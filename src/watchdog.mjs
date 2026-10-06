#!/usr/bin/env node
// paperclip-watchdog — keeps a Paperclip company moving while you're away.
// Finds tasks that are stuck for a mechanical reason and nudges, reopens or recovers them.
// Uses only the Paperclip REST API (and optionally the GitHub API). It never calls a model.
//
//   node src/watchdog.mjs            run forever (every PW_INTERVAL_SECONDS)
//   node src/watchdog.mjs --once     one pass, then exit (for cron/launchd/systemd timers)
//   node src/watchdog.mjs --dry-run  log what would be done, change nothing
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const DRY = process.argv.includes("--dry-run");
const ONCE = process.argv.includes("--once") || DRY;
const log = (m) => console.log(`${new Date().toISOString()} ${DRY ? "[dry-run] " : ""}${m}`);
const SIGN = "🛡 watchdog:";

// ── State
const S = (() => { try { return JSON.parse(fs.readFileSync(cfg.stateFile, "utf8")); } catch { return {}; } })();
for (const k of ["answered", "deps", "ci", "idle", "sessions", "unexplained", "stale", "agentErrors"]) S[k] ??= {};
function saveState() {
  if (DRY) return;
  fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(cfg.stateFile, JSON.stringify(S), { mode: 0o600 });
}

// ── Paperclip API
async function pc(route, options = {}) {
  const res = await fetch(`${cfg.paperclipUrl}/api${route}`, {
    signal: AbortSignal.timeout(30_000), ...options,
    headers: { Authorization: `Bearer ${cfg.paperclipToken}`, Origin: cfg.paperclipUrl, "Content-Type": "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Paperclip ${res.status} ${options.method ?? "GET"} ${route}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}
const list = (x) => (Array.isArray(x) ? x : x?.items ?? x?.data ?? []);
const minutesSince = (iso) => (Date.now() - new Date(iso).getTime()) / 60_000;
// Paperclip lists don't include dependency ids; `blockerAttention` tells whether unresolved blockers exist,
// and the issue detail (`blockedBy`) gives the blocking issues with their status.
const hasOpenBlockers = (issue) => (issue.blockerAttention?.unresolvedBlockerCount ?? 0) > 0;
const ACTIVE_RUN = ["running", "queued", "starting", "scheduled_retry"];

// Writes go through here so --dry-run is honest.
async function act(description, fn) {
  log(description);
  if (DRY) return null;
  try { return await fn(); } catch (e) { log(`  failed: ${e.message}`); return null; }
}
const patchIssue = (issue, body) => pc(`/issues/${issue.id}`, { method: "PATCH", body: JSON.stringify(body) });
const comment = (issue, text) => pc(`/issues/${issue.id}/comments`, { method: "POST", body: JSON.stringify({ body: `${SIGN} ${text}` }) });
const wake = (agentId, issue, reason, extra = {}) => pc(`/agents/${agentId}/wakeup`, { method: "POST", body: JSON.stringify({
  source: "automation", triggerDetail: "system", reason, payload: { issueId: issue.id }, ...extra }) });

// ── Alerts
async function alert(text) {
  log(`ALERT ${text}`);
  if (DRY) return;
  if (cfg.telegramToken && cfg.telegramChatId) {
    await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ chat_id: cfg.telegramChatId, text: `⚠ ${text}` }),
    }).catch((e) => log(`  telegram failed: ${e.message}`));
  }
  if (cfg.webhookUrl) {
    await fetch(cfg.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ source: "paperclip-watchdog", text }) }).catch((e) => log(`  webhook failed: ${e.message}`));
  }
}

// ── GitHub (for the CI watcher)
async function gh(route) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "paperclip-watchdog" };
  if (cfg.githubToken) headers.Authorization = `Bearer ${cfg.githubToken}`;
  const res = await fetch(`https://api.github.com${route}`, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${route}`);
  return res.json();
}

// ── Snapshot of one company
async function snapshot(company) {
  const issues = list(await pc(`/companies/${company.id}/issues?limit=500`));
  const runs = list(await pc(`/companies/${company.id}/heartbeat-runs?limit=100`));
  const agents = list(await pc(`/companies/${company.id}/agents`));
  const byId = new Map(issues.map((i) => [i.id, i]));
  const runsOf = (issueId) => runs.filter((r) => r.contextSnapshot?.issueId === issueId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const openChildren = (issue) => issues.some((x) => x.parentId === issue.id && !["done", "cancelled"].includes(x.status));
  const cardCache = new Map();
  const cards = async (issue) => {
    if (!cardCache.has(issue.id)) cardCache.set(issue.id, list(await pc(`/issues/${issue.id}/interactions`).catch(() => [])));
    return cardCache.get(issue.id);
  };
  return { company, issues, runs, agents, byId, runsOf, openChildren, cards };
}

// ── Watchers ────────────────────────────────────────────────────────────────────

// 1) A card on a blocked task was answered, but nothing woke the assignee.
async function answeredCard(c) {
  for (const issue of c.issues) {
    if (issue.status !== "blocked" || !issue.assigneeAgentId || hasOpenBlockers(issue) || c.openChildren(issue)) continue;
    const cards = await c.cards(issue);
    if (cards.some((e) => e.status === "pending")) continue;
    const last = cards.filter((e) => ["answered", "accepted", "rejected"].includes(e.status) && !S.answered[e.id])
      .sort((a, b) => new Date(b.resolvedAt ?? b.updatedAt) - new Date(a.resolvedAt ?? a.updatedAt))[0];
    if (!last) continue;
    const at = new Date(last.resolvedAt ?? last.updatedAt).getTime();
    if (Date.now() - at < 3 * 60_000) continue; // give Paperclip's own wake a chance
    const runs = c.runsOf(issue.id);
    if (runs.some((r) => ACTIVE_RUN.includes(r.status))) continue;
    S.answered[last.id] = 1;
    if (runs.some((r) => new Date(r.createdAt).getTime() > at)) continue; // already handled
    const outcome = last.kind === "request_confirmation" ? (last.status === "accepted" ? "was accepted" : "was rejected") : "was answered";
    await act(`answered-card: reopen ${issue.identifier}`, () =>
      patchIssue(issue, { status: "todo", unblockDescriptor: null, comment: `${SIGN} the card you were waiting for ${outcome}. Read the answer and continue.` }));
  }
}

// 2) Every blocking issue is done, but the task is still blocked.
async function dependencyDone(c) {
  for (const issue of c.issues) {
    if (issue.status !== "blocked" || !issue.assigneeAgentId || hasOpenBlockers(issue)) continue;
    if (minutesSince(issue.updatedAt) < 3 || S.deps[issue.id] === issue.updatedAt) continue;
    const blockers = list((await pc(`/issues/${issue.id}`).catch(() => ({}))).blockedBy);
    if (!blockers.length || blockers.some((b) => !["done", "cancelled"].includes(b.status))) continue;
    if ((await c.cards(issue)).some((e) => e.status === "pending") || c.openChildren(issue)) continue;
    S.deps[issue.id] = issue.updatedAt;
    const what = blockers.map((b) => `${b.identifier} (${b.status})`).join(", ");
    await act(`dependency-done: reopen ${issue.identifier} ← ${what}`, () =>
      patchIssue(issue, { status: "todo", comment: `${SIGN} the work you were waiting for is finished: ${what}. Read the results and continue.` }));
  }
}

// 3) The agent is waiting for CI. Convention: blocked + unblockDescriptor.action "<marker> owner/repo#123".
//    When all checks finish, reopen with a summary; if the PR conflicts (CI will never start), say so.
async function ciWait(c) {
  const rx = new RegExp(`${cfg.ciMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*([\\w.-]+/[\\w.-]+)#(\\d+)`, "i");
  for (const issue of c.issues) {
    if (issue.status !== "blocked" || !issue.assigneeAgentId) continue;
    const m = String(issue.unblockDescriptor?.action ?? "").match(rx);
    if (!m || minutesSince(issue.updatedAt) < 3 || S.ci[issue.id] === issue.updatedAt) continue;
    const [, repo, num] = m;
    let pr, checks;
    try {
      pr = await gh(`/repos/${repo}/pulls/${num}`);
      checks = (await gh(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`)).check_runs ?? [];
    } catch (e) { log(`ci-wait: ${issue.identifier} ${e.message}`); continue; }
    if (pr.state !== "open") {
      S.ci[issue.id] = issue.updatedAt;
      await act(`ci-wait: ${issue.identifier} PR is ${pr.merged ? "merged" : "closed"}`, () =>
        patchIssue(issue, { status: "todo", unblockDescriptor: null, comment: `${SIGN} ${repo}#${num} is ${pr.merged ? "merged" : "closed"}. Continue.` }));
      continue;
    }
    if (!checks.length && pr.mergeable === false) {
      S.ci[issue.id] = issue.updatedAt;
      await act(`ci-wait: ${issue.identifier} PR conflicts`, () =>
        patchIssue(issue, { status: "todo", unblockDescriptor: null, comment: `${SIGN} ${repo}#${num} conflicts with its base branch, so CI will not start. Merge the base branch, resolve the conflict, push, then wait for CI again.` }));
      continue;
    }
    if (!checks.length || checks.some((k) => k.status !== "completed")) continue;
    S.ci[issue.id] = issue.updatedAt;
    const icon = (k) => (k.conclusion === "success" ? "✔" : ["skipped", "neutral"].includes(k.conclusion) ? "–" : "✘");
    const summary = checks.map((k) => `${icon(k)} ${k.name}`).join(" · ");
    await act(`ci-wait: ${issue.identifier} CI finished`, () =>
      patchIssue(issue, { status: "todo", unblockDescriptor: null, comment: `${SIGN} ${repo}#${num} CI finished: ${summary}. Continue based on the result.` }));
  }
}

// 4) Assigned todo/in_review task with no run for a while: nudge with an explicit wakeup (max N times per state).
async function idleAssigned(c) {
  for (const issue of c.issues) {
    if (!issue.assigneeAgentId || !["todo", "in_review"].includes(issue.status)) continue;
    if (minutesSince(issue.updatedAt) < cfg.idleMinutes) continue;
    const last = c.runsOf(issue.id).find((r) => r.agentId === issue.assigneeAgentId);
    if (last && (ACTIVE_RUN.includes(last.status) || new Date(last.createdAt) > new Date(issue.updatedAt))) continue;
    if ((await c.cards(issue)).some((e) => e.status === "pending")) continue;
    const key = `${issue.status}|${issue.assigneeAgentId}`;
    const s = S.idle[issue.id]?.key === key ? S.idle[issue.id] : { key, n: 0, t: 0 };
    if (s.n >= cfg.idleMaxNudges || Date.now() - s.t < 30 * 60_000) continue;
    s.n += 1; s.t = Date.now(); S.idle[issue.id] = s;
    const res = await act(`idle-assigned: wake ${issue.identifier} (${s.n}/${cfg.idleMaxNudges})`, () =>
      wake(issue.assigneeAgentId, issue, `${issue.identifier} has been waiting for you; ${issue.status === "in_review" ? "do the review" : "do the work"} now.`,
        { idempotencyKey: `pw-idle-${issue.id}-${key}-${s.n}` }));
    // Paperclip can hold a task behind an internal recovery lock; no wakeup will ever run it.
    if (res?.status === "skipped" && res?.reason === "execution_reconciliation_required")
      await alert(`${c.company.name} ${issue.identifier}: Paperclip's recovery lock blocks this task (execution_reconciliation_required). Continue the work in a new issue on the same branch/PR.`);
  }
}

// 5) The last two runs of the same agent on the same task ended empty (timeout / adapter failure):
//    the provider session is probably broken. Reset it and start fresh.
async function brokenSession(c) {
  const groups = new Map();
  for (const r of c.runs) {
    const id = r.contextSnapshot?.issueId; if (!id) continue;
    const k = `${r.agentId}|${id}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r);
  }
  const bad = (r) => r.status === "timed_out" || (r.status === "failed" && r.errorCode === "adapter_failed");
  for (const [k, rs] of groups) {
    rs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (ACTIVE_RUN.includes(rs[0].status) || rs.length < 2 || !bad(rs[0]) || !bad(rs[1]) || S.sessions[k] === rs[0].id) continue;
    const [agentId, issueId] = k.split("|"); const issue = c.byId.get(issueId);
    if (!issue || !["todo", "in_progress", "in_review"].includes(issue.status) || issue.assigneeAgentId !== agentId) continue;
    S.sessions[k] = rs[0].id;
    await act(`broken-session: reset ${issue.identifier}`, async () => {
      await pc(`/agents/${agentId}/runtime-state/reset-session`, { method: "POST", body: "{}" });
      await wake(agentId, issue, `The last two runs ended without output; the session was reset. Read the task comments and continue.`,
        { forceFreshSession: true, idempotencyKey: `pw-session-${rs[0].id}` });
    });
    await alert(`${c.company.name} ${issue.identifier}: two empty runs in a row, agent session reset and restarted.`);
  }
}

// 6) Blocked with no visible reason (no blocker, card, child or description). Paperclip's own
//    "needs attention" blocks are reopened faster.
async function unexplainedBlocked(c) {
  for (const issue of c.issues) {
    if (issue.status !== "blocked" || !issue.assigneeAgentId || issue.assigneeUserId) continue;
    const ba = issue.blockerAttention ?? {};
    const wait = ba.reason === "attention_required" ? 3 : cfg.unexplainedBlockedMinutes;
    if (minutesSince(issue.updatedAt) < wait) continue;
    if (hasOpenBlockers(issue) || issue.unblockDescriptor || c.openChildren(issue)) continue;
    if ((await c.cards(issue)).some((e) => e.status === "pending")) continue;
    const s = S.unexplained[issue.id];
    if (s && s.u === issue.updatedAt && s.n >= 2) continue;
    const n = s?.u === issue.updatedAt ? s.n + 1 : 1;
    S.unexplained[issue.id] = { u: issue.updatedAt, n };
    await act(`unexplained-blocked: reopen ${issue.identifier}`, () =>
      patchIssue(issue, { status: "todo", comment: `${SIGN} this task was blocked without a visible reason (no blocker, card or child task). Reopened, continue where you left off. (${n}/2)` }));
  }
}

// 7) Agent left in "error" after its task was already closed (e.g. a reviewer whose run was stopped
//    when it approved). The work is done; the error only blocks future wakeups.
async function benignAgentError(c) {
  for (const a of c.agents) {
    if (a.status !== "error") continue;
    const last = c.runs.filter((r) => r.agentId === a.id).sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt))[0];
    const issue = last && c.byId.get(last.contextSnapshot?.issueId);
    if (!issue || !["done", "cancelled", "in_review"].includes(issue.status) || S.agentErrors[a.id] === last.id) continue;
    S.agentErrors[a.id] = last.id;
    await act(`benign-agent-error: clear ${a.name}`, () => pc(`/agents/${a.id}/clear-error`, { method: "POST", body: "{}" }));
  }
}

// 8) Anything assigned that hasn't moved for PW_STALE_HOURS with no visible reason: tell a human (no action).
async function staleAlert(c) {
  for (const issue of c.issues) {
    if (!issue.assigneeAgentId || !["todo", "in_progress", "in_review", "blocked"].includes(issue.status)) continue;
    if (minutesSince(issue.updatedAt) < cfg.staleHours * 60 || S.stale[issue.id] === issue.updatedAt) continue;
    if (hasOpenBlockers(issue) || c.openChildren(issue)) continue;
    if (c.runsOf(issue.id).some((r) => ACTIVE_RUN.includes(r.status))) continue;
    if ((await c.cards(issue)).some((e) => e.status === "pending")) continue;
    S.stale[issue.id] = issue.updatedAt;
    const why = issue.unblockDescriptor?.action ? `waiting for: ${String(issue.unblockDescriptor.action).slice(0, 80)}` : "no visible reason";
    await alert(`${c.company.name} ${issue.identifier} has not moved for ${Math.round(minutesSince(issue.updatedAt) / 60)} h (${issue.status}, ${why}): ${(issue.title ?? "").slice(0, 70)}`);
  }
}

// ── One pass over all companies
async function pass() {
  const snaps = [];
  for (const company of list(await pc("/companies"))) {
    try { snaps.push(await snapshot(company)); } catch (e) { log(`${company.name}: ${e.message}`); }
  }
    for (const c of snaps) {
    const w = cfg.watch;
    for (const [on, fn] of [[w.answeredCard, answeredCard], [w.dependencyDone, dependencyDone], [w.ciWait, ciWait],
      [w.idleAssigned, idleAssigned], [w.brokenSession, brokenSession], [w.unexplainedBlocked, unexplainedBlocked],
      [w.benignAgentError, benignAgentError], [w.staleAlert, staleAlert]]) {
      if (!on) continue;
      try { await fn(c); } catch (e) { log(`${c.company.name} ${fn.name}: ${e.message}`); }
    }
  }
  saveState();
}

log(`started; Paperclip ${cfg.paperclipUrl}; ${ONCE ? "single pass" : `every ${cfg.intervalSeconds}s`}`);
do {
  try { await pass(); } catch (e) { log(`pass error: ${e.message}`); }
  if (!ONCE) await new Promise((r) => setTimeout(r, cfg.intervalSeconds * 1000));
} while (!ONCE);
