import type { CourseRelease, CourseTreeNode, LessonDraft } from "@course-os/contracts";
import type { ReadWeaveFileState } from "@course-os/readweave-adapter";
import { materialGroups, selectMaterialRelease, stableMaterialId } from "../../packages/readweave-adapter/src/tree-identity.js";

export type VerificationMode = "formal" | "synthetic";

export interface VerificationIssue {
  courseId?: string;
  moduleId?: string;
  releaseId?: string;
  code: string;
}

export interface CurrentMaterial {
  courseId: string;
  moduleId: string;
  materialId: string;
  releaseId: string;
  version: number;
  lifecycle: CourseRelease["lifecycle"];
  pageCount: number;
}

export interface CourseStateInspection {
  mode: VerificationMode;
  courses: Array<{ id: string; title: string }>;
  releases: CourseRelease[];
  currentMaterials: CurrentMaterial[];
  issues: VerificationIssue[];
}

const fixtureMarker = /(synthetic|golden|regression|legacy|test-course)/i;
const syntheticMarker = /synthetic/i;

/** Inspect the selected course scope with the same stable identity and release selection as the runtime tree. */
export function inspectCourseState(state: ReadWeaveFileState, mode: VerificationMode): CourseStateInspection {
  const courseById = new Map(state.courses.map((course) => [course.id, course]));
  const activeCourses = state.courses.filter((course) => course.status !== "archived"
    && matchesMode(mode, course.id, course.title));
  const archivedCourseIds = new Set(state.courses.filter((course) => course.status === "archived").map((course) => course.id));
  const releases = state.releases.filter((release) => {
    if (archivedCourseIds.has(release.courseId)) return false;
    const course = courseById.get(release.courseId);
    return matchesMode(mode, release.id, release.courseId, release.courseTitle, release.moduleTitle, course?.title);
  });
  const releaseIds = new Set(releases.map((release) => release.id));
  const drafts = state.drafts.filter((draft) => releaseIds.has(draft.sourceReleaseId));
  const courseIds = new Set([...activeCourses.map((course) => course.id), ...releases.map((release) => release.courseId)]);
  const courses = [...courseIds].map((id) => ({ id, title: courseById.get(id)?.title
    ?? releases.find((release) => release.courseId === id)?.courseTitle ?? id }));
  const issues = inspectReleaseStructure(releases);
  if (mode === "synthetic" && releases.length === 0) issues.push({ code: "SYNTHETIC_SCOPE_EMPTY" });

  const currentMaterials: CurrentMaterial[] = [];
  for (const group of materialGroups(releases, drafts)) {
    const materialId = stableMaterialId(group.courseId, group.moduleId);
    const matchingNodes = (state.treeNodes ?? []).filter((node) => node.kind === "material" && !node.archived
      && (node.materialId || node.id) === materialId);
    if (matchingNodes.length > 1) issues.push({ courseId: group.courseId, moduleId: group.moduleId, code: "DUPLICATE_STABLE_MATERIAL_NODE" });
    const persisted = matchingNodes[0];
    const current = selectMaterialRelease(group.releases, drafts, group.courseId, group.moduleId, persisted?.currentReleaseId);
    if (!current) {
      issues.push({ courseId: group.courseId, moduleId: group.moduleId, code: "CURRENT_RELEASE_MISSING" });
      continue;
    }
    if (persisted?.currentReleaseId && persisted.currentReleaseId !== current.id) {
      issues.push({ courseId: group.courseId, moduleId: group.moduleId, releaseId: persisted.currentReleaseId, code: "CURRENT_RELEASE_POINTER_INVALID" });
    }
    if (persisted?.releaseId && persisted.releaseId !== current.id) {
      issues.push({ courseId: group.courseId, moduleId: group.moduleId, releaseId: persisted.releaseId, code: "TREE_RELEASE_POINTER_STALE" });
    }
    if (persisted?.pageCount !== undefined && persisted.pageCount !== current.pages.length) {
      issues.push({ courseId: group.courseId, moduleId: group.moduleId, releaseId: current.id, code: "TREE_PAGE_COUNT_STALE" });
    }
    currentMaterials.push({ courseId: group.courseId, moduleId: group.moduleId, materialId, releaseId: current.id,
      version: current.version, lifecycle: current.lifecycle, pageCount: current.pages.length });
  }

  return { mode, courses, releases, currentMaterials, issues };
}

/** Structural and version checks shared by the tree and course commands; no teaching-quality rules run here. */
export function inspectReleaseStructure(releases: CourseRelease[]): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  const groups = new Map<string, CourseRelease[]>();
  for (const release of releases) {
    const groupKey = `${release.courseId}\u0000${release.moduleId}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), release]);
    const context = { courseId: release.courseId, moduleId: release.moduleId, releaseId: release.id };
    const pages = Array.isArray(release.pages) ? release.pages : [];
    const pageIds = Array.isArray(release.pageIds) ? release.pageIds : [];
    if (!Number.isSafeInteger(release.version) || release.version < 1) issues.push({ ...context, code: "RELEASE_VERSION_INVALID" });
    if (!Number.isFinite(Date.parse(release.publishedAt))) issues.push({ ...context, code: "RELEASE_TIMESTAMP_INVALID" });
    if (release.lifecycle !== undefined && release.lifecycle !== "published" && release.lifecycle !== "draft_source") {
      issues.push({ ...context, code: "RELEASE_LIFECYCLE_INVALID" });
    }
    if (duplicateValues(pageIds).length || duplicateValues(pages.map((page) => page.id)).length) {
      issues.push({ ...context, code: "RELEASE_PAGE_IDS_DUPLICATE" });
    }
    const declaredIds = new Set(pageIds);
    const actualIds = new Set(pages.map((page) => page.id));
    if (pageIds.length !== pages.length || declaredIds.size !== actualIds.size
      || [...declaredIds].some((id) => !actualIds.has(id))) {
      issues.push({ ...context, code: "RELEASE_PAGE_IDS_MISMATCH" });
    }
    const pageNumbers = pages.map((page) => page.pageNumber).sort((left, right) => left - right);
    if (pageNumbers.some((number, index) => !Number.isSafeInteger(number) || number !== index + 1)) {
      issues.push({ ...context, code: "RELEASE_PAGE_NUMBERS_NOT_CONTIGUOUS" });
    }
  }

  for (const group of groups.values()) {
    const versions = new Set<number>();
    for (const release of group) {
      if (versions.has(release.version)) {
        issues.push({ courseId: release.courseId, moduleId: release.moduleId, releaseId: release.id,
          code: `DUPLICATE_RELEASE_VERSION:${release.version}` });
      }
      versions.add(release.version);
    }
  }
  return issues;
}

export function visibleTreeNodes(state: ReadWeaveFileState): CourseTreeNode[] {
  return (state.treeNodes ?? []).filter((node) => !node.archived && node.visibility !== "archived");
}

function matchesMode(mode: VerificationMode, ...values: Array<string | undefined>): boolean {
  const joined = values.filter(Boolean).join(" ");
  return mode === "synthetic" ? syntheticMarker.test(joined) : !fixtureMarker.test(joined);
}

function duplicateValues(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value);
}
