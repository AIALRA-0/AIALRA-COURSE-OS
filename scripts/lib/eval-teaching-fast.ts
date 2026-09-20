import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type FailureCategory = "content" | "provider" | "network" | "input" | "unknown";

export interface FastEvaluationManifest {
  schemaVersion: 1;
  seed: string | number;
  concurrency: number;
  maxPages?: number;
  latestFormalPerModule?: boolean;
  selection?: {
    releaseIds?: string[];
    pageIds?: string[];
    pageNumbers?: number[];
    featureTags?: string[];
    domains?: string[];
  };
  tagsByPageId?: Record<string, string[]>;
  domainsByReleaseId?: Record<string, string[]>;
}

export interface FastEvaluationSource {
  releases?: unknown[];
  costEntries?: unknown[];
  generationJobs?: unknown[];
  generationPlans?: unknown[];
  events?: unknown[];
  generationEvents?: unknown[];
  errors?: unknown[];
  generationErrors?: unknown[];
  repairTickets?: unknown[];
  repairEvents?: unknown[];
  checkpoints?: unknown[];
  [key: string]: unknown;
}

export interface EvaluationIssue {
  code: string;
  category: FailureCategory;
  source: "quality" | "metadata" | "input";
}

export interface PageCostSummary {
  entryCount: number;
  estimatedMicrousd: number;
  actualMicrousd: number;
  durationMs: number;
  providers: string[];
  models: string[];
  stages: string[];
  statuses: string[];
}

export interface PageMetadataSummary {
  initial?: Record<string, unknown>;
  final: Record<string, unknown>;
  repairs: Array<Record<string, unknown>>;
  cost: PageCostSummary;
  providerFailures: number;
  networkFailures: number;
}

export interface FastEvaluationRow {
  key: string;
  releaseId: string;
  moduleId: string;
  pageId: string;
  pageNumber: number;
  title: string;
  featureTags: string[];
  domains: string[];
  score: number;
  publishable: boolean;
  issues: EvaluationIssue[];
  metadata: PageMetadataSummary;
}

export interface FailureCounts {
  content: number;
  provider: number;
  network: number;
  input: number;
  unknown: number;
}

export interface FastEvaluationResult {
  resultType: "course-os-fast-evaluation";
  schemaVersion: 1;
  setName: string;
  seed: string | number;
  manifest: FastEvaluationManifest;
  status: "passed" | "failed" | "degraded";
  availability: "complete" | "degraded";
  releaseCount: number;
  pageCount: number;
  selectedPageCount: number;
  averageScore: number;
  publishableCount: number;
  failureCounts: FailureCounts;
  cost: { entryCount: number; estimatedMicrousd: number; actualMicrousd: number; durationMs: number };
  rows: FastEvaluationRow[];
}

export interface FastEvaluationComparison {
  comparisonType: "course-os-fast-evaluation-comparison";
  baseline: { setName: string; pageCount: number; averageScore: number; cost: FastEvaluationResult["cost"] };
  candidate: { setName: string; pageCount: number; averageScore: number; cost: FastEvaluationResult["cost"] };
  matchedPageCount: number;
  baselineOnly: string[];
  candidateOnly: string[];
  scoreDelta: number;
  contentFailureDelta: number;
  providerFailureDelta: number;
  networkFailureDelta: number;
  costDeltaMicrousd: number;
  regressions: Array<{ key: string; scoreDelta: number; newIssues: string[] }>;
}

interface FastPageEvaluation {
  score: number;
  issues: string[];
  explanationCharacters: number;
  repeatedParagraphRatio: number;
}

interface NormalizedRelease {
  id: string;
  moduleId: string;
  moduleTitle: string;
  lifecycle?: string;
  version: number;
  pages: Array<Record<string, unknown>>;
  raw: Record<string, unknown>;
}

interface PageCandidate {
  release: NormalizedRelease;
  page: Record<string, unknown>;
  featureTags: string[];
  domains: string[];
}

const metadataKeys = new Set(["status", "state", "hash", "contentHash", "revision", "attempt", "stage", "phase", "provider", "model", "errorCode", "category", "createdAt", "updatedAt", "durationMs", "inputTokens", "outputTokens"]);

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizedText(value: unknown): string {
  return stringValue(value).toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return unique(value.filter((item): item is string => typeof item === "string").map(normalizedText));
  if (typeof value === "string") return unique(value.split(/[,|]/u).map(normalizedText));
  return [];
}

function releasePages(release: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(release.pages) ? release.pages.map(objectRecord).filter((page): page is Record<string, unknown> => Boolean(page)) : [];
}

function normalizeReleases(source: FastEvaluationSource): NormalizedRelease[] {
  const values = Array.isArray(source.releases) ? source.releases : [];
  return values.map(objectRecord).filter((release): release is Record<string, unknown> => Boolean(release)).map((release) => ({
    id: stringValue(release.id, "unknown-release"),
    moduleId: stringValue(release.moduleId, stringValue(release.id, "unknown-module")),
    moduleTitle: stringValue(release.moduleTitle),
    lifecycle: stringValue(release.lifecycle) || undefined,
    version: numberValue(release.version),
    pages: releasePages(release),
    raw: release
  }));
}

function pageKindTags(page: Record<string, unknown>): string[] {
  const tags: string[] = [];
  const explicit = [...asStringArray(page.tags), ...asStringArray(page.featureTags), ...asStringArray(page.features)];
  tags.push(...explicit);
  const atoms = Array.isArray(page.atoms) ? page.atoms.map(objectRecord).filter((atom): atom is Record<string, unknown> => Boolean(atom)) : [];
  const blocks = Array.isArray(page.blocks) ? page.blocks.map(objectRecord).filter((block): block is Record<string, unknown> => Boolean(block)) : [];
  const atomKinds = atoms.map((atom) => normalizedText(atom.kind));
  const blockKinds = blocks.map((block) => normalizedText(block.kind));
  const markdown = blocks.map((block) => stringValue(block.markdown)).join("\n");
  if (atomKinds.some((kind) => kind.includes("math")) || /\\(?:frac|sum|int|theta|nabla)|\$[^$]+\$/u.test(markdown)) tags.push("formula");
  if (atomKinds.some((kind) => kind.includes("code") || kind.includes("pseudo")) || /```/u.test(markdown)) tags.push("code");
  if (blockKinds.some((kind) => kind.includes("table")) || /\|[^\n]+\|/u.test(markdown)) tags.push("table");
  if (atomKinds.some((kind) => kind.includes("diagram") || kind.includes("figure") || kind.includes("graph")) || stringValue(page.imageUrl)) tags.push("visual");
  if (stringValue(page.title) || markdown) tags.push("text");
  return unique(tags);
}

function inferDomains(release: NormalizedRelease, page: Record<string, unknown>): string[] {
  return unique([
    ...asStringArray(release.raw.domain),
    ...asStringArray(release.raw.domains),
    ...asStringArray(page.domain),
    ...asStringArray(page.domains),
    normalizedText(release.moduleTitle),
    normalizedText(release.moduleId)
  ]);
}

function pageNumber(page: Record<string, unknown>): number {
  return numberValue(page.pageNumber, 0);
}

function stablePageKey(release: NormalizedRelease, page: Record<string, unknown>): string {
  const explicit = stringValue(page.id);
  return explicit || `${release.moduleId}:${pageNumber(page)}:${normalizedText(page.title)}`;
}

function latestFormalReleases(releases: NormalizedRelease[]): NormalizedRelease[] {
  const latest = new Map<string, NormalizedRelease>();
  for (const release of releases) {
    if (release.lifecycle === "draft_source") continue;
    const current = latest.get(release.moduleId);
    if (!current || release.version > current.version) latest.set(release.moduleId, release);
  }
  return [...latest.values()];
}

function matchesSelection(candidate: PageCandidate, manifest: FastEvaluationManifest): boolean {
  const selection = manifest.selection;
  if (!selection) return true;
  if (selection.releaseIds?.length && !selection.releaseIds.includes(candidate.release.id)) return false;
  if (selection.pageIds?.length && !selection.pageIds.includes(stringValue(candidate.page.id))) return false;
  if (selection.pageNumbers?.length && !selection.pageNumbers.includes(pageNumber(candidate.page))) return false;
  if (selection.featureTags?.length && !selection.featureTags.every((tag) => candidate.featureTags.includes(normalizedText(tag)))) return false;
  if (selection.domains?.length && !selection.domains.some((domain) => candidate.domains.includes(normalizedText(domain)))) return false;
  return true;
}

function selectPages(source: FastEvaluationSource, manifest: FastEvaluationManifest): PageCandidate[] {
  const releases = manifest.latestFormalPerModule === false ? normalizeReleases(source) : latestFormalReleases(normalizeReleases(source));
  const candidates = releases.flatMap((release) => release.pages.map((page) => ({
    release,
    page,
    featureTags: unique([...pageKindTags(page), ...(manifest.tagsByPageId?.[stringValue(page.id)] ?? []).map(normalizedText)]),
    domains: unique([...inferDomains(release, page), ...(manifest.domainsByReleaseId?.[release.id] ?? []).map(normalizedText)])
  }))).filter((candidate) => matchesSelection(candidate, manifest));
  const ranked = candidates.sort((left, right) => {
    const leftRank = stableHash(`${manifest.seed}:${stablePageKey(left.release, left.page)}`);
    const rightRank = stableHash(`${manifest.seed}:${stablePageKey(right.release, right.page)}`);
    return leftRank.localeCompare(rightRank);
  });
  return typeof manifest.maxPages === "number" ? ranked.slice(0, Math.max(0, manifest.maxPages)) : ranked;
}

function matchingPage(record: Record<string, unknown>, candidate: PageCandidate): boolean {
  const pageId = stringValue(candidate.page.id);
  const releaseId = candidate.release.id;
  const candidateJobId = stringValue(record.jobId);
  const directPage = stringValue(record.pageId) || stringValue(record.objectId);
  const recordReleaseId = stringValue(record.releaseId);
  const pageJobId = stringValue(candidate.page.jobId);
  return (directPage.length > 0 && directPage === pageId)
    || (recordReleaseId.length > 0 && recordReleaseId === releaseId)
    || (candidateJobId.length > 0 && pageJobId.length > 0 && candidateJobId === pageJobId);
}

function relatedRecords(source: FastEvaluationSource, keys: string[], candidate: PageCandidate): Record<string, unknown>[] {
  return keys.flatMap((key) => Array.isArray(source[key]) ? source[key].map(objectRecord).filter((record): record is Record<string, unknown> => Boolean(record)).filter((record) => matchingPage(record, candidate)) : []);
}

function classifyFailure(value: unknown): FailureCategory {
  const record = objectRecord(value);
  const text = normalizedText(record ? [record.code, record.errorCode, record.category, record.message, record.stage].join(" ") : value);
  if (/network|timeout|timed out|dns|socket|connection|etapi|fetch failed|econn|unreachable/u.test(text)) return "network";
  if (/provider|model|credential|quota|rate limit|429|401|403|5\d\d|llm/u.test(text)) return "provider";
  if (/quality|content|coverage|math|schema|structure|question|format|narrative|publishable|invalid teaching/u.test(text)) return "content";
  return "unknown";
}

function metadataSummary(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => metadataKeys.has(key)).map(([key, item]) => [key, item]));
}

function evaluatePageFast(page: Record<string, unknown>): FastPageEvaluation {
  const sections = Array.isArray(page.lessonSections) ? page.lessonSections.map(objectRecord).filter((section): section is Record<string, unknown> => Boolean(section)) : [];
  const sectionKinds = new Set(sections.map((section) => normalizedText(section.kind)));
  const requiredSections = ["learning_objectives", "main_content", "prior_knowledge", "full_explanation", "misconceptions"];
  const issues = requiredSections.filter((kind) => !sectionKinds.has(kind)).map((kind) => `TEACHING_SECTION_MISSING:${kind}`);
  const explanation = stringValue(sections.find((section) => normalizedText(section.kind) === "full_explanation")?.markdown).trim();
  if (explanation.length < 300) issues.push("TEACHING_EXPLANATION_TOO_SHORT");
  const paragraphs = explanation.split(/\n\s*\n/u).map((value) => value.replace(/[`*_>#-]/gu, "").replace(/\s+/gu, "").trim()).filter((value) => value.length >= 24);
  const counts = new Map<string, number>();
  for (const paragraph of paragraphs) counts.set(paragraph, (counts.get(paragraph) ?? 0) + 1);
  const repeatedParagraphRatio = paragraphs.length ? paragraphs.filter((paragraph) => (counts.get(paragraph) ?? 0) > 1).length / paragraphs.length : 1;
  if (repeatedParagraphRatio > 0.15) issues.push("TEACHING_REPETITION_TOO_HIGH");
  const questions = Array.isArray(page.questionBank) ? page.questionBank.map(objectRecord).filter((question): question is Record<string, unknown> => Boolean(question)).filter((question) => normalizedText(question.status) === "approved") : [];
  if (questions.length !== 4) issues.push("TEACHING_QUESTION_COUNT_INVALID");
  const quality = objectRecord(page.quality);
  if (quality?.mathValid === false) issues.push("TEACHING_MATH_INVALID");
  return { score: Math.max(0, Math.round((1 - Math.min(1, issues.length / 8)) * 100)), issues: unique(issues), explanationCharacters: explanation.length, repeatedParagraphRatio };
}

function pageMetadata(source: FastEvaluationSource, candidate: PageCandidate, pageEval: FastPageEvaluation): PageMetadataSummary {
  const costs = relatedRecords(source, ["costEntries", "costs"], candidate);
  const repairs = relatedRecords(source, ["repairTickets", "repairEvents", "repairs"], candidate).map(metadataSummary);
  const failures = relatedRecords(source, ["errors", "generationErrors", "events", "generationEvents"], candidate);
  const providerFailures = failures.filter((record) => classifyFailure(record) === "provider").length;
  const networkFailures = failures.filter((record) => classifyFailure(record) === "network").length;
  const initialRecord = relatedRecords(source, ["initial", "initialResults", "generationCheckpoints"], candidate)[0];
  const cost: PageCostSummary = {
    entryCount: costs.length,
    estimatedMicrousd: costs.reduce((sum, item) => sum + numberValue(item.estimatedMicrousd), 0),
    actualMicrousd: costs.reduce((sum, item) => sum + numberValue(item.actualMicrousd), 0),
    durationMs: costs.reduce((sum, item) => sum + numberValue(item.durationMs), 0),
    providers: unique(costs.map((item) => normalizedText(item.provider))),
    models: unique(costs.map((item) => normalizedText(item.model))),
    stages: unique(costs.map((item) => normalizedText(item.stage))),
    statuses: unique(costs.map((item) => normalizedText(item.status)))
  };
  return {
    initial: initialRecord ? metadataSummary(initialRecord) : undefined,
    final: { score: pageEval.score, publishable: Boolean(objectRecord(candidate.page.quality)?.publishable), issueCount: pageEval.issues.length },
    repairs,
    cost,
    providerFailures,
    networkFailures
  };
}

function contentIssues(page: Record<string, unknown>, pageEval: FastPageEvaluation): EvaluationIssue[] {
  const quality = objectRecord(page.quality);
  const publishable = Boolean(quality?.publishable);
  const issueCodes = [...pageEval.issues];
  if (!publishable) issueCodes.push("PAGE_NOT_PUBLISHABLE");
  return unique(issueCodes).map((code) => ({ code, category: "content" as const, source: "quality" as const }));
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, items.length)) }, () => worker()));
  return results;
}

export async function loadEvaluationSource(path: string): Promise<FastEvaluationSource> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (Array.isArray(parsed)) return { releases: parsed };
  const record = objectRecord(parsed);
  if (!record) throw new Error(`EVALUATION_INPUT_NOT_OBJECT:${path}`);
  if (record.resultType === "course-os-fast-evaluation") throw new Error(`EVALUATION_INPUT_IS_RESULT_SET:${path}`);
  return record as FastEvaluationSource;
}

export async function loadEvaluationManifest(path: string): Promise<FastEvaluationManifest> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  const manifest = objectRecord(parsed);
  if (!manifest || manifest.schemaVersion !== 1 || manifest.seed === undefined) throw new Error(`EVALUATION_MANIFEST_INVALID:${path}`);
  const concurrency = numberValue(manifest.concurrency, 1);
  if (concurrency < 1) throw new Error("EVALUATION_MANIFEST_CONCURRENCY_INVALID");
  return { ...manifest, concurrency: Math.floor(concurrency) } as FastEvaluationManifest;
}

export async function runFastEvaluation(source: FastEvaluationSource, manifest: FastEvaluationManifest, setName = "local"): Promise<FastEvaluationResult> {
  const selected = selectPages(source, manifest);
  const rows = await mapWithConcurrency(selected, manifest.concurrency, async (candidate): Promise<FastEvaluationRow> => {
    let pageEval: FastPageEvaluation;
    let issues: EvaluationIssue[];
    try {
      pageEval = evaluatePageFast(candidate.page);
      issues = contentIssues(candidate.page, pageEval);
    } catch (error) {
      pageEval = { score: 0, issues: [String(error)], explanationCharacters: 0, repeatedParagraphRatio: 1 };
      issues = [{ code: "PAGE_EVALUATION_FAILED", category: "content", source: "input" }];
    }
    const metadata = pageMetadata(source, candidate, pageEval);
    const failures = relatedRecords(source, ["errors", "generationErrors", "events", "generationEvents"], candidate)
      .map((record) => ({ record, category: classifyFailure(record) }))
      .filter(({ category }) => category === "provider" || category === "network" || category === "unknown");
    issues.push(...failures.map(({ record, category }) => ({ code: stringValue(record.code, stringValue(record.errorCode, "GENERATION_FAILURE")), category, source: "metadata" as const })));
    return {
      key: stablePageKey(candidate.release, candidate.page),
      releaseId: candidate.release.id,
      moduleId: candidate.release.moduleId,
      pageId: stringValue(candidate.page.id, stablePageKey(candidate.release, candidate.page)),
      pageNumber: pageNumber(candidate.page),
      title: stringValue(candidate.page.title, "Untitled page"),
      featureTags: candidate.featureTags,
      domains: candidate.domains,
      score: pageEval.score,
      publishable: Boolean(objectRecord(candidate.page.quality)?.publishable),
      issues,
      metadata
    };
  });
  const failureCounts: FailureCounts = { content: 0, provider: 0, network: 0, input: 0, unknown: 0 };
  for (const row of rows) for (const issue of row.issues) failureCounts[issue.category] += 1;
  const metadataRecords = ["errors", "generationErrors", "events", "generationEvents"].flatMap((key) => Array.isArray(source[key]) ? source[key].map(objectRecord).filter((record): record is Record<string, unknown> => Boolean(record)) : []);
  for (const record of metadataRecords) {
    const hasPageIdentity = ["pageId", "objectId", "jobId", "releaseId"].some((key) => stringValue(record[key]).length > 0);
    if (!hasPageIdentity) {
      const category = classifyFailure(record);
      if (category === "provider" || category === "network" || category === "unknown") failureCounts[category] += 1;
    }
  }
  const cost = rows.reduce((summary, row) => ({
    entryCount: summary.entryCount + row.metadata.cost.entryCount,
    estimatedMicrousd: summary.estimatedMicrousd + row.metadata.cost.estimatedMicrousd,
    actualMicrousd: summary.actualMicrousd + row.metadata.cost.actualMicrousd,
    durationMs: summary.durationMs + row.metadata.cost.durationMs
  }), { entryCount: 0, estimatedMicrousd: 0, actualMicrousd: 0, durationMs: 0 });
  const status = failureCounts.content || failureCounts.input ? "failed" : failureCounts.provider || failureCounts.network || failureCounts.unknown ? "degraded" : "passed";
  return {
    resultType: "course-os-fast-evaluation",
    schemaVersion: 1,
    setName,
    seed: manifest.seed,
    manifest,
    status,
    availability: status === "degraded" ? "degraded" : "complete",
    releaseCount: normalizeReleases(source).length,
    pageCount: normalizeReleases(source).reduce((sum, release) => sum + release.pages.length, 0),
    selectedPageCount: rows.length,
    averageScore: rows.length ? Math.round(rows.reduce((sum, row) => sum + row.score, 0) / rows.length) : 0,
    publishableCount: rows.filter((row) => row.publishable).length,
    failureCounts,
    cost,
    rows
  };
}

export function compareFastEvaluations(baseline: FastEvaluationResult, candidate: FastEvaluationResult): FastEvaluationComparison {
  const baselineByKey = new Map(baseline.rows.map((row) => [row.key, row]));
  const candidateByKey = new Map(candidate.rows.map((row) => [row.key, row]));
  const matched = [...candidateByKey.keys()].filter((key) => baselineByKey.has(key));
  const regressions = matched.flatMap((key) => {
    const left = baselineByKey.get(key)!;
    const right = candidateByKey.get(key)!;
    const newIssues = right.issues.map((issue) => issue.code).filter((code) => !left.issues.some((issue) => issue.code === code));
    return right.score < left.score || newIssues.length ? [{ key, scoreDelta: right.score - left.score, newIssues }] : [];
  });
  return {
    comparisonType: "course-os-fast-evaluation-comparison",
    baseline: { setName: baseline.setName, pageCount: baseline.selectedPageCount, averageScore: baseline.averageScore, cost: baseline.cost },
    candidate: { setName: candidate.setName, pageCount: candidate.selectedPageCount, averageScore: candidate.averageScore, cost: candidate.cost },
    matchedPageCount: matched.length,
    baselineOnly: [...baselineByKey.keys()].filter((key) => !candidateByKey.has(key)).sort(),
    candidateOnly: [...candidateByKey.keys()].filter((key) => !baselineByKey.has(key)).sort(),
    scoreDelta: candidate.averageScore - baseline.averageScore,
    contentFailureDelta: candidate.failureCounts.content - baseline.failureCounts.content,
    providerFailureDelta: candidate.failureCounts.provider - baseline.failureCounts.provider,
    networkFailureDelta: candidate.failureCounts.network - baseline.failureCounts.network,
    costDeltaMicrousd: candidate.cost.actualMicrousd - baseline.cost.actualMicrousd,
    regressions
  };
}

export function formatFastEvaluationMarkdown(result: FastEvaluationResult, comparison?: FastEvaluationComparison): string {
  const failures = Object.entries(result.failureCounts).map(([key, value]) => `${key}=${value}`).join(", ");
  const lines = [
    `# Fast teaching evaluation: ${result.setName}`,
    "",
    `- Status: ${result.status}`,
    `- Selected pages: ${result.selectedPageCount}/${result.pageCount}`,
    `- Average score: ${result.averageScore}`,
    `- Publishable pages: ${result.publishableCount}/${result.selectedPageCount}`,
    `- Failures: ${failures}`,
    `- Cost: estimated ${result.cost.estimatedMicrousd}µUSD, actual ${result.cost.actualMicrousd}µUSD, ${result.cost.entryCount} entries`,
    ""
  ];
  if (comparison) {
    lines.push("## Comparison", "", `- Matched pages: ${comparison.matchedPageCount}`, `- Score delta: ${comparison.scoreDelta >= 0 ? "+" : ""}${comparison.scoreDelta}`, `- Content failure delta: ${comparison.contentFailureDelta >= 0 ? "+" : ""}${comparison.contentFailureDelta}`, `- Provider failure delta: ${comparison.providerFailureDelta >= 0 ? "+" : ""}${comparison.providerFailureDelta}`, `- Network failure delta: ${comparison.networkFailureDelta >= 0 ? "+" : ""}${comparison.networkFailureDelta}`, `- Actual cost delta: ${comparison.costDeltaMicrousd >= 0 ? "+" : ""}${comparison.costDeltaMicrousd}µUSD`, `- Regressions: ${comparison.regressions.length}`, "");
  }
  return `${lines.join("\n")}\n`;
}
