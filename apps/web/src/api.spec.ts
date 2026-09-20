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
