/** Shared composition contract: generation, compilation and persisted-page checks use the same rules. */
export const teachingCompositionContract = {
  version: 1,
  chapterBridgeMarkdown: "用日常中文写前页关联与本页问题；独立问题分行列出，不能提前裸用未定义英文",
  priorKnowledge: "一个元素只定义一个必要概念，首次配中文与有依据的英文，三至五句连续解释是什么、用途、机制、条件和区别；定义内部不拆子列表",
  learningObjectives: "每项只承诺正文真正教会的一种判断、计算或操作，不提前堆放陌生术语",
  fullExplanationMarkdown: "先按对象与依赖建立段落，再成文；独立步骤用有序列表，比较项和表格列说明用列表；同一因果过程保持连续；公式、代码、表格保留原对象且逐项解释",
  mainContentMarkdown: "讲解后的两至五条要点，不加标题、不引入新术语，每条继承成立条件",
  misconceptions: "一个元素一处误解，错误理解、错因、正确判断、核对方法各占一个段落；四个标签统一加粗，解释因果，不能只贴标签",
  questions: "题干、每个选项、标准答案和解析均使用中文与合法数学，不为复述原文重新插入英文；理解题标准答案的独立并列内容分行列项，不挤成分号串；解析按依据、运算步骤、结果与误选原因分段或列项，每个错误选项的理由单独列项，不能用分号串成一段；选择题标准答案必须逐字等于一个选项",
  preservation: "换行、列表层级、公式和代码在生成、保存、读取和渲染中保持一致；不通过删掉问题段落或截断总结来通过验证"
} as const;

/** Normalize explicit role labels without rewriting the explanation itself. */
export function formatMisconception(value: string): string {
  const parts = value.trim().split(/\n\s*\n|[；;]\s*(?=\*{0,2}(?:错因|正确判断|核对方法)[：:])/u);
  const roles = ["错误理解", "错因", "正确判断", "核对方法"] as const;
  if (parts.length !== roles.length) return value;
  const bodies = parts.map((part, index) => {
    const unwrapped = part.trim().replace(/^\*{0,2}((?:错误理解|错因|正确判断|核对方法)[：:])\*{0,2}/u, "$1");
    const prefix = index === 0 ? /^(?:错误理解[：:]|误以为\s*)/u
      : index === 1 ? /^(?:错因[：:]|错因是\s*)/u
        : new RegExp(`^${roles[index]}[：:]`, "u");
    const match = unwrapped.match(prefix);
    if (!match) return undefined;
    return (index === 0 && match[0].startsWith("误以为") ? unwrapped : unwrapped.slice(match[0].length)).trimStart();
  });
  if (bodies.some(body => !body)) return value;
  return bodies.map((body, index) => `**${roles[index]}：** ${body}`).join("\n\n");
}

/** Split a long generated sentence only at real Chinese sentence boundaries. */
export function normalizePackedTeachingProse(markdown: string): string {
  let inFence = false;
  return markdown.split(/\r?\n/u).flatMap((line) => {
    if (/^\s*(?:```|~~~)/u.test(line)) { inFence = !inFence; return [line]; }
    if (inFence || /^\s*(?:[|>#]|[-*+]\s|\d+[.)]\s|\$\$)/u.test(line)
      || (line.match(/\p{Script=Han}/gu)?.length ?? 0) <= 160) return [line];
    const parts = line.split(/(?<=[。！？；])/u).map(part => part.trim()).filter(Boolean);
    if (parts.length < 2) return [line];
    const paragraphs: string[] = [];
    let current = "";
    for (const part of parts) {
      const next = current ? `${current}${part}` : part;
      if (current && (next.match(/\p{Script=Han}/gu)?.length ?? 0) > 125) {
        paragraphs.push(current);
        current = part;
      } else current = next;
    }
    if (current) paragraphs.push(current);
    return paragraphs.map(paragraph => paragraph.endsWith("；") ? paragraph.slice(0, -1) : paragraph)
      .flatMap((paragraph, index) => index === 0 ? [paragraph] : ["", paragraph]);
  }).join("\n");
}

/** Title-case ordinary English term names without rewriting official mixed-case names or source quotes. */
export function normalizeEnglishTermCase(markdown: string): string {
  const minor = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "vs", "with"]);
  const protectedParts = /(```[\s\S]*?```|~~~[\s\S]*?~~~|^(?: {4}|\t|\s*[>|]|\s*<[^>]*>)[^\r\n]*$|!?\[[^\]\r\n]*\]\([^\r\n]*?\)|`[^`\r\n]+`|“[^”\r\n]*”|\$\$[\s\S]*?\$\$|(?<!\$)\$[^$\r\n]+\$(?!\$)|https?:\/\/\S+)/gmu;
  return markdown.split(protectedParts).map((part, index) => index % 2 === 1 ? part : part.replace(
    /([\p{Script=Han}]{2,25})（([A-Za-z][A-Za-z ]{2,80})）/gu,
    (_match, chinese: string, english: string) => `${chinese}（${english.split(/(\s+)/u).map((word, position) => {
      if (!/^[a-z]+$/u.test(word) || (position > 0 && minor.has(word))) return word;
      return word[0]!.toUpperCase() + word.slice(1);
    }).join("")}）`)).join("");
}

const protectedMarkdownPattern = /```[\s\S]*?```|~~~[\s\S]*?~~~|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|(?<!\$)\$[^$\r\n]+\$(?!\$)|`[^`\r\n]+`|!?\[[^\]\r\n]*\]\([^\r\n]*?\)|https?:\/\/[^\s。、，；！？、]+|“[^”\r\n]*”|「[^」\r\n]*」/gu;

/** Apply a deterministic transform only to prose outside opaque Markdown objects. */
function mapPresentationProse(markdown: string, transform: (value: string) => string): string {
  const protectedValues: string[] = [];
  const masked = markdown.replace(protectedMarkdownPattern, (value) => {
    const index = protectedValues.push(value) - 1;
    return `\uE000${index}\uE001`;
  });
  const transformed = transform(masked);
  return transformed.replace(/\uE000(\d+)\uE001/gu, (_match, index: string) => protectedValues[Number(index)]!);
}

function isOpaquePresentationLine(line: string): boolean {
  if (/^\s*(?:[-*+]|\d+[.)])\s+/u.test(line)) return false;
  return /^(?: {4}|\t|\s*(?:[>|]|\||<[^>]*>))/u.test(line);
}

function englishTermCase(value: string): string {
  const minor = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "vs", "with"]);
  return value.split(/(\s+)/u).map((word, position) => {
    if (!/^[a-z]+$/u.test(word) || (position > 0 && minor.has(word))) return word;
    return word[0]!.toUpperCase() + word.slice(1);
  }).join("");
}

/** Remove Chinese full stops from authored prose without touching opaque objects. */
export function normalizeChineseProsePunctuation(markdown: string): string {
  return mapPresentationProse(markdown, (value) => value.split(/(\r?\n)/u).map((part) => {
    if (/^\r?\n$/u.test(part) || isOpaquePresentationLine(part) || !/\p{Script=Han}/u.test(part)) return part;
    return part.replace(/。(?=\s*$)/gu, "").replace(/。/gu, "；").replace(/；(?=\s*$)/gu, "");
  }).join(""));
}

function isBilingualTermPrefix(value: string): boolean {
  return /[\p{Script=Han}]{2,25}（[A-Za-z][A-Za-z -]{1,80}）\s*[：:]$/u.test(value.trim());
}

function isMisconceptionRolePrefix(value: string): boolean {
  return /(?:错误理解|错因|正确判断|核对方法)\s*[：:]$/u.test(value.trim());
}

function colonIntroducesIndependentContent(prefix: string, content: string): boolean {
  const trimmedPrefix = prefix.trim();
  const trimmedContent = content.trim();
  if (!trimmedContent || isBilingualTermPrefix(prefix) || isMisconceptionRolePrefix(prefix)) return false;
  if (/^(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s|\$\$|\\\[|```|~~~)/u.test(trimmedContent)) return true;
  if (!/^[\p{Script=Han}A-Za-z0-9` _-]{1,24}[：:]$/u.test(trimmedPrefix)) return false;
  if (/[。！？；;，,]/u.test(trimmedPrefix) || trimmedContent.length > 120) return false;
  return /^(?:操作|步骤|流程|注意事项|处理步骤|执行顺序|检查方法)$/u.test(trimmedPrefix)
    || /^(?:执行|读取|检查|计算|先|再|第一|第二|将|把|不要|不能|需要)/u.test(trimmedContent);
}

/** Put content introduced by a structural colon on its own Markdown line. */
export function normalizeColonIntroducedLineBreaks(markdown: string): string {
  return mapPresentationProse(markdown, (value) => value.split(/\r?\n/u).map((line) => {
    if (isOpaquePresentationLine(line)) return line;
    const match = line.match(/^(.*?[：:])\s*(\S[\s\S]*)$/u);
    if (!match || !colonIntroducesIndependentContent(match[1]!, match[2]!)) return line;
    const prefix = match[1]!.replace(/\s+$/u, "");
    const content = match[2]!.trimStart();
    const listPrefix = /^([ \t]*)(?:[-*+]|\d+[.)])\s+/u.exec(prefix);
    const continuationIndent = listPrefix ? `${listPrefix[1]}  ` : "";
    return `${prefix}\n${continuationIndent}${content}`;
  }).join("\n"));
}

/** Normalize list indentation to two spaces per nested Markdown level. */
export function normalizeListIndentation(markdown: string): string {
  return mapPresentationProse(markdown, (value) => value.split(/\r?\n/u).map((line, lineIndex, lines) => {
    const previous = lineIndex > 0 ? lines[lineIndex - 1]! : "";
    if (isOpaquePresentationLine(line)
      || (/^ {4,}(?:[-*+]|\d+[.)])\s+/u.test(line) && !/^\s*(?:[-*+]|\d+[.)])\s+/u.test(previous))) return line;
    const match = line.match(/^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/u);
    if (!match) return line;
    const columns = [...match[1]!].reduce((total, character) => total + (character === "\t" ? 4 : 1), 0);
    const level = columns === 0 ? 0 : Math.max(1, Math.ceil(columns / 4));
    return `${"  ".repeat(level)}${match[2]} ${match[3]}`;
  }).join("\n"));
}

/** Keep headings within the supported three-level Markdown hierarchy. */
export function normalizeThreeLevelHeadings(markdown: string): string {
  return mapPresentationProse(markdown, (value) => value.split(/\r?\n/u).map((line) => {
    if (isOpaquePresentationLine(line)) return line;
    const match = line.match(/^(\s*)(#{1,6})(\s+.*)$/u);
    if (!match) return line;
    return `${match[1]}${"#".repeat(Math.min(3, match[2]!.length))}${match[3]}`;
  }).join("\n"));
}

/** Convert ordinary Chinese-term parentheses to the documented bilingual shape. */
export function normalizeBilingualTermShape(markdown: string): string {
  const shaped = mapPresentationProse(markdown, (value) => value.replace(
    /([\p{Script=Han}]{2,25})\s*\(([A-Za-z][A-Za-z -]{1,80})\)/gu,
    (_match, chinese: string, english: string) => `${chinese}（${englishTermCase(english)}）`
  ));
  return normalizeEnglishTermCase(shaped);
}

export const displayFormulaMarker = "<!-- course-os:display-formula -->";

export interface PresentationRenderMetadata {
  centeredParagraphs?: ReadonlyArray<number> | ReadonlySet<number> | Readonly<Record<string, boolean>>;
}

function metadataContainsParagraph(metadata: PresentationRenderMetadata | undefined, index: number): boolean {
  const values = metadata?.centeredParagraphs;
  if (!values) return false;
  if (values instanceof Set) return values.has(index);
  if (Array.isArray(values)) return values.includes(index);
  return (values as Readonly<Record<string, boolean>>)[String(index)] === true;
}

function isPureDisplayFormulaParagraph(value: string): boolean {
  const withoutMarker = value.replace(new RegExp(`^\\s*${displayFormulaMarker}\\s*`, "u"), "").trim();
  return /^\$\$[\s\S]+\$\$$/u.test(withoutMarker)
    || /^\\\[[\s\S]+\\\]$/u.test(withoutMarker)
    || /^\\begin\{(?:equation|displaymath)\}[\s\S]+\\end\{(?:equation|displaymath)\}$/u.test(withoutMarker);
}

/** Add the supported center marker only when renderer metadata authorizes it. */
export function normalizeDisplayFormulaParagraphs(markdown: string, metadata?: PresentationRenderMetadata): string {
  return markdown.split(/\n\s*\n/u).map((paragraph, index) => {
    const hasMarker = paragraph.includes(displayFormulaMarker);
    const pureFormula = isPureDisplayFormulaParagraph(paragraph);
    if (!pureFormula && hasMarker) return paragraph.replace(new RegExp(`\\s*${displayFormulaMarker}\\s*`, "gu"), "").trim();
    if (pureFormula && !hasMarker && metadataContainsParagraph(metadata, index)) return `${displayFormulaMarker}\n${paragraph.trim()}`;
    return paragraph;
  }).join("\n\n");
}

/** Reject renderer centering metadata or markers applied to prose containing formulas. */
export function validateDisplayFormulaAlignment(markdown: string, metadata?: PresentationRenderMetadata): string[] {
  const issues: string[] = [];
  markdown.split(/\n\s*\n/u).forEach((paragraph, index) => {
    const marked = paragraph.includes(displayFormulaMarker) || metadataContainsParagraph(metadata, index);
    if (marked && !isPureDisplayFormulaParagraph(paragraph)) issues.push("TEACHING_PRESENTATION:DISPLAY_FORMULA_PROSE_CENTERED");
  });
  return [...new Set(issues)];
}

/** Apply the bounded presentation repairs in a stable order. */
export function normalizePresentationMarkdown(markdown: string, metadata?: PresentationRenderMetadata): string {
  let result = normalizeChineseProsePunctuation(markdown);
  result = normalizeColonIntroducedLineBreaks(result);
  result = normalizeListIndentation(result);
  result = normalizeThreeLevelHeadings(result);
  result = normalizeBilingualTermShape(result);
  return normalizeDisplayFormulaParagraphs(result, metadata);
}

export function validatePresentationFormatting(markdown: string, metadata?: PresentationRenderMetadata): string[] {
  const issues = new Set<string>();
  const masked = markdown.replace(protectedMarkdownPattern, (value) => value.replace(/[^\r\n]/gu, " "));
  let previousHeadingLevel: number | undefined;
  for (const line of masked.split(/\r?\n/u)) {
    if (isOpaquePresentationLine(line)) continue;
    if (/\p{Script=Han}/u.test(line) && /。/u.test(line)) issues.add("TEACHING_PRESENTATION:CHINESE_FULL_STOP");
    if (/；\s*$/u.test(line)) issues.add("TEACHING_PRESENTATION:LINE_END_SEMICOLON");
    const colon = line.match(/^(.*?[：:])\s+(\S[\s\S]*)$/u);
    if (colon && (colonIntroducesIndependentContent(colon[1]!, colon[2]!)
      || /^(?:[-*+]\s+|\d+[.)]\s+|\$\$|\\\[)/u.test(colon[2]!))) {
      issues.add("TEACHING_PRESENTATION:COLON_CONTENT_NOT_BROKEN");
    }
    const list = line.match(/^([ \t]*)(?:[-*+]|\d+[.)])\s+/u);
    if (list) {
      const columns = [...list[1]!].reduce((total, character) => total + (character === "\t" ? 4 : 1), 0);
      if (columns % 2 !== 0) issues.add("TEACHING_PRESENTATION:LIST_INDENT_NON_CANONICAL");
    }
    const heading = line.match(/^[ \t]*(#{1,6})\s+/u);
    if (heading) {
      const headingLevel = heading[1]!.length;
      if (headingLevel > 3) issues.add("TEACHING_PRESENTATION:HEADING_LEVEL_OVERFLOW");
      if (previousHeadingLevel !== undefined && headingLevel > previousHeadingLevel + 1) {
        issues.add("TEACHING_PRESENTATION:HEADING_LEVEL_JUMP");
      }
      previousHeadingLevel = headingLevel;
    }
    if (/\p{Script=Han}{2,25}\s*\([A-Za-z][A-Za-z -]{1,80}\)/u.test(line)) issues.add("TEACHING_PRESENTATION:BILINGUAL_TERM_SHAPE");
    if (/\p{Script=Han}{2,25}（[^）]*[,，;；]|[^）]*\b(?:also known as|aka|简称)\b[^）]*）/iu.test(line)) issues.add("TEACHING_PRESENTATION:BILINGUAL_TERM_SHAPE");
  }
  for (const issue of validateDisplayFormulaAlignment(markdown, metadata)) issues.add(issue);
  return [...issues];
}

function validatePresentationMarkdown(markdown: string, metadata?: PresentationRenderMetadata): string[] {
  return validatePresentationFormatting(markdown, metadata);
}

export interface PresentationInput {
  chapterBridgeMarkdown?: string;
  learningObjectives: string[];
  priorKnowledge: string[];
  fullExplanationMarkdown: string;
  mainContentMarkdown: string;
  misconceptions: string[];
  questions: Array<{ prompt: string; options?: string[]; expectedAnswer?: string; explanation: string }>;
}

/** Mechanical findings only; semantic list membership and factual sufficiency require the source audit. */
export function validateTeachingPresentation(input: PresentationInput): string[] {
  const fields: Record<string, string[]> = {
    chapterBridgeMarkdown: [input.chapterBridgeMarkdown || ""],
    learningObjectives: input.learningObjectives,
    priorKnowledge: input.priorKnowledge,
    fullExplanationMarkdown: [input.fullExplanationMarkdown],
    mainContentMarkdown: [input.mainContentMarkdown],
    misconceptions: input.misconceptions,
    questions: input.questions.flatMap(q => [q.prompt, ...(q.options || []), q.expectedAnswer || "", q.explanation])
  };
  const issues = new Set<string>();
  for (const [field, texts] of Object.entries(fields)) {
    for (const text of texts) {
      for (const issue of validatePresentationMarkdown(text)) issues.add(`${issue}:${field}`);
      const prose = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|\$\$[\s\S]*?\$\$|\$[^$\n]+\$|`[^`\n]+`|https?:\/\/\S+|“[^”\n]*”/g, "");
      for (const line of prose.split(/\r?\n/u)) {
        // Tables and quoted source are objects, not prose paragraphs.
        if (/^\s*(?:[|>]|#{1,6}\s)/u.test(line)) continue;
        const oneDefinition = field === "priorKnowledge" && /^\s*(?:[-*+]\s+)?[^：\n]{2,100}：/u.test(line)
          && (line.split(/[；;]/u).length >= 3 && line.split(/[；;]/u).length <= 5);
        if (!oneDefinition && (line.match(/\p{Script=Han}/gu)?.length || 0) > 180) {
          issues.add(`TEACHING_PRESENTATION:${field}:PROSE_PACKED`);
        }
        if (/(?:两个|三个|四个|两项|三项|四项)(?:问题|步骤|目标|原因|条件)[：:][^\n]*[；;]/u.test(line)) issues.add(`TEACHING_PRESENTATION:${field}:PARALLEL_ITEMS_PACKED`);
        // Ordinary academic names use title case. Keep official mixed-case names,
        // code, formulas, and quoted source labels untouched.
        const names = [...line.matchAll(/[\p{Script=Han}]{2,25}（([A-Za-z][A-Za-z ]{2,80})）/gu)];
        const minorWords = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "vs", "with"]);
        if (names.some(match => match[1]!.split(/\s+/u).some((word, index) => /^[a-z]+$/u.test(word)
          && (index === 0 || !minorWords.has(word))))) issues.add(`TEACHING_PRESENTATION:${field}:ENGLISH_NAME_CASE`);
      }
      if (field === "fullExplanationMarkdown") {
        if (text.split(/\r?\n/u).some(line => /^\s*\$[^$\n]*(?:=|\\(?:sum|frac|int|prod|left|right))[^$\n]*\$\s*$/u.test(line))) {
          issues.add(`TEACHING_PRESENTATION:${field}:STANDALONE_MATH_INLINE`);
        }
        if (text.split(/\r?\n/u).filter(line => /^\s*(?![-*+]\s)(?:\$[^$\n]+\$|[A-Za-zθΣαβγ])\s*的定义是/u.test(line)).length >= 3) {
          issues.add(`TEACHING_PRESENTATION:${field}:SYMBOL_DEFINITIONS_UNLISTED`);
        }
      }
    }
  }
  for (const value of input.misconceptions) {
    if (/^错误理解[：:]/u.test(value.trim()) && /[；;]\s*(?:错因|正确判断|核对方法)[：:]/u.test(value)) {
      issues.add("TEACHING_PRESENTATION:misconceptions:ROLES_PACKED");
    }
    const roleLabels = [...value.matchAll(/(?:^|\n\s*\n)((?:\*\*)?(错误理解|错因|正确判断|核对方法)[：:](?:\*\*)?)/gu)];
    if (roleLabels.length > 0 && roleLabels.some((match) => match[1] !== `**${match[2]}：**`)) {
      issues.add("TEACHING_PRESENTATION:misconceptions:LABEL_NOT_BOLD");
    }
  }
  return [...issues];
}
