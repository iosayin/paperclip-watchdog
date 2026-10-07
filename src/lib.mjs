// Pure helpers used by the watchers. No I/O here, so they can be tested in isolation.

// Secrets are grouped into "families" by name: CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN-1 and
// CLAUDE_CODE_OAUTH_TOKEN_2 are interchangeable versions of the same credential (e.g. two Claude accounts).
export function secretFamily(name) {
  return String(name ?? "").trim().toUpperCase().replace(/[-_ ]?\d+$/, "");
}

// Given the secrets of a company and the secret id an agent env var points to, return the secret the agent
// should use instead, or null when nothing needs to change. Prefers the most recently updated active secret.
export function failoverTarget(secrets, currentId) {
  const current = secrets.find((s) => s.id === currentId);
  if (!current || current.status === "active") return null;
  const family = secretFamily(current.name);
  const candidates = secrets
    .filter((s) => s.id !== current.id && s.status === "active" && secretFamily(s.name) === family)
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return candidates[0] ?? null;
}

// A cheap fingerprint of secret statuses, so agents are only inspected when something changed.
export function statusFingerprint(secrets) {
  return secrets.map((s) => `${s.id}:${s.status}`).sort().join(",");
}

// `ps -o etime` → seconds. Formats: "ss", "mm:ss", "hh:mm:ss", "d-hh:mm:ss".
export function etimeSeconds(etime) {
  const [days, rest] = String(etime).includes("-") ? String(etime).split("-") : ["0", String(etime)];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// Parse `ps -Ao pid=,ppid=,etime=,command=` output.
export function parsePs(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), age: etimeSeconds(m[3]), command: m[4] });
  }
  return out;
}

const REAPERS = /(^|\/)(launchd|systemd|init|tini|dumb-init|s6-svscan)( |$)/;

// Headless browsers whose launcher died: parent is pid 1 (or an init-style reaper), the command matches the
// browser pattern, it is not a child helper (--type=…), and it is older than minAgeSeconds.
// Returns each orphan with all its descendant pids, children first.
export function findOrphanBrowsers(procs, { pattern, minAgeSeconds }) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const children = new Map();
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  const descendants = (pid) => (children.get(pid) ?? []).flatMap((c) => [...descendants(c), c]);
  return procs
    .filter((p) => {
      if (!pattern.test(p.command) || / --type=/.test(p.command) || p.age < minAgeSeconds) return false;
      const parent = byPid.get(p.ppid);
      return p.ppid === 1 || (parent && REAPERS.test(parent.command));
    })
    .map((p) => ({ ...p, kill: [...descendants(p.pid), p.pid] }));
}
