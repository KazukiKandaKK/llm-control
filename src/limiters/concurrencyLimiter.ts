import { ConcurrencyLimiterConfig } from "../types";

export class ConcurrencyLimiter {
  private cwnd: number;
  private inflight: number;
  private readonly betaC: number;
  private readonly cwndMin: number;
  private readonly cwndMax: number;
  private readonly delayDecrease?: number;

  constructor(private readonly config: ConcurrencyLimiterConfig) {
    this.cwnd = config.cwndInit;
    this.inflight = 0;
    this.betaC = config.betaC;
    this.cwndMin = config.cwndMin;
    this.cwndMax = config.cwndMax;
    this.delayDecrease = config.delayDecrease;
  }

  canAcquire(): boolean {
    return this.inflight < Math.floor(this.cwnd);
  }

  acquire(): void {
    if (!this.canAcquire()) {
      throw new Error("ConcurrencyLimiter acquire called without capacity");
    }
    this.inflight += 1;
  }

  release(): void {
    this.inflight = Math.max(0, this.inflight - 1);
  }

  onSuccess(): void {
    this.cwnd = Math.min(this.cwndMax, this.cwnd + 1);
  }

  onLoss(): void {
    this.cwnd = Math.max(this.cwndMin, this.cwnd * this.betaC);
  }

  onDelaySignal(): void {
    if (this.delayDecrease === undefined) return;
    this.cwnd = Math.max(this.cwndMin, this.cwnd * this.delayDecrease);
  }

  getState(): { cwnd: number; inflight: number } {
    return { cwnd: this.cwnd, inflight: this.inflight };
  }
}
