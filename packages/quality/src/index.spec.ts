import { describe, expect, it } from "vitest";
import { calculateCoverage, normalizeHumanReadableChineseMarkdown, normalizeLegacyMathDelimiters, removeMainExplanationDuplicateLines, validateHumanReadableChinese, validateLessonStructure, validateMarkdownMath, validatePseudoCodeLines, validateTeachingNarrative, validateTex } from "./index.js";

describe("strict math", () => {
  it("accepts valid fractions and rejects broken TeX", () => {
    expect(validateTex("\\frac{4}{2}=2").valid).toBe(true);
    expect(validateTex("\\frac{4{2}").valid).toBe(false);
  });

  it("checks every math fragment inside teaching Markdown", () => {
    expect(validateMarkdownMath("有效公式 $\\frac{4}{2}=2$")).toEqual([]);
    expect(validateMarkdownMath("损坏公式 $\\frac{4{2}$")).not.toEqual([]);
  });

  it("converts an unescaped TeX bracket only when its contents are clearly mathematical", () => {
    expect(normalizeLegacyMathDelimiters("[V=V_1\\cup V_2,\\qquad V_1\\cap V_2=\\varnothing]")).toBe("$$\nV=V_1\\cup V_2,\\qquad V_1\\cap V_2=\\varnothing\n$$");
    expect(normalizeLegacyMathDelimiters("普通文字 [第 1 页] 和链接 [文档](https://example.com)")).toBe("普通文字 [第 1 页] 和链接 [文档](https://example.com)");
  });

  it("normalizes every supported delimiter while protecting code and ordinary brackets", () => {
    expect(normalizeLegacyMathDelimiters("行内 \\(x^2\\) 和显示 \\[\\frac{a}{b}\\]"))
      .toBe("行内 $x^2$ 和显示 $$\\frac{a}{b}$$");
    expect(normalizeLegacyMathDelimiters("```ts\nconst value = [x$y];\n```\n`$not math$` [普通文字]"))
      .toBe("```ts\nconst value = [x$y];\n```\n`$not math$` [普通文字]");
    expect(validateMarkdownMath("矩阵 $$\\begin{bmatrix}1 & 0\\\\0 & 1\\end{bmatrix}$$")).toEqual([]);
  });

  it("reports an unclosed explicit delimiter instead of returning a misleading plain-text formula", () => {
    expect(validateMarkdownMath("损坏公式 \\[x^2")).toContain("MATH_UNCLOSED_DISPLAY_DELIMITER");
  });

  it("does not treat a currency amount as an unfinished inline formula", () => {
    expect(validateMarkdownMath("价格是 $5 美元")).toEqual([]);
    expect(normalizeLegacyMathDelimiters("价格是 $5 美元")).toBe("价格是 $5 美元");
  });

  it("wraps high-confidence bare TeX while preserving code, URLs and ordinary backslashes", () => {
    const formula = "\\sum_{i=1}^{k}\\sum_{j=1}^{k}c_{ij},\\quad i\\ne j";
    expect(normalizeLegacyMathDelimiters(formula)).toBe(`$$\n${formula}\n$$`);
    expect(normalizeLegacyMathDelimiters(`- ${formula}`)).toBe(`- $${formula}$`);
    expect(normalizeLegacyMathDelimiters(`连接目标是 ${formula}，值越小越好`)).toBe(`连接目标是 $${formula}$，值越小越好`);
    expect(normalizeLegacyMathDelimiters(`$$\n${formula}\n$$`)).toBe(`$$\n${formula}\n$$`);
    expect(normalizeLegacyMathDelimiters("```txt\n\\sum_{i=1}^{k}\n```\n`\\sum_{i=1}^{k}` https://example.com/\\sum C:\\Users\\demo"))
      .toBe("```txt\n\\sum_{i=1}^{k}\n```\n`\\sum_{i=1}^{k}` https://example.com/\\sum C:\\Users\\demo");
    expect(validateMarkdownMath(formula)).toEqual([]);
  });
});

describe("coverage", () => {
  it("requires every high-risk field", () => {
    const result = calculateCoverage(
      [{ id: "r1", atomId: "a1", requiredFields: ["preState", "postState"], risk: "high" }],
      [{ requirementId: "r1", explanationBlockId: "b1", coveredFields: ["preState"], status: "partial" }]
    );
    expect(result.highRiskCoverage).toBe(0.5);
    expect(result.publishable).toBe(false);
  });
});

describe("learner-facing teaching narrative", () => {
  const valid = {
    learningObjectives: ["能够解释对象之间的关系"],
    mainContentMarkdown: "- 先确认对象\n- 再解释关系\n- 最后检查结果",
    priorKnowledge: ["先知道对象的定义"],
    fullExplanationMarkdown: [
      "## 输入怎样变成结果\n页面给出了输入对象、处理规则和输出对象，三者按顺序出现\n规则读取输入并改变状态，状态变化决定最后得到的输出",
      "## 跟着算一次\n给定输入 2，执行加 3 的规则，先得到中间值 5，再检查结果是否满足目标",
      "## 哪些情况不能照用\n输入缺失时不能执行规则，结果看似合理也不能替代前提检查"
    ].join("\n\n"),
    misconceptions: ["不要跳过输入条件"],
    questions: [{ prompt: "对象是什么", explanation: "对象提供计算的起点" }]
  };

  it("accepts adaptive structure without learner-facing audit labels", () => {
    expect(validateTeachingNarrative(valid)).toEqual([]);
  });

  it("rejects audit noise and repeated paragraphs", () => {
    const bad = { ...valid, fullExplanationMarkdown: "来源状态\n\n重复的说明内容需要被删除，因为它没有增加新的理解。\n\n重复的说明内容需要被删除，因为它没有增加新的理解。" };
    expect(validateTeachingNarrative(bad)).toEqual(expect.arrayContaining([
      "TEACHING_METADATA_NOISE:来源状态",
      "TEACHING_REPEATED_PARAGRAPH",
      "WRITING_CHINESE_FULL_STOP_FORBIDDEN"
    ]));
  });

  it("rejects the old fixed six-heading template", () => {
    const templated = { ...valid, fullExplanationMarkdown: "## 先说这页要解决什么\n目标\n\n## 先读原对象\n对象" };
    expect(validateTeachingNarrative(templated)).toEqual(expect.arrayContaining([
      "TEACHING_FIXED_TEMPLATE_HEADING:先说这页要解决什么",
      "TEACHING_FIXED_TEMPLATE_HEADING:先读原对象"
    ]));
  });

  it("rejects an agenda that expands beyond its teaching-density budget", () => {
    const oversized = { ...valid, pageKind: "agenda" as const, fullExplanationMarkdown: "议程只需要说明主题层级与学习顺序\n".repeat(150) };
    expect(validateTeachingNarrative(oversized)).toContain("TEACHING_EXPLANATION_TOO_LONG");
  });

  it("removes only exact lines duplicated from compact main content", () => {
    const repeated = "材料说明怎样建立平面规划问题，并给出后续章节的完整阅读入口";
    const unique = "这里解释对象之间的关系，并保留正文没有重复提供的内容\n读者将从材料主题进入后续章节，再逐步识别问题、输入和结果\n这些说明没有照抄核心内容，也没有引入页面未提供的结论\n完整讲解保留理解顺序，让删除重复行以后仍满足最低内容量";
    const explanation = `## 这份材料讲什么\n${repeated}\n${unique}`;
    expect(removeMainExplanationDuplicateLines(`- ${repeated}`, explanation)).toBe(`## 这份材料讲什么\n${unique}`);
  });

  it("normalizes only authored Chinese punctuation and protects source objects", () => {
    const source = "正文第一句。正文第二句；\n> 原文句号。\n`原样。` 和 $x_{。}=1$\n```text\n日志。\n```";
    expect(normalizeHumanReadableChineseMarkdown(source)).toBe("正文第一句；正文第二句\n> 原文句号。\n`原样。` 和 $x_{。}=1$\n```text\n日志。\n```");
    expect(validateHumanReadableChinese(normalizeHumanReadableChineseMarkdown(source))).toEqual([]);
  });

  it("turns a standalone colon label into a real Markdown heading", () => {
    expect(normalizeHumanReadableChineseMarkdown("操作：\n执行检查")).toBe("## 操作\n执行检查");
    expect(normalizeHumanReadableChineseMarkdown("- 注意事项：\n不要跳过条件")).toBe("## 注意事项\n不要跳过条件");
    expect(normalizeHumanReadableChineseMarkdown("`PPO` 训练：\n读取一批经验")).toBe("## `PPO` 训练\n读取一批经验");
  });

  it("rejects colon pseudo-headings and line-ending semicolons", () => {
    expect(validateHumanReadableChinese("操作：\n执行检查；")).toEqual(expect.arrayContaining([
      "WRITING_COLON_PSEUDO_HEADING",
      "WRITING_LINE_END_SEMICOLON_FORBIDDEN"
    ]));
  });
});

describe("pseudocode", () => {
  it("fails a line without before and after state", () => {
    expect(validatePseudoCodeLines([{
      kind: "pseudocode_line",
      id: "line-1",
      lineNumber: 1,
      code: "x = 1",
      semantic: "赋值",
      reads: [],
      writes: ["x"],
      preState: "",
      postState: "x 等于 1",
      sideEffects: [],
      complexityRelation: "常数时间"
    }])).toContain("line-1:preState_MISSING");
  });
});

describe("lesson structure punctuation", () => {
  it("does not treat factorial notation as multiple sentences", () => {
    const page = {
      lessonSections: [
        { kind: "learning_objectives" },
        { kind: "main_content" },
        { kind: "prior_knowledge", items: [{ id: "prior", text: "理解阶乘的定义" }] },
        { kind: "full_explanation", markdown: "完整讲解" },
        { kind: "misconceptions", items: [{ id: "misconception", text: "不要把 16! 读成 16×15" }] }
      ]
    };
    expect(validateLessonStructure(page as never)).toEqual([]);
  });
});
