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

  it("aborts a hung fetch at ten seconds before starting one automatic recovery request", async () => {
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
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(firstRequest).resolves.toMatchObject({ releaseId: "release-1" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(calls[1]?.requestId).toBeTruthy();
    expect(calls[1]?.requestId).not.toBe(calls[0]?.requestId);
  });

  it("keeps the same deadline active while consuming a hanging JSON body", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const signals: AbortSignal[] = [];
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
      if (requestSignal) signals.push(requestSignal);
      return Promise.resolve(response);
    }));

    const request = api.lesson("page-1");
    const timedOut = expect(request).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", status: 408 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);

    await timedOut;
    expect(bodyText).toHaveBeenCalledTimes(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
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


  it("recovers a transient saved-answer GET without changing page, session or selection", async () => {
    const saved = [{ id: "attempt-one", pageId: "page:2", answer: "B", correct: true }];
    const mock = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: "READ_DEADLINE_EXCEEDED" } }, { status: 504 }))
      .mockResolvedValueOnce(Response.json(saved));
    vi.stubGlobal("fetch", mock);
    await expect(api.questionAttempts("page:2", "session/one", "selection+1")).resolves.toEqual(saved);
    expect(mock).toHaveBeenCalledTimes(2);
    const path = "/api/v1/pages/page%3A2/question-attempts?sessionId=session%2Fone&selectionId=selection%2B1";
    for (const [url, init] of mock.mock.calls) {
      expect(url).toBe(path);
      expect(init.method ?? "GET").toBe("GET");
      expect(init.body).toBeUndefined();
    }
    expect(new Headers(mock.mock.calls[0]![1].headers).get("X-Request-Id"))
      .not.toBe(new Headers(mock.mock.calls[1]![1].headers).get("X-Request-Id"));
  });

  it("stops saved-answer recovery after its second transient failure", async () => {
    const mock = vi.fn(async () => Response.json({ error: { code: "UPSTREAM_UNAVAILABLE", requestId: "second-failure" } }, { status: 502 }));
    vi.stubGlobal("fetch", mock);
    await expect(api.questionAttempts("page-2", "session-one", "selection-one"))
      .rejects.toMatchObject({ status: 502, requestId: "second-failure" });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])("does not replay saved-answer reads denied with HTTP %s", async (status) => {
    const mock = vi.fn(async () => Response.json({ error: {} }, { status }));
    vi.stubGlobal("fetch", mock);
    await expect(api.questionAttempts("page-2", "session-one", "selection-one")).rejects.toMatchObject({ status });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("does not start saved-answer recovery after caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new DOMException("page changed", "AbortError");
    const mock = vi.fn(async () => {
      controller.abort(reason);
      return Response.json({ error: {} }, { status: 504 });
    });
    vi.stubGlobal("fetch", mock);
    await expect(api.questionAttempts("page-2", "session-one", "selection-one", { signal: controller.signal })).rejects.toBe(reason);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("keeps answer submission outside automatic GET recovery", async () => {
    const mock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: { code: "UPSTREAM_UNAVAILABLE" } }, { status: 504 }));
    vi.stubGlobal("fetch", mock);
    await expect(api.questionAttempt({ selectionId: "selection-one", sessionId: "session-one", courseReleaseId: "release-one", pageId: "page-2", questionId: "question-one", questionVersion: 1, answer: "B", usedHintLevel: 0 }, "stable-attempt-key"))
      .rejects.toMatchObject({ status: 504 });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]![1]?.method).toBe("POST");
    expect(new Headers(mock.mock.calls[0]![1]?.headers).get("Idempotency-Key")).toBe("stable-attempt-key");
  });
});
