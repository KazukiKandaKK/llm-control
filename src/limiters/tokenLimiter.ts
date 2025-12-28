import { TokenLimiterConfig } from "../types";

export class TokenLimiter {
  private bucket: number;
  private debt: number;
  private r: number;
  private lastRefillAt: number;
  private bucketCap: number;
  private rMax: number;

  constructor(private readonly config: TokenLimiterConfig, now = Date.now()) {
    this.bucket = config.bucketSize;
    this.r = config.rInit;
    this.debt = 0;
    this.lastRefillAt = now;
    this.bucketCap = config.bucketSize;
    this.rMax = config.rMax;
  }

  refill(now = Date.now()): void {
    const deltaSeconds = Math.max(0, (now - this.lastRefillAt) / 1000);
    const added = this.r * deltaSeconds;
    let tokens = this.bucket + added;

    if (this.config.settlementMode === "debt" && this.debt > 0) {
      const pay = Math.min(this.debt, tokens);
      this.debt -= pay;
      tokens -= pay;
    }

    this.bucket = Math.min(this.bucketCap, Math.max(0, tokens));
    this.lastRefillAt = now;
  }

  canAcquire(cost: number): boolean {
    return this.bucket >= cost;
  }

  acquire(cost: number): void {
    if (!this.canAcquire(cost)) {
      throw new Error("TokenLimiter acquire called without capacity");
    }
    this.bucket -= cost;
  }

  settle(costPred: number, costActual: number): void {
    const diff = costPred - costActual;
    if (diff > 0) {
      this.bucket = Math.min(this.bucketCap, this.bucket + diff);
      return;
    }

    const shortage = -diff;
    if (this.config.settlementMode === "debt") {
      this.debt += shortage;
    } else {
      this.bucket -= shortage;
    }
  }

  onSuccess(): void {
    this.r = Math.min(this.rMax, this.r + this.config.additiveStep);
  }

  onLoss(): void {
    this.r = Math.max(this.config.rMin, this.r * this.config.beta);
  }

  onSoftLoss(): void {
    this.r = Math.max(this.config.rMin, this.r * this.config.betaSoft);
  }

  applyRemoteLimit(params: { limitTokens?: number; remainingTokens?: number }): void {
    if (params.limitTokens !== undefined) {
      this.bucketCap = params.limitTokens;
      this.bucket = Math.min(this.bucket, this.bucketCap);
    }
    if (params.remainingTokens !== undefined) {
      this.bucket = Math.min(Math.max(0, params.remainingTokens), this.bucketCap);
    }
  }

  applyRemoteRate(params: { limitTokens?: number; windowSeconds?: number; resetMs?: number }): void {
    const windowSeconds =
      params.windowSeconds ??
      (params.resetMs !== undefined ? params.resetMs / 1000 : undefined);
    if (params.limitTokens !== undefined && windowSeconds && windowSeconds > 0) {
      const maxR = params.limitTokens / windowSeconds;
      this.rMax = Math.min(this.config.rMax, maxR);
      this.r = Math.min(this.r, this.rMax);
    }
  }

  getState(): { r: number; bucket: number; debt: number; bucketCap: number } {
    return {
      r: this.r,
      bucket: this.bucket,
      debt: this.debt,
      bucketCap: this.bucketCap
    };
  }
}
