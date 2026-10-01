import type {
  CourseConflict,
  CourseProject,
  CourseRelease,
  CostRollup,
  GenerationCostEntry,
  GenerationJob,
  GenerationPlan,
  ImportRecord,
  LearningSession,
  LessonDraft,
  MasteryRecord,
  PageQuestion,
  QuestionAttempt,
  QuestionBankItem,
  QuestionSelection,
  QualityValidationResult,
  ReadWeaveSyncStatus,
  WorkspaceTree,
  CourseTreeNode,
  TrashRecord,
  ReadWeaveDeepLink,
  WorkspaceSettings,
  ModelProviderConfig,
  ModelRoutePolicy,
  SearchProviderConfig,
  SearchRoutePolicy,
  ReviewMap,
  ReviewPlan,
  ReviewSession,
  ReviewAttemptResult,
  WritingPolicyCurrent,
  GenerationHarnessCurrent,
  SelfRetelling
} from "@course-os/contracts";
import type { ImportTaskSummary, WebGenerationPlan, WebImportRecord } from "./types.js";
import { readQuestionBatchState } from "./question-preview.js";

export type { SearchProviderConfig, SearchRoutePolicy } from "@course-os/contracts";

export interface ReadWeaveEtapiSettings {
  enabled: boolean;
  baseUrl: string;
  parentNoteId: string;
  publicUrl: string;
  credential: { configured: boolean; maskedValue?: string; updatedAt?: string };
}

export type ReadWeaveEtapiSettingsUpdate = Partial<Pick<ReadWeaveEtapiSettings, "enabled" | "baseUrl" | "parentNoteId" | "publicUrl">> & { token?: string };
export type ModelProviderCreate = Pick<ModelProviderConfig, "id" | "displayName" | "baseUrl" | "enabled" | "models">;
export interface ApiRequestOptions {
  signal?: AbortSignal;
  releaseId?: string;
  confirm?: boolean;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const WORKSPACE_ID = "personal";
const READ_REQUEST_TIMEOUT_MS = 10_000;

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly code = "HTTP_ERROR",
    public readonly status = 500,
    public readonly retryable = false,
    public readonly details?: unknown,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function requestId(): string {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `request-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
type QuestionSelectionResponse = {
  selection: QuestionSelection;
  questions: QuestionBankItem[];
  available: number;
  draftCount?: number;
};

type QuestionRefillResponse = {
  pageId: string;
  added: QuestionBankItem[];
  available: number;
  draftCount: number;
  revision: number;
  draft: LessonDraft;
};

const questionSelectionRequests = new Map<string, Promise<QuestionSelectionResponse>>();

type ApiProblem = {
  error?: {
    message?: string;
    code?: string;
    retryable?: boolean;
    details?: unknown;
    requestId?: string;
  };
  requestId?: string;
};

function asProblem(value: unknown): ApiProblem | undefined {
  return value && typeof value === "object" ? value as ApiProblem : undefined;
}

function isHtmlResponse(contentType: string, body: string): boolean {
  return contentType.toLowerCase().includes("text/html") || /^\s*(?:<!doctype\s+html|<html\b)/i.test(body);
}

function isLoginPage(contentType: string, body: string): boolean {
  return isHtmlResponse(contentType, body) && /\b(?:sign\s*in|log\s*in|login|password|session\s+expired|authenticate)\b/i.test(body);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The request was aborted.", "AbortError");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method || "GET").toUpperCase();
  const isReadRequest = ["GET", "HEAD", "OPTIONS"].includes(method);
  const requestIdValue = requestId();
  const headers = new Headers(init?.headers);
  headers.set("X-Request-Id", requestIdValue);
  headers.set("X-Workspace-Id", WORKSPACE_ID);
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("X-Actor", "personal-user");
    headers.set("X-Schema-Version", "2.4.0");
  }
  const externalSignal = isReadRequest ? init?.signal : undefined;
  const controller = isReadRequest ? new AbortController() : undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let forwardAbort: (() => void) | undefined;

  if (controller && externalSignal?.aborted) throw abortReason(externalSignal);
  if (controller && externalSignal) {
    forwardAbort = () => controller.abort(abortReason(externalSignal));
    externalSignal.addEventListener("abort", forwardAbort, { once: true });
  }
  if (controller) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("The read request timed out.", "TimeoutError"));
    }, READ_REQUEST_TIMEOUT_MS);
  }

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      ...(controller ? { signal: controller.signal } : {})
    });
    if (controller?.signal.aborted) throw abortReason(controller.signal);

    if (response.status === 204) return undefined as T;
    const body = await response.text();
    if (controller?.signal.aborted) throw abortReason(controller.signal);

    let payload: unknown;
    if (body.length > 0) {
      try {
        payload = JSON.parse(body);
      } catch {
        payload = undefined;
      }
    }
    const problem = asProblem(payload);
    const errorRequestId = response.headers.get("x-request-id")
      || problem?.error?.requestId
      || problem?.requestId
      || requestIdValue;

    if (!response.ok) {
      const statusCode = response.status === 401 ? "UNAUTHORIZED" : response.status === 403 ? "FORBIDDEN" : "HTTP_ERROR";
      const statusMessage = response.status === 401
        ? "登录状态已失效，请重新登录"
        : response.status === 403
          ? "当前账号无权访问此内容"
          : `HTTP ${response.status}`;
      throw new ApiRequestError(
        response.status === 401 || response.status === 403 ? statusMessage : problem?.error?.message || statusMessage,
        problem?.error?.code || statusCode,
        response.status,
        Boolean(problem?.error?.retryable),
        problem?.error?.details,
        errorRequestId
      );
    }

    const contentType = response.headers.get("content-type") || "";
    if (isLoginPage(contentType, body)) {
      throw new ApiRequestError(
        "接口返回了登录页面，登录状态可能已失效，请重新登录",
        "AUTH_REQUIRED",
        response.status,
        false,
        undefined,
        errorRequestId
      );
    }
    if (payload === undefined) {
      if (isHtmlResponse(contentType, body)) {
        throw new ApiRequestError("接口返回了 HTML 页面，暂时无法读取内容", "INVALID_RESPONSE", response.status, false, undefined, errorRequestId);
      }
      throw new ApiRequestError("接口返回的数据格式无效", "INVALID_RESPONSE", response.status, false, undefined, errorRequestId);
    }
    return payload as T;
  } catch (error) {
    if (timedOut) {
      throw new ApiRequestError(
        "读取超时（10 秒），请手动重试",
        "REQUEST_TIMEOUT",
        408,
        true,
        undefined,
        requestIdValue
      );
    }
    if (externalSignal?.aborted) throw abortReason(externalSignal);
    if (error instanceof TypeError) {
      throw new ApiRequestError("网络连接失败，请检查网络后重试", "NETWORK_ERROR", 0, true, undefined, requestIdValue);
    }
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (externalSignal && forwardAbort) externalSignal.removeEventListener("abort", forwardAbort);
  }
}

export const api = {
  createCourse: (title: string, description?: string) => request<CourseProject>("/api/v1/courses", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ title, description })
  }),
  workspaceTree: (workspaceId = WORKSPACE_ID, options?: ApiRequestOptions) => request<WorkspaceTree>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tree?view=library`, { signal: options?.signal }),
  createModule: (courseId: string, title: string, description?: string) => request<CourseTreeNode>("/api/v1/modules", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ courseId, title, description })
  }),
  updateTreeNode: (node: CourseTreeNode, patch: { title?: string; parentId?: string | null; archived?: boolean; sortOrder?: number }) => request<CourseTreeNode>(`/api/v1/tree/nodes/${encodeURIComponent(node.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ ...patch, expectedRevision: node.revision ?? 0 })
  }),
  treeNodeProperties: (nodeId: string, options?: ApiRequestOptions) => request<import("@course-os/contracts").TreeNodeProperties>(`/api/v1/tree/nodes/${encodeURIComponent(nodeId)}/properties`, { signal: options?.signal }),
  treeNodeVersions: (nodeId: string, options?: ApiRequestOptions) => request<CourseRelease[]>(`/api/v1/tree/nodes/${encodeURIComponent(nodeId)}/versions`, { signal: options?.signal }),
  duplicateTreeNode: (node: CourseTreeNode) => request<CourseTreeNode>(`/api/v1/tree/nodes/${encodeURIComponent(node.id)}:duplicate`, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() }
  }),
  trashTreeNode: (node: CourseTreeNode) => request<TrashRecord>(`/api/v1/tree/nodes/${encodeURIComponent(node.id)}:trash`, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() }
  }),
  trash: (options?: ApiRequestOptions) => request<TrashRecord[]>("/api/v1/trash", { signal: options?.signal }),
  restoreTrash: (item: TrashRecord, restoreMode: "original" | "root" = "original") => request<CourseTreeNode>(`/api/v1/trash/${encodeURIComponent(item.id)}:restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ restoreMode })
  }),
  permanentlyDeleteTrash: (item: TrashRecord) => request<void>(`/api/v1/trash/${encodeURIComponent(item.id)}`, {
    method: "DELETE",
    headers: { "Idempotency-Key": crypto.randomUUID() }
  }),
  deepLink: (noteId: string, options?: ApiRequestOptions) => request<ReadWeaveDeepLink>(`/api/v1/readweave/links/${encodeURIComponent(noteId)}`, { signal: options?.signal }),
  settings: (options?: ApiRequestOptions) => request<WorkspaceSettings>("/api/v1/settings", { signal: options?.signal }),
  saveSettings: (settings: WorkspaceSettings) => request<WorkspaceSettings>("/api/v1/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(settings)
  }),
  modelProviders: (options?: ApiRequestOptions) => request<ModelProviderConfig[]>("/api/v1/model-providers", { signal: options?.signal }),
  createModelProvider: (provider: ModelProviderCreate) => request<ModelProviderConfig>("/api/v1/model-providers", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(provider)
  }),
  updateModelProvider: (providerId: string, patch: Partial<ModelProviderCreate>) => request<ModelProviderConfig>(`/api/v1/model-providers/${encodeURIComponent(providerId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(patch)
  }),
  deleteModelProvider: (providerId: string) => request<void>(`/api/v1/model-providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
    headers: { "Idempotency-Key": crypto.randomUUID() }
  }),
  saveProviderCredential: (providerId: string, secret: string) => request<Pick<ModelProviderConfig, "id" | "credential">>(`/api/v1/model-providers/${encodeURIComponent(providerId)}/credential`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ secret })
  }),
  testProvider: (providerId: string) => request<ModelProviderConfig>(`/api/v1/model-providers/${encodeURIComponent(providerId)}:test`, { method: "POST" }),
  searchProviders: (options?: ApiRequestOptions) => request<SearchProviderConfig[]>("/api/v1/search-providers", { signal: options?.signal }),
  updateSearchProvider: (providerId: string, patch: { baseUrl?: string; endpoint?: string; enabled?: boolean; maxResults?: number }) => request<SearchProviderConfig>(`/api/v1/search-providers/${encodeURIComponent(providerId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(patch)
  }),
  saveSearchProviderCredential: (providerId: string, secret: string) => request<Pick<SearchProviderConfig, "id" | "credential">>(`/api/v1/search-providers/${encodeURIComponent(providerId)}/credential`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ secret })
  }),
  testSearchProvider: (providerId: string) => request<SearchProviderConfig>(`/api/v1/search-providers/${encodeURIComponent(providerId)}:test`, { method: "POST" }),
  searchRoutePolicy: (options?: ApiRequestOptions) => request<SearchRoutePolicy>("/api/v1/search-route-policy", { signal: options?.signal }),
  saveSearchRoutePolicy: (policy: SearchRoutePolicy) => request<SearchRoutePolicy>("/api/v1/search-route-policy", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(policy)
  }),
  modelRoutePolicy: (options?: ApiRequestOptions) => request<ModelRoutePolicy>("/api/v1/model-route-policy", { signal: options?.signal }),
  saveModelRoutePolicy: (policy: ModelRoutePolicy) => request<ModelRoutePolicy>("/api/v1/model-route-policy", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(policy)
  }),
  readweaveEtapiSettings: (options?: ApiRequestOptions) => request<ReadWeaveEtapiSettings>("/api/v1/readweave/etapi-settings", { signal: options?.signal }),
  updateReadweaveEtapiSettings: (settings: ReadWeaveEtapiSettingsUpdate) => request<ReadWeaveEtapiSettings>("/api/v1/readweave/etapi-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(settings)
  }),
  deleteReadweaveEtapiSettings: () => request<void>("/api/v1/readweave/etapi-settings", {
    method: "DELETE",
    headers: { "Idempotency-Key": crypto.randomUUID() }
  }),
  releases: (options?: ApiRequestOptions) => request<CourseRelease[]>("/api/v1/releases?view=index", { signal: options?.signal }),
  release: (id: string, options?: ApiRequestOptions) => request<CourseRelease>(`/api/v1/releases/${encodeURIComponent(id)}`, { signal: options?.signal }),
  lesson: (pageId: string, options?: ApiRequestOptions) => request<{ releaseId: string; page: CourseRelease["pages"][number]; unpublishedDraftRevision?: number; qaRecords: PageQuestion[] }>(`/api/v1/pages/${encodeURIComponent(pageId)}/lesson${options?.releaseId ? `?releaseId=${encodeURIComponent(options.releaseId)}` : ""}`, { signal: options?.signal }),
  pageQuestions: (pageId: string, options?: ApiRequestOptions) => request<PageQuestion[]>(`/api/v1/pages/${encodeURIComponent(pageId)}/questions`, { signal: options?.signal }),
  selfRetellings: (releaseId?: string, options?: ApiRequestOptions) => request<SelfRetelling[]>(`/api/v1/self-retellings${releaseId ? `?releaseId=${encodeURIComponent(releaseId)}` : ""}`, { signal: options?.signal }),
  saveSelfRetelling: (releaseId: string, pageId: string, answer: string, idempotencyKey: string) => request<SelfRetelling>(`/api/v1/self-retellings/${encodeURIComponent(releaseId)}/${encodeURIComponent(pageId)}`, {
    method: "PUT", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ answer })
  }),
  reviewSelfRetelling: (releaseId: string, pageId: string, result: "again" | "remembered") => request<SelfRetelling>(`/api/v1/self-retellings/${encodeURIComponent(releaseId)}/${encodeURIComponent(pageId)}/review`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ result })
  }),
  readweaveQuestions: (pageId: string, options?: ApiRequestOptions) => request<import("@course-os/contracts").ReadWeavePageQuestions>(`/api/v1/pages/${encodeURIComponent(pageId)}/readweave-questions`, { signal: options?.signal }),
  draft: (pageId: string, options?: ApiRequestOptions) => request<LessonDraft>(`/api/v1/pages/${encodeURIComponent(pageId)}/draft`, { signal: options?.signal }),
  draftSnapshot: (pageId: string, options?: ApiRequestOptions) => request<LessonDraft>(`/api/v1/pages/${encodeURIComponent(pageId)}/draft?view=snapshot${options?.releaseId ? `&releaseId=${encodeURIComponent(options.releaseId)}` : ""}${options?.confirm ? "&confirm=1" : ""}`, { signal: options?.signal }),
  saveDraft: (draft: LessonDraft, page: LessonDraft["page"], changedBlockIds: string[]) => request<LessonDraft>(`/api/v1/pages/${encodeURIComponent(draft.pageId)}/draft`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ baseRevision: draft.revision, page, changedBlockIds })
  }),
  validateDraft: (pageId: string) => request<QualityValidationResult>(`/api/v1/pages/${encodeURIComponent(pageId)}:validate`, { method: "POST" }),
  syncStatus: (options?: ApiRequestOptions) => request<ReadWeaveSyncStatus>("/api/v1/sync/status", { signal: options?.signal }),
  conflicts: (options?: ApiRequestOptions) => request<CourseConflict[]>("/api/v1/conflicts", { signal: options?.signal }),
  resolveConflict: (conflictId: string, resolution: "local" | "remote" | "merged", mergedContent?: string) => request<CourseConflict>(`/api/v1/conflicts/${encodeURIComponent(conflictId)}:resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ resolution, mergedContent })
  }),
  publish: (baseReleaseId: string) => request<CourseRelease>("/api/v1/releases", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ baseReleaseId })
  }),
  importMaterial: (file: File, courseId?: string, options: { qualityMode?: string; language?: string; parentNodeId?: string; autoGenerate?: boolean; previousMaterialVersionId?: string } = {}) => {
    const body = new FormData();
    body.append("file", file);
    body.append("source", "course-os-studio");
    body.append("license", "private_course_material");
    if (courseId) body.append("courseId", courseId);
    if (options.qualityMode) body.append("qualityMode", options.qualityMode);
    if (options.language) body.append("language", options.language);
    if (options.parentNodeId) body.append("parentNodeId", options.parentNodeId);
    if (options.previousMaterialVersionId) body.append("previousMaterialVersionId", options.previousMaterialVersionId);
    body.append("autoGenerate", String(options.autoGenerate !== false));
    return request<ImportRecord>("/api/v1/imports", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body });
  },
  importTasks: (options?: ApiRequestOptions) => request<ImportTaskSummary[]>("/api/v1/imports", { signal: options?.signal }),
  importRecord: (importId: string, options?: ApiRequestOptions) => request<WebImportRecord>(`/api/v1/imports/${encodeURIComponent(importId)}`, { signal: options?.signal }),
  createGenerationJob: (materialVersionId: string, pageIds: string[], budgetUsd: number) => request<GenerationJob>("/api/v1/generation-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ materialVersionId, pageIds, budgetUsd })
  }),
  generationJob: (jobId: string, options?: ApiRequestOptions) => request<GenerationJob>(`/api/v1/generation-jobs/${encodeURIComponent(jobId)}`, { signal: options?.signal }),
  createGenerationPlan: (materialVersionId: string, pageIds: string[], budgetUsd: number, options: { qualityMode?: string; language?: string; sourceImportId?: string; holdForReview?: boolean } = {}) => request<{ plan: GenerationPlan; currentJob?: GenerationJob }>("/api/v1/generation-plans", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ materialVersionId, pageIds, budgetUsd, ...options })
  }),
  generationPlan: (planId: string, options?: ApiRequestOptions) => request<{ plan: WebGenerationPlan; currentJob?: GenerationJob; activeJobs?: GenerationJob[] }>(`/api/v1/generation-plans/${encodeURIComponent(planId)}`, { signal: options?.signal }),
  retryGenerationPlanFailed: (planId: string) => request<{ plan: WebGenerationPlan; jobs: GenerationJob[] }>(`/api/v1/generation-plans/${encodeURIComponent(planId)}:retry-failed`, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() }
  }),
  writingPolicy: (options?: ApiRequestOptions) => request<WritingPolicyCurrent>("/api/v1/writing-policy/current", { signal: options?.signal }),
  generationHarness: (options?: ApiRequestOptions) => request<GenerationHarnessCurrent>("/api/v1/generation-harness/current", { signal: options?.signal }),
  costs: (filters: { courseId?: string; materialVersionId?: string; pageId?: string; jobId?: string } = {}, options?: ApiRequestOptions) => {
    const query = new URLSearchParams(Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1])));
    return request<{ entries: GenerationCostEntry[]; rollups: CostRollup[] }>(`/api/v1/costs${query.size ? `?${query}` : ""}`, { signal: options?.signal });
  },
  createSession: (courseReleaseId: string, sessionId?: string) => request<LearningSession>("/api/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ courseReleaseId, sessionId })
  }),
  updateSession: (sessionId: string, patch: Partial<LearningSession>) => request<LearningSession>(`/api/v1/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  }),
  ask: (sessionId: string, payload: { pageId: string; question: string; learnerAttempt: string; hintLevel: number; anchorIds: string[] }) => request<PageQuestion>(`/api/v1/sessions/${sessionId}/questions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(payload)
  }),
  retractQuestion: (question: PageQuestion) => request<PageQuestion>(`/api/v1/questions/${encodeURIComponent(question.id)}:retract`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ baseRevision: question.revision })
  }),
  setQuestionReviewPolicy: (question: PageQuestion, reviewPolicy: "include" | "exclude") => request<PageQuestion>(`/api/v1/questions/${encodeURIComponent(question.id)}/review-policy`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ baseRevision: question.revision, reviewPolicy })
  }),
  selectQuestions: (pageId: string, sessionId: string, seed?: string, count?: 2 | 3 | 5, excludeQuestionIds?: string[], allowRepeat = false) => {
    const savedBatch = seed === undefined ? readQuestionBatchState(sessionId, pageId) : undefined;
    const stableSeed = seed || savedBatch?.activeSeed || `${sessionId}:${pageId}:${new Date().toISOString().slice(0, 10)}`;
    const stableCount = count ?? savedBatch?.activeCount ?? 3;
    const excluded = excludeQuestionIds ?? savedBatch?.activeExcludedQuestionIds ?? [];
    const cacheKey = `${sessionId}:${pageId}:${stableSeed}:${stableCount}`;
    const existing = questionSelectionRequests.get(cacheKey);
    if (existing) return existing;
    const pending = request<QuestionSelectionResponse>(`/api/v1/pages/${encodeURIComponent(pageId)}/questions:select`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `question-selection:${crypto.randomUUID()}` },
      body: JSON.stringify({ sessionId, seed: stableSeed, count: stableCount, excludeQuestionIds: excluded, allowRepeat })
    }).catch((error) => { questionSelectionRequests.delete(cacheKey); throw error; });
    questionSelectionRequests.set(cacheKey, pending);
    return pending;
  },
  questionAttempts: (pageId: string, sessionId: string, selectionId: string, options?: ApiRequestOptions) => request<QuestionAttempt[]>(`/api/v1/pages/${encodeURIComponent(pageId)}/question-attempts?sessionId=${encodeURIComponent(sessionId)}&selectionId=${encodeURIComponent(selectionId)}`, { signal: options?.signal }),
  refillQuestions: (pageId: string, baseRevision: number) => request<QuestionRefillResponse>(`/api/v1/pages/${encodeURIComponent(pageId)}/questions:refill`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ baseRevision })
  }),
  questionAttempt: (payload: { selectionId: string; sessionId: string; courseReleaseId: string; pageId: string; questionId: string; questionVersion: number; answer: string; usedHintLevel: number }, idempotencyKey: string = crypto.randomUUID()) => request<{ attempt: QuestionAttempt; mastery: MasteryRecord | null; evaluationState: "correct" | "incorrect" | "unverified"; feedback: string }>("/api/v1/question-attempts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(payload)
  }),
  attempt: (payload: { courseReleaseId: string; itemId: string; answer: string; usedHintLevel: number }) => request<{ attempt: { correct: boolean }; mastery: MasteryRecord; feedback: string }>("/api/v1/assessment-attempts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(payload)
  }),
  reviewQueue: (options?: ApiRequestOptions) => request<MasteryRecord[]>("/api/v1/review-queue", { signal: options?.signal }),
  reviewMap: (options?: ApiRequestOptions) => request<ReviewMap>("/api/v1/review-map", { signal: options?.signal }),
  createReviewPlan: (payload: { source: "due" | "manual"; objectiveIds: string[]; seed?: string; budgetUsd?: number }) => request<{ plan: ReviewPlan }>("/api/v1/review-plans", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(payload)
  }),
  reviewPlan: (id: string, options?: ApiRequestOptions) => request<{ plan: ReviewPlan }>(`/api/v1/review-plans/${encodeURIComponent(id)}`, { signal: options?.signal }),
  retryReviewPlan: (id: string) => request<{ plan: ReviewPlan }>(`/api/v1/review-plans/${encodeURIComponent(id)}:retry`, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() }
  }),
  cancelReviewPlan: (id: string) => request<{ plan: ReviewPlan }>(`/api/v1/review-plans/${encodeURIComponent(id)}:cancel`, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() }
  }),
  startReviewPlan: (id: string) => request<ReviewSessionResponse>(`/api/v1/review-plans/${encodeURIComponent(id)}:start`, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() }
  }),
  currentReviewSession: (options?: ApiRequestOptions) => request<ReviewSessionResponse>("/api/v1/review-sessions/current", { signal: options?.signal }),
  createReviewSession: (payload: { source: "due" | "manual"; objectiveIds?: string[]; count?: number; seed?: string }) => request<ReviewSessionResponse>("/api/v1/review-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(payload)
  }),
  reviewSession: (id: string, options?: ApiRequestOptions) => request<ReviewSessionResponse>(`/api/v1/review-sessions/${encodeURIComponent(id)}`, { signal: options?.signal }),
  reviewSessionAttempt: (id: string, payload: { answer: string; usedHintLevel: number; questionId?: string }) => request<ReviewAttemptResult & { session: ReviewSession; question?: QuestionBankItem }>(`/api/v1/review-sessions/${encodeURIComponent(id)}/attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(payload)
  }),
  skipReviewSession: (id: string) => request<ReviewSessionResponse>(`/api/v1/review-sessions/${encodeURIComponent(id)}/skip`, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() }
  })
};

type ReviewSessionResponse = {
  session: ReviewSession;
  objective?: ReviewMap["objectives"][number];
  question?: QuestionBankItem;
};
