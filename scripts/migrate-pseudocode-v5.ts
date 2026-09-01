import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CourseRelease, IdempotentWriteContext, LessonDraft, PageLesson, PseudoCodeLine, ReleaseManifest } from "@course-os/contracts";
import { COURSE_API_VERSION } from "@course-os/contracts";
import { hashManifest, sha256Text, stableStringify } from "@course-os/domain";
import { FileReadWeaveCourseApi, type ReadWeaveFileState } from "@course-os/readweave-adapter";
import { calculateCoverage, validateMathAtoms, validatePageForPublication } from "@course-os/quality";
import { klPseudoCodeLines } from "@course-os/teaching";

const dataDir = resolve(process.env.COURSE_OS_DATA_DIR || "./var");
const statePath = resolve(dataDir, "readweave-course-store.json");
const readweave = new FileReadWeaveCourseApi(statePath);
const sourceState = JSON.parse(await readFile(statePath, "utf8")) as ReadWeaveFileState;
const summaryByCode = new Map(klPseudoCodeLines().map((line) => [line.code, line.teacherSummary || ""]));
const candidates = sourceState.releases
  .filter((release) => /-full-v4$/.test(release.id) && release.lifecycle !== "draft_source")
  .filter((release) => release.pages.some((page) => page.atoms.some((atom) => atom.kind === "pseudocode_line" && !atom.teacherSummary?.trim())));

if (candidates.length === 0) {
  process.stdout.write("No v4 pseudocode pages need a teacher-summary migration\n");
  process.exit(0);
}

for (const source of candidates) {
  const releaseId = source.id.replace(/-v4$/, "-v5");
  if (await readweave.getRelease(releaseId)) {
    process.stdout.write(`SKIP ${releaseId} already exists\n`);
    continue;
  }
  const pageIdMap = new Map(source.pages.map((page) => [page.id, `${releaseId}:page:${page.pageNumber}`]));
  const changedPages: PageLesson[] = [];
  const pages = source.pages.map((original) => {
    const page = replaceDeep(original, pageIdMap) as PageLesson;
    let changed = false;
    page.atoms = page.atoms.map((atom) => {
      if (atom.kind !== "pseudocode_line" || atom.teacherSummary?.trim()) return atom;
      changed = true;
      return { ...atom, teacherSummary: summaryByCode.get(atom.code) || `这一行执行${atom.semantic}，并把结果交给后续步骤继续处理` } satisfies PseudoCodeLine;
    });
    if (!changed) return page;
    page.coverageRequirements = page.coverageRequirements.map((requirement) => {
      const atom = page.atoms.find((candidate) => candidate.id === requirement.atomId);
      if (atom?.kind !== "pseudocode_line" || requirement.requiredFields.includes("teacherSummary")) return requirement;
      return { ...requirement, requiredFields: ["teacherSummary", ...requirement.requiredFields] };
    });
    page.coverageClaims = page.coverageClaims.map((claim) => {
      const requirement = page.coverageRequirements.find((candidate) => candidate.id === claim.requirementId);
      if (!requirement || !requirement.requiredFields.includes("teacherSummary") || claim.coveredFields.includes("teacherSummary")) return claim;
      return { ...claim, coveredFields: ["teacherSummary", ...claim.coveredFields] };
    });
    page.quality = { ...page.quality, issues: [] };
    const coverage = calculateCoverage(page.coverageRequirements, page.coverageClaims);
    const issues = [...validatePageForPublication(page), ...validateMathAtoms(page.atoms.filter((atom) => atom.kind === "math_expression"))];
    page.quality = {
      ...page.quality,
      highRiskCoverage: coverage.highRiskCoverage,
      generalCoverage: coverage.generalCoverage,
      mathValid: issues.length === 0,
      publishable: issues.length === 0 && coverage.publishable,
      issues
    };
    if (!page.quality.publishable) throw new Error(`PSEUDOCODE_MIGRATION_PAGE_NOT_PUBLISHABLE:${page.id}:${issues.join("|")}`);
    changedPages.push(page);
    return page;
  });
  const assessments = replaceDeep(source.assessments, pageIdMap);
  const oldManifest = await readweave.getManifest(source.id);
  const createdAt = new Date().toISOString();
  const manifest: ReleaseManifest = {
    id: `${releaseId}:manifest`,
    schemaVersion: COURSE_API_VERSION,
    courseReleaseId: releaseId,
    sourceHashes: oldManifest?.sourceHashes ?? [],
    pageHashes: pages.map((page) => sha256Text(stableStringify(page))),
    explanationHashes: pages.flatMap((page) => page.blocks.map((block) => sha256Text(stableStringify(block)))),
    assessmentHashes: assessments.map((assessment) => sha256Text(stableStringify(assessment))),
    writingPolicySnapshotId: source.writingPolicySnapshotId,
    modelRoutes: [...new Set([...(oldManifest?.modelRoutes ?? []), "teacher-summary-migration-v1"])],
    qualityHarnessVersion: "ee680-pseudocode-v5",
    costInputs: oldManifest?.costInputs ?? [],
    createdAt
  };
  const release: CourseRelease = {
    ...structuredClone(source),
    id: releaseId,
    version: source.version + 1,
    publishedAt: createdAt,
    pageIds: pages.map((page) => page.id),
    pages,
    assessments,
    modelRoute: `${source.modelRoute}+teacher-summary-migration-v1`,
    qualityHarnessVersion: "ee680-pseudocode-v5",
    manifestHash: hashManifest(manifest)
  };
  await readweave.publishRelease(release, manifest, context(`migration:${releaseId}:publish`));
  for (const page of changedPages) {
    const draft: LessonDraft = {
      id: `draft:${page.id}`,
      workspaceId: "personal",
      courseId: release.courseId,
      moduleId: release.moduleId,
      sourceReleaseId: release.id,
      pageId: page.id,
      revision: 0,
      status: "clean",
      page: structuredClone(page),
      changedBlockIds: [],
      contentHash: sha256Text(stableStringify(page)),
      updatedAt: createdAt
    };
    await readweave.saveDraft(draft, 0, context(`migration:${releaseId}:draft:${page.pageNumber}`));
  }
  process.stdout.write(`PUBLISHED ${releaseId} pages=${pages.length} changedPages=${changedPages.length}\n`);
}

function replaceDeep<T>(value: T, replacements: Map<string, string>): T {
  if (typeof value === "string") {
    let result: string = value;
    for (const [from, to] of [...replacements.entries()].sort((left, right) => right[0].length - left[0].length)) result = result.split(from).join(to);
    return result as T;
  }
  if (Array.isArray(value)) return value.map((item) => replaceDeep(item, replacements)) as T;
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) result[key] = replaceDeep(child, replacements);
    return result as T;
  }
  return value;
}

function context(idempotencyKey: string): IdempotentWriteContext {
  return { idempotencyKey, actor: "course-os-pseudocode-migration", workspaceId: "personal", schemaVersion: COURSE_API_VERSION, requestId: idempotencyKey };
}
