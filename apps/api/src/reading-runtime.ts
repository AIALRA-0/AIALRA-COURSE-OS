import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CourseConflict, CourseProject, CourseRelease, LessonDraft, ReadWeaveSyncStatus, TrashRecord, WorkspaceTree, CourseTreeNode } from "@course-os/contracts";
import type { ReadWeaveCourseApi } from "@course-os/readweave-adapter";
import { withReadBudget, withIndependentReadBudget } from "@course-os/readweave-adapter";
import { writeJsonAtomic } from "@course-os/storage";
import { ReadingReplica } from "./reading-replica.js";

type TreeBuilder = (courses: CourseProject[], nodes: CourseTreeNode[], trash: TrashRecord[], workspaceId: string) => WorkspaceTree;

/** Remote authority is used for confirmation, never as a fallback for a reader. */
export class ReadingRuntime {
  readonly replica: ReadingReplica;
  private timer?: ReturnType<typeof setInterval>;
  private refreshInFlight?: Promise<void>;
  private refreshController?: AbortController;
  private closed = false;
  private projectionInvalid = false;
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
    try { await readFile(this.invalidPath); this.projectionInvalid = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  assertAccess(): void {
    if (this.accessDenied) throw new Error("READING_ACCESS_DENIED");
  }

  status() {
    const local = this.replica.status();
    return { ...local, ready: local.ready && !this.accessDenied && !this.projectionInvalid, synchronization: this.sync.state,
      message: this.sync.message, accessDenied: this.accessDenied };
  }

  syncStatus(): ReadWeaveSyncStatus {
    return { ...this.sync, lastReadAt: this.replica.status().lastConfirmedAt,
      message: this.accessDenied ? "来源访问权限失效，阅读已停止" : this.sync.message };
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
        const committed = await this.replica.replace({ courses, releases, drafts: ownedDrafts, tree, trash }, expectedRevision);
        if (committed === false) throw new Error("READING_CONFIRMATION_SUPERSEDED");
        this.sync = { ...await this.authority.getSyncStatus(), state: "connected" };
        this.accessDenied = false;
        await unlink(this.deniedPath).catch(error => { if (error.code !== "ENOENT") throw error; });
        await unlink(this.invalidPath).catch(error => { if (error.code !== "ENOENT") throw error; });
        this.projectionInvalid = false;
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
      const [courses, indexes, nodes, trash] = await Promise.all([
        this.authority.listCourses(), this.authority.listReleaseIndexes(), this.authority.listTreeNodes(), this.authority.listTrash()
      ]);
      const committed = await this.replica.updateMetadata({ courses, indexes, tree: this.buildTree(courses, nodes, trash, this.workspaceId), trash }, expectedRevision);
      if (!committed || this.closed) return;
      // Reconcile a bounded slice of existing leaf objects, no model calls.
      const pages = indexes.flatMap(index => index.pages.map(page => ({ releaseId: index.id, pageId: page.id })));
      for (let count = 0; count < Math.min(8, pages.length); count += 1) {
        const target = pages[this.cursor++ % pages.length]!;
        const draft = await this.authority.getDraftByPage(target.pageId);
        if (draft?.sourceReleaseId === target.releaseId && draft.workspaceId === this.workspaceId) await this.replica.upsertDraft(draft);
      }
      this.sync = { ...await this.authority.getSyncStatus(), state: "connected" };
      this.accessDenied = false;
      await unlink(this.deniedPath).catch(error => { if (error.code !== "ENOENT") throw error; });
    });
    this.refreshInFlight = read;
    try { await read; }
    catch (error) { await this.unavailable(error); throw error; }
    finally { if (this.refreshInFlight === read) this.refreshInFlight = undefined; if (this.refreshController === controller) this.refreshController = undefined; }
  }

  private async refreshMetadataProjection(includeIndexes: boolean): Promise<void> {
    const [courses, indexes, nodes, trash] = await Promise.all([
      this.authority.listCourses(),
      includeIndexes ? this.authority.listReleaseIndexes() : Promise.resolve(undefined),
      this.authority.listTreeNodes(),
      this.authority.listTrash()
    ]);
    await this.replica.updateMetadata({
      courses,
      ...(indexes === undefined ? {} : { indexes }),
      tree: this.buildTree(courses, nodes, trash, this.workspaceId),
      trash
    });
  }

  async confirmPage(pageId: string, releaseId?: string): Promise<void> {
    try {
      await withReadBudget({ timeoutMs: 8_000 }, async () => {
        const draft = await this.authority.getDraftByPage(pageId);
        if (draft && draft.workspaceId === this.workspaceId && (!releaseId || draft.sourceReleaseId === releaseId)) await this.replica.upsertDraft(draft);
      });
    } catch (error) { await this.unavailable(error); throw error; }
  }

  /** Persist only the result already acknowledged by ReadWeave. */
  async saved(method: keyof ReadWeaveCourseApi, result: unknown): Promise<void> {
    try {
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
        const updated = await this.replica.upsertDraft(draft);
        if (!updated) {
          const existing = await this.replica.getDraft(draft.workspaceId, draft.pageId, draft.sourceReleaseId);
          if (!existing || existing.revision < draft.revision
            || existing.revision === draft.revision && existing.contentHash !== draft.contentHash) {
            throw new Error("READING_CONFIRMED_WRITE_NOT_PROJECTED");
          }
        }
      } else if (method === "registerDraftSource" || method === "publishRelease") {
        const release = result as CourseRelease;
        const updated = await this.replica.upsertRelease(release);
        if (!updated) {
          const existing = await this.replica.getReleaseIndex(this.workspaceId, release.id);
          if (!existing || existing.version < release.version
            || existing.version === release.version && existing.manifestHash !== release.manifestHash) {
            throw new Error("READING_CONFIRMED_WRITE_NOT_PROJECTED");
          }
        }
        await this.refreshMetadataProjection(false);
      }
      else {
        await this.refreshMetadataProjection(true);
      }
    } catch (error) {
      await this.unavailable(error);
      // An acknowledged authority write must never trigger paid generation again.
      // Stop serving potentially stale metadata until a controlled confirmation succeeds.
      this.projectionInvalid = true;
      await writeJsonAtomic(this.invalidPath, { method, failedAt: new Date().toISOString() });
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
      const result = await value.apply(target, args);
      await runtime.saved(property as keyof ReadWeaveCourseApi, result);
      return result;
    };
  } });
}
