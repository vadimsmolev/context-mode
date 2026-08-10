import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "playwright";

// Гард против фатального краша MCP-сервера от stealth-teardown. playwright-extra гоняет часть
// CDP-эвазий fire-and-forget (index.cjs.js → _client().send/on): если контекст закрыт раньше
// (быстрый ctx.close на 4xx/WAF), CDP-вызов отклоняется и никем не ловится → unhandledRejection
// → процесс падает. Регистрируем узкий предикат прямо на process.on("unhandledRejection"):
// глотаем ТОЛЬКО stealth-CDP-close, всё остальное по-прежнему фатально (re-throw).
// Идемпотентно — модуль может быть переимпортирован (dynamic import) многократно за жизнь процесса.
{
  const G = globalThis as any;
  const INSTALLED = Symbol.for("context-mode.cdpRejectionGuardInstalled");
  if (!G[INSTALLED]) {
    process.on("unhandledRejection", (reason: any) => {
      const msg: string = reason?.message ?? (typeof reason === "string" ? reason : "");
      const stack: string = reason?.stack ?? "";
      const isClose = /Target page, context or browser has been closed|Target closed/i.test(msg);
      const fromCdp = /cdpSession\.send|playwright-extra/i.test(msg + stack);
      if (isClose && fromCdp) {
        console.warn("[cm] swallowed benign stealth CDP-close rejection:", msg);
        return;
      }
      throw reason;
    });
    G[INSTALLED] = true;
  }
}

// Отключаем stealth-эвазию webgl.vendor: она проставляет канонную "Intel Iris OpenGL Engine"
// (известный анти-бот tell). WebGL-строку задаём сами в applyFingerprint — реальным GPU хоста.
const stealth = StealthPlugin();
stealth.enabledEvasions.delete("webgl.vendor");
chromiumExtra.use(stealth);

// WebGL-строки реального GPU хоста, отдаваемые как параметр (не замыкание) — см. applyFingerprint.
const WEBGL_VENDOR = "Google Inc. (NVIDIA)";
const WEBGL_RENDERER = "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti SUPER (0x00002705) Direct3D11 vs_5_0 ps_5_0, D3D11)";

// B2 fingerprint-hardening. Замерено (about:blank, new-headless+stealth): userAgentData=null,
// languages=en-US, deviceMemory=undefined, hardwareConcurrency=4, webgl=Intel Iris — всё палит
// headless. Init-script перекрывает их консистентно под Windows-Chrome (UA stealth и так Windows;
// platform=Win32). Версию прокидываем из реального бинаря, чтобы не дрейфовала при апдейте Chromium.
// Сериализуется и исполняется в браузере — TS-типы стираются, доступны только browser-глобалы;
// поэтому все внешние значения (включая WebGL vendor/renderer) идут параметром, не замыканием.
function applyFingerprint({
  uaFull,
  uaMajor,
  webglVendor,
  webglRenderer,
}: {
  uaFull: string;
  uaMajor: string;
  webglVendor: string;
  webglRenderer: string;
}) {
  const def = (obj: any, prop: string, val: any) => {
    try { Object.defineProperty(obj, prop, { get: () => val, configurable: true }); } catch { /* ignore */ }
  };
  def(navigator, "languages", ["ru-RU", "ru"]);
  def(navigator, "deviceMemory", 8);
  def(navigator, "hardwareConcurrency", 8);

  const brands = [
    { brand: "Not)A;Brand", version: "24" },
    { brand: "Chromium", version: uaMajor },
    { brand: "Google Chrome", version: uaMajor },
  ];
  const fullVersionList = [
    { brand: "Not)A;Brand", version: "24.0.0.0" },
    { brand: "Chromium", version: uaFull },
    { brand: "Google Chrome", version: uaFull },
  ];
  def(navigator, "userAgentData", {
    brands, mobile: false, platform: "Windows",
    getHighEntropyValues: () => Promise.resolve({
      architecture: "x86", bitness: "64", brands, fullVersionList,
      mobile: false, model: "", platform: "Windows", platformVersion: "10.0.0",
      uaFullVersion: uaFull, wow64: false,
    }),
    toJSON: () => ({ brands, mobile: false, platform: "Windows" }),
  });

  // WebGL → реальный GPU хоста, как его отдал бы Windows-Chrome через ANGLE/D3D11.
  const VENDOR = webglVendor;
  const RENDERER = webglRenderer;
  const protos = [
    typeof WebGLRenderingContext !== "undefined" ? WebGLRenderingContext.prototype : null,
    typeof WebGL2RenderingContext !== "undefined" ? WebGL2RenderingContext.prototype : null,
  ];
  for (const proto of protos) {
    if (!proto) continue;
    const orig = (proto as any).getParameter;
    (proto as any).getParameter = function (this: any, p: number) {
      if (p === 37445) return VENDOR;   // UNMASKED_VENDOR_WEBGL
      if (p === 37446) return RENDERER; // UNMASKED_RENDERER_WEBGL
      return orig.call(this, p);
    };
  }
}

const BROWSER_FETCH_TIMEOUT_MS = 30_000;
const BROWSER_FETCH_MAX_TEXT_KB = 300;
const BROWSER_FETCH_INDEX_MIN_KB = 1;
const STABILITY_INTERVAL_MS = 100;   // poll interval
const STABILITY_MAX_MS = 5_000;      // max wait for content to stabilize
const STABILITY_ROUNDS = 2;          // consecutive equal-length readings = stable
const STABILITY_MIN_CHARS = 500;     // below this — never exit early, wait for more content

const BLOCKED_MARKERS = [
  "Checking your browser",
  "captcha",
  "Just a moment",
  "Access denied",
  "cf-browser-verification",
];

const COOKIE_ACCEPT_SELECTORS = [
  "#onetrust-accept-btn-handler",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "button[id*='accept'][id*='cookie']",
  "button[class*='accept'][class*='cookie']",
  "[class*='cookie-banner'] button",
  "[id*='cookie-banner'] button",
  "[class*='CookieBanner'] button",
  "[class*='Cookies'] button",
  "[data-testid*='cookie'] button",
];

export type BrowserFetchOk = {
  ok: true;
  url: string;
  kb: number;
  indexed: boolean;
  source: string;
  attempts: number;
  ms: number;
  text: string;
};

export type BrowserFetchErr = {
  ok: false;
  url: string;
  error: "timeout" | "navigation" | "internal" | "blocked" | "empty";
  reason?: string;
  attempts: number;
  ms: number;
};

export type BrowserFetchResult = BrowserFetchOk | BrowserFetchErr;

let _browser: Browser | null = null;
let _initPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (_browser?.isConnected()) return _browser;
  if (_initPromise) return _initPromise;
  // Held in a local so the return below narrows to `Promise<Browser>` — TS
  // can't retain that narrowing on the mutable module-level `_initPromise`
  // once a closure in the chain (the disconnected handler) writes it back.
  const promise: Promise<Browser> = (chromiumExtra as any).launch({
    headless: true,
    channel: "chromium", // полный chromium-бинарь → new-headless (plugins=5, честный UA), а не headless_shell
    args: [
      "--disable-blink-features=AutomationControlled",
      "--lang=ru-RU,ru",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  }).then((b: Browser) => {
    _browser = b;
    b.on("disconnected", () => { _browser = null; _initPromise = null; });
    return b;
  }).catch((err: Error) => {
    _initPromise = null;
    throw err;
  });
  _initPromise = promise;
  return promise;
}

async function waitForStableText(page: Page): Promise<void> {
  const deadline = Date.now() + STABILITY_MAX_MS;
  let prev = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(STABILITY_INTERVAL_MS);
    const len: number = await page.evaluate(() => document.body?.innerText?.length ?? 0);
    if (len >= STABILITY_MIN_CHARS && len === prev) {
      stable++;
      if (stable >= STABILITY_ROUNDS) return;
    } else {
      stable = 0;
    }
    prev = len;
  }
}

function classifyError(err: Error): BrowserFetchErr["error"] {
  const msg = err.message || "";
  if (/Timeout|exceeded/i.test(msg)) return "timeout";
  if (/net::|ERR_|Navigation/i.test(msg)) return "navigation";
  return "internal";
}

export async function browserFetchPage(opts: {
  url: string;
  source: string;
  timeoutMs?: number;
  retries?: number;
  maxKb?: number;
  scrollPages?: number;
  indexer?: (params: { content: string; source: string }) => Promise<void>;
}): Promise<BrowserFetchResult> {
  const {
    url,
    source,
    timeoutMs = BROWSER_FETCH_TIMEOUT_MS,
    retries = 1,
    maxKb = BROWSER_FETCH_MAX_TEXT_KB,
    scrollPages = 1,
    indexer,
  } = opts;

  const t0 = Date.now();
  let attempts = 0;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    attempts++;
    const browser = await getBrowser();
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      locale: "ru-RU",
      timezoneId: "Europe/Moscow",
      viewport: { width: 1440, height: 900 },
      // userAgent не пиним: stealth (user-agent-override) и так выставляет актуальный Windows-Chrome
      // (замерено 148.x); старый пин Chrome/124 был мёртвым и рассинхронивал client-hints.
    });
    const uaFull = browser.version();
    await ctx.addInitScript(applyFingerprint, {
      uaFull,
      uaMajor: uaFull.split(".")[0],
      webglVendor: WEBGL_VENDOR,
      webglRenderer: WEBGL_RENDERER,
    });
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
      // HTTP-status gate. WAF/анти-бот (Qrator у dns-shop, ozon под VPN) и битые
      // страницы отдают 4xx/5xx с непустым телом-заглушкой (>100 символов), которое
      // иначе проходило бы как ok=true и засчитывалось бы как покрытый источник.
      // Код ответа надёжнее эвристик по длине текста и списку маркеров. Fail-fast:
      // не тратим scroll + waitForStableText (до 5с) на заведомо мёртвую страницу.
      const httpStatus = resp?.status() ?? 0;
      if (httpStatus >= 400) {
        await ctx.close().catch(() => {});
        const ms = Date.now() - t0;
        const isBlock = httpStatus === 401 || httpStatus === 403 || httpStatus === 429;
        return {
          ok: false,
          url,
          error: isBlock ? "blocked" : "navigation",
          reason: `HTTP ${httpStatus}`,
          attempts,
          ms,
        };
      }
      // Scroll triggers lazy-load and looks human-like
      await page.evaluate(() => window.scrollBy(0, 600));
      await waitForStableText(page);
      for (let p = 1; p < scrollPages; p++) {
        await page.evaluate(() => window.scrollBy(0, 1200));
        await waitForStableText(page);
      }

      // Cookie consent (best effort, short timeouts)
      for (const selector of COOKIE_ACCEPT_SELECTORS) {
        try {
          const btn = page.locator(selector).first();
          if (await btn.isVisible({ timeout: 500 })) {
            await btn.click({ timeout: 1000 });
            await page.waitForTimeout(500);
            break;
          }
        } catch { /* ignore */ }
      }

      const text = await page.evaluate(() => (document.body?.innerText ?? "").trim());
      await ctx.close();

      const ms = Date.now() - t0;

      if (text.length < 2000 && BLOCKED_MARKERS.some(m => text.toLowerCase().includes(m.toLowerCase()))) {
        return { ok: false, url, error: "blocked", reason: "anti-bot markers detected", attempts, ms };
      }

      if (text.length < 100) {
        return { ok: false, url, error: "empty", reason: `extracted text too short (${text.length} chars)`, attempts, ms };
      }

      const maxBytes = maxKb * 1024;
      const truncated = text.length > maxBytes ? text.slice(0, maxBytes) : text;
      const kb = Math.round(truncated.length / 102.4) / 10;

      let indexed = false;
      if (indexer && truncated.length >= BROWSER_FETCH_INDEX_MIN_KB * 1024) {
        await indexer({ content: truncated, source });
        indexed = true;
      }

      return { ok: true, url, kb, indexed, source, attempts, ms, text: truncated };
    } catch (err) {
      await ctx.close().catch(() => {});
      lastErr = err as Error;
    }
  }

  const ms = Date.now() - t0;
  return {
    ok: false,
    url,
    error: classifyError(lastErr!),
    reason: lastErr?.message,
    attempts,
    ms,
  };
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
    _initPromise = null;
  }
}
