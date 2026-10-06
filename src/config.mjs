import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
function secret(name) {
  const file = process.env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, "utf8").trim();
  return (process.env[name] ?? "").trim();
}
const bool = (name, def) => (process.env[name] === undefined ? def : process.env[name] === "true");
const num = (name, def) => (process.env[name] === undefined ? def : Number(process.env[name]));

export function loadConfig() {
  loadEnvFile(process.env.PW_ENV_FILE ?? path.resolve(process.cwd(), ".env"));
  const cfg = {
    paperclipUrl: (process.env.PAPERCLIP_URL ?? "http://localhost:3100").replace(/\/+$/, ""),
    paperclipToken: secret("PAPERCLIP_TOKEN"),
    githubToken: secret("GITHUB_TOKEN"), // optional, for private repos / higher rate limit
    intervalSeconds: Math.max(30, num("PW_INTERVAL_SECONDS", 60)),
    stateFile: process.env.PW_STATE_FILE ?? path.join(os.homedir(), ".paperclip-watchdog", "state.json"),
    // Watchers (each can be switched off)
    watch: {
      answeredCard: bool("PW_ANSWERED_CARD", true),
      dependencyDone: bool("PW_DEPENDENCY_DONE", true),
      ciWait: bool("PW_CI_WAIT", true),
      idleAssigned: bool("PW_IDLE_ASSIGNED", true),
      brokenSession: bool("PW_BROKEN_SESSION", true),
      unexplainedBlocked: bool("PW_UNEXPLAINED_BLOCKED", true),
      benignAgentError: bool("PW_BENIGN_AGENT_ERROR", true),
      staleAlert: bool("PW_STALE_ALERT", true),
    },
    idleMinutes: num("PW_IDLE_MINUTES", 10),
    idleMaxNudges: num("PW_IDLE_MAX_NUDGES", 2),
    unexplainedBlockedMinutes: num("PW_UNEXPLAINED_BLOCKED_MINUTES", 15),
    staleHours: num("PW_STALE_HOURS", 2),
    ciMarker: process.env.PW_CI_MARKER ?? "CI pending:",
    // Alerts (optional): Telegram and/or a generic webhook. Without them, alerts go to stdout.
    telegramToken: secret("PW_TELEGRAM_BOT_TOKEN"),
    telegramChatId: (process.env.PW_TELEGRAM_CHAT_ID ?? "").trim(),
    webhookUrl: (process.env.PW_WEBHOOK_URL ?? "").trim(),
  };
  if (!cfg.paperclipToken) {
    console.error("Missing PAPERCLIP_TOKEN (board API token). See .env.example.");
    process.exit(2);
  }
  return cfg;
}
