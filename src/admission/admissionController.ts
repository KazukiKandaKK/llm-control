import {
  ControlConfig,
  CostEstimator,
  LLMControl,
  RequestMeta,
  ResponseMeta,
  RunResult,
  SignalClassifier,
  TelemetrySink
} from "../types";
import { TokenLimiter } from "../limiters/tokenLimiter";
import { ConcurrencyLimiter } from "../limiters/concurrencyLimiter";
import { QueueOverflowError, QueueTimeoutError } from "../errors";
import { sleep } from "../utils/time";

type AdmissionDeps = {
  costEstimator: CostEstimator;
  tokenLimiter: TokenLimiter;
  concurrencyLimiter: ConcurrencyLimiter;
  signalClassifier: SignalClassifier;
  telemetry?: TelemetrySink;
};

type LimiterBundle = {
  tokenLimiter: TokenLimiter;
  concurrencyLimiter: ConcurrencyLimiter;
  baselineFTL?: number;
};

export class AdmissionController implements LLMControl {
  private queueSize = 0;
  private retryAfterUntil = 0;
  private readonly bundles = new Map<string, LimiterBundle>();
  private readonly defaultBundle: LimiterBundle;
  private readonly streamOutputs = new Map<string, number>();

  constructor(
    private readonly config: ControlConfig,
    private readonly deps: AdmissionDeps
  ) {
    this.defaultBundle = {
      tokenLimiter: deps.tokenLimiter,
      concurrencyLimiter: deps.concurrencyLimiter
    };
  }

  async run<T>(
    req: RequestMeta,
    fn: () => Promise<RunResult<T>>
  ): Promise<RunResult<T>> {
    const reqId = req.id ?? `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const bundle = this.getBundle(req);
    const estimate = this.deps.costEstimator.estimate(req);
    const costPred = estimate.inputTokens + estimate.outputTokens;
    const deadline = Date.now() + this.config.queue.timeoutMs;

    if (this.queueSize >= this.config.queue.maxSize) {
      throw new QueueOverflowError();
    }

    this.queueSize += 1;
    const queuedAt = Date.now();

    while (Date.now() < deadline) {
      bundle.tokenLimiter.refill();

      if (Date.now() < this.retryAfterUntil) {
        await sleep(10);
        continue;
      }

      if (bundle.tokenLimiter.canAcquire(costPred) && bundle.concurrencyLimiter.canAcquire()) {
        bundle.tokenLimiter.acquire(costPred);
        bundle.concurrencyLimiter.acquire();
        this.queueSize -= 1;

        const wait = Date.now() - queuedAt;
        this.deps.telemetry?.onQueueWait?.(wait, req);

        const startAt = Date.now();
        try {
          this.streamOutputs.set(reqId, 0);
          const { result, meta } = await fn();
          const metaWithTimes = this.ensureTiming(meta, startAt);
          this.onComplete(req, reqId, metaWithTimes, costPred, estimate);
          return { result, meta: metaWithTimes };
        } catch (error) {
          const meta = this.buildErrorMeta(error, startAt);
          this.onComplete(req, reqId, meta, costPred, estimate);
          throw error;
        } finally {
          this.streamOutputs.delete(reqId);
        }
      }

      await sleep(10);
    }

    this.queueSize -= 1;
    throw new QueueTimeoutError();
  }

  private onComplete(
    req: RequestMeta,
    reqId: string,
    meta: ResponseMeta,
    costPred: number,
    estimate: { inputTokens: number; outputTokens: number }
  ): void {
    const bundle = this.getBundle(req);
    bundle.concurrencyLimiter.release();

    const streamingOut = this.streamOutputs.get(reqId);
    const outputTokens =
      meta.outputTokens ?? streamingOut ?? estimate.outputTokens;
    const costActual =
      (meta.inputTokens ?? estimate.inputTokens) + outputTokens;

    bundle.tokenLimiter.settle(costPred, costActual);
    this.deps.costEstimator.settle(req, meta);

    this.applyRateLimitHeaders(meta, bundle, req);

    const signal = this.deps.signalClassifier.classify(meta);
    this.applySignal(signal, req, bundle, meta);

    const concState = bundle.concurrencyLimiter.getState();
    const tokenState = bundle.tokenLimiter.getState();
    this.deps.telemetry?.onLimiterState?.(
      {
        cwnd: concState.cwnd,
        inflight: concState.inflight,
        r: tokenState.r,
        bucket: tokenState.bucket,
        debt: tokenState.debt
      },
      req
    );

    this.deps.telemetry?.onLatency?.(
      {
        firstTokenMs:
          meta.firstTokenAt && meta.startAt
            ? meta.firstTokenAt - meta.startAt
            : undefined,
        totalMs: meta.endAt - meta.startAt
      },
      req
    );
  }

  private applySignal(
    signal: ReturnType<SignalClassifier["classify"]>,
    req: RequestMeta,
    bundle: LimiterBundle,
    meta: ResponseMeta
  ): void {
    if (signal.type === "success") {
      this.applyDelaySignal(meta, bundle);
      bundle.tokenLimiter.onSuccess();
      bundle.concurrencyLimiter.onSuccess();
      return;
    }

    if (signal.type === "rate_limit") {
      bundle.tokenLimiter.onLoss();
      bundle.concurrencyLimiter.onLoss();
      if (signal.retryAfterMs) {
        this.retryAfterUntil = Math.max(
          this.retryAfterUntil,
          Date.now() + signal.retryAfterMs
        );
      }
      this.deps.telemetry?.onError?.(signal, req);
      return;
    }

    if (signal.type === "soft_loss") {
      bundle.tokenLimiter.onSoftLoss();
      bundle.concurrencyLimiter.onLoss();
      this.deps.telemetry?.onError?.(signal, req);
      return;
    }

    this.deps.telemetry?.onError?.(signal, req);
  }

  private applyDelaySignal(meta: ResponseMeta, bundle: LimiterBundle): void {
    if (!meta.firstTokenAt || !meta.startAt) return;
    const ftl = meta.firstTokenAt - meta.startAt;
    if (ftl < 0) return;
    const lambda = 0.2;
    if (bundle.baselineFTL === undefined) {
      bundle.baselineFTL = ftl;
      return;
    }
    bundle.baselineFTL = lambda * ftl + (1 - lambda) * bundle.baselineFTL;
    const threshold = this.config.concurrencyLimiter.delayThresholdMs;
    if (threshold === undefined) return;
    const qdelay = ftl - bundle.baselineFTL;
    if (qdelay > threshold) {
      bundle.concurrencyLimiter.onDelaySignal();
    }
  }

  private applyRateLimitHeaders(meta: ResponseMeta, bundle: LimiterBundle, req: RequestMeta): void {
    const headers = meta.headers ?? {};
    const mapping = this.config.rateLimitHeaders?.[req.provider] ?? {};
    const limitHeader = mapping.limitTokensHeader ?? "x-ratelimit-limit-tokens";
    const remainingHeader = mapping.remainingTokensHeader ?? "x-ratelimit-remaining-tokens";
    const windowHeader = mapping.windowSecondsHeader ?? "x-ratelimit-window-seconds";
    const resetMsHeader = mapping.resetMsHeader ?? "x-ratelimit-reset-ms";

    const limitTokens = parseInt(this.headerValue(headers, limitHeader) ?? "", 10);
    const remainingTokens = parseInt(this.headerValue(headers, remainingHeader) ?? "", 10);
    const windowSeconds = parseInt(this.headerValue(headers, windowHeader) ?? "", 10);
    const resetMs = parseInt(this.headerValue(headers, resetMsHeader) ?? "", 10);
    if (!Number.isNaN(limitTokens) || !Number.isNaN(remainingTokens)) {
      bundle.tokenLimiter.applyRemoteLimit({
        limitTokens: Number.isNaN(limitTokens) ? undefined : limitTokens,
        remainingTokens: Number.isNaN(remainingTokens) ? undefined : remainingTokens
      });
      bundle.tokenLimiter.applyRemoteRate({
        limitTokens: Number.isNaN(limitTokens) ? undefined : limitTokens,
        windowSeconds: Number.isNaN(windowSeconds) ? undefined : windowSeconds,
        resetMs: Number.isNaN(resetMs) ? undefined : resetMs
      });
    }
  }

  private getBundle(req: RequestMeta): LimiterBundle {
    if (!this.config.dimensions || this.config.dimensions.length === 0) {
      return this.defaultBundle;
    }
    const keyParts = this.config.dimensions.map((d) => req[d] ?? "default");
    const key = keyParts.join("|");
    const existing = this.bundles.get(key);
    if (existing) return existing;
    const bundle: LimiterBundle = {
      tokenLimiter: new TokenLimiter(this.config.tokenLimiter),
      concurrencyLimiter: new ConcurrencyLimiter(this.config.concurrencyLimiter)
    };
    this.bundles.set(key, bundle);
    return bundle;
  }

  getBundleForTest(req: RequestMeta): LimiterBundle {
    return this.getBundle(req);
  }

  private headerValue(headers: Record<string, string>, name: string): string | undefined {
    const target = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === target) return headers[key];
    }
    return undefined;
  }

  onStreamToken(reqId: string, deltaTokens: number): void {
    const current = this.streamOutputs.get(reqId) ?? 0;
    this.streamOutputs.set(reqId, current + deltaTokens);
  }

  private ensureTiming(meta: ResponseMeta, startAt: number): ResponseMeta {
    return {
      ...meta,
      startAt: meta.startAt ?? startAt,
      endAt: meta.endAt ?? Date.now()
    };
  }

  private buildErrorMeta(error: unknown, startAt: number): ResponseMeta {
    const endAt = Date.now();
    if (
      error &&
      typeof error === "object" &&
      "meta" in error &&
      typeof (error as any).meta === "object"
    ) {
      const meta = (error as any).meta as Partial<ResponseMeta>;
      return {
        status: meta.status ?? 500,
        headers: meta.headers ?? {},
        errorType: meta.errorType ?? "unknown",
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
        startAt: meta.startAt ?? startAt,
        endAt: meta.endAt ?? endAt
      };
    }

    return {
      status: 500,
      headers: {},
      errorType: "unknown",
      startAt,
      endAt
    };
  }
}
