import { describe, expect, it } from "vitest";
import { calculateCoverage, hasPlaceholderContent, hasUnpairedEnglishPhrase, maximumTeachingExplanationCharacters, normalizeAdjacentTeachingHeadings, normalizeBareMathSymbols, normalizeHumanReadableChineseMarkdown, normalizeLegacyMathDelimiters, normalizePriorDefinitionAbbreviation, normalizePriorDefinitionClauseCount, normalizeSourceLabelCodeSpans, quoteContextualSourceLabels, quoteRepeatedSourceLabels, removeMainExplanationDuplicateLines, unpairedEnglishTeachingFields, validateHumanReadableChinese, validateLessonStructure, validateMarkdownMath, validatePseudoCodeLines, validateTeachingCountConsistency, validateTeachingNarrative, validateTex } from "./index.js";

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
    expect(normalizeLegacyMathDelimiters("令 W_e$v_i;v_j$ 表示边权，`W_e` 是代码，https://example.com/W_e 保持原样"))
      .toBe("令 $W_e$ $v_i;v_j$ 表示边权，`W_e` 是代码，https://example.com/W_e 保持原样");
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

describe("publication placeholders", () => {
  it("blocks standalone placeholders without rejecting a real explanation of source uncertainty", () => {
    expect(hasPlaceholderContent("## 来源\n待确认\n继续讲解")).toBe(true);
    expect(hasPlaceholderContent("- （待补充）")).toBe(true);
    expect(hasPlaceholderContent("原图有一项数值待确认，因此本页只比较确定的趋势")).toBe(false);
  });
});

describe("learner-facing teaching narrative", () => {
  it("detects conflicting object counts across explanation, summary, and questions", () => {
    expect(validateTeachingCountConsistency("图中有五种硬件。\n另有一段说图中列出四种硬件。"))
      .toContain("TEACHING_COUNT_CONTRADICTION:硬件");
    expect(validateTeachingCountConsistency("图中有五种硬件，另有四种算法。"))
      .toEqual([]);
    expect(validateTeachingCountConsistency("`四种硬件`是代码样例，图中有五种硬件。"))
      .toEqual([]);
    expect(validateTeachingCountConsistency("图中有五种硬件，四类训练条件，不同硬件上的柱高各异；四种不同硬件的说法错误"))
      .toEqual([]);
    expect(validateTeachingCountConsistency("图中有四组柱的比较，另一张图有两组柱的比较；训练条件并不相同"))
      .toEqual([]);
    expect(validateTeachingCountConsistency("策略有两个动作可以选择，本回合只执行一个动作"))
      .toEqual([]);
    expect(validateTeachingCountConsistency("每个块对应一个节点，边嵌入读取两个节点向量"))
      .toEqual([]);
    expect(validateTeachingCountConsistency("前四个模块属于一类模块，另有一种硬件"))
      .toEqual([]);
    expect(validateTeachingCountConsistency("图中有五种硬件，其中前四种硬件属于同一类；另一个训练阶段只使用一种硬件"))
      .toEqual([]);
    expect(validateTeachingCountConsistency("左图显示四种算法，右图显示两种算法"))
      .toEqual([]);
  });
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

  it("rejects a claimed loss of softmax normalization after changing one parameter", () => {
    const wrong = { ...valid, misconceptions: [
      "错误理解：未选动作不会改变；错因：两个动作共用分母；正确判断：改动一个参数也会影响两个动作；核对方法：把新参数代回 softmax，检查两个概率是否相加等于 $1$，如果只改一个参数，和就不是 $1$"
    ] };
    expect(validateTeachingNarrative(wrong)).toContain("TEACHING_SOFTMAX_NORMALIZATION_CONTRADICTION:misconceptions");
    const correct = { ...wrong, misconceptions: [wrong.misconceptions[0]!.replace("和就不是 $1$", "和仍等于 $1$")] };
    expect(validateTeachingNarrative(correct)).not.toContain("TEACHING_SOFTMAX_NORMALIZATION_CONTRADICTION:misconceptions");
  });

  it("does not mistake a positive learning rate for an unspecified reward weight", () => {
    const update = { ...valid, fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n` +
      "更新式 $\\theta \\leftarrow \\theta + \\alpha G \\nabla_{\\theta} \\log \\pi(a \\mid s)$，学习率 $\\alpha=0.1$，奖励为正，因此被选动作概率上升，另一动作概率下降" };
    expect(validateTeachingNarrative(update)).not.toContain("TEACHING_WEIGHTED_TREND_CONDITION_MISSING:fullExplanationMarkdown");
  });

  it("blocks a page whose answer conflicts with its own counted objects", () => {
    const inconsistent = { ...valid,
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n图中列出五种硬件供比较`,
      questions: [{ prompt: "图中列出四种硬件分别是什么", explanation: "先按图中标签核对" }]
    };
    expect(validateTeachingNarrative(inconsistent)).toContain("TEACHING_COUNT_CONTRADICTION:硬件");
    const answerOnly = { ...valid,
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n图中列出五种硬件供比较`,
      questions: [{ prompt: "图中全部硬件有哪些", explanation: "按横轴名称依次核对", expectedAnswer: "这里只列出四种硬件" }]
    };
    expect(validateTeachingNarrative(answerOnly)).toContain("TEACHING_COUNT_CONTRADICTION:硬件");
  });

  it("separates available actions from the action executed in one episode", () => {
    const correct = { ...valid, strictWritingStyle: true,
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n动作空间包含两个动作供选择，每个回合只执行其中一个动作` };
    expect(validateTeachingNarrative(correct)).not.toContain("TEACHING_ACTION_COUNT_CONFLATION:fullExplanationMarkdown");
    const wrong = { ...correct, learningObjectives: ["能指出哪些结论依赖只有一个状态、一个动作这一设定"] };
    expect(validateTeachingNarrative(wrong)).toContain("TEACHING_ACTION_COUNT_CONFLATION:learningObjectives");
  });

  it("rejects universal netlist claims that exceed cross-netlist evidence", () => {
    const wrong = { ...valid, strictWritingStyle: true,
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n这个编码器适用于任意网表` };
    expect(validateTeachingNarrative(wrong)).toContain("TEACHING_UNBOUNDED_GENERALIZATION:fullExplanationMarkdown");
    expect(validateTeachingNarrative({ ...wrong,
      fullExplanationMarkdown: wrong.fullExplanationMarkdown.replace("适用于任意网表", "在材料给出的不同网表上复用，不保证适用于任意网表") }))
      .not.toContain("TEACHING_UNBOUNDED_GENERALIZATION:fullExplanationMarkdown");
  });

  it("accepts adaptive structure without learner-facing audit labels", () => {
    expect(validateTeachingNarrative(valid)).toEqual([]);
  });

  it("rejects an empty heading transition and overexpanded agenda across page kinds", () => {
    const adjacent = { ...valid, fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n## 怎样使用\n\n## 两个步骤\n先检查输入，再执行转换` };
    expect(validateTeachingNarrative(adjacent)).toContain("TEACHING_ADJACENT_HEADINGS");
    expect(validateTeachingNarrative({ ...adjacent, fullExplanationMarkdown: adjacent.fullExplanationMarkdown.replace("## 怎样使用\n\n", "") })).not.toContain("TEACHING_ADJACENT_HEADINGS");
    expect(validateTeachingNarrative({ ...valid, strictWritingStyle: true,
      fullExplanationMarkdown: `读者刚翻到材料第 2 页，最想先知道后面会讲什么\n\n${valid.fullExplanationMarkdown}` }))
      .toContain("TEACHING_LAYOUT_COMMENTARY");
    expect(validateTeachingNarrative({ ...valid, pageKind: "agenda", fullExplanationMarkdown: "目录说明本页展示的阅读层级，先看基础，再看方法，最后看结果\n\n".repeat(40) })).toContain("TEACHING_EXPLANATION_TOO_LONG");
  });

  it("keeps source course codes and quoted slide labels while rejecting unexplained English", () => {
    expect(hasUnpairedEnglishPhrase("课程编号 EE 680，强化学习 RL 即强化学习，原页“Interconnections between partitions”对应连接目标")).toBe(false);
    expect(hasUnpairedEnglishPhrase('目录中 "Google RL Floorplanner" 是原图引用的一级条目名称')).toBe(false);
    expect(hasUnpairedEnglishPhrase("原图标题「Step 1: Compute clip」指向先计算比例")).toBe(false);
    expect(hasUnpairedEnglishPhrase("Step 1: Compute clip 应当直接照搬到讲解中")).toBe(true);
    expect(hasUnpairedEnglishPhrase('原页把“RL”列在标题中，尚未解释其含义')).toBe(false);
    expect(hasUnpairedEnglishPhrase("作者发表于 Bell System Technical Journal 的文章给出原始方法")).toBe(false);
    expect(hasUnpairedEnglishPhrase("上一页说 PDA 会处理输入，读者尚不知道这个缩写是什么")).toBe(true);
    expect(hasUnpairedEnglishPhrase("Graph Encoder 直接决定输出")).toBe(true);
    expect(hasUnpairedEnglishPhrase("原图给出 `ENTITY test is port a: in bit; end ENTITY test`，它是硬件描述语言的端口声明")).toBe(false);
    expect(hasUnpairedEnglishPhrase("参考文献发表于《Bell System Technical Journal》，本页没有给出该论文的实验数据")).toBe(false);
    expect(hasUnpairedEnglishPhrase("Kernighan-Lin 算法按交换顶点改善划分", ["Kernighan-Lin"])).toBe(false);
    expect(validateTeachingNarrative({ ...valid, sourceTitle: "Kernighan-Lin 算法规则", fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\nKernighan-Lin 算法（Kernighan-Lin Algorithm）：通过交换顶点改善划分，原图页脚引用《Bell System Technical Journal》作为出处`, strictWritingStyle: true })).not.toContain("TEACHING_UNPAIRED_ENGLISH");
  });

  it("quotes a previously cited source label consistently in questions and answers", () => {
    const source = "原图的“Google RL Floorplanner”列在目录第二部分";
    expect(quoteRepeatedSourceLabels("Google RL Floorplanner 属于哪一部分？", source))
      .toBe("“Google RL Floorplanner” 属于哪一部分？");
    expect(quoteRepeatedSourceLabels("“Google RL Floorplanner” 已列出", source))
      .toBe("“Google RL Floorplanner” 已列出");
    expect(quoteRepeatedSourceLabels("`Google RL Floorplanner` 与 $Google RL Floorplanner$", source))
      .toBe("`Google RL Floorplanner` 与 $Google RL Floorplanner$");
    expect(quoteRepeatedSourceLabels("Graph Encoder 仍需先定义", source))
      .toBe("Graph Encoder 仍需先定义");
  });

  it("quotes contextual English labels only when they occur in the source", () => {
    const source = "Setup\nOne episode with one action\nUpdate Rule\nFormula\nWhere\nIntuition\nWhat is W_e";
    expect(quoteContextualSourceLabels("左栏是 Setup 部分，回到页面 Update Rule 一行核对", source))
      .toBe("左栏是 “Setup” 部分，回到页面 “Update Rule” 一行核对");
    expect(quoteContextualSourceLabels("回到页面 Hidden Rule 一行核对", source))
      .toBe("回到页面 Hidden Rule 一行核对");
    expect(quoteContextualSourceLabels("代码 `Update Rule` 与原文“Setup”保持不变", source))
      .toBe("代码 `Update Rule` 与原文“Setup”保持不变");
    expect(quoteContextualSourceLabels("回到页面 What is $W_e$ 区域核对", source))
      .toBe("回到页面 “What is $W_e$” 区域核对");
    expect(quoteContextualSourceLabels("页面的 Formula 区块给出公式，Where 区块列出维度，Intuition 一句话解释用途", source))
      .toBe("页面的 “Formula” 区块给出公式，“Where” 区块列出维度，“Intuition” 一句话解释用途");
  });

  it("delimits narrow bare math symbols while protecting authored objects", () => {
    expect(normalizeBareMathSymbols("代入 e^0 = 1，并检查 x_1 与 ab_{2}"))
      .toBe("代入 $e^0$ = 1，并检查 $x_1$ 与 $ab_{2}$");
    expect(normalizeBareMathSymbols("保留 $e^0$、`x_1`、https://example.test/x_1 和原文“e^0”"))
      .toBe("保留 $e^0$、`x_1`、https://example.test/x_1 和原文“e^0”");
  });

  it("moves a definition abbreviation outside the official English name parentheses", () => {
    expect(normalizePriorDefinitionAbbreviation("马尔可夫决策过程（Markov Decision Process, MDP）：一种序贯决策框架"))
      .toBe("MDP 马尔可夫决策过程（Markov Decision Process）：一种序贯决策框架");
    expect(normalizePriorDefinitionAbbreviation("- 马尔可夫决策过程（Markov Decision Process, MDP）：一种序贯决策框架"))
      .toBe("- MDP 马尔可夫决策过程（Markov Decision Process）：一种序贯决策框架");
    expect(normalizePriorDefinitionAbbreviation("策略（Policy）：动作的概率分布"))
      .toBe("策略（Policy）：动作的概率分布");
  });

  it("preserves definition facts while merging excess policy clauses", () => {
    expect(normalizePriorDefinitionClauseCount("术语：它是什么；具体做什么；怎样工作；何时使用；如何区分；补充边界"))
      .toBe("术语：它是什么；具体做什么；怎样工作；何时使用；如何区分，补充边界");
    expect(normalizePriorDefinitionClauseCount("术语：它是什么；具体做什么；怎样工作；何时使用；如何区分"))
      .toBe("术语：它是什么；具体做什么；怎样工作；何时使用；如何区分");
  });

  it("restores source labels from code spans without changing commands or identifiers", () => {
    const source = "Agent\nMacro order: place larger ones first\npnpm run build";
    expect(normalizeSourceLabelCodeSpans("椭圆标记 `Agent`，方框写着 `Macro order: place larger ones first`", source))
      .toBe("椭圆标记 “Agent”，方框写着 “Macro order: place larger ones first”");
    expect(normalizeSourceLabelCodeSpans("运行 `pnpm run build`，读取 `edge_id`", source))
      .toBe("运行 `pnpm run build`，读取 `edge_id`");
  });

  it("allows a source model name only after the page actually explains it", () => {
    const developed = { ...valid, sourceTitle: "EDGE-GNN: WHY?", fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\nEdge-GNN 是处理边关系的图编码器，负责把连接信息变成可复用的表示`, strictWritingStyle: false };
    expect(validateTeachingNarrative(developed)).not.toContain("TEACHING_UNPAIRED_ENGLISH");
    expect(validateTeachingNarrative({ ...developed, strictWritingStyle: true })).not.toContain("TEACHING_UNPAIRED_ENGLISH");
    expect(validateTeachingNarrative({ ...developed, sourceTitle: "OTHER TOPIC", strictWritingStyle: true })).toContain("TEACHING_UNPAIRED_ENGLISH");
    expect(validateTeachingNarrative({ ...valid, sourceTitle: "EDGE-GNN: WHY?", fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n上一页把 EDGE-GNN 定位成处理边关系的图编码器`, strictWritingStyle: true })).not.toContain("TEACHING_UNPAIRED_ENGLISH");
  });

  it("rejects lowercase English glosses while accepting a verified formal English name", () => {
    expect(hasUnpairedEnglishPhrase("功耗（power）表示单位时间内消耗或转换的能量")).toBe(true);
    expect(hasUnpairedEnglishPhrase("功耗（Power Consumption）表示单位时间内消耗或转换的能量")).toBe(false);
    expect(validateTeachingNarrative({ ...valid, strictWritingStyle: true,
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n功耗（power）表示单位时间内消耗或转换的能量` }))
      .toContain("TEACHING_UNPAIRED_ENGLISH");
  });

  it("rejects source narration as the dominant explanation voice", () => {
    const commentary = [
      "页面给出输入对象和输出对象",
      "本页列出三个处理阶段",
      "原图显示输入进入第一步",
      "课件给出转换公式",
      "表中写着每种方法的名称",
      "原表列出方法的年代"
    ].join("\n\n");
    expect(validateTeachingNarrative({ ...valid, strictWritingStyle: true,
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n${commentary}` }))
      .toContain("TEACHING_SOURCE_COMMENTARY_OVERUSE");
    expect(validateTeachingNarrative({ ...valid, strictWritingStyle: true,
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n原图保留标签“Agent”，它表示负责选择动作的代理` }))
      .not.toContain("TEACHING_SOURCE_COMMENTARY_OVERUSE");
  });

  it("rejects absolute optimality claims that are stronger than the stated trade-off evidence", () => {
    expect(validateTeachingNarrative({ ...valid, strictWritingStyle: true,
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n## 多个目标怎样权衡\n功耗、时序与面积相互竞争，所以不存在唯一最优解` }))
      .toContain("TEACHING_LOGICAL_OVERCLAIM:fullExplanationMarkdown");
    expect(validateTeachingNarrative({ ...valid, strictWritingStyle: true,
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n## 多个目标怎样权衡\n功耗、时序与面积相互竞争，仅凭这些信息不能确定唯一最优解` }))
      .not.toContain("TEACHING_LOGICAL_OVERCLAIM:fullExplanationMarkdown");
  });

  it("rejects an audit-style object heading and a second copy of the previous-page bridge", () => {
    const bridge = "上一页解释了输入怎样进入处理规则\n\n本页继续计算规则怎样改变结果";
    expect(validateTeachingNarrative({ ...valid, strictWritingStyle: true, chapterBridgeMarkdown: bridge,
      fullExplanationMarkdown: `## 页面上的对象\n上一页给出了输入和处理规则，本页继续计算结果\n\n${valid.fullExplanationMarkdown}` }))
      .toEqual(expect.arrayContaining(["TEACHING_SOURCE_COMMENTARY_HEADING", "TEACHING_BRIDGE_REPEATED_IN_EXPLANATION"]));
    expect(validateTeachingNarrative({ ...valid, strictWritingStyle: true, chapterBridgeMarkdown: bridge,
      fullExplanationMarkdown: `## 输入怎样进入结果\n先读取当前输入，再执行转换规则\n\n${valid.fullExplanationMarkdown}` }))
      .not.toEqual(expect.arrayContaining(["TEACHING_SOURCE_COMMENTARY_HEADING", "TEACHING_BRIDGE_REPEATED_IN_EXPLANATION"]));
    expect(validateTeachingNarrative({ ...valid, strictWritingStyle: true, chapterBridgeMarkdown: bridge,
      fullExplanationMarkdown: `## 当前计算\n前页已经给出输入，本页计算结果\n\n${valid.fullExplanationMarkdown}` }))
      .toContain("TEACHING_BRIDGE_REPEATED_IN_EXPLANATION");
  });

  it("rejects a method lineage invented from a chronological comparison table", () => {
    const input = { ...valid, strictWritingStyle: true,
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n表格中每一行的限制恰好对应前一行暴露的短板，因此后一代方法依次解决了前一代方法的问题` };
    expect(validateTeachingNarrative(input)).toContain("TEACHING_METHOD_PROGRESSION_OVERCLAIM:fullExplanationMarkdown");
    expect(validateTeachingNarrative({ ...input,
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n表格只分别列出各方法的思路、限制和年代，没有给出逐代替代关系` }))
      .not.toContain("TEACHING_METHOD_PROGRESSION_OVERCLAIM:fullExplanationMarkdown");
  });

  it("rejects nested quotation marks inside a bilingual term label", () => {
    const prior = "强化学习智能体（Reinforcement Learning “Agent”）：在环境中选择动作的决策对象；它读取状态并输出动作；通过回报调整后续选择；用于连续决策任务；它与环境给出的回报不同";
    expect(validateTeachingNarrative({ ...valid, strictWritingStyle: true, priorKnowledge: [prior] }))
      .toContain("TEACHING_PRIOR_TERM_PAIR_MALFORMED");
  });

  it("rejects a learning objective that says another parameter stays unchanged after both are updated", () => {
    const input = { ...valid, strictWritingStyle: true,
      learningObjectives: ["能说明被选动作对应参数怎样更新，以及另一个参数为何保持不变"],
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n两个参数同时更新，第一个增加 0.1，第二个减少 0.1` };
    expect(validateTeachingNarrative(input)).toContain("TEACHING_OBJECTIVE_EXPLANATION_CONTRADICTION");
  });

  it("recognizes a source-backed correction without requiring fixed cue words", () => {
    const input = {
      ...valid,
      lessonFlowVersion: 2 as const,
      priorKnowledge: ["箭头：图中连接两个步骤的方向标记；它说明哪一步先发生；阅读时沿箭头检查输入怎样进入下一步；遇到流程图时用它判断先后；它与无方向的连线不同"],
      misconceptions: ["把右侧六步当成可以任意交换顺序：虚线说明它们都属于内部流程，原图的箭头表示先后，顺序改变会使后续步骤缺少输入"]
    };
    expect(validateTeachingNarrative(input)).not.toContain("TEACHING_MISCONCEPTION_REASON_MISSING");
    expect(validateTeachingNarrative({ ...input, misconceptions: ["把流程理解错了：页面没有说明"] })).toContain("TEACHING_MISCONCEPTION_REASON_MISSING");
  });

  it("accepts a stated source limit with a correction, but rejects several misconceptions packed into one item", () => {
    const boundary = "把目录中的标题当成已经解释过的概念；这一页只有名称和阅读顺序，没有定义与做法；正确判断是先将它当作后续章节的入口，核对办法是到对应章节找定义";
    const input = { ...valid, lessonFlowVersion: 2 as const, misconceptions: [boundary] };
    expect(validateTeachingNarrative(input)).not.toContain("TEACHING_MISCONCEPTION_REASON_MISSING");
    expect(validateTeachingNarrative({ ...input, misconceptions: ['把 "Results" 当成基础部分的子条目；错因是只看到条目靠后，没有核对缩进；正确判断是两者同级；检查办法是比较行首是否对齐'] }))
      .not.toContain("TEACHING_MISCONCEPTION_REASON_MISSING");
    expect(validateTeachingNarrative({ ...input, misconceptions: [`${boundary} - 以为右侧曲线与左侧柱状图来自同一实验；两张图的横轴不同，因此必须分别比较`] })).toContain("TEACHING_MISCONCEPTIONS_PACKED");
  });

  it("rejects a full definition repeated after prior knowledge and locates unpaired English fields", () => {
    const prior = "图编码器（Graph Encoder）：把图结构转换为数值表示的组件；它为后续网络提供可计算的输入；通过邻居间的信息传递更新每个位置的表示；在图结构需要进入网络时使用；它不同于直接输出决策的预测层";
    const input = { ...valid, strictWritingStyle: true, priorKnowledge: [prior], fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n图编码器（Graph Encoder）：把图结构转换为数值表示的组件；它为后续网络提供可计算的输入；通过邻居间的信息传递更新每个位置的表示；在图结构需要进入网络时使用；它不同于直接输出决策的预测层`, mainContentMarkdown: "- CPU 组柱更高\n- 两图不能直接合并判断" };
    expect(validateTeachingNarrative(input)).toContain("TEACHING_PRIOR_DEFINITION_REPEATED");
    expect(unpairedEnglishTeachingFields(input)).toContain("mainContentMarkdown");
    expect(unpairedEnglishTeachingFields(input)).not.toContain("priorKnowledge");
  });

  it("rejects two English names assigned to one Chinese term inside a definition", () => {
    const conflicting = "布线（Placement）：决定电路元件的位置；通过选择坐标安排它们；需要满足连线约束；这和决定导线走向的布线（Routing）不同";
    expect(validateTeachingNarrative({ ...valid, strictWritingStyle: true, priorKnowledge: [conflicting] }))
      .toContain("TEACHING_PRIOR_TRANSLATION_CONFLICT");
    const consistent = conflicting.replace("布线（Placement）", "布局（Placement）");
    expect(validateTeachingNarrative({ ...valid, strictWritingStyle: true, priorKnowledge: [consistent] }))
      .not.toContain("TEACHING_PRIOR_TRANSLATION_CONFLICT");
  });

  it("identifies malformed inline math in the specific teaching field", () => {
    expect(validateTeachingNarrative({ ...valid, strictWritingStyle: true, learningObjectives: ["求出 $\\epsilon=0.2 时的允许区间"] }))
      .toContain("TEACHING_MATH_INVALID:learningObjectives");
    expect(validateTeachingNarrative({ ...valid, strictWritingStyle: true, learningObjectives: ["求出 $\\epsilon=0.2$ 时的允许区间"] }))
      .not.toContain("TEACHING_MATH_INVALID:learningObjectives");
  });

  it("rejects explaining pagination as learning content on an agenda slide", () => {
    expect(validateTeachingNarrative({ ...valid, strictWritingStyle: true, pageKind: "agenda", fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n右下角 2/27 是页码` }))
      .toContain("TEACHING_LAYOUT_COMMENTARY");
    expect(validateTeachingNarrative({ ...valid, strictWritingStyle: true, pageKind: "agenda" }))
      .not.toContain("TEACHING_LAYOUT_COMMENTARY");
  });

  it("rejects irrelevant absence checklists while preserving a meaningful chart limitation", () => {
    expect(validateTeachingNarrative({ ...valid, strictWritingStyle: true,
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n图中没有横轴、纵轴、图例或表格` }))
      .toContain("TEACHING_IRRELEVANT_ABSENCE_CHECKLIST");
    expect(validateTeachingNarrative({ ...valid, strictWritingStyle: true,
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n图中没有横轴、纵轴和图例，因此无法读取数值刻度` }))
      .not.toContain("TEACHING_IRRELEVANT_ABSENCE_CHECKLIST");
  });

  it("turns only an empty adjacent heading into a lead sentence", () => {
    const source = "### 第一步：算比率\n\n## 比率等于新概率除以旧概率\n\n代入两项概率后得到 1.5\n\n### 第二步：比较贡献";
    expect(normalizeAdjacentTeachingHeadings(source)).toBe("### 第一步：算比率\n\n比率等于新概率除以旧概率\n\n代入两项概率后得到 1.5\n\n### 第二步：比较贡献");
  });

  it("accepts a verified long English term in one definition but rejects stacked definitions", () => {
    const prior = "近端策略优化（Proximal Policy Optimization, PPO）：通过比较新旧策略的概率限制每次更新幅度；先计算概率比，再在给定区间内裁剪；它用于更新策略时避免单步改动过大";
    expect(validateTeachingNarrative({ ...valid, lessonFlowVersion: 2, priorKnowledge: [prior] })).not.toContain("TEACHING_PRIOR_KNOWLEDGE_TOO_SHALLOW");
    expect(validateTeachingNarrative({ ...valid, lessonFlowVersion: 2, strictWritingStyle: true, priorKnowledge: [`${prior}：策略是动作概率分布`] })).toContain("TEACHING_PRIOR_MULTIPLE_DEFINITIONS");
  });

  it("accepts a concrete two-clause numerical boundary and a three-clause correction", () => {
    const input = {
      ...valid,
      lessonFlowVersion: 2 as const,
      priorKnowledge: ["平方：把一个数与自己相乘；用于比较误差大小；先计算差，再与自身相乘；只有题目要求平方误差时才使用"],
      misconceptions: ["把差值直接当成平方结果；结果还取决于是否执行平方，$-0.35$ 的平方是 $0.1225$，不能只看差的绝对值"]
    };
    expect(validateTeachingNarrative(input)).not.toContain("TEACHING_MISCONCEPTION_REASON_MISSING");
    expect(validateTeachingNarrative({ ...input, misconceptions: ["以为平方会改变差值；平方只改变用于比较的结果大小，不能跳过原始差值；最后应核对得到的结果是否满足目标条件"] })).not.toContain("TEACHING_MISCONCEPTION_REASON_MISSING");
  });

  it("accepts a detailed prior definition with one concise but meaningful clause", () => {
    const input = {
      ...valid,
      strictWritingStyle: true,
      priorKnowledge: ["割集大小：落在两个不同子集之间的所有连接边各自代价相加得到的总量；它随顶点归属的变化而变化；本页用它衡量划分的好坏；它与子集内部的边数没有直接关系"],
      questions: [{ prompt: "怎样判断割集大小", explanation: "先找到落在两个不同子集之间的边，逐条核对这些边的代价；再把代价相加得到割集大小；子集内部的边不计入这个结果" }]
    };
    expect(validateTeachingNarrative(input)).not.toContain("TEACHING_PRIOR_DEFINITION_INCOMPLETE");
  });

  it("rejects a dense mixed-language bridge, shallow definitions and a second summary heading", () => {
    const flawed = {
      ...valid,
      strictWritingStyle: true,
      chapterBridgeMarkdown: "上一页列出了可学习参数的五个部分，其中 Graph Encoder 由 Node embedding FC 和 Edge embedding FC 构成，但没有解释为什么要保留、训练它有什么作用、与后续网络怎样连接；本页回答它是什么、为什么先训练、怎么使用",
      mainContentMarkdown: "## 编码器与迁移学习\n\n- 保留已经学到的表示",
      priorKnowledge: ["网表：一种描述电路连接的结构化数据，本页的编码器接收它"]
    };
    expect(validateTeachingNarrative(flawed)).toEqual(expect.arrayContaining([
      "TEACHING_BRIDGE_NEEDS_BLOCKS",
      "TEACHING_BRIDGE_UNPAIRED_ENGLISH",
      "TEACHING_PRIOR_DEFINITION_INCOMPLETE",
      "TEACHING_SUMMARY_MUST_BE_BULLETS",
      "TEACHING_QUESTION_EXPLANATION_TOO_SHORT"
    ]));
  });

  it("accepts the same structure on a distinct calculation page when each item is explained", () => {
    const developed = {
      ...valid,
      strictWritingStyle: true,
      chapterBridgeMarkdown: "前页已经给出预测值和实际值；本页接着计算两者相差多少，并判断平方后的结果表示什么",
      priorKnowledge: ["平方：把一个数与自己相乘的运算；本页用它处理预测值与实际值之间的差；先计算差，再让差与自身相乘，得到一个非负结果；当题目要求平方误差时才执行这一步，不能把差的绝对值直接当成平方结果"],
      questions: [{ prompt: "预测误差怎样计算", explanation: "先用 1.15 减去 1.5，得到差值 -0.35；再将差值与自己相乘，得到 0.1225；平方误差是这个非负结果，不能停在差的绝对值 0.35" }]
    };
    expect(validateTeachingNarrative(developed)).toEqual([]);
  });

  it("requires a sign condition for a trend claimed from symbolic weights", () => {
    const weighted = { ...valid, strictWritingStyle: true,
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n回报式为 $r=-x-\\lambda y-\\gamma z$，三个量增大都会让回报下降`,
      mainContentMarkdown: "- 回报由三个量计算\n- 系数决定每项影响" };
    expect(validateTeachingNarrative(weighted)).toContain("TEACHING_WEIGHTED_TREND_CONDITION_MISSING:fullExplanationMarkdown");
    const multiline = { ...weighted, fullExplanationMarkdown: weighted.fullExplanationMarkdown.replace(
      "$r=-x-\\lambda y-\\gamma z$", () => "$$\nr=-x\n-\\lambda y\n-\\gamma z\n$$") };
    expect(validateTeachingNarrative(multiline)).toContain("TEACHING_WEIGHTED_TREND_CONDITION_MISSING:fullExplanationMarkdown");
    const conditional = { ...weighted, fullExplanationMarkdown: weighted.fullExplanationMarkdown.replace(
      "三个量增大都会让回报下降", "若权重为正且其他量不变，三个量增大都会让回报下降") };
    expect(validateTeachingNarrative(conditional)).not.toContain("TEACHING_WEIGHTED_TREND_CONDITION_MISSING:fullExplanationMarkdown");
    const onlyWhen = { ...weighted, fullExplanationMarkdown: weighted.fullExplanationMarkdown.replace(
      "三个量增大都会让回报下降", "只有在权重为正且其他量不变时，增大其中一个量才会让回报下降") };
    expect(validateTeachingNarrative(onlyWhen)).not.toContain("TEACHING_WEIGHTED_TREND_CONDITION_MISSING:fullExplanationMarkdown");
    const misconception = { ...onlyWhen, misconceptions: [
      "错误理解：这些指标越小越好\n\n错因：回报由加权分项组成，权重符号未知\n\n正确判断：只有在权重为正且其他量不变时，对应指标增大才会让回报下降\n\n核对方法：检查系数符号与其他输入"
    ] };
    expect(validateTeachingNarrative(misconception)).not.toContain("TEACHING_WEIGHTED_TREND_CONDITION_MISSING:misconceptions");
    const wrongCorrection = { ...misconception, misconceptions: [misconception.misconceptions[0]!.replace(
      "只有在权重为正且其他量不变时，对应指标增大才会让回报下降", "所有指标越小越好")] };
    expect(validateTeachingNarrative(wrongCorrection)).toContain("TEACHING_WEIGHTED_TREND_CONDITION_MISSING:misconceptions");
    const rejectsUnqualifiedTrend = { ...weighted, fullExplanationMarkdown: weighted.fullExplanationMarkdown.replace(
      "三个量增大都会让回报下降", "不能把‘三个量增大都会让回报下降’当作已经证明的结论；只有当权重为正且其他量不变时，才能判断增大其中一个量会让回报下降") };
    expect(validateTeachingNarrative(rejectsUnqualifiedTrend)).not.toContain("TEACHING_WEIGHTED_TREND_CONDITION_MISSING:fullExplanationMarkdown");
    const missingSign = { ...weighted, fullExplanationMarkdown: weighted.fullExplanationMarkdown.replace(
      "三个量增大都会让回报下降", "若三个量增大，回报都会下降") };
    expect(validateTeachingNarrative(missingSign)).toContain("TEACHING_WEIGHTED_TREND_CONDITION_MISSING:fullExplanationMarkdown");
    const answerOnly = { ...valid, strictWritingStyle: true, questions: [{
      prompt: "怎样判断结果变化", expectedAnswer: "由 $r=-x-\\lambda y-\\gamma z$ 可知，三个量增大都会让回报下降",
      explanation: "先代入公式，再比较改变一个输入之前与之后的输出数值，最后说明判断需要的条件"
    }] };
    expect(validateTeachingNarrative(answerOnly)).toContain("TEACHING_WEIGHTED_TREND_CONDITION_MISSING:questions");
    const symbolicResult = { ...weighted, fullExplanationMarkdown: weighted.fullExplanationMarkdown.replace(
      "三个量增大都会让回报下降", "三个量中任何一项增大都会让 $r_T$ 变小") };
    expect(validateTeachingNarrative(symbolicResult)).toContain("TEACHING_WEIGHTED_TREND_CONDITION_MISSING:fullExplanationMarkdown");
    const formulaOnlyInSource = { ...weighted, fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n末端回报由三个带负号的加权分项组成，三项前面的负号说明每个指标越大，回报越低；各项权重没有给出` };
    expect(validateTeachingNarrative(formulaOnlyInSource)).toContain("TEACHING_WEIGHTED_TREND_CONDITION_MISSING:fullExplanationMarkdown");
    const vagueResultName = { ...weighted, mainContentMarkdown: "- 末态式为 $r_T=-x-\\lambda y-\\gamma z$\n- 线长、拥挤和密度越大，该量越小" };
    expect(validateTeachingNarrative(vagueResultName)).toContain("TEACHING_WEIGHTED_TREND_CONDITION_MISSING:mainContentMarkdown");
    const smallerIsBetterWithoutWeightSigns = { ...weighted, fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n回报式为 $r_T=-x-\\lambda y-\\gamma z$；这些指标都是越小越好，权重具体符号没有给出` };
    expect(validateTeachingNarrative(smallerIsBetterWithoutWeightSigns)).toContain("TEACHING_WEIGHTED_TREND_CONDITION_MISSING:fullExplanationMarkdown");
    const reversedPreference = { ...weighted, fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n回报式为 $r_T=-x-\\lambda y-\\gamma z$；取负号后回报数值越大代表布局越差` };
    expect(validateTeachingNarrative(reversedPreference)).toContain("TEACHING_REWARD_DIRECTION_REVERSED:fullExplanationMarkdown");
    const correctPreference = { ...weighted, fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n回报式为 $r_T=-x-\\lambda y-\\gamma z$；在权重为正且其他输入不变时，成本降低会让回报数值增大，表示惩罚减轻` };
    expect(validateTeachingNarrative(correctPreference)).not.toContain("TEACHING_REWARD_DIRECTION_REVERSED:fullExplanationMarkdown");
  });

  it("rejects cross-field teaching contradictions and mathematical expressions rendered as code", () => {
    const cannotMeetObjective = { ...valid, strictWritingStyle: true,
      learningObjectives: ["能够代入回报和学习率算出一轮参数更新后的结果"],
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n更新后的参数具体数值无法确定` };
    expect(validateTeachingNarrative(cannotMeetObjective)).toContain("TEACHING_OBJECTIVE_EXPLANATION_CONTRADICTION");
    const mathAsCode = { ...valid, strictWritingStyle: true,
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n状态从 \`s0\` 经过动作 \`a0\`，回报写成 \`r0 = 0\`` };
    expect(validateTeachingNarrative(mathAsCode)).toContain("TEACHING_MATH_AS_CODE:fullExplanationMarkdown");
    const deniedReward = { ...valid, strictWritingStyle: true,
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n末端回报 $r_T$ 由三个分项组成。页面没有给出最终回报在哪里` };
    expect(validateTeachingNarrative(deniedReward)).toContain("TEACHING_OBJECT_PRESENCE_CONTRADICTION");
    const falseEquivalence = { ...valid, strictWritingStyle: true,
      learningObjectives: ["说明两条计算式为什么等价"],
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n两条写法同时存在，但当前材料未说明怎样统一` };
    expect(validateTeachingNarrative(falseEquivalence)).toContain("TEACHING_OBJECTIVE_EXPLANATION_CONTRADICTION");
    const unknownRouting = { ...valid, strictWritingStyle: true,
      learningObjectives: ["说出由哪些方法分别承担放置与布线"],
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n本页未给出布线的实现方式` };
    expect(validateTeachingNarrative(unknownRouting)).toContain("TEACHING_OBJECTIVE_EXPLANATION_CONTRADICTION");
    const unknownEdgeWeightDimension = { ...valid, strictWritingStyle: true,
      learningObjectives: ["解释两端节点和边权的作用"],
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n边权 $w_{ij}^e$ 的维度没有给出，两个 32 维节点向量拼接后是 64 维`,
      mainContentMarkdown: "- 两个节点向量和边权共同拼成 64 维输入\n- 输出为 32 维" };
    expect(validateTeachingNarrative(unknownEdgeWeightDimension)).toContain("TEACHING_CONCAT_DIMENSION_CONTRADICTION:mainContentMarkdown");
    const correctlySeparatedDimensions = { ...unknownEdgeWeightDimension,
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n页面主公式除两个节点向量外还多出边权 $w_{ij}^e$；它的维度没有给出，因此总维度无法确定，不能把它与后面 $[v_i;v_j]$ 的 64 维结论合并成同一个维度结论`,
      mainContentMarkdown: "- 两个节点向量拼接后是 64 维\n- 含边权的总维度无法确定" };
    expect(validateTeachingNarrative(correctlySeparatedDimensions)).not.toContain("TEACHING_CONCAT_DIMENSION_CONTRADICTION:fullExplanationMarkdown");
    const conditionalConcat = { ...correctlySeparatedDimensions,
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n如果要把 $w_{ij}^{e}$ 也纳入，需要知道它的维度以及它与 64 维拼接向量的拼接方式，当前页面没有给出这两项信息` };
    expect(validateTeachingNarrative(conditionalConcat)).not.toContain("TEACHING_CONCAT_DIMENSION_CONTRADICTION:fullExplanationMarkdown");
    const selectedParameterContradiction = { ...valid, strictWritingStyle: true,
      learningObjectives: ["能说明为什么本次更新只改变被选中动作对应的策略权重"],
      fullExplanationMarkdown: `${valid.fullExplanationMarkdown}\n\n梯度的两个分量都不为零，因此两个策略参数会同时更新` };
    expect(validateTeachingNarrative(selectedParameterContradiction)).toContain("TEACHING_OBJECTIVE_EXPLANATION_CONTRADICTION");
    const misplacedBridgeAbbreviation = { ...valid, strictWritingStyle: true,
      chapterBridgeMarkdown: "上一页介绍了马尔可夫决策过程（Markov Decision Process, MDP）的基本循环\n\n本页继续完成一次更新" };
    expect(validateTeachingNarrative(misplacedBridgeAbbreviation)).toContain("TEACHING_ABBREVIATION_PLACEMENT:chapterBridgeMarkdown");
  });

  it("accepts a concrete causal correction without requiring one fixed pair of cue words", () => {
    const explained = { ...valid, lessonFlowVersion: 2 as const, priorKnowledge: ["输入条件：规则只对满足输入条件的对象执行，因此要先确认对象是否满足条件，再计算并核对结果是否符合目标"], misconceptions: ["把未满足条件的结果直接当作答案会出错，由于规则的前提不成立，应先核对输入条件再判断结果"] };
    expect(validateTeachingNarrative(explained)).toEqual([]);
    expect(validateTeachingNarrative({ ...explained, misconceptions: ["以为可以直接接入完整模型：完整网络末端留着价值预测层，输出的是奖励数值而不是策略所需的表示；核对时检查末端是否仍包含价值预测输出"] })).toEqual([]);
    expect(validateTeachingNarrative({ ...explained, misconceptions: ["把一万个设计样本当成推理阶段的数据规模；它在材料中紧跟预训练步骤，描述的是学习编码器时使用的有标注样本数量；核对办法是回到原文训练步骤，确认数字所在位置"] })).toEqual([]);
    expect(validateTeachingNarrative({ ...explained, misconceptions: ["把热力图当成可读出具体数值的结果：页面只给出了颜色分布，没有标明色标和单位；核对办法是先找图例，找不到就只描述颜色变化"] })).toEqual([]);
    expect(validateTeachingNarrative({ ...explained, misconceptions: ["不要直接套用结果"] })).toContain("TEACHING_MISCONCEPTION_REASON_MISSING");
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

  it("exposes the same page-specific explanation limits used by repair", () => {
    expect(maximumTeachingExplanationCharacters({ pageKind: "cover", sourceDensity: "dense" })).toBe(900);
    expect(maximumTeachingExplanationCharacters({ pageKind: "agenda", sourceDensity: "dense" })).toBe(1_000);
    expect(maximumTeachingExplanationCharacters({ pageKind: "concept", sourceDensity: "sparse" })).toBe(2_000);
    expect(maximumTeachingExplanationCharacters({ pageKind: "formula", sourceDensity: "sparse" })).toBe(3_500);
    expect(maximumTeachingExplanationCharacters({ pageKind: "diagram", sourceDensity: "sparse" })).toBe(3_500);
    expect(maximumTeachingExplanationCharacters({ pageKind: "formula", sourceDensity: "normal" })).toBe(3_500);
    expect(maximumTeachingExplanationCharacters({ pageKind: "diagram", sourceDensity: "dense" })).toBe(5_000);
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

  it("does not mistake a sentence with inline math or code for an empty colon heading", () => {
    expect(validateHumanReadableChinese("它旁边给出的回报是一段表达式：$r_T=-x$\n下一句解释这项回报"))
      .not.toContain("WRITING_COLON_PSEUDO_HEADING");
    expect(validateHumanReadableChinese("原图的标签是：`Force-directed method`\n这里解释标签"))
      .not.toContain("WRITING_COLON_PSEUDO_HEADING");
    expect(validateHumanReadableChinese("操作：\n执行检查"))
      .toContain("WRITING_COLON_PSEUDO_HEADING");
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
