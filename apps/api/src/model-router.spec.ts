import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpModelRouterClient, HttpProviderTeachingClient, ModelRouterGenerationError, modelInput, probeProviderConnection, RoutedProviderTeachingClient, SettingsProviderTeachingClient, currentGenerationHarness, teachingOutputTokenLimit, teachingPackageSchema, withCurrentDeepSeekModels, type ModelRouterInput, type TeachingPackage } from "./model-router.js";

describe("generation harness", () => {
  it("loads editable prompt and schema files as one hashed snapshot", () => {
    const snapshot = currentGenerationHarness();
    expect(snapshot).toMatchObject({ id: "course-os-teaching", version: "2.4.30", taskContract: "GENERATE + TEACHING" });
    expect(snapshot.files.some((file) => file.path === "apps/api/src/app.ts")).toBe(true);
    const schema = teachingPackageSchema as { properties: Record<string, unknown>; required: string[] };
    expect(new Set(schema.required)).toEqual(new Set(Object.keys(schema.properties)));
    expect(snapshot.files.map((file) => file.path)).toEqual(["teaching-system-prompt.md", "teaching-user-prompt.md", "teaching-blueprint.md", "teaching-package.schema.json", "semantic-audit-prompt.md", "semantic-audit.schema.json", "policy-format-rules.md", "policy-explanation-framework.md", "policy-formula-explanation.md", "apps/api/src/app.ts", "apps/api/src/generation-harness.ts", "apps/api/src/teaching-blueprint.ts", "apps/api/src/model-router.ts", "packages/quality/src/index.ts"]);
    expect(snapshot.aggregateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.files.find((file) => file.path === "policy-format-rules.md")?.sha256).toBe("b15dcd70817c1dc88a925a935355059c2dc6eb3ae280775dc09faae1f51a1a7b");
    expect(snapshot.files.find((file) => file.path === "policy-explanation-framework.md")?.sha256).toBe("a4e00e0b3441f7e7036b810f8bda685422649a498682834c898e6d4c263e9a9c");
    expect(snapshot.files.find((file) => file.path === "policy-formula-explanation.md")?.sha256).toBe("73caaa9e14cd6f8f85e34f4cb807c5f37a234a95fddddae5177aa37f829486e6");
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

  it("uses JSON schema with OpenCode Go chat completions models", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://opencode.test/chat/completions");
      const body = JSON.parse(String(init?.body)) as { response_format?: { type?: string; json_schema?: { schema?: unknown } } };
      expect(body.response_format?.type).toBe("json_schema");
      expect(body.response_format?.json_schema?.schema).toBeTruthy();
      return Response.json({ model: "deepseek-v4-pro", choices: [{ message: { content: JSON.stringify(providerTeachingContent()) } }], usage: { prompt_tokens: 90, completion_tokens: 210, cached_tokens: 10 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new HttpProviderTeachingClient({ providerId: "opencode-go", baseUrl: "https://opencode.test", apiKey: "synthetic-example-opencode-token", model: "deepseek-v4-pro", protocol: "chat_completions", supportsVision: false, billingMode: "subscription_quota" }).generateTeachingPackage(providerInput("chat-test"));
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
    const result = await client.auditTeachingPackage({ ...providerInput("semantic-audit-test", true), teachingPackage: providerTeachingContent() as TeachingPackage, maxCostUsd: 0.01 });
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

  it("repairs only the failing teaching field and keeps the verified page intact", async () => {
    const before = providerTeachingContent() as TeachingPackage;
    const replacement = ["输入：这是处理开始前已知的对象；它决定规则作用于什么；处理时按规则逐步检查；没有输入就不能确定输出"];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { instructions: string; text: { format: { schema: { required: string[] } } }; input: Array<{ content: Array<{ type: string; text?: string }> }>; max_output_tokens: number };
      expect(body.text.format.schema.required).toEqual(["priorKnowledge"]);
      expect(body.input[0]?.content.map((part) => part.type)).toEqual(["input_text", "input_image"]);
      expect(body.max_output_tokens).toBe(2_500);
      expect(body.instructions).toContain("maximumExplanationCharacters");
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

  it("binds coverage excerpts to the newly repaired explanation when both fields change", async () => {
    const before = providerTeachingContent() as TeachingPackage;
    const explanation = "先找出图上的输入，再说明计算怎样得到输出，同时逐项核对原图的箭头与符号。".repeat(5);
    const evidence = [{ atomId: "atom-1", coveredFields: ["observation"], explanation: "正文逐字写明：先找出图上的输入，再说明计算怎样得到输出" }];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { instructions: string; input: Array<{ content: Array<{ text?: string }> }> };
      expect(body.instructions).toContain("本次同一 JSON 返回的 fullExplanationMarkdown");
      expect(body.instructions).not.toContain("必须逐字摘取 explanationContext");
      expect(body.input[0]?.content[0]?.text).toContain('"fullExplanationMarkdown"');
      return Response.json({ model: "deepseek-flash", output_text: JSON.stringify({ fullExplanationMarkdown: explanation, coverageEvidence: evidence }),
        usage: { input_tokens: 200, output_tokens: 80, total_cost: 0.002 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test",
      apiKey: "synthetic-example-deepseek-token", model: "deepseek-flash", protocol: "responses", supportsVision: true, billingMode: "metered" });
    const result = await client.repairTeachingFields({ ...providerInput("paired-coverage-repair", true),
      repair: { issues: ["TEACHING_COVERAGE_QUOTE_NOT_FOUND", "TEACHING_EXPLANATION_TOO_LONG"],
        maximumExplanationCharacters: 3500, previousTeachingPackage: before } }, ["fullExplanationMarkdown", "coverageEvidence"]);
    expect(result.content.fullExplanationMarkdown).toBe(explanation);
    expect(result.content.coverageEvidence).toEqual(evidence);
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
      expect(body.text.format.schema.properties.sourceChecks.minItems).toBe(3);
      return Response.json({ model: "deepseek-v4-flash-vision-exp", output_text: JSON.stringify({ findings: [],
        sourceChecks: ["起点", "动作", "结果"].map((claim) => ({ claim, evidence: `图中标记${claim}`, verdict: "supported" })) }),
        usage: { input_tokens: 120, output_tokens: 100, total_cost: 0.001 } });
    }));
    const client = new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test",
      apiKey: "synthetic-example-deepseek-token", model: "deepseek-v4-flash-vision-exp", protocol: "responses", supportsVision: true, billingMode: "metered" });
    const blueprint = { resourcePackage: { pageKind: "diagram" } } as ModelRouterInput["blueprint"];
    const result = await client.auditTeachingPackage({ ...providerInput("diagram-audit-test", true), blueprint,
      teachingPackage: providerTeachingContent() as TeachingPackage, maxCostUsd: 0.01 });
    expect(result.sourceChecks).toHaveLength(3);
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

  it("uses the current DeepSeek visual route even when persisted model settings are older", async () => {
    const providers = [{ id: "deepseek", displayName: "DeepSeek", baseUrl: "https://deepseek.test", enabled: true,
      credential: { configured: true }, models: [{ id: "deepseek-v4-pro", displayName: "Pro", protocol: "responses" as const,
        supportsVision: false, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" as const }] }];
    expect(withCurrentDeepSeekModels(providers).find((provider) => provider.id === "deepseek")?.models.some((model) => model.id === "deepseek-flash" && model.supportsVision)).toBe(true);
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
