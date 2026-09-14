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
  if (explanation.length < minimumExplanationCharacters(page)) issues.push("TEACHING_EXPLANATION_TOO_SHORT");
  const paragraphs = explanation.split(/\n\s*\n/).map((value) => value.replace(/[`*_>#-]/g, "").replace(/\s+/g, "").trim()).filter((value) => value.length >= 24);
  const counts = new Map<string, number>();
  for (const paragraph of paragraphs) counts.set(paragraph, (counts.get(paragraph) ?? 0) + 1);
  const repeatedParagraphRatio = paragraphs.length ? paragraphs.filter((paragraph) => (counts.get(paragraph) ?? 0) > 1).length / paragraphs.length : 1;
  if (repeatedParagraphRatio > 0.15) issues.push("TEACHING_REPETITION_TOO_HIGH");
  const forbidden = ["页面元素核对", "来源状态", "等待审核", "等待验证", "模型推断", "已覆盖"];
  for (const phrase of forbidden) if (explanation.includes(phrase)) issues.push(`TEACHING_METADATA_NOISE:${phrase}`);
  const questions = page.questionBank?.filter((question) => question.status === "approved") ?? [];
  if (questions.length !== 4) issues.push("TEACHING_QUESTION_COUNT_INVALID");
  if (sections.length >= 5 && questions.length) {
    issues.push(...validateTeachingNarrative({
      lessonFlowVersion: page.lessonFlowVersion,
      chapterBridgeMarkdown: sections.find((section) => section.kind === "chapter_bridge")?.markdown,
      learningObjectives: sections.find((section) => section.kind === "learning_objectives")?.items?.map((item) => item.text) ?? [],
      mainContentMarkdown: sections.find((section) => section.kind === "main_content")?.markdown ?? "",
      priorKnowledge: sections.find((section) => section.kind === "prior_knowledge")?.items?.map((item) => item.text) ?? [],
      fullExplanationMarkdown: explanation,
      misconceptions: sections.find((section) => section.kind === "misconceptions")?.items?.map((item) => item.text) ?? [],
      questions: questions.map((question) => ({ prompt: question.prompt, explanation: question.explanation }))
    }));
  }
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
  lessonFlowVersion?: 2;
  strictWritingStyle?: boolean;
  chapterBridgeMarkdown?: string;
  learningObjectives: string[];
  mainContentMarkdown: string;
  priorKnowledge: string[];
  fullExplanationMarkdown: string;
  misconceptions: string[];
  questions: Array<{ prompt: string; explanation: string }>;
  pageKind?: "cover" | "agenda" | "concept" | "formula" | "diagram" | "table" | "code" | "mixed";
  sourceDensity?: "sparse" | "normal" | "dense";
  sourceTitle?: string;
}

export function maximumTeachingExplanationCharacters(input: Pick<TeachingNarrativeInput, "pageKind" | "sourceDensity">): number {
  return input.pageKind === "cover" ? 900
    : input.pageKind === "agenda" ? 1_000
      : input.sourceDensity === "sparse" ? 2_000
        : input.sourceDensity === "dense" ? 5_000
          : 3_500;
}

/**
 * Checks the learner-facing narrative, not the provenance metadata.  A page
 * can have perfect atom bookkeeping and still read like an internal audit
 * log, so these checks deliberately run before a generated draft is saved.
 */
export function validateTeachingNarrative(input: TeachingNarrativeInput): string[] {
  const issues: string[] = [];
  const explanation = input.fullExplanationMarkdown.trim();
  const maximumCharacters = maximumTeachingExplanationCharacters(input);
  if (explanation.length > maximumCharacters) issues.push("TEACHING_EXPLANATION_TOO_LONG");
  const legacyTemplateHeadings = [
    "先说这页要解决什么",
    "先读原对象",
    "解释核心关系",
    "做一个例子或计算",
    "边界与易错点",
    "最后回收"
  ];
  for (const heading of legacyTemplateHeadings) if (explanation.includes(`## ${heading}`)) issues.push(`TEACHING_FIXED_TEMPLATE_HEADING:${heading}`);

  const headings = [...explanation.matchAll(/^#{2,4}\s+(.+)$/gm)].map((match) => match[1]!.trim());
  if (explanation.length >= 500 && headings.length < 2) issues.push("TEACHING_COMPLEX_CONTENT_UNSTRUCTURED");
  if (new Set(headings).size !== headings.length) issues.push("TEACHING_HEADING_DUPLICATE");
  if (/^#{2,4}\s+[^\n]+\n(?:\s*\n)*#{2,4}\s+/m.test(explanation)) issues.push("TEACHING_ADJACENT_HEADINGS");

  const learnerText = [
    input.chapterBridgeMarkdown || "",
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
  issues.push(...validateHumanReadableChinese(learnerText));
  issues.push(...validateTeachingCountConsistency(learnerText));
  if (input.lessonFlowVersion === 2) {
    for (const prior of input.priorKnowledge) {
      if (!/^[^：\n]{2,100}：\s*.{30,}$/u.test(prior.trim())) issues.push("TEACHING_PRIOR_KNOWLEDGE_TOO_SHALLOW");
    }
    for (const misconception of input.misconceptions) {
      if (/\s+[-*+]\s+(?=[\p{Script=Han}“])|\n\s*[-*+]\s/u.test(misconception)) issues.push("TEACHING_MISCONCEPTIONS_PACKED");
      const hasReason = /(因为|由于|原因|错因|导致|所以|因此|错误在于|问题在于|不成立|不满足|混淆|只有|没有|未给出|未说明|不包含)/u.test(misconception);
      const clauses = misconception.split(/[；;]/).map((clause) => clause.trim()).filter(Boolean);
      const hasExplainedCorrection = /[：:][^；;。\n]{18,}[；;][^；;。\n]{12,}/u.test(misconception)
        || (clauses.length >= 3 && clauses[0]!.length >= 8 && clauses[1]!.length >= 15 && clauses.slice(2).some((clause) => clause.length >= 12))
        || (clauses.length === 2 && clauses[0]!.length >= 8 && clauses[1]!.length >= 35 && /(?:\$[^$]+\$|因为|导致|取决于|必须|需要)/u.test(clauses[1]!));
      const hasCorrection = /(正确|应当|应该|检查|核对|判断|验证|确认|应先|应以|可通过|可以通过|需要|必须|不能|不应|可用|重新|只对应|方向反转|只改变|不直接)/u.test(misconception);
      const evidenceBasedCorrection = /[：:][^\n]{35,}/u.test(misconception)
        && /(?:原图|页面|图中|箭头|虚线|公式|表格)[^\n]{0,80}(?:说明|表示|只|没有|缺少)/u.test(misconception)
        && /(而不是|不能|需要|先后|否则|无法|仅|只|应|但|缺少|使)/u.test(misconception);
      if ((!hasReason && !hasExplainedCorrection && !evidenceBasedCorrection) || (!hasCorrection && !evidenceBasedCorrection)) issues.push("TEACHING_MISCONCEPTION_REASON_MISSING");
    }
    const outsideMath = stripProtectedMarkdown(learnerText);
    if (/(?<![\p{L}\p{N}])(?:[A-Za-z]{1,3}_[A-Za-z0-9{}]+|[A-Za-z]{1,3}\^[A-Za-z0-9{}]+)/u.test(outsideMath)) issues.push("TEACHING_BARE_MATH_SYMBOL");
  }

  if (input.strictWritingStyle) {
    if (/(?:页码|页脚|版式信息)/u.test(explanation) || (input.pageKind === "agenda" && /\b\d+\s*\/\s*\d+\b/u.test(explanation))) {
      issues.push("TEACHING_LAYOUT_COMMENTARY");
    }
    const mathFields = {
      chapterBridgeMarkdown: input.chapterBridgeMarkdown || "",
      learningObjectives: input.learningObjectives.join("\n"),
      priorKnowledge: input.priorKnowledge.join("\n"),
      fullExplanationMarkdown: input.fullExplanationMarkdown,
      mainContentMarkdown: input.mainContentMarkdown,
      misconceptions: input.misconceptions.join("\n"),
      questions: input.questions.map((question) => `${question.prompt}\n${question.explanation}`).join("\n")
    };
    for (const [field, markdown] of Object.entries(mathFields)) {
      if (validateMarkdownMath(markdown).length > 0) issues.push(`TEACHING_MATH_INVALID:${field}`);
    }
    const sourceNames = definedSourceNames(input.sourceTitle || "", learnerText);
    if (hasUnpairedEnglishPhrase(learnerText, sourceNames)) issues.push("TEACHING_UNPAIRED_ENGLISH");
    const summaryLines = input.mainContentMarkdown.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (summaryLines.length < 2 || summaryLines.length > 5 || summaryLines.some((line) => !/^[-*+]\s+\S/u.test(line))) {
      issues.push("TEACHING_SUMMARY_MUST_BE_BULLETS");
    }
    const bridge = input.chapterBridgeMarkdown?.trim() || "";
    if (bridge && bridge.length > 120 && !/\n\s*\n|\n\s*[-*+]\s/u.test(bridge)) issues.push("TEACHING_BRIDGE_NEEDS_BLOCKS");
    if (bridge && hasUnpairedEnglishPhrase(bridge, sourceNames)) issues.push("TEACHING_BRIDGE_UNPAIRED_ENGLISH");
    for (const prior of input.priorKnowledge) {
      const definition = prior.trim().replace(/^[-*+]\s+/, "");
      const split = definition.indexOf("：");
      const label = split < 0 ? "" : definition.slice(0, split).trim();
      const translatedLabel = /^([\p{Script=Han}]{2,20})（([A-Za-z][A-Za-z\s-]{1,80})）$/u.exec(label);
      if (translatedLabel) {
        const chinese = translatedLabel[1]!;
        const expectedEnglish = translatedLabel[2]!.replace(/\s+/g, " ").trim().toLowerCase();
        const repeated = new RegExp(`(?:^|[^\\p{Script=Han}]|的)${escapeRegExp(chinese)}（([A-Za-z][A-Za-z\\s-]{1,80})）`, "gu");
        if ([...definition.matchAll(repeated)].some((match) => match[1]!.replace(/\s+/g, " ").trim().toLowerCase() !== expectedEnglish)) {
          issues.push("TEACHING_PRIOR_TRANSLATION_CONFLICT");
        }
      }
      if (label.length >= 2 && new RegExp(`^\\s*(?:[-*+]\\s*)?${escapeRegExp(label)}：`, "mu").test(explanation)) {
        issues.push("TEACHING_PRIOR_DEFINITION_REPEATED");
      }
      if (split >= 0 && definition.slice(split + 1).includes("：")) issues.push("TEACHING_PRIOR_MULTIPLE_DEFINITIONS");
      const clauses = split < 0 ? [] : definition.slice(split + 1).split(/[；;]/).map((part) => part.trim()).filter(Boolean);
      if (split < 2 || definition.length < 70 || clauses.length < 3 || clauses.length > 5 || clauses.some((part) => part.length < 8)) {
        issues.push("TEACHING_PRIOR_DEFINITION_INCOMPLETE");
      }
      if (hasUnpairedEnglishPhrase(definition, sourceNames)) issues.push("TEACHING_PRIOR_UNPAIRED_ENGLISH");
    }
    for (const question of input.questions) {
      if (question.explanation.trim().length < 48) issues.push("TEACHING_QUESTION_EXPLANATION_TOO_SHORT");
    }
  }

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

  const mainLines = new Set(normalizedContentLines(input.mainContentMarkdown));
  const repeatedAcrossSections = normalizedContentLines(input.fullExplanationMarkdown).filter((line) => mainLines.has(line));
  if (repeatedAcrossSections.length > 0) issues.push("TEACHING_MAIN_EXPLANATION_DUPLICATION");

  const questionPrompts = input.questions.map((question) => question.prompt.replace(/\s+/g, "").trim());
  if (new Set(questionPrompts).size !== questionPrompts.length) issues.push("TEACHING_QUESTION_DUPLICATE");
  return [...new Set(issues)];
}

/** Flag conflicting counts for the same named object across teaching and questions. */
export function validateTeachingCountConsistency(markdown: string): string[] {
  const numerals: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const nouns = ["训练方式", "训练条件", "硬件", "算法", "模型", "步骤", "对象", "图表", "曲线", "公式", "参数", "节点", "模块", "方法", "方案", "样本", "图像", "表格", "层级", "部分", "章节", "流程", "动作", "状态", "结构", "数据", "变量", "数值", "任务", "页面", "指标", "例子", "问题", "区段", "材料", "需求", "选项"];
  const counts = new Map<string, Set<number>>();
  for (const match of stripProtectedMarkdown(markdown).matchAll(/(?<![A-Za-z0-9约近])([一二两三四五六七八九十]|[1-9][0-9]?)(?:个|种|组|类|项|条|张|根)([\p{Script=Han}]{2,7})/gu)) {
    const value = numerals[match[1]!] ?? Number(match[1]);
    if (!Number.isFinite(value)) continue;
    const tail = match[2]!.replace(/^(?:不同的?|主要的?|相关的?|被比较的?)/u, "");
    const noun = nouns.find((candidate) => tail.startsWith(candidate));
    if (!noun) continue;
    const seen = counts.get(noun) ?? new Set<number>();
    seen.add(value);
    counts.set(noun, seen);
  }
  return [...counts].filter(([, seen]) => seen.size > 1).map(([noun]) => `TEACHING_COUNT_CONTRADICTION:${noun}`);
}

/** Keep every heading's words while turning an empty nested heading into prose. */
export function normalizeAdjacentTeachingHeadings(markdown: string): string {
  return markdown.replace(/(^#{2,4}[ \t]+[^\r\n]+\r?\n(?:[ \t]*\r?\n)*)(?:#{2,4})[ \t]+([^\r\n]+)/gm,
    (_match, firstHeading: string, nextTitle: string) => `${firstHeading}${nextTitle}`);
}

export function hasUnpairedEnglishPhrase(markdown: string, sourceNames: string[] = []): boolean {
  return unpairedEnglishPhrases(markdown, sourceNames).length > 0;
}

export function unpairedEnglishPhrases(markdown: string, sourceNames: string[] = []): string[] {
  const visible = stripProtectedMarkdown(markdown)
    .replace(/(?:[A-Za-z][A-Za-z0-9-]*\s+)?[\p{Script=Han}]{2,25}（[^）]*[A-Za-z][^）]*）/gu, "")
    .replace(/\b[A-Z]{2,5}\s+\d{2,5}\b/gu, "")
    .replace(/\b[A-Z]{2,8}\s*即[\p{Script=Han}]{2,20}/gu, "")
    .replace(/(?<=发表于|刊于)\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,5}(?=\s+的(?:文章|论文|期刊))/gu, "")
    .replace(/“[A-Za-z][^”\n]{2,100}”/gu, "")
    .replace(/"[A-Za-z][^"\n]{2,100}"/gu, "")
    .replace(/《[A-Za-z][^》\n]{2,100}》/gu, "");
  const withoutSourceNames = sourceNames.reduce((text, name) => text.replace(new RegExp(`(?<![A-Za-z])${escapeRegExp(name)}(?![A-Za-z])`, "giu"), ""), visible);
  return [...new Set([...withoutSourceNames.matchAll(/(?:^|[^\p{L}])((?:[A-Z][a-z]+(?:[- ][A-Za-z]+)+|[A-Z]{2,}|[a-z]+-[a-z]+\s+[a-z]+))(?=$|[^\p{L}])/gu)].map((match) => match[1]!).filter(Boolean))];
}

/** Keep a source label quoted when a question repeats it outside code or math. */
export function quoteRepeatedSourceLabels(text: string, explanation: string): string {
  const labels = [...new Set([...explanation.matchAll(/(?:“([^”\n]{2,80})”|"([^"\n]{2,80})")/gu)]
    .map((match) => match[1] || match[2] || "")
    .filter((label) => /^[A-Za-z][A-Za-z0-9 .:/_-]*$/u.test(label)))]
    .sort((left, right) => right.length - left.length);
  return text.split(/(`[^`]*`|\$[^$]*\$|https?:\/\/[^\s）”"]+)/gu).map((part, index) => {
    if (index % 2 === 1) return part;
    return labels.reduce((current, label) => current.replace(
      new RegExp(`(?<![A-Za-z0-9“"])${escapeRegExp(label)}(?![A-Za-z0-9”"])`, "gu"), `“${label}”`
    ), part);
  }).join("");
}

export type TeachingNarrativeField = "chapterBridgeMarkdown" | "learningObjectives" | "mainContentMarkdown" | "priorKnowledge" | "fullExplanationMarkdown" | "misconceptions" | "questions";

export function unpairedEnglishTeachingFields(input: TeachingNarrativeInput): TeachingNarrativeField[] {
  const parts: Record<TeachingNarrativeField, string> = {
    chapterBridgeMarkdown: input.chapterBridgeMarkdown || "",
    learningObjectives: input.learningObjectives.join("\n"),
    mainContentMarkdown: input.mainContentMarkdown,
    priorKnowledge: input.priorKnowledge.join("\n"),
    fullExplanationMarkdown: input.fullExplanationMarkdown,
    misconceptions: input.misconceptions.join("\n"),
    questions: input.questions.map((question) => `${question.prompt}\n${question.explanation}`).join("\n")
  };
  const learnerText = Object.values(parts).join("\n");
  const sourceNames = definedSourceNames(input.sourceTitle || "", learnerText);
  return (Object.keys(parts) as TeachingNarrativeField[]).filter((field) => hasUnpairedEnglishPhrase(parts[field], sourceNames));
}

function definedSourceNames(title: string, learnerText: string): string[] {
  const names = [...title.matchAll(/\b(?:[A-Z][A-Za-z]+-[A-Z][A-Za-z]+|[A-Z]{2,8})\b/gu)].map((match) => match[0]);
  const definedTitleNames = names.filter((name) => new RegExp(`${escapeRegExp(name)}[^\\n]{0,90}(?:(?:是|指|作为|用于|表示|即)[^\\n]{0,70}[\\p{Script=Han}]{2}|(?:算法|模型|方法|规则|框架)（[^）]{3,80}）：[^\\n]{2,})`, "iu").test(learnerText));
  const explainedQuotes = [...learnerText.matchAll(/“([A-Z][A-Za-z ]{3,80})”[^\n]{0,80}(?:对应|表示|指|说明)[^\n]{0,60}[\p{Script=Han}]{2}/gu)].map((match) => match[1]!);
  return [...new Set([...definedTitleNames, ...explainedQuotes])];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove only learner-facing lines that are already present verbatim in the
 * compact main-content section. The fact remains available in main content;
 * no paraphrase, inference, or source-bearing line is rewritten.
 */
export function removeMainExplanationDuplicateLines(mainContentMarkdown: string, fullExplanationMarkdown: string): string {
  const mainLines = new Set(normalizedContentLines(mainContentMarkdown));
  if (mainLines.size === 0) return fullExplanationMarkdown;
  const repaired = fullExplanationMarkdown.split(/\r?\n/).filter((line) => {
    if (!line.trim() || /^\s*#{1,6}\s/.test(line)) return true;
    const normalized = normalizedContentLines(line);
    return normalized.length !== 1 || !mainLines.has(normalized[0]!);
  }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return repaired.length >= 120 ? repaired : fullExplanationMarkdown;
}

/** Hard, deterministic subset of the approved human-readable Chinese policy. */
export function validateHumanReadableChinese(markdown: string): string[] {
  const issues: string[] = [];
  const visible = stripProtectedMarkdown(markdown);
  if (visible.includes("。")) issues.push("WRITING_CHINESE_FULL_STOP_FORBIDDEN");
  if (visible.split(/\r?\n/).some((line) => /；\s*$/.test(line))) issues.push("WRITING_LINE_END_SEMICOLON_FORBIDDEN");
  if (visible.split(/\r?\n/).some((line) => /^\s*(?!#{1,6}\s)(?:[-*+]\s*)?[\p{Script=Han}A-Za-z0-9 _-]{1,18}[：:]\s*$/u.test(line))) issues.push("WRITING_COLON_PSEUDO_HEADING");
  return issues;
}

/** Apply only lossless punctuation repairs outside code, quotes, URLs and math. */
export function normalizeHumanReadableChineseMarkdown(markdown: string): string {
  let inFence = false;
  let fenceMarker = "";
  let inDisplayMath = false;
  return markdown.split(/(\r?\n)/).map((part) => {
    if (/^\r?\n$/.test(part)) return part;
    const fence = part.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) { inFence = true; fenceMarker = fence[1]!; }
      else if (part.trimStart().startsWith(fenceMarker)) { inFence = false; fenceMarker = ""; }
      return part;
    }
    if (inFence || /^\s*>/.test(part)) return part;
    const displayCount = part.match(/(?<!\\)\$\$/g)?.length ?? 0;
    if (inDisplayMath || displayCount > 0) {
      if (displayCount % 2 === 1) inDisplayMath = !inDisplayMath;
      return part;
    }
    const protectedValues: string[] = [];
    const protectedLine = part.replace(/`[^`\r\n]+`|(?<!\$)\$[^$\r\n]+\$(?!\$)|https?:\/\/\S+/g, (value) => {
      protectedValues.push(value);
      return `\u0000${protectedValues.length - 1}\u0000`;
    });
    const repaired = protectedLine.replace(/。(?=\s*$)/g, "").replace(/。/g, "；").replace(/；(?=\s*$)/g, "");
    const pseudoHeading = repaired.match(/^(\s*)(?:[-*+]\s*)?([\p{Script=Han}A-Za-z0-9 _-]{1,18})[：:]\s*$/u);
    const structured = pseudoHeading ? `${pseudoHeading[1]}## ${pseudoHeading[2]!.trim()}` : repaired;
    const restored = structured.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => protectedValues[Number(index)]!);
    if (validateHumanReadableChinese(restored).includes("WRITING_COLON_PSEUDO_HEADING")) {
      const renderedHeading = restored.match(/^(\s*)(?:[-*+]\s*)?(.+?)[：:]\s*$/u);
      if (renderedHeading) return `${renderedHeading[1]}## ${renderedHeading[2]!.trim()}`;
    }
    return restored;
  }).join("");
}

function stripProtectedMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "")
    .replace(/^\s*>.*$/gm, "")
    .replace(/`[^`\r\n]+`/g, "")
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/(?<!\$)\$[^$\r\n]+\$(?!\$)/g, "")
    .replace(/https?:\/\/\S+/g, "");
}

function normalizedContentLines(markdown: string): string[] {
  return stripProtectedMarkdown(markdown).split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:#{1,6}|[-*+]\s+|\d+[.)]\s+)/, "").replace(/\s+/g, "").trim())
    .filter((line) => line.length >= 24);
}

function minimumExplanationCharacters(page: PageLesson): number {
  const titleLike = page.pageNumber === 1 && page.atoms.every((atom) => atom.kind === "image_region");
  if (titleLike) return 120;
  if (/(目录|大纲|outline|agenda|contents)/i.test(page.title)) return 200;
  return 300;
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
  return normalizeBareVariableMath(normalizeBareTexFragments(scanMarkdownMath(markdown).normalized));
}

function normalizeBareVariableMath(markdown: string): string {
  let fence = false;
  let displayMath = false;
  return markdown.split(/(\r?\n)/).map((line) => {
    if (/^\s*(`{3,}|~{3,})/.test(line)) { fence = !fence; return line; }
    if (fence || /^\s*>/.test(line)) return line;
    const displayDelimiterCount = line.match(/(?<!\\)\$\$/g)?.length ?? 0;
    if (displayMath || displayDelimiterCount > 0) {
      if (displayDelimiterCount % 2 === 1) displayMath = !displayMath;
      return line;
    }
    const protectedPieces: string[] = [];
    const protectedLine = line.replace(/`[^`\r\n]+`|\$\$[\s\S]*?\$\$|(?<!\$)\$[^$\r\n]+\$(?!\$)|https?:\/\/\S+/g, (value) => {
      protectedPieces.push(value);
      return `\u0000${protectedPieces.length - 1}\u0000`;
    });
    const repaired = protectedLine.replace(/(?<![\p{L}\p{N}_\\])([A-Za-z]_(?:\{[A-Za-z0-9]+\}|[A-Za-z0-9]{1,3}))(?![\p{L}\p{N}_])/gu, (_match, value: string) => `$${value}$`);
    return repaired.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => protectedPieces[Number(index)]!);
  }).join("").replace(/(?<=[A-Za-z0-9}])\$(?=\$[A-Za-z\\])/g, "$ ");
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
  const placeholderIssues = [
    ...page.blocks.filter((block) => /待生成|待补充|待核验|待确认/.test(block.markdown)).map((block) => `${block.id}:PLACEHOLDER_CONTENT`),
    ...(page.lessonSections ?? []).flatMap((section) => [
      ...(section.markdown && /待生成|待补充|待核验|待确认/.test(section.markdown) ? [`${section.id}:PLACEHOLDER_CONTENT`] : []),
      ...(section.items ?? []).filter((item) => /待生成|待补充|待核验|待确认/.test(item.text)).map((item) => `${item.id}:PLACEHOLDER_CONTENT`)
    ])
  ];
  const questionIssues = page.questionBank && page.questionBank.filter((item) => item.status === "approved").length < 4 ? ["QUESTION_BANK_MINIMUM_NOT_MET"] : [];
  return [...page.quality.issues, ...mathIssues, ...markdownMathIssues, ...pseudoIssues, ...coverage.missing.map((item) => `${item.requirementId}:MISSING:${item.fields.join(",")}`), ...sectionIssues, ...placeholderIssues, ...questionIssues];
}

export function validateLessonStructure(page: PageLesson): string[] {
  if (!page.lessonSections) return [];
  const actual = page.lessonSections.map((item) => item.kind);
  const expected = page.lessonFlowVersion === 2
    ? [...(actual[0] === "chapter_bridge" ? ["chapter_bridge"] : []), "prior_knowledge", "learning_objectives", "full_explanation", "main_content", "misconceptions"]
    : ["learning_objectives", "main_content", "prior_knowledge", "full_explanation", "misconceptions"];
  const issues = expected.flatMap((kind, index) => actual[index] === kind ? [] : [`LESSON_SECTION_ORDER:${kind}`]);
  for (const section of page.lessonSections.filter((item) => item.kind === "prior_knowledge" || item.kind === "misconceptions")) {
    if (!section.items?.length) issues.push(`${section.kind}:ITEMS_REQUIRED`);
    if (page.lessonFlowVersion !== 2) for (const item of section.items ?? []) if (hasSentenceBoundaryOutsideMath(item.text)) issues.push(`${item.id}:MULTIPLE_SENTENCES`);
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
