import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";
import { createQuestionBatchState } from "./question-preview.js";

describe("metadata write result recovery", () => {
  it("keeps an unknown operation across tab closure without replaying it automatically", async () => {
    const durable = new Map<string, string>();
    const storage = { getItem: (key: string) => durable.get(key) ?? null,
      setItem: (key: string, value: string) => durable.set(key, value) };
    const keys: string[] = [];
    vi.stubGlobal("window", { localStorage: storage, sessionStorage: { getItem: () => null } });
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key")!);
      if (keys.length === 1) throw new TypeError("write acknowledged but response lost");
      return Response.json({ id: "synthetic-reopened-course" });
    }));
    vi.resetModules();
    const original = await import("./api.js");
    await expect(original.api.createCourse("Reopened course")).rejects.toMatchObject({ code: "METADATA_RESULT_UNKNOWN" });
    vi.resetModules();
    const reopened = await import("./api.js");
    expect(keys).toHaveLength(1);
    await reopened.api.createCourse("Reopened course");
    expect(keys).toEqual([keys[0], keys[0]]);
    expect(JSON.parse(durable.get("course-os-pending-metadata:personal")!)).toEqual([]);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it("keeps the same key after a lost response and discards it only after confirmation", async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("window", { sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value)
    } });
    const keys: string[] = [];
    let lost = true;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key")!);
      if (lost) { lost = false; throw new TypeError("response lost after commit"); }
      return Response.json({ id: "synthetic-created-course", title: "Recovery course" });
    }));
    await expect(api.createCourse("Recovery course")).rejects.toMatchObject({ code: "METADATA_RESULT_UNKNOWN" });
    const unresolved = JSON.parse(stored.get("course-os-pending-metadata:personal")!);
    expect(unresolved[0][1]).toBe(keys[0]);
    expect(keys).toHaveLength(1); // No automatic write retry.
    await expect(api.createCourse("Recovery course")).resolves.toMatchObject({ id: "synthetic-created-course" });
    expect(keys[1]).toBe(keys[0]);
    expect(JSON.parse(stored.get("course-os-pending-metadata:personal")!)).toEqual([]);
    await api.createCourse("Recovery course");
    expect(keys[2]).not.toBe(keys[0]);
  });
  it("restores the unresolved operation key after the module is loaded again", async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("window", { sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value)
    } });
    const keys: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key")!);
      if (keys.length === 1) throw new TypeError("response lost after commit");
      return Response.json({ id: "synthetic-reloaded-course", title: "Reload recovery course" });
    }));
    await expect(api.createCourse("Reload recovery course")).rejects.toMatchObject({ code: "METADATA_RESULT_UNKNOWN" });
    vi.resetModules();
    const reloaded = await import("./api.js");
    await reloaded.api.createCourse("Reload recovery course");
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(JSON.parse(stored.get("course-os-pending-metadata:personal")!)).toEqual([]);
  });
  it("retries the original revision when refresh has already exposed the committed tree node", async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("window", { sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value)
    } });
    const sent: Array<{ key: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent.push({ key: new Headers(init?.headers).get("Idempotency-Key")!, body: JSON.parse(String(init?.body)) });
      if (sent.length === 1) throw new TypeError("lost rename response");
      return Response.json({ id: "synthetic-node-reloaded", kind: "module", title: "Renamed", revision: 2, children: [] });
    }));
    const node = { id: "synthetic-node-reloaded", kind: "module" as const, title: "Original", revision: 1, children: [] };
    await expect(api.updateTreeNode(node, { title: "Renamed" })).rejects.toMatchObject({ code: "METADATA_RESULT_UNKNOWN" });
    vi.resetModules();
    const reloaded = await import("./api.js");
    await reloaded.api.updateTreeNode({ ...node, title: "Renamed", revision: 2 }, { title: "Renamed" });
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[1]?.body).toEqual({ title: "Renamed", expectedRevision: 1 });
  });
  it("stops waiting on a hung write without forgetting its unknown result or retrying automatically", async () => {
    vi.useFakeTimers();
    const stored = new Map<string, string>();
    vi.stubGlobal("window", { sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value)
    } });
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    const fresh = await import("./api.js");
    const result = expect(fresh.api.createCourse("Hung response course")).rejects.toMatchObject({ code: "METADATA_RESULT_UNKNOWN" });
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stored.get("course-os-pending-metadata:personal")!).length).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("search settings API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the native Course OS search settings endpoints", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method || "GET", body: typeof init?.body === "string" ? init.body : undefined });
      return new Response(JSON.stringify({ id: "search-one", credential: { configured: true, maskedValue: "••••1234" }, workspaceId: "personal", rules: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    await api.searchProviders();
    await api.updateSearchProvider("search one", { enabled: true, endpoint: "/search", maxResults: 6 });
    await api.saveSearchProviderCredential("search one", "secret-value");
    await api.testSearchProvider("search one");
    await api.searchRoutePolicy();
    await api.saveSearchRoutePolicy({ workspaceId: "personal", rules: [], updatedAt: new Date(0).toISOString() });

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /api/v1/search-providers",
      "PATCH /api/v1/search-providers/search%20one",
      "PUT /api/v1/search-providers/search%20one/credential",
      "POST /api/v1/search-providers/search%20one:test",
      "GET /api/v1/search-route-policy",
      "PUT /api/v1/search-route-policy"
    ]);
    expect(calls.at(2)?.body).toBe(JSON.stringify({ secret: "secret-value" }));
  });
});

describe("ReadWeave deep link API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("looks up the encoded note ID in the active workspace", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return Response.json({ noteId: "note/one", url: "https://readweave.example/#root/note/one", host: "readweave.example", verified: true });
    }));

    await expect(api.deepLink("note/one")).resolves.toMatchObject({
      noteId: "note/one",
      verified: true,
      url: "https://readweave.example/#root/note/one"
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/v1/readweave/links/note%2Fone");
    expect(calls[0]?.headers.get("X-Workspace-Id")).toBe("personal");
  });
});

describe("generation plan API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries failed pages through the plan endpoint", async () => {
    const calls: Array<{ url: string; method: string; body?: string; idempotencyKey?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), method: init?.method || "GET", body: typeof init?.body === "string" ? init.body : undefined, idempotencyKey: headers.get("Idempotency-Key") || undefined });
      return new Response(JSON.stringify({ plan: { id: "plan-1", failedPageIds: ["page-2"] }, jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    await api.retryGenerationPlanFailed("plan/1");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "/api/v1/generation-plans/plan%2F1:retry-failed", method: "POST" });
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.idempotencyKey).toBeTruthy();
  });
});

describe("self retelling API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads per-release answers and uses the persistent answer and card review routes", async () => {
    const calls: Array<{ url: string; method: string; body?: string; headers: Headers }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method || "GET", body: typeof init?.body === "string" ? init.body : undefined, headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ workspaceId: "personal", releaseId: "release one", pageId: "page one", answer: "用自己的话解释" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    await api.selfRetellings("release one");
    await api.saveSelfRetelling("release one", "page one", "用自己的话解释", "retelling-key");
    await api.reviewSelfRetelling("release one", "page one", "remembered");

    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET /api/v1/self-retellings?releaseId=release%20one",
      "PUT /api/v1/self-retellings/release%20one/page%20one",
      "POST /api/v1/self-retellings/release%20one/page%20one/review"
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ answer: "用自己的话解释" });
    expect(calls[1]!.headers.get("Idempotency-Key")).toBe("retelling-key");
    expect(calls[2]!.headers.get("Idempotency-Key")).toBeTruthy();
    expect(calls[2]!.headers.get("X-Actor")).toBe("personal-user");
    expect(calls[2]!.headers.get("X-Workspace-Id")).toBe("personal");
  });
});

describe("question selection API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reuses the persisted active seed and exclusions on preload, and includes count in request identity", async () => {
    const state = {
      ...createQuestionBatchState("session-refresh", "page-refresh", "2026-09-30"),
      batchIndex: 2,
      activeSeed: "session-refresh:page-refresh:batch:2",
      activeCount: 5 as const,
      requestedCount: 2 as const,
      usedQuestionIds: ["q1", "q2"],
      activeExcludedQuestionIds: ["q1", "q2"]
    };
    vi.stubGlobal("window", { sessionStorage: { getItem: vi.fn(() => JSON.stringify(state)) } });
    const calls: Array<{ body: string; url: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body) });
      return Response.json({ selection: { id: "selection" }, questions: [], available: 0 });
    }));

    await api.selectQuestions("page-refresh", "session-refresh");
    await api.selectQuestions("page-refresh", "session-refresh", state.activeSeed, state.activeCount, state.activeExcludedQuestionIds);
    await api.selectQuestions("page-refresh", "session-refresh", state.activeSeed, 2, state.activeExcludedQuestionIds);

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ seed: state.activeSeed, count: 5, excludeQuestionIds: ["q1", "q2"] });
    expect(JSON.parse(calls[1]!.body)).toMatchObject({ seed: state.activeSeed, count: 2, excludeQuestionIds: ["q1", "q2"] });
  });
});
