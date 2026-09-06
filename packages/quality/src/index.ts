import katex from "katex";
import type { CoverageClaim, CoverageRequirement, MathExpression, PageLesson, PseudoCodeLine } from "@course-os/contracts";

export interface CoverageResult {
  highRiskCoverage: number;
  generalCoverage: number;
  missing: Array<{ requirementId: string; fields: string[] }>;
  publishable: boolean;
}

export interface ReleaseClosureResult {
  ready: boolean;
  issues: string[];
  pageCount: number;
}

export interface TeachingEvalResult {
  score: number;
  issues: string[];
  explanationCharacters: number;
  repeatedParagraphRatio: number;
}

/** Deterministic regression rubric for compiled learner pages. */
export function evaluateTeachingPage(page: PageLesson): TeachingEvalResult {
  const sections = page.lessonSections ?? [];
  const explanation = sections.find((section) => section.kind === "full_explanation")?.markdown?.trim() ?? "";
  const required = ["learning_objectives", "main_content", "prior_knowledge", "full_explanation", "misconceptions"];
  const issues = required.filter((kind) => !sections.some((section) => section.kind === kind)).map((kind) => `TEACHING_SECTION_MISSING:${kind}`);
  if (explanation.length < 300) issues.push("TEACHING_EXPLANATION_TOO_SHORT");
  const paragraphs = explanation.split(/\n\s*\n/).map((value) => value.replace(/[`*_>#-]/g, "").replace(/\s+/g, "").trim()).filter((value) => value.length >= 24);
  const counts = new Map<string, number>();
  for (const paragraph of paragraphs) counts.set(paragraph, (counts.get(paragraph) ?? 0) + 1);
  const repeatedParagraphRatio = paragraphs.length ? paragraphs.filter((paragraph) => (counts.get(paragraph) ?? 0) > 1).length / paragraphs.length : 1;
  if (repeatedParagraphRatio > 0.15) issues.push("TEACHING_REPETITION_TOO_HIGH");
  const forbidden = ["页面元素核对", "来源状态", "等待审核", "等待验证", "模型推断", "已覆盖"];
  for (const phrase of forbidden) if (explanation.includes(phrase)) issues.push(`TEACHING_METADATA_NOISE:${phrase}`);
  const questions = page.questionBank?.filter((question) => question.status === "approved") ?? [];
  if (questions.length !== 4) issues.push("TEACHING_QUESTION_COUNT_INVALID");
  const score = Math.max(0, Math.round((1 - Math.min(1, issues.length / 8)) * 100));
  return { score, issues: [...new Set(issues)], explanationCharacters: explanation.length, repeatedParagraphRatio };
}

/** A release is usable only when every persisted page is independently publishable. */
export function evaluateReleaseClosure(release: { pages: PageLesson[]; pageIds: string[] }): ReleaseClosureResult {
  const issues = [...(release.pageIds.length === release.pages.length ? [] : ["RELEASE_PAGE_SET_MISMATCH"]),
    ...release.pages.flatMap((page) => validatePageForPublication(page).map((issue) => `${page.id}:${issue}`))];
  return { ready: issues.length === 0 && release.pages.length > 0, issues, pageCount: release.pages.length };
}

export interface TeachingNarrativeInput {
  learningObjectives: string[];
  mainContentMarkdown: string;
  priorKnowledge: string[];
  fullExplanationMarkdown: string;
  misconceptions: string[];
  questions: Array<{ prompt: string; explanation: string }>;
}

/**
 * Checks the learner-facing narrative, not the provenance metadata.  A page
 * can have perfect atom bookkeeping and still read like an internal audit
 * log, so these checks deliberately run before a generated draft is saved.
 */
export function validateTeachingNarrative(input: TeachingNarrativeInput): string[] {
  const issues: string[] = [];
  const explanation = input.fullExplanationMarkdown.trim();
  const requiredHeadings = [
    "先说这页要解决什么",
    "先读原对象",
    "解释核心关系",
    "做一个例子或计算",
    "边界与易错点",
    "最后回收"
  ];
  let previous = -1;
  const positions: number[] = [];
  for (const heading of requiredHeadings) {
    const position = explanation.indexOf(`## ${heading}`);
    positions.push(position);
    if (position < 0) issues.push(`TEACHING_STRUCTURE_MISSING:${heading}`);
    else if (position < previous) issues.push(`TEACHING_STRUCTURE_ORDER:${heading}`);
    else previous = position;
  }
  for (let index = 0; index < requiredHeadings.length; index += 1) {
    const position = positions[index]!;
    if (position < 0) continue;
    const nextPosition = positions.slice(index + 1).find((candidate) => candidate >= 0) ?? explanation.length;
    const body = explanation.slice(position + (`## ${requiredHeadings[index]}`).length, nextPosition)
      .replace(/[`*_>#-]/g, "")
      .replace(/\s+/g, "")
      .trim();
    if (body.length < 18) issues.push(`TEACHING_SECTION_TOO_SHORT:${requiredHeadings[index]}`);
  }

  const learnerText = [
    input.learningObjectives.join("\n"),
    input.mainContentMarkdown,
    input.priorKnowledge.join("\n"),
    input.fullExplanationMarkdown,
    input.misconceptions.join("\n"),
    input.questions.map((question) => `${question.prompt}\n${question.explanation}`).join("\n")
  ].join("\n");
  const forbidden = [
    "页面元素核对",
    "来源状态",
    "等待审核",
    "等待验证",
    "模型推断",
    "已覆盖",
    "需要结合左侧原图",
    "来源冲突必须进入人工审核"
  ];
  for (const phrase of forbidden) if (learnerText.includes(phrase)) issues.push(`TEACHING_METADATA_NOISE:${phrase}`);

  const paragraphs = explanation.split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/^#+\s*/, "").replace(/[`*_>#-]/g, "").replace(/\s+/g, "").trim())
    .filter((paragraph) => paragraph.length >= 24);
  const counts = new Map<string, number>();
  for (const paragraph of paragraphs) counts.set(paragraph, (counts.get(paragraph) ?? 0) + 1);
  if ([...counts.values()].some((count) => count > 1)) issues.push("TEACHING_REPEATED_PARAGRAPH");

  const contentSentences = input.fullExplanationMarkdown
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim())
    .filter((line) => line.length >= 18 && !line.startsWith("## "));
  const uniqueSentences = new Set(contentSentences.map((line) => line.replace(/\s+/g, "")));
  if (contentSentences.length >= 8 && uniqueSentences.size / contentSentences.length < 0.78) issues.push("TEACHING_REPETITION_RATIO_LOW");
  return [...new Set(issues)];
}

export function validateTex(sourceTex: string): { valid: true; normalizedTex: string } | { valid: false; error: string } {
  const normalizedTex = sourceTex.trim();
  if (!normalizedTex) return { valid: false, error: "MATH_EMPTY" };
  try {
    katex.renderToString(normalizedTex, { throwOnError: true, strict: "error", output: "htmlAndMathml" });
    return { valid: true, normalizedTex };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : "MATH_PARSE_FAILED" };
  }
}

export function validateMathAtoms(expressions: MathExpression[]): string[] {
  return expressions.flatMap((expression) => {
    const result = validateTex(expression.normalizedTex || expression.sourceTex);
    return result.valid ? [] : [`${expression.id}:${result.error}`];
  });
}

export function validateMarkdownMath(markdown: string): string[] {
  const initial = scanMarkdownMath(markdown);
  const normalized = normalizeBareTexFragments(initial.normalized);
  const scanned = normalized === initial.normalized ? initial : scanMarkdownMath(normalized);
  return [...scanned.issues, ...scanned.formulas.flatMap((tex) => {
    const result = validateTex(tex);
    return result.valid ? [] : [result.error];
  })];
}

/** Convert legacy TeX delimiters before Markdown parsing
 *
 * A bracket is only rewritten when it is the explicit TeX delimiter `\\[` or
 * `\\(`, so ordinary Chinese square brackets remain ordinary text
 */
export function normalizeLegacyMathDelimiters(markdown: string): string {
  return normalizeBareTexFragments(scanMarkdownMath(markdown).normalized);
}

interface MathScanResult {
  normalized: string;
  formulas: string[];
  issues: string[];
}

function scanMarkdownMath(markdown: string): MathScanResult {
  const output: string[] = [];
  const formulas: string[] = [];
  const issues: string[] = [];
  let index = 0;
  while (index < markdown.length) {
    const fenced = markdown.slice(index).match(/^(`{3,}|~{3,})/);
    if (fenced) {
      const fence = fenced[1]!;
      const close = markdown.indexOf(fence, index + fence.length);
      if (close < 0) { output.push(markdown.slice(index)); break; }
      const end = close + fence.length;
      output.push(markdown.slice(index, end));
      index = end;
      continue;
    }
    if (markdown[index] === "`") {
      const close = findUnescaped(markdown, "`", index + 1);
      if (close < 0) { output.push(markdown.slice(index)); break; }
      const end = close + 1;
      output.push(markdown.slice(index, end));
      index = end;
      continue;
    }
    if (markdown.startsWith("\\[", index)) {
      const close = markdown.indexOf("\\]", index + 2);
      if (close < 0) { issues.push("MATH_UNCLOSED_DISPLAY_DELIMITER"); output.push(markdown.slice(index)); break; }
      const tex = markdown.slice(index + 2, close);
      formulas.push(tex);
      output.push(`$$${tex}$$`);
      index = close + 2;
      continue;
    }
    if (markdown.startsWith("\\(", index)) {
      const close = markdown.indexOf("\\)", index + 2);
      if (close < 0) { issues.push("MATH_UNCLOSED_INLINE_DELIMITER"); output.push(markdown.slice(index)); break; }
      const tex = markdown.slice(index + 2, close);
      formulas.push(tex);
      output.push(`$${tex}$`);
      index = close + 2;
      continue;
    }
    if (markdown.startsWith("$$", index) && !isEscaped(markdown, index)) {
      const close = findUnescaped(markdown, "$$", index + 2);
      if (close < 0) { issues.push("MATH_UNCLOSED_DISPLAY_DELIMITER"); output.push(markdown.slice(index)); break; }
      const tex = markdown.slice(index + 2, close);
      formulas.push(tex);
      output.push(`$$${tex}$$`);
      index = close + 2;
      continue;
    }
    if (markdown[index] === "$" && !isEscaped(markdown, index) && markdown[index + 1] !== "$" && !isEscaped(markdown, index + 1)) {
      const close = findUnescaped(markdown, "$", index + 1);
      if (close < 0) {
        const remainder = markdown.slice(index + 1);
        if (looksLikeTeX(remainder)) {
          issues.push("MATH_UNCLOSED_INLINE_DELIMITER");
          output.push(markdown.slice(index));
          break;
        }
        output.push("$");
        index += 1;
        continue;
      }
      const candidate = markdown.slice(index + 1, close);
      if (candidate.includes("\n")) {
        if (looksLikeTeX(candidate)) {
          issues.push("MATH_UNCLOSED_INLINE_DELIMITER");
          output.push(markdown.slice(index));
          break;
        }
        output.push("$");
        index += 1;
        continue;
      }
      const tex = candidate;
      formulas.push(tex);
      output.push(`$${tex}$`);
      index = close + 1;
      continue;
    }
    if (markdown[index] === "[") {
      const close = markdown.indexOf("]", index + 1);
      if (close >= 0 && markdown[close + 1] === "(") {
        const end = markdown.indexOf(")", close + 2);
        if (end >= 0) { output.push(markdown.slice(index, end + 1)); index = end + 1; continue; }
      }
      if (close >= 0 && !markdown.slice(index + 1, close).includes("\n")) {
        const tex = markdown.slice(index + 1, close);
        if (looksLikeTeX(tex)) {
          const lineStart = markdown.lastIndexOf("\n", index - 1) + 1;
          const onlyIndent = markdown.slice(lineStart, index).trim() === "";
          const atLineEnd = markdown.slice(close + 1).match(/^[ \t]*(?:\r?\n|$)/);
          formulas.push(tex);
          output.push(onlyIndent && atLineEnd ? `$$\n${tex.trim()}\n$$` : `$${tex.trim()}$`);
          index = close + 1;
          continue;
        }
      }
    }
    if (markdown.startsWith("\u000crac", index)) { output.push("\\frac"); index += 4; continue; }
    output.push(markdown[index]!);
    index += 1;
  }
  return { normalized: output.join(""), formulas, issues };
}

function findUnescaped(value: string, needle: string, from: number): number {
  let index = from;
  while (index < value.length) {
    const found = value.indexOf(needle, index);
    if (found < 0) return -1;
    if (!isEscaped(value, found)) return found;
    index = found + 1;
  }
  return -1;
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function looksLikeTeX(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  const hasMathSyntax = /[=^_{}]/.test(text) || /\\(?:frac|binom|sqrt|sum|prod|int|cup|cap|in|subset|leq|geq|neq|varnothing|times|cdot|operatorname|text|left|right|quad|qquad|alpha|beta|gamma|delta|lambda|mu|pi|sigma|infty|partial|nabla|begin|end)\b/.test(text);
  return hasMathSyntax && (/\\[A-Za-z]+/.test(text) || /[=^_{}]/.test(text));
}

const HIGH_CONFIDENCE_TEX_COMMAND = /\\(?:frac|binom|sqrt|sum|prod|int|operatorname|begin|lim|max|min|argmax|argmin)(?![A-Za-z])/;

function normalizeBareTexFragments(markdown: string): string {
  const lines = markdown.match(/[^\r\n]*(?:\r?\n|$)/g) ?? [];
  let fence: string | undefined;
  let displayMath = false;
  return lines.map((line) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (line.trimStart().startsWith(fence)) fence = undefined;
      return line;
    }
    if (fence) return line;
    const displayDelimiterCount = line.match(/(?<!\\)\$\$/g)?.length ?? 0;
    if (displayMath || displayDelimiterCount > 0) {
      if (displayDelimiterCount % 2 === 1) displayMath = !displayMath;
      return line;
    }
    if (/`|https?:\/\/|www\./i.test(line) || /(?:\$|\\\(|\\\[)/.test(line)) return line;
    const parts = line.match(/^(\s*(?:(?:[-+*]|\d+[.)])\s+)?)(.*?)(\r?\n?)$/);
    if (!parts) return line;
    const prefix = parts[1]!;
    const content = parts[2]!;
    const ending = parts[3]!;
    const commandIndex = content.search(HIGH_CONFIDENCE_TEX_COMMAND);
    if (commandIndex < 0) return line;
    const before = content.slice(0, commandIndex);
    const remainder = content.slice(commandIndex);
    const boundary = remainder.search(/[，。；！？\u3400-\u9fff]/);
    const candidate = (boundary < 0 ? remainder : remainder.slice(0, boundary)).trimEnd();
    const after = boundary < 0 ? "" : remainder.slice(candidate.length);
    if (!looksLikeTeX(candidate) || !balanced(candidate, "{", "}")) return line;
    if (!before.trim() && !after.trim() && !prefix.trim()) return `$$\n${candidate}\n$$${ending}`;
    return `${prefix}${before}$${candidate}$${after}${ending}`;
  }).join("");
}

function balanced(value: string, open: string, close: string): boolean {
  let depth = 0;
  for (const character of value) {
    if (character === open) depth += 1;
    if (character === close) depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

export function validatePseudoCodeLines(lines: PseudoCodeLine[]): string[] {
  const issues: string[] = [];
  const seen = new Set<number>();
  for (const line of lines) {
    if (seen.has(line.lineNumber)) issues.push(`${line.id}:LINE_NUMBER_DUPLICATE`);
    seen.add(line.lineNumber);
    const checks: Array<[string, unknown]> = [
      ["teacherSummary", line.teacherSummary],
      ["semantic", line.semantic],
      ["preState", line.preState],
      ["postState", line.postState],
      ["complexityRelation", line.complexityRelation]
    ];
    for (const [field, value] of checks) {
      if (typeof value !== "string" || value.trim() === "") issues.push(`${line.id}:${field}_MISSING`);
    }
    if (typeof line.teacherSummary === "string" && /^(初始化|更新变量|检查条件|遍历|赋值|锁定|结束算法)$/.test(line.teacherSummary.trim())) {
      issues.push(`${line.id}:teacherSummary_TOO_VAGUE`);
    }
    if (!Array.isArray(line.reads) || !Array.isArray(line.writes) || !Array.isArray(line.sideEffects)) {
      issues.push(`${line.id}:STATE_EFFECTS_INVALID`);
    }
  }
  return issues;
}

export function calculateCoverage(requirements: CoverageRequirement[], claims: CoverageClaim[]): CoverageResult {
  const missing: CoverageResult["missing"] = [];
  const ratios = requirements.map((requirement) => {
    const related = claims.filter((claim) => claim.requirementId === requirement.id && claim.status !== "missing");
    const covered = new Set(related.flatMap((claim) => claim.coveredFields));
    const missingFields = requirement.requiredFields.filter((field) => !covered.has(field));
    if (missingFields.length > 0) missing.push({ requirementId: requirement.id, fields: missingFields });
    return { risk: requirement.risk, ratio: requirement.requiredFields.length === 0 ? 1 : (requirement.requiredFields.length - missingFields.length) / requirement.requiredFields.length };
  });
  const highRisk = ratios.filter((item) => item.risk === "high");
  const general = ratios.filter((item) => item.risk === "general");
  const highRiskCoverage = average(highRisk.map((item) => item.ratio));
  const generalCoverage = average(general.map((item) => item.ratio));
  return { highRiskCoverage, generalCoverage, missing, publishable: highRiskCoverage === 1 && generalCoverage >= 0.98 };
}

export function validatePageForPublication(page: PageLesson): string[] {
  const mathIssues = validateMathAtoms(page.atoms.filter((atom): atom is MathExpression => atom.kind === "math_expression"));
  const pseudoIssues = validatePseudoCodeLines(page.atoms.filter((atom): atom is PseudoCodeLine => atom.kind === "pseudocode_line"));
  const coverage = calculateCoverage(page.coverageRequirements, page.coverageClaims);
  const markdownMathIssues = [
    ...page.blocks.map((block) => ({ id: block.id, markdown: block.markdown })),
    ...(page.lessonSections ?? []).flatMap((section) => [
      ...(section.markdown ? [{ id: section.id, markdown: section.markdown }] : []),
      ...(section.items ?? []).map((item) => ({ id: item.id, markdown: item.text }))
    ])
  ].flatMap((block) => validateMarkdownMath(block.markdown).map((issue) => `${block.id}:${issue}`));
  const sectionIssues = validateLessonStructure(page);
  const questionIssues = page.questionBank && page.questionBank.filter((item) => item.status === "approved").length < 4 ? ["QUESTION_BANK_MINIMUM_NOT_MET"] : [];
  return [...page.quality.issues, ...mathIssues, ...markdownMathIssues, ...pseudoIssues, ...coverage.missing.map((item) => `${item.requirementId}:MISSING:${item.fields.join(",")}`), ...sectionIssues, ...questionIssues];
}

export function validateLessonStructure(page: PageLesson): string[] {
  if (!page.lessonSections) return [];
  const expected = ["learning_objectives", "main_content", "prior_knowledge", "full_explanation", "misconceptions"];
  const actual = page.lessonSections.map((item) => item.kind);
  const issues = expected.flatMap((kind, index) => actual[index] === kind ? [] : [`LESSON_SECTION_ORDER:${kind}`]);
  for (const section of page.lessonSections.filter((item) => item.kind === "prior_knowledge" || item.kind === "misconceptions")) {
    if (!section.items?.length) issues.push(`${section.kind}:ITEMS_REQUIRED`);
    for (const item of section.items ?? []) if (hasSentenceBoundaryOutsideMath(item.text)) issues.push(`${item.id}:MULTIPLE_SENTENCES`);
  }
  const full = page.lessonSections.find((item) => item.kind === "full_explanation");
  if (!full?.markdown?.trim()) issues.push("FULL_EXPLANATION_REQUIRED");
  return issues;
}

function hasSentenceBoundaryOutsideMath(value: string): boolean {
  const normalized = normalizeLegacyMathDelimiters(value)
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/(?<!\\)\$[^$\n]*?(?<!\\)\$/g, "")
    // A factorial such as 16! is mathematical notation, not the end of a
    // sentence. Keep genuine punctuation checks for the surrounding prose.
    .replace(/(?<=[A-Za-z0-9)])!(?=\s|$)/g, "");
  return /[。！？!?].+/.test(normalized);
}

function average(values: number[]): number {
  return values.length === 0 ? 1 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
