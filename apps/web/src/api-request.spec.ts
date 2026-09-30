import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";

function pendingUntilAborted(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const rejectOnAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal.aborted) rejectOnAbort();
    else signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
}

describe("read request lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts a hung fetch at ten seconds and a manual retry starts a new request", async () => {
    vi.useFakeTimers();
    const calls: Array<{ signal?: AbortSignal; requestId: string | null }> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      calls.push({ signal: init?.signal ?? undefined, requestId: headers.get("X-Request-Id") });
      if (calls.length === 1) {
        if (!init?.signal) throw new Error("Expected the read request to pass an AbortSignal");
        return pendingUntilAborted(init.signal);
      }
      return Promise.resolve(Response.json({ releaseId: "release-1", page: { id: "page-1" }, qaRecords: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstRequest = api.lesson("page-1");
    const timedOut = expect(firstRequest).rejects.toMatchObject({
      name: "ApiRequestError",
      code: "REQUEST_TIMEOUT",
      status: 408,
      requestId: expect.any(String)
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await timedOut;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal?.aborted).toBe(true);

    await expect(api.lesson("page-1")).resolves.toMatchObject({ releaseId: "release-1" });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.requestId).toBeTruthy();
    expect(calls[1]?.requestId).not.toBe(calls[0]?.requestId);
  });

  it("keeps the same deadline active while consuming a hanging JSON body", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const bodyText = vi.fn(() => new Promise<string>((_resolve, reject) => {
      if (!requestSignal) throw new Error("Expected the read request to pass an AbortSignal");
      requestSignal.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
    }));
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      text: bodyText
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return Promise.resolve(response);
    }));

    const request = api.lesson("page-1");
    const timedOut = expect(request).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", status: 408 });
    await vi.advanceTimersByTimeAsync(10_000);

    await timedOut;
    expect(bodyText).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(true);
  });

  it("forwards external cancellation and removes its abort listener when settled", async () => {
    const external = new AbortController();
    const reason = new TypeError("caller cancellation sentinel");
    const removeListener = vi.spyOn(external.signal, "removeEventListener");
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      if (!fetchSignal) throw new Error("Expected the read request to pass an AbortSignal");
      return pendingUntilAborted(fetchSignal);
    }));

    const request = api.lesson("page-1", { signal: external.signal });
    external.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(fetchSignal?.aborted).toBe(true);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("maps network TypeErrors to a Chinese retryable error with a request ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));

    await expect(api.settings()).rejects.toMatchObject({
      name: "ApiRequestError",
      code: "NETWORK_ERROR",
      status: 0,
      retryable: true,
      requestId: expect.any(String),
      message: "网络连接失败，请检查网络后重试"
    });
  });

  it("turns an HTML login redirect into an actionable auth error with the response request ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "<!doctype html><html><title>Sign in</title><form><input type='password'></form></html>",
      { status: 200, headers: { "Content-Type": "text/html", "X-Request-Id": "login-request-7" } }
    )));

    await expect(api.settings()).rejects.toMatchObject({
      name: "ApiRequestError",
      code: "AUTH_REQUIRED",
      status: 200,
      requestId: "login-request-7",
      message: "接口返回了登录页面，登录状态可能已失效，请重新登录"
    });
  });

  it.each([
    { status: 401, code: "UNAUTHORIZED", message: "登录状态已失效，请重新登录", responseId: "unauthorized-response" },
    { status: 403, code: "FORBIDDEN", message: "当前账号无权访问此内容", responseId: "forbidden-response" }
  ])("preserves the meaning and request ID of HTTP $status", async ({ status, code, message, responseId }) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { requestId: responseId } }, { status })));

    await expect(api.settings()).rejects.toMatchObject({
      name: "ApiRequestError",
      code,
      status,
      requestId: responseId,
      message
    });
  });

  it("does not apply the read timeout to writes or replace a supplied idempotency key", async () => {
    vi.useFakeTimers();
    let finishRequest: ((response: Response) => void) | undefined;
    let requestInit: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      return new Promise<Response>((resolve) => { finishRequest = resolve; });
    }));

    const write = api.saveSelfRetelling("release-1", "page-1", "answer", "stable-answer-key");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(requestInit?.signal).toBeUndefined();
    expect(new Headers(requestInit?.headers).get("Idempotency-Key")).toBe("stable-answer-key");
    finishRequest?.(Response.json({ releaseId: "release-1", pageId: "page-1", answer: "answer" }));
    await expect(write).resolves.toMatchObject({ answer: "answer" });
  });
});
