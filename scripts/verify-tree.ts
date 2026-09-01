import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CourseRelease, CourseTreeNode } from "@course-os/contracts";
import type { ReadWeaveFileState } from "@course-os/readweave-adapter";

const statePath = resolve(process.env.COURSE_OS_DATA_DIR || "./var", "readweave-course-store.json");
let state: ReadWeaveFileState;
try {
  state = JSON.parse(await readFile(statePath, "utf8")) as ReadWeaveFileState;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    process.stdout.write(`${JSON.stringify({ status: "skipped", reason: "本地尚未建立 ReadWeave 文件状态" }, null, 2)}\n`);
    process.exit(0);
  }
  throw error;
}

const archivedCourseIds = new Set(state.courses.filter((course) => course.status === "archived").map((course) => course.id));
const formalCourseIds = new Set([
  ...state.courses.filter((course) => course.status !== "archived" && !isRegressionAsset(course.id, course.title)).map((course) => course.id),
  ...state.releases.filter((release) => !archivedCourseIds.has(release.courseId) && !isRegressionAsset(release.courseId, release.courseTitle)).map((release) => release.courseId)
]);
const formalCourses = [...formalCourseIds].map((courseId) => state.courses.find((course) => course.id === courseId) ?? {
  id: courseId,
  workspaceId: "personal",
  title: state.releases.find((release) => release.courseId === courseId)?.courseTitle ?? courseId,
  status: "active" as const,
  createdAt: state.releases.find((release) => release.courseId === courseId)?.publishedAt ?? new Date(0).toISOString(),
  updatedAt: state.releases.find((release) => release.courseId === courseId)?.publishedAt ?? new Date(0).toISOString()
});
const formalReleases = state.releases.filter((release) => release.lifecycle !== "draft_source" && formalCourseIds.has(release.courseId) && !isRegressionAsset(release.id, `${release.courseTitle} ${release.moduleTitle}`));
const groups = new Map<string, CourseRelease[]>();
for (const release of formalReleases) {
  const key = `${release.courseId}\u0000${release.moduleId}`;
  groups.set(key, [...(groups.get(key) ?? []), release]);
}

const issues: string[] = [];
const stableMaterialIds = [...groups.keys()].map((key) => {
  const separator = key.indexOf("\u0000");
  return `material:${key.slice(0, separator)}:${key.slice(separator + 1)}`;
});
if (new Set(stableMaterialIds).size !== stableMaterialIds.length) issues.push("STABLE_MATERIAL_ID_DUPLICATE");

const rawNodes = state.treeNodes ?? [];
const rawVisibleNodes = rawNodes.filter((node) => !node.archived && node.visibility !== "archived");
if (rawVisibleNodes.some((node) => !["course", "material"].includes(node.kind))) issues.push("VISIBLE_TREE_CONTAINS_HIDDEN_NODE_KIND");
if (rawVisibleNodes.some((node) => node.kind === "trash" || (node.title === "回收站" && node.parentId))) issues.push("NESTED_TRASH_NODE_PRESENT");
const duplicateIds = duplicateValues(rawVisibleNodes.map((node) => node.id));
for (const id of duplicateIds) issues.push(`VISIBLE_TREE_NODE_DUPLICATE:${id}`);

const formalMaterials: CourseTreeNode[] = [...groups.entries()].flatMap(([key, releases]) => {
  const separator = key.indexOf("\u0000");
  const courseId = key.slice(0, separator);
  const moduleId = key.slice(separator + 1);
  const current = [...releases].sort((left, right) => right.version - left.version || right.publishedAt.localeCompare(left.publishedAt))[0];
  if (!current) return [];
  return [{ id: `material:${courseId}:${moduleId}`, kind: "material", title: current.moduleTitle, parentId: courseId, pageCount: current.pages.length, children: [] }];
});
const formalMaterialIdSet = new Set(formalMaterials.map((node) => node.id));
for (const node of rawVisibleNodes.filter((candidate) => candidate.kind === "material")) {
  const stableId = node.materialId || node.id;
  if (formalMaterialIdSet.has(stableId) && node.id !== stableId) issues.push(`LEGACY_MATERIAL_ID_VISIBLE:${node.id}`);
  if (node.parentId && !formalCourseIds.has(node.parentId)) issues.push(`MATERIAL_PARENT_NOT_FORMAL_COURSE:${node.id}`);
}

const ee680 = formalReleases.filter((release) => release.courseId === "usc-ee680");
const ee680Current = new Map<string, CourseRelease>();
for (const release of ee680) {
  const current = ee680Current.get(release.moduleId);
  if (!current || release.version > current.version || (release.version === current.version && release.publishedAt > current.publishedAt)) ee680Current.set(release.moduleId, release);
}
const expectedEe680: Record<string, number> = { "ee680-introduction": 25, "ee680-chapter-2": 47 };
for (const [moduleId, expectedPageCount] of Object.entries(expectedEe680)) {
  const release = ee680Current.get(moduleId);
  if (!release) continue;
  if (release.pages.length !== expectedPageCount) issues.push(`EE680_PAGE_COUNT:${moduleId}:${release.pages.length}/${expectedPageCount}`);
  const numbers = release.pages.map((page) => page.pageNumber).sort((left, right) => left - right);
  if (numbers.some((number, index) => number !== index + 1)) issues.push(`EE680_PAGE_ORDER:${moduleId}`);
}

const report = {
  status: issues.length ? "failed" : "passed",
  checkedAt: new Date().toISOString(),
  statePath,
  treeContract: "2.4.0",
  formalCourses: formalCourses.length,
  formalMaterials: formalMaterials.length,
  rawVisibleNodes: rawVisibleNodes.length,
  hiddenLegacyNodes: rawNodes.length - rawVisibleNodes.length,
  trashRecords: state.trash.filter((item) => item.restoreAvailable).length,
  issues
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (issues.length) process.exitCode = 1;

function duplicateValues(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value);
}

function isRegressionAsset(...values: string[]): boolean {
  return /(synthetic|golden|regression|legacy|test-course)/i.test(values.join(" "));
}
