import { RequestMeta, Signal, TelemetrySink } from "../types";

type Labels = { provider: string; model: string; tenant: string };

const LAT_BUCKETS = [0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5, 10]; // seconds
const QUEUE_BUCKETS = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1]; // seconds

function labels(ctx: RequestMeta): Labels {
  return {
    provider: ctx.provider,
    model: ctx.model,
    tenant: ctx.tenant ?? "default"
  };
}

function bucketKey(prefix: string, bucket: number, l: Labels): string {
  return `${prefix}{provider="${l.provider}",model="${l.model}",tenant="${l.tenant}",le="${bucket}"}`;
}

function gaugeKey(name: string, l: Labels): string {
  return `${name}{provider="${l.provider}",model="${l.model}",tenant="${l.tenant}"}`;
}

export class PrometheusTelemetry implements TelemetrySink {
  counters = new Map<string, number>();
  gauges = new Map<string, number>();

  onQueueWait(ms: number, ctx: RequestMeta): void {
    const l = labels(ctx);
    const seconds = ms / 1000;
    for (const b of QUEUE_BUCKETS) {
      if (seconds <= b) {
        const key = bucketKey("llm_queue_wait_seconds_bucket", b, l);
        this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
        break;
      }
    }
  }

  onLimiterState(
    state: { cwnd: number; inflight: number; r: number; bucket: number; debt: number },
    ctx: RequestMeta
  ): void {
    const l = labels(ctx);
    this.gauges.set(gaugeKey("llm_cc_cwnd", l), state.cwnd);
    this.gauges.set(gaugeKey("llm_cc_inflight", l), state.inflight);
    this.gauges.set(gaugeKey("llm_tr_rate", l), state.r);
    this.gauges.set(gaugeKey("llm_tr_bucket", l), state.bucket);
    this.gauges.set(gaugeKey("llm_tr_debt", l), state.debt);
  }

  onError(signal: Signal, ctx: RequestMeta): void {
    const l = labels(ctx);
    const key = `${"llm_errors_total"}{provider="${l.provider}",model="${l.model}",tenant="${l.tenant}",signal="${signal.type}"}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  onLatency(latency: { firstTokenMs?: number; totalMs: number }, ctx: RequestMeta): void {
    const l = labels(ctx);
    const ftlSeconds = latency.firstTokenMs !== undefined ? latency.firstTokenMs / 1000 : undefined;
    const totalSeconds = latency.totalMs / 1000;

    if (ftlSeconds !== undefined) {
      for (const b of LAT_BUCKETS) {
        if (ftlSeconds <= b) {
          const key = bucketKey("llm_latency_first_token_seconds_bucket", b, l);
          this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
          break;
        }
      }
    }

    for (const b of LAT_BUCKETS) {
      if (totalSeconds <= b) {
        const key = bucketKey("llm_latency_total_seconds_bucket", b, l);
        this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
        break;
      }
    }
  }

  onRetry(ctx: RequestMeta): void {
    const l = labels(ctx);
    const key = `${"llm_retries_total"}{provider="${l.provider}",model="${l.model}",tenant="${l.tenant}"}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  snapshot() {
    return {
      counters: new Map(this.counters),
      gauges: new Map(this.gauges)
    };
  }
}
