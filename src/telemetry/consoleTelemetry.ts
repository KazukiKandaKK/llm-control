import { RequestMeta, Signal, TelemetrySink } from "../types";

export class ConsoleTelemetry implements TelemetrySink {
  onQueueWait(ms: number, ctx: RequestMeta): void {
    console.info("[llm-cc] queue_wait_ms=%d provider=%s model=%s", ms, ctx.provider, ctx.model);
  }

  onLimiterState(
    state: { cwnd: number; inflight: number; r: number; bucket: number; debt: number },
    ctx: RequestMeta
  ): void {
    console.info(
      "[llm-cc] state cwnd=%d inflight=%d r=%.2f bucket=%.1f debt=%.1f provider=%s model=%s",
      state.cwnd,
      state.inflight,
      state.r,
      state.bucket,
      state.debt,
      ctx.provider,
      ctx.model
    );
  }

  onError(signal: Signal, ctx: RequestMeta): void {
    console.warn("[llm-cc] error signal=%s provider=%s model=%s", signal.type, ctx.provider, ctx.model);
  }
}
