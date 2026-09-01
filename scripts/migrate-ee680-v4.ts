import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { COURSE_API_VERSION, type CourseRelease, type LessonDraft, type PageLesson, type ReleaseManifest } from "@course-os/contracts";
import { hashManifest, sha256Text, stableStringify } from "@course-os/domain";
import { FileReadWeaveCourseApi, type ReadWeaveFileState } from "@course-os/readweave-adapter";
import { calculateCoverage, validateMarkdownMath, validateMathAtoms, validatePageForPublication } from "@course-os/quality";
import { splitSentences } from "@course-os/teaching";

const dataDir = resolve(process.env.COURSE_OS_DATA_DIR || "./var");
const statePath = resolve(dataDir, "readweave-course-store.json");
const readweave = new FileReadWeaveCourseApi(statePath);
const now = new Date().toISOString();

const sourceState = JSON.parse(await readFile(statePath, "utf8")) as ReadWeaveFileState;
const expectedModules = ["ee680-introduction", "ee680-chapter-2"];

for (const moduleId of expectedModules) {
  const candidates = sourceState.releases
    .filter((release) => release.moduleId === moduleId && release.lifecycle !== "draft_source" && !/-v4$/.test(release.id))
    .sort((left, right) => right.version - left.version || right.publishedAt.localeCompare(left.publishedAt));
  const source = candidates[0];
  if (!source) throw new Error(`SOURCE_RELEASE_NOT_FOUND:${moduleId}`);
  const releaseId = source.id.replace(/-v\d+$/, "-v4");
  if (await readweave.getRelease(releaseId)) {
    process.stdout.write(`SKIP ${releaseId} already exists\n`);
    continue;
  }

  const pageIdMap = new Map<string, string>();
  for (const page of source.pages) pageIdMap.set(page.id, `${releaseId}:page:${page.pageNumber}`);
  const pages = source.pages.map((page) => repairPage(replaceDeep(page, pageIdMap) as PageLesson));
  const assessments = source.assessments.map((assessment) => replaceDeep(assessment, pageIdMap));
  const release: CourseRelease = {
    ...structuredClone(source),
    id: releaseId,
    version: source.version + 1,
    publishedAt: now,
    lifecycle: "published",
    pageIds: pages.map((page) => page.id),
    pages,
    assessments,
    modelRoute: `${source.modelRoute}+math-aware-migration-v1`,
    qualityHarnessVersion: "ee680-full-v4",
    manifestHash: ""
  };
  const oldManifest = await readweave.getManifest(source.id);
  const manifest: ReleaseManifest = {
    id: `${releaseId}:manifest`,
    schemaVersion: oldManifest?.schemaVersion ?? "2.1.0",
    courseReleaseId: releaseId,
    sourceHashes: oldManifest?.sourceHashes ?? [],
    pageHashes: pages.map((page) => sha256Text(stableStringify(page))),
    explanationHashes: pages.flatMap((page) => page.blocks.map((block) => sha256Text(stableStringify(block)))),
    assessmentHashes: assessments.map((assessment) => sha256Text(stableStringify(assessment))),
    writingPolicySnapshotId: source.writingPolicySnapshotId,
    modelRoutes: [...new Set([...(oldManifest?.modelRoutes ?? []), "math-aware-migration-v1"])],
    qualityHarnessVersion: "ee680-full-v4",
    costInputs: oldManifest?.costInputs ?? [],
    createdAt: now
  };
  release.manifestHash = hashManifest(manifest);
  await readweave.publishRelease(release, manifest, context(`migration:${releaseId}:publish`));

  for (const page of pages) {
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
      updatedAt: now
    };
    await readweave.saveDraft(draft, 0, context(`migration:${releaseId}:draft:${page.pageNumber}`));
  }
  process.stdout.write(`PUBLISHED ${releaseId} pages=${pages.length}\n`);
}

function repairPage(page: PageLesson): PageLesson {
  const repaired = structuredClone(page);
  const blockByKind = new Map(repaired.blocks.map((block) => [block.kind, block]));
  for (const section of repaired.lessonSections ?? []) {
    if (section.kind !== "learning_objectives" && section.kind !== "prior_knowledge" && section.kind !== "misconceptions") continue;
    const blockKind = section.kind === "learning_objectives" ? "objective" : section.kind === "prior_knowledge" ? "prerequisite" : "misconception";
    const source = blockByKind.get(blockKind)?.markdown ?? section.items?.map((item) => item.text).join("\n") ?? "";
    section.items = splitSentences(source).map((text, index) => ({
      id: `${section.id}:item:${index + 1}`,
      text,
      sourceAnchorIds: [...section.sourceAnchorIds]
    }));
  }
  repaired.quality = { ...repaired.quality, issues: [] };
  const validationIssues = validatePageForPublication(repaired);
  const coverage = calculateCoverage(repaired.coverageRequirements, repaired.coverageClaims);
  const mathIssues = [
    ...validateMathAtoms(repaired.atoms.filter((atom) => atom.kind === "math_expression")),
    ...repaired.blocks.flatMap((block) => validateMarkdownMath(block.markdown)),
    ...(repaired.lessonSections ?? []).flatMap((section) => [
      ...(section.markdown ? validateMarkdownMath(section.markdown) : []),
      ...(section.items ?? []).flatMap((item) => validateMarkdownMath(item.text))
    ])
  ];
  repaired.quality = {
    highRiskCoverage: coverage.highRiskCoverage,
    generalCoverage: coverage.generalCoverage,
    mathValid: mathIssues.length === 0,
    publishable: validationIssues.length === 0 && coverage.publishable,
    issues: validationIssues
  };
  if (!repaired.quality.publishable) throw new Error(`MIGRATION_PAGE_NOT_PUBLISHABLE:${page.id}:${validationIssues.join("|")}`);
  return repaired;
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

function context(idempotencyKey: string) {
  return { idempotencyKey, actor: "course-os-migration", workspaceId: "personal", schemaVersion: COURSE_API_VERSION, requestId: idempotencyKey };
}
