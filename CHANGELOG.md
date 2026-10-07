# Changelog

## 0.2.0

- **`token-failover`**: when an agent's credential secret is disabled or rotated out, runs fail at setup with `Secret is not active` and tasks pile up as blocked. The watchdog now moves the agents to another active secret of the same family (`NAME`, `NAME-1`, `NAME_2`, …), reopens the tasks that failed for this reason and sends an alert. Agents are only inspected when a secret status changes. Switching a company between accounts is now: disable one secret, keep the other active.
- **`orphan-browser`**: stops headless Playwright/Puppeteer browsers whose launcher died (re-parented to pid 1 or an init reaper) and that are older than `PW_ORPHAN_BROWSER_MINUTES` (15). Cancelled and timed-out agent runs were leaving them running for hours. Same-machine only; a no-op on Windows and in containers that can't see the host.
- Pure helpers moved to `src/lib.mjs` with tests (`npm test`).

## 0.1.0

First release: `answered-card`, `dependency-done`, `ci-wait`, `idle-assigned`, `broken-session`, `unexplained-blocked`, `benign-agent-error`, `stale-alert`.
