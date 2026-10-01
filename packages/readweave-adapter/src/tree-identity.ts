import type { CourseProject, CourseRelease, CourseTreeNode, LessonDraft, PageLesson } from "@course-os/contracts";

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

export function selectMaterialRelease(
  releases: CourseRelease[],
  drafts: LessonDraft[],
  courseId: string,
  moduleId: string,
  preferredReleaseId?: string
): CourseRelease | undefined {
  const materialReleases = releases.filter((release) => release.courseId === courseId && release.moduleId === moduleId);
  const preferred = preferredReleaseId ? materialReleases.find((release) => release.id === preferredReleaseId) : undefined;
  const preferredIsReadable = preferred && isReadableRelease(preferred, drafts);
  if (preferredIsReadable) return preferred;

  const readable = materialReleases.filter((release) => isReadableRelease(release, drafts));
  const newestFirst = (items: CourseRelease[]) => [...items].sort(
    (left, right) => right.version - left.version || right.publishedAt.localeCompare(left.publishedAt)
  );
  // Preserve an incomplete source as an entry when there is no readable version.
  return newestFirst(readable)[0] ?? preferred ?? newestFirst(materialReleases)[0];
}

function isReadableRelease(release: CourseRelease, drafts: LessonDraft[]): boolean {
  return release.lifecycle !== "draft_source" || hasCompleteReadableDraft(release, drafts);
}

export function validateMaterialReleaseTarget(
  node: CourseTreeNode | undefined,
  releaseId: string,
  courses: CourseProject[],
  releases: CourseRelease[],
  drafts: LessonDraft[],
  workspaceId: string
): CourseRelease {
  if (node?.kind !== "material") throw new Error("READWEAVE_TREE_CURRENT_RELEASE_MATERIAL_ONLY");
  const release = releases.find((item) => item.id === releaseId);
  if (!release || stableMaterialId(release.courseId, release.moduleId) !== (node.materialId || node.id)) {
    throw new Error("READWEAVE_TREE_CURRENT_RELEASE_OWNERSHIP");
  }
  const course = courses.find((item) => item.id === release.courseId);
  if (!course || course.workspaceId !== workspaceId) throw new Error("READWEAVE_TREE_CURRENT_RELEASE_OWNERSHIP");
  if (!isReadableRelease(release, drafts)) throw new Error("READWEAVE_TREE_CURRENT_RELEASE_NOT_READY");
  return release;
}

function hasCompleteReadableDraft(release: CourseRelease, drafts: LessonDraft[]): boolean {
  const pageIds = release.pageIds.length > 0 ? release.pageIds : release.pages.map((page) => page.id);
  if (pageIds.length === 0 || pageIds.length !== release.pages.length || new Set(pageIds).size !== pageIds.length) return false;
  const pagesById = new Map(release.pages.map((page) => [page.id, page]));
  return pageIds.every((pageId) => {
    if (!pagesById.has(pageId)) return false;
    return drafts.some((draft) => draft.sourceReleaseId === release.id
      && draft.courseId === release.courseId
      && draft.moduleId === release.moduleId
      && draft.pageId === pageId
      && draft.page.id === pageId
      && (draft.status === "ready" || draft.status === "clean")
      && hasReadablePageBody(draft.page));
  });
}

function hasReadablePageBody(page: PageLesson): boolean {
  const full = page.lessonSections?.find((section) => section.kind === "full_explanation");
  // A present full-explanation section is authoritative. Do not let a summary
  // or a legacy core block make an explicitly blank full explanation readable.
  const bodyText = full
    ? [full.markdown ?? ""]
    : page.blocks.filter((block) => block.kind === "core").map((block) => block.markdown);
  return bodyText.some((value) => {
    const text = value.trim();
    return text.length > 0 && !/(?:待生成|待确认|待补充|当前只完成来源拆解|还没有冒充教授级讲解)/u.test(text);
  });
}

export function materialGroups(releases: CourseRelease[], drafts: LessonDraft[] = []): Array<{ courseId: string; moduleId: string; latest: CourseRelease; releases: CourseRelease[] }> {
  const groups = new Map<string, { courseId: string; moduleId: string; latest: CourseRelease; releases: CourseRelease[] }>();
  for (const release of releases) {
    const key = `${release.courseId}\u0000${release.moduleId}`;
    const group = groups.get(key) ?? { courseId: release.courseId, moduleId: release.moduleId, latest: release, releases: [] };
    group.releases.push(release);
    const candidate = selectMaterialRelease(group.releases, drafts, group.courseId, group.moduleId);
    if (candidate) group.latest = candidate;
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function materialTreeNode(
  course: CourseProject,
  group: { courseId: string; moduleId: string; latest: CourseRelease; releases: CourseRelease[] },
  persisted?: CourseTreeNode,
  drafts: LessonDraft[] = []
): CourseTreeNode {
  const current = selectMaterialRelease(group.releases, drafts, group.courseId, group.moduleId, persisted?.currentReleaseId) ?? group.latest;
  return {
    id: persisted?.id ?? stableMaterialId(group.courseId, group.moduleId),
    kind: "material",
    materialId: persisted?.materialId ?? stableMaterialId(group.courseId, group.moduleId),
    title: persisted?.title ?? current.moduleTitle,
    subtitle: `${current.pages.length} 页 · ${current.lifecycle === "draft_source" ? "待审核" : "已就绪"}`,
    parentId: persisted ? persisted.parentId : course.id,
    releaseId: current.id,
    currentReleaseId: current.id,
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
