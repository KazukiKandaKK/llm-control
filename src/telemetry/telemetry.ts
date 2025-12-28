import { TelemetrySink } from "../types";

export class NullTelemetry implements TelemetrySink {
  onQueueWait(): void {
    // noop
  }
  onLimiterState(): void {
    // noop
  }
  onError(): void {
    // noop
  }
}
