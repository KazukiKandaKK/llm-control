import { RunResult, ResponseMeta } from "../src/types";
import { sleep } from "../src/utils/time";

export type PseudoLLMConfig = {
  rateLimitChance?: number;
  serverErrorChance?: number;
  timeoutChance?: number;
  baseFirstTokenMs?: number;
  totalDurationMs?: number;
  outputTokens?: number;
};

const DEFAULTS: Required<PseudoLLMConfig> = {
  rateLimitChance: 0.0,
  serverErrorChance: 0.0,
  timeoutChance: 0.0,
  baseFirstTokenMs: 120,
  totalDurationMs: 800,
  outputTokens: 120
};

export class PseudoLLMServer {
  private readonly cfg: Required<PseudoLLMConfig>;

  constructor(config: PseudoLLMConfig = {}) {
    this.cfg = { ...DEFAULTS, ...config };
  }

  async call(prompt: string): Promise<RunResult<string>> {
    const startAt = Date.now();
    const ftl = this.jitter(this.cfg.baseFirstTokenMs);
    const duration = this.jitter(this.cfg.totalDurationMs);

    await sleep(ftl);

    const roll = Math.random();
    if (roll < this.cfg.rateLimitChance) {
      throw this.withMeta("rate limit", {
        status: 429,
        headers: { "retry-after": "1" },
        errorType: "rate_limit",
        startAt,
        endAt: Date.now()
      });
    }

    if (roll < this.cfg.rateLimitChance + this.cfg.serverErrorChance) {
      throw this.withMeta("server error", {
        status: 503,
        headers: {},
        errorType: "server_error",
        startAt,
        endAt: Date.now()
      });
    }

    if (roll < this.cfg.rateLimitChance + this.cfg.serverErrorChance + this.cfg.timeoutChance) {
      throw this.withMeta("timeout", {
        status: 504,
        headers: {},
        errorType: "timeout",
        startAt,
        endAt: Date.now()
      });
    }

    await sleep(Math.max(0, duration - ftl));

    const meta: ResponseMeta = {
      status: 200,
      headers: {},
      inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
      outputTokens: this.cfg.outputTokens,
      startAt,
      firstTokenAt: startAt + ftl,
      endAt: startAt + duration
    };

    return {
      result: `ok:${prompt.slice(0, 16)}`,
      meta
    };
  }

  private jitter(value: number): number {
    const spread = value * 0.1;
    return Math.max(0, value + (Math.random() * spread - spread / 2));
  }

  private withMeta(message: string, meta: ResponseMeta): Error {
    const err = new Error(message);
    (err as any).meta = meta;
    return err;
  }
}
