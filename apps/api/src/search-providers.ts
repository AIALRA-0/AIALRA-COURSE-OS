import type { ProviderHealth, SearchProviderConfig, SearchRoutePolicy } from "@course-os/contracts";
import type { TeachingResearchEvidence, TeachingResearchQuery } from "./teaching-plan.js";

export type CourseSearchProviderId = "tinyfish" | "octen" | "openalex" | "parallel" | "exa" | "jina" | "serper";

export interface CourseSearchConnection {
  providerId: CourseSearchProviderId;
  baseUrl: string;
  endpoint?: string;
  apiKey?: string;
  parameters?: Record<string, number | string | boolean>;
  estimatedMicrousdPerRequest?: number;
}

export interface CourseSearchReceipt {
  queryId: string;
  provider: CourseSearchProviderId;
  durationMs: number;
  estimatedMicrousd: number;
  resultCount: number;
  errorCode?: "SEARCH_PROVIDER_AUTH" | "SEARCH_PROVIDER_RATE_LIMIT" | "SEARCH_PROVIDER_TIMEOUT" | "SEARCH_PROVIDER_NETWORK" | "SEARCH_PROVIDER_RESPONSE";
  retryable?: boolean;
}

export interface CourseSearchResponse {
  evidence: TeachingResearchEvidence[];
  receipts: CourseSearchReceipt[];
}

export function defaultCourseSearchProviders(): SearchProviderConfig[] {
  const capturedAt = "2026-09-10T04:00:00.000Z";
  const vault = { backend: "course_os_vault" as const, state: "missing" as const };
  return [
    { id: "tinyfish", displayName: "TinyFish Search", baseUrl: "https://api.search.tinyfish.ai", endpoint: "/", authType: "x-api-key", enabled: false,
      credential: { configured: false }, vault, purposes: ["web", "terminology", "temporal"], maxResults: 8,
      pricing: { currency: "USD", perRequestMicrousd: 0, capturedAt, source: "provider-default" } },
    { id: "octen", displayName: "Octen Search", baseUrl: "https://api.octen.ai", endpoint: "/search", authType: "x-api-key", enabled: false,
      credential: { configured: false }, vault, purposes: ["web", "terminology", "temporal"], maxResults: 8,
      pricing: { currency: "USD", perRequestMicrousd: 1_000, capturedAt, source: "provider-default" } },
    { id: "openalex", displayName: "OpenAlex", baseUrl: "https://api.openalex.org", endpoint: "/works", authType: "query", enabled: false,
      credential: { configured: false }, credentialRequired: false, vault, purposes: ["academic", "terminology"], maxResults: 10,
      pricing: { currency: "USD", perRequestMicrousd: 1_000, capturedAt, source: "provider-default" } },
    { id: "parallel", displayName: "Parallel Search", baseUrl: "https://api.parallel.ai", endpoint: "/v1/search", authType: "x-api-key", enabled: false,
      credential: { configured: false }, vault, purposes: ["web", "terminology", "temporal"], maxResults: 8,
      pricing: { currency: "USD", perRequestMicrousd: 1_000, capturedAt, source: "provider-default" } },
    { id: "exa", displayName: "Exa", baseUrl: "https://api.exa.ai", endpoint: "/search", authType: "x-api-key", enabled: false,
      credential: { configured: false }, vault, purposes: ["web", "terminology", "temporal"], maxResults: 8,
      pricing: { currency: "USD", perRequestMicrousd: 7_000, capturedAt, source: "provider-default" } },
    { id: "jina", displayName: "Jina Search", baseUrl: "https://s.jina.ai", authType: "bearer", enabled: false,
      credential: { configured: false }, vault, purposes: ["web", "terminology", "temporal"], maxResults: 8,
      pricing: { currency: "USD", perRequestMicrousd: 1_000, capturedAt, source: "provider-default" } },
    { id: "serper", displayName: "Serper", baseUrl: "https://google.serper.dev", endpoint: "/search", authType: "x-api-key", enabled: false,
      credential: { configured: false }, vault, purposes: ["web", "terminology", "temporal"], maxResults: 8,
      pricing: { currency: "USD", perRequestMicrousd: 1_000, capturedAt, source: "provider-default" } }
  ];
}

export function mergeCourseSearchProviderDefaults(saved: SearchProviderConfig[]): SearchProviderConfig[] {
  const providers = saved.map(item => structuredClone(item));
  const ids = new Set(providers.map(item => item.id));
  for (const item of defaultCourseSearchProviders()) if (!ids.has(item.id)) providers.push(structuredClone(item));
  return providers;
}

export function defaultCourseSearchRoutePolicy(workspaceId = "personal"): SearchRoutePolicy {
  return {
    workspaceId,
    rules: [
      { kind: "web", providerId: "tinyfish", enabled: false },
      { kind: "academic", providerId: "openalex", enabled: false },
      { kind: "terminology", providerId: "openalex", enabled: false },
      { kind: "temporal", providerId: "tinyfish", enabled: false }
    ],
    allowProviderFallback: false,
    maxResults: 8,
    updatedAt: new Date(0).toISOString()
  };
}

interface RawSearchResult { title?: string; url?: string; snippet?: string }

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" ? parsed.toString() : undefined;
  } catch { return undefined; }
}

function normalizedResults(rows: RawSearchResult[]): RawSearchResult[] {
  const seen = new Set<string>();
  return rows.flatMap(row => {
    const url = safeUrl(row.url);
    const title = row.title?.trim();
    const snippet = row.snippet?.replace(/\s+/gu, " ").trim();
    if (!url || !title || !snippet || seen.has(url)) return [];
    seen.add(url);
    return [{ title, url, snippet: snippet.slice(0, 2_000) }];
  }).slice(0, 8);
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 8_000): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`SEARCH_PROVIDER_FAILED:${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new Error("SEARCH_PROVIDER_INVALID_RESPONSE");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("SEARCH_PROVIDER_TIMEOUT");
    throw error;
  } finally { clearTimeout(timeout); }
}

async function fetchText(url: string, init: RequestInit, timeoutMs = 8_000): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`SEARCH_PROVIDER_FAILED:${response.status}`);
    return await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("SEARCH_PROVIDER_TIMEOUT");
    throw error;
  } finally { clearTimeout(timeout); }
}

function parseJinaResponse(raw: string): RawSearchResult[] {
  try {
    const payload = JSON.parse(raw) as { data?: Array<{ title?: string; url?: string; description?: string; content?: string }> };
    return normalizedResults((payload.data ?? []).map(row => ({
      title: row.title,
      url: row.url,
      snippet: row.description || row.content
    })));
  } catch {
    const records = new Map<string, { title?: string; url?: string; description?: string; content?: string }>();
    let currentIndex: string | undefined;
    let currentField: "description" | "content" | undefined;
    for (const sourceLine of raw.split(/\r?\n/u)) {
      const line = sourceLine.trim();
      const field = line.match(/^\[(\d+)\]\s+(Title|URL Source|Description|Markdown Content|Content):\s*(.*)$/iu);
      if (field) {
        const index = field[1];
        const sourceLabel = field[2];
        const sourceValue = field[3];
        if (!index || !sourceLabel || sourceValue === undefined) continue;
        currentIndex = index;
        const record = records.get(index) ?? {};
        const label = sourceLabel.toLowerCase();
        const value = sourceValue.trim();
        if (label === "title") record.title = value;
        else if (label === "url source") record.url = value;
        else if (label === "description") record.description = value;
        else record.content = value;
        currentField = label === "description" ? "description" : label.includes("content") ? "content" : undefined;
        records.set(index, record);
        continue;
      }
      if (!line || !currentIndex || !currentField) continue;
      const record = records.get(currentIndex)!;
      record[currentField] = [record[currentField], line].filter(Boolean).join(" ");
    }
    return normalizedResults([...records.values()].map(record => ({
      title: record.title,
      url: record.url,
      snippet: record.description || record.content
    })));
  }
}

function classifySearchFailure(error: unknown): Pick<CourseSearchReceipt, "errorCode" | "retryable"> {
  const code = error instanceof Error ? error.message : "SEARCH_PROVIDER_FAILED";
  if (code === "SEARCH_PROVIDER_TIMEOUT") return { errorCode: "SEARCH_PROVIDER_TIMEOUT", retryable: true };
  if (/SEARCH_PROVIDER_FAILED:(?:401|403)$/u.test(code)) return { errorCode: "SEARCH_PROVIDER_AUTH", retryable: false };
  if (/SEARCH_PROVIDER_FAILED:429$/u.test(code)) return { errorCode: "SEARCH_PROVIDER_RATE_LIMIT", retryable: true };
  if (/SEARCH_PROVIDER_FAILED:5\d\d$/u.test(code)) return { errorCode: "SEARCH_PROVIDER_RESPONSE", retryable: true };
  if (code === "SEARCH_PROVIDER_INVALID_RESPONSE") return { errorCode: "SEARCH_PROVIDER_RESPONSE", retryable: false };
  if (/SEARCH_PROVIDER_FAILED:\d+$/u.test(code)) return { errorCode: "SEARCH_PROVIDER_RESPONSE", retryable: false };
  return { errorCode: "SEARCH_PROVIDER_NETWORK", retryable: true };
}

async function executeSearch(connection: CourseSearchConnection, query: string, limit = 8): Promise<RawSearchResult[]> {
  const base = connection.baseUrl.replace(/\/$/u, "");
  if (connection.providerId !== "openalex" && !connection.apiKey) throw new Error("SEARCH_PROVIDER_NOT_CONFIGURED");
  if (connection.providerId === "tinyfish") {
    const url = new URL(connection.baseUrl);
    url.searchParams.set("query", query);
    const payload = await fetchJson(url.toString(), { headers: { "X-API-Key": connection.apiKey! } }) as { results?: Array<{ title?: string; url?: string; snippet?: string }> };
    return normalizedResults(payload.results ?? []).slice(0, limit);
  }
  if (connection.providerId === "octen") {
    const payload = await fetchJson(`${base}${connection.endpoint || "/search"}`, { method: "POST", headers: { "x-api-key": connection.apiKey!, "Content-Type": "application/json" },
      body: JSON.stringify({ query, count: Math.min(limit, Number(connection.parameters?.count) || 8) }) }) as { data?: { results?: Array<{ title?: string; url?: string; highlight?: string }> } };
    return normalizedResults((payload.data?.results ?? []).map(row => ({ title: row.title, url: row.url, snippet: row.highlight })));
  }
  if (connection.providerId === "parallel") {
    const payload = await fetchJson(`${base}${connection.endpoint || "/v1/search"}`, { method: "POST", headers: { "x-api-key": connection.apiKey!, "Content-Type": "application/json" }, body: JSON.stringify({
      objective: query, search_queries: [query], mode: connection.parameters?.mode || "turbo",
      advanced_settings: { max_results: Math.min(limit, Number(connection.parameters?.maxResults) || 8), excerpt_settings: { max_chars_per_result: 2_000 } }
    }) }) as { results?: Array<{ title?: string; url?: string; excerpts?: string[] | string }> };
    return normalizedResults((payload.results ?? []).map(row => ({ title: row.title, url: row.url, snippet: Array.isArray(row.excerpts) ? row.excerpts.join(" ") : row.excerpts })));
  }
  if (connection.providerId === "exa") {
    const payload = await fetchJson(`${base}${connection.endpoint || "/search"}`, {
      method: "POST",
      headers: { "x-api-key": connection.apiKey!, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        type: connection.parameters?.type || "auto",
        numResults: Math.min(limit, Number(connection.parameters?.numResults) || 8),
        contents: { highlights: true, text: true }
      })
    }) as { results?: Array<{ title?: string; url?: string; text?: string; highlights?: string[]; publishedDate?: string }> };
    return normalizedResults((payload.results ?? []).map(row => ({
      title: row.title,
      url: row.url,
      snippet: row.text || row.highlights?.join(" ")
    })));
  }
  if (connection.providerId === "jina") {
    const url = new URL(`${base}/${encodeURIComponent(query)}`);
    const payload = await fetchText(url.toString(), {
      headers: {
        "Authorization": `Bearer ${connection.apiKey!}`,
        "X-Respond-With": "no-content",
        "X-Return-Format": "json"
      }
    });
    return parseJinaResponse(payload).slice(0, limit);
  }
  if (connection.providerId === "serper") {
    const payload = await fetchJson(`${base}${connection.endpoint || "/search"}`, {
      method: "POST",
      headers: { "X-API-KEY": connection.apiKey!, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: Math.min(limit, Number(connection.parameters?.num) || 8) })
    }) as { organic?: Array<{ title?: string; link?: string; snippet?: string }>; knowledgeGraph?: { title?: string; description?: string; website?: string } };
    const rows = [...(payload.knowledgeGraph?.website ? [{
      title: payload.knowledgeGraph.title,
      url: payload.knowledgeGraph.website,
      snippet: payload.knowledgeGraph.description
    }] : []), ...(payload.organic ?? []).map(row => ({ title: row.title, url: row.link, snippet: row.snippet }))];
    return normalizedResults(rows);
  }
  const url = new URL(`${base}${connection.endpoint || "/works"}`);
  url.searchParams.set("search", query);
  url.searchParams.set("per-page", String(Math.min(limit, Number(connection.parameters?.perPage) || 8)));
  if (connection.apiKey) url.searchParams.set("api_key", connection.apiKey);
  const payload = await fetchJson(url.toString(), {}) as { results?: Array<{ title?: string; doi?: string; id?: string; publication_year?: number; primary_location?: { source?: { display_name?: string }; landing_page_url?: string }; authorships?: Array<{ author?: { display_name?: string } }> }> };
  return normalizedResults((payload.results ?? []).map(row => ({ title: row.title, url: row.doi || row.primary_location?.landing_page_url || row.id,
    snippet: [row.authorships?.map(item => item.author?.display_name).filter(Boolean).join(", "), row.primary_location?.source?.display_name, row.publication_year].filter(Boolean).join("；") })));
}

export async function searchTeachingEvidence(queries: TeachingResearchQuery[], connections: CourseSearchConnection[]): Promise<CourseSearchResponse> {
  const evidence: TeachingResearchEvidence[] = [];
  const receipts: CourseSearchReceipt[] = [];
  for (const query of queries.slice(0, 2)) {
    for (const connection of connections) {
      const started = Date.now();
      try {
        const results = await executeSearch(connection, query.query);
        receipts.push({ queryId: query.id, provider: connection.providerId, durationMs: Date.now() - started,
          estimatedMicrousd: connection.estimatedMicrousdPerRequest ?? 0, resultCount: results.length });
        evidence.push(...results.map(result => ({ queryId: query.id, provider: connection.providerId, title: result.title!, url: result.url!, snippet: result.snippet!, status: "candidate" as const })));
        if (results.length) break;
      } catch (error) {
        receipts.push({ queryId: query.id, provider: connection.providerId, durationMs: Date.now() - started,
          estimatedMicrousd: 0, resultCount: 0, ...classifySearchFailure(error) });
      }
    }
  }
  return { evidence, receipts };
}

export async function probeSearchConnection(connection: CourseSearchConnection): Promise<ProviderHealth> {
  const checkedAt = new Date().toISOString();
  if (connection.providerId !== "openalex" && !connection.apiKey) return { providerId: connection.providerId, state: "unconfigured", checkedAt, message: "请先保存搜索接口密钥" };
  try {
    const rows = await executeSearch(connection, "Course OS health check", 1);
    return { providerId: connection.providerId, state: "connected", checkedAt, message: rows.length ? "连接正常，搜索接口返回了可用结果" : "连接正常，当前测试查询没有结果" };
  } catch (error) {
    const code = error instanceof Error ? error.message : "SEARCH_PROVIDER_FAILED";
    return { providerId: connection.providerId, state: code.includes("401") || code.includes("403") ? "offline" : "degraded", checkedAt,
      message: code === "SEARCH_PROVIDER_TIMEOUT" ? "连接检查超时" : code.includes("401") || code.includes("403") ? "接口可以访问，但密钥无效或没有权限" : "暂时无法完成搜索接口检查" };
  }
}
