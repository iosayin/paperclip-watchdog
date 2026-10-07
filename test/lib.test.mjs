import { test } from "node:test";
import assert from "node:assert/strict";
import { etimeSeconds, failoverTarget, findOrphanBrowsers, parsePs, secretFamily, statusFingerprint } from "../src/lib.mjs";

test("secretFamily groups numbered versions of the same credential", () => {
  assert.equal(secretFamily("CLAUDE_CODE_OAUTH_TOKEN"), "CLAUDE_CODE_OAUTH_TOKEN");
  assert.equal(secretFamily("CLAUDE_CODE_OAUTH_TOKEN-1"), "CLAUDE_CODE_OAUTH_TOKEN");
  assert.equal(secretFamily("claude_code_oauth_token_2"), "CLAUDE_CODE_OAUTH_TOKEN");
  assert.equal(secretFamily("ANTHROPIC_API_KEY 3"), "ANTHROPIC_API_KEY");
  assert.notEqual(secretFamily("GITHUB_TOKEN"), secretFamily("CLAUDE_CODE_OAUTH_TOKEN"));
});

test("failoverTarget picks the newest active secret of the same family", () => {
  const secrets = [
    { id: "a", name: "CLAUDE_CODE_OAUTH_TOKEN", status: "disabled", updatedAt: "2026-01-02" },
    { id: "b", name: "CLAUDE_CODE_OAUTH_TOKEN-1", status: "active", updatedAt: "2026-01-01" },
    { id: "c", name: "CLAUDE_CODE_OAUTH_TOKEN-2", status: "active", updatedAt: "2026-01-03" },
    { id: "d", name: "GITHUB_TOKEN", status: "active", updatedAt: "2026-01-09" },
  ];
  assert.equal(failoverTarget(secrets, "a").id, "c");
  assert.equal(failoverTarget(secrets, "b"), null, "active secret needs no failover");
  assert.equal(failoverTarget(secrets, "zzz"), null, "unknown secret is left alone");
  assert.equal(failoverTarget([{ id: "a", name: "X_TOKEN", status: "disabled" }, { id: "g", name: "GITHUB_TOKEN", status: "active" }], "a"),
    null, "never jumps to another family");
});

test("statusFingerprint changes only when a status changes", () => {
  const s1 = [{ id: "a", status: "active" }, { id: "b", status: "disabled" }];
  assert.equal(statusFingerprint(s1), statusFingerprint([...s1].reverse()));
  assert.notEqual(statusFingerprint(s1), statusFingerprint([{ id: "a", status: "disabled" }, { id: "b", status: "disabled" }]));
});

test("etimeSeconds understands every ps format", () => {
  assert.equal(etimeSeconds("42"), 42);
  assert.equal(etimeSeconds("05:07"), 307);
  assert.equal(etimeSeconds("02:00:01"), 7201);
  assert.equal(etimeSeconds("1-00:00:10"), 86410);
});

test("findOrphanBrowsers stops only orphaned, old browser trees", () => {
  const ps = parsePs([
    "    1     0 9-00:00:00 /sbin/launchd",
    "  100     1    02:10:00 /home/u/.cache/ms-playwright/chromium-1/chrome-linux/chrome --headless --remote-debugging-pipe",
    "  101   100    02:10:00 /home/u/.cache/ms-playwright/chromium-1/chrome-linux/chrome --type=renderer",
    "  102   101    02:09:00 /home/u/.cache/ms-playwright/chromium-1/chrome-linux/chrome --type=utility",
    "  200   150    03:00:00 /home/u/.cache/ms-playwright/chromium-1/chrome-linux/chrome --headless",
    "  150     1    03:00:00 node run-tests.js",
    "  300     1       02:00 /home/u/.cache/ms-playwright/chromium-1/chrome-linux/chrome --headless",
    "  400     1    05:00:00 /usr/bin/firefox",
    "  500   600    04:00:00 /home/u/.cache/puppeteer/chrome/linux/chrome --headless",
    "  600     1 9-00:00:00 /usr/lib/systemd/systemd --user",
  ].join("\n"));
  const pattern = /ms-playwright[\\/]|puppeteer[\\/]|chrome-headless-shell/;
  const found = findOrphanBrowsers(ps, { pattern, minAgeSeconds: 15 * 60 });
  assert.deepEqual(found.map((o) => o.pid).sort(), [100, 500]);
  const tree = found.find((o) => o.pid === 100).kill;
  assert.deepEqual(tree, [102, 101, 100], "children first, then the browser");
  // 200: launcher (150) still alive · 300: too young · 400: not a matching browser
});
