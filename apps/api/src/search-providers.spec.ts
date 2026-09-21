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

  it("calls Exa directly and normalizes text or highlights", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://exa.test/search");
      expect(new Headers(init?.headers).get("x-api-key")).toBe("synthetic-exa-key");
      expect(JSON.parse(String(init?.body))).toMatchObject({ query: "graph encoder", type: "auto", numResults: 8, contents: { highlights: true, text: true } });
      return Response.json({ results: [{ title: "Graph Encoder", url: "https://example.test/exa", highlights: ["A useful excerpt"] }] });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await searchTeachingEvidence([{ id: "q1", atomId: "a1", query: "graph encoder", reason: "missing term" }], [
      { providerId: "exa", baseUrl: "https://exa.test", endpoint: "/search", apiKey: "synthetic-exa-key" }
    ]);
    expect(result.evidence[0]).toMatchObject({ provider: "exa", title: "Graph Encoder", snippet: "A useful excerpt", status: "candidate" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("calls Jina Search with its bearer protocol and normalizes data results", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://jina.test/graph%20encoder");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-jina-key");
      expect(new Headers(init?.headers).get("x-return-format")).toBe("json");
      return Response.json({ data: [{ title: "Jina result", url: "https://example.test/jina", description: "Jina excerpt" }] });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await searchTeachingEvidence([{ id: "q1", atomId: "a1", query: "graph encoder", reason: "missing term" }], [
      { providerId: "jina", baseUrl: "https://jina.test", apiKey: "synthetic-jina-key" }
    ]);
    expect(result.evidence[0]).toMatchObject({ provider: "jina", url: "https://example.test/jina", snippet: "Jina excerpt" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("accepts Jina Search indexed text responses when the service ignores the JSON header", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response([
      "[1] Title: Graph Encoder",
      "[1] URL Source: https://example.test/graph-encoder",
      "[1] Description: A graph encoder turns graph structure into vectors.",
      "[2] Title: Message Passing",
      "[2] URL Source: https://example.test/message-passing",
      "[2] Markdown Content:",
      "Nodes exchange information with their neighbours.",
      "The updated states are used by downstream layers."
    ].join("\n"), { status: 200, headers: { "Content-Type": "text/plain" } })));
    const result = await searchTeachingEvidence([{ id: "q1", atomId: "a1", query: "graph encoder", reason: "missing term" }], [
      { providerId: "jina", baseUrl: "https://jina.test", apiKey: "synthetic-jina-key" }
    ]);
    expect(result.evidence).toEqual([
      expect.objectContaining({ provider: "jina", title: "Graph Encoder", url: "https://example.test/graph-encoder", snippet: "A graph encoder turns graph structure into vectors." }),
      expect.objectContaining({ provider: "jina", title: "Message Passing", url: "https://example.test/message-passing", snippet: "Nodes exchange information with their neighbours. The updated states are used by downstream layers." })
    ]);
  });

  it("calls Serper directly and includes a knowledge graph result before organic results", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://serper.test/search");
      expect(new Headers(init?.headers).get("x-api-key")).toBe("synthetic-serper-key");
      expect(JSON.parse(String(init?.body))).toEqual({ q: "graph encoder", num: 8 });
      return Response.json({ knowledgeGraph: { title: "Graph Encoder", website: "https://example.test/kg", description: "Knowledge graph excerpt" }, organic: [{ title: "Organic", link: "https://example.test/organic", snippet: "Organic excerpt" }] });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await searchTeachingEvidence([{ id: "q1", atomId: "a1", query: "graph encoder", reason: "missing term" }], [
      { providerId: "serper", baseUrl: "https://serper.test", apiKey: "synthetic-serper-key" }
    ]);
    expect(result.evidence.map(item => item.title)).toEqual(["Graph Encoder", "Organic"]);
    expect(fetcher).toHaveBeenCalledOnce();
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

  it("classifies malformed JSON as a non-retryable response failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } })));
    const result = await searchTeachingEvidence([{ id: "q1", atomId: "a1", query: "term", reason: "missing term" }], [
      { providerId: "serper", baseUrl: "https://serper.test", apiKey: "synthetic-serper-key" }
    ]);
    expect(result.receipts).toEqual([expect.objectContaining({ provider: "serper", errorCode: "SEARCH_PROVIDER_RESPONSE", retryable: false })]);
  });
});
