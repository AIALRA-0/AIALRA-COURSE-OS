import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CourseRelease, MathExpression, PageLesson, PseudoCodeLine } from "@course-os/contracts";
import type { ReadWeaveFileState } from "@course-os/readweave-adapter";
import { calculateCoverage, validateMathAtoms, validatePageForPublication, validatePseudoCodeLines } from "@course-os/quality";

const dataDir = resolve(process.env.COURSE_OS_DATA_DIR || "./var");
const statePath = resolve(dataDir, "readweave-course-store.json");
const state = JSON.parse(await readFile(statePath, "utf8")) as ReadWeaveFileState;
const releases = state.releases.filter((release) => release.courseId === "usc-ee680" && release.lifecycle !== "draft_source" && !/(synthetic|golden|regression|legacy)/i.test(`${release.id} ${release.courseTitle} ${release.moduleTitle}`));

const latestByModule = new Map<string, CourseRelease>();
for (const release of releases) {
  const current = latestByModule.get(release.moduleId);
  if (!current || release.version > current.version || (release.version === current.version && release.publishedAt > current.publishedAt)) latestByModule.set(release.moduleId, release);
}

const expectedPages: Record<string, number> = {
  "ee680-introduction": 25,
  "ee680-chapter-2": 47
};
const issues: Array<{ releaseId: string; pageId?: string; code: string }> = [];
const moduleReports = [...latestByModule.values()].sort((left, right) => left.moduleId.localeCompare(right.moduleId)).map((release) => {
  const expected = expectedPages[release.moduleId];
  if (expected === undefined) issues.push({ releaseId: release.id, code: "UNEXPECTED_MODULE" });
  if (expected !== undefined && release.pages.length !== expected) issues.push({ releaseId: release.id, code: `PAGE_COUNT_EXPECTED_${expected}_ACTUAL_${release.pages.length}` });
  const sorted = [...release.pages].sort((left, right) => left.pageNumber - right.pageNumber);
  const expectedNumbers = Array.from({ length: sorted.length }, (_, index) => index + 1);
  if (sorted.some((page, index) => page.pageNumber !== expectedNumbers[index])) issues.push({ releaseId: release.id, code: "PAGE_NUMBERS_NOT_CONTIGUOUS" });
  const pageReports = sorted.map((page) => inspectPage(release, page));
  return {
    releaseId: release.id,
    moduleId: release.moduleId,
    version: release.version,
    pages: release.pages.length,
    publishablePages: pageReports.filter((page) => page.publishable).length,
    mathExpressions: pageReports.reduce((sum, page) => sum + page.mathExpressions, 0),
    pseudocodeLines: pageReports.reduce((sum, page) => sum + page.pseudocodeLines, 0),
    approvedQuestions: pageReports.reduce((sum, page) => sum + page.approvedQuestions, 0)
  };
});

if (latestByModule.size !== Object.keys(expectedPages).length) issues.push({ releaseId: "usc-ee680", code: `MODULE_COUNT_EXPECTED_${Object.keys(expectedPages).length}_ACTUAL_${latestByModule.size}` });

const report = {
  checkedAt: new Date().toISOString(),
  courseId: "usc-ee680",
  source: "local ReadWeave state",
  releasesChecked: moduleReports.length,
  modules: moduleReports,
  issueCount: issues.length,
  issues
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (issues.length) process.exitCode = 1;

function inspectPage(release: CourseRelease, page: PageLesson) {
  const pageIssues = validatePageForPublication(page);
  for (const code of pageIssues) issues.push({ releaseId: release.id, pageId: page.id, code: publicIssueCode(code) });
  const coverage = calculateCoverage(page.coverageRequirements, page.coverageClaims);
  if (coverage.highRiskCoverage < 1) issues.push({ releaseId: release.id, pageId: page.id, code: "HIGH_RISK_COVERAGE_BELOW_100" });
  if (coverage.generalCoverage < 0.98) issues.push({ releaseId: release.id, pageId: page.id, code: "GENERAL_COVERAGE_BELOW_98" });
  if (!/^\/api\/v1\/media\/[a-f0-9]{64}$/i.test(page.imageUrl)) issues.push({ releaseId: release.id, pageId: page.id, code: "IMAGE_URL_NOT_CONTENT_ADDRESSED" });
  const math = page.atoms.filter((atom): atom is MathExpression => atom.kind === "math_expression");
  const pseudo = page.atoms.filter((atom): atom is PseudoCodeLine => atom.kind === "pseudocode_line");
  for (const code of validateMathAtoms(math)) issues.push({ releaseId: release.id, pageId: page.id, code: publicIssueCode(code) });
  for (const code of validatePseudoCodeLines(pseudo)) issues.push({ releaseId: release.id, pageId: page.id, code: publicIssueCode(code) });
  const approvedQuestions = page.questionBank?.filter((item) => item.status === "approved") ?? [];
  if (approvedQuestions.length < 4) issues.push({ releaseId: release.id, pageId: page.id, code: "APPROVED_QUESTION_COUNT_BELOW_4" });
  if (approvedQuestions.filter((item) => item.kind === "comprehension").length < 2) issues.push({ releaseId: release.id, pageId: page.id, code: "COMPREHENSION_QUESTION_COUNT_BELOW_2" });
  if (approvedQuestions.filter((item) => item.kind === "multiple_choice").length < 2) issues.push({ releaseId: release.id, pageId: page.id, code: "MULTIPLE_CHOICE_COUNT_BELOW_2" });
  return {
    publishable: pageIssues.length === 0 && coverage.publishable,
    mathExpressions: math.length,
    pseudocodeLines: pseudo.length,
    approvedQuestions: approvedQuestions.length
  };
}

function publicIssueCode(value: string): string {
  const separator = value.indexOf(":");
  return separator >= 0 ? value.slice(separator + 1) : value;
}
