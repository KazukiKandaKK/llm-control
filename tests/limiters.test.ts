import { describe, expect, it } from "vitest";
import { TokenLimiter } from "../src/limiters/tokenLimiter";
import { ConcurrencyLimiter } from "../src/limiters/concurrencyLimiter";

describe("TokenLimiter", () => {
  const cfg = {
    rInit: 100,
    rMin: 10,
    rMax: 1000,
    bucketSize: 200,
    additiveStep: 20,
    beta: 0.5,
    betaSoft: 0.8,
    settlementMode: "debt" as const
  };

  it("refills up to bucket cap and pays down debt", () => {
    const limiter = new TokenLimiter(cfg, 0);
    limiter.acquire(150);
    limiter.settle(150, 200); // debt 50
    limiter.refill(1000); // 1 second later adds 100 tokens, pays debt first
    const state = limiter.getState();
    expect(state.debt).toBe(0);
    expect(state.bucket).toBe(100); // 100 refill - 50 debt, but bucket floor at 0 then capped to size
  });

  it("allows negative bucket when settlementMode=allow_negative", () => {
    const limiter = new TokenLimiter({ ...cfg, settlementMode: "allow_negative" }, 0);
    limiter.acquire(200);
    limiter.settle(200, 400); // shortage 200
    const state = limiter.getState();
    expect(state.bucket).toBeLessThan(0);
  });

  it("clamps additive increase at rMax", () => {
    const limiter = new TokenLimiter({ ...cfg, rInit: 950, additiveStep: 200 }, Date.now());
    limiter.onSuccess();
    expect(limiter.getState().r).toBeLessThanOrEqual(cfg.rMax);
  });

  it("applies remote rate limit window to clamp r", () => {
    const limiter = new TokenLimiter(cfg, Date.now());
    limiter.applyRemoteRate({ limitTokens: 100, windowSeconds: 20 });
    const state = limiter.getState();
    expect(state.r).toBeLessThanOrEqual(5); // 100/20
  });

  it("additive increase and multiplicative decrease respect bounds", () => {
    const limiter = new TokenLimiter(cfg, Date.now());
    limiter.onSuccess();
    expect(limiter.getState().r).toBe(120);
    limiter.onLoss();
    expect(limiter.getState().r).toBeGreaterThanOrEqual(cfg.rMin);
  });
});

describe("ConcurrencyLimiter", () => {
  const cfg = {
    cwndInit: 2,
    cwndMin: 1,
    cwndMax: 4,
    betaC: 0.5,
    delayDecrease: 0.5
  };

  it("enforces floor(cwnd) on acquisition and AIMD updates", () => {
    const limiter = new ConcurrencyLimiter(cfg);
    expect(limiter.canAcquire()).toBe(true);
    limiter.acquire();
    limiter.acquire();
    expect(limiter.canAcquire()).toBe(false);
    limiter.onSuccess();
    expect(limiter.getState().cwnd).toBeGreaterThanOrEqual(3);
    limiter.onLoss();
    expect(limiter.getState().cwnd).toBeGreaterThanOrEqual(cfg.cwndMin);
    limiter.release();
    limiter.release();
  });

  it("applies delay-based micro decrease", () => {
    const limiter = new ConcurrencyLimiter(cfg);
    const before = limiter.getState().cwnd;
    limiter.onDelaySignal();
    expect(limiter.getState().cwnd).toBeLessThanOrEqual(before);
  });
});
