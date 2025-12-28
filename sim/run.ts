import {
  AdmissionController,
  TokenLimiter,
  ConcurrencyLimiter,
  EWMAEstimator,
  BasicSignalClassifier
} from "../src";
import { PseudoLLMServer } from "./pseudoLLM";
import { InMemoryTelemetry } from "../src/telemetry/inMemoryTelemetry";

async function main() {
  const config = {
    queue: { enabled: true, maxSize: 100, timeoutMs: 1000 },
    tokenLimiter: {
      rInit: 500,
      rMin: 50,
      rMax: 5000,
      bucketSize: 2000,
      additiveStep: 50,
      beta: 0.7,
      betaSoft: 0.85,
      settlementMode: "debt" as const
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

  const controller = new AdmissionController(config, {
    costEstimator: new EWMAEstimator(),
    tokenLimiter: new TokenLimiter(config.tokenLimiter),
    concurrencyLimiter: new ConcurrencyLimiter(config.concurrencyLimiter),
    signalClassifier: new BasicSignalClassifier(),
    telemetry: new InMemoryTelemetry()
  });

  const server = new PseudoLLMServer({
    rateLimitChance: 0.1,
    serverErrorChance: 0.0,
    timeoutChance: 0.0,
    outputTokens: 64
  });

  const req = { provider: "sim", model: "demo", inputText: "hello streaming world" };
  const { result, meta } = await controller.run(req, () => server.call(req.inputText ?? ""));

  console.log("result:", result);
  console.log("meta:", {
    status: meta.status,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
    startAt: meta.startAt,
    firstTokenAt: meta.firstTokenAt,
    endAt: meta.endAt
  });
  console.log("limiter state:", controller.getBundleForTest(req).tokenLimiter.getState());
}

main().catch((err) => {
  console.error("run error", err);
  process.exit(1);
});
