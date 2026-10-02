import { describe, expect, it, vi } from "vitest";
import { requestJson } from "../verify-reading-stability.js";

describe("reading stability JSON requests", () => {
  it("aborts the fetch when a total timeout expires while reading the body", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestSignal = init?.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          requestSignal!.addEventListener("abort", () => controller.error(requestSignal!.reason), { once: true });
        }
      }), { headers: { "content-type": "application/json" } });
    };

    await expect(requestJson("http://127.0.0.1", "/hanging-body", {}, { timeoutMs: 15, fetchImpl }))
      .rejects.toThrow("HTTP request timed out");
    expect(requestSignal?.aborted).toBe(true);
  });

  it("removes the caller abort listener after a completed response", async () => {
    const caller = new AbortController();
    const addListener = vi.spyOn(caller.signal, "addEventListener");
    const removeListener = vi.spyOn(caller.signal, "removeEventListener");
    const result = await requestJson("http://127.0.0.1", "/ok", { signal: caller.signal }, {
      timeoutMs: 1_000,
      fetchImpl: async () => Response.json({ ok: true })
    });
    const registered = addListener.mock.calls.find(([type]) => type === "abort")?.[1];

    expect(result.body).toEqual({ ok: true });
    expect(registered).toBeTypeOf("function");
    expect(removeListener).toHaveBeenCalledWith("abort", registered);
  });

  it("rejects and cancels an SSE response before trying to read its open body", async () => {
    let requestSignal: AbortSignal | undefined;
    let resolveCanceled!: () => void;
    const canceled = new Promise<void>((resolvePromise) => { resolveCanceled = resolvePromise; });
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestSignal = init?.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({ cancel: () => resolveCanceled() }), {
        headers: { "content-type": "text/event-stream" }
      });
    };

    await expect(requestJson("http://127.0.0.1", "/events", {}, { timeoutMs: 1_000, fetchImpl }))
      .rejects.toThrow("received text/event-stream");
    await canceled;
    expect(requestSignal?.aborted).toBe(true);
  });
});
