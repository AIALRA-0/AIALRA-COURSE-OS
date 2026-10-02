import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ReadWeaveFileState } from "@course-os/readweave-adapter";
import { inspectCourseState, visibleTreeNodes, type VerificationMode } from "./lib/verify-course-state.js";

const args = new Set(process.argv.slice(2));
for (const arg of args) if (arg !== "--synthetic") throw new Error(`Unknown verify:tree option: ${arg}`);
const mode: VerificationMode = args.has("--synthetic") ? "synthetic" : "formal";
const statePath = resolve(process.env.COURSE_OS_DATA_DIR || "./var", "readweave-course-store.json");
let state: ReadWeaveFileState;
try {
  state = JSON.parse(await readFile(statePath, "utf8")) as ReadWeaveFileState;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    process.stdout.write(`${JSON.stringify({ status: "skipped", reason: "本地尚未建立 ReadWeave 文件状态", statePath, mode }, null, 2)}\n`);
    process.exit(0);
  }
  throw error;
}

const inspection = inspectCourseState(state, mode);
const issues = [...inspection.issues];
const rawNodes = state.treeNodes ?? [];
const rawVisibleNodes = visibleTreeNodes(state);
if (rawVisibleNodes.some((node) => !["course", "material"].includes(node.kind))) issues.push({ code: "VISIBLE_TREE_CONTAINS_HIDDEN_NODE_KIND" });
if (rawVisibleNodes.some((node) => node.kind === "trash" || (node.title === "回收站" && node.parentId))) {
  issues.push({ code: "NESTED_TRASH_NODE_PRESENT" });
}
for (const id of duplicateValues(rawVisibleNodes.map((node) => node.id))) issues.push({ code: `VISIBLE_TREE_NODE_DUPLICATE:${id}` });

const materialIds = new Set(inspection.currentMaterials.map((material) => material.materialId));
const archivedCourseIds = new Set(state.courses.filter((course) => course.status === "archived").map((course) => course.id));
const knownCourseIds = new Set([
  ...state.courses.filter((course) => course.status !== "archived").map((course) => course.id),
  ...state.releases.filter((release) => !archivedCourseIds.has(release.courseId)).map((release) => release.courseId)
]);
for (const node of rawVisibleNodes.filter((candidate) => candidate.kind === "material")) {
  const stableId = node.materialId || node.id;
  if (materialIds.has(stableId) && node.id !== stableId) issues.push({ code: `LEGACY_MATERIAL_ID_VISIBLE:${node.id}` });
  if (node.parentId && !knownCourseIds.has(node.parentId)) issues.push({ code: `MATERIAL_PARENT_NOT_A_COURSE:${node.id}` });
}

const report = {
  status: issues.length ? "failed" : inspection.releases.length === 0 ? "skipped" : "passed",
  checkedAt: new Date().toISOString(),
  statePath,
  mode,
  treeContract: "2.4.0",
  releasesChecked: inspection.releases.length,
  formalCourses: inspection.courses.length,
  formalMaterials: inspection.currentMaterials.length,
  rawVisibleNodes: rawVisibleNodes.length,
  hiddenLegacyNodes: rawNodes.length - rawVisibleNodes.length,
  trashRecords: (state.trash ?? []).filter((item) => item.restoreAvailable).length,
  issues
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (issues.length) process.exitCode = 1;

function duplicateValues(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value);
}
