import { normalizePresentationMarkdown, validateTeachingPresentation } from "./presentation.js";
export {
  displayFormulaMarker,
  teachingCompositionContract,
  formatMisconception,
  normalizeBilingualTermShape,
  normalizeChineseProsePunctuation,
  normalizeColonIntroducedLineBreaks,
  normalizeDisplayFormulaParagraphs,
  normalizeEnglishTermCase,
  normalizeListIndentation,
  normalizePackedTeachingProse,
  normalizePresentationMarkdown,
  normalizeThreeLevelHeadings,
  validateDisplayFormulaAlignment,
  validatePresentationFormatting,
  validateTeachingPresentation
} from "./presentation.js";
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
  if (sections.length >= 5 && questions.length && page.teachingTrace?.version !== 1) {
    issues.push(...validateTeachingNarrative({
      lessonFlowVersion: page.lessonFlowVersion,
      strictWritingStyle: page.lessonFlowVersion === 2,
      sourceTitle: page.title,
      sourceDensity: "dense",
      chapterBridgeMarkdown: sections.find((section) => section.kind === "chapter_bridge")?.markdown,
      learningObjectives: sections.find((section) => section.kind === "learning_objectives")?.items?.map((item) => item.text) ?? [],
      mainContentMarkdown: sections.find((section) => section.kind === "main_content")?.markdown ?? "",
      priorKnowledge: sections.find((section) => section.kind === "prior_knowledge")?.items?.map((item) => item.text) ?? [],
      fullExplanationMarkdown: explanation,
      misconceptions: sections.find((section) => section.kind === "misconceptions")?.items?.map((item) => item.text) ?? [],
      questions: questions.map((question) => ({ prompt: question.prompt, explanation: question.explanation, expectedAnswer: question.expectedAnswer, options: question.options }))
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
  questions: Array<{ prompt: string; explanation: string; expectedAnswer?: string; options?: string[] }>;
  pageKind?: "cover" | "agenda" | "concept" | "formula" | "diagram" | "table" | "code" | "mixed";
  sourceDensity?: "sparse" | "normal" | "dense";
  sourceTitle?: string;
}

function factorialMagnitudeMismatches(markdown: string): Array<{ n: number; expectedExponent: number }> {
  const mismatches: Array<{ n: number; expectedExponent: number }> = [];
  const visibleMath = markdown.replace(/\$/gu, "");
  const claims = visibleMath.split(/[。！？\n]/u).filter((clause) => /(\d{2,5})!/.test(clause) && /10\^\{\d+\}/u.test(clause));
  for (const clause of claims) {
    for (const factorial of clause.matchAll(/(\d{2,5})!/gu)) {
      const n = Number(factorial[1]);
      if (!Number.isInteger(n) || n > 10_000) continue;
      let logarithm = 0;
      for (let value = 2; value <= n; value += 1) logarithm += Math.log10(value);
      const expectedExponent = Math.floor(logarithm);
      const afterFactorial = clause.slice((factorial.index ?? 0) + factorial[0].length);
      for (const exponent of afterFactorial.matchAll(/10\^\{(\d+)\}/gu)) {
        const between = afterFactorial.slice(0, exponent.index ?? 0);
        // Only bind an exponent to n! when the text actually states an
        // equality or estimate. A comparison such as "n! 远大于 10^360"
        // mentions two magnitudes but does not claim that 10^360 estimates n!.
        if (between.length > 220 || !/(?:=|≈|约(?:等于|为)|估算(?:为)?|写成|标为|更接近(?:于)?|数量级[^；，,]{0,24}(?:是|为|达到))/u.test(between)) continue;
        const statedExponent = Number(exponent[1]);
        if (!Number.isInteger(statedExponent) || statedExponent === expectedExponent) continue;
        const claimPrefix = clause.slice(0, (factorial.index ?? 0) + factorial[0].length + (exponent.index ?? 0));
        const sourceQualified = /(?:原文|材料|页面|本页|课件)[^\n]{0,180}(?:粗略|近似|错误|写成|标为)/u.test(claimPrefix);
        const correctedElsewhere = new RegExp(`10\\^\\{${expectedExponent}\\}`).test(markdown)
          && /(?:复算|实际|准确|严格|更接近|约为|得到)/u.test(markdown);
        if (!(sourceQualified && correctedElsewhere)) mismatches.push({ n, expectedExponent });
      }
    }
  }
  return mismatches.filter((value, index, values) => values.findIndex((candidate) => candidate.n === value.n && candidate.expectedExponent === value.expectedExponent) === index);
}

export function untranslatedSourceLabels(markdown: string): string[] {
  const labels: string[] = [];
  const explained = new Set<string>();
  const knownNearbyTranslations: Record<string, RegExp> = {
    "cell+macro placement": /单元与宏单元(?:的)?(?:放置|布局)/u,
    "edge embeddings": /边嵌入/u,
    "macro embeddings": /宏单元嵌入/u,
    "macro features": /宏单元特征/u,
    "netlist graph": /网表图/u,
    "graph conv.": /图卷积/u
  };
  for (const match of markdown.matchAll(/“([A-Za-z][A-Za-z0-9 +,:?.()/_-]{2,100})”/gu)) {
    const label = match[1]!.trim();
    if (/^[A-Z][A-Z0-9-]{1,12}$/u.test(label)) continue;
    if (explained.has(label)) continue;
    const start = match.index ?? 0;
    const after = markdown.slice(start + match[0].length, start + match[0].length + 160);
    const translated = /(?:即|意为|意思是|可译为|表示|对应|前者说明|后者说明)[^。！？\n]{0,70}[\p{Script=Han}]{2}/u.test(after)
      || /^[，,：:]?\s*[（(][\p{Script=Han}][^）)\r\n]{1,80}[）)]/u.test(after)
      || /^的[\p{Script=Han}]{2,24}(?:模块|方法|步骤|阶段|栏目|标题|标签|对象|网络|层)/u.test(after)
      || /^[^。！？\n]{0,100}[\p{Script=Han}]{2,20}(?:是|分别是)[^。！？\n]{0,55}/u.test(after)
      || Boolean(knownNearbyTranslations[label.toLowerCase()]?.test(after));
    if (translated) explained.add(label);
    else labels.push(label);
  }
  return labels;
}

function hasEnglishOnlyMarkdownTable(markdown: string): boolean {
  const rows = markdown.split(/\r?\n/u).filter((line) => /^\s*\|.*\|\s*$/u.test(line));
  const cells = rows.flatMap((row) => row.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cell) => cell && !/^:?-{3,}:?$/u.test(cell));
  const englishCells = cells.filter((cell) => /[A-Za-z]{3}/u.test(cell) && !/[\p{Script=Han}]/u.test(cell));
  return cells.length >= 8 && englishCells.length / cells.length >= 0.6;
}

function hasFalseSameMagnitudeClaim(markdown: string): boolean {
  return markdown.split(/[；。！？\n]/u).some((clause) => {
    if (!/(?:同一|相同|相近)(?:个)?(?:数量级|量级)/u.test(clause)) return false;
    if (/(?:不能|无法|不可|并非|不是|不在|不属于|不应)(?:称为|视为|算作|认为|当作)?[^；。！？\n]{0,18}(?:同一|相同|相近)(?:个)?(?:数量级|量级)/u.test(clause)) return false;
    const exponents = [...clause.matchAll(/10\^\{(\d+)\}/gu)].map((match) => Number(match[1]));
    return exponents.some((left, index) => exponents.slice(index + 1).some((right) => Math.abs(left - right) > 1));
  });
}

function hasSoftmaxUpdateMismatch(markdown: string, referenceMarkdown = markdown): boolean {
  const compact = markdown.replace(/\s+/gu, " ");
  const reference = referenceMarkdown.replace(/\s+/gu, " ");
  const finalAssignedValue = (parameter: 1 | 2): number | undefined => {
    const assignments = [...referenceMarkdown.matchAll(new RegExp(`\\\\theta_${parameter}[^\\n。；]{0,180}`, "gu"))]
      .map((match) => match[0])
      .filter((value) => /\\leftarrow/u.test(value))
      .map((value) => [...value.slice(value.indexOf(`\\theta_${parameter}`) + `\\theta_${parameter}`.length).matchAll(/-?\d+(?:\.\d+)?/gu)].map((match) => Number(match[0])).at(-1))
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return assignments.at(-1);
  };
  const parameterPairs = [...reference.matchAll(/\\theta_1\s*(?:\\leftarrow|=)[^\d-]*(-?\d+(?:\.\d+)?)[^。；]{0,180}\\theta_2\s*(?:\\leftarrow|=)[^\d-]*(-?\d+(?:\.\d+)?)/gu)]
    .map((match) => [Number(match[1]), Number(match[2])] as const)
    .filter(([left, right]) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) >= 1e-9);
  const assignedTheta1 = finalAssignedValue(1);
  const assignedTheta2 = finalAssignedValue(2);
  const parameterPair = assignedTheta1 !== undefined && assignedTheta2 !== undefined && Math.abs(assignedTheta1 - assignedTheta2) >= 1e-9
    ? [assignedTheta1, assignedTheta2] as const
    : parameterPairs.at(-1);
  if (!parameterPair) return false;
  const [theta1, theta2] = parameterPair;
  const expected1 = Math.exp(theta1) / (Math.exp(theta1) + Math.exp(theta2));
  const probabilityPairs = [
    ...compact.matchAll(/(?:更新后[^。；]{0,180})?\\pi\s*\(\s*a_1[^)]*\)\s*(?:\\approx|≈|=)\s*(\d+(?:\.\d+)?)[^。；]{0,120}\\pi\s*\(\s*a_2[^)]*\)\s*(?:\\approx|≈|=)\s*(\d+(?:\.\d+)?)/gu),
    ...compact.matchAll(/更新后[^。；]{0,100}概率[^。；]{0,30}(\d(?:\.\d+)?)[^。；]{0,35}(?:与|和)[^。；]{0,20}(\d(?:\.\d+)?)/gu)
  ];
  return probabilityPairs.some((match) => {
    const probability1 = Number(match[1]);
    const probability2 = Number(match[2]);
    if (!Number.isFinite(probability1) || !Number.isFinite(probability2)) return false;
    const describesUpdatedResult = /更新后|重新代入|更新规则/u.test(match[0]);
    return describesUpdatedResult && (Math.abs(probability1 - expected1) > 0.012 || Math.abs(probability2 - (1 - expected1)) > 0.012);
  });
}

export function maximumTeachingExplanationCharacters(input: Pick<TeachingNarrativeInput, "pageKind" | "sourceDensity">): number {
  return input.pageKind === "cover" ? 900
    : input.pageKind === "agenda" ? 1_000
      : input.sourceDensity === "sparse" && ["formula", "diagram", "table", "code", "mixed"].includes(input.pageKind ?? "") ? 3_500
      : input.sourceDensity === "sparse" ? 2_000
        : input.sourceDensity === "dense" ? 5_000
          : 3_500;
}

/** Identify page-navigation metadata for field-local correction. */
export function validateTeachingSourceFocus(input: TeachingNarrativeInput): string[] {
  const sections: Array<[string, string]> = [
    ["chapterBridgeMarkdown", input.chapterBridgeMarkdown || ""],
    ["learningObjectives", input.learningObjectives.join("\n")],
    ["mainContentMarkdown", input.mainContentMarkdown],
    ["priorKnowledge", input.priorKnowledge.join("\n")],
    ["fullExplanationMarkdown", input.fullExplanationMarkdown],
    ["misconceptions", input.misconceptions.join("\n")],
    ["questions", input.questions.map(question => [question.prompt, question.expectedAnswer || "", ...(question.options || []), question.explanation].join("\n")).join("\n")]
  ];
  const visibleSections = sections.map(([field, markdown]) => [field, stripProtectedMarkdown(markdown)] as const);
  const issues: string[] = [];
  const locator = /(?:页码|页脚|页眉|页面编号|分页信息|第\s*\d+\s*页)/u;
  for (const [field, text] of visibleSections) {
    if (locator.test(text)) issues.push(`TEACHING_PRESENTATION:${field}:LAYOUT_COMMENTARY`);
  }
  return [...new Set(issues)];
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
  if (headings.some((heading) => /^(?:页面上的对象|本页对象|原图对象)$/u.test(heading))) issues.push("TEACHING_SOURCE_COMMENTARY_HEADING");
  if (input.chapterBridgeMarkdown?.trim() && /(?:上一页|前一页|前页)/u.test(explanation.slice(0, 700))) issues.push("TEACHING_BRIDGE_REPEATED_IN_EXPLANATION");

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
  issues.push(...validateTeachingCountConsistency(learnerText, input.questions));
  for (const field of softmaxNormalizationIssueFields(input)) issues.push(`TEACHING_SOFTMAX_NORMALIZATION_CONTRADICTION:${field}`);
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
    issues.push(...validateTeachingPresentation(input));
    if (/(?:页码|页脚|版式信息|读者刚翻到|材料第\s*\d+\s*页)/u.test(explanation)
      || (input.pageKind === "agenda" && /\b\d+\s*\/\s*\d+\b/u.test(explanation))) {
      issues.push("TEACHING_LAYOUT_COMMENTARY");
    }
    if (explanation.split(/[；。\n]/u).some((clause) =>
      /(?:图中|页面)(?:并)?没有/u.test(clause)
      && (clause.match(/横轴|纵轴|图例|表格/gu) || []).length >= 3
      && !/(?:因此|所以|无法|不能|需要|难以|难以确认)/u.test(clause))) {
      issues.push("TEACHING_IRRELEVANT_ABSENCE_CHECKLIST");
    }
    if (sourceNarrationLines(explanation).length >= 4) issues.push("TEACHING_SOURCE_COMMENTARY_OVERUSE");
    const mathFields = {
      chapterBridgeMarkdown: input.chapterBridgeMarkdown || "",
      learningObjectives: input.learningObjectives.join("\n"),
      priorKnowledge: input.priorKnowledge.join("\n"),
      fullExplanationMarkdown: input.fullExplanationMarkdown,
      mainContentMarkdown: input.mainContentMarkdown,
      misconceptions: input.misconceptions.join("\n"),
      questions: input.questions.map((question) => `${question.prompt}\n${question.expectedAnswer || ""}\n${(question.options || []).join("\n")}\n${question.explanation}`).join("\n")
    };
    for (const [field, markdown] of Object.entries(mathFields)) {
      const semanticMarkdown = field === "questions"
        ? input.questions.map((question) => `${question.expectedAnswer || ""}\n${question.explanation}`).join("\n")
        : field === "misconceptions"
          ? input.misconceptions.map((item) => item.replace(/(^|\n)错误理解：[\s\S]*?(?=\n\n(?:错因|正确判断|核对方法)：|$)/gu, "$1")).join("\n")
          : markdown;
      if (validateMarkdownMath(markdown).length > 0) issues.push(`TEACHING_MATH_INVALID:${field}`);
      if (hasMathFormattedAsCode(markdown)) issues.push(`TEACHING_MATH_AS_CODE:${field}`);
      if (hasUnqualifiedWeightedTrend(semanticMarkdown)) issues.push(`TEACHING_WEIGHTED_TREND_CONDITION_MISSING:${field}`);
      if (hasReversedNegativeRewardPreference(semanticMarkdown)) issues.push(`TEACHING_REWARD_DIRECTION_REVERSED:${field}`);
      if (/[\p{Script=Han}]{2,20}（[A-Za-z][A-Za-z .&/-]{1,80}[,，]\s*[A-Z][A-Z0-9-]{1,12}）/u.test(markdown)) {
        issues.push(`TEACHING_ABBREVIATION_PLACEMENT:${field}`);
      }
      if (untranslatedSourceLabels(markdown).length > 0) issues.push(`TEACHING_UNTRANSLATED_SOURCE_LABEL:${field}`);
      if (hasEnglishOnlyMarkdownTable(markdown)) issues.push(`TEACHING_ENGLISH_ONLY_TABLE:${field}`);
      for (const mismatch of factorialMagnitudeMismatches(semanticMarkdown)) {
        issues.push(`TEACHING_FACTORIAL_MAGNITUDE_MISMATCH:${field}:${mismatch.n}:${mismatch.expectedExponent}`);
      }
      if (hasFalseSameMagnitudeClaim(semanticMarkdown)) issues.push(`TEACHING_MAGNITUDE_COMPARISON_FALSE:${field}`);
      if (hasSoftmaxUpdateMismatch(markdown, learnerText)) issues.push(`TEACHING_SOFTMAX_UPDATE_RESULT_MISMATCH:${field}`);
      if (/功耗[^；。！？\n]{0,35}(?:是|指|表示)?[^；。！？\n]{0,12}(?:芯片工作时)?消耗的能量/u.test(semanticMarkdown)
        && !/单位时间|能量消耗(?:速率|速度)|功率/u.test(semanticMarkdown)) {
        issues.push(`TEACHING_POWER_ENERGY_CONFUSION:${field}`);
      }
      const directLogicalOverclaim = /(?:没有|不存在)(?:一个)?(?:唯一(?:的)?)?最优(?:解|方案|摆法)|(?:没有|不存在)[^；。！？\n]{0,60}(?:一个)?[^；。！？\n]{0,30}(?:同时|全部)[^；。！？\n]{0,24}(?:达到|实现)?最优|每(?:一代|一种|个阶段)[^；。！？\n]{0,32}(?:都)?(?:不够用|无效|失败)/u.test(semanticMarkdown);
      const explicitlyLimitedClaim = /(?:不能|无法)(?:据此|仅凭|从(?:本页|这些|该表|材料))?[^；。！？\n]{0,24}(?:断言|推出|证明|确定|确认)[^；。！？\n]{0,24}(?:唯一(?:的)?)?最优/u.test(semanticMarkdown);
      if (directLogicalOverclaim && !explicitlyLimitedClaim) issues.push(`TEACHING_LOGICAL_OVERCLAIM:${field}`);
      const progressionClaim = /(?:每一行|后一(?:行|代|种方法)|下一(?:行|代|种方法))[^；。！？\n]{0,80}(?:恰好|依次|逐一)?[^；。！？\n]{0,40}(?:对应|解决|弥补)[^；。！？\n]{0,45}前一(?:行|代|种方法)|(?:四类|这些|上述)方法[^；。！？\n]{0,60}(?:依次|逐代)[^；。！？\n]{0,50}(?:解决|弥补)|(?:特点|优势)[^；。！？\n]{0,45}(?:正好|分别)?(?:对应|回应)[^；。！？\n]{0,55}(?:前三|前几|各)(?:行|类)?[^；。！？\n]{0,30}(?:限制|短板)|(?:可扩展|泛化|不可微)[^；。！？\n]{0,100}回应[^；。！？\n]{0,45}(?:限制|问题)/u;
      const progressionDenial = /(?:不|不能|无法|未)(?:等于|代表|构成|足以|能推出)?[^；。！？\n]{0,50}(?:逐代|后一(?:种方法|代)|解决前一)|(?:没有|未)(?:给出|说明|证明|显示)?[^；。！？\n]{0,70}(?:演进关系|替代关系|对比证据|后一(?:种方法|代)[^；。！？\n]{0,35}(?:解决|弥补|取代)(?:了|过)?前一(?:种方法|代))/u;
      const progressionOverclaim = semanticMarkdown.split(/[；。！？\n]/u)
        .map((clause) => clause.trim())
        .filter(Boolean)
        .some((clause) => progressionClaim.test(clause) && !progressionDenial.test(clause));
      if (progressionOverclaim) {
        issues.push(`TEACHING_METHOD_PROGRESSION_OVERCLAIM:${field}`);
      }
      const claimsOneAvailableAction = /(?:只有|仅有)[^；。！？\n]{0,28}(?:一个|1\s*个)动作/u.test(semanticMarkdown);
      const scopesOneExecutedAction = /(?:每(?:个)?回合|单次|一次|该回合|这个回合)[^；。！？\n]{0,36}(?:执行|选择)[^；。！？\n]{0,20}(?:一个|1\s*个)动作|(?:只|仅)(?:执行|选择)[^；。！？\n]{0,18}(?:一个|1\s*个)动作/u.test(semanticMarkdown);
      const pageHasTwoAvailableActions = /(?:两个|2\s*个)动作[^；。！？\n]{0,30}(?:可选|可以选择|供选择|动作空间)|动作(?:空间)?[^；。！？\n]{0,30}(?:包含|有|给出)[^；。！？\n]{0,12}(?:两个|2\s*个)(?:可选)?动作/u.test(learnerText);
      if (pageHasTwoAvailableActions && claimsOneAvailableAction && !scopesOneExecutedAction) {
        issues.push(`TEACHING_ACTION_COUNT_CONFLATION:${field}`);
      }
      const unboundedNetlistClaim = /(?:任意|任何|所有)(?:一个|一种|的)?网表/u.test(semanticMarkdown);
      const explicitlyBoundedNetlistClaim = /(?:并非|不能|无法|不代表|不保证|不一定)[^；。！？\n]{0,30}(?:任意|任何|所有)(?:一个|一种|的)?网表/u.test(semanticMarkdown);
      if (unboundedNetlistClaim && !explicitlyBoundedNetlistClaim) issues.push(`TEACHING_UNBOUNDED_GENERALIZATION:${field}`);
      const pageHasSequentialActions = /\$?a_(?:0|\{0\})\$?/u.test(learnerText) && /\$?a_(?:1|\{1\})\$?/u.test(learnerText);
      const explicitlySeparatesEpisodeAndStep = /(?:一个|每个)回合[^；。！？\n]{0,90}(?:连续)?多个时间步[^；。！？\n]{0,90}每(?:个)?时间步[^；。！？\n]{0,30}(?:只|仅)[^；。！？\n]{0,18}(?:选择|执行)[^；。！？\n]{0,16}(?:一个|1\s*个)动作/u.test(semanticMarkdown)
        || /每(?:个)?(?:时间步|一步)[^；。！？\n]{0,35}(?:只|仅)[^；。！？\n]{0,18}(?:选择|执行)[^；。！？\n]{0,16}(?:一个|1\s*个)动作[^；。！？\n]{0,90}(?:但|而|同时)[^；。！？\n]{0,40}(?:一个|完整)回合[^；。！？\n]{0,70}(?:连续)?多个时间步/u.test(semanticMarkdown);
      if (pageHasSequentialActions && !explicitlySeparatesEpisodeAndStep && /每(?:个)?回合[^；。！？\n]{0,36}(?:只|仅)[^；。！？\n]{0,20}(?:(?:选择|执行)[^；。！？\n]{0,16})?(?:其中)?(?:一个|1\s*个)(?:动作)?/u.test(semanticMarkdown)) {
        issues.push(`TEACHING_EPISODE_STEP_CONFLATION:${field}`);
      }
      const negativeWeightedObjective = /=\s*-\s*(?:\\text\{)?(?:Wirelength|wirelength|线长|连线长度)/u.test(learnerText)
        && /-\s*\\(?:lambda|alpha|beta|gamma)/u.test(learnerText);
      if (negativeWeightedObjective && /后两项[^；。！？\n]{0,80}从(?:线长|连线长度)中减去/u.test(semanticMarkdown)) {
        issues.push(`TEACHING_FORMULA_SIGN_DESCRIPTION_REVERSED:${field}`);
      }
      const sourceShowsMultipleEmbeddings = /Edge embeddings/u.test(learnerText) && /Macro embeddings/u.test(learnerText);
      const fixedLengthClaim = /固定长度[^；。！？\n]{0,20}(?:向量|表示)/u.test(semanticMarkdown);
      const fixedLengthDenied = /(?:没有|未)(?:给出|说明|显示)?[^；。！？\n]{0,35}固定长度|(?:不能|无法|不应|不得|不是|并非)[^；。！？\n]{0,35}(?:当成|视为|称为)?[^；。！？\n]{0,20}固定长度/u.test(semanticMarkdown);
      if (sourceShowsMultipleEmbeddings && fixedLengthClaim && !fixedLengthDenied) {
        issues.push(`TEACHING_GRAPH_ENCODER_FIXED_LENGTH_OVERCLAIM:${field}`);
      }
      if (/不同颜色[^；。！？\n]{0,35}(?:表示|对应)[^；。！？\n]{0,45}(?:指标|数值|程度|高低)/u.test(semanticMarkdown)) {
        issues.push(`TEACHING_UNLABELED_COLOR_MEANING:${field}`);
      }
      if (/(?:三|四|五|这些|上述)条(?:要点|说明|内容)?[^；。！？\n]{0,18}(?:构成|形成)[^；。！？\n]{0,16}(?:先后|因果|递进)关系/u.test(semanticMarkdown)) {
        issues.push(`TEACHING_LIST_ORDER_CAUSAL_OVERCLAIM:${field}`);
      }
      if (/(?:三项|线长、拥塞(?:程度)?(?:和|与)密度)[^；。！？\n]{0,35}(?:分别)?(?:乘|带有)[^；。！？\n]{0,24}(?:\\lambda|lambda)[^；。！？\n]{0,24}(?:\\gamma|gamma)/u.test(semanticMarkdown)) {
        issues.push(`TEACHING_UNWEIGHTED_TERM_COEFFICIENT_MISSTATED:${field}`);
      }
      if (semanticMarkdown.split(/[；。！？\n]/u).some((clause) =>
        /(?:权重|\\lambda|\\gamma)/iu.test(clause)
        && /(?:未给出|未知)/u.test(clause)
        && /(?:线长|Wirelength)/iu.test(clause)
        && /(?:不能|无法)/u.test(clause)
        && /(?:判断|断言|确认)/u.test(clause)
        && /(?:下降|减小|变化方向)/u.test(clause))) {
        issues.push(`TEACHING_UNWEIGHTED_TERM_TREND_DENIED:${field}`);
      }
    }
    const forceDirectedStandardCells = /(?:标准单元|第二阶段)[^。！？\n]{0,90}(?:基于力|力导向)/u.test(explanation);
    if (forceDirectedStandardCells && /(?:前两个阶段|宏单元(?:放置)?和标准单元(?:放置)?)[^。！？\n]{0,55}(?:都|均)?由强化学习(?:智能体)?/u.test(input.mainContentMarkdown)) {
      issues.push("TEACHING_STAGE_ACTOR_CONTRADICTION:mainContentMarkdown");
    }
    if (/(?:第二阶段|标准单元放置)[^。！？\n]{0,150}(?:动作记为|动作是)[^。！？\n]{0,20}\$a_\{?T-1\}?\$/u.test(explanation)) {
      issues.push("TEACHING_TERMINAL_ACTION_STAGE_MISASSIGNED:fullExplanationMarkdown");
    }
    const standardCellSection = /##\s+[^\n]*(?:标准单元|力导向|基于力)[^\n]*\n([\s\S]{0,900}?)(?=\n##\s|$)/u.exec(explanation)?.[1] || "";
    const assignsTerminalActionToStandardCells = /(?:标准单元|基于力|力导向)[^。！？\n]{0,100}\$a_\{?T-1\}?\$|\$a_\{?T-1\}?\$[^。！？\n]{0,100}(?:标准单元|基于力|力导向)/u.test(standardCellSection);
    const deniesTerminalMisassignment = /\$a_\{?T-1\}?\$[^。！？\n]{0,80}(?:不是|不属于)[^。！？\n]{0,45}(?:标准单元|基于力|力导向)|(?:标准单元|基于力|力导向)[^。！？\n]{0,80}(?:不包含|没有)[^。！？\n]{0,30}\$a_\{?T-1\}?\$/u.test(standardCellSection);
    if (assignsTerminalActionToStandardCells && !deniesTerminalMisassignment
      && !/(?:宏单元阶段|最后一个宏单元)[^。！？\n]{0,40}\$a_\{?T-1\}?\$|\$a_\{?T-1\}?\$[^。！？\n]{0,45}(?:宏单元阶段|最后一个宏单元)/u.test(standardCellSection)) {
      issues.push("TEACHING_TERMINAL_ACTION_STAGE_MISASSIGNED:fullExplanationMarkdown");
    }
    if (/(?:标准单元|基于力|力导向)[^。！？\n]{0,80}(?:同样|继续)?[^。！？\n]{0,30}(?:画出|包含|经过)[^。！？\n]{0,25}(?:智能体与时间步|多个时间步)/u.test(explanation)) {
      issues.push("TEACHING_STANDARD_CELL_AGENT_INVENTED:fullExplanationMarkdown");
    }
    if (input.learningObjectives.some((objective) => /(?:解释|说明)[^。；\n]{0,35}为什么[^。；\n]{0,35}(?:回报|奖励)[^。；\n]{0,18}(?:为|等于|都是)\s*0/u.test(objective))) {
      issues.push("TEACHING_ZERO_REWARD_CAUSE_UNSUPPORTED:learningObjectives");
    }
    const objectivePromisesCalculation = input.learningObjectives.some((objective) =>
      /(?:能|能够|可以)[^。；\n]{0,45}(?:算出|计算|求出)[^。；\n]{0,45}(?:更新|参数|结果|数值)/u.test(objective));
    const explanationDeniesCalculation = /(?:更新后|更新结果|参数)[^。；\n]{0,30}(?:具体)?(?:数值|结果)[^。；\n]{0,18}(?:无法|不能)[^。；\n]{0,12}(?:确定|算出|计算)|(?:无法|不能)[^。；\n]{0,18}(?:确定|算出|计算)[^。；\n]{0,30}(?:更新后|更新结果|参数)(?:的)?(?:具体)?(?:数值|结果)/u.test(explanation);
    const objectiveClaimsFormulaEquivalence = input.learningObjectives.some((objective) => /(?:两|2)(?:个|条|种)[^。；\n]{0,20}(?:公式|计算式)[^。；\n]{0,16}(?:等价|相同)|(?:等价|相同)[^。；\n]{0,16}(?:公式|计算式)/u.test(objective));
    const explanationDeniesFormulaEquivalence = /(?:两|2)(?:个|条|种)[^。；\n]{0,60}(?:公式|计算式|写法)[^。；\n]{0,80}(?:无法|不能|未说明)[^。；\n]{0,30}(?:统一|等价|相同|确定)|(?:无法|不能|未说明)[^。；\n]{0,50}(?:两|2)(?:个|条|种)[^。；\n]{0,30}(?:公式|计算式|写法)/u.test(learnerText);
    const objectivePromisesRoutingMethod = input.learningObjectives.some((objective) => /(?:说出|指出|说明)[^。；\n]{0,55}(?:方法|实现)[^。；\n]{0,25}布线|布线[^。；\n]{0,25}(?:方法|实现)/u.test(objective));
    const explanationDeniesRoutingMethod = /布线[^。；\n]{0,30}(?:实现方式|方法|细节)[^。；\n]{0,18}(?:无法|不能|未给出|未说明|不能确认)|(?:无法|不能|未给出|未说明|不能确认)[^。；\n]{0,24}布线[^。；\n]{0,20}(?:实现方式|方法|细节)/u.test(learnerText);
    const objectivePromisesKnownConcatDimension = input.learningObjectives.some((objective) => /(?:输入|拼接)[^。；\n]{0,45}(?:边权|权重|w_?\{?ij\}?)[^。；\n]{0,55}(?:维度|64)/iu.test(objective));
    const explanationDeniesConcatDimension = /(?:边权|w_?\{?ij\}?)[^。；\n]{0,36}(?:维度|形状)[^。；\n]{0,18}(?:没有|未给出|未说明|无法|不能)|(?:没有|未给出|未说明|无法|不能)[^。；\n]{0,30}(?:边权|w_?\{?ij\}?)[^。；\n]{0,18}(?:维度|形状)/iu.test(learnerText);
    const objectiveClaimsOnlySelectedParameterChanges = input.learningObjectives.some((objective) =>
      /(?:只|仅)[^。；\n]{0,24}(?:改变|改动|更新)[^。；\n]{0,30}(?:被选中动作|选中动作)[^。；\n]{0,24}(?:参数|权重)|(?:被选中动作|选中动作)[^。；\n]{0,24}(?:参数|权重)[^。；\n]{0,24}(?:只|仅)[^。；\n]{0,16}(?:改变|改动|更新)|(?:另一个|另一项|其余|未选(?:中)?动作(?:对应的)?)[^。；\n]{0,22}(?:参数|权重)?[^。；\n]{0,12}(?:为何|为什么)?(?:保持)?不变/u.test(objective));
    const explanationSaysMultiplePolicyParametersChange = /(?:同时|都|两个|两项|两个分量)[^。；\n]{0,30}(?:改变|改动|更新)[^。；\n]{0,30}(?:参数|权重)|(?:参数|权重)[^。；\n]{0,30}(?:同时|都|两个|两项|两个分量)[^。；\n]{0,20}(?:改变|改动|更新)/u.test(learnerText);
    if (explanationDeniesConcatDimension) {
      for (const [field, markdown] of Object.entries(mathFields)) {
        if (hasUnsupportedConcatDimensionClaim(markdown)) issues.push(`TEACHING_CONCAT_DIMENSION_CONTRADICTION:${field}`);
      }
    }
    if ((objectivePromisesCalculation && explanationDeniesCalculation)
      || (objectiveClaimsFormulaEquivalence && explanationDeniesFormulaEquivalence)
      || (objectivePromisesRoutingMethod && explanationDeniesRoutingMethod)
      || (objectivePromisesKnownConcatDimension && explanationDeniesConcatDimension)
      || (objectiveClaimsOnlySelectedParameterChanges && explanationSaysMultiplePolicyParametersChange)) issues.push("TEACHING_OBJECTIVE_EXPLANATION_CONTRADICTION");
    const terminalRewardShown = /\$r_(?:T|\{T\})\$|\$r_(?:T|\{T\})\s*=|末端回报[^。；\n]{0,30}(?:表达式|由|组成|写成)/u.test(learnerText);
    const terminalRewardDenied = /(?:没有|未)(?:给出|说明)[^。；\n]{0,20}(?:最终|末端)(?:奖励|回报)[^。；\n]{0,20}(?:哪里|位置|形式|表达式|数值|来源|如何)/u.test(learnerText);
    if (terminalRewardShown && terminalRewardDenied) issues.push("TEACHING_OBJECT_PRESENCE_CONTRADICTION");
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
      if (/[“”"']/u.test(label)) issues.push("TEACHING_PRIOR_TERM_PAIR_MALFORMED");
      if (hasUnpairedEnglishPhrase(definition, sourceNames)) issues.push("TEACHING_PRIOR_UNPAIRED_ENGLISH");
      if (/（[^）\n]*[,，]\s*[A-Z][A-Z0-9-]{1,12}）/u.test(label)) issues.push("TEACHING_PRIOR_ABBREVIATION_PLACEMENT");
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

/** Mathematical state, action and reward expressions must reach KaTeX rather than render as code. */
function hasMathFormattedAsCode(markdown: string): boolean {
  const spans = [...markdown.matchAll(/`([^`\r\n]{1,80})`/gu)].map((match) => match[1]!.trim());
  if (spans.some((value) => /^(?:[A-Za-z](?:_?\d+)?\s*[=<>≤≥+*/^-]\s*-?\d|[A-Za-z]_\{?[A-Za-z0-9]+\}?)/u.test(value))) return true;
  const compactIndexed = spans.filter((value) => /^[A-Za-z]\d+$/u.test(value));
  return compactIndexed.length >= 2 && /(?:状态|动作|回报|奖励|参数|向量|公式)/u.test(markdown);
}

/** A symbolic weight has no guaranteed sign, so a trend conclusion needs its condition beside the claim. */
export function hasUnqualifiedWeightedTrend(markdown: string): boolean {
  // This rule concerns a weighted score, not every use of a learning-rate symbol.
  const formulas = [...markdown.matchAll(/\$\$([\s\S]*?)\$\$|(?<!\$)\$([^$\r\n]+)\$(?!\$)/gu)]
    .map((match) => match[1] || match[2] || "");
  const hasSymbolicWeightedScore = formulas.some((formula) => /(?:^|\s)(?:r|R|J)(?:_[A-Za-z0-9{}]+)?\s*=[\s\S]{0,150}[-−]\s*\\(?:lambda|gamma|alpha|beta|mu|eta)\b/u.test(formula));
  const admitsMissingWeights = /(?:权重|系数)[^。；;\n]{0,36}(?:没有给出|未给出|没有说明|未说明|未知|无法确定)/u.test(markdown);
  const describesWeightedPenalty = /(?:加权|带负号|负向)[^。；;\n]{0,45}(?:回报|奖励|得分|损失|目标函数|评分|结果|组成|分项)|(?:回报|奖励|得分|损失|目标函数|评分|结果)[^。；;\n]{0,45}(?:加权|带负号|负向)/u.test(markdown);
  const hasUnweightedLinePenalty = formulas.some((formula) => /(?:^|[=+\-])\s*-\s*(?:\\text\{)?(?:Wirelength|wirelength|线长|连线长度)/u.test(formula));
  if (!hasSymbolicWeightedScore && !(admitsMissingWeights && describesWeightedPenalty)) return false;
  return markdown.split(/[；;。\n]/u).some((clause) => {
    // A labelled misconception is the claim being refuted. Its explanation
    // and corrected judgement are checked separately below, not exempted.
    if (/^\s*(?:[-*]\s*)?(?:错误理解|误解)\s*[:：]/u.test(clause)) return false;
    const unqualifiedSmallerIsBetter = /(?:这些|这[两三四几]项|各项|全部|所有|三个|两项|指标)[^，]{0,45}(?:越小越好|越低越好|越少越好)/u.test(clause);
    if (unqualifiedSmallerIsBetter) {
      const explicitlyConditional = /(?:若|如果|当|假设|假定|只有在|仅在|在[^，；;\n]{0,50}(?:条件|前提)下)/u.test(clause);
      const weightsQualified = /(?:权重|系数|\\(?:lambda|gamma|alpha|beta|mu|eta))[^，]{0,45}(?:非负|为正|正数|正值|大于零|不小于零|>\s*0|≥\s*0|\\geq?\s*0)/u.test(clause);
      if (!(explicitlyConditional && weightsQualified)) return true;
    }
    const trend = clause.match(/(?:回报|奖励|得分|损失|目标函数|评分|结果).{0,100}(?:增大|增加|提高|上升|越大).{0,60}(?:下降|降低|减少|减小|变小|越小|越低)|(?:增大|增加|提高|上升|越大).{0,75}(?:回报|奖励|得分|损失|目标函数|评分|结果|(?:该|此|这个)?(?:量|数值|值|整体)|\$?r(?:_[A-Za-z0-9{}]+)?\$?).{0,60}(?:下降|降低|减少|减小|变小|越小|越低)/u);
    if (!trend) return false;
    // A warning that explicitly rejects the trend is not an assertion of it.
    const beforeTrend = clause.slice(0, (trend.index ?? 0) + Math.max(0, trend[0].search(/(?:增大|增加|提高|上升|越大)/u)));
    if (/(?:不能|不可|不应|无法|并非|不是|错误)[^，；;。]{0,40}$/u.test(beforeTrend)) return false;
    const explicitlyConditional = /(?:若|如果|当|假设|假定|只有在|仅在|在[^，；;\n]{0,50}(?:条件|前提)下|(?:权重|系数|\\(?:lambda|gamma|alpha|beta|mu|eta))[^，；;\n]{0,60}(?:时|情况下))/u.test(clause);
    const weightsQualified = /(?:权重|系数|\\(?:lambda|gamma|alpha|beta|mu|eta))[^，]{0,45}(?:非负|为正|正数|正值|大于零|不小于零|>\s*0|≥\s*0|\\geq?\s*0)/u.test(clause);
    const otherInputsControlled = /(?:其他|其余|别的)[^，]{0,20}(?:不变|固定|保持)|(?:同时|一起)[^，]{0,12}(?:增大|增加)/u.test(clause);
    const lineLengthTrend = /(?:线长|Wirelength)[^，；;\n]{0,80}(?:增大|增加|变长)[^，；;\n]{0,45}(?:回报|奖励|得分|结果|数值)[^，；;\n]{0,30}(?:下降|降低|减少|减小|变小|越低)/iu.test(clause);
    const fixedMinusOne = /(?:线长|Wirelength)[^，；;\n]{0,45}系数[^，；;\n]{0,18}(?:固定为|就是)?\s*\$?-?1\$?|(?:该项|线长项)[^，；;\n]{0,24}系数[^，；;\n]{0,18}(?:固定为|就是)?\s*\$?-?1\$?/iu.test(clause);
    if (lineLengthTrend && otherInputsControlled && (fixedMinusOne || hasUnweightedLinePenalty)) return false;
    return !(explicitlyConditional && weightsQualified && otherInputsControlled);
  });
}

/** A negated cost used as reward becomes better, not worse, when its value increases. */
function hasReversedNegativeRewardPreference(markdown: string): boolean {
  const formulas = [...markdown.matchAll(/\$\$([\s\S]*?)\$\$|(?<!\$)\$([^$\r\n]+)\$(?!\$)/gu)]
    .map((match) => match[1] || match[2] || "");
  const hasNegativeReward = formulas.some((formula) => /(?:^|\s)(?:r|R)(?:_[A-Za-z0-9{}]+)?\s*=\s*[-−]/u.test(formula));
  if (!hasNegativeReward) return false;
  return markdown.split(/[；;。\n]/u).some((clause) =>
    /(?:回报|奖励|reward|\$?r(?:_[A-Za-z0-9{}]+)?\$?)[^，]{0,45}(?:数值|值)?[^，]{0,20}(?:越大|增大|提高|上升)[^，]{0,24}(?:越差|更差|较差|更坏|越坏)/iu.test(clause)
    || /(?:取负号|取负值|负号后|负值)[^，]{0,55}(?:数值|值|回报|奖励)[^，]{0,20}(?:越大|增大|提高|上升)[^，]{0,24}(?:越差|更差|较差|更坏|越坏)/u.test(clause));
}

/** Do not fold an extra edge-weight term into a known 64-D node-pair vector. */
function hasUnsupportedConcatDimensionClaim(markdown: string): boolean {
  return markdown.split(/\r?\n|。/u).some((line) => {
    if (!/(?:边权|边的[^，；]{0,16}权重|w_?\{?ij\}?)/iu.test(line)
      || !/64\s*维/u.test(line)
      || !/(?:拼成|拼接(?:成|为)?|一并进入|共同进入|合成|构成)/u.test(line)) return false;
    if (/(?:不能|不可|无法|不应|并非|不是)[^。\n]{0,100}64\s*维|(?:维度|总维度)[^。\n]{0,50}(?:无法|不能|未知|未给出|未说明)/u.test(line)) return false;
    if (/(?:需要|必须)(?:先)?(?:知道|确认)[^。\n]{0,80}(?:维度|形状)[^。\n]{0,80}(?:没有给出|未给出|没有说明|未说明|未知|无法确定)/u.test(line)) return false;
    return true;
  });
}

/** Compare only explicit totals for the same source scope, not incidental counts. */
export function validateTeachingCountConsistency(markdown: string, questions: Array<{ prompt: string; expectedAnswer?: string }> = []): string[] {
  const numerals: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const nouns = ["训练方式", "训练条件", "节点向量", "硬件", "算法", "模型", "图表", "曲线", "公式", "节点", "模块", "图像", "表格", "章节", "材料", "选项"];
  const parse = (value: string) => [...stripProtectedMarkdown(value).matchAll(/(?<![A-Za-z0-9约近第])([一二两三四五六七八九十]|[1-9][0-9]?)(个|种|组|类|项|条|张|根)([\p{Script=Han}]{2,7})/gu)]
    .map((match) => {
      const noun = nouns.find((candidate) => match[3]!.replace(/^(?:不同的?|主要的?|相关的?|被比较的?)/u, "").startsWith(candidate));
      const measure = ["种", "类"].includes(match[2]!) ? "type" : match[2] === "组" ? "group" : "instance";
      return { index: match.index, noun, measure, value: numerals[match[1]!] ?? Number(match[1]) };
    }).filter((fact) => fact.noun && Number.isFinite(fact.value));
  const visible = stripProtectedMarkdown(markdown);
  const totals = new Map<string, Set<number>>();
  for (const fact of parse(markdown)) {
    const before = visible.slice(Math.max(0, fact.index - 80), fact.index).split(/[，。；\n]/u).at(-1) ?? "";
    const scope = [...before.matchAll(/(图中|本页|页面|该图|左图|右图|横轴|纵轴|图例|表中|表格)[^，。；\n]{0,50}?(?:有|共|列出|包含|包括|显示|比较|给出|分成)/gu)].at(-1)?.[1];
    if (!scope) continue;
    const key = `${scope}:${fact.measure}:${fact.noun}`;
    const seen = totals.get(key) ?? new Set<number>();
    seen.add(fact.value);
    totals.set(key, seen);
  }
  for (const question of questions) {
    if (!/(?:图中|页面|本页|左图|右图|横轴|图例|全部|所有)/u.test(question.prompt)
      || !/(?:哪些|列出|分别|共有|总共|几个|几种|几类|几组)/u.test(question.prompt)) continue;
    for (const fact of parse(question.expectedAnswer ?? "")) {
      const answerVisible = stripProtectedMarkdown(question.expectedAnswer ?? "");
      const before = answerVisible.slice(Math.max(0, fact.index - 6), fact.index);
      if (/(?:前|其中|部分|某些)$/u.test(before)) continue;
      for (const [key, seen] of totals) {
        if (key.endsWith(`:${fact.measure}:${fact.noun}`)) seen.add(fact.value);
      }
    }
  }
  return [...new Set([...totals].filter(([, seen]) => seen.size > 1).map(([key]) => `TEACHING_COUNT_CONTRADICTION:${key.split(":")[2]}`))];
}

/** Keep every heading's words while turning an empty nested heading into prose. */
export function normalizeAdjacentTeachingHeadings(markdown: string): string {
  return markdown.replace(/(^#{2,4}[ \t]+[^\r\n]+\r?\n(?:[ \t]*\r?\n)*)(?:#{2,4})[ \t]+([^\r\n]+)/gm,
    (_match, firstHeading: string, nextTitle: string) => `${firstHeading}${nextTitle}`);
}

export function hasUnpairedEnglishPhrase(markdown: string, sourceNames: string[] = []): boolean {
  return unpairedEnglishPhrases(markdown, sourceNames).length > 0;
}

/** Locate learner-facing lines that narrate the source instead of teaching its objects directly. */
export function sourceNarrationLines(markdown: string): string[] {
  const narration = /(?:页面|本页|原图|课件|表中|原表|图中)(?=(?:第一|第二|上半|下半|左|右)?(?:组|部分)?(?:要点|内容|文字|公式|表格|一栏|一行)?(?:给出|列出|写着|写的是|显示|说明|没有|只|下半部分|第一组|第二组)|[^\n]{0,10}(?:给出|列出|写着|显示|没有))/u;
  const justifiedEvidenceBoundary = /(?:没有|未给出|未标出|未说明)[^\n]{0,120}(?:因此|所以|无法|不能|只能|尚不能|不代表|不支持|证明|验证)/u;
  const justifiedSourceCorrection = /(?:原文|材料|页面|课件)[^\n]{0,140}(?:写成|标为|给成)[^\n]{0,100}(?:粗略|近似|错误|不准确|复算|实际|准确)/u;
  return markdown.split(/\r?\n/u).map((line) => line.trim()).filter((line) => {
    const visible = stripProtectedMarkdown(line);
    return line && narration.test(visible) && !justifiedEvidenceBoundary.test(visible) && !justifiedSourceCorrection.test(visible);
  });
}

/** Locate definitions that fail the same contract used by the narrative gate. */
export function incompletePriorKnowledgeDefinitions(priorKnowledge: string[]): string[] {
  return priorKnowledge.filter((item) => {
    const definition = item.trim().replace(/^[-*+]\s+/, "");
    const split = definition.indexOf("：");
    const clauses = split < 0 ? [] : definition.slice(split + 1).split(/[；;]/).map((part) => part.trim()).filter(Boolean);
    return split < 2 || definition.length < 70 || clauses.length < 3 || clauses.length > 5 || clauses.some((part) => part.length < 8);
  });
}

export function unpairedEnglishPhrases(markdown: string, sourceNames: string[] = []): string[] {
  const visible = stripProtectedMarkdown(markdown)
    .replace(/(?:[A-Za-z][A-Za-z0-9-]*\s+)?[\p{Script=Han}]{2,25}（[^）]*[A-Za-z][^）]*）/gu, (whole) => {
      const parenthetical = whole.slice(whole.indexOf("（") + 1, -1).trim();
      return /^[A-Z]/u.test(parenthetical) ? "" : whole;
    })
    .replace(/\b[A-Z]{2,5}\s+\d{2,5}\b/gu, "")
    .replace(/\b[A-Z]{2,8}\s*即[\p{Script=Han}]{2,20}/gu, "")
    .replace(/(?<=发表于|刊于)\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,5}(?=\s+的(?:文章|论文|期刊))/gu, "")
    .replace(/“[^”\n]{0,100}[A-Za-z][^”\n]{0,100}”/gu, "")
    .replace(/"[A-Za-z][^"\n]{0,100}"/gu, "")
    .replace(/「[A-Za-z][^」\n]{0,100}」/gu, "")
    .replace(/《[A-Za-z][^》\n]{2,100}》/gu, "");
  const withoutSourceNames = sourceNames.reduce((text, name) => text.replace(new RegExp(`(?<![A-Za-z])${escapeRegExp(name)}(?![A-Za-z])`, "giu"), ""), visible);
  return [...new Set([...withoutSourceNames.matchAll(/(?:^|[^\p{L}])((?:[A-Za-z]{3,}(?:[- ][A-Za-z]+)*|[A-Z]{2,}))(?=$|[^\p{L}])/gu)].map((match) => match[1]!).filter(Boolean))];
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

/** Quote verbatim English labels when the surrounding Chinese identifies them as source UI or diagram text. */
export function quoteContextualSourceLabels(text: string, sourceText: string): string {
  const appearsInSource = (label: string) => new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(label)}(?![A-Za-z0-9])`, "iu").test(sourceText);
  const withMathLabels = text.split(/(```[\s\S]*?```|`[^`\r\n]+`|https?:\/\/\S+|“[^”\r\n]+”|"[^"\r\n]+")/gu)
    .map((part, index) => index % 2 === 1 ? part : part.replace(
      /(?<![A-Za-z0-9“"])([A-Z][A-Za-z]*(?:[ -][A-Za-z]+){0,5})\s+(\$[^$\r\n]+\$)(?=\s*(?:区域|区块|栏目|一栏|一行|标签|节点|箭头|模块|步骤|阶段))/gu,
      (whole, label: string, math: string) => appearsInSource(label.trim()) ? `“${label.trim()} ${math}”` : whole
    )).join("");
  return withMathLabels.split(/(```[\s\S]*?```|`[^`\r\n]+`|\$\$[\s\S]*?\$\$|(?<!\$)\$[^$\r\n]+\$(?!\$)|https?:\/\/\S+|“[^”\r\n]+”|"[^"\r\n]+")/gu)
    .map((part, index) => index % 2 === 1 ? part : part.replace(
      /(?<![A-Za-z0-9“"])([A-Z][A-Za-z0-9]*(?:[ -][A-Za-z0-9]+){0,5})(?=\s*(?:部分|区域|区块|栏目|一栏|一行|一句话|标签|节点|箭头|模块|步骤|阶段))/gu,
      (label) => appearsInSource(label.trim()) ? `“${label.trim()}”` : label
    )).join("");
}

/** Add math delimiters to the same narrow symbol forms rejected by the teaching validator. */
export function normalizeBareMathSymbols(text: string): string {
  return text.split(/(```[\s\S]*?```|`[^`\r\n]+`|\$\$[\s\S]*?\$\$|(?<!\$)\$[^$\r\n]+\$(?!\$)|https?:\/\/\S+|“[^”\r\n]+”|"[^"\r\n]+")/gu)
    .map((part, index) => index % 2 === 1 ? part : part.replace(
      /(?<![\p{L}\p{N}])([A-Za-z]{1,3}(?:_[A-Za-z0-9{}]+|\^[A-Za-z0-9{}]+))(?![\p{L}\p{N}])/gu,
      "$$$1$"
    )).join("");
}

/** Move a trailing abbreviation before the Chinese term and keep only the official English name in parentheses. */
export function normalizePriorDefinitionAbbreviation(text: string): string {
  return text.replace(
    /^(\s*(?:[-*+]\s+)?)([\p{Script=Han}][^：（\n]{1,30})（([A-Za-z][A-Za-z .&/-]{1,80})[,，]\s*([A-Z][A-Z0-9-]{1,12})）：/u,
    "$1$4 $2（$3）："
  );
}

/** Remove a trailing abbreviation from parenthetical English when its Chinese term boundary is not structurally known. */
export function normalizeEmbeddedDefinitionAbbreviation(text: string): string {
  return text.replace(
    /（([A-Za-z][A-Za-z .&/-]{1,80})[,，]\s*[A-Z][A-Z0-9-]{1,12}）/gu,
    "（$1）"
  );
}

/** Keep the previous-page fact, current-page question, and following list as separate readable blocks. */
export function normalizeTeachingBridgeBlocks(text: string): string {
  return text
    .replace(/\n(?!\s*\n)(?=(?:本页|这一页|接下来)[^\n]{0,40}(?:回答|解决|说明|解释|要看))/gu, "\n\n")
    .replace(/：\n(?!\s*\n)(?=\s*[-*+]\s)/gu, "：\n\n");
}

/** Preserve every definition fact while keeping the policy's three-to-five-clause shape. */
export function normalizePriorDefinitionClauseCount(text: string): string {
  const split = text.indexOf("：");
  if (split < 2) return text;
  const clauses = text.slice(split + 1).split(/[；;]/).map((part) => part.trim()).filter(Boolean);
  if (clauses.length <= 5) return text;
  return `${text.slice(0, split + 1)}${[...clauses.slice(0, 4), clauses.slice(4).join("，")].join("；")}`;
}

/** Turn a source label mistakenly formatted as inline code back into a quoted source object. */
export function normalizeSourceLabelCodeSpans(text: string, sourceText: string): string {
  return text.replace(/`([^`\r\n]{1,100})`/gu, (whole, rawLabel: string, offset: number) => {
    const label = rawLabel.trim();
    const context = text.slice(Math.max(0, offset - 24), offset);
    const naturalLabel = /^[A-Za-z][A-Za-z0-9 +,:?/-]*$/u.test(label)
      && !/[=_{}();]|\b(?:npm|pnpm|yarn|curl|git|docker)\b/iu.test(label);
    const sourceBacked = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(label)}(?![A-Za-z0-9])`, "iu").test(sourceText);
    const introducedAsLabel = /(?:写着|标记|标为|标着|文字为|题注|标签|一行|起点是|分别是|名称是|称为|为|是)\s*$/u.test(context);
    return naturalLabel && sourceBacked && introducedAsLabel ? `“${label}”` : whole;
  });
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
    questions: input.questions.map((question) => `${question.prompt}\n${(question.options || []).join("\n")}\n${question.expectedAnswer || ""}\n${question.explanation}`).join("\n")
  };
  const learnerText = Object.values(parts).join("\n");
  const sourceNames = definedSourceNames(input.sourceTitle || "", learnerText);
  return (Object.keys(parts) as TeachingNarrativeField[]).filter((field) => hasUnpairedEnglishPhrase(parts[field], sourceNames));
}

function softmaxNormalizationIssueFields(input: TeachingNarrativeInput): TeachingNarrativeField[] {
  const parts: Record<TeachingNarrativeField, string> = {
    chapterBridgeMarkdown: input.chapterBridgeMarkdown || "",
    learningObjectives: input.learningObjectives.join("\n"),
    mainContentMarkdown: input.mainContentMarkdown,
    priorKnowledge: input.priorKnowledge.join("\n"),
    fullExplanationMarkdown: input.fullExplanationMarkdown,
    misconceptions: input.misconceptions.flatMap((item) => item.split(/(?:正确判断|核对方法)[：:]/u).slice(1)).join("\n"),
    questions: input.questions.map((question) => question.explanation).join("\n")
  };
  if (!/\bsoftmax\b/iu.test(Object.values(parts).join("\n"))) return [];
  return (Object.keys(parts) as TeachingNarrativeField[]).filter((field) => parts[field].split(/[；;。！？\n]/u).some((clause) =>
    /(?:概率|softmax)[^；;。！？\n]{0,110}(?:如果|若|当|只改|仅改)[^；;。！？\n]{0,90}(?:概率)?(?:之和|总和|和|加起来)[^；;。！？\n]{0,16}(?:不等于|不是|不为|≠)[^；;。！？\n]{0,10}\$?1\$?/iu.test(clause)));
}

function definedSourceNames(title: string, learnerText: string): string[] {
  const names = [...title.matchAll(/\b(?:[A-Z][A-Za-z]+-[A-Z][A-Za-z]+|[A-Z]{2,8})\b/gu)].map((match) => match[0]);
  const definedTitleNames = names.filter((name) => new RegExp(`${escapeRegExp(name)}[^\\n]{0,90}(?:(?:是|指|作为|用于|表示|即|定位为|定位成)[^\\n]{0,70}[\\p{Script=Han}]{2}|(?:算法|模型|方法|规则|框架)（[^）]{3,80}）：[^\\n]{2,})`, "iu").test(learnerText));
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
  // Inspect the original visible line: removing inline math/code can turn
  // “这个回报是：$r_T=...$” into a fake empty colon heading.
  const headingLines = markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "")
    .split(/(\r?\n)/u).map(part => isOpaqueMarkdownLine(part) ? "" : part).join("")
    .replace(/`([^`\r\n]+)`/g, "$1");
  if (headingLines.split(/\r?\n/).some((line) => !isNaturalListIntroduction(line) && /^\s*(?!#{1,6}\s)(?:[-*+]\s*)?[\p{Script=Han}A-Za-z0-9 _-]{1,18}[：:]\s*$/u.test(line))) issues.push("WRITING_COLON_PSEUDO_HEADING");
  return issues;
}

function isNaturalListIntroduction(line: string): boolean {
  return /^(?:(?:本页|这里|下面|以下|需要|请|先|再|核对|检查|分别|可以|包括|例如|要回答|它们分别|公式从)[^\n]{2,70}|[^\n]{4,70}(?:是|如下|包括|分为|分成|三步))[：:]\s*$/u.test(line.trim());
}

/** Apply only lossless punctuation repairs outside code, quotes, URLs and math. */
export function normalizeHumanReadableChineseMarkdown(markdown: string): string {
  let inFence = false;
  let fenceMarker = "";
  let inDisplayMath = false;
  let inBracketMath = false;
  const repaired = markdown.split(/(\r?\n)/).map((part) => {
    if (/^\r?\n$/.test(part)) return part;
    const fence = part.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) { inFence = true; fenceMarker = fence[1]!; }
      else if (part.trimStart().startsWith(fenceMarker)) { inFence = false; fenceMarker = ""; }
      return part;
    }
    if (inFence) return part;
    const bracketOpen = (part.match(/(?<!\\)\\\[/gu) ?? []).length;
    const bracketClose = (part.match(/(?<!\\)\\\]/gu) ?? []).length;
    const displayCount = part.match(/(?<!\\)\$\$/g)?.length ?? 0;
    if (inBracketMath || inDisplayMath) {
      if ((bracketOpen + bracketClose) % 2 === 1) inBracketMath = !inBracketMath;
      if (displayCount % 2 === 1) inDisplayMath = !inDisplayMath;
      return part;
    }
    // Source objects and indented code are opaque, as in ReadWeave's prose
    // range scanner. A format pass must not rewrite their original bytes.
    if (isOpaqueMarkdownLine(part)) return part;
    if (bracketOpen || bracketClose) {
      if ((bracketOpen + bracketClose) % 2 === 1) inBracketMath = !inBracketMath;
      return part;
    }
    if (displayCount > 0) {
      if (displayCount % 2 === 1) inDisplayMath = !inDisplayMath;
      return part;
    }
    const protectedValues: string[] = [];
    const protectedLine = part.replace(/!?\[[^\]\r\n]*\]\([^\r\n]*?\)|“[^”\r\n]*”|「[^」\r\n]*」|`[^`\r\n]+`|(?<!\$)\$[^$\r\n]+\$(?!\$)|https?:\/\/\S+/g, (value) => {
      protectedValues.push(value);
      return `\u0000${protectedValues.length - 1}\u0000`;
    });
    const repaired = protectedLine.replace(/。(?=\s*$)/g, "").replace(/。/g, "；").replace(/；(?=\s*$)/g, "");
    const pseudoHeading = isNaturalListIntroduction(repaired) ? null : repaired.match(/^(\s*)(?:[-*+]\s*)?([\p{Script=Han}A-Za-z0-9 _-]{1,18})[：:]\s*$/u);
    const structured = pseudoHeading ? `${pseudoHeading[1]}## ${pseudoHeading[2]!.trim()}` : repaired;
    const restored = structured.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => protectedValues[Number(index)]!);
    if (validateHumanReadableChinese(restored).includes("WRITING_COLON_PSEUDO_HEADING")) {
      const renderedHeading = restored.match(/^(\s*)(?:[-*+]\s*)?(.+?)[：:]\s*$/u);
      if (renderedHeading) return `${renderedHeading[1]}## ${renderedHeading[2]!.trim()}`;
    }
    return restored;
  }).join("");
  return normalizePresentationMarkdown(repaired);
}

function isOpaqueMarkdownLine(line: string): boolean {
  return /^(?: {4}|\t|\s*(?:[>|]|<[^>]*>|!\[[^\]\n]*\]\(|\[[^\]\n]+\]:\s*\S))/u.test(line);
}

function stripProtectedMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "")
    .split(/(\r?\n)/u).map(part => isOpaqueMarkdownLine(part) ? "" : part).join("")
    .replace(/\\\[[\s\S]*?\\\]|\\\([^\r\n]*?\\\)/gu, "")
    .replace(/!?\[[^\]\r\n]*\]\([^\r\n]*?\)/gu, "")
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
    ]),
    ...(page.questionBank ?? []).flatMap(q => [q.prompt, ...(q.options ?? []), q.expectedAnswer, q.explanation].map((markdown, i) => ({ id: `${q.id}:${i}`, markdown })))
  ].flatMap((block) => validateMarkdownMath(block.markdown).map((issue) => `${block.id}:${issue}`));
  const sectionIssues = validateLessonStructure(page);
  const placeholderIssues = [
    ...page.blocks.filter((block) => hasPlaceholderContent(block.markdown)).map((block) => `${block.id}:PLACEHOLDER_CONTENT`),
    ...(page.lessonSections ?? []).flatMap((section) => [
      ...(section.markdown && hasPlaceholderContent(section.markdown) ? [`${section.id}:PLACEHOLDER_CONTENT`] : []),
      ...(section.items ?? []).filter((item) => hasPlaceholderContent(item.text)).map((item) => `${item.id}:PLACEHOLDER_CONTENT`)
    ])
  ];
  const questionIssues = page.questionBank && page.questionBank.filter((item) => item.status === "approved").length < 4 ? ["QUESTION_BANK_MINIMUM_NOT_MET"] : [];
  const narrativeIssues = page.teachingCompositionVersion === 1 ? evaluateTeachingPage(page).issues : [];
  return [...narrativeIssues, ...page.quality.issues, ...mathIssues, ...markdownMathIssues, ...pseudoIssues, ...coverage.missing.map((item) => `${item.requirementId}:MISSING:${item.fields.join(",")}`), ...sectionIssues, ...placeholderIssues, ...questionIssues];
}

export function hasPlaceholderContent(markdown: string): boolean {
  return markdown.split(/\r?\n/u).some((line) => /^(?:\s*(?:#{1,6}\s*|[-*+]\s*|\d+[.)]\s*)?)?[（(\[]?(?:待生成|待补充|待核验|待确认)[）)\]]?\s*$/u.test(line));
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
