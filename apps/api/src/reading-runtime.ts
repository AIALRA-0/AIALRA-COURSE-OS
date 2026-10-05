import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CourseConflict, CourseProject, CourseRelease, LessonDraft, ReadWeaveSyncStatus, TrashRecord, WorkspaceTree, CourseTreeNode } from "@course-os/contracts";
import type { ReadWeaveCourseApi } from "@course-os/readweave-adapter";
import { selectMaterialRelease, withReadBudget, withIndependentReadBudget, type CourseReleaseIndex } from "@course-os/readweave-adapter";
import { writeJsonAtomic } from "@course-os/storage";
import {
  ReadingReplica,
  readingProjectionInvalidationId,
  type ReadingMaterialReleaseSelection,
  type ReadingMaterialReleaseSelectionUpsert,
  type ReadingProjectionInvalidation
} from "./reading-replica.js";

type TreeBuilder = (courses: CourseProject[], nodes: CourseTreeNode[], trash: TrashRecord[], workspaceId: string) => WorkspaceTree;

function materialReleaseSelectionHints(nodes: CourseTreeNode[], workspaceId: string): ReadingMaterialReleaseSelectionUpsert[] {
  return nodes.flatMap((node) => {
    if (node.kind !== "material") return [];
    const hint = node.currentReleaseSelection;
    const releaseId = node.currentReleaseId ?? node.releaseId;
    if (!hint || !releaseId) return [];
    return [{ workspaceId, materialId: node.materialId ?? node.id, selection: { releaseId, source: hint } }];
  });
}

/** Remote authority is used for confirmation, never as a fallback for a reader. */
export class ReadingRuntime {
  readonly replica: ReadingReplica;
  private timer?: ReturnType<typeof setInterval>;
  private refreshInFlight?: Promise<void>;
  private refreshController?: AbortController;
  private closed = false;
  private legacyProjectionInvalid = false;
  private accessDenied = false;
  private sync: ReadWeaveSyncStatus = { state: "degraded", authority: "readweave", mode: "etapi", pendingWrites: 0, conflicts: 0, message: "阅读副本尚未确认同步状态" };
  private cursor = 0;
  private readonly deniedPath: string;
  private readonly invalidPath: string;

  constructor(readonly root: string, readonly authority: ReadWeaveCourseApi, readonly workspaceId: string,
    identity: string, private readonly buildTree: TreeBuilder) {
    this.replica = new ReadingReplica(root, identity);
    this.deniedPath = join(root, "access-denied.json");
    this.invalidPath = join(root, "confirmation-required.json");
  }

  async initialize(): Promise<void> {
    await this.replica.initialize();
    try { await readFile(this.deniedPath); this.accessDenied = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await readFile(this.invalidPath); this.legacyProjectionInvalid = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  assertAccess(): void {
    if (this.accessDenied) throw new Error("READING_ACCESS_DENIED");
  }

  status() {
    const local = this.replica.status();
    const blockedObjects = this.replica.projectionInvalidations(this.workspaceId).length;
    return { ...local, ready: local.ready && !this.accessDenied && !this.legacyProjectionInvalid, synchronization: this.sync.state,
      message: blockedObjects ? "部分对象等待来源修订确认；其他已确认内容可继续阅读" : this.sync.message,
      accessDenied: this.accessDenied, blockedObjects };
  }

  syncStatus(): ReadWeaveSyncStatus {
    const blockedObjects = this.replica.projectionInvalidations(this.workspaceId).length;
    return { ...this.sync, lastReadAt: this.replica.status().lastConfirmedAt,
      message: this.accessDenied ? "来源访问权限失效，阅读已停止"
        : blockedObjects ? "部分对象等待来源修订确认；其他已确认内容可继续阅读" : this.sync.message };
  }

  start(): void {
    this.closed = false;
    // Existing confirmed data is ready immediately; refresh has its own owner.
    this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, 60_000);
    this.timer.unref();
    if (this.replica.status().ready) void this.refresh().catch(() => undefined);
  }

  close(): void { this.closed = true; if (this.timer) clearInterval(this.timer); this.refreshController?.abort(); }

  private async unavailable(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "READWEAVE_REFRESH_FAILED";
    this.sync = { ...this.sync, state: "degraded", message: "已确认课件仍可阅读，来源同步暂时不可用" };
    if (/READWEAVE_(?:ETAPI|HTTP)_(?:401|403)(?::|$)/u.test(message)) {
      this.accessDenied = true;
      await writeJsonAtomic(this.deniedPath, { deniedAt: new Date().toISOString() });
    }
  }

  private async readDraftSnapshot(pageId: string): Promise<LessonDraft | undefined> {
    return this.authority.getDraftSnapshotByPage
      ? this.authority.getDraftSnapshotByPage(pageId)
      : this.authority.getDraftByPage(pageId);
  }

  private confirmsTreeRevision(
    invalidation: ReadingProjectionInvalidation,
    courses: CourseProject[],
    nodes: CourseTreeNode[]
  ): boolean {
    if (invalidation.reason !== "tree" || invalidation.revision === undefined) return false;
    const course = invalidation.targetKind === "course"
      ? courses.find((item) => item.workspaceId === invalidation.workspaceId && item.id === invalidation.targetId)
      : undefined;
    const node = nodes.find((item) => item.id === invalidation.targetId
      || (item.kind === "material" && item.materialId === invalidation.targetId));
    const revision = node?.revision ?? course?.revision;
    if (invalidation.rejected) {
      return revision !== undefined && (invalidation.previousRevision === undefined || revision >= invalidation.previousRevision);
    }
    if (revision === undefined || revision < invalidation.revision) return false;
    if (revision > invalidation.revision) return true;
    if (invalidation.expectedArchived !== undefined) {
      const archived = node?.archived ?? course?.status === "archived";
      if (archived !== invalidation.expectedArchived) return false;
    }
    if (invalidation.expectedCurrentReleaseId !== undefined
      && node?.currentReleaseId !== invalidation.expectedCurrentReleaseId) return false;
    return true;
  }

  private confirmMetadataInvalidations(
    invalidations: ReadingProjectionInvalidation[],
    courses: CourseProject[],
    indexes: CourseReleaseIndex[],
    nodes: CourseTreeNode[],
    trash: TrashRecord[]
  ): string[] {
    return invalidations.filter((item) => {
      if (item.rejected) return this.confirmsRejectedMetadata(item, courses, indexes, nodes, trash);
      if (item.reason === "tree") return this.confirmsTreeRevision(item, courses, nodes);
      if (item.reason === "trashed") {
        return trash.some((record) => record.workspaceId === item.workspaceId && record.nodeId === item.targetId
          && (!item.trashId || record.id === item.trashId) && (!item.deletedAt || record.deletedAt === item.deletedAt));
      }
      if (item.reason === "restored") {
        const record = trash.find((candidate) => candidate.workspaceId === item.workspaceId
          && candidate.nodeId === item.targetId && (!item.trashId || candidate.id === item.trashId));
        const node = nodes.find((candidate) => candidate.id === item.targetId
          || (candidate.kind === "material" && candidate.materialId === item.targetId));
        return Boolean(record && !record.restoreAvailable && node
          && (item.revision === undefined || (node.revision ?? 0) >= item.revision));
      }
      if (item.reason === "release-removed") {
        const current = indexes.find((index) => index.id === item.targetId);
        return !current;
      }
      if (item.reason === "permanent-delete") {
        return !trash.some((record) => record.id === item.trashId)
          && !this.targetPresent(item, courses, indexes, nodes);
      }
      return false;
    }).map((item) => item.id);
  }

  private confirmsRejectedMetadata(
    invalidation: ReadingProjectionInvalidation,
    courses: CourseProject[],
    indexes: CourseReleaseIndex[],
    nodes: CourseTreeNode[],
    trash: TrashRecord[]
  ): boolean {
    const trashRecord = trash.find((record) => record.workspaceId === invalidation.workspaceId
      && (record.id === invalidation.trashId || record.nodeId === invalidation.targetId));
    const node = nodes.find((item) => item.id === invalidation.targetId
      || (item.kind === "material" && item.materialId === invalidation.targetId));
    const course = courses.find((item) => item.workspaceId === invalidation.workspaceId && item.id === invalidation.targetId);
    const index = indexes.find((item) => item.id === invalidation.targetId);
    const revision = node?.revision ?? course?.revision ?? index?.version;
    const meetsBaseline = invalidation.previousRevision === undefined
      || revision !== undefined && revision >= invalidation.previousRevision;
    const present = this.targetPresent(invalidation, courses, indexes, nodes);

    switch (invalidation.reason) {
      case "tree":
        return !present || Boolean(node || course) && meetsBaseline;
      case "trashed":
        return Boolean(trashRecord) || !present || meetsBaseline;
      case "restored":
        return Boolean(trashRecord?.restoreAvailable) || !present || meetsBaseline;
      case "release-removed":
        return !index || meetsBaseline;
      case "permanent-delete":
        return Boolean(trashRecord) || !present || meetsBaseline;
      case "draft":
        return false;
    }
  }

  private confirmMaterializedInvalidations(
    invalidations: ReadingProjectionInvalidation[],
    courses: CourseProject[],
    releases: CourseRelease[],
    drafts: LessonDraft[],
    nodes: CourseTreeNode[],
    trash: TrashRecord[]
  ): string[] {
    const indexes: CourseReleaseIndex[] = releases.map((release) => ({
      ...release,
      assessments: [],
      pages: release.pages.map((page) => ({
        id: page.id, pageNumber: page.pageNumber, title: page.title, imageUrl: page.imageUrl,
        quality: page.quality, anchors: [], atoms: [], blocks: [], lessonSections: [], questionBank: [],
        coverageRequirements: [], coverageClaims: []
      }))
    }));
    return this.confirmMetadataInvalidations(invalidations.filter((item) => item.reason !== "draft"),
      courses, indexes, nodes, trash).concat(invalidations.filter((item) => item.reason === "draft"
        && (drafts.some((draft) => draft.workspaceId === item.workspaceId && draft.pageId === item.targetId
          && draft.revision >= (item.rejected ? item.previousRevision ?? item.revision ?? 0 : item.revision ?? 0))
          || item.rejected && !drafts.some((draft) => draft.workspaceId === item.workspaceId && draft.pageId === item.targetId)
            && (item.previousRevision === undefined || !releases.some((release) => release.pages.some((page) => page.id === item.targetId)
              && courses.some((course) => course.workspaceId === item.workspaceId && course.id === release.courseId))))).map((item) => item.id));
  }

  private targetPresent(
    invalidation: ReadingProjectionInvalidation,
    courses: CourseProject[],
    indexes: CourseReleaseIndex[],
    nodes: CourseTreeNode[]
  ): boolean {
    const target = invalidation.targetId;
    if (invalidation.targetKind === "course") {
      return courses.some((item) => item.workspaceId === invalidation.workspaceId && item.id === target)
        || indexes.some((item) => item.courseId === target)
        || nodes.some((item) => item.id === target);
    }
    if (invalidation.targetKind === "release") return indexes.some((item) => item.id === target);
    if (invalidation.targetKind === "page") return indexes.some((item) => item.pages.some((page) => page.id === target));
    if (invalidation.targetKind === "material") {
      const parts = target.startsWith("material:") ? target.slice("material:".length).split(":") : [];
      const courseId = parts.shift();
      const moduleId = parts.join(":");
      return nodes.some((item) => item.id === target || item.materialId === target)
        || indexes.some((item) => item.courseId === courseId && item.moduleId === moduleId);
    }
    return nodes.some((item) => item.id === target || item.materialId === target)
      || indexes.some((item) => item.moduleId === target);
  }

  async materialize(timeoutMs = 120_000): Promise<void> {
    const expectedRevision = this.replica.revision;
    try {
      await withReadBudget({ timeoutMs }, async () => {
        const [courses, releases, drafts, nodes, trash] = await Promise.all([
          this.authority.listCourses(), this.authority.listReleases(), this.authority.listDrafts(),
          this.authority.listTreeNodes(), this.authority.listTrash()
        ]);
        const tree = this.buildTree(courses, nodes, trash, this.workspaceId);
        // Historical drafts may refer to superseded/removed sources. They stay
        // in ReadWeave, but are not reading snapshots for an unrelated version.
        const ownedDrafts = drafts.filter(draft => releases.some(release => release.id === draft.sourceReleaseId
          && release.courseId === draft.courseId && release.pageIds.includes(draft.pageId))
          && courses.some(course => course.id === draft.courseId && course.workspaceId === draft.workspaceId));
        const invalidations = this.replica.projectionInvalidations(this.workspaceId);
        const clearInvalidations = this.confirmMaterializedInvalidations(invalidations, courses, releases, ownedDrafts, nodes, trash);
        const committed = await this.replica.replace({ courses, releases, drafts: ownedDrafts, tree, trash,
          materialReleaseSelectionUpserts: materialReleaseSelectionHints(nodes, this.workspaceId) }, expectedRevision, clearInvalidations);
        if (committed === false) throw new Error("READING_CONFIRMATION_SUPERSEDED");
        const remaining = this.replica.projectionInvalidations(this.workspaceId).length;
        this.sync = { ...await this.authority.getSyncStatus(), state: remaining ? "degraded" : "connected" };
        this.accessDenied = false;
        await unlink(this.deniedPath).catch(error => { if (error.code !== "ENOENT") throw error; });
        await unlink(this.invalidPath).catch(error => { if (error.code !== "ENOENT") throw error; });
        this.legacyProjectionInvalid = false;
      });
    } catch (error) { await this.unavailable(error); throw error; }
  }

  async refresh(): Promise<void> {
    if (this.closed) return;
    if (this.refreshInFlight) return this.refreshInFlight;
    const controller = new AbortController();
    this.refreshController = controller;
    const expectedRevision = this.replica.revision;
    const read = withIndependentReadBudget({ timeoutMs: 60_000, signal: controller.signal }, async () => {
      const invalidations = this.replica.projectionInvalidations(this.workspaceId);
      const [courses, indexes, nodes, trash] = await Promise.all([
        this.authority.listCourses(), this.authority.listReleaseIndexes(), this.authority.listTreeNodes(), this.authority.listTrash()
      ]);
      const clearInvalidations = this.confirmMetadataInvalidations(invalidations, courses, indexes, nodes, trash);
      const draftInvalidations = invalidations.filter((item) => item.reason === "draft");
      const draftConfirmations = await Promise.all(draftInvalidations.map(async (item) => ({
        invalidation: item,
        draft: await this.readDraftSnapshot(item.targetId)
      })));
      const sourcePages = new Set(indexes.flatMap((index) => index.pages.map((page) => page.id)));
      const clearAbsentDrafts = draftConfirmations.filter(({ invalidation, draft }) => !draft
        && (sourcePages.has(invalidation.targetId) === false
          || invalidation.rejected && invalidation.previousRevision === undefined))
        .map(({ invalidation }) => invalidation.id);
      const committed = await this.replica.updateMetadata({
        courses,
        indexes,
        tree: this.buildTree(courses, nodes, trash, this.workspaceId),
        trash,
        materialReleaseSelectionUpserts: materialReleaseSelectionHints(nodes, this.workspaceId),
        clearInvalidations: [...clearInvalidations, ...clearAbsentDrafts]
      }, expectedRevision);
      if (!committed || this.closed) return;
      for (const { invalidation, draft } of draftConfirmations) {
        const minimumRevision = invalidation.rejected
          ? invalidation.previousRevision ?? invalidation.revision ?? 0
          : invalidation.revision ?? 0;
        if (draft && draft.workspaceId === invalidation.workspaceId && draft.pageId === invalidation.targetId
          && draft.revision >= minimumRevision) {
          const updated = await this.replica.upsertDraft(draft, [invalidation.id]);
          if (!updated) {
            const existing = await this.replica.getDraft(draft.workspaceId, draft.pageId, draft.sourceReleaseId);
            if (existing && existing.revision === draft.revision && existing.contentHash === draft.contentHash) {
              await this.replica.clearProjectionInvalidations([invalidation.id], [invalidation]);
            }
          }
        }
      }
      // Reconcile a bounded slice of existing leaf objects, no model calls.
      const pages = indexes.flatMap(index => index.pages.map(page => ({ releaseId: index.id, pageId: page.id })));
      for (let count = 0; count < Math.min(8, pages.length); count += 1) {
        const target = pages[this.cursor++ % pages.length]!;
        const draft = await this.authority.getDraftByPage(target.pageId);
        if (draft?.sourceReleaseId === target.releaseId && draft.workspaceId === this.workspaceId) await this.replica.upsertDraft(draft);
      }
      const remaining = this.replica.projectionInvalidations(this.workspaceId).length;
      this.sync = { ...await this.authority.getSyncStatus(), state: remaining ? "degraded" : "connected" };
      this.accessDenied = false;
      await unlink(this.deniedPath).catch(error => { if (error.code !== "ENOENT") throw error; });
    });
    this.refreshInFlight = read;
    try { await read; }
    catch (error) { await this.unavailable(error); throw error; }
    finally { if (this.refreshInFlight === read) this.refreshInFlight = undefined; if (this.refreshController === controller) this.refreshController = undefined; }
  }

  async confirmPage(pageId: string, releaseId?: string): Promise<void> {
    try {
      await withReadBudget({ timeoutMs: 8_000 }, async () => {
        // Explicit return from the native editor reconciles that page's notes;
        // a cached draft snapshot cannot confirm an external edit.
        const draft = await this.authority.getDraftByPage(pageId);
        const invalidations = this.replica.projectionInvalidations(this.workspaceId)
          .filter((item) => item.reason === "draft" && item.targetId === pageId);
        const clear = draft && (!releaseId || draft.sourceReleaseId === releaseId)
          ? invalidations.filter((item) => draft.revision >= (item.rejected
            ? item.previousRevision ?? item.revision ?? 0 : item.revision ?? 0)).map((item) => item.id) : [];
        if (draft && draft.workspaceId === this.workspaceId && (!releaseId || draft.sourceReleaseId === releaseId)) {
          await this.replica.upsertDraft(draft, clear);
        }
      });
    } catch (error) { await this.unavailable(error); throw error; }
  }

  async beforeWrite(method: keyof ReadWeaveCourseApi, args: unknown[]): Promise<ReadingProjectionInvalidation | undefined> {
    const invalidation = await this.invalidationBeforeWrite(method, args);
    if (!invalidation) return undefined;
    if ((method === "saveDraft" || method === "saveDraftWithCost") && args[0] && typeof args[0] === "object") {
      const draft = args[0] as LessonDraft;
      const previous = await this.replica.getDraft(draft.workspaceId, draft.pageId, draft.sourceReleaseId);
      invalidation.previousRevision = previous?.revision;
    }
    await this.persistInvalidation(invalidation, method);
    return invalidation;
  }

  async writeFailed(confirmation: ReadingProjectionInvalidation | undefined, error: unknown): Promise<void> {
    if (!confirmation || !isDefinitiveAuthorityRejection(error)) return;
    const invalidationId = confirmation.id;
    await this.replica.markProjectionRejected(invalidationId, confirmation);
    const invalidation = this.replica.projectionInvalidations(this.workspaceId).find((item) => item.id === invalidationId);
    if (!invalidation?.rejected || invalidation.revision !== confirmation.revision) return;
    if (invalidation?.reason === "draft") {
      await this.recoverRejectedDraft(invalidation).catch(() => undefined);
      return;
    }
    // A rejection proves this write did not commit. Re-read authority state and
    // clear only when its object revision is at least the pre-write baseline.
    // If that read fails, the durable rejection marker remains for a later refresh.
    await this.refresh().catch(() => undefined);
  }

  private async recoverRejectedDraft(invalidation: ReadingProjectionInvalidation): Promise<void> {
    const draft = await this.readDraftSnapshot(invalidation.targetId);
    if (!draft) {
      if (invalidation.previousRevision === undefined) {
        await this.replica.clearProjectionInvalidations([invalidation.id], [invalidation]);
      }
      return;
    }
    if (draft.workspaceId !== invalidation.workspaceId || draft.pageId !== invalidation.targetId
      || draft.revision < (invalidation.previousRevision ?? invalidation.revision ?? 0)) return;
    const updated = await this.replica.upsertDraft(draft, [invalidation.id]);
    if (updated) return;
    const existing = await this.replica.getDraft(draft.workspaceId, draft.pageId, draft.sourceReleaseId);
    if (existing && existing.revision === draft.revision && existing.contentHash === draft.contentHash) {
      await this.replica.clearProjectionInvalidations([invalidation.id], [invalidation]);
    }
  }

  private async persistInvalidation(invalidation: ReadingProjectionInvalidation, method: keyof ReadWeaveCourseApi): Promise<void> {
    try {
      await this.replica.invalidateProjection(invalidation);
    } catch (error) {
      this.legacyProjectionInvalid = true;
      await writeJsonAtomic(this.invalidPath, { method, failedAt: new Date().toISOString() });
      throw error;
    }
  }

  private invalidation(
    workspaceId: string,
    targetKind: ReadingProjectionInvalidation["targetKind"],
    targetId: string,
    reason: ReadingProjectionInvalidation["reason"],
    values: Partial<ReadingProjectionInvalidation> = {}
  ): ReadingProjectionInvalidation {
    return {
      id: readingProjectionInvalidationId(workspaceId, targetKind, targetId),
      workspaceId,
      targetKind,
      targetId,
      reason,
      ...values
    };
  }

  private nodeTarget(nodeId: string): { targetKind: ReadingProjectionInvalidation["targetKind"]; targetId: string } {
    const node = this.replica.getTreeNode(this.workspaceId, nodeId);
    if (node?.kind === "course") return { targetKind: "course", targetId: node.id };
    if (node?.kind === "material") return { targetKind: "material", targetId: node.materialId ?? node.id };
    const course = this.replica.getCourse(this.workspaceId, nodeId);
    return course ? { targetKind: "course", targetId: course.id } : { targetKind: "node", targetId: node?.id ?? nodeId };
  }

  private trashTarget(record: TrashRecord): { targetKind: ReadingProjectionInvalidation["targetKind"]; targetId: string } {
    const node = this.replica.getTreeNode(record.workspaceId, record.nodeId);
    if (node?.kind === "material") return { targetKind: "material", targetId: node.materialId ?? node.id };
    if (node?.kind === "course" || record.nodeKind === "course") return { targetKind: "course", targetId: record.nodeId };
    if (record.nodeKind === "material") return { targetKind: "material", targetId: record.nodeId };
    if (record.nodeKind === "release") return { targetKind: "release", targetId: record.nodeId };
    if (record.nodeKind === "page") return { targetKind: "page", targetId: record.nodeId.replace(/^page:/u, "") };
    return { targetKind: "node", targetId: record.nodeId };
  }

  private async invalidationBeforeWrite(method: keyof ReadWeaveCourseApi, args: unknown[]): Promise<ReadingProjectionInvalidation | undefined> {
    if ((method === "saveDraft" || method === "saveDraftWithCost") && args[0] && typeof args[0] === "object") {
      const draft = args[0] as LessonDraft;
      const expectedRevision = args[1];
      return this.invalidation(draft.workspaceId, "page", draft.pageId, "draft", {
        revision: typeof expectedRevision === "number" ? expectedRevision + 1 : draft.revision
      });
    }
    if (method === "updateTreeNode" && args[1] && typeof args[1] === "object") {
      const patch = args[1] as { archived?: boolean; currentReleaseId?: string };
      if (patch.archived === undefined && patch.currentReleaseId === undefined) return undefined;
      const target = this.nodeTarget(String(args[0]));
      const expectedRevision = args[2];
      const revision = typeof expectedRevision === "number" ? expectedRevision + 1 : undefined;
      return this.invalidation(this.workspaceId, target.targetKind, target.targetId, "tree", {
        ...(revision === undefined ? {} : { revision }),
        ...(this.replica.getTreeNode(this.workspaceId, String(args[0]))?.revision === undefined ? {} : {
          previousRevision: this.replica.getTreeNode(this.workspaceId, String(args[0]))!.revision
        }),
        ...(patch.archived === undefined ? {} : { expectedArchived: patch.archived }),
        ...(patch.currentReleaseId === undefined ? {} : { expectedCurrentReleaseId: patch.currentReleaseId })
      });
    }
    if (method === "removeDraftSource") {
      const releaseId = String(args[0]);
      const index = this.replica.getCachedReleaseIndex(this.workspaceId, releaseId);
      return this.invalidation(this.workspaceId, "release", releaseId, "release-removed",
        index ? { revision: index.version, previousRevision: index.version } : {});
    }
    if (method === "trashTreeNode") {
      const nodeId = String(args[0]);
      const target = this.nodeTarget(nodeId);
      const revision = this.replica.getTreeNode(this.workspaceId, nodeId)?.revision;
      return this.invalidation(this.workspaceId, target.targetKind, target.targetId, "trashed",
        revision === undefined ? {} : { previousRevision: revision });
    }
    if (method === "restoreTrash" || method === "permanentlyDeleteTrash") {
      const record = this.replica.getTrashRecord(this.workspaceId, String(args[0]));
      if (!record) return undefined;
      const target = this.trashTarget(record);
      const revision = this.replica.getTreeNode(this.workspaceId, record.nodeId)?.revision;
      return this.invalidation(this.workspaceId, target.targetKind, target.targetId,
        method === "restoreTrash" ? "restored" : "permanent-delete", {
          trashId: record.id,
          deletedAt: record.deletedAt,
          ...(revision === undefined ? {} : { revision, previousRevision: revision })
        });
    }
    return undefined;
  }

  private async invalidationAfterWrite(method: keyof ReadWeaveCourseApi, result: unknown, args: unknown[]): Promise<ReadingProjectionInvalidation | undefined> {
    if ((method === "saveDraft" || method === "saveDraftWithCost") && result && typeof result === "object") {
      const draft = result as LessonDraft;
      const requested = args[0] as LessonDraft | undefined;
      if (requested && (draft.workspaceId !== requested.workspaceId || draft.pageId !== requested.pageId)) return undefined;
      return this.invalidation(draft.workspaceId, "page", draft.pageId, "draft", { revision: draft.revision });
    }
    if (method === "resolveConflict" && result && typeof result === "object") {
      const conflict = result as CourseConflict;
      if (conflict.objectType === "lesson_draft" && conflict.workspaceId === this.workspaceId) {
        return this.invalidation(conflict.workspaceId, "page", conflict.objectId, "draft", {
          revision: Math.max(conflict.localRevision, conflict.remoteRevision) + 1
        });
      }
    }
    if (method === "updateTreeNode" && result && typeof result === "object") {
      const node = result as CourseTreeNode;
      const patch = (args[1] ?? {}) as { archived?: boolean; currentReleaseId?: string };
      if (patch.archived === undefined && patch.currentReleaseId === undefined) return undefined;
      const target = node.kind === "course" ? { targetKind: "course" as const, targetId: node.id }
        : node.kind === "material" ? { targetKind: "material" as const, targetId: node.materialId ?? node.id }
          : this.nodeTarget(node.id);
      return this.invalidation(this.workspaceId, target.targetKind, target.targetId, "tree", {
        ...(node.revision === undefined ? {} : { revision: node.revision }),
        ...(patch.archived === undefined ? {} : { expectedArchived: patch.archived }),
        ...(patch.currentReleaseId === undefined ? {} : { expectedCurrentReleaseId: patch.currentReleaseId })
      });
    }
    if (method === "trashTreeNode" && result && typeof result === "object") {
      const record = result as TrashRecord;
      const target = this.trashTarget(record);
      return this.invalidation(record.workspaceId, target.targetKind, target.targetId, "trashed", {
        trashId: record.id,
        deletedAt: record.deletedAt
      });
    }
    if (method === "restoreTrash") {
      const record = this.replica.getTrashRecord(this.workspaceId, String(args[0]));
      const node = result as CourseTreeNode;
      if (record && node && typeof node === "object") {
        const target = this.trashTarget(record);
        return this.invalidation(this.workspaceId, target.targetKind, target.targetId, "restored", {
          trashId: record.id,
          deletedAt: record.deletedAt,
          ...(node.revision === undefined ? {} : { revision: node.revision })
        });
      }
    }
    if (method === "permanentlyDeleteTrash") {
      const record = this.replica.getTrashRecord(this.workspaceId, String(args[0]));
      if (record) {
        const target = this.trashTarget(record);
        return this.invalidation(this.workspaceId, target.targetKind, target.targetId, "permanent-delete", {
          trashId: record.id,
          deletedAt: record.deletedAt
        });
      }
    }
    if (method === "removeDraftSource") {
      const releaseId = String(args[0]);
      const index = this.replica.getCachedReleaseIndex(this.workspaceId, releaseId);
      return this.invalidation(this.workspaceId, "release", releaseId, "release-removed",
        index ? { revision: index.version } : {});
    }
    return undefined;
  }

  private courseNode(course: CourseProject): CourseTreeNode {
    return {
      id: course.id,
      kind: "course",
      title: course.title,
      subtitle: course.description,
      status: course.status === "archived" ? "draft" : "published",
      revision: course.revision,
      sortOrder: course.sortOrder,
      archived: course.status === "archived",
      readweaveNoteId: course.readweaveNoteId,
      children: []
    };
  }

  private courseFromNode(node: CourseTreeNode, previous?: CourseProject): CourseProject {
    const now = new Date().toISOString();
    const archived = node.archived === true || node.visibility === "archived" || node.status === "draft";
    return {
      ...(previous ?? { id: node.id, workspaceId: this.workspaceId, createdAt: now, updatedAt: now, status: "active" as const }),
      id: node.id,
      workspaceId: this.workspaceId,
      title: node.title,
      ...(node.subtitle === undefined ? {} : { description: node.subtitle }),
      status: archived ? "archived" : "active",
      ...(node.revision === undefined ? {} : { revision: node.revision }),
      ...(node.sortOrder === undefined ? {} : { sortOrder: node.sortOrder }),
      ...(node.readweaveNoteId === undefined ? {} : { readweaveNoteId: node.readweaveNoteId }),
      updatedAt: now
    };
  }

  private async projectTreeNode(node: CourseTreeNode, clearInvalidations: string[] = [], sourceCourse?: CourseProject,
    materialReleaseSelection?: { materialId: string; selection: ReadingMaterialReleaseSelection },
    confirmation?: ReadingProjectionInvalidation): Promise<void> {
    const existingCourse = this.replica.getCourse(this.workspaceId, node.id);
    const courseUpserts = node.kind === "course"
      ? [this.courseFromNode(node, existingCourse ?? sourceCourse)]
      : [];
    const committed = await this.replica.updateMetadata({
      ...(courseUpserts.length ? { courseUpserts } : {}),
      treeNodeUpserts: [{ workspaceId: this.workspaceId, node }],
      ...(materialReleaseSelection ? { materialReleaseSelectionUpserts: [{
        workspaceId: this.workspaceId, ...materialReleaseSelection
      }] } : {}),
      clearInvalidations,
      ...(confirmation ? { clearInvalidationConfirmations: [confirmation] } : {})
    });
    if (!committed) throw new Error("READING_CONFIRMED_WRITE_NOT_PROJECTED");
  }

  private async projectRelease(release: CourseRelease): Promise<void> {
    const updated = await this.replica.upsertRelease(release);
    if (!updated) {
      const existing = await this.replica.getReleaseIndex(this.workspaceId, release.id);
      if (!existing || existing.version < release.version
        || existing.version === release.version && existing.manifestHash !== release.manifestHash) {
        throw new Error("READING_CONFIRMED_WRITE_NOT_PROJECTED");
      }
    }
    await this.projectMaterialSelection(release.courseId, release.moduleId);
  }

  private async projectMaterialSelection(courseId: string, moduleId: string): Promise<void> {
    const visibleIndexes = (await this.replica.listIndexes(this.workspaceId, courseId))
      .filter((index) => index.moduleId === moduleId);
    const releases = visibleIndexes.flatMap((index) => {
      const completeIndex = this.replica.getCachedReleaseIndex(this.workspaceId, index.id);
      // Keep hidden/tombstoned pages in the readiness check; a filtered index
      // must not make an incomplete draft source appear complete.
      return completeIndex && completeIndex.version === index.version ? [completeIndex] : [];
    });
    const drafts: LessonDraft[] = [];
    for (const release of releases) {
      for (const page of release.pages) {
        const draft = await this.replica.getDraft(this.workspaceId, page.id, release.id);
        if (draft) drafts.push(draft);
      }
    }
    const materialId = `material:${courseId}:${moduleId}`;
    const previousSelection = this.replica.getMaterialReleaseSelection(this.workspaceId, materialId);
    const explicitReleaseId = previousSelection?.source === "explicit" ? previousSelection.releaseId : undefined;
    const selected = selectMaterialRelease(releases, drafts, courseId, moduleId, explicitReleaseId);
    if (!selected) return;

    const existingNode = this.replica.getTreeNode(this.workspaceId, materialId);
    const node: CourseTreeNode = existingNode ? {
      ...existingNode,
      pageCount: selected.pages.length,
      currentReleaseId: selected.id,
      releaseId: selected.id
    } : {
      id: materialId,
      kind: "material",
      title: selected.moduleTitle,
      parentId: courseId,
      releaseId: selected.id,
      currentReleaseId: selected.id,
      materialId,
      pageCount: selected.pages.length,
      revision: selected.version,
      children: []
    };
    const selection: ReadingMaterialReleaseSelection = {
      releaseId: selected.id,
      source: explicitReleaseId && selected.id === explicitReleaseId ? "explicit" : "derived"
    };
    const committed = await this.replica.updateMetadata({
      treeNodeUpserts: [{ workspaceId: this.workspaceId, node }],
      materialReleaseSelectionUpserts: [{ workspaceId: this.workspaceId, materialId, selection }]
    });
    if (!committed) throw new Error("READING_CONFIRMED_WRITE_NOT_PROJECTED");
  }

  /** Persist only the result already acknowledged by ReadWeave. */
  async saved(method: keyof ReadWeaveCourseApi, result: unknown, args: unknown[] = []): Promise<void> {
    try {
      if ((method === "saveDraft" || method === "saveDraftWithCost") && result && typeof result === "object"
        && typeof args[1] === "number" && (result as LessonDraft).revision < args[1] + 1) {
        throw new Error("READING_STALE_DRAFT_WRITE_CONFIRMATION");
      }
      const invalidation = await this.invalidationAfterWrite(method, result, args);
      if (invalidation) await this.persistInvalidation(invalidation, method);
      const clear = invalidation ? [invalidation.id] : [];
      const conflict = method === "resolveConflict" ? result as CourseConflict : undefined;
      const projectResolvedDraft = conflict?.objectType === "lesson_draft" && conflict.workspaceId === this.workspaceId;
      if (method === "saveDraft" || method === "saveDraftWithCost" || projectResolvedDraft) {
        const draft = projectResolvedDraft
          ? await (this.authority.getDraftSnapshotByPage
            ? this.authority.getDraftSnapshotByPage(conflict!.objectId)
            : this.authority.getDraftByPage(conflict!.objectId))
          : result as LessonDraft;
        if (!draft || (projectResolvedDraft && (draft.pageId !== conflict!.objectId
          || draft.workspaceId !== conflict!.workspaceId
          || draft.revision <= Math.max(conflict!.localRevision, conflict!.remoteRevision)))) {
          throw new Error("READING_CONFIRMED_WRITE_NOT_PROJECTED");
        }
        const draftInvalidation = projectResolvedDraft
          ? this.invalidation(draft.workspaceId, "page", draft.pageId, "draft", { revision: draft.revision })
          : invalidation;
        if (draftInvalidation && !invalidation) await this.persistInvalidation(draftInvalidation, method);
        const clearDraft = draftInvalidation ? [draftInvalidation.id] : clear;
        const updated = await this.replica.upsertDraft(draft, clearDraft);
        if (!updated) {
          const existing = await this.replica.getDraft(draft.workspaceId, draft.pageId, draft.sourceReleaseId);
          if (!existing || existing.revision !== draft.revision || existing.contentHash !== draft.contentHash) {
            throw new Error("READING_CONFIRMED_WRITE_NOT_PROJECTED");
          }
          if (clearDraft.length) await this.replica.clearProjectionInvalidations(clearDraft, draftInvalidation ? [draftInvalidation] : []);
        }
        await this.projectMaterialSelection(draft.courseId, draft.moduleId);
      } else if (method === "registerDraftSource" || method === "publishRelease") {
        await this.projectRelease(result as CourseRelease);
      } else if (method === "createCourse") {
        const course = result as CourseProject;
        const committed = await this.replica.updateMetadata({
          courseUpserts: [course], treeNodeUpserts: [{ workspaceId: course.workspaceId, node: this.courseNode(course) }]
        });
        if (!committed) throw new Error("READING_CONFIRMED_WRITE_NOT_PROJECTED");
      } else if (method === "createTreeNode" || method === "updateTreeNode" || method === "duplicateTreeNode") {
        const node = result as CourseTreeNode;
        const sourceCourse = method === "duplicateTreeNode" ? this.replica.getCourse(this.workspaceId, String(args[0])) : undefined;
        const patch = (args[1] ?? {}) as { currentReleaseId?: string };
        const explicitSelection = method === "updateTreeNode" && node.kind === "material"
          && patch.currentReleaseId !== undefined && node.currentReleaseId === patch.currentReleaseId
          ? { materialId: node.materialId ?? node.id, selection: { releaseId: patch.currentReleaseId, source: "explicit" as const } }
          : undefined;
        await this.projectTreeNode(node, clear, sourceCourse, explicitSelection, invalidation);
      } else if (method === "trashTreeNode") {
        const record = result as TrashRecord;
        const committed = await this.replica.updateMetadata({
          treeNodeRemovals: [{ workspaceId: record.workspaceId, nodeId: record.nodeId }],
          trashUpserts: [record],
          clearInvalidations: clear,
          clearInvalidationConfirmations: invalidation ? [invalidation] : []
        });
        if (!committed) throw new Error("READING_CONFIRMED_WRITE_NOT_PROJECTED");
      } else if (method === "restoreTrash") {
        const record = this.replica.getTrashRecord(this.workspaceId, String(args[0]));
        const node = result as CourseTreeNode;
        if (!record || !node) throw new Error("READING_CONFIRMED_WRITE_NOT_PROJECTED");
        const restored = { ...record, restoreAvailable: false,
          ...(args[2] && typeof args[2] === "object" && "restoreMode" in args[2]
            ? { restoreMode: (args[2] as { restoreMode?: TrashRecord["restoreMode"] }).restoreMode } : {}) };
        const courseUpserts = node.kind === "course" ? [this.courseFromNode(node, this.replica.getCourse(this.workspaceId, node.id))] : [];
        const committed = await this.replica.updateMetadata({
          ...(courseUpserts.length ? { courseUpserts } : {}),
          treeNodeUpserts: [{ workspaceId: this.workspaceId, node }],
          trashUpserts: [restored], clearInvalidations: clear,
          clearInvalidationConfirmations: invalidation ? [invalidation] : []
        });
        if (!committed) throw new Error("READING_CONFIRMED_WRITE_NOT_PROJECTED");
      } else if (method === "removeDraftSource") {
        const releaseId = String(args[0]);
        const invalidatedIndex = this.replica.getCachedReleaseIndex(this.workspaceId, releaseId);
        const candidates = invalidatedIndex
          ? (await this.replica.listIndexes(this.workspaceId, invalidatedIndex.courseId))
            .filter((index) => index.id !== releaseId && index.moduleId === invalidatedIndex.moduleId)
            .sort((left, right) => right.version - left.version)
          : [];
        const materialId = invalidatedIndex ? `material:${invalidatedIndex.courseId}:${invalidatedIndex.moduleId}` : undefined;
        const existingNode = materialId ? this.replica.getTreeNode(this.workspaceId, materialId) : undefined;
        const replacement = candidates[0];
        if (existingNode?.currentReleaseId === releaseId && replacement) {
          await this.replica.updateMetadata({ treeNodeUpserts: [{ workspaceId: this.workspaceId, node: {
            ...existingNode, currentReleaseId: replacement.id, releaseId: replacement.id,
            pageCount: replacement.pages.length, revision: Math.max(existingNode.revision ?? 0, replacement.version)
          } }] });
        }
        await this.replica.removeRelease(this.workspaceId, releaseId, clear);
      } else if (method === "permanentlyDeleteTrash") {
        const record = this.replica.getTrashRecord(this.workspaceId, String(args[0]));
        if (!record) throw new Error("READING_CONFIRMED_WRITE_NOT_PROJECTED");
        await this.replica.updateMetadata({
          treeNodeRemovals: [{ workspaceId: this.workspaceId, nodeId: record.nodeId }],
          trashRemovals: [{ workspaceId: this.workspaceId, trashId: record.id }],
          clearInvalidations: clear,
          clearInvalidationConfirmations: invalidation ? [invalidation] : []
        });
      } else if (projectResolvedDraft) {
        // The branch above handles this case; this guard keeps unsupported conflict kinds harmless.
      } else if (method === "resolveConflict") {
        await this.refresh();
      } else {
        await this.refresh();
      }
    } catch (error) {
      await this.unavailable(error);
      process.stderr.write("Reading replica confirmation failed; authority write remains acknowledged\n");
    }
  }
}

const replicatedWrites = new Set<keyof ReadWeaveCourseApi>([
  "saveDraft", "saveDraftWithCost", "registerDraftSource", "removeDraftSource", "publishRelease", "createCourse",
  "createTreeNode", "updateTreeNode", "duplicateTreeNode", "trashTreeNode", "restoreTrash", "permanentlyDeleteTrash", "resolveConflict"
]);

/** Keep authority writes/returns unchanged, then incrementally confirm their read copies. */
export function observeReadingWrites(authority: ReadWeaveCourseApi, runtime: ReadingRuntime): ReadWeaveCourseApi {
  return new Proxy(authority, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (typeof value !== "function") return value;
    if (!replicatedWrites.has(property as keyof ReadWeaveCourseApi)) return value.bind(target);
    return async (...args: unknown[]) => {
      const method = property as keyof ReadWeaveCourseApi;
      const invalidationId = await runtime.beforeWrite(method, args);
      let result: unknown;
      try {
        result = await value.apply(target, args);
      } catch (error) {
        await runtime.writeFailed(invalidationId, error).catch(() => undefined);
        throw error;
      }
      await runtime.saved(method, result, args);
      return result;
    };
  } });
}

function isDefinitiveAuthorityRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:READWEAVE_(?:HTTP|ETAPI)_(?:400|401|403|404|409|410|422)(?::|$)|READWEAVE_[A-Z0-9_]*(?:REVISION_CONFLICT|NOT_FOUND)(?::|$)|TREE_(?:TARGET|PARENT)_NOT_FOUND(?:$|:))/u.test(message);
}
