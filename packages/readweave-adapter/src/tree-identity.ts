import type { CourseProject, CourseRelease, CourseTreeNode } from "@course-os/contracts";

/** Stable identity for a material assembled from one course and one source module */
export function stableMaterialId(courseId: string, moduleId: string): string {
  return `material:${courseId}:${moduleId}`;
}

export function isLegacyProjectionId(nodeId: string): boolean {
  return nodeId.startsWith("module-") || nodeId.startsWith("release-node:") || nodeId.startsWith("section:") || /^page[:/]/.test(nodeId);
}

export function isStableMaterialId(nodeId: string, releases: CourseRelease[]): boolean {
  return releases.some((release) => stableMaterialId(release.courseId, release.moduleId) === nodeId);
}

export function latestMaterialRelease(releases: CourseRelease[], courseId: string, moduleId: string): CourseRelease | undefined {
  return releases
    .filter((release) => release.courseId === courseId && release.moduleId === moduleId && release.lifecycle !== "draft_source")
    .sort((left, right) => right.version - left.version || right.publishedAt.localeCompare(left.publishedAt))[0]
    ?? releases
      .filter((release) => release.courseId === courseId && release.moduleId === moduleId)
      .sort((left, right) => right.version - left.version || right.publishedAt.localeCompare(left.publishedAt))[0];
}

export function materialGroups(releases: CourseRelease[]): Array<{ courseId: string; moduleId: string; latest: CourseRelease; releases: CourseRelease[] }> {
  const groups = new Map<string, { courseId: string; moduleId: string; latest: CourseRelease; releases: CourseRelease[] }>();
  for (const release of releases) {
    const key = `${release.courseId}\u0000${release.moduleId}`;
    const group = groups.get(key) ?? { courseId: release.courseId, moduleId: release.moduleId, latest: release, releases: [] };
    group.releases.push(release);
    const candidate = latestMaterialRelease(group.releases, group.courseId, group.moduleId);
    if (candidate) group.latest = candidate;
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function materialTreeNode(
  course: CourseProject,
  group: { courseId: string; moduleId: string; latest: CourseRelease; releases: CourseRelease[] },
  persisted?: CourseTreeNode
): CourseTreeNode {
  const published = group.releases.filter((release) => release.lifecycle !== "draft_source");
  const current = group.latest;
  return {
    id: persisted?.id ?? stableMaterialId(group.courseId, group.moduleId),
    kind: "material",
    materialId: persisted?.materialId ?? stableMaterialId(group.courseId, group.moduleId),
    title: persisted?.title ?? current.moduleTitle,
    subtitle: `${current.pages.length} 页 · ${current.lifecycle === "draft_source" ? "待审核" : "已就绪"}`,
    parentId: persisted ? persisted.parentId : course.id,
    releaseId: current.id,
    currentReleaseId: published[0]?.id ?? current.id,
    pageCount: current.pages.length,
    status: persisted?.archived ? "draft" : current.lifecycle === "draft_source" ? "draft" : current.pages.every((page) => page.quality.publishable) ? "published" : "needs_review",
    revision: persisted?.revision ?? current.version,
    sortOrder: persisted?.sortOrder,
    archived: persisted?.archived ?? false,
    visibility: persisted?.archived ? "archived" : "library",
    readweaveNoteId: persisted?.readweaveNoteId,
    capabilities: ["rename", "duplicate", "move", "reorder", "trash", "open_studio", "open_readweave", "history", "properties"],
    children: []
  };
}

export function courseTreeNode(course: CourseProject): CourseTreeNode {
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
    capabilities: ["import_material", "rename", "duplicate", "move", "reorder", "trash", "open_readweave", "history", "properties"],
    children: []
  };
}
