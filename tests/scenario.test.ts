import { describe, expect, it } from "vitest";
import { AdmissionController } from "../src/admission/admissionController";
import { TokenLimiter } from "../src/limiters/tokenLimiter";
import { ConcurrencyLimiter } from "../src/limiters/concurrencyLimiter";
import { EWMAEstimator } from "../src/estimator/costEstimator";
import { BasicSignalClassifier } from "../src/signals/signalClassifier";
import { ControlConfig, RequestMeta, ResponseMeta } from "../src/types";

const CONFIG: ControlConfig = {
  queue: { enabled: true, maxSize: 10, timeoutMs: 500 },
  tokenLimiter: {
    rInit: 100,
    rMin: 10,
    rMax: 1000,
    bucketSize: 500,
    additiveStep: 20,
    beta: 0.5,
    betaSoft: 0.8,
    settlementMode: "debt"
  },
  concurrencyLimiter: {
    cwndInit: 2,
    cwndMin: 1,
    cwndMax: 10,
    betaC: 0.5,
    delayDecrease: 0.8,
    delayThresholdMs: 10
  }
};

function buildScenarioController(config: ControlConfig = CONFIG) {
  return new AdmissionController(config, {
    costEstimator: new EWMAEstimator(),
    tokenLimiter: new TokenLimiter(config.tokenLimiter),
    concurrencyLimiter: new ConcurrencyLimiter(config.concurrencyLimiter),
    signalClassifier: new BasicSignalClassifier()
  });
}

function successMeta(): ResponseMeta {
  const now = Date.now();
  return {
    status: 200,
    headers: {},
    inputTokens: 1,
    outputTokens: 1,
    startAt: now,
    firstTokenAt: now,
    endAt: now
  };
}

function rateLimitError(): Error {
  const err = new Error("429");
  (err as any).meta = {
    status: 429,
    headers: { "retry-after": "0.01" },
    startAt: Date.now(),
    endAt: Date.now()
  };
  return err;
}

function softLossError(): Error {
  const err = new Error("503");
  (err as any).meta = {
    status: 503,
    headers: {},
    errorType: "server_error",
    startAt: Date.now(),
    endAt: Date.now()
  };
  return err;
}

const req: RequestMeta = { provider: "sim", model: "demo" };

describe("Scenario: backoff and recovery", () => {
  it("additively increases then backs off on 429, reducing cwnd and r", async () => {
    const controller = buildScenarioController();

    await controller.run(req, async () => ({ result: "ok1", meta: successMeta() }));
    await controller.run(req, async () => ({ result: "ok2", meta: successMeta() }));

    const before = controller.getBundleForTest(req).tokenLimiter.getState().r;
    const cwndBefore = controller.getBundleForTest(req).concurrencyLimiter.getState().cwnd;

    await expect(
      controller.run(req, async () => {
        throw rateLimitError();
      })
    ).rejects.toThrow();

    const afterState = controller.getBundleForTest(req).tokenLimiter.getState();
    const cwndAfter = controller.getBundleForTest(req).concurrencyLimiter.getState().cwnd;

    expect(afterState.r).toBeLessThan(before);
    expect(cwndAfter).toBeLessThan(cwndBefore);
  });

  it("soft loss reduces cwnd but uses softer beta for r", async () => {
    const controller = buildScenarioController();

    await controller.run(req, async () => ({ result: "ok", meta: successMeta() }));
    const before = controller.getBundleForTest(req).tokenLimiter.getState().r;
    const cwndBefore = controller.getBundleForTest(req).concurrencyLimiter.getState().cwnd;

    await expect(
      controller.run(req, async () => {
        throw softLossError();
      })
    ).rejects.toThrow();

    const after = controller.getBundleForTest(req).tokenLimiter.getState().r;
    const cwndAfter = controller.getBundleForTest(req).concurrencyLimiter.getState().cwnd;

    expect(after).toBeLessThanOrEqual(before * CONFIG.tokenLimiter.betaSoft);
    expect(cwndAfter).toBeLessThan(cwndBefore);
  });
});
