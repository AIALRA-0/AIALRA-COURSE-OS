import { afterEach, describe, expect, it, vi } from "vitest";
import { generationHarnessFileSha256 } from "./generation-harness.js";
import { buildTeachingBlueprint } from "./teaching-blueprint.js";
import { HttpModelRouterClient, HttpProviderTeachingClient, ModelRouterGenerationError, modelInput, parseWrappedProviderJson, probeProviderConnection, RoutedProviderTeachingClient, SettingsProviderTeachingClient, currentGenerationHarness, resolvedSourceConflictVerdict, supportedSourceCheckFormulaConsistent, teachingOutputTokenLimit, teachingPackageSchema, teachingRepairTargets, withCurrentDeepSeekModels, type ModelRouterInput, type TeachingPackage } from "./model-router.js";

describe("generation harness", () => {
  it("extracts the largest complete JSON object from provider wrapper text", () => {
    expect(parseWrappedProviderJson('说明文字 {"status":"meta"} 正式结果 {"facts":[{"id":"f1"}],"steps":[{"id":"s1"}]} 结束'))
      .toEqual({ facts: [{ id: "f1" }], steps: [{ id: "s1" }] });
  });
  it("repairs literal control characters inside streamed JSON strings", () => {
    expect(parseWrappedProviderJson('{"chapterBridgeMarkdown":"第一行\n第二行\t缩进"}'))
      .toEqual({ chapterBridgeMarkdown: "第一行\n第二行\t缩进" });
  });
  it("loads editable prompt and schema files as one hashed snapshot", () => {
    const snapshot = currentGenerationHarness();
    expect(snapshot).toMatchObject({ id: "course-os-teaching", version: "2.4.67", taskContract: "GENERATE + TEACHING" });
    expect(snapshot.files.some((file) => file.path === "apps/api/src/planned-teaching.ts")).toBe(true);
    expect(snapshot.files.some((file) => file.path === "apps/api/src/app.ts")).toBe(false);
    const schema = teachingPackageSchema as { properties: Record<string, unknown>; required: string[] };
    expect(new Set(schema.required)).toEqual(new Set(Object.keys(schema.properties)));
    expect(snapshot.files.map((file) => file.path)).toEqual(["teaching-system-prompt.md", "teaching-user-prompt.md", "teaching-blueprint.md", "teaching-package.schema.json", "source-audit-prompt.md", "teaching-audit-prompt.md", "semantic-audit-prompt.md", "semantic-audit.schema.json", "policy-skill.md", "policy-format-rules.md", "policy-explanation-framework.md", "policy-formula-explanation.md", "page-plan-prompt.md", "planned-writing-prompt.md", "writing-format-contract.md", "apps/api/src/generation-harness.ts", "apps/api/src/teaching-blueprint.ts", "apps/api/src/model-router.ts", "apps/api/src/teaching-patches.ts", "apps/api/src/model-usage-meter.ts", "apps/api/src/pricing.ts", "apps/api/src/teaching-plan.ts", "apps/api/src/planned-teaching.ts", "apps/api/src/generation-repair.ts", "packages/quality/src/index.ts", "packages/quality/src/presentation.ts"]);
    expect(snapshot.aggregateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.files.find((file) => file.path === "policy-skill.md")?.sha256).toBe("c0a8122648c926e06d6a43d27e9097f48e818fce17e19ab8429151ffc4d6d457");
    expect(snapshot.files.find((file) => file.path === "policy-format-rules.md")?.sha256).toBe("d834bf4624dbf0fb850a63ae35061864122afe090ce16e51a9845506af35a563");
    expect(snapshot.files.find((file) => file.path === "policy-explanation-framework.md")?.sha256).toBe("8034dfb53735e479f97d82dfc74a846d6170aa3415e80f809d17bd3502c06463");
    expect(snapshot.files.find((file) => file.path === "policy-formula-explanation.md")?.sha256).toBe("65e589994e5f5da5514d57ad5aca6d63b49adf6975e6af988598115008802c8e");
  });

  it("hashes the same Harness source identically across Windows and Linux line endings", () => {
    expect(generationHarnessFileSha256("第一行\r\n第二行\r\n")).toBe(generationHarnessFileSha256("第一行\n第二行\n"));
  });

  it("bounds model output so one slide cannot consume an unbounded response", () => {
    expect(teachingOutputTokenLimit("economy")).toBe(4_000);
    expect(teachingOutputTokenLimit("balanced")).toBe(6_000);
    expect(teachingOutputTokenLimit("quality")).toBe(8_000);
  });

  it("labels a previous model draft and gives repair an exact learner-visible limit", () => {
    const previousTeachingPackage = providerTeachingContent() as TeachingPackage;
    const input = modelInput({
      ...providerInput("repair-prompt-test"),
      repair: { issues: ["TEACHING_EXPLANATION_TOO_LONG"], maximumExplanationCharacters: 3_500, previousTeachingPackage }
    });
    const text = typeof input === "string" ? input : input[0]!.content.find((part) => part.type === "input_text")!.text;
    expect(text).toContain("上一轮模型草稿，不是 SOURCE");
    expect(text).toContain("TEACHING_EXPLANATION_TOO_LONG");
    expect(text).toContain("最多 3500 个字符");
    expect(text).toContain(JSON.stringify(previousTeachingPackage));
    expect(text).not.toContain('"resourcePackage":{"version"');
  });

  it("gives field-specific repair instructions for failures seen across diagrams and algorithms", () => {
    const input = modelInput({
      ...providerInput("writing-repair-test"),
      repair: {
        issues: ["TEACHING_UNPAIRED_ENGLISH", "TEACHING_PRIOR_DEFINITION_INCOMPLETE", "TEACHING_BRIDGE_NEEDS_BLOCKS"],
        maximumExplanationCharacters: 3_500,
        previousTeachingPackage: providerTeachingContent() as TeachingPackage
      }
    });
    const text = typeof input === "string" ? input : input[0]!.content.find((part) => part.type === "input_text")!.text;
    expect(text).toContain("四道题的题干与答案解释");
    expect(text).toContain("priorKnowledge");
    expect(text).toContain("每句至少十二字");
    expect(text).toContain("学术概念可核对可靠学术来源");
    expect(text).toContain("正式名称内部含缩写时就近展开");
    expect(text).not.toContain("中文全称（官方英文全称）");
    expect(text).toContain("空行分成两个自然段");
  });
});

describe("AIALRA Model Router teaching client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses a strict schema that requires options for every question", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        input: Array<{ content: Array<{ type: string }> }>;
        instructions: string;
        metadata: { writing_policy_snapshot_id: string };
        text: { format: { schema: { required: string[]; properties: { questions: { items: { required: string[] } } } } } };
      };
      expect(request.text.format.schema.properties.questions.items.required).toContain("options");
      expect(request.text.format.schema.required).toContain("coverageEvidence");
      expect(request.input[0]?.content.map((item) => item.type)).toEqual(["input_text", "input_image"]);
      expect(request.instructions).toContain("人类可读技术写作");
      expect(request.metadata.writing_policy_snapshot_id).toBe("writing-policy:test");
      return Response.json({
        status: "succeeded",
        model: "gpt-5.6-terra",
        output: {
          learningObjectives: ["能够解释输入、规则和输出之间的关系"],
          mainContentMarkdown: "输入经过规则处理后得到输出，学习时需要逐项核对条件和结果",
          priorKnowledge: ["先知道输入和输出分别代表什么"],
          fullExplanationMarkdown: "输入是处理开始前已经知道的信息，规则说明允许执行哪些步骤，输出是执行完成后的结果。".repeat(8),
          misconceptions: ["不要跳过输入条件直接套用最后结论"],
          coverageEvidence: [],
          questions: [
            { kind: "comprehension", prompt: "输入有什么作用", options: [], expectedAnswer: "输入提供起始信息", explanation: "没有输入就无法确定规则处理的对象" },
            { kind: "comprehension", prompt: "为什么要检查输出", options: [], expectedAnswer: "确认规则执行正确", explanation: "输出需要回到目标和约束中核对" },
            { kind: "multiple_choice", prompt: "第一步是什么", options: ["识别输入", "忽略条件", "直接结论", "删除规则"], expectedAnswer: "识别输入", explanation: "输入决定后续处理对象" },
            { kind: "multiple_choice", prompt: "最后一步是什么", options: ["核对输出", "删除结果", "忽略目标", "改变题意"], expectedAnswer: "核对输出", explanation: "输出需要对照目标检查" }
          ]
        },
        usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 30, apiEquivalentUsd: 0.001, durationMs: 100 }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpModelRouterClient("http://router", "secret");
    const result = await client.generateTeachingPackage({ pageTitle: "测试页", pageNumber: 1, sourceText: "来源", sourceImageDataUrl: "data:image/png;base64,iVBORw0KGgo=", writingPolicySnapshotId: "writing-policy:test", language: "zh-CN", qualityMode: "balanced", idempotencyKey: "model-test" });
    expect(result.content.questions).toHaveLength(4);
    expect(result.usage.apiEquivalentUsd).toBe(0.001);
  });

  it("keeps provider usage when a billed request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      status: "failed",
      model: "gpt-5.6-sol",
      error: { code: "DEADLINE_EXCEEDED", message: "late response" },
      usage: { inputTokens: 120, cachedInputTokens: 40, outputTokens: 80, apiEquivalentUsd: 0.0123, durationMs: 180000 }
    }, { status: 504 })));
    const client = new HttpModelRouterClient("http://router", "secret");
    const failure = await client.generateTeachingPackage({ pageTitle: "失败页", pageNumber: 7, sourceText: "来源", writingPolicySnapshotId: "writing-policy:test", language: "zh-CN", qualityMode: "quality", idempotencyKey: "failed-model-test" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelRouterGenerationError);
    expect(failure).toMatchObject({ code: "MODEL_ROUTER_FAILED:DEADLINE_EXCEEDED", model: "gpt-5.6-sol", usage: { apiEquivalentUsd: 0.0123, outputTokens: 80 } });
  });

  it("polls an asynchronous router job instead of treating HTTP 202 as failure", async () => {
    const content = {
      learningObjectives: ["能够解释输入、规则和输出之间的关系"],
      mainContentMarkdown: "输入经过规则处理后得到输出，学习时要核对条件和结果",
      priorKnowledge: ["先知道输入和输出分别代表什么"],
      fullExplanationMarkdown: "输入是处理开始前已经知道的信息，规则说明允许执行哪些步骤，输出是执行完成后的结果。".repeat(8),
      misconceptions: ["不要跳过输入条件直接套用最后结论"],
      coverageEvidence: [],
      questions: [
        { kind: "comprehension", prompt: "输入有什么作用", options: [], expectedAnswer: "输入提供起始信息", explanation: "没有输入就无法确定规则处理的对象" },
        { kind: "comprehension", prompt: "为什么要检查输出", options: [], expectedAnswer: "确认规则执行正确", explanation: "输出需要回到目标和约束中核对" },
        { kind: "multiple_choice", prompt: "第一步是什么", options: ["识别输入", "忽略条件", "直接结论", "删除规则"], expectedAnswer: "识别输入", explanation: "输入决定后续处理对象" },
        { kind: "multiple_choice", prompt: "最后一步是什么", options: ["核对输出", "删除结果", "忽略目标", "改变题意"], expectedAnswer: "核对输出", explanation: "输出需要对照目标检查" }
      ]
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "router-job-1", status: "running", model: "gpt-5.6-sol", usage: {} }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ id: "router-job-1", status: "succeeded", route: { model: "gpt-5.6-sol" }, output: content, usage: { inputTokens: 20, outputTokens: 40, apiEquivalentUsd: 0.002 } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpModelRouterClient("http://router", "secret", 0);
    const result = await client.generateTeachingPackage({ pageTitle: "异步页", pageNumber: 2, sourceText: "来源", writingPolicySnapshotId: "writing-policy:test", language: "zh-CN", qualityMode: "quality", idempotencyKey: "async-model-test" });
    expect(result).toMatchObject({ model: "gpt-5.6-sol", usage: { apiEquivalentUsd: 0.002 }, content: { learningObjectives: content.learningObjectives } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("http://router/api/v1/jobs/router-job-1");
  });
});

describe("OpenCode Go and DeepSeek provider clients", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the Anthropic messages protocol for OpenCode Go Qwen", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://opencode.test/messages");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("qwen3.8-flash");
      expect(body.system).toContain("只返回符合给定 JSON Schema 的对象");
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
      expect(headers.get("x-opencode-request")).toBe("chat-test");
      expect(headers.get("x-opencode-client")).toBe("course-os");
      expect(headers.get("User-Agent")).toBe("course-os/2.4.0");
      const body = JSON.parse(String(init?.body)) as { response_format?: unknown; max_tokens: number; messages: Array<{ role: string; content: string }> };
      expect(body.response_format).toBeUndefined();
      expect(body.max_tokens).toBe(6_000);
      expect(body).toMatchObject({ thinking: { type: "disabled" } });
      expect(body.messages[0]?.content).toContain("只输出一个合法 JSON 对象");
      expect(body.messages[0]?.content).toContain("输出结构：");
      return Response.json({ model: "deepseek-v4-pro", choices: [{ message: { content: JSON.stringify(providerTeachingContent()) } }], usage: { prompt_tokens: 90, completion_tokens: 210, cached_tokens: 10 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new HttpProviderTeachingClient({ providerId: "opencode-go", baseUrl: "https://opencode.test", apiKey: "synthetic-example-opencode-token", model: "deepseek-v4-pro", protocol: "chat_completions", supportsVision: false, billingMode: "subscription_quota" }).generateTeachingPackage(providerInput("chat-test"));
    expect(result.usage).toMatchObject({ inputTokens: 90, cachedInputTokens: 10, outputTokens: 210 });
  });

  it("runs semantic audit through OpenCode Go chat completions", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://opencode.test/chat/completions");
      expect(new Headers(init?.headers).get("x-opencode-session")).toBe("opencode-audit");
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }>; max_tokens: number; response_format?: unknown };
      expect(body.response_format).toBeUndefined();
      expect(body.max_tokens).toBe(8_000);
      expect(body.messages[0]?.content).toContain("只返回一个合法 JSON 对象");
      expect(body.messages[0]?.content).toContain("按 JSON Schema 严格校验");
      expect(Array.isArray(body.messages[1]?.content)).toBe(true);
      const auditText = (body.messages[1]!.content as Array<{ text?: string }>)[0]!.text!;
      expect(auditText).toContain('"previousPageContext":"前页说明输入来自传感器"');
      expect(auditText).toContain('"writingRules":');
      expect(auditText).toContain('"compositionContract":');
      expect(auditText).toContain("不能因为前页事实未印在当前图片上");
      return Response.json({ model: "deepseek-v4-flash-vision-exp", choices: [{ message: { content: JSON.stringify({
        sourceChecks: [{ claim: "输入先于输出", evidence: "原图箭头从输入指向输出", verdict: "supported" }], findings: []
      }) } }], usage: { prompt_tokens: 120, completion_tokens: 80, cached_tokens: 20 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "opencode-go", baseUrl: "https://opencode.test", apiKey: "synthetic-example-opencode-token", model: "deepseek-v4-flash-vision-exp", protocol: "chat_completions", supportsVision: true, billingMode: "subscription_quota" });
    const result = await client.auditTeachingPackage({ ...providerInput("opencode-audit", true), previousPageContext: "前页说明输入来自传感器", teachingPackage: providerTeachingContent() as TeachingPackage, maxCostUsd: 0.01 });
    expect(result).toMatchObject({ provider: "opencode-go", model: "deepseek-v4-flash-vision-exp", sourceChecks: [{ verdict: "supported" }] });
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
      expect(body.reasoning?.effort).toBe("medium");
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

  it("requests a small source-backed semantic findings report instead of a rewritten lesson", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: Array<{ content: Array<{ type: string }> }>; text: { format: { name: string } }; max_output_tokens: number; metadata: { stage: string } };
      expect(body.text.format.name).toBe("course_os_semantic_audit");
      expect(body.max_output_tokens).toBe(4_500);
      expect(body.metadata.stage).toBe("semantic_audit");
      expect(body.input[0]?.content.map((item) => item.type)).toEqual(["input_text", "input_image"]);
      return Response.json({ model: "deepseek-v4-flash-vision-exp", output_text: JSON.stringify({ sourceChecks: [{ claim: "原始比值是 1.2", evidence: "来源页写 0.30 / 0.20", verdict: "contradicted" }], findings: [{ field: "misconceptions:0", original: "原始比值是 1.2", replacement: "原始比值是 1.5", evidence: "0.30 / 0.20 = 1.5" }] }), usage: { input_tokens: 120, output_tokens: 80, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-v4-flash-vision-exp", protocol: "responses", supportsVision: true, billingMode: "metered" });
    const result = await client.auditTeachingPackage({ ...providerInput("semantic-audit-test", true), teachingPackage: { ...providerTeachingContent(), misconceptions: ["原始比值是 1.2"] } as TeachingPackage, maxCostUsd: 0.01 });
    expect(result.findings).toHaveLength(1);
    expect(result.sourceChecks).toHaveLength(1);
    expect(result.usage.apiEquivalentUsd).toBe(0.001);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns unresolved source checks for the page-level repair loop", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("audit-unresolved");
      const sourceChecks = [{ claim: "原始比值是 1.2", evidence: "来源页写 0.30 / 0.20", verdict: "contradicted" }];
      const findings: unknown[] = [];
      return Response.json({ model: "deepseek-flash", output_text: JSON.stringify({ sourceChecks, findings }), usage: { input_tokens: 120, output_tokens: 80, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-flash", protocol: "responses", supportsVision: true, billingMode: "metered" });
    const result = await client.auditTeachingPackage({ ...providerInput("audit-unresolved", true), teachingPackage: providerTeachingContent() as TeachingPackage, maxCostUsd: 0.01 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ findings: [], sourceChecks: [{ verdict: "contradicted" }],
      usage: { inputTokens: 120, outputTokens: 80, apiEquivalentUsd: 0.001 } });
  });

  it("retries one malformed audit within the page budget without hiding its cost", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const retry = fetchMock.mock.calls.length === 2;
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(retry ? "audit-invalid:invalid-retry" : "audit-invalid");
      return Response.json({ model: "deepseek-flash", output_text: JSON.stringify({ findings: [],
        sourceChecks: retry ? [{ claim: "输入先于输出", evidence: "原图箭头从输入指向输出", verdict: "supported" }]
          : [{ claim: "", evidence: "", verdict: "supported" }] }),
      usage: { input_tokens: 100, output_tokens: 70, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-flash", protocol: "responses", supportsVision: true, billingMode: "metered" });
    const result = await client.auditTeachingPackage({ ...providerInput("audit-invalid", true), teachingPackage: providerTeachingContent() as TeachingPackage, maxCostUsd: 0.01 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.usage.apiEquivalentUsd).toBe(0.002);
  });

  it("repairs only requested fields through OpenCode chat without regenerating the page", async () => {
    const before = providerTeachingContent() as TeachingPackage;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://opencode.test/chat/completions");
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0].content).toContain('"required":["priorKnowledge"]');
      return Response.json({ choices: [{ message: { content: JSON.stringify({ priorKnowledge: ["输入是计算的起点"] }) } }], usage: { prompt_tokens: 50, completion_tokens: 20 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "opencode-go", baseUrl: "https://opencode.test", apiKey: "synthetic-example-token", model: "deepseek-v4-flash", protocol: "chat_completions", supportsVision: false, billingMode: "subscription_quota" });
    const result = await client.repairTeachingFields({ ...providerInput("chat-fields"), repair: { issues: ["TEACHING_PRIOR_DEFINITION_INCOMPLETE"], maximumExplanationCharacters: 3500, previousTeachingPackage: before } }, ["priorKnowledge"]);
    expect(result.content).toEqual({ ...before, priorKnowledge: ["输入是计算的起点"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("locates repeated headings and untranslated question options without treating math as English prose", () => {
    const content = { ...providerTeachingContent(), fullExplanationMarkdown: "## 概率计算\n\n### 符号说明\n\n$e^x$\n\n## 参数更新\n\n### 符号说明\n\n$w_i$",
      misconceptions: ["错误理解：batch 就是一次任务\n\n正确判断：这里说的是一组输入"],
      questions: [{ kind: "multiple_choice", prompt: "比较 $x_i$", options: ["batch", "一组输入", "两组输入", "三组输入"], expectedAnswer: "一组输入", explanation: "选项应区分输入组数" }] } as TeachingPackage;
    const targets = teachingRepairTargets(content, ["fullExplanationMarkdown", "misconceptions", "questions"], ["TEACHING_HEADING_DUPLICATE", "TEACHING_UNPAIRED_ENGLISH"]);
    expect(targets.filter(target => target.quote === "### 符号说明")).toHaveLength(2);
    expect(targets.some(target => target.field === "misconceptions:0" && target.quote.includes("batch"))).toBe(true);
    expect(targets.some(target => target.field === "questions:0:options:0" && target.quote === "batch")).toBe(true);
    expect(targets.some(target => target.quote === "$e^x$" || target.quote === "$w_i$" || target.field === "questions:0:prompt")).toBe(false);
    expect(teachingRepairTargets(content, ["coverageEvidence"], ["TEACHING_UNPAIRED_ENGLISH"])).toEqual([]);
  });

  it("gives source-commentary repair every actual learner-facing line", () => {
    const content = { ...providerTeachingContent(), fullExplanationMarkdown: [
      "页面给出两个对象",
      "本页列出三步处理",
      "原图显示输入连接输出",
      "课件给出计算公式",
      "表中写着方法名称",
      "原表列出年代"
    ].join("\n\n") } as TeachingPackage;
    const targets = teachingRepairTargets(content, ["fullExplanationMarkdown"], ["TEACHING_SOURCE_COMMENTARY_OVERUSE"]);
    expect(targets).toHaveLength(6);
    expect(targets.every((target) => target.field === "fullExplanationMarkdown" && target.instruction.includes("直接讲"))).toBe(true);
  });

  it("locates the exact question whose weighted trend lacks its conditions", () => {
    const content = { ...providerTeachingContent(), questions: [{
      kind: "multiple_choice",
      prompt: "给定 $R=-x-\\lambda y$，怎样解释结果变化",
      options: ["指标越小越好", "指标越大越好", "无法判断", "结果不变"],
      expectedAnswer: "指标越小越好",
      explanation: "两个指标越小，回报就越大"
    }] } as TeachingPackage;
    const targets = teachingRepairTargets(content, ["questions"], ["TEACHING_WEIGHTED_TREND_CONDITION_MISSING:questions"]);
    expect(targets).toEqual([expect.objectContaining({ field: "questions:0", quote: "两个指标越小，回报就越大" })]);
  });

  it("locates the exact incomplete definition and weighted trend sentence", () => {
    const content = { ...providerTeachingContent(),
      priorKnowledge: [
        "学习率（Learning Rate）：控制参数更新幅度的正数；更新时乘以梯度；本页取 0.1；它与回报不同，回报来自环境",
        "回报（Reward）：环境在智能体执行动作后给出的数值反馈；它用于评价这一步产生的结果是否有利；算法读取回报并据此调整后续动作选择；在每次智能体与环境完成交互后产生；它与模型内部保存的参数数值不同"
      ],
      fullExplanationMarkdown: "公式为 $r=-x-\\lambda y$；三项前面都是负号，说明线长越长，回报数值越低" } as TeachingPackage;
    const targets = teachingRepairTargets(content, ["priorKnowledge", "fullExplanationMarkdown"], [
      "TEACHING_PRIOR_DEFINITION_INCOMPLETE", "TEACHING_WEIGHTED_TREND_CONDITION_MISSING:fullExplanationMarkdown"
    ]);
    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "priorKnowledge:0", quote: content.priorKnowledge[0] }),
      expect.objectContaining({ field: "fullExplanationMarkdown", quote: expect.stringContaining("线长越长") })
    ]));
    expect(targets.some((target) => target.field === "priorKnowledge:1")).toBe(false);
  });

  it("locates an invented method progression and malformed term label", () => {
    const content = { ...providerTeachingContent(),
      priorKnowledge: ["强化学习智能体（Reinforcement Learning “Agent”）：负责选择动作；读取当前状态；输出一个动作；用于连续决策；它与环境不同"],
      fullExplanationMarkdown: "表格中每一行的限制恰好对应前一行的短板" } as TeachingPackage;
    const targets = teachingRepairTargets(content, ["priorKnowledge", "fullExplanationMarkdown"], [
      "TEACHING_PRIOR_TERM_PAIR_MALFORMED", "TEACHING_METHOD_PROGRESSION_OVERCLAIM:fullExplanationMarkdown"
    ]);
    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "priorKnowledge:0" }),
      expect.objectContaining({ field: "fullExplanationMarkdown", quote: content.fullExplanationMarkdown })
    ]));
  });

  it("targets the exact repeated bridge and action-count claims", () => {
    const content = providerTeachingContent() as TeachingPackage;
    content.fullExplanationMarkdown = "上一页列出了两个动作，本页继续计算更新\n\n## 当前更新\n每个回合只执行一个动作";
    content.learningObjectives = ["能指出哪些结论依赖只有一个状态、一个动作这一设定"];
    const targets = teachingRepairTargets(content, ["fullExplanationMarkdown", "learningObjectives"], [
      "TEACHING_BRIDGE_REPEATED_IN_EXPLANATION", "TEACHING_ACTION_COUNT_CONFLATION:learningObjectives"
    ]);
    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "fullExplanationMarkdown", quote: "上一页列出了两个动作，本页继续计算更新" }),
      expect.objectContaining({ field: "learningObjectives:0", quote: "能指出哪些结论依赖只有一个状态、一个动作这一设定" })
    ]));
  });

  it("targets an unsupported progression inside a misconception array item", () => {
    const content = providerTeachingContent() as TeachingPackage;
    content.misconceptions = ["错误理解：后一种方法依次解决前一种方法；错因：把并列表格写成演进因果；正确判断：只能确认各行限制；核对方法：逐行核对"];
    expect(teachingRepairTargets(content, ["misconceptions"], ["TEACHING_METHOD_PROGRESSION_OVERCLAIM:misconceptions"]))
      .toEqual([expect.objectContaining({ field: "misconceptions:0", quote: content.misconceptions[0] })]);
  });

  it("targets untranslated labels, factorial errors, and episode-step conflation precisely", () => {
    const content = providerTeachingContent() as TeachingPackage;
    content.chapterBridgeMarkdown = "上一页给出“Why?”下面的三项内容";
    content.fullExplanationMarkdown = "$1000! = 10^{2500}$\n\n从 $s_0$ 执行 $a_0$，再执行 $a_1$，每个回合只选择并执行其中一个";
    const targets = teachingRepairTargets(content, ["chapterBridgeMarkdown", "fullExplanationMarkdown"], [
      "TEACHING_UNTRANSLATED_SOURCE_LABEL:chapterBridgeMarkdown",
      "TEACHING_FACTORIAL_MAGNITUDE_MISMATCH:fullExplanationMarkdown:1000:2567",
      "TEACHING_EPISODE_STEP_CONFLATION:fullExplanationMarkdown"
    ]);
    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "chapterBridgeMarkdown", quote: content.chapterBridgeMarkdown }),
      expect.objectContaining({ field: "fullExplanationMarkdown", quote: "$1000! = 10^{2500}$" }),
      expect.objectContaining({ field: "fullExplanationMarkdown", quote: expect.stringContaining("每个回合") })
    ]));
  });

  it("does not send already translated source labels back for repair", () => {
    const content = providerTeachingContent() as TeachingPackage;
    content.questions = [{
      kind: "multiple_choice",
      prompt: "怎样区分动作空间与本回合执行数量",
      options: ["两个可选动作", "只执行一个动作", "无法判断", "没有动作"],
      expectedAnswer: "只执行一个动作",
      explanation: "页面写出“Two actions”，即“两个可选动作”，也写出“One episode with one action”，即“一个回合只执行一个动作”；后文再次引用“one action”却没有翻译"
    }];
    const targets = teachingRepairTargets(content, ["questions"], ["TEACHING_UNTRANSLATED_SOURCE_LABEL:questions"]);
    expect(targets).toEqual([expect.objectContaining({
      field: "questions:0:explanation",
      quote: expect.stringContaining("后文再次引用“one action”却没有翻译")
    })]);
  });

  it("rejects a supported source check whose formula contradicts its evidence", () => {
    expect(supportedSourceCheckFormulaConsistent({
      claim: "末端回报为 $r_T = -\\lambda Wirelength - \\alpha congestion - \\gamma density$",
      evidence: "原图逐项写为 $r_T = -Wirelength - \\lambda congestion - \\gamma density$",
      verdict: "supported"
    })).toBe(false);
    expect(supportedSourceCheckFormulaConsistent({
      claim: "末端回报为 $r_T = -Wirelength - \\lambda congestion - \\gamma density$",
      evidence: "原图逐项写为 $r_T = - Wirelength - \\lambda congestion - \\gamma density$",
      verdict: "supported"
    })).toBe(true);
    expect(supportedSourceCheckFormulaConsistent({
      claim: "末端回报为 $r_T = -Wirelength - \\lambda \\times congestion - \\gamma \\times density$",
      evidence: "原图逐项写为 $r_T = -Wirelength - \\lambda congestion - \\gamma density$",
      verdict: "supported"
    })).toBe(true);
    expect(supportedSourceCheckFormulaConsistent({
      claim: "概率为 $p = \\frac{e^x}{e^x+e^y}$",
      evidence: "原图写成 $p = e^x/(e^x+e^y)$",
      verdict: "supported"
    })).toBe(true);
  });

  it("targets episode-step, sign-description, graph-shape, and optimality claims", () => {
    const content = providerTeachingContent() as TeachingPackage;
    content.learningObjectives = ["说明每个回合只执行一个动作"];
    content.fullExplanationMarkdown = "三项都为负，后两项从线长中减去\n\n图编码器输出固定长度向量\n\n不存在一个让五项同时达到最优的方案";
    const targets = teachingRepairTargets(content, ["learningObjectives", "fullExplanationMarkdown"], [
      "TEACHING_EPISODE_STEP_CONFLATION:learningObjectives",
      "TEACHING_FORMULA_SIGN_DESCRIPTION_REVERSED:fullExplanationMarkdown",
      "TEACHING_GRAPH_ENCODER_FIXED_LENGTH_OVERCLAIM:fullExplanationMarkdown",
      "TEACHING_LOGICAL_OVERCLAIM:fullExplanationMarkdown"
    ]);
    expect(targets.map((target) => target.quote)).toEqual(expect.arrayContaining([
      "说明每个回合只执行一个动作", "三项都为负，后两项从线长中减去", "图编码器输出固定长度向量", "不存在一个让五项同时达到最优的方案"
    ]));
  });

  it("repairs only the failing teaching field and keeps the verified page intact", async () => {
    const before = providerTeachingContent() as TeachingPackage;
    const replacement = ["输入：这是处理开始前已知的对象；它决定规则作用于什么；处理时按规则逐步检查；没有输入就不能确定输出"];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { instructions: string; text: { format: { schema: { required: string[] } } }; input: Array<{ content: Array<{ type: string; text?: string }> }>; max_output_tokens: number };
      expect(body.text.format.schema.required).toEqual(["priorKnowledge"]);
      expect(body.input[0]?.content.map((part) => part.type)).toEqual(["input_text", "input_image"]);
      expect(body.max_output_tokens).toBe(2_500);
      expect(body.instructions).toContain("maximumExplanationCharacters");
      expect(body.instructions).toContain("正式名称内部已有缩写时保留原名");
      expect(body.instructions).not.toContain("只保留已核实的正式英文全称");
      expect(body.input[0]?.content[0]?.text).toContain('"maximumExplanationCharacters":3500');
      return Response.json({ model: "deepseek-flash", output_text: JSON.stringify({ priorKnowledge: replacement }), usage: { input_tokens: 200, output_tokens: 80, total_cost: 0.002 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-flash", protocol: "responses", supportsVision: true, billingMode: "metered" });
    const result = await client.repairTeachingFields({ ...providerInput("field-repair-test", true), stage: "repair", maxCostUsd: 0.01,
      repair: { issues: ["TEACHING_PRIOR_DEFINITION_INCOMPLETE"], maximumExplanationCharacters: 3_500, previousTeachingPackage: before } }, ["priorKnowledge"]);
    expect(result.content).toEqual({ ...before, priorKnowledge: replacement });
    expect(result.usage.apiEquivalentUsd).toBe(0.002);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("supplies the full explanation when repairing a coverage quote", async () => {
    const before = providerTeachingContent() as TeachingPackage;
    before.fullExplanationMarkdown = `${"先解释来源对象，再按顺序核对其状态变化与输出结果。".repeat(130)}最后核对输出边界`;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: Array<{ content: Array<{ text?: string }> }> };
      expect(body.input[0]?.content[0]?.text).toContain("最后核对输出边界");
      return Response.json({ model: "deepseek-flash", output_text: JSON.stringify({ coverageEvidence: before.coverageEvidence }), usage: { input_tokens: 200, output_tokens: 60, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-flash", protocol: "responses", supportsVision: true, billingMode: "metered" });
    await client.repairTeachingFields({ ...providerInput("coverage-repair", true), repair: { issues: ["TEACHING_COVERAGE_QUOTE_NOT_FOUND"], maximumExplanationCharacters: 8000, previousTeachingPackage: before } }, ["coverageEvidence"]);
  });

  it("repairs prose before evidence and quotes the final explanation without changing other fields", async () => {
    const before = providerTeachingContent() as TeachingPackage;
    const explanation = "先找出图上的输入，再说明计算怎样得到输出，同时逐项核对原图的箭头与符号".repeat(5);
    const evidence = [{ atomId: "atom-1", coveredFields: ["observation"], explanation }];
    const requests: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const prompt = JSON.parse(body.input[0].content[0].text);
      requests.push(prompt.fields);
      expect(prompt.compositionContract).toBeDefined();
      if (prompt.fields[0] === "coverageEvidence") expect(prompt.explanationContext).toBe(explanation);
      return Response.json({ model: "deepseek-flash", output_text: JSON.stringify(prompt.fields[0] === "fullExplanationMarkdown"
        ? { fullExplanationMarkdown: explanation } : { coverageEvidence: [{ ...evidence[0], explanation: Object.keys(prompt.evidenceSpans)[0] }] }),
        usage: { input_tokens: 200, output_tokens: 80, total_cost: 0.002 } });
    }));
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://deepseek.test", apiKey: "synthetic-secret",
      model: "deepseek-flash", protocol: "responses", supportsVision: true, billingMode: "metered" });
    const result = await client.repairTeachingFields({ ...providerInput("sequential-fields",true), maxCostUsd:0.01,
      repair:{issues:["TEACHING_COVERAGE_QUOTE_NOT_FOUND"], maximumExplanationCharacters:3500, previousTeachingPackage:before}
    },["coverageEvidence","fullExplanationMarkdown"]);
    expect(requests).toEqual([["fullExplanationMarkdown"],["coverageEvidence"]]);
    expect(result.content.fullExplanationMarkdown).toBe(explanation);
    expect(result.content.coverageEvidence).toEqual(evidence);
    expect(result.content.questions).toEqual(before.questions);
    expect(result.usage.apiEquivalentUsd).toBe(0.004);
  });

  it("rejects a coverage span that does not exist and preserves the input package", async () => {
    const before = providerTeachingContent() as TeachingPackage;
    const original = structuredClone(before);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ model:"deepseek-flash", output_text:JSON.stringify({coverageEvidence:[{atomId:"atom-1",coveredFields:["observation"],explanation:"excerpt:99999"}]}),usage:{input_tokens:100,output_tokens:50,total_cost:0.001} })));
    const client = new HttpProviderTeachingClient({providerId:"deepseek",baseUrl:"https://deepseek.test",apiKey:"synthetic-secret",model:"deepseek-flash",protocol:"responses"});
    await expect(client.repairTeachingFields({...providerInput("invalid-span"),repair:{issues:["TEACHING_COVERAGE_QUOTE_NOT_FOUND"],maximumExplanationCharacters:3500,previousTeachingPackage:before}},["coverageEvidence"]))
      .rejects.toMatchObject({code:"MODEL_PROVIDER_FIELD_REPAIR_INVALID"});
    expect(before).toEqual(original);
  });

  it("accepts up to twenty-four source checks for a dense page without dropping verified objects", async () => {
    const sourceChecks = Array.from({ length: 18 }, (_, index) => ({
      claim: `图中对象 ${index + 1} 的位置`,
      evidence: `原图第 ${index + 1} 个对象`,
      verdict: "supported" as const
    }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ model: "deepseek-flash",
      output_text: JSON.stringify({ sourceChecks, findings: [] }),
      usage: { input_tokens: 120, output_tokens: 240, total_cost: 0.001 } })));
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test",
      apiKey: "synthetic-example-deepseek-token", model: "deepseek-flash", protocol: "responses", supportsVision: true, billingMode: "metered" });
    const result = await client.auditTeachingPackage({ ...providerInput("dense-audit", true),
      teachingPackage: providerTeachingContent() as TeachingPackage, maxCostUsd: 0.01 });
    expect(result.sourceChecks).toHaveLength(18);
  });

  it("rejects an empty semantic audit instead of treating it as source verification", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ model: "deepseek-v4-flash-vision-exp",
      output_text: JSON.stringify({ sourceChecks: [], findings: [] }),
      usage: { input_tokens: 120, output_tokens: 6, total_cost: 0.001 } })));
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test",
      apiKey: "synthetic-example-deepseek-token", model: "deepseek-v4-flash-vision-exp", protocol: "responses", supportsVision: true, billingMode: "metered" });
    await expect(client.auditTeachingPackage({ ...providerInput("empty-audit-test", true),
      teachingPackage: providerTeachingContent() as TeachingPackage, maxCostUsd: 0.01 }))
      .rejects.toMatchObject({ code: "MODEL_PROVIDER_SEMANTIC_AUDIT_INVALID", responseShape: "source_checks_too_few:0:output_tokens=6" });
  });

  it("requires three concrete source checks for a diagram", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text: { format: { schema: { properties: { sourceChecks: { minItems: number } } } } } };
      if (body.text.format.schema.properties.sourceChecks) expect(body.text.format.schema.properties.sourceChecks.minItems).toBe(3);
      return Response.json({ model: "deepseek-v4-flash-vision-exp", output_text: JSON.stringify({ findings: [],
        teachingChecks: ["entry", "terms", "prerequisites", "structure", "objects", "reasoning", "questions"].map(criterion => ({ criterion, evidence: "正文中的输入、处理步骤和输出都有对应解释", verdict: "supported" })),
        sourceChecks: ["起点", "动作", "结果"].map((claim) => ({ claim, field: "priorKnowledge:0", quote: "先知道输入和输出分别表示什么", evidence: `图中标记${claim}`, verdict: "supported" })) }),
        usage: { input_tokens: 120, output_tokens: 100, total_cost: 0.001 } });
    }));
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test",
      apiKey: "synthetic-example-deepseek-token", model: "deepseek-v4-flash-vision-exp", protocol: "responses", supportsVision: true, billingMode: "metered" });
    const blueprint = { resourcePackage: { pageKind: "diagram" } } as ModelRouterInput["blueprint"];
    const result = await client.auditTeachingPackage({ ...providerInput("diagram-audit-test", true), blueprint,
      teachingPackage: providerTeachingContent() as TeachingPackage, maxCostUsd: 0.01 });
    expect(result.sourceChecks).toHaveLength(3);
    expect(result.teachingChecks).toHaveLength(7);
    expect(result.usage.apiEquivalentUsd).toBe(0.002);
  });

  it("keeps a factual failure when the separate writing audit passes and accounts for both calls", async () => {
    const scopes: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const text = typeof body.input === "string" ? body.input : body.input[0].content[0].text;
      const source = text.includes('"auditScope":"source"');
      scopes.push(source ? "source" : "teaching");
      expect(text).toContain('"previousPageContext":"前页输入定义"');
      expect(text.includes('"writingRules":')).toBe(!source);
      if (!source) expect(text).toContain("Changed input");
      expect(body.text.format.schema.properties.findings.items.properties.field.enum).toContain("questions:0:expectedAnswer");
      return Response.json({ model: "deepseek-flash", output_text: JSON.stringify(source ? {
        sourceChecks: [{ claim: "比例相等", field: "fullExplanationMarkdown", quote: "Input", evidence: "给定两组分子分母计算结果并不相等", verdict: "contradicted" }],
        findings: [{ field: "fullExplanationMarkdown", original: "Input", replacement: "Changed input", evidence: "逐项相除得到不同结果" }]
      } : { findings: [], teachingChecks: ["entry","terms","prerequisites","structure","objects","reasoning","questions"].map(criterion => ({ criterion, evidence: "对应字段已经分段说明输入、过程与结果", verdict: "supported" })) }),
        usage: { input_tokens: 100, output_tokens: 100, total_cost: 0.002 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({providerId:"deepseek",baseUrl:"https://deepseek.test",apiKey:"synthetic-secret",model:"deepseek-flash",protocol:"responses"});
    const result = await client.auditTeachingPackage({...providerInput("split-audit"),previousPageContext:"前页输入定义",blueprint:{resourcePackage:{pageKind:"concept"}} as ModelRouterInput["blueprint"],teachingPackage:{...providerTeachingContent(),fullExplanationMarkdown:"Input is the first object described in this synthetic lesson"} as TeachingPackage,maxCostUsd:0.01});
    expect(scopes).toEqual(["source","teaching"]);
    expect(result.sourceChecks?.[0]?.verdict).toBe("contradicted");
    expect(result.findings).toHaveLength(1);
    expect(result.teachingChecks).toHaveLength(7);
    expect(result.usage.apiEquivalentUsd).toBe(0.004);
  });

  it("applies an exact teaching repair once and verifies the corrected revision", async () => {
    const checks = (failed = false) => ["entry","terms","prerequisites","structure","objects","reasoning","questions"].map(criterion => ({
      criterion, evidence: `正文已经逐项说明${criterion}对应的输入、过程与结果`, verdict: failed && criterion === "terms" ? "contradicted" : "supported",
      ...(failed && criterion === "terms" ? { field: "fullExplanationMarkdown", quote: "Input" } : {})
    }));
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const prompt = body.input[0].content[0].text as string;
      const source = prompt.includes('"auditScope":"source"');
      const verification = prompt.includes('"detectedIssues":["TEACHING_STYLE_RECHECK"]');
      const payload = source ? {
        findings: [], sourceChecks: [{ claim: "输入是起点", field: "fullExplanationMarkdown", quote: "`Input is`", evidence: "原图从输入指向输出", verdict: "supported" }]
      } : verification ? { findings: [], teachingChecks: checks() } : {
        findings: [{ field: "fullExplanationMarkdown", original: "Input", replacement: "输入", evidence: "学习正文应使用中文名称" }],
        teachingChecks: checks(true)
      };
      return Response.json({ model: "deepseek-flash", output_text: JSON.stringify(payload), usage: { input_tokens: 100, output_tokens: 100, total_cost: 0.002 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://deepseek.test", apiKey: "synthetic-secret", model: "deepseek-flash", protocol: "responses" });
    const content = { ...providerTeachingContent(), fullExplanationMarkdown: "Input is the first object described in this synthetic lesson" } as TeachingPackage;
    const result = await client.auditTeachingPackage({ ...providerInput("teaching-repair", true), blueprint: { resourcePackage: { pageKind: "concept" } } as ModelRouterInput["blueprint"],
      teachingPackage: content, maxCostUsd: 0.01 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.correctedTeachingPackage?.fullExplanationMarkdown).toContain("输入 is the first object");
    expect(result.teachingChecks?.every(check => check.verdict === "supported")).toBe(true);
    expect(result.usage.apiEquivalentUsd).toBe(0.006);
  });

  it("rejects source verdicts that cannot be located in the lesson instead of turning them into content defects", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.input).toContain("错误理解本身不是作者认同的主张");
      expect(body.text.format.schema.properties.sourceChecks.items.required).toContain("quote");
      return Response.json({ model: "deepseek-flash", output_text: JSON.stringify({ findings: [], sourceChecks: [{
        field: "misconceptions:0", quote: "不存在的截断句子", claim: "定义被截断", evidence: "声称末尾不完整", verdict: "contradicted"
      }] }), usage: { input_tokens: 100, output_tokens: 30, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://deepseek.test", apiKey: "synthetic-secret", model: "deepseek-flash", protocol: "responses" });
    await expect(client.auditTeachingPackage({ ...providerInput("ungrounded-audit"), blueprint: { resourcePackage: { pageKind: "concept" } } as ModelRouterInput["blueprint"], teachingPackage: providerTeachingContent() as TeachingPackage, maxCostUsd: 0.01 }))
      .rejects.toMatchObject({ code: "MODEL_PROVIDER_SEMANTIC_AUDIT_INVALID", responseShape: expect.stringContaining("source_check_quote_not_found"), usage: { apiEquivalentUsd: 0.002 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts a source conflict only when the lesson explicitly preserves and corrects it", () => {
    const check = { claim: "页面把 $1000!$ 写成 $10^{2500}$ 的等式", evidence: "页面原式不成立，两个指数相差 67", verdict: "contradicted" as const };
    expect(resolvedSourceConflictVerdict(check, "页面把 $1000!$ 写成 $10^{2500}$，但独立核算得到 $4.02\\times10^{2567}$，两者相差约 67 个数量级")).toBe("supported");
    expect(resolvedSourceConflictVerdict(check, "页面把 $1000!$ 写成 $10^{2500}$，所以两者相等")).toBe("contradicted");
  });

  it("rejects a negative teaching verdict that has no real field quotation", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const prompt = typeof body.input === "string" ? body.input : body.input[0].content[0].text;
      const source = prompt.includes('"auditScope":"source"');
      const payload = source ? {
        findings: [], sourceChecks: [{ claim: "输入是起点", field: "fullExplanationMarkdown", quote: "输入是处理开始前已经知道的信息", evidence: "原图从输入指向输出", verdict: "supported" }]
      } : {
        findings: [{ field: "fullExplanationMarkdown", original: "输入是处理开始前已经知道的信息", replacement: "输入是规则开始处理前已经确定的信息", evidence: "声称正文重复" }],
        teachingChecks: ["entry","terms","prerequisites","structure","objects","reasoning","questions"].map(criterion => ({
          criterion, evidence: "审计声称这一项存在问题但没有给出真实原文位置", verdict: criterion === "structure" ? "contradicted" : "supported"
        }))
      };
      return Response.json({ model: "deepseek-flash", output_text: JSON.stringify(payload), usage: { input_tokens: 100, output_tokens: 30, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://deepseek.test", apiKey: "synthetic-secret", model: "deepseek-flash", protocol: "responses" });
    await expect(client.auditTeachingPackage({ ...providerInput("ungrounded-teaching"), blueprint: { resourcePackage: { pageKind: "concept" } } as ModelRouterInput["blueprint"],
      teachingPackage: providerTeachingContent() as TeachingPackage, maxCostUsd: 0.01 }))
      .rejects.toMatchObject({ code: "MODEL_PROVIDER_SEMANTIC_AUDIT_INVALID", responseShape: expect.stringContaining("teaching_check_quote_not_found") });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects a patch with an invented quotation before another audit can act on it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ model: "deepseek-flash", output_text: JSON.stringify({
      sourceChecks: [{ claim: "输入先于输出", evidence: "图上有对应箭头", verdict: "supported" }],
      findings: [{ field: "priorKnowledge:0", original: "不存在的原文", replacement: "替换后的定义", evidence: "声称原句有问题" }]
    }), usage: { input_tokens: 100, output_tokens: 30, total_cost: 0.001 } })));
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://deepseek.test", apiKey: "synthetic-secret", model: "deepseek-flash", protocol: "responses" });
    await expect(client.auditTeachingPackage({ ...providerInput("invented-patch"), teachingPackage: providerTeachingContent() as TeachingPackage, maxCostUsd: 0.01 }))
      .rejects.toMatchObject({ code: "MODEL_PROVIDER_SEMANTIC_AUDIT_INVALID", responseShape: expect.stringContaining("finding_quote_not_found") });
  });

  it("preserves a provider's summary list when it returns an array instead of Markdown", async () => {
    const content = { ...providerTeachingContent(), mainContentMarkdown: ["识别输入与条件", "按规则计算结果", "核对输出含义"] };
    const fetchMock = vi.fn(async () => Response.json({ model: "deepseek-v4-flash-vision-exp", output_text: JSON.stringify(content), usage: { input_tokens: 100, output_tokens: 200, total_cost: 0.004 } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-v4-flash-vision-exp", protocol: "responses", supportsVision: false, billingMode: "metered" }).generateTeachingPackage(providerInput("summary-array"));
    expect(result.content.mainContentMarkdown).toBe("- 识别输入与条件\n- 按规则计算结果\n- 核对输出含义");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("repairs only inferable provider shape drift before strict validation", async () => {
    const content = providerTeachingContent() as Record<string, unknown>;
    content.learningObjectives = [{ objective: "能够识别对象" }, { text: "能够解释关系" }];
    content.priorKnowledge = { items: [{ knowledge: "先知道输入和输出" }] };
    content.misconceptions = "不要跳过条件";
    content.questions = (content.questions as Array<Record<string, unknown>>).map((question) => ({
      ...question,
      kind: question.kind === "comprehension" ? "multiple_choice" : "comprehension"
    }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ model: "deepseek-v4-flash-vision-exp", output_text: JSON.stringify(content) }, { status: 200 })));
    const result = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-v4-flash-vision-exp", protocol: "responses", supportsVision: false, billingMode: "metered" }).generateTeachingPackage(providerInput("shape-repair-test"));
    expect(result.content.learningObjectives).toHaveLength(2);
    expect(result.content.questions.filter((question) => question.kind === "comprehension")).toHaveLength(2);
    expect(result.content.questions.filter((question) => question.kind === "multiple_choice")).toHaveLength(2);
  });

  it("keeps both a prior concept and its definition when a provider returns objects", async () => {
    const content = providerTeachingContent() as Record<string, unknown>;
    content.priorKnowledge = [{ term: "归一化", definition: "把几个正数转换为总和等于一的比例" }];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ model: "deepseek-flash", output_text: JSON.stringify(content), usage: { input_tokens: 100, output_tokens: 80, total_cost: 0.001 } })));
    const result = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-flash", protocol: "responses", supportsVision: false, billingMode: "metered" }).generateTeachingPackage(providerInput("prior-term-definition"));
    expect(result.content.priorKnowledge).toEqual(["归一化：把几个正数转换为总和等于一的比例"]);
  });

  it("unwraps a uniquely identifiable nested objective without guessing between alternatives", async () => {
    const content = providerTeachingContent() as Record<string, unknown>;
    content.learningObjectives = [{ generated: { goal: { summary: "能够识别唯一的学习目标" } } }];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ model: "deepseek-v4-flash-vision-exp", output_text: JSON.stringify(content) }, { status: 200 })));
    const result = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-v4-flash-vision-exp", protocol: "responses", supportsVision: false, billingMode: "metered" }).generateTeachingPackage(providerInput("nested-shape-repair-test"));
    expect(result.content.learningObjectives).toEqual(["能够识别唯一的学习目标"]);

    content.learningObjectives = [{ first: "目标甲", second: "目标乙" }];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ model: "deepseek-v4-flash-vision-exp", output_text: JSON.stringify(content) }, { status: 200 })));
    const failure = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-v4-flash-vision-exp", protocol: "responses", supportsVision: false, billingMode: "metered" }).generateTeachingPackage(providerInput("ambiguous-shape-repair-test")).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "MODEL_ROUTER_LEARNING_OBJECTIVES_INVALID", responseShape: expect.stringContaining("learningObjectives=array:1:object") });
  });

  it("retries malformed structured output once with a distinct idempotency key and accounts for both calls", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      attempts += 1;
      const body = JSON.parse(String(init?.body)) as { instructions: string };
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(attempts === 1 ? "shape-retry-test" : "shape-retry-test:schema-retry");
      if (attempts === 2) expect(body.instructions).toContain("MODEL_ROUTER_LEARNING_OBJECTIVES_INVALID");
      const content = providerTeachingContent() as Record<string, unknown>;
      if (attempts === 1) content.learningObjectives = [{ first: "目标甲", second: "目标乙" }];
      return Response.json({ model: "deepseek-v4-flash-vision-exp", output_text: JSON.stringify(content), usage: { input_tokens: 100, output_tokens: 200, cached_tokens: 10 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-v4-flash-vision-exp", protocol: "responses", supportsVision: false, billingMode: "metered" }).generateTeachingPackage(providerInput("shape-retry-test"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ schemaRetries: 1, usage: { inputTokens: 200, cachedInputTokens: 20, outputTokens: 400 } });
  });

  it("retries invalid provider JSON once, while preserving both calls' usage", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const attempt = fetchMock.mock.calls.length;
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(attempt === 1 ? "json-retry" : "json-retry:schema-retry");
      return Response.json({ model: "deepseek-flash", output_text: attempt === 1 ? '{"learningObjectives":[' : JSON.stringify(providerTeachingContent()), usage: { input_tokens: 100, output_tokens: 150 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-flash", protocol: "responses", supportsVision: false, billingMode: "metered" }).generateTeachingPackage(providerInput("json-retry"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ schemaRetries: 1, usage: { inputTokens: 200, outputTokens: 300 } });
  });

  it("requires the full explanation and summary when a provider omits them on a sparse page", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      attempts += 1;
      const body = JSON.parse(String(init?.body)) as { instructions: string };
      const content = providerTeachingContent() as Record<string, unknown>;
      if (attempts === 1) {
        delete content.mainContentMarkdown;
        delete content.fullExplanationMarkdown;
      } else {
        expect(body.instructions).toContain("mainContentMarkdown");
        expect(body.instructions).toContain("fullExplanationMarkdown");
      }
      return Response.json({ model: "deepseek-v4-flash-vision-exp", output_text: JSON.stringify(content), usage: { input_tokens: 100, output_tokens: 200 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-v4-flash-vision-exp", protocol: "responses", supportsVision: false, billingMode: "metered" }).generateTeachingPackage(providerInput("sparse-page-shape-retry"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.schemaRetries).toBe(1);
    expect(result.content.fullExplanationMarkdown).toBeTruthy();
  });

  it("stops a billed page after the first call exceeds its remaining cost limit", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      model: "deepseek-v4-flash-vision-exp",
      output_text: JSON.stringify(providerTeachingContent()),
      usage: { input_tokens: 100, output_tokens: 200, total_cost: 0.07 }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-v4-flash-vision-exp", protocol: "responses", billingMode: "metered" });
    const failure = await client.generateTeachingPackage({ ...providerInput("cost-limit-test"), maxCostUsd: 0.06 }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "MODEL_PROVIDER_PAGE_BUDGET_EXCEEDED", usage: { apiEquivalentUsd: 0.07 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refills missing questions without rewriting a usable teaching page", async () => {
    const original = providerTeachingContent() as TeachingPackage;
    const { questions, ...withoutQuestions } = original;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ model: "deepseek-flash", output_text: JSON.stringify(withoutQuestions), usage: { input_tokens: 300, output_tokens: 900 } }))
      .mockResolvedValueOnce(Response.json({ model: "deepseek-flash", output_text: JSON.stringify({ questions }), usage: { input_tokens: 200, output_tokens: 500 } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-v4-flash-vision-exp", protocol: "responses", billingMode: "metered" });
    const result = await client.generateTeachingPackage({ ...providerInput("missing-questions-test"), maxCostUsd: 0.06 });
    expect(result.content.fullExplanationMarkdown).toBe(original.fullExplanationMarkdown);
    expect(result.content.questions).toEqual(questions);
    expect(result).toMatchObject({ schemaRetries: 1, usage: { inputTokens: 500, outputTokens: 1400 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { input: string; metadata: { stage: string }; text: { format: { name: string } } };
    expect(secondBody.metadata.stage).toBe("question_refill");
    expect(secondBody.text.format.name).toBe("course_os_question_refill");
    expect(secondBody.input).not.toContain("离线提取来源文本");
  });

  it("refills a missing teaching tail without regenerating the existing explanation", async () => {
    const original = providerTeachingContent() as TeachingPackage;
    const { misconceptions, coverageEvidence, questions, ...front } = original;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ model: "deepseek-flash", output_text: JSON.stringify(front), usage: { input_tokens: 300, output_tokens: 900, total_cost: 0.003 } }))
      .mockResolvedValueOnce(Response.json({ model: "deepseek-flash", output_text: JSON.stringify({ misconceptions, coverageEvidence, questions }), usage: { input_tokens: 200, output_tokens: 500, total_cost: 0.002 } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-flash", protocol: "responses", billingMode: "metered" });
    const result = await client.generateTeachingPackage({ ...providerInput("missing-tail-test"), maxCostUsd: 0.06 });
    expect(result.content.fullExplanationMarkdown).toBe(original.fullExplanationMarkdown);
    expect(result.content).toMatchObject({ misconceptions, coverageEvidence, questions });
    expect(result.usage.apiEquivalentUsd).toBe(0.005);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const refill = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { metadata: { stage: string }; text: { format: { schema: { required: string[] } } } };
    expect(refill.metadata.stage).toBe("teaching_tail_refill");
    expect(refill.text.format.schema.required).toEqual(["misconceptions", "coverageEvidence", "questions"]);
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

  it("repairs unescaped TeX backslashes inside a complete provider JSON object", async () => {
    const raw = JSON.stringify(providerTeachingContent()).replace("输入是处理开始前", String.raw`符号 $\lambda$ 表示系数；输入是处理开始前`);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ model: "deepseek-flash", output_text: raw, usage: { input_tokens: 100, output_tokens: 300 } })));
    const result = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-flash", protocol: "responses", billingMode: "metered" }).generateTeachingPackage(providerInput("raw-tex-json"));
    expect(result.content.fullExplanationMarkdown).toContain("$\\lambda$");
  });

  it("does not mistake a nested coverage item for a complete teaching package", async () => {
    const nested = '{"learningObjectives":["未闭合"],"coverageEvidence":[{"atomId":"a1","coveredFields":["text"],"explanation":"原句"}';
    const fetchMock = vi.fn(async () => Response.json({ model: "deepseek-flash", output_text: nested, usage: { input_tokens: 100, output_tokens: 150 } }));
    vi.stubGlobal("fetch", fetchMock);
    const failure = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-flash", protocol: "responses", billingMode: "metered" }).generateTeachingPackage(providerInput("truncated-outer-json")).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "MODEL_PROVIDER_OUTPUT_JSON_INVALID" });
  });

  it("falls back once and never exposes a provider secret in errors", async () => {
    const secret = "synthetic-example-secret-not-for-logging";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: "rate_limited", message: "temporary" } }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ model: "qwen3.8-flash", content: [{ type: "text", text: JSON.stringify(providerTeachingContent()) }], usage: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new RoutedProviderTeachingClient([
      { providerId: "deepseek", baseUrl: "https://deepseek.test", apiKey: secret, model: "deepseek-v4-pro", protocol: "responses" },
      { providerId: "opencode-go", baseUrl: "https://opencode.test", apiKey: "synthetic-example-opencode-token", model: "qwen3.8-flash", protocol: "messages" }
    ]).generateTeachingPackage(providerInput("fallback-test"));
    expect(result.provider).toBe("opencode-go");
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
          models: [{ id: "vision", displayName: "Vision", protocol: "responses", supportsVision: true,
            supportsJsonSchema: true, supportsReasoning: true, billingMode: "subscription_quota" }] }
      ],
      policy: { workspaceId: "personal", allowProviderFallback: true, allowAialraEmergencyFallback: false,
        updatedAt: new Date(0).toISOString(), routes: [
          { providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true },
          { providerId: "opencode-go", modelId: "vision", enabled: true }
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
      expect(body.model).toBe("vision");
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
          models: [{ id: "vision", displayName: "Vision", protocol: "responses", supportsVision: true,
            supportsJsonSchema: true, supportsReasoning: true, billingMode: "subscription_quota" }] }
      ],
      policy: { workspaceId: "personal", allowProviderFallback: true, allowAialraEmergencyFallback: false,
        updatedAt: new Date(0).toISOString(), routes: [
          { providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true },
          { providerId: "opencode-go", modelId: "vision", enabled: true }
        ], rules: [{ stage: "teach", providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true }] },
      credential: async () => "synthetic-secret"
    }) });
    const result = await client.generateTeachingPackage({ ...providerInput("image-only-fallback", true), sourceText: "" });
    expect(result).toMatchObject({ provider: "opencode-go", model: "vision" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows every enabled route in visible priority order after quota failures", async () => {
    const providerIds = ["kuafu", "opencode-go", "deepseek", "codex", "kimi-coding"];
    const fetchMock = vi.fn(async (url: string) => {
      const providerId = new URL(url).hostname.split(".")[0]!;
      if (providerId !== "kimi-coding") return Response.json({ error: { code: "quota_exhausted" } }, { status: 429 });
      return Response.json({ model: "test-model", output_text: JSON.stringify(providerTeachingContent()), usage: { input_tokens: 100, output_tokens: 200, total_cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SettingsProviderTeachingClient({ load: async () => ({
      providers: providerIds.map(id => ({ id, displayName: id, baseUrl: `https://${id}.test`, enabled: true,
        credential: { configured: true }, models: [{ id: "test-model", displayName: "Test", protocol: "responses" as const,
          supportsVision: true, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" as const }] })),
      policy: { workspaceId: "personal", allowProviderFallback: true, allowAialraEmergencyFallback: false, updatedAt: new Date(0).toISOString(),
        routes: providerIds.map(providerId => ({ providerId, modelId: "test-model", enabled: true })),
        rules: [{ stage: "teach", providerId: "deepseek", modelId: "test-model", enabled: true }] },
      credential: async () => "synthetic-secret"
    }) });
    const result = await client.generateTeachingPackage(providerInput("ordered-route-test"));
    expect(result.provider).toBe("kimi-coding");
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).hostname.split(".")[0])).toEqual(providerIds);
  });

  it("preserves a zero-usage quota error across a planned-stage retry", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: { code: "429" } }, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const page = {
      id: "sample:page:1", pageNumber: 1, title: "示例", imageUrl: "",
      anchors: [], atoms: [], blocks: [], coverageRequirements: [], coverageClaims: [],
      quality: { highRiskCoverage: 0, generalCoverage: 0, mathValid: true, publishable: false, issues: [] }
    } as Parameters<typeof buildTeachingBlueprint>[0];
    const input = {
      ...providerInput("planned-quota-test"),
      blueprint: buildTeachingBlueprint(page, "来源内容", "zh-CN", "quality", "writing-policy:test", false),
      maxCostUsd: 0.06
    };
    const client = new HttpProviderTeachingClient({ providerId: "opencode-go", baseUrl: "https://opencode.test", apiKey: "synthetic-example-token", model: "deepseek-v4-flash-vision-exp", protocol: "chat_completions", supportsVision: true, billingMode: "subscription_quota" });
    await expect(client.generateTeachingPackage(input)).rejects.toMatchObject({ provider: "opencode-go", code: "MODEL_PROVIDER_FAILED:429" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reaches the configured provider fallback after a planned-stage quota failure", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: { code: "429" } }, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const page = {
      id: "sample:page:2", pageNumber: 2, title: "示例", imageUrl: "",
      anchors: [], atoms: [], blocks: [], coverageRequirements: [], coverageClaims: [],
      quality: { highRiskCoverage: 0, generalCoverage: 0, mathValid: true, publishable: false, issues: [] }
    } as Parameters<typeof buildTeachingBlueprint>[0];
    const client = new SettingsProviderTeachingClient({ load: async () => ({
      providers: ["opencode-go", "deepseek"].map(id => ({ id, displayName: id, baseUrl: `https://${id}.test`, enabled: true,
        credential: { configured: true }, models: [{ id: "deepseek-v4-flash-vision-exp", displayName: "Vision", protocol: "chat_completions" as const,
          supportsVision: true, supportsJsonSchema: true, supportsReasoning: false, billingMode: "metered" as const }] })),
      policy: { workspaceId: "personal", allowProviderFallback: true, allowAialraEmergencyFallback: false, updatedAt: new Date(0).toISOString(),
        rules: [{ stage: "teach", providerId: "opencode-go", modelId: "deepseek-v4-flash-vision-exp", fallbackProviderId: "deepseek", fallbackModelId: "deepseek-v4-flash-vision-exp", enabled: true }] },
      credential: async () => "synthetic-secret"
    }) });
    const input = { ...providerInput("planned-fallback-test"),
      blueprint: buildTeachingBlueprint(page, "来源内容", "zh-CN", "quality", "writing-policy:test", false), maxCostUsd: 0.06 };
    await expect(client.generateTeachingPackage(input)).rejects.toMatchObject({ provider: "deepseek", code: "MODEL_PROVIDER_FAILED:429" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("falls back during semantic audit when the primary quota route fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: "quota_exhausted", message: "quota exhausted" } }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ model: "deepseek-flash", output_text: JSON.stringify({
        sourceChecks: [{ claim: "输入先于输出", evidence: "原图箭头从输入指向输出", verdict: "supported" }], findings: []
      }), usage: { input_tokens: 100, output_tokens: 50, total_cost: 0.001 } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SettingsProviderTeachingClient({ load: async () => ({
      providers: [
        { id: "opencode-go", displayName: "OpenCode", baseUrl: "https://opencode.test", enabled: true, credential: { configured: true }, models: [{ id: "deepseek-v4-flash-vision-exp", displayName: "OpenCode Vision", protocol: "chat_completions", supportsVision: true, supportsJsonSchema: true, supportsReasoning: true, billingMode: "subscription_quota" }] },
        { id: "deepseek", displayName: "DeepSeek", baseUrl: "https://deepseek.test", enabled: true, credential: { configured: true }, models: [{ id: "deepseek-flash", displayName: "DeepSeek Flash", protocol: "responses", supportsVision: true, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" }] }
      ],
      policy: { workspaceId: "personal", allowProviderFallback: true, allowAialraEmergencyFallback: false, updatedAt: new Date(0).toISOString(), rules: [{ stage: "semantic_audit", providerId: "opencode-go", modelId: "deepseek-v4-flash-vision-exp", fallbackProviderId: "deepseek", fallbackModelId: "deepseek-flash", enabled: true }] },
      credential: async () => "synthetic-secret"
    }) });
    const result = await client.auditTeachingPackage({ ...providerInput("audit-fallback", true), teachingPackage: providerTeachingContent() as TeachingPackage, maxCostUsd: 0.01 });
    expect(result.provider).toBe("deepseek");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not switch to paid fallback for authentication or content failures", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: { code: "invalid_api_key" } }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SettingsProviderTeachingClient({ load: async () => ({
      providers: ["opencode-go", "deepseek"].map(id => ({ id, displayName: id, baseUrl: `https://${id}.test`, enabled: true,
        credential: { configured: true }, models: [{ id: "flash-test", displayName: "Flash", protocol: "chat_completions" as const,
          supportsVision: true, supportsJsonSchema: true, supportsReasoning: false, billingMode: "metered" as const }] })),
      policy: { workspaceId: "personal", allowProviderFallback: true, allowAialraEmergencyFallback: false, updatedAt: new Date(0).toISOString(),
        rules: [{ stage: "teach", providerId: "opencode-go", modelId: "flash-test", fallbackProviderId: "deepseek", fallbackModelId: "flash-test", enabled: true }] },
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

  it("uses an explicitly configured semantic audit route without changing the teaching route", async () => {
    const models = ["deepseek-flash", "deepseek-v4-flash-vision-exp"].map((id) => ({ id, displayName: id,
      protocol: "responses" as const, supportsVision: true, supportsJsonSchema: true,
      supportsReasoning: true, billingMode: "metered" as const }));
    const seenModels: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      seenModels.push(body.model);
      return Response.json({ model: body.model, output_text: JSON.stringify({
        sourceChecks: [{ claim: "图中标出两个对象", evidence: "原图有两个标签", verdict: "supported" }], findings: []
      }), usage: { input_tokens: 100, output_tokens: 50, total_cost: 0.001 } });
    }));
    const client = new SettingsProviderTeachingClient({ load: async () => ({
      providers: [{ id: "deepseek", displayName: "DeepSeek", baseUrl: "https://deepseek.test", enabled: true,
        credential: { configured: true }, models }],
      policy: { workspaceId: "personal", allowProviderFallback: false, allowAialraEmergencyFallback: false,
        updatedAt: new Date(0).toISOString(), rules: [
          { stage: "teach", providerId: "deepseek", modelId: "deepseek-flash", enabled: true },
          { stage: "semantic_audit", providerId: "deepseek", modelId: "deepseek-v4-flash-vision-exp", enabled: true }
        ] },
      credential: async () => "synthetic-secret"
    }) });
    const result = await client.auditTeachingPackage({ ...providerInput("explicit-audit-route", true),
      teachingPackage: providerTeachingContent() as TeachingPackage });
    expect(result.model).toBe("deepseek-v4-flash-vision-exp");
    expect(seenModels).toEqual(["deepseek-v4-flash-vision-exp"]);
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

function providerInput(idempotencyKey: string, withImage = false) {
  return {
    pageTitle: "供应商协议测试页",
    pageNumber: 1,
    sourceText: "来源内容：输入经过规则处理后得到输出",
    sourceImageDataUrl: withImage ? "data:image/png;base64,iVBORw0KGgo=" : undefined,
    writingPolicySnapshotId: "writing-policy:test",
    language: "zh-CN",
    qualityMode: "balanced",
    idempotencyKey
  };
}

function providerTeachingContent() {
  return {
    learningObjectives: ["能够解释输入、规则和输出之间的关系"],
    mainContentMarkdown: "先识别输入，再按照规则处理，最后核对输出是否满足目标",
    priorKnowledge: ["先知道输入和输出分别表示什么"],
    fullExplanationMarkdown: "输入是处理开始前已经知道的信息，规则限定允许执行的步骤，输出是处理结束后的结果。每一步都要对照目标与约束检查，不能只看最后数字。".repeat(8),
    misconceptions: ["不要跳过输入条件直接套用最后结论"],
    coverageEvidence: [],
    questions: [
      { kind: "comprehension", prompt: "输入有什么作用", options: [], expectedAnswer: "输入提供起始信息", explanation: "没有输入就无法确定规则处理的对象" },
      { kind: "comprehension", prompt: "为什么要检查输出", options: [], expectedAnswer: "确认规则执行正确", explanation: "输出需要回到目标和约束中核对" },
      { kind: "multiple_choice", prompt: "第一步是什么", options: ["识别输入", "忽略条件", "直接结论", "删除规则"], expectedAnswer: "识别输入", explanation: "输入决定后续处理对象" },
      { kind: "multiple_choice", prompt: "最后一步是什么", options: ["核对输出", "删除结果", "忽略目标", "改变题意"], expectedAnswer: "核对输出", explanation: "输出需要对照目标检查" }
    ]
  };
}
