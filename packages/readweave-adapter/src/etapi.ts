import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { brotliCompress, brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { assertReadBudgetActive, currentReadBudget, readBudgetAbortError, withIndependentReadBudget, type ReadBudget } from "./read-budget.js";
import { decodeReadWeaveStateContent, decodeReadWeaveStateContentAsync } from "./state-decoder.js";
import type {
  AssessmentAttempt,
  CredentialStatus,
  CourseConflict,
  CourseProject,
  CourseRelease,
  DraftSourceAsset,
  ExplanationBlock,
  GenerationCostEntry,
  IdempotentWriteContext,
  LessonDraft,
  MasteryRecord,
  PageQuestion,
  QuestionAttempt,
  QuestionSelection,
  ReviewPlan,
  ReadWeaveSyncStatus,
  ReadWeaveDeepLink,
  ReleaseManifest,
  ResearchArchive,
  ModelProviderConfig,
  ModelRoutePolicy,
  TrashRecord,
  WorkspaceSettings,
  CourseTreeNode,
  TreeNodeProperties
} from "@course-os/contracts";
import type { CourseReleaseIndex, MasteryReducer, QuestionAttemptTransactionResult, ReadWeaveCourseApi, ReadWeaveFileState } from "./index.js";
import { EMPTY_STATE, defaultModelProviders, defaultModelRoutePolicy, defaultWorkspaceSettings, toCourseReleaseIndex } from "./index.js";
import { isLegacyProjectionId, isStableMaterialId, materialGroups, materialTreeNode, stableMaterialId, validateMaterialReleaseTarget } from "./tree-identity.js";
import { assertTrashReferencesSafe, trashDeleteIdempotencyKey, trashDeleteReplay, trashDeleteScope, type TrashDeleteOptions, type TrashNativeErasePlan, type TrashDeleteScope } from "./trash-safety.js";

const stateCodecPrefix = "COURSE_OS_BR_STATE_V1:";
const brotliCompressAsync = promisify(brotliCompress);

export function encodeReadWeaveStateContent(state: unknown): string {
  const plain = JSON.stringify(state);
  if (Buffer.byteLength(plain) < 1_000_000) return plain;
  const hash = createHash("sha256").update(plain).digest("hex");
  const compressed = brotliCompressSync(plain, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 2 } });
  return `${stateCodecPrefix}${hash}:${compressed.toString("base64")}`;
}

/** Preserve the snapshot format while moving online compression off the event loop. */
export async function encodeReadWeaveStateContentAsync(state: unknown): Promise<string> {
  const plain = JSON.stringify(state);
  if (Buffer.byteLength(plain) < 1_000_000) return plain;
  const hash = createHash("sha256").update(plain).digest("hex");
  const compressed = await brotliCompressAsync(plain, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 2 } });
  return `${stateCodecPrefix}${hash}:${compressed.toString("base64")}`;
}

export { decodeReadWeaveStateContent } from "./state-decoder.js";

export interface EtapiReadWeaveConfig {
  baseUrl: string;
  token: string;
  parentNoteId: string;
  publicUrl?: string;
  workspaceId?: string;
  seedStatePath?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  /** Trusted server-side read-only native erase log verifier. Never request-controlled. */
  verifyNativeErase?: (plan: TrashNativeErasePlan) => Promise<boolean>;
}

interface EtapiNote {
  noteId: string;
  title: string;
  type: string;
  mime: string;
  blobId?: string;
  parentBranchIds?: string[];
  childNoteIds?: string[];
  utcDateModified?: string;
}

interface EtapiBranch {
  branchId: string;
  noteId: string;
  parentNoteId: string;
  notePosition?: number;
  prefix?: string;
  isExpanded?: boolean;
}

interface CreatedNoteResponse {
  note: EtapiNote;
  branch: EtapiBranch;
}

interface SearchResponse {
  results: EtapiNote[];
}

interface CourseProjection {
  courseNoteId: string;
  materialsNoteId: string;
  qaNoteId: string;
  reviewNoteId: string;
  qualityNoteId: string;
  releasesNoteId: string;
  notesNoteId: string;
  modules: Record<string, string>;
  moduleBranchIds?: Record<string, string>;
  childBranchIds?: Record<string, string>;
}

type SectionKey = "source" | "objectives" | "main" | "prerequisites" | "explanation" | "misconceptions" | "qa" | "assessment" | "quality";

interface DraftProjection {
  pageNoteId: string;
  pageOverviewHash?: string;
  sourceNoteId: string;
  atomsNoteId: string;
  blockNoteIds: Record<string, string>;
  blockHashes: Record<string, string>;
  sectionNoteIds: Record<SectionKey, string>;
  sourceImageNoteId?: string;
  sourceImageFileName?: string;
}

interface ProjectionIndex {
  courseRootNoteId: string;
  stateNoteId: string;
  metadataIndexNoteId?: string;
  metadataIndexRevision?: number;
  activityStateNoteId?: string;
  costIndexNoteId?: string;
  rootMaterialsNoteId?: string;
  trashNoteId?: string;
  materialReleaseSelections?: Record<string, { releaseId: string; source: "derived" | "explicit" }>;
  courses: Record<string, CourseProjection>;
  drafts: Record<string, DraftProjection>;
  releases: Record<string, string>;
}

interface EtapiState extends ReadWeaveFileState {
  projections: ProjectionIndex;
}

interface EtapiMetadataIndex {
  format: "course-os-metadata-index";
  formatVersion: 1;
  schemaVersion: "1.0.0";
  authorityType: "readweave-etapi";
  workspaceId: string;
  stateNoteId: string;
  status: "staged" | "active" | "rolling_back" | "rolled_back";
  revision: number;
  migration: {
    id: string;
    phase: "staged" | "active" | "rolling_back" | "rolled_back";
    sourceSchemaVersion: string;
    startedAt: string;
    completedAt?: string;
  };
  courses: CourseProject[];
  treeNodes: CourseTreeNode[];
  trash: TrashRecord[];
  projections: Pick<ProjectionIndex, "courseRootNoteId" | "rootMaterialsNoteId" | "trashNoteId" | "materialReleaseSelections"> & {
    courses: Record<string, CourseProjection>;
  };
  idempotency: ReadWeaveFileState["idempotency"];
}

interface LocatedMetadataIndex {
  noteId: string;
  index: EtapiMetadataIndex;
}

interface EtapiActivityState {
  schemaVersion: "1.0.0";
  questionSelections: QuestionSelection[];
  questionAttempts: QuestionAttempt[];
  attempts: AssessmentAttempt[];
  mastery: MasteryRecord[];
  idempotency: ReadWeaveFileState["idempotency"];
}

interface EtapiActivityRoutes {
  activityStateNoteId?: string;
  releases: Map<string, Pick<CourseRelease, "id" | "courseId">>;
  reviewNoteIds: Map<string, string>;
  assessmentNoteIds: Map<string, string>;
}

interface EtapiCostIndexState {
  schemaVersion: "1.0.0";
  costEntries: GenerationCostEntry[];
  idempotency: ReadWeaveFileState["idempotency"];
}

interface EtapiDraftPageRecord {
  schemaVersion: "1.0.0";
  pageId: string;
  draft: LessonDraft;
  projection: DraftProjection;
  costEntries: GenerationCostEntry[];
  idempotency: ReadWeaveFileState["idempotency"];
  conflicts: CourseConflict[];
}

interface LocatedDraftPageRecord {
  noteId: string;
  record: EtapiDraftPageRecord;
}

interface DraftPageReadContext {
  costEntries: GenerationCostEntry[];
  conflicts: CourseConflict[];
  idempotency: ReadWeaveFileState["idempotency"];
  projections: { stateNoteId?: string; drafts: Record<string, DraftProjection> };
}

interface BootstrapResult {
  projection: ProjectionIndex;
  stateSnapshot?: Partial<EtapiState>;
  routeState?: Partial<EtapiState>;
}

interface SharedRead<T> {
  promise: Promise<T>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
  independent: boolean;
  ownerDeadline?: number;
  maximumDeadline?: number;
  ownerTimer?: ReturnType<typeof setTimeout>;
}

// The API process is single-writer in production. Adapter instances can still
// overlap briefly when ETAPI settings are replaced, so their page locks share
// this process-wide map.
const draftPageWriteChains = new Map<string, Promise<void>>();
const etapiWriteChains = new Map<string, Promise<void>>();

const activityIdempotencyKinds = new Set(["question_selection", "question_attempt", "question_attempt_transaction", "attempt"]);
const metadataIdempotencyKinds = new Set(["course", "tree_node", "trash", "restore", "native_erase_preflight", "permanent_delete"]);
const metadataIndexLabel = "courseOsMetadataIndex";
const metadataMigrationLabel = "courseOsMetadataMigration";
const metadataIndexTitlePrefix = "Course OS Metadata Index";
const workspaceRootTitle = "Course OS";
const workspaceIndexTitle = "00 Course OS 结构化索引";
const activityIndexTitle = "01 Course OS 学习活动索引";
const backgroundSharedReadBudgetMs = 30_000;
const maximumSharedReadBudgetMs = 180_000;

function createSharedRead<T>(
  work: (markIndependent: () => void) => Promise<T>,
  options: { budgeted?: boolean; independent?: boolean } = {}
): SharedRead<T> {
  const controller = new AbortController();
  const budgeted = options.budgeted ?? true;
  const startedAt = Date.now();
  const maximumDeadline = budgeted ? startedAt + maximumSharedReadBudgetMs : undefined;
  const callerDeadline = budgeted ? currentReadBudget()?.deadline : undefined;
  const shared: SharedRead<T> = {
    promise: Promise.resolve(undefined as T),
    controller,
    consumers: 0,
    settled: false,
    independent: options.independent ?? false,
    ...(maximumDeadline === undefined ? {} : {
      maximumDeadline,
      ownerDeadline: Math.min(maximumDeadline, callerDeadline ?? startedAt + backgroundSharedReadBudgetMs)
    })
  };
  const run = () => work(() => {
    shared.independent = true;
    if (shared.maximumDeadline !== undefined && shared.ownerDeadline !== shared.maximumDeadline) {
      shared.ownerDeadline = shared.maximumDeadline;
      scheduleSharedReadDeadline(shared);
    }
  });
  if (shared.ownerDeadline !== undefined) scheduleSharedReadDeadline(shared);
  shared.promise = budgeted
    ? withIndependentReadBudget({ signal: controller.signal, deadline: maximumDeadline }, run)
    : Promise.resolve().then(run);
  void shared.promise.then(
    () => { shared.settled = true; clearSharedReadDeadline(shared); },
    () => { shared.settled = true; clearSharedReadDeadline(shared); }
  );
  return shared;
}

function joinSharedRead<T>(
  shared: SharedRead<T>,
  budget?: ReadBudget,
  options: { writeOwner?: boolean } = {}
): Promise<T> {
  if (options.writeOwner && !shared.settled && shared.maximumDeadline !== undefined) {
    // A write may reuse a read that began under a short caller scope. The
    // write becomes the owner of that shared lookup, so the reader's deadline
    // must not abort the GETs needed to complete the write.
    shared.independent = true;
    shared.ownerDeadline = shared.maximumDeadline;
    scheduleSharedReadDeadline(shared);
  }
  const signal = budget?.signal;
  if (signal?.aborted) {
    if (shared.consumers === 0 && !shared.settled && !shared.independent) {
      shared.controller.abort(readBudgetAbortError(signal, budget?.deadline));
    }
    return Promise.reject(readBudgetAbortError(signal, budget?.deadline));
  }
  // A background consumer has no HTTP scope. It must not inherit the first
  // foreground consumer's short deadline. Bound it from the shared start,
  // so repeated joins cannot reset this operation's total waiting budget.
  const backgroundDeadline = !budget && shared.maximumDeadline !== undefined
    ? shared.maximumDeadline - maximumSharedReadBudgetMs + backgroundSharedReadBudgetMs : undefined;
  extendSharedReadDeadline(shared, budget?.deadline ?? backgroundDeadline);
  shared.consumers += 1;

  return new Promise<T>((resolve, reject) => {
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      signal?.removeEventListener("abort", onAbort);
      shared.consumers -= 1;
      if (shared.consumers === 0 && !shared.settled && !shared.independent) {
        shared.controller.abort(signal ? readBudgetAbortError(signal, budget?.deadline) : new Error("READ_CANCELLED"));
      }
    };
    const onAbort = () => {
      const error = readBudgetAbortError(signal!, budget?.deadline);
      detach();
      reject(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    shared.promise.then(
      (value) => { detach(); resolve(value); },
      (error: unknown) => { detach(); reject(error); }
    );
  });
}

function extendSharedReadDeadline<T>(shared: SharedRead<T>, consumerDeadline?: number): void {
  if (consumerDeadline === undefined || shared.maximumDeadline === undefined) return;
  const nextDeadline = Math.min(shared.maximumDeadline, consumerDeadline);
  if (shared.ownerDeadline === undefined || nextDeadline > shared.ownerDeadline) {
    shared.ownerDeadline = nextDeadline;
    scheduleSharedReadDeadline(shared);
  }
}

function scheduleSharedReadDeadline<T>(shared: SharedRead<T>): void {
  if (shared.ownerTimer !== undefined) clearTimeout(shared.ownerTimer);
  if (shared.ownerDeadline === undefined || shared.settled || shared.controller.signal.aborted) return;
  const remaining = shared.ownerDeadline - Date.now();
  if (remaining <= 0) {
    shared.controller.abort(new Error("READ_DEADLINE_EXCEEDED"));
    return;
  }
  shared.ownerTimer = setTimeout(() => scheduleSharedReadDeadline(shared), Math.min(remaining, 2_147_483_647));
}

function clearSharedReadDeadline<T>(shared: SharedRead<T>): void {
  if (shared.ownerTimer !== undefined) clearTimeout(shared.ownerTimer);
  shared.ownerTimer = undefined;
}

const SECTION_DEFINITIONS = [
  ["source", "00 来源与原始截图"],
  ["prerequisites", "01 先验知识"],
  ["objectives", "02 学习目标"],
  ["explanation", "03 完整讲解"],
  ["main", "04 主要内容"],
  ["misconceptions", "05 易错点"],
  ["assessment", "06 随机问题"],
  ["qa", "07 QA记录"],
  ["quality", "08 质量与成本"]
] as const;

const LESSON_SECTION_KIND_BY_SECTION: Partial<Record<SectionKey, string>> = {
  objectives: "learning_objectives",
  main: "main_content",
  prerequisites: "prior_knowledge",
  explanation: "full_explanation",
  misconceptions: "misconceptions"
};

export class EtapiReadWeaveCourseApi implements ReadWeaveCourseApi {
  // The authoritative workspace index is large. Writes replace this cache with
  // the committed state immediately, so a one-minute read window keeps local
  // mutations coherent while avoiding a full ReadWeave download on routine
  // page navigation and status checks.
  private static readonly readCacheTtlMs = 60_000;
  private static readonly maxStaleReadMs = 300_000;
  private readonly fetchImpl: typeof fetch;
  private readonly workspaceId: string;
  private readonly writeQueueKey: string;
  private readonly requestTimeoutMs: number;
  private bootstrapInFlight?: SharedRead<BootstrapResult>;
  private bootstrapCache?: BootstrapResult;
  private metadataIndexCache?: { noteId: string; index: EtapiMetadataIndex; expiresAt: number };
  private readonly draftPageRecordCache = new Map<string, LocatedDraftPageRecord>();
  private readonly draftPageRecordVersions = new Map<string, number>();
  private draftPageRecordVersion = 0;
  private draftPageRecordsHydrated = false;
  private draftPageRecordsHydration?: SharedRead<void>;
  private readonly costNoteEnsures = new Map<string, Promise<void>>();
  private readonly writeContext = new AsyncLocalStorage<IdempotentWriteContext>();
  private stateCache?: { state: EtapiState; expiresAt: number };
  private stateReadInFlight?: SharedRead<EtapiState>;
  private stateVersion = 0;
  private activityCache?: { state: EtapiActivityState; expiresAt: number };
  private activityReadInFlight?: SharedRead<EtapiActivityState>;
  private activityVersion = 0;
  private activityStateNoteId?: string;
  private activityRoutes?: EtapiActivityRoutes;
  private readonly draftReadCache = new Map<string, { draft: LessonDraft; expiresAt: number }>();
  private lastReadAt?: string;
  private lastWriteAt?: string;

  constructor(private readonly config: EtapiReadWeaveConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.workspaceId = config.workspaceId ?? "personal";
    this.writeQueueKey = `${new URL(config.baseUrl).toString()}\u0000${config.parentNoteId}\u0000${this.workspaceId}`;
    this.requestTimeoutMs = Math.max(1_000, config.requestTimeoutMs ?? 30_000);
  }

  /** Verify credentials and access to the configured root without changing remote data. */
  async verifyConnection(): Promise<void> {
    await this.raw(`/notes/${encodeURIComponent(this.config.parentNoteId)}`);
  }

  async listCourses(): Promise<CourseProject[]> {
    const metadata = await this.metadataIndexForRead();
    if (metadata) return mergeReleaseCourses(metadata.index.courses, [], this.workspaceId);
    const state = await this.readStateReference(false, false);
    return mergeReleaseCourses(state.courses, state.releases, this.workspaceId);
  }

  async createCourse(course: CourseProject, context: IdempotentWriteContext): Promise<CourseProject> {
    const change = async (state: EtapiState): Promise<CourseProject> => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) {
        const existing = state.courses.find((item) => item.id === replay.objectId);
        if (!existing) throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
        return existing;
      }
      if (state.courses.some((item) => item.id === course.id)) throw new Error("READWEAVE_COURSE_EXISTS");
      const projection = await this.ensureCourseScaffold(state, course.id, course.title, course.description);
      const saved = { ...structuredClone(course), readweaveNoteId: projection.courseNoteId };
      state.courses.push(saved);
      state.idempotency[context.idempotencyKey] = { kind: "course", objectId: saved.id };
      return saved;
    };
    // Existing metadata is sufficient even after an API restart. Bootstrap
    // from the legacy core only when no active metadata authority exists.
    const existing = await this.mutateMetadata(context, () => true, change, true);
    const result = existing.applied ? existing : await this.mutateMetadata(context, () => true, change);
    if (!result.applied) throw new Error("READWEAVE_METADATA_MUTATION_UNAVAILABLE");
    const saved = result.value;
    await this.readBackMetadataTreeNode(saved.id, courseNodeFromProject(saved));
    return saved;
  }

  async registerDraftSource(release: CourseRelease, context: IdempotentWriteContext): Promise<CourseRelease> {
    return this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) {
        const existing = state.releases.find((item) => item.id === replay.objectId);
        if (!existing) throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
        return existing;
      }
      if (state.releases.some((item) => item.id === release.id)) throw new Error("READWEAVE_DRAFT_SOURCE_EXISTS");
      const saved = structuredClone({ ...release, lifecycle: "draft_source" as const });
      await this.ensureCourseProjection(state, saved);
      state.releases.push(saved);
      this.upsertStableMaterialNodes(state);
      state.idempotency[context.idempotencyKey] = { kind: "draft_source", objectId: saved.id };
      return saved;
    }, context);
  }

  async removeDraftSource(releaseId: string, context: IdempotentWriteContext): Promise<void> {
    await this.mutate(async (state) => {
      const release = state.releases.find((item) => item.id === releaseId);
      if (!release) return;
      if (release.lifecycle !== "draft_source") throw new Error("READWEAVE_PUBLISHED_RELEASE_DELETE_DENIED");
      const drafts = state.drafts.filter((item) => item.sourceReleaseId === releaseId);
      for (const draft of drafts) {
        const projection = state.projections.drafts[draft.id];
        if (projection) {
          await this.deleteNote(projection.pageNoteId);
          delete state.projections.drafts[draft.id];
        }
        const pageRecord = await this.findDraftPageRecord(draft.pageId);
        if (pageRecord) {
          await this.deleteNote(pageRecord.noteId);
          this.draftPageRecordCache.delete(draft.pageId);
        }
      }
      const course = state.projections.courses[release.courseId];
      const moduleNoteId = course?.modules[release.moduleId];
      if (moduleNoteId) {
        await this.deleteNote(moduleNoteId);
        delete course.modules[release.moduleId];
      }
      const draftIds = new Set(drafts.map((item) => item.id));
      state.releases = state.releases.filter((item) => item.id !== releaseId);
      state.drafts = state.drafts.filter((item) => item.sourceReleaseId !== releaseId);
      for (const [key, value] of Object.entries(state.idempotency)) {
        if (value.objectId === releaseId || draftIds.has(value.objectId)) delete state.idempotency[key];
      }
    }, context);
  }

  async listReleases(courseId?: string): Promise<CourseRelease[]> {
    const releases = (await this.readStateReference(false, false)).releases;
    return structuredClone(courseId ? releases.filter((release) => release.courseId === courseId) : releases);
  }

  async listReleaseIndexes(courseId?: string): Promise<CourseReleaseIndex[]> {
    const releases = (await this.readStateReference(false, false)).releases;
    return (courseId ? releases.filter((release) => release.courseId === courseId) : releases).map(toCourseReleaseIndex);
  }

  async getRelease(releaseId: string): Promise<CourseRelease | undefined> {
    const release = (await this.readStateReference(false, false)).releases.find((item) => item.id === releaseId);
    return release ? structuredClone(release) : undefined;
  }

  async getManifest(releaseId: string): Promise<ReleaseManifest | undefined> {
    return (await this.readState()).manifests.find((manifest) => manifest.courseReleaseId === releaseId);
  }

  async publishRelease(release: CourseRelease, manifest: ReleaseManifest, context: IdempotentWriteContext): Promise<CourseRelease> {
    return this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) {
        const existing = state.releases.find((item) => item.id === replay.objectId);
        if (!existing) throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
        return existing;
      }
      if (state.releases.some((item) => item.id === release.id)) throw new Error("READWEAVE_RELEASE_IMMUTABLE");
      if (manifest.courseReleaseId !== release.id) throw new Error("READWEAVE_MANIFEST_RELEASE_MISMATCH");
      const course = await this.ensureCourseProjection(state, release);
      const releaseNote = await this.createNote(course.releasesNoteId, `${release.moduleTitle} · v${release.version}`, JSON.stringify({ release, manifest }, null, 2), "code", "application/json", {
        courseOsType: "release",
        courseOsObjectId: release.id,
        courseOsImmutable: "true"
      });
      state.projections.releases[release.id] = releaseNote.noteId;
      state.releases.push(structuredClone({ ...release, lifecycle: "published" as const }));
      state.manifests.push(structuredClone(manifest));
      for (const page of release.pages) {
        const current = state.drafts.find((item) => item.pageId === page.id);
        if (current && current.status !== "clean") continue;
        const draft: LessonDraft = current ?? {
          id: `draft:${page.id}`,
          workspaceId: this.workspaceId,
          courseId: release.courseId,
          moduleId: release.moduleId,
          sourceReleaseId: release.id,
          pageId: page.id,
          revision: 0,
          status: "clean",
          page: structuredClone(page),
          changedBlockIds: [],
          contentHash: sha256(JSON.stringify(page)),
          updatedAt: release.publishedAt
        };
        draft.sourceReleaseId = release.id;
        draft.page = structuredClone(page);
        draft.status = "clean";
        draft.changedBlockIds = [];
        draft.contentHash = sha256(JSON.stringify(page));
        draft.updatedAt = release.publishedAt;
        if (!current) state.drafts.push(draft);
        const projection = await this.ensureDraftProjection(state, draft);
        await this.refreshDraftProjection(draft, projection);
        draft.readweaveNoteId = projection.pageNoteId;
        const pageRecord = await this.findDraftPageRecord(page.id);
        if (pageRecord) {
          const refreshed = this.makeDraftPageRecord(state, draft, projection, pageRecord.record);
          await this.writeDraftPageRecord(refreshed, pageRecord.noteId, state);
        }
      }
      this.upsertStableMaterialNodes(state);
      state.idempotency[context.idempotencyKey] = { kind: "release", objectId: release.id };
      return release;
    }, context);
  }

  async saveQuestion(question: PageQuestion, context: IdempotentWriteContext): Promise<PageQuestion> {
    return this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) {
        const existing = state.questions.find((item) => item.id === replay.objectId);
        if (!existing) throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
        return existing;
      }
      const release = state.releases.find((item) => item.id === question.courseReleaseId);
      const course = release ? await this.ensureCourseProjection(state, release) : undefined;
      const draft = state.drafts.find((item) => item.pageId === question.pageId);
      const projection = draft ? state.projections.drafts[draft.id] : undefined;
      const parentNoteId = projection?.sectionNoteIds.qa ?? course?.qaNoteId;
      const note = parentNoteId ? await this.createNote(parentNoteId, question.question.slice(0, 90), renderQuestion(question), "text", undefined, {
        courseOsType: "qa_record", courseOsObjectId: question.id, courseOsPageId: question.pageId
      }) : undefined;
      const saved = structuredClone({ ...question, readweaveNoteId: note?.noteId });
      state.questions.push(saved);
      state.idempotency[context.idempotencyKey] = { kind: "question", objectId: question.id };
      return saved;
    }, context);
  }

  async updateQuestion(question: PageQuestion, expectedRevision: number, context: IdempotentWriteContext): Promise<PageQuestion> {
    return this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) return state.questions.find((item) => item.id === replay.objectId) ?? question;
      const index = state.questions.findIndex((item) => item.id === question.id);
      if (index < 0) throw new Error("READWEAVE_QUESTION_NOT_FOUND");
      const current = state.questions[index]!;
      if (current.revision !== expectedRevision) throw new Error("READWEAVE_QUESTION_REVISION_CONFLICT");
      const saved = structuredClone({ ...question, readweaveNoteId: current.readweaveNoteId, revision: expectedRevision + 1, updatedAt: new Date().toISOString() });
      if (saved.readweaveNoteId) await this.putContent(saved.readweaveNoteId, renderQuestion(saved));
      state.questions[index] = saved;
      state.idempotency[context.idempotencyKey] = { kind: "question", objectId: saved.id };
      return saved;
    }, context);
  }

  async listQuestions(pageId?: string): Promise<PageQuestion[]> {
    const questions = (await this.readStateReference()).questions;
    return structuredClone(pageId ? questions.filter((item) => item.pageId === pageId) : questions);
  }

  async listNativePageQuestions(pageId: string, workspaceId = this.workspaceId): Promise<import("@course-os/contracts").ReadWeavePageQuestions> {
    if (workspaceId !== this.workspaceId || !/^[A-Za-z0-9:._-]{1,256}$/.test(pageId) || !/^[A-Za-z0-9:._-]{1,256}$/.test(workspaceId)) return { pageId, questions: [] };
    // The structured index is tens of megabytes. Search the verified workspace
    // and page labels instead of loading it for every learner-side QA refresh.
    const workspaceRootNoteId = await this.findWorkspaceRootNoteId();
    if (!workspaceRootNoteId) return { pageId, questions: [] };
    const pageQuery = new URLSearchParams({ search: `#courseOsObjectId=${quoteSearchValue(pageId)}`, ancestorNoteId: workspaceRootNoteId, ancestorDepth: "lt12", fastSearch: "true" });
    const pages = (await this.request<SearchResponse>(`/notes?${pageQuery.toString()}`)).results.filter((item) => item.type === "text");
    if (pages.length !== 1) return { pageId, questions: [] };
    const pageNoteId = pages[0]!.noteId;
    const pageNote = await this.getNote(pageNoteId);
    const noteIds = new Set([pageNoteId, ...(pageNote.childNoteIds ?? [])]);
    const directChildren = pageNote.childNoteIds ?? [];
    const grandchildren = await Promise.all(directChildren.slice(0, 32).map(async (noteId) => {
      try { return (await this.getNote(noteId)).childNoteIds ?? []; } catch { return []; }
    }));
    for (const noteId of grandchildren.flat().slice(0, 128)) noteIds.add(noteId);
    const links = await this.findNativeLinksForArticles(noteIds);
    const byObject = new Map<string, import("@course-os/contracts").ReadWeaveNativeQuestion>();
    for (const link of links) {
      if (!link.objectId || byObject.has(link.objectId)) continue;
      let object: { objectId?: string; kind?: string; contentType?: string; title?: string; body?: string; updatedAt?: string };
      try { object = JSON.parse(await this.getContent(link.objectId)); } catch { continue; }
      if (object.objectId !== link.objectId || object.kind !== "question") continue;
      if ((link.contentType ?? object.contentType ?? "problem") !== "problem") continue;
      const title = (link.displayTitle ?? object.title ?? "").trim();
      if (!title) continue;
      byObject.set(link.objectId, { objectId: link.objectId, title, excerpt: plainReadWeaveText(link.displayBody ?? object.body ?? "").slice(0, 500), updatedAt: object.updatedAt });
    }
    const base = trustedPublicBase(this.config.publicUrl || "https://readweave.example.com");
    return { pageId, noteUrl: `${base.origin}/#root/${encodeURIComponent(pageNoteId)}`, questions: [...byObject.values()] };
  }

  private async findNativeLinksForArticles(articleIds: Set<string>): Promise<Array<{
    articleId: string; objectId: string; kind?: string; contentType?: string; displayTitle?: string; displayBody?: string
  }>> {
    if (articleIds.size === 0) return [];
    // Body search scans unrelated notes upstream before applying ancestry.
    // Read only the existing link directory, with bounded concurrent reads.
    const root = await this.getNote("_readweaveLinks");
    const ids = [...new Set(root.childNoteIds ?? [])];
    const links: Array<{ articleId: string; objectId: string; kind?: string; contentType?: string; displayTitle?: string; displayBody?: string }> = [];
    for (let offset = 0; offset < ids.length; offset += 4) {
      const batch = await Promise.all(ids.slice(offset, offset + 4).map(async (noteId) => {
        // A failed read must remain an error, not look like an empty question list.
        const content = await this.getContent(noteId);
        try {
          const value = JSON.parse(content) as Record<string, unknown>;
          if (value.linkId !== noteId || typeof value.articleId !== "string"
            || !articleIds.has(value.articleId) || typeof value.objectId !== "string") return undefined;
          return value as typeof links[number];
        } catch { return undefined; }
      }));
      links.push(...batch.filter((item): item is NonNullable<typeof item> => !!item));
    }
    return links;
  }

  async listQuestionAttempts(pageId?: string): Promise<QuestionAttempt[]> {
    // Attempts live in the activity index; draft page hydration cannot change them.
    const attempts = (await this.readActivityReference()).questionAttempts;
    return structuredClone(pageId ? attempts.filter((item) => item.pageId === pageId) : attempts);
  }

  async saveQuestionSelection(selection: QuestionSelection, context: IdempotentWriteContext): Promise<QuestionSelection> {
    return this.mutateActivity(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) return state.questionSelections.find((item) => item.id === replay.objectId) ?? selection;
      // A selection is an internal reproducibility record, not learner work.
      // Keep it in the compact activity index instead of creating a visible
      // note and rewriting the multi-megabyte course index on every page open.
      state.questionSelections.push(structuredClone(selection));
      state.idempotency[context.idempotencyKey] = { kind: "question_selection", objectId: selection.id };
      return selection;
    }, context);
  }

  async getQuestionSelection(selectionId: string): Promise<QuestionSelection | undefined> {
    const selection = (await this.readActivityReference()).questionSelections.find((item) => item.id === selectionId);
    return selection ? structuredClone(selection) : undefined;
  }

  async saveQuestionAttempt(attempt: QuestionAttempt, context: IdempotentWriteContext): Promise<QuestionAttempt> {
    let wasReplay = false;
    const saved = await this.mutateActivity(async (state) => {
      const replayEntry = state.idempotency[context.idempotencyKey];
      if (replayEntry) {
        wasReplay = true;
        return state.questionAttempts.find((item) => item.id === replayEntry.objectId) ?? attempt;
      }
      state.questionAttempts.push(structuredClone(attempt));
      state.idempotency[context.idempotencyKey] = { kind: "question_attempt", objectId: attempt.id };
      return attempt;
    }, context);
    await this.writeContext.run(context, () => this.writeQuestionAttemptNote(saved, undefined, undefined, wasReplay));
    return saved;
  }

  async saveQuestionAttemptTransaction(attempt: QuestionAttempt, assessmentAttempt: AssessmentAttempt, reduceMastery: MasteryReducer, context: IdempotentWriteContext): Promise<QuestionAttemptTransactionResult> {
    let wasReplay = false;
    const saved = await this.mutateActivity(async (state) => {
      const replayEntry = state.idempotency[context.idempotencyKey];
      if (replayEntry) {
        wasReplay = true;
        return replayQuestionAttemptTransaction(state, replayEntry.objectId);
      }
      const mastery = reduceMastery(state.mastery.find((item) => item.objectiveId === assessmentAttempt.objectiveId));
      state.questionAttempts.push(structuredClone(attempt));
      state.attempts.push(structuredClone(assessmentAttempt));
      const masteryIndex = state.mastery.findIndex((item) => item.objectiveId === mastery.objectiveId);
      if (masteryIndex >= 0) state.mastery[masteryIndex] = structuredClone(mastery);
      else state.mastery.push(structuredClone(mastery));
      state.idempotency[context.idempotencyKey] = { kind: "question_attempt_transaction", objectId: attempt.id };
      return { attempt: structuredClone(attempt), assessmentAttempt: structuredClone(assessmentAttempt), mastery: structuredClone(mastery) };
    }, context);
    await this.writeContext.run(context, () => this.writeQuestionAttemptNote(saved.attempt, saved.assessmentAttempt, saved.mastery, wasReplay));
    return saved;
  }

  async getReviewPlan(planId: string): Promise<ReviewPlan | undefined> {
    return (await this.readState()).reviewPlans.find((item) => item.id === planId);
  }

  async saveReviewPlan(plan: ReviewPlan, context: IdempotentWriteContext): Promise<ReviewPlan> {
    return this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) return structuredClone(state.reviewPlans.find((item) => item.id === replay.objectId) ?? plan);
      if (state.reviewPlans.some((item) => item.id === plan.id)) throw new Error("READWEAVE_REVIEW_PLAN_EXISTS");
      const release = state.releases.find((item) => plan.items.some((entry) => entry.releaseId === item.id));
      const course = release ? await this.ensureCourseProjection(state, release) : undefined;
      const note = course ? await this.createNote(course.reviewNoteId, `复习计划 · ${plan.id}`, `<pre>${escapeHtml(JSON.stringify(plan, null, 2))}</pre>`, "text", undefined, {
        courseOsType: "review_plan", courseOsObjectId: plan.id
      }) : undefined;
      const saved = structuredClone({ ...plan, readweaveNoteId: note?.noteId });
      state.reviewPlans.push(saved);
      state.idempotency[context.idempotencyKey] = { kind: "review_plan", objectId: saved.id };
      return saved;
    }, context);
  }

  async updateReviewPlan(plan: ReviewPlan, expectedRevision: number, context: IdempotentWriteContext): Promise<ReviewPlan> {
    return this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) return structuredClone(state.reviewPlans.find((item) => item.id === replay.objectId) ?? plan);
      const index = state.reviewPlans.findIndex((item) => item.id === plan.id);
      if (index < 0) throw new Error("READWEAVE_REVIEW_PLAN_NOT_FOUND");
      const current = state.reviewPlans[index]!;
      if (current.revision !== expectedRevision) throw new Error("READWEAVE_REVIEW_PLAN_REVISION_CONFLICT");
      const saved = structuredClone({ ...plan, revision: expectedRevision + 1, updatedAt: new Date().toISOString() });
      if (saved.readweaveNoteId) await this.putContent(saved.readweaveNoteId, `<pre>${escapeHtml(JSON.stringify(saved, null, 2))}</pre>`);
      state.reviewPlans[index] = saved;
      state.idempotency[context.idempotencyKey] = { kind: "review_plan", objectId: saved.id };
      return saved;
    }, context);
  }

  async appendCostEntry(entry: GenerationCostEntry, context: IdempotentWriteContext): Promise<GenerationCostEntry> {
    if (entry.pageId) {
      const pageCost = await this.appendDraftPageCost(entry, context);
      if (pageCost) return pageCost;
    }
    const result = await this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      const saved = replay ? state.costEntries.find((item) => item.id === replay.objectId) ?? entry : structuredClone(entry);
      if (!replay) {
        state.costEntries.push(saved);
        state.idempotency[context.idempotencyKey] = { kind: "cost_entry", objectId: entry.id };
      }
      const release = state.releases.find((item) => item.id === saved.materialVersionId || item.courseId === saved.courseId);
      let parentNoteId: string | undefined;
      if (release) {
        const course = replay
          ? state.projections.courses[release.courseId]
          : await this.ensureCourseProjection(state, release);
        const draft = saved.pageId ? state.drafts.find((item) => item.pageId === saved.pageId) : undefined;
        const projection = draft ? state.projections.drafts[draft.id] : undefined;
        parentNoteId = projection?.sectionNoteIds.quality ?? course?.qualityNoteId;
      }
      return { saved, parentNoteId };
    }, context);
    if (result.parentNoteId) {
      await this.writeContext.run(context, () => this.ensureCostNoteOnce(result.parentNoteId!, result.saved));
    }
    return result.saved;
  }

  private async appendDraftPageCost(entry: GenerationCostEntry, context: IdempotentWriteContext): Promise<GenerationCostEntry | undefined> {
    if (!entry.pageId) return undefined;
    return this.withDraftPageLock(entry.pageId, context, async () => {
      const state = structuredClone(await this.readStateReference(true));
      const located = await this.findDraftPageRecord(entry.pageId!);
      if (located) this.mergeDraftPageRecord(state, located.record);
      const release = state.releases.find((item) => item.id === entry.materialVersionId)
        ?? state.releases.find((item) => item.courseId === entry.courseId
          && item.pages.some((page) => page.id === entry.pageId));
      let draft = located?.record.draft ?? state.drafts.find((item) => item.pageId === entry.pageId);
      if (!draft && release) {
        const page = release.pages.find((item) => item.id === entry.pageId);
        if (page) {
          draft = {
            id: `draft:${page.id}`,
            workspaceId: this.workspaceId,
            courseId: release.courseId,
            moduleId: release.moduleId,
            sourceReleaseId: release.id,
            pageId: page.id,
            revision: 0,
            status: "clean",
            page: structuredClone(page),
            changedBlockIds: [],
            contentHash: sha256(JSON.stringify(page)),
            updatedAt: release.publishedAt
          };
        }
      }
      if (!draft || !release) return undefined;

      const projection = located?.record.projection ?? state.projections.drafts[draft.id]
        ?? await this.ensureDraftProjection(state, draft);
      state.projections.drafts[draft.id] = projection;
      const existingCost = located?.record.costEntries.find((item) => item.id === entry.id)
        ?? state.costEntries.find((item) => item.id === entry.id);
      const replay = located?.record.idempotency[context.idempotencyKey] ?? state.idempotency[context.idempotencyKey];
      const saved = replay
        ? located?.record.costEntries.find((item) => item.id === replay.objectId)
          ?? state.costEntries.find((item) => item.id === replay.objectId)
          ?? existingCost
          ?? entry
        : existingCost ?? structuredClone(entry);
      const record = this.makeDraftPageRecord(state, draft, projection, located?.record);
      if (!record.costEntries.some((item) => item.id === saved.id)) record.costEntries.push(structuredClone(saved));
      record.idempotency[context.idempotencyKey] = { kind: "cost_entry", objectId: saved.id };
      record.idempotency[saved.id] = { kind: "cost_entry", objectId: saved.id };
      if (!located || !replay || !existingCost) {
        await this.writeDraftPageRecord(record, located?.noteId, state);
      }
      const parentNoteId = projection.sectionNoteIds.quality;
      await this.writeContext.run(context, () => this.ensureCostNoteOnce(parentNoteId, saved));
      return structuredClone(saved);
    });
  }

  async listCostEntries(filters: { courseId?: string; materialVersionId?: string; pageId?: string; jobId?: string } = {}): Promise<GenerationCostEntry[]> {
    const reference = filters.pageId || filters.materialVersionId
      ? await this.readStateReference(false, false) : undefined;
    const release = filters.materialVersionId
      ? reference?.releases.find(item => item.id === filters.materialVersionId) : undefined;
    const scoped = Boolean(reference && (filters.pageId || release) && (!filters.materialVersionId || release));
    const state = scoped ? reference! : await this.readState();
    const costIndex = state.projections.costIndexNoteId
      ? await this.readCostIndex(state.projections.costIndexNoteId)
      : undefined;
    let costs = state.costEntries;
    if (scoped) {
      const pageIds = filters.pageId ? [filters.pageId] : [...new Set([
        ...release!.pageIds, ...release!.pages.map(page => page.id),
        ...state.drafts.filter(draft => draft.sourceReleaseId === release!.id).map(draft => draft.pageId),
        ...mergeCostEntries(costIndex?.costEntries, state.costEntries)
          .filter(cost => cost.materialVersionId === release!.id && cost.pageId).map(cost => cost.pageId!)
      ])];
      const observedVersions = new Map(this.draftPageRecordVersions);
      const records = new Map((await this.readDraftPageRecords(pageIds)).map(located => [located.record.pageId, located]));
      for (const pageId of pageIds) {
        let located = records.get(pageId);
        // Only a newer record committed/observed during this fresh read may
        // supersede its result. A missing remote record is not a cache hit.
        const cached = this.draftPageRecordCache.get(pageId);
        if (located && cached && cached.record.draft.revision > located.record.draft.revision
          && (this.draftPageRecordVersions.get(pageId) ?? 0) > (observedVersions.get(pageId) ?? 0)) located = cached;
        located ??= await this.recoverUnlabelledDraftPageRecord(pageId, 4);
        costs = mergeCostEntries(costs, located?.record.costEntries);
      }
    }
    return structuredClone(mergeCostEntries(costIndex?.costEntries, costs).filter((item) =>
      (!filters.courseId || item.courseId === filters.courseId) &&
      (!filters.materialVersionId || item.materialVersionId === filters.materialVersionId) &&
      (!filters.pageId || item.pageId === filters.pageId) &&
      (!filters.jobId || item.jobId === filters.jobId)));
  }

  async saveAttempt(attempt: AssessmentAttempt, mastery: MasteryRecord, context: IdempotentWriteContext): Promise<AssessmentAttempt> {
    return this.mutateActivity(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) {
        const existing = state.attempts.find((item) => item.id === replay.objectId);
        if (!existing) throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
        return existing;
      }
      state.attempts.push(structuredClone(attempt));
      const index = state.mastery.findIndex((item) => item.objectiveId === mastery.objectiveId);
      if (index >= 0) state.mastery[index] = structuredClone(mastery);
      else state.mastery.push(structuredClone(mastery));
      state.idempotency[context.idempotencyKey] = { kind: "attempt", objectId: attempt.id };
      return attempt;
    }, context);
  }

  async listMastery(): Promise<MasteryRecord[]> {
    return structuredClone((await this.readActivityReference()).mastery);
  }

  async listAssessmentAttempts(objectiveId?: string): Promise<AssessmentAttempt[]> {
    const attempts = (await this.readActivityReference()).attempts;
    return structuredClone(objectiveId ? attempts.filter((item) => item.objectiveId === objectiveId) : attempts);
  }

  async archiveResearch(archive: ResearchArchive, context: IdempotentWriteContext): Promise<ResearchArchive> {
    return this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) {
        const existing = state.researchArchives.find((item) => item.id === replay.objectId);
        if (!existing) throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
        return existing;
      }
      if (state.researchArchives.some((item) => item.id === archive.id)) throw new Error("READWEAVE_RESEARCH_IMMUTABLE");
      state.researchArchives.push(structuredClone(archive));
      state.idempotency[context.idempotencyKey] = { kind: "research", objectId: archive.id };
      return archive;
    }, context);
  }

  async searchResearch(query: string): Promise<Array<{ archiveId: string; title: string; snippets: string[] }>> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return (await this.readState()).researchArchives.flatMap((archive) => {
      const snippets = archive.content.split(/\r?\n/).filter((line) => line.toLowerCase().includes(needle)).slice(0, 8);
      return snippets.length ? [{ archiveId: archive.id, title: archive.title, snippets }] : [];
    });
  }

  async listDrafts(): Promise<LessonDraft[]> {
    // Listing drafts is used by the workspace tree and metadata refreshes
    // where only ownership/counts are needed. Re-reading every explanation
    // block from ReadWeave here turned one refresh into hundreds of ETAPI
    // requests. Reconcile the single page when it is opened instead.
    return structuredClone((await this.readState()).drafts);
  }

  async getDraftByPage(pageId: string): Promise<LessonDraft | undefined> {
    return this.withDraftPageLock(pageId, undefined, async () => {
      const located = await this.findDraftPageRecord(pageId);
      const stateReference = located ? undefined : await this.readStateReference(true, false);
      const draft = located?.record.draft ?? stateReference?.drafts.find((item) => item.pageId === pageId);
      if (!draft) return undefined;
      if (draft.workspaceId !== this.workspaceId) return undefined;
      const state = this.createDraftPageReadContext(stateReference, draft, located?.record);
      const reconciled = await this.reconcileDraft(state, draft);
      if (reconciled.changed) {
        const projection = state.projections.drafts[reconciled.draft.id];
        if (projection) {
          const record = this.makeDraftPageRecord(state, reconciled.draft, projection, located?.record);
          await this.writeDraftPageRecord(record, located?.noteId, stateReference);
        }
      }
      this.draftReadCache.set(pageId, { draft: structuredClone(reconciled.draft), expiresAt: Date.now() + EtapiReadWeaveCourseApi.readCacheTtlMs });
      return reconciled.draft;
    });
  }

  private createDraftPageReadContext(
    state: Pick<EtapiState, "costEntries" | "conflicts" | "idempotency" | "projections"> | undefined,
    draft: LessonDraft,
    record?: EtapiDraftPageRecord
  ): DraftPageReadContext {
    const costEntries = mergeCostEntries(
      state?.costEntries.filter((entry) => entry.pageId === draft.pageId),
      record?.costEntries
    );
    const costIds = new Set(costEntries.map((entry) => entry.id));
    const conflictsById = new Map((state?.conflicts ?? [])
      .filter((item) => item.objectId === draft.pageId)
      .map((item) => [item.id, item]));
    for (const conflict of record?.conflicts ?? []) conflictsById.set(conflict.id, conflict);
    const conflictIds = new Set(conflictsById.keys());
    const legacyIdempotency = Object.fromEntries(Object.entries(state?.idempotency ?? {}).filter(([, value]) =>
      (value.kind === "draft" && value.objectId === draft.id) ||
      (value.kind === "cost_entry" && costIds.has(value.objectId)) ||
      (value.kind === "conflict" && conflictIds.has(value.objectId))
    ));
    const projection = record?.projection ?? state?.projections.drafts[draft.id];

    return {
      costEntries: structuredClone(costEntries),
      conflicts: structuredClone([...conflictsById.values()]),
      idempotency: structuredClone({ ...legacyIdempotency, ...(record?.idempotency ?? {}) }),
      projections: {
        stateNoteId: state?.projections.stateNoteId,
        drafts: projection ? { [draft.id]: structuredClone(projection) } : {}
      }
    };
  }

  async getDraftSnapshotByPage(pageId: string): Promise<LessonDraft | undefined> {
    const cached = this.draftReadCache.get(pageId);
    if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.draft);
    const cachedLocated = this.draftPageRecordCache.get(pageId);
    if (cachedLocated) {
      const draft = cachedLocated.record.draft;
      if (draft.workspaceId !== this.workspaceId) return undefined;
      return structuredClone(draft);
    }
    const located = await this.findDraftPageRecord(pageId);
    const draft = located?.record.draft
      ?? (await this.readStateReference(false, false)).drafts.find((item) => item.pageId === pageId);
    if (!draft || draft.workspaceId !== this.workspaceId) return undefined;
    return structuredClone(draft);
  }

  async saveDraft(draft: LessonDraft, expectedRevision: number, context: IdempotentWriteContext, sourceAsset?: DraftSourceAsset): Promise<LessonDraft> {
    return this.saveDraftInternal(draft, expectedRevision, context, sourceAsset);
  }

  async saveDraftWithCost(draft: LessonDraft, expectedRevision: number, context: IdempotentWriteContext, cost: GenerationCostEntry, sourceAsset?: DraftSourceAsset): Promise<LessonDraft> {
    return this.saveDraftInternal(draft, expectedRevision, context, sourceAsset, cost);
  }

  private async saveDraftInternal(draft: LessonDraft, expectedRevision: number, context: IdempotentWriteContext, sourceAsset?: DraftSourceAsset, cost?: GenerationCostEntry): Promise<LessonDraft> {
    return this.withDraftPageLock(draft.pageId, context, async () => {
      const reference = await this.readStateReference(true, false);
      const located = await this.findDraftPageRecord(draft.pageId);
      const previous = located?.record;
      const currentReference = previous?.draft ?? reference.drafts.find(item => item.pageId === draft.pageId);
      const replay = previous?.idempotency[context.idempotencyKey] ?? reference.idempotency[context.idempotencyKey];
      const replayReference = replay && currentReference?.id !== replay.objectId
        ? reference.drafts.find(item => item.id === replay.objectId) : undefined;
      const selectedDrafts = [currentReference, replayReference].filter((item): item is LessonDraft => !!item);
      const pageContext = this.createDraftPageReadContext(reference, currentReference ?? replayReference ?? draft, previous);
      const courseIds = new Set([draft.courseId, ...selectedDrafts.map(item => item.courseId)]);
      const sourceIds = new Set([draft.sourceReleaseId, ...selectedDrafts.map(item => item.sourceReleaseId)]);
      const state: EtapiState = {
        ...reference, ...pageContext,
        drafts: selectedDrafts.map(item => structuredClone(item)),
        releases: reference.releases.filter(item => sourceIds.has(item.id)),
        projections: {
          ...reference.projections, ...pageContext.projections,
          courses: Object.fromEntries([...courseIds].filter(id => reference.projections.courses[id])
            .map(id => [id, structuredClone(reference.projections.courses[id]!)]))
        }
      };
      const fallbackState = (): EtapiState => ({ ...reference, projections: { ...reference.projections,
        courses: { ...reference.projections.courses, ...state.projections.courses } } });
      let current = state.drafts.find(item => item.pageId === draft.pageId);
      let projection = current ? state.projections.drafts[current.id] : undefined;
      if (replay) {
        const existing = current?.id === replay.objectId
          ? current
          : state.drafts.find((item) => item.id === replay.objectId);
        if (!existing) throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
        projection = projection ?? state.projections.drafts[existing.id] ?? await this.ensureDraftProjection(state, existing, sourceAsset);
        if (!previous) {
          const migrated = this.makeDraftPageRecord(state, existing, projection);
          await this.writeDraftPageRecord(migrated, undefined, fallbackState());
        }
        await this.syncMetadataMaterialFromDraft(this.stateCache?.state ?? fallbackState(), existing, context);
        if (cost) await this.writeContext.run(context, () => this.ensureCostNoteOnce(projection!.sectionNoteIds.quality, cost));
        return structuredClone(existing);
      }

      if (current) current = (await this.reconcileDraft(state, current, draft)).draft;
      const conflictResult = async (remoteDraft: LessonDraft | undefined, remoteProjection: DraftProjection | undefined): Promise<never> => {
        const conflictDraft = remoteDraft ?? current ?? draft;
        const conflictProjection = state.projections.drafts[conflictDraft.id] ?? remoteProjection
          ?? await this.ensureDraftProjection(state, conflictDraft, sourceAsset);
        const conflict = this.createConflict(draft, expectedRevision, conflictDraft);
        const record = this.makeDraftPageRecord(state, conflictDraft, conflictProjection, previous);
        record.conflicts = [...record.conflicts.filter((item) => item.id !== conflict.id), conflict];
        await this.writeDraftPageRecord(record, located?.noteId, fallbackState());
        this.draftReadCache.delete(draft.pageId);
        throw new Error(`READWEAVE_REVISION_CONFLICT:${conflict.id}`);
      };

      if ((current?.revision ?? 0) !== expectedRevision) return conflictResult(current, projection);

      const projectionCreated = !projection;
      const ensureStartedAt = performance.now();
      projection = await this.ensureDraftProjection(state, current ?? draft, sourceAsset);
      const ensuredAt = performance.now();
      if (current) {
        current = (await this.reconcileDraft(state, current, draft)).draft;
        if (current.revision !== expectedRevision) return conflictResult(current, projection);
      }

      try {
        await this.refreshDraftProjection(draft, projection, sourceAsset, 4, current);
      } catch (error) {
        if (error instanceof Error && error.message === "READWEAVE_DRAFT_BLOCK_CONFLICT" && current) {
          const latest = await this.reconcileDraft(state, current, draft);
          if (latest.changed) return conflictResult(latest.draft, projection);
        }
        throw error;
      }
      if (process.env.COURSE_OS_READWEAVE_TIMING === "1") {
        console.info("course_os.readweave_draft_projection_timing", JSON.stringify({
          projectionCreated,
          ensureDraftProjectionMs: Math.round(ensuredAt - ensureStartedAt),
          refreshDraftProjectionMs: Math.round(performance.now() - ensuredAt)
        }));
      }

      const saved: LessonDraft = structuredClone({
        ...draft,
        readweaveNoteId: projection.pageNoteId,
        revision: (current?.revision ?? 0) + 1,
        contentHash: sha256(JSON.stringify(draft.page)),
        updatedAt: new Date().toISOString()
      });
      if (cost) await this.writeContext.run(context, () => this.ensureCostNoteOnce(projection!.sectionNoteIds.quality, cost));
      const record = this.makeDraftPageRecord(state, saved, projection, previous);
      if (cost && !record.costEntries.some((item) => item.id === cost.id)) record.costEntries.push(structuredClone(cost));
      record.idempotency[context.idempotencyKey] = { kind: "draft", objectId: saved.id };
      if (cost) record.idempotency[cost.id] = { kind: "cost_entry", objectId: cost.id };
      await this.writeDraftPageRecord(record, located?.noteId, fallbackState());
      await this.syncMetadataMaterialFromDraft(this.stateCache?.state ?? fallbackState(), saved, context);
      return saved;
    }).catch((error: unknown) => {
      this.invalidateStateCache();
      throw error;
    });
  }

  async listConflicts(): Promise<CourseConflict[]> {
    return (await this.readState()).conflicts;
  }

  async resolveConflict(conflictId: string, resolution: "local" | "remote" | "merged", mergedContent: string | undefined, context: IdempotentWriteContext): Promise<CourseConflict> {
    const stateReference = await this.readStateReference(true, false);
    let initial = stateReference.conflicts.find((item) => item.id === conflictId);
    if (!initial) {
      const pageId = lessonDraftPageIdFromConflictId(conflictId);
      if (pageId) initial = (await this.findDraftPageRecord(pageId))?.record.conflicts.find((item) => item.id === conflictId);
    }
    if (initial?.objectType === "lesson_draft") {
      return this.withDraftPageLock(initial.objectId, context, async () => {
        const stateReference = await this.readStateReference(true, false);
        const located = await this.findDraftPageRecord(initial.objectId);
        const draft = located?.record.draft ?? stateReference.drafts.find((item) => item.pageId === initial!.objectId);
        if (!draft) throw new Error("READWEAVE_DRAFT_NOT_FOUND");
        const state = this.createDraftPageReadContext(stateReference, draft, located?.record);
        const replay = state.idempotency[context.idempotencyKey];
        if (replay) {
          const existing = state.conflicts.find((item) => item.id === replay.objectId);
          if (!existing) throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
          return existing;
        }
        const conflict = state.conflicts.find((item) => item.id === conflictId);
        if (!conflict) throw new Error("READWEAVE_CONFLICT_NOT_FOUND");
        if (conflict.status === "resolved") return conflict;
        if (resolution === "merged" && !mergedContent?.trim()) throw new Error("READWEAVE_MERGED_CONTENT_REQUIRED");
        const selected = resolution === "local" ? conflict.localContent : resolution === "remote" ? conflict.remoteContent : mergedContent!;
        const previousDraft = structuredClone(draft);
        try {
          draft.page = JSON.parse(selected);
        } catch {
          throw new Error("READWEAVE_CONFLICT_CONTENT_INVALID");
        }
        draft.revision = Math.max(conflict.localRevision, conflict.remoteRevision, draft.revision) + 1;
        draft.status = "editing";
        draft.contentHash = sha256(JSON.stringify(draft.page));
        draft.updatedAt = new Date().toISOString();
        const projection = located?.record.projection ?? state.projections.drafts[draft.id]
          ?? await this.ensureDraftProjection(stateReference, draft);
        state.projections.drafts[draft.id] = projection;
        conflict.status = "resolved";
        conflict.resolution = resolution;
        conflict.resolvedAt = draft.updatedAt;
        state.idempotency[context.idempotencyKey] = { kind: "conflict", objectId: conflict.id };
        await this.refreshDraftProjection(draft, projection, undefined, 4, previousDraft);
        const record = this.makeDraftPageRecord(state, draft, projection, located?.record);
        record.conflicts = [...record.conflicts.filter((item) => item.id !== conflict.id), conflict];
        record.idempotency[context.idempotencyKey] = { kind: "conflict", objectId: conflict.id };
        await this.writeDraftPageRecord(record, located?.noteId, stateReference);
        return structuredClone(conflict);
      });
    }
    return this.mutate(async (state) => {
      const conflict = state.conflicts.find((item) => item.id === conflictId);
      if (!conflict) throw new Error("READWEAVE_CONFLICT_NOT_FOUND");
      if (conflict.status === "resolved") return conflict;
      if (resolution === "merged" && !mergedContent?.trim()) throw new Error("READWEAVE_MERGED_CONTENT_REQUIRED");
      const draft = state.drafts.find((item) => item.pageId === conflict.objectId);
      if (!draft) throw new Error("READWEAVE_DRAFT_NOT_FOUND");
      const selected = resolution === "local" ? conflict.localContent : resolution === "remote" ? conflict.remoteContent : mergedContent!;
      try {
        draft.page = JSON.parse(selected);
      } catch {
        throw new Error("READWEAVE_CONFLICT_CONTENT_INVALID");
      }
      draft.revision = Math.max(conflict.localRevision, conflict.remoteRevision, draft.revision) + 1;
      draft.status = "editing";
      draft.contentHash = sha256(JSON.stringify(draft.page));
      draft.updatedAt = new Date().toISOString();
      conflict.status = "resolved";
      conflict.resolution = resolution;
      conflict.resolvedAt = draft.updatedAt;
      state.idempotency[context.idempotencyKey] = { kind: "conflict", objectId: conflict.id };
      return conflict;
    }, context);
  }

  async getSyncStatus(): Promise<ReadWeaveSyncStatus> {
    try {
      const state = await this.readStateReference(true);
      return {
        state: "connected",
        authority: "readweave",
        mode: "etapi",
        pendingWrites: 0,
        conflicts: state.conflicts.filter((item) => item.status === "open").length,
        lastReadAt: this.lastReadAt,
        lastWriteAt: this.lastWriteAt,
        deepLinkBase: this.config.publicUrl,
        message: "ReadWeave ETAPI 权威存储已连接"
      };
    } catch {
      return {
        state: "offline",
        authority: "readweave",
        mode: "etapi",
        pendingWrites: 0,
        conflicts: 0,
        deepLinkBase: this.config.publicUrl,
        message: "ReadWeave 暂时不可访问，请稍后重试"
      };
    }
  }

  async listTreeNodes(): Promise<CourseTreeNode[]> {
    const metadata = await this.metadataIndexForRead();
    if (metadata) return this.treeNodesFromMetadata(metadata.index);
    const state = await this.readStateReference(false, false);
    const courses = mergeReleaseCourses(state.courses, state.releases, this.workspaceId).filter((course) => course.status !== "archived");
    const stableMaterialIds = new Set(materialGroups(state.releases).map((group) => stableMaterialId(group.courseId, group.moduleId)));
    const archivedMaterialIds = new Set(state.treeNodes
      .filter((node) => node.kind === "material" && node.archived)
      .map((node) => node.materialId || node.id));
    const generated = courses.map((course) => ({
      id: course.id,
      kind: "course" as const,
      title: course.title,
      subtitle: course.description,
      status: course.status === "archived" ? "draft" as const : "published" as const,
      archived: course.status === "archived",
      visibility: course.status === "archived" ? "archived" as const : "library" as const,
      revision: course.revision ?? 0,
      sortOrder: course.sortOrder,
      readweaveNoteId: course.readweaveNoteId ?? state.projections.courses[course.id]?.courseNoteId,
      children: []
    }));
    const byId = new Map(state.treeNodes
      .filter((node) => (node.kind === "course" || node.kind === "material") && !node.archived)
      .filter((node) => !(node.kind === "material" && node.id !== node.materialId && node.materialId && stableMaterialIds.has(node.materialId)))
      .map((node) => [node.id, withMaterialReleaseSelectionHint(structuredClone(node), state.projections.materialReleaseSelections)] as const));
    for (const node of generated) if (!byId.has(node.id)) byId.set(node.id, node);
    for (const group of materialGroups(state.releases, state.drafts)) {
      const course = courses.find((item) => item.id === group.courseId);
      if (!course) continue;
      const id = stableMaterialId(group.courseId, group.moduleId);
      if (archivedMaterialIds.has(id)) continue;
      const persisted = state.treeNodes.find((node) => node.kind === "material" && !node.archived && (node.id === id || node.materialId === id));
      const selection = state.projections.materialReleaseSelections?.[id];
      const selectionNode = !persisted ? undefined
        : selection?.source === "derived" ? { ...persisted, currentReleaseId: undefined, releaseId: undefined }
          : selection?.source === "explicit" ? { ...persisted, currentReleaseId: selection.releaseId, releaseId: selection.releaseId }
            : persisted;
      const projection = state.projections.courses[group.courseId];
      const legacyNoteId = projection?.modules[group.moduleId];
      byId.set(id, withMaterialReleaseSelectionHint({
        ...materialTreeNode(course, group, selectionNode, state.drafts),
        id,
        materialId: id,
        readweaveNoteId: persisted?.readweaveNoteId ?? legacyNoteId
      }, state.projections.materialReleaseSelections));
    }
    return [...byId.values()];
  }

  /** Raw same-workspace metadata lookup, including archived nodes hidden from the visible tree. */
  async getTreeNodeMetadata(nodeId: string): Promise<{ node: CourseTreeNode; workspaceId: string } | undefined> {
    const metadata = await this.metadataIndexForRead();
    if (!metadata) {
      const state = await this.readStateReference(false, false);
      const course = state.courses.find((candidate) => candidate.id === nodeId);
      if (course) return course.workspaceId === this.workspaceId
        ? { node: courseNodeFromProject(course), workspaceId: course.workspaceId }
        : undefined;
      const node = state.treeNodes.find((candidate) => candidate.id === nodeId);
      if (!node) return undefined;
      const courses = mergeReleaseCourses(state.courses, state.releases, this.workspaceId);
      const materialId = node.materialId || node.id;
      const owner = node.kind === "material"
        ? courses.filter((candidate) => materialId.startsWith(`material:${candidate.id}:`))
          .sort((left, right) => right.id.length - left.id.length)[0]
        : courses.find((candidate) => candidate.id === node.parentId);
      return owner?.workspaceId === this.workspaceId
        ? { node: withMaterialReleaseSelectionHint(structuredClone(node), state.projections.materialReleaseSelections), workspaceId: owner.workspaceId }
        : undefined;
    }
    const course = metadata.index.courses.find((candidate) => candidate.id === nodeId);
    if (course) return course.workspaceId === this.workspaceId
      ? { node: courseNodeFromProject(course), workspaceId: course.workspaceId }
      : undefined;
    const node = metadata.index.treeNodes.find((candidate) => candidate.id === nodeId);
    if (!node) return undefined;
    const materialId = node.materialId || node.id;
    const owner = node.kind === "material"
      ? metadata.index.courses
        .filter((candidate) => materialId.startsWith(`material:${candidate.id}:`))
        .sort((left, right) => right.id.length - left.id.length)[0]
      : metadata.index.courses.find((candidate) => candidate.id === node.parentId);
    return owner?.workspaceId === this.workspaceId
      ? { node: withMaterialReleaseSelectionHint(structuredClone(node), metadata.index.projections.materialReleaseSelections), workspaceId: owner.workspaceId }
      : undefined;
  }

  async createTreeNode(node: CourseTreeNode, context: IdempotentWriteContext): Promise<CourseTreeNode> {
    const result = await this.mutateMetadata(context, (state) => {
      if (node.kind !== "module" && node.kind !== "material") return true;
      if (!node.parentId) return true;
      if (state.courses.some((course) => course.id === node.parentId)) return true;
      const currentMaterial = /^material:([^:]+):current$/.exec(node.parentId);
      return Boolean(currentMaterial && state.courses.some((course) => course.id === currentMaterial[1]));
    }, async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) return state.treeNodes.find((item) => item.id === replay.objectId) ?? node;
      if (state.treeNodes.some((item) => item.id === node.id) || state.courses.some((item) => item.id === node.id)) throw new Error("READWEAVE_TREE_NODE_EXISTS");
      const saved = structuredClone({ ...node, revision: node.revision ?? 0, children: [] });
      if (node.kind === "module" || node.kind === "material") {
        const courseId = this.courseIdForParent(state, node.parentId);
        const course = state.courses.find((item) => item.id === courseId);
        if (!course) throw new Error("READWEAVE_TREE_COURSE_NOT_FOUND");
        const projection = await this.ensureCourseScaffold(state, course.id, course.title, course.description);
        const parentNoteId = node.parentId ? this.parentNoteIdForTreeNode(state, projection, node.parentId) : await this.ensureWorkspaceContainer(state, "rootMaterialsNoteId", "00 工作区根材料");
        const moduleNote = await this.createNote(parentNoteId, node.title, `<p>Course OS 材料</p>`, "text", undefined, { courseOsType: "material", courseOsObjectId: node.id });
        saved.readweaveNoteId = moduleNote.noteId;
        projection.modules[node.materialId || node.id] = moduleNote.noteId;
        projection.moduleBranchIds ??= {};
        projection.moduleBranchIds[node.materialId || node.id] = moduleNote.branch.branchId;
      }
      state.treeNodes.push(saved);
      state.idempotency[context.idempotencyKey] = { kind: "tree_node", objectId: saved.id };
      return saved;
    });
    if (!result.applied) return this.createTreeNodeLegacy(node, context);
    await this.readBackMetadataTreeNode(result.value.id, result.value);
    return result.value;
  }

  private async createTreeNodeLegacy(node: CourseTreeNode, context: IdempotentWriteContext): Promise<CourseTreeNode> {
    const saved = await this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) return state.treeNodes.find((item) => item.id === replay.objectId) ?? node;
      if (state.treeNodes.some((item) => item.id === node.id) || state.courses.some((item) => item.id === node.id)) throw new Error("READWEAVE_TREE_NODE_EXISTS");
      const saved = structuredClone({ ...node, revision: node.revision ?? 0, children: [] });
      if (node.kind === "module" || node.kind === "material") {
        const courseId = this.courseIdForParent(state, node.parentId);
        const course = state.courses.find((item) => item.id === courseId);
        if (!course) throw new Error("READWEAVE_TREE_COURSE_NOT_FOUND");
        const projection = await this.ensureCourseScaffold(state, course.id, course.title, course.description);
        const parentNoteId = node.parentId ? this.parentNoteIdForTreeNode(state, projection, node.parentId) : await this.ensureWorkspaceContainer(state, "rootMaterialsNoteId", "00 工作区根材料");
        const moduleNote = await this.createNote(parentNoteId, node.title, `<p>Course OS 材料</p>`, "text", undefined, { courseOsType: "material", courseOsObjectId: node.id });
        saved.readweaveNoteId = moduleNote.noteId;
        projection.modules[node.materialId || node.id] = moduleNote.noteId;
        projection.moduleBranchIds ??= {};
        projection.moduleBranchIds[node.materialId || node.id] = moduleNote.branch.branchId;
      }
      state.treeNodes.push(saved);
      state.idempotency[context.idempotencyKey] = { kind: "tree_node", objectId: saved.id };
      return saved;
    }, context);
    return this.readBackTreeNode(saved.id, saved);
  }

  async updateTreeNode(nodeId: string, patch: { title?: string; parentId?: string | null; archived?: boolean; sortOrder?: number; currentReleaseId?: string }, expectedRevision: number, context: IdempotentWriteContext): Promise<CourseTreeNode> {
    const change = async (state: EtapiState): Promise<CourseTreeNode> => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) {
        const replayNode = state.treeNodes.find((item) => item.id === replay.objectId);
        if (replayNode) return structuredClone(replayNode);
        const replayCourse = state.courses.find((item) => item.id === replay.objectId);
        if (replayCourse) return { id: replayCourse.id, kind: "course", title: replayCourse.title, subtitle: replayCourse.description, status: replayCourse.status === "archived" ? "draft" : "published", archived: replayCourse.status === "archived", revision: replayCourse.revision ?? 0, readweaveNoteId: replayCourse.readweaveNoteId, children: [] } as CourseTreeNode;
        throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
      }
      if (isLegacyProjectionId(nodeId)) throw new Error("TREE_NODE_NOT_EDITABLE");
      const course = this.ensureCourseProject(state, nodeId);
      const node = state.treeNodes.find((item) => item.id === nodeId) ?? await this.ensureStableMaterialNode(state, nodeId);
      const currentRevision = course?.revision ?? node?.revision ?? 0;
      if (!course && !node) throw new Error("TREE_NODE_STALE");
      if (currentRevision !== expectedRevision) throw new Error("READWEAVE_TREE_NODE_REVISION_CONFLICT");
      if (patch.currentReleaseId !== undefined) {
        if (context.workspaceId !== this.workspaceId) throw new Error("READWEAVE_TREE_CURRENT_RELEASE_OWNERSHIP");
        const targetRelease = validateMaterialReleaseTarget(node, patch.currentReleaseId, state.courses, state.releases, state.drafts, this.workspaceId);
        node!.currentReleaseId = targetRelease.id;
        node!.releaseId = targetRelease.id;
        if (node!.kind === "material") {
          state.projections.materialReleaseSelections ??= {};
          state.projections.materialReleaseSelections[node!.materialId || node!.id] = { releaseId: targetRelease.id, source: "explicit" };
          node!.currentReleaseSelection = "explicit";
        }
      }
      if (course) {
        if (patch.title?.trim() && patch.title.trim() !== course.title) {
          if (!course.readweaveNoteId) course.readweaveNoteId = (await this.ensureCourseScaffold(state, course.id, course.title, course.description)).courseNoteId;
          await this.patchNoteTitle(course.readweaveNoteId, patch.title.trim());
          course.title = patch.title.trim();
        }
        if (typeof patch.archived === "boolean") course.status = patch.archived ? "archived" : "active";
        if (typeof patch.sortOrder === "number" && Number.isFinite(patch.sortOrder)) course.sortOrder = patch.sortOrder;
        course.revision = currentRevision + 1;
        course.updatedAt = new Date().toISOString();
        const saved: CourseTreeNode = { id: course.id, kind: "course", title: course.title, subtitle: course.description, status: course.status === "archived" ? "draft" : "published", archived: course.status === "archived", revision: course.revision, readweaveNoteId: course.readweaveNoteId, children: [] };
        if (node) Object.assign(node, saved); else state.treeNodes.push(saved);
        state.idempotency[context.idempotencyKey] = { kind: "tree_node", objectId: nodeId };
        return saved;
      }
      const moduleNoteId = node!.readweaveNoteId || this.findProjectedModuleNoteId(state, nodeId);
      if (patch.title?.trim() && patch.title.trim() !== node!.title) {
        if (moduleNoteId) await this.patchNoteTitle(moduleNoteId, patch.title.trim());
        node!.title = patch.title.trim();
      }
      if (patch.parentId !== undefined) {
        if (patch.parentId === nodeId) throw new Error("READWEAVE_TREE_PARENT_CYCLE");
        // A material may be restored to or reordered within the workspace root
        if (node?.kind === "material" && patch.parentId && !this.ensureCourseProject(state, patch.parentId)) throw new Error("TREE_TARGET_NOT_FOUND");
        if (node?.kind !== "material" && patch.parentId && !state.treeNodes.some((item) => item.id === patch.parentId) && !state.courses.some((item) => item.id === patch.parentId) && !isVirtualTreeParent(state, patch.parentId)) throw new Error("READWEAVE_TREE_PARENT_NOT_FOUND");
        if (moduleNoteId && patch.parentId !== node!.parentId) await this.moveProjectedNote(state, node!, moduleNoteId, patch.parentId);
        if (patch.parentId === null) delete node!.parentId;
        else node!.parentId = patch.parentId;
      }
      if (typeof patch.archived === "boolean") node!.archived = patch.archived;
      if (typeof patch.sortOrder === "number" && Number.isFinite(patch.sortOrder)) node!.sortOrder = patch.sortOrder;
      node!.revision = currentRevision + 1;
      state.idempotency[context.idempotencyKey] = { kind: "tree_node", objectId: nodeId };
      return structuredClone(node!);
    };
    const canUseMetadata = (state: EtapiState): boolean => {
      if (patch.currentReleaseId !== undefined) return false;
      const course = state.courses.some((item) => item.id === nodeId);
      const node = state.treeNodes.find((item) => item.id === nodeId);
      if (!course && !node) return false;
      if (patch.parentId !== undefined && patch.parentId !== null) {
        const knownParent = state.courses.some((item) => item.id === patch.parentId)
          || state.treeNodes.some((item) => item.id === patch.parentId)
          || isVirtualTreeParent(state, patch.parentId);
        if (!knownParent) return false;
      }
      return true;
    };
    const fast = await this.mutateMetadata(context, canUseMetadata, change);
    if (fast.applied) {
      await this.readBackMetadataTreeNode(fast.value.id, fast.value);
      return fast.value;
    }
    const saved = await this.mutate(change, context);
    return this.readBackTreeNode(saved.id, saved);
  }

  async duplicateTreeNode(nodeId: string, context: IdempotentWriteContext): Promise<CourseTreeNode> {
    const saved = await this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) return state.treeNodes.find((item) => item.id === replay.objectId) ?? ({ id: replay.objectId, kind: "page", title: "副本", children: [] } as CourseTreeNode);
      if (isLegacyProjectionId(nodeId)) throw new Error("TREE_NODE_NOT_EDITABLE");
      const sourceCourse = this.ensureCourseProject(state, nodeId);
      if (sourceCourse) {
        const copyId = `${nodeId}:copy:${Date.now()}`;
        const copyCourse: CourseProject = structuredClone({ ...sourceCourse, id: copyId, title: `${sourceCourse.title} 副本`, revision: 0, sortOrder: undefined, readweaveNoteId: undefined });
        const projection = await this.ensureCourseScaffold(state, copyCourse.id, copyCourse.title, copyCourse.description);
        copyCourse.readweaveNoteId = projection.courseNoteId;
        state.courses.push(copyCourse);
        const copy = courseNodeFromProject(copyCourse);
        state.idempotency[context.idempotencyKey] = { kind: "course", objectId: copy.id };
        return copy;
      }
      const source = state.treeNodes.find((item) => item.id === nodeId) ?? await this.ensureStableMaterialNode(state, nodeId);
      if (!source) throw new Error("TREE_NODE_STALE");
      const copyId = `${nodeId}:copy:${Date.now()}`;
      const copy: CourseTreeNode = structuredClone({ ...source, id: copyId, materialId: copyId, title: `${source.title} 副本`, revision: 0, archived: false, children: [], readweaveNoteId: undefined });
      const courseId = this.courseIdForNode(state, nodeId);
      const courseProjection = courseId ? state.projections.courses[courseId] : undefined;
      if (courseProjection) {
        const note = await this.createNote(courseProjection.materialsNoteId, copy.title, "<p>Course OS 材料草稿副本</p>", "text", undefined, { courseOsType: "material", courseOsObjectId: copy.id });
        copy.readweaveNoteId = note.noteId;
        courseProjection.modules[copy.id] = note.noteId;
        courseProjection.moduleBranchIds ??= {};
        courseProjection.moduleBranchIds[copy.id] = note.branch.branchId;
      }
      state.treeNodes.push(copy);
      state.idempotency[context.idempotencyKey] = { kind: "tree_node", objectId: copy.id };
      return copy;
    }, context);
    return this.readBackTreeNode(saved.id, saved);
  }

  async trashTreeNode(nodeId: string, context: IdempotentWriteContext): Promise<TrashRecord> {
    const change = async (state: EtapiState): Promise<TrashRecord> => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) {
        const replayTrash = state.trash.find((item) => item.id === replay.objectId);
        if (replayTrash) return replayTrash;
        throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
      }
      const existing = state.trash.find((item) => item.nodeId === nodeId && item.restoreAvailable);
      if (existing) return existing;
      if (isLegacyProjectionId(nodeId)) throw new Error("TREE_NODE_NOT_EDITABLE");
      const course = this.ensureCourseProject(state, nodeId);
      const node = state.treeNodes.find((item) => item.id === nodeId) ?? await this.ensureStableMaterialNode(state, nodeId);
      const projectedModuleNoteId = node?.kind === "module" ? this.findProjectedModuleNoteId(state, nodeId) : undefined;
      const courseProjection = course ? await this.ensureCourseScaffold(state, course.id, course.title, course.description) : undefined;
      const source = course ? { id: course.id, kind: "course" as const, title: course.title, parentId: undefined, readweaveNoteId: course.readweaveNoteId || courseProjection?.courseNoteId } : node ? { ...node, readweaveNoteId: node.readweaveNoteId || projectedModuleNoteId } : node;
      if (!source) throw new Error("TREE_NODE_STALE");
      const noteId = source.readweaveNoteId;
      if (noteId) {
        const trashRoot = await this.ensureWorkspaceContainer(state, "trashNoteId", "回收站");
        const sourceBranchId = courseProjection?.moduleBranchIds?.[nodeId] || (node ? await this.findBranchId(noteId) : undefined);
        const movedBranchId = await this.moveNoteToContainer(noteId, trashRoot, sourceBranchId);
        if (courseProjection && !course) {
          courseProjection.moduleBranchIds ??= {};
          courseProjection.moduleBranchIds[nodeId] = movedBranchId;
        }
      }
      // A recoverable delete only changes Course OS visibility; the ReadWeave note, attachments and revisions stay intact
      if (course) course.status = "archived";
      if (node) node.archived = true;
      if (course) course.revision = (course.revision ?? 0) + 1;
      if (node) node.revision = (node.revision ?? 0) + 1;
      const item: TrashRecord = { id: `trash:${nodeId}:${Date.now()}`, workspaceId: context.workspaceId, nodeId, nodeKind: source.kind, title: source.title, parentId: source.parentId, originalParentId: source.parentId, originalSortOrder: node?.sortOrder ?? course?.sortOrder, originalPath: treePath(state, nodeId), readweaveNoteId: noteId, snapshotHash: sha256(JSON.stringify(source)), deletedAt: new Date().toISOString(), deletedBy: context.actor, restoreAvailable: true, restoreMode: "original" };
      state.trash.push(item);
      state.idempotency[context.idempotencyKey] = { kind: "trash", objectId: item.id };
      return item;
    };
    const fast = await this.mutateMetadata(context, (state) => {
      if (state.idempotency[context.idempotencyKey]) return true;
      const existing = state.trash.find(item => item.nodeId === nodeId && item.restoreAvailable);
      if (existing) return !existing.readweaveNoteId || Boolean(state.projections.trashNoteId);
      const course = state.courses.find(item => item.id === nodeId);
      if (course) {
        const projection = state.projections.courses[course.id];
        return Boolean(projection && [projection.courseNoteId, projection.materialsNoteId, projection.qaNoteId,
          projection.reviewNoteId, projection.qualityNoteId, projection.releasesNoteId, projection.notesNoteId].every(Boolean));
      }
      const node = state.treeNodes.find(item => item.id === nodeId);
      return Boolean(node && (node.readweaveNoteId
        || (node.kind === "module" && this.findProjectedModuleNoteId(state, nodeId))));
    }, change, true);
    if (fast.applied) return this.readBackMetadataTrashRecord(fast.value);
    const saved = await this.mutate(change, context);
    const readBack = (await this.listTrash()).find((item) => item.id === saved.id);
    if (!readBack || readBack.nodeId !== saved.nodeId || readBack.snapshotHash !== saved.snapshotHash) throw new Error("READWEAVE_TREE_READBACK_FAILED");
    if (readBack.readweaveNoteId) {
      const state = await this.readState();
      const trashRoot = state.projections.trashNoteId;
      if (!trashRoot || !(await this.findBranchId(readBack.readweaveNoteId, trashRoot))) throw new Error("READWEAVE_TREE_TRASH_READBACK_FAILED");
    }
    return readBack;
  }

  private async readBackMetadataTrashRecord(expected: TrashRecord): Promise<TrashRecord> {
    const cached = this.metadataIndexCache;
    const located = cached && cached.expiresAt > Date.now() && cached.index.status === "active"
      ? { noteId: cached.noteId, index: cached.index } : await this.metadataIndexForRead();
    const readBack = located?.index.trash.find(item => item.id === expected.id);
    if (!readBack || readBack.nodeId !== expected.nodeId || readBack.workspaceId !== expected.workspaceId
      || readBack.snapshotHash !== expected.snapshotHash || readBack.deletedAt !== expected.deletedAt
      || readBack.readweaveNoteId !== expected.readweaveNoteId || readBack.restoreAvailable !== expected.restoreAvailable) {
      throw new Error("READWEAVE_TREE_READBACK_FAILED");
    }
    if (readBack.readweaveNoteId) {
      const trashRoot = located!.index.projections.trashNoteId;
      if (!trashRoot || !(await this.findBranchId(readBack.readweaveNoteId, trashRoot))) {
        throw new Error("READWEAVE_TREE_TRASH_READBACK_FAILED");
      }
    }
    return structuredClone(readBack);
  }

  async listTrash(): Promise<TrashRecord[]> {
    const metadata = await this.metadataIndexForRead();
    const trash = metadata?.index.trash ?? (await this.readStateReference(false, false)).trash;
    return structuredClone(trash.filter((item) => item.workspaceId === this.workspaceId || !item.workspaceId));
  }

  async restoreTrash(trashId: string, context: IdempotentWriteContext, options: { restoreMode?: "original" | "root" } = {}): Promise<CourseTreeNode> {
    const saved = await this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay?.kind === "restore") {
        const replayCourse = state.courses.find((candidate) => candidate.id === replay.objectId);
        if (replayCourse) return courseNodeFromProject(replayCourse);
        const replayNode = state.treeNodes.find((candidate) => candidate.id === replay.objectId && !candidate.archived);
        if (replayNode) return structuredClone(replayNode);
        throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
      }
      const item = state.trash.find((candidate) => candidate.id === trashId && candidate.restoreAvailable);
      if (!item) throw new Error("READWEAVE_TRASH_NOT_FOUND");
      const course = this.ensureCourseProject(state, item.nodeId);
      const node = state.treeNodes.find((candidate) => candidate.id === item.nodeId) ?? await this.ensureStableMaterialNode(state, item.nodeId);
      const originalParent = item.originalParentId ? this.ensureCourseProject(state, item.originalParentId) : undefined;
      const useOriginal = (options.restoreMode ?? item.restoreMode ?? "original") === "original" && Boolean(originalParent && originalParent.status !== "archived");
      const restoreMode = useOriginal ? "original" : "root";
      let targetNoteId: string | undefined;
      if (course) {
        targetNoteId = state.projections.courseRootNoteId;
      } else if (node) {
        if (useOriginal && originalParent) {
          const parentProjection = await this.ensureCourseScaffold(state, originalParent.id, originalParent.title, originalParent.description);
          node.parentId = originalParent.id;
          targetNoteId = parentProjection.materialsNoteId;
        } else {
          delete node.parentId;
          targetNoteId = await this.ensureWorkspaceContainer(state, "rootMaterialsNoteId", "00 工作区根材料");
        }
      }
      if (!course && !node) throw new Error("READWEAVE_TREE_STALE");
      if (item.readweaveNoteId && targetNoteId) await this.moveNoteToContainer(item.readweaveNoteId, targetNoteId);
      if (course) {
        course.status = "active";
        course.revision = (course.revision ?? 0) + 1;
        course.updatedAt = new Date().toISOString();
      }
      if (node) {
        node.archived = false;
        node.visibility = "library";
        node.revision = (node.revision ?? 0) + 1;
      }
      item.restoreMode = restoreMode;
      item.restoreAvailable = false;
      state.idempotency[context.idempotencyKey] = { kind: "restore", objectId: item.nodeId };
      return course ? courseNodeFromProject(course) : structuredClone(node!);
    }, context);
    const result = await this.readBackTreeNode(saved.id, saved);
    if (saved.readweaveNoteId) {
      const state = await this.readState();
      const targetNoteId = saved.kind === "course"
        ? state.projections.courseRootNoteId
        : saved.parentId
          ? state.projections.courses[saved.parentId]?.materialsNoteId
          : state.projections.rootMaterialsNoteId;
      if (!targetNoteId || !(await this.findBranchId(saved.readweaveNoteId, targetNoteId))) throw new Error("READWEAVE_TREE_RESTORE_READBACK_FAILED");
    }
    return result;
  }

  async previewTrashNativeErase(trashId: string, context: IdempotentWriteContext, expectedDeletedAt?: string,
    selector: { expectedSnapshotHash?: string; expectedRevision?: number } = {},
    options: Pick<TrashDeleteOptions, "checkExternalReferences"> = {}): Promise<TrashNativeErasePlan> {
    trashDeleteIdempotencyKey(context);
    if (context.workspaceId !== this.workspaceId) throw new Error("READWEAVE_TRASH_WORKSPACE_MISMATCH");
    const provisionalContext = { ...context, idempotencyKey: "native-erase-preflight:lookup" };
    const prepare = async (metadata: EtapiState): Promise<TrashNativeErasePlan> => {
      const item = metadata.trash.find(candidate => candidate.id === trashId);
      if (!item) throw new Error("READWEAVE_TRASH_NOT_FOUND");
      const deleteOptions: TrashDeleteOptions = { ...selector, expectedDeletedAt, ...options };
      const metadataScope = trashDeleteScope(metadata, item, context, deleteOptions);
      const key = nativeErasePreflightKey(item.workspaceId, item.id, item.snapshotHash ?? "");
      const existing = metadata.idempotency[key];
      if (existing) {
        if (existing.kind !== "native_erase_preflight") throw new Error("READWEAVE_NATIVE_ERASE_PREFLIGHT_CONFLICT");
        let saved: TrashNativeErasePlan;
        try { saved = JSON.parse(existing.objectId) as TrashNativeErasePlan; }
        catch { throw new Error("READWEAVE_NATIVE_ERASE_PREFLIGHT_CORRUPT"); }
        this.assertNativeErasePlanMetadataBindings(metadata, item, metadataScope, saved);
        const state = await this.readNativeEraseScopeState(metadata, item, context, deleteOptions);
        const scope = trashDeleteScope(state, item, context, deleteOptions);
        this.assertFrozenNativeErasePlan(state, item, scope, saved);
        await assertTrashReferencesSafe(state, scope, deleteOptions);
        const current = await this.makeTrashNativeErasePlan(state, item, scope);
        if (JSON.stringify([current.noteIds, current.rootNoteIds, current.rootBranchIds, current.branches])
          !== JSON.stringify([saved.noteIds, saved.rootNoteIds, saved.rootBranchIds, saved.branches])) {
          throw new Error("READWEAVE_NATIVE_ERASE_MAPPING_CHANGED");
        }
        await assertTrashReferencesSafe(state, scope, deleteOptions);
        return saved;
      }
      const state = await this.readNativeEraseScopeState(metadata, item, context, deleteOptions);
      const scope = trashDeleteScope(state, item, context, deleteOptions);
      await assertTrashReferencesSafe(state, scope, deleteOptions);
      const plan = await this.makeTrashNativeErasePlan(state, item, scope);
      await assertTrashReferencesSafe(state, scope, deleteOptions);
      // Native UI erase removes the live note graph before Course OS can
      // confirm it. Persist this small snapshot-bound receipt now so the
      // verifier can still bind logs to the pre-erase roots and branches.
      metadata.idempotency[key] = { kind: "native_erase_preflight", objectId: JSON.stringify(plan) };
      return plan;
    };
    const fast = await this.mutateMetadata(provisionalContext, () => true, prepare, true);
    if (fast.applied) return fast.value;
    const legacy = await this.mutateMetadata(provisionalContext, () => true, prepare);
    if (!legacy.applied) throw new Error("READWEAVE_METADATA_MUTATION_UNAVAILABLE");
    return legacy.value;
  }

  private async readNativeEraseScopeState(metadata: EtapiState, item: TrashRecord,
    context: IdempotentWriteContext, deleteOptions: TrashDeleteOptions): Promise<EtapiState> {
    const reference = await this.readStateReference(true, false);
    const state: EtapiState = {
      ...reference, courses: metadata.courses, treeNodes: metadata.treeNodes, trash: metadata.trash,
      drafts: [...reference.drafts], costEntries: [...reference.costEntries], conflicts: [...reference.conflicts],
      idempotency: { ...reference.idempotency, ...metadata.idempotency },
      projections: { ...reference.projections, ...metadata.projections,
        drafts: { ...reference.projections.drafts }, releases: reference.projections.releases }
    };
    // Scope/reference checks must observe current independent authorities even
    // when the large, otherwise unchanged core snapshot is already cached.
    const activityNoteId = state.projections.activityStateNoteId ?? await this.findActivityStateNoteId();
    if (activityNoteId) {
      const content = await this.getContent(activityNoteId);
      this.applyActivityState(state, this.activityStateFrom(decodeReadWeaveStateContent(content) as Partial<EtapiActivityState>));
    }
    // Existing positive protection can reject before downloading every draft.
    // An unchecked scope still needs the complete fresh scan and later checks.
    const knownScope = trashDeleteScope(state, item, context, deleteOptions);
    await assertTrashReferencesSafe(state, knownScope, deleteOptions);
    const freshRecords = await this.readDraftPageRecords();
    const freshPageIds = new Set(freshRecords.map(located => located.record.pageId));
    for (const pageId of knownScope.pageIds) {
      if (!freshPageIds.has(pageId)) this.draftPageRecordCache.delete(pageId);
    }
    for (const located of this.draftPageRecordCache.values()) this.mergeDraftPageRecord(state, located.record);
    return state;
  }

  async permanentlyDeleteTrash(trashId: string, context: IdempotentWriteContext, expectedDeletedAt?: string, options: TrashDeleteOptions = {}): Promise<void> {
    trashDeleteIdempotencyKey(context);
    if (context.workspaceId !== this.workspaceId) throw new Error("READWEAVE_TRASH_WORKSPACE_MISMATCH");
    const verifier = this.config.verifyNativeErase;
    if (!verifier) throw new Error("READWEAVE_PERMANENT_DELETE_UNSUPPORTED");
    if (!expectedDeletedAt || !options.expectedSnapshotHash) throw new Error("READWEAVE_TRASH_SNAPSHOT_REQUIRED");
    const deleteOptions = { ...options, expectedDeletedAt };
    const fast = await this.mutateMetadata(context, () => true, async (metadata) => {
      if (trashDeleteReplay(metadata, trashId, context, deleteOptions)) return true;
      const item = metadata.trash.find(candidate => candidate.id === trashId);
      if (!item) return false;
      const state = await this.readNativeEraseScopeState(metadata, item, context, deleteOptions);
      const scope = trashDeleteScope(state, item, context, deleteOptions);
      // A scope with any core release/page authority still needs the existing
      // full-state prune and readback. Only metadata-only scopes use this path.
      if (scope.releaseIds.length || scope.pageIds.length) return false;
      const preflight = metadata.idempotency[nativeErasePreflightKey(item.workspaceId, item.id, item.snapshotHash ?? "")];
      if (!preflight || preflight.kind !== "native_erase_preflight") throw new Error("READWEAVE_NATIVE_ERASE_PREFLIGHT_REQUIRED");
      let plan: TrashNativeErasePlan;
      try { plan = JSON.parse(preflight.objectId) as TrashNativeErasePlan; }
      catch { throw new Error("READWEAVE_NATIVE_ERASE_PREFLIGHT_CORRUPT"); }
      this.assertFrozenNativeErasePlan(state, item, scope, plan);
      const physicalIds = new Set(plan.noteIds);
      if (Object.values(state.projections.releases).some(id => physicalIds.has(id))
        || Object.values(state.projections.drafts).some(projection =>
          [projection.pageNoteId, projection.sourceNoteId, projection.atomsNoteId, projection.sourceImageNoteId,
            ...Object.values(projection.blockNoteIds), ...Object.values(projection.sectionNoteIds)]
            .some(id => id && physicalIds.has(id)))) return false;
      await assertTrashReferencesSafe(state, scope, deleteOptions);
      await this.verifyTrashNativeErase(state, item, scope);
      const nodeIds = new Set(scope.nodeIds);
      const materialIds = new Set(metadata.treeNodes.filter(node => nodeIds.has(node.id)).map(node => node.materialId ?? node.id));
      metadata.courses = metadata.courses.filter(course => !scope.courseIds.includes(course.id));
      metadata.treeNodes = metadata.treeNodes.filter(node => !nodeIds.has(node.id));
      metadata.trash = metadata.trash.filter(record => record.id !== trashId && !nodeIds.has(record.nodeId));
      for (const id of [...scope.courseIds, ...nodeIds]) delete metadata.projections.courses[id];
      for (const projection of Object.values(metadata.projections.courses)) for (const key of Object.keys(projection.modules)) {
        if (nodeIds.has(key) || materialIds.has(key)) {
          delete projection.modules[key]; delete projection.moduleBranchIds?.[key];
        }
      }
      for (const key of Object.keys(metadata.projections.materialReleaseSelections ?? {})) {
        if (nodeIds.has(key) || materialIds.has(key)) delete metadata.projections.materialReleaseSelections![key];
      }
      metadata.idempotency[trashDeleteIdempotencyKey(context)] = {
        kind: "permanent_delete", objectId: JSON.stringify([trashId, deleteOptions.expectedDeletedAt, deleteOptions.expectedSnapshotHash])
      };
      return true;
    }, true);
    if (fast.applied && fast.value) return;
    let confirmedPlan: TrashNativeErasePlan | undefined;
    let confirmedNodeIds: string[] = [];
    let confirmedPageIds: string[] = [];
    this.invalidateStateCache();
    await this.mutate(async (state) => {
      if (trashDeleteReplay(state, trashId, context, deleteOptions)) return;
      const index = state.trash.findIndex(candidate => candidate.id === trashId);
      if (index < 0) throw new Error("READWEAVE_TRASH_NOT_FOUND");
      const item = state.trash[index]!;
      const scope = trashDeleteScope(state, item, context, deleteOptions);
      confirmedNodeIds = [...scope.nodeIds];
      confirmedPageIds = [...scope.pageIds];
      await assertTrashReferencesSafe(state, scope, deleteOptions);
      const plan = await this.verifyTrashNativeErase(state, item, scope);
      confirmedPlan = plan;
      const releaseIds = new Set(scope.releaseIds);
      const nodeIds = new Set(scope.nodeIds);
      const materials = new Set(state.treeNodes.filter(node => nodeIds.has(node.id)).map(node => node.materialId ?? node.id));
      const removedDrafts = state.drafts.filter(draft => scope.courseIds.includes(draft.courseId)
        || releaseIds.has(draft.sourceReleaseId) || nodeIds.has(draft.moduleId)
        || materials.has(stableMaterialId(draft.courseId, draft.moduleId)));
      const removedDraftIds = new Set(removedDrafts.map(draft => draft.id));
      const removedPageIds = new Set(removedDrafts.map(draft => draft.pageId));
      state.courses = state.courses.filter(course => !scope.courseIds.includes(course.id));
      state.releases = state.releases.filter(release => !releaseIds.has(release.id));
      state.manifests = state.manifests.filter(manifest => !releaseIds.has(manifest.courseReleaseId));
      state.drafts = state.drafts.filter(draft => !removedDraftIds.has(draft.id));
      state.questions = state.questions.filter(question => !releaseIds.has(question.courseReleaseId));
      state.treeNodes = state.treeNodes.filter(node => !nodeIds.has(node.id));
      state.trash = state.trash.filter(record => record.id !== trashId && !nodeIds.has(record.nodeId));
      for (const id of scope.courseIds) delete state.projections.courses[id];
      for (const id of nodeIds) delete state.projections.courses[id];
      for (const id of releaseIds) delete state.projections.releases[id];
      for (const id of removedDraftIds) delete state.projections.drafts[id];
      if (state.projections.materialReleaseSelections) {
        for (const key of Object.keys(state.projections.materialReleaseSelections)) if (materials.has(key) || nodeIds.has(key)) delete state.projections.materialReleaseSelections[key];
      }
      // Draft page records are independent authorities. Stop stale in-process
      // copies from being merged into the next core snapshot after native erase.
      for (const pageId of removedPageIds) {
        this.draftPageRecordCache.delete(pageId);
        this.draftReadCache.delete(pageId);
      }
      state.idempotency[trashDeleteIdempotencyKey(context)] = {
        kind: "permanent_delete",
        objectId: JSON.stringify([trashId, deleteOptions.expectedDeletedAt, deleteOptions.expectedSnapshotHash])
      };
    }, context);
    this.invalidateStateCache();
    const readBack = structuredClone(await this.readStateReference(true));
    await this.mergeDraftPageRecords(readBack);
    if (readBack.trash.some(record => record.id === trashId)
      || (confirmedPlan && (readBack.courses.some(course => confirmedNodeIds.includes(course.id))
        || readBack.treeNodes.some(node => confirmedNodeIds.includes(node.id))
        || readBack.drafts.some(draft => confirmedPageIds.includes(draft.pageId))))) {
      throw new Error("READWEAVE_TRASH_DELETE_READBACK_FAILED");
    }
  }

  private async verifyTrashNativeErase(state: EtapiState, item: TrashRecord, scope: TrashDeleteScope): Promise<TrashNativeErasePlan> {
    const preflight = state.idempotency[nativeErasePreflightKey(item.workspaceId, item.id, item.snapshotHash ?? "")];
    if (!preflight || preflight.kind !== "native_erase_preflight") throw new Error("READWEAVE_NATIVE_ERASE_PREFLIGHT_REQUIRED");
    let plan: TrashNativeErasePlan;
    try { plan = JSON.parse(preflight.objectId) as TrashNativeErasePlan; }
    catch { throw new Error("READWEAVE_NATIVE_ERASE_PREFLIGHT_CORRUPT"); }
    this.assertFrozenNativeErasePlan(state, item, scope, plan);
    let affirmative: boolean;
    try { affirmative = await this.config.verifyNativeErase!(structuredClone(plan)); }
    catch { throw new Error("READWEAVE_NATIVE_ERASE_UNVERIFIED"); }
    if (affirmative !== true) throw new Error("READWEAVE_NATIVE_ERASE_UNVERIFIED");
    for (const noteId of plan.noteIds) {
      try { await this.getNote(noteId); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("READWEAVE_ETAPI_404:")) throw error;
        continue;
      }
      throw new Error("READWEAVE_NATIVE_ERASE_READBACK_FAILED");
    }
    return plan;
  }

  async getTrashCapabilities(): Promise<{
    directPermanentDelete: false;
    requiresNativeUi: true;
    canConfirmNativeErase: boolean;
    reason: "READWEAVE_NATIVE_ERASE_REQUIRED";
  }> {
    return {
      directPermanentDelete: false,
      requiresNativeUi: true,
      canConfirmNativeErase: Boolean(this.config.verifyNativeErase),
      reason: "READWEAVE_NATIVE_ERASE_REQUIRED"
    };
  }

  private assertNativeErasePlanMetadataBindings(state: EtapiState, item: TrashRecord, scope: TrashDeleteScope, plan: TrashNativeErasePlan): Set<string> {
    const node = state.courses.find(candidate => candidate.id === item.nodeId)
      ?? state.treeNodes.find(candidate => candidate.id === item.nodeId);
    if (plan.trashId !== item.id || plan.workspaceId !== item.workspaceId || plan.nodeId !== item.nodeId
      || plan.deletedAt !== item.deletedAt || plan.snapshotHash !== item.snapshotHash
      || plan.revision !== (node?.revision ?? 0) || plan.workspaceId !== this.workspaceId) {
      throw new Error("READWEAVE_TRASH_CHANGED");
    }
    if (!Array.isArray(plan.noteIds) || !Array.isArray(plan.rootNoteIds) || !plan.rootBranchIds || !Array.isArray(plan.nativeLinks)) {
      throw new Error("READWEAVE_NATIVE_ERASE_PREFLIGHT_CORRUPT");
    }
    const expected = new Set<string>();
    const add = (id?: string) => { if (id) expected.add(id); };
    add(item.readweaveNoteId);
    for (const courseId of scope.courseIds) {
      const course = state.courses.find(candidate => candidate.id === courseId);
      const projection = state.projections.courses[courseId];
      add(course?.readweaveNoteId);
      if (!projection) throw new Error("READWEAVE_NATIVE_ERASE_MAPPING_CHANGED");
      for (const id of [projection.courseNoteId, projection.materialsNoteId, projection.qaNoteId, projection.reviewNoteId,
        projection.qualityNoteId, projection.releasesNoteId, projection.notesNoteId]) add(id);
      for (const [nodeId, id] of Object.entries(projection.modules)) if (scope.nodeIds.includes(nodeId)
        || state.treeNodes.some(treeNode => scope.nodeIds.includes(treeNode.id) && (treeNode.materialId || treeNode.id) === nodeId)) add(id);
    }
    for (const treeNode of state.treeNodes) if (scope.nodeIds.includes(treeNode.id)) {
      add(treeNode.readweaveNoteId);
      const key = treeNode.materialId || treeNode.id;
      for (const projection of Object.values(state.projections.courses)) add(projection.modules[key]);
    }
    const frozenIds = new Set(plan.noteIds);
    if (frozenIds.size !== plan.noteIds.length || [...expected].some(id => !frozenIds.has(id))) {
      throw new Error("READWEAVE_NATIVE_ERASE_MAPPING_CHANGED");
    }
    if (!item.readweaveNoteId || !plan.rootNoteIds.includes(item.readweaveNoteId)) {
      throw new Error("READWEAVE_NATIVE_ERASE_PREFLIGHT_CORRUPT");
    }
    return expected;
  }

  private assertFrozenNativeErasePlan(state: EtapiState, item: TrashRecord, scope: TrashDeleteScope, plan: TrashNativeErasePlan): void {
    const expected = this.assertNativeErasePlanMetadataBindings(state, item, scope, plan);
    if (!plan.rootBranchIds) throw new Error("READWEAVE_NATIVE_ERASE_PREFLIGHT_CORRUPT");
    const add = (id?: string) => { if (id) expected.add(id); };
    for (const releaseId of scope.releaseIds) {
      const id = state.projections.releases[releaseId];
      if (!id) {
        const release = state.releases.find(candidate => candidate.id === releaseId);
        // registerDraftSource creates catalog authority without a published note.
        if (release?.lifecycle === "draft_source" && !state.manifests.some(manifest => manifest.courseReleaseId === releaseId)) continue;
        throw new Error("READWEAVE_NATIVE_ERASE_MAPPING_CHANGED");
      }
      add(id);
    }
    for (const draft of state.drafts) if (scope.pageIds.includes(draft.pageId)) {
      add(draft.readweaveNoteId);
      const projection = state.projections.drafts[draft.id];
      if (!projection) throw new Error("READWEAVE_NATIVE_ERASE_MAPPING_CHANGED");
      for (const id of [projection.pageNoteId, projection.sourceNoteId, projection.atomsNoteId, projection.sourceImageNoteId,
        ...Object.values(projection.blockNoteIds), ...Object.values(projection.sectionNoteIds)]) add(id);
    }
    const frozenIds = new Set(plan.noteIds);
    if (frozenIds.size !== plan.noteIds.length || [...expected].some(id => !frozenIds.has(id))) {
      throw new Error("READWEAVE_NATIVE_ERASE_MAPPING_CHANGED");
    }
    const roots = new Set(plan.rootNoteIds);
    if (roots.size !== plan.rootNoteIds.length || [...roots].some(id => !frozenIds.has(id))
      || !item.readweaveNoteId || !roots.has(item.readweaveNoteId)
      || Object.keys(plan.rootBranchIds).length !== roots.size) throw new Error("READWEAVE_NATIVE_ERASE_PREFLIGHT_CORRUPT");
    const linkIds = new Set(plan.nativeLinks.map(link => link.noteId));
    if (linkIds.size !== roots.size || [...roots].some(id => !linkIds.has(id)
      || plan.nativeLinks.find(link => link.noteId === id)?.url !== `${trustedPublicBase(this.config.publicUrl || "https://readweave.example.com").origin}/#root/${encodeURIComponent(id)}`)) {
      throw new Error("READWEAVE_NATIVE_ERASE_PREFLIGHT_CORRUPT");
    }
    const branchRecords = plan.branches ?? [];
    const branchById = new Map(branchRecords.map(branch => [branch.branchId, branch]));
    if (branchById.size !== branchRecords.length) throw new Error("READWEAVE_NATIVE_ERASE_PREFLIGHT_CORRUPT");
    for (const root of roots) {
      const branchIds = plan.rootBranchIds[root];
      if (!Array.isArray(branchIds) || branchIds.length === 0 || new Set(branchIds).size !== branchIds.length
        || branchIds.some(id => branchById.get(id)?.noteId !== root)) throw new Error("READWEAVE_NATIVE_ERASE_PREFLIGHT_CORRUPT");
    }
    const releaseNoteIds = new Set(scope.releaseIds.map(id => state.projections.releases[id]).filter((id): id is string => Boolean(id)));
    const allowedReleaseParents = new Set(scope.releaseIds.flatMap(id => {
      const release = state.releases.find(candidate => candidate.id === id);
      const parent = release && state.projections.courses[release.courseId]?.releasesNoteId;
      return parent ? [parent] : [];
    }));
    const hasInvalidParent = branchRecords.some(branch => {
      if (!frozenIds.has(branch.noteId) || frozenIds.has(branch.parentNoteId)) return !frozenIds.has(branch.noteId);
      const isTrashRoot = branch.noteId === item.readweaveNoteId && branch.parentNoteId === state.projections.trashNoteId;
      const isDraftRecordRoot = roots.has(branch.noteId) && branch.parentNoteId === state.projections.stateNoteId;
      const isScopedReleaseRoot = releaseNoteIds.has(branch.noteId) && allowedReleaseParents.has(branch.parentNoteId);
      return !isTrashRoot && !isDraftRecordRoot && !isScopedReleaseRoot;
    });
    if (hasInvalidParent) {
      throw new Error("READWEAVE_TRASH_SHARED_REFERENCE");
    }
    const children = new Map<string, string[]>();
    for (const branch of branchRecords) if (frozenIds.has(branch.parentNoteId)) {
      const list = children.get(branch.parentNoteId) ?? [];
      list.push(branch.noteId);
      children.set(branch.parentNoteId, list);
    }
    const reachable = new Set(roots);
    const pending = [...roots];
    while (pending.length) for (const child of children.get(pending.pop()!) ?? []) if (!reachable.has(child)) {
      reachable.add(child); pending.push(child);
    }
    if (plan.noteIds.some(id => !reachable.has(id))) throw new Error("READWEAVE_NATIVE_ERASE_PREFLIGHT_CORRUPT");
  }

  private async makeTrashNativeErasePlan(state: EtapiState, item: TrashRecord, scope: TrashDeleteScope): Promise<TrashNativeErasePlan> {
    if (!item.snapshotHash) throw new Error("READWEAVE_TRASH_SNAPSHOT_REQUIRED");
    if (!item.readweaveNoteId) throw new Error("READWEAVE_NATIVE_ERASE_MAPPING_INCOMPLETE");
    const noteIds = new Set<string>();
    const add = (noteId: string | undefined) => {
      if (!noteId?.trim()) return;
      noteIds.add(noteId);
    };
    add(item.readweaveNoteId);
    for (const courseId of scope.courseIds) {
      const course = state.courses.find(candidate => candidate.id === courseId);
      const projection = state.projections.courses[courseId];
      if (!projection || [projection.courseNoteId, projection.materialsNoteId, projection.qaNoteId,
        projection.reviewNoteId, projection.qualityNoteId, projection.releasesNoteId, projection.notesNoteId].some(id => !id)) {
        throw new Error("READWEAVE_NATIVE_ERASE_MAPPING_INCOMPLETE");
      }
      add(course?.readweaveNoteId);
      for (const noteId of [projection.courseNoteId, projection.materialsNoteId, projection.qaNoteId,
        projection.reviewNoteId, projection.qualityNoteId, projection.releasesNoteId, projection.notesNoteId]) add(noteId);
      for (const [nodeId, noteId] of Object.entries(projection.modules)) if (scope.nodeIds.includes(nodeId)
        || [...state.treeNodes].some(node => scope.nodeIds.includes(node.id) && (node.materialId || node.id) === nodeId)) add(noteId);
    }
    for (const node of state.treeNodes) if (scope.nodeIds.includes(node.id)) {
      add(node.readweaveNoteId);
      const materialKey = node.materialId || node.id;
      for (const projection of Object.values(state.projections.courses)) add(projection.modules[materialKey]);
      if ((node.kind === "module" || node.kind === "material") && !node.readweaveNoteId
        && !Object.values(state.projections.courses).some(projection => projection.modules[materialKey])) {
        throw new Error("READWEAVE_NATIVE_ERASE_MAPPING_INCOMPLETE");
      }
    }
    const releaseNotes: string[] = [];
    for (const releaseId of scope.releaseIds) {
      const noteId = state.projections.releases[releaseId];
      if (!noteId) {
        const release = state.releases.find(candidate => candidate.id === releaseId);
        if (release?.lifecycle === "draft_source" && !state.manifests.some(manifest => manifest.courseReleaseId === releaseId)) continue;
        throw new Error("READWEAVE_NATIVE_ERASE_MAPPING_INCOMPLETE");
      }
      add(noteId); releaseNotes.push(noteId);
    }
    const pageIds = new Set(scope.pageIds);
    for (const draft of state.drafts) if (pageIds.has(draft.pageId)) {
      add(draft.readweaveNoteId);
      const projection = state.projections.drafts[draft.id];
      if (!projection) throw new Error("READWEAVE_NATIVE_ERASE_MAPPING_INCOMPLETE");
      for (const noteId of [projection.pageNoteId, projection.sourceNoteId, projection.atomsNoteId, projection.sourceImageNoteId,
        ...Object.values(projection.blockNoteIds), ...Object.values(projection.sectionNoteIds)]) add(noteId);
      const record = this.draftPageRecordCache.get(draft.pageId);
      if (!record) {
        // Legacy core drafts need no independent record, but skipped malformed
        // records are not proof of absence. Check this affected page's headers.
        const title = `Course OS draft record · ${draft.pageId}`;
        const query = new URLSearchParams({ search: quoteSearchValue(title), ancestorNoteId: this.config.parentNoteId,
          ancestorDepth: "lt5", fastSearch: "true" });
        const byTitle = await this.request<SearchResponse>(`/notes?${query.toString()}`);
        const byLabel = await this.searchDraftRecordLabel(this.config.parentNoteId, "courseOsDraftRecordPageId", draft.pageId);
        if (!Array.isArray(byTitle.results) || byTitle.results.some(note => note.title === title) || byLabel.size) {
          throw new Error("READWEAVE_NATIVE_ERASE_MAPPING_INCOMPLETE");
        }
        continue;
      }
      add(record.noteId);
      add(record.record.draft.readweaveNoteId);
      for (const noteId of [record.record.projection.pageNoteId, record.record.projection.sourceNoteId,
        record.record.projection.atomsNoteId, record.record.projection.sourceImageNoteId,
        ...Object.values(record.record.projection.blockNoteIds), ...Object.values(record.record.projection.sectionNoteIds)]) add(noteId);
    }
    if (noteIds.size === 0 || (item.readweaveNoteId && !noteIds.has(item.readweaveNoteId))) {
      throw new Error("READWEAVE_NATIVE_ERASE_MAPPING_INCOMPLETE");
    }
    const releaseNoteIds = new Set(releaseNotes);
    // Freeze the full ETAPI-owned descendant closure, including historical/non-current blocks
    // that are no longer represented by current course or draft projections.
    const pendingNotes = [...noteIds];
    const scannedNotes = new Map<string, EtapiNote>();
    while (pendingNotes.length) {
      const noteId = pendingNotes.pop()!;
      if (scannedNotes.has(noteId)) continue;
      let note: EtapiNote;
      try { note = await this.getNote(noteId); }
      catch { throw new Error("READWEAVE_NATIVE_ERASE_MAPPING_INCOMPLETE"); }
      scannedNotes.set(noteId, note);
      if (!Array.isArray(note.childNoteIds)) throw new Error("READWEAVE_NATIVE_ERASE_CHILD_MAPPING_INCOMPLETE");
      for (const childId of note.childNoteIds) {
        if (typeof childId !== "string" || !childId.trim()) throw new Error("READWEAVE_NATIVE_ERASE_CHILD_MAPPING_INCOMPLETE");
        if (!noteIds.has(childId)) { noteIds.add(childId); pendingNotes.push(childId); }
      }
    }
    const orderedNoteIds = [...noteIds].sort();
    const externalRoots = new Set<string>();
    const branches: Array<{ branchId: string; noteId: string; parentNoteId: string }> = [];
    const links = new Map<string, { noteId: string; url: string; title: string }>();
    const base = trustedPublicBase(this.config.publicUrl || "https://readweave.example.com");
    for (const noteId of orderedNoteIds) {
      const note = scannedNotes.get(noteId)!;
      links.set(noteId, { noteId, url: `${base.origin}/#root/${encodeURIComponent(noteId)}`, title: note.title });
      const parentBranchIds = [...new Set(note.parentBranchIds ?? [])];
      if (parentBranchIds.length === 0) throw new Error("READWEAVE_NATIVE_ERASE_BRANCH_MAPPING_INCOMPLETE");
      for (const branchId of parentBranchIds) {
        let branch: EtapiBranch;
        try { branch = await this.getBranch(branchId); }
        catch { throw new Error("READWEAVE_NATIVE_ERASE_BRANCH_MAPPING_INCOMPLETE"); }
        const isOwnedParent = noteIds.has(branch.parentNoteId);
        const isTrashRoot = noteId === item.readweaveNoteId && branch.parentNoteId === state.projections.trashNoteId;
        const isDraftRecordRoot = [...this.draftPageRecordCache.values()].some(record => pageIds.has(record.record.pageId)
          && record.noteId === noteId) && branch.parentNoteId === state.projections.stateNoteId;
        const isScopedReleaseParent = releaseNoteIds.has(noteId) && scope.releaseIds.some(releaseId => {
          const release = state.releases.find(candidate => candidate.id === releaseId);
          return release && state.projections.courses[release.courseId]?.releasesNoteId === branch.parentNoteId;
        });
        if (branch.noteId !== noteId || (!isOwnedParent && !isTrashRoot && !isDraftRecordRoot && !isScopedReleaseParent)) throw new Error("READWEAVE_TRASH_SHARED_REFERENCE");
        branches.push({ branchId, noteId, parentNoteId: branch.parentNoteId });
        if (!noteIds.has(branch.parentNoteId)) externalRoots.add(noteId);
      }
    }
    const rootNoteIds = [...new Set([item.readweaveNoteId, ...externalRoots]
      .filter((value): value is string => typeof value === "string" && noteIds.has(value)))].sort();
    if (rootNoteIds.length === 0) throw new Error("READWEAVE_NATIVE_ERASE_ROOTS_MISSING");
    const rootBranchIds: Record<string, string[]> = {};
    for (const rootNoteId of rootNoteIds) {
      const ids = branches.filter(branch => branch.noteId === rootNoteId).map(branch => branch.branchId).sort();
      if (ids.length === 0) throw new Error("READWEAVE_NATIVE_ERASE_BRANCH_MAPPING_INCOMPLETE");
      rootBranchIds[rootNoteId] = ids;
    }
    const node = state.courses.find(candidate => candidate.id === item.nodeId)
      ?? state.treeNodes.find(candidate => candidate.id === item.nodeId);
    return {
      trashId: item.id,
      workspaceId: item.workspaceId,
      nodeId: item.nodeId,
      deletedAt: item.deletedAt,
      snapshotHash: item.snapshotHash,
      revision: node?.revision ?? 0,
      rootNoteIds,
      rootBranchIds,
      nativeLinks: rootNoteIds.map(noteId => links.get(noteId)!).sort((left, right) => left.noteId.localeCompare(right.noteId)),
      noteIds: orderedNoteIds,
      branches: branches.sort((left, right) => left.branchId.localeCompare(right.branchId))
    };
  }

  /** Run or resume the one-time legacy metadata split and return its active authority. */
  async ensureMetadataIndex(): Promise<{ noteId: string; revision: number; status: "active" }> {
    return this.enqueueWrite(async () => {
      const located = await this.metadataIndexForMutation();
      if (located.index.status !== "active") throw new Error("READWEAVE_METADATA_MIGRATION_NOT_ACTIVE");
      return { noteId: located.noteId, revision: located.index.revision, status: "active" };
    });
  }

  /** Rebuild the legacy root snapshot from the current core and metadata overlay before retiring the split. */
  async prepareMetadataRollback(): Promise<void> {
    await this.enqueueWrite(async () => {
      this.metadataIndexCache = undefined;
      this.invalidateStateCache();
      const root = await this.readRawState();
      const pointer = root.projections.metadataIndexNoteId;
      let located: LocatedMetadataIndex | undefined;
      if (pointer) {
        located = await this.readMetadataIndex(pointer);
      } else {
        located = await this.findMetadataMigration(metadataMigrationId(this.workspaceId, root.projections.stateNoteId));
        if (!located) return;
        if (located.index.status === "rolled_back") return;
        if (located.index.status === "active" && JSON.stringify(metadataPayload(root)) !== JSON.stringify(metadataPayload(located.index))) {
          throw new Error("READWEAVE_METADATA_ROLLBACK_ROOT_MISMATCH");
        }
      }
      if (located.index.workspaceId !== this.workspaceId || located.index.stateNoteId !== root.projections.stateNoteId) {
        throw new Error("READWEAVE_METADATA_INDEX_SOURCE_MISMATCH");
      }
      if (located.index.status === "rolled_back") {
        if (pointer) throw new Error("READWEAVE_METADATA_ROLLBACK_POINTER_REMAINS");
        return;
      }
      if (located.index.status !== "active" && located.index.status !== "staged" && located.index.status !== "rolling_back") {
        throw new Error("READWEAVE_METADATA_ROLLBACK_NOT_ACTIVE");
      }

      if (located.index.status !== "rolling_back") {
        const rollingBack = {
          ...located.index,
          status: "rolling_back" as const,
          revision: located.index.revision + 1,
          migration: { ...located.index.migration, phase: "rolling_back" as const }
        };
        located = await this.writeMetadataIndex(located, rollingBack, located.index.revision);
      }

      const currentRoot = await this.readRawState();
      if (currentRoot.projections.stateNoteId !== located.index.stateNoteId
        || (currentRoot.projections.metadataIndexNoteId && currentRoot.projections.metadataIndexNoteId !== located.noteId)) {
        throw new Error("READWEAVE_METADATA_ROLLBACK_ROOT_MISMATCH");
      }

      const restored = applyMetadataIndex(currentRoot, located.index, located.noteId);
      delete restored.projections.metadataIndexNoteId;
      delete restored.projections.metadataIndexRevision;
      const content = await encodeReadWeaveStateContentAsync(restored);
      await this.putContent(currentRoot.projections.stateNoteId, content);
      const readBackContent = await this.getContent(currentRoot.projections.stateNoteId);
      if (readBackContent !== content) throw new Error("READWEAVE_METADATA_ROLLBACK_READBACK_FAILED");
      const readBack = normalizeState(await decodeReadWeaveStateContentAsync(readBackContent) as Partial<EtapiState>, currentRoot.projections);
      if (readBack.projections.metadataIndexNoteId || JSON.stringify(metadataPayload(readBack)) !== JSON.stringify(metadataPayload(located.index))) {
        throw new Error("READWEAVE_METADATA_ROLLBACK_READBACK_FAILED");
      }

      const retired = {
        ...located.index,
        status: "rolled_back" as const,
        revision: located.index.revision + 1,
        migration: { ...located.index.migration, phase: "rolled_back" as const }
      };
      const committed = await this.writeMetadataIndex(located, retired, located.index.revision);
      this.metadataIndexCache = undefined;
      this.invalidateStateCache();
      if (committed.index.status !== "rolled_back") throw new Error("READWEAVE_METADATA_ROLLBACK_READBACK_FAILED");
    });
  }

  async getTreeNodeProperties(nodeId: string): Promise<TreeNodeProperties | undefined> {
    const nodes = await this.listTreeNodes();
    const node = nodes.find((item) => item.id === nodeId);
    if (!node) return undefined;
    const readweaveUrl = node.readweaveNoteId ? (await this.getDeepLink(node.readweaveNoteId))?.url : undefined;
    return {
      nodeId: node.id,
      kind: node.kind,
      title: node.title,
      subtitle: node.subtitle,
      revision: node.revision ?? 0,
      sortOrder: node.sortOrder,
      readweaveNoteId: node.readweaveNoteId,
      readweaveUrl,
      syncState: "connected",
      pageCount: node.pageCount ?? (node.kind === "release" ? node.subtitle?.match(/(\d+)\s*页/)?.[1] ? Number(node.subtitle.match(/(\d+)\s*页/)?.[1]) : undefined : node.children.length || undefined)
    };
  }

  private async readBackTreeNode(nodeId: string, expected: CourseTreeNode): Promise<CourseTreeNode> {
    // The successful state write already committed and cached the exact object
    // owned by the serialized mutation. Rebuilding every virtual release node
    // here scans and clones the multi-megabyte state after each small tree edit.
    const state = await this.readStateReference(true);
    const stored = state.treeNodes.find((candidate) => candidate.id === nodeId);
    const course = state.courses.find((candidate) => candidate.id === nodeId);
    const node = stored ?? (course ? courseNodeFromProject(course) : undefined);
    if (!node || node.title !== expected.title || node.parentId !== expected.parentId || (expected.revision !== undefined && node.revision !== expected.revision)) throw new Error("READWEAVE_TREE_READBACK_FAILED");
    if (expected.currentReleaseId !== undefined && node.currentReleaseId !== expected.currentReleaseId) throw new Error("READWEAVE_TREE_READBACK_FAILED");
    if (expected.readweaveNoteId && node.readweaveNoteId !== expected.readweaveNoteId) throw new Error("READWEAVE_TREE_IDENTITY_READBACK_FAILED");
    if (node.readweaveNoteId) await this.getNote(node.readweaveNoteId);
    return node;
  }

  async getDeepLink(noteId: string): Promise<ReadWeaveDeepLink | undefined> {
    // Link ownership needs projection metadata, not every page's teaching body
    // or the complete activity index. Hydrating those here stalls properties.
    const state = await this.readStateReference(false, false);
    const known = new Set<string>();
    for (const course of state.courses) {
      if (course.readweaveNoteId) known.add(course.readweaveNoteId);
      const projection = state.projections.courses[course.id];
      if (projection) {
        for (const value of [projection.courseNoteId, projection.materialsNoteId, projection.qaNoteId, projection.reviewNoteId, projection.qualityNoteId, projection.releasesNoteId, projection.notesNoteId]) known.add(value);
        for (const value of Object.values(projection.modules)) known.add(value);
      }
    }
    for (const draft of state.drafts) {
      if (draft.readweaveNoteId) known.add(draft.readweaveNoteId);
      const projection = state.projections.drafts[draft.id];
      if (projection) {
        for (const value of [projection.pageNoteId, projection.sourceNoteId, projection.atomsNoteId, projection.sourceImageNoteId]) if (value) known.add(value);
        for (const value of Object.values(projection.blockNoteIds)) known.add(value);
        for (const value of Object.values(projection.sectionNoteIds)) known.add(value);
      }
    }
    for (const value of Object.values(state.projections.releases)) known.add(value);
    for (const question of state.questions) if (question.readweaveNoteId) known.add(question.readweaveNoteId);
    for (const node of state.treeNodes) if (node.readweaveNoteId) known.add(node.readweaveNoteId);
    for (const { record } of this.draftPageRecordCache.values()) {
      if (record.draft.readweaveNoteId) known.add(record.draft.readweaveNoteId);
      const projection = record.projection;
      for (const value of [projection.pageNoteId, projection.sourceNoteId, projection.atomsNoteId, projection.sourceImageNoteId]) if (value) known.add(value);
      for (const value of Object.values(projection.blockNoteIds)) known.add(value);
      for (const value of Object.values(projection.sectionNoteIds)) known.add(value);
    }
    const found = known.has(noteId);
    if (!found) return undefined;
    try {
      await this.getNote(noteId);
    } catch {
      return undefined;
    }
    const base = trustedPublicBase(this.config.publicUrl || "https://readweave.example.com");
    return { noteId, url: `${base.origin}/#root/${encodeURIComponent(noteId)}`, host: base.hostname, verified: true, verifiedAt: new Date().toISOString() };
  }

  async getWorkspaceSettings(): Promise<WorkspaceSettings> {
    const state = await this.readStateReference(false, false);
    return structuredClone(state.settings ?? defaultWorkspaceSettings(this.workspaceId));
  }

  async saveWorkspaceSettings(settings: WorkspaceSettings, context: IdempotentWriteContext): Promise<WorkspaceSettings> {
    return this.mutate(async (state) => {
      if (state.idempotency[context.idempotencyKey]) return structuredClone(state.settings ?? defaultWorkspaceSettings(this.workspaceId));
      state.settings = structuredClone({ ...settings, updatedAt: new Date().toISOString() });
      state.idempotency[context.idempotencyKey] = { kind: "settings", objectId: settings.workspaceId };
      return structuredClone(state.settings);
    }, context);
  }

  async listModelProviders(): Promise<ModelProviderConfig[]> { const state = await this.readState(); return structuredClone(state.modelProviders.length ? state.modelProviders : defaultModelProviders()); }

  async updateModelProvider(providerId: string, patch: { baseUrl?: string; enabled?: boolean }, context: IdempotentWriteContext): Promise<ModelProviderConfig> {
    return this.mutate(async (state) => {
      const providers = state.modelProviders.length ? state.modelProviders : defaultModelProviders();
      const provider = providers.find((item) => item.id === providerId);
      if (!provider) throw new Error("MODEL_PROVIDER_NOT_FOUND");
      if (state.idempotency[context.idempotencyKey]) return structuredClone(provider);
      if (patch.baseUrl !== undefined) provider.baseUrl = patch.baseUrl.trim();
      if (patch.enabled !== undefined) provider.enabled = patch.enabled;
      state.modelProviders = providers;
      state.idempotency[context.idempotencyKey] = { kind: "provider_config", objectId: providerId };
      return structuredClone(provider);
    }, context);
  }

  async saveModelProviderCredential(providerId: string, credential: CredentialStatus, context: IdempotentWriteContext): Promise<Pick<ModelProviderConfig, "id" | "credential">> {
    if (!credential.configured || !credential.maskedValue) throw new Error("MODEL_PROVIDER_CREDENTIAL_STATUS_REQUIRED");
    return this.mutate(async (state) => {
      const providers = state.modelProviders.length ? state.modelProviders : defaultModelProviders();
      const provider = providers.find((item) => item.id === providerId);
      if (!provider) throw new Error("MODEL_PROVIDER_NOT_FOUND");
      if (state.idempotency[context.idempotencyKey]) return { id: provider.id, credential: structuredClone(provider.credential) };
      provider.credential = structuredClone(credential);
      state.modelProviders = providers;
      state.idempotency[context.idempotencyKey] = { kind: "provider_credential", objectId: providerId };
      return { id: provider.id, credential: structuredClone(provider.credential) };
    }, context);
  }

  async testModelProvider(providerId: string): Promise<ModelProviderConfig> { const provider = (await this.listModelProviders()).find((item) => item.id === providerId); if (!provider) throw new Error("MODEL_PROVIDER_NOT_FOUND"); return structuredClone({ ...provider, health: { providerId, state: provider.credential.configured ? "connected" as const : "unconfigured" as const, checkedAt: new Date().toISOString(), message: provider.credential.configured ? "供应商配置已就绪" : "请先保存接口密钥" } }); }

  async getModelRoutePolicy(): Promise<ModelRoutePolicy> { const state = await this.readState(); return structuredClone(state.modelRoutePolicy ?? defaultModelRoutePolicy(this.workspaceId)); }

  async saveModelRoutePolicy(policy: ModelRoutePolicy, context: IdempotentWriteContext): Promise<ModelRoutePolicy> {
    return this.mutate(async (state) => {
      if (state.idempotency[context.idempotencyKey]) return structuredClone(state.modelRoutePolicy ?? defaultModelRoutePolicy(this.workspaceId));
      state.modelRoutePolicy = structuredClone({ ...policy, updatedAt: new Date().toISOString() });
      state.idempotency[context.idempotencyKey] = { kind: "model_route_policy", objectId: policy.workspaceId };
      return structuredClone(state.modelRoutePolicy);
    }, context);
  }

  private async ensureStableMaterialNode(state: EtapiState, nodeId: string): Promise<CourseTreeNode | undefined> {
    const group = materialGroups(state.releases, state.drafts).find((item) => stableMaterialId(item.courseId, item.moduleId) === nodeId);
    if (!group || !isStableMaterialId(nodeId, state.releases)) return undefined;
    let course = state.courses.find((item) => item.id === group.courseId);
    if (!course) {
      course = {
        id: group.courseId,
        workspaceId: this.workspaceId,
        title: group.latest.courseTitle,
        status: "active",
        createdAt: group.latest.publishedAt,
        updatedAt: group.latest.publishedAt
      };
      state.courses.push(course);
    }
    const projection = await this.ensureCourseScaffold(state, course.id, course.title, course.description);
    const material = materialTreeNode(course, group, undefined, state.drafts);
    state.projections.materialReleaseSelections ??= {};
    state.projections.materialReleaseSelections[nodeId] ??= { releaseId: material.currentReleaseId ?? "", source: "derived" };
    material.currentReleaseSelection = state.projections.materialReleaseSelections[nodeId]!.source;
    const noteId = projection.modules[group.moduleId] ?? projection.modules[nodeId];
    if (noteId) {
      material.readweaveNoteId = noteId;
      projection.modules[nodeId] = noteId;
    }
    else {
      const note = await this.createNote(projection.materialsNoteId, material.title, "<p>Course OS 材料</p>", "text", undefined, { courseOsType: "material", courseOsObjectId: nodeId });
      material.readweaveNoteId = note.noteId;
      projection.modules[nodeId] = note.noteId;
      projection.moduleBranchIds ??= {};
      projection.moduleBranchIds[nodeId] = note.branch.branchId;
    }
    const legacy = state.treeNodes.find((item) => item.kind === "material" && item.materialId === nodeId && item.id !== nodeId);
    if (legacy) state.treeNodes = state.treeNodes.filter((item) => item.id !== legacy.id);
    material.id = nodeId;
    material.materialId = nodeId;
    state.treeNodes.push(material);
    return material;
  }

  /** Keep the metadata authority's stable material rows current at existing state-save boundaries. */
  private upsertStableMaterialNodes(state: EtapiState, only?: { courseId: string; moduleId: string }): void {
    const releases = (state.releases ?? []).filter((release) => !only || (release.courseId === only.courseId && release.moduleId === only.moduleId));
    const drafts = (state.drafts ?? []).filter((draft) => !only || (draft.courseId === only.courseId && draft.moduleId === only.moduleId));
    state.courses = mergeReleaseCourses(state.courses ?? [], releases, this.workspaceId);
    state.projections.materialReleaseSelections ??= {};
    const groups = materialGroups(releases, drafts);
    for (const group of groups) {
      const id = stableMaterialId(group.courseId, group.moduleId);
      const course = state.courses.find((item) => item.id === group.courseId);
      if (!course) continue;

      const existing = state.treeNodes.find((node) => node.kind === "material" && node.id === id)
        ?? state.treeNodes.find((node) => node.kind === "material" && node.materialId === id);
      const selection = state.projections.materialReleaseSelections[id] ??= existing?.currentReleaseId
        ? { releaseId: existing.currentReleaseId, source: "explicit" }
        : { releaseId: "", source: "derived" };
      const selectionNode = existing && selection.source === "explicit"
        ? { ...existing, currentReleaseId: selection.releaseId, releaseId: selection.releaseId }
        : existing ? { ...existing, currentReleaseId: undefined, releaseId: undefined } : undefined;
      const material: CourseTreeNode = {
        ...materialTreeNode(course, group, selectionNode, drafts),
        id,
        materialId: id,
        currentReleaseSelection: selection.source
      };
      if (selection.source === "derived") selection.releaseId = material.currentReleaseId ?? "";
      const projection = state.projections.courses[group.courseId];
      const projectedNoteId = projection?.modules[id] ?? projection?.modules[group.moduleId];
      material.readweaveNoteId = existing?.readweaveNoteId ?? projectedNoteId;
      if (projection && projectedNoteId && !projection.modules[id]) projection.modules[id] = projectedNoteId;

      const stableIndex = state.treeNodes.findIndex((node) => node.kind === "material" && node.id === id);
      if (stableIndex >= 0) state.treeNodes[stableIndex] = material;
      else state.treeNodes.push(material);
    }
  }

  private async syncMetadataMaterialFromDraft(state: EtapiState, draft: LessonDraft, context: IdempotentWriteContext): Promise<void> {
    const pointer = state.projections.metadataIndexNoteId;
    if (!pointer) return;

    await this.enqueueWrite(async () => {
      const located = await this.readMetadataIndex(pointer);
      if (located.index.workspaceId !== this.workspaceId || located.index.stateNoteId !== state.projections.stateNoteId) {
        throw new Error("READWEAVE_METADATA_INDEX_SOURCE_MISMATCH");
      }
      if (located.index.status !== "active") throw new Error("READWEAVE_METADATA_MIGRATION_IN_PROGRESS");

      const materialState = metadataStateView(located.index, located.noteId);
      materialState.releases = state.releases.filter((release) => release.courseId === draft.courseId && release.moduleId === draft.moduleId);
      materialState.drafts = state.drafts.filter((item) => item.courseId === draft.courseId && item.moduleId === draft.moduleId);
      const draftIndex = materialState.drafts.findIndex((item) => item.pageId === draft.pageId);
      if (draftIndex >= 0) materialState.drafts[draftIndex] = structuredClone(draft);
      else materialState.drafts.push(structuredClone(draft));

      const incomingProjection = state.projections.courses[draft.courseId];
      const currentProjection = materialState.projections.courses[draft.courseId];
      if (incomingProjection) {
        materialState.projections.courses[draft.courseId] = {
          ...structuredClone(incomingProjection),
          ...structuredClone(currentProjection ?? {}),
          modules: { ...incomingProjection.modules, ...currentProjection?.modules },
          moduleBranchIds: { ...incomingProjection.moduleBranchIds, ...currentProjection?.moduleBranchIds },
          childBranchIds: { ...incomingProjection.childBranchIds, ...currentProjection?.childBranchIds }
        };
      }

      this.upsertStableMaterialNodes(materialState, { courseId: draft.courseId, moduleId: draft.moduleId });
      const next: EtapiMetadataIndex = {
        ...located.index,
        courses: structuredClone(materialState.courses),
        treeNodes: structuredClone(materialState.treeNodes),
        projections: {
          ...located.index.projections,
          materialReleaseSelections: structuredClone(materialState.projections.materialReleaseSelections ?? {}),
          courses: structuredClone(materialState.projections.courses)
        }
      };
      if (JSON.stringify(metadataPayload(located.index)) !== JSON.stringify(metadataPayload(next))) {
        next.revision = located.index.revision + 1;
        const committed = await this.writeMetadataIndex(located, next, located.index.revision);
        this.commitMetadataIndex(committed);
        state.projections.metadataIndexRevision = committed.index.revision;
      } else {
        this.commitMetadataIndex(located);
        state.projections.metadataIndexRevision = located.index.revision;
      }
    }, context);
  }

  private ensureCourseProject(state: EtapiState, courseId: string): CourseProject | undefined {
    const existing = state.courses.find((item) => item.id === courseId);
    if (existing) return existing;
    const merged = mergeReleaseCourses(state.courses, state.releases, this.workspaceId).find((item) => item.id === courseId);
    if (!merged) return undefined;
    state.courses.push(merged);
    return merged;
  }

  private courseIdForParent(state: EtapiState, parentId?: string): string | undefined {
    if (!parentId) return undefined;
    if (this.ensureCourseProject(state, parentId)) return parentId;
    const materialMatch = /^material:([^:]+):current$/.exec(parentId);
    if (materialMatch && state.courses.some((course) => course.id === materialMatch[1])) return materialMatch[1];
    const parent = state.treeNodes.find((node) => node.id === parentId);
    if (parent?.kind === "course") return parent.id;
    const release = state.releases.find((item) => item.moduleId === parentId || item.id === parent?.releaseId);
    return release?.courseId;
  }

  private courseIdForNode(state: EtapiState, nodeId: string): string | undefined {
    const node = state.treeNodes.find((item) => item.id === nodeId);
    const direct = this.courseIdForParent(state, node?.parentId);
    if (direct) return direct;
    for (const [courseId, projection] of Object.entries(state.projections.courses)) {
      if (Object.keys(projection.modules).includes(nodeId)) return courseId;
    }
    return state.releases.find((item) => item.moduleId === nodeId || item.id === node?.releaseId)?.courseId;
  }

  private findProjectedModuleNoteId(state: EtapiState, nodeId: string): string | undefined {
    for (const projection of Object.values(state.projections.courses)) {
      const noteId = projection.modules[nodeId];
      if (noteId) return noteId;
    }
    return undefined;
  }

  private parentNoteIdForTreeNode(state: EtapiState, course: CourseProjection, parentId?: string | null): string {
    if (!parentId) return state.projections.rootMaterialsNoteId ?? state.projections.courseRootNoteId;
    if (state.courses.some((item) => item.id === parentId)) return course.materialsNoteId;
    if (parentId === course.courseNoteId || parentId === course.materialsNoteId) return course.materialsNoteId;
    const materialMatch = /^material:([^:]+):current$/.exec(parentId);
    if (materialMatch) return course.materialsNoteId;
    const parentNode = state.treeNodes.find((node) => node.id === parentId);
    if (parentNode?.readweaveNoteId) return parentNode.readweaveNoteId;
    const projected = course.modules[parentId];
    if (projected) return projected;
    return parentId;
  }

  private async moveProjectedNote(state: EtapiState, node: CourseTreeNode, noteId: string, parentId: string | null): Promise<void> {
    const courseId = this.courseIdForNode(state, node.id);
    const course = courseId ? state.projections.courses[courseId] : undefined;
    const targetCourseId = parentId ? this.courseIdForParent(state, parentId) : undefined;
    const targetProject = targetCourseId ? this.ensureCourseProject(state, targetCourseId) : undefined;
    const targetCourse = targetProject ? await this.ensureCourseScaffold(state, targetProject.id, targetProject.title, targetProject.description) : undefined;
    const targetNoteId = parentId === null
      ? await this.ensureWorkspaceContainer(state, "rootMaterialsNoteId", "00 工作区根材料")
      : targetCourse
        ? targetCourse.materialsNoteId
        : course
          ? this.parentNoteIdForTreeNode(state, course, parentId)
          : parentId;
    const targetBranchId = targetNoteId ? await this.findBranchId(targetNoteId) : undefined;
    if (!targetBranchId || !targetNoteId) throw new Error("READWEAVE_TREE_TARGET_BRANCH_NOT_FOUND");
    const sourceBranchId = await this.resolveSourceBranch(noteId, course?.moduleBranchIds?.[node.id]);
    if (!sourceBranchId) {
      const created = await this.createBranch(noteId, targetNoteId);
      this.updateModuleProjectionAfterMove(state, node.id, targetCourseId, created.branchId, noteId);
      return;
    }
    const movedBranchId = await this.moveBranch(sourceBranchId, targetNoteId);
    this.updateModuleProjectionAfterMove(state, node.id, targetCourseId, movedBranchId, noteId);
  }

  private updateModuleProjectionAfterMove(state: EtapiState, nodeId: string, targetCourseId: string | undefined, branchId: string, noteId: string): void {
    for (const projection of Object.values(state.projections.courses)) {
      delete projection.modules[nodeId];
      delete projection.moduleBranchIds?.[nodeId];
    }
    if (!targetCourseId) return;
    const targetProjection = state.projections.courses[targetCourseId];
    if (!targetProjection) return;
    targetProjection.modules[nodeId] = noteId;
    targetProjection.moduleBranchIds ??= {};
    targetProjection.moduleBranchIds[nodeId] = branchId;
  }

  private async ensureWorkspaceContainer(state: EtapiState, key: "rootMaterialsNoteId" | "trashNoteId", title: string): Promise<string> {
    const existing = state.projections[key];
    if (existing) {
      await this.getNote(existing);
      return existing;
    }
    const created = await this.createNote(state.projections.courseRootNoteId, title, `<p>${escapeHtml(title)}，由 Course OS 维护</p>`, "text", undefined, {
      courseOsType: key === "trashNoteId" ? "trash_root" : "root_materials",
      courseOsWorkspaceId: this.workspaceId
    });
    state.projections[key] = created.noteId;
    return created.noteId;
  }

  private async moveNoteToContainer(noteId: string, targetNoteId: string, sourceBranchId?: string): Promise<string> {
    const targetBranchId = await this.findBranchId(targetNoteId);
    if (!targetBranchId) throw new Error("READWEAVE_TREE_TARGET_BRANCH_NOT_FOUND");
    const source = await this.resolveSourceBranch(noteId, sourceBranchId);
    if (!source) {
      const created = await this.createBranch(noteId, targetNoteId);
      return created.branchId;
    }
    return this.moveBranch(source, targetNoteId);
  }

  private async resolveSourceBranch(noteId: string, cachedBranchId?: string): Promise<string | undefined> {
    if (cachedBranchId) {
      try {
        const branch = await this.getBranch(cachedBranchId);
        if (branch.noteId === noteId) return branch.branchId;
      } catch {
        // The projection may contain a branch from an earlier remote revision
        // or a deleted test fixture, so fall back to the note's current branch
      }
    }
    return this.findBranchId(noteId);
  }

  private async findBranchId(noteId: string, parentNoteId?: string): Promise<string | undefined> {
    const note = await this.getNote(noteId);
    for (const branchId of note.parentBranchIds ?? []) {
      try {
        const branch = await this.getBranch(branchId);
        if (!parentNoteId || branch.parentNoteId === parentNoteId) return branch.branchId;
      } catch {
        // ReadWeave may retain a historical parentBranchId after the branch
        // was removed, so ignore that stale reference and inspect the rest
      }
    }
    return undefined;
  }

  private async getNote(noteId: string): Promise<EtapiNote> {
    return this.request<EtapiNote>(`/notes/${encodeURIComponent(noteId)}`);
  }

  private async getBranch(branchId: string): Promise<EtapiBranch> {
    return this.request<EtapiBranch>(`/branches/${encodeURIComponent(branchId)}`);
  }

  private async createBranch(
    noteId: string,
    parentNoteId: string,
    properties: Partial<Pick<EtapiBranch, "notePosition" | "prefix" | "isExpanded">> = { notePosition: 10, prefix: "", isExpanded: false }
  ): Promise<EtapiBranch> {
    return this.request<EtapiBranch>("/branches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteId, parentNoteId, ...properties })
    });
  }

  private async moveBranch(branchId: string, parentNoteId: string): Promise<string> {
    const source = await this.getBranch(branchId);
    if (source.parentNoteId === parentNoteId) return source.branchId;

    // ETAPI models moves as a new parent/child branch plus deletion of the old branch.
    // Create first so deleting the old branch cannot delete the note as its last branch.
    const moved = await this.createBranch(source.noteId, parentNoteId, {
      prefix: source.prefix ?? "",
      isExpanded: source.isExpanded ?? false
    });
    if (moved.branchId !== source.branchId) {
      await this.raw(`/branches/${encodeURIComponent(source.branchId)}`, { method: "DELETE" });
    }
    return moved.branchId;
  }

  private async patchNoteTitle(noteId: string, title: string): Promise<void> {
    await this.request<EtapiNote>(`/notes/${encodeURIComponent(noteId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title })
    });
  }

  private async undeleteNote(noteId: string): Promise<void> {
    await this.raw(`/notes/${encodeURIComponent(noteId)}/undelete`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fallbackParentNoteId: this.config.parentNoteId })
    });
  }

  private async reconcileDraft(state: Pick<DraftPageReadContext, "projections">, draft: LessonDraft, pendingDraft?: LessonDraft): Promise<{ draft: LessonDraft; changed: boolean }> {
    const projection = state.projections.drafts[draft.id];
    if (!projection) return { draft, changed: false };
    const next = structuredClone(draft);
    let changed = false;
    const changedBlocks: ExplanationBlock[] = [];
    const remoteBlocks = await Promise.all(next.page.blocks.map(async (block) => {
      const noteId = projection.blockNoteIds[block.id];
      return noteId ? this.getContent(noteId) : undefined;
    }));
    for (const [index, block] of next.page.blocks.entries()) {
      const remoteMarkdown = remoteBlocks[index];
      if (remoteMarkdown === undefined) continue;
      const remoteHash = sha256(remoteMarkdown);
      if (remoteHash !== projection.blockHashes[block.id]) {
        const pendingBlock = pendingDraft?.page.blocks.find((candidate) => candidate.id === block.id);
        if (remoteHash !== sha256(block.markdown) && (!pendingBlock || remoteHash !== sha256(pendingBlock.markdown))) {
          block.markdown = remoteMarkdown;
          changed = true;
          changedBlocks.push(block);
        }
        projection.blockHashes[block.id] = remoteHash;
      }
    }
    if (changed) {
      let allChangedBlocksHaveUniqueLessonSections = next.page.lessonFlowVersion === 2 && next.page.lessonSections !== undefined;
      if (allChangedBlocksHaveUniqueLessonSections) {
        for (const block of changedBlocks) {
          const sectionKey = this.sectionForBlock(block);
          const lessonKind = LESSON_SECTION_KIND_BY_SECTION[sectionKey];
          if (!lessonKind) {
            allChangedBlocksHaveUniqueLessonSections = false;
            continue;
          }
          const matchingBlocks = next.page.blocks.filter((candidate) => this.sectionForBlock(candidate) === sectionKey);
          const matchingSections = next.page.lessonSections!.filter((section) => section.kind === lessonKind);
          if (matchingBlocks.length !== 1 || matchingSections.length !== 1) {
            allChangedBlocksHaveUniqueLessonSections = false;
            continue;
          }
          matchingSections[0]!.markdown = block.markdown;
          matchingSections[0]!.items = [];
        }
      }
      next.revision += 1;
      if (next.status !== "ready" || !allChangedBlocksHaveUniqueLessonSections) next.status = "editing";
      next.changedBlockIds = next.page.blocks.map((block) => block.id);
      next.contentHash = sha256(JSON.stringify(next.page));
      next.updatedAt = new Date().toISOString();
    }
    return { draft: next, changed };
  }

  private createConflict(local: LessonDraft, baseRevision: number, remote?: LessonDraft): CourseConflict {
    return {
      id: `conflict:${local.pageId}:${Date.now()}`,
      workspaceId: local.workspaceId,
      objectId: local.pageId,
      objectType: "lesson_draft",
      baseRevision,
      localRevision: local.revision,
      remoteRevision: remote?.revision ?? 0,
      baseContent: "",
      localContent: JSON.stringify(local.page),
      remoteContent: JSON.stringify(remote?.page ?? {}),
      status: "open",
      createdAt: new Date().toISOString()
    };
  }

  private async ensureDraftProjection(state: EtapiState, draft: LessonDraft, sourceAsset?: DraftSourceAsset): Promise<DraftProjection> {
    const existing = state.projections.drafts[draft.id];
    if (existing) return existing;
    const release = state.releases.find((item) => item.id === draft.sourceReleaseId);
    if (!release) throw new Error("READWEAVE_SOURCE_RELEASE_NOT_FOUND");
    const course = await this.ensureCourseProjection(state, release);
    const moduleNoteId = course.modules[release.moduleId] ?? await this.createModule(course, release);
    const initialOverview = this.renderPageOverview(draft);
    const pageNote = await this.createNote(moduleNoteId, `第 ${String(draft.page.pageNumber).padStart(3, "0")} 页 · ${draft.page.title}`, initialOverview, "text", undefined, {
      courseOsType: "page",
      courseOsObjectId: draft.pageId
    });
    const sectionNoteIds = {} as Record<SectionKey, string>;
    for (const [key, title] of SECTION_DEFINITIONS) {
      sectionNoteIds[key] = (await this.createNote(pageNote.noteId, title, key === "source" ? "" : this.renderSectionOverview(draft, key), "text", undefined, { courseOsType: `page_${key}`, courseOsPageId: draft.pageId })).noteId;
    }
    let sourceImageNoteId: string | undefined;
    if (sourceAsset) {
      const sourceImage = await this.createNote(sectionNoteIds.source, sourceAsset.fileName, "", "image", sourceAsset.mediaType, {
        courseOsType: "source_page_image",
        courseOsPageId: draft.pageId,
        courseOsSourceHash: sourceAsset.sha256
      });
      await this.putBinaryContent(sourceImage.noteId, sourceAsset.bytes, sourceAsset.mediaType);
      sourceImageNoteId = sourceImage.noteId;
    }
    await this.putContent(sectionNoteIds.source, this.renderSource(draft, sourceImageNoteId, sourceAsset?.fileName));
    await this.putContent(sectionNoteIds.quality, `<h3>页面元素</h3><pre>${escapeHtml(JSON.stringify(draft.page.atoms, null, 2))}</pre><h3>质量结果</h3><pre>${escapeHtml(JSON.stringify(draft.page.quality, null, 2))}</pre>`);
    const blockNoteIds: Record<string, string> = {};
    const blockHashes: Record<string, string> = {};
    for (const block of draft.page.blocks) {
      const section = this.sectionForBlock(block);
      const note = await this.createNote(sectionNoteIds[section], block.title, block.markdown, "code", "text/markdown", {
        courseOsType: "explanation_block",
        courseOsObjectId: block.id,
        courseOsPageId: draft.pageId
      });
      blockNoteIds[block.id] = note.noteId;
      blockHashes[block.id] = sha256(block.markdown);
    }
    const projection: DraftProjection = {
      pageNoteId: pageNote.noteId,
      pageOverviewHash: sha256(await this.getContent(pageNote.noteId)),
      sourceNoteId: sectionNoteIds.source,
      atomsNoteId: sectionNoteIds.quality,
      blockNoteIds,
      blockHashes,
      sectionNoteIds,
      sourceImageNoteId,
      sourceImageFileName: sourceAsset?.fileName
    };
    state.projections.drafts[draft.id] = projection;
    return projection;
  }

  private async refreshDraftProjection(draft: LessonDraft, projection: DraftProjection, sourceAsset?: DraftSourceAsset, maxConcurrency = 1, expectedDraft?: LessonDraft): Promise<void> {
    const interruptedSectionContents = new Map<string, string>();
    if (projection.pageOverviewHash) {
      const actualOverview = await this.getContent(projection.pageNoteId);
      const actualHash = sha256(actualOverview);
      if (actualHash !== projection.pageOverviewHash) {
        const pendingHash = sha256(this.renderPageOverview(draft, projection.sourceImageNoteId, projection.sourceImageFileName));
        if (actualHash !== pendingHash && !(await this.isInterruptedOverviewWrite(actualOverview, draft, projection, interruptedSectionContents))) {
          throw new Error("READWEAVE_PAGE_OVERVIEW_CONFLICT");
        }
        // A previous attempt updated the note before its state transaction failed.
        projection.pageOverviewHash = actualHash;
      }
    }
    const currentBlockHashes = await Promise.all(draft.page.blocks.map(async (block) => {
      const noteId = projection.blockNoteIds[block.id];
      return noteId ? sha256(await this.getContent(noteId)) : undefined;
    }));
    for (const [index, block] of draft.page.blocks.entries()) {
      const actualHash = currentBlockHashes[index];
      if (actualHash === undefined) continue;
      const targetHash = sha256(block.markdown);
      const expectedHash = projection.blockHashes[block.id];
      if (actualHash !== expectedHash && actualHash !== targetHash) throw new Error("READWEAVE_DRAFT_BLOCK_CONFLICT");
      if (actualHash === targetHash) projection.blockHashes[block.id] = targetHash;
    }
    if (sourceAsset) {
      projection.sourceImageFileName = sourceAsset.fileName;
      if (!projection.sourceImageNoteId) {
        const sourceImage = await this.createNote(projection.sectionNoteIds.source, sourceAsset.fileName, "", "image", sourceAsset.mediaType, {
          courseOsType: "source_page_image",
          courseOsPageId: draft.pageId,
          courseOsSourceHash: sourceAsset.sha256
        });
        projection.sourceImageNoteId = sourceImage.noteId;
      }
      await this.putBinaryContent(projection.sourceImageNoteId, sourceAsset.bytes, sourceAsset.mediaType);
    }
    const updates: Array<() => Promise<void>> = [];
    const blockCreations: Array<() => Promise<void>> = [];
    if (projection.pageOverviewHash) {
      const overview = this.renderPageOverview(draft, projection.sourceImageNoteId, projection.sourceImageFileName);
      updates.push(async () => {
        const actual = await this.getContent(projection.pageNoteId);
        const actualHash = sha256(actual);
        const nextHash = sha256(overview);
        if (actualHash === nextHash) {
          projection.pageOverviewHash = actualHash;
          return;
        }
        if (actualHash !== projection.pageOverviewHash && !(await this.isInterruptedOverviewWrite(actual, draft, projection, interruptedSectionContents))) {
          throw new Error("READWEAVE_PAGE_OVERVIEW_CONFLICT");
        }
        await this.putContent(projection.pageNoteId, overview);
        projection.pageOverviewHash = sha256(await this.getContent(projection.pageNoteId));
      });
    }
    const queueContentUpdate = (noteId: string, content: string, expectedContent?: string, legacyExpectedContent?: string): void => {
      updates.push(async () => {
        const actual = await this.getContent(noteId);
        if (actual === content) return;
        if (expectedContent !== undefined && actual !== expectedContent && actual !== interruptedSectionContents.get(noteId)
          && actual !== legacyExpectedContent
          && !(expectedDraft?.revision === 0 && actual === "")) {
          throw new Error("READWEAVE_DRAFT_SECTION_CONFLICT");
        }
        await this.putContent(noteId, content);
      });
    };
    queueContentUpdate(
      projection.sectionNoteIds.source,
      this.renderSource(draft, projection.sourceImageNoteId, projection.sourceImageFileName),
      sourceAsset ? undefined : expectedDraft ? this.renderSource(expectedDraft, projection.sourceImageNoteId, projection.sourceImageFileName) : undefined
    );
    for (const [key] of SECTION_DEFINITIONS) {
      if (key === "source") continue;
      queueContentUpdate(
        projection.sectionNoteIds[key],
        this.renderSectionOverview(draft, key),
        expectedDraft ? this.renderSectionOverview(expectedDraft, key) : undefined,
        expectedDraft ? this.renderLegacySectionOverview(expectedDraft, key) : undefined
      );
    }
    for (const block of draft.page.blocks) {
      const nextHash = sha256(block.markdown);
      let noteId = projection.blockNoteIds[block.id];
      if (!noteId) {
        blockCreations.push(async () => {
          const section = this.sectionForBlock(block);
          const query = new URLSearchParams({
            search: `#courseOsObjectId="${block.id}"`,
            ancestorNoteId: projection.sectionNoteIds[section],
            ancestorDepth: "lt3",
            fastSearch: "true"
          });
          const existing = (await this.request<SearchResponse>(`/notes?${query.toString()}`)).results.find((item) => item.title === block.title);
          if (existing) {
            if (await this.getContent(existing.noteId) !== block.markdown) throw new Error("READWEAVE_DRAFT_BLOCK_CONFLICT");
            projection.blockNoteIds[block.id] = existing.noteId;
          } else {
            const note = await this.createNote(projection.sectionNoteIds[section], block.title, block.markdown, "code", "text/markdown", {
              courseOsType: "explanation_block",
              courseOsObjectId: block.id,
              courseOsPageId: draft.pageId
            });
            projection.blockNoteIds[block.id] = note.noteId;
          }
          projection.blockHashes[block.id] = nextHash;
        });
      } else {
        const baselineHash = projection.blockHashes[block.id];
        updates.push(async () => {
          const actualHash = sha256(await this.getContent(noteId!));
          if (actualHash === nextHash) {
            projection.blockHashes[block.id] = nextHash;
            return;
          }
          if (actualHash !== baselineHash) throw new Error("READWEAVE_DRAFT_BLOCK_CONFLICT");
          await this.putContent(noteId!, block.markdown);
          projection.blockHashes[block.id] = nextHash;
        });
      }
    }
    await forEachWithConcurrency(updates, maxConcurrency, (update) => update());
    for (const createBlock of blockCreations) await createBlock();
  }

  private async isInterruptedOverviewWrite(actual: string, draft: LessonDraft, projection: DraftProjection, recoveredSections?: Map<string, string>): Promise<boolean> {
    const emptyPage = { ...draft.page, lessonSections: [] };
    const prefix = this.renderPageOverview({ ...draft, page: emptyPage }, projection.sourceImageNoteId, projection.sourceImageFileName);
    if (!actual.startsWith(prefix)) return false;
    const sections = [
      ["prerequisites", "先验知识"],
      ["objectives", "学习目标"],
      ["explanation", "完整讲解"],
      ["main", "主要内容"],
      ["misconceptions", "易错点"]
    ] as const;
    const headings = [...actual.matchAll(/<h3>([^<]+)<\/h3>/gu)];
    if (headings.map((match) => match[1]).join("|") !== "承上启下|先验知识|学习目标|完整讲解|主要内容|易错点") return false;
    const contents = await Promise.all(sections.map(async ([key]) => this.getContent(projection.sectionNoteIds[key])));
    const matches = sections.every(([, title], index) => {
      const heading = `<h3>${title}</h3>`;
      const start = actual.indexOf(heading);
      const next = actual.indexOf("<h3>", start + heading.length);
      return start >= 0 && actual.slice(start + heading.length, next < 0 ? undefined : next) === contents[index];
    });
    if (matches && recoveredSections) {
      sections.forEach(([key], index) => recoveredSections.set(projection.sectionNoteIds[key], contents[index]!));
    }
    return matches;
  }

  private async ensureCourseProjection(state: EtapiState, release: CourseRelease): Promise<CourseProjection> {
    const projection = await this.ensureCourseScaffold(state, release.courseId, release.courseTitle);
    if (!projection.modules[release.moduleId]) projection.modules[release.moduleId] = await this.createModule(projection, release);
    return projection;
  }

  private async ensureCourseScaffold(state: EtapiState, courseId: string, title: string, description?: string): Promise<CourseProjection> {
    const existing = state.projections.courses[courseId];
    if (existing) {
      existing.moduleBranchIds ??= {};
      existing.childBranchIds ??= {};
      return existing;
    }
    const courseNote = await this.createNote(state.projections.courseRootNoteId, title, `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(description || "本课程的正式教学内容、草稿、问答、质量记录和发布版本由 ReadWeave 管理")}</p>`, "text", undefined, {
      courseOsType: "course",
      courseOsObjectId: courseId
    });
    const overview = await this.createNote(courseNote.noteId, "00 课程概览", "", "text");
    const objectives = await this.createNote(courseNote.noteId, "01 学习目标与前置知识", "", "text");
    const materials = await this.createNote(courseNote.noteId, "02 课程材料", "", "text");
    const qa = await this.createNote(courseNote.noteId, "03 课程问答", "", "text");
    const review = await this.createNote(courseNote.noteId, "04 错因与复习", "", "text");
    const quality = await this.createNote(courseNote.noteId, "05 质量与审核", "", "text");
    const releases = await this.createNote(courseNote.noteId, "06 正式发布", "", "text");
    const notes = await this.createNote(courseNote.noteId, "99 我的笔记", "", "text");
    await this.putContent(overview.noteId, `<p>课程 ID: <code>${escapeHtml(courseId)}</code></p><p>${escapeHtml(description || "等待导入第一份课程材料")}</p>`);
    const projection: CourseProjection = {
      courseNoteId: courseNote.noteId,
      materialsNoteId: materials.noteId,
      qaNoteId: qa.noteId,
      reviewNoteId: review.noteId,
      qualityNoteId: quality.noteId,
      releasesNoteId: releases.noteId,
      notesNoteId: notes.noteId,
      modules: {},
      moduleBranchIds: {},
      childBranchIds: {
        overview: overview.branch.branchId,
        objectives: objectives.branch.branchId,
        materials: materials.branch.branchId,
        qa: qa.branch.branchId,
        review: review.branch.branchId,
        quality: quality.branch.branchId,
        releases: releases.branch.branchId,
        notes: notes.branch.branchId
      }
    };
    state.projections.courses[courseId] = projection;
    return projection;
  }

  private async createModule(course: CourseProjection, release: CourseRelease): Promise<string> {
    const moduleNote = await this.createNote(course.materialsNoteId, release.moduleTitle, `<p>材料版本 v${release.version}</p>`, "text", undefined, {
      courseOsType: "module",
      courseOsObjectId: release.moduleId
    });
    course.modules[release.moduleId] = moduleNote.noteId;
    course.moduleBranchIds ??= {};
    course.moduleBranchIds[release.moduleId] = moduleNote.branch.branchId;
    return moduleNote.noteId;
  }

  private sectionForBlock(block: ExplanationBlock): SectionKey {
    if (block.kind === "objective") return "objectives";
    if (block.kind === "prerequisite") return "prerequisites";
    if (block.kind === "misconception") return "misconceptions";
    if (block.kind === "qa") return "qa";
    if (block.kind === "source_status") return "quality";
    if (block.kind === "core") return "main";
    return "explanation";
  }

  private renderSectionOverview(draft: LessonDraft, section: Exclude<SectionKey, "source">): string {
    if (section === "quality") return `<h3>页面元素</h3><pre>${escapeHtml(JSON.stringify(draft.page.atoms, null, 2))}</pre><h3>质量结果</h3><pre>${escapeHtml(JSON.stringify(draft.page.quality, null, 2))}</pre>`;
    if (section === "assessment") return this.renderAssessmentOverview(draft, "默认每次学习抽取 3 题，可选 2、3 或 5 题，并保存种子、顺序和作答记录");
    if (section === "qa") return "<p>本页实时问答会作为子笔记自动保存，撤回只改变状态，不删除历史修订</p>";
    const kind = LESSON_SECTION_KIND_BY_SECTION[section];
    if (!kind) return "<p>本节内容保存在下方结构化讲解子笔记中</p>";
    const lesson = draft.page.lessonSections?.find((item) => item.kind === kind);
    if (!lesson) return "<p>本节内容保存在下方结构化讲解子笔记中</p>";
    if (lesson.items?.length) return `<ul>${lesson.items.map((item) => `<li>${escapeHtml(item.text)}</li>`).join("")}</ul>`;
    return lesson.markdown ? renderReadableLessonText(lesson.markdown) : "<p>本节内容保存在下方结构化讲解子笔记中</p>";
  }

  private renderLegacySectionOverview(draft: LessonDraft, section: Exclude<SectionKey, "source">): string | undefined {
    if (section === "assessment") return this.renderAssessmentOverview(draft, "每次学习抽取两题并保存种子、顺序和作答记录", true);
    const kind = LESSON_SECTION_KIND_BY_SECTION[section];
    if (!kind) return undefined;
    const lesson = draft.page.lessonSections?.find((item) => item.kind === kind);
    if (!lesson?.markdown || lesson.items?.length) return undefined;
    return `<pre>${escapeHtml(lesson.markdown)}</pre>`;
  }

  private renderAssessmentOverview(draft: LessonDraft, selectionSummary: string, legacyAllQuestions = false): string {
    const questions = (draft.page.questionBank ?? []).filter(question => legacyAllQuestions || question.status === "approved");
    return questions.length
      ? `<p>正式题库共 ${questions.length} 题，${selectionSummary}</p><ol>${questions.map((question) => `<li><strong>${escapeHtml(question.kind === "multiple_choice" ? "选择题" : "理解题")}</strong> ${escapeHtml(question.prompt)}<details><summary>审核答案</summary><p>${escapeHtml(question.expectedAnswer)}</p><p>${escapeHtml(question.explanation)}</p></details></li>`).join("")}</ol>`
      : "<p>本页尚未建立通过审核的随机题</p>";
  }

  private renderPageOverview(draft: LessonDraft, imageNoteId?: string, fileName = "page.png"): string {
    const image = imageNoteId ? `<p><img src="api/images/${encodeURIComponent(imageNoteId)}/${encodeURIComponent(fileName)}" alt="第 ${draft.page.pageNumber} 页原图"></p>` : "";
    const sections = draft.page.lessonFlowVersion === 2 ? draft.page.lessonSections ?? [] : [];
    const lesson = sections.map((section) => {
      const content = section.markdown ? renderReadableLessonText(section.markdown)
        : section.items?.length ? `<ul>${section.items.map((item) => `<li>${escapeHtml(item.text)}</li>`).join("")}</ul>` : "";
      return content ? `<h3>${escapeHtml(section.title)}</h3>${content}` : "";
    }).join("");
    return `<h2>${escapeHtml(draft.page.title)}</h2><p>第 ${draft.page.pageNumber} 页</p>${image}${lesson}`;
  }

  private renderSource(draft: LessonDraft, imageNoteId?: string, fileName = "page.png"): string {
    const image = imageNoteId ? `<p><img src="api/images/${encodeURIComponent(imageNoteId)}/${encodeURIComponent(fileName)}" alt="原始页面"></p>` : "";
    const extracted = draft.page.anchors.find((anchor) => anchor.kind === "text")?.text;
    return `<p>原始页面</p>${image}<p><code>${escapeHtml(draft.page.imageUrl)}</code></p>${extracted ? `<h3>提取文本</h3><pre>${escapeHtml(extracted)}</pre>` : ""}<h3>来源锚点</h3><pre>${escapeHtml(JSON.stringify(draft.page.anchors, null, 2))}</pre>`;
  }

  private async mutateMetadata<T>(
    context: IdempotentWriteContext,
    canApply: (state: EtapiState) => boolean,
    change: (state: EtapiState) => Promise<T>,
    existingAuthorityOnly = false
  ): Promise<{ applied: false } | { applied: true; value: T; replayed: boolean }> {
    return this.enqueueWrite(async () => {
      try {
        const cached = this.metadataIndexCache;
        const cachedReplay = cached && cached.expiresAt > Date.now() && cached.index.status === "active"
          && Object.hasOwn(cached.index.idempotency, context.idempotencyKey);
        const located = cachedReplay
          ? { noteId: cached.noteId, index: cached.index }
          : existingAuthorityOnly ? await this.metadataIndexForRead() : await this.metadataIndexForMutation();
        if (!located) return { applied: false };
        if (located.index.status === "rolling_back") throw new Error("READWEAVE_METADATA_ROLLBACK_IN_PROGRESS");
        if (located.index.status !== "active") return { applied: false };
        const state = metadataStateView(located.index, located.noteId);
        if (!canApply(state)) return { applied: false };
        const replayed = Boolean(state.idempotency[context.idempotencyKey]);
        const before = metadataPayload(located.index);
        const value = structuredClone(await change(state));
        const next = metadataIndexFromState(located.index, state);
        if (JSON.stringify(before) !== JSON.stringify(metadataPayload(next))) {
          next.revision = located.index.revision + 1;
          next.status = "active";
          next.migration = { ...next.migration, phase: "active", completedAt: next.migration.completedAt ?? new Date().toISOString() };
          const committed = await this.writeMetadataIndex(located, next, located.index.revision);
          this.commitMetadataIndex(committed);
        } else {
          this.commitMetadataIndex(located);
        }
        return { applied: true, value, replayed };
      } catch (error) {
        this.metadataIndexCache = undefined;
        this.invalidateStateCache();
        throw error;
      }
    }, context);
  }

  private async readBackMetadataTreeNode(nodeId: string, expected: CourseTreeNode, verifyRemoteNote = true): Promise<CourseTreeNode> {
    // mutateMetadata has already committed and read back the authority before
    // handing its result here. Use that exact revision instead of downloading
    // the metadata index a second time for the same operation.
    const cached = this.metadataIndexCache;
    const located = cached && cached.expiresAt > Date.now() && cached.index.status === "active"
      ? { noteId: cached.noteId, index: cached.index }
      : await this.metadataIndexForMutation();
    const stored = located.index.treeNodes.find((candidate) => candidate.id === nodeId);
    const course = located.index.courses.find((candidate) => candidate.id === nodeId);
    const node = stored ?? (course ? courseNodeFromProject(course) : undefined);
    if (!node || node.title !== expected.title || node.parentId !== expected.parentId
      || (expected.revision !== undefined && node.revision !== expected.revision)) {
      throw new Error("READWEAVE_TREE_READBACK_FAILED");
    }
    if (expected.currentReleaseId !== undefined && node.currentReleaseId !== expected.currentReleaseId) {
      throw new Error("READWEAVE_TREE_READBACK_FAILED");
    }
    if (expected.readweaveNoteId && node.readweaveNoteId !== expected.readweaveNoteId) {
      throw new Error("READWEAVE_TREE_IDENTITY_READBACK_FAILED");
    }
    if (verifyRemoteNote && node.readweaveNoteId) await this.getNote(node.readweaveNoteId);
    return structuredClone(node);
  }

  private async metadataIndexForMutation(): Promise<LocatedMetadataIndex> {
    const cached = this.metadataIndexCache;
    if (cached && cached.expiresAt > Date.now()) {
      const latest = await this.readMetadataIndex(cached.noteId);
      if (latest.index.status === "active") return latest;
      if (latest.index.status === "rolling_back") throw new Error("READWEAVE_METADATA_ROLLBACK_IN_PROGRESS");
    }

    const legacy = await this.readRawState();
    const pointer = legacy.projections.metadataIndexNoteId;
    if (pointer) {
      const pointed = await this.readMetadataIndex(pointer);
      if (pointed.index.workspaceId !== this.workspaceId || pointed.index.stateNoteId !== legacy.projections.stateNoteId) {
        throw new Error("READWEAVE_METADATA_INDEX_SOURCE_MISMATCH");
      }
      const rootRevision = legacy.projections.metadataIndexRevision ?? 0;
      const stagedPointerPending = pointed.index.status === "staged" && rootRevision === pointed.index.revision + 1;
      if (pointed.index.revision < rootRevision && !stagedPointerPending) throw new Error("READWEAVE_METADATA_INDEX_REVISION_INVALID");
      if (pointed.index.status === "active") {
        await this.addMetadataIndexAuthorityLabel(pointed);
        this.commitMetadataIndex(pointed);
        return pointed;
      }
      if (pointed.index.status === "staged") return this.finishMetadataMigration(legacy, pointed);
      if (pointed.index.status === "rolling_back") throw new Error("READWEAVE_METADATA_ROLLBACK_IN_PROGRESS");
      throw new Error("READWEAVE_METADATA_INDEX_ROLLED_BACK");
    }

    const active = await this.findActiveMetadataIndex();
    if (active) throw new Error("READWEAVE_METADATA_ROOT_POINTER_MISSING");
    return this.startMetadataMigration(legacy);
  }

  private async metadataIndexForRead(): Promise<LocatedMetadataIndex | undefined> {
    const cached = this.metadataIndexCache;
    if (cached && cached.expiresAt > Date.now()) {
      const latest = await this.readMetadataIndex(cached.noteId);
      if (latest.index.status === "active" || latest.index.status === "rolling_back") {
        this.cacheMetadataIndex(latest);
        return latest;
      }
    }
    const located = await this.findMetadataIndexForWorkspace();
    if (!located) return undefined;
    if (located.index.status === "active" || located.index.status === "rolling_back") {
      this.cacheMetadataIndex(located);
      return located;
    }
    if (located.index.status !== "staged") return undefined;

    // A staged index is readable only after the root has committed its pointer.
    // This path is limited to recovery from an interrupted one-time migration.
    const root = await this.readRawState();
    if (root.projections.metadataIndexNoteId !== located.noteId
      || (root.projections.metadataIndexRevision ?? 0) !== located.index.revision + 1) return undefined;
    this.cacheMetadataIndex(located);
    return located;
  }

  private async findMetadataIndexForWorkspace(): Promise<LocatedMetadataIndex | undefined> {
    const query = new URLSearchParams({
      search: quoteSearchValue(`${metadataIndexTitlePrefix} · ${this.workspaceId}`),
      ancestorNoteId: this.config.parentNoteId,
      ancestorDepth: "lt5",
      fastSearch: "true"
    });
    const response = await this.request<SearchResponse>(`/notes?${query.toString()}`);
    const matches = response.results.filter((note) => note.title === `${metadataIndexTitlePrefix} · ${this.workspaceId}`);
    if (matches.length > 1) throw new Error("READWEAVE_METADATA_INDEX_DUPLICATE");
    return matches[0] ? this.readMetadataIndex(matches[0].noteId) : undefined;
  }

  private treeNodesFromMetadata(index: EtapiMetadataIndex): CourseTreeNode[] {
    const courses = mergeReleaseCourses(index.courses, [], this.workspaceId).filter((course) => course.status !== "archived");
    const stableMaterialIds = new Set(index.treeNodes
      .filter((node) => node.kind === "material" && node.id === node.materialId)
      .map((node) => node.id));
    const byId = new Map(index.treeNodes
      .filter((node) => (node.kind === "course" || node.kind === "material") && !node.archived)
      .filter((node) => !(node.kind === "material" && node.id !== node.materialId && node.materialId && stableMaterialIds.has(node.materialId)))
      .map((node) => [node.id, withMaterialReleaseSelectionHint(structuredClone(node), index.projections.materialReleaseSelections)] as const));
    for (const course of courses) {
      if (byId.has(course.id)) continue;
      byId.set(course.id, {
        id: course.id,
        kind: "course",
        title: course.title,
        subtitle: course.description,
        status: "published",
        archived: false,
        visibility: "library",
        revision: course.revision ?? 0,
        sortOrder: course.sortOrder,
        readweaveNoteId: course.readweaveNoteId ?? index.projections.courses[course.id]?.courseNoteId,
        children: []
      });
    }
    return [...byId.values()];
  }

  private async startMetadataMigration(legacy: EtapiState): Promise<LocatedMetadataIndex> {
    this.upsertStableMaterialNodes(legacy);
    const stateNoteId = legacy.projections.stateNoteId;
    const migrationId = metadataMigrationId(this.workspaceId, stateNoteId);
    let staged = await this.findMetadataMigration(migrationId);
    if (staged?.index.status === "staged") return this.finishMetadataMigration(legacy, staged);
    if (staged?.index.status === "active" || staged?.index.status === "rolling_back") {
      throw new Error("READWEAVE_METADATA_ROOT_POINTER_MISSING");
    }

    const migrated = metadataIndexFromLegacy(legacy, this.workspaceId, migrationId, 1);
    if (staged) {
      migrated.revision = staged.index.revision + 1;
      await this.writeMetadataIndex(staged, migrated, staged.index.revision);
      staged = { noteId: staged.noteId, index: migrated };
    } else {
      const title = `${metadataIndexTitlePrefix} · ${this.workspaceId}`;
      const created = await this.createNote(stateNoteId, title, await encodeReadWeaveStateContentAsync(migrated), "code", "application/json", {
        [metadataMigrationLabel]: migrationId,
        courseOsWorkspaceId: this.workspaceId,
        courseOsType: "metadata_index"
      });
      staged = await this.readMetadataIndex(created.noteId);
      if (staged.index.status !== "staged" || staged.index.migration.id !== migrationId) throw new Error("READWEAVE_METADATA_MIGRATION_READBACK_FAILED");
    }
    return this.finishMetadataMigration(legacy, staged);
  }

  private async finishMetadataMigration(legacy: EtapiState, staged: LocatedMetadataIndex): Promise<LocatedMetadataIndex> {
    if (staged.index.workspaceId !== this.workspaceId || staged.index.stateNoteId !== legacy.projections.stateNoteId) {
      throw new Error("READWEAVE_METADATA_INDEX_SOURCE_MISMATCH");
    }
    let root = await this.readRawState();
    if (root.projections.stateNoteId !== legacy.projections.stateNoteId) throw new Error("READWEAVE_METADATA_INDEX_SOURCE_MISMATCH");
    const existingPointer = root.projections.metadataIndexNoteId;
    if (existingPointer && existingPointer !== staged.noteId) throw new Error("READWEAVE_METADATA_INDEX_POINTER_MISMATCH");

    if (staged.index.status === "active") {
      if (!existingPointer || !metadataFieldsAreEmpty(root)
        || (root.projections.metadataIndexRevision ?? 0) > staged.index.revision) {
        throw new Error("READWEAVE_METADATA_ROOT_POINTER_INVALID");
      }
      await this.addMetadataIndexAuthorityLabel(staged);
      this.commitMetadataIndex(staged);
      return staged;
    }
    if (staged.index.status !== "staged") {
      throw new Error("READWEAVE_METADATA_MIGRATION_NOT_RESUMABLE");
    }

    if (!existingPointer) this.upsertStableMaterialNodes(root);
    if (!existingPointer && JSON.stringify(metadataPayload(root)) !== JSON.stringify(metadataPayload(staged.index))) {
      const refreshed = metadataIndexFromLegacy(root, this.workspaceId, staged.index.migration.id, staged.index.revision + 1);
      staged = await this.writeMetadataIndex(staged, refreshed, staged.index.revision);
    }
    const activeRevision = staged.index.revision + 1;
    if (existingPointer && (root.projections.metadataIndexRevision ?? 0) !== activeRevision) {
      throw new Error("READWEAVE_METADATA_ROOT_POINTER_INVALID");
    }
    const rootIsSplit = existingPointer === staged.noteId && metadataFieldsAreEmpty(root);
    if (!rootIsSplit) {
      const core = stateWithoutMetadata(root, staged.noteId, activeRevision);
      const content = await encodeReadWeaveStateContentAsync(core);
      const stateNoteId = stateNoteIdFromState(root);
      await this.putContent(stateNoteId, content);
      const readBackContent = await this.getContent(stateNoteId);
      if (readBackContent !== content) throw new Error("READWEAVE_METADATA_ROOT_READBACK_FAILED");
      const readBack = normalizeState(await decodeReadWeaveStateContentAsync(readBackContent) as Partial<EtapiState>, root.projections);
      if (readBack.projections.metadataIndexNoteId !== staged.noteId
        || readBack.projections.metadataIndexRevision !== activeRevision
        || !metadataFieldsAreEmpty(readBack)) {
        throw new Error("READWEAVE_METADATA_ROOT_READBACK_FAILED");
      }
      root = readBack;
    }

    const next = {
      ...staged.index,
      status: "active" as const,
      revision: activeRevision,
      migration: { ...staged.index.migration, phase: "active" as const, completedAt: new Date().toISOString() }
    };
    let activated = await this.writeMetadataIndex(staged, next, staged.index.revision);
    await this.addMetadataIndexAuthorityLabel(activated);
    activated = await this.readMetadataIndex(activated.noteId);
    if (activated.index.status !== "active") throw new Error("READWEAVE_METADATA_MIGRATION_READBACK_FAILED");
    this.commitMetadataIndex(activated);
    return activated;
  }

  private async readRawState(): Promise<EtapiState> {
    const bootstrap = await this.ensureWorkspaceResult();
    let parsed = bootstrap.stateSnapshot;
    if (parsed) bootstrap.stateSnapshot = undefined;
    if (!parsed) parsed = await decodeReadWeaveStateContentAsync(await this.getContent(bootstrap.projection.stateNoteId)) as Partial<EtapiState>;
    return normalizeState(parsed, bootstrap.projection);
  }

  private async readMetadataIndex(noteId: string, confirmedContent?: string): Promise<LocatedMetadataIndex> {
    const parsed = await decodeReadWeaveStateContentAsync(confirmedContent ?? await this.getContent(noteId)) as Partial<EtapiMetadataIndex>;
    if (parsed.format !== "course-os-metadata-index" || parsed.formatVersion !== 1 || parsed.schemaVersion !== "1.0.0"
      || parsed.authorityType !== "readweave-etapi" || !parsed.workspaceId || !parsed.stateNoteId
      || !["staged", "active", "rolling_back", "rolled_back"].includes(parsed.status ?? "")
      || !Number.isInteger(parsed.revision) || (parsed.revision ?? -1) < 1
      || !parsed.migration?.id || !["staged", "active", "rolling_back", "rolled_back"].includes(parsed.migration.phase ?? "")
      || !Array.isArray(parsed.courses) || !Array.isArray(parsed.treeNodes) || !Array.isArray(parsed.trash)
      || !parsed.projections || typeof parsed.projections.courses !== "object" || !parsed.idempotency) {
      throw new Error("READWEAVE_METADATA_INDEX_INVALID");
    }
    const index = parsed as EtapiMetadataIndex;
    if (index.workspaceId !== this.workspaceId) throw new Error("READWEAVE_METADATA_INDEX_WORKSPACE_MISMATCH");
    return { noteId, index };
  }

  private async writeMetadataIndex(
    located: LocatedMetadataIndex,
    next: EtapiMetadataIndex,
    expectedRevision: number
  ): Promise<LocatedMetadataIndex> {
    const timingEnabled = process.env.COURSE_OS_READWEAVE_TIMING === "1";
    let encodeMs: number | undefined;
    let snapshotBytes: number | undefined;
    let stateNotePutMs: number | undefined;
    let confirmationMs: number | undefined;
    let succeeded = false;
    try {
      const latest = await this.readMetadataIndex(located.noteId);
      if (latest.index.revision !== expectedRevision) throw new Error("READWEAVE_METADATA_REVISION_CONFLICT");
      if (latest.index.migration.id !== next.migration.id || latest.index.stateNoteId !== next.stateNoteId
        || latest.index.workspaceId !== next.workspaceId || next.revision !== expectedRevision + 1) {
        throw new Error("READWEAVE_METADATA_INDEX_IDENTITY_MISMATCH");
      }
      const encodeStartedAt = timingEnabled ? performance.now() : 0;
      const content = await encodeReadWeaveStateContentAsync(next);
      if (timingEnabled) { encodeMs = Math.round(performance.now() - encodeStartedAt); snapshotBytes = Buffer.byteLength(content); }
      await this.putContent(located.noteId, content, timingEnabled ? durationMs => { stateNotePutMs = durationMs; } : undefined);
      const confirmationStartedAt = timingEnabled ? performance.now() : 0;
      const readBackContent = await this.getContent(located.noteId);
      if (readBackContent !== content) throw new Error("READWEAVE_METADATA_INDEX_READBACK_FAILED");
      const readBack = await this.readMetadataIndex(located.noteId, readBackContent);
      if (readBack.index.revision !== next.revision || readBack.index.status !== next.status
        || JSON.stringify(metadataPayload(readBack.index)) !== JSON.stringify(metadataPayload(next))) {
        throw new Error("READWEAVE_METADATA_INDEX_READBACK_FAILED");
      }
      if (timingEnabled) confirmationMs = Math.round(performance.now() - confirmationStartedAt);
      succeeded = true;
      return readBack;
    } finally {
      if (timingEnabled) this.logWriteTiming("course_os.readweave_metadata_write_timing", {
        encodeMs, snapshotBytes, stateNotePutMs, confirmationMs, succeeded
      });
    }
  }

  private async findMetadataMigration(migrationId: string): Promise<LocatedMetadataIndex | undefined> {
    const byLabelQuery = new URLSearchParams({
      search: `#${metadataMigrationLabel}=${quoteSearchValue(migrationId)}`,
      ancestorNoteId: this.config.parentNoteId,
      ancestorDepth: "lt5",
      fastSearch: "true"
    });
    const byTitleQuery = new URLSearchParams({
      search: quoteSearchValue(`${metadataIndexTitlePrefix} · ${this.workspaceId}`),
      ancestorNoteId: this.config.parentNoteId,
      ancestorDepth: "lt5",
      fastSearch: "true"
    });
    const responses = await Promise.all([
      this.request<SearchResponse>(`/notes?${byLabelQuery.toString()}`),
      this.request<SearchResponse>(`/notes?${byTitleQuery.toString()}`)
    ]);
    const candidates = [...new Map(responses.flatMap((response) => response.results)
      .filter((candidate) => candidate.title === `${metadataIndexTitlePrefix} · ${this.workspaceId}`)
      .map((candidate) => [candidate.noteId, candidate])).values()];
    const matches: LocatedMetadataIndex[] = [];
    for (const note of candidates) {
      const located = await this.readMetadataIndex(note.noteId);
      if (located.index.migration.id === migrationId) matches.push(located);
    }
    if (matches.length > 1) throw new Error("READWEAVE_METADATA_MIGRATION_DUPLICATE");
    return matches[0];
  }

  private async findActiveMetadataIndex(): Promise<LocatedMetadataIndex | undefined> {
    const query = new URLSearchParams({
      search: `#${metadataIndexLabel}=${quoteSearchValue(this.workspaceId)}`,
      ancestorNoteId: this.config.parentNoteId,
      ancestorDepth: "lt5",
      fastSearch: "true"
    });
    const response = await this.request<SearchResponse>(`/notes?${query.toString()}`);
    const active: LocatedMetadataIndex[] = [];
    for (const note of response.results.filter((candidate) => candidate.title.startsWith(`${metadataIndexTitlePrefix} · `))) {
      const located = await this.readMetadataIndex(note.noteId);
      if (located.index.status === "active" && located.index.workspaceId === this.workspaceId) active.push(located);
    }
    if (active.length > 1) throw new Error("READWEAVE_METADATA_INDEX_DUPLICATE");
    return active[0];
  }

  private async addMetadataIndexAuthorityLabel(located: LocatedMetadataIndex): Promise<void> {
    const query = new URLSearchParams({
      search: `#${metadataIndexLabel}=${quoteSearchValue(this.workspaceId)}`,
      ancestorNoteId: this.config.parentNoteId,
      ancestorDepth: "lt5",
      fastSearch: "true"
    });
    const found = (await this.request<SearchResponse>(`/notes?${query.toString()}`)).results.some((note) => note.noteId === located.noteId);
    if (!found) await this.addDraftRecordLabel(located.noteId, metadataIndexLabel, this.workspaceId);
  }

  private commitMetadataIndex(located: LocatedMetadataIndex): void {
    this.cacheMetadataIndex(located);
    this.stateVersion += 1;
    if (!this.stateCache || located.index.status === "rolled_back") return;
    applyMetadataIndex(this.stateCache.state, located.index, located.noteId);
    this.stateCache.expiresAt = Date.now() + EtapiReadWeaveCourseApi.readCacheTtlMs;
  }

  private cacheMetadataIndex(located: LocatedMetadataIndex): void {
    this.metadataIndexCache = { noteId: located.noteId, index: located.index, expiresAt: Date.now() + 15_000 };
  }

  private async prepareMetadataAwareStateWrite(state: EtapiState): Promise<{ coreState?: EtapiState }> {
    const stateNoteId = state.projections.stateNoteId;
    const pointer = state.projections.metadataIndexNoteId;
    if (!pointer) {
      const migrationId = metadataMigrationId(this.workspaceId, stateNoteId);
      const pending = await this.findMetadataMigration(migrationId);
      if (pending && pending.index.status !== "rolled_back") throw new Error("READWEAVE_METADATA_MIGRATION_IN_PROGRESS");
      const active = await this.findActiveMetadataIndex();
      if (active) throw new Error("READWEAVE_METADATA_ROOT_POINTER_MISSING");
      return {};
    }

    const located = await this.readMetadataIndex(pointer);
    if (located.index.stateNoteId !== stateNoteId || located.index.workspaceId !== this.workspaceId) {
      throw new Error("READWEAVE_METADATA_INDEX_SOURCE_MISMATCH");
    }
    if (located.index.status === "rolling_back") throw new Error("READWEAVE_METADATA_ROLLBACK_IN_PROGRESS");
    if (located.index.status !== "active") throw new Error("READWEAVE_METADATA_MIGRATION_IN_PROGRESS");
    if ((state.projections.metadataIndexRevision ?? 0) !== located.index.revision) {
      throw new Error("READWEAVE_METADATA_REVISION_CONFLICT");
    }

    const next = metadataIndexFromState(located.index, state);
    if (JSON.stringify(metadataPayload(located.index)) !== JSON.stringify(metadataPayload(next))) {
      next.revision = located.index.revision + 1;
      next.migration = { ...next.migration, completedAt: next.migration.completedAt ?? new Date().toISOString() };
      const committed = await this.writeMetadataIndex(located, next, located.index.revision);
      this.commitMetadataIndex(committed);
      state.projections.metadataIndexRevision = committed.index.revision;
    }
    return { coreState: stateWithoutMetadata(state, pointer, state.projections.metadataIndexRevision ?? located.index.revision) };
  }

  private async readState(requireFresh = false): Promise<EtapiState> {
    const state = structuredClone(await this.readStateReference(requireFresh));
    await this.mergeDraftPageRecords(state);
    return state;
  }

  private async readStateReference(requireFresh = false, includeActivity = true): Promise<EtapiState> {
    const withActivity = async (state: EtapiState): Promise<EtapiState> => {
      if (includeActivity && state.projections.activityStateNoteId) {
        this.applyActivityState(state, await this.readActivityReference(state.projections.activityStateNoteId));
      }
      return state;
    };
    const now = Date.now();
    if (this.stateCache && this.stateCache.expiresAt > now) return withActivity(this.stateCache.state);

    if (this.writeContext.getStore()) {
      const versionAtReadStart = this.stateVersion;
      const state = await this.readRemoteState();
      if (this.stateVersion === versionAtReadStart) {
        this.stateCache = { state, expiresAt: Date.now() + EtapiReadWeaveCourseApi.readCacheTtlMs };
        this.cacheActivityRoutes(state);
        this.lastReadAt = new Date().toISOString();
      }
      return withActivity(state);
    }

    if (!this.stateReadInFlight) {
      const versionAtReadStart = this.stateVersion;
      const read = createSharedRead(() => this.readRemoteState());
      this.stateReadInFlight = read;
      void read.promise.then((state) => {
        if (this.stateReadInFlight === read && this.stateVersion === versionAtReadStart) {
          this.stateCache = { state, expiresAt: Date.now() + EtapiReadWeaveCourseApi.readCacheTtlMs };
          this.cacheActivityRoutes(state);
          this.lastReadAt = new Date().toISOString();
        }
      }).catch(() => undefined).finally(() => {
        if (this.stateReadInFlight === read) this.stateReadInFlight = undefined;
      });
    }
    const pendingRead = this.stateReadInFlight;
    if (!pendingRead) throw new Error("READWEAVE_STATE_READ_MISSING");
    if (!requireFresh && this.stateCache && now < this.stateCache.expiresAt + EtapiReadWeaveCourseApi.maxStaleReadMs) {
      return withActivity(this.stateCache.state);
    }
    const state = await joinSharedRead(pendingRead, currentReadBudget());
    const current = this.stateCache && this.stateCache.expiresAt > Date.now() ? this.stateCache.state : state;
    return withActivity(current);
  }

  private async readRemoteState(): Promise<EtapiState> {
    const bootstrap = await this.ensureWorkspaceResult();
    // Bootstrap already downloaded this immutable snapshot to locate the
    // projection notes. Reuse it for the first read instead of fetching the
    // same large index a second time during a cold API start.
    let parsed = bootstrap.stateSnapshot;
    if (parsed) bootstrap.stateSnapshot = undefined;
    if (!parsed) parsed = await decodeReadWeaveStateContentAsync(await this.getContent(bootstrap.projection.stateNoteId)) as Partial<EtapiState>;
    const state = normalizeState(parsed, bootstrap.projection);
    const metadataNoteId = state.projections.metadataIndexNoteId;
    if (metadataNoteId) {
      const located = await this.readMetadataIndex(metadataNoteId);
      if (located.index.workspaceId !== this.workspaceId || located.index.stateNoteId !== state.projections.stateNoteId) {
        throw new Error("READWEAVE_METADATA_INDEX_SOURCE_MISMATCH");
      }
      const pointerRevision = state.projections.metadataIndexRevision ?? 0;
      const stagedPointerPending = located.index.status === "staged" && pointerRevision === located.index.revision + 1;
      if (located.index.status === "rolled_back" || (located.index.revision < pointerRevision && !stagedPointerPending)) {
        throw new Error("READWEAVE_METADATA_INDEX_REVISION_INVALID");
      }
      if (!metadataFieldsAreEmpty(state)) throw new Error("READWEAVE_METADATA_ROOT_DUAL_AUTHORITY");
      applyMetadataIndex(state, located.index, metadataNoteId);
      state.projections.metadataIndexRevision = located.index.revision;
      this.cacheMetadataIndex(located);
    }
    for (const located of this.draftPageRecordCache.values()) this.mergeDraftPageRecord(state, located.record);
    return state;
  }

  private async mergeDraftPageRecords(state: EtapiState): Promise<void> {
    await this.hydrateDraftPageRecords();
    for (const located of this.draftPageRecordCache.values()) this.mergeDraftPageRecord(state, located.record);
  }

  private async hydrateDraftPageRecords(): Promise<void> {
    if (this.draftPageRecordsHydrated) return;
    const isWrite = Boolean(this.writeContext.getStore());
    if (!this.draftPageRecordsHydration) {
      const hydration = createSharedRead(async () => {
        await this.readDraftPageRecords();
      }, { budgeted: !isWrite, independent: isWrite });
      this.draftPageRecordsHydration = hydration;
      void hydration.promise.then(() => {
        if (this.draftPageRecordsHydration === hydration) this.draftPageRecordsHydrated = true;
      }).catch(() => undefined).finally(() => {
        if (this.draftPageRecordsHydration === hydration) this.draftPageRecordsHydration = undefined;
      });
    }
    const pendingRead = this.draftPageRecordsHydration;
    if (!pendingRead) throw new Error("READWEAVE_DRAFT_PAGE_HYDRATION_MISSING");
    await joinSharedRead(pendingRead, isWrite ? undefined : currentReadBudget(), { writeOwner: isWrite });
  }

  private async readDraftPageRecords(pageId?: string | readonly string[]): Promise<LocatedDraftPageRecord[]> {
    const pageIds = pageId === undefined ? undefined : new Set(typeof pageId === "string" ? [pageId] : pageId);
    if (pageIds?.size === 0) return [];
    const observedVersions = new Map(this.draftPageRecordVersions);
    const searches = pageIds
      ? [[...pageIds].map(id => `#courseOsDraftRecordPageId=${quoteSearchValue(id)}`).join(" OR ")]
      : ['#courseOsType="draft_record"', '"Course OS draft record"'];
    const responses = await Promise.all(searches.map(async (search) => {
      const query = new URLSearchParams({
        search,
        ancestorNoteId: this.config.parentNoteId,
        ancestorDepth: "lt5",
        fastSearch: "true"
      });
      return this.request<SearchResponse>(`/notes?${query.toString()}`);
    }));
    const notes = [...new Map(responses.flatMap((response) => response.results)
      .filter((note) => note.title.startsWith("Course OS draft record · "))
      .map((note) => [note.noteId, note])).values()];
    const concurrency = pageIds ? 4 : 8;
    const recordsBySearchOrder = new Array<LocatedDraftPageRecord | undefined>(notes.length);
    await forEachWithConcurrency(notes.map((note, index) => ({ note, index })), concurrency, async ({ note, index }) => {
      const parsed = decodeReadWeaveStateContent(await this.getContent(note.noteId)) as Partial<EtapiDraftPageRecord>;
      if (!parsed.pageId || !parsed.draft || !parsed.projection || parsed.draft.pageId !== parsed.pageId) return;
      if (pageIds && !pageIds.has(parsed.pageId)) return;
      const located = {
        noteId: note.noteId,
        record: {
          schemaVersion: "1.0.0" as const,
          pageId: parsed.pageId,
          draft: parsed.draft,
          projection: parsed.projection,
          costEntries: parsed.costEntries ?? [],
          idempotency: parsed.idempotency ?? {},
          conflicts: parsed.conflicts ?? []
        }
      };
      recordsBySearchOrder[index] = located;
    });
    const located = recordsBySearchOrder.filter((item): item is LocatedDraftPageRecord => item !== undefined);
    const newest = new Map<string, LocatedDraftPageRecord>();
    for (const candidate of located) {
      const previous = newest.get(candidate.record.pageId);
      if (!previous
        || candidate.record.draft.revision > previous.record.draft.revision
        || (candidate.record.draft.revision === previous.record.draft.revision
          && candidate.noteId.localeCompare(previous.noteId) < 0)) {
        newest.set(candidate.record.pageId, candidate);
      }
    }
    for (const candidate of newest.values()) {
      if ((this.draftPageRecordVersions.get(candidate.record.pageId) ?? 0)
        <= (observedVersions.get(candidate.record.pageId) ?? 0)) this.cacheDraftPageRecord(candidate);
    }
    return [...newest.values()];
  }

  private async findDraftPageRecord(pageId: string): Promise<LocatedDraftPageRecord | undefined> {
    const located = (await this.readDraftPageRecords(pageId))[0];
    const cached = this.draftPageRecordCache.get(pageId);
    if (cached || located) {
      return cached && (!located || cached.record.draft.revision > located.record.draft.revision)
        ? cached : located;
    }
    return this.recoverUnlabelledDraftPageRecord(pageId);
  }

  private async recoverUnlabelledDraftPageRecord(pageId: string, contentConcurrency?: number): Promise<LocatedDraftPageRecord | undefined> {
    const projection = await this.ensureWorkspace();
    const title = `Course OS draft record · ${pageId}`;
    const query = new URLSearchParams({
      search: quoteSearchValue(title),
      ancestorNoteId: projection.stateNoteId,
      ancestorDepth: "lt5",
      fastSearch: "true"
    });
    const results = (await this.request<SearchResponse>(`/notes?${query.toString()}`)).results
      .filter((note) => note.title === title);
    const readCandidate = async (note: SearchResponse["results"][number]) => {
      const content = await this.getContent(note.noteId);
      let parsed: Partial<EtapiDraftPageRecord>;
      try {
        parsed = decodeReadWeaveStateContent(content) as Partial<EtapiDraftPageRecord>;
      } catch {
        return undefined;
      }
      if (parsed.pageId !== pageId || !parsed.draft?.page || !parsed.projection || parsed.draft.pageId !== pageId
        || parsed.draft.contentHash !== sha256(JSON.stringify(parsed.draft.page))) return undefined;
      return {
        content,
        located: {
          noteId: note.noteId,
          record: {
            schemaVersion: "1.0.0" as const,
            pageId,
            draft: parsed.draft,
            projection: parsed.projection,
            costEntries: parsed.costEntries ?? [],
            idempotency: parsed.idempotency ?? {},
            conflicts: parsed.conflicts ?? []
          }
        } satisfies LocatedDraftPageRecord
      };
    };
    const candidates: NonNullable<Awaited<ReturnType<typeof readCandidate>>>[] = [];
    const concurrency = contentConcurrency ?? Math.max(1, results.length);
    for (let offset = 0; offset < results.length; offset += concurrency) {
      const batch = await Promise.all(results.slice(offset, offset + concurrency).map(readCandidate));
      candidates.push(...batch.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined));
    }
    candidates.sort((left, right) => right.located.record.draft.revision - left.located.record.draft.revision
      || left.located.noteId.localeCompare(right.located.noteId));
    const selected = candidates[0];
    if (!selected) return undefined;

    for (const duplicate of candidates.slice(1)) {
      if (duplicate.content === selected.content) await this.deleteNote(duplicate.located.noteId);
    }
    const [typeLabel, pageLabel] = await Promise.all([
      this.searchDraftRecordLabel(projection.stateNoteId, "courseOsType", "draft_record"),
      this.searchDraftRecordLabel(projection.stateNoteId, "courseOsDraftRecordPageId", pageId)
    ]);
    if (!typeLabel.has(selected.located.noteId)) await this.addDraftRecordLabel(selected.located.noteId, "courseOsType", "draft_record");
    if (!pageLabel.has(selected.located.noteId)) await this.addDraftRecordLabel(selected.located.noteId, "courseOsDraftRecordPageId", pageId);
    this.cacheDraftPageRecord(selected.located);
    return selected.located;
  }

  private async searchDraftRecordLabel(stateNoteId: string, name: string, value: string): Promise<Set<string>> {
    const query = new URLSearchParams({
      search: `#${name}=${quoteSearchValue(value)}`,
      ancestorNoteId: stateNoteId,
      ancestorDepth: "lt5",
      fastSearch: "true"
    });
    return new Set((await this.request<SearchResponse>(`/notes?${query.toString()}`)).results.map((note) => note.noteId));
  }

  private async addDraftRecordLabel(noteId: string, name: string, value: string): Promise<void> {
    await this.request("/attributes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteId, type: "label", name, value, position: 10, isInheritable: false })
    });
  }

  private cacheDraftPageRecord(located: LocatedDraftPageRecord): void {
    this.draftPageRecordCache.set(located.record.pageId, located);
    const assessmentNoteId = located.record.projection.sectionNoteIds.assessment;
    if (assessmentNoteId) this.activityRoutes?.assessmentNoteIds.set(located.record.pageId, assessmentNoteId);
    this.draftPageRecordVersion += 1;
    this.draftPageRecordVersions.set(located.record.pageId, this.draftPageRecordVersion);
  }

  private mergeDraftPageRecord(state: EtapiState, record: EtapiDraftPageRecord): void {
    const draftIndex = state.drafts.findIndex((draft) => draft.pageId === record.pageId);
    if (draftIndex >= 0) state.drafts[draftIndex] = structuredClone(record.draft);
    else state.drafts.push(structuredClone(record.draft));
    state.projections.drafts[record.draft.id] = structuredClone(record.projection);

    const costsById = new Map(state.costEntries.filter((entry) => entry.pageId !== record.pageId).map((entry) => [entry.id, entry]));
    for (const entry of state.costEntries.filter((item) => item.pageId === record.pageId)) costsById.set(entry.id, entry);
    for (const entry of record.costEntries) costsById.set(entry.id, structuredClone(entry));
    state.costEntries = [...costsById.values()];

    // Callers own this state snapshot. Preserve spread's own data properties,
    // including __proto__, without copying the full dictionary for every page.
    for (const key of Reflect.ownKeys(record.idempotency)) {
      if (!Object.prototype.propertyIsEnumerable.call(record.idempotency, key)) continue;
      Object.defineProperty(state.idempotency, key, {
        value: Reflect.get(record.idempotency, key), writable: true, enumerable: true, configurable: true
      });
    }
    const conflictsById = new Map(state.conflicts.filter((item) => item.objectId !== record.pageId).map((item) => [item.id, item]));
    for (const item of state.conflicts.filter((conflict) => conflict.objectId === record.pageId)) conflictsById.set(item.id, item);
    for (const item of record.conflicts) conflictsById.set(item.id, structuredClone(item));
    state.conflicts = [...conflictsById.values()];
  }

  private makeDraftPageRecord(
    state: DraftPageReadContext,
    draft: LessonDraft,
    projection: DraftProjection,
    previous?: EtapiDraftPageRecord
  ): EtapiDraftPageRecord {
    const costEntries = mergeCostEntries(
      state.costEntries.filter((entry) => entry.pageId === draft.pageId),
      previous?.costEntries
    );
    const costIds = new Set(costEntries.map((entry) => entry.id));
    const legacyIdempotency = Object.fromEntries(Object.entries(state.idempotency).filter(([, value]) =>
      (value.kind === "draft" && value.objectId === draft.id) ||
      (value.kind === "cost_entry" && costIds.has(value.objectId)) ||
      (value.kind === "conflict" && state.conflicts.some((item) => item.objectId === draft.pageId && item.id === value.objectId))
    ));
    const conflictMap = new Map(state.conflicts.filter((item) => item.objectId === draft.pageId).map((item) => [item.id, item]));
    for (const item of previous?.conflicts ?? []) conflictMap.set(item.id, item);
    return {
      schemaVersion: "1.0.0",
      pageId: draft.pageId,
      draft: structuredClone(draft),
      projection: structuredClone(projection),
      costEntries,
      idempotency: { ...legacyIdempotency, ...(previous?.idempotency ?? {}) },
      conflicts: [...conflictMap.values()]
    };
  }

  private async withDraftPageLock<T>(pageId: string, context: IdempotentWriteContext | undefined, work: () => Promise<T>): Promise<T> {
    const lockKey = [this.config.baseUrl, this.config.parentNoteId, this.workspaceId, pageId].join("\u0000");
    const predecessor = draftPageWriteChains.get(lockKey) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    draftPageWriteChains.set(lockKey, current);
    await predecessor.catch(() => undefined);
    try {
      return context ? await this.writeContext.run(context, work) : await work();
    } finally {
      release();
      if (draftPageWriteChains.get(lockKey) === current) draftPageWriteChains.delete(lockKey);
    }
  }

  private async writeDraftPageRecord(
    record: EtapiDraftPageRecord,
    noteId: string | undefined,
    fallbackState?: EtapiState
  ): Promise<string> {
    try {
      const content = await encodeReadWeaveStateContentAsync(record);
      let savedNoteId = noteId;
      if (savedNoteId) {
        await this.putContent(savedNoteId, content);
      } else {
        if (!fallbackState) throw new Error("READWEAVE_STATE_REFERENCE_REQUIRED");
        const note = await this.createNote(fallbackState.projections.stateNoteId, `Course OS draft record · ${record.pageId}`, content, "code", "application/json", {
          courseOsType: "draft_record",
          courseOsDraftRecordPageId: record.pageId
        });
        savedNoteId = note.noteId;
      }
      const readback = decodeReadWeaveStateContent(await this.getContent(savedNoteId)) as Partial<EtapiDraftPageRecord>;
      if (readback.pageId !== record.pageId
        || readback.draft?.revision !== record.draft.revision
        || readback.draft?.contentHash !== record.draft.contentHash
        || readback.draft?.contentHash !== sha256(JSON.stringify(readback.draft.page))) {
        throw new Error("READWEAVE_DRAFT_RECORD_READBACK_FAILED");
      }
      const located: LocatedDraftPageRecord = {
        noteId: savedNoteId,
        record: {
          schemaVersion: "1.0.0",
          pageId: record.pageId,
          draft: structuredClone(record.draft),
          projection: structuredClone(record.projection),
          costEntries: structuredClone(record.costEntries),
          idempotency: structuredClone(record.idempotency),
          conflicts: structuredClone(record.conflicts)
        }
      };
      const base = this.stateCache?.state ?? fallbackState;
      const cached = this.draftPageRecordCache.get(record.pageId);
      const newerRecord = cached && cached.record.draft.revision > record.draft.revision ? cached : undefined;
      const latestDraft = base?.drafts.find(item => item.pageId === record.pageId);
      let committed = newerRecord?.record ?? located.record;
      if (newerRecord) committed = { ...committed,
        costEntries: mergeCostEntries(record.costEntries, committed.costEntries),
        idempotency: { ...record.idempotency, ...committed.idempotency },
        conflicts: [...new Map([...record.conflicts, ...committed.conflicts].map(item => [item.id, item])).values()] };
      if (latestDraft && latestDraft.revision > committed.draft.revision) {
        const latest = this.createDraftPageReadContext(base, latestDraft);
        committed = { ...committed, draft: structuredClone(latestDraft),
          projection: latest.projections.drafts[latestDraft.id] ?? committed.projection,
          costEntries: mergeCostEntries(committed.costEntries, latest.costEntries),
          idempotency: { ...committed.idempotency, ...latest.idempotency },
          conflicts: [...new Map([...committed.conflicts, ...latest.conflicts].map(item => [item.id, item])).values()] };
      }
      let next: EtapiState | undefined;
      if (base) {
        next = { ...base, drafts: [...base.drafts], idempotency: { ...base.idempotency },
          projections: { ...base.projections, drafts: { ...base.projections.drafts } } };
        const courseId = record.draft.courseId;
        const incomingCourse = fallbackState?.projections.courses[courseId];
        const currentCourse = base.projections.courses[courseId];
        if (incomingCourse && incomingCourse !== currentCourse) {
          next.projections.courses = { ...base.projections.courses, [courseId]: {
            ...incomingCourse, ...currentCourse,
            modules: { ...incomingCourse.modules, ...currentCourse?.modules },
            moduleBranchIds: { ...incomingCourse.moduleBranchIds, ...currentCourse?.moduleBranchIds },
            childBranchIds: { ...incomingCourse.childBranchIds, ...currentCourse?.childBranchIds }
          } };
        }
        this.mergeDraftPageRecord(next, committed);
      }
      this.cacheDraftPageRecord({ noteId: newerRecord?.noteId ?? savedNoteId, record: committed });
      this.lastWriteAt = new Date().toISOString();
      this.stateVersion += 1;
      if (next) this.stateCache = { state: next, expiresAt: Date.now() + EtapiReadWeaveCourseApi.readCacheTtlMs };
      this.draftReadCache.delete(record.pageId);
      return savedNoteId;
    } catch (error) {
      this.invalidateStateCache();
      throw error;
    }
  }

  private async writeState(state: EtapiState): Promise<void> {
    const timingEnabled = process.env.COURSE_OS_READWEAVE_TIMING === "1";
    let encodeMs: number | undefined;
    let snapshotBytes: number | undefined;
    let stateNotePutMs: number | undefined;
    let phase: "encode" | "put" | "complete" = "encode";
    let succeeded = false;
    try {
      for (const located of this.draftPageRecordCache.values()) this.mergeDraftPageRecord(state, located.record);
      this.upsertStableMaterialNodes(state);
      const split = await this.prepareMetadataAwareStateWrite(state);
      const encodeStartedAt = timingEnabled ? performance.now() : 0;
      let content: string;
      try {
        content = await encodeReadWeaveStateContentAsync(split.coreState ?? state);
      } finally {
        if (timingEnabled) encodeMs = Math.round(performance.now() - encodeStartedAt);
      }
      if (timingEnabled) snapshotBytes = Buffer.byteLength(content);
      phase = "put";
      await this.putContent(state.projections.stateNoteId, content, timingEnabled
        ? (durationMs) => { stateNotePutMs = durationMs; }
        : undefined);
      this.lastWriteAt = new Date().toISOString();
      for (const located of this.draftPageRecordCache.values()) this.mergeDraftPageRecord(state, located.record);
      // `mutate` owns this object and serializes every writer through
      // `writeChain`, so the committed snapshot can become the cache directly.
      // Public reads still clone the values they return.
      this.stateVersion += 1;
      this.stateCache = { state, expiresAt: Date.now() + EtapiReadWeaveCourseApi.readCacheTtlMs };
      this.cacheActivityRoutes(state);
      if (state.projections.activityStateNoteId) this.commitActivityState(this.activityState(state));
      phase = "complete";
      succeeded = true;
    } catch (error) {
      this.invalidateStateCache();
      throw error;
    } finally {
      if (timingEnabled) {
        this.logWriteTiming("course_os.readweave_state_write_timing", {
          encodeMs,
          snapshotBytes,
          stateNotePutMs,
          phase,
          succeeded
        });
      }
    }
  }

  private activityState(state: EtapiState): EtapiActivityState {
    return {
      schemaVersion: "1.0.0",
      questionSelections: state.questionSelections,
      questionAttempts: state.questionAttempts,
      attempts: state.attempts,
      mastery: state.mastery,
      idempotency: Object.fromEntries(Object.entries(state.idempotency).filter(([, entry]) => activityIdempotencyKinds.has(entry.kind)))
    };
  }

  private activityStateFrom(value: Partial<EtapiActivityState>): EtapiActivityState {
    return {
      schemaVersion: "1.0.0",
      questionSelections: value.questionSelections ?? [],
      questionAttempts: value.questionAttempts ?? [],
      attempts: value.attempts ?? [],
      mastery: value.mastery ?? [],
      idempotency: Object.fromEntries(Object.entries(value.idempotency ?? {})
        .filter(([, entry]) => activityIdempotencyKinds.has(entry.kind)))
    };
  }

  private applyActivityState(state: EtapiState, activity: EtapiActivityState): void {
    state.questionSelections = activity.questionSelections;
    state.questionAttempts = activity.questionAttempts;
    state.attempts = activity.attempts;
    state.mastery = activity.mastery;
    for (const [key, entry] of Object.entries(state.idempotency)) {
      if (activityIdempotencyKinds.has(entry.kind)) delete state.idempotency[key];
    }
    Object.assign(state.idempotency, activity.idempotency);
  }

  private cacheActivityRoutes(state: Partial<EtapiState>): void {
    const projection = state.projections;
    if (!projection) return;
    if (projection.activityStateNoteId) this.activityStateNoteId = projection.activityStateNoteId;
    const releases = new Map<string, Pick<CourseRelease, "id" | "courseId">>();
    for (const release of state.releases ?? []) {
      releases.set(release.id, { id: release.id, courseId: release.courseId });
    }
    const assessmentNoteIds = new Map<string, string>();
    for (const draft of state.drafts ?? []) {
      const noteId = projection.drafts[draft.id]?.sectionNoteIds.assessment;
      if (noteId) assessmentNoteIds.set(draft.pageId, noteId);
    }
    for (const [pageId, located] of this.draftPageRecordCache) {
      const noteId = located.record.projection.sectionNoteIds.assessment;
      if (noteId) assessmentNoteIds.set(pageId, noteId);
    }
    this.activityRoutes = {
      activityStateNoteId: projection.activityStateNoteId,
      releases,
      reviewNoteIds: new Map(Object.entries(projection.courses).map(([courseId, course]) => [courseId, course.reviewNoteId])),
      assessmentNoteIds
    };
  }

  private async readActivityReference(noteId?: string): Promise<EtapiActivityState> {
    const activityNoteId = noteId ?? await this.findActivityStateNoteId();
    if (!activityNoteId) {
      const state = await this.readStateReference();
      this.cacheActivityRoutes(state);
      return this.activityState(state);
    }
    const now = Date.now();
    if (this.activityCache && this.activityCache.expiresAt > now) return this.activityCache.state;

    if (this.writeContext.getStore()) {
      const versionAtReadStart = this.activityVersion;
      const content = await this.getContent(activityNoteId);
      const activity = this.activityStateFrom(decodeReadWeaveStateContent(content) as Partial<EtapiActivityState>);
      if (this.activityVersion === versionAtReadStart) {
        this.activityCache = { state: activity, expiresAt: Date.now() + EtapiReadWeaveCourseApi.readCacheTtlMs };
      }
      return activity;
    }

    if (!this.activityReadInFlight) {
      const versionAtReadStart = this.activityVersion;
      const read = createSharedRead(async () => {
        const content = await this.getContent(activityNoteId);
        return this.activityStateFrom(decodeReadWeaveStateContent(content) as Partial<EtapiActivityState>);
      });
      this.activityReadInFlight = read;
      void read.promise.then((activity) => {
        if (this.activityReadInFlight === read && this.activityVersion === versionAtReadStart) {
          this.activityCache = { state: activity, expiresAt: Date.now() + EtapiReadWeaveCourseApi.readCacheTtlMs };
        }
      }).catch(() => undefined).finally(() => {
        if (this.activityReadInFlight === read) this.activityReadInFlight = undefined;
      });
    }
    const pendingRead = this.activityReadInFlight;
    if (!pendingRead) throw new Error("READWEAVE_ACTIVITY_READ_MISSING");
    const activity = await joinSharedRead(pendingRead, currentReadBudget());
    return this.activityCache && this.activityCache.expiresAt > Date.now() ? this.activityCache.state : activity;
  }

  private async findActivityStateNoteId(): Promise<string | undefined> {
    const known = this.activityStateNoteId ?? this.activityRoutes?.activityStateNoteId ?? this.stateCache?.state.projections.activityStateNoteId;
    if (known) return known;
    const workspaceRootNoteId = await this.findWorkspaceRootNoteId();
    if (!workspaceRootNoteId) return undefined;
    const query = new URLSearchParams({
      search: `#courseOsActivityIndex=${quoteSearchValue(this.workspaceId)}`,
      ancestorNoteId: workspaceRootNoteId,
      ancestorDepth: "lt5",
      fastSearch: "true"
    });
    const [workspaceRoot, response] = await Promise.all([
      this.getNote(workspaceRootNoteId),
      this.request<SearchResponse>(`/notes?${query.toString()}`)
    ]);
    const directChildIds = new Set(workspaceRoot.childNoteIds ?? []);
    const matches = response.results.filter((note) => directChildIds.has(note.noteId) && note.title === activityIndexTitle);
    if (matches.length > 1) throw new Error("READWEAVE_ACTIVITY_INDEX_DUPLICATE");
    if (matches.length === 0) return undefined;
    this.activityStateNoteId = matches[0]!.noteId;
    if (this.activityRoutes) this.activityRoutes.activityStateNoteId = this.activityStateNoteId;
    return this.activityStateNoteId;
  }

  private trustedWorkspaceRootNoteId(): string | undefined {
    const bootstrapRoot = this.bootstrapCache?.projection.courseRootNoteId;
    if (bootstrapRoot) return bootstrapRoot;

    const now = Date.now();
    const stateCache = this.stateCache;
    if (stateCache && stateCache.expiresAt > now && stateCache.state.projections.courseRootNoteId) {
      return stateCache.state.projections.courseRootNoteId;
    }

    const metadataCache = this.metadataIndexCache;
    if (metadataCache && metadataCache.expiresAt > now
      && metadataCache.index.workspaceId === this.workspaceId
      && metadataCache.index.status === "active") {
      return metadataCache.index.projections.courseRootNoteId;
    }
    return undefined;
  }

  private async findWorkspaceRootNoteId(): Promise<string | undefined> {
    const trusted = this.trustedWorkspaceRootNoteId();
    if (trusted) return trusted;

    const query = new URLSearchParams({
      search: `#courseOsType=${quoteSearchValue("workspace")} AND #courseOsWorkspaceId=${quoteSearchValue(this.workspaceId)}`,
      ancestorNoteId: this.config.parentNoteId,
      ancestorDepth: "lt5",
      fastSearch: "true"
    });
    const [parent, response] = await Promise.all([
      this.getNote(this.config.parentNoteId),
      this.request<SearchResponse>(`/notes?${query.toString()}`)
    ]);
    const directChildIds = new Set(parent.childNoteIds ?? []);
    const workspaceMatches = response.results.filter((note) => note.type === "text");
    const directMatches = workspaceMatches.filter((note) => directChildIds.has(note.noteId));
    if (directMatches.length > 1) throw new Error("READWEAVE_WORKSPACE_ROOT_AMBIGUOUS");
    if (directMatches.length === 1) return directMatches[0]!.noteId;
    if (response.results.length > 0) throw new Error("READWEAVE_WORKSPACE_ROOT_NOT_FOUND");
    return undefined;
  }

  private async findCourseIndexNotes(ancestorNoteId: string, directChildrenOnly = true): Promise<EtapiNote[]> {
    const query = new URLSearchParams({
      search: `#courseOsIndex=${this.workspaceId}`,
      ancestorNoteId,
      ancestorDepth: "lt5",
      fastSearch: "true"
    });
    if (!directChildrenOnly) return (await this.request<SearchResponse>(`/notes?${query.toString()}`)).results;
    const [parent, response] = await Promise.all([
      this.getNote(ancestorNoteId),
      this.request<SearchResponse>(`/notes?${query.toString()}`)
    ]);
    const directChildIds = new Set(parent.childNoteIds ?? []);
    return response.results.filter((note) => directChildIds.has(note.noteId));
  }

  private async questionAttemptNoteParent(releaseId: string, pageId: string): Promise<string | undefined> {
    let routes = this.activityRoutes ?? (await this.ensureWorkspace(), this.activityRoutes);
    if (!routes?.releases.has(releaseId)) {
      const state = await this.readStateReference(true);
      this.cacheActivityRoutes(state);
      routes = this.activityRoutes;
    }
    const release = routes?.releases.get(releaseId);
    if (!release) return undefined;
    const courseNoteId = routes?.reviewNoteIds.get(release.courseId);
    if (!courseNoteId) {
      const state = await this.readStateReference(true);
      const fullRelease = state.releases.find((item) => item.id === releaseId);
      if (!fullRelease) return undefined;
      const course = await this.ensureCourseProjection(state, fullRelease);
      this.cacheActivityRoutes(state);
      return this.activityRoutes?.assessmentNoteIds.get(pageId) ?? course.reviewNoteId;
    }
    const pageNoteId = routes?.assessmentNoteIds.get(pageId);
    if (pageNoteId) return pageNoteId;
    const state = await this.readStateReference();
    const draft = state.drafts.find((item) => item.pageId === pageId);
    const assessmentNoteId = draft ? state.projections.drafts[draft.id]?.sectionNoteIds.assessment : undefined;
    if (assessmentNoteId) this.activityRoutes?.assessmentNoteIds.set(pageId, assessmentNoteId);
    return assessmentNoteId ?? courseNoteId;
  }

  private async writeQuestionAttemptNote(
    attempt: QuestionAttempt,
    assessmentAttempt: AssessmentAttempt | undefined,
    mastery: MasteryRecord | undefined,
    ensureExisting: boolean
  ): Promise<void> {
    const parentNoteId = await this.questionAttemptNoteParent(attempt.courseReleaseId, attempt.pageId);
    if (!parentNoteId) return;
    if (ensureExisting) {
      const query = new URLSearchParams({
        search: `#courseOsObjectId="${attempt.id}"`,
        ancestorNoteId: this.config.parentNoteId,
        ancestorDepth: "lt12",
        fastSearch: "true"
      });
      if ((await this.request<SearchResponse>(`/notes?${query.toString()}`)).results.length > 0) return;
    }
    const body = assessmentAttempt && mastery
      ? { attempt, assessmentAttempt, mastery }
      : attempt;
    const kind = assessmentAttempt ? "question_attempt_transaction" : "question_attempt";
    await this.createNote(parentNoteId, `作答 · ${attempt.pageId}`, `<pre>${escapeHtml(JSON.stringify(body, null, 2))}</pre>`, "text", undefined, {
      courseOsType: kind, courseOsObjectId: attempt.id, courseOsPageId: attempt.pageId
    });
  }

  private async initializeActivityState(state: EtapiState): Promise<void> {
    const note = await this.createNote(
      state.projections.courseRootNoteId,
      "01 Course OS 学习活动索引",
      await encodeReadWeaveStateContentAsync(this.activityState(state)),
      "code",
      "application/json",
      { courseOsActivityIndex: this.workspaceId, courseOsType: "activity_index" }
    );
    state.projections.activityStateNoteId = note.noteId;
    // Persist the pointer once. Later selections and attempts update only the
    // compact activity index, while the immutable course material stays put.
    await this.writeState(state);
  }

  private async writeActivityState(state: EtapiState): Promise<void> {
    const noteId = state.projections.activityStateNoteId;
    if (!noteId) throw new Error("READWEAVE_ACTIVITY_INDEX_NOT_INITIALIZED");
    const timingEnabled = process.env.COURSE_OS_READWEAVE_TIMING === "1";
    try {
      const encodeStartedAt = timingEnabled ? performance.now() : 0;
      const activity = this.activityState(state);
      const content = await encodeReadWeaveStateContentAsync(activity);
      const putStartedAt = timingEnabled ? performance.now() : 0;
      await this.putContent(noteId, content);
      const putFinishedAt = timingEnabled ? performance.now() : 0;
      this.lastWriteAt = new Date().toISOString();
      this.commitActivityState(activity);
      this.stateVersion += 1;
      if (timingEnabled) this.logWriteTiming("course_os.readweave_activity_state_write_timing", {
        encodeMs: Math.round(putStartedAt - encodeStartedAt), revisionAndPutMs: Math.round(putFinishedAt - putStartedAt),
        idempotencyKeyCount: Object.keys(activity.idempotency).length
      });
    } catch (error) {
      this.invalidateStateCache();
      throw error;
    }
  }

  private commitActivityState(activity: EtapiActivityState): void {
    this.activityVersion += 1;
    this.activityCache = { state: activity, expiresAt: Date.now() + EtapiReadWeaveCourseApi.readCacheTtlMs };
    const cache = this.stateCache;
    if (!cache) return;
    const state = cache.state;
    state.questionSelections = structuredClone(activity.questionSelections);
    state.questionAttempts = structuredClone(activity.questionAttempts);
    state.attempts = structuredClone(activity.attempts);
    state.mastery = structuredClone(activity.mastery);
    for (const [key, entry] of Object.entries(state.idempotency)) {
      if (activityIdempotencyKinds.has(entry.kind)) delete state.idempotency[key];
    }
    Object.assign(state.idempotency, structuredClone(activity.idempotency));
    cache.expiresAt = Date.now() + EtapiReadWeaveCourseApi.readCacheTtlMs;
  }

  private async readCostIndex(noteId: string): Promise<EtapiCostIndexState> {
    const parsed = decodeReadWeaveStateContent(await this.getContent(noteId)) as Partial<EtapiCostIndexState>;
    return {
      schemaVersion: "1.0.0",
      costEntries: parsed.costEntries ?? [],
      idempotency: parsed.idempotency ?? {}
    };
  }

  private async mutateActivity<T>(change: (state: EtapiActivityState) => Promise<T>, context: IdempotentWriteContext): Promise<T> {
    return this.enqueueWrite(async () => {
      const timingEnabled = process.env.COURSE_OS_READWEAVE_TIMING === "1";
      const mutationStartedAt = timingEnabled ? performance.now() : 0;
      let activityReadMs = 0;
      let activityCloneMs = 0;
      let changeMs = 0;
      let activityWriteMs = 0;
      let replay = false;
      try {
        const activityNoteId = await this.findActivityStateNoteId();
        let result: T;
        if (activityNoteId) {
          const readStartedAt = timingEnabled ? performance.now() : 0;
          const reference = await this.readActivityReference(activityNoteId);
          if (timingEnabled) activityReadMs = performance.now() - readStartedAt;
          const cloneStartedAt = timingEnabled ? performance.now() : 0;
          const activity = structuredClone(reference);
          if (timingEnabled) activityCloneMs = performance.now() - cloneStartedAt;
          replay = Boolean(activity.idempotency[context.idempotencyKey]);
          const changeStartedAt = timingEnabled ? performance.now() : 0;
          result = structuredClone(await change(activity));
          if (timingEnabled) changeMs = performance.now() - changeStartedAt;
          if (!replay) {
            const writeStartedAt = timingEnabled ? performance.now() : 0;
            await this.writeActivityIndex(activityNoteId, activity);
            if (timingEnabled) activityWriteMs = performance.now() - writeStartedAt;
          }
        } else {
          // A legacy workspace has no separate activity note yet. Initialize
          // it once from the root snapshot, without draft hydration/merging.
          const readStartedAt = timingEnabled ? performance.now() : 0;
          const source = await this.readStateReference(true);
          if (timingEnabled) activityReadMs = performance.now() - readStartedAt;
          const cloneStartedAt = timingEnabled ? performance.now() : 0;
          const state = structuredClone(source);
          if (timingEnabled) activityCloneMs = performance.now() - cloneStartedAt;
          const activity = this.activityState(state);
          replay = Boolean(activity.idempotency[context.idempotencyKey]);
          const changeStartedAt = timingEnabled ? performance.now() : 0;
          result = structuredClone(await change(activity));
          if (timingEnabled) changeMs = performance.now() - changeStartedAt;
          if (!replay) {
            this.applyActivityState(state, activity);
            const writeStartedAt = timingEnabled ? performance.now() : 0;
            await this.initializeActivityState(state);
            if (timingEnabled) activityWriteMs = performance.now() - writeStartedAt;
          }
        }
        if (timingEnabled) this.logWriteTiming("course_os.readweave_activity_mutation_timing", {
          activityReadMs: Math.round(activityReadMs), activityCloneMs: Math.round(activityCloneMs),
          changeMs: Math.round(changeMs), activityWriteMs: Math.round(activityWriteMs),
          totalMs: Math.round(performance.now() - mutationStartedAt), replay
        });
        return result;
      } catch (error) {
        // Activity writes do not mutate the course snapshot. Keep its last
        // committed value available when the activity index write fails.
        throw error;
      }
    }, context);
  }

  private async writeActivityIndex(noteId: string, activity: EtapiActivityState): Promise<void> {
    const timingEnabled = process.env.COURSE_OS_READWEAVE_TIMING === "1";
    const encodeStartedAt = timingEnabled ? performance.now() : 0;
    const content = await encodeReadWeaveStateContentAsync(activity);
    const putStartedAt = timingEnabled ? performance.now() : 0;
    try {
      await this.putContent(noteId, content);
      this.lastWriteAt = new Date().toISOString();
      this.commitActivityState(activity);
      this.stateVersion += 1;
      if (timingEnabled) this.logWriteTiming("course_os.readweave_activity_state_write_timing", {
        encodeMs: Math.round(putStartedAt - encodeStartedAt),
        revisionAndPutMs: Math.round(performance.now() - putStartedAt),
        idempotencyKeyCount: Object.keys(activity.idempotency).length
      });
    } catch (error) {
      if (timingEnabled) this.logWriteTiming("course_os.readweave_activity_state_write_timing", {
        encodeMs: Math.round(putStartedAt - encodeStartedAt), revisionAndPutMs: Math.round(performance.now() - putStartedAt),
        idempotencyKeyCount: Object.keys(activity.idempotency).length, succeeded: false
      });
      // ETAPI can commit a PUT and lose its response. Force the next mutation
      // or readback to reload the authoritative activity index before replay.
      this.invalidateStateCache();
      this.activityVersion += 1;
      this.activityCache = undefined;
      this.activityReadInFlight = undefined;
      throw error;
    }
  }

  private async mutate<T>(change: (state: EtapiState) => Promise<T>, context?: IdempotentWriteContext): Promise<T> {
    return this.enqueueWrite(async () => {
      try {
        const pendingRead = this.stateReadInFlight;
        if (pendingRead) await pendingRead.promise.catch(() => undefined);
        // The API process is the only writer of the Course OS state note. Most
        // write routes have already loaded this snapshot to check workspace
        // ownership and revisions, so downloading the same multi-megabyte note
        // again only adds seconds of latency. An expired or missing snapshot is
        // still fetched from ReadWeave before the mutation.
        const state = structuredClone(await this.readStateReference(true));
        await this.mergeDraftPageRecords(state);
        const replay = Boolean(context && state.idempotency[context.idempotencyKey]);
        const activityBefore = state.projections.activityStateNoteId
          ? JSON.stringify(this.activityState(state)) : undefined;
        const result = structuredClone(await change(state));
        if (!replay) {
          // Drafts, release metadata, and generation costs do not change the
          // learning activity index. Avoid rewriting that separate note for
          // every generated page while retaining the write for actual changes.
          if (state.projections.activityStateNoteId
            && JSON.stringify(this.activityState(state)) !== activityBefore) {
            await this.writeActivityState(state);
          }
          await this.writeState(state);
        }
        return result;
      } catch (error) {
        // A callback can update its private state object after a remote
        // projection call. If either step fails, discard the snapshot so no
        // reader can observe an uncommitted local mutation.
        this.invalidateStateCache();
        throw error;
      }
    }, context);
  }

  private enqueueWrite<T>(work: () => Promise<T>, context?: IdempotentWriteContext): Promise<T> {
    const timingEnabled = process.env.COURSE_OS_READWEAVE_TIMING === "1";
    const enqueuedAt = timingEnabled ? performance.now() : 0;
    const previous = etapiWriteChains.get(this.writeQueueKey) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const workStartedAt = timingEnabled ? performance.now() : 0;
      let succeeded = false;
      try {
        const result = await (context ? this.writeContext.run(context, work) : work());
        succeeded = true;
        return result;
      } finally {
        if (timingEnabled) {
          this.logWriteTiming("course_os.readweave_write_queue_timing", {
            queueWaitMs: Math.round(workStartedAt - enqueuedAt),
            serializedWorkMs: Math.round(performance.now() - workStartedAt),
            succeeded
          });
        }
      }
    });
    etapiWriteChains.set(this.writeQueueKey, operation.then(() => undefined, () => undefined));
    return operation;
  }

  private logWriteTiming(event: string, timing: Record<string, number | string | boolean | undefined>): void {
    try {
      console.info(event, JSON.stringify(timing));
    } catch {
      // Timing output must never change whether a write succeeds.
    }
  }

  private invalidateStateCache(): void {
    this.stateVersion += 1;
    this.stateCache = undefined;
  }

  private async ensureWorkspace(): Promise<ProjectionIndex> {
    return (await this.ensureWorkspaceResult()).projection;
  }

  private async ensureWorkspaceResult(): Promise<BootstrapResult> {
    if (this.bootstrapCache) return this.bootstrapCache;
    if (!this.bootstrapInFlight) {
      const isWrite = Boolean(this.writeContext.getStore());
      const read = createSharedRead(
        (markIndependent) => this.bootstrap(isWrite ? undefined : markIndependent),
        { budgeted: !isWrite, independent: isWrite }
      );
      this.bootstrapInFlight = read;
      void read.promise.then((result) => {
        if (this.bootstrapInFlight === read) {
          this.commitBootstrapResult(result);
          this.bootstrapCache = result;
        }
      }).catch(() => undefined).finally(() => {
        if (this.bootstrapInFlight === read) this.bootstrapInFlight = undefined;
      });
    }
    const pendingRead = this.bootstrapInFlight;
    if (!pendingRead) throw new Error("READWEAVE_BOOTSTRAP_MISSING");
    const isWrite = Boolean(this.writeContext.getStore());
    const budget = isWrite ? undefined : currentReadBudget();
    return joinSharedRead(pendingRead, budget, { writeOwner: isWrite });
  }

  private commitBootstrapResult(result: BootstrapResult): void {
    const routeState = result.routeState ?? result.stateSnapshot;
    if (routeState) this.cacheActivityRoutes(routeState);
    result.routeState = undefined;
  }

  private async bootstrap(markIndependent?: () => void): Promise<BootstrapResult> {
    const workspaceRootNoteId = await this.findWorkspaceRootNoteId();
    const indexes = await this.findCourseIndexNotes(workspaceRootNoteId ?? this.config.parentNoteId, workspaceRootNoteId !== undefined);
    if (indexes.length > 1) throw new Error("READWEAVE_COURSE_INDEX_DUPLICATE");
    const existing = indexes[0];
    if (existing) {
      const content = await this.getContent(existing.noteId);
      const parsed = await decodeReadWeaveStateContentAsync(content) as Partial<EtapiState>;
      if (!parsed.projections) throw new Error("READWEAVE_COURSE_INDEX_INVALID");
      const indexedWorkspaceRoot = parsed.projections.courseRootNoteId;
      if (workspaceRootNoteId) {
        if (indexedWorkspaceRoot !== workspaceRootNoteId) throw new Error("READWEAVE_COURSE_INDEX_WORKSPACE_MISMATCH");
      } else {
        // Preserve a single legacy index only when its declared root is an
        // actual direct child of the configured parent and the index is below it.
        const parent = await this.getNote(this.config.parentNoteId);
        if (!indexedWorkspaceRoot || !(parent.childNoteIds ?? []).includes(indexedWorkspaceRoot)) {
          throw new Error("READWEAVE_COURSE_INDEX_WORKSPACE_MISMATCH");
        }
        const legacyIndexes = await this.findCourseIndexNotes(indexedWorkspaceRoot);
        if (legacyIndexes.length !== 1 || legacyIndexes[0]!.noteId !== existing.noteId) {
          throw new Error("READWEAVE_COURSE_INDEX_WORKSPACE_MISMATCH");
        }
      }
      return { projection: parsed.projections, stateSnapshot: parsed };
    }
    if (workspaceRootNoteId) throw new Error("READWEAVE_COURSE_INDEX_NOT_FOUND");
    // Initial workspace materialization creates remote notes. Once the empty
    // workspace is confirmed, let this bounded bootstrap finish independently
    // so a disconnect cannot strand a half-created workspace.
    markIndependent?.();
    const root = await this.createNote(this.config.parentNoteId, workspaceRootTitle, "<h2>Course OS</h2><p>课程制作、学习和长期复习的权威知识树</p>", "text", undefined, {
      courseOsType: "workspace",
      courseOsWorkspaceId: this.workspaceId
    });
    const stateNote = await this.createNote(root.noteId, workspaceIndexTitle, "{}", "code", "application/json", {
      courseOsIndex: this.workspaceId,
      courseOsType: "system_index"
    });
    const projection: ProjectionIndex = {
      courseRootNoteId: root.noteId,
      stateNoteId: stateNote.noteId,
      courses: {},
      drafts: {},
      releases: {}
    };
    const seed = await this.loadSeed();
    const state = normalizeState(seed, projection);
    await this.materializeSeed(state);
    await this.putContent(stateNote.noteId, JSON.stringify(state, null, 2));
    return { projection, routeState: state };
  }

  private async materializeSeed(state: EtapiState): Promise<void> {
    const latestPage = new Map<string, { release: CourseRelease; page: CourseRelease["pages"][number] }>();
    for (const release of [...state.releases].sort((left, right) => left.version - right.version)) {
      const course = await this.ensureCourseProjection(state, release);
      if (release.lifecycle !== "draft_source" && !state.projections.releases[release.id]) {
        const manifest = state.manifests.find((item) => item.courseReleaseId === release.id);
        const note = await this.createNote(course.releasesNoteId, `${release.moduleTitle} · v${release.version}`, JSON.stringify({ release, manifest }, null, 2), "code", "application/json", {
          courseOsType: "release",
          courseOsObjectId: release.id,
          courseOsImmutable: "true"
        });
        state.projections.releases[release.id] = note.noteId;
      }
      for (const page of release.pages) latestPage.set(page.id, { release, page });
    }
    for (const { release, page } of latestPage.values()) {
      let draft = state.drafts.find((item) => item.pageId === page.id);
      if (!draft) {
        draft = {
          id: `draft:${page.id}`,
          workspaceId: this.workspaceId,
          courseId: release.courseId,
          moduleId: release.moduleId,
          sourceReleaseId: release.id,
          pageId: page.id,
          revision: 0,
          status: release.lifecycle === "draft_source" ? "needs_review" : "clean",
          page: structuredClone(page),
          changedBlockIds: [],
          contentHash: sha256(JSON.stringify(page)),
          updatedAt: release.publishedAt
        };
        state.drafts.push(draft);
      }
      const pageProjection = await this.ensureDraftProjection(state, draft);
      await this.refreshDraftProjection(draft, pageProjection);
      draft.readweaveNoteId = pageProjection.pageNoteId;
    }
  }

  private async loadSeed(): Promise<Partial<EtapiState>> {
    if (!this.config.seedStatePath) return {};
    try {
      return JSON.parse(await readFile(this.config.seedStatePath, "utf8")) as Partial<EtapiState>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async createNote(parentNoteId: string, title: string, content: string, type: "text" | "code" | "image", mime?: string, labels: Record<string, string> = {}): Promise<EtapiNote & { branch: EtapiBranch }> {
    const created = await this.request<CreatedNoteResponse>("/create-note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentNoteId, title, type, mime, content, isExpanded: false })
    });
    for (const [name, value] of Object.entries(labels)) {
      await this.request("/attributes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noteId: created.note.noteId, type: "label", name, value, position: 10, isInheritable: false })
      });
    }
    return { ...created.note, branch: created.branch };
  }

  private async ensureCostNote(parentNoteId: string, entry: GenerationCostEntry): Promise<void> {
    const query = new URLSearchParams({
      search: `#courseOsObjectId="${entry.id}"`,
      ancestorNoteId: this.config.parentNoteId,
      fastSearch: "true"
    });
    const existing = (await this.request<SearchResponse>(`/notes?${query.toString()}`)).results;
    if (existing.length > 0) return;
    await this.createNote(parentNoteId, `成本 · ${entry.stage} · ${entry.model}`, `<pre>${escapeHtml(JSON.stringify(entry, null, 2))}</pre>`, "text", undefined, {
      courseOsType: "generation_cost", courseOsObjectId: entry.id, courseOsPageId: entry.pageId ?? ""
    });
  }

  private async ensureCostNoteOnce(parentNoteId: string, entry: GenerationCostEntry): Promise<void> {
    const pending = this.costNoteEnsures.get(entry.id);
    if (pending) return pending;
    const operation = this.ensureCostNote(parentNoteId, entry);
    this.costNoteEnsures.set(entry.id, operation);
    try {
      await operation;
    } finally {
      if (this.costNoteEnsures.get(entry.id) === operation) this.costNoteEnsures.delete(entry.id);
    }
  }

  private async getContent(noteId: string): Promise<string> {
    const response = await this.raw(`/notes/${encodeURIComponent(noteId)}/content`);
    return response.text();
  }

  private async putContent(noteId: string, content: string, onPutDuration?: (durationMs: number) => void): Promise<void> {
    await this.raw(`/notes/${encodeURIComponent(noteId)}/revision`, { method: "POST" });
    const putStartedAt = onPutDuration ? performance.now() : 0;
    try {
      await this.raw(`/notes/${encodeURIComponent(noteId)}/content`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: Buffer.from(content)
      });
    } finally {
      if (onPutDuration) onPutDuration(Math.round(performance.now() - putStartedAt));
    }
  }

  private async putBinaryContent(noteId: string, content: Uint8Array, mediaType: string): Promise<void> {
    await this.raw(`/notes/${encodeURIComponent(noteId)}/content`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "X-Course-Asset-Type": mediaType },
      body: Buffer.from(content)
    });
  }

  private async deleteNote(noteId: string): Promise<void> {
    await this.raw(`/notes/${encodeURIComponent(noteId)}`, { method: "DELETE" });
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.raw(path, init);
    return response.json() as Promise<T>;
  }

  private async raw(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", this.config.token);
    headers.set("Accept", "application/json");
    if (init?.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const writeContext = this.writeContext.getStore();
    if (writeContext) {
      headers.set("Idempotency-Key", writeContext.idempotencyKey);
      headers.set("X-Actor", writeContext.actor);
      headers.set("X-Workspace-Id", writeContext.workspaceId);
      headers.set("X-Request-Id", writeContext.requestId);
      headers.set("X-Schema-Version", writeContext.schemaVersion);
    }
    const base = this.config.baseUrl.replace(/\/$/, "");
    const input = `${base}/etapi${path}`;
    const method = (init?.method ?? "GET").toUpperCase();
    const budget = method === "GET" && !writeContext ? currentReadBudget() : undefined;
    if (budget) return this.rawWithReadBudget(input, init, headers, method, budget);
    return this.rawWithLegacyRetry(input, init, headers, method);
  }

  private async rawWithLegacyRetry(input: string, init: RequestInit | undefined, headers: Headers, method: string): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await this.fetchImpl(input, { ...init, headers, signal: controller.signal });
        if (response.ok) {
          if (method !== "GET") return response;
          const body = await response.arrayBuffer();
          return new Response(body.byteLength > 0 ? body : null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        }
        if (!shouldRetryHttpStatus(response.status) || attempt === 2) throw new Error(`READWEAVE_ETAPI_${response.status}:${await response.text()}`);
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : "REQUEST_FAILED";
        if (message.startsWith("READWEAVE_ETAPI_") && !message.startsWith("READWEAVE_ETAPI_NETWORK")) throw error;
        if (attempt === 2) throw new Error(`READWEAVE_ETAPI_NETWORK:${message}`);
      } finally {
        clearTimeout(timeout);
      }
      await delayForRetry(attempt);
    }
    throw new Error(`READWEAVE_ETAPI_NETWORK:${lastError instanceof Error ? lastError.message : "REQUEST_FAILED"}`);
  }

  private async rawWithReadBudget(
    input: string,
    init: RequestInit | undefined,
    headers: Headers,
    method: string,
    budget: ReadBudget
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assertReadBudgetActive(budget);
      const controller = new AbortController();
      let requestTimedOut = false;
      const remaining = budget.deadline === undefined ? Number.POSITIVE_INFINITY : budget.deadline - Date.now();
      if (remaining <= 0) throw readBudgetAbortError(budget.signal, budget.deadline);
      const sources = [
        { signal: budget.signal, isBudget: true },
        ...(init?.signal ? [{ signal: init.signal, isBudget: false }] : [])
      ];
      const uniqueSources = [...new Map(sources.map((source) => [source.signal, source])).values()];
      const listeners = uniqueSources.map(({ signal, isBudget }) => {
        const abort = () => controller.abort(isBudget
          ? readBudgetAbortError(signal, budget.deadline)
          : new Error("READ_CANCELLED"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        return { signal, abort };
      });
      const attemptLimit = Math.min(this.requestTimeoutMs, remaining);
      const deadlineOwnsAttempt = remaining <= this.requestTimeoutMs;
      const timeout = setTimeout(() => {
        requestTimedOut = !deadlineOwnsAttempt;
        controller.abort(new Error(deadlineOwnsAttempt ? "READ_DEADLINE_EXCEEDED" : "READWEAVE_REQUEST_TIMEOUT"));
      }, attemptLimit);

      try {
        if (controller.signal.aborted) throw controller.signal.reason;
        const response = await this.fetchImpl(input, { ...init, headers, signal: controller.signal });
        if (response.ok) {
          if (method !== "GET") return response;
          const body = await response.arrayBuffer();
          assertReadBudgetActive(budget);
          return new Response(body.byteLength > 0 ? body : null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        }
        if (!shouldRetryHttpStatus(response.status) || attempt === 2) {
          throw new Error(`READWEAVE_ETAPI_${response.status}:${await response.text()}`);
        }
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        if (budget.signal.aborted) throw readBudgetAbortError(budget.signal, budget.deadline);
        if (init?.signal?.aborted) throw new Error("READ_CANCELLED");
        if (budget.deadline !== undefined && Date.now() >= budget.deadline) {
          throw readBudgetAbortError(budget.signal, budget.deadline);
        }
        if (controller.signal.reason instanceof Error && controller.signal.reason.message === "READ_DEADLINE_EXCEEDED") {
          throw controller.signal.reason;
        }
        lastError = error;
        const message = error instanceof Error ? error.message : "REQUEST_FAILED";
        if (message.startsWith("READWEAVE_ETAPI_") && !message.startsWith("READWEAVE_ETAPI_NETWORK")) throw error;
        if (attempt === 2) throw new Error(`READWEAVE_ETAPI_NETWORK:${message}`);
      } finally {
        clearTimeout(timeout);
        for (const { signal, abort } of listeners) signal.removeEventListener("abort", abort);
      }
      if (requestTimedOut && budget.deadline !== undefined && Date.now() >= budget.deadline) {
        throw readBudgetAbortError(budget.signal, budget.deadline);
      }
      await delayForReadRetry(attempt, budget, init?.signal ?? undefined);
    }
    throw new Error(`READWEAVE_ETAPI_NETWORK:${lastError instanceof Error ? lastError.message : "REQUEST_FAILED"}`);
  }
}

function plainReadWeaveText(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
}

function lessonDraftPageIdFromConflictId(conflictId: string): string | undefined {
  const prefix = "conflict:";
  if (!conflictId.startsWith(prefix)) return undefined;
  const timestampSeparator = conflictId.lastIndexOf(":");
  if (timestampSeparator <= prefix.length || !/^\d+$/u.test(conflictId.slice(timestampSeparator + 1))) return undefined;
  return conflictId.slice(prefix.length, timestampSeparator);
}

function metadataMigrationId(workspaceId: string, stateNoteId: string): string {
  return `migration-${sha256(`${workspaceId}\u0000${stateNoteId}`).slice(0, 32)}`;
}

function metadataIdempotency(idempotency: ReadWeaveFileState["idempotency"]): ReadWeaveFileState["idempotency"] {
  return Object.fromEntries(Object.entries(idempotency ?? {})
    .filter(([, entry]) => metadataIdempotencyKinds.has(entry.kind)));
}

function metadataPayload(value: EtapiMetadataIndex | EtapiState): unknown {
  const projections = value.projections;
  return {
    courses: value.courses ?? [],
    treeNodes: value.treeNodes ?? [],
    trash: value.trash ?? [],
    projections: {
      courseRootNoteId: projections.courseRootNoteId,
      ...(projections.rootMaterialsNoteId ? { rootMaterialsNoteId: projections.rootMaterialsNoteId } : {}),
      ...(projections.trashNoteId ? { trashNoteId: projections.trashNoteId } : {}),
      materialReleaseSelections: projections.materialReleaseSelections ?? {},
      courses: projections.courses ?? {}
    },
    idempotency: metadataIdempotency(value.idempotency)
  };
}

function withMaterialReleaseSelectionHint(
  node: CourseTreeNode,
  selections?: Record<string, { releaseId: string; source: "derived" | "explicit" }>
): CourseTreeNode {
  if (node.kind !== "material") return node;
  const source = selections?.[node.materialId || node.id]?.source
    ?? node.currentReleaseSelection
    ?? (node.currentReleaseId ? "explicit" : "derived");
  return { ...node, currentReleaseSelection: source };
}

function metadataIndexFromLegacy(
  state: EtapiState,
  workspaceId: string,
  migrationId: string,
  revision: number
): EtapiMetadataIndex {
  return {
    format: "course-os-metadata-index",
    formatVersion: 1,
    schemaVersion: "1.0.0",
    authorityType: "readweave-etapi",
    workspaceId,
    stateNoteId: state.projections.stateNoteId,
    status: "staged",
    revision,
    migration: {
      id: migrationId,
      phase: "staged",
      sourceSchemaVersion: String((state as { schemaVersion?: string }).schemaVersion ?? "1.0.0"),
      startedAt: new Date().toISOString()
    },
    courses: structuredClone(state.courses ?? []),
    treeNodes: structuredClone(state.treeNodes ?? []),
    trash: structuredClone(state.trash ?? []),
    projections: {
      courseRootNoteId: state.projections.courseRootNoteId,
      ...(state.projections.rootMaterialsNoteId ? { rootMaterialsNoteId: state.projections.rootMaterialsNoteId } : {}),
      ...(state.projections.trashNoteId ? { trashNoteId: state.projections.trashNoteId } : {}),
      materialReleaseSelections: structuredClone(state.projections.materialReleaseSelections ?? {}),
      courses: structuredClone(state.projections.courses ?? {})
    },
    idempotency: structuredClone(metadataIdempotency(state.idempotency))
  };
}

function metadataIndexFromState(index: EtapiMetadataIndex, state: EtapiState): EtapiMetadataIndex {
  return {
    ...index,
    courses: structuredClone(state.courses ?? []),
    treeNodes: structuredClone(state.treeNodes ?? []),
    trash: structuredClone(state.trash ?? []),
    projections: {
      courseRootNoteId: state.projections.courseRootNoteId,
      ...(state.projections.rootMaterialsNoteId ? { rootMaterialsNoteId: state.projections.rootMaterialsNoteId } : {}),
      ...(state.projections.trashNoteId ? { trashNoteId: state.projections.trashNoteId } : {}),
      materialReleaseSelections: structuredClone(state.projections.materialReleaseSelections ?? {}),
      courses: structuredClone(state.projections.courses ?? {})
    },
    idempotency: structuredClone(metadataIdempotency(state.idempotency))
  };
}

function metadataStateView(index: EtapiMetadataIndex, noteId: string): EtapiState {
  return {
    ...structuredClone(EMPTY_STATE),
    courses: structuredClone(index.courses),
    treeNodes: structuredClone(index.treeNodes),
    trash: structuredClone(index.trash),
    idempotency: structuredClone(index.idempotency),
    projections: {
      courseRootNoteId: index.projections.courseRootNoteId,
      stateNoteId: index.stateNoteId,
      metadataIndexNoteId: noteId,
      metadataIndexRevision: index.revision,
      ...(index.projections.rootMaterialsNoteId ? { rootMaterialsNoteId: index.projections.rootMaterialsNoteId } : {}),
      ...(index.projections.trashNoteId ? { trashNoteId: index.projections.trashNoteId } : {}),
      materialReleaseSelections: structuredClone(index.projections.materialReleaseSelections ?? {}),
      courses: structuredClone(index.projections.courses),
      drafts: {},
      releases: {}
    }
  };
}

function applyMetadataIndex(state: EtapiState, index: EtapiMetadataIndex, noteId?: string): EtapiState {
  state.courses = structuredClone(index.courses);
  state.treeNodes = structuredClone(index.treeNodes);
  state.trash = structuredClone(index.trash);
  for (const [key, entry] of Object.entries(state.idempotency)) {
    // Older native confirmations stored their receipt in the core. Preserve
    // it until a real core write moves it to metadata; no cleanup rewrite.
    if (metadataIdempotencyKinds.has(entry.kind)
      && (entry.kind !== "permanent_delete" || Object.hasOwn(index.idempotency, key))) delete state.idempotency[key];
  }
  Object.assign(state.idempotency, structuredClone(index.idempotency));
  state.projections = {
    ...state.projections,
    courseRootNoteId: index.projections.courseRootNoteId,
    rootMaterialsNoteId: index.projections.rootMaterialsNoteId,
    trashNoteId: index.projections.trashNoteId,
    materialReleaseSelections: structuredClone(index.projections.materialReleaseSelections ?? {}),
    courses: structuredClone(index.projections.courses),
    metadataIndexNoteId: noteId ?? state.projections.metadataIndexNoteId,
    metadataIndexRevision: index.revision
  };
  return state;
}

function metadataFieldsAreEmpty(state: EtapiState): boolean {
  return state.courses.length === 0
    && state.treeNodes.length === 0
    && state.trash.length === 0
    && Object.keys(state.projections.courses ?? {}).length === 0
    && state.projections.rootMaterialsNoteId === undefined
    && state.projections.trashNoteId === undefined
    && Object.keys(state.projections.materialReleaseSelections ?? {}).length === 0
    && !Object.values(metadataIdempotency(state.idempotency)).some(entry => entry.kind !== "permanent_delete");
}

function stateWithoutMetadata(state: EtapiState, noteId: string, revision: number): EtapiState {
  const idempotency = Object.fromEntries(Object.entries(state.idempotency)
    .filter(([, entry]) => !metadataIdempotencyKinds.has(entry.kind)));
  return {
    ...state,
    courses: [],
    treeNodes: [],
    trash: [],
    idempotency,
    projections: {
      ...state.projections,
      metadataIndexNoteId: noteId,
      metadataIndexRevision: revision,
      rootMaterialsNoteId: undefined,
      trashNoteId: undefined,
      materialReleaseSelections: undefined,
      courses: {}
    }
  };
}

function stateNoteIdFromState(state: EtapiState): string {
  const noteId = state.projections.stateNoteId;
  if (!noteId) throw new Error("READWEAVE_METADATA_STATE_NOTE_MISSING");
  return noteId;
}

function normalizeState(input: Partial<EtapiState>, projection: ProjectionIndex): EtapiState {
  return {
    ...structuredClone(EMPTY_STATE),
    ...input,
    courses: input.courses ?? [],
    releases: input.releases ?? [],
    manifests: input.manifests ?? [],
    questions: input.questions ?? [],
    questionSelections: input.questionSelections ?? [],
    questionAttempts: input.questionAttempts ?? [],
    reviewPlans: input.reviewPlans ?? [],
    costEntries: input.costEntries ?? [],
    attempts: input.attempts ?? [],
    mastery: input.mastery ?? [],
    researchArchives: input.researchArchives ?? [],
    drafts: input.drafts ?? [],
    conflicts: input.conflicts ?? [],
    treeNodes: input.treeNodes ?? [],
    trash: input.trash ?? [],
    modelProviders: input.modelProviders ?? [],
    idempotency: input.idempotency ?? {},
    projections: input.projections ?? projection
  };
}

function quoteSearchValue(value: string): string {
  // ReadWeave's search lexer escapes the next character, unlike JSON string escapes.
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

function mergeCostEntries(...groups: Array<GenerationCostEntry[] | undefined>): GenerationCostEntry[] {
  const entries = new Map<string, GenerationCostEntry>();
  for (const group of groups) {
    for (const entry of group ?? []) entries.set(entry.id, entry);
  }
  return [...entries.values()];
}

function isVirtualTreeParent(state: EtapiState, parentId: string): boolean {
  const match = /^material:([^:]+):current$/.exec(parentId);
  return Boolean(match && state.courses.some((course) => course.id === match[1]));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nativeErasePreflightKey(workspaceId: string, trashId: string, snapshotHash: string): string {
  return `course-os:native-erase-preflight:v1:${sha256(JSON.stringify([workspaceId, trashId, snapshotHash]))}`;
}

function shouldRetryHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function delayForRetry(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
}

async function delayForReadRetry(attempt: number, budget: ReadBudget, requestSignal?: AbortSignal): Promise<void> {
  assertReadBudgetActive(budget);
  if (requestSignal?.aborted) throw new Error("READ_CANCELLED");
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      budget.signal.removeEventListener("abort", onBudgetAbort);
      requestSignal?.removeEventListener("abort", onRequestAbort);
    };
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const onBudgetAbort = () => finish(() => reject(readBudgetAbortError(budget.signal, budget.deadline)));
    const onRequestAbort = () => finish(() => reject(new Error("READ_CANCELLED")));
    const onDelayComplete = () => {
      try {
        assertReadBudgetActive(budget);
        if (requestSignal?.aborted) throw new Error("READ_CANCELLED");
        finish(resolve);
      } catch (error) {
        finish(() => reject(error));
      }
    };

    budget.signal.addEventListener("abort", onBudgetAbort, { once: true });
    requestSignal?.addEventListener("abort", onRequestAbort, { once: true });
    if (budget.signal.aborted) {
      onBudgetAbort();
      return;
    }
    if (requestSignal?.aborted) {
      onRequestAbort();
      return;
    }
    const retryMs = 10 * (attempt + 1);
    const remaining = budget.deadline === undefined ? retryMs : Math.max(0, budget.deadline - Date.now());
    timer = setTimeout(onDelayComplete, Math.min(retryMs, remaining));
  });
}

function treePath(state: EtapiState, nodeId: string): string[] {
  const byId = new Map<string, CourseTreeNode>();
  for (const course of mergeReleaseCourses(state.courses, state.releases)) byId.set(course.id, courseNodeFromProject(course));
  for (const node of state.treeNodes) byId.set(node.id, node);
  const path: string[] = [];
  const visited = new Set<string>();
  let current = byId.get(nodeId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current.title);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function forEachWithConcurrency<T>(items: T[], maxConcurrency: number, action: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && nextIndex < items.length) {
      const item = items[nextIndex++]!;
      try {
        await action(item);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, maxConcurrency)) }, worker));
  if (failed) throw failure;
}

function renderReadableLessonText(markdown: string): string {
  const output: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (paragraph.length) output.push(`<p>${paragraph.map(escapeHtml).join("<br>")}</p>`);
    if (list.length) output.push(`<ul>${list.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`);
    paragraph = [];
    list = [];
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) { flush(); output.push(`<h4>${escapeHtml(heading[1]!)}</h4>`); continue; }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) { if (paragraph.length) flush(); list.push(bullet[1]!); continue; }
    if (list.length) flush();
    paragraph.push(line);
  }
  flush();
  return output.join("");
}

function replayQuestionAttemptTransaction(state: Pick<EtapiActivityState, "questionAttempts" | "attempts" | "mastery">, attemptId: string): QuestionAttemptTransactionResult {
  const attempt = state.questionAttempts.find((item) => item.id === attemptId);
  const assessmentAttempt = state.attempts.find((item) => item.id === attemptId);
  const mastery = assessmentAttempt && state.mastery.find((item) => item.objectiveId === assessmentAttempt.objectiveId);
  if (!attempt || !assessmentAttempt || !mastery) throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
  return { attempt: structuredClone(attempt), assessmentAttempt: structuredClone(assessmentAttempt), mastery: structuredClone(mastery) };
}

function trustedPublicBase(publicUrl: string): URL {
  const parsed = new URL(publicUrl);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("READWEAVE_PUBLIC_URL_INVALID");
  return parsed;
}

function renderQuestion(question: PageQuestion): string {
  return `<h3>${escapeHtml(question.question)}</h3><p>${escapeHtml(question.response)}</p><dl><dt>学生尝试</dt><dd>${escapeHtml(question.learnerAttempt || "未填写")}</dd><dt>提示层级</dt><dd>${question.hintLevel}</dd><dt>复习策略</dt><dd>${escapeHtml(question.reviewPolicy)}</dd><dt>状态</dt><dd>${escapeHtml(question.status)}</dd></dl>`;
}

function mergeReleaseCourses(courses: CourseProject[], releases: CourseRelease[], workspaceId = "personal"): CourseProject[] {
  const merged = new Map(courses.map((course) => [course.id, structuredClone(course)]));
  for (const release of releases) {
    if (merged.has(release.courseId)) continue;
    merged.set(release.courseId, {
      id: release.courseId,
      workspaceId,
      title: release.courseTitle,
      status: "active",
      createdAt: release.publishedAt,
      updatedAt: release.publishedAt
    });
  }
  return [...merged.values()];
}

function courseNodeFromProject(course: CourseProject): CourseTreeNode {
  return {
    id: course.id,
    kind: "course",
    title: course.title,
    subtitle: course.description,
    status: course.status === "archived" ? "draft" : "published",
    archived: course.status === "archived",
    visibility: course.status === "archived" ? "archived" : "library",
    revision: course.revision ?? 0,
    sortOrder: course.sortOrder,
    readweaveNoteId: course.readweaveNoteId,
    children: []
  };
}
