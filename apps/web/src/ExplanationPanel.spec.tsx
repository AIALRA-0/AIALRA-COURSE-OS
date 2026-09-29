import { renderToStaticMarkup } from "react-dom/server";
import type { CourseRelease, PageLesson } from "@course-os/contracts";
import { describe, expect, it } from "vitest";
import { ExplanationPanel, summaryMarkdown } from "./ExplanationPanel.js";

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
});
