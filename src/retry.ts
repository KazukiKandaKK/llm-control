import { RequestMeta, RunResult } from "./types";
import { sleep } from "./utils/time";

export type RetryConfig = {
  maxRetries: number;
  baseDelayMs: number;
  jitterRatio?: number; // 0..1
};

const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 2,
  baseDelayMs: 200,
  jitterRatio: 0.5
};

export async function withRetries<T>(
  runner: () => Promise<RunResult<T>>,
  meta: RequestMeta,
  config: RetryConfig = DEFAULT_RETRY,
  telemetry?: { onRetry?: (ctx: RequestMeta) => void }
): Promise<RunResult<T>> {
  let attempt = 0;
  while (true) {
    try {
      return await runner();
    } catch (err: any) {
      attempt += 1;
      const signal = err?.meta?.errorType ?? err?.meta?.status;
      if (attempt > config.maxRetries) throw err;
      if (err?.meta?.status === 429 || err?.meta?.status === 503 || err?.meta?.errorType === "timeout") {
        const retryAfterMs = parseRetryAfter(err);
        const backoff = retryAfterMs ?? jittered(config.baseDelayMs * attempt, config.jitterRatio ?? 0.5);
        telemetry?.onRetry?.(meta);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
}

function parseRetryAfter(err: any): number | undefined {
  const headers = err?.meta?.headers as Record<string, string> | undefined;
  if (!headers) return undefined;
  const header = headers["retry-after"] ?? headers["Retry-After"];
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function jittered(base: number, ratio: number): number {
  const spread = base * ratio;
  return Math.max(0, base + (Math.random() * spread - spread / 2));
}
