import { RequestMeta, Signal, TelemetrySink } from "../types";

type LimiterState = {
  cwnd: number;
  inflight: number;
  r: number;
  bucket: number;
  debt: number;
};

export class InMemoryTelemetry implements TelemetrySink {
  queueWaits: Array<{ ms: number; ctx: RequestMeta }> = [];
  limiterStates: Array<{ state: LimiterState; ctx: RequestMeta }> = [];
  errors: Array<{ signal: Signal; ctx: RequestMeta }> = [];

  onQueueWait(ms: number, ctx: RequestMeta): void {
    this.queueWaits.push({ ms, ctx });
  }

  onLimiterState(state: LimiterState, ctx: RequestMeta): void {
    this.limiterStates.push({ state, ctx });
  }

  onError(signal: Signal, ctx: RequestMeta): void {
    this.errors.push({ signal, ctx });
  }
}
