import { teachingCompositionContract } from "@course-os/quality";
import { randomUUID } from "node:crypto";
import type { GenerationStage, ModelProviderConfig, ModelRoutePolicy, ProviderHealth, TeachingBlueprint } from "@course-os/contracts";
import { modelInput, professorInstructions, semanticAuditPrompt, semanticAuditSchema, teachingPackageSchema } from "./generation-harness.js";
import { estimateMicrousd, priceSnapshotFor } from "./pricing.js";
export { currentGenerationHarness, modelInput, professorInstructions, teachingBlueprint, teachingPackageSchema, teachingSystemPromptTemplate, teachingUserPromptTemplate } from "./generation-harness.js";

export interface TeachingPackage {
  chapterBridgeMarkdown?: string;
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
  schemaRetries?: number;
}

export interface ModelRouterInput {
  pageTitle: string;
  pageNumber: number;
  sourceText: string;
  previousPageContext?: string;
  sourceImageDataUrl?: string;
  writingPolicySnapshotId: string;
  language: string;
  qualityMode: string;
  idempotencyKey: string;
  maxCostUsd?: number;
  stage?: GenerationStage | "qa";
  blueprint?: TeachingBlueprint;
  repair?: {
    issues: string[];
    maximumExplanationCharacters: number;
    previousTeachingPackage: TeachingPackage;
  };
}

export interface ModelRouterClient {
  generateTeachingPackage(input: ModelRouterInput): Promise<TeachingGenerationResult>;
  repairTeachingFields?(input: ModelRouterInput, fields: Array<keyof TeachingPackage>): Promise<TeachingGenerationResult>;
  auditTeachingPackage?(input: ModelRouterInput & { teachingPackage: TeachingPackage }): Promise<SemanticAuditResult>;
}

export interface SemanticAuditResult {
  teachingChecks?: Array<{ criterion: string; evidence: string; verdict: "supported" | "contradicted" | "unverified" }>;
  findings: Array<{ field: string; original: string; replacement: string; evidence: string }>;
  sourceChecks?: Array<{ claim: string; evidence: string; verdict: "supported" | "contradicted" | "unverified" }>;
  provider: string;
  model: string;
  usage: ModelRouterUsage;
}

export function teachingOutputTokenLimit(qualityMode: string): number {
  // DeepSeek defaults to high-effort thinking. The teaching response is a
  // bounded JSON page, so reserve only the final answer and fail explicitly
  // if a page cannot fit instead of silently spending on hidden reasoning.
  return qualityMode === "economy" ? 4_000 : qualityMode === "quality" ? 8_000 : 6_000;
}

function providerTeachingOutputTokenLimit(connection: ProviderConnection, qualityMode: string): number {
  if (connection.providerId !== "opencode-go" || connection.protocol !== "chat_completions") {
    return teachingOutputTokenLimit(qualityMode);
  }
  // DeepSeek chat requests explicitly disable hidden reasoning, so reserve only
  // the teaching JSON allowance. Other chat models keep their existing allowance.
  if (/^deepseek-/.test(connection.model)) return teachingOutputTokenLimit(qualityMode);
  return qualityMode === "economy" ? 8_000 : qualityMode === "quality" ? 16_000 : 12_000;
}

export class ModelRouterGenerationError extends Error {
  readonly provider: string;

  constructor(
    readonly code: string,
    readonly model: string,
    readonly usage: ModelRouterUsage,
    provider = "aialra-model-router",
    readonly responseShape?: string,
    readonly partialContent?: TeachingPackage
  ) {
    super(code);
    this.name = "ModelRouterGenerationError";
    this.provider = provider;
  }
}

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
          max_output_tokens: teachingOutputTokenLimit(input.qualityMode),
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

function sumProviderUsage(first: ModelRouterUsage, second: ModelRouterUsage): ModelRouterUsage {
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    cachedInputTokens: first.cachedInputTokens + second.cachedInputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    apiEquivalentUsd: first.apiEquivalentUsd !== null && second.apiEquivalentUsd !== null
      ? first.apiEquivalentUsd + second.apiEquivalentUsd : null,
    durationMs: first.durationMs + second.durationMs
  };
}

function describeTeachingResponseShape(value: unknown): string {
  const shape = (item: unknown): string => Array.isArray(item)
    ? `array:${item.length}:${item.length ? typeof item[0] : "empty"}`
    : item === null ? "null" : typeof item;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `root=${shape(value)}`;
  const record = value as Record<string, unknown>;
  const fields = ["chapterBridgeMarkdown", "learningObjectives", "priorKnowledge", "fullExplanationMarkdown", "mainContentMarkdown", "misconceptions", "coverageEvidence", "questions"]
    .map((key) => `${key}=${Object.hasOwn(record, key) ? shape(record[key]) : "missing"}`);
  const wrappers = ["teachingPackage", "package", "content", "result", "data"]
    .filter((key) => Object.hasOwn(record, key));
  return `root=object;${fields.join(";")};keys=${Object.keys(record).join(",")};wrappers=${wrappers.join(",") || "none"}`;
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

function providerRequestHeaders(connection: ProviderConnection, input: ModelRouterInput, idempotencyKey = input.idempotencyKey || randomUUID()): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${connection.apiKey}`,
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey
  };
  if (connection.providerId === "opencode-go") {
    // Keep one provider session across a page job and its field repairs;
    // each individual request still retains its own idempotency key.
    headers["x-opencode-session"] = (input.idempotencyKey || idempotencyKey).split(":attempt:")[0]!.split(":field:")[0]!;
    headers["x-opencode-request"] = idempotencyKey;
    headers["x-opencode-client"] = "course-os";
    headers["User-Agent"] = "course-os/2.4.0";
  }
  return headers;
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
  constructor(
    private readonly connection: ProviderConnection,
    private readonly requestTimeoutMs = 180_000,
    private readonly requestAbsoluteTimeoutMs = 12 * 60_000
  ) {}

  private async requestJson(url: string, init: RequestInit, started: number): Promise<{ response: Response; body: ProviderResponseBody }> {
    const controller = new AbortController();
    let idleTimeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const absoluteTimeout = setTimeout(() => controller.abort(), Math.max(this.requestTimeoutMs, this.requestAbsoluteTimeoutMs));
    const refreshIdleTimeout = () => {
      clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    };
    try {
      const rawBody = this.connection.providerId === "opencode-go" && /^deepseek-/.test(this.connection.model)
        && this.connection.protocol === "chat_completions" && typeof init.body === "string"
        ? JSON.stringify({ ...JSON.parse(init.body), thinking: { type: "disabled" } })
        : init.body;
      const useResponsesStream = ["deepseek", "opencode-go"].includes(this.connection.providerId) && this.connection.protocol === "responses"
        && typeof rawBody === "string";
      const requestBody = useResponsesStream
        ? JSON.stringify({ ...(JSON.parse(rawBody as string) as Record<string, unknown>), stream: true })
        : rawBody;
      const response = await fetch(url, {
        ...init,
        body: requestBody,
        headers: useResponsesStream ? { ...Object.fromEntries(new Headers(init.headers).entries()), Accept: "text/event-stream" } : init.headers,
        signal: controller.signal
      });
      refreshIdleTimeout();
      let body: ProviderResponseBody;
      try {
        const contentType = response.headers?.get("content-type") || "";
        body = useResponsesStream && response.body && !contentType.includes("application/json")
          ? await readResponsesEventStream(response.body, refreshIdleTimeout)
          : await response.json() as ProviderResponseBody;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new ModelRouterGenerationError("MODEL_PROVIDER_TIMEOUT", this.connection.model, emptyUsage(started), this.connection.providerId);
        }
        throw new ModelRouterGenerationError("MODEL_PROVIDER_INVALID_RESPONSE", this.connection.model, emptyUsage(started), this.connection.providerId);
      }
      return { response, body };
    } catch (error) {
      if (error instanceof ModelRouterGenerationError) throw error;
      throw new ModelRouterGenerationError(error instanceof Error && error.name === "AbortError"
        ? "MODEL_PROVIDER_TIMEOUT" : "MODEL_PROVIDER_NETWORK_FAILURE",
      this.connection.model, emptyUsage(started), this.connection.providerId);
    } finally {
      clearTimeout(idleTimeout);
      clearTimeout(absoluteTimeout);
    }
  }

  async repairTeachingFields(input: ModelRouterInput, fields: Array<keyof TeachingPackage>): Promise<TeachingGenerationResult> {
    if (!["responses", "chat_completions"].includes(this.connection.protocol || "") || !input.repair?.previousTeachingPackage || fields.length === 0) {
      return this.generateTeachingPackage(input);
    }
    if (fields.length > 1) {
      // Finish the prose first; evidence must quote the final text, never a
      // simultaneously rewritten explanation. Each call sees one field contract.
      const ordered = [...fields.filter(field => field !== "coverageEvidence"), ...fields.filter(field => field === "coverageEvidence")];
      let content = input.repair.previousTeachingPackage;
      let usage = emptyUsage(Date.now());
      let model = this.connection.model;
      let completedCalls = 0;
      for (const field of ordered) {
        const spent = usage.inputTokens === 0 && usage.outputTokens === 0 ? 0 : this.usageCostUsd(usage);
        if (input.maxCostUsd !== undefined && (spent === undefined || spent >= input.maxCostUsd)) {
          throw new ModelRouterGenerationError("MODEL_PROVIDER_PAGE_BUDGET_EXCEEDED", model, usage, this.connection.providerId);
        }
        try {
          const result = await this.repairTeachingFields({ ...input,
            idempotencyKey: `${input.idempotencyKey}:field:${field}`,
            maxCostUsd: input.maxCostUsd === undefined ? undefined : input.maxCostUsd - (spent ?? 0),
            repair: { ...input.repair, previousTeachingPackage: content }
          }, [field]);
          content = result.content; model = result.model; usage = completedCalls++ === 0 ? result.usage : sumProviderUsage(usage, result.usage);
        } catch (error) {
          if (!(error instanceof ModelRouterGenerationError)) throw error;
          throw new ModelRouterGenerationError(error.code, error.model, completedCalls === 0 ? error.usage : sumProviderUsage(usage, error.usage), error.provider, error.responseShape);
        }
      }
      return { content, provider: this.connection.providerId, model, usage };
    }
    const started = Date.now();
    const previous = input.repair.previousTeachingPackage;
    const properties = structuredClone(teachingPackageSchema.properties) as Record<string, unknown>;
    const evidenceSpans = fields.includes("coverageEvidence")
      ? Object.fromEntries(previous.fullExplanationMarkdown.split(/\r?\n/).map(line => line.trim())
        .filter(line => !/^#{1,6}\s/.test(line) && line.replace(/[`*_#\s]/g, "").length >= 12)
        .map((text, index) => [`excerpt:${String(index + 1).padStart(5,"0")}`, text.slice(0,400)])) : {};
    if (fields.includes("coverageEvidence")) {
      if (!Object.keys(evidenceSpans).length) throw new ModelRouterGenerationError("MODEL_PROVIDER_FIELD_REPAIR_INVALID", this.connection.model, emptyUsage(started), this.connection.providerId);
      const coverageSchema = properties.coverageEvidence as { items: { properties: Record<string,unknown> } };
      coverageSchema.items.properties.explanation = { type: "string", enum: Object.keys(evidenceSpans) };
    }
    const schema = { type: "object", properties: Object.fromEntries(fields.map((field) => [field, properties[field]])), required: fields, additionalProperties: false };
    const coverageQuoteInstruction = fields.includes("fullExplanationMarkdown")
      ? "修复 coverageEvidence 时，每条 explanation 必须逐字摘取本次同一 JSON 返回的 fullExplanationMarkdown 中连续至少 12 个字符；先写定完整讲解，再填写覆盖证据，不得引用旧草稿或自行改写摘录"
      : "修复 coverageEvidence 时，每条 explanation 必须逐字摘取 explanationContext 中连续至少 12 个字符，不得引用旧草稿或自行改写摘录";
    const prompt = JSON.stringify({
      pageTitle: input.pageTitle, pageNumber: input.pageNumber, sourceText: input.sourceText.slice(0, 6_000),
      previousPageContext: input.previousPageContext?.slice(0, 800),
      issues: input.repair.issues, fields,
      compositionContract: Object.fromEntries(fields.filter(field => field in teachingCompositionContract).map(field => [field, teachingCompositionContract[field as keyof typeof teachingCompositionContract]])),
      evidenceSpans: fields.includes("coverageEvidence") ? evidenceSpans : undefined,
      maximumExplanationCharacters: input.repair.maximumExplanationCharacters,
      existingFields: Object.fromEntries(fields.map((field) => [field, previous[field]])),
      explanationContext: fields.includes("fullExplanationMarkdown") ? undefined : previous.fullExplanationMarkdown.slice(0, fields.includes("coverageEvidence") ? 12_000 : 2_500),
      coverageAtomIds: input.blueprint?.resourcePackage.atomIds,
      coverageRequirements: input.blueprint?.requirementPackage.requirements.map((item) => ({
        atomId: item.atomId, requiredFields: item.requiredFields
      }))
    });
    const content = input.sourceImageDataUrl
      ? [{ role: "user", content: [{ type: "input_text", text: prompt }, { type: "input_image", image_url: input.sourceImageDataUrl }] }]
      : prompt;
    const responseRequest = { model: this.connection.model,
          instructions: `${professorInstructions(input.language)}\n\n只修复指定字段，只返回这些字段的 JSON，不重写其他字段，不增添来源没有给出的事实。${fields.includes("coverageEvidence") ? "从 evidenceSpans 选择真正解释对应来源对象的片段编号，explanation 只填 excerpt: 编号，不自行摘录、拼接或改写正文。" : coverageQuoteInstruction}；atomId 和 coveredFields 也须与来源及正文一致。完整讲解的覆盖原句不得丢失；先验知识逐项保持单冒号和三至五个完整分句。若修复完整讲解，字符数必须严格低于输入中的 maximumExplanationCharacters，删除页码、页脚与版式点评，只保留有效教学内容；原图中的英文标签可以逐字加引号保留，普通英文必须依照写作策略配中文。英文缩写首次出现时写出中文名称、英文全称与缩写，后文优先使用中文，英文或缩写每次出现仍需中英文配对。若问题涉及符号权重和结果变化方向，必须写清权重符号与其他输入固定的条件；来源未给条件时不能写无条件单调结论。\n本次成文要求：${fields.map(field => teachingCompositionContract[field as keyof typeof teachingCompositionContract] || "只绑定真实来源对象与正文片段").join("\n")}\n${fields.includes("questions") ? "题库修复必须删除无助于理解的原文英文复述，改用准确中文表达；不要把已能准确用中文表达的原文标签再次作为题目解释中的普通英文。只有程序标识、数学变量或题目确实要求辨认的原始对象才保留原样，并在对象外用中文解释。理解题的 expectedAnswer 若含独立比较项，必须直接写成多行 Markdown 列表；不能只给 explanation 换行而漏掉标准答案。" : ""}`,
          input: content, max_output_tokens: fields.includes("fullExplanationMarkdown") ? 4_500 : 2_500,
          ...(this.connection.providerId === "deepseek" ? { reasoning: { effort: "none" } }
            : this.connection.providerId === "opencode-go" ? { reasoning: { effort: "medium" } }
            : { temperature: 0.2 }),
          text: { format: { type: "json_schema", name: "course_os_teaching_field_repair", schema, strict: true } },
          metadata: { product: "course-os", stage: "repair", writing_policy_snapshot_id: input.writingPolicySnapshotId }
        };
    const chat = this.connection.protocol === "chat_completions";
    const requestBody = chat ? {
      model: this.connection.model,
      max_tokens: providerTeachingOutputTokenLimit(this.connection, input.qualityMode),
      temperature: 0.2,
      messages: [
        { role: "system", content: `${responseRequest.instructions}\n只返回这些字段，输出结构：${JSON.stringify(schema)}` },
        { role: "user", content: input.sourceImageDataUrl
          ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: input.sourceImageDataUrl } }]
          : prompt }
      ]
    } : responseRequest;
    const { response, body } = await this.requestJson(`${this.connection.baseUrl.replace(/\/$/, "")}/${chat ? "chat/completions" : "responses"}`, {
      method: "POST", headers: providerRequestHeaders(this.connection, input, `${input.idempotencyKey}:fields`),
      body: JSON.stringify(requestBody)
    }, started);
    const usage = normalizeProviderUsage(body.usage, body.usage?.cost ?? body.cost, started);
    const model = body.model || this.connection.model;
    if (!response.ok || providerBodyFailed(body)) throw new ModelRouterGenerationError(providerFailureCode(response.status, providerBodyError(body)), model, usage, this.connection.providerId);
    const spent = this.usageCostUsd(usage);
    if (input.maxCostUsd !== undefined && (spent === undefined || spent > input.maxCostUsd)) {
      throw new ModelRouterGenerationError(spent === undefined ? "MODEL_PROVIDER_COST_UNAVAILABLE" : "MODEL_PROVIDER_PAGE_BUDGET_EXCEEDED", model, usage, this.connection.providerId);
    }
    let partial: Record<string, unknown>;
    try {
      const output = extractProviderOutput(body);
      partial = (typeof output === "string" ? parseProviderJson(output) : output) as Record<string, unknown>;
    } catch { throw new ModelRouterGenerationError("MODEL_PROVIDER_FIELD_REPAIR_JSON_INVALID", model, usage, this.connection.providerId); }
    if (!partial || typeof partial !== "object" || fields.some((field) => !(field in partial))) {
      throw new ModelRouterGenerationError("MODEL_PROVIDER_FIELD_REPAIR_INCOMPLETE", model, usage, this.connection.providerId);
    }
    if (fields.includes("coverageEvidence") && Array.isArray(partial.coverageEvidence)) {
      partial.coverageEvidence = partial.coverageEvidence.map(item => {
        const excerpt = evidenceSpans[item.explanation];
        if (excerpt) return { ...item, explanation: excerpt };
        // Accept an already exact quote for compatible providers, never fuzzy similarity.
        if (item.explanation.replace(/[`*_#\s]/g," ").trim().length >= 12 && previous.fullExplanationMarkdown.includes(item.explanation)) return item;
        throw new ModelRouterGenerationError("MODEL_PROVIDER_FIELD_REPAIR_INVALID", model, usage, this.connection.providerId);
      });
    }
    const repaired = normalizeTeachingPackageShape({ ...previous, ...Object.fromEntries(fields.map((field) => [field, partial[field]])) } as TeachingPackage);
    try { validateTeachingPackage(repaired); }
    catch { throw new ModelRouterGenerationError("MODEL_PROVIDER_FIELD_REPAIR_INVALID", model, usage, this.connection.providerId); }
    return { content: repaired, provider: this.connection.providerId, model, usage };
  }

  async auditTeachingPackage(input: ModelRouterInput & { teachingPackage: TeachingPackage }): Promise<SemanticAuditResult> {
    try {
      return await this.auditTeachingOnce(input);
    } catch (error) {
      if (!(error instanceof ModelRouterGenerationError) || error.code !== "MODEL_PROVIDER_SEMANTIC_AUDIT_INVALID") throw error;
      const spent = this.usageCostUsd(error.usage);
      if (input.maxCostUsd !== undefined && (spent === undefined || spent >= input.maxCostUsd)) throw error;
      try {
        const retry = await this.auditTeachingOnce({ ...input, idempotencyKey: `${input.idempotencyKey}:invalid-retry`,
          maxCostUsd: input.maxCostUsd === undefined ? undefined : input.maxCostUsd - (spent ?? 0) }, true);
        return { ...retry, usage: sumProviderUsage(error.usage, retry.usage) };
      } catch (retryError) {
        if (!(retryError instanceof ModelRouterGenerationError)) throw retryError;
        throw new ModelRouterGenerationError(retryError.code, retryError.model,
          sumProviderUsage(error.usage, retryError.usage), retryError.provider, retryError.responseShape);
      }
    }
  }

  private async auditTeachingOnce(input: ModelRouterInput & { teachingPackage: TeachingPackage }, unresolvedRetry = false): Promise<SemanticAuditResult> {
    const started = Date.now();
    const prompt = `${semanticAuditPrompt.trim()}\n输出结构：${JSON.stringify(semanticAuditSchema)}${unresolvedRetry ? "\n\n上次核验标记了矛盾或无法确认，却没有给出可执行的最小修正。这次须逐项重新核对原图；能证实错误时给出确实存在于教学字段中的 original 和有来源依据的 replacement，无法确认时保持 unverified，绝不能为通过检查编造修正。" : ""}\n\n${JSON.stringify({ pageTitle: input.pageTitle, pageNumber: input.pageNumber,
      sourceText: input.sourceText.slice(0, 14_000), sourceAtoms: input.blueprint?.resourcePackage,
      detectedIssues: input.repair?.issues, teachingPackage: input.teachingPackage })}`;
    const auditSchema = structuredClone(semanticAuditSchema) as { properties: { sourceChecks: { minItems: number } } };
    if (input.blueprint?.resourcePackage.pageKind === "diagram") auditSchema.properties.sourceChecks.minItems = 3;
    const userInput = input.sourceImageDataUrl
      ? [{ role: "user", content: [{ type: "input_text", text: prompt }, { type: "input_image", image_url: input.sourceImageDataUrl }] }]
      : prompt;
    const baseUrl = this.connection.baseUrl.replace(/\/$/, "");
    const chatRequiresLocalSchemaValidation = this.connection.providerId === "opencode-go";
    const request = this.connection.protocol === "responses" ? {
      url: `${baseUrl}/responses`,
      body: { model: this.connection.model, instructions: "你是严格的课程事实核验员。只返回符合 JSON Schema 的对象，不添加正文。", input: userInput,
        max_output_tokens: 4_500, ...(this.connection.providerId === "deepseek" ? { reasoning: { effort: "none" } }
          : this.connection.providerId === "opencode-go" ? { reasoning: { effort: "low" } }
          : { temperature: 0 }),
        text: { format: { type: "json_schema", name: "course_os_semantic_audit", schema: auditSchema, strict: true } },
        metadata: { product: "course-os", stage: "semantic_audit", writing_policy_snapshot_id: input.writingPolicySnapshotId }
      }
    } : this.connection.protocol === "chat_completions" ? {
      url: `${baseUrl}/chat/completions`,
      body: { model: this.connection.model, max_tokens: chatRequiresLocalSchemaValidation ? 8_000 : 4_500, temperature: 0,
        messages: [
          { role: "system", content: chatRequiresLocalSchemaValidation
            ? "你是严格的课程事实核验员。只返回一个合法 JSON 对象，不使用 Markdown 代码围栏，不添加正文。返回结果仍会由 Course OS 按 JSON Schema 严格校验。"
            : "你是严格的课程事实核验员。只返回符合 JSON Schema 的对象，不添加正文。" },
          { role: "user", content: input.sourceImageDataUrl
            ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: input.sourceImageDataUrl } }]
            : prompt }
        ],
        ...(chatRequiresLocalSchemaValidation ? {} : {
          response_format: { type: "json_schema", json_schema: { name: "course_os_semantic_audit", schema: auditSchema, strict: true } }
        })
      }
    } : undefined;
    if (!request) throw new ModelRouterGenerationError("MODEL_PROVIDER_SEMANTIC_AUDIT_UNSUPPORTED", this.connection.model, emptyUsage(started), this.connection.providerId);
    const { response, body } = await this.requestJson(request.url, {
        method: "POST",
        headers: providerRequestHeaders(this.connection, input),
        body: JSON.stringify(request.body)
      }, started);
    const usage = normalizeProviderUsage(body.usage, body.usage?.cost ?? body.cost, started);
    const model = body.model || this.connection.model;
    if (!response.ok || providerBodyFailed(body)) throw new ModelRouterGenerationError(providerFailureCode(response.status, providerBodyError(body)), model, usage, this.connection.providerId);
    const spent = this.usageCostUsd(usage);
    if (input.maxCostUsd !== undefined && (spent === undefined || spent > input.maxCostUsd)) throw new ModelRouterGenerationError(spent === undefined ? "MODEL_PROVIDER_COST_UNAVAILABLE" : "MODEL_PROVIDER_PAGE_BUDGET_EXCEEDED", model, usage, this.connection.providerId);
    let parsed: unknown;
    const invalidAudit = (reason: string): never => {
      throw new ModelRouterGenerationError("MODEL_PROVIDER_SEMANTIC_AUDIT_INVALID", model, usage, this.connection.providerId,
        `${reason}:output_tokens=${usage.outputTokens}`);
    };
    try { const output = extractProviderOutput(body); parsed = typeof output === "string" ? parseProviderJson(output) : output; }
    catch { return invalidAudit("json_unparseable"); }
    const findings = (parsed as { findings?: unknown } | null)?.findings;
    const sourceChecks = (parsed as { sourceChecks?: unknown } | null)?.sourceChecks;
    if (!Array.isArray(findings)) return invalidAudit("findings_missing");
    if (findings.length > 12 || findings.some((item) => !item || typeof item !== "object" ||
      ["field", "original", "replacement", "evidence"].some((field) => typeof item[field] !== "string"))) return invalidAudit(`findings_shape:${findings.length}`);
    if (!Array.isArray(sourceChecks)) return invalidAudit("source_checks_missing");
    if (sourceChecks.length < auditSchema.properties.sourceChecks.minItems) return invalidAudit(`source_checks_too_few:${sourceChecks.length}`);
    if (sourceChecks.length > 24 || sourceChecks.some((item) => !item || typeof item !== "object"
      || typeof item.claim !== "string" || !item.claim.trim() || typeof item.evidence !== "string" || !item.evidence.trim()
      || !["supported", "contradicted", "unverified"].includes(item.verdict))) return invalidAudit(`source_checks_shape:${sourceChecks.length}`);
    const teachingChecks = (parsed as SemanticAuditResult).teachingChecks;
    const criteria = ["entry", "terms", "prerequisites", "structure", "objects", "reasoning", "questions"];
    if (input.blueprint || teachingChecks !== undefined) {
      if (!Array.isArray(teachingChecks) || teachingChecks.length !== criteria.length
        || new Set(teachingChecks.map(check => check.criterion)).size !== criteria.length
        || teachingChecks.some(check => !criteria.includes(check.criterion) || typeof check.evidence !== "string" || check.evidence.trim().length < 12
          || !["supported", "contradicted", "unverified"].includes(check.verdict))) return invalidAudit("teaching_checks_incomplete");
      if (teachingChecks.some(check => check.verdict !== "supported") && findings.length === 0) return invalidAudit("teaching_findings_missing");
    }
    return { findings, sourceChecks, teachingChecks, provider: this.connection.providerId, model, usage };
  }

  async generateTeachingPackage(input: ModelRouterInput): Promise<TeachingGenerationResult> {
    let firstFailure: ModelRouterGenerationError;
    try {
      return await this.generateOnce(input);
    } catch (error) {
      if (!(error instanceof ModelRouterGenerationError) || !isTeachingShapeError(error.code)) throw error;
      firstFailure = error;
    }
    if (input.maxCostUsd !== undefined) {
      const spent = this.usageCostUsd(firstFailure.usage);
      if (spent === undefined || spent >= input.maxCostUsd) throw firstFailure;
      input = { ...input, maxCostUsd: input.maxCostUsd - spent };
    }
    const missingTail = this.connection.protocol === "responses" ? missingTeachingTailFields(firstFailure.partialContent) : [];
    if (missingTail.length > 0 && firstFailure.partialContent) {
      try {
        const recovered = await this.generateMissingTeachingTail(input, firstFailure.partialContent, missingTail);
        return { ...recovered, usage: sumProviderUsage(firstFailure.usage, recovered.usage), schemaRetries: 1 };
      } catch (error) {
        if (!(error instanceof ModelRouterGenerationError)) throw error;
        throw new ModelRouterGenerationError(error.code, error.model, sumProviderUsage(firstFailure.usage, error.usage), error.provider, error.responseShape);
      }
    }
    try {
      const recovered = await this.generateOnce({ ...input, idempotencyKey: `${input.idempotencyKey}:schema-retry` }, firstFailure.code);
      return { ...recovered, usage: sumProviderUsage(firstFailure.usage, recovered.usage), schemaRetries: 1 };
    } catch (error) {
      if (!(error instanceof ModelRouterGenerationError)) throw error;
      throw new ModelRouterGenerationError(error.code, error.model, sumProviderUsage(firstFailure.usage, error.usage), error.provider, error.responseShape);
    }
  }

  private async generateOnce(input: ModelRouterInput, previousShapeError?: string): Promise<TeachingGenerationResult> {
    const started = Date.now();
    const request = this.buildRequest(input, previousShapeError);
    const { response, body } = await this.requestJson(request.url,
      { method: "POST", headers: request.headers, body: JSON.stringify(request.body) }, started);
    const usage = normalizeProviderUsage(body.usage, body.usage?.cost ?? body.cost, started);
    if (!response.ok || providerBodyFailed(body)) throw new ModelRouterGenerationError(providerFailureCode(response.status, providerBodyError(body)), body.model || this.connection.model, usage, this.connection.providerId);
    if (input.maxCostUsd !== undefined) {
      const spent = this.usageCostUsd(usage);
      if (spent === undefined) throw new ModelRouterGenerationError("MODEL_PROVIDER_COST_UNAVAILABLE", body.model || this.connection.model, usage, this.connection.providerId);
      if (spent > input.maxCostUsd) throw new ModelRouterGenerationError("MODEL_PROVIDER_PAGE_BUDGET_EXCEEDED", body.model || this.connection.model, usage, this.connection.providerId);
    }
    const output = extractProviderOutput(body);
    if (output === undefined || output === null) throw new ModelRouterGenerationError("MODEL_PROVIDER_OUTPUT_MISSING", body.model || this.connection.model, usage, this.connection.providerId);
    let content: TeachingPackage;
    if (typeof output === "string") {
      try { content = parseTeachingPackageJson(output); }
      catch { throw new ModelRouterGenerationError("MODEL_PROVIDER_OUTPUT_JSON_INVALID", body.model || this.connection.model, usage, this.connection.providerId); }
    } else {
      content = output as TeachingPackage;
    }
    content = normalizeTeachingPackageShape(content);
    try {
      validateTeachingPackage(content);
      return { content, provider: this.connection.providerId, model: body.model || this.connection.model, usage };
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_:-]+$/.test(error.message) ? error.message : "MODEL_PROVIDER_INVALID_TEACHING_PACKAGE";
      throw new ModelRouterGenerationError(code, body.model || this.connection.model, usage, this.connection.providerId, describeTeachingResponseShape(content), content);
    }
  }

  private async generateMissingTeachingTail(input: ModelRouterInput, partial: TeachingPackage, missing: TeachingTailField[]): Promise<TeachingGenerationResult> {
    const started = Date.now();
    const schemaProperties = teachingPackageSchema.properties as Record<string, unknown>;
    const refillSchema = { type: "object", properties: Object.fromEntries(missing.map((field) => [field, schemaProperties[field]])), required: missing, additionalProperties: false };
    const onlyQuestions = missing.length === 1 && missing[0] === "questions";
    const stage = onlyQuestions ? "question_refill" : "teaching_tail_refill";
    const refillContext = {
      title: input.pageTitle,
      sourceText: onlyQuestions ? undefined : input.sourceText.slice(0, 12_000),
      explanation: partial.fullExplanationMarkdown,
      summary: partial.mainContentMarkdown,
      misconceptions: missing.includes("misconceptions") ? undefined : partial.misconceptions,
      atomIds: input.blueprint?.resourcePackage.atomIds,
      requirements: input.blueprint?.requirementPackage.requirements
    };
    const { response, body } = await this.requestJson(`${this.connection.baseUrl.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: providerRequestHeaders(this.connection, input, `${input.idempotencyKey}:${stage}`),
        body: JSON.stringify({
          model: this.connection.model,
          instructions: professorInstructions(input.language),
          input: `第 ${input.pageNumber} 页的讲解已经写好，只补齐缺失的 ${missing.join("、")} 字段，不重写已有字段，不引入讲解或来源没有解释的事实。题目须恰好两道理解题和两道四选一选择题；覆盖证据只能使用给定 atomId，且必须摘录已有讲解中的连续原文。只返回包含这些缺失字段的 JSON 对象。\n\n${JSON.stringify(refillContext)}`,
          max_output_tokens: onlyQuestions ? 2_000 : 4_000,
          reasoning: { effort: this.connection.providerId === "opencode-go" ? "low" : "none" },
          text: { format: { type: "json_schema", name: `course_os_${stage}`, schema: refillSchema, strict: true } },
          metadata: { product: "course-os", stage, writing_policy_snapshot_id: input.writingPolicySnapshotId }
        })
      }, started);
    const usage = normalizeProviderUsage(body.usage, body.usage?.cost ?? body.cost, started);
    if (!response.ok || providerBodyFailed(body)) throw new ModelRouterGenerationError(providerFailureCode(response.status, providerBodyError(body)), body.model || this.connection.model, usage, this.connection.providerId);
    const spent = this.usageCostUsd(usage);
    if (input.maxCostUsd !== undefined && (spent === undefined || spent > input.maxCostUsd)) throw new ModelRouterGenerationError(spent === undefined ? "MODEL_PROVIDER_COST_UNAVAILABLE" : "MODEL_PROVIDER_PAGE_BUDGET_EXCEEDED", body.model || this.connection.model, usage, this.connection.providerId);
    const output = extractProviderOutput(body);
    let parsed: Partial<TeachingPackage>;
    try { parsed = (typeof output === "string" ? JSON.parse(output) : output) as Partial<TeachingPackage>; }
    catch { throw new ModelRouterGenerationError("MODEL_PROVIDER_OUTPUT_JSON_INVALID", body.model || this.connection.model, usage, this.connection.providerId); }
    const content = normalizeTeachingPackageShape({ ...partial, ...Object.fromEntries(missing.map((field) => [field, parsed?.[field]])) } as TeachingPackage);
    try { validateTeachingPackage(content); }
    catch { throw new ModelRouterGenerationError(onlyQuestions ? "MODEL_PROVIDER_QUESTIONS_INVALID" : "MODEL_PROVIDER_TEACHING_TAIL_INVALID", body.model || this.connection.model, usage, this.connection.providerId, describeTeachingResponseShape(content)); }
    return { content, provider: this.connection.providerId, model: body.model || this.connection.model, usage };
  }

  private usageCostUsd(usage: ModelRouterUsage): number | undefined {
    if (usage.apiEquivalentUsd !== null) return usage.apiEquivalentUsd;
    if (usage.inputTokens === 0 && usage.outputTokens === 0) return undefined;
    const estimate = estimateMicrousd(priceSnapshotFor(this.connection.providerId, this.connection.model), usage.inputTokens, usage.cachedInputTokens, usage.outputTokens);
    return estimate === undefined ? undefined : estimate / 1_000_000;
  }

  private buildRequest(input: ModelRouterInput, previousShapeError?: string) {
    const baseUrl = this.connection.baseUrl.replace(/\/$/, "");
    const text = modelInput(input);
    const instruction = professorInstructions(input.language) + (previousShapeError
      ? `\n\n上一次输出未通过结构校验（${previousShapeError}）。请重新生成完整的单个 JSON 对象，不要包裹在外层对象中。必须逐项写出 chapterBridgeMarkdown、learningObjectives、priorKnowledge、fullExplanationMarkdown、mainContentMarkdown、misconceptions、coverageEvidence 和 questions；即使是封面或目录，也不能省略完整讲解和列表总结。learningObjectives、priorKnowledge 和 misconceptions 必须是字符串数组。`
      : "");
    const headers = providerRequestHeaders(this.connection, input);
    if (this.connection.protocol === "responses") {
      return {
        url: `${baseUrl}/responses`,
        headers,
        body: {
          model: this.connection.model,
          instructions: instruction,
          input: text,
          max_output_tokens: teachingOutputTokenLimit(input.qualityMode),
          ...(this.connection.providerId === "deepseek" ? { reasoning: { effort: "none" } }
            : this.connection.providerId === "opencode-go" ? { reasoning: { effort: "medium" } }
            : { temperature: 0.2 }),
          text: { format: { type: "json_schema", name: "course_os_teaching_package", schema: teachingPackageSchema, strict: true } },
          metadata: { product: "course-os", stage: input.stage || "teach", writing_policy_snapshot_id: input.writingPolicySnapshotId }
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
          max_tokens: teachingOutputTokenLimit(input.qualityMode),
          temperature: 0.2,
          messages: [{ role: "user", content }]
        }
      };
    }
    const chatRequiresLocalSchemaValidation = this.connection.providerId === "opencode-go";
    const messages = [
      { role: "system", content: chatRequiresLocalSchemaValidation
        ? `${instruction}\n\n只输出一个合法 JSON 对象，不使用 Markdown 代码围栏或额外说明。输出结构：${JSON.stringify(teachingPackageSchema)}`
        : instruction },
      { role: "user", content: Array.isArray(text) ? text[0]?.content.map((part) => part.type === "input_text" ? { type: "text", text: part.text } : { type: "image_url", image_url: { url: part.image_url } }) : text }
    ];
    return { url: `${baseUrl}/chat/completions`, headers, body: { model: this.connection.model, max_tokens: providerTeachingOutputTokenLimit(this.connection, input.qualityMode), temperature: 0.2, messages,
      ...(chatRequiresLocalSchemaValidation ? {} : {
        response_format: { type: "json_schema", json_schema: { name: "course_os_teaching_package", strict: true, schema: teachingPackageSchema } }
      }) } };
  }
}

function isTeachingShapeError(code: string): boolean {
  return code === "MODEL_PROVIDER_OUTPUT_JSON_INVALID"
    || code === "MODEL_PROVIDER_INVALID_TEACHING_PACKAGE"
    || /^MODEL_ROUTER_(?:INVALID_TEACHING_PACKAGE|[A-Z_]+_INVALID)$/.test(code);
}

function providerFailureCode(status: number, error: ProviderResponseBody["error"]): string {
  const message = error?.message || "";
  if (status === 402 || /insufficient\s+(?:balance|credit)|quota\s+exhausted|billing\s+(?:limit|required)/i.test(message)) {
    return "MODEL_PROVIDER_INSUFFICIENT_BALANCE";
  }
  return `MODEL_PROVIDER_FAILED:${error?.code || status}`;
}

function anthropicImagePart(imageUrl: string): { type: "image"; source: { type: "base64"; media_type: string; data: string } } {
  const match = imageUrl.match(/^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,(.+)$/i);
  if (!match) throw new Error("MODEL_PROVIDER_IMAGE_FORMAT_UNSUPPORTED");
  return { type: "image", source: { type: "base64", media_type: match[1]!.toLowerCase().replace("jpg", "jpeg"), data: match[2]! } };
}

export class RoutedProviderTeachingClient implements ModelRouterClient {
  constructor(private readonly connections: ProviderConnection[]) {}

  async auditTeachingPackage(input: ModelRouterInput & { teachingPackage: TeachingPackage }): Promise<SemanticAuditResult> {
    const connection = [...this.connections].sort((left, right) => scoreConnection(left, input) - scoreConnection(right, input))[0];
    if (!connection) throw new ModelRouterGenerationError("MODEL_PROVIDER_NOT_CONFIGURED", "unconfigured", emptyUsage(Date.now()), "course-os");
    return new HttpProviderTeachingClient(connection).auditTeachingPackage(input);
  }

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

/** Add current provider routes that older persisted ReadWeave settings may not contain yet. */
export function withCurrentDeepSeekModels(providers: ModelProviderConfig[]): ModelProviderConfig[] {
  return providers.map((provider) => {
    if (provider.id === "deepseek" && !provider.models.some((model) => model.id === "deepseek-flash")) {
      return { ...provider, models: [...provider.models, {
        id: "deepseek-flash", displayName: "DeepSeek Flash", protocol: "responses" as const,
        supportsVision: true, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" as const
      }] };
    }
    if (provider.id === "opencode-go" && !provider.models.some((model) => model.id === "gpt-5.6-luna")) {
      return { ...provider, models: [{
        id: "gpt-5.6-luna", displayName: "GPT 5.6 Luna", protocol: "responses" as const,
        supportsVision: true, supportsJsonSchema: true, supportsReasoning: true, billingMode: "subscription_quota" as const
      }, ...provider.models] };
    }
    return provider;
  });
}

/**
 * Resolve the saved workspace route for every job instead of freezing the
 * provider choice at process start. Credentials are fetched only at call time
 * and never enter the browser-facing settings response
 */
export class SettingsProviderTeachingClient implements ModelRouterClient {
  constructor(private readonly source: SettingsProviderSource) {}

  async repairTeachingFields(input: ModelRouterInput, fields: Array<keyof TeachingPackage>): Promise<TeachingGenerationResult> {
    return this.runWithFallback("repair", input, (client) => client.repairTeachingFields(input, fields));
  }

  async auditTeachingPackage(input: ModelRouterInput & { teachingPackage: TeachingPackage }): Promise<SemanticAuditResult> {
    return this.runWithFallback("semantic_audit", input, (client) => client.auditTeachingPackage(input));
  }

  async generateTeachingPackage(input: ModelRouterInput): Promise<TeachingGenerationResult> {
    return this.runWithFallback(input.stage || "teach", input, (client) => client.generateTeachingPackage(input));
  }

  private async runWithFallback<T>(stage: GenerationStage | "qa", input: ModelRouterInput, execute: (client: HttpProviderTeachingClient) => Promise<T>): Promise<T> {
    const { providers: savedProviders, policy, credential } = await this.source.load();
    const providers = withCurrentDeepSeekModels(savedProviders);
    const rule = policy.rules.find((candidate) => candidate.stage === stage && candidate.enabled)
      || policy.rules.find((candidate) => candidate.stage === "teach" && candidate.enabled);
    if (!rule) throw new ModelRouterGenerationError("MODEL_PROVIDER_ROUTE_NOT_CONFIGURED", "unconfigured", emptyUsage(Date.now()), "course-os");

    const candidates = [
      { providerId: rule.providerId, modelId: rule.modelId },
      ...(policy.allowProviderFallback !== false && rule.fallbackProviderId && rule.fallbackModelId ? [{ providerId: rule.fallbackProviderId, modelId: rule.fallbackModelId }] : [])
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
        return await execute(new HttpProviderTeachingClient(connection));
      } catch (error) {
        if (!(error instanceof ModelRouterGenerationError)) throw error;
        // Only exhausted subscription quota authorizes switching to metered billing.
        // Content, configuration and network failures retain the original provider.
        if (error.code !== "MODEL_PROVIDER_INSUFFICIENT_BALANCE"
          && !/^MODEL_PROVIDER_FAILED:(?:429|rate_limited|quota_exhausted|rate_limit_exceeded)$/.test(error.code)) throw error;
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
    const model = process.env.OPENCODE_GO_MODEL || "deepseek-v4-flash-vision-exp";
    connections.push({ providerId: "opencode-go", baseUrl: process.env.OPENCODE_GO_BASE_URL || "https://opencode.ai/zen/go/v1", apiKey: openCodeKey, model, protocol: openCodeProtocol(model), supportsVision: openCodeSupportsVision(model), billingMode: "subscription_quota" });
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
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string };
}

async function readResponsesEventStream(stream: ReadableStream<Uint8Array>, onActivity: () => void): Promise<ProviderResponseBody> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResponse: ProviderResponseBody | undefined;
  const processEvent = (block: string): ProviderResponseBody | undefined => {
    const data = block.split(/\r?\n/u).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    const event = JSON.parse(data) as { type?: string; response?: ProviderResponseBody };
    if (["response.completed", "response.incomplete", "response.failed"].includes(event.type || "") && event.response) {
      finalResponse = event.response;
    }
    return finalResponse;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onActivity();
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/u);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        const completed = processEvent(block);
        if (completed) {
          await reader.cancel();
          return completed;
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) processEvent(buffer);
  } finally {
    reader.releaseLock();
  }
  if (!finalResponse) throw new Error("MODEL_PROVIDER_STREAM_FINAL_EVENT_MISSING");
  return finalResponse;
}

function providerBodyFailed(body: ProviderResponseBody): boolean {
  return body.status === "failed" || body.status === "incomplete";
}

function providerBodyError(body: ProviderResponseBody): ProviderResponseBody["error"] {
  if (body.error) return body.error;
  if (body.status === "incomplete") return { code: body.incomplete_details?.reason || "response_incomplete" };
  if (body.status === "failed") return { code: "response_failed" };
  return undefined;
}

function extractProviderOutput(body: ProviderResponseBody): unknown {
  if (typeof body.output_text === "string") return body.output_text;
  if (typeof body.output === "string") return body.output;
  if (Array.isArray(body.output)) {
    const text = body.output.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as { type?: unknown; content?: Array<{ type?: unknown; text?: unknown }> };
      if (candidate.type && candidate.type !== "message") return [];
      return candidate.content?.flatMap((part) => {
        if (part.type && part.type !== "output_text") return [];
        return typeof part.text === "string" ? [part.text] : [];
      }) ?? [];
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
  if (model === "gpt-5.6-luna") return "responses";
  return model === "qwen3.8-flash" ? "messages" : "chat_completions";
}

function openCodeSupportsVision(model: string): boolean {
  return model === "gpt-5.6-luna" || model.includes("vision");
}

function stripJsonFences(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function parseProviderJson(value: string): unknown {
  const source = stripJsonFences(value);
  try { return JSON.parse(source); }
  catch {
    let inString = false;
    let escaped = false;
    let repaired = "";
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index]!;
      if (escaped) { repaired += character; escaped = false; continue; }
      if (character === '"') { inString = !inString; repaired += character; continue; }
      if (inString && character === "\\") {
        const next = source[index + 1] || "";
        if (next && !/^["\\/bfnrtu]$/.test(next)) repaired += "\\";
        repaired += character;
        escaped = true;
        continue;
      }
      repaired += character;
    }
    return JSON.parse(repaired);
  }
}

function parseTeachingPackageJson(value: string): TeachingPackage {
  const normalized = stripJsonFences(value);
  try { return parseProviderJson(normalized) as TeachingPackage; }
  catch {
    let firstParsed: TeachingPackage | undefined;
    for (let start = normalized.indexOf("{"); start >= 0; start = normalized.indexOf("{", start + 1)) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = start; index < normalized.length; index += 1) {
        const character = normalized[index]!;
        if (inString) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') { inString = true; continue; }
        if (character === "{") depth += 1;
        else if (character === "}" && --depth === 0) {
          try {
            const candidate = parseProviderJson(normalized.slice(start, index + 1)) as TeachingPackage;
            if (candidate && typeof candidate === "object" && Array.isArray(candidate.learningObjectives)
              && typeof candidate.fullExplanationMarkdown === "string") firstParsed ??= candidate;
            try {
              validateTeachingPackage(candidate);
              return candidate;
            } catch {
              // A provider may include a parseable metadata object before the
              // actual teaching package. Keep scanning for the valid object.
            }
          } catch {
            // This brace pair was not a complete JSON object; keep scanning.
          }
          break;
        }
      }
    }
    if (firstParsed) return firstParsed;
    throw new Error("MODEL_PROVIDER_OUTPUT_JSON_INVALID");
  }
}

/**
 * Providers occasionally return a semantically usable list as one string or
 * label a question inconsistently with its option shape. These are lossless
 * boundary repairs, not content generation: strict validation still runs
 * immediately afterwards and rejects anything that cannot be inferred safely
 * from the returned JSON.
 */
function normalizeTeachingPackageShape(value: TeachingPackage): TeachingPackage {
  if (!value || typeof value !== "object") return value;
  const candidate = value as TeachingPackage & Record<string, unknown>;
  const summary = candidate.mainContentMarkdown;
  if (Array.isArray(summary) && summary.length >= 2 && summary.length <= 5
    && summary.every((item) => typeof item === "string" && item.trim() && !item.includes("\n"))) {
    candidate.mainContentMarkdown = summary.map((item: string) => `- ${item.trim().replace(/^[-*+]\s+/, "")}`).join("\n");
  }
  for (const field of ["learningObjectives", "priorKnowledge", "misconceptions"] as const) {
    const normalized = normalizeStringList(candidate[field]);
    if (normalized !== undefined) candidate[field] = normalized as never;
  }
  if (Array.isArray(candidate.questions)) {
    candidate.questions = candidate.questions.map((question) => {
      if (!question || typeof question !== "object" || !Array.isArray(question.options)) return question;
      const options = question.options;
      if (options.length === 0 && question.kind === "multiple_choice") return { ...question, kind: "comprehension" };
      if (options.length === 4 && question.kind === "comprehension") return { ...question, kind: "multiple_choice" };
      return question;
    });
  }
  return candidate;
}

type TeachingTailField = "misconceptions" | "coverageEvidence" | "questions";

function missingTeachingTailFields(value: TeachingPackage | undefined): TeachingTailField[] {
  if (!value || !Array.isArray(value.learningObjectives) || !Array.isArray(value.priorKnowledge)
    || typeof value.mainContentMarkdown !== "string" || typeof value.fullExplanationMarkdown !== "string"
    || value.fullExplanationMarkdown.length < 120) return [];
  const fields: TeachingTailField[] = ["misconceptions", "coverageEvidence", "questions"];
  return fields.filter((field) => (value as unknown as Record<string, unknown>)[field] === undefined);
}

function normalizeStringList(value: unknown, depth = 0): string[] | undefined {
  if (typeof value === "string" && value.trim()) {
    const items = value.split(/\r?\n|[；;]/)
      .map((item) => item.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
      .filter(Boolean);
    return items.length > 0 ? items : [value.trim()];
  }
  if (depth > 4) return undefined;
  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalizeStringListItem(item, depth + 1));
    if (normalized.every((item): item is string => typeof item === "string")) return normalized;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["items", "values", "objectives", "knowledge", "points"]) {
      const items = normalizeStringList(record[key], depth + 1);
      if (items) return items;
    }
    const nestedLists = Object.values(record)
      .map((item) => normalizeStringList(item, depth + 1))
      .filter((item): item is string[] => Boolean(item));
    if (nestedLists.length === 1) return nestedLists[0];
  }
  return undefined;
}

function normalizeStringListItem(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (depth > 4) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const term = record.term ?? record.name ?? record.concept ?? record.knowledge;
  const definition = record.definition ?? record.explanation ?? record.description;
  if (typeof term === "string" && term.trim() && typeof definition === "string" && definition.trim()) {
    return `${term.trim().replace(/[：:]$/u, "")}：${definition.trim()}`;
  }
  for (const key of ["text", "value", "objective", "knowledge", "point", "description", "content", "label"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  const nestedStrings = Object.values(record)
    .map((item) => normalizeStringListItem(item, depth + 1))
    .filter((item): item is string => Boolean(item));
  const unique = [...new Set(nestedStrings)];
  if (unique.length === 1) return unique[0];
  return undefined;
}

function validateTeachingPackage(value: unknown): asserts value is TeachingPackage {
  if (!value || typeof value !== "object") throw new Error("MODEL_ROUTER_INVALID_TEACHING_PACKAGE");
  const candidate = value as Partial<TeachingPackage>;
  if (candidate.chapterBridgeMarkdown !== undefined && typeof candidate.chapterBridgeMarkdown !== "string") throw new Error("MODEL_ROUTER_CHAPTER_BRIDGE_INVALID");
  if (!Array.isArray(candidate.learningObjectives) || !candidate.learningObjectives.every((item) => typeof item === "string")) throw new Error("MODEL_ROUTER_LEARNING_OBJECTIVES_INVALID");
  if (typeof candidate.mainContentMarkdown !== "string") throw new Error("MODEL_ROUTER_MAIN_CONTENT_INVALID");
  if (!Array.isArray(candidate.priorKnowledge) || !candidate.priorKnowledge.every((item) => typeof item === "string")) throw new Error("MODEL_ROUTER_PRIOR_KNOWLEDGE_INVALID");
  if (typeof candidate.fullExplanationMarkdown !== "string" || candidate.fullExplanationMarkdown.length < 120) throw new Error("MODEL_ROUTER_FULL_EXPLANATION_INVALID");
  if (!Array.isArray(candidate.misconceptions) || !candidate.misconceptions.every((item) => typeof item === "string")) throw new Error("MODEL_ROUTER_MISCONCEPTIONS_INVALID");
  if (!Array.isArray(candidate.coverageEvidence) || candidate.coverageEvidence.some((item) => !item || typeof item !== "object" || typeof item.atomId !== "string" || !Array.isArray(item.coveredFields) || typeof item.explanation !== "string")) throw new Error("MODEL_ROUTER_COVERAGE_EVIDENCE_INVALID");
  if (!Array.isArray(candidate.questions) || candidate.questions.length !== 4 || candidate.questions.some((item) => !item || typeof item !== "object" || (item.kind !== "comprehension" && item.kind !== "multiple_choice") || typeof item.prompt !== "string" || !Array.isArray(item.options) || typeof item.expectedAnswer !== "string" || !item.expectedAnswer || typeof item.explanation !== "string")) throw new Error("MODEL_ROUTER_QUESTIONS_INVALID");
  const questions = candidate.questions;
  const comprehension = questions.filter((item) => item.kind === "comprehension").length;
  const choices = questions.filter((item) => item.kind === "multiple_choice").length;
  if (comprehension !== 2 || choices !== 2) throw new Error("MODEL_ROUTER_QUESTION_MIX_INVALID");
  for (const item of questions.filter((question) => question.kind === "comprehension")) if ((item.options ?? []).length !== 0) throw new Error("MODEL_ROUTER_COMPREHENSION_OPTIONS_INVALID");
  for (const item of questions.filter((question) => question.kind === "multiple_choice")) {
    const options = item.options ?? [];
    if (options.length !== 4 || !options.includes(item.expectedAnswer)) throw new Error("MODEL_ROUTER_CHOICE_INVALID");
  }
}
