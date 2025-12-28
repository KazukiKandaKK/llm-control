import { describe, expect, it } from "vitest";
import { AdmissionController } from "../src/admission/admissionController";
import { TokenLimiter } from "../src/limiters/tokenLimiter";
import { ConcurrencyLimiter } from "../src/limiters/concurrencyLimiter";
import { EWMAEstimator } from "../src/estimator/costEstimator";
import { BasicSignalClassifier } from "../src/signals/signalClassifier";
import { PseudoLLMServer } from "../sim/pseudoLLM";
import { ControlConfig, RequestMeta, ResponseMeta } from "../src/types";
import { QueueOverflowError, QueueTimeoutError } from "../src/errors";
import { InMemoryTelemetry } from "../src/telemetry/inMemoryTelemetry";
import { MetricsTelemetry } from "../src/telemetry/metricsTelemetry";

const BASE_CONFIG: ControlConfig = {
  queue: { enabled: true, maxSize: 100, timeoutMs: 500 },
  tokenLimiter: {
    rInit: 500,
    rMin: 50,
    rMax: 5000,
    bucketSize: 2000,
    additiveStep: 50,
    beta: 0.7,
    betaSoft: 0.85,
    settlementMode: "debt"
  },
  concurrencyLimiter: {
    cwndInit: 4,
    cwndMin: 1,
    cwndMax: 64,
    betaC: 0.7,
    delayDecrease: 0.9,
    delayThresholdMs: 50
  }
};

function buildController(config: ControlConfig = BASE_CONFIG, telemetry?: InMemoryTelemetry) {
  const estimator = new EWMAEstimator();
  const tokenLimiter = new TokenLimiter(config.tokenLimiter);
  const concLimiter = new ConcurrencyLimiter(config.concurrencyLimiter);
  const classifier = new BasicSignalClassifier();

  return new AdmissionController(
    config,
    {
      costEstimator: estimator,
      tokenLimiter,
      concurrencyLimiter: concLimiter,
      signalClassifier: classifier,
      telemetry
    }
  );
}

describe("AdmissionController", () => {
  it("admits and updates state on a successful call", async () => {
    const controller = buildController();
    const server = new PseudoLLMServer();

    const { meta } = await controller.run(
      { provider: "sim", model: "demo" },
      () => server.call("hello world")
    );

    expect(meta.status).toBe(200);
  });

  it("respects rate limit errors as congestion signals", async () => {
    const controller = buildController();
    const server = new PseudoLLMServer({ rateLimitChance: 1 });

    await expect(
      controller.run({ provider: "sim", model: "demo" }, () => server.call("burst"))
    ).rejects.toThrow();
  });

  it("enforces queue overflow guardrails", async () => {
    const config: ControlConfig = {
      queue: { enabled: true, maxSize: 1, timeoutMs: 80 },
      tokenLimiter: {
        rInit: 0,
        rMin: 0,
        rMax: 0,
        bucketSize: 0,
        additiveStep: 0,
        beta: 0.7,
        betaSoft: 0.85,
        settlementMode: "debt"
      },
      concurrencyLimiter: {
        cwndInit: 1,
        cwndMin: 1,
        cwndMax: 1,
        betaC: 0.7,
        delayDecrease: 0.9
      }
    };
    const controller = buildController(config);

    const first = controller.run({ provider: "sim", model: "demo" }, makeSuccessCall());

    await expect(
      controller.run({ provider: "sim", model: "demo" }, makeSuccessCall())
    ).rejects.toBeInstanceOf(QueueOverflowError);

    await expect(first).rejects.toBeInstanceOf(QueueTimeoutError);
  });

  it("times out when no token/concurrency capacity arrives", async () => {
    const config: ControlConfig = {
      queue: { enabled: true, maxSize: 10, timeoutMs: 50 },
      tokenLimiter: {
        rInit: 0,
        rMin: 0,
        rMax: 0,
        bucketSize: 0,
        additiveStep: 0,
        beta: 0.7,
        betaSoft: 0.85,
        settlementMode: "debt"
      },
      concurrencyLimiter: {
        cwndInit: 0,
        cwndMin: 0,
        cwndMax: 0,
        betaC: 0.7,
        delayDecrease: 0.9
      }
    };
    const controller = buildController(config);

    await expect(
      controller.run({ provider: "sim", model: "demo" }, makeSuccessCall())
    ).rejects.toBeInstanceOf(QueueTimeoutError);
  });

  it("honors Retry-After before admitting the next request", async () => {
    const controller = buildController({
      ...BASE_CONFIG,
      queue: { enabled: true, maxSize: 10, timeoutMs: 1000 }
    });

    const retryAfterMs = 60;
    await expect(
      controller.run({ provider: "sim", model: "demo" }, () =>
        Promise.reject(withMeta("rate", retryAfterMeta(retryAfterMs)))
      )
    ).rejects.toThrow();

    const start = Date.now();
    const { meta } = await controller.run(
      { provider: "sim", model: "demo" },
      makeSuccessCall()
    );
    const waited = Date.now() - start;

    expect(meta.status).toBe(200);
    expect(waited).toBeGreaterThanOrEqual(retryAfterMs - 5); // jitter allowance
  });

  it("settles streaming output tokens when meta.outputTokens is absent", async () => {
    const config: ControlConfig = {
      queue: { enabled: true, maxSize: 5, timeoutMs: 200 },
      tokenLimiter: {
        rInit: 0,
        rMin: 0,
        rMax: 0,
        bucketSize: 1000,
        additiveStep: 0,
        beta: 0.7,
        betaSoft: 0.85,
        settlementMode: "debt"
      },
      concurrencyLimiter: {
        cwndInit: 1,
        cwndMin: 1,
        cwndMax: 1,
        betaC: 0.7,
        delayDecrease: 0.9,
        delayThresholdMs: 50
      }
    };
    const estimator = new FixedEstimator(0, 1000);
    const controller = buildControllerWithEstimator(config, estimator);
    const req: RequestMeta = { provider: "sim", model: "demo", id: "stream-1" };

    const result = controller.run(req, async () => {
      controller.onStreamToken?.("stream-1", 10);
      const meta = successMeta();
      delete meta.outputTokens;
      return { result: "ok", meta };
    });

    await expect(result).resolves.toBeDefined();

    const state = controller.getBundleForTest(req).tokenLimiter.getState();
    expect(state.bucket).toBeGreaterThanOrEqual(980);
  });

  it("triggers delay-based micro decrease on first-token latency inflation", async () => {
    const controller = buildController({
      ...BASE_CONFIG,
      concurrencyLimiter: {
        ...BASE_CONFIG.concurrencyLimiter,
        cwndInit: 2,
        cwndMin: 1,
        cwndMax: 10,
        delayDecrease: 0.5,
        delayThresholdMs: 10
      }
    });

    await controller.run({ provider: "sim", model: "demo" }, () =>
      Promise.resolve({
        result: "ok",
        meta: { ...successMeta(), firstTokenAt: Date.now() + 2 }
      })
    );

    const before = controller.getBundleForTest({ provider: "sim", model: "demo" }).concurrencyLimiter.getState().cwnd;

    await controller.run({ provider: "sim", model: "demo" }, () =>
      Promise.resolve({
        result: "ok",
        meta: { ...successMeta(), firstTokenAt: Date.now() + 100 }
      })
    );

    const after = controller.getBundleForTest({ provider: "sim", model: "demo" }).concurrencyLimiter.getState().cwnd;

    expect(after).toBeLessThan(before);
  });

  it("syncs token bucket with provider-specific rate limit headers", async () => {
    const config: ControlConfig = {
      queue: { enabled: true, maxSize: 5, timeoutMs: 200 },
      tokenLimiter: {
        rInit: 0,
        rMin: 0,
        rMax: 1000,
        bucketSize: 5000,
        additiveStep: 0,
        beta: 0.7,
        betaSoft: 0.85,
        settlementMode: "debt"
      },
      concurrencyLimiter: {
        cwndInit: 1,
        cwndMin: 1,
        cwndMax: 1,
        betaC: 0.7,
        delayDecrease: 0.9,
        delayThresholdMs: 50
      },
      rateLimitHeaders: {
        sim: {
          limitTokensHeader: "ratelimit-limit-token",
          remainingTokensHeader: "ratelimit-remaining-token"
        }
      }
    };
    const estimator = new FixedEstimator(0, 100);
    const controller = buildControllerWithEstimator(config, estimator);
    const req: RequestMeta = { provider: "sim", model: "demo" };

    await controller.run(req, async () => {
      const meta = successMeta();
      meta.headers = {
        "ratelimit-limit-token": "100",
        "ratelimit-remaining-token": "20",
        "ratelimit-window-seconds": "10",
        "x-ratelimit-reset-ms": "10000"
      };
      delete meta.outputTokens;
      return { result: "ok", meta };
    });

    const state = controller.getBundleForTest(req).tokenLimiter.getState();
    expect(state.bucketCap).toBe(100);
    expect(state.bucket).toBe(20);
    expect(state.r).toBeLessThanOrEqual(10);
  });

  it("accumulates streaming tokens across multiple callbacks", async () => {
    const config: ControlConfig = {
      queue: { enabled: true, maxSize: 5, timeoutMs: 200 },
      tokenLimiter: {
        rInit: 0,
        rMin: 0,
        rMax: 0,
        bucketSize: 1000,
        additiveStep: 0,
        beta: 0.7,
        betaSoft: 0.85,
        settlementMode: "debt"
      },
      concurrencyLimiter: {
        cwndInit: 1,
        cwndMin: 1,
        cwndMax: 1,
        betaC: 0.7,
        delayDecrease: 0.9,
        delayThresholdMs: 50
      }
    };
    const estimator = new FixedEstimator(0, 100);
    const controller = buildControllerWithEstimator(config, estimator);
    const req: RequestMeta = { provider: "sim", model: "demo", id: "stream-2" };

    await controller.run(req, async () => {
      controller.onStreamToken?.("stream-2", 10);
      controller.onStreamToken?.("stream-2", 15);
      const meta = successMeta();
      delete meta.outputTokens;
      return { result: "ok", meta };
    });

    const state = controller.getBundleForTest(req).tokenLimiter.getState();
    // bucket should refund predicted-output diff using accumulated 25 tokens (1 input + 25 output = 26 actual)
    expect(state.bucket).toBeGreaterThanOrEqual(974);
  });

  it("isolates limiter bundles per dimension key", async () => {
    const controller = buildController({
      ...BASE_CONFIG,
      dimensions: ["provider"]
    });

    const reqA: RequestMeta = { provider: "a", model: "demo" };
    const reqB: RequestMeta = { provider: "b", model: "demo" };

    await controller.run(reqA, makeSuccessCall());
    await controller.run(reqB, makeSuccessCall());

    const bundleA = controller.getBundleForTest(reqA);
    const bundleB = controller.getBundleForTest(reqB);

    expect(bundleA).not.toBe(bundleB);
    expect(bundleA.tokenLimiter.getState().bucket).toBeGreaterThan(0);
    expect(bundleB.tokenLimiter.getState().bucket).toBeGreaterThan(0);
  });

  it("emits telemetry events on queue wait, state update, and errors", async () => {
    const telemetry = new InMemoryTelemetry();
    const controller = buildController({
      ...BASE_CONFIG,
      queue: { enabled: true, maxSize: 10, timeoutMs: 1500 }
    }, telemetry);
    const server = new PseudoLLMServer({ rateLimitChance: 1 });

    await expect(
      controller.run({ provider: "sim", model: "demo" }, () => server.call("burst"))
    ).rejects.toThrow();

    await controller.run({ provider: "sim", model: "demo" }, makeSuccessCall());

    expect(telemetry.queueWaits.length).toBeGreaterThan(0);
    expect(telemetry.limiterStates.length).toBeGreaterThan(0);
    expect(telemetry.errors.length).toBeGreaterThan(0);
  });

  it("records metrics telemetry counters and gauges", async () => {
    const telemetry = new MetricsTelemetry();
    const controller = buildController({
      ...BASE_CONFIG,
      queue: { enabled: true, maxSize: 10, timeoutMs: 1500 }
    }, telemetry as any);

    await controller.run({ provider: "sim", model: "demo" }, makeSuccessCall());
    await controller.run({ provider: "sim", model: "demo" }, makeSuccessCall());

    telemetry.onError({ type: "rate_limit" }, { provider: "sim", model: "demo" });

    const snap = telemetry.snapshot();
    expect(snap.queueWaitMs.size).toBeGreaterThan(0);
    expect(snap.errors.size).toBeGreaterThan(0);
    expect(snap.limiterGauge.size).toBeGreaterThan(0);
  });
});

function makeSuccessCall() {
  return async () => ({ result: "ok", meta: successMeta() });
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

function withMeta(message: string, meta: ResponseMeta): Error {
  const err = new Error(message);
  (err as any).meta = meta;
  return err;
}

function retryAfterMeta(ms: number): ResponseMeta {
  const now = Date.now();
  return {
    status: 429,
    headers: { "retry-after": `${ms / 1000}` },
    errorType: "rate_limit",
    startAt: now,
    endAt: now
  };
}

class FixedEstimator extends EWMAEstimator {
  constructor(private readonly input: number, private readonly output: number) {
    super();
  }
  override estimate(): { inputTokens: number; outputTokens: number } {
    return { inputTokens: this.input, outputTokens: this.output };
  }
}

function buildControllerWithEstimator(config: ControlConfig, estimator: EWMAEstimator) {
  const tokenLimiter = new TokenLimiter(config.tokenLimiter);
  const concLimiter = new ConcurrencyLimiter(config.concurrencyLimiter);
  const classifier = new BasicSignalClassifier();

  return new (AdmissionController as any)(
    config,
    {
      costEstimator: estimator,
      tokenLimiter,
      concurrencyLimiter: concLimiter,
      signalClassifier: classifier
    }
  ) as AdmissionController;
}
