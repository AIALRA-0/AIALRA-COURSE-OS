import { afterEach, describe, expect, it, vi } from "vitest";
import { generationHarnessFileSha256 } from "./generation-harness.js";
import { HttpProviderTeachingClient, ModelRouterGenerationError, parseWrappedProviderJson, probeProviderConnection, RoutedProviderTeachingClient, SettingsProviderTeachingClient, currentGenerationHarness, teachingPackageSchema, withCurrentDeepSeekModels } from "./model-router.js";

describe("generation harness", () => {
  it("extracts the largest complete JSON object from provider wrapper text", () => {
    expect(parseWrappedProviderJson('说明文字 {"status":"meta"} 正式结果 {"facts":[{"id":"f1"}],"steps":[{"id":"s1"}]} 结束'))
      .toEqual({ facts: [{ id: "f1" }], steps: [{ id: "s1" }] });
  });
  it("repairs literal control characters inside streamed JSON strings", () => {
    expect(parseWrappedProviderJson('{"chapterBridgeMarkdown":"第一行\n第二行\t缩进"}'))
      .toEqual({ chapterBridgeMarkdown: "第一行\n第二行\t缩进" });
  });
  it("salvages only complete top-level fields from truncated JSON", () => {
    expect(parseWrappedProviderJson('{"priorKnowledge":["完整字段"],"fullExplanationMarkdown":"截断中'))
      .toEqual({ priorKnowledge: ["完整字段"] });
    expect(parseWrappedProviderJson('{"priorKnowledge":["完整字段"],"questions":'))
      .toEqual({ priorKnowledge: ["完整字段"] });
  });
  it("rejects malformed JSON when no complete field can be recovered", () => {
    expect(() => parseWrappedProviderJson('{"priorKnowledge":['))
      .toThrow("MODEL_PROVIDER_OUTPUT_JSON_INVALID");
  });
  it("loads editable prompt and schema files as one hashed snapshot", () => {
    const snapshot = currentGenerationHarness();
    expect(snapshot).toMatchObject({ id: "course-os-teaching", version: "2.5.0", taskContract: "GENERATE + TEACHING" });
    expect(snapshot.files.some((file) => file.path === "apps/api/src/planned-teaching.ts")).toBe(true);
    expect(snapshot.files.some((file) => file.path === "apps/api/src/app.ts")).toBe(false);
    const schema = teachingPackageSchema as { properties: Record<string, unknown>; required: string[] };
    expect(new Set(schema.required)).toEqual(new Set(Object.keys(schema.properties)));
    expect(snapshot.files.map((file) => file.path)).toEqual(["page-plan-prompt.md", "planned-writing-prompt.md", "writing-format-contract.md", "policy-skill.md", "policy-format-rules.md", "policy-explanation-framework.md", "policy-formula-explanation.md", "teaching-package.schema.json", "apps/api/src/generation-harness.ts", "apps/api/src/model-router.ts", "apps/api/src/model-usage-meter.ts", "apps/api/src/pricing.ts", "apps/api/src/planned-teaching.ts", "packages/quality/src/presentation.ts"]);
    expect(snapshot.aggregateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.files.find((file) => file.path === "policy-skill.md")?.sha256).toBe("c0a8122648c926e06d6a43d27e9097f48e818fce17e19ab8429151ffc4d6d457");
    expect(snapshot.files.find((file) => file.path === "policy-format-rules.md")?.sha256).toBe("d834bf4624dbf0fb850a63ae35061864122afe090ce16e51a9845506af35a563");
    expect(snapshot.files.find((file) => file.path === "policy-explanation-framework.md")?.sha256).toBe("8034dfb53735e479f97d82dfc74a846d6170aa3415e80f809d17bd3502c06463");
    expect(snapshot.files.find((file) => file.path === "policy-formula-explanation.md")?.sha256).toBe("65e589994e5f5da5514d57ad5aca6d63b49adf6975e6af988598115008802c8e");
  });

  it("hashes the same Harness source identically across Windows and Linux line endings", () => {
    expect(generationHarnessFileSha256("第一行\r\n第二行\r\n")).toBe(generationHarnessFileSha256("第一行\n第二行\n"));
  });


});

describe("OpenCode Go and DeepSeek provider clients", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns metadata from raw provider output without retaining its values", async () => {
    const rawText = JSON.stringify({ answer: "private provider text", items: ["one", "two"], count: 4, empty: null });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      id: "response-test-id", status: "completed", stop_reason: "stop", output_text: rawText,
      usage: { input_tokens: 100, output_tokens: 100, total_cost: 0.001 }
    })));
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://deepseek.test",
      apiKey: "synthetic-example-token", model: "deepseek-flash", protocol: "responses" });
    const result = await runPlannedStageForTest(client);
    expect(result.providerDiagnostic).toEqual({
      responseId: "response-test-id",
      finishReason: "stop",
      status: "completed",
      rawOutputType: "string",
      rawOutputChars: rawText.length,
      rawFields: {
        answer: { type: "string", length: "private provider text".length },
        items: { type: "array", length: 2 },
        count: { type: "number" },
        empty: { type: "null" }
      }
    });
    expect(JSON.stringify(result.providerDiagnostic)).not.toContain("private provider text");
  });

  it("tracks concurrent provider requests and emits gated structured lifecycle logs", async () => {
    vi.stubEnv("COURSE_OS_PROVIDER_REQUEST_DIAGNOSTICS", "true");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let releaseRequests!: () => void;
    const requestsReleased = new Promise<void>((resolve) => { releaseRequests = resolve; });
    const fetchMock = vi.fn(async () => {
      await requestsReleased;
      return Response.json({ output_text: "ok", usage: { input_tokens: 100, output_tokens: 100, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://deepseek.test",
      apiKey: "synthetic-example-token", model: "deepseek-flash", protocol: "responses" });
    const first = runPlannedStageForTest(client, "counter_a");
    const second = runPlannedStageForTest(client, "counter_b");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const startEvents = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((event) => event.state === "start");
    expect(startEvents.map((event) => event.currentInFlight)).toEqual([1, 2]);
    expect(startEvents.map((event) => event.peakInFlight)).toEqual([1, 2]);
    releaseRequests();
    await Promise.all([first, second]);
    const events = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    const endEvents = events.filter((event) => event.state === "end");
    expect(endEvents).toHaveLength(2);
    expect(endEvents.map((event) => event.currentInFlight).sort()).toEqual([0, 1]);
    expect(endEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "deepseek", model: "deepseek-flash", phase: "counter_a", httpStatus: 200, error: null }),
      expect.objectContaining({ provider: "deepseek", model: "deepseek-flash", phase: "counter_b", httpStatus: 200, error: null })
    ]));
    expect(JSON.stringify(events)).not.toContain("synthetic-example-token");
    expect(JSON.stringify(events)).not.toContain("https://deepseek.test");
  });

  it("uses the Anthropic messages protocol for OpenCode Go Qwen", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://opencode.test/messages");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("qwen3.8-flash");
      expect(body.system).toContain("questions");
      expect(body.response_format).toBeUndefined();
      expect((body.messages as Array<{ content: unknown }>)[0]?.content).toContain("来源内容");
      return Response.json({ model: "qwen3.8-flash", content: [{ type: "text", text: JSON.stringify(providerTeachingContent()) }], usage: { input_tokens: 120, output_tokens: 240, input_tokens_details: { cached_tokens: 30 }, cost: 0.003 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new HttpProviderTeachingClient({ providerId: "opencode-go", baseUrl: "https://opencode.test", apiKey: "synthetic-example-opencode-token", model: "qwen3.8-flash", protocol: "messages", supportsVision: false, billingMode: "subscription_quota" }).generateTeachingPackage(providerInput("qwen-test"));
    expect(result).toMatchObject({ provider: "opencode-go", model: "qwen3.8-flash", usage: { inputTokens: 120, cachedInputTokens: 30, outputTokens: 240, apiEquivalentUsd: 0.003 } });
  });

  it("uses locally validated JSON with OpenCode Go chat completions models", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://opencode.test/chat/completions");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-opencode-session")).toBe("chat-test");
      expect(headers.get("x-opencode-request")).toBe("chat-test:teaching");
      expect(headers.get("x-opencode-client")).toBe("course-os");
      expect(headers.get("User-Agent")).toBe("course-os/2.4.0");
      const body = JSON.parse(String(init?.body)) as { response_format?: unknown; max_tokens: number; messages: Array<{ role: string; content: string }> };
      expect(body.response_format).toBeUndefined();
      expect(body.max_tokens).toBeGreaterThan(0);
      expect(body.max_tokens).toBeLessThanOrEqual(15_000);
      expect(body).toMatchObject({ thinking: { type: "disabled" } });
      expect(body.messages[0]?.content).toContain("questions");
      expect(body.messages[1]?.content).toContain("来源内容");
      return Response.json({ model: "deepseek-v4-flash-vision-exp", choices: [{ message: { content: JSON.stringify(providerTeachingContent()) } }], usage: { prompt_tokens: 90, completion_tokens: 210, cached_tokens: 10 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new HttpProviderTeachingClient({ providerId: "opencode-go", baseUrl: "https://opencode.test", apiKey: "synthetic-example-opencode-token", model: "deepseek-v4-flash-vision-exp", protocol: "chat_completions", supportsVision: false, billingMode: "subscription_quota" }).generateTeachingPackage(providerInput("chat-test"));
    expect(result.usage).toMatchObject({ inputTokens: 90, cachedInputTokens: 10, outputTokens: 210 });
  });

  it("uses DeepSeek Responses with structured output and image input", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.deepseek.test/responses");
      const body = JSON.parse(String(init?.body)) as { input: Array<{ content: Array<{ type: string; image_url?: string }> }>; reasoning?: { effort?: string }; temperature?: number; text?: { format?: { type?: string; json_schema?: unknown } } };
      expect(body.text?.format?.type).toBe("json_schema");
      expect(body.reasoning?.effort).toBe("none");
      expect(body.temperature).toBeUndefined();
      expect(body.input[0]?.content.map((item) => item.type)).toEqual(["input_text", "input_image"]);
      expect(body.input[0]?.content[1]?.image_url).toMatch(/^data:image\/png;base64,/);
      return Response.json({ model: "deepseek-v4-flash-vision-exp", output_text: JSON.stringify(providerTeachingContent()), usage: { input_tokens: 300, output_tokens: 400, input_tokens_details: { cached_tokens: 50 }, total_cost: 0.012 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-v4-flash-vision-exp", protocol: "responses", supportsVision: true, billingMode: "metered" }).generateTeachingPackage(providerInput("responses-test", true));
    expect(result).toMatchObject({ provider: "deepseek", model: "deepseek-v4-flash-vision-exp", usage: { inputTokens: 300, cachedInputTokens: 50, outputTokens: 400, apiEquivalentUsd: 0.012 } });
  });

  it("reads the page image and returns its content and teaching order", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: Array<{ content: Array<{ type: string }> }> };
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("understand-page:page_understanding");
      expect(body.input[0]?.content.map(part => part.type)).toEqual(["input_text", "input_image"]);
      return Response.json({ model: "deepseek-v4-flash-vision-exp",
        output_text: "页面内容：输入经过规则处理得到输出。\n教学顺序：先说明输入，再解释规则与结果。",
        usage: { input_tokens: 100, output_tokens: 50, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://deepseek.test",
      apiKey: "synthetic-example-token", model: "deepseek-v4-flash-vision-exp", protocol: "responses", supportsVision: true });
    const result = await client.understandPage(providerInput("understand-page", true));
    expect(result).toMatchObject({ sourceDescription: "输入经过规则处理得到输出。",
      teachingPlan: "先说明输入，再解释规则与结果。", provider: "deepseek", usage: { apiEquivalentUsd: 0.001 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requests high detail for one chat-completions page image and limits matrix transcription", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string | Array<{ type: string; image_url?: { detail?: string } }> }> };
      const instructions = body.messages[0]?.content;
      expect(typeof instructions).toBe("string");
      expect(instructions).toContain("密集数值表或矩阵只说明行列含义");
      expect(instructions).toContain("最多选两个能同时按行标签、列标签和交叉位置核实的例值");
      expect(instructions).toContain("不能完成核对就不要写具体数值");
      expect(instructions).toContain("候选比较值也不自动等于实际操作收益");
      expect(instructions).toContain("边相互交叉、标签邻近多条线或端点不清时");
      expect(instructions).toContain("没有单位或所计对象的数字保留原文");
      const imagePart = (body.messages[1]?.content as Array<{ type: string; image_url?: { detail?: string } }>).find(part => part.type === "image_url");
      expect(imagePart?.image_url?.detail).toBe("high");
      return Response.json({ choices: [{ message: { content: "页面内容：矩阵中已核实的代表值见相应行列。\n教学顺序：先说明矩阵含义。" } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "opencode-go", baseUrl: "https://opencode.test", apiKey: "synthetic-example-token",
      model: "deepseek-v4-flash-vision-exp", protocol: "chat_completions", supportsVision: true });
    const result = await client.understandPage(providerInput("matrix-page-understanding", true));
    expect(result?.sourceDescription).toContain("矩阵中已核实");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("generates a bridge from the previous explanation and current summary", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string; text?: { format?: { name?: string } } };
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("bridge-page:bridge");
      expect(body.input).toContain("前页解释了输入");
      expect(body.input).toContain("本页讨论处理规则");
      expect(body.text?.format?.name).toBeUndefined();
      return Response.json({ model: "deepseek-flash",
        output_text: "前页认识了输入，本页接着看处理规则。",
        usage: { input_tokens: 100, output_tokens: 50, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://deepseek.test",
      apiKey: "synthetic-example-token", model: "deepseek-flash", protocol: "responses" });
    const result = await client.generateBridge({ ...providerInput("bridge-page"), previousPageContext: "前页解释了输入",
      currentSummary: "本页讨论处理规则" });
    expect(result).toMatchObject({ markdown: "前页认识了输入，本页接着看处理规则。", provider: "deepseek",
      usage: { apiEquivalentUsd: 0.001 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the native Kuafu Responses route without a ReadWeave hop", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.kuafushe.test/v1/responses");
      const body = JSON.parse(String(init?.body)) as { model?: string; stream?: boolean; reasoning?: { effort?: string }; text?: { format?: { type?: string } } };
      expect(body).toMatchObject({ model: "deepseek-v4.1-flash", stream: true, reasoning: { effort: "none" } });
      expect(body.text?.format?.type).toBe("json_schema");
      return Response.json({ model: "deepseek-v4.1-flash", output_text: JSON.stringify(providerTeachingContent()), usage: { input_tokens: 180, output_tokens: 260, input_tokens_details: { cached_tokens: 40 }, total_cost: 0.002 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new HttpProviderTeachingClient({ providerId: "kuafu", baseUrl: "https://api.kuafushe.test/v1", apiKey: "synthetic-example-kuafu-token", model: "deepseek-v4.1-flash", protocol: "responses", supportsVision: false, billingMode: "metered" }).generateTeachingPackage(providerInput("kuafu-responses-test"));
    expect(result).toMatchObject({ provider: "kuafu", model: "deepseek-v4.1-flash", usage: { inputTokens: 180, cachedInputTokens: 40, outputTokens: 260, apiEquivalentUsd: 0.002 } });
  });

  it("uses OpenCode Go Luna Responses with session identity and structured output", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://opencode.test/responses");
      expect(new Headers(init?.headers).get("x-opencode-session")).toBe("luna-responses-test");
      const body = JSON.parse(String(init?.body)) as { reasoning?: { effort?: string }; temperature?: number; text?: { format?: { type?: string } }; input: Array<{ content: Array<{ type: string }> }> };
      expect(body.reasoning?.effort).toBe("none");
      expect(body.temperature).toBeUndefined();
      expect(body.text?.format?.type).toBe("json_schema");
      expect(body.input[0]?.content.map((item) => item.type)).toEqual(["input_text", "input_image"]);
      return Response.json({ model: "gpt-5.6-luna", output_text: JSON.stringify(providerTeachingContent()), usage: { input_tokens: 300, output_tokens: 400, input_tokens_details: { cached_tokens: 50 } } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new HttpProviderTeachingClient({ providerId: "opencode-go", baseUrl: "https://opencode.test", apiKey: "synthetic-example-opencode-token", model: "gpt-5.6-luna", protocol: "responses", supportsVision: true, billingMode: "subscription_quota" }).generateTeachingPackage(providerInput("luna-responses-test", true));
    expect(result).toMatchObject({ provider: "opencode-go", model: "gpt-5.6-luna", usage: { inputTokens: 300, cachedInputTokens: 50, outputTokens: 400 } });
  });

  it("keeps the provider timeout active while reading the response body", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true });
      })
    } as Response)));
    const client = new HttpProviderTeachingClient({
      providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token",
      model: "deepseek-v4-flash-vision-exp", protocol: "responses", supportsVision: true, billingMode: "metered"
    }, 10);
    const failure = await client.generateTeachingPackage(providerInput("response-body-timeout", true)).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "ModelRouterGenerationError", code: "MODEL_PROVIDER_TIMEOUT", provider: "deepseek", model: "deepseek-v4-flash-vision-exp"
    });
  });

  it("consumes DeepSeek Responses events and keeps final usage", async () => {
    const content = providerTeachingContent();
    const encoder = new TextEncoder();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true });
      const final = { type: "response.completed", sequence_number: 3, response: {
        status: "completed", model: "deepseek-v4-flash-vision-exp",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(content) }] }],
        usage: { input_tokens: 220, output_tokens: 330, input_tokens_details: { cached_tokens: 20 }, total_cost: 0.004 }
      } };
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { status: "in_progress" } })}\n\n`));
        controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify(final)}\n\n`));
        controller.close();
      } }), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }));
    const result = await new HttpProviderTeachingClient({
      providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token",
      model: "deepseek-v4-flash-vision-exp", protocol: "responses", supportsVision: true, billingMode: "metered"
    }, 50).generateTeachingPackage(providerInput("responses-stream", true));
    expect(result).toMatchObject({ provider: "deepseek", model: "deepseek-v4-flash-vision-exp",
      usage: { inputTokens: 220, cachedInputTokens: 20, outputTokens: 330, apiEquivalentUsd: 0.004 } });
  });

  it("retries an HTTP 200 event stream that closes without its final response", async () => {
    const incomplete = new Response("event: response.created\ndata: {\"type\":\"response.created\"}\n\n", {
      headers: { "Content-Type": "text/event-stream" }
    });
    const completed = new Response("event: response.completed\ndata: "
      + JSON.stringify({ type: "response.completed", response: { status: "completed", output_text: "ok",
        usage: { input_tokens: 100, output_tokens: 100, total_cost: 0.001 } } }) + "\n\n", {
      headers: { "Content-Type": "text/event-stream" }
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(incomplete).mockResolvedValueOnce(completed);
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "kuafu", baseUrl: "https://relay.test",
      apiKey: "synthetic-example-token", model: "deepseek-v4.1-flash", protocol: "responses" });
    const result = await runPlannedStageForTest(client);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.providerDiagnostic).toMatchObject({ status: "completed", rawOutputChars: 2 });
  });

  it("preserves the HTTP status when a relay returns plain text instead of JSON or events", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream unavailable", {
      status: 502, headers: { "Content-Type": "text/plain" }
    })));
    const client = new HttpProviderTeachingClient({
      providerId: "kuafu", baseUrl: "https://relay.test", apiKey: "synthetic-example-token",
      model: "deepseek-v4.1-flash", protocol: "responses", supportsVision: true, billingMode: "metered"
    });
    await expect(client.generateTeachingPackage(providerInput("relay-plain-text-502", true)))
      .rejects.toMatchObject({ provider: "kuafu", code: "MODEL_PROVIDER_FAILED:502" });
  });

  it("retries a relay reasoning-only failure once within the same teaching stage", async () => {
    const fetchMock = vi.fn(async () => fetchMock.mock.calls.length === 1
      ? Response.json({ error: { code: "upstream_reasoning_only", message: "no final content" } }, { status: 400 })
      : Response.json({ model: "deepseek-v4.1-flash", output_text: JSON.stringify(providerTeachingContent()),
        usage: { input_tokens: 100, output_tokens: 200, total_cost: 0.001 } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "kuafu", baseUrl: "https://relay.test",
      apiKey: "synthetic-example-token", model: "deepseek-v4.1-flash", protocol: "responses",
      supportsVision: false, billingMode: "metered" });
    const result = await client.generateTeachingPackage({ ...providerInput("reasoning-only-retry"), maxCostUsd: 8 });
    expect(result.content.fullExplanationMarkdown).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the configured backup when a relay rejects concurrent requests", async () => {
    const fetchMock = vi.fn(async (url: string) => url.includes("primary.test")
      ? Response.json({ error: { code: "gateway_concurrency_limit", message: "busy" } }, { status: 400 })
      : Response.json({ model: "deepseek-v4.1-flash", output_text: JSON.stringify(providerTeachingContent()),
        usage: { input_tokens: 100, output_tokens: 200, total_cost: 0.001 } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SettingsProviderTeachingClient({ load: async () => ({
      providers: ["kuafu", "kuafu-backup"].map((id, index) => ({ id, displayName: id, baseUrl: `https://${index === 0 ? "primary" : "backup"}.test`, enabled: true,
        credential: { configured: true }, models: [{ id: index === 0 ? "deepseek-v4.1-flash" : "deepseek-v4.1-flash-expires-on-0910", displayName: "Flash", protocol: "responses" as const,
          supportsVision: false, supportsJsonSchema: true, supportsReasoning: false, billingMode: "metered" as const }] })),
      policy: { workspaceId: "personal", allowProviderFallback: true, allowAialraEmergencyFallback: false,
        updatedAt: new Date(0).toISOString(), routes: [
          { providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true },
          { providerId: "kuafu-backup", modelId: "deepseek-v4.1-flash-expires-on-0910", enabled: true }
        ], rules: [{ stage: "teach", providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true }] },
      credential: async () => "synthetic-secret"
    }) });
    const result = await client.generateTeachingPackage(providerInput("concurrency-fallback"));
    expect(result.provider).toBe("kuafu-backup");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("backup.test"))).toBe(true);
  });

  it("bounds simultaneous Kuafu teaching calls while all page jobs can keep running", async () => {
    let active = 0;
    let peak = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 20));
      active -= 1;
      return Response.json({ model: "deepseek-v4.1-flash", output_text: JSON.stringify(providerTeachingContent()),
        usage: { input_tokens: 100, output_tokens: 200, total_cost: 0.001 } });
    }));
    const client = new SettingsProviderTeachingClient({ load: async () => ({
      providers: [{ id: "kuafu", displayName: "Kuafu", baseUrl: "https://primary.test", enabled: true,
        credential: { configured: true }, models: [{ id: "deepseek-v4.1-flash", displayName: "Flash", protocol: "responses" as const,
          supportsVision: false, supportsJsonSchema: true, supportsReasoning: false, billingMode: "metered" as const }] }],
      policy: { workspaceId: "personal", allowProviderFallback: false, allowAialraEmergencyFallback: false,
        updatedAt: new Date(0).toISOString(), routes: [{ providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true }],
        rules: [{ stage: "teach", providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true }] },
      credential: async () => "synthetic-secret"
    }) });
    const results = await Promise.all(Array.from({ length: 15 }, (_, index) =>
      client.generateTeachingPackage(providerInput(`parallel-page-${index}`))));
    expect(results).toHaveLength(15);
    expect(peak).toBeLessThanOrEqual(12);
    expect(peak).toBeGreaterThan(1);
  });

  it("uses the planned writer without a blueprint and only adds a plan call when none was supplied", async () => {
    const calls: Array<{ body: Record<string, any>; key: string | null }> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      calls.push({ body, key: new Headers(init?.headers).get("Idempotency-Key") });
      const name = body.text?.format?.name;
      return Response.json({ model: body.model, output_text: name
        ? JSON.stringify(providerTeachingContent())
        : "先识别页面主题，再按来源顺序解释对象之间的关系。",
      usage: { input_tokens: 100, output_tokens: 200, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = { ...providerInput("plan-without-blueprint"), teachingPlan: undefined };
    const result = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://deepseek.test",
      apiKey: "synthetic-example-token", model: "deepseek-flash", protocol: "responses", supportsVision: true })
      .generateTeachingPackage(input);

    expect(result.content.questions).toHaveLength(4);
    expect(calls).toHaveLength(2);
    expect(calls.map(call => call.body.text?.format?.name ?? "freeform")).toEqual(["freeform", "course_os_teaching"]);
    expect(calls.map(call => call.key)).toEqual(["plan-without-blueprint:plan", "plan-without-blueprint:teaching"]);
    expect(calls[0]!.body.input).toContain("来源内容");
  });

  it("retries only the failed provider stage once with identical body and idempotency key", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: "upstream_error" } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ model: "deepseek-flash", output_text: JSON.stringify(providerTeachingContent()),
        usage: { input_tokens: 100, output_tokens: 200, total_cost: 0.001 } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://deepseek.test",
      apiKey: "synthetic-example-token", model: "deepseek-flash", protocol: "responses", supportsVision: true })
      .generateTeachingPackage(providerInput("same-stage-retry"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(fetchMock.mock.calls[1]?.[0]);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(fetchMock.mock.calls[1]?.[1]?.body);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe("same-stage-retry:teaching");
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Idempotency-Key")).toBe("same-stage-retry:teaching");
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 200, apiEquivalentUsd: 0.001 });
    expect(result.usage.unreportedCostReserveUsd).toBeGreaterThan(0);
  });

  it("does not retry quota exhaustion or turn a malformed result into a whole-page retry", async () => {
    const quotaFetch = vi.fn(async () => Response.json({ error: { code: "quota_exhausted" } }, { status: 429 }));
    vi.stubGlobal("fetch", quotaFetch);
    const quotaFailure = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://deepseek.test",
      apiKey: "synthetic-example-token", model: "deepseek-flash", protocol: "responses" })
      .generateTeachingPackage(providerInput("quota-no-retry")).catch((error: unknown) => error);
    expect(quotaFailure).toMatchObject({ code: "MODEL_PROVIDER_INSUFFICIENT_BALANCE" });
    expect(quotaFetch).toHaveBeenCalledTimes(1);

    const phases: string[] = [];
    const formatFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      const phase = body.text?.format?.name as string;
      phases.push(phase);
      return Response.json({ model: body.model,
        output_text: phase === "course_os_teaching" ? "{broken json" : JSON.stringify(providerTeachingContent()),
        usage: { input_tokens: 100, output_tokens: 200, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", formatFetch);
    const result = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://deepseek.test",
      apiKey: "synthetic-example-token", model: "deepseek-flash", protocol: "responses" })
      .generateTeachingPackage(providerInput("format-repair-only"));
    expect(phases).toEqual(["course_os_teaching", "course_os_format_repair"]);
    expect(new Headers(formatFetch.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe("format-repair-only:teaching");
    expect(new Headers(formatFetch.mock.calls[1]?.[1]?.headers).get("Idempotency-Key")).toBe("format-repair-only:format_repair");
    expect(result.teachingTrace?.phases.map(phase => phase.phase)).toEqual(["teaching", "format_repair"]);
  });

  it("stops before a response that exceeds the configured page budget", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      model: "deepseek-flash",
      output_text: JSON.stringify(providerTeachingContent()),
      usage: { input_tokens: 100, output_tokens: 200, total_cost: 0.07 }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const failure = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://deepseek.test",
      apiKey: "synthetic-example-token", model: "deepseek-flash", protocol: "responses" })
      .generateTeachingPackage({ ...providerInput("page-budget"), maxCostUsd: 0.06 }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "MODEL_PROVIDER_PAGE_BUDGET_EXCEEDED", usage: { apiEquivalentUsd: 0.07 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("reads only the final message and ignores Responses reasoning items", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      model: "deepseek-v4-flash-vision-exp",
      output: [
        { type: "reasoning", content: [{ type: "reasoning_text", text: '{"learningObjectives":"思考片段"}' }] },
        { type: "message", content: [{ type: "output_text", text: JSON.stringify(providerTeachingContent()) }] }
      ]
    }, { status: 200 })));
    const result = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-v4-flash-vision-exp", protocol: "responses", supportsVision: true, billingMode: "metered" }).generateTeachingPackage(providerInput("responses-reasoning-test", true));
    expect(result.content.learningObjectives).toHaveLength(1);
  });

  it("extracts a JSON object when a provider wraps it in explanatory text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ model: "deepseek-v4-flash-vision-exp", output_text: `元数据：${JSON.stringify({ note: "不是教学包" })}，正式结果如下：\n${JSON.stringify(providerTeachingContent())}\n以上` }, { status: 200 })));
    const result = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-v4-flash-vision-exp", protocol: "responses", supportsVision: true, billingMode: "metered" }).generateTeachingPackage(providerInput("wrapped-json-test"));
    expect(result.provider).toBe("deepseek");
    expect(result.content.questions).toHaveLength(4);
  });

  it("preserves a valid TeX formula through the planned writer", async () => {
    const content = { ...providerTeachingContent(), fullExplanationMarkdown: String.raw`系数 $\lambda$ 控制规则的强度；完整解释仍需说明每一步如何核对目标。` };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ model: "deepseek-flash", output_text: JSON.stringify(content), usage: { input_tokens: 100, output_tokens: 300, total_cost: 0.001 } })));
    const result = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-flash", protocol: "responses", billingMode: "metered" }).generateTeachingPackage(providerInput("raw-tex-json"));
    expect(result.content.fullExplanationMarkdown).toContain("$\\lambda$");
  });

  it("falls back once and never exposes a provider secret in errors", async () => {
    const secret = "synthetic-example-secret-not-for-logging";
    const zeroUsageRateLimit = () => Response.json({ error: { code: "rate_limited", message: "temporary" }, usage: { total_cost: 0 } }, { status: 429 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(zeroUsageRateLimit())
      .mockResolvedValueOnce(zeroUsageRateLimit())
      .mockResolvedValueOnce(Response.json({ model: "qwen3.8-flash", content: [{ type: "text", text: JSON.stringify(providerTeachingContent()) }], usage: { input_tokens: 100, output_tokens: 200, total_cost: 0.001 } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new RoutedProviderTeachingClient([
      { providerId: "deepseek", baseUrl: "https://deepseek.test", apiKey: secret, model: "deepseek-v4-pro", protocol: "responses" },
      { providerId: "opencode-go", baseUrl: "https://opencode.test", apiKey: "synthetic-example-opencode-token", model: "qwen3.8-flash", protocol: "messages" }
    ]).generateTeachingPackage(providerInput("fallback-test"));
    expect(result.provider).toBe("opencode-go");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstError = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://deepseek.test", apiKey: secret, model: "deepseek-v4-pro", protocol: "responses" }).generateTeachingPackage(providerInput("secret-error-test")).catch((error: unknown) => error);
    expect(firstError).toBeInstanceOf(ModelRouterGenerationError);
    expect(String(firstError)).not.toContain(secret);
  });

  it("keeps the primary provider error when fallback is disabled", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: { code: "rate_limited" } }, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SettingsProviderTeachingClient({ load: async () => ({
      providers: [
        { id: "deepseek", displayName: "DeepSeek", baseUrl: "https://deepseek.test", enabled: true, credential: { configured: true }, models: [{ id: "deepseek-v4-pro", displayName: "DeepSeek", protocol: "responses", supportsVision: false, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" }] },
        { id: "opencode-go", displayName: "OpenCode", baseUrl: "https://opencode.test", enabled: true, credential: { configured: true }, models: [{ id: "fallback", displayName: "Fallback", protocol: "responses", supportsVision: false, supportsJsonSchema: true, supportsReasoning: true, billingMode: "subscription_quota" }] }
      ],
      policy: { workspaceId: "personal", allowProviderFallback: false, allowAialraEmergencyFallback: false, updatedAt: new Date(0).toISOString(), rules: [{ stage: "teach", providerId: "deepseek", modelId: "deepseek-v4-pro", fallbackProviderId: "opencode-go", fallbackModelId: "fallback", enabled: true }] },
      credential: async () => "synthetic-secret"
    }) });
    const failure = await client.generateTeachingPackage(providerInput("no-fallback-test")).catch((error: unknown) => error);
    expect(failure).toMatchObject({ provider: "deepseek", code: "MODEL_PROVIDER_FAILED:rate_limited" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the next configured route after a relay upstream failure", async () => {
    const upstreamFailure = () => Response.json({ error: { code: "upstream_error", message: "relay upstream unavailable" }, usage: { total_cost: 0 } }, { status: 502 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(upstreamFailure())
      .mockResolvedValueOnce(upstreamFailure())
      .mockResolvedValueOnce(Response.json({ model: "deepseek-flash", output_text: JSON.stringify(providerTeachingContent()), usage: { input_tokens: 100, output_tokens: 300, total_cost: 0.001 } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SettingsProviderTeachingClient({ load: async () => ({
      providers: [
        { id: "kuafu", displayName: "Kuafu", baseUrl: "https://kuafu.test", enabled: true, credential: { configured: true }, models: [{ id: "deepseek-v4.1-flash", displayName: "Flash", protocol: "responses", supportsVision: false, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" }] },
        { id: "deepseek", displayName: "DeepSeek", baseUrl: "https://deepseek.test", enabled: true, credential: { configured: true }, models: [{ id: "deepseek-flash", displayName: "Flash", protocol: "responses", supportsVision: false, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" }] }
      ],
      policy: { workspaceId: "personal", allowProviderFallback: true, allowAialraEmergencyFallback: false, updatedAt: new Date(0).toISOString(), rules: [{ stage: "teach", providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true }], routes: [
        { providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true },
        { providerId: "deepseek", modelId: "deepseek-flash", enabled: true }
      ] },
      credential: async () => "synthetic-secret"
    }) });
    const result = await client.generateTeachingPackage(providerInput("upstream-fallback"));
    expect(result.provider).toBe("deepseek");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["kuafu", "deepseek-v4.1-flash", "kuafu-backup", "deepseek-v4.1-flash-expires-on-0910"],
    ["kuafu-backup", "deepseek-v4.1-flash-expires-on-0910", "kuafu", "deepseek-v4.1-flash"]
  ])("uses the other Kuafu line when %s has two transient upstream failures", async (firstProvider, first, secondProvider, second) => {
    const upstreamFailure = () => Response.json({ error: { code: "upstream_error" }, usage: { total_cost: 0 } }, { status: 502 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(upstreamFailure())
      .mockResolvedValueOnce(upstreamFailure())
      .mockResolvedValueOnce(Response.json({ model: second, output_text: JSON.stringify(providerTeachingContent()), usage: { input_tokens: 100, output_tokens: 200, total_cost: 0.001 } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SettingsProviderTeachingClient({ load: async () => ({
      providers: [
        { id: firstProvider, displayName: firstProvider, baseUrl: "https://kuafu.test", enabled: true, credential: { configured: true }, models: [first].map(id => ({
          id, displayName: id, protocol: "responses" as const, supportsVision: false, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" as const
        })) },
        { id: secondProvider, displayName: secondProvider, baseUrl: "https://kuafu.test", enabled: true, credential: { configured: true }, models: [second].map(id => ({
          id, displayName: id, protocol: "responses" as const, supportsVision: false, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" as const
        })) }
      ],
      policy: { workspaceId: "personal", allowProviderFallback: true, allowAialraEmergencyFallback: false, updatedAt: new Date(0).toISOString(),
        rules: [{ stage: "teach", providerId: firstProvider, modelId: first, enabled: true }], routes: [
          { providerId: firstProvider, modelId: first, enabled: true }, { providerId: secondProvider, modelId: second, enabled: true }
        ] },
      credential: async () => "synthetic-secret"
    }) });
    const result = await client.generateTeachingPackage(providerInput(`kuafu-${first}-backup`));
    expect(result).toMatchObject({ provider: secondProvider, model: second });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(call => JSON.parse(String(call[1]?.body)).model)).toEqual([first, first, second]);
  });

  it("keeps a text-only Kuafu route primary when extracted page source is available", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string; input: unknown };
      expect(body.model).toBe("deepseek-v4.1-flash");
      expect(typeof body.input).toBe("string");
      expect(String(body.input)).toContain("来源内容");
      expect(JSON.stringify(body)).not.toContain("input_image");
      return Response.json({ model: body.model, output_text: JSON.stringify(providerTeachingContent()),
        usage: { input_tokens: 100, output_tokens: 200, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SettingsProviderTeachingClient({ load: async () => ({
      providers: [
        { id: "kuafu", displayName: "Kuafu", baseUrl: "https://kuafu.test", enabled: true, credential: { configured: true },
          models: [{ id: "deepseek-v4.1-flash", displayName: "DeepSeek V4.1 Flash", protocol: "responses", supportsVision: false,
            supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" }] },
        { id: "opencode-go", displayName: "OpenCode", baseUrl: "https://opencode.test", enabled: true, credential: { configured: true },
          models: [{ id: "deepseek-v4-flash-vision-exp", displayName: "Vision", protocol: "responses", supportsVision: true,
            supportsJsonSchema: true, supportsReasoning: true, billingMode: "subscription_quota" }] }
      ],
      policy: { workspaceId: "personal", allowProviderFallback: true, allowAialraEmergencyFallback: false,
        updatedAt: new Date(0).toISOString(), routes: [
          { providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true },
          { providerId: "opencode-go", modelId: "deepseek-v4-flash-vision-exp", enabled: true }
        ], rules: [{ stage: "teach", providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true }] },
      credential: async () => "synthetic-secret"
    }) });
    const result = await client.generateTeachingPackage(providerInput("kuafu-extracted-source", true));
    expect(result).toMatchObject({ provider: "kuafu", model: "deepseek-v4.1-flash" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps image-only pages on a vision-capable route", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string; input: Array<{ content: Array<{ type: string }> }> };
      expect(body.model).toBe("deepseek-v4-flash-vision-exp");
      expect(body.input[0]?.content.map((part) => part.type)).toContain("input_image");
      return Response.json({ model: body.model, output_text: JSON.stringify(providerTeachingContent()),
        usage: { input_tokens: 100, output_tokens: 200, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SettingsProviderTeachingClient({ load: async () => ({
      providers: [
        { id: "kuafu", displayName: "Kuafu", baseUrl: "https://kuafu.test", enabled: true, credential: { configured: true },
          models: [{ id: "deepseek-v4.1-flash", displayName: "DeepSeek V4.1 Flash", protocol: "responses", supportsVision: false,
            supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" }] },
        { id: "opencode-go", displayName: "OpenCode", baseUrl: "https://opencode.test", enabled: true, credential: { configured: true },
          models: [{ id: "deepseek-v4-flash-vision-exp", displayName: "Vision", protocol: "responses", supportsVision: true,
            supportsJsonSchema: true, supportsReasoning: true, billingMode: "subscription_quota" }] }
      ],
      policy: { workspaceId: "personal", allowProviderFallback: true, allowAialraEmergencyFallback: false,
        updatedAt: new Date(0).toISOString(), routes: [
          { providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true },
          { providerId: "opencode-go", modelId: "deepseek-v4-flash-vision-exp", enabled: true }
        ], rules: [{ stage: "teach", providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true }] },
      credential: async () => "synthetic-secret"
    }) });
    const result = await client.generateTeachingPackage({ ...providerInput("image-only-fallback", true), sourceText: "" });
    expect(result).toMatchObject({ provider: "opencode-go", model: "deepseek-v4-flash-vision-exp" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fail over to another route after quota exhaustion", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: { code: "quota_exhausted" } }, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SettingsProviderTeachingClient({ load: async () => ({
      providers: ["kuafu", "kuafu-backup"].map((id, index) => ({ id, displayName: id, baseUrl: "https://kuafu.test", enabled: true,
        credential: { configured: true }, models: [{ id: index === 0 ? "deepseek-v4.1-flash" : "deepseek-v4.1-flash-expires-on-0910",
          displayName: id, protocol: "responses" as const, supportsVision: false, supportsJsonSchema: true,
          supportsReasoning: true, billingMode: "metered" as const }] })),
      policy: { workspaceId: "personal", allowProviderFallback: true, allowAialraEmergencyFallback: false, updatedAt: new Date(0).toISOString(),
        routes: [
          { providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true },
          { providerId: "kuafu-backup", modelId: "deepseek-v4.1-flash-expires-on-0910", enabled: true }
        ],
        rules: [{ stage: "teach", providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true }] },
      credential: async () => "synthetic-secret"
    }) });
    await expect(client.generateTeachingPackage(providerInput("quota-route-test"))).rejects.toMatchObject({
      provider: "kuafu", code: "MODEL_PROVIDER_INSUFFICIENT_BALANCE"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not switch to paid fallback for authentication or content failures", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: { code: "invalid_api_key" } }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SettingsProviderTeachingClient({ load: async () => ({
      providers: ["opencode-go", "deepseek"].map(id => ({ id, displayName: id, baseUrl: `https://${id}.test`, enabled: true,
        credential: { configured: true }, models: [{ id: "deepseek-v4-flash-vision-exp", displayName: "Flash", protocol: "chat_completions" as const,
          supportsVision: true, supportsJsonSchema: true, supportsReasoning: false, billingMode: "metered" as const }] })),
      policy: { workspaceId: "personal", allowProviderFallback: true, allowAialraEmergencyFallback: false, updatedAt: new Date(0).toISOString(),
        rules: [{ stage: "teach", providerId: "opencode-go", modelId: "deepseek-v4-flash-vision-exp", fallbackProviderId: "deepseek", fallbackModelId: "deepseek-v4-flash-vision-exp", enabled: true }] },
      credential: async () => "synthetic-secret"
    }) });
    await expect(client.generateTeachingPackage(providerInput("primary-auth-failure"))).rejects.toMatchObject({ provider: "opencode-go", code: "MODEL_PROVIDER_FAILED:invalid_api_key" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses current provider routes even when persisted model settings are older", async () => {
    const providers = [
      { id: "deepseek", displayName: "DeepSeek", baseUrl: "https://deepseek.test", enabled: true,
        credential: { configured: true }, models: [{ id: "deepseek-v4-pro", displayName: "Pro", protocol: "responses" as const,
          supportsVision: false, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" as const }] },
      { id: "opencode-go", displayName: "OpenCode", baseUrl: "https://opencode.test", enabled: true,
        credential: { configured: true }, models: [] }
    ];
    expect(withCurrentDeepSeekModels(providers).find((provider) => provider.id === "deepseek")?.models.some((model) => model.id === "deepseek-flash" && model.supportsVision)).toBe(true);
    expect(withCurrentDeepSeekModels(providers).find((provider) => provider.id === "opencode-go")?.models).toContainEqual(expect.objectContaining({ id: "gpt-5.6-luna", protocol: "responses", supportsVision: true }));
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string; input: Array<{ content: Array<{ type: string }> }> };
      expect(body.model).toBe("deepseek-flash");
      expect(body.input[0]?.content.map((part) => part.type)).toEqual(["input_text", "input_image"]);
      return Response.json({ model: "deepseek-flash", output_text: JSON.stringify(providerTeachingContent()), usage: { input_tokens: 100, output_tokens: 200, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SettingsProviderTeachingClient({ load: async () => ({ providers,
      policy: { workspaceId: "personal", allowProviderFallback: false, allowAialraEmergencyFallback: false,
        updatedAt: new Date(0).toISOString(), rules: [{ stage: "teach", providerId: "deepseek", modelId: "deepseek-flash", enabled: true }] },
      credential: async () => "synthetic-secret" }) });
    const result = await client.generateTeachingPackage(providerInput("current-deepseek-flash", true));
    expect(result).toMatchObject({ provider: "deepseek", model: "deepseek-flash" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies insufficient provider balance without retaining the provider message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: { code: "invalid_request_error", message: "Insufficient Balance" }
    }, { status: 402 })));
    const failure = await new HttpProviderTeachingClient({
      providerId: "deepseek",
      baseUrl: "https://deepseek.test",
      apiKey: "synthetic-example-deepseek-token",
      model: "deepseek-v4-flash-vision-exp",
      protocol: "responses",
      supportsVision: true,
      billingMode: "metered"
    }).generateTeachingPackage(providerInput("balance-test", true)).catch((error: unknown) => error);
    expect(failure).toMatchObject({ provider: "deepseek", code: "MODEL_PROVIDER_INSUFFICIENT_BALANCE" });
    expect(String(failure)).not.toContain("Insufficient Balance");
  });

  it("checks provider connectivity without returning the credential", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://opencode.test/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-example-probe-token");
      return Response.json({ data: [{ id: "qwen3.8-flash" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const health = await probeProviderConnection({ providerId: "opencode-go", baseUrl: "https://opencode.test", apiKey: "synthetic-example-probe-token", model: "qwen3.8-flash", protocol: "messages" });
    expect(health).toMatchObject({ providerId: "opencode-go", state: "connected" });
    expect(JSON.stringify(health)).not.toContain("synthetic-example-probe-token");
  });

  it("fully probes Kuafu model, structured output, and vision without exposing the credential", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer synthetic-example-kuafu-probe-token");
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "deepseek-v4.1-flash" }] });
      expect(url).toBe("https://api.kuafushe.test/v1/responses");
      const body = JSON.parse(String(init?.body)) as { input: Array<{ content: Array<{ type: string }> }>; text?: { format?: { type?: string } } };
      expect(body.input[0]?.content.map((part) => part.type)).toEqual(["input_text", "input_image"]);
      expect(body.text?.format?.type).toBe("json_schema");
      return Response.json({ status: "completed", output_text: "{\"ok\":true}" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const health = await probeProviderConnection({ providerId: "kuafu", baseUrl: "https://api.kuafushe.test/v1", apiKey: "synthetic-example-kuafu-probe-token", model: "deepseek-v4.1-flash", protocol: "responses", supportsVision: true, billingMode: "metered" }, true);
    expect(health).toMatchObject({ providerId: "kuafu", state: "connected", message: expect.stringContaining("图片输入") });
    expect(JSON.stringify(health)).not.toContain("synthetic-example-kuafu-probe-token");
  });

  it("fully probes the routed OpenCode DeepSeek chat model with image input", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "deepseek-v4-flash-vision-exp" }] });
      expect(url).toBe("https://opencode.test/chat/completions");
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: unknown }>; thinking?: { type?: string } };
      const headers = new Headers(init?.headers);
      expect(headers.get("x-opencode-session")).toBeTruthy();
      expect(headers.get("x-opencode-request")).toBeTruthy();
      expect(body.thinking?.type).toBe("disabled");
      expect(body.messages[1]?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url" })]));
      return Response.json({ choices: [{ message: { content: "{\"ok\":true}" } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const health = await probeProviderConnection({ providerId: "opencode-go", baseUrl: "https://opencode.test", apiKey: "synthetic-example-opencode-probe-token",
      model: "deepseek-v4-flash-vision-exp", protocol: "chat_completions", supportsVision: true, billingMode: "subscription_quota" }, true);
    expect(health).toMatchObject({ providerId: "opencode-go", state: "connected", message: expect.stringContaining("图片输入") });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function runPlannedStageForTest(client: HttpProviderTeachingClient, phase = "teaching") {
  const internalClient = client as unknown as {
    requestPlannedStage(
      input: ReturnType<typeof providerInput>,
      request: { phase: string; instructions: string; prompt: string; maxOutputTokens: number },
      budget: number
    ): Promise<{ providerDiagnostic?: Record<string, unknown> }>;
  };
  return internalClient.requestPlannedStage(providerInput(`diagnostic-${phase}`), {
    phase, instructions: "test", prompt: "test", maxOutputTokens: 1_000
  }, 0.06);
}

function providerInput(idempotencyKey: string, withImage = false) {
  return {
    pageTitle: "供应商协议测试页",
    pageNumber: 1,
    sourceText: "来源内容：输入经过规则处理后得到输出",
    sourceImageDataUrl: withImage ? "data:image/png;base64,iVBORw0KGgo=" : undefined,
    writingPolicySnapshotId: "writing-policy:test",
    language: "zh-CN",
    qualityMode: "balanced",
    idempotencyKey,
    teachingPlan: "先说明页面的核心问题，再按课件顺序解释关键对象及其关系。"
  };
}

function providerTeachingContent() {
  return {
    learningObjectives: ["能够解释输入、规则和输出之间的关系"],
    mainContentMarkdown: "先识别输入，再按照规则处理，最后核对输出是否满足目标",
    priorKnowledge: ["输入（Input）：输入是处理开始前已经掌握的信息。它指出规则要处理的对象，也限定后续步骤的起点。先分清输入与结果，才能判断规则是否正确作用于目标对象。"],
    fullExplanationMarkdown: "输入是处理开始前已经知道的信息，规则限定允许执行的步骤，输出是处理结束后的结果。每一步都要对照目标与约束检查，不能只看最后数字。".repeat(8),
    misconceptions: ["**错误理解：** 只看最后结果就能判断处理正确\n\n**错因：** 结果可能来自错误输入或跳过条件的步骤\n\n**正确判断：** 必须同时核对输入、规则和输出\n\n**核对方法：** 逐步检查每个条件是否满足，再确认结果符合目标"],
    coverageEvidence: [],
    questions: [
      { kind: "comprehension", prompt: "输入在处理过程中起什么作用？", options: [], expectedAnswer: "输入指出规则要处理的对象，并提供执行步骤的起点。", explanation: "先确定对象和起点，才能按规则检查后续步骤。" },
      { kind: "comprehension", prompt: "为什么不能只看最后的输出？", options: [], expectedAnswer: "因为还要核对输入和规则是否正确，输出是否满足目标。", explanation: "相同结果可能由不同过程得到，检查过程才能发现条件遗漏。" },
      { kind: "multiple_choice", prompt: "应用规则前，首先要确认什么？", options: ["输入和适用条件", "最终答案的排版", "后续章节的结论", "与任务无关的背景"], expectedAnswer: "输入和适用条件", explanation: "规则只有作用于正确对象并满足条件时，结果才有意义。" },
      { kind: "multiple_choice", prompt: "执行规则后，下一步应做什么？", options: ["将输出与目标核对", "删除输入记录", "跳过适用条件", "直接更换问题"], expectedAnswer: "将输出与目标核对", explanation: "核对输出可以确认规则执行结果是否符合任务目标。" }
    ]
  };
}
