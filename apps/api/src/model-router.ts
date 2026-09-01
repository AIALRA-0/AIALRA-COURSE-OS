import { randomUUID } from "node:crypto";
import type { GenerationStage, ModelProviderConfig, ModelRoutePolicy, ProviderHealth } from "@course-os/contracts";

export interface TeachingPackage {
  learningObjectives: string[];
  mainContentMarkdown: string;
  priorKnowledge: string[];
  fullExplanationMarkdown: string;
  misconceptions: string[];
  coverageEvidence: Array<{
    atomId: string;
    coveredFields: string[];
    explanation: string;
  }>;
  questions: Array<{
    kind: "comprehension" | "multiple_choice";
    prompt: string;
    options?: string[];
    expectedAnswer: string;
    explanation: string;
  }>;
}

export interface ModelRouterUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiEquivalentUsd: number | null;
  durationMs: number;
}

export interface TeachingGenerationResult {
  content: TeachingPackage;
  provider: string;
  model: string;
  usage: ModelRouterUsage;
}

export interface ModelRouterInput {
  pageTitle: string;
  pageNumber: number;
  sourceText: string;
  sourceImageDataUrl?: string;
  writingPolicySnapshotId: string;
  language: string;
  qualityMode: string;
  idempotencyKey: string;
  stage?: GenerationStage | "qa";
}

export interface ModelRouterClient {
  generateTeachingPackage(input: ModelRouterInput): Promise<TeachingGenerationResult>;
}

export class ModelRouterGenerationError extends Error {
  readonly provider: string;

  constructor(
    readonly code: string,
    readonly model: string,
    readonly usage: ModelRouterUsage,
    provider = "aialra-model-router"
  ) {
    super(code);
    this.name = "ModelRouterGenerationError";
    this.provider = provider;
  }
}

const teachingPackageSchema = {
  type: "object",
  properties: {
    learningObjectives: { type: "array", minItems: 1, items: { type: "string", minLength: 8 } },
    mainContentMarkdown: { type: "string", minLength: 30 },
    priorKnowledge: { type: "array", minItems: 1, items: { type: "string", minLength: 6 } },
    fullExplanationMarkdown: { type: "string", minLength: 300 },
    misconceptions: { type: "array", minItems: 1, items: { type: "string", minLength: 8 } },
    coverageEvidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          atomId: { type: "string", minLength: 1 },
          coveredFields: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          explanation: { type: "string", minLength: 20 }
        },
        required: ["atomId", "coveredFields", "explanation"],
        additionalProperties: false
      }
    },
    questions: {
      type: "array",
      minItems: 4,
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["comprehension", "multiple_choice"] },
          prompt: { type: "string", minLength: 8 },
          options: { type: "array", minItems: 0, maxItems: 4, items: { type: "string", minLength: 1 } },
          expectedAnswer: { type: "string", minLength: 1 },
          explanation: { type: "string", minLength: 8 }
        },
        required: ["kind", "prompt", "options", "expectedAnswer", "explanation"],
        additionalProperties: false
      }
    }
  },
  required: ["learningObjectives", "mainContentMarkdown", "priorKnowledge", "fullExplanationMarkdown", "misconceptions", "coverageEvidence", "questions"],
  additionalProperties: false
} as const;

export class HttpModelRouterClient implements ModelRouterClient {
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly pollIntervalMs = 2_000) {}

  async generateTeachingPackage(input: ModelRouterInput): Promise<TeachingGenerationResult> {
    const started = Date.now();
    const requestedModel = input.qualityMode === "quality" ? "sol" : "terra";
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey || randomUUID() },
        body: JSON.stringify({
          model: requestedModel,
          reasoning: { effort: input.qualityMode === "quality" ? "high" : "medium" },
          max_output_tokens: input.qualityMode === "economy" ? 5000 : 9000,
          instructions: professorInstructions(input.language),
          input: modelInput(input),
          text: { format: { type: "json_schema", name: "course_os_teaching_package", schema: teachingPackageSchema, strict: true } },
          metadata: { product: "course-os", stage: "professor_draft", writing_policy_snapshot_id: input.writingPolicySnapshotId },
          aialra: { permission_preset: "restricted", deadline_ms: 180000 }
        })
      });
    } catch {
      throw new ModelRouterGenerationError("MODEL_ROUTER_NETWORK_FAILURE", requestedModel, emptyUsage(started));
    }
    let body: RouterResponseBody;
    try {
      body = await response.json() as RouterResponseBody;
    } catch {
      throw new ModelRouterGenerationError("MODEL_ROUTER_INVALID_RESPONSE", requestedModel, emptyUsage(started));
    }
    if (response.status === 202 || body.status === "queued" || body.status === "running") {
      if (!body.id) throw new ModelRouterGenerationError("MODEL_ROUTER_ASYNC_ID_MISSING", body.model || requestedModel, normalizeUsage(body.usage, started));
      body = await this.waitForJob(body.id, requestedModel, started);
    }
    const model = body.model || requestedModel;
    const usage = normalizeUsage(body.usage, started);
    if (!response.ok || body.status !== "succeeded") throw new ModelRouterGenerationError(`MODEL_ROUTER_FAILED:${body.error?.code || response.status}`, model, usage);
    try {
      const content = typeof body.output === "string" ? JSON.parse(body.output) as TeachingPackage : body.output as TeachingPackage;
      validateTeachingPackage(content);
      return { content, provider: "aialra-model-router", model, usage };
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_:-]+$/.test(error.message) ? error.message : "MODEL_ROUTER_INVALID_TEACHING_PACKAGE";
      throw new ModelRouterGenerationError(code, model, usage);
    }
  }

  private async waitForJob(jobId: string, requestedModel: string, started: number): Promise<RouterResponseBody> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/v1/jobs/${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${this.apiKey}` } });
      } catch {
        continue;
      }
      if (!response.ok) continue;
      const job = await response.json() as { status?: string; output?: unknown; errorCode?: string | null; errorMessage?: string | null; usage?: Partial<ModelRouterUsage>; route?: { model?: string } };
      const body: RouterResponseBody = {
        id: jobId,
        status: job.status,
        model: job.route?.model || requestedModel,
        output: job.output,
        error: job.errorCode ? { code: job.errorCode, message: job.errorMessage || undefined } : null,
        usage: job.usage
      };
      if (job.status === "succeeded") return body;
      if (["failed", "cancelled"].includes(job.status || "")) throw new ModelRouterGenerationError(`MODEL_ROUTER_FAILED:${job.errorCode || job.status}`, body.model!, normalizeUsage(job.usage, started));
    }
    throw new ModelRouterGenerationError("MODEL_ROUTER_ASYNC_TIMEOUT", requestedModel, emptyUsage(started));
  }
}

interface RouterResponseBody {
  id?: string;
  status?: string;
  model?: string;
  output?: unknown;
  error?: { code?: string; message?: string } | null;
  usage?: Partial<ModelRouterUsage>;
}

function modelInput(input: { pageTitle: string; pageNumber: number; sourceText: string; sourceImageDataUrl?: string; writingPolicySnapshotId: string }): string | Array<{ role: "user"; content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "high" }> }> {
  const text = `写作策略快照：${input.writingPolicySnapshotId}\n页面编号：${input.pageNumber}\n页面标题：${input.pageTitle}\n\n离线提取的来源内容：\n${input.sourceText.slice(0, 45_000)}\n\n请把原始页面图像作为第一手来源，逐项核对文字、公式、箭头、图表和图片区域；离线文字只用于辅助检索，图像与文字冲突时必须明确标记冲突，不得静默猜测`;
  if (!input.sourceImageDataUrl) return text;
  return [{ role: "user", content: [{ type: "input_text", text }, { type: "input_image", image_url: input.sourceImageDataUrl, detail: "high" }] }];
}

function emptyUsage(started: number): ModelRouterUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, apiEquivalentUsd: null, durationMs: Date.now() - started };
}

function normalizeUsage(usage: Partial<ModelRouterUsage> | undefined, started: number): ModelRouterUsage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    cachedInputTokens: usage?.cachedInputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    apiEquivalentUsd: usage?.apiEquivalentUsd ?? null,
    durationMs: usage?.durationMs ?? Date.now() - started
  };
}

export function modelRouterFromEnvironment(): ModelRouterClient | undefined {
  const baseUrl = process.env.MODEL_ROUTER_URL;
  const apiKey = process.env.MODEL_ROUTER_API_KEY;
  return baseUrl && apiKey ? new HttpModelRouterClient(baseUrl, apiKey) : undefined;
}

export interface ProviderConnection {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: "responses" | "messages" | "chat_completions";
  supportsVision?: boolean;
  billingMode?: "metered" | "subscription_quota" | "free" | "unknown";
}

export async function probeProviderConnection(connection: ProviderConnection): Promise<ProviderHealth> {
  const checkedAt = new Date().toISOString();
  if (!connection.apiKey) return { providerId: connection.providerId, state: "unconfigured", checkedAt, message: "请先保存接口密钥" };
  if (!connection.baseUrl) return { providerId: connection.providerId, state: "degraded", checkedAt, message: "这个供应商没有可检查的公开接口地址" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${connection.baseUrl.replace(/\/$/, "")}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${connection.apiKey}`, Accept: "application/json" },
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403) return { providerId: connection.providerId, state: "offline", checkedAt, message: "接口可以访问，但密钥无效或没有权限" };
    if (!response.ok) return { providerId: connection.providerId, state: "degraded", checkedAt, message: `接口返回 HTTP ${response.status}，请检查地址和供应商状态` };
    return { providerId: connection.providerId, state: "connected", checkedAt, message: "连接正常，已读取供应商模型目录" };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "连接检查超过 8 秒，供应商没有及时响应" : "暂时无法连接供应商接口";
    return { providerId: connection.providerId, state: "offline", checkedAt, message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Small OpenAI-compatible client used by OpenCode Go and DeepSeek
 *
 * The protocol is explicit because these providers expose more than one
 * endpoint and silently switching formats makes failures hard to diagnose
 */
export class HttpProviderTeachingClient implements ModelRouterClient {
  constructor(private readonly connection: ProviderConnection) {}

  async generateTeachingPackage(input: ModelRouterInput): Promise<TeachingGenerationResult> {
    const started = Date.now();
    const request = this.buildRequest(input);
    let response: Response;
    try {
      response = await fetch(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(request.body) });
    } catch {
      throw new ModelRouterGenerationError("MODEL_PROVIDER_NETWORK_FAILURE", this.connection.model, emptyUsage(started), this.connection.providerId);
    }
    let body: ProviderResponseBody = {};
    try { body = await response.json() as ProviderResponseBody; } catch {
      throw new ModelRouterGenerationError("MODEL_PROVIDER_INVALID_RESPONSE", this.connection.model, emptyUsage(started), this.connection.providerId);
    }
    const usage = normalizeProviderUsage(body.usage, body.usage?.cost ?? body.cost, started);
    if (!response.ok) throw new ModelRouterGenerationError(`MODEL_PROVIDER_FAILED:${body.error?.code || response.status}`, body.model || this.connection.model, usage, this.connection.providerId);
    const output = extractProviderOutput(body);
    try {
      const content = typeof output === "string" ? JSON.parse(stripJsonFences(output)) as TeachingPackage : output as TeachingPackage;
      validateTeachingPackage(content);
      return { content, provider: this.connection.providerId, model: body.model || this.connection.model, usage };
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_:-]+$/.test(error.message) ? error.message : "MODEL_PROVIDER_INVALID_TEACHING_PACKAGE";
      throw new ModelRouterGenerationError(code, body.model || this.connection.model, usage, this.connection.providerId);
    }
  }

  private buildRequest(input: ModelRouterInput) {
    const baseUrl = this.connection.baseUrl.replace(/\/$/, "");
    const text = modelInput(input);
    const instruction = professorInstructions(input.language);
    const headers = { Authorization: `Bearer ${this.connection.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey || randomUUID() };
    if (this.connection.protocol === "responses") {
      return {
        url: `${baseUrl}/responses`,
        headers,
        body: {
          model: this.connection.model,
          instructions: instruction,
          input: text,
          max_output_tokens: input.qualityMode === "economy" ? 5000 : 9000,
          temperature: 0.2,
          text: { format: { type: "json_schema", name: "course_os_teaching_package", schema: teachingPackageSchema, strict: true } },
          metadata: { product: "course-os", stage: "professor_draft", writing_policy_snapshot_id: input.writingPolicySnapshotId }
        }
      };
    }
    if (this.connection.protocol === "messages") {
      const content = Array.isArray(text)
        ? text[0]?.content.map((part) => part.type === "input_text" ? { type: "text", text: part.text } : anthropicImagePart(part.image_url))
        : text;
      return {
        url: `${baseUrl}/messages`,
        headers,
        body: {
          model: this.connection.model,
          system: `${instruction}\n\n只输出符合要求的 JSON 对象，不要使用 Markdown 代码围栏或额外说明`,
          max_tokens: input.qualityMode === "economy" ? 5000 : 9000,
          temperature: 0.2,
          messages: [{ role: "user", content }]
        }
      };
    }
    const messages = [
      { role: "system", content: instruction },
      { role: "user", content: Array.isArray(text) ? text[0]?.content.map((part) => part.type === "input_text" ? { type: "text", text: part.text } : { type: "image_url", image_url: { url: part.image_url } }) : text }
    ];
    return { url: `${baseUrl}/chat/completions`, headers, body: { model: this.connection.model, max_tokens: input.qualityMode === "economy" ? 5000 : 9000, temperature: 0.2, messages, response_format: { type: "json_schema", json_schema: { name: "course_os_teaching_package", strict: true, schema: teachingPackageSchema } } } };
  }
}

function anthropicImagePart(imageUrl: string): { type: "image"; source: { type: "base64"; media_type: string; data: string } } {
  const match = imageUrl.match(/^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,(.+)$/i);
  if (!match) throw new Error("MODEL_PROVIDER_IMAGE_FORMAT_UNSUPPORTED");
  return { type: "image", source: { type: "base64", media_type: match[1]!.toLowerCase().replace("jpg", "jpeg"), data: match[2]! } };
}

export class RoutedProviderTeachingClient implements ModelRouterClient {
  constructor(private readonly connections: ProviderConnection[]) {}

  async generateTeachingPackage(input: ModelRouterInput): Promise<TeachingGenerationResult> {
    const candidates = [...this.connections].sort((left, right) => scoreConnection(left, input) - scoreConnection(right, input));
    let lastError: ModelRouterGenerationError | undefined;
    for (const connection of candidates.slice(0, 2)) {
      try { return await new HttpProviderTeachingClient(connection).generateTeachingPackage(input); }
      catch (error) {
        if (!(error instanceof ModelRouterGenerationError)) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new ModelRouterGenerationError("MODEL_PROVIDER_NOT_CONFIGURED", "unconfigured", emptyUsage(Date.now()), "course-os");
  }
}

export interface SettingsProviderSource {
  load: () => Promise<{
    providers: ModelProviderConfig[];
    policy: ModelRoutePolicy;
    credential: (providerId: string) => Promise<string | undefined>;
  }>;
}

/**
 * Resolve the saved workspace route for every job instead of freezing the
 * provider choice at process start. Credentials are fetched only at call time
 * and never enter the browser-facing settings response
 */
export class SettingsProviderTeachingClient implements ModelRouterClient {
  constructor(private readonly source: SettingsProviderSource) {}

  async generateTeachingPackage(input: ModelRouterInput): Promise<TeachingGenerationResult> {
    const { providers, policy, credential } = await this.source.load();
    const stage = input.stage || "teach";
    const rule = policy.rules.find((candidate) => candidate.stage === stage && candidate.enabled)
      || policy.rules.find((candidate) => candidate.stage === "teach" && candidate.enabled);
    if (!rule) throw new ModelRouterGenerationError("MODEL_PROVIDER_ROUTE_NOT_CONFIGURED", "unconfigured", emptyUsage(Date.now()), "course-os");

    const candidates = [
      { providerId: rule.providerId, modelId: rule.modelId },
      ...(rule.fallbackProviderId && rule.fallbackModelId ? [{ providerId: rule.fallbackProviderId, modelId: rule.fallbackModelId }] : [])
    ];
    let lastError: ModelRouterGenerationError | undefined;
    for (const candidate of candidates.slice(0, 2)) {
      const provider = providers.find((item) => item.id === candidate.providerId && item.enabled);
      const model = provider?.models.find((item) => item.id === candidate.modelId);
      const apiKey = provider ? await credential(provider.id) : undefined;
      if (!provider || !model || !apiKey) {
        lastError = new ModelRouterGenerationError("MODEL_PROVIDER_NOT_CONFIGURED", candidate.modelId, emptyUsage(Date.now()), candidate.providerId);
        continue;
      }
      if (input.sourceImageDataUrl && !model.supportsVision) {
        lastError = new ModelRouterGenerationError("MODEL_PROVIDER_VISION_UNAVAILABLE", model.id, emptyUsage(Date.now()), provider.id);
        continue;
      }
      const connection: ProviderConnection = {
        providerId: provider.id,
        baseUrl: provider.baseUrl,
        apiKey,
        model: model.id,
        protocol: model.protocol,
        supportsVision: model.supportsVision,
        billingMode: model.billingMode
      };
      try {
        return await new HttpProviderTeachingClient(connection).generateTeachingPackage(input);
      } catch (error) {
        if (!(error instanceof ModelRouterGenerationError)) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new ModelRouterGenerationError("MODEL_PROVIDER_NOT_CONFIGURED", "unconfigured", emptyUsage(Date.now()), "course-os");
  }
}

export function providerRouterFromSettings(source: SettingsProviderSource): ModelRouterClient {
  return new SettingsProviderTeachingClient(source);
}

export function providerRouterFromEnvironment(): ModelRouterClient | undefined {
  const openCodeKey = process.env.OPENCODE_GO_API_KEY;
  const deepSeekKey = process.env.DEEPSEEK_API_KEY;
  const connections: ProviderConnection[] = [];
  if (openCodeKey) {
    const model = process.env.OPENCODE_GO_MODEL || "qwen3.8-flash";
    connections.push({ providerId: "opencode-go", baseUrl: process.env.OPENCODE_GO_BASE_URL || "https://opencode.ai/zen/go/v1", apiKey: openCodeKey, model, protocol: openCodeProtocol(model), supportsVision: model.includes("vision"), billingMode: "subscription_quota" });
  }
  if (deepSeekKey) {
    const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash-vision-exp";
    connections.push({ providerId: "deepseek", baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com", apiKey: deepSeekKey, model, protocol: "responses", supportsVision: model.includes("vision"), billingMode: "metered" });
  }
  if (!connections.length) return undefined;
  return new RoutedProviderTeachingClient(connections);
}

function scoreConnection(connection: ProviderConnection, input: ModelRouterInput): number {
  if (input.sourceImageDataUrl && !connection.supportsVision) return 100;
  if (input.qualityMode === "economy") return connection.providerId === "opencode-go" ? 0 : 10;
  return connection.providerId === "deepseek" ? 0 : 10;
}

interface ProviderResponseBody {
  id?: string;
  model?: string;
  output?: unknown;
  output_text?: string;
  choices?: Array<{ message?: { content?: string | Array<{ text?: string }> }; text?: string }>;
  content?: Array<{ type?: string; text?: string }>;
  usage?: Partial<ModelRouterUsage> & {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    cost?: number;
    total_cost?: number;
  };
  cost?: number;
  error?: { code?: string; message?: string };
}

function extractProviderOutput(body: ProviderResponseBody): unknown {
  if (typeof body.output_text === "string") return body.output_text;
  if (typeof body.output === "string") return body.output;
  if (Array.isArray(body.output)) {
    const text = body.output.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as { content?: Array<{ text?: string }> };
      return candidate.content?.flatMap((part) => part.text ? [part.text] : []) ?? [];
    }).join("");
    if (text) return text;
  }
  const choice = body.choices?.[0];
  if (typeof choice?.message?.content === "string") return choice.message.content;
  if (Array.isArray(choice?.message?.content)) return choice.message.content.map((part) => part.text || "").join("");
  if (typeof choice?.text === "string") return choice.text;
  if (body.content?.length) return body.content.map((part) => part.text || "").join("");
  return body.output;
}

function normalizeProviderUsage(usage: ProviderResponseBody["usage"], cost: number | undefined, started: number): ModelRouterUsage {
  return {
    inputTokens: usage?.inputTokens ?? usage?.input_tokens ?? usage?.prompt_tokens ?? 0,
    cachedInputTokens: usage?.cachedInputTokens ?? usage?.input_tokens_details?.cached_tokens ?? usage?.cached_tokens ?? 0,
    outputTokens: usage?.outputTokens ?? usage?.output_tokens ?? usage?.completion_tokens ?? 0,
    apiEquivalentUsd: typeof cost === "number" ? cost : typeof usage?.total_cost === "number" ? usage.total_cost : null,
    durationMs: Date.now() - started
  };
}

function openCodeProtocol(model: string): ProviderConnection["protocol"] {
  return model === "qwen3.8-flash" ? "messages" : "chat_completions";
}

function stripJsonFences(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function professorInstructions(language: string): string {
  return `你是教学水平极高但说话清楚的教授，请把单页课件编译成${language === "en" ? "English" : "简体中文"}教学内容

必须说明概念是什么、为什么需要、解决什么问题，并逐项解释页面中的文字、公式、变量、图形和箭头
数学要给符号表、代入过程、推导步骤和结果含义
代码和伪代码要逐行说明读取对象、修改对象、执行前状态、执行后状态和副作用
图表要说明坐标轴、单位、图例、序列、趋势、限制和能支持的结论
图片要区分观察事实与推断，不得捏造页面没有提供的信息
来源内容中会列出页面原子和覆盖要求；coverageEvidence 必须逐个使用原始 atomId，coveredFields 只能填写讲解中确实解释过的字段，explanation 必须给出对应解释，不得为了通过检查虚报覆盖
完整讲解至少包含一个可复算或复现的例子，以及前提、特殊情况和失败条件
先验知识和易错点中的每个数组项只表达一个完整意思
生成 2 道理解题和 2 道选择题，理解题的 options 必须是空数组，选择题必须有 4 个选项，expectedAnswer 必须与其中一个选项完全一致
只返回符合给定 JSON Schema 的对象`;
}

function validateTeachingPackage(value: TeachingPackage): void {
  if (!value || !Array.isArray(value.learningObjectives) || !Array.isArray(value.questions) || value.questions.length < 4 || value.fullExplanationMarkdown.length < 300) throw new Error("MODEL_ROUTER_INVALID_TEACHING_PACKAGE");
  const comprehension = value.questions.filter((item) => item.kind === "comprehension").length;
  const choices = value.questions.filter((item) => item.kind === "multiple_choice").length;
  if (comprehension < 2 || choices < 2) throw new Error("MODEL_ROUTER_QUESTION_MIX_INVALID");
  for (const item of value.questions.filter((candidate) => candidate.kind === "multiple_choice")) if (!item.options || item.options.length !== 4 || !item.options.includes(item.expectedAnswer)) throw new Error("MODEL_ROUTER_CHOICE_INVALID");
}
