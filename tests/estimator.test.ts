import { describe, expect, it } from "vitest";
import { TokenizerEstimator } from "../src/estimator/costEstimator";
import { RequestMeta } from "../src/types";

describe("TokenizerEstimator", () => {
  it("uses provided tokenizer for input estimation", () => {
    const tokenizer = (text: string) => text.length; // simple tokenizer
    const est = new TokenizerEstimator(tokenizer);
    const req: RequestMeta = { provider: "sim", model: "demo", inputText: "abcd" };
    const cost = est.estimate(req);
    expect(cost.inputTokens).toBe(4);
  });
});
