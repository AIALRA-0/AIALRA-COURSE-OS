import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
import type { ReadWeaveCourseApi, ReadWeaveFileState } from "./index.js";
import { EMPTY_STATE, defaultModelProviders, defaultModelRoutePolicy, defaultWorkspaceSettings } from "./index.js";
import { isLegacyProjectionId, isStableMaterialId, materialGroups, materialTreeNode, stableMaterialId } from "./tree-identity.js";

export interface EtapiReadWeaveConfig {
  baseUrl: string;
  token: string;
  parentNoteId: string;
  publicUrl?: string;
  workspaceId?: string;
  seedStatePath?: string;
  fetchImpl?: typeof fetch;
}

interface EtapiNote {
  noteId: string;
  title: string;
  type: string;
  mime: string;
  blobId?: string;
  parentBranchIds?: string[];
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
  sourceNoteId: string;
  atomsNoteId: string;
  blockNoteIds: Record<string, string>;
  blockHashes: Record<string, string>;
  sectionNoteIds: Record<SectionKey, string>;
  sourceImageNoteId?: string;
}

interface ProjectionIndex {
  courseRootNoteId: string;
  stateNoteId: string;
  rootMaterialsNoteId?: string;
  trashNoteId?: string;
  courses: Record<string, CourseProjection>;
  drafts: Record<string, DraftProjection>;
  releases: Record<string, string>;
}

interface EtapiState extends ReadWeaveFileState {
  projections: ProjectionIndex;
}

const SECTION_DEFINITIONS = [
  ["source", "00 来源与原始截图"],
  ["objectives", "01 学习目标"],
  ["main", "02 主要内容"],
  ["prerequisites", "03 先验知识"],
  ["explanation", "04 完整讲解"],
  ["misconceptions", "05 易错点"],
  ["assessment", "06 随机问题"],
  ["qa", "07 QA记录"],
  ["quality", "08 质量与成本"]
] as const;

export class EtapiReadWeaveCourseApi implements ReadWeaveCourseApi {
  private readonly fetchImpl: typeof fetch;
  private readonly workspaceId: string;
  private bootstrapPromise?: Promise<ProjectionIndex>;
  private writeChain: Promise<void> = Promise.resolve();
  private lastReadAt?: string;
  private lastWriteAt?: string;
  private activeWriteContext?: IdempotentWriteContext;

  constructor(private readonly config: EtapiReadWeaveConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.workspaceId = config.workspaceId ?? "personal";
  }

  async listCourses(): Promise<CourseProject[]> {
    const state = await this.readState();
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
    const releases = (await this.readState()).releases;
    return courseId ? releases.filter((release) => release.courseId === courseId) : releases;
  }

  async getRelease(releaseId: string): Promise<CourseRelease | undefined> {
    return (await this.readState()).releases.find((release) => release.id === releaseId);
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
    const questions = (await this.readState()).questions;
    return pageId ? questions.filter((item) => item.pageId === pageId) : questions;
  }

  async listQuestionAttempts(pageId?: string): Promise<QuestionAttempt[]> {
    const attempts = (await this.readState()).questionAttempts;
    return pageId ? attempts.filter((item) => item.pageId === pageId) : attempts;
  }

  async saveQuestionSelection(selection: QuestionSelection, context: IdempotentWriteContext): Promise<QuestionSelection> {
    return this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) return state.questionSelections.find((item) => item.id === replay.objectId) ?? selection;
      const draft = state.drafts.find((item) => item.pageId === selection.pageId);
      const projection = draft ? state.projections.drafts[draft.id] : undefined;
      if (projection) await this.createNote(projection.sectionNoteIds.assessment, `抽题记录 · ${selection.createdAt}`, `<pre>${escapeHtml(JSON.stringify(selection, null, 2))}</pre>`, "text", undefined, {
        courseOsType: "question_selection", courseOsObjectId: selection.id, courseOsPageId: selection.pageId
      });
      state.questionSelections.push(structuredClone(selection));
      state.idempotency[context.idempotencyKey] = { kind: "question_selection", objectId: selection.id };
      return selection;
    }, context);
  }

  async saveQuestionAttempt(attempt: QuestionAttempt, context: IdempotentWriteContext): Promise<QuestionAttempt> {
    return this.mutate(async (state) => {
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
    return this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) return state.costEntries.find((item) => item.id === replay.objectId) ?? entry;
      const release = state.releases.find((item) => item.id === entry.materialVersionId || item.courseId === entry.courseId);
      if (release) {
        const course = await this.ensureCourseProjection(state, release);
        const draft = entry.pageId ? state.drafts.find((item) => item.pageId === entry.pageId) : undefined;
        const projection = draft ? state.projections.drafts[draft.id] : undefined;
        await this.createNote(projection?.sectionNoteIds.quality ?? course.qualityNoteId, `成本 · ${entry.stage} · ${entry.model}`, `<pre>${escapeHtml(JSON.stringify(entry, null, 2))}</pre>`, "text", undefined, {
          courseOsType: "generation_cost", courseOsObjectId: entry.id, courseOsPageId: entry.pageId ?? ""
        });
      }
      state.costEntries.push(structuredClone(entry));
      state.idempotency[context.idempotencyKey] = { kind: "cost_entry", objectId: entry.id };
      return entry;
    }, context);
  }

  async listCostEntries(filters: { courseId?: string; materialVersionId?: string; pageId?: string; jobId?: string } = {}): Promise<GenerationCostEntry[]> {
    return (await this.readState()).costEntries.filter((item) =>
      (!filters.courseId || item.courseId === filters.courseId) &&
      (!filters.materialVersionId || item.materialVersionId === filters.materialVersionId) &&
      (!filters.pageId || item.pageId === filters.pageId) &&
      (!filters.jobId || item.jobId === filters.jobId));
  }

  async saveAttempt(attempt: AssessmentAttempt, mastery: MasteryRecord, context: IdempotentWriteContext): Promise<AssessmentAttempt> {
    return this.mutate(async (state) => {
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
    const state = await this.readState();
    let changed = false;
    for (let index = 0; index < state.drafts.length; index += 1) {
      const reconciled = await this.reconcileDraft(state, state.drafts[index]!);
      state.drafts[index] = reconciled.draft;
      changed ||= reconciled.changed;
    }
    if (changed) await this.writeState(state);
    return state.drafts;
  }

  async getDraftByPage(pageId: string): Promise<LessonDraft | undefined> {
    const state = await this.readState();
    const index = state.drafts.findIndex((draft) => draft.pageId === pageId);
    if (index < 0) return undefined;
    const reconciled = await this.reconcileDraft(state, state.drafts[index]!);
    if (reconciled.changed) {
      state.drafts[index] = reconciled.draft;
      await this.writeState(state);
    }
    return reconciled.draft;
  }

  async saveDraft(draft: LessonDraft, expectedRevision: number, context: IdempotentWriteContext, sourceAsset?: DraftSourceAsset): Promise<LessonDraft> {
    const result = await this.mutate(async (state): Promise<{ saved?: LessonDraft; conflict?: CourseConflict }> => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) {
        const existing = state.drafts.find((item) => item.id === replay.objectId);
        if (!existing) throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
        return { saved: existing };
      }
      const index = state.drafts.findIndex((item) => item.pageId === draft.pageId);
      let current = index >= 0 ? state.drafts[index] : undefined;
      if (current) current = (await this.reconcileDraft(state, current)).draft;
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== expectedRevision) {
        const conflict = this.createConflict(draft, expectedRevision, current);
        state.conflicts.push(conflict);
        return { conflict };
      }
      const projection = await this.ensureDraftProjection(state, draft, sourceAsset);
      await this.refreshDraftProjection(draft, projection, sourceAsset);
      const saved: LessonDraft = structuredClone({
        ...draft,
        readweaveNoteId: projection.pageNoteId,
        revision: currentRevision + 1,
        contentHash: sha256(JSON.stringify(draft.page)),
        updatedAt: new Date().toISOString()
      });
      if (index >= 0) state.drafts[index] = saved;
      else state.drafts.push(saved);
      state.idempotency[context.idempotencyKey] = { kind: "draft", objectId: saved.id };
      return { saved };
    }, context);
    if (result.conflict) throw new Error(`READWEAVE_REVISION_CONFLICT:${result.conflict.id}`);
    if (!result.saved) throw new Error("READWEAVE_DRAFT_SAVE_FAILED");
    return result.saved;
  }

  async listConflicts(): Promise<CourseConflict[]> {
    return (await this.readState()).conflicts;
  }

  async resolveConflict(conflictId: string, resolution: "local" | "remote" | "merged", mergedContent: string | undefined, context: IdempotentWriteContext): Promise<CourseConflict> {
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
      draft.contentHash = sha256(selected);
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
      const state = await this.readState();
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
    const state = await this.readState();
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
      if (!byId.has(id)) {
        byId.set(id, { ...materialTreeNode(course, group, persisted), id, materialId: id, readweaveNoteId: persisted?.readweaveNoteId ?? legacyNoteId });
      }
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

  async listTrash(): Promise<TrashRecord[]> { return (await this.readState()).trash.filter((item) => item.workspaceId === this.workspaceId || !item.workspaceId); }

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
    const visible = (await this.listTreeNodes()).find((candidate) => candidate.id === nodeId);
    const node = visible ?? (await this.readState()).treeNodes.find((candidate) => candidate.id === nodeId);
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
    return this.mutate(async (state) => { state.settings = structuredClone({ ...settings, updatedAt: new Date().toISOString() }); state.idempotency[context.idempotencyKey] = { kind: "settings", objectId: settings.workspaceId }; return structuredClone(state.settings!); }, context);
  }

  async listModelProviders(): Promise<ModelProviderConfig[]> { const state = await this.readState(); return structuredClone(state.modelProviders.length ? state.modelProviders : defaultModelProviders()); }

  async updateModelProvider(providerId: string, patch: { baseUrl?: string; enabled?: boolean }, context: IdempotentWriteContext): Promise<ModelProviderConfig> {
    return this.mutate(async (state) => {
      const providers = state.modelProviders.length ? state.modelProviders : defaultModelProviders();
      const provider = providers.find((item) => item.id === providerId);
      if (!provider) throw new Error("MODEL_PROVIDER_NOT_FOUND");
      if (patch.baseUrl !== undefined) provider.baseUrl = patch.baseUrl.trim();
      if (patch.enabled !== undefined) provider.enabled = patch.enabled;
      state.modelProviders = providers;
      state.idempotency[context.idempotencyKey] = { kind: "provider_config", objectId: providerId };
      return structuredClone(provider);
    }, context);
  }

  async saveModelProviderCredential(providerId: string, credential: CredentialStatus, context: IdempotentWriteContext): Promise<Pick<ModelProviderConfig, "id" | "credential">> {
    if (!credential.configured || !credential.maskedValue) throw new Error("MODEL_PROVIDER_CREDENTIAL_STATUS_REQUIRED");
    return this.mutate(async (state) => { const providers = state.modelProviders.length ? state.modelProviders : defaultModelProviders(); const provider = providers.find((item) => item.id === providerId); if (!provider) throw new Error("MODEL_PROVIDER_NOT_FOUND"); provider.credential = structuredClone(credential); state.modelProviders = providers; state.idempotency[context.idempotencyKey] = { kind: "provider_credential", objectId: providerId }; return { id: provider.id, credential: structuredClone(provider.credential) }; }, context);
  }

  async testModelProvider(providerId: string): Promise<ModelProviderConfig> { const provider = (await this.listModelProviders()).find((item) => item.id === providerId); if (!provider) throw new Error("MODEL_PROVIDER_NOT_FOUND"); return structuredClone({ ...provider, health: { providerId, state: provider.credential.configured ? "connected" as const : "unconfigured" as const, checkedAt: new Date().toISOString(), message: provider.credential.configured ? "供应商配置已就绪" : "请先保存接口密钥" } }); }

  async getModelRoutePolicy(): Promise<ModelRoutePolicy> { const state = await this.readState(); return structuredClone(state.modelRoutePolicy ?? defaultModelRoutePolicy(this.workspaceId)); }

  async saveModelRoutePolicy(policy: ModelRoutePolicy, context: IdempotentWriteContext): Promise<ModelRoutePolicy> { return this.mutate(async (state) => { state.modelRoutePolicy = structuredClone({ ...policy, updatedAt: new Date().toISOString() }); state.idempotency[context.idempotencyKey] = { kind: "model_route_policy", objectId: policy.workspaceId }; return structuredClone(state.modelRoutePolicy!); }, context); }

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
    return this.request<EtapiBranch>("/branches", { method: "POST", body: JSON.stringify({ noteId, parentNoteId, notePosition: 10, prefix: "", isExpanded: false }) });
  }

  private async moveBranch(branchId: string, parentBranchId: string): Promise<void> {
    const result = await this.request<{ success?: boolean }>(`/branches/${encodeURIComponent(branchId)}/move-to/${encodeURIComponent(parentBranchId)}`, { method: "PUT" });
    if (result.success === false) throw new Error("READWEAVE_TREE_MOVE_REJECTED");
  }

  private async patchNoteTitle(noteId: string, title: string): Promise<void> {
    await this.request<EtapiNote>(`/notes/${encodeURIComponent(noteId)}`, { method: "PATCH", body: JSON.stringify({ title }) });
  }

  private async undeleteNote(noteId: string): Promise<void> {
    await this.raw(`/notes/${encodeURIComponent(noteId)}/undelete`, { method: "PUT", body: JSON.stringify({ fallbackParentNoteId: this.config.parentNoteId }) });
  }

  private async reconcileDraft(state: EtapiState, draft: LessonDraft): Promise<{ draft: LessonDraft; changed: boolean }> {
    const projection = state.projections.drafts[draft.id];
    if (!projection) return { draft, changed: false };
    const next = structuredClone(draft);
    let changed = false;
    for (const block of next.page.blocks) {
      const noteId = projection.blockNoteIds[block.id];
      if (!noteId) continue;
      const remoteMarkdown = await this.getContent(noteId);
      const remoteHash = sha256(remoteMarkdown);
      if (remoteHash !== projection.blockHashes[block.id]) {
        block.markdown = remoteMarkdown;
        projection.blockHashes[block.id] = remoteHash;
        changed = true;
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
    const pageNote = await this.createNote(moduleNoteId, `第 ${String(draft.page.pageNumber).padStart(3, "0")} 页 · ${draft.page.title}`, this.renderPageOverview(draft), "text", undefined, {
      courseOsType: "page",
      courseOsObjectId: draft.pageId
    });
    const sectionNoteIds = {} as Record<SectionKey, string>;
    for (const [key, title] of SECTION_DEFINITIONS) {
      sectionNoteIds[key] = (await this.createNote(pageNote.noteId, title, "", "text", undefined, { courseOsType: `page_${key}`, courseOsPageId: draft.pageId })).noteId;
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
      sourceNoteId: sectionNoteIds.source,
      atomsNoteId: sectionNoteIds.quality,
      blockNoteIds,
      blockHashes,
      sectionNoteIds,
      sourceImageNoteId
    };
    state.projections.drafts[draft.id] = projection;
    return projection;
  }

  private async refreshDraftProjection(draft: LessonDraft, projection: DraftProjection, sourceAsset?: DraftSourceAsset): Promise<void> {
    await this.putContent(projection.pageNoteId, this.renderPageOverview(draft));
    if (sourceAsset) {
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
    await this.putContent(projection.sectionNoteIds.source, this.renderSource(draft, projection.sourceImageNoteId, sourceAsset?.fileName));
    for (const [key] of SECTION_DEFINITIONS) {
      if (key === "source") continue;
      await this.putContent(projection.sectionNoteIds[key], this.renderSectionOverview(draft, key));
    }
    for (const block of draft.page.blocks) {
      const nextHash = sha256(block.markdown);
      let noteId = projection.blockNoteIds[block.id];
      if (!noteId) {
        const section = this.sectionForBlock(block);
        const note = await this.createNote(projection.sectionNoteIds[section], block.title, block.markdown, "code", "text/markdown", {
          courseOsType: "explanation_block",
          courseOsObjectId: block.id,
          courseOsPageId: draft.pageId
        });
        noteId = note.noteId;
        projection.blockNoteIds[block.id] = noteId;
      } else if (projection.blockHashes[block.id] !== nextHash) {
        await this.putContent(noteId, block.markdown);
      }
      projection.blockHashes[block.id] = nextHash;
    }
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
    return lesson.markdown ? `<pre>${escapeHtml(lesson.markdown)}</pre>` : "<p>本节内容保存在下方结构化讲解子笔记中</p>";
  }

  private renderPageOverview(draft: LessonDraft): string {
    return `<h2>${escapeHtml(draft.page.title)}</h2><p>页面 ${draft.page.pageNumber} · 修订 ${draft.revision}</p><p>下方子笔记按学习目标、主要内容、先验知识、完整讲解、易错点、随机问题、QA记录和质量成本排列</p>`;
  }

  private renderSource(draft: LessonDraft, imageNoteId?: string, fileName = "page.png"): string {
    const image = imageNoteId ? `<p><img src="api/images/${encodeURIComponent(imageNoteId)}/${encodeURIComponent(fileName)}" alt="原始页面"></p>` : "";
    const extracted = draft.page.anchors.find((anchor) => anchor.kind === "text")?.text;
    return `<p>原始页面</p>${image}<p><code>${escapeHtml(draft.page.imageUrl)}</code></p>${extracted ? `<h3>提取文本</h3><pre>${escapeHtml(extracted)}</pre>` : ""}<h3>来源锚点</h3><pre>${escapeHtml(JSON.stringify(draft.page.anchors, null, 2))}</pre>`;
  }

  private async readState(): Promise<EtapiState> {
    const projection = await this.ensureWorkspace();
    const content = await this.getContent(projection.stateNoteId);
    const parsed = JSON.parse(content) as Partial<EtapiState>;
    this.lastReadAt = new Date().toISOString();
    return normalizeState(parsed, projection);
  }

  private async writeState(state: EtapiState): Promise<void> {
    await this.putContent(state.projections.stateNoteId, JSON.stringify(state, null, 2));
    this.lastWriteAt = new Date().toISOString();
  }

  private async mutate<T>(change: (state: EtapiState) => Promise<T>, context?: IdempotentWriteContext): Promise<T> {
    let result!: T;
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      const previousContext = this.activeWriteContext;
      this.activeWriteContext = context;
      try {
        const state = await this.readState();
        result = await change(state);
        await this.writeState(state);
      } finally {
        this.activeWriteContext = previousContext;
      }
    });
    await this.writeChain;
    return result;
  }

  private async ensureWorkspace(): Promise<ProjectionIndex> {
    if (!this.bootstrapPromise) this.bootstrapPromise = this.bootstrap();
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
      const parsed = JSON.parse(await this.getContent(existing.noteId)) as Partial<EtapiState>;
      if (!parsed.projections) throw new Error("READWEAVE_COURSE_INDEX_INVALID");
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

  private async getContent(noteId: string): Promise<string> {
    const response = await this.raw(`/notes/${encodeURIComponent(noteId)}/content`);
    return response.text();
  }

  private async putContent(noteId: string, content: string): Promise<void> {
    await this.raw(`/notes/${encodeURIComponent(noteId)}/revision`, { method: "POST" });
    await this.raw(`/notes/${encodeURIComponent(noteId)}/content`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: Buffer.from(content)
    });
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
    if (this.activeWriteContext) {
      headers.set("Idempotency-Key", this.activeWriteContext.idempotencyKey);
      headers.set("X-Actor", this.activeWriteContext.actor);
      headers.set("X-Workspace-Id", this.activeWriteContext.workspaceId);
      headers.set("X-Request-Id", this.activeWriteContext.requestId);
      headers.set("X-Schema-Version", this.activeWriteContext.schemaVersion);
    }
    const base = this.config.baseUrl.replace(/\/$/, "");
    const input = `${base}/etapi${path}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.fetchImpl(input, { ...init, headers });
        if (response.ok) return response;
        if (!shouldRetryHttpStatus(response.status) || attempt === 2) throw new Error(`READWEAVE_ETAPI_${response.status}:${await response.text()}`);
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : "REQUEST_FAILED";
        if (message.startsWith("READWEAVE_ETAPI_") && !message.startsWith("READWEAVE_ETAPI_NETWORK")) throw error;
        if (attempt === 2) throw new Error(`READWEAVE_ETAPI_NETWORK:${message}`);
      }
      await delayForRetry(attempt);
    }
    throw new Error(`READWEAVE_ETAPI_NETWORK:${lastError instanceof Error ? lastError.message : "REQUEST_FAILED"}`);
  }
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
