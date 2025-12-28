import { RequestMeta, Signal, TelemetrySink } from "../types";

type Counter = Map<string, number>;
type Gauge = Map<string, number>;

function key(ctx: RequestMeta): string {
  return `${ctx.provider}:${ctx.model}:${ctx.tenant ?? "default"}`;
}

export class MetricsTelemetry implements TelemetrySink {
  queueWaitMs: Counter = new Map();
  errors: Counter = new Map();
  limiterGauge: Gauge = new Map();

  onQueueWait(ms: number, ctx: RequestMeta): void {
    const k = key(ctx);
    this.queueWaitMs.set(k, (this.queueWaitMs.get(k) ?? 0) + ms);
  }

  onLimiterState(
    state: { cwnd: number; inflight: number; r: number; bucket: number; debt: number },
    ctx: RequestMeta
  ): void {
    const k = key(ctx);
    this.limiterGauge.set(k, state.cwnd);
  }

  onError(signal: Signal, ctx: RequestMeta): void {
    const k = key(ctx) + `:${signal.type}`;
    this.errors.set(k, (this.errors.get(k) ?? 0) + 1);
  }

  snapshot() {
    return {
      queueWaitMs: new Map(this.queueWaitMs),
      errors: new Map(this.errors),
      limiterGauge: new Map(this.limiterGauge)
    };
  }
}
