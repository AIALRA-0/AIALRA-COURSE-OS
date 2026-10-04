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
  invalidations?: ReadingProjectionInvalidation[];
  materialReleaseSelections?: Record<string, ReadingMaterialReleaseSelection>;
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
  materialReleaseSelectionUpserts?: ReadingMaterialReleaseSelectionUpsert[];
}

export interface ReadingReplicaMetadataUpdate {
  expectedRevision?: number;
  courses?: CourseProject[];
  indexes?: CourseReleaseIndex[];
  tree?: WorkspaceTree;
  trash?: TrashRecord[];
  courseUpserts?: CourseProject[];
  treeNodeUpserts?: Array<{ workspaceId: string; node: CourseTreeNode }>;
  treeNodeRemovals?: Array<{ workspaceId: string; nodeId: string }>;
  trashUpserts?: TrashRecord[];
  trashRemovals?: Array<{ workspaceId: string; trashId: string }>;
  materialReleaseSelectionUpserts?: ReadingMaterialReleaseSelectionUpsert[];
  clearInvalidations?: string[];
  clearInvalidationConfirmations?: ReadingProjectionInvalidation[];
}

export interface ReadingMaterialReleaseSelection {
  releaseId: string;
  source: "derived" | "explicit";
}

export interface ReadingMaterialReleaseSelectionUpsert {
  workspaceId: string;
  materialId: string;
  selection: ReadingMaterialReleaseSelection;
}

export interface ReadingProjectionInvalidation {
  id: string;
  workspaceId: string;
  targetKind: "course" | "material" | "release" | "page" | "node";
  targetId: string;
  reason: "draft" | "tree" | "trashed" | "restored" | "release-removed" | "permanent-delete";
  revision?: number;
  previousRevision?: number;
  rejected?: boolean;
  expectedArchived?: boolean;
  expectedCurrentReleaseId?: string;
  trashId?: string;
  deletedAt?: string;
}

export function readingProjectionInvalidationId(workspaceId: string, targetKind: ReadingProjectionInvalidation["targetKind"], targetId: string): string {
  return `${workspaceId}\u0000${targetKind}\u0000${targetId}`;
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

export type ReadingMediaVisibility = "confirmed" | "blocked" | "unindexed";

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

function imageMediaHash(imageUrl: string): string | undefined {
  const path = imageUrl.split(/[?#]/u, 1)[0] ?? "";
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2 || segments.at(-2) !== "media") return undefined;
  try { return decodeURIComponent(segments.at(-1)!); }
  catch { return undefined; }
}

function assertIdentifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`READING_INVALID_INPUT:${name}`);
}

function applyMaterialReleaseSelectionUpserts(
  current: Record<string, ReadingMaterialReleaseSelection> | undefined,
  upserts: ReadingMaterialReleaseSelectionUpsert[] = []
): Record<string, ReadingMaterialReleaseSelection> {
  let selections = current ?? {};
  for (const item of upserts) {
    assertIdentifier(item?.workspaceId, "WORKSPACE_ID");
    assertIdentifier(item?.materialId, "MATERIAL_ID");
    assertIdentifier(item?.selection?.releaseId, "RELEASE_ID");
    if (item.selection.source !== "derived" && item.selection.source !== "explicit") {
      throw new Error("READING_INVALID_INPUT:MATERIAL_RELEASE_SELECTION");
    }
    selections = {
      ...selections,
      [pointerKey(item.workspaceId, item.materialId, "")]: jsonClone(item.selection)
    };
  }
  return selections;
}

function assertCatalog(catalog: ReplicaCatalog, authorityHash: string): void {
  if (!catalog || catalog.format !== FORMAT_VERSION || !Number.isSafeInteger(catalog.revision) || catalog.revision < 0) {
    throw new Error("READING_CORRUPT:CATALOG_INVALID");
  }
  if (catalog.authorityHash !== authorityHash) throw new Error("READING_AUTHORITY_MISMATCH");
  if (!Array.isArray(catalog.courses) || !Array.isArray(catalog.releases) || !Array.isArray(catalog.trees) || !Array.isArray(catalog.trash)) {
    throw new Error("READING_CORRUPT:CATALOG_INVALID");
  }
  if (catalog.invalidations !== undefined && (!Array.isArray(catalog.invalidations)
    || catalog.invalidations.some((item) => !item || typeof item.id !== "string" || typeof item.workspaceId !== "string"
      || typeof item.targetId !== "string" || !["course", "material", "release", "page", "node"].includes(item.targetKind)))) {
    throw new Error("READING_CORRUPT:CATALOG_INVALID");
  }
  if (catalog.materialReleaseSelections !== undefined && (!catalog.materialReleaseSelections
    || typeof catalog.materialReleaseSelections !== "object" || Array.isArray(catalog.materialReleaseSelections)
    || Object.values(catalog.materialReleaseSelections).some((selection) => !selection
      || typeof selection.releaseId !== "string" || !["derived", "explicit"].includes(selection.source)))) {
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
  return { ...catalog, snapshotCount: totals.count, snapshotBytes: totals.bytes, invalidations: catalog.invalidations ?? [] };
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
    trash: [],
    invalidations: [],
    materialReleaseSelections: {}
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

function emptyWorkspaceTree(workspaceId: string): WorkspaceTree {
  return {
    workspaceId,
    title: "Course OS 课程空间",
    treeVersion: "2.4.0",
    courses: [],
    rootMaterials: [],
    trash: { id: `workspace:${workspaceId}:trash`, kind: "trash", title: "回收站", children: [] },
    updatedAt: new Date().toISOString()
  };
}

function takeTreeNode(nodes: CourseTreeNode[], nodeId: string): CourseTreeNode | undefined {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.id === nodeId || (node.kind === "material" && node.materialId === nodeId)) {
      nodes.splice(index, 1);
      return node;
    }
    const nested = takeTreeNode(node.children ?? [], nodeId);
    if (nested) return nested;
  }
  return undefined;
}

function removeTreeNode(tree: WorkspaceTree, nodeId: string): void {
  takeTreeNode(tree.courses, nodeId);
  takeTreeNode(tree.rootMaterials ?? [], nodeId);
}

function appendToTreeNode(nodes: CourseTreeNode[], parentId: string, child: CourseTreeNode): boolean {
  for (const node of nodes) {
    if (node.id === parentId || node.materialId === parentId) {
      node.children = [...(node.children ?? []), child];
      return true;
    }
    if (appendToTreeNode(node.children ?? [], parentId, child)) return true;
  }
  return false;
}

function upsertTreeNode(tree: WorkspaceTree, incoming: CourseTreeNode): boolean {
  const old = takeTreeNode(tree.courses, incoming.id) ?? takeTreeNode(tree.rootMaterials ?? [], incoming.id)
    ?? (incoming.materialId ? takeTreeNode(tree.courses, incoming.materialId) ?? takeTreeNode(tree.rootMaterials ?? [], incoming.materialId) : undefined);
  const node: CourseTreeNode = {
    ...(old ?? {} as CourseTreeNode),
    ...jsonClone(incoming),
    children: incoming.children?.length ? jsonClone(incoming.children) : old?.children ?? []
  };
  if (node.kind === "course") {
    tree.courses = [...tree.courses, node];
    return true;
  }
  if (node.parentId) {
    const virtualParent = /^material:([^:]+):current$/u.exec(node.parentId);
    const parentId = virtualParent?.[1] ?? node.parentId;
    if (!appendToTreeNode(tree.courses, parentId, node) && !appendToTreeNode(tree.rootMaterials ?? [], parentId, node)) return false;
    return true;
  }
  if (node.kind === "material") {
    tree.rootMaterials = [...(tree.rootMaterials ?? []), node];
    return true;
  }
  tree.courses = [...tree.courses, node];
  return true;
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
        ? release.pages.filter((page) => Boolean(page.snapshot) && !this.isTombstoned(catalog, release.workspaceId, "page", page.pageId)
          && !this.isProjectionInvalidated(catalog, release.workspaceId, "page", page.pageId)).length
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

  getMediaVisibility(workspaceId: string, hash: string): ReadingMediaVisibility {
    const catalog = this.requireCatalog();
    let indexedOwner = false;
    for (const release of catalog.releases) {
      if (release.workspaceId !== workspaceId) continue;
      for (const page of release.index.pages) {
        if (imageMediaHash(page.imageUrl) !== hash) continue;
        indexedOwner = true;
        if (this.isReleaseVisible(catalog, release)
          && !this.isTombstoned(catalog, workspaceId, "page", page.id)
          && !this.isProjectionInvalidated(catalog, workspaceId, "page", page.id)
          && !this.isPageArchived(catalog, workspaceId, page.id)) return "confirmed";
      }
    }
    return indexedOwner ? "blocked" : "unindexed";
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
      if (this.isNodeProjectionInvalidated(catalog, workspaceId, node)) return false;
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

  projectionInvalidations(workspaceId?: string): ReadingProjectionInvalidation[] {
    const catalog = this.catalog;
    if (!catalog) return [];
    return jsonClone((catalog.invalidations ?? []).filter((item) => !workspaceId || item.workspaceId === workspaceId));
  }

  async invalidateProjection(invalidation: ReadingProjectionInvalidation): Promise<void> {
    assertIdentifier(invalidation?.workspaceId, "WORKSPACE_ID");
    assertIdentifier(invalidation?.targetId, "INVALIDATION_TARGET");
    if (invalidation.id !== readingProjectionInvalidationId(invalidation.workspaceId, invalidation.targetKind, invalidation.targetId)
      || (invalidation.revision !== undefined && (!Number.isSafeInteger(invalidation.revision) || invalidation.revision < 0))) {
      throw new Error("READING_INVALID_INPUT:PROJECTION_INVALIDATION");
    }
    await this.commit(async (current) => {
      const invalidations = current.invalidations ?? [];
      const existing = invalidations.find((item) => item.id === invalidation.id);
      if (existing && existing.revision !== undefined && invalidation.revision !== undefined
        && existing.revision > invalidation.revision) return current;
      return {
        ...current,
        invalidations: [...invalidations.filter((item) => item.id !== invalidation.id), jsonClone(invalidation)]
      };
    });
  }

  async clearProjectionInvalidations(ids: string[], confirmations?: ReadingProjectionInvalidation[]): Promise<void> {
    const clear = new Set(ids);
    if (!clear.size) return;
    await this.commit(async (current) => ({
      ...current,
      invalidations: (current.invalidations ?? []).filter((item) => !clear.has(item.id)
        || confirmations !== undefined && !confirmations.some(value => JSON.stringify(value) === JSON.stringify(item)))
    }));
  }

  async markProjectionRejected(id: string, confirmation?: ReadingProjectionInvalidation): Promise<void> {
    await this.commit(async (current) => ({
      ...current,
      invalidations: (current.invalidations ?? []).map((item) => item.id === id
        && (confirmation === undefined || JSON.stringify(item) === JSON.stringify(confirmation))
        ? { ...item, rejected: true }
        : item)
    }));
  }

  getCourse(workspaceId: string, courseId: string): CourseProject | undefined {
    const course = this.requireCatalog().courses.find((item) => item.workspaceId === workspaceId && item.id === courseId);
    return course ? jsonClone(course) : undefined;
  }

  getTrashRecord(workspaceId: string, trashId: string): TrashRecord | undefined {
    const record = this.requireCatalog().trash.find((item) => item.workspaceId === workspaceId && item.id === trashId);
    return record ? jsonClone(record) : undefined;
  }

  getCachedReleaseIndex(workspaceId: string, releaseId: string): CourseReleaseIndex | undefined {
    const release = this.requireCatalog().releases.find((item) => item.workspaceId === workspaceId && item.index.id === releaseId);
    return release ? jsonClone(release.index) : undefined;
  }

  getTreeNode(workspaceId: string, nodeId: string): CourseTreeNode | undefined {
    const tree = this.requireCatalog().trees.find((item) => item.workspaceId === workspaceId);
    if (!tree) return undefined;
    const find = (nodes: CourseTreeNode[]): CourseTreeNode | undefined => {
      for (const node of nodes) {
        if (node.id === nodeId || node.materialId === nodeId) return node;
        const nested = find(node.children ?? []);
        if (nested) return nested;
      }
      return undefined;
    };
    const node = find(tree.courses) ?? find(tree.rootMaterials ?? []);
    return node ? jsonClone(node) : undefined;
  }

  getMaterialReleaseSelection(workspaceId: string, materialId: string): ReadingMaterialReleaseSelection | undefined {
    const selection = this.requireCatalog().materialReleaseSelections?.[pointerKey(workspaceId, materialId, "")];
    return selection ? jsonClone(selection) : undefined;
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
      && !this.isProjectionInvalidated(catalog, workspaceId, "page", pageId)
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
        || !this.isReleaseVisible(catalog, release) || this.isTombstoned(catalog, workspaceId, "page", pageId)
        || this.isProjectionInvalidated(catalog, workspaceId, "page", pageId)) continue;
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

  async replace(input: ReadingReplicaInput, expectedRevision?: number, clearInvalidations: string[] = []): Promise<void | false> {
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw new Error("READING_INVALID_INPUT:EXPECTED_REVISION");
    }
    const committed = await this.commit(async (current) => {
      if (expectedRevision !== undefined && current.revision !== expectedRevision) return undefined;
      const replacement = await this.buildReplacement(input, current);
      if (!replacement) return undefined;
      const clear = new Set(clearInvalidations);
      return { ...replacement, invalidations: (current.invalidations ?? []).filter((item) => !clear.has(item.id)) };
    });
    return committed ? undefined : false;
  }

  async upsertRelease(release: CourseRelease, clearInvalidations: string[] = []): Promise<boolean> {
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
      const clear = new Set(clearInvalidations);
      return withSnapshotTotals({ ...current, releases,
        invalidations: (current.invalidations ?? []).filter((item) => !clear.has(item.id)) });
    });
  }

  async upsertDraft(draft: LessonDraft, clearInvalidations: string[] = []): Promise<boolean> {
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
      const clear = new Set(clearInvalidations);
      return withSnapshotTotals({ ...current, releases,
        invalidations: (current.invalidations ?? []).filter((item) => !clear.has(item.id)
          || item.reason !== "draft" || (item.revision ?? 0) > draft.revision) });
    });
  }

  async updateMetadata(update: ReadingReplicaMetadataUpdate, expectedRevision = update.expectedRevision): Promise<boolean> {
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw new Error("READING_INVALID_INPUT:EXPECTED_REVISION");
    }
    return this.commit(async (current) => {
      if (expectedRevision !== undefined && current.revision !== expectedRevision) return undefined;
      // Authority callbacks can complete out of order. Reject the whole stale
      // projection before updating its course, version selection or protection.
      const findNode = (nodes: CourseTreeNode[], id: string): CourseTreeNode | undefined => {
        for (const node of nodes) {
          if (node.id === id || node.materialId === id) return node;
          const found = findNode(node.children ?? [], id);
          if (found) return found;
        }
        return undefined;
      };
      for (const { workspaceId, node } of update.treeNodeUpserts ?? []) {
        const tree = current.trees.find(item => item.workspaceId === workspaceId);
        const old = tree && (findNode(tree.courses, node.id) ?? findNode(tree.rootMaterials ?? [], node.id));
        if (old?.revision !== undefined && (node.revision === undefined || node.revision < old.revision)) return undefined;
        const targetId = node.kind === "material" ? node.materialId ?? node.id : node.id;
        const fence = (current.invalidations ?? []).find(item => item.workspaceId === workspaceId && item.targetId === targetId);
        if (fence?.revision !== undefined && (node.revision === undefined || node.revision < fence.revision)) return undefined;
      }
      let courses = current.courses;
      let releases = current.releases;
      let trees = current.trees;
      let trash = current.trash;
      const materialReleaseSelections = applyMaterialReleaseSelectionUpserts(
        current.materialReleaseSelections, update.materialReleaseSelectionUpserts
      );

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
      if (update.courseUpserts !== undefined) {
        const upserts = validateCourseList(update.courseUpserts);
        for (const course of upserts) {
          courses = [...courses.filter((item) => item.workspaceId !== course.workspaceId || item.id !== course.id), course];
        }
      }
      if (update.trashRemovals !== undefined) {
        const removed = new Set(update.trashRemovals.map((item) => pointerKey(item.workspaceId, item.trashId, "")));
        trash = trash.filter((item) => !removed.has(pointerKey(item.workspaceId, item.id, "")));
      }
      if (update.trashUpserts !== undefined) {
        const upserts = update.trashUpserts.map((record) => {
          assertIdentifier(record?.workspaceId, "WORKSPACE_ID");
          assertIdentifier(record?.id, "TRASH_ID");
          return jsonClone(record);
        });
        for (const record of upserts) {
          trash = [...trash.filter((item) => item.workspaceId !== record.workspaceId || item.id !== record.id), record];
        }
      }

      const treeByWorkspace = new Map<string, WorkspaceTree>();
      const getTree = (workspaceId: string): WorkspaceTree => {
        const cached = treeByWorkspace.get(workspaceId);
        if (cached) return cached;
        const existing = trees.find((item) => item.workspaceId === workspaceId);
        const tree = existing ? jsonClone(existing) : emptyWorkspaceTree(workspaceId);
        treeByWorkspace.set(workspaceId, tree);
        return tree;
      };
      for (const item of update.treeNodeRemovals ?? []) {
        const tree = getTree(item.workspaceId);
        removeTreeNode(tree, item.nodeId);
      }
      for (const item of update.treeNodeUpserts ?? []) {
        const tree = getTree(item.workspaceId);
        if (!upsertTreeNode(tree, item.node)) throw new Error("READING_PROJECTION_TREE_PARENT_MISSING");
      }
      for (const [workspaceId, tree] of treeByWorkspace) {
        const available = trash.filter((item) => item.workspaceId === workspaceId && item.restoreAvailable).length;
        tree.trash = {
          ...(tree.trash ?? { id: `workspace:${workspaceId}:trash`, kind: "trash" as const, title: "回收站", children: [] }),
          subtitle: available ? `${available} 项可恢复` : "暂时为空",
          status: available ? "draft" : "published"
        };
        tree.updatedAt = new Date().toISOString();
      }
      if (treeByWorkspace.size) {
        trees = [...trees.filter((tree) => !treeByWorkspace.has(tree.workspaceId)), ...treeByWorkspace.values()];
      }
      const invalidations = new Set(update.clearInvalidations ?? []);
      return withSnapshotTotals({
        ...current,
        courses,
        releases,
        trees,
        trash,
        materialReleaseSelections,
        invalidations: (current.invalidations ?? []).filter((item) => !invalidations.has(item.id)
          || update.clearInvalidationConfirmations !== undefined
            && !update.clearInvalidationConfirmations.some(value => JSON.stringify(value) === JSON.stringify(item)))
      });
    });
  }

  async removeRelease(workspaceId: string, releaseId: string, clearInvalidations: string[] = []): Promise<void> {
    await this.commit(async (current) => ({
      ...current,
      releases: current.releases.filter((item) => item.workspaceId !== workspaceId || item.index.id !== releaseId),
      invalidations: (current.invalidations ?? []).filter((item) => !clearInvalidations.includes(item.id))
    }));
  }

  private isTombstoned(catalog: ReplicaCatalog, workspaceId: string, kind: TrashRecord["nodeKind"], nodeId: string): boolean {
    return catalog.trash.some((record) => record.workspaceId === workspaceId && record.nodeKind === kind
      && (record.restoreAvailable || record.permanentDeleteRequested)
      && (record.nodeId === nodeId || (kind === "page" && record.nodeId === `page:${nodeId}`)));
  }

  private isProjectionInvalidated(
    catalog: ReplicaCatalog,
    workspaceId: string,
    targetKind: ReadingProjectionInvalidation["targetKind"],
    targetId: string
  ): boolean {
    return (catalog.invalidations ?? []).some((item) => item.workspaceId === workspaceId
      && item.targetKind === targetKind && item.targetId === targetId);
  }

  private isNodeProjectionInvalidated(catalog: ReplicaCatalog, workspaceId: string, node: CourseTreeNode): boolean {
    const targetKind = node.kind === "course" ? "course" : node.kind === "material" ? "material" : "node";
    const targetId = node.kind === "material" ? node.materialId ?? node.id : node.id;
    if (this.isProjectionInvalidated(catalog, workspaceId, targetKind, targetId)) return true;
    if (node.kind === "material" && node.currentReleaseId
      && this.isProjectionInvalidated(catalog, workspaceId, "release", node.currentReleaseId)) return true;
    return false;
  }

  private isPageArchived(catalog: ReplicaCatalog, workspaceId: string, pageId: string): boolean {
    const tree = catalog.trees.find((item) => item.workspaceId === workspaceId);
    if (!tree) return false;
    const visit = (nodes: CourseTreeNode[]): boolean => nodes.some((node) =>
      node.kind === "page" && (node.pageId ?? node.id) === pageId
        && (node.archived === true || node.visibility === "archived")
      || visit(node.children ?? []));
    return visit(tree.courses) || visit(tree.rootMaterials ?? []);
  }

  private isCourseVisible(catalog: ReplicaCatalog, workspaceId: string, courseId: string): boolean {
    const course = catalog.courses.find((item) => item.workspaceId === workspaceId && item.id === courseId);
    if (!course || isRegressionAsset(course.id, course.title)
      || this.isProjectionInvalidated(catalog, workspaceId, "course", courseId)
      || course.status === "archived" || Boolean(course.archivedAt)
      || this.isTombstoned(catalog, workspaceId, "course", courseId)) return false;
    const courseNode = catalog.trees.find((tree) => tree.workspaceId === workspaceId)?.courses
      .find((node) => node.kind === "course" && node.id === courseId);
    return !courseNode?.archived && courseNode?.visibility !== "archived";
  }

  private isReleaseVisible(catalog: ReplicaCatalog, release: CatalogRelease): boolean {
    if (isRegressionAsset(release.index.id, `${release.index.courseTitle} ${release.index.moduleTitle}`)
      || this.isTombstoned(catalog, release.workspaceId, "release", release.index.id)
      || this.isProjectionInvalidated(catalog, release.workspaceId, "release", release.index.id)) return false;
    const sourceCourse = catalog.courses.find((course) => course.id === release.courseId
      && course.workspaceId === release.workspaceId);
    if (!sourceCourse || isRegressionAsset(sourceCourse.id, sourceCourse.title)
      || this.isTombstoned(catalog, release.workspaceId, "course", sourceCourse.id)) return false;

    const materialId = `material:${release.courseId}:${release.index.moduleId}`;
    if (this.isTombstoned(catalog, release.workspaceId, "material", materialId)
      || this.isProjectionInvalidated(catalog, release.workspaceId, "material", materialId)
      || this.isProjectionInvalidated(catalog, release.workspaceId, "node", release.index.moduleId)) return false;
    const tree = catalog.trees.find((item) => item.workspaceId === release.workspaceId);
    const material = tree?.courses.flatMap((node) => [node, ...(node.children ?? [])])
      .concat(tree.rootMaterials ?? [])
      .find((node) => node.kind === "material" && (node.id === materialId || node.materialId === materialId));
    if (material?.archived || material?.visibility === "archived") return false;

    if (material?.parentId && material.parentId !== release.courseId) {
      if (this.isProjectionInvalidated(catalog, release.workspaceId, "course", material.parentId)) return false;
      return this.isCourseVisible(catalog, release.workspaceId, material.parentId);
    }
    return this.isCourseVisible(catalog, release.workspaceId, release.courseId);
  }

  private visibleReleaseIndex(catalog: ReplicaCatalog, release: CatalogRelease): CourseReleaseIndex {
    const pages = release.index.pages.filter((page) => !this.isTombstoned(catalog, release.workspaceId, "page", page.id)
      && !this.isProjectionInvalidated(catalog, release.workspaceId, "page", page.id));
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
      trash,
      materialReleaseSelections: applyMaterialReleaseSelectionUpserts(
        current.materialReleaseSelections, input.materialReleaseSelectionUpserts
      )
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
