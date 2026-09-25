import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
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
import { isLegacyProjectionId, isStableMaterialId, materialGroups, materialTreeNode, stableMaterialId } from "./tree-identity.js";

const stateCodecPrefix = "COURSE_OS_BR_STATE_V1:";

export function encodeReadWeaveStateContent(state: unknown): string {
  const plain = JSON.stringify(state);
  if (Buffer.byteLength(plain) < 1_000_000) return plain;
  const hash = createHash("sha256").update(plain).digest("hex");
  const compressed = brotliCompressSync(plain, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 2 } });
  return `${stateCodecPrefix}${hash}:${compressed.toString("base64")}`;
}

export function decodeReadWeaveStateContent(content: string): unknown {
  if (!content.startsWith(stateCodecPrefix)) return JSON.parse(content);
  const encoded = /^COURSE_OS_BR_STATE_V1:([a-f0-9]{64}):([A-Za-z0-9+/]+={0,2})$/u.exec(content);
  if (!encoded) throw new Error("READWEAVE_STATE_CODEC_INVALID");
  const plain = brotliDecompressSync(Buffer.from(encoded[2]!, "base64"), { maxOutputLength: 512_000_000 }).toString("utf8");
  if (createHash("sha256").update(plain).digest("hex") !== encoded[1]) throw new Error("READWEAVE_STATE_CODEC_HASH_MISMATCH");
  return JSON.parse(plain);
}

export interface EtapiReadWeaveConfig {
  baseUrl: string;
  token: string;
  parentNoteId: string;
  publicUrl?: string;
  workspaceId?: string;
  seedStatePath?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
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
  activityStateNoteId?: string;
  costIndexNoteId?: string;
  rootMaterialsNoteId?: string;
  trashNoteId?: string;
  courses: Record<string, CourseProjection>;
  drafts: Record<string, DraftProjection>;
  releases: Record<string, string>;
}

interface EtapiState extends ReadWeaveFileState {
  projections: ProjectionIndex;
}

interface EtapiActivityState {
  schemaVersion: "1.0.0";
  questionSelections: QuestionSelection[];
  questionAttempts: QuestionAttempt[];
  attempts: AssessmentAttempt[];
  mastery: MasteryRecord[];
  idempotency: ReadWeaveFileState["idempotency"];
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

// The API process is single-writer in production. Adapter instances can still
// overlap briefly when ETAPI settings are replaced, so their page locks share
// this process-wide map.
const draftPageWriteChains = new Map<string, Promise<void>>();

const activityIdempotencyKinds = new Set(["question_selection", "question_attempt", "question_attempt_transaction", "attempt"]);

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

export class EtapiReadWeaveCourseApi implements ReadWeaveCourseApi {
  // The authoritative workspace index is large. Writes replace this cache with
  // the committed state immediately, so a one-minute read window keeps local
  // mutations coherent while avoiding a full ReadWeave download on routine
  // page navigation and status checks.
  private static readonly readCacheTtlMs = 60_000;
  private static readonly maxStaleReadMs = 300_000;
  private readonly fetchImpl: typeof fetch;
  private readonly workspaceId: string;
  private readonly requestTimeoutMs: number;
  private bootstrapPromise?: Promise<ProjectionIndex>;
  private bootstrapStateContent?: string;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly draftPageRecordCache = new Map<string, LocatedDraftPageRecord>();
  private readonly draftPageRecordVersions = new Map<string, number>();
  private draftPageRecordVersion = 0;
  private draftPageRecordsHydrated = false;
  private draftPageRecordsHydration?: Promise<void>;
  private readonly costNoteEnsures = new Map<string, Promise<void>>();
  private readonly writeContext = new AsyncLocalStorage<IdempotentWriteContext>();
  private stateCache?: { state: EtapiState; expiresAt: number };
  private stateReadInFlight?: Promise<EtapiState>;
  private stateVersion = 0;
  private readonly draftReadCache = new Map<string, { draft: LessonDraft; expiresAt: number }>();
  private nativeLinksCache?: { expiresAt: number; links: Array<{ articleId: string; objectId: string; kind?: string; contentType?: string; displayTitle?: string; displayBody?: string }> };
  private nativeLinksInFlight?: Promise<NonNullable<EtapiReadWeaveCourseApi["nativeLinksCache"]>["links"]>;
  private lastReadAt?: string;
  private lastWriteAt?: string;

  constructor(private readonly config: EtapiReadWeaveConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.workspaceId = config.workspaceId ?? "personal";
    this.requestTimeoutMs = Math.max(1_000, config.requestTimeoutMs ?? 30_000);
  }

  /** Verify credentials and access to the configured root without changing remote data. */
  async verifyConnection(): Promise<void> {
    await this.raw(`/notes/${encodeURIComponent(this.config.parentNoteId)}`);
  }

  async listCourses(): Promise<CourseProject[]> {
    const state = await this.readStateReference();
    return mergeReleaseCourses(state.courses, state.releases, this.workspaceId);
  }

  async createCourse(course: CourseProject, context: IdempotentWriteContext): Promise<CourseProject> {
    const saved = await this.mutate(async (state) => {
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
    }, context);
    await this.readBackTreeNode(saved.id, courseNodeFromProject(saved));
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
    const releases = (await this.readStateReference()).releases;
    return structuredClone(courseId ? releases.filter((release) => release.courseId === courseId) : releases);
  }

  async listReleaseIndexes(courseId?: string): Promise<CourseReleaseIndex[]> {
    const releases = (await this.readStateReference()).releases;
    return (courseId ? releases.filter((release) => release.courseId === courseId) : releases).map(toCourseReleaseIndex);
  }

  async getRelease(releaseId: string): Promise<CourseRelease | undefined> {
    const release = (await this.readStateReference()).releases.find((item) => item.id === releaseId);
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
    const workspaceQuery = new URLSearchParams({ search: `#courseOsWorkspaceId="${workspaceId}"`, ancestorNoteId: this.config.parentNoteId, ancestorDepth: "lt5", fastSearch: "true" });
    const workspaces = (await this.request<SearchResponse>(`/notes?${workspaceQuery.toString()}`)).results;
    if (workspaces.length !== 1) return { pageId, questions: [] };
    const pageQuery = new URLSearchParams({ search: `#courseOsObjectId="${pageId}"`, ancestorNoteId: workspaces[0]!.noteId, ancestorDepth: "lt12", fastSearch: "true" });
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
    const links = (await this.readNativeLinks()).filter((link) => noteIds.has(link.articleId));
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

  private async readNativeLinks(): Promise<NonNullable<EtapiReadWeaveCourseApi["nativeLinksCache"]>["links"]> {
    if (this.nativeLinksCache && this.nativeLinksCache.expiresAt > Date.now()) return this.nativeLinksCache.links;
    if (this.nativeLinksInFlight) return this.nativeLinksInFlight;
    this.nativeLinksInFlight = (async () => {
      const root = await this.getNote("_readweaveLinks");
      const ids = root.childNoteIds ?? [];
      const links: NonNullable<EtapiReadWeaveCourseApi["nativeLinksCache"]>["links"] = [];
      for (let index = 0; index < ids.length; index += 8) {
        const batch = await Promise.all(ids.slice(index, index + 8).map(async (id) => {
          try {
            const value = JSON.parse(await this.getContent(id)) as Record<string, unknown>;
            if (value.linkId !== id || typeof value.articleId !== "string" || typeof value.objectId !== "string") return undefined;
            return value as typeof links[number];
          } catch { return undefined; }
        }));
        links.push(...batch.filter((item): item is typeof links[number] => !!item));
      }
      this.nativeLinksCache = { links, expiresAt: Date.now() + 15_000 };
      return links;
    })();
    try { return await this.nativeLinksInFlight; } finally { this.nativeLinksInFlight = undefined; }
  }

  async listQuestionAttempts(pageId?: string): Promise<QuestionAttempt[]> {
    const attempts = (await this.readState()).questionAttempts;
    return pageId ? attempts.filter((item) => item.pageId === pageId) : attempts;
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

  async saveQuestionAttempt(attempt: QuestionAttempt, context: IdempotentWriteContext): Promise<QuestionAttempt> {
    return this.mutateActivity(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) return state.questionAttempts.find((item) => item.id === replay.objectId) ?? attempt;
      const release = state.releases.find((item) => item.id === attempt.courseReleaseId);
      if (release) {
        const course = await this.ensureCourseProjection(state, release);
        const draft = state.drafts.find((item) => item.pageId === attempt.pageId);
        const projection = draft ? state.projections.drafts[draft.id] : undefined;
        await this.createNote(projection?.sectionNoteIds.assessment ?? course.reviewNoteId, `作答 · ${attempt.pageId}`, `<pre>${escapeHtml(JSON.stringify(attempt, null, 2))}</pre>`, "text", undefined, {
          courseOsType: "question_attempt", courseOsObjectId: attempt.id, courseOsPageId: attempt.pageId
        });
      }
      state.questionAttempts.push(structuredClone(attempt));
      state.idempotency[context.idempotencyKey] = { kind: "question_attempt", objectId: attempt.id };
      return attempt;
    }, context);
  }

  async saveQuestionAttemptTransaction(attempt: QuestionAttempt, assessmentAttempt: AssessmentAttempt, reduceMastery: MasteryReducer, context: IdempotentWriteContext): Promise<QuestionAttemptTransactionResult> {
    return this.mutateActivity(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) return replayQuestionAttemptTransaction(state, replay.objectId);
      const mastery = reduceMastery(state.mastery.find((item) => item.objectiveId === assessmentAttempt.objectiveId));
      const release = state.releases.find((item) => item.id === attempt.courseReleaseId);
      if (release) {
        const course = await this.ensureCourseProjection(state, release);
        const draft = state.drafts.find((item) => item.pageId === attempt.pageId);
        const projection = draft ? state.projections.drafts[draft.id] : undefined;
        await this.createNote(projection?.sectionNoteIds.assessment ?? course.reviewNoteId, `作答 · ${attempt.pageId}`, `<pre>${escapeHtml(JSON.stringify({ attempt, assessmentAttempt, mastery }, null, 2))}</pre>`, "text", undefined, {
          courseOsType: "question_attempt_transaction", courseOsObjectId: attempt.id, courseOsPageId: attempt.pageId
        });
      }
      state.questionAttempts.push(structuredClone(attempt));
      state.attempts.push(structuredClone(assessmentAttempt));
      const masteryIndex = state.mastery.findIndex((item) => item.objectiveId === mastery.objectiveId);
      if (masteryIndex >= 0) state.mastery[masteryIndex] = structuredClone(mastery);
      else state.mastery.push(structuredClone(mastery));
      state.idempotency[context.idempotencyKey] = { kind: "question_attempt_transaction", objectId: attempt.id };
      return { attempt: structuredClone(attempt), assessmentAttempt: structuredClone(assessmentAttempt), mastery: structuredClone(mastery) };
    }, context);
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
    const state = await this.readState();
    const costIndex = state.projections.costIndexNoteId
      ? await this.readCostIndex(state.projections.costIndexNoteId)
      : undefined;
    return mergeCostEntries(costIndex?.costEntries, state.costEntries).filter((item) =>
      (!filters.courseId || item.courseId === filters.courseId) &&
      (!filters.materialVersionId || item.materialVersionId === filters.materialVersionId) &&
      (!filters.pageId || item.pageId === filters.pageId) &&
      (!filters.jobId || item.jobId === filters.jobId));
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
    return (await this.readState()).mastery;
  }

  async listAssessmentAttempts(objectiveId?: string): Promise<AssessmentAttempt[]> {
    const attempts = (await this.readState()).attempts;
    return objectiveId ? attempts.filter((item) => item.objectiveId === objectiveId) : attempts;
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
    const cached = this.draftReadCache.get(pageId);
    if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.draft);
    return this.withDraftPageLock(pageId, undefined, async () => {
      const stateReference = await this.readStateReference(true);
      const located = await this.findDraftPageRecord(pageId);
      if (!located && !stateReference.drafts.some((item) => item.pageId === pageId)) return undefined;
      const state = structuredClone(stateReference);
      if (located) this.mergeDraftPageRecord(state, located.record);
      const draft = state.drafts.find((item) => item.pageId === pageId);
      if (!draft) return undefined;
      const reconciled = await this.reconcileDraft(state, draft);
      if (reconciled.changed) {
        const projection = state.projections.drafts[reconciled.draft.id];
        if (projection) {
          const record = this.makeDraftPageRecord(state, reconciled.draft, projection, located?.record);
          await this.writeDraftPageRecord(record, located?.noteId, state);
        }
      }
      this.draftReadCache.set(pageId, { draft: structuredClone(reconciled.draft), expiresAt: Date.now() + EtapiReadWeaveCourseApi.readCacheTtlMs });
      return reconciled.draft;
    });
  }

  async getDraftSnapshotByPage(pageId: string): Promise<LessonDraft | undefined> {
    const cached = this.draftReadCache.get(pageId);
    if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.draft);
    const cachedLocated = this.draftPageRecordCache.get(pageId);
    const [stateReference, located] = await Promise.all([
      this.readStateReference(),
      cachedLocated ?? this.findDraftPageRecord(pageId)
    ]);
    const state = structuredClone(stateReference);
    if (located) this.mergeDraftPageRecord(state, located.record);
    const draft = state.drafts.find((item) => item.pageId === pageId);
    return draft ? structuredClone(draft) : undefined;
  }

  async saveDraft(draft: LessonDraft, expectedRevision: number, context: IdempotentWriteContext, sourceAsset?: DraftSourceAsset): Promise<LessonDraft> {
    return this.saveDraftInternal(draft, expectedRevision, context, sourceAsset);
  }

  async saveDraftWithCost(draft: LessonDraft, expectedRevision: number, context: IdempotentWriteContext, cost: GenerationCostEntry, sourceAsset?: DraftSourceAsset): Promise<LessonDraft> {
    return this.saveDraftInternal(draft, expectedRevision, context, sourceAsset, cost);
  }

  private async saveDraftInternal(draft: LessonDraft, expectedRevision: number, context: IdempotentWriteContext, sourceAsset?: DraftSourceAsset, cost?: GenerationCostEntry): Promise<LessonDraft> {
    return this.withDraftPageLock(draft.pageId, context, async () => {
      const state = structuredClone(await this.readStateReference(true));
      const located = await this.findDraftPageRecord(draft.pageId);
      if (located) this.mergeDraftPageRecord(state, located.record);
      const previous = located?.record;
      let current = previous?.draft ?? state.drafts.find((item) => item.pageId === draft.pageId);
      let projection = previous?.projection ?? (current ? state.projections.drafts[current.id] : undefined);
      const replay = previous?.idempotency[context.idempotencyKey] ?? state.idempotency[context.idempotencyKey];
      if (replay) {
        const existing = current?.id === replay.objectId
          ? current
          : state.drafts.find((item) => item.id === replay.objectId);
        if (!existing) throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
        projection = projection ?? state.projections.drafts[existing.id] ?? await this.ensureDraftProjection(state, existing, sourceAsset);
        if (!previous) {
          const migrated = this.makeDraftPageRecord(state, existing, projection);
          await this.writeDraftPageRecord(migrated, undefined, state);
        }
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
        await this.writeDraftPageRecord(record, located?.noteId, state);
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
      await this.writeDraftPageRecord(record, located?.noteId, state);
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
    const initial = (await this.readState()).conflicts.find((item) => item.id === conflictId);
    if (initial?.objectType === "lesson_draft") {
      return this.withDraftPageLock(initial.objectId, context, async () => {
        const state = structuredClone(await this.readStateReference(true));
        const located = await this.findDraftPageRecord(initial.objectId);
        if (located) this.mergeDraftPageRecord(state, located.record);
        const conflict = state.conflicts.find((item) => item.id === conflictId);
        if (!conflict) throw new Error("READWEAVE_CONFLICT_NOT_FOUND");
        if (conflict.status === "resolved") return conflict;
        if (resolution === "merged" && !mergedContent?.trim()) throw new Error("READWEAVE_MERGED_CONTENT_REQUIRED");
        const draft = located?.record.draft ?? state.drafts.find((item) => item.pageId === conflict.objectId);
        if (!draft) throw new Error("READWEAVE_DRAFT_NOT_FOUND");
        const selected = resolution === "local" ? conflict.localContent : resolution === "remote" ? conflict.remoteContent : mergedContent!;
        const previousDraft = structuredClone(draft);
        try {
          draft.page = JSON.parse(selected);
        } catch {
          throw new Error("READWEAVE_CONFLICT_CONTENT_INVALID");
        }
        draft.revision = Math.max(conflict.localRevision, conflict.remoteRevision) + 1;
        draft.status = "editing";
        draft.contentHash = sha256(JSON.stringify(draft.page));
        draft.updatedAt = new Date().toISOString();
        const projection = located?.record.projection ?? state.projections.drafts[draft.id]
          ?? await this.ensureDraftProjection(state, draft);
        conflict.status = "resolved";
        conflict.resolution = resolution;
        conflict.resolvedAt = draft.updatedAt;
        state.idempotency[context.idempotencyKey] = { kind: "conflict", objectId: conflict.id };
        await this.refreshDraftProjection(draft, projection, undefined, 4, previousDraft);
        const record = this.makeDraftPageRecord(state, draft, projection, located?.record);
        record.conflicts = [...record.conflicts.filter((item) => item.id !== conflict.id), conflict];
        record.idempotency[context.idempotencyKey] = { kind: "conflict", objectId: conflict.id };
        await this.writeDraftPageRecord(record, located?.noteId, state);
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
      draft.revision = Math.max(conflict.localRevision, conflict.remoteRevision) + 1;
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
    const state = await this.readStateReference();
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
      .map((node) => [node.id, structuredClone(node)] as const));
    for (const node of generated) if (!byId.has(node.id)) byId.set(node.id, node);
    for (const group of materialGroups(state.releases)) {
      const course = courses.find((item) => item.id === group.courseId);
      if (!course) continue;
      const id = stableMaterialId(group.courseId, group.moduleId);
      if (archivedMaterialIds.has(id)) continue;
      const persisted = state.treeNodes.find((node) => node.kind === "material" && !node.archived && (node.id === id || node.materialId === id));
      const projection = state.projections.courses[group.courseId];
      const legacyNoteId = projection?.modules[group.moduleId];
      byId.set(id, { ...materialTreeNode(course, group, persisted), id, materialId: id, readweaveNoteId: persisted?.readweaveNoteId ?? legacyNoteId });
    }
    return [...byId.values()];
  }

  async createTreeNode(node: CourseTreeNode, context: IdempotentWriteContext): Promise<CourseTreeNode> {
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

  async updateTreeNode(nodeId: string, patch: { title?: string; parentId?: string | null; archived?: boolean; sortOrder?: number }, expectedRevision: number, context: IdempotentWriteContext): Promise<CourseTreeNode> {
    const saved = await this.mutate(async (state) => {
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
    }, context);
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
    const saved = await this.mutate(async (state) => {
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
    }, context);
    const readBack = (await this.listTrash()).find((item) => item.id === saved.id);
    if (!readBack || readBack.nodeId !== saved.nodeId || readBack.snapshotHash !== saved.snapshotHash) throw new Error("READWEAVE_TREE_READBACK_FAILED");
    if (readBack.readweaveNoteId) {
      const state = await this.readState();
      const trashRoot = state.projections.trashNoteId;
      if (!trashRoot || !(await this.findBranchId(readBack.readweaveNoteId, trashRoot))) throw new Error("READWEAVE_TREE_TRASH_READBACK_FAILED");
    }
    return readBack;
  }

  async listTrash(): Promise<TrashRecord[]> {
    return structuredClone((await this.readStateReference()).trash.filter((item) => item.workspaceId === this.workspaceId || !item.workspaceId));
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

  async permanentlyDeleteTrash(trashId: string, context: IdempotentWriteContext): Promise<void> {
    const state = await this.readState();
    const item = state.trash.find((candidate) => candidate.id === trashId);
    if (item?.readweaveNoteId) throw new Error("READWEAVE_PERMANENT_DELETE_UNSUPPORTED");
    await this.mutate(async (state) => {
      if (state.idempotency[context.idempotencyKey]) return;
      const index = state.trash.findIndex((candidate) => candidate.id === trashId);
      if (index < 0) return;
      const item = state.trash[index]!;
      state.trash.splice(index, 1);
      if (item.nodeKind === "course") {
        const releaseIds = new Set(state.releases.filter((release) => release.courseId === item.nodeId).map((release) => release.id));
        const removedDrafts = state.drafts.filter((draft) => draft.courseId === item.nodeId);
        for (const draft of removedDrafts) {
          const pageRecord = await this.findDraftPageRecord(draft.pageId);
          if (pageRecord) {
            await this.deleteNote(pageRecord.noteId);
            this.draftPageRecordCache.delete(draft.pageId);
          }
        }
        state.courses = state.courses.filter((course) => course.id !== item.nodeId);
        state.releases = state.releases.filter((release) => release.courseId !== item.nodeId);
        state.drafts = state.drafts.filter((draft) => draft.courseId !== item.nodeId);
        state.questions = state.questions.filter((question) => !releaseIds.has(question.courseReleaseId));
        state.questionSelections = state.questionSelections.filter((selection) => !releaseIds.has(selection.courseReleaseId));
        state.questionAttempts = state.questionAttempts.filter((attempt) => !releaseIds.has(attempt.courseReleaseId));
        state.treeNodes = state.treeNodes.filter((node) => node.id !== item.nodeId && node.parentId !== item.nodeId);
      } else state.treeNodes = state.treeNodes.filter((node) => node.id !== item.nodeId);
      state.idempotency[context.idempotencyKey] = { kind: "permanent_delete", objectId: trashId };
    }, context);
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
    if (expected.readweaveNoteId && node.readweaveNoteId !== expected.readweaveNoteId) throw new Error("READWEAVE_TREE_IDENTITY_READBACK_FAILED");
    if (node.readweaveNoteId) await this.getNote(node.readweaveNoteId);
    return node;
  }

  async getDeepLink(noteId: string): Promise<ReadWeaveDeepLink | undefined> {
    const state = await this.readState();
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

  async getWorkspaceSettings(): Promise<WorkspaceSettings> { const state = await this.readState(); return structuredClone(state.settings ?? defaultWorkspaceSettings(this.workspaceId)); }

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
    const group = materialGroups(state.releases).find((item) => stableMaterialId(item.courseId, item.moduleId) === nodeId);
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
    const material = materialTreeNode(course, group);
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
    if (sourceBranchId !== targetBranchId) {
      await this.moveBranch(sourceBranchId, targetBranchId);
      const movedBranchId = await this.findBranchId(noteId, targetNoteId);
      this.updateModuleProjectionAfterMove(state, node.id, targetCourseId, movedBranchId || sourceBranchId, noteId);
    }
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
    if (source !== targetBranchId) await this.moveBranch(source, targetBranchId);
    return source;
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

  private async createBranch(noteId: string, parentNoteId: string): Promise<EtapiBranch> {
    return this.request<EtapiBranch>("/branches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteId, parentNoteId, notePosition: 10, prefix: "", isExpanded: false })
    });
  }

  private async moveBranch(branchId: string, parentBranchId: string): Promise<void> {
    const result = await this.request<{ success?: boolean }>(`/branches/${encodeURIComponent(branchId)}/move-to/${encodeURIComponent(parentBranchId)}`, { method: "PUT" });
    if (result.success === false) throw new Error("READWEAVE_TREE_MOVE_REJECTED");
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

  private async reconcileDraft(state: EtapiState, draft: LessonDraft, pendingDraft?: LessonDraft): Promise<{ draft: LessonDraft; changed: boolean }> {
    const projection = state.projections.drafts[draft.id];
    if (!projection) return { draft, changed: false };
    const next = structuredClone(draft);
    let changed = false;
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
        }
        projection.blockHashes[block.id] = remoteHash;
      }
    }
    if (changed) {
      next.revision += 1;
      next.status = "editing";
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
    const queueContentUpdate = (noteId: string, content: string, expectedContent?: string): void => {
      updates.push(async () => {
        const actual = await this.getContent(noteId);
        if (actual === content) return;
        if (expectedContent !== undefined && actual !== expectedContent && actual !== interruptedSectionContents.get(noteId)
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
        expectedDraft ? this.renderSectionOverview(expectedDraft, key) : undefined
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
    if (section === "assessment") {
      const questions = draft.page.questionBank ?? [];
      return questions.length
        ? `<p>正式题库共 ${questions.length} 题，每次学习抽取两题并保存种子、顺序和作答记录</p><ol>${questions.map((question) => `<li><strong>${escapeHtml(question.kind === "multiple_choice" ? "选择题" : "理解题")}</strong> ${escapeHtml(question.prompt)}<details><summary>审核答案</summary><p>${escapeHtml(question.expectedAnswer)}</p><p>${escapeHtml(question.explanation)}</p></details></li>`).join("")}</ol>`
        : "<p>本页尚未建立通过审核的随机题</p>";
    }
    if (section === "qa") return "<p>本页实时问答会作为子笔记自动保存，撤回只改变状态，不删除历史修订</p>";
    const kind = ({ objectives: "learning_objectives", main: "main_content", prerequisites: "prior_knowledge", explanation: "full_explanation", misconceptions: "misconceptions" } as const)[section];
    const lesson = draft.page.lessonSections?.find((item) => item.kind === kind);
    if (!lesson) return "<p>本节内容保存在下方结构化讲解子笔记中</p>";
    if (lesson.items?.length) return `<ul>${lesson.items.map((item) => `<li>${escapeHtml(item.text)}</li>`).join("")}</ul>`;
    return lesson.markdown ? renderReadableLessonText(lesson.markdown) : "<p>本节内容保存在下方结构化讲解子笔记中</p>";
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

  private async readState(requireFresh = false): Promise<EtapiState> {
    const state = structuredClone(await this.readStateReference(requireFresh));
    await this.mergeDraftPageRecords(state);
    return state;
  }

  private async readStateReference(requireFresh = false): Promise<EtapiState> {
    const now = Date.now();
    if (this.stateCache && this.stateCache.expiresAt > now) return this.stateCache.state;
    if (!this.stateReadInFlight) {
      const versionAtReadStart = this.stateVersion;
      const read = this.readRemoteState();
      this.stateReadInFlight = read;
      void read.then((state) => {
        if (this.stateReadInFlight === read && this.stateVersion === versionAtReadStart) {
          this.stateCache = { state, expiresAt: Date.now() + EtapiReadWeaveCourseApi.readCacheTtlMs };
        }
      }).catch(() => undefined).finally(() => {
        if (this.stateReadInFlight === read) this.stateReadInFlight = undefined;
      });
    }
    if (!requireFresh && this.stateCache && now < this.stateCache.expiresAt + EtapiReadWeaveCourseApi.maxStaleReadMs) {
      return this.stateCache.state;
    }
    const state = await this.stateReadInFlight;
    return this.stateCache && this.stateCache.expiresAt > Date.now() ? this.stateCache.state : state;
  }

  private async readRemoteState(): Promise<EtapiState> {
    const projection = await this.ensureWorkspace();
    // Bootstrap already downloaded this immutable snapshot to locate the
    // projection notes. Reuse it for the first read instead of fetching the
    // same large index a second time during a cold API start.
    const content = this.bootstrapStateContent ?? await this.getContent(projection.stateNoteId);
    this.bootstrapStateContent = undefined;
    const parsed = decodeReadWeaveStateContent(content) as Partial<EtapiState>;
    const state = normalizeState(parsed, projection);
    const activityStateNoteId = state.projections.activityStateNoteId;
    if (activityStateNoteId) {
      const activity = decodeReadWeaveStateContent(await this.getContent(activityStateNoteId)) as Partial<EtapiActivityState>;
      state.questionSelections = activity.questionSelections ?? state.questionSelections;
      state.questionAttempts = activity.questionAttempts ?? state.questionAttempts;
      state.attempts = activity.attempts ?? state.attempts;
      state.mastery = activity.mastery ?? state.mastery;
      state.idempotency = { ...state.idempotency, ...(activity.idempotency ?? {}) };
    }
    for (const located of this.draftPageRecordCache.values()) this.mergeDraftPageRecord(state, located.record);
    this.lastReadAt = new Date().toISOString();
    return state;
  }

  private async mergeDraftPageRecords(state: EtapiState): Promise<void> {
    await this.hydrateDraftPageRecords();
    for (const located of this.draftPageRecordCache.values()) this.mergeDraftPageRecord(state, located.record);
  }

  private async hydrateDraftPageRecords(): Promise<void> {
    if (this.draftPageRecordsHydrated) return;
    if (!this.draftPageRecordsHydration) {
      const hydration = this.readDraftPageRecords().then(() => {
        this.draftPageRecordsHydrated = true;
      });
      this.draftPageRecordsHydration = hydration;
      void hydration.catch(() => {
        if (this.draftPageRecordsHydration === hydration) this.draftPageRecordsHydration = undefined;
      }).finally(() => {
        if (this.draftPageRecordsHydration === hydration) this.draftPageRecordsHydration = undefined;
      });
    }
    await this.draftPageRecordsHydration;
  }

  private async readDraftPageRecords(pageId?: string): Promise<LocatedDraftPageRecord[]> {
    const observedVersions = new Map(this.draftPageRecordVersions);
    const searches = pageId
      ? [`#courseOsDraftRecordPageId="${pageId}"`]
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
    const located: LocatedDraftPageRecord[] = [];
    for (let index = 0; index < notes.length; index += 8) {
      const batch = await Promise.all(notes.slice(index, index + 8).map(async (note) => {
        const parsed = decodeReadWeaveStateContent(await this.getContent(note.noteId)) as Partial<EtapiDraftPageRecord>;
        if (!parsed.pageId || !parsed.draft || !parsed.projection || parsed.draft.pageId !== parsed.pageId) return undefined;
        if (pageId && parsed.pageId !== pageId) return undefined;
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
        return located;
      }));
      located.push(...batch.filter((item): item is LocatedDraftPageRecord => item !== undefined));
    }
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

  private async recoverUnlabelledDraftPageRecord(pageId: string): Promise<LocatedDraftPageRecord | undefined> {
    const projection = await this.ensureWorkspace();
    const title = `Course OS draft record · ${pageId}`;
    const query = new URLSearchParams({
      search: `"${title}"`,
      ancestorNoteId: projection.stateNoteId,
      ancestorDepth: "lt5",
      fastSearch: "true"
    });
    const results = (await this.request<SearchResponse>(`/notes?${query.toString()}`)).results
      .filter((note) => note.title === title);
    const candidates = (await Promise.all(results.map(async (note) => {
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
    }))).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
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
      search: `#${name}="${value}"`,
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

    state.idempotency = { ...state.idempotency, ...record.idempotency };
    const conflictsById = new Map(state.conflicts.filter((item) => item.objectId !== record.pageId).map((item) => [item.id, item]));
    for (const item of state.conflicts.filter((conflict) => conflict.objectId === record.pageId)) conflictsById.set(item.id, item);
    for (const item of record.conflicts) conflictsById.set(item.id, structuredClone(item));
    state.conflicts = [...conflictsById.values()];
  }

  private makeDraftPageRecord(
    state: EtapiState,
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
    fallbackState: EtapiState
  ): Promise<string> {
    try {
      const content = encodeReadWeaveStateContent(record);
      let savedNoteId = noteId;
      if (savedNoteId) {
        await this.putContent(savedNoteId, content);
      } else {
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
      this.cacheDraftPageRecord(located);
      this.lastWriteAt = new Date().toISOString();
      const next = structuredClone(this.stateCache?.state ?? fallbackState);
      this.mergeDraftPageRecord(next, record);
      this.stateVersion += 1;
      this.stateCache = { state: next, expiresAt: Date.now() + EtapiReadWeaveCourseApi.readCacheTtlMs };
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
      const encodeStartedAt = timingEnabled ? performance.now() : 0;
      let content: string;
      try {
        content = encodeReadWeaveStateContent(state);
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

  private async initializeActivityState(state: EtapiState): Promise<void> {
    const note = await this.createNote(
      state.projections.courseRootNoteId,
      "01 Course OS 学习活动索引",
      encodeReadWeaveStateContent(this.activityState(state)),
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
    try {
      await this.putContent(noteId, encodeReadWeaveStateContent(this.activityState(state)));
      this.lastWriteAt = new Date().toISOString();
      for (const located of this.draftPageRecordCache.values()) this.mergeDraftPageRecord(state, located.record);
      this.stateVersion += 1;
      this.stateCache = { state, expiresAt: Date.now() + EtapiReadWeaveCourseApi.readCacheTtlMs };
    } catch (error) {
      this.invalidateStateCache();
      throw error;
    }
  }

  private async readCostIndex(noteId: string): Promise<EtapiCostIndexState> {
    const parsed = decodeReadWeaveStateContent(await this.getContent(noteId)) as Partial<EtapiCostIndexState>;
    return {
      schemaVersion: "1.0.0",
      costEntries: parsed.costEntries ?? [],
      idempotency: parsed.idempotency ?? {}
    };
  }

  private async mutateActivity<T>(change: (state: EtapiState) => Promise<T>, context: IdempotentWriteContext): Promise<T> {
    return this.enqueueWrite(async () => {
      try {
        const pendingRead = this.stateReadInFlight;
        if (pendingRead) await pendingRead.catch(() => undefined);
        const state = structuredClone(await this.readStateReference(true));
        if (!state.projections.activityStateNoteId) await this.mergeDraftPageRecords(state);
        const replay = Boolean(state.idempotency[context.idempotencyKey]);
        const result = structuredClone(await change(state));
        if (!replay) {
          if (state.projections.activityStateNoteId) await this.writeActivityState(state);
          else await this.initializeActivityState(state);
        }
        return result;
      } catch (error) {
        this.invalidateStateCache();
        throw error;
      }
    }, context);
  }

  private async mutate<T>(change: (state: EtapiState) => Promise<T>, context?: IdempotentWriteContext): Promise<T> {
    return this.enqueueWrite(async () => {
      try {
        const pendingRead = this.stateReadInFlight;
        if (pendingRead) await pendingRead.catch(() => undefined);
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
    const operation = this.writeChain.catch(() => undefined).then(async () => {
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
    this.writeChain = operation.then(() => undefined, () => undefined);
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
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.bootstrap().catch(error => {
        // A transient ETAPI failure must not pin every later read to the
        // rejected bootstrap promise after ReadWeave recovers.
        this.bootstrapPromise = undefined;
        throw error;
      });
    }
    return this.bootstrapPromise;
  }

  private async bootstrap(): Promise<ProjectionIndex> {
    const query = new URLSearchParams({
      search: `#courseOsIndex=${this.workspaceId}`,
      ancestorNoteId: this.config.parentNoteId,
      ancestorDepth: "lt5",
      fastSearch: "true"
    });
    const search = await this.request<SearchResponse>(`/notes?${query.toString()}`);
    const existing = search.results[0];
    if (existing) {
      const content = await this.getContent(existing.noteId);
      const parsed = decodeReadWeaveStateContent(content) as Partial<EtapiState>;
      if (!parsed.projections) throw new Error("READWEAVE_COURSE_INDEX_INVALID");
      this.bootstrapStateContent = content;
      return parsed.projections;
    }
    const root = await this.createNote(this.config.parentNoteId, "Course OS", "<h2>Course OS</h2><p>课程制作、学习和长期复习的权威知识树</p>", "text", undefined, {
      courseOsType: "workspace",
      courseOsWorkspaceId: this.workspaceId
    });
    const stateNote = await this.createNote(root.noteId, "00 Course OS 结构化索引", "{}", "code", "application/json", {
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
    return projection;
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
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await this.fetchImpl(input, { ...init, headers, signal: controller.signal });
        if (response.ok) return response;
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
}

function plainReadWeaveText(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
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

function shouldRetryHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function delayForRetry(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
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

function replayQuestionAttemptTransaction(state: ReadWeaveFileState, attemptId: string): QuestionAttemptTransactionResult {
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
