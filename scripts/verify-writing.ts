import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CourseRelease, MathExpression, PageLesson, PseudoCodeLine } from "@course-os/contracts";
import { sha256Text, stableStringify } from "@course-os/domain";
import type { ReadWeaveFileState } from "@course-os/readweave-adapter";
import { validateMarkdownMath, validateMathAtoms, validatePageForPublication, validatePseudoCodeLines } from "@course-os/quality";

interface WritingPolicyManifest {
  schemaVersion: "1.0.0";
  policySnapshotId: string;
  files: Array<{ path: string; sourcePath: string; sha256: string }>;
  aggregateSha256: string;
}

const manifestPath = resolve("config/writing-policy-manifest.json");
const policyIssues: string[] = [];
let manifest: WritingPolicyManifest | undefined;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8")) as WritingPolicyManifest;
} catch {
  policyIssues.push("WRITING_POLICY_MANIFEST_MISSING_OR_INVALID");
}

if (manifest) {
  if (manifest.schemaVersion !== "1.0.0") policyIssues.push("WRITING_POLICY_MANIFEST_SCHEMA_UNSUPPORTED");
  if (!/^writing-policy:[a-f0-9]{16}$/.test(manifest.policySnapshotId)) policyIssues.push("WRITING_POLICY_SNAPSHOT_ID_INVALID");
  if (!manifest.files.length || manifest.files.some((file) => !/^[a-f0-9]{64}$/.test(file.sha256) || !file.path || !file.sourcePath)) policyIssues.push("WRITING_POLICY_FILE_ENTRY_INVALID");
  const aggregate = sha256Text(stableStringify(manifest.files.map(({ path, sha256 }) => ({ path, sha256 }))));
  if (aggregate !== manifest.aggregateSha256 || manifest.policySnapshotId !== `writing-policy:${aggregate.slice(0, 16)}`) policyIssues.push("WRITING_POLICY_MANIFEST_HASH_MISMATCH");
}

const configuredSkillRoot = process.env.HUMAN_READABLE_SKILL_DIR || process.env.HUMAN_WRITING_SKILL_DIR;
const sourceVerification = configuredSkillRoot ? "source_and_manifest" : "manifest_only";
if (manifest && configuredSkillRoot) {
  const skillRoot = resolve(configuredSkillRoot);
  for (const file of manifest.files) {
    try {
      const bytes = await readFile(resolve(skillRoot, file.sourcePath));
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== file.sha256) policyIssues.push(`WRITING_POLICY_SOURCE_HASH_MISMATCH:${file.path}`);
    } catch {
      policyIssues.push(`WRITING_POLICY_SOURCE_FILE_MISSING:${file.path}`);
    }
  }
}

const statePath = resolve(process.env.COURSE_OS_DATA_DIR || "./var", "readweave-course-store.json");
let state: ReadWeaveFileState | undefined;
try {
  state = JSON.parse(await readFile(statePath, "utf8")) as ReadWeaveFileState;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

if (!state) {
  const status = policyIssues.length ? "failed" : "passed";
  process.stdout.write(`${JSON.stringify({ status, checkedAt: new Date().toISOString(), contract: "2.4.0", policy: publicPolicyReport(), sourceVerification, courseContent: "not_present", issueCount: policyIssues.length, issues: policyIssues }, null, 2)}\n`);
  if (policyIssues.length) process.exitCode = 1;
} else {
  const archivedCourseIds = new Set(state.courses.filter((course) => course.status === "archived").map((course) => course.id));
  const courseIds = new Set([
    ...state.courses.filter((course) => course.status !== "archived" && !isRegressionAsset(course.id, course.title)).map((course) => course.id),
    ...state.releases.filter((release) => !archivedCourseIds.has(release.courseId) && !isRegressionAsset(release.courseId, release.courseTitle)).map((release) => release.courseId)
  ]);
  const currentByModule = new Map<string, CourseRelease>();
  for (const release of state.releases) {
    if (release.lifecycle === "draft_source" || !courseIds.has(release.courseId) || isRegressionAsset(release.id, `${release.courseTitle} ${release.moduleTitle}`)) continue;
    const key = `${release.courseId}\u0000${release.moduleId}`;
    const current = currentByModule.get(key);
    if (!current || release.version > current.version || (release.version === current.version && release.publishedAt > current.publishedAt)) currentByModule.set(key, release);
  }

  const issues: Array<{ releaseId: string; pageId?: string; code: string }> = policyIssues.map((code) => ({ releaseId: "writing-policy", code }));
  let pseudocodeLines = 0;
  let mathExpressions = 0;
  for (const release of currentByModule.values()) {
    if (manifest && release.writingPolicySnapshotId !== manifest.policySnapshotId) issues.push({ releaseId: release.id, code: "WRITING_POLICY_SNAPSHOT_NOT_APPROVED" });
    for (const page of release.pages) inspectPage(release, page);
  }

  const report = {
    status: issues.length ? "failed" : "passed",
    checkedAt: new Date().toISOString(),
    contract: "2.4.0",
    policy: publicPolicyReport(),
    sourceVerification,
    releaseCount: currentByModule.size,
    pageCount: [...currentByModule.values()].reduce((sum, release) => sum + release.pages.length, 0),
    pseudocodeLines,
    mathExpressions,
    issueCount: issues.length,
    issues
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (issues.length) process.exitCode = 1;

  function inspectPage(release: CourseRelease, page: PageLesson): void {
    for (const code of validatePageForPublication(page)) issues.push({ releaseId: release.id, pageId: page.id, code: publicCode(code) });
    const math = page.atoms.filter((atom): atom is MathExpression => atom.kind === "math_expression");
    const pseudo = page.atoms.filter((atom): atom is PseudoCodeLine => atom.kind === "pseudocode_line");
    mathExpressions += math.length;
    pseudocodeLines += pseudo.length;
    for (const code of validateMathAtoms(math)) issues.push({ releaseId: release.id, pageId: page.id, code: publicCode(code) });
    for (const code of validatePseudoCodeLines(pseudo)) issues.push({ releaseId: release.id, pageId: page.id, code: publicCode(code) });
    const markdown = [
      ...page.blocks.map((block) => ({ id: block.id, text: block.markdown })),
      ...(page.lessonSections ?? []).flatMap((section) => [
        ...(section.markdown ? [{ id: section.id, text: section.markdown }] : []),
        ...(section.items ?? []).map((item) => ({ id: item.id, text: item.text }))
      ])
    ];
    for (const block of markdown) for (const code of validateMarkdownMath(block.text)) issues.push({ releaseId: release.id, pageId: page.id, code: `${block.id}:${publicCode(code)}` });
  }
}

function publicPolicyReport() {
  return manifest ? { manifest: "config/writing-policy-manifest.json", schemaVersion: manifest.schemaVersion, policySnapshotId: manifest.policySnapshotId, files: manifest.files.map(({ path, sha256 }) => ({ path, sha256 })), aggregateSha256: manifest.aggregateSha256 } : { manifest: "config/writing-policy-manifest.json" };
}

function publicCode(value: string): string {
  const separator = value.indexOf(":");
  return separator >= 0 ? value.slice(separator + 1) : value;
}

function isRegressionAsset(...values: string[]): boolean {
  return /(synthetic|golden|regression|legacy|test-course)/i.test(values.join(" "));
}
