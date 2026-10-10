import { afterEach, describe, expect, it, vi } from "vitest";
import { generationHarnessFileSha256 } from "./generation-harness.js";
import { loadWritingStandards } from "./writing-standards.js";
import { meterModelRouter } from "./model-usage-meter.js";
import { HttpProviderTeachingClient, ModelRouterGenerationError, parseWrappedProviderJson, probeProviderConnection, RoutedProviderTeachingClient, SettingsProviderTeachingClient, currentGenerationHarness, teachingPackageSchema, withCurrentDeepSeekModels } from "./model-router.js";

const explicitProviderBadRequest = [
  "[req_synthetic_envelope_0001] [deepseek-v4.1-flash]",
  "**Bad request from AI provider**",
  "- Your request was rejected by the AI provider (invalid parameters or unsupported content).",
  "How to fix:",
  "- Review your request format and simplify your prompt.",
  "",
  "**Billing:**",
  "- This request still counts as a request and is billed based on its input (minimum 1,000 prompt / 1,000 completion / 1,000 cached tokens).",
  "- Do not resend the same request — it will keep failing and keep consuming your quota.",
  "**Recommended tools:**",
  "- These responses are optimized for opencode, Claude Code, and Codex."
].join("\n");

const explicitProviderTemporaryUnavailable = [
  "[req_synthetic456] [deepseek-v4.1-flash]",
  "**AI provider temporarily unavailable**",
  "- The AI provider failed to process your request (temporary server issue or oversized prompt).",
  "- This was retried automatically.",
  "How to fix:",
  "- Wait a moment and retry with a shorter or simpler prompt.",
  "- Do not keep retrying the exact same request.",
  "**Billing:**",
  "- This request still counts as a request and is billed based on its input (minimum 1,000 prompt / 1,000 completion / 1,000 cached tokens).",
  "- Do not resend the same request — it will keep failing and keep consuming your quota.",
  "**Recommended tools:**",
  "- These responses are optimized for opencode, Claude Code, and Codex.",
  "- If you are using a non-standard client and keep hitting errors, switch to one of the supported tools above."
].join("\n");

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
    expect(snapshot).toMatchObject({ id: "course-os-teaching", version: "2.5.5", taskContract: "GENERATE + TEACHING" });
    expect(snapshot.files.some((file) => file.path === "apps/api/src/planned-teaching.ts")).toBe(true);
    expect(snapshot.files.some((file) => file.path === "apps/api/src/app.ts")).toBe(false);
    const schema = teachingPackageSchema as { properties: Record<string, unknown>; required: string[] };
    expect(new Set(schema.required)).toEqual(new Set(Object.keys(schema.properties)));
    expect(snapshot.files.map((file) => file.path)).toEqual(["page-plan-prompt.md", "planned-writing-prompt.md", "writing-format-contract.md", "writing-standard-source.md", "style-standard-source.md", "teaching-package.schema.json", "apps/api/src/generation-harness.ts", "apps/api/src/writing-standards.ts", "apps/api/src/model-router.ts", "apps/api/src/model-usage-meter.ts", "apps/api/src/pricing.ts", "apps/api/src/planned-teaching.ts", "apps/api/src/page-source.ts", "apps/api/src/source-layout.ts", "apps/api/src/upstream/openmaic-course-context.ts", "packages/quality/src/presentation.ts", "packages/quality/src/prior-knowledge.ts"]);
    expect(snapshot.aggregateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.files.find((file) => file.path === "writing-standard-source.md")?.sha256).toBe("ba0f450a1f8f30a5f9328376739081e4ff9f501904f376bc36c55aca743ddc6f");
    expect(snapshot.files.find((file) => file.path === "style-standard-source.md")?.sha256).toBe("97f49d1a670616b8546ed5eb1f1dfca4f45ec48d49d791a9c8c41662c3e03d76");
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
      expect(body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "low" });
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
      expect(body.reasoning?.effort).toBe("low");
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

  it("sends same-image visual cross-check guidance and retains full extracted source", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string | Array<{ type: string; image_url?: { detail?: string } }> }> };
      const instructions = body.messages[0]?.content;
      expect(typeof instructions).toBe("string");
      expect(instructions).toContain("不遗漏清楚可读的数据");
      expect(instructions).toContain("不猜填模糊单元格");
      expect(instructions).toContain("当同一对象同时出现在示意图、表格或图例中时，在同一张原图内交叉核对其可见位置、分组和标签归属。");
      expect(instructions).toContain("若这些观察冲突，重新核读原图；仍不能消解时只保留已确认的文字与数值并就近标注局部不确定，不依据未确认的分组关系宣称来源自相矛盾。");
      expect(instructions).toContain("交叉只影响实际无法跟踪的那一条或几条，其他端点明确可追踪的连接仍须逐条保留");
      expect(instructions).toContain("只有某一端点或连线本身不能唯一追踪时，才仅对该局部标注不确定");
      expect(instructions).toContain("区分元件实例标签、信号端点和网络标签，不把门内名称当输入信号；边按两个实际端点转写，只有图例明确说明粗细代表权值时才解释为权值；数字保留负号与小数；只给实际可辨认的局部信息，不凭未看清的线宣称连接不存在。");
      expect(instructions).toContain("门的轮廓、输入输出端点数量与位置、输出端反相圈及其连接关系");
      expect(instructions).toContain("例如 AND 形状加输出反相圈表示 NAND");
      expect(instructions).toContain("背景中的通用逻辑规则须明确标为背景说明");
      expect(instructions).not.toContain("只保留可见标签与整体结构，不分配具体边权");
      const textPart = (body.messages[1]?.content as Array<{ type: string; text?: string }>).find(part => part.type === "text");
      const sent = JSON.parse(textPart!.text!);
      expect(sent.extractedText).toBe("完整来源".repeat(5000));
      expect(sent.courseContext).toBe("课程背景");
      const imagePart = (body.messages[1]?.content as Array<{ type: string; image_url?: { detail?: string } }>).find(part => part.type === "image_url");
      expect(imagePart?.image_url?.detail).toBe("high");
      return Response.json({ choices: [{ message: { content: "页面内容：矩阵中已核实的代表值见相应行列。\n教学顺序：先说明矩阵含义。" } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "opencode-go", baseUrl: "https://opencode.test", apiKey: "synthetic-example-token",
      model: "deepseek-v4-flash-vision-exp", protocol: "chat_completions", supportsVision: true });
    const result = await client.understandPage({ ...providerInput("matrix-page-understanding", true), sourceText: "完整来源".repeat(5000), courseContext: "课程背景" });
    expect(result?.sourceDescription).toContain("矩阵中已核实");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("generates a bridge from the previous explanation and current summary", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string; instructions: string; max_output_tokens: number; text?: { format?: { name?: string } } };
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("bridge-page:bridge");
      expect(body.input).toContain("前页解释了输入");
      expect(body.input).toContain("本页讨论处理规则");
      expect(body.instructions).toContain("previousTeaching 只有明确包含已确认的真实前页讲解时");
      expect(body.instructions.endsWith("本次成文任务仅是承上启下：只用一个自然段、2–4句，从已确认的前页一点自然引出本页问题；若没有可确认的前页信息，就只依据本页摘要提出本页问题。复用已有术语，不重复定义、正文、代码或推导；输出仅限承接段。"))
        .toBe(true);
      expect(body.max_output_tokens).toBe(15_000);
      expect(body.text?.format?.name).toBeUndefined();
      return Response.json({ model: "deepseek-flash",
        output_text: "课程举例说明：AI provider temporarily unavailable 是系统提示语，本页继续讨论处理规则。",
        usage: { input_tokens: 100, output_tokens: 50, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://deepseek.test",
      apiKey: "synthetic-example-token", model: "deepseek-flash", protocol: "responses" });
    const result = await client.generateBridge({ ...providerInput("bridge-page"), previousPageContext: "前页解释了输入",
      currentSummary: "本页讨论处理规则" });
    expect(result).toMatchObject({ markdown: "课程举例说明：AI provider temporarily unavailable 是系统提示语，本页继续讨论处理规则", provider: "deepseek",
      usage: { apiEquivalentUsd: 0.001 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["bridge", "teaching"] as const)("rejects the HTTP-200 provider refusal before %s content is delivered and meters its usage", async kind => {
    const providerResponse = Response.json({ status: "completed", model: "deepseek-v4.1-flash", output_text: explicitProviderBadRequest,
      usage: { input_tokens: 140, output_tokens: 0, total_cost: 0.001 } });
    expect(providerResponse.status).toBe(200);
    const fetchMock = vi.fn(async () => providerResponse);
    vi.stubGlobal("fetch", fetchMock);
    const upstream = new HttpProviderTeachingClient({ providerId: "kuafu", baseUrl: "https://kuafu.test",
      apiKey: "synthetic-example-token", model: "deepseek-v4.1-flash", protocol: "responses" });
    const metered = meterModelRouter(upstream);
    const input = providerInput(`provider-refusal-${kind}`);
    const generation = kind === "bridge"
      ? metered.client.generateBridge!({ ...input, previousPageContext: "前页已确认讲解", currentSummary: "本页教学摘要" })
      : metered.client.generateTeachingPackage(input);

    await expect(generation).rejects.toMatchObject({ code: "MODEL_PROVIDER_OPAQUE_RELAY_REJECTION",
      provider: "kuafu", model: "deepseek-v4.1-flash", usage: { inputTokens: 140, outputTokens: 0, apiEquivalentUsd: 0.001 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(metered.groupedUsage()).toMatchObject([{ provider: "kuafu", model: "deepseek-v4.1-flash",
      usage: { inputTokens: 140, outputTokens: 0, apiEquivalentUsd: 0.001 } }]);
  });

  it("retries the explicit HTTP-200 temporary outage envelope and retains usage from both attempts", async () => {
    const fetchMock = vi.fn(async () => Response.json({ model: "deepseek-v4.1-flash", output_text: explicitProviderTemporaryUnavailable,
      usage: { input_tokens: 140, output_tokens: 0, total_cost: 0.001 } }));
    vi.stubGlobal("fetch", fetchMock);
    const upstream = new HttpProviderTeachingClient({ providerId: "kuafu", baseUrl: "https://kuafu.test",
      apiKey: "synthetic-example-token", model: "deepseek-v4.1-flash", protocol: "responses" });
    const metered = meterModelRouter(upstream);
    const input = providerInput("provider-temporary-unavailable");

    await expect(metered.client.generateBridge!({ ...input, previousPageContext: "前页已确认讲解", currentSummary: "本页教学摘要" }))
      .rejects.toMatchObject({ code: "MODEL_PROVIDER_FAILED:upstream_error", provider: "kuafu", model: "deepseek-v4.1-flash",
        usage: { inputTokens: 280, outputTokens: 0, apiEquivalentUsd: 0.002 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(metered.groupedUsage()).toMatchObject([{ provider: "kuafu", model: "deepseek-v4.1-flash",
      usage: { inputTokens: 280, outputTokens: 0, apiEquivalentUsd: 0.002 } }]);
  });

  it("starts from the current page question when previousTeaching marks a module start", async () => {
    const firstPageContext = "这是模块“ee680-introduction”的起始页；从课程主题和本页问题自然建立阅读起点";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string; instructions: string };
      const prompt = JSON.parse(body.input) as { previousTeaching?: string; currentSummary?: string };
      expect(prompt.previousTeaching).toBe(firstPageContext);
      expect(prompt.currentSummary).toBe("本页讨论处理规则如何改变输出");
      expect(body.instructions).toContain("previousTeaching 只有明确包含已确认的真实前页讲解时");
      expect(body.instructions).toContain("本页是模块起始页");
      expect(body.instructions).toContain("前页内容不可用");
      expect(body.instructions).toContain("只依据 currentSummary 中的本页内容提出本页正在解决的问题");
      expect(body.instructions).toContain("不写“上一页讲过”等前页事实");
      return Response.json({ model: "deepseek-flash", output_text: "本页关注处理规则怎样改变输出。",
        usage: { input_tokens: 100, output_tokens: 40, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://deepseek.test",
      apiKey: "synthetic-example-token", model: "deepseek-flash", protocol: "responses" });
    const result = await client.generateBridge({ ...providerInput("bridge-first-page"), pageNumber: 1,
      previousPageContext: firstPageContext, currentSummary: "本页讨论处理规则如何改变输出" });

    expect(result.markdown).toBe("本页关注处理规则怎样改变输出");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the native Kuafu Responses route without a ReadWeave hop", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.kuafushe.test/v1/responses");
      const body = JSON.parse(String(init?.body)) as { model?: string; stream?: boolean; reasoning?: { effort?: string }; text?: { format?: { type?: string } } };
      expect(body).toMatchObject({ model: "deepseek-v4.1-flash", stream: true, reasoning: { effort: "low" } });
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
      expect(body.reasoning?.effort).toBe("low");
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

  it("reports a disconnected Responses stream as a provider error with unknown usage reserved", async () => {
    const encoder = new TextEncoder();
    const disconnected = () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoder.encode("event: response.created\ndata: {\"type\":\"response.created\"}\n\n"));
      controller.error(new Error("upstream stream disconnected"));
    } }), { headers: { "Content-Type": "text/event-stream" } });
    const fetchMock = vi.fn(async () => disconnected());
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "kuafu", baseUrl: "https://relay.test",
      apiKey: "synthetic-example-token", model: "deepseek-v4.1-flash", protocol: "responses" });

    const failure = await runPlannedStageForTest(client).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "MODEL_PROVIDER_STREAM_INTERRUPTED",
      usage: { inputTokens: 0, outputTokens: 0, apiEquivalentUsd: null } });
    expect((failure as ModelRouterGenerationError).usage.unreportedCostReserveUsd).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a completed SSE response with an output_text item but no text and keeps unknown cost reserved", async () => {
    const encoder = new TextEncoder();
    const emptyCompleted = { type: "response.completed", sequence_number: 1, response: {
      status: "completed", model: "deepseek-v4.1-flash",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text" }], status: "completed" }]
    } };
    const validCompleted = { type: "response.completed", sequence_number: 1, response: {
      status: "completed", model: "deepseek-v4.1-flash",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "本页继续核对前述条件。" }], status: "completed" }],
      usage: { input_tokens: 125, output_tokens: 34, total_cost: 0.002 }
    } };
    const asSse = (event: unknown) => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { status: "in_progress" } })}\n\n`));
      controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`));
      controller.close();
    } }), { headers: { "Content-Type": "text/event-stream" } });
    const fetchMock = vi.fn().mockResolvedValueOnce(asSse(emptyCompleted)).mockResolvedValueOnce(asSse(validCompleted));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "kuafu", baseUrl: "https://relay.test",
      apiKey: "synthetic-example-token", model: "deepseek-v4.1-flash", protocol: "responses" });

    const result = await client.generateBridge!({ ...providerInput("empty-bridge-output"),
      previousPageContext: "前页已确认讲解", currentSummary: "本页教学摘要" });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ max_output_tokens: 15_000, stream: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.markdown).toBe("本页继续核对前述条件");
    expect(result.usage).toMatchObject({ inputTokens: 125, outputTokens: 34, apiEquivalentUsd: 0.002 });
    expect(result.usage.unreportedCostReserveUsd).toBeGreaterThan(0);
  });

  it("does not retry nonempty malformed JSON as a missing-output provider failure", async () => {
    const fetchMock = vi.fn(async () => Response.json({ model: "deepseek-v4.1-flash", output_text: "{malformed json",
      usage: { input_tokens: 100, output_tokens: 20, total_cost: 0.001 } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "kuafu", baseUrl: "https://relay.test",
      apiKey: "synthetic-example-token", model: "deepseek-v4.1-flash", protocol: "responses" });

    const result = await runPlannedStageForTest(client, "teaching", { type: "object", properties: { answer: { type: "string" } } });

    expect(result.content).toBe("{malformed json");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("keeps a 524 provider error and an unknown zero-cost receipt explicit", async () => {
    const upstreamFailure = () => Response.json({ error: { code: "content_missing" }, usage: { total_cost: 0 } }, { status: 524 });
    const fetchMock = vi.fn(async () => upstreamFailure());
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "kuafu", baseUrl: "https://relay.test",
      apiKey: "synthetic-example-token", model: "deepseek-v4.1-flash", protocol: "responses", billingMode: "metered" });
    const failure = await client.generateTeachingPackage(providerInput("upstream-524-zero-usage"))
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ provider: "kuafu", code: "MODEL_PROVIDER_FAILED:524",
      usage: { inputTokens: 0, outputTokens: 0, apiEquivalentUsd: null } });
    expect((failure as ModelRouterGenerationError).usage.unreportedCostReserveUsd).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it.each([
    { accounting: "reported primary usage", primaryUsage: { input_tokens: 140, output_tokens: 0, total_cost: 0.08 }, expectedCost: 0.081, expectReserve: false },
    { accounting: "unreported primary usage", primaryUsage: undefined, expectedCost: 0.001, expectReserve: true }
  ])("uses the explicit second route once and aggregates $accounting within the remaining page budget", async scenario => {
    const requests: Array<{ url: string; maxOutputTokens?: number }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { max_output_tokens?: number };
      requests.push({ url: String(url), maxOutputTokens: request.max_output_tokens });
      if (String(url).includes("primary.test")) {
        return Response.json({ status: "completed", model: "deepseek-v4.1-flash", output_text: explicitProviderBadRequest,
          ...(scenario.primaryUsage ? { usage: scenario.primaryUsage } : {}) });
      }
      return Response.json({ status: "completed", model: "deepseek-v4.1-flash-expires-on-0910",
        output_text: JSON.stringify(providerTeachingContent()),
        usage: { input_tokens: 100, output_tokens: 200, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const metered = meterModelRouter(configuredKuafuFallbackClient());
    const result = await metered.client.generateTeachingPackage({ ...providerInput(`opaque-relay-fallback-${scenario.expectReserve}`), maxCostUsd: 0.13 });

    expect(result).toMatchObject({ provider: "kuafu-backup", model: "deepseek-v4.1-flash-expires-on-0910",
      usage: { inputTokens: scenario.primaryUsage ? 240 : 100, outputTokens: 200, apiEquivalentUsd: scenario.expectedCost } });
    if (scenario.expectReserve) expect(result.usage.unreportedCostReserveUsd).toBeGreaterThan(0);
    else expect(result.usage.unreportedCostReserveUsd).toBeUndefined();
    expect(requests.filter(request => request.url.includes("primary.test"))).toHaveLength(1);
    expect(requests.filter(request => request.url.includes("backup.test"))).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    if (!scenario.expectReserve) {
      expect(requests[1]!.maxOutputTokens).toBeLessThan(requests[0]!.maxOutputTokens!);
    }
    expect(metered.groupedUsage()).toEqual([{ provider: "kuafu-backup", model: "deepseek-v4.1-flash-expires-on-0910", usage: result.usage }]);
  });

  it("does not fall back for a structured HTTP 400 invalid_request_error", async () => {
    const fetchMock = vi.fn(async (url: string) => String(url).includes("primary.test")
      ? Response.json({ error: { code: "invalid_request_error", message: "invalid input" } }, { status: 400 })
      : Response.json({ status: "completed", output_text: JSON.stringify(providerTeachingContent()) }));
    vi.stubGlobal("fetch", fetchMock);
    const client = configuredKuafuFallbackClient();

    await expect(client.generateTeachingPackage(providerInput("structured-invalid-request-no-fallback"))).rejects.toMatchObject({
      provider: "kuafu", code: "MODEL_PROVIDER_FAILED:invalid_request_error"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("primary.test");
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

    const quotaVariantFetch = vi.fn(async () => Response.json({ error: { code: "quota_exceeded" }, usage: { total_cost: 0 } }, { status: 429 }));
    vi.stubGlobal("fetch", quotaVariantFetch);
    const quotaVariantFailure = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://deepseek.test",
      apiKey: "synthetic-example-token", model: "deepseek-flash", protocol: "responses" })
      .generateTeachingPackage(providerInput("quota-exceeded-no-retry")).catch((error: unknown) => error);
    expect(quotaVariantFailure).toMatchObject({ code: "MODEL_PROVIDER_INSUFFICIENT_BALANCE",
      usage: { apiEquivalentUsd: null } });
    expect(quotaVariantFetch).toHaveBeenCalledTimes(1);

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
      expect(body.thinking?.type).toBe("enabled");
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

describe("enabled low thinking across stages and retries", () => {
  it.each(["responses", "messages", "chat_completions"] as const)("keeps low effort and complete rules in %s", async (protocol) => {
    const bundle = loadWritingStandards();
    const bodies: Array<Record<string, unknown>> = [];
    const keys: Array<string | null> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      keys.push(new Headers(init?.headers).get("Idempotency-Key"));
      const instructions = protocol === "responses" ? String(body.instructions)
        : protocol === "messages" ? String(body.system)
          : String((body.messages as Array<{ content: string }>)[0]!.content);
      expect(instructions).toContain(bundle.writing);
      expect(instructions).toContain(bundle.style);
      expect(body.temperature).toBeUndefined();
      expect(body.max_output_tokens ?? body.max_tokens).toBe(15_000);
      if (protocol === "responses") expect(body.reasoning).toEqual({ effort: "low" });
      else {
        expect(body.thinking).toEqual({ type: "enabled" });
        if (protocol === "messages") expect(body.output_config).toEqual({ effort: "low" });
        else expect(body.reasoning_effort).toBe("low");
      }
      return bodies.length % 2 === 1 ? Response.json({ error: { code: "upstream_error" } }, { status: 503 })
        : Response.json({ output_text: "ok", usage: { input_tokens: 100, output_tokens: 100, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "kuafu-backup", model: "deepseek-v4.1-flash-expires-on-0910",
      baseUrl: "https://synthetic.test", apiKey: "synthetic-example-key", protocol });
    for (const phase of ["page_understanding", "planning", "teaching", "format_repair", "bridge"]) {
      await runPlannedStageForTest(client, phase);
      expect(bodies.at(-1)).toEqual(bodies.at(-2));
      expect(keys.at(-1)).toBe(keys.at(-2));
    }
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });
});

function runPlannedStageForTest(client: HttpProviderTeachingClient, phase = "teaching", schema?: Record<string, unknown>) {
  const internalClient = client as unknown as {
    requestPlannedStage(
      input: ReturnType<typeof providerInput>,
      request: { phase: string; instructions: string; prompt: string; maxOutputTokens: number; schema?: Record<string, unknown> },
      budget: number
    ): Promise<{ content: unknown; providerDiagnostic?: Record<string, unknown> }>;
  };
  return internalClient.requestPlannedStage(providerInput(`diagnostic-${phase}`), {
    phase, instructions: "test", prompt: "test", maxOutputTokens: 1_000, ...(schema ? { schema } : {})
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
    // Protocol/fallback tests fund the complete standards prompt; low-budget tests override this.
    maxCostUsd: 0.2,
    teachingPlan: "先说明页面的核心问题，再按课件顺序解释关键对象及其关系。"
  };
}

function configuredKuafuFallbackClient() {
  return new SettingsProviderTeachingClient({ load: async () => ({
    providers: [
      { id: "kuafu", displayName: "Kuafu", baseUrl: "https://primary.test", enabled: true,
        credential: { configured: true }, models: [{ id: "deepseek-v4.1-flash", displayName: "Flash", protocol: "responses" as const,
          supportsVision: false, supportsJsonSchema: true, supportsReasoning: false, billingMode: "metered" as const }] },
      { id: "kuafu-backup", displayName: "Kuafu backup", baseUrl: "https://backup.test", enabled: true,
        credential: { configured: true }, models: [{ id: "deepseek-v4.1-flash-expires-on-0910", displayName: "Flash backup", protocol: "responses" as const,
          supportsVision: false, supportsJsonSchema: true, supportsReasoning: false, billingMode: "metered" as const }] }
    ],
    policy: { workspaceId: "personal", allowProviderFallback: true, allowAialraEmergencyFallback: false,
      updatedAt: new Date(0).toISOString(), routes: [
        { providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true },
        { providerId: "kuafu-backup", modelId: "deepseek-v4.1-flash-expires-on-0910", enabled: true }
      ], rules: [{ stage: "teach", providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true }] },
    credential: async () => "synthetic-secret"
  }) });
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
