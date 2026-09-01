import katex from "katex";
import type { CoverageClaim, CoverageRequirement, MathExpression, PageLesson, PseudoCodeLine } from "@course-os/contracts";

export interface CoverageResult {
  highRiskCoverage: number;
  generalCoverage: number;
  missing: Array<{ requirementId: string; fields: string[] }>;
  publishable: boolean;
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
  const scanned = scanMarkdownMath(markdown);
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
  return scanMarkdownMath(markdown).normalized;
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
    .replace(/(?<!\\)\$[^$\n]*?(?<!\\)\$/g, "");
  return /[。！？!?].+/.test(normalized);
}

function average(values: number[]): number {
  return values.length === 0 ? 1 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
