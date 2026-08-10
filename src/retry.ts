export type RetryOpts = {
  retries: number;
  baseDelayMs?: number;
  label: string;
  shouldRetry?: (err: Error) => boolean;
  onRetry?: (attempt: number, err: Error, delayMs: number) => void;
};

const DEFAULT_BASE_DELAY_MS = 500;

export function defaultShouldRetry(err: Error): boolean {
  const msg = err.message || "";

  if (/BRAVE_API_KEY not set/i.test(msg)) return false;
  if (/Missing extractorApiKey/i.test(msg)) return false;
  if (/not supported yet/i.test(msg)) return false;

  if (err.name === "AbortError" || /aborted/i.test(msg) || /timeout/i.test(msg)) return true;

  const httpMatch = msg.match(/HTTP (\d{3})/);
  if (httpMatch) {
    const code = Number(httpMatch[1]);
    if (code === 429) return true;
    if (code >= 500 && code < 600) return true;
    return false;
  }

  if (/fetch failed/i.test(msg) || /network/i.test(msg) || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/.test(msg)) {
    return true;
  }

  return false;
}

function computeDelay(attempt: number, baseDelayMs: number): number {
  const raw = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = raw * (Math.random() * 0.4 - 0.2);
  return Math.max(0, Math.round(raw + jitter));
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;
  const maxAttempts = 1 + opts.retries;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      lastError = e;
      if (attempt >= maxAttempts || !shouldRetry(e)) throw e;

      const delayMs = computeDelay(attempt, baseDelayMs);
      opts.onRetry?.(attempt, e, delayMs);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError ?? new Error(`${opts.label}: withRetry exhausted without error`);
}
