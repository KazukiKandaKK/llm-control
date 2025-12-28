import { IncomingMessage, ServerResponse } from "http";
import { LLMControl, RequestMeta, RunResult } from "../types";

type ProxyOptions = {
  toRequestMeta: (req: IncomingMessage) => RequestMeta;
  toUpstream: (req: IncomingMessage) => Promise<RunResult<Buffer>>;
  onResponse?: (resMeta: RunResult<Buffer>["meta"], res: ServerResponse) => void;
};

/**
 * Minimal HTTP proxy skeleton that performs Admission.acquire() before
 * dispatching to the upstream. Real-world usage should be paired with
 * framework adapters (Express, Fastify) and stream-aware piping.
 */
export class HttpProxy {
  constructor(private readonly controller: LLMControl, private readonly opts: ProxyOptions) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const meta = this.opts.toRequestMeta(req);
    try {
      const result = await this.controller.run(meta, () => this.opts.toUpstream(req));
      res.statusCode = 200;
      this.opts.onResponse?.(result.meta, res);
      res.end(result.result);
    } catch (err: any) {
      const status = err?.meta?.status ?? 503;
      res.statusCode = status;
      this.opts.onResponse?.(err?.meta, res);
      res.end();
    }
  }
}
