import { renderToStaticMarkup } from "react-dom/server";
import type { CourseRelease, PageLesson } from "@course-os/contracts";
import { describe, expect, it } from "vitest";
import { displayPriorKnowledge, ExplanationPanel, QuestionAnswerFeedback, QuestionBankStatus, summaryMarkdown } from "./ExplanationPanel.js";
import { SelfRetellingPanel } from "./SelfRetellingPanel.js";

describe("self-retelling panel presentation", () => {
  it("keeps its saved-answer field and dynamic page count inside the scoped workbench panel", () => {
    const release = { id: "release-1", pageIds: ["page-1", "page-2", "page-3"] } as unknown as CourseRelease;
    const page = { id: "page-1" } as unknown as PageLesson;
    const markup = renderToStaticMarkup(<SelfRetellingPanel release={release} page={page} />);

    expect(markup).toContain('class="self-retelling-panel workbench-panel study-self-retelling-panel"');
    expect(markup).toContain("阅读进度 0/3 · 0%");
    expect(markup).toContain('aria-required="true"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('data-action="save-self-retelling"');
  });
});

describe("lesson summary", () => {
  it("removes a duplicate leading title while preserving the existing conclusions", () => {
    expect(summaryMarkdown("## 编码器与迁移学习\n\n- 先训练编码器\n- 再将它接入另一种网络"))
      .toBe("- 先训练编码器\n- 再将它接入另一种网络");
    expect(summaryMarkdown("## 只有标题的旧内容")).toBe("## 只有标题的旧内容");
  });
});

describe("question answer feedback", () => {
  it.each([
    ["correct", "✅", "回答正确：记录已保存"],
    ["incorrect", "❌", "回答未完全正确：记录已保存，还需要复习"]
  ] as const)("displays a hidden visual symbol plus readable authoritative %s text", (state, symbol, title) => {
    const markup = renderToStaticMarkup(<QuestionAnswerFeedback state={state} feedback="完整解释 **要点**，含 $x=y$ 与 `原文`。" />);
    expect(markup).toContain(`<span aria-hidden="true">${symbol}</span>`);
    expect(markup).toContain(title);
    expect(markup).toContain("完整解释 <strong>要点</strong>");
    expect(markup).toContain("<code>原文</code>");
    expect(markup).toContain("katex");
  });

  it.each(["incorrect", "unverified"] as const)("preserves partially correct feedback under the actual %s result without reinterpreting prose", (state) => {
    const feedback = "部分正确：前半部分满足条件，后半部分需要补充。\n\n**依据：** 不变量仍成立，但尚未说明边界。";
    const markup = renderToStaticMarkup(<QuestionAnswerFeedback state={state} feedback={feedback} />);
    expect(markup).toContain("部分正确：前半部分满足条件，后半部分需要补充。");
    expect(markup).toContain("<strong>依据：</strong> 不变量仍成立，但尚未说明边界。");
    expect(markup).not.toContain("✅");
    if (state === "unverified") {
      expect(markup).not.toContain("❌");
      expect(markup).toContain("尚未判定对错");
    }
  });

  it("does not turn save failures into an incorrect answer or a saved record", () => {
    const markup = renderToStaticMarkup(<QuestionAnswerFeedback state="error" feedback="保存暂不可用，重试。" />);
    expect(markup).toContain("保存失败：答案仍保留在输入框");
    expect(markup).toContain("请检查后重试");
    expect(markup).not.toContain("✅");
    expect(markup).not.toContain("❌");
    expect(markup).not.toContain("记录已保存");
  });

  it("shows a verdict even when a successfully saved result has empty explanation", () => {
    expect(renderToStaticMarkup(<QuestionAnswerFeedback state="correct" feedback="" />)).toContain("回答正确：记录已保存");
  });
});

describe("prior knowledge definition display", () => {
  it("renders mixed definitions as sibling list items with one paragraph per ordinary definition", () => {
    const lesson = { id: "mixed", title: "合成定义", pageNumber: 1, blocks: [], anchors: [], atoms: [], lessonSections: [{ id: "prior", kind: "prior_knowledge", title: "先验知识", items: [{ id: "mixed", text: "节点（Node）：定义。\n- 边（Edge）：连接。\n## Kernel\n函数说明。\n- 路径（Path）：有序连接。", sourceAnchorIds: [] }, { id: "continuation", text: "它工作的方式是：逐个连接。", sourceAnchorIds: [] }], sourceAnchorIds: [], atomIds: [] }], quality: { issues: [] } } as unknown as PageLesson;
    const markup = renderToStaticMarkup(<ExplanationPanel release={{ id: "synthetic" } as CourseRelease} page={lesson} />);
    const prior = markup.match(/<article class="lesson-block section-prior_knowledge"[\s\S]*?<\/article>/u)![0];
    expect(prior.match(/<li>/gu)).toHaveLength(4);
    expect(prior.match(/<ul/gu)).toHaveLength(1);
    expect(prior.match(/<p>/gu)).toHaveLength(4);
    expect(prior).toContain("Kernel： 函数说明。");
    expect(prior).toContain("路径（Path）：有序连接。 它工作的方式是：逐个连接。");
  });

  it("preserves rich definition objects and nested reference lists in the rendered tree", () => {
    const lesson = { id: "rich", title: "合成定义", blocks: [], anchors: [], atoms: [], lessonSections: [{ id: "prior", kind: "prior_knowledge", title: "先验知识", markdown: "节点（Node）：保留 $x:y$ 和 `x:y`。\n\n> 引文原文。\n> - 条目（Quoted）：真实引用。\n\n- 参考资料：\n  - 子资料保持嵌套。\n\n```text\n## Raw\n- 假名（Fake）：不能成为定义。\n```\n\n$$\nx = y\n$$\n\n- 边（Edge）：另一条定义。", sourceAnchorIds: [], atomIds: [] }], quality: { issues: [] } } as unknown as PageLesson;
    const markup = renderToStaticMarkup(<ExplanationPanel release={{ id: "synthetic" } as CourseRelease} page={lesson} />);
    expect(markup).toContain("<blockquote>");
    expect(markup).toContain("真实引用。");
    expect(markup).toContain("子资料保持嵌套。");
    expect(markup).toContain("<code>x:y</code>");
    expect(markup).toContain('class="language-text"');
    expect(markup).toContain("- 假名（Fake）：不能成为定义。");
    expect(markup).toContain('class="katex"');
    expect(markup).not.toContain("katex-error");
  });

  it("does not repair opaque quotation text while flattening definitions around it", () => {
    const lesson = { id: "quote", title: "引文保护", blocks: [], anchors: [], atoms: [], lessonSections: [{ id: "prior", kind: "prior_knowledge", title: "先验知识", items: [{ id: "prior", text: "节点（Node）：定义。\n\n> **原文标签： ** 引文中的标点和格式保持原样。\n\n- 边（Edge）：另一项。", sourceAnchorIds: [] }], sourceAnchorIds: [], atomIds: [] }], quality: { issues: [] } } as unknown as PageLesson;
    const markup = renderToStaticMarkup(<ExplanationPanel release={{ id: "synthetic" } as CourseRelease} page={lesson} />);
    expect(markup).toContain("**原文标签： ** 引文中的标点和格式保持原样。");
    expect(markup).not.toContain("<strong>原文标签：</strong>");
  });

  it("retains all legacy prior knowledge definitions without sentence splitting or an eight-item limit", () => {
    const terms = Array.from({ length: 10 }, (_, i) => `节点${i}（Node${i}）：完整定义。还有一句；保留。`);
    const lesson = { id: "legacy", title: "旧定义", blocks: [{ id: "prior", kind: "prerequisite", markdown: terms.join("\n- ") }], anchors: [], atoms: [], quality: { issues: [] } } as unknown as PageLesson;
    const markup = renderToStaticMarkup(<ExplanationPanel release={{ id: "synthetic" } as CourseRelease} page={lesson} />);
    for (const term of terms) expect(markup).toContain(term);
  });

  it.each([
    ["**图（Graph）：** 图由顶点和边组成。", "图（Graph）： 图由顶点和边组成。"],
    ["**图（Graph）： ** 图由顶点和边组成。", "图（Graph）： 图由顶点和边组成。"]
  ])("removes only the opening definition emphasis markers", (source, expected) => {
    expect(displayPriorKnowledge(source)).toBe(expected);
  });

  it("preserves all text and Markdown after the definition prefix", () => {
    const suffix = " 图用于表示关系；后文 **仍可加粗**，公式 $O(n)$ 和代码 `x**y` 保持原样。";
    expect(displayPriorKnowledge(`**图（Graph）：**${suffix}`)).toBe(`图（Graph）：${suffix}`);
  });
});

describe("lesson generation readiness badge", () => {
  const page = (publishable: boolean) => ({
    id: "page-1",
    pageNumber: 1,
    title: "候选讲解内容",
    imageUrl: "",
    anchors: [],
    atoms: [],
    blocks: [],
    coverageRequirements: [],
    coverageClaims: [],
    quality: { highRiskCoverage: 0, generalCoverage: 0, mathValid: false, publishable, issues: ["offline audit pending"] }
  }) as PageLesson;
  const release = { id: "release-1" } as CourseRelease;

  it("shows a matching ready candidate as generated without changing its nonpublishable quality value", () => {
    const readyCandidate = page(false);
    const markup = renderToStaticMarkup(<ExplanationPanel release={release} page={readyCandidate} generatedReady />);

    expect(markup).toContain("候选讲解内容");
    expect(markup).toContain('class="quality-badge hold">讲解尚未生成</span>');
    expect(readyCandidate.quality.publishable).toBe(false);
  });

  it("keeps an unfinished source seed labeled as a draft and preserves formal published behavior", () => {
    const unfinished = renderToStaticMarkup(<ExplanationPanel release={release} page={page(false)} generatedReady={false} />);
    const published = renderToStaticMarkup(<ExplanationPanel release={release} page={page(true)} />);

    expect(unfinished).toContain('class="quality-badge hold">讲解尚未生成</span>');
    expect(published).toContain('class="quality-badge hold">讲解尚未生成</span>');
  });

  it("shows an explicit missing full explanation and never fills it with the summary", () => {
    const lesson = page(false);
    lesson.lessonSections = [
      { id: "full", kind: "full_explanation", title: "完整讲解", markdown: "", sourceAnchorIds: [], atomIds: [] },
      { id: "main", kind: "main_content", title: "主要内容", markdown: "只保留的摘要", sourceAnchorIds: [], atomIds: [] }
    ];
    const markup = renderToStaticMarkup(<ExplanationPanel release={release} page={lesson} />);
    const fullSection = markup.match(/<article class="lesson-block section-full_explanation"[\s\S]*?(?=<article class="lesson-block section-main_content")/)?.[0] ?? "";

    expect(fullSection).toContain("完整讲解尚未生成；已有摘要保留");
    expect(fullSection).not.toContain("只保留的摘要");
    expect(markup).toContain("只保留的摘要");
  });

  it("removes emphasis only from a prior knowledge item definition prefix", () => {
    const lesson = page(false);
    lesson.lessonSections = [{
      id: "prior",
      kind: "prior_knowledge",
      title: "先验知识",
      items: [{ id: "definition", text: "**图（Graph）： ** 后文 **保持粗体**。", sourceAnchorIds: [] }],
      markdown: "**段落标签： ** Markdown 正文保持原样。",
      sourceAnchorIds: [],
      atomIds: []
    }];
    const markup = renderToStaticMarkup(<ExplanationPanel release={release} page={lesson} />);

    expect(markup).toContain("图（Graph）： 后文 <strong>保持粗体</strong>。");
    expect(markup).not.toContain("<strong>图（Graph）：");
    expect(markup).toContain("段落标签： Markdown 正文保持原样。");
    expect(markup).not.toContain("**段落标签： **");
  });

  it("normalizes legacy labels in objectives, full explanation, and summary while preserving code", () => {
    const lesson = page(false);
    lesson.lessonSections = [
      {
        id: "objectives",
        kind: "learning_objectives",
        title: "学习目标",
        items: [{ id: "objective", text: "**目标标签： ** 判断是否满足条件。", sourceAnchorIds: [] }],
        markdown: "**目标说明： **正文标签正常显示。\n\n```text\n**代码标签： **原样保留\n```\n\n行内代码 `x; **代码标签： **y` 保持原样。",
        sourceAnchorIds: [],
        atomIds: []
      },
      {
        id: "full",
        kind: "full_explanation",
        title: "完整讲解",
        items: [{ id: "full-item", text: "**正文标签： **完整讲解项可读。", sourceAnchorIds: [] }],
        markdown: "**正文标签： **详细讲解清楚显示，保留 **合法粗体** 和公式 $O(n)$，行内代码 `x; **代码标签： **y` 不改。",
        sourceAnchorIds: [],
        atomIds: []
      },
      {
        id: "summary",
        kind: "main_content",
        title: "主要内容",
        items: [{ id: "summary-item", text: "**摘要项： **结论保持可读。", sourceAnchorIds: [] }],
        markdown: "**摘要标签： **摘要正文正常显示。",
        sourceAnchorIds: [],
        atomIds: []
      }
    ];
    const markup = renderToStaticMarkup(<ExplanationPanel release={release} page={lesson} />);
    const fullSection = markup.match(/<article class="lesson-block section-full_explanation"[\s\S]*?(?=<article class="lesson-block section-main_content")/)?.[0] ?? "";

    expect(markup).toContain("<strong>目标标签：</strong> 判断是否满足条件。");
    expect(markup).toContain("<strong>目标说明：</strong> 正文标签正常显示。");
    expect(markup).toContain("<strong>正文标签：</strong> 完整讲解项可读。");
    expect(markup).toContain("<strong>正文标签：</strong> 详细讲解清楚显示");
    expect(markup).toContain("<strong>合法粗体</strong>");
    expect(markup).toContain('class="katex"');
    expect(markup).toContain("<strong>摘要项：</strong> 结论保持可读。");
    expect(markup).toContain("<strong>摘要标签：</strong> 摘要正文正常显示。");
    expect(markup).toContain("<code class=\"language-text\">**代码标签： **原样保留\n</code>");
    expect(markup).toContain("<code>x; **代码标签： **y</code>");
    expect(fullSection).toContain("<code>x; **代码标签： **y</code>");
    expect(markup).not.toContain("**正文标签： **");
  });

  it("does not display a legacy summary as a full explanation", () => {
    const lesson = page(false);
    lesson.blocks = [{ id: "summary", kind: "core", title: "摘要", markdown: "仅存摘要", sourceAnchorIds: [], atomIds: [] }] as PageLesson["blocks"];
    const markup = renderToStaticMarkup(<ExplanationPanel release={release} page={lesson} />);
    expect(markup).toContain('class="quality-badge hold">讲解尚未生成</span>');
    const full = markup.match(/<article class="lesson-block section-full_explanation"[\s\S]*?(?=<article class="lesson-block section-main_content")/)?.[0] ?? "";
    expect(full).not.toContain("仅存摘要");
    expect(markup).toContain("仅存摘要");
  });

  it("marks missing main content as incomplete while retaining its full explanation", () => {
    const lesson = page(false);
    lesson.lessonSections = [
      { id: "bridge", kind: "chapter_bridge", title: "承上启下", markdown: "已确认的真实承接", sourceAnchorIds: [], atomIds: [] },
      { id: "full", kind: "full_explanation", title: "完整讲解", markdown: "已有完整教学正文", sourceAnchorIds: [], atomIds: [] },
      { id: "main", kind: "main_content", title: "主要内容", markdown: "", sourceAnchorIds: [], atomIds: [] }
    ];
    const markup = renderToStaticMarkup(<ExplanationPanel release={release} page={lesson} />);
    expect(markup).toContain('class="quality-badge hold">正文可读 · 主要内容待补齐</span>');
    expect(markup).toContain("已有完整教学正文");
    expect(markup).toContain("主要内容尚未补齐；完整讲解保留");
  });

  it("preserves a long full explanation verbatim even when its opening repeats the summary", () => {
    const lesson = page(false);
    const repeatedOpening = "第29页完整讲解的长正文开头，必须按原样保留，不能因它与摘要重复而删掉。";
    const fullText = `${repeatedOpening}\n\n后续段落继续解释关键步骤、条件和推导。`;
    lesson.lessonSections = [
      { id: "full", kind: "full_explanation", title: "完整讲解", markdown: fullText, sourceAnchorIds: [], atomIds: [] },
      { id: "main", kind: "main_content", title: "主要内容", markdown: repeatedOpening, sourceAnchorIds: [], atomIds: [] }
    ];
    const markup = renderToStaticMarkup(<ExplanationPanel release={release} page={lesson} />);

    expect(markup).toContain(repeatedOpening);
    expect(markup).toContain("后续段落继续解释关键步骤、条件和推导。");
    expect(markup.split(repeatedOpening)).toHaveLength(3);
  });

  it("reports available and draft questions without imposing a four-question threshold", () => {
    const markup = renderToStaticMarkup(<QuestionBankStatus available={2} draftCount={1} />);

    expect(markup).toContain("当前有 2 道合格题可以练习；另有 1 道草稿题尚未确认");
    expect(markup).not.toContain("还差");
    expect(markup).not.toContain("第 3 道题");
  });

  it("explains an empty question bank accurately", () => {
    const markup = renderToStaticMarkup(<QuestionBankStatus available={0} draftCount={0} />);

    expect(markup).toContain("当前没有符合条件的可练习题目");
    expect(markup).not.toContain("还差");
  });

  it("renders pseudocode explanation math while preserving the code line", () => {
    const lesson = page(true);
    lesson.atoms = [{
      kind: "pseudocode_line",
      id: "line-1",
      lineNumber: 1,
      code: "while (n > 0) do",
      semantic: "每轮处理一个元素",
      teacherSummary: "每轮减少一个元素，因此为 $O(n)$。",
      reads: ["$n$"],
      writes: [],
      preState: "当前规模为 $n$。",
      postState: "规模变成 $n-1$。",
      sideEffects: [],
      complexityRelation: "$O(n)$"
    }];
    const markup = renderToStaticMarkup(<ExplanationPanel release={release} page={lesson} />);

    expect(markup).toContain("<code>while (n &gt; 0) do</code>");
    expect(markup).toContain("katex");
    expect(markup).toContain("O(n)");
    expect(markup).not.toContain("katex-error");
  });
});
