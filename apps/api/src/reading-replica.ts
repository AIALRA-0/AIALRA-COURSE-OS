import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  CourseProject,
  CourseRelease,
  CourseTreeNode,
  LessonDraft,
  PageLesson,
  TrashRecord,
  WorkspaceTree
} from "@course-os/contracts";
import { sha256Text, stableStringify } from "@course-os/domain";
import { writeJsonAtomic } from "@course-os/storage";
import { toCourseReleaseIndex, type CourseReleaseIndex } from "@course-os/readweave-adapter";

const FORMAT_VERSION = 1;
const MAX_SNAPSHOT_COUNT = 50_000;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024 * 1024;
const REGRESSION_ASSET_MARKER = /(?:^|[-_\s])(synthetic|golden|regression|legacy)(?:$|[-_\s])/i;

interface DraftPointer {
  id: string;
  revision: number;
  contentHash: string;
  updatedAt: string;
}

interface SnapshotPointer {
  snapshotHash: string;
  bytes: number;
  pageHash: string;
  draft?: DraftPointer;
}

interface CatalogRelease {
  workspaceId: string;
  courseId: string;
  index: CourseReleaseIndex;
  pages: Array<{ pageId: string; snapshot?: SnapshotPointer }>;
}

interface ReplicaCatalog {
  format: 1;
  authorityHash: string;
  revision: number;
  lastConfirmedAt?: string;
  snapshotCount: number;
  snapshotBytes: number;
  courses: CourseProject[];
  releases: CatalogRelease[];
  trees: WorkspaceTree[];
  trash: TrashRecord[];
}

interface SnapshotEnvelope {
  format: 1;
  authorityHash: string;
  workspaceId: string;
  courseId: string;
  releaseId: string;
  pageId: string;
  pageHash: string;
  page: PageLesson;
  confirmedDraft?: DraftPointer;
  draft?: LessonDraft;
}

interface SnapshotBudget {
  count: number;
  bytes: number;
}

interface CatalogFile {
  payload: ReplicaCatalog;
  sha256: string;
}

export interface ReadingReplicaInput {
  courses: CourseProject[];
  releases: CourseRelease[];
  drafts: LessonDraft[];
  tree: WorkspaceTree;
  trash: TrashRecord[];
}

export interface ReadingReplicaMetadataUpdate {
  expectedRevision?: number;
  courses?: CourseProject[];
  indexes?: CourseReleaseIndex[];
  tree?: WorkspaceTree;
  trash?: TrashRecord[];
}

export interface ReadingReplicaStatus {
  ready: boolean;
  revision: number;
  courses: number;
  pages: number;
  releases: number;
  snapshotBytes: number;
  lastConfirmedAt?: string;
  maxSnapshotCount: number;
  maxSnapshotBytes: number;
}

const processLocks = new Map<string, Promise<void>>();

async function withProcessLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = processLocks.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const gate = new Promise<void>((resolveGate) => { unlock = resolveGate; });
  const tail = previous.then(() => gate);
  processLocks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    unlock();
    if (processLocks.get(key) === tail) processLocks.delete(key);
  }
}

function jsonClone<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("READING_INVALID_INPUT:VALUE_NOT_SERIALIZABLE");
  return JSON.parse(serialized) as T;
}

function pageHash(page: PageLesson): string {
  return sha256Text(stableStringify(page));
}

function hasConfirmedPageBody(page: PageLesson): boolean {
  return page.anchors.length > 0 || page.atoms.length > 0 || page.blocks.length > 0
    || Boolean(page.lessonSections?.length || page.questionBank?.length || page.coverageRequirements.length
      || page.coverageClaims.length || page.teachingTrace || page.lessonFlowVersion || page.teachingCompositionVersion);
}

function snapshotHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pointerKey(workspaceId: string, releaseId: string, pageId: string): string {
  return `${workspaceId}\u0000${releaseId}\u0000${pageId}`;
}

function isRegressionAsset(...values: string[]): boolean {
  return REGRESSION_ASSET_MARKER.test(values.join(" "));
}

function assertIdentifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`READING_INVALID_INPUT:${name}`);
}

function assertCatalog(catalog: ReplicaCatalog, authorityHash: string): void {
  if (!catalog || catalog.format !== FORMAT_VERSION || !Number.isSafeInteger(catalog.revision) || catalog.revision < 0) {
    throw new Error("READING_CORRUPT:CATALOG_INVALID");
  }
  if (catalog.authorityHash !== authorityHash) throw new Error("READING_AUTHORITY_MISMATCH");
  if (!Array.isArray(catalog.courses) || !Array.isArray(catalog.releases) || !Array.isArray(catalog.trees) || !Array.isArray(catalog.trash)) {
    throw new Error("READING_CORRUPT:CATALOG_INVALID");
  }
  const totals = snapshotTotals(catalog.releases);
  const indexedPages = catalog.releases.reduce((total, release) => total + release.index.pages.length, 0);
  if (totals.count !== catalog.snapshotCount || totals.bytes !== catalog.snapshotBytes) throw new Error("READING_CORRUPT:CATALOG_INVALID");
  if (totals.count > MAX_SNAPSHOT_COUNT || totals.bytes > MAX_SNAPSHOT_BYTES
    || indexedPages > MAX_SNAPSHOT_COUNT || catalog.releases.length > MAX_SNAPSHOT_COUNT || catalog.courses.length > MAX_SNAPSHOT_COUNT) {
    throw new Error("READING_CAPACITY_EXCEEDED");
  }
  if (catalog.lastConfirmedAt !== undefined && !Number.isFinite(Date.parse(catalog.lastConfirmedAt))) {
    throw new Error("READING_CORRUPT:CATALOG_INVALID");
  }
}

function snapshotTotals(releases: CatalogRelease[]): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const release of releases) {
    if (!Array.isArray(release.pages)) throw new Error("READING_CORRUPT:CATALOG_INVALID");
    for (const page of release.pages) {
      if (!page.snapshot) continue;
      count += 1;
      bytes += page.snapshot.bytes;
    }
  }
  return { count, bytes };
}

function withSnapshotTotals(catalog: ReplicaCatalog): ReplicaCatalog {
  const totals = snapshotTotals(catalog.releases);
  return { ...catalog, snapshotCount: totals.count, snapshotBytes: totals.bytes };
}

function draftPointer(draft: LessonDraft | undefined): DraftPointer | undefined {
  if (!draft) return undefined;
  return { id: draft.id, revision: draft.revision, contentHash: draft.contentHash, updatedAt: draft.updatedAt };
}

function sameDraftVersion(incoming: LessonDraft, current: DraftPointer | undefined): "newer" | "same" | "older" {
  if (!current) return "newer";
  if (incoming.revision > current.revision) return "newer";
  if (incoming.revision < current.revision) return "older";
  return incoming.contentHash === current.contentHash ? "same" : "older";
}

function validateCourseList(courses: CourseProject[]): CourseProject[] {
  if (!Array.isArray(courses)) throw new Error("READING_INVALID_INPUT:COURSES");
  const seen = new Set<string>();
  return courses.map((course) => {
    assertIdentifier(course?.id, "COURSE_ID");
    assertIdentifier(course.workspaceId, "WORKSPACE_ID");
    const key = pointerKey(course.workspaceId, course.id, "");
    if (seen.has(key)) throw new Error("READING_INVALID_INPUT:COURSE_DUPLICATE");
    seen.add(key);
    return jsonClone(course);
  });
}

function validateRelease(release: CourseRelease): void {
  assertIdentifier(release?.id, "RELEASE_ID");
  assertIdentifier(release.courseId, "COURSE_ID");
  if (!Number.isSafeInteger(release.version) || release.version < 0) throw new Error("READING_INVALID_INPUT:RELEASE_VERSION");
  if (!Array.isArray(release.pages) || !Array.isArray(release.pageIds) || release.pages.length !== release.pageIds.length) {
    throw new Error("READING_INVALID_INPUT:RELEASE_PAGES");
  }
  const seen = new Set<string>();
  release.pages.forEach((page, index) => {
    assertIdentifier(page?.id, "PAGE_ID");
    if (release.pageIds[index] !== page.id || seen.has(page.id)) throw new Error("READING_INVALID_INPUT:RELEASE_PAGES");
    seen.add(page.id);
  });
}

function validateDraft(draft: LessonDraft): void {
  assertIdentifier(draft?.id, "DRAFT_ID");
  assertIdentifier(draft.workspaceId, "WORKSPACE_ID");
  assertIdentifier(draft.courseId, "COURSE_ID");
  assertIdentifier(draft.sourceReleaseId, "RELEASE_ID");
  assertIdentifier(draft.pageId, "PAGE_ID");
  assertIdentifier(draft.contentHash, "DRAFT_HASH");
  if (!Number.isSafeInteger(draft.revision) || draft.revision < 0 || draft.page?.id !== draft.pageId) {
    throw new Error("READING_INVALID_INPUT:DRAFT");
  }
}

function releaseIndex(release: CourseRelease): CourseReleaseIndex {
  const index = toCourseReleaseIndex(release);
  return sanitizeReleaseIndex(index);
}

function sanitizeReleaseIndex(input: CourseReleaseIndex): CourseReleaseIndex {
  assertIdentifier(input?.id, "RELEASE_ID");
  assertIdentifier(input.courseId, "COURSE_ID");
  if (!Number.isSafeInteger(input.version) || input.version < 0 || !Array.isArray(input.pages) || !Array.isArray(input.pageIds)) {
    throw new Error("READING_INVALID_INPUT:INDEX");
  }
  const pageIds = input.pages.map((page) => page.id);
  if (new Set(pageIds).size !== pageIds.length || pageIds.some((id, index) => input.pageIds[index] !== id)
    || input.pageIds.length !== pageIds.length) throw new Error("READING_INVALID_INPUT:INDEX_PAGES");
  const index = jsonClone(input);
  // The catalog carries page labels and quality summaries, never lesson bodies,
  // assessment answers, or generation costs.
  index.costUsd = 0;
  index.assessments = [];
  index.pages = index.pages.map((page) => ({
    id: page.id,
    pageNumber: page.pageNumber,
    title: page.title,
    imageUrl: page.imageUrl,
    quality: jsonClone(page.quality),
    anchors: [],
    atoms: [],
    blocks: [],
    lessonSections: [],
    questionBank: [],
    coverageRequirements: [],
    coverageClaims: []
  }));
  return index;
}

function emptyCatalog(authorityHash: string): ReplicaCatalog {
  return {
    format: FORMAT_VERSION,
    authorityHash,
    revision: 0,
    snapshotCount: 0,
    snapshotBytes: 0,
    courses: [],
    releases: [],
    trees: [],
    trash: []
  };
}

function walkTree(nodes: CourseTreeNode[], visit: (node: CourseTreeNode) => boolean): CourseTreeNode[] {
  const result: CourseTreeNode[] = [];
  for (const node of nodes) {
    if (!visit(node)) continue;
    result.push({ ...jsonClone(node), children: walkTree(node.children ?? [], visit) });
  }
  return result;
}

export class ReadingReplica {
  private readonly replicaDir: string;
  private readonly snapshotsDir: string;
  private readonly catalogPath: string;
  private readonly rootLockKey: string;
  private readonly authorityHash: string;
  private catalog?: ReplicaCatalog;

  constructor(rootDir: string, authorityIdentity: string) {
    assertIdentifier(rootDir, "ROOT_DIR");
    assertIdentifier(authorityIdentity, "AUTHORITY_IDENTITY");
    this.replicaDir = join(resolve(rootDir), "reading-replica");
    this.snapshotsDir = join(this.replicaDir, "snapshots");
    this.catalogPath = join(this.replicaDir, "catalog.json");
    this.rootLockKey = this.replicaDir.toLowerCase();
    this.authorityHash = sha256Text(authorityIdentity);
  }

  get revision(): number {
    return this.catalog?.revision ?? 0;
  }

  async initialize(): Promise<void> {
    await withProcessLock(this.rootLockKey, async () => {
      await mkdir(this.snapshotsDir, { recursive: true });
      const persisted = await this.readCatalogFile();
      if (persisted) {
        this.catalog = persisted;
        return;
      }
      const initial = emptyCatalog(this.authorityHash);
      await this.writeCatalogFile(initial);
      this.catalog = initial;
    });
  }

  status(): ReadingReplicaStatus {
    const catalog = this.catalog;
    if (!catalog) {
      return {
        ready: false,
        revision: 0,
        courses: 0,
        pages: 0,
        releases: 0,
        snapshotBytes: 0,
        maxSnapshotCount: MAX_SNAPSHOT_COUNT,
        maxSnapshotBytes: MAX_SNAPSHOT_BYTES
      };
    }
    const hasConfirmedCatalog = this.hasConfirmedCatalog(catalog);
    return {
      ready: hasConfirmedCatalog,
      revision: catalog.revision,
      courses: catalog.courses.filter((course) => this.isCourseVisible(catalog, course.workspaceId, course.id)).length,
      pages: catalog.releases.reduce((total, release) => total + (this.isReleaseVisible(catalog, release)
        ? release.pages.filter((page) => Boolean(page.snapshot) && !this.isTombstoned(catalog, release.workspaceId, "page", page.pageId)).length
        : 0), 0),
      releases: catalog.releases.filter((release) => this.isReleaseVisible(catalog, release)).length,
      snapshotBytes: catalog.snapshotBytes,
      ...(catalog.lastConfirmedAt ? { lastConfirmedAt: catalog.lastConfirmedAt } : {}),
      maxSnapshotCount: MAX_SNAPSHOT_COUNT,
      maxSnapshotBytes: MAX_SNAPSHOT_BYTES
    };
  }

  async listCourses(workspaceId: string): Promise<CourseProject[]> {
    const catalog = this.requireReadableCatalog();
    return jsonClone(catalog.courses.filter((course) => course.workspaceId === workspaceId
      && this.isCourseVisible(catalog, workspaceId, course.id)));
  }

  async listIndexes(workspaceId: string, courseId?: string): Promise<CourseReleaseIndex[]> {
    const catalog = this.requireReadableCatalog();
    return jsonClone(catalog.releases
      .filter((release) => release.workspaceId === workspaceId && (!courseId || release.courseId === courseId)
        && this.isReleaseVisible(catalog, release))
      .map((release) => this.visibleReleaseIndex(catalog, release)));
  }

  async getReleaseIndex(workspaceId: string, releaseId: string): Promise<CourseReleaseIndex | undefined> {
    const catalog = this.requireReadableCatalog();
    const release = catalog.releases.find((item) => item.workspaceId === workspaceId && item.index.id === releaseId);
    return release && this.isReleaseVisible(catalog, release)
      ? jsonClone(this.visibleReleaseIndex(catalog, release))
      : undefined;
  }

  async getTree(workspaceId: string): Promise<WorkspaceTree | undefined> {
    const catalog = this.requireReadableCatalog();
    const tree = catalog.trees.find((item) => item.workspaceId === workspaceId);
    if (!tree) return undefined;
    const visibleNode = (node: CourseTreeNode): boolean => {
      if (node.archived || node.visibility === "archived") return false;
      if (node.kind === "course") return this.isCourseVisible(catalog, workspaceId, node.id);
      if (node.kind === "material") {
        const materialId = node.materialId ?? node.id;
        const release = catalog.releases.find((item) => item.workspaceId === workspaceId
          && (item.index.id === node.currentReleaseId || item.index.id === node.releaseId
            || materialId === `material:${item.courseId}:${item.index.moduleId}`));
        return !this.isTombstoned(catalog, workspaceId, "material", materialId)
          && Boolean(release && this.isReleaseVisible(catalog, release));
      }
      if (node.kind === "page") return !this.isTombstoned(catalog, workspaceId, "page", node.pageId ?? node.id);
      return true;
    };
    const result = jsonClone(tree);
    result.courses = walkTree(result.courses, visibleNode);
    if (result.rootMaterials) result.rootMaterials = walkTree(result.rootMaterials, visibleNode);
    return result;
  }

  async listTrash(workspaceId: string): Promise<TrashRecord[]> {
    return jsonClone(this.requireReadableCatalog().trash.filter((item) => item.workspaceId === workspaceId));
  }

  async getPageSource(workspaceId: string, pageId: string, releaseId?: string): Promise<{
    release: CourseReleaseIndex;
    page: PageLesson;
    draft?: LessonDraft;
  } | undefined> {
    const catalog = this.requireReadableCatalog();
    const candidates = catalog.releases.filter((item) => item.workspaceId === workspaceId
      && (!releaseId || item.index.id === releaseId)
      && this.isReleaseVisible(catalog, item)
      && !this.isTombstoned(catalog, workspaceId, "page", pageId)
      && item.index.pages.some((page) => page.id === pageId));
    const tree = catalog.trees.find((item) => item.workspaceId === workspaceId);
    const preferredReleaseIds = new Set<string>();
    const collectCurrent = (nodes: CourseTreeNode[]) => {
      for (const node of nodes) {
        if (node.kind === "material") {
          const id = node.currentReleaseId ?? node.releaseId;
          if (id) preferredReleaseIds.add(id);
        }
        collectCurrent(node.children ?? []);
      }
    };
    if (tree) {
      collectCurrent(tree.courses);
      collectCurrent(tree.rootMaterials ?? []);
    }
    candidates.sort((left, right) => Number(preferredReleaseIds.has(right.index.id)) - Number(preferredReleaseIds.has(left.index.id))
      || right.index.version - left.index.version
      || right.index.publishedAt.localeCompare(left.index.publishedAt));
    const selected = candidates[0];
    if (!selected) return undefined;
    const pageRef = selected.pages.find((page) => page.pageId === pageId && page.snapshot);
    if (!pageRef?.snapshot) return undefined;
    const snapshot = await this.readSnapshot(workspaceId, selected.courseId, selected.index.id, pageId, pageRef.snapshot);
    const sourcePage = selected.index.lifecycle === "draft_source"
      ? snapshot.confirmedDraft ? snapshot.page : snapshot.draft?.status === "ready" ? snapshot.draft.page : undefined
      : snapshot.page;
    if (!sourcePage) return undefined;
    const result: { release: CourseReleaseIndex; page: PageLesson; draft?: LessonDraft } = {
      release: jsonClone(this.visibleReleaseIndex(catalog, selected)),
      page: jsonClone(sourcePage)
    };
    if (snapshot.draft) result.draft = jsonClone(snapshot.draft);
    return result;
  }

  async getDraft(workspaceId: string, pageId: string, releaseId?: string): Promise<LessonDraft | undefined> {
    const catalog = this.requireReadableCatalog();
    const candidates: Array<{ release: CatalogRelease; page: SnapshotPointer }> = [];
    for (const release of catalog.releases) {
      if (release.workspaceId !== workspaceId || (releaseId && release.index.id !== releaseId)
        || !this.isReleaseVisible(catalog, release) || this.isTombstoned(catalog, workspaceId, "page", pageId)) continue;
      const page = release.pages.find((item) => item.pageId === pageId)?.snapshot;
      if (page?.draft) candidates.push({ release, page });
    }
    candidates.sort((left, right) => right.page.draft!.updatedAt.localeCompare(left.page.draft!.updatedAt)
      || right.page.draft!.revision - left.page.draft!.revision);
    const selected = candidates[0];
    if (!selected) return undefined;
    const snapshot = await this.readSnapshot(workspaceId, selected.release.courseId, selected.release.index.id, pageId, selected.page);
    return snapshot.draft ? jsonClone(snapshot.draft) : undefined;
  }

  async replace(input: ReadingReplicaInput, expectedRevision?: number): Promise<void | false> {
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw new Error("READING_INVALID_INPUT:EXPECTED_REVISION");
    }
    const committed = await this.commit(async (current) => {
      if (expectedRevision !== undefined && current.revision !== expectedRevision) return undefined;
      return this.buildReplacement(input, current);
    });
    return committed ? undefined : false;
  }

  async upsertRelease(release: CourseRelease): Promise<boolean> {
    validateRelease(release);
    return this.commit(async (current) => {
      const matchingCourses = current.courses.filter((course) => course.id === release.courseId);
      if (matchingCourses.length !== 1) return undefined;
      const course = matchingCourses[0]!;
      const old = current.releases.find((item) => item.workspaceId === course.workspaceId && item.index.id === release.id);
      if (old && (old.courseId !== course.id || release.version < old.index.version
        || (release.version === old.index.version && release.manifestHash !== old.index.manifestHash))) return undefined;
      const index = releaseIndex(release);
      const replacement = release.lifecycle === "published"
        ? await this.buildReleaseRecord(course.workspaceId, release, current, new Map(), {
          count: current.snapshotCount - (old?.pages.filter((page) => page.snapshot).length ?? 0),
          bytes: current.snapshotBytes - (old?.pages.reduce((total, page) => total + (page.snapshot?.bytes ?? 0), 0) ?? 0)
        })
        : this.buildMetadataReleaseRecord(course.workspaceId, index, current);
      if (!replacement) return undefined;
      const releases = current.releases.filter((item) => !(item.workspaceId === course.workspaceId && item.index.id === release.id));
      releases.push(replacement);
      return withSnapshotTotals({ ...current, releases });
    });
  }

  async upsertDraft(draft: LessonDraft): Promise<boolean> {
    validateDraft(draft);
    return this.commit(async (current) => {
      const release = current.releases.find((item) => item.workspaceId === draft.workspaceId && item.index.id === draft.sourceReleaseId);
      if (!release || release.courseId !== draft.courseId) return undefined;
      const pageRef = release.pages.find((item) => item.pageId === draft.pageId);
      if (!pageRef) return undefined;
      if (sameDraftVersion(draft, pageRef.snapshot?.draft) !== "newer") return undefined;
      const normalizedDraft = jsonClone(draft);
      const oldSnapshot = pageRef.snapshot
        ? await this.readSnapshot(draft.workspaceId, release.courseId, release.index.id, draft.pageId, pageRef.snapshot)
        : undefined;
      let sourcePage: PageLesson;
      let confirmedDraft: DraftPointer | undefined;
      if (release.index.lifecycle === "draft_source") {
        if (normalizedDraft.status === "ready") {
          sourcePage = jsonClone(normalizedDraft.page);
          confirmedDraft = draftPointer(normalizedDraft);
        } else if (oldSnapshot?.confirmedDraft) {
          sourcePage = jsonClone(oldSnapshot.page);
          confirmedDraft = oldSnapshot.confirmedDraft;
        } else if (oldSnapshot?.draft?.status === "ready") {
          sourcePage = jsonClone(oldSnapshot.draft.page);
          confirmedDraft = draftPointer(oldSnapshot.draft);
        } else {
          sourcePage = jsonClone(normalizedDraft.page);
        }
      } else if (oldSnapshot) {
        sourcePage = oldSnapshot.page;
      } else {
        const indexedPage = release.index.pages.find((page) => page.id === draft.pageId);
        if (!indexedPage) return undefined;
        sourcePage = jsonClone(normalizedDraft.page);
        sourcePage.pageNumber = indexedPage.pageNumber;
        sourcePage.title = indexedPage.title;
        sourcePage.imageUrl = indexedPage.imageUrl;
        sourcePage.quality = jsonClone(indexedPage.quality);
      }
      const nextSnapshot: SnapshotEnvelope = {
        format: FORMAT_VERSION,
        authorityHash: this.authorityHash,
        workspaceId: draft.workspaceId,
        courseId: release.courseId,
        releaseId: release.index.id,
        pageId: draft.pageId,
        pageHash: pageHash(sourcePage),
        page: sourcePage,
        ...(confirmedDraft ? { confirmedDraft } : {}),
        draft: normalizedDraft
      };
      const budget = {
        count: current.snapshotCount - (pageRef.snapshot ? 1 : 0),
        bytes: current.snapshotBytes - (pageRef.snapshot?.bytes ?? 0)
      };
      const stored = await this.storeSnapshot(nextSnapshot, budget);
      const pages = release.pages.map((item) => item.pageId === draft.pageId
        ? { pageId: item.pageId, snapshot: stored }
        : item);
      const releases = current.releases.map((item) => item === release ? { ...item, pages } : item);
      return withSnapshotTotals({ ...current, releases });
    });
  }

  async updateMetadata(update: ReadingReplicaMetadataUpdate, expectedRevision = update.expectedRevision): Promise<boolean> {
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw new Error("READING_INVALID_INPUT:EXPECTED_REVISION");
    }
    return this.commit(async (current) => {
      if (expectedRevision !== undefined && current.revision !== expectedRevision) return undefined;
      let courses = current.courses;
      let releases = current.releases;
      let trees = current.trees;
      let trash = current.trash;

      if (update.courses !== undefined) {
        courses = validateCourseList(update.courses);
        const courseKeys = new Set(courses.map((course) => pointerKey(course.workspaceId, course.id, "")));
        releases = releases.filter((release) => courseKeys.has(pointerKey(release.workspaceId, release.courseId, "")));
        const retainedWorkspaces = new Set(courses.map((course) => course.workspaceId));
        if (update.tree) retainedWorkspaces.add(update.tree.workspaceId);
        if (update.trash) for (const record of update.trash) retainedWorkspaces.add(record.workspaceId);
        trees = trees.filter((tree) => retainedWorkspaces.has(tree.workspaceId));
        trash = trash.filter((record) => retainedWorkspaces.has(record.workspaceId));
      }
      if (update.indexes !== undefined) {
        if (!Array.isArray(update.indexes)) throw new Error("READING_INVALID_INPUT:INDEXES");
        const replacements: CatalogRelease[] = [];
        const seen = new Set<string>();
        for (const incoming of update.indexes) {
          const index = sanitizeReleaseIndex(incoming);
          const matchingCourses = courses.filter((course) => course.id === index.courseId);
          if (matchingCourses.length === 0) continue;
          if (matchingCourses.length !== 1) throw new Error("READING_INVALID_INPUT:RELEASE_COURSE_SCOPE");
          const course = matchingCourses[0]!;
          const key = pointerKey(course.workspaceId, index.id, "");
          if (seen.has(key)) throw new Error("READING_INVALID_INPUT:RELEASE_DUPLICATE");
          seen.add(key);
          const old = current.releases.find((item) => item.workspaceId === course.workspaceId && item.index.id === index.id);
          if (old && old.courseId !== course.id) return undefined;
          if (old && (old.index.version > index.version
            || (old.index.version === index.version && old.index.manifestHash !== index.manifestHash))) {
            replacements.push(old);
            continue;
          }
          const sameReleaseScope = old?.courseId === course.id;
          const previousPages = new Map((sameReleaseScope ? old?.pages ?? [] : []).map((page) => [page.pageId, page.snapshot]));
          replacements.push({
            workspaceId: course.workspaceId,
            courseId: course.id,
            index,
            pages: index.pages.map((page) => ({
              pageId: page.id,
              ...(previousPages.get(page.id) ? { snapshot: previousPages.get(page.id)! } : {})
            }))
          });
        }
        releases = replacements;
      }
      if (update.tree !== undefined) {
        assertIdentifier(update.tree.workspaceId, "WORKSPACE_ID");
        const normalizedTree = jsonClone(update.tree);
        trees = [...trees.filter((tree) => tree.workspaceId !== normalizedTree.workspaceId), normalizedTree];
      }
      if (update.trash !== undefined) {
        if (!Array.isArray(update.trash)) throw new Error("READING_INVALID_INPUT:TRASH");
        trash = update.trash.map((record) => {
          assertIdentifier(record?.workspaceId, "WORKSPACE_ID");
          return jsonClone(record);
        });
      }
      return withSnapshotTotals({ ...current, courses, releases, trees, trash });
    });
  }

  private isTombstoned(catalog: ReplicaCatalog, workspaceId: string, kind: TrashRecord["nodeKind"], nodeId: string): boolean {
    return catalog.trash.some((record) => record.workspaceId === workspaceId && record.nodeKind === kind
      && (record.restoreAvailable || record.permanentDeleteRequested)
      && (record.nodeId === nodeId || (kind === "page" && record.nodeId === `page:${nodeId}`)));
  }

  private isCourseVisible(catalog: ReplicaCatalog, workspaceId: string, courseId: string): boolean {
    const course = catalog.courses.find((item) => item.workspaceId === workspaceId && item.id === courseId);
    if (!course || isRegressionAsset(course.id, course.title)
      || course.status === "archived" || Boolean(course.archivedAt)
      || this.isTombstoned(catalog, workspaceId, "course", courseId)) return false;
    const courseNode = catalog.trees.find((tree) => tree.workspaceId === workspaceId)?.courses
      .find((node) => node.kind === "course" && node.id === courseId);
    return !courseNode?.archived && courseNode?.visibility !== "archived";
  }

  private isReleaseVisible(catalog: ReplicaCatalog, release: CatalogRelease): boolean {
    if (isRegressionAsset(release.index.id, `${release.index.courseTitle} ${release.index.moduleTitle}`)
      || !this.isCourseVisible(catalog, release.workspaceId, release.courseId)
      || this.isTombstoned(catalog, release.workspaceId, "release", release.index.id)) return false;
    const materialId = `material:${release.courseId}:${release.index.moduleId}`;
    if (this.isTombstoned(catalog, release.workspaceId, "material", materialId)) return false;
    const tree = catalog.trees.find((item) => item.workspaceId === release.workspaceId);
    const material = tree?.courses.flatMap((node) => [node, ...(node.children ?? [])])
      .concat(tree.rootMaterials ?? [])
      .find((node) => node.kind === "material" && (node.id === materialId || node.materialId === materialId));
    return !material?.archived && material?.visibility !== "archived";
  }

  private visibleReleaseIndex(catalog: ReplicaCatalog, release: CatalogRelease): CourseReleaseIndex {
    const pages = release.index.pages.filter((page) => !this.isTombstoned(catalog, release.workspaceId, "page", page.id));
    return { ...jsonClone(release.index), pages, pageIds: pages.map((page) => page.id) };
  }

  private buildMetadataReleaseRecord(workspaceId: string, index: CourseReleaseIndex, current: ReplicaCatalog): CatalogRelease {
    const old = current.releases.find((item) => item.workspaceId === workspaceId && item.index.id === index.id);
    const oldPages = new Map((old?.courseId === index.courseId ? old.pages : []).map((page) => [page.pageId, page.snapshot]));
    return {
      workspaceId,
      courseId: index.courseId,
      index,
      pages: index.pages.map((page) => ({
        pageId: page.id,
        ...(oldPages.get(page.id) ? { snapshot: oldPages.get(page.id)! } : {})
      }))
    };
  }

  private requireCatalog(): ReplicaCatalog {
    if (!this.catalog) throw new Error("READING_NOT_READY");
    return this.catalog;
  }

  private requireReadableCatalog(): ReplicaCatalog {
    const catalog = this.requireCatalog();
    if (!this.hasConfirmedCatalog(catalog)) throw new Error("READING_NOT_READY");
    return catalog;
  }

  private hasConfirmedCatalog(catalog: ReplicaCatalog): boolean {
    return Boolean(catalog.lastConfirmedAt && Number.isFinite(Date.parse(catalog.lastConfirmedAt))
      && (catalog.courses.length > 0 || catalog.releases.length > 0));
  }

  private async commit(build: (current: ReplicaCatalog) => Promise<ReplicaCatalog | undefined>): Promise<boolean> {
    this.requireCatalog();
    return withProcessLock(this.rootLockKey, async () => {
      const current = await this.readCatalogFile();
      if (!current) throw new Error("READING_CORRUPT:CATALOG_MISSING");
      this.catalog = current;
      try {
        const proposed = await build(current);
        if (!proposed) {
          await this.cleanupUnreferenced(current).catch(() => undefined);
          return false;
        }
        const next = withSnapshotTotals({ ...proposed, revision: current.revision + 1, authorityHash: this.authorityHash, lastConfirmedAt: new Date().toISOString() });
        assertCatalog(next, this.authorityHash);
        await this.writeCatalogFile(next);
        this.catalog = next;
        await this.cleanupUnreferenced(next).catch(() => undefined);
        return true;
      } catch (error) {
        const persisted = await this.readCatalogFile().catch(() => undefined);
        await this.cleanupUnreferenced(persisted ?? current).catch(() => undefined);
        throw error;
      }
    });
  }

  private async buildReplacement(input: ReadingReplicaInput, current: ReplicaCatalog): Promise<ReplicaCatalog | undefined> {
    if (!input || !Array.isArray(input.releases) || !Array.isArray(input.drafts) || !Array.isArray(input.trash)) {
      throw new Error("READING_INVALID_INPUT:REPLACEMENT");
    }
    const courses = validateCourseList(input.courses);
    assertIdentifier(input.tree?.workspaceId, "WORKSPACE_ID");
    const tree = jsonClone(input.tree);
    const trash = input.trash.map((record) => {
      assertIdentifier(record?.workspaceId, "WORKSPACE_ID");
      return jsonClone(record);
    });

    const coursesById = new Map<string, CourseProject[]>();
    for (const course of courses) coursesById.set(course.id, [...(coursesById.get(course.id) ?? []), course]);
    const seenReleases = new Set<string>();
    const releaseCourses = new Map<CourseRelease, CourseProject>();
    for (const release of input.releases) {
      validateRelease(release);
      const matching = coursesById.get(release.courseId) ?? [];
      if (matching.length !== 1) throw new Error("READING_INVALID_INPUT:RELEASE_COURSE_SCOPE");
      const course = matching[0]!;
      const key = pointerKey(course.workspaceId, release.id, "");
      if (seenReleases.has(key)) throw new Error("READING_INVALID_INPUT:RELEASE_DUPLICATE");
      seenReleases.add(key);
      releaseCourses.set(release, course);

      const prior = current.releases.find((item) => item.workspaceId === course.workspaceId && item.index.id === release.id);
      if (prior && (release.version < prior.index.version
        || (release.version === prior.index.version && release.manifestHash !== prior.index.manifestHash))) return undefined;
    }

    const draftsByPage = new Map<string, LessonDraft>();
    for (const draft of input.drafts) {
      validateDraft(draft);
      const key = pointerKey(draft.workspaceId, draft.sourceReleaseId, draft.pageId);
      if (draftsByPage.has(key)) throw new Error("READING_INVALID_INPUT:DRAFT_DUPLICATE");
      const source = input.releases.find((release) => release.id === draft.sourceReleaseId && release.courseId === draft.courseId);
      const sourceCourse = source ? releaseCourses.get(source) : undefined;
      if (!source || sourceCourse?.workspaceId !== draft.workspaceId || !source.pages.some((page) => page.id === draft.pageId)) {
        throw new Error("READING_INVALID_INPUT:DRAFT_SOURCE");
      }
      draftsByPage.set(key, draft);
    }

    if (input.releases.reduce((total, release) => total + release.pages.length, 0) > MAX_SNAPSHOT_COUNT) {
      throw new Error("READING_CAPACITY_EXCEEDED");
    }

    const releases: CatalogRelease[] = [];
    const snapshotBudget: SnapshotBudget = { count: 0, bytes: 0 };
    for (const release of input.releases) {
      const course = releaseCourses.get(release)!;
      const built = await this.buildReleaseRecord(course.workspaceId, release, current, draftsByPage, snapshotBudget);
      if (!built) return undefined;
      releases.push(built);
    }
    return withSnapshotTotals({
      ...current,
      courses,
      releases,
      trees: [tree],
      trash
    });
  }

  private async buildReleaseRecord(
    workspaceId: string,
    release: CourseRelease,
    current: ReplicaCatalog,
    draftsByPage: Map<string, LessonDraft>,
    budget: SnapshotBudget
  ): Promise<CatalogRelease | undefined> {
    const oldRelease = current.releases.find((item) => item.workspaceId === workspaceId && item.index.id === release.id);
    if (oldRelease && (release.version < oldRelease.index.version
      || (release.version === oldRelease.index.version && release.manifestHash !== oldRelease.index.manifestHash))) return undefined;
    if (oldRelease && oldRelease.courseId !== release.courseId) return undefined;

    const pages: CatalogRelease["pages"] = [];
    const index = releaseIndex(release);
    for (const rawPage of release.pages) {
      const incomingPage = jsonClone(rawPage);
      const oldPage = oldRelease?.pages.find((item) => item.pageId === incomingPage.id);
      const draftKey = pointerKey(workspaceId, release.id, incomingPage.id);
      let selectedDraft = draftsByPage.get(draftKey);
      let oldSnapshot: SnapshotEnvelope | undefined;
      if (oldPage?.snapshot && (release.lifecycle === "draft_source" || !hasConfirmedPageBody(incomingPage) || oldPage.snapshot.draft)) {
        oldSnapshot = await this.readSnapshot(workspaceId, release.courseId, release.id, incomingPage.id, oldPage.snapshot);
        const existingDraft = oldSnapshot.draft;
        if (existingDraft && (!selectedDraft || sameDraftVersion(selectedDraft, oldPage.snapshot.draft) !== "newer")) selectedDraft = existingDraft;
      }

      // Index placeholders may be materialized during a refresh. Keep the
      // already-confirmed immutable page until a full page or newer saved draft arrives.
      if (release.lifecycle !== "draft_source" && !hasConfirmedPageBody(incomingPage) && oldPage?.snapshot) {
        if (!selectedDraft || oldPage.snapshot.draft && sameDraftVersion(selectedDraft, oldPage.snapshot.draft) !== "newer") {
          this.includeSnapshotBudget(budget, oldPage.snapshot);
          pages.push({ pageId: incomingPage.id, snapshot: oldPage.snapshot });
          continue;
        }
      }
      if (selectedDraft) {
        validateDraft(selectedDraft);
        if (selectedDraft.workspaceId !== workspaceId || selectedDraft.sourceReleaseId !== release.id
          || selectedDraft.courseId !== release.courseId || selectedDraft.pageId !== incomingPage.id) {
          throw new Error("READING_INVALID_INPUT:DRAFT_SOURCE");
        }
        selectedDraft = jsonClone(selectedDraft);
      }

      if (release.lifecycle === "draft_source") {
        let page: PageLesson | undefined;
        let confirmedDraft: DraftPointer | undefined;
        if (selectedDraft?.status === "ready") {
          page = jsonClone(selectedDraft.page);
          confirmedDraft = draftPointer(selectedDraft);
        } else if (oldSnapshot?.confirmedDraft) {
          page = jsonClone(oldSnapshot.page);
          confirmedDraft = oldSnapshot.confirmedDraft;
        } else if (oldSnapshot?.draft?.status === "ready") {
          page = jsonClone(oldSnapshot.draft.page);
          confirmedDraft = draftPointer(oldSnapshot.draft);
        } else if (selectedDraft) {
          // Keep unready drafts available through getDraft without treating them as lecture source.
          page = jsonClone(selectedDraft.page);
        }
        if (!page) {
          pages.push({ pageId: incomingPage.id });
          continue;
        }
        const envelope: SnapshotEnvelope = {
          format: FORMAT_VERSION,
          authorityHash: this.authorityHash,
          workspaceId,
          courseId: release.courseId,
          releaseId: release.id,
          pageId: page.id,
          pageHash: pageHash(page),
          page,
          ...(confirmedDraft ? { confirmedDraft } : {}),
          ...(selectedDraft ? { draft: selectedDraft } : {})
        };
        pages.push({ pageId: page.id, snapshot: await this.storeSnapshot(envelope, budget) });
        continue;
      }

      if (!hasConfirmedPageBody(incomingPage) && !oldPage?.snapshot && !selectedDraft) {
        pages.push({ pageId: incomingPage.id });
        continue;
      }
      const page = !hasConfirmedPageBody(incomingPage) && !oldSnapshot && selectedDraft
        ? jsonClone(selectedDraft.page)
        : !hasConfirmedPageBody(incomingPage) && oldSnapshot
          ? jsonClone(oldSnapshot.page)
          : incomingPage;
      const hash = pageHash(page);
      if (oldRelease && oldRelease.index.manifestHash === release.manifestHash && oldPage?.snapshot
        && hasConfirmedPageBody(incomingPage) && oldPage.snapshot.pageHash !== hash) return undefined;
      const envelope: SnapshotEnvelope = {
        format: FORMAT_VERSION,
        authorityHash: this.authorityHash,
        workspaceId,
        courseId: release.courseId,
        releaseId: release.id,
        pageId: page.id,
        pageHash: hash,
        page,
        ...(selectedDraft ? { draft: selectedDraft } : {})
      };
      pages.push({ pageId: page.id, snapshot: await this.storeSnapshot(envelope, budget) });
    }
    return { workspaceId, courseId: release.courseId, index, pages };
  }

  private async storeSnapshot(envelope: SnapshotEnvelope, budget?: SnapshotBudget): Promise<SnapshotPointer> {
    const normalized = jsonClone(envelope);
    const bytes = Buffer.from(`${JSON.stringify(normalized)}\n`, "utf8");
    const hash = snapshotHash(bytes);
    if (budget && (budget.count + 1 > MAX_SNAPSHOT_COUNT || budget.bytes + bytes.byteLength > MAX_SNAPSHOT_BYTES)) {
      throw new Error("READING_CAPACITY_EXCEEDED");
    }
    const path = join(this.snapshotsDir, `${hash}.json`);
    await mkdir(dirname(path), { recursive: true });
    try {
      const existing = await readFile(path);
      if (snapshotHash(existing) !== hash) throw new Error("READING_CORRUPT:SNAPSHOT_HASH_MISMATCH");
      if (budget) { budget.count += 1; budget.bytes += existing.byteLength; }
      return this.snapshotPointer(normalized, hash, existing.byteLength);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const temporaryPath = `${path}.${cryptoRandomSuffix()}.tmp`;
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      try {
        const existing = await readFile(path);
        if (snapshotHash(existing) !== hash) throw new Error("READING_CORRUPT:SNAPSHOT_HASH_MISMATCH");
        if (budget) { budget.count += 1; budget.bytes += existing.byteLength; }
        return this.snapshotPointer(normalized, hash, existing.byteLength);
      } catch {
        throw error;
      }
    }
    if (budget) { budget.count += 1; budget.bytes += bytes.byteLength; }
    return this.snapshotPointer(normalized, hash, bytes.byteLength);
  }

  private includeSnapshotBudget(budget: SnapshotBudget, pointer: SnapshotPointer): void {
    if (budget.count + 1 > MAX_SNAPSHOT_COUNT || budget.bytes + pointer.bytes > MAX_SNAPSHOT_BYTES) {
      throw new Error("READING_CAPACITY_EXCEEDED");
    }
    budget.count += 1;
    budget.bytes += pointer.bytes;
  }

  private snapshotPointer(envelope: SnapshotEnvelope, hash: string, bytes: number): SnapshotPointer {
    return {
      snapshotHash: hash,
      bytes,
      pageHash: envelope.pageHash,
      ...(envelope.draft ? { draft: draftPointer(envelope.draft)! } : {})
    };
  }

  private async readSnapshot(workspaceId: string, courseId: string, releaseId: string, pageId: string, pointer: SnapshotPointer): Promise<SnapshotEnvelope> {
    if (!/^[a-f0-9]{64}$/.test(pointer.snapshotHash)) throw new Error("READING_CORRUPT:SNAPSHOT_POINTER_INVALID");
    let bytes: Buffer;
    try {
      bytes = await readFile(join(this.snapshotsDir, `${pointer.snapshotHash}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("READING_CORRUPT:SNAPSHOT_MISSING");
      throw error;
    }
    if (bytes.byteLength !== pointer.bytes || snapshotHash(bytes) !== pointer.snapshotHash) {
      throw new Error("READING_CORRUPT:SNAPSHOT_HASH_MISMATCH");
    }
    let envelope: SnapshotEnvelope;
    try {
      envelope = JSON.parse(bytes.toString("utf8")) as SnapshotEnvelope;
    } catch {
      throw new Error("READING_CORRUPT:SNAPSHOT_INVALID");
    }
    if (envelope.format !== FORMAT_VERSION || envelope.authorityHash !== this.authorityHash) {
      throw new Error(envelope.authorityHash !== this.authorityHash ? "READING_AUTHORITY_MISMATCH" : "READING_CORRUPT:SNAPSHOT_INVALID");
    }
    if (envelope.workspaceId !== workspaceId || envelope.courseId !== courseId || envelope.releaseId !== releaseId || envelope.pageId !== pageId
      || envelope.page?.id !== pageId || envelope.pageHash !== pointer.pageHash || pageHash(envelope.page) !== pointer.pageHash) {
      throw new Error("READING_CORRUPT:SNAPSHOT_SCOPE_OR_CONTENT_MISMATCH");
    }
    if (Boolean(envelope.draft) !== Boolean(pointer.draft)) throw new Error("READING_CORRUPT:SNAPSHOT_DRAFT_MISMATCH");
    if (envelope.draft) {
      validateDraft(envelope.draft);
      const expected = pointer.draft;
      if (envelope.draft.workspaceId !== workspaceId || envelope.draft.sourceReleaseId !== releaseId
        || envelope.draft.pageId !== pageId || !expected || envelope.draft.id !== expected.id
        || envelope.draft.revision !== expected.revision || envelope.draft.contentHash !== expected.contentHash
        || envelope.draft.updatedAt !== expected.updatedAt) {
        throw new Error("READING_CORRUPT:SNAPSHOT_DRAFT_MISMATCH");
      }
    }
    if (envelope.confirmedDraft) {
      const confirmed = envelope.confirmedDraft;
      if (!confirmed.id || !Number.isSafeInteger(confirmed.revision) || confirmed.revision < 0
        || !confirmed.contentHash || !Number.isFinite(Date.parse(confirmed.updatedAt))) {
        throw new Error("READING_CORRUPT:SNAPSHOT_CONFIRMED_DRAFT_INVALID");
      }
      if (envelope.draft?.status === "ready" && envelope.draft.revision === confirmed.revision
        && (envelope.draft.id !== confirmed.id || envelope.draft.contentHash !== confirmed.contentHash
          || envelope.draft.updatedAt !== confirmed.updatedAt)) {
        throw new Error("READING_CORRUPT:SNAPSHOT_CONFIRMED_DRAFT_MISMATCH");
      }
    }
    return envelope;
  }

  private async readCatalogFile(): Promise<ReplicaCatalog | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.catalogPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let file: CatalogFile;
    try {
      file = JSON.parse(raw) as CatalogFile;
    } catch {
      throw new Error("READING_CORRUPT:CATALOG_INVALID");
    }
    if (!file?.payload || typeof file.sha256 !== "string"
      || sha256Text(stableStringify(file.payload)) !== file.sha256) throw new Error("READING_CORRUPT:CATALOG_HASH_MISMATCH");
    assertCatalog(file.payload, this.authorityHash);
    return file.payload;
  }

  private async writeCatalogFile(catalog: ReplicaCatalog): Promise<void> {
    const payload = jsonClone(catalog);
    const file: CatalogFile = { payload, sha256: sha256Text(stableStringify(payload)) };
    await writeJsonAtomic(this.catalogPath, file);
  }

  private async cleanupUnreferenced(catalog: ReplicaCatalog): Promise<void> {
    const referenced = new Set<string>();
    for (const release of catalog.releases) {
      for (const page of release.pages) {
        if (page.snapshot) referenced.add(`${page.snapshot.snapshotHash}.json`);
      }
    }
    let entries;
    try {
      entries = await readdir(this.snapshotsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name) || referenced.has(entry.name)) continue;
      await unlink(join(this.snapshotsDir, entry.name)).catch(() => undefined);
    }
  }
}

function cryptoRandomSuffix(): string {
  return randomUUID();
}
