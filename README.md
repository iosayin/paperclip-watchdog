# paperclip-watchdog

[![npm](https://img.shields.io/npm/v/paperclip-watchdog?color=cb3837&logo=npm)](https://www.npmjs.com/package/paperclip-watchdog) [![license](https://img.shields.io/github/license/iosayin/paperclip-watchdog)](LICENSE) ![node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white) ![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

**Keep your [Paperclip](https://github.com/paperclipai/paperclip) company moving while you're away.**

Agents get stuck for boring reasons: a card was answered but nobody woke the agent, the task it waited for finished hours ago, CI finished (or will never start because the PR conflicts), a session broke and every run times out. You come back in the morning and nothing moved.

`paperclip-watchdog` checks your Paperclip server every minute, finds tasks stuck for a **mechanical** reason and unsticks them. When something needs a human, it tells you.

<p align="center"><img src="https://raw.githubusercontent.com/iosayin/paperclip-watchdog/main/docs/demo.gif" width="720" alt="paperclip-watchdog log: reopening and waking stuck tasks"></p>

- 🧠 **No model tokens.** It only calls the Paperclip REST API (and GitHub for CI). Waiting costs nothing.
- 🔁 **Safe by design.** Every action is capped per task, signed in a comment (`🛡 watchdog:`), and `--dry-run` shows what it would do.
- 📦 **Zero dependencies.** One Node.js process (≥ 20). Runs as a daemon or one pass at a time (cron, launchd, systemd timer).

## What it fixes

| Watcher | Stuck because… | What it does |
|---|---|---|
| `answered-card` | You answered/accepted a card, but the blocked task never woke up | Reopens it: *"the card you were waiting for was accepted"* |
| `dependency-done` | Every blocking issue is done, the task is still `blocked` | Reopens it with the list of finished blockers |
| `ci-wait` | The agent waits for CI (`CI pending: owner/repo#123`) | Reopens it when all checks finish, with a ✔/✘ summary. If the PR **conflicts** (CI will never start), says so |
| `idle-assigned` | Assigned `todo`/`in_review`, no run for 10 min | Explicit wakeup (max 2). Detects Paperclip's internal recovery lock (`execution_reconciliation_required`) and alerts you |
| `broken-session` | Two empty runs in a row (timeout / adapter failure) | Resets the agent session and starts fresh |
| `unexplained-blocked` | `blocked` with no blocker, card, child task or reason | Reopens it (Paperclip's own "needs attention" blocks after 3 min) |
| `benign-agent-error` | Agent left in `error` after its task was closed (e.g. a reviewer stopped right after approving) | Clears the error so future wakeups work |
| `stale-alert` | Nothing moved for 2 h and no reason is visible | Alerts you (Telegram, webhook or log). No action |

## Quick start

**Fastest way** (no clone, Node ≥ 20):

```bash
# put your settings in .env (see .env.example), then
npx paperclip-watchdog --dry-run
npx paperclip-watchdog
```

Or from source:

```bash
git clone https://github.com/iosayin/paperclip-watchdog && cd paperclip-watchdog
cp .env.example .env          # PAPERCLIP_URL, PAPERCLIP_TOKEN (board API token)
node src/watchdog.mjs --dry-run   # see what it would do, changes nothing
node src/watchdog.mjs             # run
```

Run it as a service: [`examples/`](examples) has systemd, launchd and a Dockerfile.

## Teach your agents one convention (for `ci-wait`)

Waiting for CI inside an agent run burns the run's time limit. Add this to your agents' instructions:

> After pushing, don't wait for CI in the run. Set the task to `blocked`, put `CI pending: <owner>/<repo>#<PR>` in the unblock description, and finish the run. The watchdog will reopen the task with the CI result.

Waiting for another task? Use Paperclip's blockers (`blockedBy`), not free text: `dependency-done` handles the rest.

## Alerts

Set `PW_TELEGRAM_BOT_TOKEN` + `PW_TELEGRAM_CHAT_ID`, or `PW_WEBHOOK_URL` (receives `{"source":"paperclip-watchdog","text":"..."}`). Without them, alerts are logged.

Want to **answer** approvals and questions from your phone too? See [paperclip-telegram](https://github.com/iosayin/paperclip-telegram) (works great together).

## Configuration

Every watcher can be turned off (`PW_ANSWERED_CARD=false`, …). Thresholds: `PW_IDLE_MINUTES`, `PW_IDLE_MAX_NUDGES`, `PW_UNEXPLAINED_BLOCKED_MINUTES`, `PW_STALE_HOURS`, `PW_CI_MARKER`. See [`.env.example`](.env.example).

## Notes

- The board token can change task status and wake agents. Keep it like a password (`PAPERCLIP_TOKEN_FILE` + `chmod 600`).
- Tested with Paperclip `2026.1001`. Paperclip moves fast; if a field changes, please open an issue.

## License

MIT
