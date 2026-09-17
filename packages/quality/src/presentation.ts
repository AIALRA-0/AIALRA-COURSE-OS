/** Shared composition contract: generation, compilation and persisted-page checks use the same rules. */
export const teachingCompositionContract = {
  version: 1,
  chapterBridgeMarkdown: "用日常中文写前页关联与本页问题；独立问题分行列出，不能提前裸用未定义英文",
  priorKnowledge: "一个元素只定义一个必要概念，首次配中文与有依据的英文，三至五句连续解释是什么、用途、机制、条件和区别；定义内部不拆子列表",
  learningObjectives: "每项只承诺正文真正教会的一种判断、计算或操作，不提前堆放陌生术语",
  fullExplanationMarkdown: "先按对象与依赖建立段落，再成文；独立步骤用有序列表，比较项和表格列说明用列表；同一因果过程保持连续；公式、代码、表格保留原对象且逐项解释",
  mainContentMarkdown: "讲解后的两至五条要点，不加标题、不引入新术语，每条继承成立条件",
  misconceptions: "一个元素一处误解，错误理解、错因、正确判断、核对方法各占一个段落；解释因果，不能只贴标签",
  questions: "题干、每个选项、标准答案和解析均使用中文与合法数学，不为复述原文重新插入英文；理解题标准答案的独立并列内容分行列项，不挤成分号串；解析按依据、运算步骤、结果与误选原因分段或列项，每个错误选项的理由单独列项，不能用分号串成一段；选择题标准答案必须逐字等于一个选项",
  preservation: "换行、列表层级、公式和代码在生成、保存、读取和渲染中保持一致；不通过删掉问题段落或截断总结来通过验证"
} as const;

/** Only explicit role labels are split; a definition or an arbitrary colon is never guessed into a list. */
export function formatMisconception(value: string): string {
  if (!/^错误理解[：:]/u.test(value.trim())) return value;
  const parts = value.trim().split(/[；;]\s*(?=(?:错因|正确判断|核对方法)[：:])/u);
  if (parts.length !== 4 || !parts.every((part, i) => part.startsWith(["错误理解", "错因", "正确判断", "核对方法"][i]!))) return value;
  return parts.join("\n\n");
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
      const prose = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|\$\$[\s\S]*?\$\$|\$[^$\n]+\$|`[^`\n]+`|https?:\/\/\S+|“[^”\n]*”/g, "");
      for (const line of prose.split(/\r?\n/u)) {
        // Tables and quoted source are objects, not prose paragraphs.
        if (/^\s*(?:[|>]|#{1,6}\s)/u.test(line)) continue;
        if ((line.match(/\p{Script=Han}/gu)?.length || 0) > 180) issues.add(`TEACHING_PRESENTATION:${field}:PROSE_PACKED`);
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
  }
  return [...issues];
}
