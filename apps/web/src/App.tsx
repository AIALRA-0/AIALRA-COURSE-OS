import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type SetStateAction, type CSSProperties } from "react";
import type { CourseConflict, CourseRelease, CourseTreeNode, GenerationCostEntry, GenerationJob, GenerationPlan, ImportRecord, LearningSession, LessonDraft, ModelProviderConfig, ModelRoutePolicy, PageLesson, ReadWeaveSyncStatus, ReviewMap, TrashRecord, WorkspaceMode, WorkspaceSettings, WorkspaceTree } from "@course-os/contracts";
import { api, ApiRequestError, type ModelProviderCreate, type ReadWeaveEtapiSettings, type SearchProviderConfig, type SearchRoutePolicy } from "./api.js";
import { CourseTree, resolveSearchInputKeyAction, type CourseTreeActions, type CourseTreeTask, type CourseTreeSearchMaterial } from "./CourseTree.js";
import { Icon } from "./Icon.js";
import { formatActivityAge, formatProgressCount, getImportActivity, getImportTaskState, getImportTaskStatus, getImportTaskTiming, getImportTaskPollingMode, importProgressTitle, importTaskStateLabel, standaloneGenerationJobId, summarizeImportProgress } from "./import-progress.js";
import { PdfLayoutPreview } from "./PdfLayoutPreview.js";
import { addModelRoute, removeModelRoute } from "./settings-routes.js";
import { SlideViewer, type ViewState } from "./SlideViewer.js";
import { BoundedPagePrefetchQueue, ImageResourceCache, settlePagePrefetch } from "./reading-prefetch.js";
import type { ImportTaskSummary, WebGenerationPlan, WebImportRecord } from "./types.js";

type ExplanationPanelModule = typeof import("./ExplanationPanel.js");
let explanationPanelLoad: Promise<ExplanationPanelModule> | undefined;
export function preloadExplanationPanel(): Promise<ExplanationPanelModule> {
  return explanationPanelLoad ??= import("./ExplanationPanel.js");
}
const ExplanationPanel = lazy(() => preloadExplanationPanel().then((module) => ({ default: module.ExplanationPanel })));
const ReviewWorkspace = lazy(() => import("./ReviewWorkspace.js").then((module) => ({ default: module.ReviewWorkspace })));
const StudioWorkspace = lazy(() => import("./StudioWorkspace.js").then((module) => ({ default: module.StudioWorkspace })));

type MobileMode = "visual" | "lesson" | "practice";
type UtilityPanel = "search" | "sync" | "account" | "settings" | "trash" | null;
type TreeTextAction = { kind: "module" | "rename"; node: CourseTreeNode };
export type CandidateReadUnavailable = "not_generated" | "not_ready";
export type CandidatePreviewState = { pageId: string; page?: PageLesson; error?: string; terminal?: boolean; generatedReady?: boolean; notice?: string; unavailable?: CandidateReadUnavailable };

export function isGlobalSearchShortcut(event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "key">): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
}
export type CachedPageSnapshot = { releaseId: string; page: PageLesson; contentHash: string; unpublishedDraftRevision?: number };
export interface SharedReadRequest<T> {
  promise: Promise<T>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
}
export interface SharedReadLease<T> {
  promise: Promise<T>;
  release: () => void;
}

const PAGE_CACHE_LIMIT = 5;

export function pageSnapshotCacheKey(releaseId: string, pageId: string): string {
  return `${releaseId}\u0000${pageId}`;
}

export function rememberPageSnapshot(cache: Map<string, CachedPageSnapshot>, releaseId: string, page: PageLesson, limit = PAGE_CACHE_LIMIT, unpublishedDraftRevision?: number): Map<string, CachedPageSnapshot> {
  const next = new Map(cache);
  const key = pageSnapshotCacheKey(releaseId, page.id);
  const contentHash = JSON.stringify(page);
  next.delete(key);
  next.set(key, { releaseId, page, contentHash, unpublishedDraftRevision });
  while (next.size > limit) next.delete(next.keys().next().value!);
  return next;
}

export function isCurrentPageSnapshot(requested: { releaseId: string; pageId: string }, active: { releaseId: string; pageId: string }, response: { releaseId: string; pageId: string }): boolean {
  return pageSnapshotResponseState(requested, active, response) === "match";
}

export type PageSnapshotResponseState = "stale" | "mismatch" | "match";

export function pageSnapshotResponseState(requested: { releaseId: string; pageId: string }, active: { releaseId: string; pageId: string }, response: { releaseId: string; pageId: string }): PageSnapshotResponseState {
  if (requested.releaseId !== active.releaseId || requested.pageId !== active.pageId) return "stale";
  if (response.releaseId !== requested.releaseId || response.pageId !== requested.pageId) return "mismatch";
  return "match";
}

const TERMINAL_PAGE_READ_CODES = new Set([
  "ACCESS_DENIED", "AUTHENTICATION_REQUIRED", "AUTH_REQUIRED", "FORBIDDEN", "UNAUTHORIZED",
  "RELEASE_NOT_FOUND", "PAGE_NOT_FOUND", "RESOURCE_NOT_FOUND"
]);

export function isAuthorizationPageReadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const apiError = error as { code?: unknown; status?: unknown };
  return apiError.status === 401 || apiError.status === 403
    || typeof apiError.code === "string" && ["ACCESS_DENIED", "AUTHENTICATION_REQUIRED", "AUTH_REQUIRED", "FORBIDDEN", "UNAUTHORIZED"].includes(apiError.code);
}

export function isTerminalPageReadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const apiError = error as { code?: unknown; status?: unknown };
  return isAuthorizationPageReadError(error) || apiError.status === 404
    || typeof apiError.code === "string" && TERMINAL_PAGE_READ_CODES.has(apiError.code);
}

function pageReadErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "当前页面暂时无法读取";
}

function candidateReadUnavailable(error: unknown): CandidateReadUnavailable | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  if (code === "PAGE_NOT_GENERATED") return "not_generated";
  if (code === "PAGE_NOT_READY") return "not_ready";
  return undefined;
}

function candidateUnavailableGuidance(state: CandidateReadUnavailable): string {
  return state === "not_generated"
    ? "请进入制作模式生成本页讲解。"
    : "请进入制作模式检查候选讲解及其保存状态。";
}

function candidateNeedsReviewPreview(draft: LessonDraft, releaseId: string, pageId: string): CandidatePreviewState | undefined {
  if (draft.status !== "needs_review" || candidateSnapshotIdentityMismatch(draft, releaseId, pageId)) return undefined;
  const sections = draft.page.lessonSections ?? [];
  const hasTeachingText = (kind: "full_explanation" | "main_content") => {
    const markdown = sections.find((section) => section.kind === kind)?.markdown?.trim() ?? "";
    return Boolean(markdown) && !/(?:待生成|待确认|待补充|上传中|等待上传|当前只完成来源拆解|还没有冒充教授级讲解)/u.test(markdown);
  };
  const hasFullExplanation = hasTeachingText("full_explanation");
  const hasMainContent = hasTeachingText("main_content");
  if (draft.page.teachingCompositionVersion !== 1 || (!hasFullExplanation && !hasMainContent)) return undefined;

  const availableQuestions = draft.page.questionBank?.filter((question) => question.status === "approved").length ?? 0;
  const bodyNotice = hasFullExplanation && hasMainContent
    ? "完整讲解已保存并可读，主要内容摘要已保存。"
    : hasFullExplanation
      ? "已有完整讲解正文可读；主要内容摘要尚未补齐。"
      : "完整讲解尚未生成；已有摘要保留。可先阅读已有摘要。";
  const questionNotice = availableQuestions > 0
    ? `题库当前有 ${availableQuestions} 道可用题。`
    : "题库当前没有可用题。";
  const actionNotice = `无需重试读取，请进入制作模式${availableQuestions === 0 ? "准备题库" : "检查候选内容"}并确认。`;
  const title = readablePageTitle(draft.page.title);
  return {
    pageId,
    page: title === draft.page.title ? draft.page : { ...draft.page, title },
    generatedReady: false,
    notice: [bodyNotice, questionNotice, actionNotice].filter(Boolean).join(" ")
  };
}

export function candidatePreviewForUnavailableRead(
  current: CandidatePreviewState | undefined,
  pageId: string,
  state: CandidateReadUnavailable,
  evidence: string
): CandidatePreviewState {
  const guidance = candidateUnavailableGuidance(state);
  return current?.pageId === pageId && current.page
    ? { ...current, error: undefined, terminal: false, unavailable: state, notice: `当前显示的是上次可读讲解；${evidence}。${guidance}` }
    : { pageId, unavailable: state, notice: `${evidence}。${guidance}` };
}

export function candidatePreviewAfterReadFailure(
  current: CandidatePreviewState | undefined,
  pageId: string,
  error: unknown
): CandidatePreviewState {
  const detail = pageReadErrorMessage(error);
  const unavailable = candidateReadUnavailable(error);
  if (unavailable) return candidatePreviewForUnavailableRead(current, pageId, unavailable, detail);
  if (isTerminalPageReadError(error)) return { pageId, error: `当前候选页已不可访问：${detail}`, terminal: true };
  if (current?.pageId === pageId && current.terminal) return current;
  return current?.pageId === pageId && current.page
    ? { ...current, error: undefined, terminal: false, unavailable: undefined, notice: `当前显示的是上次可读讲解；最新 ReadWeave 内容读取失败：${detail}` }
    : { pageId, error: detail };
}

export function formalPageAfterReadFailure(
  currentPage: PageLesson | undefined,
  error: unknown
): { page?: PageLesson; error: string; terminal: boolean } {
  const terminal = isTerminalPageReadError(error);
  return {
    ...(terminal ? {} : currentPage ? { page: currentPage } : {}),
    error: pageReadErrorMessage(error),
    terminal
  };
}

export function pageCacheAfterReadFailure(
  cache: Map<string, CachedPageSnapshot>,
  releaseId: string,
  pageId: string,
  error: unknown
): Map<string, CachedPageSnapshot> {
  if (!isTerminalPageReadError(error)) return cache;
  const next = new Map(cache);
  if (isAuthorizationPageReadError(error)) next.clear();
  else next.delete(pageSnapshotCacheKey(releaseId, pageId));
  return next;
}

export function pageCacheAfterPrefetch(
  cache: Map<string, CachedPageSnapshot>,
  releaseId: string,
  page: PageLesson,
  capturedEpoch: number,
  currentEpoch: number,
  unpublishedDraftRevision?: number
): Map<string, CachedPageSnapshot> {
  return capturedEpoch === currentEpoch ? rememberPageSnapshot(cache, releaseId, page, PAGE_CACHE_LIMIT, unpublishedDraftRevision) : cache;
}

type FormalLessonRead = Awaited<ReturnType<typeof api.lesson>>;

export function beginFormalPageLoad({
  releaseId,
  pageId,
  hasCachedPage,
  readPage,
  isActive,
  onPage,
  onError
}: {
  releaseId: string;
  pageId: string;
  hasCachedPage: () => boolean;
  readPage: () => SharedReadLease<FormalLessonRead>;
  isActive: () => boolean;
  onPage: (lesson: FormalLessonRead) => void;
  onError: (error: unknown) => void;
}): { loadInitial: () => void; onFocus: () => void; cancel: () => void } {
  let latestRead = 0;
  let currentRead: SharedReadLease<FormalLessonRead> | undefined;
  let disposed = false;
  const load = (force: boolean) => {
    if (disposed || !isActive() || (!force && hasCachedPage())) return;
    currentRead?.release();
    const readId = ++latestRead;
    const lessonRead = readPage();
    currentRead = lessonRead;
    void lessonRead.promise.then((lesson) => {
      if (disposed || !isActive() || readId !== latestRead) return;
      const state = pageSnapshotResponseState(
        { releaseId, pageId },
        { releaseId, pageId },
        { releaseId: lesson.releaseId, pageId: lesson.page.id }
      );
      if (state === "match") onPage(lesson);
      else onError(new Error(`当前页读取返回了不匹配的课程版本或页面 ID（版本 ${lesson.releaseId}，页面 ${lesson.page.id}），请重试`));
    }).catch((error: unknown) => {
      if (!disposed && isActive() && readId === latestRead) onError(error);
    }).finally(() => {
      lessonRead.release();
      if (currentRead === lessonRead) currentRead = undefined;
    });
  };
  return {
    loadInitial: () => load(false),
    onFocus: () => load(true),
    cancel: () => {
      disposed = true;
      latestRead += 1;
      currentRead?.release();
      currentRead = undefined;
    }
  };
}

export function readOnce<T>(inFlight: Map<string, SharedReadRequest<T>>, key: string, read: (signal: AbortSignal) => Promise<T>): SharedReadLease<T> {
  let request = inFlight.get(key);
  if (!request || request.controller.signal.aborted) {
    const controller = new AbortController();
    const created: SharedReadRequest<T> = { promise: Promise.resolve(undefined as T), controller, consumers: 0, settled: false };
    created.promise = Promise.resolve().then(() => read(controller.signal)).finally(() => {
      created.settled = true;
      if (inFlight.get(key) === created) inFlight.delete(key);
    });
    void created.promise.catch(() => undefined);
    inFlight.set(key, created);
    request = created;
  }

  request.consumers += 1;
  let released = false;
  return {
    promise: request.promise,
    release: () => {
      if (released) return;
      released = true;
      request!.consumers -= 1;
      if (!request!.settled && request!.consumers === 0 && !request!.controller.signal.aborted) request!.controller.abort();
    }
  };
}

function readLessonOnce(inFlight: Map<string, SharedReadRequest<Awaited<ReturnType<typeof api.lesson>>>>, releaseId: string, pageId: string) {
  return readOnce(inFlight, pageSnapshotCacheKey(releaseId, pageId), (signal) => api.lesson(pageId, { signal, releaseId }));
}

function readCandidateSnapshotOnce(inFlight: Map<string, SharedReadRequest<LessonDraft>>, releaseId: string, pageId: string) {
  return readOnce(inFlight, pageSnapshotCacheKey(releaseId, pageId), (signal) => api.draftSnapshot(pageId, { signal, releaseId }));
}

const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 320;
const OFFLINE_SYNC: ReadWeaveSyncStatus = { state: "offline", authority: "readweave", mode: "http", pendingWrites: 0, conflicts: 0, message: "ReadWeave 暂时不可访问" };

function clampSidebarWidth(value: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(value)));
}

function readablePageTitle(title: string): string {
  return title.split(/\s{12,}/, 1)[0]?.trim() || title;
}

export function normalizeSidebarWidth(savedValue: string | null): number {
  const saved = Number(savedValue);
  return Number.isFinite(saved) && saved >= SIDEBAR_MIN_WIDTH ? clampSidebarWidth(saved) : SIDEBAR_DEFAULT_WIDTH;
}

export function sourceReleasesForCourse(releases: CourseRelease[], courseId: string, courses?: CourseTreeNode[]): CourseRelease[] {
  if (!courseId) return [];
  const selected = courses?.find(course => course.id === courseId);
  if (selected) {
    const current = new Set(selected.children.filter(node => node.kind === "material")
      .map(node => node.currentReleaseId ?? node.releaseId));
    return releases.filter(release => release.lifecycle === "draft_source" && current.has(release.id));
  }
  return releases.filter((release) => release.courseId === courseId && release.lifecycle === "draft_source");
}

export function resolveTaskTreeMetadata(task: Pick<ImportTaskSummary, "id" | "originalName" | "courseId" | "materialVersionId">, releases: CourseRelease[]): { courseId?: string; title: string } {
  const jobId = standaloneGenerationJobId(task.id);
  if (!jobId) return { courseId: task.courseId, title: task.originalName };
  const release = releases.find((item) => item.id === task.materialVersionId);
  return {
    courseId: task.courseId ?? release?.courseId,
    title: release ? `${release.moduleTitle} · 生成任务 ${jobId.slice(0, 6)}` : task.originalName
  };
}

export function isUnresolvedTaskFailure(task: ImportTaskSummary, tasks: ImportTaskSummary[], releases: CourseRelease[]): boolean {
  const failedPageIds = [...new Set(task.generationFailedPageIds ?? [])];
  if (getImportTaskState(task) !== "failed" || failedPageIds.length === 0) return false;
  const materialVersionId = task.materialVersionId || `material-version:${task.id}`;
  if (!releases.some((item) => item.id === materialVersionId)) return false;
  const recoveredPages = new Set(tasks.filter((candidate) => candidate.id !== task.id
    && candidate.createdAt > task.createdAt
    && (candidate.materialVersionId || `material-version:${candidate.id}`) === materialVersionId
    && getImportTaskState(candidate) === "completed")
    .flatMap((candidate) => candidate.generationCompletedPageIds ?? []));
  return failedPageIds.some((pageId) => !recoveredPages.has(pageId));
}

function readSidebarWidth(): number {
  return normalizeSidebarWidth(localStorage.getItem("course-os-sidebar-width"));
}

export function App() {
  const initialNavigation = useRef(readNavigationHash());
  const [releases, setReleases] = useState<CourseRelease[]>([]);
  const [tree, setTree] = useState<WorkspaceTree>();
  const [releaseIndexError, setReleaseIndexError] = useState("");
  const [releaseIndexLoading, setReleaseIndexLoading] = useState(true);
  const [releaseIndexReload, setReleaseIndexReload] = useState(0);
  const releaseIndexRequests = useRef(new Map<string, SharedReadRequest<CourseRelease[]>>());
  const releaseRequests = useRef(new Map<string, SharedReadRequest<CourseRelease>>());
  const [treeError, setTreeError] = useState("");
  const [treeLoading, setTreeLoading] = useState(false);
  const treeReadUsers = useRef(0);
  const treeRequests = useRef(new Map<string, SharedReadRequest<WorkspaceTree>>());
  const [sync, setSync] = useState<ReadWeaveSyncStatus>();
  const syncReadInFlight = useRef<Promise<ReadWeaveSyncStatus> | undefined>(undefined);
  const [conflicts, setConflicts] = useState<CourseConflict[]>([]);
  const [reviewMap, setReviewMap] = useState<ReviewMap>();
  const [releaseId, setReleaseId] = useState(initialNavigation.current.releaseId);
  const [pageIndex, setPageIndex] = useState(initialNavigation.current.pageIndex);
  const [mode, setMode] = useState<WorkspaceMode>(initialNavigation.current.mode);
  const [session, setSession] = useState<LearningSession>();
  const [pageCache, setPageCache] = useState<Map<string, CachedPageSnapshot>>(() => new Map());
  const pageCacheRef = useRef(pageCache);
  pageCacheRef.current = pageCache;
  const pageCacheInvalidationEpoch = useRef(0);
  const [imageResources] = useState(() => new ImageResourceCache(8));
  const pagePrefetchQueue = useRef(new BoundedPagePrefetchQueue(2));
  const lessonRequests = useRef(new Map<string, SharedReadRequest<Awaited<ReturnType<typeof api.lesson>>>>());
  const candidateSnapshotRequests = useRef(new Map<string, SharedReadRequest<LessonDraft>>());
  const [view, setView] = useState<ViewState>({ zoom: 1, panX: 0, panY: 0 });
  const [mobileMode, setMobileMode] = useState<MobileMode>("visual");
  const [pageDockOpen, setPageDockOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">((localStorage.getItem("course-os-theme") as "light" | "dark") || "light");
  const [importOpen, setImportOpen] = useState(false);
  const [importParentNodeId, setImportParentNodeId] = useState<string>();
  const [activeImportId, setActiveImportId] = useState(readActiveImportId);
  const [taskRecords, setTaskRecords] = useState<ImportTaskSummary[]>([]);
  const [secondaryReadsStarted, setSecondaryReadsStarted] = useState(false);
  const [createCourseOpen, setCreateCourseOpen] = useState(false);
  const [utilityPanel, setUtilityPanel] = useState<UtilityPanel>(null);
  const [globalSearchFocusRequest, setGlobalSearchFocusRequest] = useState(0);
  const [leftCollapsed, setLeftCollapsed] = useState(() => localStorage.getItem("course-os-left-collapsed") === "true");
  const [rightCollapsed, setRightCollapsed] = useState(() => localStorage.getItem("course-os-right-collapsed") === "true");
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const sidebarResizeCleanup = useRef<(() => void) | undefined>(undefined);
  const metadataReadyImports = useRef(new Set<string>());
  const [historyNode, setHistoryNode] = useState<CourseTreeNode>();
  const [moveNode, setMoveNode] = useState<CourseTreeNode>();
  const [textAction, setTextAction] = useState<TreeTextAction>();
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [explicitReleaseReload, setExplicitReleaseReload] = useState(0);
  const [sessionWarning, setSessionWarning] = useState("");
  const [sessionReadyReleaseId, setSessionReadyReleaseId] = useState<string>();
  const activePageIdentity = useRef({ releaseId: "", pageId: "" });
  const [loading, setLoading] = useState(!initialNavigation.current.releaseId);
  const detailedReleaseIds = useRef(new Set<string>());
  const sessionRef = useRef<LearningSession | undefined>(undefined);
  const pendingSessionPatchRef = useRef(new Map<string, Partial<LearningSession>>());
  const sessionWriteTimerRef = useRef<number | undefined>(undefined);
  const sessionWriteInFlightRef = useRef(false);

  useEffect(() => { sessionRef.current = session; }, [session]);

  const flushSessionWrites = useCallback(() => {
    if (sessionWriteInFlightRef.current || pendingSessionPatchRef.current.size === 0) return;
    sessionWriteInFlightRef.current = true;
    void flushNextSessionPatch(
      pendingSessionPatchRef.current,
      (sessionId, patch) => api.updateSession(sessionId, patch),
      () => sessionRef.current?.id,
      (updated) => {
        sessionRef.current = updated;
        setSession((current) => current?.id === updated.id ? updated : current);
      }
    ).catch(() => undefined).finally(() => {
      sessionWriteInFlightRef.current = false;
      if (pendingSessionPatchRef.current.size > 0 && sessionWriteTimerRef.current === undefined) {
        sessionWriteTimerRef.current = window.setTimeout(() => {
          sessionWriteTimerRef.current = undefined;
          flushSessionWrites();
        }, 240);
      }
    });
  }, []);

  const scheduleSessionPatch = useCallback((sessionId: string, patch: Partial<LearningSession>) => {
    const pending = pendingSessionPatchRef.current.get(sessionId) || {};
    Object.assign(pending, patch);
    pendingSessionPatchRef.current.set(sessionId, pending);
    if (sessionWriteTimerRef.current !== undefined) return;
    sessionWriteTimerRef.current = window.setTimeout(() => {
      sessionWriteTimerRef.current = undefined;
      flushSessionWrites();
    }, 240);
  }, [flushSessionWrites]);

  useEffect(() => () => {
    if (sessionWriteTimerRef.current !== undefined) window.clearTimeout(sessionWriteTimerRef.current);
  }, []);

  const refreshSyncStatus = useCallback(async ({ includeConflicts = true }: { includeConflicts?: boolean } = {}) => {
    let syncRead = syncReadInFlight.current;
    if (!syncRead) {
      syncRead = api.syncStatus();
      syncReadInFlight.current = syncRead;
      void syncRead.then(() => { if (syncReadInFlight.current === syncRead) syncReadInFlight.current = undefined; },
        () => { if (syncReadInFlight.current === syncRead) syncReadInFlight.current = undefined; });
    }
    const [syncStatus, openConflicts] = await Promise.all([
      syncRead,
      includeConflicts ? api.conflicts() : Promise.resolve<CourseConflict[] | undefined>(undefined)
    ]);
    setSync(syncStatus);
    if (openConflicts) setConflicts(openConflicts.filter((item) => item.status === "open"));
    return syncStatus;
  }, []);

  const refreshMetadata = useCallback(async ({ includeReview = false }: { includeReview?: boolean } = {}) => {
    void api.settings().then((workspaceSettings) => {
      document.documentElement.style.setProperty("--course-font-scale", String(workspaceSettings.baseFontScale));
      if (workspaceSettings.theme === "light" || workspaceSettings.theme === "dark") setTheme(workspaceSettings.theme);
    }).catch(() => undefined);
    void refreshSyncStatus({ includeConflicts: false }).catch(() => setSync(OFFLINE_SYNC));
    treeReadUsers.current += 1;
    setTreeLoading(true);
    const treeRead = readOnce(treeRequests.current, "workspace-tree", (signal) => api.workspaceTree(undefined, { signal }));
    try {
      const workspaceTree = await treeRead.promise;
      setTree(workspaceTree);
      setTreeError("");
    } catch (reason) {
      setTreeError(reason instanceof Error ? reason.message : "无法读取课程目录");
      throw reason;
    } finally {
      treeRead.release();
      treeReadUsers.current = Math.max(0, treeReadUsers.current - 1);
      setTreeLoading(treeReadUsers.current > 0);
    }
    if (includeReview) await api.reviewMap().then(setReviewMap).catch(() => setReviewMap(undefined));
  }, [refreshSyncStatus]);

  useEffect(() => {
    // The lesson index is sufficient to open the requested page. Tree,
    // settings, and sync status can arrive afterward without hiding it.
    let active = true;
    setReleaseIndexLoading(true);
    setReleaseIndexError("");
    const indexRead = readOnce(releaseIndexRequests.current, "release-index", (signal) => api.releases({ signal }));
    const treeRead = initialNavigation.current.releaseId
      ? undefined
      : readOnce(treeRequests.current, "workspace-tree", (signal) => api.workspaceTree(undefined, { signal }));
    void indexRead.promise.then(async (items) => {
      if (!active) return;
      setReleases((current) => mergeReleaseIndex(current, items, detailedReleaseIds.current));
      if (initialNavigation.current.releaseId) return;
      let initialTree = tree;
      if (treeRead) {
        try {
          initialTree = await treeRead.promise;
          if (active) {
            setTree(initialTree);
            setTreeError("");
          }
        } catch (reason) {
          if (active) setTreeError(reason instanceof Error ? reason.message : "无法读取课程目录");
        }
      }
      if (active && !initialNavigation.current.releaseId) {
        setReleaseId((current) => current || defaultRelease(items, initialTree)?.id || "");
      }
    }).catch((reason) => {
      if (active) setReleaseIndexError(reason instanceof Error ? reason.message : "无法读取课程列表");
    })
      .finally(() => {
        indexRead.release();
        treeRead?.release();
        if (active) {
          setReleaseIndexLoading(false);
          setLoading(false);
        }
      });
    return () => {
      active = false;
      indexRead.release();
    };
  }, [releaseIndexReload]);
  useEffect(() => {
    if (!secondaryReadsStarted || sync?.state === "connected") return;
    const timer = window.setInterval(() => { void refreshSyncStatus({ includeConflicts: false }).catch(() => undefined); }, 10_000);
    return () => window.clearInterval(timer);
  }, [secondaryReadsStarted, sync?.state, refreshSyncStatus]);

  useEffect(() => {
    const followHashNavigation = () => {
      const navigation = readNavigationHash();
      initialNavigation.current = navigation;
      if (navigation.releaseId) {
        setReleaseId(navigation.releaseId);
        setLoading(false);
      }
      setPageIndex(navigation.pageIndex);
      setMode(navigation.mode);
      setActiveImportId(readActiveImportId());
    };
    window.addEventListener("hashchange", followHashNavigation);
    return () => window.removeEventListener("hashchange", followHashNavigation);
  }, []);

  useEffect(() => {
    if (mode !== "review") return;
    void api.reviewMap().then(setReviewMap).catch(() => setReviewMap(undefined));
  }, [mode]);

  useEffect(() => {
    if (mode === "learn") void preloadExplanationPanel().catch(() => undefined);
  }, [mode]);

  const release = useMemo(() => releases.find((item) => item.id === releaseId), [releaseId, releases]);
  useEffect(() => {
    if (!releaseId || releaseId !== initialNavigation.current.releaseId || detailedReleaseIds.current.has(releaseId)) return;
    let active = true;
    setError("");
    const releaseRead = readOnce(releaseRequests.current, releaseId, (signal) => api.release(releaseId, { signal }));
    void releaseRead.promise.then((loaded) => {
      if (!active) return;
      if (loaded.id !== releaseId) {
        setError("无法载入指定课程版本");
        return;
      }
      detailedReleaseIds.current.add(loaded.id);
      setReleases((current) => mergeReleaseIndex(current, [...current.filter((item) => item.id !== loaded.id), loaded], detailedReleaseIds.current));
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "无法载入指定课程版本");
    }).finally(releaseRead.release);
    return () => { active = false; releaseRead.release(); };
  }, [releaseId, explicitReleaseReload]);
  const indexedPage = release?.pages[pageIndex];
  activePageIdentity.current = { releaseId: release?.id ?? "", pageId: indexedPage?.id ?? "" };
  const detailedPage = release && indexedPage
    ? pageCache.get(pageSnapshotCacheKey(release.id, indexedPage.id))?.page
    : undefined;
  const page = detailedPage ?? indexedPage;
  const pageDetailReady = release?.lifecycle === "draft_source" || Boolean(detailedPage);
  const [formalPageError, setFormalPageError] = useState<{ key: string; message: string; terminal?: boolean }>();
  const [formalPageReload, setFormalPageReload] = useState(0);
  const currentPageCacheKey = release && indexedPage ? pageSnapshotCacheKey(release.id, indexedPage.id) : "";
  const currentFormalPageError = formalPageError?.key === currentPageCacheKey ? formalPageError : undefined;
  const previousImageScope = useRef(releaseId);
  useEffect(() => {
    if (previousImageScope.current && previousImageScope.current !== releaseId) {
      imageResources.clear(indexedPage?.imageUrl);
      pagePrefetchQueue.current.clearPending();
    }
    previousImageScope.current = releaseId;
  }, [releaseId, imageResources]);
  useEffect(() => {
    if (mode !== "learn" || !indexedPage?.imageUrl) return;
    void imageResources.load(indexedPage.imageUrl, "high").catch(() => undefined);
  }, [mode, release?.id, indexedPage?.id, indexedPage?.imageUrl, imageResources]);
  const prefetchPage = useCallback((targetIndex: number, priority = 0) => {
    if (mode !== "learn" || !release) return;
    const target = release.pages[targetIndex];
    if (!target) return;
    const key = pageSnapshotCacheKey(release.id, target.id);
    if (pageCacheRef.current.has(key)) {
      if (target.imageUrl) void imageResources.load(target.imageUrl, priority > 0 ? "high" : "low").catch(() => undefined);
      return;
    }
    const capturedCacheEpoch = pageCacheInvalidationEpoch.current;
    void pagePrefetchQueue.current.enqueue(key, async () => {
      if (capturedCacheEpoch !== pageCacheInvalidationEpoch.current) return;
      const image = target.imageUrl ? imageResources.load(target.imageUrl, priority > 0 ? "high" : "low").catch(() => undefined) : Promise.resolve(undefined);
      const snapshotRead: SharedReadLease<LessonDraft | Awaited<ReturnType<typeof api.lesson>>> = release.lifecycle === "draft_source"
        ? readCandidateSnapshotOnce(candidateSnapshotRequests.current, release.id, target.id)
        : readLessonOnce(lessonRequests.current, release.id, target.id);
      try {
        await settlePagePrefetch(snapshotRead.promise, image, (result) => {
          let pageSnapshot: PageLesson | undefined;
          let unpublishedDraftRevision: number | undefined;
          if (release.lifecycle === "draft_source") {
            const draft = result as unknown as LessonDraft;
            if (isReadyCandidateSnapshot(draft, release.id, target.id)) {
              const title = readablePageTitle(draft.page.title);
              pageSnapshot = title === draft.page.title ? draft.page : { ...draft.page, title };
            }
          } else {
            const lesson = result as unknown as Awaited<ReturnType<typeof api.lesson>>;
            if (lesson.releaseId === release.id && lesson.page.id === target.id) { pageSnapshot = lesson.page; unpublishedDraftRevision = lesson.unpublishedDraftRevision; }
          }
          if (pageSnapshot) setPageCache((current) => pageCacheAfterPrefetch(
            current, release.id, pageSnapshot!, capturedCacheEpoch, pageCacheInvalidationEpoch.current, unpublishedDraftRevision
          ));
        });
      } finally {
        snapshotRead.release();
      }
    }, priority).catch(() => undefined);
  }, [imageResources, mode, release]);
  useEffect(() => {
    if (!release || !indexedPage || release.lifecycle === "draft_source") {
      return;
    }
    let active = true;
    const requestIdentity = { releaseId: release.id, pageId: indexedPage.id };
    const cacheKey = pageSnapshotCacheKey(release.id, indexedPage.id);
    setFormalPageError((current) => current?.key === cacheKey && !current.terminal ? undefined : current);
    const formalRead = beginFormalPageLoad({
      releaseId: release.id,
      pageId: indexedPage.id,
      hasCachedPage: () => pageCacheRef.current.has(cacheKey),
      // Recheck only this confirmed leaf through the local API; authority revocation is reflected by the runtime refresh gate.
      readPage: () => readLessonOnce(lessonRequests.current, release.id, indexedPage.id),
      isActive: () => active && pageSnapshotResponseState(requestIdentity, activePageIdentity.current, requestIdentity) === "match",
      onPage: (lesson) => {
        setFormalPageError((current) => current?.key === cacheKey ? undefined : current);
        setPageCache((current) => rememberPageSnapshot(current, release.id, lesson.page, PAGE_CACHE_LIMIT, lesson.unpublishedDraftRevision));
      },
      onError: (reason) => {
        const failure = formalPageAfterReadFailure(pageCacheRef.current.get(cacheKey)?.page, reason);
        if (failure.terminal) {
          pageCacheInvalidationEpoch.current += 1;
          setPageCache((current) => pageCacheAfterReadFailure(current, release.id, indexedPage.id, reason));
        }
        setFormalPageError((current) => current?.key === cacheKey && current.terminal && !failure.terminal
          ? current
          : { key: cacheKey, message: failure.error, terminal: failure.terminal });
      }
    });
    formalRead.loadInitial();
    window.addEventListener("focus", formalRead.onFocus);
    return () => {
      active = false;
      formalRead.cancel();
      window.removeEventListener("focus", formalRead.onFocus);
    };
  }, [indexedPage?.id, release?.id, release?.lifecycle, formalPageReload]);
  useEffect(() => {
    if (!release || !indexedPage) return;
    const timer = window.setTimeout(() => {
      prefetchPage(pageIndex + 1);
      prefetchPage(pageIndex - 1);
    }, 120);
    return () => { window.clearTimeout(timer); };
  }, [release?.id, indexedPage?.id, pageIndex, prefetchPage]);
  const [candidatePreview, setCandidatePreview] = useState<CandidatePreviewState>();
  const [candidatePreviewReload, setCandidatePreviewReload] = useState(0);
  useEffect(() => {
    if (mode !== "learn" || release?.lifecycle !== "draft_source" || !page) { setCandidatePreview(undefined); return; }
    let active = true;
    let snapshotRead: SharedReadLease<LessonDraft> | undefined;
    const cached = pageCache.get(pageSnapshotCacheKey(release.id, page.id));
    if (cached) setCandidatePreview((current) => current?.pageId === page.id && current.page ? current : { pageId: page.id, page: cached.page, generatedReady: true });
    const reconcileCandidatePreview = beginCandidatePreviewLoad({
      releaseId: release.id,
      pageId: page.id,
      readSnapshot: () => {
        if (cached) return Promise.resolve({ sourceReleaseId: release.id, pageId: page.id, status: "ready", page: cached.page } as LessonDraft);
        snapshotRead = readCandidateSnapshotOnce(candidateSnapshotRequests.current, release.id, page.id);
        return snapshotRead.promise;
      },
      readCurrentDraft: (signal, confirm) => api.draftSnapshot(page.id, { signal, releaseId: release.id, confirm }),
      isActive: () => active,
      setPreview: setCandidatePreview,
      onTerminalError: (reason) => {
        pageCacheInvalidationEpoch.current += 1;
        setPageCache((current) => pageCacheAfterReadFailure(current, release.id, page.id, reason));
      }
    });
    window.addEventListener("focus", reconcileCandidatePreview);
    return () => {
      active = false;
      snapshotRead?.release();
      reconcileCandidatePreview.cancel();
      window.removeEventListener("focus", reconcileCandidatePreview);
    };
  }, [mode, release?.id, release?.lifecycle, page?.id, candidatePreviewReload]);
  const firstContentReady = mode !== "learn" || !releaseId || Boolean(activeImportId || error || currentFormalPageError || candidatePreview?.error || candidatePreview?.unavailable
    || (release?.lifecycle === "draft_source" ? candidatePreview?.page : detailedPage));
  useEffect(() => {
    if (firstContentReady) { setSecondaryReadsStarted(true); return; }
    const timer = window.setTimeout(() => setSecondaryReadsStarted(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [firstContentReady]);
  useEffect(() => {
    if (!secondaryReadsStarted) return;
    let active = true;
    let timer = 0;
    let initialPoll = true;
    const refresh = async () => {
      let nextPollMs = 30_000;
      try {
        const records = await api.importTasks();
        if (!active) return;
        setTaskRecords(records);
        const newlyReady = records.filter((record) => record.state === "ready" && !metadataReadyImports.current.has(record.id));
        newlyReady.forEach((record) => metadataReadyImports.current.add(record.id));
        if (!initialPoll && newlyReady.length) void refreshMetadata().catch(() => undefined);
        if (records.some((record) => ["queued", "running"].includes(getImportTaskState(record)))) nextPollMs = 4000;
      } catch {
        // Keep the last visible task list during a transient connection failure.
      } finally {
        initialPoll = false;
        if (active) timer = window.setTimeout(() => void refresh(), nextPollMs);
      }
    };
    void refresh();
    return () => { active = false; window.clearTimeout(timer); };
  }, [secondaryReadsStarted, activeImportId, refreshMetadata]);
  useEffect(() => {
    if (!secondaryReadsStarted) return;
    void refreshMetadata().catch(() => undefined);
  }, [secondaryReadsStarted, refreshMetadata]);
  const previewRelease = useMemo(() => release
    ? { ...release, pages: release.pages.map((item, index) => {
      const source = index === pageIndex
        ? (release.lifecycle === "draft_source" && candidatePreview?.pageId === item.id && candidatePreview.page ? candidatePreview.page : page ?? item)
        : item;
      const title = readablePageTitle(source.title);
      return title === source.title ? source : { ...source, title };
    }) }
    : release, [release, page, pageIndex, candidatePreview]);

  useEffect(() => {
    if (!release) return;
    let active = true;
    setSessionReadyReleaseId(undefined);
    if (sessionRef.current?.courseReleaseId !== release.id) sessionRef.current = undefined;
    setSession((current) => current?.courseReleaseId === release.id ? current : undefined);
    setView({ zoom: 1, panX: 0, panY: 0 });
    setSessionWarning("");
    setPageIndex((index) => Math.min(release.pages.length - 1, Math.max(0, index)));
    const savedSession = localStorage.getItem(`course-os-session:${release.id}`) || undefined;
    api.createSession(release.id, savedSession).then((created) => {
      if (!active) return;
      setSession(created);
      sessionRef.current = created;
      localStorage.setItem(`course-os-session:${release.id}`, created.id);
      const restoredIndex = release.pages.findIndex((candidate) => candidate.id === created.currentPageId);
      if (!initialNavigation.current.hasExplicitPage && restoredIndex >= 0) setPageIndex(restoredIndex);
      setView({ zoom: created.zoom, panX: created.panX, panY: created.panY });
      setSessionReadyReleaseId(release.id);
    }).catch((reason) => {
      if (!active) return;
      const detail = reason instanceof Error ? `：${reason.message}` : "";
      setSessionWarning(`学习会话恢复失败${detail}，当前讲解仍可阅读，本次学习位置不会保存`);
      setSessionReadyReleaseId(release.id);
    });
    return () => { active = false; };
  }, [release?.id]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("course-os-theme", theme);
  }, [theme]);

  useEffect(() => { localStorage.setItem("course-os-left-collapsed", String(leftCollapsed)); }, [leftCollapsed]);
  useEffect(() => { localStorage.setItem("course-os-right-collapsed", String(rightCollapsed)); }, [rightCollapsed]);
  useEffect(() => { localStorage.setItem("course-os-sidebar-width", String(sidebarWidth)); }, [sidebarWidth]);
  useEffect(() => () => sidebarResizeCleanup.current?.(), []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isGlobalSearchShortcut(event)) {
        event.preventDefault();
        setUtilityPanel("search");
        setGlobalSearchFocusRequest((current) => current + 1);
      }
      if (event.key === "Escape") {
        setUtilityPanel(null);
        setMobileTreeOpen(false);
        setHistoryNode(undefined);
        setMoveNode(undefined);
        setTextAction(undefined);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!release || !page) return;
    if (!initialNavigation.current.hasExplicitPage && sessionReadyReleaseId !== release.id) return;
    const navigation = new URLSearchParams(location.hash.slice(1));
    navigation.set("mode", mode);
    navigation.set("release", release.id);
    navigation.set("page", String(pageIndex + 1));
    localStorage.setItem(`course-os-last-page:${release.id}`, page.id);
    if (mode !== "review") {
      navigation.delete("reviewPlan");
      navigation.delete("reviewSession");
    }
    location.hash = navigation.toString();
  }, [mode, pageIndex, page?.id, release?.id, sessionReadyReleaseId]);

  useEffect(() => {
    if (!release || !page) return;
    const activeSession = sessionRef.current?.courseReleaseId === release.id ? sessionRef.current : undefined;
    if (activeSession) scheduleSessionPatch(activeSession.id, { currentPageId: page.id });
  }, [page?.id, release?.id, scheduleSessionPatch]);

  const updateView = useCallback((next: ViewState) => {
    setView(next);
    const activeSession = sessionRef.current?.courseReleaseId === release?.id ? sessionRef.current : undefined;
    if (activeSession) scheduleSessionPatch(activeSession.id, next);
  }, [release?.id, scheduleSessionPatch]);

  const selectPage = (nextReleaseId: string, pageId: string) => {
    const nextRelease = releases.find((item) => item.id === nextReleaseId);
    const nextIndex = nextRelease?.pages.findIndex((item) => item.id === pageId) ?? -1;
    if (nextRelease && nextIndex >= 0) {
      trackImport(undefined);
      initialNavigation.current.hasExplicitPage = true;
      setReleaseId(nextRelease.id);
      setPageIndex(nextIndex);
    }
  };

  const handlePublished = (published: CourseRelease) => {
    setReleases((current) => [published, ...current]);
    setReleaseId(published.id);
    setPageIndex(Math.min(pageIndex, published.pages.length - 1));
    refreshMetadata().catch(() => undefined);
  };

  const handleImported = (record: ImportRecord) => {
    Promise.all([api.releases(), refreshMetadata()]).then(([items]) => {
      setReleases(items);
      setTaskRecords((current) => current.map((item) => item.id === record.id ? record : item));
    }).catch(() => undefined);
  };

  const openImported = async (record: ImportRecord, nextMode: "learn" | "studio" = "learn") => {
    try {
      const items = await api.releases();
      const target = items.find(item => item.id === record.materialVersionId);
      if (!target?.pages.length) { setToast("这个材料尚未取得可读取的页面"); return; }
      const saved = localStorage.getItem(`course-os-last-page:${target.id}`);
      const index = Math.max(0, target.pages.findIndex(page => page.id === saved));
      setReleases(items);
      trackImport(undefined);
      setReleaseId(target.id);
      setPageIndex(index);
      setMode(nextMode);
    } catch (reason) { setToast(reason instanceof Error ? reason.message : "无法打开材料"); }
  };

  const rememberImport = (record: ImportRecord) => {
    setTaskRecords((current) => [record, ...current.filter((item) => item.id !== record.id)]);
    void refreshMetadata().catch(() => undefined);
  };

  const trackImport = (importId?: string) => {
    const navigation = new URLSearchParams(location.hash.slice(1));
    if (importId) {
      navigation.set("import", importId);
      localStorage.setItem("course-os-active-import", importId);
    } else {
      navigation.delete("import");
      localStorage.removeItem("course-os-active-import");
    }
    setActiveImportId(importId);
    location.hash = navigation.toString();
  };

  const backgroundTasks = useMemo(() => taskRecords.map((record) => {
    const completed = record.generationCompletedPageIds?.length ?? 0;
    const failed = record.generationFailedPageIds?.length ?? 0;
    const total = record.pageIds?.length ?? 0;
    const state = getImportTaskState(record);
    const metadata = resolveTaskTreeMetadata(record, releases);
    const detail = record.autoGenerate === false || record.generationState === "not_requested"
      ? `${importTaskStateLabel(state)}${total > 0 ? ` · 已转换 ${total} 页` : ""}`
      : `${importTaskStateLabel(state)}${total > 0 ? ` · 成功 ${completed}/${total} 页${failed > 0 ? ` · 失败 ${failed}` : ""}` : ""}`;
    const activity = getImportActivity(record as WebImportRecord, undefined, [], []);
    return { id: record.id, courseId: metadata.courseId, parentNodeId: record.parentNodeId, title: metadata.title, detail, state, unresolved: isUnresolvedTaskFailure(record, taskRecords, releases), progress: { percent: activity.progressPercent, completed: activity.overall?.completed, total: activity.overall?.total, indeterminate: activity.progressPercent === undefined && state === "running", stale: activity.stale } };
  }), [taskRecords, releases]);
  const [clearFailedBusy, setClearFailedBusy] = useState(false);
  const clearingTasks = useRef(false);
  const clearFailedTasks = async (taskIds: string[]) => {
    if (!taskIds.length || clearingTasks.current || !window.confirm(`清除 ${taskIds.length} 条已结束的失败任务记录？保留课程、原图、讲解、答案和费用；正在运行的任务不会清除`)) return;
    clearingTasks.current = true; setClearFailedBusy(true);
    try {
      const fingerprints = Object.fromEntries(taskRecords.filter(record => taskIds.includes(record.id) && record.cleanupFingerprint).map(record => [record.id, record.cleanupFingerprint!]));
      const receipt = await api.clearFailedTasks(taskIds, crypto.randomUUID(), fingerprints);
      setTaskRecords(await api.importTasks());
      if (activeImportId && receipt.cleared.includes(activeImportId)) trackImport(undefined);
      setToast(`已清除 ${receipt.cleared.length} 条；跳过 ${receipt.skipped.length} 条；失败 ${receipt.failed.length} 条${[...receipt.skipped, ...receipt.failed].map(item => ` · ${item.reason}`).join("")}`);
    } catch (reason) { setToast(reason instanceof Error ? reason.message : "清除结果尚未确认，请刷新核对"); }
    finally { clearingTasks.current = false; setClearFailedBusy(false); }
  };

  const runTreeAction = async (action: () => Promise<unknown>, success: string, pending = "正在保存…", refresh = true) => {
    setToast(pending);
    try { await action(); if (refresh) await refreshMetadata(); setToast(success); }
    catch (reason) { setToast(reason instanceof Error ? reason.message : "课程树操作失败"); }
  };

  const updateTreeAfterRename = (updated: CourseTreeNode) => {
    const replace = (nodes: CourseTreeNode[]): CourseTreeNode[] => nodes.map((node) => node.id === updated.id
      ? { ...node, ...updated, children: node.children }
      : { ...node, children: replace(node.children) });
    setTree((current) => current ? { ...current, courses: replace(current.courses), rootMaterials: replace(current.rootMaterials ?? []) } : current);
  };

  const adjustSidebarWidth = (delta: number) => setSidebarWidth((current) => clampSidebarWidth(current + delta));
  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 900) return;
    event.preventDefault();
    sidebarResizeCleanup.current?.();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const move = (moveEvent: globalThis.PointerEvent) => setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      sidebarResizeCleanup.current = undefined;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    sidebarResizeCleanup.current = finish;
  };

  const shellStyle = { "--course-sidebar": `${sidebarWidth}px` } as CSSProperties;
  const searchMaterials = useMemo<CourseTreeSearchMaterial[]>(() => {
    const byId = new Map(releases.map(item => [item.id, item]));
    return flattenTree([...(tree?.courses ?? []), ...(tree?.rootMaterials ?? [])]).flatMap(({ node }) => {
      if (node.kind !== "material" || node.archived || node.visibility === "archived") return [];
      const current = byId.get(node.currentReleaseId || node.releaseId || "");
      return current ? [{ materialNodeId: node.id, releaseId: current.id, version: current.version,
        lifecycle: current.lifecycle, pages: current.pages.map(({ id, pageNumber, title }) => ({ id, pageNumber, title })) }] : [];
    });
  }, [tree, releases]);

  const openTreeNode = (node: CourseTreeNode, nextMode: "learn" | "studio", restoreReadingPosition = false) => {
    const candidateRelease = [node.currentReleaseId, node.releaseId]
      .filter((id): id is string => Boolean(id))
      .map((id) => releases.find((item) => item.id === id))
      .find((item): item is CourseRelease => Boolean(item))
      ?? (node.kind === "course"
        ? [...releases].filter((item) => item.courseId === node.id && item.lifecycle !== "draft_source").sort(compareReleaseRecency)[0]
          ?? [...releases].filter((item) => item.courseId === node.id).sort(compareReleaseRecency)[0]
        : undefined);
    const savedPageId = candidateRelease && restoreReadingPosition
      ? localStorage.getItem(`course-os-last-page:${candidateRelease.id}`) : undefined;
    const candidatePage = candidateRelease?.pages.find(item => item.id === savedPageId) ?? candidateRelease?.pages[0];
    if (!candidateRelease || !candidatePage) {
      setToast("这个材料还没有可读取的页面");
      return;
    }
    selectPage(candidateRelease.id, candidatePage.id);
    setMode(nextMode);
  };

  const reorderTreeNode = async (node: CourseTreeNode, direction: "up" | "down") => {
    const siblings = node.kind === "course"
      ? (tree?.courses ?? []).filter((candidate) => candidate.kind === "course")
      : node.parentId
        ? (tree?.courses.find((course) => course.id === node.parentId)?.children ?? [])
        : (tree?.rootMaterials ?? []);
    const index = siblings.findIndex((candidate) => candidate.id === node.id);
    const target = index < 0 ? undefined : siblings[index + (direction === "up" ? -1 : 1)];
    if (!target) { setToast(direction === "up" ? "已经是最前面" : "已经是最后面"); return; }
    const sourceOrder = node.sortOrder ?? index;
    const targetOrder = target.sortOrder ?? (direction === "up" ? index - 1 : index + 1);
    await runTreeAction(async () => {
      await api.updateTreeNode(node, { sortOrder: targetOrder });
      await api.updateTreeNode(target, { sortOrder: sourceOrder });
    }, "顺序已更新");
  };

  const treeActions: CourseTreeActions = {
    createModule: (node) => setTextAction({ kind: "module", node }),
    importMaterial: (node) => { setImportParentNodeId(node.id); setImportOpen(true); },
    rename: (node) => setTextAction({ kind: "rename", node }),
    duplicate: (node) => void runTreeAction(() => api.duplicateTreeNode(node).then(() => undefined), "已建立新的草稿副本"),
    move: (node) => setMoveNode(node),
    moveTo: (node, parentId, sortOrder) => void runTreeAction(() => api.updateTreeNode(node, { parentId, sortOrder }).then(() => undefined), "项目位置已更新"),
    reorder: (node, direction) => void reorderTreeNode(node, direction),
    trash: (node) => {
      if (window.confirm(`确定把“${node.title}”移入回收站吗`)) void runTreeAction(() => api.trashTreeNode(node).then(() => undefined), "已移入回收站");
    },
    openMaterial: (node, options) => openTreeNode(node, "learn", options?.restoreReadingPosition ?? true),
    openStudio: (node) => {
      if (node.pageId && node.releaseId) { selectPage(node.releaseId, node.pageId); setMode("studio"); }
      else openTreeNode(node, "studio");
    },
    openReadWeave: (node) => {
      if (node.readweaveNoteId) void runTreeAction(
        () => openVerifiedReadWeaveDeepLink(node.readweaveNoteId!),
        "已打开 ReadWeave 精细笔记",
        "正在验证 ReadWeave 精细笔记…",
        false
      );
    },
    history: (node) => setHistoryNode(node),
    properties: (node) => void runTreeAction(async () => { const properties = await api.treeNodeProperties(node.id); setToast(`${properties.title} · 修订 ${properties.revision} · ${properties.syncState === "connected" ? "已同步" : "未同步"}`); }, "节点属性已读取"),
    openTrash: () => setUtilityPanel("trash")
  };

  if (error) return <main className="empty-state"><span className="empty-logo">CO</span><h1>Course OS 暂时无法启动</h1><p>{error}</p><button className="primary-button" data-action="release-retry" onClick={() => { setError(""); setExplicitReleaseReload((value) => value + 1); }}>重试</button></main>;
  if (loading) return <main className="empty-state"><div className="loader" /><h1>正在建立课程工作区</h1><p>正在读取 ReadWeave、课程树和固定发布版本</p></main>;
  if (!release || !page) return <div className="product-shell" style={shellStyle}>
    <header className="product-topbar"><div className="product-brand"><span className="brand-symbol"><span>C</span><span>O</span></span><div><strong>Course OS</strong><small>Course intelligence workspace</small></div></div><div className="product-actions"><button className="mobile-tree-button icon-button" data-action="open-mobile-tree" onClick={() => setMobileTreeOpen(true)} aria-label="打开课程项目树" title="打开课程项目树"><Icon name="panel" /></button><button className={`sync-indicator sync-${sync?.state || "offline"}`} data-action="open-sync-panel" onClick={() => setUtilityPanel("sync")}><span className="live-dot"/><span>{sync?.state === "connected" ? "ReadWeave 已连接" : "等待 ReadWeave"}</span></button><button className="profile-button" data-action="open-account" onClick={() => setUtilityPanel("account")} aria-label="账户菜单">A</button></div></header>
       <StartupReadNotices releaseIndexError={releaseIndexError} releaseIndexLoading={releaseIndexLoading} onRetryReleaseIndex={() => setReleaseIndexReload((value) => value + 1)} treeError={treeError} treeLoading={treeLoading} onRetryTree={() => { setTreeError(""); void refreshMetadata().catch(() => undefined); }} />
       <div className={`product-body ${leftCollapsed ? "left-collapsed" : ""}`}><CourseTree tree={tree} searchMaterials={searchMaterials} backgroundTasks={backgroundTasks} onClearFailed={(ids) => void clearFailedTasks(ids)} clearFailedBusy={clearFailedBusy} selectedTaskId={activeImportId} onSelectTask={trackImport} collapsed={leftCollapsed} onCollapse={() => setLeftCollapsed((value) => !value)} sidebarWidth={sidebarWidth} onResizeStart={startSidebarResize} onResizeKeyboard={adjustSidebarWidth} actions={treeActions} onSelectPage={() => undefined} onImport={() => setImportOpen(true)} onCreateCourse={() => setCreateCourseOpen(true)} onSettings={() => setUtilityPanel("settings")} /><section className={`product-content empty-course-workspace ${activeImportId ? "task-page-open" : ""}`}>{activeImportId ? <ImportActivityDock key={activeImportId} importId={activeImportId} taskTitle={backgroundTasks.find((task) => task.id === activeImportId)?.title} onReady={handleImported} onOpen={(record, nextMode) => void openImported(record, nextMode)} onProgress={() => setCandidatePreviewReload((value) => value + 1)} onClose={() => trackImport(undefined)} /> : releaseId ? <WorkspaceLoader /> : releaseIndexError || releaseIndexLoading ? null : <><span className="empty-logo">CO</span><h1>{tree?.courses.length ? "导入第一份课程材料" : "建立第一门课程"}</h1><p>{tree?.courses.length ? "选择现有课程并导入课件，系统会建立对应页面" : "先建立课程项目，再导入 PPTX、PDF 或 syllabus，系统会在 ReadWeave 中建立对应知识树"}</p><div><button className="primary-button" data-action="empty-create-course" onClick={() => setCreateCourseOpen(true)}><Icon name="plus" />新建课程</button><button className="quiet-button" data-action="empty-import-material" onClick={() => setImportOpen(true)}><Icon name="upload" />导入材料</button></div></>}</section></div>
      <MobileTreeDrawer tree={tree} searchMaterials={searchMaterials} backgroundTasks={backgroundTasks} onClearFailed={(ids) => void clearFailedTasks(ids)} clearFailedBusy={clearFailedBusy} selectedTaskId={activeImportId} onSelectTask={(id) => { setMobileTreeOpen(false); trackImport(id); }} actions={treeActions} onClose={() => setMobileTreeOpen(false)} open={mobileTreeOpen} onSelectPage={() => setMobileTreeOpen(false)} onImport={() => { setMobileTreeOpen(false); setImportOpen(true); }} onCreateCourse={() => { setMobileTreeOpen(false); setCreateCourseOpen(true); }} onSettings={() => { setMobileTreeOpen(false); setUtilityPanel("settings"); }} />
      {importOpen && <ImportDialog courses={tree?.courses ?? []} releases={releases} parentNodeId={importParentNodeId} onClose={() => { setImportOpen(false); setImportParentNodeId(undefined); }} onSubmitted={(record) => { setImportOpen(false); setImportParentNodeId(undefined); rememberImport(record); trackImport(record.id); setToast("材料已加入后台任务，可从课程树打开进度"); }} />}
    {createCourseOpen && <CreateCourseDialog onClose={() => setCreateCourseOpen(false)} onCreated={() => refreshMetadata().catch(() => undefined)} />}
       {utilityPanel && <UtilityDialog panel={utilityPanel} focusRequest={globalSearchFocusRequest} releases={releases} tree={tree} sync={sync} conflicts={conflicts} theme={theme} onTheme={setTheme} onSelectPage={selectPage} onRefresh={refreshMetadata} onRefreshSync={refreshSyncStatus} onOpenTrash={() => setUtilityPanel("trash")} onClose={() => setUtilityPanel(null)} />}
    {historyNode && <HistoryDialog node={historyNode} releases={releases} onClose={() => setHistoryNode(undefined)} onSelectPage={selectPage} />}
    {textAction && <TreeTextDialog action={textAction} onClose={() => setTextAction(undefined)} onSubmit={(title) => { const action = textAction; setTextAction(undefined); if (action.kind === "module") void runTreeAction(() => api.createModule(action.node.id, title).then(() => undefined), "模块已建立"); else if (title !== action.node.title || api.hasPendingTreeNodeUpdate(action.node, { title })) void runTreeAction(() => api.updateTreeNode(action.node, { title }).then((updated) => { updateTreeAfterRename(updated); }), "名称已更新", "正在保存名称…", false); }} />}
    {moveNode && <MoveNodeDialog node={moveNode} tree={tree} onClose={() => setMoveNode(undefined)} onMove={(parentId) => { void runTreeAction(() => api.updateTreeNode(moveNode, { parentId }).then(() => undefined), "节点位置已更新"); setMoveNode(undefined); }} />}
    {toast && <div className="app-toast" role="status">{toast}</div>}
  </div>;

  return (
    <div className="product-shell" style={shellStyle}>
      <header className="product-topbar">
        <div className="product-brand"><span className="brand-symbol"><span>C</span><span>O</span></span><div><strong>Course OS</strong><small>Course intelligence workspace</small></div></div>

        <nav className="mode-switcher" aria-label="工作模式">
          <ModeButton actionId="mode-learn" active={mode === "learn"} icon="play" label="学习" onClick={() => setMode("learn")} />
          <ModeButton actionId="mode-studio" active={mode === "studio"} icon="edit" label="制作" onClick={() => setMode("studio")} />
          <ModeButton actionId="mode-review" active={mode === "review"} icon="review" label="复习" onClick={() => setMode("review")} />
        </nav>

         <div className="product-actions">
           <button className="mobile-tree-button icon-button" data-action="open-mobile-tree" onClick={() => setMobileTreeOpen(true)} aria-label="打开课程项目树" title="打开课程项目树"><Icon name="panel" /></button>
           <button className={`sync-indicator sync-${sync?.state || "offline"}`} data-action="open-sync-panel" onClick={() => setUtilityPanel("sync")}><span className="live-dot"/><span>{sync?.state === "connected" ? "ReadWeave 已同步" : "同步状态异常"}</span>{conflicts.length > 0 && <b>{conflicts.length}</b>}</button>
          <button className="command-button" data-action="open-global-search" onClick={() => setUtilityPanel("search")}><Icon name="command" /><span>全局搜索</span><kbd>⌘ K</kbd></button>
          <button className="icon-button" data-action="toggle-theme" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={theme === "light" ? "切换深色模式" : "切换浅色模式"}><Icon name={theme === "light" ? "moon" : "sun"} /></button>
          <button className="profile-button" data-action="open-account" onClick={() => setUtilityPanel("account")} aria-label="账户菜单">A</button>
        </div>
      </header>

      <StartupReadNotices releaseIndexError={releaseIndexError} releaseIndexLoading={releaseIndexLoading} onRetryReleaseIndex={() => setReleaseIndexReload((value) => value + 1)} treeError={treeError} treeLoading={treeLoading} onRetryTree={() => { setTreeError(""); void refreshMetadata().catch(() => undefined); }} />
      <div className={`product-body ${leftCollapsed ? "left-collapsed" : ""}`}>
        <CourseTree tree={tree} searchMaterials={searchMaterials} backgroundTasks={backgroundTasks} onClearFailed={(ids) => void clearFailedTasks(ids)} clearFailedBusy={clearFailedBusy} selectedTaskId={activeImportId} onSelectTask={trackImport} collapsed={leftCollapsed} onCollapse={() => setLeftCollapsed((value) => !value)} sidebarWidth={sidebarWidth} onResizeStart={startSidebarResize} onResizeKeyboard={adjustSidebarWidth} actions={treeActions} selectedPageId={page.id} onSelectPage={selectPage} onImport={() => setImportOpen(true)} onCreateCourse={() => setCreateCourseOpen(true)} onSettings={() => setUtilityPanel("settings")} />
        <section className={`product-content ${mode === "learn" ? "learning-content-layout" : ""}`}>
          {sessionWarning && <p className="empty-inline" role="status">{sessionWarning}</p>}
          {mode === "learn" && release.lifecycle === "draft_source" && candidatePreview?.pageId === page.id && candidatePreview.page && candidatePreview.notice && candidatePreview.generatedReady !== false && <p className="empty-inline" role="status">{candidatePreview.notice}{candidatePreview.unavailable && <button type="button" className="quiet-button" data-action="candidate-open-studio" onClick={() => setMode("studio")}>进入制作模式</button>}</p>}
          {mode === "learn" ? <div className="learning-content-slot">{activeImportId ? <ImportActivityDock key={activeImportId} importId={activeImportId} onReady={handleImported} onOpen={(record, nextMode) => void openImported(record, nextMode)} onProgress={() => setCandidatePreviewReload((value) => value + 1)} onClose={() => trackImport(undefined)} /> : <Suspense fallback={<WorkspaceLoader />}>
            {mode === "learn" && <LearningWorkspace release={previewRelease ?? release} pageIndex={pageIndex} setPageIndex={setPageIndex} onPrefetchPage={(targetIndex, priority = 10) => prefetchPage(targetIndex, priority)} imageResources={imageResources} session={session?.courseReleaseId === release.id ? session : undefined} view={view} updateView={updateView} mobileMode={mobileMode} setMobileMode={setMobileMode} pageDockOpen={pageDockOpen} setPageDockOpen={setPageDockOpen} rightCollapsed={rightCollapsed} onToggleRight={() => setRightCollapsed((value) => !value)} onEnterStudio={() => setMode("studio")} unpublishedDraftRevision={pageCache.get(pageSnapshotCacheKey(release.id, page.id))?.unpublishedDraftRevision} generatedReady={release.lifecycle === "draft_source" && candidatePreview?.pageId === page.id && candidatePreview.generatedReady === true} contentReady={release.lifecycle === "draft_source" ? Boolean(candidatePreview?.pageId === page.id && candidatePreview.page) : pageDetailReady} contentError={release.lifecycle === "draft_source" ? candidatePreview?.pageId === page.id ? candidatePreview.error : undefined : currentFormalPageError?.message} contentNotice={release.lifecycle === "draft_source" && candidatePreview?.pageId === page.id ? candidatePreview.notice : undefined} contentReviewRequired={release.lifecycle === "draft_source" && candidatePreview?.pageId === page.id && candidatePreview.generatedReady === false && Boolean(candidatePreview.page && candidatePreview.notice)} contentUnavailable={release.lifecycle === "draft_source" && candidatePreview?.pageId === page.id && Boolean(candidatePreview.unavailable)} contentTerminalError={release.lifecycle === "draft_source" ? candidatePreview?.pageId === page.id && candidatePreview.terminal === true : currentFormalPageError?.terminal === true} onRetryContent={() => release.lifecycle === "draft_source" ? setCandidatePreviewReload((value) => value + 1) : setFormalPageReload((value) => value + 1)} />}
          </Suspense>}</div> : activeImportId ? <ImportActivityDock key={activeImportId} importId={activeImportId} onReady={handleImported} onOpen={(record, nextMode) => void openImported(record, nextMode)} onProgress={() => setCandidatePreviewReload((value) => value + 1)} onClose={() => trackImport(undefined)} /> : <Suspense fallback={<WorkspaceLoader />}>
            {mode === "studio" && !pageDetailReady && release.lifecycle !== "draft_source" && <div className="workspace-loader compact" role="status">{currentFormalPageError ? <><span>{currentFormalPageError.message}</span><button type="button" className="quiet-button compact" onClick={() => setFormalPageReload((value) => value + 1)}>重试</button></> : <><div className="loader" /><span>正在载入页面详情</span></>}</div>}
            {pageDetailReady && mode === "studio" && <StudioWorkspace key={`${release.id}:${page.id}`} release={release} page={page} sync={sync} imageResources={imageResources} rightCollapsed={rightCollapsed} onToggleRight={() => setRightCollapsed((value) => !value)} onPublished={handlePublished} onChanged={() => refreshMetadata().catch(() => undefined)} />}
             {mode === "review" && <ReviewWorkspace releases={releases} reviewMap={reviewMap} onOpenPage={(nextReleaseId, pageId) => { selectPage(nextReleaseId, pageId); setMode("learn"); }} onReviewChanged={() => refreshMetadata({ includeReview: true })} />}
          </Suspense>}
        </section>
      </div>

      <MobileTreeDrawer tree={tree} searchMaterials={searchMaterials} backgroundTasks={backgroundTasks} onClearFailed={(ids) => void clearFailedTasks(ids)} clearFailedBusy={clearFailedBusy} selectedTaskId={activeImportId} onSelectTask={(id) => { setMobileTreeOpen(false); trackImport(id); }} selectedPageId={page.id} actions={treeActions} onClose={() => setMobileTreeOpen(false)} open={mobileTreeOpen} onSelectPage={(nextReleaseId, nextPageId) => { setMobileTreeOpen(false); selectPage(nextReleaseId, nextPageId); }} onImport={() => { setMobileTreeOpen(false); setImportOpen(true); }} onCreateCourse={() => { setMobileTreeOpen(false); setCreateCourseOpen(true); }} onSettings={() => { setMobileTreeOpen(false); setUtilityPanel("settings"); }} />
       {importOpen && <ImportDialog courses={tree?.courses ?? []} releases={releases} parentNodeId={importParentNodeId} onClose={() => { setImportOpen(false); setImportParentNodeId(undefined); }} onSubmitted={(record) => { setImportOpen(false); setImportParentNodeId(undefined); rememberImport(record); trackImport(record.id); setToast("材料已加入后台任务，可从课程树打开进度"); }} />}
      {createCourseOpen && <CreateCourseDialog onClose={() => setCreateCourseOpen(false)} onCreated={() => refreshMetadata().catch(() => undefined)} />}
       {utilityPanel && <UtilityDialog panel={utilityPanel} focusRequest={globalSearchFocusRequest} releases={releases} tree={tree} sync={sync} conflicts={conflicts} theme={theme} onTheme={setTheme} onSelectPage={selectPage} onRefresh={refreshMetadata} onRefreshSync={refreshSyncStatus} onOpenTrash={() => setUtilityPanel("trash")} onClose={() => setUtilityPanel(null)} />}
      {historyNode && <HistoryDialog node={historyNode} releases={releases} onClose={() => setHistoryNode(undefined)} onSelectPage={selectPage} />}
      {textAction && <TreeTextDialog action={textAction} onClose={() => setTextAction(undefined)} onSubmit={(title) => { const action = textAction; setTextAction(undefined); if (action.kind === "module") void runTreeAction(() => api.createModule(action.node.id, title).then(() => undefined), "模块已建立"); else if (title !== action.node.title || api.hasPendingTreeNodeUpdate(action.node, { title })) void runTreeAction(() => api.updateTreeNode(action.node, { title }).then((updated) => { updateTreeAfterRename(updated); }), "名称已更新", "正在保存名称…", false); }} />}
      {moveNode && <MoveNodeDialog node={moveNode} tree={tree} onClose={() => setMoveNode(undefined)} onMove={(parentId) => { void runTreeAction(() => api.updateTreeNode(moveNode, { parentId }).then(() => undefined), "节点位置已更新"); setMoveNode(undefined); }} />}
      {toast && <div className="app-toast" role="status">{toast}</div>}
    </div>
  );
}

function ModeButton({ actionId, active, icon, label, onClick }: { actionId: string; active: boolean; icon: "edit" | "play" | "review"; label: string; onClick: () => void }) {
  return <button className={active ? "active" : ""} data-action={actionId} onClick={onClick}><Icon name={icon} />{label}</button>;
}

function MobileTreeDrawer({ tree, searchMaterials, selectedPageId, selectedTaskId, backgroundTasks, onSelectTask, onClearFailed, clearFailedBusy, actions, open, onClose, onSelectPage, onImport, onCreateCourse, onSettings }: {
  tree?: WorkspaceTree;
  searchMaterials: CourseTreeSearchMaterial[];
  selectedPageId?: string;
  selectedTaskId?: string;
  backgroundTasks: CourseTreeTask[];
  onSelectTask: (taskId: string) => void;
  onClearFailed: (ids: string[]) => void;
  clearFailedBusy: boolean;
  actions: CourseTreeActions;
  open: boolean;
  onClose: () => void;
  onSelectPage: (releaseId: string, pageId: string) => void;
  onImport: () => void;
  onCreateCourse: () => void;
  onSettings: () => void;
}) {
  if (!open) return null;
  return <div className="mobile-tree-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="mobile-tree-drawer" role="dialog" aria-modal="true" aria-label="课程项目树" onMouseDown={(event) => event.stopPropagation()}>
      <CourseTree tree={tree} searchMaterials={searchMaterials} backgroundTasks={backgroundTasks} onClearFailed={onClearFailed} clearFailedBusy={clearFailedBusy} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} selectedPageId={selectedPageId} collapsed={false} onCollapse={onClose} onSelectPage={onSelectPage} onImport={onImport} onCreateCourse={onCreateCourse} onSettings={onSettings} actions={actions} />
    </div>
  </div>;
}

function LearningWorkspace({ release, pageIndex, setPageIndex, onPrefetchPage, imageResources, session, view, updateView, mobileMode, setMobileMode, pageDockOpen, setPageDockOpen, rightCollapsed, onToggleRight, onEnterStudio, unpublishedDraftRevision, generatedReady, contentReady = true, contentError, contentNotice, contentReviewRequired = false, contentUnavailable = false, contentTerminalError = false, onRetryContent }: {
  release: CourseRelease;
  pageIndex: number;
  setPageIndex: Dispatch<SetStateAction<number>>;
  onPrefetchPage: (index: number, priority?: number) => void;
  imageResources: ImageResourceCache;
  session?: LearningSession;
  view: ViewState;
  updateView: (next: ViewState) => void;
  mobileMode: MobileMode;
  setMobileMode: (mode: MobileMode) => void;
  pageDockOpen: boolean;
  setPageDockOpen: Dispatch<SetStateAction<boolean>>;
  rightCollapsed: boolean;
  onToggleRight: () => void;
  onEnterStudio: () => void;
  unpublishedDraftRevision?: number;
  generatedReady?: boolean;
  contentReady?: boolean;
  contentError?: string;
  contentNotice?: string;
  contentReviewRequired?: boolean;
  contentUnavailable?: boolean;
  contentTerminalError?: boolean;
  onRetryContent?: () => void;
}) {
  const page = release.pages[pageIndex]!;
  const canShowContent = contentReady && !contentTerminalError;
  const lessonColumnRef = useRef<HTMLDivElement>(null);
  const lessonStripRef = useRef<HTMLElement>(null);

  useEffect(() => {
    lessonColumnRef.current?.scrollTo({ top: 0, behavior: "auto" });
    if (!pageDockOpen) return;
    const strip = lessonStripRef.current;
    const active = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !active) return;
    strip.scrollTo({
      left: active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2,
      behavior: "auto",
    });
  }, [page.id, pageDockOpen, release.id]);

  return <div className="learning-workspace">
    <header className="learning-header">
      <div><div className="breadcrumbs"><span>{release.courseTitle}</span><Icon name="chevronRight" /><span>{release.moduleTitle}</span></div><h1>{page.title}</h1></div>
      <div className="learning-header-actions"><button className="quiet-button" data-action="learn-open-studio" onClick={onEnterStudio}><Icon name="edit" />制作本页</button><div className="learning-progress"><span>学习进度</span><strong>{pageIndex + 1} / {release.pages.length}</strong><div><i style={{ width: `${(pageIndex + 1) / release.pages.length * 100}%` }} /></div></div></div>
    </header>

    <nav className="mobile-tabs" aria-label="手机学习模式">
      <button className={mobileMode === "visual" ? "active" : ""} data-action="mobile-visual" onClick={() => setMobileMode("visual")}>原始课件</button>
      <button className={mobileMode === "lesson" ? "active" : ""} data-action="mobile-lesson" onClick={() => setMobileMode("lesson")}>老师讲解</button>
      <button className={mobileMode === "practice" ? "active" : ""} data-action="mobile-practice" onClick={() => setMobileMode("practice")}>提问与测验</button>
    </nav>

    <main className={`learning-grid mode-${mobileMode} ${rightCollapsed ? "right-is-collapsed" : ""}`}>
      <div className="visual-column">{contentTerminalError
        ? <div className="empty-inline" role="alert">{contentError || "当前页面已无权访问或已删除"}</div>
        : <SlideViewer imageUrl={page.imageUrl} title={page.title} value={view} onChange={updateView} imageResources={imageResources} />}</div>
      {rightCollapsed
          ? <aside className="right-collapsed-rail"><button data-action="right-expand-learn" onClick={onToggleRight} aria-label="展开教学栏" title="展开教学栏"><Icon name="chevronLeft" /><span>展开讲解</span></button></aside>
        : <div className="lesson-column" ref={lessonColumnRef}><div className="column-collapse-row"><span>老师讲解</span><button data-action="right-collapse-learn" onClick={onToggleRight} aria-label="收起教学栏" title="收起教学栏"><Icon name="chevronRight" /></button></div>{canShowContent && contentReviewRequired && contentNotice && <p className="empty-inline" role="status">{contentNotice}<button type="button" className="quiet-button" data-action="candidate-open-studio" onClick={onEnterStudio}>进入制作模式</button></p>}{canShowContent ? <Suspense fallback={<WorkspaceLoader compact />}><ExplanationPanel key={page.id} release={release} page={page} sessionId={session?.id} onEnterStudio={onEnterStudio} loadRootRef={lessonColumnRef} generatedReady={generatedReady} unpublishedDraftRevision={unpublishedDraftRevision} /></Suspense> : <div className="workspace-loader compact" role={contentTerminalError ? "alert" : "status"}>{!contentError && !contentTerminalError && !contentUnavailable && <div className="loader" />}<span>{contentUnavailable ? contentNotice : contentError ? `目标页讲解载入失败：${contentError}` : release.lifecycle === "draft_source" ? "正在载入候选讲解" : "正在载入本页讲解"}</span>{contentUnavailable ? <button type="button" className="quiet-button" data-action="candidate-open-studio" onClick={onEnterStudio}>进入制作模式</button> : contentError && onRetryContent && <button type="button" className="quiet-button compact" onClick={onRetryContent}>重试</button>}</div>}</div>}
    </main>

    <footer className={`page-dock ${pageDockOpen ? "expanded" : "collapsed"}`}>
      <div className="page-dock-summary">
        <button data-action="page-previous" disabled={pageIndex === 0} title={pageIndex === 0 ? "已经是第一页" : "打开上一页"} onMouseEnter={() => onPrefetchPage(pageIndex - 1)} onFocus={() => onPrefetchPage(pageIndex - 1)} onPointerDown={() => onPrefetchPage(pageIndex - 1, 20)} onClick={() => setPageIndex((index) => index - 1)}><Icon name="arrowLeft" />上一页</button>
        <button className="page-dock-toggle" data-action="toggle-page-dock" onClick={() => setPageDockOpen((open) => !open)} aria-expanded={pageDockOpen}><span>第 {page.pageNumber} 页 · {page.title}</span><small>{pageDockOpen ? "收起全部页面" : `展开全部 ${release.pages.length} 页`}</small><Icon name={pageDockOpen ? "chevronUp" : "chevronDown"} /></button>
        <button className="button-icon-trailing" data-action="page-next" disabled={pageIndex === release.pages.length - 1} title={pageIndex === release.pages.length - 1 ? "已经是最后一页" : "打开下一页"} onMouseEnter={() => onPrefetchPage(pageIndex + 1)} onFocus={() => onPrefetchPage(pageIndex + 1)} onPointerDown={() => onPrefetchPage(pageIndex + 1, 20)} onClick={() => setPageIndex((index) => index + 1)}>下一页<Icon name="arrowRight" /></button>
      </div>
      {pageDockOpen && <nav className="lesson-strip" ref={lessonStripRef} aria-label="课程全部页面">{release.pages.map((item, index) => <button key={item.id} data-action="page-select" className={index === pageIndex ? "active" : ""} aria-current={index === pageIndex ? "page" : undefined} onMouseEnter={() => onPrefetchPage(index)} onFocus={() => onPrefetchPage(index)} onPointerDown={() => onPrefetchPage(index, 20)} onClick={() => setPageIndex(index)}><span>{item.pageNumber}</span><div><strong>{item.title}</strong><small>{item.quality.publishable ? "讲解已生成" : "讲解草稿"}</small></div></button>)}</nav>}
    </footer>
  </div>;
}

export type GlobalSearchResult = { release: CourseRelease; page: CourseRelease["pages"][number] };

export function buildGlobalSearchResults(releases: CourseRelease[], tree: WorkspaceTree | undefined, query: string): GlobalSearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  return currentMaterialReleases(releases, tree)
    .flatMap((release) => release.pages.map((page) => ({ release, page })))
    .filter(({ release, page }) => !needle || `${release.courseTitle} ${release.moduleTitle} ${page.title} ${page.pageNumber}`.toLocaleLowerCase().includes(needle))
    .slice(0, 40);
}

function UtilityDialog({ panel, focusRequest, releases, tree, sync, conflicts, theme, onTheme, onSelectPage, onRefresh, onRefreshSync, onOpenTrash, onClose }: {
  panel: Exclude<UtilityPanel, null>;
  focusRequest: number;
  releases: CourseRelease[];
  tree?: WorkspaceTree;
  sync?: ReadWeaveSyncStatus;
  conflicts: CourseConflict[];
  theme: "light" | "dark";
  onTheme: (theme: "light" | "dark") => void;
  onSelectPage: (releaseId: string, pageId: string) => void;
  onRefresh: () => Promise<void>;
  onRefreshSync: () => Promise<ReadWeaveSyncStatus>;
  onOpenTrash: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<{ kind: "success" | "error" | "pending"; text: string }>();
  const searchInput = useRef<HTMLInputElement>(null);
  const searchResults = useRef<HTMLDivElement>(null);
  const results = buildGlobalSearchResults(releases, tree, query);
  useEffect(() => {
    if (panel === "search") searchInput.current?.focus();
  }, [focusRequest, panel]);
  useEffect(() => {
    if (panel !== "search") return;
    searchResults.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [activeSearchIndex, panel, results.length]);
  const selectSearchResult = (result: GlobalSearchResult) => {
    onSelectPage(result.release.id, result.page.id);
    onClose();
  };
  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const action = resolveSearchInputKeyAction(event.key, activeSearchIndex, results.length);
    if (action.kind === "none") return;
    event.preventDefault();
    if (action.kind === "close") { onClose(); return; }
    if (action.kind === "move") { setActiveSearchIndex(action.index); return; }
    const result = results[action.index];
    if (result) selectSearchResult(result);
  };
  const refreshSync = async () => {
    setRefreshing(true);
    setSyncFeedback({ kind: "pending", text: "正在检查 ReadWeave 连接…" });
    try {
      const next = await onRefreshSync();
      setSyncFeedback({ kind: "success", text: `同步状态已更新 · ${next.state === "connected" ? "连接正常" : next.message || "暂时无法确认连接"}` });
    } catch (reason) {
      setSyncFeedback({ kind: "error", text: reason instanceof Error ? reason.message : "同步状态读取失败" });
    } finally { setRefreshing(false); }
  };
  return <div className="modal-backdrop utility-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="utility-dialog" role="dialog" aria-modal="true" aria-label={panelTitle(panel)}>
      <header><div><span className="section-kicker">COURSE OS</span><h2>{panelTitle(panel)}</h2></div><button className="icon-button" data-action="close-utility-panel" onClick={onClose} aria-label="关闭"><span aria-hidden="true">×</span></button></header>
      {panel === "search" && <div className="utility-content"><label className="utility-search"><Icon name="search" /><input ref={searchInput} data-action="search-pages" autoFocus role="combobox" aria-autocomplete="list" aria-expanded={results.length > 0} aria-controls="global-search-results" aria-activedescendant={results[activeSearchIndex] ? `global-search-result-${activeSearchIndex}` : undefined} onKeyDown={onSearchKeyDown} value={query} onChange={(event) => { setQuery(event.target.value); setActiveSearchIndex(0); }} placeholder="搜索课程、材料、页面或页码" /></label><div ref={searchResults} id="global-search-results" className="search-results" role="listbox" aria-label="搜索结果">{results.map(({ release, page }, index) => <button key={`${release.id}:${page.id}`} id={`global-search-result-${index}`} role="option" aria-selected={index === activeSearchIndex} className={index === activeSearchIndex ? "active" : undefined} style={index === activeSearchIndex ? { background: "var(--soft)" } : undefined} data-action="search-open-page" onMouseEnter={() => setActiveSearchIndex(index)} onClick={() => selectSearchResult({ release, page })}><span>{page.pageNumber}</span><div><strong>{page.title}</strong><small>{release.courseTitle} · {release.moduleTitle}</small></div><Icon name="arrowRight" /></button>)}{results.length === 0 && <p className="empty-inline" role="status">没有找到匹配页面</p>}</div></div>}
      {panel === "sync" && <div className="utility-content"><div className={`sync-card sync-${sync?.state || "offline"}`}><span className="live-dot"/><div><strong>{sync?.state === "connected" ? "ReadWeave 已连接" : "ReadWeave 尚未连接"}</strong><span>{sync?.message || "尚未取得同步说明"}</span></div></div><dl className="utility-definitions"><div><dt>权威来源</dt><dd>ReadWeave</dd></div><div><dt>最近内容确认</dt><dd>{sync?.lastReadAt ? new Date(sync.lastReadAt).toLocaleString() : "尚未确认"}</dd></div><div><dt>待写入</dt><dd>{sync?.pendingWrites ?? 0}</dd></div><div><dt>冲突</dt><dd>{conflicts.length}</dd></div></dl>{conflicts.length > 0 && <div className="conflict-summary">{conflicts.map((conflict) => <p key={conflict.id}><Icon name="warning" />{conflict.objectType} · {conflict.objectId}</p>)}</div>}{syncFeedback && <p className={`sync-feedback ${syncFeedback.kind}`} role={syncFeedback.kind === "error" ? "alert" : "status"} aria-live="polite"><Icon name={syncFeedback.kind === "error" ? "warning" : syncFeedback.kind === "success" ? "check" : "sparkles"} />{syncFeedback.text}</p>}<button className="primary-button" data-action="refresh-sync-status" aria-describedby="refresh-sync-status-reason" disabled={refreshing} onClick={() => void refreshSync()}>{refreshing ? "正在重新检查" : "重新检查同步状态"}</button><span id="refresh-sync-status-reason" className="sr-only">{refreshing ? "正在读取 ReadWeave 连接和待同步操作" : "重新读取 ReadWeave 连接、待写入和冲突状态"}</span></div>}
      {panel === "settings" && <SettingsPanel theme={theme} onTheme={onTheme} sync={sync} onOpenTrash={onOpenTrash} />}
      {panel === "trash" && <TrashPanel onRefresh={onRefresh} />}
      {panel === "account" && <div className="utility-content account-panel"><span className="account-avatar">A</span><h3>Personal workspace</h3><p>当前课程内容由 ReadWeave 统一保存，身份验证由 Authentik 管理</p><a className="primary-button" href="/_aialra_auth/logout">退出登录</a></div>}
    </section>
  </div>;
}

function panelTitle(panel: Exclude<UtilityPanel, null>) {
  return ({ search: "全局课程搜索", sync: "ReadWeave 同步状态", account: "账户", settings: "工作区设置", trash: "回收站" })[panel];
}

type SettingsTab = "general" | "appearance" | "learning" | "readweave" | "providers" | "search" | "routing" | "data" | "diagnostics";

function SettingsPanel({ theme, onTheme, sync, onOpenTrash }: { theme: "light" | "dark"; onTheme: (theme: "light" | "dark") => void; sync?: ReadWeaveSyncStatus; onOpenTrash: () => void }) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [settings, setSettings] = useState<WorkspaceSettings>({ workspaceId: "personal", language: "zh-CN", theme, baseFontScale: 1.1, defaultQualityMode: "balanced", learningAutoAdvance: false, showEnglishLabels: false, updatedAt: new Date(0).toISOString() });
  const [providers, setProviders] = useState<ModelProviderConfig[]>([]);
  const [policy, setPolicy] = useState<ModelRoutePolicy>({ workspaceId: "personal", rules: [], allowAialraEmergencyFallback: false, updatedAt: new Date(0).toISOString() });
  const [searchProviders, setSearchProviders] = useState<SearchProviderConfig[]>([]);
  const [searchPolicy, setSearchPolicy] = useState<SearchRoutePolicy>({ workspaceId: "personal", rules: [], updatedAt: new Date(0).toISOString() });
  const [searchSecrets, setSearchSecrets] = useState<Record<string, string>>({});
  const [searchAvailable, setSearchAvailable] = useState(true);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [etapi, setEtapi] = useState<ReadWeaveEtapiSettings>();
  const [etapiToken, setEtapiToken] = useState("");
  const [newProvider, setNewProvider] = useState({ id: "", displayName: "", baseUrl: "", modelId: "" });
  const [trashCount, setTrashCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.readweaveEtapiSettings().then(setEtapi).catch((reason) => setError(reason instanceof Error ? reason.message : "ReadWeave 设置读取失败"));
    Promise.all([api.settings(), api.modelProviders(), api.modelRoutePolicy(), api.trash()]).then(([loadedSettings, loadedProviders, loadedPolicy, trash]) => {
      setSettings(loadedSettings);
      if (loadedSettings.theme === "light" || loadedSettings.theme === "dark") onTheme(loadedSettings.theme);
      setProviders(loadedProviders);
      setPolicy(loadedPolicy);
      setTrashCount(trash.length);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "设置读取失败"));
    Promise.allSettled([api.searchProviders(), api.searchRoutePolicy()]).then(([loadedProviders, loadedPolicy]) => {
      const providersReady = loadedProviders.status === "fulfilled";
      const policyReady = loadedPolicy.status === "fulfilled";
      if (providersReady) setSearchProviders(loadedProviders.value);
      if (policyReady) setSearchPolicy(loadedPolicy.value);
      setSearchAvailable(providersReady || policyReady);
    });
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--course-font-scale", String(settings.baseFontScale));
  }, [settings.baseFontScale]);

  const saveSettings = async () => {
    setBusy(true); setError("");
    try {
      const saved = await api.saveSettings(settings);
      setSettings(saved);
      if (saved.theme === "light" || saved.theme === "dark") onTheme(saved.theme);
      localStorage.setItem("course-os-language", saved.language);
      localStorage.setItem("course-os-budget", saved.defaultQualityMode);
      setNotice("工作区设置已保存");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "设置保存失败"); }
    finally { setBusy(false); }
  };

  const savePolicy = async () => {
    setBusy(true); setError("");
    try {
      // Empty routes is the API signal for an intentional switch to per-stage rules.
      const policyToSave = policy.routes === undefined ? { ...policy, routes: [] } : policy;
      setPolicy(await api.saveModelRoutePolicy(policyToSave)); setNotice("模型路由规则已保存");
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "路由规则保存失败"); }
    finally { setBusy(false); }
  };

  const saveSecret = async (providerId: string) => {
    const secret = secrets[providerId]?.trim();
    if (!secret) return;
    setBusy(true); setError("");
    try {
      const saved = await api.saveProviderCredential(providerId, secret);
      setProviders((current) => current.map((provider) => provider.id === providerId ? { ...provider, credential: saved.credential } : provider));
      setSecrets((current) => ({ ...current, [providerId]: "" }));
      setNotice("接口密钥已加密保存，页面不会回显完整密钥");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "接口密钥保存失败"); }
    finally { setBusy(false); }
  };

  const saveProvider = async (provider: ModelProviderConfig) => {
    setBusy(true); setError("");
    try {
      const saved = await api.updateModelProvider(provider.id, { displayName: provider.displayName, baseUrl: provider.baseUrl, enabled: provider.enabled });
      setProviders((current) => current.map((item) => item.id === provider.id ? saved : item));
      setNotice(`${provider.displayName} 设置已保存`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "供应商设置保存失败"); }
    finally { setBusy(false); }
  };

  const createProvider = async () => {
    setBusy(true); setError("");
    try {
      const model: ModelProviderCreate["models"][number] = { id: newProvider.modelId.trim(), displayName: newProvider.modelId.trim(), protocol: "responses", supportsVision: false, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" };
      const created = await api.createModelProvider({ id: newProvider.id.trim(), displayName: newProvider.displayName.trim(), baseUrl: newProvider.baseUrl.trim(), enabled: false, models: [model] });
      setProviders((current) => [...current.filter((item) => item.id !== created.id), created]);
      setNewProvider({ id: "", displayName: "", baseUrl: "", modelId: "" });
      setNotice("模型供应商已新增；请保存密钥并测试连接后再启用路由");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "新增供应商失败"); }
    finally { setBusy(false); }
  };

  const deleteProvider = async (providerId: string) => {
    if (!window.confirm("删除该供应商及已保存的密钥，并移除对应路由？")) return;
    setBusy(true); setError("");
    try {
      await api.deleteModelProvider(providerId);
      setProviders((current) => current.filter((item) => item.id !== providerId));
      setPolicy((current) => ({ ...current, routes: current.routes?.filter((route) => route.providerId !== providerId) }));
      setNotice("供应商、密钥和对应路由已删除");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除供应商失败"); }
    finally { setBusy(false); }
  };

  const saveEtapi = async () => {
    if (!etapi) return;
    setBusy(true); setError("");
    try {
      const saved = await api.updateReadweaveEtapiSettings({ enabled: etapi.enabled, baseUrl: etapi.baseUrl, parentNoteId: etapi.parentNoteId, publicUrl: etapi.publicUrl, ...(etapiToken.trim() ? { token: etapiToken.trim() } : {}) });
      setEtapi(saved); setEtapiToken(""); setNotice("ReadWeave 连接已更新并通过检查");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "ReadWeave 连接更新失败，原设置已保留"); }
    finally { setBusy(false); }
  };

  const deleteEtapi = async () => {
    if (!window.confirm("删除 ETAPI 连接会使 Course OS 暂时无法读写 ReadWeave，确定继续？")) return;
    setBusy(true); setError("");
    try { await api.deleteReadweaveEtapiSettings(); setEtapi((current) => current ? { ...current, enabled: false, credential: { configured: false } } : current); setNotice("ETAPI 配置已删除，ReadWeave 连接已停用"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "删除 ETAPI 配置失败"); }
    finally { setBusy(false); }
  };

  const testProvider = async (providerId: string) => {
    setBusy(true); setError("");
    try {
      const checked = await api.testProvider(providerId);
      setProviders((current) => current.map((provider) => provider.id === providerId ? checked : provider));
      setNotice(checked.health?.message || "供应商检查完成");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "供应商连接检查失败"); }
    finally { setBusy(false); }
  };

  const saveSearchSecret = async (providerId: string) => {
    const secret = searchSecrets[providerId]?.trim();
    if (!secret) return;
    setBusy(true); setError("");
    try {
      const saved = await api.saveSearchProviderCredential(providerId, secret);
      setSearchProviders((current) => current.map((provider) => provider.id === providerId ? { ...provider, credential: saved.credential } : provider));
      setSearchSecrets((current) => ({ ...current, [providerId]: "" }));
      setNotice("搜索接口密钥已加密保存，页面不会回显完整密钥");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "搜索接口密钥保存失败"); }
    finally { setBusy(false); }
  };

  const saveSearchProvider = async (provider: SearchProviderConfig) => {
    setBusy(true); setError("");
    try {
      const saved = await api.updateSearchProvider(provider.id, { baseUrl: provider.baseUrl, endpoint: provider.endpoint, enabled: provider.enabled, maxResults: provider.maxResults });
      setSearchProviders((current) => current.map((item) => item.id === provider.id ? saved : item));
      setNotice(`${provider.displayName} 搜索设置已保存`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "搜索供应商设置保存失败"); }
    finally { setBusy(false); }
  };

  const testSearchProvider = async (providerId: string) => {
    setBusy(true); setError("");
    try {
      const checked = await api.testSearchProvider(providerId);
      setSearchProviders((current) => current.map((provider) => provider.id === providerId ? checked : provider));
      setNotice(checked.health?.message || "搜索供应商检查完成");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "搜索供应商连接检查失败"); }
    finally { setBusy(false); }
  };

  const saveSearchPolicy = async () => {
    setBusy(true); setError("");
    try { setSearchPolicy(await api.saveSearchRoutePolicy(searchPolicy)); setNotice("搜索路由规则已保存"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "搜索路由规则保存失败"); }
    finally { setBusy(false); }
  };

  const updateSearchRule = (index: number, patch: Partial<SearchRoutePolicy["rules"][number]>) => {
    setSearchPolicy((current) => ({ ...current, rules: current.rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule) }));
  };

  const updateModelRoute = (index: number, patch: Partial<NonNullable<ModelRoutePolicy["routes"]>[number]>) => {
    setPolicy((current) => ({ ...current, routes: (current.routes || []).map((route, routeIndex) => routeIndex === index ? { ...route, ...patch } : route) }));
  };

  const moveModelRoute = (index: number, direction: -1 | 1) => {
    setPolicy((current) => {
      const routes = [...(current.routes || [])];
      const target = index + direction;
      if (target < 0 || target >= routes.length) return current;
      [routes[index], routes[target]] = [routes[target]!, routes[index]!];
      return { ...current, routes };
    });
  };

  const canAddModelRoute = (policy.routes?.length || 0) < 12 && providers.some((provider) =>
    provider.models.length > 0 && !(policy.routes || []).some((route) => route.providerId === provider.id));

  const updateSetting = <K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));
  const tabs: Array<[SettingsTab, string]> = [["general", "通用"], ["appearance", "外观与字号"], ["learning", "学习偏好"], ["readweave", "ReadWeave"], ["providers", "模型供应商"], ["search", "搜索供应商"], ["routing", "模型路由"], ["data", "数据与版本"], ["diagnostics", "诊断"]];
  return <div className="settings-page">
    <aside className="settings-nav"><div className="settings-nav-title"><strong>工作区设置</strong></div>{tabs.map(([key, label]) => <button key={key} data-action={`settings-tab:${key}`} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}<Icon name="chevronRight" /></button>)}<div className="settings-nav-foot"><span className={`settings-health health-${sync?.state || "offline"}`} /><span>{sync?.state === "connected" ? "ReadWeave 已连接" : "等待连接"}</span></div></aside>
    <main className="settings-main">
      <header className="settings-main-header"><div><h3>{tabs.find(([key]) => key === tab)?.[1]}</h3></div></header>
      <div className="settings-main-content">
        {tab === "general" && <SettingsSection title="工作区行为" description="这些设置会影响新导入材料和整个课程播放器"><SettingsField label="内容语言"><select value={settings.language} onChange={(event) => updateSetting("language", event.target.value as WorkspaceSettings["language"])}><option value="zh-CN">简体中文</option><option value="en">English</option></select></SettingsField><SettingsField label="默认生成质量"><select value={settings.defaultQualityMode} onChange={(event) => updateSetting("defaultQualityMode", event.target.value as WorkspaceSettings["defaultQualityMode"])}><option value="economy">经济：优先节省额度</option><option value="balanced">平衡：默认选择</option><option value="quality">质量：更长讲解和更严格评审</option></select></SettingsField><SettingsSaveButton busy={busy} onClick={saveSettings} /></SettingsSection>}
        {tab === "appearance" && <SettingsSection title="让内容更容易看清" description="字体比例保存在个人工作区，不会改变课程发布内容"><SettingsField label="界面主题"><select value={settings.theme === "system" ? theme : settings.theme} onChange={(event) => { const next = event.target.value as WorkspaceSettings["theme"]; updateSetting("theme", next); if (next !== "system") onTheme(next); }}><option value="light">亮色</option><option value="dark">暗色</option><option value="system">跟随系统</option></select></SettingsField><SettingsField label="正文大小"><select value={settings.baseFontScale} onChange={(event) => updateSetting("baseFontScale", Number(event.target.value) as WorkspaceSettings["baseFontScale"])}><option value="1">标准</option><option value="1.1">较大</option><option value="1.2">大字</option><option value="1.3">特大</option></select></SettingsField><SettingsField label="显示英文辅助标签"><input type="checkbox" checked={settings.showEnglishLabels} onChange={(event) => updateSetting("showEnglishLabels", event.target.checked)} />保留英文术语标签</SettingsField><SettingsSaveButton busy={busy} onClick={saveSettings} /></SettingsSection>}
        {tab === "learning" && <SettingsSection title="学习节奏" description="学习位置、缩放和未提交答案会在刷新后恢复"><SettingsField label="学习完成一页后自动进入下一页"><input type="checkbox" checked={settings.learningAutoAdvance} onChange={(event) => updateSetting("learningAutoAdvance", event.target.checked)} />开启自动翻页</SettingsField><div className="settings-callout"><Icon name="target" /><span>完整答案不会直接生成掌握证据，系统还需要无提示和延迟或迁移题表现</span></div><SettingsSaveButton busy={busy} onClick={saveSettings} /></SettingsSection>}
        {tab === "readweave" && <SettingsSection title="ReadWeave 权威连接" description="连接配置只保存在服务端；修改前检查新连接，密钥不会回显"><div className={`settings-connection ${sync?.state || "offline"}`}><span className="live-dot" /><div><strong>{sync?.state === "connected" ? "连接正常" : "当前无法确认连接"}</strong><span>{sync?.message || "等待 Course OS 读取连接状态"}</span></div></div><SettingsRow label="当前待写入" value={String(sync?.pendingWrites ?? 0)} /><SettingsRow label="未解决冲突" value={String(sync?.conflicts ?? 0)} />{etapi && <div className="settings-edit-grid"><SettingsField label="启用 ETAPI"><input type="checkbox" checked={etapi.enabled} onChange={(event) => setEtapi((current) => current ? { ...current, enabled: event.target.checked } : current)} /></SettingsField><SettingsField label="服务端地址"><input value={etapi.baseUrl} onChange={(event) => setEtapi((current) => current ? { ...current, baseUrl: event.target.value } : current)} /></SettingsField><SettingsField label="根笔记 ID"><input value={etapi.parentNoteId} onChange={(event) => setEtapi((current) => current ? { ...current, parentNoteId: event.target.value } : current)} /></SettingsField><SettingsField label="公开跳转地址"><input value={etapi.publicUrl} onChange={(event) => setEtapi((current) => current ? { ...current, publicUrl: event.target.value } : current)} /></SettingsField><SettingsField label="ETAPI 密钥"><input type="password" value={etapiToken} placeholder={etapi.credential.configured ? "已配置；留空不变" : "输入密钥"} onChange={(event) => setEtapiToken(event.target.value)} autoComplete="new-password" /></SettingsField><div className="settings-action-row"><button className="primary-button" disabled={busy} onClick={() => void saveEtapi()}>保存并测试连接</button><button className="quiet-button danger-button" disabled={busy} onClick={() => void deleteEtapi()}>删除 ETAPI 配置</button></div></div>}</SettingsSection>}
        {tab === "providers" && <SettingsSection title="模型供应商" description="密钥只提交给服务端加密保存，浏览器只看到配置状态和末尾四位"><div className="settings-provider-create"><input aria-label="供应商 ID" placeholder="供应商 ID" value={newProvider.id} onChange={(event) => setNewProvider((current) => ({ ...current, id: event.target.value }))} /><input aria-label="供应商名称" placeholder="名称" value={newProvider.displayName} onChange={(event) => setNewProvider((current) => ({ ...current, displayName: event.target.value }))} /><input aria-label="供应商接口地址" placeholder="https://..." value={newProvider.baseUrl} onChange={(event) => setNewProvider((current) => ({ ...current, baseUrl: event.target.value }))} /><input aria-label="模型 ID" placeholder="模型 ID" value={newProvider.modelId} onChange={(event) => setNewProvider((current) => ({ ...current, modelId: event.target.value }))} /><button className="quiet-button" disabled={busy || !newProvider.id || !newProvider.displayName || !newProvider.baseUrl || !newProvider.modelId} onClick={() => void createProvider()}>新增供应商</button></div><div className="provider-list">{providers.map((provider) => <article className="provider-card" key={provider.id}><header><div><strong>{provider.displayName}</strong><span>{provider.baseUrl || "应急路由，默认关闭"}</span></div><span className={`provider-status ${provider.credential.configured ? "configured" : "unconfigured"}`}>{provider.credential.configured ? provider.credential.maskedValue || "已配置" : "未配置"}</span></header><div className="provider-models">{provider.models.map((model) => <span key={model.id}>{model.displayName} · {model.protocol} · {model.billingMode === "subscription_quota" ? "套餐额度" : model.billingMode === "metered" ? "按量计费" : "未标记"}</span>)}</div><div className="provider-capabilities">{Array.from(new Set(provider.models.flatMap((model) => [model.supportsVision ? "图像输入" : "", model.supportsJsonSchema ? "结构化输出" : "", model.supportsReasoning ? "推理" : ""].filter(Boolean)))).map((capability) => <span key={capability}>{capability}</span>)}</div><div className="provider-config"><label><span>供应商名称</span><input value={provider.displayName} onChange={(event) => setProviders((current) => current.map((item) => item.id === provider.id ? { ...item, displayName: event.target.value } : item))} /></label><label><span>接口地址</span><input value={provider.baseUrl} disabled={provider.id === "aialra-router"} placeholder="https://..." onChange={(event) => setProviders((current) => current.map((item) => item.id === provider.id ? { ...item, baseUrl: event.target.value } : item))} /></label><label className="provider-enabled"><input type="checkbox" checked={provider.enabled} onChange={(event) => setProviders((current) => current.map((item) => item.id === provider.id ? { ...item, enabled: event.target.checked } : item))} />允许路由使用</label><button className="quiet-button" disabled={busy} onClick={() => void saveProvider(provider)}>保存配置</button></div><div className="provider-actions"><input type="password" value={secrets[provider.id] || ""} placeholder={provider.credential.configured ? "输入新密钥以替换" : "粘贴接口密钥"} onChange={(event) => setSecrets((current) => ({ ...current, [provider.id]: event.target.value }))} autoComplete="new-password" /><button className="quiet-button" disabled={busy || !secrets[provider.id]?.trim()} onClick={() => void saveSecret(provider.id)}>保存密钥</button><button className="quiet-button" disabled={busy} onClick={() => void testProvider(provider.id)}>测试连接</button></div><button className="quiet-button danger-button provider-delete" disabled={busy} onClick={() => void deleteProvider(provider.id)}>删除供应商</button>{provider.health && <p className="provider-health"><span className={`settings-health health-${provider.health.state}`} />{provider.health.message}</p>}</article>)}</div></SettingsSection>}
        {tab === "search" && <SearchSettingsSection providers={searchProviders} policy={searchPolicy} secrets={searchSecrets} available={searchAvailable} busy={busy} onProviderChange={(providerId, patch) => setSearchProviders((current) => current.map((provider) => provider.id === providerId ? { ...provider, ...patch } : provider))} onPolicyChange={setSearchPolicy} onSecretChange={(providerId, value) => setSearchSecrets((current) => ({ ...current, [providerId]: value }))} onSaveProvider={saveSearchProvider} onSaveSecret={saveSearchSecret} onTestProvider={testSearchProvider} onRuleChange={updateSearchRule} onSavePolicy={saveSearchPolicy} />}
        {tab === "routing" && <SettingsSection title="模型调用优先级" description="按顺序直连已启用线路；可新增、查看、修改、删除并保存">
          <div className="model-priority-list">{(policy.routes || []).map((route, index) => {
            const provider = providers.find((item) => item.id === route.providerId);
            return <div className="model-priority-row" key={route.providerId}>
              <span className="model-priority-rank">{index + 1}</span>
              <div className="model-priority-controls">
                <label><span>供应商</span><select value={route.providerId} disabled={busy} onChange={(event) => {
                  const nextProvider = providers.find((item) => item.id === event.target.value);
                  updateModelRoute(index, { providerId: event.target.value, modelId: nextProvider?.models[0]?.id || "" });
                }}>{providers.filter((item) => item.models.length > 0 && (item.id === route.providerId || !(policy.routes || []).some((other, otherIndex) => otherIndex !== index && other.providerId === item.id))).map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
                <label><span>模型</span><select value={route.modelId} disabled={busy} onChange={(event) => updateModelRoute(index, { modelId: event.target.value })}>{provider?.models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></label>
              </div>
              <label className="model-priority-enabled"><input type="checkbox" checked={route.enabled} disabled={busy} onChange={(event) => updateModelRoute(index, { enabled: event.target.checked })} />启用</label>
              <div className="model-priority-actions">
                <button className="icon-button" disabled={busy || index === 0} onClick={() => moveModelRoute(index, -1)} aria-label={`上移 ${provider?.displayName || route.providerId}`}>↑</button>
                <button className="icon-button" disabled={busy || index === (policy.routes?.length || 0) - 1} onClick={() => moveModelRoute(index, 1)} aria-label={`下移 ${provider?.displayName || route.providerId}`}>↓</button>
                <button className="quiet-button danger-button" disabled={busy} onClick={() => setPolicy((current) => removeModelRoute(current, index))} aria-label={`删除 ${provider?.displayName || route.providerId} 线路`}>删除</button>
              </div>
            </div>;
          })}</div>
          <button className="quiet-button settings-add-route" data-action="settings-add-model-route" disabled={busy || !canAddModelRoute} onClick={() => setPolicy((current) => addModelRoute(current, providers))}>新增线路</button>
          <label className="settings-checkbox"><input type="checkbox" checked={policy.allowProviderFallback ?? false} disabled={busy} onChange={(event) => setPolicy((current) => ({ ...current, allowProviderFallback: event.target.checked }))} />线路失败时，按顺序尝试下一条已启用线路</label>
          <div className="settings-callout"><Icon name="target" /><span>修改保存后立即用于后续模型调用；现有页面内容不受影响</span></div>
          <SettingsSaveButton busy={busy} onClick={savePolicy} />
        </SettingsSection>}
        {tab === "data" && <SettingsSection title="数据与版本" description="正式版本不可原位修改，删除默认进入 ReadWeave 回收站"><SettingsRow label="权威内容" value="ReadWeave" /><SettingsRow label="回收站记录" value={`${trashCount} 条`} /><SettingsRow label="正式发布" value="不可变，可回滚" /><SettingsRow label="原始材料" value="私有、内容寻址、去重保存" /><div className="settings-callout"><Icon name="archive" /><span>测试课程、黄金样本和旧发布版本仍用于回归，但不会混入正式课程树</span></div><button className="quiet-button button-icon-trailing settings-trash-button" data-action="settings-open-trash" onClick={onOpenTrash}>打开回收站<Icon name="arrowRight" /></button></SettingsSection>}
        {tab === "diagnostics" && <SettingsSection title="连接与诊断" description="这里显示可核对的状态，不显示密钥"><SettingsRow label="Course OS API" value="已载入当前页面" /><SettingsRow label="ReadWeave" value={sync?.state === "connected" ? "已连接" : "离线或待检查"} /><SettingsRow label="同步队列" value={`${sync?.pendingWrites ?? 0} 条待处理`} /><SettingsRow label="冲突" value={`${sync?.conflicts ?? 0} 条`} /><button className="primary-button" data-action="settings-reload" aria-describedby="settings-reload-reason" disabled={busy} onClick={() => window.location.reload()}>重新载入并重试</button><span id="settings-reload-reason" className="sr-only">{busy ? "当前有设置操作正在保存" : "重新载入页面并重新检查连接"}</span></SettingsSection>}
        {notice && <p className="settings-notice"><Icon name="check" />{notice}</p>}
        {error && <p className="settings-error"><Icon name="warning" />{error}</p>}
      </div>
    </main>
  </div>;
}

function SearchSettingsSection({
  providers,
  policy,
  secrets,
  available,
  busy,
  onProviderChange,
  onPolicyChange,
  onSecretChange,
  onSaveProvider,
  onSaveSecret,
  onTestProvider,
  onRuleChange,
  onSavePolicy
}: {
  providers: SearchProviderConfig[];
  policy: SearchRoutePolicy;
  secrets: Record<string, string>;
  available: boolean;
  busy: boolean;
  onProviderChange: (providerId: string, patch: Partial<SearchProviderConfig>) => void;
  onPolicyChange: Dispatch<SetStateAction<SearchRoutePolicy>>;
  onSecretChange: (providerId: string, value: string) => void;
  onSaveProvider: (provider: SearchProviderConfig) => Promise<void>;
  onSaveSecret: (providerId: string) => Promise<void>;
  onTestProvider: (providerId: string) => Promise<void>;
  onRuleChange: (index: number, patch: Partial<SearchRoutePolicy["rules"][number]>) => void;
  onSavePolicy: () => Promise<void>;
}) {
  const [activeAction, setActiveAction] = useState("");
  const rules = policy.rules;
  const run = async (key: string, action: () => Promise<void>) => {
    setActiveAction(key);
    try { await action(); } finally { setActiveAction(""); }
  };
  const purposeText = (purpose: NonNullable<SearchProviderConfig["purposes"]>[number]) => ({ web: "网页", academic: "学术", terminology: "术语", temporal: "时效" })[purpose];
  return <>
    <SettingsSection title="搜索供应商" description="Course OS 原生搜索设置，密钥只提交给 Course OS 服务端，搜索供应商与 ReadWeave 项目保持独立">
      {!available && <div className="settings-callout"><Icon name="warning" /><span>当前后端尚未启用搜索供应商接口，模型设置仍可正常使用。启用接口后重新打开本页即可管理搜索线路。</span></div>}
      {available && providers.length === 0 && <p className="empty-inline">暂无可配置的搜索供应商</p>}
      <div className="provider-list search-provider-list">{providers.map((provider) => {
        const actionKey = (action: string) => `${provider.id}:${action}`;
        return <article className="provider-card search-provider-card" key={provider.id}>
          <header><div><strong>{provider.displayName}</strong><span>{provider.baseUrl || "由 Course OS 服务端管理"}</span></div><span className={`provider-status ${provider.credential.configured ? "configured" : "unconfigured"}`}>{provider.credential.configured ? provider.credential.maskedValue || "已配置" : "未配置"}</span></header>
          <div className="provider-capabilities">{(provider.purposes || []).map((purpose) => <span key={`${provider.id}-${purpose}`}>{purposeText(purpose)}</span>)}</div>
          <div className="provider-config search-provider-config"><label><span>接口地址</span><input value={provider.baseUrl} placeholder="https://..." onChange={(event) => onProviderChange(provider.id, { baseUrl: event.target.value })} /></label><label><span>接口路径</span><input value={provider.endpoint || ""} placeholder="/search" onChange={(event) => onProviderChange(provider.id, { endpoint: event.target.value })} /></label><label><span>结果上限</span><input type="number" min="1" max="20" value={provider.maxResults ?? 8} onChange={(event) => onProviderChange(provider.id, { maxResults: Number(event.target.value) })} /></label><label className="provider-enabled"><input type="checkbox" checked={provider.enabled} onChange={(event) => onProviderChange(provider.id, { enabled: event.target.checked })} />允许路由使用</label><button className="quiet-button" disabled={busy} onClick={() => void run(actionKey("save"), () => onSaveProvider(provider))}>{busy && activeAction === actionKey("save") ? "保存中…" : "保存配置"}</button></div>
          <div className="provider-actions"><input type="password" value={secrets[provider.id] || ""} placeholder={provider.credential.configured ? "输入新密钥以替换" : "粘贴接口密钥"} onChange={(event) => onSecretChange(provider.id, event.target.value)} autoComplete="new-password" /><button className="quiet-button" disabled={busy || !secrets[provider.id]?.trim()} onClick={() => void run(actionKey("secret"), () => onSaveSecret(provider.id))}>{busy && activeAction === actionKey("secret") ? "保存中…" : "保存密钥"}</button><button className="quiet-button" disabled={busy} onClick={() => void run(actionKey("test"), () => onTestProvider(provider.id))}>{busy && activeAction === actionKey("test") ? "检查中…" : "测试连接"}</button></div>
          {provider.health && <p className="provider-health"><span className={`settings-health health-${provider.health.state}`} />{provider.health.message}</p>}
        </article>;
      })}</div>
    </SettingsSection>
    <SettingsSection title="搜索路由" description="只有教学规划明确发现外部证据缺口时才搜索，每页最多两项，不把搜索变成固定重步骤">
      <div className="search-route-editor">{rules.map((rule, index) => <div className="search-route-row" key={rule.kind}><strong>{({ web: "网页事实", academic: "学术来源", terminology: "正式术语", temporal: "时效信息" })[rule.kind]}</strong><label><span>主线路</span><select value={rule.providerId} onChange={(event) => onRuleChange(index, { providerId: event.target.value })}>{providers.map(provider => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}</select></label><label><span>备用线路</span><select value={rule.fallbackProviderId || ""} onChange={(event) => onRuleChange(index, { fallbackProviderId: event.target.value || undefined })}><option value="">不使用备用</option>{providers.filter(provider => provider.id !== rule.providerId).map(provider => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}</select></label><label className="provider-enabled"><input type="checkbox" checked={rule.enabled} onChange={(event) => onRuleChange(index, { enabled: event.target.checked })} />启用</label></div>)}</div>
      <label className="settings-checkbox"><input type="checkbox" checked={policy.allowProviderFallback ?? false} onChange={(event) => onPolicyChange(current => ({ ...current, allowProviderFallback: event.target.checked }))} />主线路没有结果或失败时允许使用显式备用线路</label>
      <label className="settings-field"><span>每次搜索结果上限</span><input type="number" min="1" max="20" value={policy.maxResults ?? 8} onChange={(event) => onPolicyChange(current => ({ ...current, maxResults: Number(event.target.value) }))} /></label>
      <button className="primary-button settings-save" disabled={busy || !available} onClick={() => void run("search-policy", onSavePolicy)}>{busy && activeAction === "search-policy" ? "保存中…" : "保存搜索路由"}</button>
    </SettingsSection>
  </>;
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { return <section className="settings-section"><div className="settings-section-heading"><h4>{title}</h4><p>{description}</p></div>{children}</section>; }
function SettingsField({ label, children }: { label: string; children: React.ReactNode }) { return <label className="settings-field"><span>{label}</span>{children}</label>; }
function SettingsRow({ label, value }: { label: string; value: string }) { return <div className="settings-row"><span>{label}</span><strong>{value}</strong></div>; }
function SettingsSaveButton({ busy, onClick }: { busy: boolean; onClick: () => void }) { return <><button className="primary-button settings-save" data-action="settings-save" aria-describedby="settings-save-reason" disabled={busy} onClick={onClick}>{busy ? "保存中" : "保存设置"}</button><span id="settings-save-reason" className="sr-only">{busy ? "正在保存工作区设置" : "保存当前设置到 Course OS"}</span></>; }

function WorkspaceLoader({ compact = false }: { compact?: boolean }) {
  return <div className={`workspace-loader ${compact ? "compact" : ""}`}><div className="loader" /><span>正在准备课程工具</span></div>;
}

export function StartupReadNotices({ releaseIndexError, releaseIndexLoading, onRetryReleaseIndex, treeError, treeLoading, onRetryTree }: {
  releaseIndexError: string;
  releaseIndexLoading: boolean;
  onRetryReleaseIndex: () => void;
  treeError: string;
  treeLoading: boolean;
  onRetryTree: () => void;
}) {
  const notice = (key: string, label: string, error: string, loading: boolean, actionId: string, onRetry: () => void) => {
    if (!error && !loading) return null;
    return <div key={key} className="empty-inline" role={error ? "alert" : "status"} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <span>{error ? `${label}读取失败：${error}` : `正在读取${label}`}</span>
      {error && <button className="quiet-button" type="button" data-action={actionId} disabled={loading} onClick={onRetry}>{loading ? "正在重试" : "重试"}</button>}
    </div>;
  };

  const notices = [
    notice("release-index", "课程索引", releaseIndexError, releaseIndexLoading, "release-index-retry", onRetryReleaseIndex),
    notice("workspace-tree", "课程目录", treeError, treeLoading, "workspace-tree-retry", onRetryTree)
  ].filter(Boolean);
  if (notices.length === 0) return null;

  return <div className="app-toast" data-testid="startup-read-notices" aria-label="启动读取状态" style={{ top: "calc(var(--topbar) + 12px)", bottom: "auto" }}>{notices}</div>;
}

function ImportDialog({ courses, releases, parentNodeId, onClose, onSubmitted }: { courses: WorkspaceTree["courses"]; releases: CourseRelease[]; parentNodeId?: string; onClose: () => void; onSubmitted: (record: ImportRecord) => void }) {
  const [file, setFile] = useState<File>();
  const [courseId, setCourseId] = useState(courses.find(course => course.id === parentNodeId)?.id || "");
  const [previousMaterialVersionId, setPreviousMaterialVersionId] = useState("");
  const [qualityMode, setQualityMode] = useState(localStorage.getItem("course-os-budget") || "balanced");
  const [language, setLanguage] = useState(localStorage.getItem("course-os-language") || "zh-CN");
  const [autoGenerate, setAutoGenerate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const updateSources = sourceReleasesForCourse(releases, courseId, courses);
  const [uploadStatus, setUploadStatus] = useState("");
  const submitting = useRef(false);
  const [pdfLayout, setPdfLayout] = useState<import("@course-os/contracts").PdfLayoutSelection>({ mode: "auto" });
  const [pdfInspection, setPdfInspection] = useState<import("@course-os/contracts").PdfLayoutInspection>();
  const [inspectingPdf, setInspectingPdf] = useState(false);
  const [inspectionError, setInspectionError] = useState("");
  const isPdf = Boolean(file && /\.pdf$/i.test(file.name));
  useEffect(() => {
    let current = true;
    setPdfInspection(undefined);
    setInspectionError("");
    if (!file || !/\.pdf$/i.test(file.name)) { setInspectingPdf(false); return; }
    setInspectingPdf(true);
    void api.inspectPdf(file, pdfLayout).then(value => { if (current) setPdfInspection(value); },
      reason => { if (current) setInspectionError(reason instanceof Error ? reason.message : "无法检查 PDF"); })
      .finally(() => { if (current) setInspectingPdf(false); });
    return () => { current = false; };
  }, [file, pdfLayout]);
  const upload = async () => {
    if (!file || submitting.current || (isPdf && (inspectingPdf || !pdfInspection))) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    const signature = JSON.stringify([file.name, file.size, file.lastModified, courseId, previousMaterialVersionId, qualityMode, language, autoGenerate, parentNodeId, pdfInspection?.fingerprint]);
    const storageKey = `course-os-import-operation:${signature}`;
    const savedKey = localStorage.getItem(storageKey);
    const operationKey = savedKey || crypto.randomUUID();
    localStorage.setItem(storageKey, operationKey);
    try {
      if (savedKey) {
        setUploadStatus("正在恢复同次导入");
        try {
          const accepted = await api.recoverImport(operationKey);
          localStorage.removeItem(storageKey);
          onSubmitted(accepted);
          return;
        } catch (reason) {
          if (!(reason instanceof ApiRequestError) || reason.status !== 404) throw reason;
        }
      }
      setUploadStatus("正在上传文件");
      const imported = await api.importMaterial(file, courseId || undefined, { qualityMode, language, parentNodeId, autoGenerate, pdfLayout: isPdf ? pdfLayout : undefined, previousMaterialVersionId: previousMaterialVersionId || undefined, operationKey,
        onUpload: (sent, total) => setUploadStatus(total ? `正在上传 ${Math.floor(sent / total * 100)}%` : "正在上传文件"),
        onUploaded: () => setUploadStatus("上传完成，等待文件检查与接单") });
      localStorage.removeItem(storageKey);
      onSubmitted(imported);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "材料导入失败"); }
    finally { setBusy(false); submitting.current = false; }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <header><div><span className="section-kicker">NEW MATERIAL</span><h2 id="import-title">导入课程材料</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><span aria-hidden="true">×</span></button></header>
      <>
        <label className={`drop-zone ${file ? "has-file" : ""}`}>
          <input type="file" accept=".pptx,.pdf,.md,.txt" disabled={busy} onChange={(event) => { setPdfInspection(undefined); setInspectionError(""); setPdfLayout({ mode: "auto" }); setFile(event.target.files?.[0]); }} />
          <span className="drop-icon"><Icon name={file ? "check" : "upload"} /></span>
          <strong>{file ? file.name : "选择 PPTX、PDF 或 syllabus"}</strong>
          <p>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB · 将先执行安全检查` : "原始材料保持私有，上传后先隔离检查再进入解析"}</p>
          <span className="file-types">PPTX · PDF · MD · TXT</span>
        </label>
        {isPdf && <PdfLayoutPreview inspection={pdfInspection} selection={pdfLayout} busy={inspectingPdf || busy} error={inspectionError} onChange={setPdfLayout} />}
        <div className="import-options"><label><span>目标课程</span><select value={courseId} onChange={(event) => { setCourseId(event.target.value); setPreviousMaterialVersionId(""); }}><option value="">暂不归类</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label><label><span>更新现有材料</span><select value={previousMaterialVersionId} disabled={!courseId || updateSources.length === 0} onChange={(event) => setPreviousMaterialVersionId(event.target.value)}><option value="">作为新材料导入</option>{updateSources.map((release) => <option key={release.id} value={release.id}>{release.moduleTitle} · 草稿 · {release.pages.length} 页</option>)}</select></label><label><span>生成质量</span><select value={qualityMode} onChange={(event) => setQualityMode(event.target.value)}><option value="economy">经济</option><option value="balanced">平衡</option><option value="quality">质量</option></select></label><label><span>内容语言</span><select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="zh-CN">简体中文</option><option value="en">English</option></select></label></div>
        <label className="import-auto-generate"><input type="checkbox" checked={autoGenerate} onChange={(event) => setAutoGenerate(event.target.checked)} /><span><strong>导入后自动生成整套讲解</strong><small>默认开启，只写入候选草稿，不会自动发布正式课程</small></span></label>
        {error && <p className="dialog-error"><Icon name="warning" />{error}</p>}
        {busy && <p role="status">{uploadStatus} · 关闭窗口不会取消已提交的导入</p>}
        <footer><button className="quiet-button" onClick={onClose}>{busy ? "关闭窗口" : "取消"}</button><button className="primary-button" disabled={!file || busy || (isPdf && (inspectingPdf || !pdfInspection))} onClick={upload}><Icon name="sparkles" />{busy ? uploadStatus : "确认方案并导入"}</button></footer>
      </>
    </section>
  </div>;
}

export function beginImportCostRead<T>(inFlight: Map<string, Promise<unknown>>, key: string, read: () => Promise<T>, isCurrent: () => boolean, onSuccess: (value: T) => void, onFailure: () => void): void {
  if (inFlight.has(key)) return;
  const pending = Promise.resolve().then(read);
  inFlight.set(key, pending);
  void pending.then(
    (value) => { if (isCurrent()) onSuccess(value); },
    () => { if (isCurrent()) onFailure(); }
  ).finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key); });
}

function ImportActivityDock({ importId, taskTitle, onReady, onProgress, onClose, onOpen }: { importId: string; taskTitle?: string; onReady: (record: ImportRecord) => void; onProgress: () => void; onClose: () => void; onOpen: (record: ImportRecord, mode?: "learn" | "studio") => void }) {
  const [record, setRecord] = useState<WebImportRecord>();
  const [plan, setPlan] = useState<WebGenerationPlan>();
  const [activeJobs, setActiveJobs] = useState<GenerationJob[]>([]);
  const [costs, setCosts] = useState<GenerationCostEntry[]>([]);
  const [costReadUnavailable, setCostReadUnavailable] = useState(false);
  const [error, setError] = useState("");
  const [retryingFailed, setRetryingFailed] = useState(false);
  const [retryError, setRetryError] = useState("");
  const readyNotified = useRef(false);
  const progressRef = useRef(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    let activeCostKey: string | undefined;
    const costReadsInFlight = new Map<string, Promise<unknown>>();
    const readCosts = (key: string, read: () => Promise<{ entries: GenerationCostEntry[] }>) => {
      activeCostKey = key;
      beginImportCostRead(costReadsInFlight, key, read, () => !cancelled && activeCostKey === key,
        (result) => { setCosts(result.entries); setCostReadUnavailable(false); },
        () => setCostReadUnavailable(true));
    };
    const refresh = async () => {
      if (refreshing || cancelled) return;
      refreshing = true;
      window.clearTimeout(timer);
      let polling: ReturnType<typeof getImportTaskPollingMode> = "active";
      try {
        const updated = await api.importRecord(importId);
        if (cancelled) return;
        setRecord(updated);
        setError("");
        if (updated.state === "ready" && !readyNotified.current) {
          readyNotified.current = true;
          onReady(updated);
        }
        const standaloneJobId = standaloneGenerationJobId(importId);
        if (standaloneJobId) {
          readCosts(`job:${standaloneJobId}`, () => api.costs({ jobId: standaloneJobId }));
          const job = await api.generationJob(standaloneJobId);
          if (cancelled) return;
          setRecord({
            ...updated,
            generationState: job.state,
            generationCompletedPageIds: job.completedPageIds,
            generationFailedPageIds: job.failedPageIds,
            generationActivity: job.latestStageActivity,
            attemptStartedAt: job.attemptStartedAt,
            endedAt: job.endedAt,
            updatedAt: job.updatedAt
          });
          setPlan(undefined);
          setActiveJobs(["queued", "running", "pending_sync"].includes(job.state) ? [job] : []);
          polling = getImportTaskPollingMode({ ...updated, generationState: job.state }, undefined, [job]);
          const processed = job.completedPageIds.length + job.failedPageIds.length;
          if (processed > progressRef.current) {
            progressRef.current = processed;
            onProgress();
          }
        } else if (updated.generationPlanId) {
          if (updated.materialVersionId) readCosts(`material:${updated.materialVersionId}`, () => api.costs({ materialVersionId: updated.materialVersionId! }));
          else activeCostKey = undefined;
          const planResult = await api.generationPlan(updated.generationPlanId);
          if (cancelled) return;
          setPlan(planResult.plan);
          setActiveJobs(planResult.activeJobs ?? (planResult.currentJob && ["queued", "running", "pending_sync"].includes(planResult.currentJob.state) ? [planResult.currentJob] : []));
          polling = getImportTaskPollingMode(updated, planResult.plan, planResult.activeJobs ?? []);
          const processed = planResult.plan.completedPageIds.length + planResult.plan.failedPageIds.length;
          if (processed > progressRef.current) {
            progressRef.current = processed;
            onProgress();
          }
        } else {
          activeCostKey = undefined;
          setPlan(undefined);
          setActiveJobs([]);
          setCosts([]);
          setCostReadUnavailable(false);
          polling = getImportTaskPollingMode(updated);
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取后台任务进度");
      } finally {
        refreshing = false;
        if (!cancelled && polling !== "stopped") timer = window.setTimeout(() => void refresh(), polling === "idle" ? 60_000 : 2000);
      }
    };
    let refreshing = false;
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    void refresh();
    return () => { cancelled = true; window.clearTimeout(timer); window.removeEventListener("focus", onFocus); };
  }, [importId, refreshNonce]);
  if (!record) return <section className="import-task-workspace" role="status"><header className="import-task-page-header"><div><span className="section-kicker">后台任务</span><h2>正在恢复任务状态</h2></div><button className="quiet-button" onClick={onClose}>返回课程</button></header><div className="import-activity-loading"><span className="loader" /><span>{error || "正在读取已保存的任务状态"}</span></div></section>;
  const retryFailed = async () => {
    if (!plan || retryingFailed || plan.state !== "failed" || plan.failedPageIds.length === 0) return;
    setRetryingFailed(true);
    setRetryError("");
    try {
      const result = await api.retryGenerationPlanFailed(plan.id);
      setPlan(result.plan);
      setActiveJobs(result.jobs.filter((job) => ["queued", "running", "pending_sync"].includes(job.state)));
      progressRef.current = result.plan.completedPageIds.length + result.plan.failedPageIds.length;
      onProgress();
      setRefreshNonce(value => value + 1);
    } catch (reason) {
      setRetryError(reason instanceof Error ? reason.message : "重试失败页面失败");
    } finally {
      setRetryingFailed(false);
    }
  };
  return <ImportProgress record={record} taskTitle={taskTitle} plan={plan} activeJobs={activeJobs} costs={costs} costReadUnavailable={costReadUnavailable} error={error || retryError} retryingFailed={retryingFailed} onRetryFailed={() => void retryFailed()} onClose={onClose} onOpen={() => onOpen(record)} onGenerate={() => onOpen(record, "studio")} />;
}

function ImportProgress({ record, taskTitle, plan, activeJobs, costs, costReadUnavailable, error, retryingFailed, onRetryFailed, onClose, onOpen, onGenerate }: { record: WebImportRecord; taskTitle?: string; plan?: WebGenerationPlan; activeJobs: GenerationJob[]; costs: GenerationCostEntry[]; costReadUnavailable: boolean; error?: string; retryingFailed: boolean; onRetryFailed: () => void; onClose: () => void; onOpen: () => void; onGenerate: () => void }) {
  const importInfo = importStatus(record.state);
  const auto = record.autoGenerate !== false;
  const planState = plan?.state;
  const taskState = getImportTaskState(record, plan, activeJobs);
  const terminalJob = !auto || Boolean(planState && ["awaiting_review", "completed", "failed", "cancelled"].includes(planState));
  const taskFinished = ["completed", "failed", "cancelled", "paused", "awaiting_review"].includes(taskState);
  const finished = ["failed", "rejected"].includes(record.state) || (record.state === "ready" && (terminalJob || taskFinished));
  const summary = summarizeImportProgress(record, plan, activeJobs, costs);
  const taskStatus = getImportTaskStatus(record, plan, activeJobs, retryingFailed);
  const timing = getImportTaskTiming(record, plan, activeJobs);
  const activity = getImportActivity(record, plan, activeJobs, costs);
  const awaitingPlanDetails = auto && Boolean(record.generationPlanId) && !plan;
  const failed = plan?.failedPageIds.length ?? record.generationFailedPageIds?.length ?? 0;
  const progress = activity.progressPercent;
  const failedState = record.state === "failed" || record.state === "rejected" || planState === "failed" || taskState === "failed";
  const cancelledState = planState === "cancelled" || taskState === "cancelled";
  const statusTitle = record.state !== "ready" ? importInfo.title : taskStatus.fact;
  const currentPages = activeJobs.map((job) => {
    const sourceIndex = record.pageIds?.indexOf(job.pageIds[0] ?? "") ?? -1;
    return sourceIndex >= 0 ? sourceIndex + 1 : (job.batchIndex ?? 0) + 1;
  }).sort((a, b) => a - b);
  const stageCount = record.state === "processing" ? ` · 页面 ${formatProgressCount(summary.conversion)}`
    : plan ? ` · 正文 ${formatProgressCount(summary.core)} · 跨页承接 ${formatProgressCount(summary.crossPage)}`
      : record.generationJobId ? ` · 页面 ${formatProgressCount(summary.core)}` : "";
  const activeDetail = activeJobs.length
    ? plan ? ` · 并行处理 ${activeJobs.length} 页${currentPages.length ? `（第 ${currentPages.join("、")} 页）` : ""}` : " · 当前生成任务运行中"
    : "";
  const currentStage = `${activity.stage}${activity.stageCode ? `（${activity.stageCode}）` : ""}${activity.phase ? ` · ${activity.phase}` : ""}`;
  const recordedModelStage = activity.phaseStatus
    ? activity.phaseStatus === "started" ? "模型调用进行中" : "模型已响应"
    : activity.stageStatus === "started" && ["teach", "repair", "semantic_audit"].includes(activity.stageCode || "") ? "模型阶段已开始"
      : activity.stageStatus === "completed" && ["teach", "repair", "semantic_audit"].includes(activity.stageCode || "") ? "模型阶段已完成"
        : "尚未调用模型";
  const statusDetail = record.state !== "ready" ? `${currentStage}${stageCount}` : !auto ? "已按你的选择跳过自动生成" : retryingFailed ? "失败页面正在重新排队" : awaitingPlanDetails ? "正在读取生成进度" : `${currentStage}${stageCount}${activeDetail}`;
  const indeterminate = progress === undefined && (activity.busy || awaitingPlanDetails) && (!activity.stale || awaitingPlanDetails);
  const canRetryFailed = planState === "failed" && failed > 0 && !retryingFailed;
  const providerModel = summary.provider && summary.model ? `${summary.provider} / ${summary.model}` : summary.provider || summary.model
    || (awaitingPlanDetails ? "正在读取模型记录" : taskFinished ? "模型记录暂不可用" : recordedModelStage);
  const concurrency = summary.concurrency?.running !== undefined && summary.concurrency.limit !== undefined
    ? `${summary.concurrency.running}/${summary.concurrency.limit}`
    : summary.concurrency?.running !== undefined
      ? String(summary.concurrency.running)
      : summary.concurrency?.limit !== undefined
        ? `—/${summary.concurrency.limit}`
        : "—";
  const confirmedCost = summary.costUsd === undefined ? undefined : `$${summary.costUsd.toFixed(4)}${summary.costBasis ? `（${summary.costBasis === "reported" ? "供应商回报" : summary.costBasis === "estimated" ? "价格估算" : "混合核算"}）` : ""}`;
  const cost = costReadUnavailable ? confirmedCost ? `${confirmedCost}（成本暂不可读，显示上次确认值）` : "成本暂不可读" : confirmedCost ?? (awaitingPlanDetails ? "正在读取成本记录" : activity.busy ? "生成中，完成页面后结算" : "成本记录暂不可用");
  const progressLabel = failedState ? "生成失败" : cancelledState ? "已取消" : awaitingPlanDetails ? "正在读取任务进度"
    : progress === undefined ? activity.stale ? "状态待确认" : activity.busy ? "处理中" : "—"
      : `${progressScopeLabel(activity.progressScope)}${progress}%${activity.overall ? ` · ${activity.overall.completed}/${activity.overall.total}` : ""}`;
  const progressDescription = progress === undefined
    ? `${activity.stage}，${failedState ? `${failed} 页失败` : awaitingPlanDetails ? "正在读取任务进度" : activity.stale ? "状态长时间未更新" : "进度百分比暂不可核对"}`
    : `${activity.progressScope || activity.stage} ${progress}%`;
  return <section className={`import-task-workspace import-state-${record.state} ${activity.stale && !awaitingPlanDetails ? "task-stale" : ""}`} aria-live="polite">
    <header className="import-task-page-header"><div><span className="section-kicker">后台任务</span><h2>{statusTitle}</h2></div><button className="quiet-button" data-action="close-import-task" onClick={onClose}>返回课程</button></header>
    <p className="import-activity-file">{taskTitle || record.originalName}</p>
    <div className={`import-progress ${indeterminate ? "is-indeterminate" : ""} ${activity.stale && !awaitingPlanDetails ? "is-stale" : ""} ${failedState ? "is-failed" : ""}`} role="progressbar" aria-label={`${activity.progressScope || activity.stage}阶段进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={progressDescription}><i style={progress === undefined ? undefined : { width: `${progress}%` }} /></div>
    <div className="import-progress-label"><strong>{progressLabel}</strong><span>{statusDetail}<small>{awaitingPlanDetails ? "正在获取最新任务状态" : activity.stale ? "已超过 2 分钟没有可核对的工作进展；连接或心跳不代表工作完成" : `最近工作进展：${formatActivityAge(activity.ageSeconds)}`}</small><small>{timing.label}</small></span></div>
    <dl><div><dt>当前阶段</dt><dd>{currentStage}</dd></div><div><dt>最后工作进展</dt><dd>{formatActivityAge(activity.ageSeconds)}</dd></div><div><dt>转换页面</dt><dd>{formatProgressCount(summary.conversion)}</dd></div><div><dt>正文核心完成</dt><dd>{auto ? formatProgressCount(summary.core) : "未启用"}</dd></div><div><dt>跨页承接完成</dt><dd>{auto ? formatProgressCount(summary.crossPage) : "未启用"}</dd></div><div><dt>失败页面</dt><dd>{failed}</dd></div></dl>
    <details className="task-technical-details"><summary><Icon name="chevronDown" />运行详情</summary><dl><div><dt>修复数</dt><dd>{summary.repairCount ?? "—"}</dd></div><div><dt>运行并发</dt><dd>{concurrency}</dd></div><div><dt>供应商 / 模型</dt><dd>{providerModel}</dd></div><div><dt>累计成本</dt><dd>{cost}</dd></div></dl></details>
    {Array.isArray(plan?.failureReasons) && plan.failureReasons.length > 0 && <p className="dialog-error" role="alert"><Icon name="warning" />{plan.failureReasons.filter((reason): reason is string => typeof reason === "string").join(" · ")}</p>}
    {(error || record.issues.length > 0) && <p className="dialog-error"><Icon name="warning" />{error || record.issues.join(" · ")}</p>}
    <footer><span>{finished ? failedState ? "任务已结束，可查看失败页面" : cancelledState ? "任务已取消" : taskState === "awaiting_review" ? taskStatus.fact : taskState === "paused" ? "任务已暂停" : !auto || record.generationState === "not_requested" ? "材料导入完成，尚未生成讲解" : "任务已完成" : "离开此页不会停止任务，刷新后仍可从课程树恢复"}</span>{taskStatus.action === "open_draft" && <button className="primary-button" data-action="open-task-lesson" onClick={onOpen}>打开讲解</button>}{taskStatus.action === "generate" && <button className="primary-button" data-action="open-task-generation" onClick={onGenerate}>打开材料与生成工具</button>}{canRetryFailed && <button className="primary-button" data-action="retry-failed-pages" onClick={onRetryFailed}>重试失败页面</button>}{retryingFailed && <button className="primary-button" data-action="retry-failed-pages" disabled>正在重试失败页面</button>}</footer>
  </section>;
}

function progressScopeLabel(scope?: string): string { return scope && scope !== "整体流程" ? `${scope} ` : ""; }

function importStatus(state: ImportRecord["state"]): { title: string; detail: string } {
  if (state === "accepted" || state === "quarantined") return { title: "材料已进入处理队列", detail: "文件检查已完成，等待转换器领取" };
  if (state === "processing") return { title: "正在转换材料", detail: "正在等待转换页面计数更新" };
  if (state === "syncing") return { title: "正在保存课程材料", detail: "正在等待 ReadWeave 写入状态更新" };
  if (state === "ready") return { title: "材料已导入", detail: "材料可以打开学习或继续生成讲解" };
  return { title: "材料处理已停止", detail: "请查看错误信息后重试" };
}

function CreateCourseDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api.createCourse(title.trim(), description.trim() || undefined);
      await onCreated();
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "课程创建失败"); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="import-dialog compact-dialog" role="dialog" aria-modal="true" aria-labelledby="create-course-title">
      <header><div><span className="section-kicker">NEW COURSE</span><h2 id="create-course-title">建立课程项目</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><span aria-hidden="true">×</span></button></header>
      <div className="dialog-form"><label><span>课程名称</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如 数字系统设计" /></label><label><span>课程说明</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="课程目标、适用对象或材料范围" rows={4} /></label></div>
      <p className="dialog-hint"><Icon name="book" />创建后会同时在 ReadWeave 建立课程知识树</p>
      {error && <p className="dialog-error"><Icon name="warning" />{error}</p>}
      <footer><button className="quiet-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!title.trim() || busy} onClick={create}>{busy ? "正在建立" : "建立课程"}</button></footer>
    </section>
  </div>;
}

function TreeTextDialog({ action, onClose, onSubmit }: { action: TreeTextAction; onClose: () => void; onSubmit: (title: string) => void }) {
  const [title, setTitle] = useState(action.kind === "rename" ? action.node.title : "");
  const heading = action.kind === "rename" ? `重命名“${action.node.title}”` : "新建课程模块";
  const submit = () => {
    const value = title.trim();
    if (value) onSubmit(value);
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="import-dialog compact-dialog tree-text-dialog" role="dialog" aria-modal="true" aria-labelledby="tree-text-title">
      <header><div><span className="section-kicker">COURSE TREE</span><h2 id="tree-text-title">{heading}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><span aria-hidden="true">×</span></button></header>
      <div className="dialog-form"><label><span>{action.kind === "rename" ? "新名称" : "模块名称"}</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); }} placeholder={action.kind === "rename" ? "输入新的名称" : "例如 第一章：基础概念"} /></label><p className="dialog-hint"><Icon name="edit" />发布版本保持不可变，修改只会写入新的树节点或草稿</p></div>
      <footer><button className="quiet-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!title.trim()} onClick={submit}>{action.kind === "rename" ? "保存名称" : "建立模块"}</button></footer>
    </section>
  </div>;
}

function MoveNodeDialog({ node, tree, onClose, onMove }: { node: CourseTreeNode; tree?: WorkspaceTree; onClose: () => void; onMove: (parentId: string | null) => void }) {
  const [parentId, setParentId] = useState(node.parentId ?? "");
  const descendants = useMemo(() => new Set(collectNodeIds(node)), [node]);
  const allowedKinds = node.kind === "course" ? [] : node.kind === "material" ? ["course"] : ["course", "material"];
  const targets = flattenTree(tree?.courses ?? []).filter(({ node: candidate }) => !descendants.has(candidate.id) && allowedKinds.includes(candidate.kind));
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="import-dialog compact-dialog move-dialog" role="dialog" aria-modal="true" aria-labelledby="move-node-title">
      <header><div><span className="section-kicker">MOVE ITEM</span><h2 id="move-node-title">移动“{node.title}”</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><span aria-hidden="true">×</span></button></header>
      <div className="dialog-form"><label><span>目标位置</span><select value={parentId} onChange={(event) => setParentId(event.target.value)}><option value="">课程根目录</option>{targets.map(({ node: target, depth }) => <option key={target.id} value={target.id}>{`${"　".repeat(depth)}${target.title}`}</option>)}</select></label><p className="dialog-hint"><Icon name="move" />移动只改变课程树位置，不会修改已发布内容</p></div>
      <footer><button className="quiet-button" onClick={onClose}>取消</button><button className="primary-button" onClick={() => onMove(parentId || null)}>确认移动</button></footer>
    </section>
  </div>;
}

export type TrashCapabilities = Awaited<ReturnType<typeof api.trashCapabilities>>;

export function latestRestorableTrashRecords(records: readonly TrashRecord[]): TrashRecord[] {
  const latestByNode = new Map<string, TrashRecord>();
  for (const record of records) {
    if (!record.restoreAvailable) continue;
    const key = `${record.workspaceId}\u0000${record.nodeId}`;
    const current = latestByNode.get(key);
    if (!current || record.deletedAt > current.deletedAt || (record.deletedAt === current.deletedAt && record.id > current.id)) {
      latestByNode.set(key, record);
    }
  }
  return [...latestByNode.values()]
    .sort((left, right) => right.deletedAt.localeCompare(left.deletedAt) || left.id.localeCompare(right.id));
}

export function canDirectlyDeleteTrashRecord(
  capabilities: TrashCapabilities | undefined,
  record: Pick<TrashRecord, "readweaveNoteId">
): boolean {
  return capabilities?.directPermanentDelete === true
    && capabilities.requiresNativeUi === false
    && Boolean(record.readweaveNoteId);
}

export function canDirectlyDeleteTrashRecords(
  capabilities: TrashCapabilities | undefined,
  records: readonly TrashRecord[]
): boolean {
  return records.length > 0 && records.every((record) => canDirectlyDeleteTrashRecord(capabilities, record));
}

function TrashPanel({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [items, setItems] = useState<TrashRecord[]>([]);
  const [capabilities, setCapabilities] = useState<TrashCapabilities>();
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(true);
  const [capabilityError, setCapabilityError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const visibleItems = useMemo(() => latestRestorableTrashRecords(items), [items]);
  const directDeleteAvailable = capabilities?.directPermanentDelete === true && capabilities.requiresNativeUi === false;
  const nativeUiRequired = capabilities?.requiresNativeUi === true;
  const canEmptyTrash = canDirectlyDeleteTrashRecords(capabilities, visibleItems);

  const load = async (): Promise<TrashRecord[] | undefined> => {
    setError("");
    try {
      const records = await api.trash();
      setItems(records);
      return records;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "回收站读取失败");
      return undefined;
    }
  };
  const loadCapabilities = async () => {
    setCapabilities(undefined);
    setCapabilitiesLoading(true);
    setCapabilityError("");
    try {
      const result = await api.trashCapabilities();
      if (typeof result.directPermanentDelete !== "boolean" || typeof result.requiresNativeUi !== "boolean") {
        throw new Error("永久删除能力响应格式无效");
      }
      setCapabilities(result);
    } catch (reason) {
      setCapabilityError(reason instanceof Error ? reason.message : "无法读取永久删除能力");
    } finally {
      setCapabilitiesLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => { void loadCapabilities(); }, []);
  const reload = () => { void load(); void loadCapabilities(); };
  const restore = async (item: TrashRecord, restoreMode: "original" | "root") => {
    setBusyId(item.id); setError(""); setNotice("");
    try {
      await api.restoreTrash(item, restoreMode);
      const refreshedRecords = await load();
      await onRefresh();
      setNotice(refreshedRecords
        ? restoreMode === "original" ? "项目已恢复到原路径，并已重新读取回收站" : "项目已恢复到工作区根目录，并已重新读取回收站"
        : "恢复请求已完成，但回收站重新读取失败；请重新载入核对");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "项目恢复失败"); }
    finally { setBusyId(""); }
  };
  const permanentlyDelete = async (item: TrashRecord) => {
    if (busyId || !canDirectlyDeleteTrashRecord(capabilities, item)) return;
    if (!window.confirm(`确认通过当前适配器直接永久删除“${item.title}”吗？此操作无法撤回。`)) return;
    setBusyId(item.id); setError(""); setNotice("");
    try {
      await api.permanentlyDeleteTrash(item);
      const refreshedRecords = await load();
      await onRefresh();
      const remainsRestorable = refreshedRecords && latestRestorableTrashRecords(refreshedRecords)
        .some((record) => record.workspaceId === item.workspaceId && record.nodeId === item.nodeId);
      setNotice(refreshedRecords
        ? remainsRestorable
          ? "直接删除请求返回成功，但该对象仍出现在最新可恢复列表中；请先核对状态，不要重复操作。"
          : "适配器直接删除请求返回成功；Course OS 已重新读取最新可恢复列表。"
        : "直接删除请求返回成功，但回收站重新读取失败；请重新载入核对当前状态。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "永久删除结果尚未确认，请重新读取回收站"); }
    finally { setBusyId(""); }
  };
  const emptyTrash = async () => {
    if (busyId || !canEmptyTrash || !window.confirm(`确认向当前适配器直接永久删除这 ${visibleItems.length} 条最新可恢复记录？操作无法撤回；取消不会删除任何内容。`)) return;
    setBusyId("empty-trash"); setError(""); setNotice("");
    try {
      const receipt = await api.emptyTrash(visibleItems, crypto.randomUUID());
      const refreshedRecords = await load();
      await onRefresh();
      const readback = refreshedRecords ? "最新可恢复列表已重新读取" : "回收站重新读取失败，请重新载入核对";
      setNotice(`适配器回执：直接删除 ${receipt.cleared.length} 条，跳过 ${receipt.skipped.length} 条，失败 ${receipt.failed.length} 条；${readback}${[...receipt.skipped, ...receipt.failed].map((entry) => ` · ${entry.reason}`).join("")}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "直接删除结果尚未确认，请重新读取回收站"); }
    finally { setBusyId(""); }
  };
  const openNativeReadWeaveNote = async (item: TrashRecord) => {
    if (busyId || !nativeUiRequired || !item.readweaveNoteId) return;
    const actionId = `open-readweave:${item.id}`;
    setBusyId(actionId); setError(""); setNotice("");
    try {
      await openVerifiedReadWeaveDeepLink(item.readweaveNoteId);
      setNotice("已打开经过验证的 ReadWeave 笔记链接。请在 ReadWeave 原生回收站登录并核对对象；Course OS 未执行删除。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法打开经过验证的 ReadWeave 笔记链接"); }
    finally { setBusyId(""); }
  };

  const capabilityMessage = capabilitiesLoading
    ? "正在单独检查永久删除能力；检查完成前，直接删除和清空操作均已停用。"
    : capabilityError
      ? `无法确认当前适配器的永久删除能力，直接删除和清空操作已停用。${capabilityError}`
      : nativeUiRequired
        ? "永久删除必须在 ReadWeave 原生回收站中完成。请使用 ReadWeave 登录状态核对并确认；Course OS 只会打开经过验证的笔记链接，不会执行删除。"
        : directDeleteAvailable
          ? "当前适配器报告支持直接永久删除。操作只会对下方最新可恢复记录开放，并要求存在 ReadWeave 笔记 ID。"
          : `当前适配器未报告可用的直接永久删除能力，相关操作已停用。${capabilities?.reason || ""}`;

  return <div className="utility-content trash-panel">
    <div className="trash-intro"><div><strong>回收站</strong><p>移入回收站不会立即删除对象。下方仅显示每个对象最近一次可恢复记录；历史重复项和不可恢复记录不计入操作数量。</p></div><div className="trash-actions"><button className="quiet-button" onClick={reload} disabled={Boolean(busyId)}>重新载入</button><button className="quiet-button danger-button" data-action="empty-trash" onClick={() => void emptyTrash()} disabled={Boolean(busyId) || !canEmptyTrash} title={!directDeleteAvailable ? capabilityMessage : visibleItems.some((item) => !item.readweaveNoteId) ? "至少一项缺少 ReadWeave 笔记 ID，无法安全执行批量永久删除" : undefined}>清空回收站（{visibleItems.length}）</button></div></div>
    <p className={`trash-capability ${capabilityError ? "is-error" : ""}`} role={capabilityError ? "alert" : "status"} aria-live="polite">{capabilityMessage}</p>
    <div className="trash-list">{visibleItems.map((item) => {
      const canRestoreOriginal = Boolean(item.originalParentId || item.originalPath?.length);
      const canDelete = canDirectlyDeleteTrashRecord(capabilities, item);
      const actionIsBusy = busyId === item.id;
      const nativeLinkIsBusy = busyId === `open-readweave:${item.id}`;
      return <article className="trash-item" key={`${item.workspaceId}:${item.nodeId}`}>
        <div><strong>{item.title}</strong><span>{item.nodeKind} · 删除于 {formatDateTime(item.deletedAt)}</span><small>原路径：{item.originalPath?.join(" / ") || "未记录"}</small></div>
        <div className="trash-actions">
          <button className="quiet-button" disabled={Boolean(busyId) || !canRestoreOriginal} title={!canRestoreOriginal ? "原路径已经不存在，请选择恢复到工作区根目录" : busyId ? "正在处理上一项操作" : undefined} onClick={() => void restore(item, "original")}>恢复原路径</button>
          <button className="quiet-button" disabled={Boolean(busyId)} title={busyId ? "正在处理上一项操作" : undefined} onClick={() => void restore(item, "root")}>恢复到根目录</button>
          {directDeleteAvailable && <button className="quiet-button danger-button" data-action="trash-permanent-delete" disabled={Boolean(busyId) || !canDelete} title={!item.readweaveNoteId ? "缺少 ReadWeave 笔记 ID，不能直接永久删除" : busyId ? "正在处理上一项操作" : "适配器直接永久删除后无法撤回"} onClick={() => void permanentlyDelete(item)}>{actionIsBusy ? "正在删除" : "永久删除"}</button>}
          {nativeUiRequired && item.readweaveNoteId && <button className="quiet-button" data-action="trash-open-native-note" disabled={Boolean(busyId)} title={busyId ? "正在打开经过验证的笔记链接" : "打开经过验证的 ReadWeave 笔记；删除需在 ReadWeave 原生回收站中完成"} onClick={() => void openNativeReadWeaveNote(item)}>{nativeLinkIsBusy ? "正在打开" : "在 ReadWeave 中核对"}</button>}
          {nativeUiRequired && !item.readweaveNoteId && <span className="trash-native-note-missing">没有可验证的 ReadWeave 笔记链接</span>}
        </div>
      </article>;
    })}{visibleItems.length === 0 && !error && <p className="empty-inline">当前没有可恢复的回收站项目</p>}</div>
    {notice && <p className="settings-notice"><Icon name="check" />{notice}</p>}
    {error && <p className="settings-error"><Icon name="warning" />{error}</p>}
  </div>;
}

function HistoryDialog({ node, releases, onClose, onSelectPage }: { node: CourseTreeNode; releases: CourseRelease[]; onClose: () => void; onSelectPage: (releaseId: string, pageId: string) => void }) {
  const materialSource = node.kind === "material" ? releases.find((release) => release.id === (node.currentReleaseId ?? node.releaseId)) : undefined;
  const versions = releases
    .filter((release) => node.kind === "course"
      ? release.courseId === node.id
      : release.courseId === materialSource?.courseId && release.moduleId === materialSource?.moduleId)
    .sort((left, right) => right.version - left.version);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="import-dialog history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title">
      <header><div><span className="section-kicker">VERSION HISTORY</span><h2 id="history-title">{node.title} 的版本历史</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><span aria-hidden="true">×</span></button></header>
      <div className="history-list">
        {versions.length === 0 && <p className="empty-inline">这个节点暂时没有可查看的历史版本</p>}
        {versions.map((release) => <article key={release.id}><div><strong>v{release.version} · {release.moduleTitle}</strong><span>{release.pages.length} 页 · {release.lifecycle === "published" ? "正式版本" : "草稿来源"}</span></div><button className="quiet-button button-icon-trailing" onClick={() => { const first = release.pages[0]; if (first) { onSelectPage(release.id, first.id); onClose(); } }}>打开第一页<Icon name="arrowRight" /></button></article>)}
      </div>
      <footer><button className="quiet-button" onClick={onClose}>关闭</button></footer>
    </section>
  </div>;
}

function readNavigationHash(): { releaseId: string; pageIndex: number; hasExplicitPage: boolean; mode: WorkspaceMode } {
  const hash = new URLSearchParams(location.hash.slice(1));
  const requestedPage = Number(hash.get("page") || 1);
  const requestedMode = hash.get("mode");
  return {
    releaseId: hash.get("release") || "",
    pageIndex: Number.isFinite(requestedPage) ? Math.max(0, Math.trunc(requestedPage) - 1) : 0,
    hasExplicitPage: hash.has("page"),
    mode: requestedMode === "studio" || requestedMode === "review" || requestedMode === "learn" ? requestedMode : "learn"
  };
}

export function resolveActiveImportId(hashValue: string, savedImportId?: string | null): string | undefined {
  const hash = new URLSearchParams(hashValue.startsWith("#") ? hashValue.slice(1) : hashValue);
  const importId = hash.get("import");
  if (importId) return importId;
  if (hash.has("release") || hash.has("page")) return undefined;
  return savedImportId || undefined;
}

export async function flushNextSessionPatch(
  pendingPatches: Map<string, Partial<LearningSession>>,
  updateSession: (sessionId: string, patch: Partial<LearningSession>) => Promise<LearningSession>,
  getCurrentSessionId: () => string | undefined,
  onCurrentSessionUpdated: (updated: LearningSession) => void
): Promise<boolean> {
  const next = pendingPatches.entries().next();
  if (next.done) return false;
  const [sessionId, patch] = next.value;
  pendingPatches.delete(sessionId);
  const updated = await updateSession(sessionId, patch);
  if (getCurrentSessionId() === sessionId) onCurrentSessionUpdated(updated);
  return true;
}

function readActiveImportId(): string | undefined {
  return resolveActiveImportId(location.hash, localStorage.getItem("course-os-active-import"));
}

export async function openVerifiedReadWeaveDeepLink(
  noteId: string,
  openWindow: () => Window | null = () => window.open("about:blank", "_blank"),
  loadLink: (id: string) => Promise<{ url: string; verified: boolean }> = api.deepLink
): Promise<void> {
  const popup = openWindow();
  if (!popup) throw new Error("浏览器阻止打开 ReadWeave 新窗口");
  popup.opener = null;
  try {
    const link = await loadLink(noteId);
    if (!link.verified) throw new Error("这个 ReadWeave 目标尚未验证");
    popup.location.replace(link.url);
  } catch (reason) {
    popup.close();
    throw reason;
  }
}

export function mergeReleaseIndex(current: CourseRelease[], indexed: CourseRelease[], detailedReleaseIds: ReadonlySet<string>): CourseRelease[] {
  const merged = new Map(indexed.map((item) => [item.id, item]));
  for (const item of current) {
    if (detailedReleaseIds.has(item.id)) merged.set(item.id, item);
  }
  return [...merged.values()];
}

export function isReadyCandidateSnapshot(draft: LessonDraft, releaseId: string, pageId: string): boolean {
  return !candidateSnapshotIdentityMismatch(draft, releaseId, pageId) && draft.status === "ready";
}

function candidateSnapshotIdentityMismatch(draft: LessonDraft, releaseId: string, pageId: string): string | undefined {
  const mismatches: string[] = [];
  if (draft.sourceReleaseId !== releaseId) mismatches.push(`来源版本 ${draft.sourceReleaseId || "缺失"}`);
  if (draft.pageId !== pageId) mismatches.push(`记录页面 ${draft.pageId || "缺失"}`);
  if (draft.page?.id !== pageId) mismatches.push(`正文页面 ${draft.page?.id || "缺失"}`);
  return mismatches.length
    ? `候选讲解身份错配：${mismatches.join("、")}；请求版本 ${releaseId}、页面 ${pageId}，请重试`
    : undefined;
}

export type CandidatePreviewReconcile = ((event?: Event) => void) & { cancel: () => void };

export function beginCandidatePreviewLoad({
  releaseId,
  pageId,
  readSnapshot,
  readCurrentDraft,
  isActive,
  setPreview,
  onTerminalError
}: {
  releaseId: string;
  pageId: string;
  readSnapshot: () => Promise<LessonDraft>;
  readCurrentDraft: (signal: AbortSignal, confirm: boolean) => Promise<LessonDraft>;
  isActive: () => boolean;
  setPreview: Dispatch<SetStateAction<CandidatePreviewState | undefined>>;
  onTerminalError?: (error: unknown) => void;
}): CandidatePreviewReconcile {
  let snapshotReady = false;
  let latestRead = 0;
  let currentDraftController: AbortController | undefined;
  let disposed = false;
  const reconcile = (event?: Event) => {
    if (disposed || !snapshotReady || !isActive()) return;
    currentDraftController?.abort();
    const controller = new AbortController();
    currentDraftController = controller;
    const readId = ++latestRead;
    // Initial reads use confirmed copies; returning from ReadWeave explicitly
    // requests an authority confirmation without hiding the readable page.
    void readCurrentDraft(controller.signal, event?.type === "focus").then((draft) => {
      if (!isActive() || readId !== latestRead) return;
      const identityMismatch = candidateSnapshotIdentityMismatch(draft, releaseId, pageId);
      if (identityMismatch) {
        setPreview((current) => current?.pageId === pageId && current.page
          ? { ...current, notice: `当前显示的是上次可读讲解；最新 ReadWeave 内容${identityMismatch}，暂未替换正文` }
          : current);
      } else if (draft.status === "ready") {
        const title = readablePageTitle(draft.page.title);
        const updatedPage = title === draft.page.title ? draft.page : { ...draft.page, title };
        setPreview((current) => current?.pageId === pageId
          ? { ...current, page: updatedPage, error: undefined, terminal: false, unavailable: undefined, notice: undefined, generatedReady: true }
          : current);
      } else {
        const partialPreview = candidateNeedsReviewPreview(draft, releaseId, pageId);
        if (partialPreview) {
          snapshotReady = false;
          setPreview(partialPreview);
        } else {
          setPreview((current) => candidatePreviewForUnavailableRead(
            current,
            pageId,
            "not_ready",
            `ReadWeave 候选状态为 ${draft.status}；本页尚未确认可供学习的完整讲解`
          ));
        }
      }
    }).catch((reason: unknown) => {
      if (!isActive() || readId !== latestRead) return;
      if (isTerminalPageReadError(reason)) onTerminalError?.(reason);
      setPreview((current) => candidatePreviewAfterReadFailure(current, pageId, reason));
    }).finally(() => {
      if (currentDraftController === controller) currentDraftController = undefined;
    });
  };

  setPreview((current) => current?.pageId === pageId && (current.page || current.terminal) ? current : { pageId });
  const reportSnapshotProblem = (message: string) => setPreview((current) => {
    if (current?.pageId === pageId && current.terminal) return current;
    return current?.pageId === pageId && current.page
      ? { ...current, error: undefined, notice: `当前显示的是上次可读讲解；${message}，暂未替换正文` }
      : { pageId, error: message };
  });
  void readSnapshot().then((draft) => {
    if (!isActive()) return;
    const identityMismatch = candidateSnapshotIdentityMismatch(draft, releaseId, pageId);
    if (identityMismatch) {
      reportSnapshotProblem(identityMismatch);
    } else if (draft.status === "ready") {
      const title = readablePageTitle(draft.page.title);
      const snapshotPage = title === draft.page.title ? draft.page : { ...draft.page, title };
      snapshotReady = true;
      setPreview({ pageId, page: snapshotPage, generatedReady: true });
      reconcile();
    } else {
      const partialPreview = candidateNeedsReviewPreview(draft, releaseId, pageId);
      if (partialPreview) setPreview(partialPreview);
      else setPreview((current) => candidatePreviewForUnavailableRead(
          current,
          pageId,
          "not_ready",
          `ReadWeave 候选状态为 ${draft.status}；本页尚未确认可供学习的完整讲解`
        ));
    }
  }).catch((reason: unknown) => {
    if (!isActive()) return;
    if (isTerminalPageReadError(reason)) onTerminalError?.(reason);
    setPreview((current) => candidatePreviewAfterReadFailure(current, pageId, reason));
  });
  return Object.assign(reconcile, {
    cancel: () => {
      disposed = true;
      latestRead += 1;
      currentDraftController?.abort();
      currentDraftController = undefined;
    }
  });
}

function compareReleaseRecency(left: CourseRelease, right: CourseRelease): number {
  return right.version - left.version || right.publishedAt.localeCompare(left.publishedAt);
}

export function currentMaterialReleases(items: CourseRelease[], tree?: WorkspaceTree): CourseRelease[] {
  if (tree) {
    const materialNodes = flattenTree([...tree.courses, ...(tree.rootMaterials ?? [])])
      .map(({ node }) => node)
      .filter((node) => node.kind === "material" && !node.archived && node.visibility !== "archived");
    const byId = new Map(items.map((release) => [release.id, release]));
    const selected = new Map<string, CourseRelease>();
    for (const node of materialNodes) {
      const release = [node.currentReleaseId, node.releaseId]
        .filter((id): id is string => Boolean(id))
        .map((id) => byId.get(id))
        .find((candidate): candidate is CourseRelease => Boolean(candidate));
      if (release) selected.set(release.id, release);
    }
    return [...selected.values()];
  }

  const latestByMaterial = new Map<string, CourseRelease>();
  for (const release of [...items].sort(compareReleaseRecency)) {
    const key = `${release.courseId}\u0000${release.moduleId}`;
    if (!latestByMaterial.has(key)) latestByMaterial.set(key, release);
  }
  return [...latestByMaterial.values()];
}

export function defaultRelease(items: CourseRelease[], tree?: WorkspaceTree): CourseRelease | undefined {
  return currentMaterialReleases(items, tree).sort(compareReleaseRecency)[0];
}

function flattenTree(nodes: CourseTreeNode[], depth = 0): Array<{ node: CourseTreeNode; depth: number }> {
  return nodes.flatMap((node) => [{ node, depth }, ...flattenTree(node.children, depth + 1)]);
}

function collectNodeIds(node: CourseTreeNode): string[] {
  return [node.id, ...node.children.flatMap(collectNodeIds)];
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}
