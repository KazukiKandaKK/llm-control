export type RequestMeta = {
  provider: string;
  model: string;
  tenant?: string;
  priority?: number;
  maxOutputTokens?: number;
  inputText?: string;
  headers?: Record<string, string>;
  id?: string; // optional request id for streaming accounting
};

export type ResponseMeta = {
  status: number;
  headers: Record<string, string>;
  errorType?: "rate_limit" | "timeout" | "server_error" | "client_error" | "unknown";
  inputTokens?: number;
  outputTokens?: number;
  startAt: number;
  firstTokenAt?: number;
  endAt: number;
};

export type CostEstimate = {
  inputTokens: number;
  outputTokens: number;
};

export type Signal =
  | { type: "success" }
  | { type: "rate_limit"; retryAfterMs?: number }
  | { type: "soft_loss"; reason: "timeout" | "server_error" }
  | { type: "client_error" }
  | { type: "unknown" };

export type RunResult<T> = {
  result: T;
  meta: ResponseMeta;
};

export type TokenLimiterConfig = {
  rInit: number;
  rMin: number;
  rMax: number;
  bucketSize: number;
  additiveStep: number;
  beta: number;
  betaSoft: number;
  settlementMode: "debt" | "allow_negative";
};

export type ConcurrencyLimiterConfig = {
  cwndInit: number;
  cwndMin: number;
  cwndMax: number;
  betaC: number;
  delayDecrease?: number;
  delayThresholdMs?: number;
};

export type QueueConfig = {
  enabled: boolean;
  maxSize: number;
  timeoutMs: number;
};

export type RateLimitHeaderNames = {
  limitTokensHeader?: string;
  remainingTokensHeader?: string;
  windowSecondsHeader?: string;
  resetMsHeader?: string;
};

export type ControlConfig = {
  queue: QueueConfig;
  tokenLimiter: TokenLimiterConfig;
  concurrencyLimiter: ConcurrencyLimiterConfig;
  dimensions?: Array<"provider" | "model" | "tenant">;
  rateLimitHeaders?: Record<string, RateLimitHeaderNames>;
};

export interface CostEstimator {
  estimate(req: RequestMeta): CostEstimate;
  settle(req: RequestMeta, meta: ResponseMeta): void;
}

export interface SignalClassifier {
  classify(meta: ResponseMeta): Signal;
}

export interface TelemetrySink {
  onQueueWait?(ms: number, ctx: RequestMeta): void;
  onLimiterState?(state: {
    cwnd: number;
    inflight: number;
    r: number;
    bucket: number;
    debt: number;
  }, ctx: RequestMeta): void;
  onError?(signal: Signal, ctx: RequestMeta): void;
  onLatency?(latency: { firstTokenMs?: number; totalMs: number }, ctx: RequestMeta): void;
  onRetry?(ctx: RequestMeta): void;
}

export interface LLMControl {
  run<T>(req: RequestMeta, fn: () => Promise<RunResult<T>>): Promise<RunResult<T>>;
  onStreamToken?(reqId: string, deltaTokens: number): void;
}
