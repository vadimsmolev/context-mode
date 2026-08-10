#!/usr/bin/env node
/**
 * rollback-fork — restores installed_plugins.json and ~/.claude/settings.json
 * from the most recent deploy-fork backup, then repoints npm-global at the
 * registry's installPath. The deployed version dir is left in place (harmless
 * once nothing references it; delete manually if desired).
 */
import { cpSync, readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const BACKUP = join(HOME, ".claude", "plugins", "cache", "claude-context-mode", "context-mode-backup");
const IP_PATH = join(HOME, ".claude", "plugins", "installed_plugins.json");
const SETTINGS_PATH = join(HOME, ".claude", "settings.json");

const latest = (prefix) => {
  const names = readdirSync(BACKUP).filter((n) => n.startsWith(prefix)).sort();
  if (names.length === 0) throw new Error(`no ${prefix}* backups in ${BACKUP}`);
  return join(BACKUP, names[names.length - 1]);
};

const ipBackup = latest("installed_plugins.");
const settingsBackup = latest("settings.");
cpSync(ipBackup, IP_PATH);
cpSync(settingsBackup, SETTINGS_PATH);
console.log(`rollback-fork: restored ${ipBackup}`);
console.log(`rollback-fork: restored ${settingsBackup}`);

const ip = JSON.parse(readFileSync(IP_PATH, "utf-8"));
let installPath = "";
for (const [key, value] of Object.entries(ip.plugins ?? {})) {
  if (!key.toLowerCase().includes("context-mode")) continue;
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (entry?.installPath) { installPath = entry.installPath; break; }
  }
}
if (installPath) {
  execSync(`npm install -g "${installPath}" --no-audit --no-fund`, { stdio: "inherit" });
  console.log(`rollback-fork: npm-global → ${installPath}`);
} else {
  console.error("rollback-fork: WARNING — no installPath found in restored registry; npm-global left as-is");
}
console.log("rollback-fork: DONE — restart Claude Code.");
