import { renderToStaticMarkup } from "react-dom/server";
import type { CourseRelease, PageLesson } from "@course-os/contracts";
import { describe, expect, it } from "vitest";
import { ExplanationPanel, QuestionBankStatus, summaryMarkdown } from "./ExplanationPanel.js";

describe("lesson summary", () => {
  it("removes a duplicate leading title while preserving the existing conclusions", () => {
    expect(summaryMarkdown("## 编码器与迁移学习\n\n- 先训练编码器\n- 再将它接入另一种网络"))
      .toBe("- 先训练编码器\n- 再将它接入另一种网络");
    expect(summaryMarkdown("## 只有标题的旧内容")).toBe("## 只有标题的旧内容");
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
    expect(markup).toContain('class="quality-badge pass">讲解已生成</span>');
    expect(readyCandidate.quality.publishable).toBe(false);
  });

  it("keeps an unfinished source seed labeled as a draft and preserves formal published behavior", () => {
    const unfinished = renderToStaticMarkup(<ExplanationPanel release={release} page={page(false)} generatedReady={false} />);
    const published = renderToStaticMarkup(<ExplanationPanel release={release} page={page(true)} />);

    expect(unfinished).toContain('class="quality-badge hold">讲解草稿</span>');
    expect(published).toContain('class="quality-badge pass">讲解已生成</span>');
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

  it("reports the actual approved and draft question counts without filling missing questions", () => {
    const markup = renderToStaticMarkup(<QuestionBankStatus available={2} draftCount={1} />);

    expect(markup).toContain("当前有 2 道可用题目、1 道草稿题；还差 2 道可用题目才能练习");
    expect(markup).not.toContain("第 3 道题");
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
