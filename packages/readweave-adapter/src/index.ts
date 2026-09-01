import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  AssessmentAttempt,
  CredentialStatus,
  CourseConflict,
  CourseProject,
  CourseRelease,
  CourseTreeNode,
  DraftSourceAsset,
  GenerationCostEntry,
  IdempotentWriteContext,
  LessonDraft,
  MasteryRecord,
  PageQuestion,
  QuestionAttempt,
  QuestionSelection,
  ReviewPlan,
  ReadWeaveSyncStatus,
  ReleaseManifest,
  ResearchArchive,
  ReadWeaveDeepLink,
  TreeNodeProperties,
  ModelProviderConfig,
  ModelRoutePolicy,
  TrashRecord,
  WorkspaceSettings
} from "@course-os/contracts";
import { writeJsonAtomic } from "@course-os/storage";
import { courseTreeNode, isLegacyProjectionId, isStableMaterialId, materialGroups, materialTreeNode, stableMaterialId } from "./tree-identity.js";

export interface ReadWeaveCourseApi {
  listCourses(): Promise<CourseProject[]>;
  createCourse(course: CourseProject, context: IdempotentWriteContext): Promise<CourseProject>;
  registerDraftSource(release: CourseRelease, context: IdempotentWriteContext): Promise<CourseRelease>;
  removeDraftSource(releaseId: string, context: IdempotentWriteContext): Promise<void>;
  listReleases(courseId?: string): Promise<CourseRelease[]>;
  getRelease(releaseId: string): Promise<CourseRelease | undefined>;
  publishRelease(release: CourseRelease, manifest: ReleaseManifest, context: IdempotentWriteContext): Promise<CourseRelease>;
  saveQuestion(question: PageQuestion, context: IdempotentWriteContext): Promise<PageQuestion>;
  updateQuestion(question: PageQuestion, expectedRevision: number, context: IdempotentWriteContext): Promise<PageQuestion>;
  listQuestions(pageId?: string): Promise<PageQuestion[]>;
  listQuestionAttempts(pageId?: string): Promise<QuestionAttempt[]>;
  saveQuestionSelection(selection: QuestionSelection, context: IdempotentWriteContext): Promise<QuestionSelection>;
  saveQuestionAttempt(attempt: QuestionAttempt, context: IdempotentWriteContext): Promise<QuestionAttempt>;
  getReviewPlan(planId: string): Promise<ReviewPlan | undefined>;
  saveReviewPlan(plan: ReviewPlan, context: IdempotentWriteContext): Promise<ReviewPlan>;
  updateReviewPlan(plan: ReviewPlan, expectedRevision: number, context: IdempotentWriteContext): Promise<ReviewPlan>;
  appendCostEntry(entry: GenerationCostEntry, context: IdempotentWriteContext): Promise<GenerationCostEntry>;
  listCostEntries(filters?: { courseId?: string; materialVersionId?: string; pageId?: string; jobId?: string }): Promise<GenerationCostEntry[]>;
  saveAttempt(attempt: AssessmentAttempt, mastery: MasteryRecord, context: IdempotentWriteContext): Promise<AssessmentAttempt>;
  listAssessmentAttempts(objectiveId?: string): Promise<AssessmentAttempt[]>;
  listMastery(): Promise<MasteryRecord[]>;
  getManifest(releaseId: string): Promise<ReleaseManifest | undefined>;
  archiveResearch(archive: ResearchArchive, context: IdempotentWriteContext): Promise<ResearchArchive>;
  searchResearch(query: string): Promise<Array<{ archiveId: string; title: string; snippets: string[] }>>;
  listDrafts(): Promise<LessonDraft[]>;
  getDraftByPage(pageId: string): Promise<LessonDraft | undefined>;
  saveDraft(draft: LessonDraft, expectedRevision: number, context: IdempotentWriteContext, sourceAsset?: DraftSourceAsset): Promise<LessonDraft>;
  listConflicts(): Promise<CourseConflict[]>;
  resolveConflict(conflictId: string, resolution: "local" | "remote" | "merged", mergedContent: string | undefined, context: IdempotentWriteContext): Promise<CourseConflict>;
  getSyncStatus(): Promise<ReadWeaveSyncStatus>;
  listTreeNodes(): Promise<CourseTreeNode[]>;
  createTreeNode(node: CourseTreeNode, context: IdempotentWriteContext): Promise<CourseTreeNode>;
  updateTreeNode(nodeId: string, patch: { title?: string; parentId?: string | null; archived?: boolean; sortOrder?: number }, expectedRevision: number, context: IdempotentWriteContext): Promise<CourseTreeNode>;
  duplicateTreeNode(nodeId: string, context: IdempotentWriteContext): Promise<CourseTreeNode>;
  trashTreeNode(nodeId: string, context: IdempotentWriteContext): Promise<TrashRecord>;
  listTrash(): Promise<TrashRecord[]>;
  restoreTrash(trashId: string, context: IdempotentWriteContext, options?: { restoreMode?: "original" | "root" }): Promise<CourseTreeNode>;
  permanentlyDeleteTrash(trashId: string, context: IdempotentWriteContext): Promise<void>;
  getTreeNodeProperties(nodeId: string): Promise<TreeNodeProperties | undefined>;
  getDeepLink(noteId: string): Promise<ReadWeaveDeepLink | undefined>;
  getWorkspaceSettings(): Promise<WorkspaceSettings>;
  saveWorkspaceSettings(settings: WorkspaceSettings, context: IdempotentWriteContext): Promise<WorkspaceSettings>;
  listModelProviders(): Promise<ModelProviderConfig[]>;
  updateModelProvider(providerId: string, patch: { baseUrl?: string; enabled?: boolean }, context: IdempotentWriteContext): Promise<ModelProviderConfig>;
  saveModelProviderCredential(providerId: string, credential: CredentialStatus, context: IdempotentWriteContext): Promise<Pick<ModelProviderConfig, "id" | "credential">>;
  testModelProvider(providerId: string): Promise<ModelProviderConfig>;
  getModelRoutePolicy(): Promise<ModelRoutePolicy>;
  saveModelRoutePolicy(policy: ModelRoutePolicy, context: IdempotentWriteContext): Promise<ModelRoutePolicy>;
}

export interface ReadWeaveFileState {
  schemaVersion: "1.0.0";
  courses: CourseProject[];
  releases: CourseRelease[];
  manifests: ReleaseManifest[];
  questions: PageQuestion[];
  questionSelections: QuestionSelection[];
  questionAttempts: QuestionAttempt[];
  reviewPlans: ReviewPlan[];
  costEntries: GenerationCostEntry[];
  attempts: AssessmentAttempt[];
  mastery: MasteryRecord[];
  researchArchives: ResearchArchive[];
  drafts: LessonDraft[];
  conflicts: CourseConflict[];
  treeNodes: CourseTreeNode[];
  trash: TrashRecord[];
  settings?: WorkspaceSettings;
  modelProviders: ModelProviderConfig[];
  modelRoutePolicy?: ModelRoutePolicy;
  idempotency: Record<string, { kind: string; objectId: string }>;
}

export const EMPTY_STATE: ReadWeaveFileState = {
  schemaVersion: "1.0.0",
  courses: [],
  releases: [],
  manifests: [],
  questions: [],
  questionSelections: [],
  questionAttempts: [],
  reviewPlans: [],
  costEntries: [],
  attempts: [],
  mastery: [],
  researchArchives: [],
  drafts: [],
  conflicts: [],
  treeNodes: [],
  trash: [],
  modelProviders: [],
  idempotency: {}
};

export function defaultWorkspaceSettings(workspaceId: string): WorkspaceSettings {
  return { workspaceId, language: "zh-CN", theme: "light", baseFontScale: 1.1, defaultQualityMode: "balanced", learningAutoAdvance: false, showEnglishLabels: false, updatedAt: new Date(0).toISOString() };
}

export function defaultModelProviders(): ModelProviderConfig[] {
  return [
    { id: "opencode-go", displayName: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go/v1", enabled: true, credential: { configured: false }, models: [
      { id: "qwen3.8-flash", displayName: "Qwen 3.8 Flash", protocol: "messages", supportsVision: false, supportsJsonSchema: false, supportsReasoning: true, billingMode: "subscription_quota" },
      { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", protocol: "chat_completions", supportsVision: false, supportsJsonSchema: true, supportsReasoning: true, billingMode: "subscription_quota" },
      { id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", protocol: "chat_completions", supportsVision: false, supportsJsonSchema: true, supportsReasoning: true, billingMode: "subscription_quota" },
      { id: "deepseek-v4-flash-vision-exp", displayName: "DeepSeek V4 Flash Vision Exp", protocol: "chat_completions", supportsVision: true, supportsJsonSchema: true, supportsReasoning: true, billingMode: "subscription_quota" }
    ] },
    { id: "deepseek", displayName: "DeepSeek API", baseUrl: "https://api.deepseek.com", enabled: true, credential: { configured: false }, models: [
      { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", protocol: "responses", supportsVision: false, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" },
      { id: "deepseek-v4-flash-vision-exp", displayName: "DeepSeek V4 Flash Vision Exp", protocol: "responses", supportsVision: true, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" },
      { id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", protocol: "responses", supportsVision: false, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" }
    ] },
    { id: "aialra-router", displayName: "AIALRA Model Router", baseUrl: "", enabled: false, credential: { configured: false }, models: [] }
  ];
}

export function defaultModelRoutePolicy(workspaceId: string): ModelRoutePolicy {
  return {
    workspaceId,
    allowAialraEmergencyFallback: false,
    updatedAt: new Date(0).toISOString(),
    rules: [
      { stage: "extract", providerId: "opencode-go", modelId: "qwen3.8-flash", fallbackProviderId: "deepseek", fallbackModelId: "deepseek-v4-flash", enabled: true },
      { stage: "atomize", providerId: "opencode-go", modelId: "qwen3.8-flash", fallbackProviderId: "deepseek", fallbackModelId: "deepseek-v4-flash", enabled: true },
      { stage: "teach", providerId: "deepseek", modelId: "deepseek-v4-flash-vision-exp", fallbackProviderId: "opencode-go", fallbackModelId: "deepseek-v4-flash-vision-exp", enabled: true },
      { stage: "review", providerId: "opencode-go", modelId: "qwen3.8-flash", fallbackProviderId: "deepseek", fallbackModelId: "deepseek-v4-pro", enabled: true },
      { stage: "repair", providerId: "deepseek", modelId: "deepseek-v4-pro", fallbackProviderId: "opencode-go", fallbackModelId: "deepseek-v4-flash", enabled: true },
      { stage: "question_refill", providerId: "opencode-go", modelId: "qwen3.8-flash", fallbackProviderId: "deepseek", fallbackModelId: "deepseek-v4-flash", enabled: true },
      { stage: "qa", providerId: "opencode-go", modelId: "qwen3.8-flash", fallbackProviderId: "deepseek", fallbackModelId: "deepseek-v4-pro", enabled: true }
    ]
  };
}

export class FileReadWeaveCourseApi implements ReadWeaveCourseApi {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly statePath: string, private readonly publicUrl = "https://readweave.example.com") {}

  async listCourses(): Promise<CourseProject[]> {
    const state = await this.read();
    return mergeReleaseCourses(state.courses, state.releases);
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
      const saved = structuredClone({ ...course, readweaveNoteId: course.readweaveNoteId ?? fileCourseNoteId(course.id) });
      state.courses.push(saved);
      state.idempotency[context.idempotencyKey] = { kind: "course", objectId: course.id };
      return saved;
    });
    await this.readBackTreeNode(saved.id, courseTreeNode(saved));
    return saved;
  }

  async listTreeNodes(): Promise<CourseTreeNode[]> {
    const state = await this.read();
    const stableMaterialIds = new Set(materialGroups(state.releases).map((group) => stableMaterialId(group.courseId, group.moduleId)));
    const archivedMaterialIds = new Set(state.treeNodes
      .filter((node) => node.kind === "material" && node.archived)
      .map((node) => node.materialId || node.id));
    const generatedCourses = mergeReleaseCourses(state.courses, state.releases)
      .filter((course) => course.status !== "archived")
      .map((course) => ({ ...courseTreeNode(course), readweaveNoteId: course.readweaveNoteId ?? fileCourseNoteId(course.id) }));
    const byId = new Map(state.treeNodes
      .filter((node) => (node.kind === "course" || node.kind === "material") && !node.archived)
      .filter((node) => !(node.kind === "material" && node.id !== node.materialId && node.materialId && stableMaterialIds.has(node.materialId)))
      .map((node) => [node.id, structuredClone(node)] as const));
    for (const node of generatedCourses) if (!byId.has(node.id)) byId.set(node.id, node);
    const persistedMaterials = new Map(state.treeNodes.filter((node) => node.kind === "material" && !node.archived).map((node) => [node.id, node]));
    for (const group of materialGroups(state.releases)) {
      const course = generatedCourses.find((item) => item.id === group.courseId);
      if (!course) continue;
      const id = stableMaterialId(group.courseId, group.moduleId);
      if (archivedMaterialIds.has(id)) continue;
      const persisted = persistedMaterials.get(id) ?? state.treeNodes.find((node) => node.kind === "material" && !node.archived && node.materialId === id);
      if (!byId.has(id)) byId.set(id, { ...materialTreeNode(state.courses.find((item) => item.id === course.id) ?? {
        id: course.id,
        workspaceId: "personal",
        title: course.title,
        status: "active",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString()
      }, group, persisted), id, materialId: id, readweaveNoteId: persisted?.readweaveNoteId ?? fileMaterialNoteId(id) });
    }
    return [...byId.values()];
  }

  async createTreeNode(node: CourseTreeNode, context: IdempotentWriteContext): Promise<CourseTreeNode> {
    const saved = await this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) return state.treeNodes.find((item) => item.id === replay.objectId) ?? node;
      if (state.treeNodes.some((item) => item.id === node.id) || state.courses.some((item) => item.id === node.id)) throw new Error("READWEAVE_TREE_NODE_EXISTS");
      const saved = structuredClone({ ...node, revision: node.revision ?? 0, children: [], readweaveNoteId: node.readweaveNoteId ?? (node.kind === "material" ? fileMaterialNoteId(node.materialId || node.id) : undefined) });
      state.treeNodes.push(saved);
      state.idempotency[context.idempotencyKey] = { kind: "tree_node", objectId: saved.id };
      return saved;
    });
    return this.readBackTreeNode(saved.id, saved);
  }

  async updateTreeNode(nodeId: string, patch: { title?: string; parentId?: string | null; archived?: boolean; sortOrder?: number }, expectedRevision: number, context: IdempotentWriteContext): Promise<CourseTreeNode> {
    const saved = await this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) {
        const replayNode = state.treeNodes.find((item) => item.id === replay.objectId);
        if (replayNode) return structuredClone(replayNode);
        const replayCourse = state.courses.find((item) => item.id === replay.objectId);
        if (replayCourse) return courseTreeNode(replayCourse);
        throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
      }
      if (isLegacyProjectionId(nodeId)) throw new Error("TREE_NODE_NOT_EDITABLE");
      const course = ensureCourseForTreeMutation(state, nodeId);
      const node = ensureMaterialForTreeMutation(state, nodeId) ?? state.treeNodes.find((item) => item.id === nodeId);
      const currentRevision = course?.revision ?? node?.revision ?? 0;
      if (!course && !node) throw new Error("TREE_NODE_STALE");
      if (currentRevision !== expectedRevision) throw new Error("READWEAVE_TREE_NODE_REVISION_CONFLICT");
      const now = new Date().toISOString();
      if (course) {
        if (patch.title?.trim()) course.title = patch.title.trim();
        if (typeof patch.archived === "boolean") course.status = patch.archived ? "archived" : "active";
        if (typeof patch.sortOrder === "number" && Number.isFinite(patch.sortOrder)) course.sortOrder = patch.sortOrder;
        course.revision = currentRevision + 1;
        course.updatedAt = now;
        const saved = structuredClone({ id: course.id, kind: "course" as const, title: course.title, subtitle: course.description, status: course.status === "archived" ? "draft" as const : "published" as const, archived: course.status === "archived", revision: course.revision, readweaveNoteId: course.readweaveNoteId, children: [] });
        if (node) Object.assign(node, saved);
        else state.treeNodes.push(saved);
        state.idempotency[context.idempotencyKey] = { kind: "tree_node", objectId: nodeId };
        return saved;
      }
      if (patch.title?.trim()) node!.title = patch.title.trim();
      if (patch.parentId !== undefined) {
        if (patch.parentId === nodeId) throw new Error("READWEAVE_TREE_PARENT_CYCLE");
        // A material may be restored to or reordered within the workspace root
        // when the user explicitly chooses the root destination
        if (node?.kind === "material" && patch.parentId && !state.courses.some((item) => item.id === patch.parentId) && !mergeReleaseCourses(state.courses, state.releases).some((item) => item.id === patch.parentId)) throw new Error("TREE_TARGET_NOT_FOUND");
        if (node?.kind !== "material" && patch.parentId && !state.treeNodes.some((item) => item.id === patch.parentId) && !state.courses.some((item) => item.id === patch.parentId) && !isVirtualTreeParent(state, patch.parentId)) throw new Error("READWEAVE_TREE_PARENT_NOT_FOUND");
        if (patch.parentId === null) delete node!.parentId;
        else node!.parentId = patch.parentId;
      }
      if (typeof patch.archived === "boolean") node!.archived = patch.archived;
      if (typeof patch.sortOrder === "number" && Number.isFinite(patch.sortOrder)) node!.sortOrder = patch.sortOrder;
      node!.revision = currentRevision + 1;
      state.idempotency[context.idempotencyKey] = { kind: "tree_node", objectId: nodeId };
      return structuredClone(node!);
    });
    return this.readBackTreeNode(saved.id, saved);
  }

  async duplicateTreeNode(nodeId: string, context: IdempotentWriteContext): Promise<CourseTreeNode> {
    const saved = await this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) {
        const replayNode = state.treeNodes.find((item) => item.id === replay.objectId);
        if (replayNode) return structuredClone(replayNode);
        const replayCourse = state.courses.find((item) => item.id === replay.objectId);
        if (replayCourse) return courseTreeNode(replayCourse);
        throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
      }
      if (isLegacyProjectionId(nodeId)) throw new Error("TREE_NODE_NOT_EDITABLE");
      const copyId = `${nodeId}:copy:${Date.now()}`;
      const sourceCourse = ensureCourseForTreeMutation(state, nodeId);
      if (sourceCourse) {
        const copyCourse = structuredClone({ ...sourceCourse, id: copyId, title: `${sourceCourse.title} 副本`, revision: 0, sortOrder: undefined, readweaveNoteId: fileCourseNoteId(copyId) });
        state.courses.push(copyCourse);
        const copy = courseTreeNode(copyCourse);
        state.idempotency[context.idempotencyKey] = { kind: "course", objectId: copy.id };
        return { ...copy, readweaveNoteId: copyCourse.readweaveNoteId };
      }
      const source = ensureMaterialForTreeMutation(state, nodeId) ?? state.treeNodes.find((item) => item.id === nodeId);
      if (!source) throw new Error("TREE_NODE_STALE");
      const copy: CourseTreeNode = structuredClone({ ...source, id: copyId, materialId: copyId, title: `${source.title} 副本`, revision: 0, archived: false, visibility: "library" as const, readweaveNoteId: fileMaterialNoteId(copyId), children: [] });
      state.treeNodes.push(copy);
      state.idempotency[context.idempotencyKey] = { kind: "tree_node", objectId: copy.id };
      return copy;
    });
    return this.readBackTreeNode(saved.id, saved);
  }

  async trashTreeNode(nodeId: string, context: IdempotentWriteContext): Promise<TrashRecord> {
    const saved = await this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) {
        const existingReplay = state.trash.find((item) => item.id === replay.objectId);
        if (existingReplay) return existingReplay;
        throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
      }
      const existing = state.trash.find((item) => item.nodeId === nodeId && item.restoreAvailable);
      if (existing) return existing;
      if (isLegacyProjectionId(nodeId)) throw new Error("TREE_NODE_NOT_EDITABLE");
      const course = ensureCourseForTreeMutation(state, nodeId);
      const node = ensureMaterialForTreeMutation(state, nodeId) ?? state.treeNodes.find((item) => item.id === nodeId);
      const source = course ? { id: course.id, kind: "course" as const, title: course.title, parentId: undefined, readweaveNoteId: course.readweaveNoteId } : node;
      if (!source) throw new Error("TREE_NODE_STALE");
      if (course) course.status = "archived";
      if (node) node.archived = true;
      const item: TrashRecord = { id: `trash:${nodeId}:${Date.now()}`, workspaceId: context.workspaceId, nodeId, nodeKind: source.kind, title: source.title, parentId: source.parentId, originalParentId: source.parentId, originalSortOrder: node?.sortOrder ?? course?.sortOrder, originalPath: treePath(state, nodeId), readweaveNoteId: source.readweaveNoteId, snapshotHash: createHash("sha256").update(JSON.stringify(source)).digest("hex"), deletedAt: new Date().toISOString(), deletedBy: context.actor, restoreAvailable: true, restoreMode: "original" };
      state.trash.push(item);
      state.idempotency[context.idempotencyKey] = { kind: "trash", objectId: item.id };
      return item;
    });
    const records = await this.listTrash();
    const readBack = records.find((item) => item.id === saved.id);
    if (!readBack || readBack.nodeId !== saved.nodeId || readBack.snapshotHash !== saved.snapshotHash) throw new Error("READWEAVE_TREE_READBACK_FAILED");
    return readBack;
  }

  async listTrash(): Promise<TrashRecord[]> {
    return (await this.read()).trash.filter((item) => item.workspaceId === "personal" || !item.workspaceId);
  }

  async restoreTrash(trashId: string, context: IdempotentWriteContext, options: { restoreMode?: "original" | "root" } = {}): Promise<CourseTreeNode> {
    const saved = await this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay?.kind === "restore") {
        const replayCourse = state.courses.find((candidate) => candidate.id === replay.objectId);
        if (replayCourse) return courseTreeNode(replayCourse);
        const replayNode = state.treeNodes.find((candidate) => candidate.id === replay.objectId && !candidate.archived);
        if (replayNode) return structuredClone(replayNode);
        throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
      }
      const item = state.trash.find((candidate) => candidate.id === trashId && candidate.restoreAvailable);
      if (!item) throw new Error("READWEAVE_TRASH_NOT_FOUND");
      const course = state.courses.find((candidate) => candidate.id === item.nodeId);
      const node = state.treeNodes.find((candidate) => candidate.id === item.nodeId);
      if (course) { course.status = "active"; course.updatedAt = new Date().toISOString(); }
      if (node) {
        node.archived = false;
        node.visibility = "library";
        const restoreMode = options.restoreMode ?? item.restoreMode ?? "original";
        if (restoreMode === "root") delete node.parentId;
        else if (item.originalParentId && state.courses.some((candidate) => candidate.id === item.originalParentId && candidate.status !== "archived")) node.parentId = item.originalParentId;
        else delete node.parentId;
        item.restoreMode = restoreMode;
      }
      item.restoreAvailable = false;
      state.idempotency[context.idempotencyKey] = { kind: "restore", objectId: item.nodeId };
      return course ? { id: course.id, kind: "course" as const, title: course.title, subtitle: course.description, status: "published" as const, revision: course.revision ?? 0, readweaveNoteId: course.readweaveNoteId, children: [] } : structuredClone(node!);
    });
    return this.readBackTreeNode(saved.id, saved);
  }

  async permanentlyDeleteTrash(trashId: string, context: IdempotentWriteContext): Promise<void> {
    await this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) return;
      const index = state.trash.findIndex((candidate) => candidate.id === trashId);
      if (index < 0) return;
      const item = state.trash[index]!;
      if (item.nodeKind === "course") {
        const releaseIds = new Set(state.releases.filter((release) => release.courseId === item.nodeId).map((release) => release.id));
        state.courses = state.courses.filter((course) => course.id !== item.nodeId);
        state.releases = state.releases.filter((release) => release.courseId !== item.nodeId);
        state.drafts = state.drafts.filter((draft) => draft.courseId !== item.nodeId);
        state.questions = state.questions.filter((question) => !releaseIds.has(question.courseReleaseId));
        state.questionSelections = state.questionSelections.filter((selection) => !releaseIds.has(selection.courseReleaseId));
        state.questionAttempts = state.questionAttempts.filter((attempt) => !releaseIds.has(attempt.courseReleaseId));
        state.treeNodes = state.treeNodes.filter((node) => node.id !== item.nodeId && node.parentId !== item.nodeId);
      } else {
        state.treeNodes = state.treeNodes.filter((node) => node.id !== item.nodeId);
      }
      state.trash.splice(index, 1);
      state.idempotency[context.idempotencyKey] = { kind: "permanent_delete", objectId: trashId };
    });
  }

  async getDeepLink(noteId: string): Promise<ReadWeaveDeepLink | undefined> {
    const state = await this.read();
    const releaseCourses = mergeReleaseCourses(state.courses, state.releases);
    const releaseCourseNoteFound = releaseCourses.some((item) => fileCourseNoteId(item.id) === noteId);
    const releaseMaterialNoteFound = materialGroups(state.releases).some((group) => fileMaterialNoteId(stableMaterialId(group.courseId, group.moduleId)) === noteId);
    const found = releaseCourseNoteFound || releaseMaterialNoteFound || state.courses.some((item) => item.readweaveNoteId === noteId || fileCourseNoteId(item.id) === noteId) || state.drafts.some((item) => item.readweaveNoteId === noteId) || state.questions.some((item) => item.readweaveNoteId === noteId) || state.treeNodes.some((item) => item.readweaveNoteId === noteId || (item.kind === "material" && fileMaterialNoteId(item.materialId || item.id) === noteId));
    if (!found) return undefined;
    const base = trustedPublicBase(this.publicUrl);
    return { noteId, url: `${base.origin}/#root/${encodeURIComponent(noteId)}`, host: base.hostname, verified: true, verifiedAt: new Date().toISOString() };
  }

  async getWorkspaceSettings(): Promise<WorkspaceSettings> {
    const state = await this.read();
    return structuredClone(state.settings ?? defaultWorkspaceSettings("personal"));
  }

  async saveWorkspaceSettings(settings: WorkspaceSettings, context: IdempotentWriteContext): Promise<WorkspaceSettings> {
    return this.mutate(async (state) => {
      state.settings = structuredClone({ ...settings, updatedAt: new Date().toISOString() });
      state.idempotency[context.idempotencyKey] = { kind: "settings", objectId: settings.workspaceId };
      return structuredClone(state.settings);
    });
  }

  async listModelProviders(): Promise<ModelProviderConfig[]> {
    const state = await this.read();
    return structuredClone(state.modelProviders.length ? state.modelProviders : defaultModelProviders());
  }

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
    });
  }

  async saveModelProviderCredential(providerId: string, credential: CredentialStatus, context: IdempotentWriteContext): Promise<Pick<ModelProviderConfig, "id" | "credential">> {
    if (!credential.configured || !credential.maskedValue) throw new Error("MODEL_PROVIDER_CREDENTIAL_STATUS_REQUIRED");
    return this.mutate(async (state) => {
      const provider = (state.modelProviders.length ? state.modelProviders : defaultModelProviders()).find((item) => item.id === providerId);
      if (!provider) throw new Error("MODEL_PROVIDER_NOT_FOUND");
      provider.credential = structuredClone(credential);
      state.modelProviders = state.modelProviders.length ? state.modelProviders : defaultModelProviders();
      state.modelProviders = state.modelProviders.map((item) => item.id === providerId ? provider : item);
      state.idempotency[context.idempotencyKey] = { kind: "provider_credential", objectId: providerId };
      return { id: provider.id, credential: structuredClone(provider.credential) };
    });
  }

  async testModelProvider(providerId: string): Promise<ModelProviderConfig> {
    const provider = (await this.listModelProviders()).find((item) => item.id === providerId);
    if (!provider) throw new Error("MODEL_PROVIDER_NOT_FOUND");
    return structuredClone({ ...provider, health: { providerId, state: provider.credential.configured ? "connected" as const : "unconfigured" as const, checkedAt: new Date().toISOString(), message: provider.credential.configured ? "供应商配置已就绪" : "请先保存接口密钥" } });
  }

  async getModelRoutePolicy(): Promise<ModelRoutePolicy> {
    const state = await this.read();
    return structuredClone(state.modelRoutePolicy ?? defaultModelRoutePolicy("personal"));
  }

  async saveModelRoutePolicy(policy: ModelRoutePolicy, context: IdempotentWriteContext): Promise<ModelRoutePolicy> {
    return this.mutate(async (state) => {
      state.modelRoutePolicy = structuredClone({ ...policy, updatedAt: new Date().toISOString() });
      state.idempotency[context.idempotencyKey] = { kind: "model_route_policy", objectId: policy.workspaceId };
      return structuredClone(state.modelRoutePolicy);
    });
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
      state.releases.push(saved);
      state.idempotency[context.idempotencyKey] = { kind: "draft_source", objectId: saved.id };
      return saved;
    });
  }

  async removeDraftSource(releaseId: string, _context: IdempotentWriteContext): Promise<void> {
    await this.mutate(async (state) => {
      const release = state.releases.find((item) => item.id === releaseId);
      if (!release) return;
      if (release.lifecycle !== "draft_source") throw new Error("READWEAVE_PUBLISHED_RELEASE_DELETE_DENIED");
      const draftIds = new Set(state.drafts.filter((item) => item.sourceReleaseId === releaseId).map((item) => item.id));
      state.releases = state.releases.filter((item) => item.id !== releaseId);
      state.drafts = state.drafts.filter((item) => item.sourceReleaseId !== releaseId);
      for (const [key, value] of Object.entries(state.idempotency)) {
        if (value.objectId === releaseId || draftIds.has(value.objectId)) delete state.idempotency[key];
      }
    });
  }

  async listReleases(courseId?: string): Promise<CourseRelease[]> {
    const state = await this.read();
    return courseId ? state.releases.filter((release) => release.courseId === courseId) : state.releases;
  }

  async getRelease(releaseId: string): Promise<CourseRelease | undefined> {
    return (await this.read()).releases.find((release) => release.id === releaseId);
  }

  async getManifest(releaseId: string): Promise<ReleaseManifest | undefined> {
    return (await this.read()).manifests.find((manifest) => manifest.courseReleaseId === releaseId);
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
      state.releases.push(structuredClone(release));
      state.manifests.push(structuredClone(manifest));
      state.idempotency[context.idempotencyKey] = { kind: "release", objectId: release.id };
      return release;
    });
  }

  async saveQuestion(question: PageQuestion, context: IdempotentWriteContext): Promise<PageQuestion> {
    return this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) {
        const existing = state.questions.find((item) => item.id === replay.objectId);
        if (!existing) throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
        return existing;
      }
      state.questions.push(structuredClone(question));
      state.idempotency[context.idempotencyKey] = { kind: "question", objectId: question.id };
      return question;
    });
  }

  async updateQuestion(question: PageQuestion, expectedRevision: number, context: IdempotentWriteContext): Promise<PageQuestion> {
    return this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) return state.questions.find((item) => item.id === replay.objectId) ?? question;
      const index = state.questions.findIndex((item) => item.id === question.id);
      if (index < 0) throw new Error("READWEAVE_QUESTION_NOT_FOUND");
      if (state.questions[index]!.revision !== expectedRevision) throw new Error("READWEAVE_QUESTION_REVISION_CONFLICT");
      const saved = structuredClone({ ...question, revision: expectedRevision + 1, updatedAt: new Date().toISOString() });
      state.questions[index] = saved;
      state.idempotency[context.idempotencyKey] = { kind: "question", objectId: saved.id };
      return saved;
    });
  }

  async listQuestions(pageId?: string): Promise<PageQuestion[]> {
    const questions = (await this.read()).questions;
    return pageId ? questions.filter((item) => item.pageId === pageId) : questions;
  }

  async listQuestionAttempts(pageId?: string): Promise<QuestionAttempt[]> {
    const attempts = (await this.read()).questionAttempts;
    return pageId ? attempts.filter((item) => item.pageId === pageId) : attempts;
  }

  async saveQuestionSelection(selection: QuestionSelection, context: IdempotentWriteContext): Promise<QuestionSelection> {
    return this.appendAuthorityObject("questionSelection", selection, context, "questionSelections");
  }

  async saveQuestionAttempt(attempt: QuestionAttempt, context: IdempotentWriteContext): Promise<QuestionAttempt> {
    return this.appendAuthorityObject("questionAttempt", attempt, context, "questionAttempts");
  }

  async getReviewPlan(planId: string): Promise<ReviewPlan | undefined> {
    return (await this.read()).reviewPlans.find((item) => item.id === planId);
  }

  async saveReviewPlan(plan: ReviewPlan, context: IdempotentWriteContext): Promise<ReviewPlan> {
    return this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) {
        const existing = state.reviewPlans.find((item) => item.id === replay.objectId);
        if (!existing) throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
        return structuredClone(existing);
      }
      if (state.reviewPlans.some((item) => item.id === plan.id)) throw new Error("READWEAVE_REVIEW_PLAN_EXISTS");
      state.reviewPlans.push(structuredClone(plan));
      state.idempotency[context.idempotencyKey] = { kind: "review_plan", objectId: plan.id };
      return structuredClone(plan);
    });
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
      state.reviewPlans[index] = saved;
      state.idempotency[context.idempotencyKey] = { kind: "review_plan", objectId: saved.id };
      return saved;
    });
  }

  async appendCostEntry(entry: GenerationCostEntry, context: IdempotentWriteContext): Promise<GenerationCostEntry> {
    return this.appendAuthorityObject("costEntry", entry, context, "costEntries");
  }

  async listCostEntries(filters: { courseId?: string; materialVersionId?: string; pageId?: string; jobId?: string } = {}): Promise<GenerationCostEntry[]> {
    return (await this.read()).costEntries.filter((item) =>
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
    });
  }

  async listMastery(): Promise<MasteryRecord[]> {
    return (await this.read()).mastery;
  }

  async listAssessmentAttempts(objectiveId?: string): Promise<AssessmentAttempt[]> {
    const attempts = (await this.read()).attempts;
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
    });
  }

  async searchResearch(query: string): Promise<Array<{ archiveId: string; title: string; snippets: string[] }>> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return (await this.read()).researchArchives.flatMap((archive) => {
      const lines = archive.content.split(/\r?\n/);
      const snippets = lines.filter((line) => line.toLowerCase().includes(needle)).slice(0, 8);
      return snippets.length ? [{ archiveId: archive.id, title: archive.title, snippets }] : [];
    });
  }

  async listDrafts(): Promise<LessonDraft[]> {
    return (await this.read()).drafts;
  }

  async getDraftByPage(pageId: string): Promise<LessonDraft | undefined> {
    return (await this.read()).drafts.find((draft) => draft.pageId === pageId);
  }

  async saveDraft(draft: LessonDraft, expectedRevision: number, context: IdempotentWriteContext, _sourceAsset?: DraftSourceAsset): Promise<LessonDraft> {
    const result = await this.mutate(async (state): Promise<{ saved?: LessonDraft; conflict?: CourseConflict }> => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) {
        const existing = state.drafts.find((item) => item.id === replay.objectId);
        if (!existing) throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
        return { saved: existing };
      }
      const index = state.drafts.findIndex((item) => item.pageId === draft.pageId);
      const current = index >= 0 ? state.drafts[index] : undefined;
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== expectedRevision) {
        const conflict: CourseConflict = {
          id: `conflict:${draft.pageId}:${Date.now()}`,
          workspaceId: draft.workspaceId,
          objectId: draft.pageId,
          objectType: "lesson_draft",
          baseRevision: expectedRevision,
          localRevision: draft.revision,
          remoteRevision: currentRevision,
          baseContent: "",
          localContent: JSON.stringify(draft.page),
          remoteContent: JSON.stringify(current?.page ?? {}),
          status: "open",
          createdAt: new Date().toISOString()
        };
        state.conflicts.push(conflict);
        return { conflict };
      }
      const saved = structuredClone({ ...draft, revision: currentRevision + 1 });
      if (index >= 0) state.drafts[index] = saved;
      else state.drafts.push(saved);
      state.idempotency[context.idempotencyKey] = { kind: "draft", objectId: saved.id };
      return { saved };
    });
    if (result.conflict) throw new Error(`READWEAVE_REVISION_CONFLICT:${result.conflict.id}`);
    if (!result.saved) throw new Error("READWEAVE_DRAFT_SAVE_FAILED");
    return result.saved;
  }

  async listConflicts(): Promise<CourseConflict[]> {
    return (await this.read()).conflicts;
  }

  async resolveConflict(conflictId: string, resolution: "local" | "remote" | "merged", mergedContent: string | undefined, context: IdempotentWriteContext): Promise<CourseConflict> {
    return this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      if (replay) {
        const existing = state.conflicts.find((item) => item.id === replay.objectId);
        if (!existing) throw new Error("READWEAVE_IDEMPOTENCY_CORRUPT");
        return existing;
      }
      const conflict = state.conflicts.find((item) => item.id === conflictId);
      if (!conflict) throw new Error("READWEAVE_CONFLICT_NOT_FOUND");
      conflict.status = "resolved";
      conflict.resolution = resolution;
      conflict.resolvedAt = new Date().toISOString();
      if (resolution === "merged" && !mergedContent?.trim()) throw new Error("READWEAVE_MERGED_CONTENT_REQUIRED");
      const draft = state.drafts.find((item) => item.pageId === conflict.objectId);
      if (draft) {
        const selectedContent = resolution === "local" ? conflict.localContent : resolution === "remote" ? conflict.remoteContent : mergedContent!;
        try {
          draft.page = JSON.parse(selectedContent);
          draft.revision = Math.max(conflict.localRevision, conflict.remoteRevision) + 1;
          draft.status = "editing";
          draft.contentHash = createHash("sha256").update(selectedContent).digest("hex");
          draft.updatedAt = conflict.resolvedAt;
        } catch {
          throw new Error("READWEAVE_CONFLICT_CONTENT_INVALID");
        }
      }
      state.idempotency[context.idempotencyKey] = { kind: "conflict", objectId: conflict.id };
      return conflict;
    });
  }

  async getSyncStatus(): Promise<ReadWeaveSyncStatus> {
    const state = await this.read();
    const lastWriteAt = [...state.drafts.map((item) => item.updatedAt), ...state.releases.map((item) => item.publishedAt)].sort().at(-1);
    return {
      state: "connected",
      authority: "readweave",
      mode: "file",
      pendingWrites: 0,
      conflicts: state.conflicts.filter((item) => item.status === "open").length,
      lastReadAt: new Date().toISOString(),
      lastWriteAt,
      message: "ReadWeave 本地权威存储已连接"
    };
  }

  private async read(): Promise<ReadWeaveFileState> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<ReadWeaveFileState>;
      return {
        ...structuredClone(EMPTY_STATE),
        ...parsed,
        courses: parsed.courses ?? [],
        drafts: parsed.drafts ?? [],
      conflicts: parsed.conflicts ?? [],
        treeNodes: parsed.treeNodes ?? [],
        trash: parsed.trash ?? [],
        modelProviders: parsed.modelProviders ?? [],
        questionSelections: parsed.questionSelections ?? [],
        questionAttempts: parsed.questionAttempts ?? [],
        costEntries: parsed.costEntries ?? []
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_STATE);
      throw error;
    }
  }

  private async mutate<T>(change: (state: ReadWeaveFileState) => Promise<T>): Promise<T> {
    let result!: T;
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      const state = await this.read();
      result = await change(state);
      await writeJsonAtomic(this.statePath, state);
    });
    await this.writeChain;
    return result;
  }

  private async appendAuthorityObject<T extends { id: string }>(kind: string, value: T, context: IdempotentWriteContext, key: "questionSelections" | "questionAttempts" | "costEntries"): Promise<T> {
    return this.mutate(async (state) => {
      const replay = state.idempotency[context.idempotencyKey];
      const target = state[key] as unknown as T[];
      if (replay) return target.find((item) => item.id === replay.objectId) ?? value;
      target.push(structuredClone(value));
      state.idempotency[context.idempotencyKey] = { kind, objectId: value.id };
      return value;
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
    const visible = (await this.listTreeNodes()).find((candidate) => candidate.id === nodeId);
    const node = visible ?? (await this.read()).treeNodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.title !== expected.title || node.parentId !== expected.parentId || (expected.revision !== undefined && node.revision !== expected.revision)) throw new Error("READWEAVE_TREE_READBACK_FAILED");
    if (expected.readweaveNoteId && node.readweaveNoteId !== expected.readweaveNoteId) throw new Error("READWEAVE_TREE_IDENTITY_READBACK_FAILED");
    return node;
  }
}

function isVirtualTreeParent(state: ReadWeaveFileState, parentId: string): boolean {
  const match = /^material:([^:]+):current$/.exec(parentId);
  return Boolean(match && state.courses.some((course) => course.id === match[1]));
}

function ensureCourseForTreeMutation(state: ReadWeaveFileState, nodeId: string): CourseProject | undefined {
  const existing = state.courses.find((item) => item.id === nodeId);
  if (existing) return existing;
  const release = state.releases.find((item) => item.courseId === nodeId);
  if (!release) return undefined;
  const merged = mergeReleaseCourses([], [release]).find((item) => item.id === nodeId);
  if (!merged) return undefined;
  merged.readweaveNoteId = merged.readweaveNoteId ?? fileCourseNoteId(merged.id);
  state.courses.push(merged);
  return merged;
}

function ensureMaterialForTreeMutation(state: ReadWeaveFileState, nodeId: string): CourseTreeNode | undefined {
  const persisted = state.treeNodes.find((item) => item.kind === "material" && (item.id === nodeId || item.materialId === nodeId));
  if (persisted) {
    if (persisted.id === nodeId) return persisted;
    const stable = structuredClone({ ...persisted, id: nodeId, materialId: nodeId });
    state.treeNodes = state.treeNodes.filter((item) => item.id !== persisted.id);
    state.treeNodes.push(stable);
    return stable;
  }
  if (!isStableMaterialId(nodeId, state.releases)) return undefined;
  const group = materialGroups(state.releases).find((item) => stableMaterialId(item.courseId, item.moduleId) === nodeId);
  if (!group) return undefined;
  let course = state.courses.find((item) => item.id === group.courseId);
  if (!course) {
    course = mergeReleaseCourses([], state.releases).find((item) => item.id === group.courseId);
    if (course) state.courses.push(course);
  }
  if (!course) return undefined;
  const material = { ...materialTreeNode(course, group), readweaveNoteId: fileMaterialNoteId(nodeId) };
  state.treeNodes.push(material);
  return material;
}

function treePath(state: ReadWeaveFileState, nodeId: string): string[] {
  const courses = mergeReleaseCourses(state.courses, state.releases);
  const byId = new Map<string, CourseTreeNode>();
  for (const course of courses) byId.set(course.id, courseTreeNode(course));
  for (const node of state.treeNodes) byId.set(node.id, node);
  const path: string[] = [];
  let current = byId.get(nodeId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current.title);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

function fileCourseNoteId(courseId: string): string { return `file-readweave:course:${courseId}`; }
function fileMaterialNoteId(materialId: string): string { return `file-readweave:material:${materialId}`; }

export { EtapiReadWeaveCourseApi, type EtapiReadWeaveConfig } from "./etapi.js";

export class HttpReadWeaveCourseApi implements ReadWeaveCourseApi {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly baseUrl: string, private readonly token: string, fetchImpl: typeof fetch = fetch, private readonly publicUrl = "https://readweave.example.com") {
    this.fetchImpl = fetchImpl;
  }

  async listCourses(): Promise<CourseProject[]> {
    return this.request<CourseProject[]>("/courses");
  }

  async createCourse(course: CourseProject, context: IdempotentWriteContext): Promise<CourseProject> {
    const saved = await this.request<CourseProject>("/courses", { method: "POST", body: JSON.stringify(course), headers: this.writeHeaders(context) });
    const readBack = (await this.listCourses()).find((candidate) => candidate.id === saved.id);
    if (!readBack || readBack.title !== saved.title || readBack.workspaceId !== saved.workspaceId) throw new Error("READWEAVE_TREE_READBACK_FAILED");
    return readBack;
  }

  async registerDraftSource(release: CourseRelease, context: IdempotentWriteContext): Promise<CourseRelease> {
    return this.request<CourseRelease>("/draft-sources", { method: "POST", body: JSON.stringify(release), headers: this.writeHeaders(context) });
  }

  async removeDraftSource(releaseId: string, context: IdempotentWriteContext): Promise<void> {
    await this.request(`/draft-sources/${encodeURIComponent(releaseId)}`, { method: "DELETE", headers: this.writeHeaders(context) });
  }

  async listReleases(courseId?: string): Promise<CourseRelease[]> {
    const query = courseId ? `?course_id=${encodeURIComponent(courseId)}` : "";
    return this.request<CourseRelease[]>(`/releases${query}`);
  }

  async getRelease(releaseId: string): Promise<CourseRelease | undefined> {
    const response = await this.fetchWithRetry(`${this.baseUrl}/releases/${encodeURIComponent(releaseId)}`, { headers: this.headers() });
    if (response.status === 404) return undefined;
    return this.decode<CourseRelease>(response);
  }

  async getManifest(releaseId: string): Promise<ReleaseManifest | undefined> {
    const response = await this.fetchWithRetry(`${this.baseUrl}/releases/${encodeURIComponent(releaseId)}/manifest`, { headers: this.headers() });
    if (response.status === 404) return undefined;
    return this.decode<ReleaseManifest>(response);
  }

  async publishRelease(release: CourseRelease, manifest: ReleaseManifest, context: IdempotentWriteContext): Promise<CourseRelease> {
    return this.request<CourseRelease>("/releases", { method: "POST", body: JSON.stringify({ release, manifest }), headers: this.writeHeaders(context) });
  }

  async saveQuestion(question: PageQuestion, context: IdempotentWriteContext): Promise<PageQuestion> {
    return this.request<PageQuestion>("/questions", { method: "POST", body: JSON.stringify(question), headers: this.writeHeaders(context) });
  }

  async updateQuestion(question: PageQuestion, expectedRevision: number, context: IdempotentWriteContext): Promise<PageQuestion> {
    return this.request<PageQuestion>(`/questions/${encodeURIComponent(question.id)}`, { method: "PATCH", body: JSON.stringify({ question, expectedRevision }), headers: this.writeHeaders(context) });
  }

  async listQuestions(pageId?: string): Promise<PageQuestion[]> {
    return this.request<PageQuestion[]>(`/questions${pageId ? `?page_id=${encodeURIComponent(pageId)}` : ""}`);
  }

  async listQuestionAttempts(pageId?: string): Promise<QuestionAttempt[]> {
    return this.request<QuestionAttempt[]>(`/question-attempts${pageId ? `?page_id=${encodeURIComponent(pageId)}` : ""}`);
  }

  async saveQuestionSelection(selection: QuestionSelection, context: IdempotentWriteContext): Promise<QuestionSelection> {
    return this.request<QuestionSelection>("/question-selections", { method: "POST", body: JSON.stringify(selection), headers: this.writeHeaders(context) });
  }

  async saveQuestionAttempt(attempt: QuestionAttempt, context: IdempotentWriteContext): Promise<QuestionAttempt> {
    return this.request<QuestionAttempt>("/question-attempts", { method: "POST", body: JSON.stringify(attempt), headers: this.writeHeaders(context) });
  }

  async getReviewPlan(planId: string): Promise<ReviewPlan | undefined> {
    const response = await this.fetchWithRetry(`${this.baseUrl}/review-plans/${encodeURIComponent(planId)}`, { headers: this.headers() });
    if (response.status === 404) return undefined;
    return this.decode<ReviewPlan>(response);
  }

  async saveReviewPlan(plan: ReviewPlan, context: IdempotentWriteContext): Promise<ReviewPlan> {
    return this.request<ReviewPlan>("/review-plans", { method: "POST", body: JSON.stringify(plan), headers: this.writeHeaders(context) });
  }

  async updateReviewPlan(plan: ReviewPlan, expectedRevision: number, context: IdempotentWriteContext): Promise<ReviewPlan> {
    return this.request<ReviewPlan>(`/review-plans/${encodeURIComponent(plan.id)}`, { method: "PATCH", body: JSON.stringify({ plan, expectedRevision }), headers: this.writeHeaders(context) });
  }

  async appendCostEntry(entry: GenerationCostEntry, context: IdempotentWriteContext): Promise<GenerationCostEntry> {
    return this.request<GenerationCostEntry>("/cost-entries", { method: "POST", body: JSON.stringify(entry), headers: this.writeHeaders(context) });
  }

  async listCostEntries(filters: { courseId?: string; materialVersionId?: string; pageId?: string; jobId?: string } = {}): Promise<GenerationCostEntry[]> {
    const query = new URLSearchParams();
    if (filters.courseId) query.set("course_id", filters.courseId);
    if (filters.materialVersionId) query.set("material_version_id", filters.materialVersionId);
    if (filters.pageId) query.set("page_id", filters.pageId);
    if (filters.jobId) query.set("job_id", filters.jobId);
    return this.request<GenerationCostEntry[]>(`/cost-entries${query.size ? `?${query}` : ""}`);
  }

  async saveAttempt(attempt: AssessmentAttempt, mastery: MasteryRecord, context: IdempotentWriteContext): Promise<AssessmentAttempt> {
    return this.request<AssessmentAttempt>("/assessment-attempts", { method: "POST", body: JSON.stringify({ attempt, mastery }), headers: this.writeHeaders(context) });
  }

  async listMastery(): Promise<MasteryRecord[]> {
    return this.request<MasteryRecord[]>("/mastery");
  }

  async listAssessmentAttempts(objectiveId?: string): Promise<AssessmentAttempt[]> {
    return this.request<AssessmentAttempt[]>(`/assessment-attempts${objectiveId ? `?objective_id=${encodeURIComponent(objectiveId)}` : ""}`);
  }

  async archiveResearch(archive: ResearchArchive, context: IdempotentWriteContext): Promise<ResearchArchive> {
    return this.request<ResearchArchive>("/research-archives", { method: "POST", body: JSON.stringify(archive), headers: this.writeHeaders(context) });
  }

  async searchResearch(query: string): Promise<Array<{ archiveId: string; title: string; snippets: string[] }>> {
    return this.request(`/research-archives/search?q=${encodeURIComponent(query)}`);
  }

  async listDrafts(): Promise<LessonDraft[]> {
    return this.request<LessonDraft[]>("/drafts");
  }

  async getDraftByPage(pageId: string): Promise<LessonDraft | undefined> {
    const response = await this.fetchWithRetry(`${this.baseUrl}/drafts/by-page/${encodeURIComponent(pageId)}`, { headers: this.headers() });
    if (response.status === 404) return undefined;
    return this.decode<LessonDraft>(response);
  }

  async saveDraft(draft: LessonDraft, expectedRevision: number, context: IdempotentWriteContext, _sourceAsset?: DraftSourceAsset): Promise<LessonDraft> {
    return this.request<LessonDraft>("/drafts", {
      method: "POST",
      body: JSON.stringify({ draft, expectedRevision }),
      headers: this.writeHeaders(context)
    });
  }

  async listConflicts(): Promise<CourseConflict[]> {
    return this.request<CourseConflict[]>("/conflicts");
  }

  async resolveConflict(conflictId: string, resolution: "local" | "remote" | "merged", mergedContent: string | undefined, context: IdempotentWriteContext): Promise<CourseConflict> {
    return this.request<CourseConflict>(`/conflicts/${encodeURIComponent(conflictId)}:resolve`, {
      method: "POST",
      body: JSON.stringify({ resolution, mergedContent }),
      headers: this.writeHeaders(context)
    });
  }

  async getSyncStatus(): Promise<ReadWeaveSyncStatus> {
    try {
      return await this.request<ReadWeaveSyncStatus>("/sync/status");
    } catch {
      return {
        state: "offline",
        authority: "readweave",
        mode: "http",
        pendingWrites: 0,
        conflicts: 0,
        message: "ReadWeave 暂时不可访问，请稍后重试"
      };
    }
  }

  async listTreeNodes(): Promise<CourseTreeNode[]> {
    return this.request<CourseTreeNode[]>("/tree/nodes");
  }

  async createTreeNode(node: CourseTreeNode, context: IdempotentWriteContext): Promise<CourseTreeNode> {
    const saved = await this.request<CourseTreeNode>("/tree/nodes", { method: "POST", body: JSON.stringify({ node }), headers: this.writeHeaders(context) });
    return this.readBackTreeNode(saved.id, saved);
  }

  async updateTreeNode(nodeId: string, patch: { title?: string; parentId?: string | null; archived?: boolean; sortOrder?: number }, expectedRevision: number, context: IdempotentWriteContext): Promise<CourseTreeNode> {
    const saved = await this.request<CourseTreeNode>(`/tree/nodes/${encodeURIComponent(nodeId)}`, { method: "PATCH", body: JSON.stringify({ patch, expectedRevision }), headers: this.writeHeaders(context) });
    return this.readBackTreeNode(saved.id, saved);
  }

  async duplicateTreeNode(nodeId: string, context: IdempotentWriteContext): Promise<CourseTreeNode> {
    const saved = await this.request<CourseTreeNode>(`/tree/nodes/${encodeURIComponent(nodeId)}:duplicate`, { method: "POST", headers: this.writeHeaders(context) });
    return this.readBackTreeNode(saved.id, saved);
  }

  async trashTreeNode(nodeId: string, context: IdempotentWriteContext): Promise<TrashRecord> {
    const saved = await this.request<TrashRecord>(`/tree/nodes/${encodeURIComponent(nodeId)}:trash`, { method: "POST", headers: this.writeHeaders(context) });
    const readBack = (await this.listTrash()).find((item) => item.id === saved.id);
    if (!readBack || readBack.nodeId !== saved.nodeId || readBack.snapshotHash !== saved.snapshotHash) throw new Error("READWEAVE_TREE_READBACK_FAILED");
    return readBack;
  }

  async listTrash(): Promise<TrashRecord[]> {
    return this.request<TrashRecord[]>("/trash");
  }

  async restoreTrash(trashId: string, context: IdempotentWriteContext, options: { restoreMode?: "original" | "root" } = {}): Promise<CourseTreeNode> {
    const saved = await this.request<CourseTreeNode>(`/trash/${encodeURIComponent(trashId)}:restore`, { method: "POST", body: JSON.stringify({ restoreMode: options.restoreMode ?? "original" }), headers: this.writeHeaders(context) });
    return this.readBackTreeNode(saved.id, saved);
  }

  async permanentlyDeleteTrash(trashId: string, context: IdempotentWriteContext): Promise<void> {
    await this.request<unknown>(`/trash/${encodeURIComponent(trashId)}`, { method: "DELETE", headers: this.writeHeaders(context) });
  }

  async getTreeNodeProperties(nodeId: string): Promise<TreeNodeProperties | undefined> {
    const response = await this.fetchWithRetry(`${this.baseUrl}/tree/nodes/${encodeURIComponent(nodeId)}/properties`, { headers: this.headers() });
    if (response.status === 404) return undefined;
    return this.decode<TreeNodeProperties>(response);
  }

  async getDeepLink(noteId: string): Promise<ReadWeaveDeepLink | undefined> {
    const response = await this.fetchWithRetry(`${this.baseUrl}/deep-links/${encodeURIComponent(noteId)}`, { headers: this.headers() });
    if (response.status === 404) return undefined;
    return normalizeTrustedDeepLink(await this.decode<ReadWeaveDeepLink>(response), noteId, this.publicUrl);
  }

  async getWorkspaceSettings(): Promise<WorkspaceSettings> {
    return this.request<WorkspaceSettings>("/settings");
  }

  async saveWorkspaceSettings(settings: WorkspaceSettings, context: IdempotentWriteContext): Promise<WorkspaceSettings> {
    return this.request<WorkspaceSettings>("/settings", { method: "PATCH", body: JSON.stringify(settings), headers: this.writeHeaders(context) });
  }

  async listModelProviders(): Promise<ModelProviderConfig[]> {
    return this.request<ModelProviderConfig[]>("/model-providers");
  }

  async updateModelProvider(providerId: string, patch: { baseUrl?: string; enabled?: boolean }, context: IdempotentWriteContext): Promise<ModelProviderConfig> {
    return this.request<ModelProviderConfig>(`/model-providers/${encodeURIComponent(providerId)}`, { method: "PATCH", body: JSON.stringify(patch), headers: this.writeHeaders(context) });
  }

  async saveModelProviderCredential(providerId: string, credential: CredentialStatus, context: IdempotentWriteContext): Promise<Pick<ModelProviderConfig, "id" | "credential">> {
    return this.request<Pick<ModelProviderConfig, "id" | "credential">>(`/model-providers/${encodeURIComponent(providerId)}/credential`, { method: "PUT", body: JSON.stringify({ credential }), headers: this.writeHeaders(context) });
  }

  async testModelProvider(providerId: string): Promise<ModelProviderConfig> {
    return this.request<ModelProviderConfig>(`/model-providers/${encodeURIComponent(providerId)}:test`, { method: "POST", headers: this.headers() });
  }

  async getModelRoutePolicy(): Promise<ModelRoutePolicy> {
    return this.request<ModelRoutePolicy>("/model-route-policy");
  }

  async saveModelRoutePolicy(policy: ModelRoutePolicy, context: IdempotentWriteContext): Promise<ModelRoutePolicy> {
    return this.request<ModelRoutePolicy>("/model-route-policy", { method: "PUT", body: JSON.stringify(policy), headers: this.writeHeaders(context) });
  }

  private headers(): Record<string, string> {
    return { Accept: "application/json", Authorization: `Bearer ${this.token}` };
  }

  private writeHeaders(context: IdempotentWriteContext): Record<string, string> {
    return {
      ...this.headers(),
      "Content-Type": "application/json",
      "Idempotency-Key": context.idempotencyKey,
      "X-Actor": context.actor,
      "X-Workspace-Id": context.workspaceId,
      "X-Schema-Version": context.schemaVersion,
      "X-Request-Id": context.requestId
    };
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchWithRetry(`${this.baseUrl}${path}`, { ...init, headers: init?.headers ?? this.headers() });
    return this.decode<T>(response);
  }

  private async readBackTreeNode(nodeId: string, expected: CourseTreeNode): Promise<CourseTreeNode> {
    const node = (await this.listTreeNodes()).find((candidate) => candidate.id === nodeId);
    if (!node || node.title !== expected.title || node.parentId !== expected.parentId || (expected.revision !== undefined && node.revision !== expected.revision)) throw new Error("READWEAVE_TREE_READBACK_FAILED");
    if (expected.readweaveNoteId && node.readweaveNoteId !== expected.readweaveNoteId) throw new Error("READWEAVE_TREE_IDENTITY_READBACK_FAILED");
    return node;
  }

  private async fetchWithRetry(input: string, init?: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.fetchImpl(input, init);
        if (!shouldRetryHttpStatus(response.status) || attempt === 2) return response;
        await delayForRetry(attempt);
        continue;
      } catch (error) {
        lastError = error;
        if (attempt === 2) throw new Error(`READWEAVE_HTTP_NETWORK:${error instanceof Error ? error.message : "REQUEST_FAILED"}`);
        await delayForRetry(attempt);
      }
    }
    throw new Error(`READWEAVE_HTTP_NETWORK:${lastError instanceof Error ? lastError.message : "REQUEST_FAILED"}`);
  }

  private async decode<T>(response: Response): Promise<T> {
    if (!response.ok) throw new Error(`READWEAVE_HTTP_${response.status}:${await response.text()}`);
    return response.json() as Promise<T>;
  }
}

function shouldRetryHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function delayForRetry(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
}

function normalizeTrustedDeepLink(link: ReadWeaveDeepLink, requestedNoteId: string, publicUrl: string): ReadWeaveDeepLink | undefined {
  const trusted = trustedPublicBase(publicUrl);
  if (link.noteId !== requestedNoteId || link.host !== trusted.hostname || !link.verified) return undefined;
  try {
    const parsed = new URL(link.url);
    if (parsed.protocol !== "https:" || parsed.hostname !== trusted.hostname) return undefined;
  } catch {
    return undefined;
  }
  return {
    ...link,
    host: trusted.hostname,
    url: `${trusted.origin}/#root/${encodeURIComponent(requestedNoteId)}`,
    verified: true,
    verifiedAt: link.verifiedAt || new Date().toISOString()
  };
}

function trustedPublicBase(publicUrl: string): URL {
  const parsed = new URL(publicUrl);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("READWEAVE_PUBLIC_URL_INVALID");
  return parsed;
}

function mergeReleaseCourses(courses: CourseProject[], releases: CourseRelease[]): CourseProject[] {
  const merged = new Map(courses.map((course) => [course.id, structuredClone(course)]));
  for (const release of releases) {
    if (merged.has(release.courseId)) continue;
    merged.set(release.courseId, {
      id: release.courseId,
      workspaceId: "personal",
      title: release.courseTitle,
      status: "active",
      createdAt: release.publishedAt,
      updatedAt: release.publishedAt
    });
  }
  return [...merged.values()];
}
