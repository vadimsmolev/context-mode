import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG = "[ctx_web_search]";
const OPENCLAW_CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");

export type WebSearchSettings = {
  braveApiKey: string;
  searxngUrl: string;
};

// OpenClaw persists plugin config under plugins.entries.<name>.config — the
// key that carries braveApiKey/searxngUrl is not our plugin's, so walk every
// entry instead of trusting a fixed name (#3.3 of the ТЗ).
function walkOpenclawConfig(): { braveApiKey?: string; searxngUrl?: string } {
  if (!existsSync(OPENCLAW_CONFIG_PATH)) return {};
  try {
    const data = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
    const entries = data?.plugins?.entries;
    if (!entries || typeof entries !== "object") return {};

    let braveApiKey: string | undefined;
    let searxngUrl: string | undefined;
    for (const entry of Object.values(entries as Record<string, unknown>)) {
      const cfg = (entry as { config?: Record<string, unknown> } | undefined)?.config;
      if (!cfg) continue;
      if (!braveApiKey && typeof cfg.braveApiKey === "string" && cfg.braveApiKey.trim()) {
        braveApiKey = cfg.braveApiKey;
      }
      if (!searxngUrl && typeof cfg.searxngUrl === "string" && cfg.searxngUrl.trim()) {
        searxngUrl = cfg.searxngUrl;
      }
    }
    return { braveApiKey, searxngUrl };
  } catch (err) {
    console.error(`${LOG} failed reading ${OPENCLAW_CONFIG_PATH}: ${(err as Error).message}`);
    return {};
  }
}

let cached: WebSearchSettings | undefined;

export function loadWebSearchSettings(): WebSearchSettings {
  if (cached) return cached;
  const walked = walkOpenclawConfig();
  cached = {
    braveApiKey: process.env.BRAVE_API_KEY ?? walked.braveApiKey ?? "",
    searxngUrl: process.env.SEARXNG_URL ?? walked.searxngUrl ?? "http://localhost:8888",
  };
  return cached;
}
