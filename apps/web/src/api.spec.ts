import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";

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
