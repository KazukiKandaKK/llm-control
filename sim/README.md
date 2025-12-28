# Simulator quickstart

擬似LLMサーバーを使用して、実際のAPI呼び出しなしでアドミッションコントローラーを実行します。

```bash
npm install
npm test -- --run   # optional: verify tests
```

```ts
import { PseudoLLMServer } from "./pseudoLLM";
import {
  AdmissionController,
  TokenLimiter,
  ConcurrencyLimiter,
  EWMAEstimator,
  BasicSignalClassifier
} from "../src";
import { InMemoryTelemetry } from "../src/telemetry/inMemoryTelemetry";

const server = new PseudoLLMServer({
  rateLimitChance: 0.2,
  serverErrorChance: 0.1,
  timeoutChance: 0.05
});

const config = {
  queue: { enabled: true, maxSize: 100, timeoutMs: 500 },
  tokenLimiter: {
    rInit: 500, rMin: 50, rMax: 5000,
    bucketSize: 2000, additiveStep: 50,
    beta: 0.7, betaSoft: 0.85, settlementMode: "debt"
  },
  concurrencyLimiter: {
    cwndInit: 4, cwndMin: 1, cwndMax: 64,
    betaC: 0.7, delayDecrease: 0.9, delayThresholdMs: 50
  }
};

const controller = new AdmissionController(config, {
  costEstimator: new EWMAEstimator(),
  tokenLimiter: new TokenLimiter(config.tokenLimiter),
  concurrencyLimiter: new ConcurrencyLimiter(config.concurrencyLimiter),
  signalClassifier: new BasicSignalClassifier(),
  telemetry: new InMemoryTelemetry()
});

const res = await controller.run(
  { provider: "sim", model: "demo", inputText: "hello world" },
  () => server.call("hello world")
);

console.log(res.meta.status, res.meta.inputTokens, res.meta.outputTokens);
```
