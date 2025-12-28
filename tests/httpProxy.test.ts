import { describe, expect, it } from "vitest";
import { HttpProxy } from "../src/gateway/httpProxy";
import { LLMControl, RequestMeta, RunResult } from "../src/types";

class StubController implements LLMControl {
  called = false;
  async run<T>(req: RequestMeta, fn: () => Promise<RunResult<T>>): Promise<RunResult<T>> {
    this.called = true;
    return fn();
  }
}

function makeRes() {
  return {
    statusCode: 0,
    body: Buffer.alloc(0),
    end(chunk?: any) {
      if (chunk) this.body = Buffer.from(chunk);
    }
  };
}

describe("HttpProxy", () => {
  it("invokes controller before upstream and writes response", async () => {
    const controller = new StubController();
    const proxy = new HttpProxy(controller, {
      toRequestMeta: () => ({ provider: "sim", model: "demo" }),
      toUpstream: async () => ({
        result: Buffer.from("ok"),
        meta: { status: 200, headers: {}, startAt: Date.now(), endAt: Date.now() }
      }),
      onResponse: (meta, res: any) => {
        res.setHeader?.("x-test-status", meta?.status ?? 0);
      }
    });

    const res = makeRes();
    await proxy.handle({} as any, res as any);

    expect(controller.called).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toBe("ok");
  });
});
  it("propagates upstream error status", async () => {
    const controller = new StubController();
    const proxy = new HttpProxy(controller, {
      toRequestMeta: () => ({ provider: "sim", model: "demo" }),
      toUpstream: async () => {
        const err = new Error("upstream");
        (err as any).meta = { status: 503, headers: {}, startAt: Date.now(), endAt: Date.now() };
        throw err;
      }
    });

    const res: any = {
      statusCode: 0,
      setHeader() {},
      endCalled: false,
      end() {
        this.endCalled = true;
      }
    };

    await proxy.handle({} as any, res as any);

    expect(res.statusCode).toBe(503);
    expect(res.endCalled).toBe(true);
  });
