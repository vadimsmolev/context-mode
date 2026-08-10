import { withRetry } from "./retry.js";

const LOG = "[ctx_web_search]";
const RETRIES = 2;
const BRAVE_TIMEOUT_MS = 15000;
const BRIGHTDATA_TIMEOUT_MS = 30000;
const SEARXNG_TIMEOUT_MS = 15000;

export type SerpResult = { url: string; title: string; snippet: string };

export type SerpBackend = "brave" | "web" | "searxng";

export type SearchOk = { status: "ok"; backend: SerpBackend; results: SerpResult[] };
export type SearchErr = {
  status: "error";
  backend_tried: SerpBackend[];
  reason: string;
};
export type SearchOutcome = SearchOk | SearchErr;

export type SearchBackend = SerpBackend | "auto";

export type SearchConfig = {
  searxngUrl: string;
  braveApiKey?: string;
  brightdataApiKey?: string;
  brightdataZone?: string;
  brightdataHl?: string;
};

// Promise-chain rate limiter: each acquire() waits its turn AND the minimum
// interval since the previous run completed, so concurrent callers serialize
// against Brave's per-second quota instead of bursting past it.
function makeRateLimiter(minIntervalMs: number): () => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  let lastRun = 0;
  return function acquire(): Promise<void> {
    const next = chain.then(async () => {
      const wait = lastRun + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastRun = Date.now();
    });
    chain = next;
    return next;
  };
}

const BRAVE_MIN_INTERVAL_MS = Number(process.env.BRAVE_MIN_INTERVAL_MS) || 1100;
const braveLimiter = makeRateLimiter(BRAVE_MIN_INTERVAL_MS);

async function searchBrave(
  query: string,
  count: number,
  apiKey: string,
): Promise<SerpResult[]> {
  if (!apiKey) throw new Error("config: braveApiKey not set");

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(Math.max(count, 1), 20)));
  // Регион выдачи — по языку запроса: русский запрос ищет в РФ-выдаче,
  // латиница — в международной.
  const cyr = (query.match(/[а-яё]/gi) ?? []).length;
  const lat = (query.match(/[a-z]/gi) ?? []).length;
  url.searchParams.set("country", cyr >= lat ? "RU" : "US");
  url.searchParams.set("search_lang", cyr >= lat ? "ru" : "en");

  return withRetry(async () => {
    await braveLimiter();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BRAVE_TIMEOUT_MS);
    try {
      let resp: Response;
      try {
        resp = await fetch(url.toString(), {
          signal: ctrl.signal,
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
        });
      } catch (err) {
        const e = err as Error;
        if (e.name === "AbortError" || /aborted/i.test(e.message)) {
          throw new Error(`Brave timeout after ${BRAVE_TIMEOUT_MS}ms (q="${query.slice(0, 80)}")`);
        }
        throw new Error(`Brave network: ${e.message}`);
      }
      const rawText = await resp.text();
      if (!resp.ok) {
        throw new Error(`Brave HTTP ${resp.status}: ${rawText.slice(0, 300)}`);
      }
      if (!rawText.trim()) {
        throw new Error(`Brave empty response body (status=${resp.status})`);
      }
      let data: any;
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error(`Brave non-JSON response: ${rawText.slice(0, 300)}`);
      }
      const items: any[] = data?.web?.results ?? [];
      return items.map((r: any) => {
        // Дата публикации префиксом к сниппету — без неё свежесть источника
        // теряется на пути до ответа. page_age — ISO (режем до даты), age —
        // человекочитаемый фолбэк; у части страниц нет ни того, ни другого.
        const iso = String(r.page_age ?? "").trim();
        const age = iso ? iso.slice(0, 10) : String(r.age ?? "").trim();
        return {
          url: String(r.url ?? ""),
          title: String(r.title ?? ""),
          snippet: `${age ? `[${age}] ` : ""}${String(r.description ?? "")}`,
        };
      }).filter((r: SerpResult) => r.url);
    } finally {
      clearTimeout(timer);
    }
  }, {
    retries: RETRIES,
    label: "brave",
    onRetry: (attempt, err, delayMs) => {
      console.error(`${LOG} brave retry attempt=${attempt} in ${delayMs}ms after: ${err.message}`);
    },
  });
}

async function searchBrightdata(
  query: string,
  count: number,
  apiKey: string,
  zone: string,
  hl: string,
): Promise<SerpResult[]> {
  if (!apiKey) throw new Error("config: brightdataApiKey not set");
  if (!zone) throw new Error("config: brightdataZone not set");

  const searchUrl =
    `https://www.google.com/search?q=${encodeURIComponent(query)}` +
    `&brd_json=1&num=${count}&hl=${encodeURIComponent(hl)}`;

  return withRetry(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BRIGHTDATA_TIMEOUT_MS);
    try {
      let resp: Response;
      try {
        resp = await fetch("https://api.brightdata.com/request", {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ zone, url: searchUrl, format: "raw" }),
        });
      } catch (err) {
        const e = err as Error;
        if (e.name === "AbortError" || /aborted/i.test(e.message)) {
          throw new Error(`Bright Data timeout after ${BRIGHTDATA_TIMEOUT_MS}ms (q="${query.slice(0, 80)}")`);
        }
        throw new Error(`Bright Data network: ${e.message}`);
      }
      const rawText = await resp.text();
      if (!resp.ok) {
        throw new Error(`Bright Data HTTP ${resp.status}: ${rawText.slice(0, 300)}`);
      }
      if (!rawText.trim()) {
        throw new Error(`Bright Data empty response body (status=${resp.status})`);
      }
      let data: any;
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error(`Bright Data non-JSON response: ${rawText.slice(0, 300)}`);
      }
      const items: any[] = data?.organic ?? [];
      return items.map((r: any) => {
        const extTexts = (r.extensions ?? [])
          .map((e: any) => e?.text)
          .filter(Boolean);
        const prefix = extTexts.length ? `[${extTexts.join("; ")}] ` : "";
        const desc = String(r.description ?? "");
        return {
          url: String(r.link ?? ""),
          title: String(r.title ?? ""),
          snippet: `${prefix}${desc}`,
        };
      }).filter((r: SerpResult) => r.url);
    } finally {
      clearTimeout(timer);
    }
  }, {
    retries: RETRIES,
    label: "brightdata",
    onRetry: (attempt, err, delayMs) => {
      console.error(`${LOG} brightdata retry attempt=${attempt} in ${delayMs}ms after: ${err.message}`);
    },
  });
}

async function searchSearxng(query: string, count: number, searxngUrl: string): Promise<SerpResult[]> {
  const url = new URL(`${searxngUrl.replace(/\/$/, "")}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");

  return withRetry(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SEARXNG_TIMEOUT_MS);
    try {
      let resp: Response;
      try {
        resp = await fetch(url.toString(), { signal: ctrl.signal });
      } catch (err) {
        const e = err as Error;
        if (e.name === "AbortError" || /aborted/i.test(e.message)) {
          throw new Error(`SearXNG timeout after ${SEARXNG_TIMEOUT_MS}ms (url=${searxngUrl})`);
        }
        throw new Error(`SearXNG network: ${e.message} (url=${searxngUrl})`);
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => resp.statusText);
        throw new Error(`SearXNG HTTP ${resp.status}: ${body.slice(0, 300)}`);
      }
      const data: any = await resp.json();
      const items: any[] = data?.results ?? [];
      return items.slice(0, count).map((r) => ({
        url: String(r.url ?? ""),
        title: String(r.title ?? ""),
        snippet: String(r.content ?? ""),
      })).filter((r) => r.url);
    } finally {
      clearTimeout(timer);
    }
  }, {
    retries: RETRIES,
    label: "searxng",
    onRetry: (attempt, err, delayMs) => {
      console.error(`${LOG} searxng retry attempt=${attempt} in ${delayMs}ms after: ${err.message}`);
    },
  });
}

export async function searchWeb(
  query: string,
  opts: { backend: SearchBackend; count: number; config: SearchConfig },
): Promise<SearchOutcome> {
  const { backend, count, config } = opts;
  const tried: SerpBackend[] = [];
  const errs: string[] = [];

  // auto: Brave → Bright Data → SearXNG. Brave и Bright Data скипаются в auto,
  // если для них нет ключей — Bright Data остаётся в коде выключенным
  // (не экспонируется в enum тула), но остаётся вызываемой при явном backend="web".
  const haveBraveKey = !!(config.braveApiKey && config.braveApiKey.trim());
  const haveBd = !!(
    config.brightdataApiKey && config.brightdataApiKey.trim()
    && config.brightdataZone && config.brightdataZone.trim()
  );

  if (backend === "brave" || (backend === "auto" && haveBraveKey)) {
    tried.push("brave");
    try {
      const results = await searchBrave(query, count, config.braveApiKey ?? "");
      return { status: "ok", backend: "brave", results };
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      errs.push(`brave: ${msg}`);
      if (backend === "brave") {
        return { status: "error", backend_tried: tried, reason: msg };
      }
      console.error(`${LOG} backend=brave failed (${msg}), falling back to brightdata`);
    }
  }

  if (backend === "web" || (backend === "auto" && haveBd)) {
    tried.push("web");
    try {
      const results = await searchBrightdata(
        query,
        count,
        config.brightdataApiKey ?? "",
        config.brightdataZone ?? "",
        config.brightdataHl ?? "ru",
      );
      return { status: "ok", backend: "web", results };
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      errs.push(`web: ${msg}`);
      if (backend === "web") {
        return { status: "error", backend_tried: tried, reason: msg };
      }
      console.error(`${LOG} backend=web failed (${msg}), falling back to searxng`);
    }
  }

  if (backend === "searxng" || backend === "auto") {
    tried.push("searxng");
    try {
      const results = await searchSearxng(query, count, config.searxngUrl);
      return { status: "ok", backend: "searxng", results };
    } catch (err) {
      errs.push(`searxng: ${String((err as Error).message ?? err)}`);
    }
  }

  return { status: "error", backend_tried: tried, reason: errs.join("; ") };
}
