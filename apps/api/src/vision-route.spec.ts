import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig, ModelRoutePolicy } from "@course-os/contracts";
import { SettingsProviderTeachingClient, type ModelRouterInput, type SettingsProviderSource, type TeachingPackage } from "./model-router.js";

const imageDataUrl = "data:image/png;base64,iVBORw0KGgo=";
const kuafuModelId = "deepseek-v4.1-flash";
const lunaModelId = "gpt-5.6-luna";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("vision route selection", () => {
  it("uses the extract Luna rule while keeping Kuafu as the teaching route and sends the source image to vision", async () => {
    const seen: Array<{ url: string; body: ProviderRequestBody }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as ProviderRequestBody;
      seen.push({ url: String(url), body });
      if (body.model === lunaModelId) {
        return Response.json({
          model: lunaModelId,
          output_text: "页面内容：原图展示输入与规则的对应关系。\n教学顺序：先识别输入，再核对处理规则。",
          usage: { input_tokens: 120, output_tokens: 80 }
        });
      }
      if (body.model === kuafuModelId) {
        return Response.json({
          model: kuafuModelId,
          output_text: JSON.stringify(fullTeachingPackage()),
          usage: { input_tokens: 300, output_tokens: 500, total_cost: 0.001 }
        });
      }
      throw new Error(`UNEXPECTED_SYNTHETIC_MODEL:${body.model}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new SettingsProviderTeachingClient(settingsSource({
      extract: { providerId: "opencode-go", modelId: lunaModelId },
      globalRoutes: [{ providerId: "kuafu", modelId: kuafuModelId }],
      kuafuSupportsVision: false
    }));
    const input = modelInput("vision-extract-keeps-teach-route");
    const understood = await client.understandPage(input);
    expect(understood).toMatchObject({ provider: "opencode-go", model: lunaModelId });

    const teachInput: ModelRouterInput = {
      ...input,
      sourceText: `${input.sourceText}\n\n页面图像观察：${understood!.sourceDescription}`,
      teachingPlan: understood!.teachingPlan
    };
    const generated = await client.generateTeachingPackage(teachInput);

    expect(generated).toMatchObject({ provider: "kuafu", model: kuafuModelId });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(seen.map((request) => request.body.model)).toEqual([lunaModelId, kuafuModelId]);
    expect(seen[0]?.url).toBe("https://opencode.test/v1/responses");
    const visionInput = seen[0]?.body.input;
    expect(Array.isArray(visionInput)).toBe(true);
    expect((visionInput as Array<{ content: Array<{ type: string; image_url?: string }> }>)[0]?.content)
      .toContainEqual(expect.objectContaining({ type: "input_image", image_url: imageDataUrl }));

    // Kuafu's configured model is text-only: it receives the extracted page text and plan.
    expect(seen[1]?.url).toBe("https://kuafu.test/v1/responses");
    expect(typeof seen[1]?.body.input).toBe("string");
    expect(seen[1]?.body.input).toContain("原图展示输入与规则的对应关系");
    expect(seen[1]?.body.input).toContain("先识别输入，再核对处理规则。");
    expect(input.sourceImageDataUrl).toBe(imageDataUrl);
    expect(teachInput.sourceImageDataUrl).toBe(imageDataUrl);
  });

  it("skips a configured non-vision extract model and uses the configured vision route", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as ProviderRequestBody;
      expect(String(url)).toBe("https://opencode.test/v1/responses");
      expect(body.model).toBe(lunaModelId);
      const content = (body.input as Array<{ content: Array<{ type: string; image_url?: string }> }>)[0]?.content;
      expect(content).toContainEqual(expect.objectContaining({ type: "input_image", image_url: imageDataUrl }));
      return Response.json({
        model: lunaModelId,
        output_text: "页面内容：原图包含可读的条件判断代码。\n教学顺序：先看条件，再跟踪输出。",
        usage: { input_tokens: 100, output_tokens: 70 }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new SettingsProviderTeachingClient(settingsSource({
      extract: { providerId: "kuafu", modelId: kuafuModelId },
      globalRoutes: [
        { providerId: "kuafu", modelId: kuafuModelId },
        { providerId: "opencode-go", modelId: lunaModelId }
      ],
      kuafuSupportsVision: false
    }));

    const understood = await client.understandPage(modelInput("nonvision-extract-fallback"));

    expect(understood).toMatchObject({ provider: "opencode-go", model: lunaModelId });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

interface ProviderRequestBody {
  model: string;
  input: string | Array<{ role: string; content: Array<{ type: string; text?: string; image_url?: string }> }>;
}

function settingsSource(args: {
  extract: { providerId: string; modelId: string };
  globalRoutes: Array<{ providerId: string; modelId: string }>;
  kuafuSupportsVision: boolean;
}): SettingsProviderSource {
  const providers: ModelProviderConfig[] = [
    {
      id: "kuafu",
      displayName: "Kuafu",
      baseUrl: "https://kuafu.test/v1",
      enabled: true,
      credential: { configured: true },
      models: [{
        id: kuafuModelId,
        displayName: "DeepSeek V4.1 Flash",
        protocol: "responses",
        supportsVision: args.kuafuSupportsVision,
        supportsJsonSchema: true,
        supportsReasoning: true,
        billingMode: "metered"
      }]
    },
    {
      id: "opencode-go",
      displayName: "OpenCode Go",
      baseUrl: "https://opencode.test/v1",
      enabled: true,
      credential: { configured: true },
      models: [{
        id: lunaModelId,
        displayName: "GPT 5.6 Luna",
        protocol: "responses",
        supportsVision: true,
        supportsJsonSchema: true,
        supportsReasoning: true,
        billingMode: "subscription_quota"
      }]
    }
  ];
  const policy: ModelRoutePolicy = {
    workspaceId: "personal",
    allowProviderFallback: true,
    allowAialraEmergencyFallback: false,
    updatedAt: "2026-09-29T00:00:00.000Z",
    rules: [
      { stage: "extract", ...args.extract, enabled: true },
      { stage: "teach", providerId: "kuafu", modelId: kuafuModelId, enabled: true }
    ],
    routes: args.globalRoutes.map((route) => ({ ...route, enabled: true }))
  };
  return {
    load: async () => ({ providers, policy, credential: async () => "synthetic-test-credential" })
  };
}

function modelInput(idempotencyKey: string): ModelRouterInput {
  return {
    pageTitle: "条件与输出",
    pageNumber: 1,
    sourceText: "原始 OCR：输入 x 经过规则后得到输出 y。",
    sourceImageDataUrl: imageDataUrl,
    writingPolicySnapshotId: "writing-policy:vision-route-test",
    language: "zh-CN",
    qualityMode: "balanced",
    idempotencyKey,
    stage: "teach",
    maxCostUsd: 0.3
  };
}

function fullTeachingPackage(): TeachingPackage {
  return {
    learningObjectives: ["能够说明条件规则与输出之间的关系"],
    mainContentMarkdown: "先识别输入与适用条件，再按规则处理并核对输出。",
    priorKnowledge: ["输入是规则开始处理前提供的对象；先确认对象，才能判断条件是否适用。"],
    fullExplanationMarkdown: "输入提供处理对象，条件限定规则何时执行，输出显示处理结果。逐项核对条件和目标，才能确认规则是否正确。\n\n".repeat(8),
    misconceptions: ["**错误理解：** 只检查输出即可。\n\n**错因：** 忽略条件可能让规则作用于错误对象。\n\n**正确判断：** 同时核对输入、条件和输出。\n\n**核对方法：** 逐项确认条件满足后，再比较输出与目标。"],
    coverageEvidence: [],
    questions: [
      { kind: "comprehension", prompt: "规则处理什么？", options: [], expectedAnswer: "规则处理输入提供的对象。", explanation: "先确认对象才能检查规则是否适用。" },
      { kind: "comprehension", prompt: "条件起什么作用？", options: [], expectedAnswer: "条件限定规则何时执行。", explanation: "只有满足条件才应执行对应步骤。" },
      { kind: "multiple_choice", prompt: "执行规则前先核对什么？", options: ["输入和条件", "页脚样式", "后续章节", "无关背景"], expectedAnswer: "输入和条件", explanation: "确认对象与适用条件可避免误用规则。" },
      { kind: "multiple_choice", prompt: "规则执行后应检查什么？", options: ["输出是否符合目标", "是否删除输入", "是否跳过条件", "是否更换题目"], expectedAnswer: "输出是否符合目标", explanation: "将结果与目标比较才能确认处理是否完成。" }
    ]
  };
}
