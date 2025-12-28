import { CostEstimate, CostEstimator, RequestMeta, ResponseMeta } from "../types";

const DEFAULT_OUTPUT_TOKENS = 128;
const EWMA_LAMBDA = 0.2;

export class EWMAEstimator implements CostEstimator {
  private outputByModel = new Map<string, number>();

  estimate(req: RequestMeta): CostEstimate {
    const key = this.makeKey(req);
    const ewma = this.outputByModel.get(key) ?? DEFAULT_OUTPUT_TOKENS;
    const predictedOutput = req.maxOutputTokens
      ? Math.min(req.maxOutputTokens, ewma)
      : ewma;

    return {
      inputTokens: this.estimateInput(req.inputText),
      outputTokens: predictedOutput
    };
  }

  settle(req: RequestMeta, meta: ResponseMeta): void {
    if (meta.outputTokens === undefined) return;
    const key = this.makeKey(req);
    const prev = this.outputByModel.get(key) ?? DEFAULT_OUTPUT_TOKENS;
    const updated = EWMA_LAMBDA * meta.outputTokens + (1 - EWMA_LAMBDA) * prev;
    this.outputByModel.set(key, updated);
  }

  protected estimateInput(text?: string): number {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
  }

  private makeKey(req: RequestMeta): string {
    return `${req.provider}:${req.model}:${req.tenant ?? "default"}`;
  }
}

type TokenizerFn = (text: string) => number;

export class TokenizerEstimator extends EWMAEstimator {
  constructor(private readonly tokenizer: TokenizerFn) {
    super();
  }

  protected override estimateInput(text?: string): number {
    if (!text) return 0;
    return this.tokenizer(text);
  }
}
