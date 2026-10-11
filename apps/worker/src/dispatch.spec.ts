import { describe, expect, it } from "vitest";
import { dispatchGenerationJob, workerDispatchHeaders } from "./dispatch.js";

describe("worker dispatch", () => {
  it("preserves the job workspace when dispatching a queued task", () => {
    expect(workerDispatchHeaders("worker-token", "regression-workspace")).toEqual({
      "X-Course-Worker-Token": "worker-token",
      "X-Workspace-Id": "regression-workspace"
    });
  });

  it("keeps compatibility with older jobs without a workspace id", () => {
    expect(workerDispatchHeaders("worker-token", "")["X-Workspace-Id"]).toBe("personal");
  });
});


describe("bounded worker acknowledgement", () => {
  it("releases an unfinished body without awaiting job execution", async () => {
    let released = false;
    const result = await dispatchGenerationJob("http://api:4100", "token", "job/1", "workspace", {
      fetchImpl: async (input, init) => {
        expect(String(input).endsWith("job%2F1/run")).toBe(true);
        expect(init?.headers).toEqual(workerDispatchHeaders("token", "workspace"));
        expect(init?.signal).toBeDefined();
        return new Response(new ReadableStream({ cancel() { released = true; } }), { status: 202 });
      }
    });
    expect(result).toEqual({ ok: true, status: 202 });
    expect(released).toBe(true);
  });

  it("bounds stalled headers and allows the next acknowledgement", async () => {
    const timer = setTimeout(() => {}, 1000);
    try {
      const stalled = await dispatchGenerationJob("http://api", "token", "job", "workspace", {
        timeoutMs: 30,
        fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        })
      });
      expect(stalled).toMatchObject({ ok: false, error: "TimeoutError" });
      await expect(dispatchGenerationJob("http://api", "token", "job", "workspace", {
        fetchImpl: async () => new Response("ack", { status: 202 })
      })).resolves.toEqual({ ok: true, status: 202 });
    } finally { clearTimeout(timer); }
  });

  it("retains HTTP rejection and useful transport codes without logging secrets", async () => {
    await expect(dispatchGenerationJob("http://api", "token", "job", "workspace", {
      fetchImpl: async () => new Response("private upstream detail", { status: 503 })
    })).resolves.toEqual({ ok: false, status: 503 });
    await expect(dispatchGenerationJob("http://api", "secret", "job", "workspace", {
      fetchImpl: async () => { throw new TypeError("private secret detail", { cause: { code: "ECONNRESET" } }); }
    })).resolves.toEqual({ ok: false, error: "TypeError", causeCode: "ECONNRESET" });
  });
});
