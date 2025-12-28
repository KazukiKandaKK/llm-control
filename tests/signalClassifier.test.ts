import { describe, expect, it } from "vitest";
import { BasicSignalClassifier } from "../src/signals/signalClassifier";
import { ResponseMeta } from "../src/types";

const classifier = new BasicSignalClassifier();

describe("BasicSignalClassifier", () => {
  it("parses numeric Retry-After for 429", () => {
    const meta: ResponseMeta = {
      status: 429,
      headers: { "Retry-After": "2" },
      startAt: Date.now(),
      endAt: Date.now()
    };
    const signal = classifier.classify(meta);
    expect(signal.type).toBe("rate_limit");
    if (signal.type === "rate_limit") {
      expect(signal.retryAfterMs).toBe(2000);
    }
  });

  it("parses date Retry-After for 429", () => {
    const future = new Date(Date.now() + 1500).toUTCString();
    const meta: ResponseMeta = {
      status: 429,
      headers: { "retry-after": future },
      startAt: Date.now(),
      endAt: Date.now()
    };
    const signal = classifier.classify(meta);
    expect(signal.type).toBe("rate_limit");
    if (signal.type === "rate_limit") {
      expect(signal.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("classifies 503 and timeout as soft_loss", () => {
    const meta: ResponseMeta = {
      status: 503,
      headers: {},
      errorType: "server_error",
      startAt: Date.now(),
      endAt: Date.now()
    };
    expect(classifier.classify(meta).type).toBe("soft_loss");

    const metaTimeout: ResponseMeta = {
      status: 504,
      headers: {},
      errorType: "timeout",
      startAt: Date.now(),
      endAt: Date.now()
    };
    expect(classifier.classify(metaTimeout).type).toBe("soft_loss");
  });
});
