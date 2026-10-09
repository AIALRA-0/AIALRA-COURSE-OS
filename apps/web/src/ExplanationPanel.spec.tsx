import { renderToStaticMarkup } from "react-dom/server";
import type { CourseRelease, PageLesson } from "@course-os/contracts";
import { describe, expect, it } from "vitest";
import { displayPriorKnowledge, ExplanationPanel, QuestionBankStatus, summaryMarkdown } from "./ExplanationPanel.js";
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

describe("prior knowledge definition display", () => {
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
    expect(markup).toContain("**段落标签： ** Markdown 正文保持原样。");
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
