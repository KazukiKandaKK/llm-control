import { ResponseMeta, Signal, SignalClassifier } from "../types";

export class BasicSignalClassifier implements SignalClassifier {
  classify(meta: ResponseMeta): Signal {
    if (meta.status === 429) {
      return { type: "rate_limit", retryAfterMs: this.parseRetryAfter(meta.headers) };
    }

    if (meta.errorType === "timeout") {
      return { type: "soft_loss", reason: "timeout" };
    }

    if (meta.status >= 500) {
      return { type: "soft_loss", reason: "server_error" };
    }

    if (meta.status >= 400) {
      return { type: "client_error" };
    }

    return { type: "success" };
  }

  private parseRetryAfter(headers: Record<string, string>): number | undefined {
    const header = headers["retry-after"] ?? headers["Retry-After"];
    if (!header) return undefined;

    const seconds = Number(header);
    if (!Number.isNaN(seconds)) {
      return seconds * 1000;
    }

    const date = Date.parse(header);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - Date.now());
    }

    return undefined;
  }
}
