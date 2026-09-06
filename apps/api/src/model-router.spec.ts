import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpModelRouterClient, HttpProviderTeachingClient, ModelRouterGenerationError, probeProviderConnection, RoutedProviderTeachingClient, SettingsProviderTeachingClient, currentGenerationHarness } from "./model-router.js";

describe("generation harness", () => {
  it("loads editable prompt and schema files as one hashed snapshot", () => {
    const snapshot = currentGenerationHarness();
    expect(snapshot).toMatchObject({ id: "course-os-teaching", version: "1.2.0", taskContract: "GENERATE + TEACHING" });
    expect(snapshot.files.map((file) => file.path)).toEqual(["teaching-system-prompt.md", "teaching-user-prompt.md", "teaching-blueprint.md", "teaching-package.schema.json"]);
    expect(snapshot.aggregateSha256).toMatch(/^[a-f0-9]{64}$/);
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
      const body = JSON.parse(String(init?.body)) as { input: Array<{ content: Array<{ type: string; image_url?: string }> }>; text?: { format?: { type?: string; json_schema?: unknown } } };
      expect(body.text?.format?.type).toBe("json_schema");
      expect(body.input[0]?.content.map((item) => item.type)).toEqual(["input_text", "input_image"]);
      expect(body.input[0]?.content[1]?.image_url).toMatch(/^data:image\/png;base64,/);
      return Response.json({ model: "deepseek-v4-flash-vision-exp", output_text: JSON.stringify(providerTeachingContent()), usage: { input_tokens: 300, output_tokens: 400, input_tokens_details: { cached_tokens: 50 }, total_cost: 0.012 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new HttpProviderTeachingClient({ providerId: "deepseek", baseUrl: "https://api.deepseek.test", apiKey: "synthetic-example-deepseek-token", model: "deepseek-v4-flash-vision-exp", protocol: "responses", supportsVision: true, billingMode: "metered" }).generateTeachingPackage(providerInput("responses-test", true));
    expect(result).toMatchObject({ provider: "deepseek", model: "deepseek-v4-flash-vision-exp", usage: { inputTokens: 300, cachedInputTokens: 50, outputTokens: 400, apiEquivalentUsd: 0.012 } });
  });

  it("repairs only inferable provider shape drift before strict validation", async () => {
    const content = providerTeachingContent() as Record<string, unknown>;
    content.learningObjectives = "能够识别对象\n能够解释关系";
    content.priorKnowledge = "先知道输入和输出";
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
