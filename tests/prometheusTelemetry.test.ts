import { describe, expect, it } from "vitest";
import { PrometheusTelemetry } from "../src/telemetry/prometheusTelemetry";
import { RequestMeta } from "../src/types";

const ctx: RequestMeta = { provider: "sim", model: "demo" };

describe("PrometheusTelemetry", () => {
  it("records queue wait buckets and gauges", () => {
    const tel = new PrometheusTelemetry();
    tel.onQueueWait(10, ctx); // 0.01s boundary bucket
    tel.onQueueWait(200, ctx); // 0.2s bucket
    tel.onLimiterState({ cwnd: 2, inflight: 1, r: 100, bucket: 50, debt: 0 }, ctx);
    tel.onLatency({ totalMs: 120, firstTokenMs: 50 }, ctx);
    tel.onError({ type: "rate_limit" }, ctx);
    tel.onRetry(ctx);

    const snap = tel.snapshot();
    expect([...snap.counters.keys()].some((k) => k.startsWith("llm_queue_wait_seconds_bucket"))).toBe(true);
    expect([...snap.gauges.keys()].some((k) => k.startsWith("llm_cc_cwnd"))).toBe(true);
    expect([...snap.counters.keys()].some((k) => k.startsWith("llm_latency_total_seconds_bucket"))).toBe(true);
    expect([...snap.counters.keys()].some((k) => k.startsWith("llm_retries_total"))).toBe(true);
  });
});
