import { randomUUID } from "node:crypto";
import type { GenerationStage, ModelProviderConfig, ModelRoutePolicy, ProviderHealth, TeachingBlueprint } from "@course-os/contracts";
import { writingPolicyInstructions } from "./generation-harness.js";
import { estimateMicrousd, priceSnapshotFor } from "./pricing.js";
import { writePlannedLesson, type PlannedCall, type PlannedCheckpoint, type PlannedTrace } from "./planned-teaching.js";
import type { TeachingResearchEvidence, TeachingResearchQuery } from "./teaching-plan.js";
export { currentGenerationHarness, teachingPackageSchema } from "./generation-harness.js";

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
  /** Conservative budget charge for a completed request whose usage was lost after a timeout. */
  unreportedCostReserveUsd?: number;
  durationMs: number;
}

export interface TeachingGenerationResult {
  teachingTrace?: PlannedTrace;
  content: TeachingPackage;
  provider: string;
  model: string;
  usage: ModelRouterUsage;
  /** Number of final output format repairs, retained for persisted telemetry compatibility. */
  schemaRetries?: number;
}

export interface ModelRouterInput {
  pageTitle: string;
  pageNumber: number;
  sourceText: string;
  previousPageContext?: string;
  teachingPlan?: string;
  resolvePreviousPageContext?: () => Promise<{ context?: string; fingerprint?: string }>;
  searchEvidence?: (queries: TeachingResearchQuery[]) => Promise<TeachingResearchEvidence[]>;
  onTeachingPhase?: (phase: string, state: "started" | "completed", usage?: ModelRouterUsage) => Promise<void>;
  teachingFingerprint?: string;
  generationAttempt?: number;
  resumeTeaching?: PlannedCheckpoint;
  onTeachingCheckpoint?: (checkpoint: PlannedCheckpoint) => Promise<void>;
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
  understandPage?(input: ModelRouterInput): Promise<{ sourceDescription: string; teachingPlan: string; provider: string; model: string; usage: ModelRouterUsage } | undefined>;
  generateBridge?(input: ModelRouterInput & { currentSummary: string }): Promise<{ markdown: string; provider: string; model: string; usage: ModelRouterUsage }>;
  repairTeachingFields?(input: ModelRouterInput, fields: Array<keyof TeachingPackage>): Promise<TeachingGenerationResult>;
  auditTeachingPackage?(input: ModelRouterInput & { teachingPackage: TeachingPackage }): Promise<SemanticAuditResult>;
}

export interface SemanticAuditResult {
  teachingChecks?: Array<{ criterion: string; evidence: string; verdict: "supported" | "contradicted" | "unverified"; field?: string; quote?: string }>;
  findings: Array<{ field: string; original: string; replacement: string; evidence: string }>;
  sourceChecks?: Array<{ claim: string; evidence: string; verdict: "supported" | "contradicted" | "unverified"; field?: string; quote?: string }>;
  provider: string;
  model: string;
  usage: ModelRouterUsage;
  /** Exact-patch result produced inside the router; callers must not replay the findings on another revision. */
  correctedTeachingPackage?: TeachingPackage;
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

function emptyUsage(started: number): ModelRouterUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, apiEquivalentUsd: null, durationMs: Date.now() - started };
}

function sumProviderUsage(first: ModelRouterUsage, second: ModelRouterUsage): ModelRouterUsage {
  const knownCosts = [first.apiEquivalentUsd, second.apiEquivalentUsd].filter((cost): cost is number => cost !== null);
  const unreportedCostReserveUsd = (first.unreportedCostReserveUsd ?? 0) + (second.unreportedCostReserveUsd ?? 0);
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    cachedInputTokens: first.cachedInputTokens + second.cachedInputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    apiEquivalentUsd: knownCosts.length ? knownCosts.reduce((total, cost) => total + cost, 0) : null,
    ...(unreportedCostReserveUsd ? { unreportedCostReserveUsd } : {}),
    durationMs: first.durationMs + second.durationMs
  };
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
    // Keep one provider session across a page job;
    // each individual request still retains its own idempotency key.
    headers["x-opencode-session"] = (input.idempotencyKey || idempotencyKey).split(":attempt:")[0]!.split(":field:")[0]!;
    headers["x-opencode-request"] = idempotencyKey;
    headers["x-opencode-client"] = "course-os";
    headers["User-Agent"] = "course-os/2.4.0";
  }
  return headers;
}

export async function probeProviderConnection(connection: ProviderConnection, full = false): Promise<ProviderHealth> {
  const checkedAt = new Date().toISOString();
  if (!connection.apiKey) return { providerId: connection.providerId, state: "unconfigured", checkedAt, message: "请先保存接口密钥" };
  if (!connection.baseUrl) return { providerId: connection.providerId, state: "degraded", checkedAt, message: "这个供应商没有可检查的公开接口地址" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), full ? 60_000 : 8_000);
  try {
    const response = await fetch(`${connection.baseUrl.replace(/\/$/, "")}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${connection.apiKey}`, Accept: "application/json" },
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403) return { providerId: connection.providerId, state: "offline", checkedAt, message: "接口可以访问，但密钥无效或没有权限" };
    if (!response.ok) return { providerId: connection.providerId, state: "degraded", checkedAt, message: `接口返回 HTTP ${response.status}，请检查地址和供应商状态` };
    const catalog = await response.json().catch(() => undefined) as { data?: Array<{ id?: unknown }> } | undefined;
    const models = catalog?.data?.flatMap((item) => typeof item.id === "string" ? [item.id] : []) ?? [];
    if (full && models.length && !models.includes(connection.model)) return { providerId: connection.providerId, state: "degraded", checkedAt, message: `连接正常，但当前模型目录中没有 ${connection.model}` };
    if (!full) return { providerId: connection.providerId, state: "connected", checkedAt, message: "连接正常，已读取供应商模型目录" };
    const capabilitySchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZrS8AAAAASUVORK5CYII=";
    const input = connection.supportsVision
      ? [{ role: "user", content: [{ type: "input_text", text: "Return {\"ok\":true}." }, { type: "input_image", image_url: imageUrl }] }]
      : "Return {\"ok\":true}.";
    const chat = connection.protocol === "chat_completions";
    if (!chat && connection.protocol !== "responses") return { providerId: connection.providerId, state: "connected", checkedAt, message: "连接正常，模型目录可用；当前协议使用本地结构校验" };
    const requestBody = chat ? {
      model: connection.model,
      max_tokens: 32,
      temperature: 0,
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: "Return only the JSON object {\"ok\":true}." },
        { role: "user", content: connection.supportsVision
          ? [{ type: "text", text: "Return {\"ok\":true}." }, { type: "image_url", image_url: { url: imageUrl } }]
          : "Return {\"ok\":true}." }
      ]
    } : {
      model: connection.model,
      instructions: "Return only the requested structured object",
      input,
      max_output_tokens: 32,
      reasoning: { effort: "none" },
      text: { format: { type: "json_schema", name: "course_os_provider_probe", schema: capabilitySchema, strict: true } }
    };
    const probeId = randomUUID();
    const headers: Record<string, string> = { Authorization: `Bearer ${connection.apiKey}`, Accept: "application/json", "Content-Type": "application/json" };
    if (connection.providerId === "opencode-go") {
      headers["Idempotency-Key"] = probeId;
      headers["x-opencode-session"] = probeId;
      headers["x-opencode-request"] = probeId;
      headers["x-opencode-client"] = "course-os";
      headers["User-Agent"] = "course-os/2.4.0";
    }
    const capability = await fetch(`${connection.baseUrl.replace(/\/$/, "")}/${chat ? "chat/completions" : "responses"}`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    if (capability.status === 401 || capability.status === 403) return { providerId: connection.providerId, state: "offline", checkedAt, message: "模型目录可用，但调用密钥没有生成权限" };
    if (!capability.ok) return { providerId: connection.providerId, state: "degraded", checkedAt, message: `模型目录可用，但结构化调用返回 HTTP ${capability.status}` };
    const body = await capability.json().catch(() => undefined) as ProviderResponseBody | undefined;
    const output = body && !providerBodyFailed(body) ? extractProviderOutput(body) : undefined;
    let structured = false;
    if (typeof output === "string") {
      try { structured = (parseProviderJson(output) as { ok?: unknown }).ok === true; }
      catch { structured = false; }
    } else if (output && typeof output === "object") structured = (output as { ok?: unknown }).ok === true;
    if (!structured) return { providerId: connection.providerId, state: "degraded", checkedAt, message: "模型目录可用，但结构化调用返回了无法识别的结果" };
    return { providerId: connection.providerId, state: "connected", checkedAt, message: connection.supportsVision ? "连接正常，模型目录、结构化输出和图片输入均可用" : "连接正常，模型目录和结构化输出均可用" };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? `连接检查超过 ${full ? 60 : 8} 秒，供应商没有及时响应` : "暂时无法连接供应商接口";
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

  async understandPage(input: ModelRouterInput) {
    if (!input.sourceImageDataUrl) return undefined;
    if (!this.connection.supportsVision) throw new ModelRouterGenerationError("MODEL_PROVIDER_VISION_UNAVAILABLE", this.connection.model,
      emptyUsage(Date.now()), this.connection.providerId);
    const response = await this.requestPlannedStage(input, {
      phase: "page_understanding",
      instructions: "看清这一页课件，再为第一次接触本页知识的读者安排简短教学顺序。只根据图片和辅助提取文字描述实际可见对象、公式、图表、代码与关系。页码、页眉和纯排版元素不成为教学对象。输出两个自然语言小段，分别以“页面内容：”和“教学顺序：”开头；不输出 JSON、来源编号或覆盖账本。不确定的图像细节直接说不确定，不猜测。",
      prompt: JSON.stringify({ pageTitle: input.pageTitle, pageNumber: input.pageNumber,
        extractedText: input.sourceText.slice(0, 16_000) }),
      image: input.sourceImageDataUrl,
      maxOutputTokens: 1_200
    }, input.maxCostUsd ?? 0.06);
    const value = typeof response.content === "string" ? response.content.trim() : String(response.content ?? "").trim();
    if (!value) throw new ModelRouterGenerationError("MODEL_PROVIDER_OUTPUT_MISSING", response.model, response.usage, response.provider);
    const split = value.indexOf("教学顺序：");
    const sourceDescription = (split >= 0 ? value.slice(0, split) : value).replace(/^页面内容：/u, "").trim();
    const teachingPlan = split >= 0 ? value.slice(split + "教学顺序：".length).trim() : value;
    return { sourceDescription, teachingPlan, provider: response.provider, model: response.model, usage: response.usage };
  }

  async generateBridge(input: ModelRouterInput & { currentSummary: string }) {
    const response = await this.requestPlannedStage(input, {
      phase: "bridge",
      instructions: `为当前课件页写一个简短的承上启下段。只回收前页讲解中理解当前页确实需要的一点，再自然指出本页接着解决什么。不重复本页完整讲解，不虚构前页事实。遵守下面完整的写作策略。\n\n${writingPolicyInstructions(input.language)}`,
      prompt: JSON.stringify({ pageTitle: input.pageTitle, previousTeaching: input.previousPageContext,
        currentSummary: input.currentSummary }),
      maxOutputTokens: 700
    }, input.maxCostUsd ?? 0.06);
    const markdown = typeof response.content === "string" ? response.content.trim()
      : (response.content as { chapterBridgeMarkdown?: unknown })?.chapterBridgeMarkdown;
    if (typeof markdown !== "string" || !markdown.trim()) throw new ModelRouterGenerationError("MODEL_PROVIDER_BRIDGE_INVALID",
      response.model, response.usage, response.provider);
    return { markdown: markdown.trim(), provider: response.provider, model: response.model, usage: response.usage };
  }

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
        ? JSON.stringify({ thinking: { type: "disabled" }, ...JSON.parse(init.body) })
        : init.body;
      const useResponsesStream = ["deepseek", "kuafu", "kuafu-backup", "opencode-go"].includes(this.connection.providerId) && this.connection.protocol === "responses"
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
        if (!response.ok) {
          throw new ModelRouterGenerationError(`MODEL_PROVIDER_FAILED:${response.status}`, this.connection.model, emptyUsage(started), this.connection.providerId);
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

  async generateTeachingPackage(input: ModelRouterInput): Promise<TeachingGenerationResult> {
    // All page generation uses the same compact teaching flow, whether or not
    // the caller supplies a blueprint. Blueprints are source context only.
    return this.generatePlannedLesson(input);
  }

  private async generatePlannedLesson(input: ModelRouterInput): Promise<TeachingGenerationResult> {
    let usage = emptyUsage(Date.now());
    let model = this.connection.model;
    let calls = 0;
    try {
      const result = await writePlannedLesson(input, async request => {
        // A rejected request can have no usage receipt. It consumed no known
        // tokens, so preserve its provider error through the stage retry and
        // allow the explicit transient-provider route fallback to handle it.
        const spent = calls && (usage.inputTokens > 0 || usage.outputTokens > 0 || usage.apiEquivalentUsd !== null)
          ? this.usageCostUsd(usage) : 0;
        if (spent === undefined || spent >= (input.maxCostUsd ?? 0.06)) throw new Error("MODEL_PROVIDER_PAGE_BUDGET_EXCEEDED");
        let response: Awaited<ReturnType<HttpProviderTeachingClient["requestPlannedStage"]>>;
        try { response = await this.requestPlannedStage(input, request, (input.maxCostUsd ?? 0.06) - spent); }
        catch (error) {
          if (error instanceof ModelRouterGenerationError) usage = calls++ === 0 ? error.usage : sumProviderUsage(usage, error.usage);
          throw error;
        }
        usage = calls++ === 0 ? response.usage : sumProviderUsage(usage, response.usage);
        if (calls > 1 && response.model !== model) throw new Error("MODEL_PROVIDER_CHANGED_DURING_PAGE");
        model = response.model;
        return response;
      });
      return {
        content: result.content,
        teachingTrace: result.trace,
        usage,
        model,
        provider: this.connection.providerId,
        schemaRetries: result.trace.phases.some(phase => phase.phase === "format_repair") ? 1 : 0
      };
    } catch (error) {
      if (error instanceof ModelRouterGenerationError) {
        throw new ModelRouterGenerationError(error.code, error.model, usage, error.provider, error.responseShape, error.partialContent);
      }
      throw new ModelRouterGenerationError(error instanceof Error ? error.message : "TEACHING_GENERATION_FAILED", model, usage, this.connection.providerId);
    }
  }

  private async requestPlannedStage(input: ModelRouterInput, request: PlannedCall, budget: number) {
    const stageStarted = Date.now();
    const price = priceSnapshotFor(this.connection.providerId, this.connection.model);
    if (!price) throw new Error("MODEL_PROVIDER_COST_UNAVAILABLE");
    // Keep the exact same request body and idempotency key for one bounded
    // transient retry. Reserving half the stage budget per attempt prevents a
    // timeout or lost response from allowing an unbounded second charge.
    const estimatedInput = request.instructions.length + request.prompt.length + (request.schema ? JSON.stringify(request.schema).length : 0) + (request.image ? 8000 : 0);
    const reserve = estimatedInput * price.inputMicrousdPerMillion / 1e12;
    const attemptBudget = budget / 2;
    const allowance = Math.floor((attemptBudget - reserve) * 1e12 / price.outputMicrousdPerMillion);
    const maxTokens = Math.min(request.maxOutputTokens, allowance);
    if (maxTokens < Math.min(1_000, request.maxOutputTokens)) throw new Error("MODEL_PROVIDER_PAGE_BUDGET_EXCEEDED");
    const attemptCostCeiling = reserve + maxTokens * price.outputMicrousdPerMillion / 1e12;
    const base = this.connection.baseUrl.replace(/\/$/, "");
    const image = request.image;
    const schemaInstruction = request.schema
      ? `${request.instructions}\n请输出符合下列 JSON Schema 的内容对象，不得返回 Schema 本身；字符串必须填写实际内容：${JSON.stringify(request.schema)}`
      : request.instructions;
    const protocol = this.connection.protocol;
    const body = protocol === "responses" ? {
      model: this.connection.model, instructions: request.instructions,
      input: image ? [{ role: "user", content: [{ type: "input_text", text: request.prompt }, { type: "input_image", image_url: image, detail: "high" }] }] : request.prompt,
      max_output_tokens: maxTokens,
      ...(["deepseek", "kuafu", "kuafu-backup", "opencode-go"].includes(this.connection.providerId) ? { reasoning: { effort: "none" } } : { temperature: 0.2 }),
      text: request.schema
        ? { format: { type: "json_schema", name: `course_os_${request.phase}`, schema: request.schema, strict: true } }
        : { format: { type: "text" } }
    } : protocol === "messages" ? {
      model: this.connection.model, system: schemaInstruction, max_tokens: maxTokens,
      messages: [{ role: "user", content: image ? [{ type: "text", text: request.prompt }, anthropicImagePart(image)] : request.prompt }]
    } : {
      model: this.connection.model, max_tokens: maxTokens,
      ...(["deepseek", "opencode-go"].includes(this.connection.providerId) && this.connection.model.startsWith("deepseek-")
        ? { thinking: { type: "disabled" } } : { temperature: 0.2 }),
      messages: [{ role: "system", content: schemaInstruction }, { role: "user", content: image
        ? [{ type: "text", text: request.prompt }, { type: "image_url", image_url: { url: image } }] : request.prompt }]
    };
    const url = `${base}/${protocol === "responses" ? "responses" : protocol === "messages" ? "messages" : "chat/completions"}`;
    const init: RequestInit = {
      method: "POST",
      headers: providerRequestHeaders(this.connection, input, `${input.idempotencyKey}:${request.phase}`),
      body: JSON.stringify(body)
    };
    let accumulatedUsage: ModelRouterUsage | undefined;
    let budgetSpent = 0;
    let unreportedCostReserveUsd = 0;
    const includeUnreportedReserve = () => accumulatedUsage && unreportedCostReserveUsd > 0
      ? { ...accumulatedUsage, unreportedCostReserveUsd }
      : accumulatedUsage;
    const addAttemptUsage = (attemptUsage: ModelRouterUsage) => {
      accumulatedUsage = accumulatedUsage ? sumProviderUsage(accumulatedUsage, attemptUsage) : attemptUsage;
      return accumulatedUsage;
    };
    const chargeAttempt = (attemptUsage: ModelRouterUsage): number => {
      const reportedOrEstimated = this.usageCostUsd(attemptUsage);
      if (reportedOrEstimated !== undefined) return reportedOrEstimated;
      unreportedCostReserveUsd += attemptCostCeiling;
      return attemptCostCeiling;
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const attemptStarted = Date.now();
      let response: Response;
      let received: ProviderResponseBody;
      try {
        ({ response, body: received } = await this.requestJson(url, init, attemptStarted));
      } catch (error) {
        if (!(error instanceof ModelRouterGenerationError)) throw error;
        addAttemptUsage(error.usage);
        const retryable = retryableProviderError(error.code);
        const attemptCost = retryable ? chargeAttempt(error.usage) : (this.usageCostUsd(error.usage) ?? 0);
        budgetSpent += attemptCost;
        const canRetry = attempt === 0 && retryable
          && budgetSpent + attemptCostCeiling <= budget + 1e-9;
        if (canRetry) {
          await waitForProviderRetry();
          continue;
        }
        throw new ModelRouterGenerationError(error.code, error.model, includeUnreportedReserve()!, error.provider,
          request.phase, error.partialContent);
      }

      const attemptUsage = normalizeProviderUsage(received.usage, received.usage?.cost ?? received.cost, attemptStarted);
      addAttemptUsage(attemptUsage);
      const model = received.model || this.connection.model;
      const bodyError = providerBodyError(received);
      const providerFailed = !response.ok || providerBodyFailed(received);
      if (providerFailed) {
        const code = providerFailureCode(response.status, bodyError);
        const retryable = retryableProviderResponse(response.status, bodyError);
        const attemptCost = retryable ? chargeAttempt(attemptUsage) : (this.usageCostUsd(attemptUsage) ?? 0);
        budgetSpent += attemptCost;
        const canRetry = attempt === 0 && retryable
          && budgetSpent + attemptCostCeiling <= budget + 1e-9;
        if (canRetry) {
          await waitForProviderRetry(response);
          continue;
        }
        throw new ModelRouterGenerationError(code, model, includeUnreportedReserve()!, this.connection.providerId, request.phase);
      }

      if (received.choices?.[0]?.finish_reason === "length" || received.incomplete_details?.reason === "max_output_tokens") {
        throw new ModelRouterGenerationError("MODEL_PROVIDER_OUTPUT_LIMIT", model, includeUnreportedReserve()!, this.connection.providerId, request.phase);
      }
      let attemptCost = this.usageCostUsd(attemptUsage);
      // Some compatible providers omit usage receipts on successful responses.
      // Keep the page moving while charging the already bounded stage ceiling;
      // the next phase receives only the remaining page budget.
      if (attemptCost === undefined) attemptCost = chargeAttempt(attemptUsage);
      if (budgetSpent + attemptCost > budget) {
        throw new ModelRouterGenerationError("MODEL_PROVIDER_PAGE_BUDGET_EXCEEDED",
          model, includeUnreportedReserve()!, this.connection.providerId, request.phase);
      }
      budgetSpent += attemptCost;
      let content: unknown;
      const output = extractProviderOutput(received);
      try { content = request.schema && typeof output === "string" ? parseWrappedProviderJson(output) : output; }
      catch {
        // Malformed content is an output-format issue, not a provider outage.
        // Pass the original text to the writer so its single final-format
        // repair can act on this stage without restarting the page or route.
        content = output;
      }
      return { content, usage: includeUnreportedReserve()!, model, provider: this.connection.providerId };
    }
    throw new ModelRouterGenerationError("MODEL_PROVIDER_RETRY_EXHAUSTED", this.connection.model,
      accumulatedUsage ?? emptyUsage(stageStarted), this.connection.providerId, request.phase);
  }

  private usageCostUsd(usage: ModelRouterUsage): number | undefined {
    const reserve = usage.unreportedCostReserveUsd ?? 0;
    if (usage.apiEquivalentUsd !== null) return usage.apiEquivalentUsd + reserve;
    if (usage.inputTokens === 0 && usage.outputTokens === 0) return reserve || undefined;
    const estimate = estimateMicrousd(priceSnapshotFor(this.connection.providerId, this.connection.model), usage.inputTokens, usage.cachedInputTokens, usage.outputTokens);
    return estimate === undefined ? (reserve || undefined) : estimate / 1_000_000 + reserve;
  }

}

function providerFailureCode(status: number, error: ProviderResponseBody["error"]): string {
  const providerError = `${error?.code || ""} ${error?.message || ""}`;
  if (status === 402 || /insufficient[_\s-]+(?:balance|credit|quota)|quota[_\s-]+exhausted|billing[_\s-]+(?:limit|required)|out of credits/i.test(providerError)) {
    return "MODEL_PROVIDER_INSUFFICIENT_BALANCE";
  }
  return `MODEL_PROVIDER_FAILED:${error?.code || status}`;
}

function retryableProviderResponse(status: number, error: ProviderResponseBody["error"]): boolean {
  const providerError = `${error?.code || ""} ${error?.message || ""}`;
  if (/insufficient[_\s-]+(?:balance|credit|quota)|quota[_\s-]+exhausted|billing[_\s-]+(?:limit|required)|out of credits/i.test(providerError)) return false;
  if (/gateway_concurrency_limit/i.test(providerError)) return true;
  if (/\bupstream_reasoning_only\b/i.test(providerError)) return true;
  if (status === 401 || status === 403 || (status >= 400 && status < 500 && status !== 429)) return false;
  return status === 429 || (status >= 500 && status <= 599)
    || /\b(?:rate_limited|rate_limit_exceeded|upstream_error)\b/i.test(providerError);
}

function retryableProviderError(code: string): boolean {
  if (code === "MODEL_PROVIDER_INSUFFICIENT_BALANCE") return false;
  return code === "MODEL_PROVIDER_NETWORK_FAILURE" || code === "MODEL_PROVIDER_TIMEOUT"
    || /^MODEL_PROVIDER_FAILED:(?:429|5\d\d|rate_limited|rate_limit_exceeded|upstream_error|upstream_reasoning_only|gateway_concurrency_limit)$/u.test(code);
}

// The relay rejected five of twenty simultaneous page requests with
// gateway_concurrency_limit. Keep page jobs parallel while bounding requests
// to that relay below its observed capacity; no page needs to fail or restart.
let kuafuInFlight = 0;
const kuafuWaiters: Array<() => void> = [];
async function withKuafuCapacity<T>(providerId: string, work: () => Promise<T>): Promise<T> {
  if (providerId !== "kuafu" && providerId !== "kuafu-backup") return work();
  const configured = Number(process.env.COURSE_OS_KUAFU_MAX_IN_FLIGHT || 12);
  const limit = Number.isFinite(configured) ? Math.max(1, Math.min(20, Math.trunc(configured))) : 12;
  if (kuafuInFlight >= limit) await new Promise<void>(resolve => kuafuWaiters.push(resolve));
  else kuafuInFlight += 1;
  try { return await work(); }
  finally {
    const next = kuafuWaiters.shift();
    if (next) next();
    else kuafuInFlight -= 1;
  }
}

function waitForProviderRetry(response?: Response): Promise<void> {
  const header = response?.headers?.get("retry-after");
  const seconds = header && /^\d+(?:\.\d+)?$/u.test(header) ? Number(header) : undefined;
  const delayMs = seconds === undefined ? 200 : Math.max(50, Math.min(1_000, seconds * 1_000));
  return new Promise(resolve => setTimeout(resolve, delayMs));
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
        if (!(error instanceof ModelRouterGenerationError) || !retryableProviderError(error.code)) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new ModelRouterGenerationError("MODEL_PROVIDER_NOT_CONFIGURED", "unconfigured", emptyUsage(Date.now()), "course-os");
  }

  async understandPage(input: ModelRouterInput) {
    const connection = this.connections.find(candidate => candidate.supportsVision);
    return connection ? new HttpProviderTeachingClient(connection).understandPage(input) : undefined;
  }

  async generateBridge(input: ModelRouterInput & { currentSummary: string }) {
    const connection = [...this.connections].sort((left, right) => scoreConnection(left, input) - scoreConnection(right, input))[0];
    if (!connection) throw new ModelRouterGenerationError("MODEL_PROVIDER_NOT_CONFIGURED", "unconfigured", emptyUsage(Date.now()), "course-os");
    return new HttpProviderTeachingClient(connection).generateBridge(input);
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

  async understandPage(input: ModelRouterInput) {
    if (!input.sourceImageDataUrl) return undefined;
    const { providers: savedProviders, policy, credential } = await this.source.load();
    const providers = withCurrentDeepSeekModels(savedProviders);
    const routes = Array.isArray(policy.routes) ? policy.routes.filter(route => route.enabled) : policy.rules
      .filter(rule => rule.enabled && rule.stage === "extract")
      .map(rule => ({ providerId: rule.providerId, modelId: rule.modelId }));
    for (const route of routes) {
      const provider = providers.find(candidate => candidate.id === route.providerId && candidate.enabled);
      const model = provider?.models.find(candidate => candidate.id === route.modelId && candidate.supportsVision);
      const apiKey = provider && model ? await credential(provider.id) : undefined;
      if (!provider || !model || !apiKey) continue;
      try {
        return await new HttpProviderTeachingClient({ providerId: provider.id, baseUrl: provider.baseUrl,
          apiKey, model: model.id, protocol: model.protocol, supportsVision: true,
          billingMode: model.billingMode }).understandPage(input);
      } catch (error) {
        if (!(error instanceof ModelRouterGenerationError) || !retryableProviderError(error.code)) throw error;
      }
    }
    return undefined;
  }

  async generateBridge(input: ModelRouterInput & { currentSummary: string }) {
    return this.runWithFallback("teach", input, (client, routedInput) => client.generateBridge({ ...routedInput, currentSummary: input.currentSummary }));
  }

  async generateTeachingPackage(input: ModelRouterInput): Promise<TeachingGenerationResult> {
    return this.runWithFallback(input.stage || "teach", input, (client, routedInput) => client.generateTeachingPackage(routedInput));
  }

  private async runWithFallback<T>(stage: GenerationStage | "qa", input: ModelRouterInput,
    execute: (client: HttpProviderTeachingClient, routedInput: ModelRouterInput) => Promise<T>): Promise<T> {
    const { providers: savedProviders, policy, credential } = await this.source.load();
    const providers = withCurrentDeepSeekModels(savedProviders);
    const rule = policy.rules.find((candidate) => candidate.stage === stage && candidate.enabled)
      || policy.rules.find((candidate) => candidate.stage === "teach" && candidate.enabled);
    if (!rule) throw new ModelRouterGenerationError("MODEL_PROVIDER_ROUTE_NOT_CONFIGURED", "unconfigured", emptyUsage(Date.now()), "course-os");

    const orderedRoutes = policy.routes?.filter((candidate) => candidate.enabled) ?? [];
    const legacyRoutes = [
      { providerId: rule.providerId, modelId: rule.modelId },
      ...(policy.allowProviderFallback !== false && rule.fallbackProviderId && rule.fallbackModelId ? [{ providerId: rule.fallbackProviderId, modelId: rule.fallbackModelId }] : [])
    ];
    const candidates = (Array.isArray(policy.routes) ? orderedRoutes : legacyRoutes)
      .slice(0, policy.allowProviderFallback === false ? 1 : undefined);
    let lastError: ModelRouterGenerationError | undefined;
    for (const candidate of candidates) {
      const provider = providers.find((item) => item.id === candidate.providerId && item.enabled);
      const model = provider?.models.find((item) => item.id === candidate.modelId);
      const apiKey = provider ? await credential(provider.id) : undefined;
      if (!provider || !model || !apiKey) {
        lastError = new ModelRouterGenerationError("MODEL_PROVIDER_NOT_CONFIGURED", candidate.modelId, emptyUsage(Date.now()), candidate.providerId);
        continue;
      }
      const canUseExtractedSource = input.sourceText.trim().length > 0;
      if (input.sourceImageDataUrl && !model.supportsVision && !canUseExtractedSource) {
        lastError = new ModelRouterGenerationError("MODEL_PROVIDER_VISION_UNAVAILABLE", model.id, emptyUsage(Date.now()), provider.id);
        continue;
      }
      // ReadWeave-style generation separates source perception from teaching:
      // a text-only writing model receives the extracted source instead
      // of being skipped merely because the original page
      // image is also available. Image-only pages still require a vision route.
      const routedInput = input.sourceImageDataUrl && !model.supportsVision
        ? { ...input, sourceImageDataUrl: undefined }
        : input;
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
        return await withKuafuCapacity(provider.id, () => execute(new HttpProviderTeachingClient(connection), routedInput));
      } catch (error) {
        if (!(error instanceof ModelRouterGenerationError)) throw error;
        // Explicit routes are used only for transient provider failures. Auth,
        // quota exhaustion, malformed JSON and content errors are returned as
        // they stand so a fallback cannot restart a whole page generation.
        if (!retryableProviderError(error.code)) throw error;
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
  const kuafuKey = process.env.KUAFU_API_KEY;
  const deepSeekKey = process.env.DEEPSEEK_API_KEY;
  const connections: ProviderConnection[] = [];
  if (openCodeKey) {
    const model = process.env.OPENCODE_GO_MODEL || "deepseek-v4-flash-vision-exp";
    connections.push({ providerId: "opencode-go", baseUrl: process.env.OPENCODE_GO_BASE_URL || "https://opencode.ai/zen/go/v1", apiKey: openCodeKey, model, protocol: openCodeProtocol(model), supportsVision: openCodeSupportsVision(model), billingMode: "subscription_quota" });
  }
  if (kuafuKey) {
    const model = process.env.KUAFU_MODEL || "deepseek-v4.1-flash";
    connections.push({ providerId: "kuafu", baseUrl: process.env.KUAFU_BASE_URL || "https://api.kuafushe.cc/v1", apiKey: kuafuKey, model, protocol: "responses", supportsVision: process.env.KUAFU_SUPPORTS_VISION === "true", billingMode: "metered" });
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
  if (input.qualityMode === "economy") return connection.providerId === "opencode-go" ? 0 : connection.providerId === "kuafu" ? 5 : 10;
  return connection.providerId === "deepseek" ? 0 : 10;
}

interface ProviderResponseBody {
  id?: string;
  model?: string;
  output?: unknown;
  output_text?: string;
  choices?: Array<{ message?: { content?: string | Array<{ text?: string }> }; text?: string; finish_reason?: string }>;
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

function parseJsonCandidate(candidate: string): unknown {
  try { return JSON.parse(candidate); }
  catch {
    let inString = false;
    let escaped = false;
    let repaired = "";
    for (let index = 0; index < candidate.length; index += 1) {
      const character = candidate[index]!;
      if (escaped) { repaired += character; escaped = false; continue; }
      if (character === '"') { inString = !inString; repaired += character; continue; }
      if (inString && character === "\\") {
        const next = candidate[index + 1] || "";
        if (next && !/^["\\/bfnrtu]$/.test(next)) repaired += "\\";
        repaired += character;
        escaped = true;
        continue;
      }
      // Some OpenAI-compatible relays preserve literal control characters in
      // streamed JSON strings. They are valid model text but invalid JSON on
      // the wire, so escape only those transport characters before parsing.
      if (inString && character === "\n") { repaired += "\\n"; continue; }
      if (inString && character === "\r") { repaired += "\\r"; continue; }
      if (inString && character === "\t") { repaired += "\\t"; continue; }
      repaired += character;
    }
    return JSON.parse(repaired);
  }
}

function parseProviderJson(value: string): unknown {
  return parseJsonCandidate(stripJsonFences(value));
}

export function parseWrappedProviderJson(value: string): unknown {
  const source = stripJsonFences(value);
  try { return parseJsonCandidate(source); }
  catch {
    const candidates: Array<{ length: number; value: unknown }> = [];
    for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = start; index < source.length; index += 1) {
        const character = source[index]!;
        if (inString) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') { inString = true; continue; }
        if (character === "{") depth += 1;
        else if (character === "}" && --depth === 0) {
          const candidate = source.slice(start, index + 1);
          try { candidates.push({ length: candidate.length, value: parseJsonCandidate(candidate) }); } catch { /* keep scanning */ }
          break;
        }
      }
    }
    const best = candidates.sort((left, right) => right.length - left.length)[0];
    if (best) return best.value;
    const recovered = recoverCompletedJsonObject(source);
    if (recovered) return recovered;
    throw new Error("MODEL_PROVIDER_OUTPUT_JSON_INVALID");
  }
}

/** Recover only complete top-level members from a truncated object; later schema checks remain authoritative. */
function recoverCompletedJsonObject(source: string): Record<string, unknown> | undefined {
  if (source.length > 256_000) return undefined;
  const root = source.indexOf("{");
  if (root < 0) return undefined;
  let cursor = root + 1;
  const recovered: Record<string, unknown> = {};
  const whitespace = () => { while (/\s/u.test(source[cursor] ?? "")) cursor += 1; };
  const stringEnd = (start: number): number | undefined => {
    if (source[start] !== '"') return undefined;
    let escaped = false;
    for (let index = start + 1; index < source.length; index += 1) {
      const character = source[index]!;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') return index + 1;
    }
    return undefined;
  };
  const valueEnd = (start: number): number | undefined => {
    const first = source[start];
    if (!first) return undefined;
    if (first === '"') return stringEnd(start);
    if (first !== "{" && first !== "[") {
      let end = start;
      while (end < source.length && !/[\s,}\]]/u.test(source[end]!)) end += 1;
      return end > start ? end : undefined;
    }
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{" || character === "[") stack.push(character);
      else if (character === "}" || character === "]") {
        const expected = character === "}" ? "{" : "[";
        if (stack.pop() !== expected) return undefined;
        if (stack.length === 0) return index + 1;
      }
    }
    return undefined;
  };

  while (cursor < source.length) {
    whitespace();
    if (source[cursor] === "}") return Object.keys(recovered).length ? recovered : undefined;
    const keyEnd = stringEnd(cursor);
    if (keyEnd === undefined) break;
    let key: unknown;
    try { key = parseJsonCandidate(source.slice(cursor, keyEnd)); } catch { break; }
    if (typeof key !== "string") break;
    cursor = keyEnd;
    whitespace();
    if (source[cursor] !== ":") break;
    cursor += 1;
    whitespace();
    const end = valueEnd(cursor);
    if (end === undefined) break;
    let member: unknown;
    try { member = parseJsonCandidate(source.slice(cursor, end)); } catch { break; }
    recovered[key] = member;
    cursor = end;
    whitespace();
    if (source[cursor] === "}") return recovered;
    if (source[cursor] !== ",") break;
    cursor += 1;
  }
  return Object.keys(recovered).length ? recovered : undefined;
}
