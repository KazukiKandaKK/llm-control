import { describe, expect, it } from "vitest";
import { withRetries } from "../src/retry";
import { RequestMeta } from "../src/types";

const meta: RequestMeta = { provider: "sim", model: "demo" };

describe("withRetries", () => {
  it("retries on 429 and respects Retry-After", async () => {
    let attempts = 0;
    const start = Date.now();
    await withRetries(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error("rate");
          (err as any).meta = { status: 429, headers: { "retry-after": "0.1" } };
          throw err;
        }
        return { result: "ok", meta: { status: 200, headers: {}, startAt: Date.now(), endAt: Date.now() } };
      },
      meta,
      { maxRetries: 2, baseDelayMs: 50 }
    );
    const elapsed = Date.now() - start;
    expect(attempts).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });

  it("fails after exceeding max retries", async () => {
    await expect(
      withRetries(
        async () => {
          const err = new Error("timeout");
          (err as any).meta = { status: 504, errorType: "timeout", headers: {} };
          throw err;
        },
        meta,
        { maxRetries: 1, baseDelayMs: 10 }
      )
    ).rejects.toThrow();
  });

  it("does not retry on non-target errors", async () => {
    let attempts = 0;
    await expect(
      withRetries(
        async () => {
          attempts += 1;
          const err = new Error("bad");
          (err as any).meta = { status: 400, headers: {} };
          throw err;
        },
        meta,
        { maxRetries: 3, baseDelayMs: 10, jitterRatio: 0 }
      )
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});
