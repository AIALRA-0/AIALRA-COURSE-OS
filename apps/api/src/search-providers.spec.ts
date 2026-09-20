import { afterEach, describe, expect, it, vi } from "vitest";
import { probeSearchConnection, searchTeachingEvidence } from "./search-providers.js";

describe("native Course OS search providers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses TinyFish directly and never calls ReadWeave", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("api.search.tinyfish.test/?query=official+term");
      expect(new Headers(init?.headers).get("x-api-key")).toBe("synthetic-tinyfish-key");
      return Response.json({ results: [{ title: "Official term", url: "https://example.test/term", snippet: "Verified definition" }] });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await searchTeachingEvidence([{ id: "q1", atomId: "a1", query: "official term", reason: "missing term" }], [
      { providerId: "tinyfish", baseUrl: "https://api.search.tinyfish.test", apiKey: "synthetic-tinyfish-key", estimatedMicrousdPerRequest: 0 }
    ]);
    expect(result.evidence).toEqual([{ queryId: "q1", provider: "tinyfish", title: "Official term", url: "https://example.test/term", snippet: "Verified definition", status: "candidate" }]);
    expect(result.receipts).toEqual([expect.objectContaining({ provider: "tinyfish", resultCount: 1, estimatedMicrousd: 0 })]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("falls through to Octen only when the cheaper provider returns no result", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("tinyfish")) return Response.json({ results: [] });
      expect(JSON.parse(String(init?.body))).toEqual({ query: "evidence", count: 8 });
      return Response.json({ data: { results: [{ title: "Evidence", url: "https://example.test/evidence", highlight: "Source excerpt" }] } });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await searchTeachingEvidence([{ id: "q1", atomId: "a1", query: "evidence", reason: "missing source" }], [
      { providerId: "tinyfish", baseUrl: "https://tinyfish.test", apiKey: "synthetic-tinyfish-key" },
      { providerId: "octen", baseUrl: "https://octen.test", endpoint: "/search", apiKey: "synthetic-octen-key", estimatedMicrousdPerRequest: 1_000 }
    ]);
    expect(result.evidence[0]).toMatchObject({ provider: "octen", title: "Evidence" });
    expect(result.receipts.map(item => [item.provider, item.resultCount])).toEqual([["tinyfish", 0], ["octen", 1]]);
  });

  it("probes OpenAlex without requiring a private key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [{ title: "Course systems", id: "https://openalex.org/W1", publication_year: 2026 }] })));
    const health = await probeSearchConnection({ providerId: "openalex", baseUrl: "https://api.openalex.org", endpoint: "/works" });
    expect(health).toMatchObject({ state: "connected", providerId: "openalex" });
  });

  it("classifies provider failures without exposing raw responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "private provider message" }, { status: 429 })));
    const result = await searchTeachingEvidence([{ id: "q1", atomId: "a1", query: "term", reason: "missing term" }], [
      { providerId: "octen", baseUrl: "https://octen.test", apiKey: "synthetic-octen-key" }
    ]);
    expect(result.evidence).toEqual([]);
    expect(result.receipts).toEqual([expect.objectContaining({
      provider: "octen", resultCount: 0, errorCode: "SEARCH_PROVIDER_RATE_LIMIT", retryable: true
    })]);
    expect(JSON.stringify(result)).not.toContain("private provider message");
  });
});
