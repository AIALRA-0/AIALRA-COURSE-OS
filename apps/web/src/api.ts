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

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const WORKSPACE_ID = "personal";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly code = "HTTP_ERROR",
    public readonly status = 500,
    public readonly retryable = false,
    public readonly details?: unknown
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method || "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  headers.set("X-Request-Id", requestId());
  headers.set("X-Workspace-Id", WORKSPACE_ID);
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("X-Actor", "personal-user");
    headers.set("X-Schema-Version", "2.4.0");
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({ error: { message: response.statusText } }));
    throw new ApiRequestError(
      problem.error?.message || `HTTP ${response.status}`,
      problem.error?.code || "HTTP_ERROR",
      response.status,
      Boolean(problem.error?.retryable),
      problem.error?.details
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  createCourse: (title: string, description?: string) => request<CourseProject>("/api/v1/courses", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ title, description })
  }),
  workspaceTree: (workspaceId = WORKSPACE_ID) => request<WorkspaceTree>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tree?view=library`),
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
  treeNodeProperties: (nodeId: string) => request<import("@course-os/contracts").TreeNodeProperties>(`/api/v1/tree/nodes/${encodeURIComponent(nodeId)}/properties`),
  treeNodeVersions: (nodeId: string) => request<CourseRelease[]>(`/api/v1/tree/nodes/${encodeURIComponent(nodeId)}/versions`),
  duplicateTreeNode: (node: CourseTreeNode) => request<CourseTreeNode>(`/api/v1/tree/nodes/${encodeURIComponent(node.id)}:duplicate`, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() }
  }),
  trashTreeNode: (node: CourseTreeNode) => request<TrashRecord>(`/api/v1/tree/nodes/${encodeURIComponent(node.id)}:trash`, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() }
  }),
  trash: () => request<TrashRecord[]>("/api/v1/trash"),
  restoreTrash: (item: TrashRecord, restoreMode: "original" | "root" = "original") => request<CourseTreeNode>(`/api/v1/trash/${encodeURIComponent(item.id)}:restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ restoreMode })
  }),
  permanentlyDeleteTrash: (item: TrashRecord) => request<void>(`/api/v1/trash/${encodeURIComponent(item.id)}`, {
    method: "DELETE",
    headers: { "Idempotency-Key": crypto.randomUUID() }
  }),
  deepLink: (noteId: string) => request<ReadWeaveDeepLink>(`/api/v1/readweave/links/${encodeURIComponent(noteId)}`),
  settings: () => request<WorkspaceSettings>("/api/v1/settings"),
  saveSettings: (settings: WorkspaceSettings) => request<WorkspaceSettings>("/api/v1/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(settings)
  }),
  modelProviders: () => request<ModelProviderConfig[]>("/api/v1/model-providers"),
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
  searchProviders: () => request<SearchProviderConfig[]>("/api/v1/search-providers"),
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
  searchRoutePolicy: () => request<SearchRoutePolicy>("/api/v1/search-route-policy"),
  saveSearchRoutePolicy: (policy: SearchRoutePolicy) => request<SearchRoutePolicy>("/api/v1/search-route-policy", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(policy)
  }),
  modelRoutePolicy: () => request<ModelRoutePolicy>("/api/v1/model-route-policy"),
  saveModelRoutePolicy: (policy: ModelRoutePolicy) => request<ModelRoutePolicy>("/api/v1/model-route-policy", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(policy)
  }),
  readweaveEtapiSettings: () => request<ReadWeaveEtapiSettings>("/api/v1/readweave/etapi-settings"),
  updateReadweaveEtapiSettings: (settings: ReadWeaveEtapiSettingsUpdate) => request<ReadWeaveEtapiSettings>("/api/v1/readweave/etapi-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(settings)
  }),
  deleteReadweaveEtapiSettings: () => request<void>("/api/v1/readweave/etapi-settings", {
    method: "DELETE",
    headers: { "Idempotency-Key": crypto.randomUUID() }
  }),
  releases: () => request<CourseRelease[]>("/api/v1/releases?view=index"),
  release: (id: string) => request<CourseRelease>(`/api/v1/releases/${encodeURIComponent(id)}`),
  lesson: (pageId: string) => request<{ releaseId: string; page: CourseRelease["pages"][number]; qaRecords: PageQuestion[] }>(`/api/v1/pages/${encodeURIComponent(pageId)}/lesson`),
  selfRetellings: (releaseId?: string) => request<SelfRetelling[]>(`/api/v1/self-retellings${releaseId ? `?releaseId=${encodeURIComponent(releaseId)}` : ""}`),
  saveSelfRetelling: (releaseId: string, pageId: string, answer: string, idempotencyKey: string) => request<SelfRetelling>(`/api/v1/self-retellings/${encodeURIComponent(releaseId)}/${encodeURIComponent(pageId)}`, {
    method: "PUT", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ answer })
  }),
  reviewSelfRetelling: (releaseId: string, pageId: string, result: "again" | "remembered") => request<SelfRetelling>(`/api/v1/self-retellings/${encodeURIComponent(releaseId)}/${encodeURIComponent(pageId)}/review`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ result })
  }),
  readweaveQuestions: (pageId: string) => request<import("@course-os/contracts").ReadWeavePageQuestions>(`/api/v1/pages/${encodeURIComponent(pageId)}/readweave-questions`),
  draft: (pageId: string) => request<LessonDraft>(`/api/v1/pages/${encodeURIComponent(pageId)}/draft`),
  saveDraft: (draft: LessonDraft, page: LessonDraft["page"], changedBlockIds: string[]) => request<LessonDraft>(`/api/v1/pages/${encodeURIComponent(draft.pageId)}/draft`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ baseRevision: draft.revision, page, changedBlockIds })
  }),
  validateDraft: (pageId: string) => request<QualityValidationResult>(`/api/v1/pages/${encodeURIComponent(pageId)}:validate`, { method: "POST" }),
  syncStatus: () => request<ReadWeaveSyncStatus>("/api/v1/sync/status"),
  conflicts: () => request<CourseConflict[]>("/api/v1/conflicts"),
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
  importTasks: () => request<ImportTaskSummary[]>("/api/v1/imports"),
  importRecord: (importId: string) => request<WebImportRecord>(`/api/v1/imports/${encodeURIComponent(importId)}`),
  createGenerationJob: (materialVersionId: string, pageIds: string[], budgetUsd: number) => request<GenerationJob>("/api/v1/generation-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ materialVersionId, pageIds, budgetUsd })
  }),
  generationJob: (jobId: string) => request<GenerationJob>(`/api/v1/generation-jobs/${encodeURIComponent(jobId)}`),
  createGenerationPlan: (materialVersionId: string, pageIds: string[], budgetUsd: number, options: { qualityMode?: string; language?: string; sourceImportId?: string; holdForReview?: boolean } = {}) => request<{ plan: GenerationPlan; currentJob?: GenerationJob }>("/api/v1/generation-plans", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ materialVersionId, pageIds, budgetUsd, ...options })
  }),
  generationPlan: (planId: string) => request<{ plan: WebGenerationPlan; currentJob?: GenerationJob; activeJobs?: GenerationJob[] }>(`/api/v1/generation-plans/${encodeURIComponent(planId)}`),
  retryGenerationPlanFailed: (planId: string) => request<{ plan: WebGenerationPlan; jobs: GenerationJob[] }>(`/api/v1/generation-plans/${encodeURIComponent(planId)}:retry-failed`, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() }
  }),
  writingPolicy: () => request<WritingPolicyCurrent>("/api/v1/writing-policy/current"),
  generationHarness: () => request<GenerationHarnessCurrent>("/api/v1/generation-harness/current"),
  costs: (filters: { courseId?: string; materialVersionId?: string; pageId?: string; jobId?: string } = {}) => {
    const query = new URLSearchParams(Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1])));
    return request<{ entries: GenerationCostEntry[]; rollups: CostRollup[] }>(`/api/v1/costs${query.size ? `?${query}` : ""}`);
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
  selectQuestions: (pageId: string, sessionId: string, seed?: string) => {
    const stableSeed = seed || `${sessionId}:${pageId}:${new Date().toISOString().slice(0, 10)}`;
    const cacheKey = `${sessionId}:${pageId}:${stableSeed}`;
    const existing = questionSelectionRequests.get(cacheKey);
    if (existing) return existing;
    const pending = request<QuestionSelectionResponse>(`/api/v1/pages/${encodeURIComponent(pageId)}/questions:select`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `question-selection:${crypto.randomUUID()}` },
      body: JSON.stringify({ sessionId, seed: stableSeed, count: 2 })
    }).catch((error) => { questionSelectionRequests.delete(cacheKey); throw error; });
    questionSelectionRequests.set(cacheKey, pending);
    return pending;
  },
  refillQuestions: (pageId: string, baseRevision: number) => request<QuestionRefillResponse>(`/api/v1/pages/${encodeURIComponent(pageId)}/questions:refill`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ baseRevision })
  }),
  questionAttempt: (payload: { selectionId: string; sessionId: string; courseReleaseId: string; pageId: string; questionId: string; answer: string; usedHintLevel: number }, idempotencyKey: string = crypto.randomUUID()) => request<{ attempt: QuestionAttempt; mastery: MasteryRecord | null; evaluationState: "correct" | "incorrect" | "unverified"; feedback: string }>("/api/v1/question-attempts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(payload)
  }),
  attempt: (payload: { courseReleaseId: string; itemId: string; answer: string; usedHintLevel: number }) => request<{ attempt: { correct: boolean }; mastery: MasteryRecord; feedback: string }>("/api/v1/assessment-attempts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(payload)
  }),
  reviewQueue: () => request<MasteryRecord[]>("/api/v1/review-queue"),
  reviewMap: () => request<ReviewMap>("/api/v1/review-map"),
  createReviewPlan: (payload: { source: "due" | "manual"; objectiveIds: string[]; seed?: string; budgetUsd?: number }) => request<{ plan: ReviewPlan }>("/api/v1/review-plans", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(payload)
  }),
  reviewPlan: (id: string) => request<{ plan: ReviewPlan }>(`/api/v1/review-plans/${encodeURIComponent(id)}`),
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
  currentReviewSession: () => request<ReviewSessionResponse>("/api/v1/review-sessions/current"),
  createReviewSession: (payload: { source: "due" | "manual"; objectiveIds?: string[]; count?: number; seed?: string }) => request<ReviewSessionResponse>("/api/v1/review-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(payload)
  }),
  reviewSession: (id: string) => request<ReviewSessionResponse>(`/api/v1/review-sessions/${encodeURIComponent(id)}`),
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
