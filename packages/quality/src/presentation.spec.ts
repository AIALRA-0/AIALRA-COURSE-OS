import { describe, expect, it } from "vitest";
import {
  displayFormulaMarker,
  formatMisconception,
  normalizeBilingualTermShape,
  normalizeChineseProsePunctuation,
  normalizeColonIntroducedLineBreaks,
  normalizeDisplayFormulaParagraphs,
  normalizeListIndentation,
  normalizePresentationMarkdown,
  normalizeThreeLevelHeadings,
  validateDisplayFormulaAlignment,
  validatePresentationFormatting,
  validateTeachingPresentation,
  type PresentationInput
} from "./presentation.js";
import { hasUnpairedEnglishPhrase, validateTeachingNarrative } from "./index.js";

const base: PresentationInput = {
  chapterBridgeMarkdown: "前页说明输入怎样表示\n\n本页说明输入怎样变成结果",
  learningObjectives: ["说明这一步如何改变输入"], priorKnowledge: [],
  mainContentMarkdown: "- 输入决定起点\n- 规则决定结果",
  fullExplanationMarkdown: "## 输入到结果\n\n1. 读取输入\n2. 执行规则\n3. 核对结果",
  misconceptions: [], questions: []
};

describe("composition regressions independent of a course or page number", () => {
  it.each(["Block 与 Macro 不同", "计算 graph embedding", "表格列名是 Method 和 Era", "使用 Encoder 得到表示"])("rejects untranslated names: %s", text => {
    expect(hasUnpairedEnglishPhrase(text)).toBe(true);
  });
  it.each(["编码器（Encoder）把输入变成表示", "矩阵元素 $a_{ij}$", "运行 `encode(input)`", "原表标签“Method”表示方法", "原句“1000 macros on a 1000 grid”表示将宏单元放到网格位置"])("protects paired terms, math and source objects: %s", text => {
    expect(hasUnpairedEnglishPhrase(text)).toBe(false);
  });
  it("separates independent questions while preserving a single definition", () => {
    expect(validateTeachingPresentation({ ...base, chapterBridgeMarkdown: "本页回答两个问题：输入是什么；输出怎样产生" }))
      .toContain("TEACHING_PRESENTATION:chapterBridgeMarkdown:PARALLEL_ITEMS_PACKED");
    expect(validateTeachingPresentation({ ...base, chapterBridgeMarkdown: "本页回答两个问题：\n\n- 输入是什么\n- 输出怎样产生" })).toEqual([]);
    const definition = "输入：处理前已知的信息；决定规则作用对象；按约束读取；开始计算前使用；不能把输出当输入";
    expect(formatMisconception(definition)).toBe(definition);
  });
  it("formats only explicit misconception roles, preserving facts and math", () => {
    const value = "错误理解：差值是 $0.35^2$；错因：混淆了差与平方；正确判断：先相减再平方；核对方法：分别计算两步";
    const formatted = formatMisconception(value);
    expect(formatted.split("\n\n")).toHaveLength(4);
    expect(formatted).toBe("**错误理解：** 差值是 $0.35^2$\n\n**错因：** 混淆了差与平方\n\n**正确判断：** 先相减再平方\n\n**核对方法：** 分别计算两步");
    expect(formatMisconception(formatted)).toBe(formatted);
    expect(validateTeachingPresentation({ ...base, misconceptions: [formatted] })).toEqual([]);
  });
  it("checks every choice option, not just the question prompt", () => {
    expect(validateTeachingNarrative({ ...base, strictWritingStyle: true,
      questions: [{ prompt: "选择正确公式", options: ["$\\frac{1{2}$"], expectedAnswer: "结果", explanation: "逐项核对" }]
    })).toContain("TEACHING_MATH_INVALID:questions");
  });
  it.each([
    ["already labelled", "错误理解：把单次高分当成总体优势\n\n错因：忽略随机性\n\n正确判断：比较平均\n\n核对方法：核对样本", "**错误理解：** 把单次高分当成总体优势\n\n**错因：** 忽略随机性\n\n**正确判断：** 比较平均\n\n**核对方法：** 核对样本"],
    ["unlabelled first and second roles", "误以为 Ours 全部最小\n\n错因是跳过反例\n\n正确判断：逐列比较\n\n核对方法：核对每列", "**错误理解：** 误以为 Ours 全部最小\n\n**错因：** 跳过反例\n\n**正确判断：** 逐列比较\n\n**核对方法：** 核对每列"],
    ["partially broken first label", "*错误理解：** 把图当装饰\n\n**错因：** 没看到计算\n\n**正确判断：** 先计算表示\n\n**核对方法：** 按流程图核对", "**错误理解：** 把图当装饰\n\n**错因：** 没看到计算\n\n**正确判断：** 先计算表示\n\n**核对方法：** 按流程图核对"],
    ["missing role is not guessed", "只看最大值\n\n因此出错", "只看最大值\n\n因此出错"]
  ])("normalizes misconception role labels without changing facts: %s", (_name, input, expected) => {
    expect(formatMisconception(input)).toBe(expected);
  });
  it("checks bilingual name case in prerequisites without changing official mixed-case names", () => {
    expect(validateTeachingPresentation({ ...base, priorKnowledge: ["期望值（expected value）：对可能结果按概率求平均"] }))
      .toContain("TEACHING_PRESENTATION:priorKnowledge:ENGLISH_NAME_CASE");
    expect(validateTeachingPresentation({ ...base, priorKnowledge: ["期望值（Expected value）：对可能结果按概率求平均"] }))
      .toContain("TEACHING_PRESENTATION:priorKnowledge:ENGLISH_NAME_CASE");
    expect(validateTeachingPresentation({ ...base, priorKnowledge: ["期望值（Expected Value）：对可能结果按概率求平均", "方法名称（eBay）：保留官方写法"] }))
      .toEqual([]);
  });
  it("keeps one complete five-clause term definition together instead of flagging its length", () => {
    const definition = "层次结构（Hierarchy）：把一个大系统按包含关系分成若干层，每一层由下一层的对象组成；这样同一层的对象可以单独设计、复用和替换，层与层之间的接口保持稳定；工作方式是先确定顶层整体，再逐层把整体拆成若干组成部分，并由上一层引用下一层的实例；它适用于对象之间存在明确由什么组成关系的场合，用来控制复杂度并支持并行设计与重复使用；它与并列分类不同，并列分类只按性质把对象分组，并不规定谁包含谁，本页用它把整块芯片到门级单元串成一条链";
    expect(definition.match(/\p{Script=Han}/gu)!.length).toBeGreaterThan(180);
    expect(validateTeachingPresentation({ ...base, priorKnowledge: [definition] })).not.toContain("TEACHING_PRESENTATION:priorKnowledge:PROSE_PACKED");
    expect(validateTeachingPresentation({ ...base, fullExplanationMarkdown: definition })).toContain("TEACHING_PRESENTATION:fullExplanationMarkdown:PROSE_PACKED");
  });
  it("separates displayed formulas and parallel symbol definitions", () => {
    const cramped = "## 目标函数\n\n$J(\\theta,G)=\\frac{1}{K}\\sum_{g\\in G}E_g$\n\n$J$ 的定义是目标\n\n$K$ 的定义是数量\n\n$G$ 的定义是集合";
    expect(validateTeachingPresentation({ ...base, fullExplanationMarkdown: cramped }))
      .toEqual(expect.arrayContaining(["TEACHING_PRESENTATION:fullExplanationMarkdown:STANDALONE_MATH_INLINE", "TEACHING_PRESENTATION:fullExplanationMarkdown:SYMBOL_DEFINITIONS_UNLISTED"]));
    const structured = "## 目标函数\n\n$$\nJ(\\theta,G)=\\frac{1}{K}\\sum_{g\\in G}E_g\n$$\n\n- $J$：目标\n- $K$：数量\n- $G$：集合";
    expect(validateTeachingPresentation({ ...base, fullExplanationMarkdown: structured })).toEqual([]);
  });

  it("repairs prose punctuation while preserving code, formulas, URLs and quoted source", () => {
    const source = "正文第一句。正文第二句。\n\n`原样。` 与 $x_{。}=1$ 以及 https://example.org/a。\n> 原文句号。";
    expect(normalizeChineseProsePunctuation(source)).toBe("正文第一句；正文第二句\n\n`原样。` 与 $x_{。}=1$ 以及 https://example.org/a\n> 原文句号。");
  });

  it("breaks only structural colon content and keeps term and misconception labels intact", () => {
    expect(normalizeColonIntroducedLineBreaks("操作：执行检查")).toBe("操作：\n执行检查");
    expect(normalizeColonIntroducedLineBreaks("步骤：- 读取输入")).toBe("步骤：\n- 读取输入");
    expect(normalizeColonIntroducedLineBreaks("概率（Probability）：随机变量按概率加权的平均结果")).toBe("概率（Probability）：随机变量按概率加权的平均结果");
    expect(normalizeColonIntroducedLineBreaks("**错因：** 把差值当成平方")).toBe("**错因：** 把差值当成平方");
  });

  it("normalizes nested list indentation without changing list text", () => {
    expect(normalizeListIndentation("- 一级\n    - 二级\n        - 三级\n  - 同级二级")).toBe("- 一级\n  - 二级\n    - 三级\n  - 同级二级");
    expect(normalizeListIndentation("```text\n    - 原样代码\n```\n| - 原样表格 |"))
      .toBe("```text\n    - 原样代码\n```\n| - 原样表格 |");
    expect(normalizeListIndentation("说明\n\n    - 缩进代码")).toBe("说明\n\n    - 缩进代码");
  });

  it("caps headings at three levels and preserves headings in code fences", () => {
    expect(normalizeThreeLevelHeadings("# 一级\n## 二级\n#### 过深\n```md\n#### 原样代码\n```")).toBe("# 一级\n## 二级\n### 过深\n```md\n#### 原样代码\n```");
    expect(validatePresentationFormatting("# 一级\n### 跳级")).toContain("TEACHING_PRESENTATION:HEADING_LEVEL_JUMP");
  });

  it("normalizes bilingual term shape and title case but preserves official names", () => {
    expect(normalizeBilingualTermShape("图神经网络 (graph neural network)、公司（eBay）和公式 $x(graph)$"))
      .toBe("图神经网络（Graph Neural Network）、公司（eBay）和公式 $x(graph)$");
  });

  it("centers only pure display formulas when metadata or the supported marker authorizes it", () => {
    const source = "$$\nx = 1\n$$\n\n这句话包含公式 $x$，但仍然是正文";
    const centered = normalizeDisplayFormulaParagraphs(source, { centeredParagraphs: [0] });
    expect(centered.startsWith(`${displayFormulaMarker}\n$$`)).toBe(true);
    expect(validateDisplayFormulaAlignment(centered)).toEqual([]);
    const invalid = `${displayFormulaMarker}\n这句话包含公式 $x$，但仍然是正文`;
    expect(validateDisplayFormulaAlignment(invalid)).toEqual(["TEACHING_PRESENTATION:DISPLAY_FORMULA_PROSE_CENTERED"]);
    expect(normalizeDisplayFormulaParagraphs(invalid)).toBe("这句话包含公式 $x$，但仍然是正文");
  });

  it("requires exact bold misconception role labels", () => {
    const malformed = "错误理解：把差值当成平方\n\n错因：混淆两步\n\n正确判断：先相减再平方\n\n核对方法：分别计算";
    expect(validateTeachingPresentation({ ...base, misconceptions: [malformed] }))
      .toContain("TEACHING_PRESENTATION:misconceptions:LABEL_NOT_BOLD");
    expect(validateTeachingPresentation({ ...base, misconceptions: [formatMisconception(malformed)] }))
      .not.toContain("TEACHING_PRESENTATION:misconceptions:LABEL_NOT_BOLD");
  });

  it("composes the safe presentation transforms without touching protected objects", () => {
    const source = "#### 操作：- 执行检查\n    - 子项\n\n术语 (technical term)。\n\n$$\nx=1\n$$";
    expect(normalizePresentationMarkdown(source, { centeredParagraphs: [2] })).toBe(
      "### 操作：\n- 执行检查\n  - 子项\n\n术语（Technical Term）\n\n${displayFormulaMarker}".replace("${displayFormulaMarker}", displayFormulaMarker) + "\n$$\nx=1\n$$"
    );
  });
});
