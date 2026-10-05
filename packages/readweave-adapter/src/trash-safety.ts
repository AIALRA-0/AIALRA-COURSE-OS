import { createHash } from "node:crypto";
import type { IdempotentWriteContext, TrashRecord } from "@course-os/contracts";
import type { ReadWeaveCourseApi, ReadWeaveFileState } from "./index.js";
import { stableMaterialId } from "./tree-identity.js";

export interface TrashDeleteScope {
  trashId: string;
  workspaceId: string;
  nodeIds: string[];
  courseIds: string[];
  releaseIds: string[];
  pageIds: string[];
}

export interface TrashDeleteOptions {
  expectedDeletedAt?: string;
  /** Snapshot shown in the confirmation; required for destructive writes. */
  expectedSnapshotHash?: string;
  expectedRevision?: number;
  /** API-owned operational activity/retelling check, called within the adapter write lock. */
  checkExternalReferences?: (scope: TrashDeleteScope) => Promise<{ active: boolean; answers: boolean }>;
}

export interface TrashNativeErasePlan {
  trashId: string;
  workspaceId: string;
  nodeId: string;
  deletedAt: string;
  snapshotHash: string;
  revision?: number;
  /** Smallest independently erasable ReadWeave roots, including separate authorities. */
  rootNoteIds: string[];
  rootBranchIds?: Record<string, string[]>;
  nativeLinks: Array<{ noteId: string; url: string; title: string }>;
  /** Every ReadWeave note owned by this exact trash incarnation. */
  noteIds: string[];
  branches?: Array<{ branchId: string; noteId: string; parentNoteId: string }>;
}

export interface TrashDeleteSelection {
  id: string;
  deletedAt: string;
  snapshotHash?: string;
  revision?: number;
}

export interface TrashDeleteResult {
  id: string;
  status: "deleted" | "skipped" | "failed";
  reason?: string;
}

export function trashDeleteIdempotencyKey(context: IdempotentWriteContext): string {
  if (!context.workspaceId.trim() || !context.actor.trim() || !context.idempotencyKey.trim()) throw new Error("READWEAVE_TRASH_CONTEXT_REQUIRED");
  return `course-os:trash-delete:v1:${JSON.stringify([context.workspaceId, context.idempotencyKey])}`;
}

export function trashDeleteReplay(state: ReadWeaveFileState, trashId: string, context: IdempotentWriteContext, options: TrashDeleteOptions): boolean {
  const replay = state.idempotency[trashDeleteIdempotencyKey(context)];
  if (!replay) return false;
  if (replay.kind !== "permanent_delete" || replay.objectId !== JSON.stringify([trashId, options.expectedDeletedAt, options.expectedSnapshotHash])) throw new Error("READWEAVE_TRASH_IDEMPOTENCY_CONFLICT");
  return true;
}

export function trashDeleteScope(state: ReadWeaveFileState, item: TrashRecord, context: IdempotentWriteContext, options: TrashDeleteOptions): TrashDeleteScope {
  if (item.workspaceId !== context.workspaceId) throw new Error("READWEAVE_TRASH_WORKSPACE_MISMATCH");
  if (!item.restoreAvailable) throw new Error("READWEAVE_TRASH_NOT_DELETED");
  if (!options.expectedDeletedAt && !options.expectedSnapshotHash) throw new Error("READWEAVE_TRASH_SNAPSHOT_REQUIRED");
  if (options.expectedDeletedAt && options.expectedDeletedAt !== item.deletedAt) throw new Error("READWEAVE_TRASH_CHANGED");
  if (options.expectedSnapshotHash && options.expectedSnapshotHash !== item.snapshotHash) throw new Error("READWEAVE_TRASH_CHANGED");
  const course = state.courses.find(candidate => candidate.id === item.nodeId);
  const node = state.treeNodes.find(candidate => candidate.id === item.nodeId);
  if (item.nodeKind === "course") {
    if (!course || course.workspaceId !== context.workspaceId) throw new Error("READWEAVE_TRASH_WORKSPACE_MISMATCH");
    if (course.status !== "archived") throw new Error("READWEAVE_TRASH_NOT_DELETED");
  } else {
    if (!node || !node.archived) throw new Error("READWEAVE_TRASH_NOT_DELETED");
    if (node.kind !== item.nodeKind) throw new Error("READWEAVE_TRASH_CHANGED");
    const ancestors = new Set<string>();
    let parentId = node.parentId;
    while (parentId && !ancestors.has(parentId)) {
      ancestors.add(parentId);
      const parentCourse = state.courses.find(candidate => candidate.id === parentId);
      if (parentCourse && parentCourse.workspaceId !== context.workspaceId) throw new Error("READWEAVE_TRASH_WORKSPACE_MISMATCH");
      parentId = state.treeNodes.find(candidate => candidate.id === parentId)?.parentId;
    }
  }
  const revision = course?.revision ?? node?.revision ?? 0;
  if (options.expectedRevision !== undefined && options.expectedRevision !== revision) throw new Error("READWEAVE_TRASH_CHANGED");
  const nodeIds = new Set([item.nodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const child of state.treeNodes) if (child.parentId && nodeIds.has(child.parentId) && !nodeIds.has(child.id)) {
      nodeIds.add(child.id); changed = true;
    }
  }
  const materialIds = new Set(state.treeNodes.filter(candidate => nodeIds.has(candidate.id))
    .map(candidate => candidate.materialId ?? candidate.id));
  const releases = state.releases.filter(release => item.nodeKind === "course" ? release.courseId === item.nodeId
    : materialIds.has(stableMaterialId(release.courseId, release.moduleId))
      || nodeIds.has(release.moduleId) || nodeIds.has(release.id));
  // Moved materials and current-release pointers outside this subtree remain authoritative.
  const releaseIds = new Set(releases.map(release => release.id));
  if (state.treeNodes.some(candidate => !nodeIds.has(candidate.id)
    && ((candidate.currentReleaseId && releaseIds.has(candidate.currentReleaseId))
      || (candidate.releaseId && releaseIds.has(candidate.releaseId))
      || (candidate.materialId && releases.some(release => candidate.materialId === stableMaterialId(release.courseId, release.moduleId)))))) {
    throw new Error("READWEAVE_TRASH_SHARED_REFERENCE");
  }
  const drafts = state.drafts.filter(draft => item.nodeKind === "course" ? draft.courseId === item.nodeId
    : materialIds.has(stableMaterialId(draft.courseId, draft.moduleId)) || nodeIds.has(draft.moduleId) || releaseIds.has(draft.sourceReleaseId));
  const workspaceCourses = new Set([...releases.map(release => release.courseId), ...drafts.map(draft => draft.courseId)]);
  if ([...workspaceCourses].some(id => state.courses.find(candidate => candidate.id === id)?.workspaceId !== context.workspaceId)
    || drafts.some(draft => draft.workspaceId !== context.workspaceId)) throw new Error("READWEAVE_TRASH_WORKSPACE_MISMATCH");
  return { trashId: item.id, workspaceId: context.workspaceId, nodeIds: [...nodeIds], courseIds: course ? [course.id] : [],
    releaseIds: [...releaseIds], pageIds: [...new Set([...releases.flatMap(release => [...release.pageIds, ...release.pages.map(page => page.id)]), ...drafts.map(draft => draft.pageId)])] };
}

export async function assertTrashReferencesSafe(state: ReadWeaveFileState, scope: TrashDeleteScope, options: TrashDeleteOptions): Promise<void> {
  const releaseIds = new Set(scope.releaseIds);
  const pageIds = new Set(scope.pageIds);
  const releases = state.releases.filter(release => releaseIds.has(release.id));
  const objectives = new Set(releases.flatMap(release => [
    ...release.assessments.map(assessment => assessment.objectiveId),
    ...release.pages.flatMap(page => [...page.atoms.map(atom => atom.id), ...(page.questionBank ?? []).map(question => question.objectiveId)])
  ]));
  const relatedQuestions = state.questions.filter(question => releaseIds.has(question.courseReleaseId) || pageIds.has(question.pageId));
  const questions = new Set(relatedQuestions.map(question => question.id));
  const assessmentIds = new Set(releases.flatMap(release => release.assessments.map(assessment => assessment.id)));
  if (relatedQuestions.some(question => question.learnerAttempt.trim())
    || state.questionAttempts.some(attempt => releaseIds.has(attempt.courseReleaseId) || pageIds.has(attempt.pageId) || questions.has(attempt.questionId))
    || state.attempts.some(attempt => assessmentIds.has(attempt.itemId) || objectives.has(attempt.objectiveId))
    || state.mastery.some(record => objectives.has(record.objectiveId))) throw new Error("READWEAVE_TRASH_ANSWERS_PROTECTED");
  if (relatedQuestions.length || state.questionSelections.some(selection => releaseIds.has(selection.courseReleaseId) || pageIds.has(selection.pageId))
    || state.reviewPlans.some(plan => plan.items.some(item => releaseIds.has(item.releaseId) || pageIds.has(item.pageId)))
    || state.conflicts.some(conflict => conflict.status === "open" && (scope.nodeIds.includes(conflict.objectId)
      || releaseIds.has(conflict.objectId) || state.drafts.some(draft => pageIds.has(draft.pageId) && draft.id === conflict.objectId)))) {
    throw new Error("READWEAVE_TRASH_ACTIVITY_PROTECTED");
  }
  // The adapter cannot see sessions, retellings or jobs in OperationalStore.
  // Require the owning API to check them; do not infer that missing means empty.
  if (scope.pageIds.length || scope.releaseIds.length || scope.courseIds.length) {
    if (!options.checkExternalReferences) throw new Error("READWEAVE_TRASH_EXTERNAL_REFERENCES_UNCHECKED");
    const external = await options.checkExternalReferences(structuredClone(scope));
    if (external.active !== false) throw new Error("READWEAVE_TRASH_ACTIVITY_PROTECTED");
    if (external.answers !== false) throw new Error("READWEAVE_TRASH_ANSWERS_PROTECTED");
  }
}

/** Explicit confirmed IDs only; each authority call rechecks its own snapshot and references. */
export async function permanentlyDeleteTrashBatch(api: ReadWeaveCourseApi, selected: TrashDeleteSelection[], context: IdempotentWriteContext,
  options: Pick<TrashDeleteOptions, "checkExternalReferences"> = {}): Promise<TrashDeleteResult[]> {
  trashDeleteIdempotencyKey(context);
  if (selected.some(item => !item.id || !item.deletedAt)) throw new Error("READWEAVE_TRASH_SELECTION_INVALID");
  const unique = new Map<string, TrashDeleteSelection>();
  for (const item of selected) {
    const previous = unique.get(item.id);
    if (previous && (previous.deletedAt !== item.deletedAt || previous.snapshotHash !== item.snapshotHash || previous.revision !== item.revision)) throw new Error("READWEAVE_TRASH_SELECTION_CONFLICT");
    unique.set(item.id, item);
  }
  const results: TrashDeleteResult[] = [];
  for (const item of unique.values()) {
    const childKey = createHash("sha256").update(JSON.stringify([context.workspaceId, context.idempotencyKey, item.id, item.deletedAt, item.snapshotHash])).digest("hex");
    try {
      await api.permanentlyDeleteTrash(item.id, { ...context, idempotencyKey: `trash-batch:${childKey}` }, item.deletedAt,
        { ...options, expectedSnapshotHash: item.snapshotHash, expectedRevision: item.revision });
      results.push({ id: item.id, status: "deleted" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "READWEAVE_TRASH_DELETE_FAILED";
      const skipped = /^READWEAVE_(?:PERMANENT_DELETE_UNSUPPORTED|TRASH_(?:NOT_FOUND|NOT_DELETED|WORKSPACE_MISMATCH|CHANGED|SNAPSHOT_REQUIRED|SHARED_REFERENCE|ANSWERS_PROTECTED|ACTIVITY_PROTECTED|EXTERNAL_REFERENCES_UNCHECKED))$/.test(reason);
      results.push({ id: item.id, status: skipped ? "skipped" : "failed", reason });
    }
  }
  return results;
}
