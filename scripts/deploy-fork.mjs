#!/usr/bin/env node
/**
 * deploy-fork — deploys this fork's build into the Claude Code plugin cache.
 * Replaces the upstream `context-mode upgrade` flow (which clones from git):
 * we deploy straight from this working tree instead.
 *
 * Steps: build → backup registry+settings → copy files[] into a versioned
 * cache dir → prod deps → point installed_plugins.json and the PreToolUse
 * hook path at the new dir → refresh the npm-global install.
 *
 * Flags: --skip-build  reuse existing build/ + bundles as-is.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const FORK = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = homedir();
const CACHE_PARENT = join(HOME, ".claude", "plugins", "cache", "claude-context-mode", "context-mode");
const BACKUP = join(HOME, ".claude", "plugins", "cache", "claude-context-mode", "context-mode-backup");
const IP_PATH = join(HOME, ".claude", "plugins", "installed_plugins.json");
const SETTINGS_PATH = join(HOME, ".claude", "settings.json");

const run = (cmd, cwd, env) =>
  execSync(cmd, { cwd, stdio: "inherit", env: env ? { ...process.env, ...env } : process.env });

const pkg = JSON.parse(readFileSync(join(FORK, "package.json"), "utf-8"));
const version = pkg.version;
const TARGET = join(CACHE_PARENT, version);
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  // self-heal/start.mjs compare versions via split(".").map(Number) — suffixes become NaN
  console.error(`deploy-fork: version "${version}" is not plain X.Y.Z — aborting`);
  process.exit(1);
}

// 1. Build (fail-fast: tsc + bundles + assert scripts)
if (!process.argv.includes("--skip-build")) {
  console.log("deploy-fork: npm run build …");
  run("npm run build", FORK);
}

// 2. Backup registry + settings (timestamped, never overwritten)
mkdirSync(BACKUP, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-");
cpSync(IP_PATH, join(BACKUP, `installed_plugins.${ts}.json`));
cpSync(SETTINGS_PATH, join(BACKUP, `settings.${ts}.json`));
console.log(`deploy-fork: backed up registry + settings → ${BACKUP}`);

// 3. Copy files[] + src + package.json (same list the upstream upgrade copies)
if (existsSync(TARGET)) rmSync(TARGET, { recursive: true });
mkdirSync(TARGET, { recursive: true });
for (const item of [...(pkg.files ?? []), "src", "package.json"]) {
  const from = join(FORK, item);
  if (!existsSync(from)) continue;
  mkdirSync(dirname(join(TARGET, item)), { recursive: true });
  cpSync(from, join(TARGET, item), { recursive: true });
}
console.log(`deploy-fork: copied build → ${TARGET}`);

// 4. Production deps. Chromium already lives in ~/.cache/ms-playwright — never download here.
console.log("deploy-fork: npm install --omit=dev …");
run("npm install --omit=dev --no-audit --no-fund", TARGET, { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" });

// 5. Registry: point every context-mode entry at the new dir
const ip = JSON.parse(readFileSync(IP_PATH, "utf-8"));
let sha = "";
try { sha = execSync("git rev-parse HEAD", { cwd: FORK }).toString().trim(); } catch {}
let patched = 0;
for (const [key, value] of Object.entries(ip.plugins ?? {})) {
  if (!key.toLowerCase().includes("context-mode")) continue;
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (!entry || typeof entry !== "object") continue;
    entry.installPath = TARGET;
    entry.version = version;
    entry.lastUpdated = new Date().toISOString();
    if (sha) entry.gitCommitSha = sha;
    patched++;
  }
}
if (patched === 0) {
  console.error("deploy-fork: no context-mode entry found in installed_plugins.json — aborting before touching settings");
  process.exit(1);
}
writeFileSync(IP_PATH, JSON.stringify(ip, null, 2) + "\n");
console.log(`deploy-fork: installed_plugins.json → ${version} (${patched} entr${patched === 1 ? "y" : "ies"})`);

// 6. Hook path in ~/.claude/settings.json (hardcoded absolute path to the old version dir)
const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
const versionSeg = /(claude-context-mode[\/\\]context-mode[\/\\])[^\/\\]+([\/\\]hooks[\/\\])/;
let hooksPatched = 0;
for (const groups of Object.values(settings.hooks ?? {})) {
  for (const group of groups) {
    for (const h of group.hooks ?? []) {
      if (typeof h.command === "string" && versionSeg.test(h.command)) {
        h.command = h.command.replace(versionSeg, `$1${version}$2`);
        hooksPatched++;
      }
    }
  }
}
writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
console.log(`deploy-fork: settings.json hook paths → ${version} (${hooksPatched} command${hooksPatched === 1 ? "" : "s"})`);

// 7. npm-global (the `context-mode` CLI symlink)
run(`npm install -g "${TARGET}" --no-audit --no-fund`);

console.log(`\ndeploy-fork: DONE — ${version} deployed to ${TARGET}`);
console.log("deploy-fork: restart Claude Code (or /mcp → reconnect) to pick it up.");
