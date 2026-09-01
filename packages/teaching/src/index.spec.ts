import { describe, expect, it } from "vitest";
import { buildFullCoursePage, buildGoldenPage, extractPageSection, splitSentences } from "./index.js";

describe("golden teaching compiler", () => {
  it("extracts one page without carrying the next page", () => {
    const source = "### 2.1 第1页：一\n\n第一页\n\n### 2.2 第2页：二\n\n第二页";
    expect(extractPageSection(source, 1)).toContain("第一页");
    expect(extractPageSection(source, 1)).not.toContain("第二页");
  });

  it("gives every KL pseudocode line complete machine-checkable coverage", () => {
    const page = buildGoldenPage({ deck: "chapter-2", pageNumber: 9, rawSection: "完整讲解\n\n课堂问答：\n\n- 问：测试？答：测试", imageUrl: "/media/hash", materialVersionId: "chapter-2-v1" });
    expect(page.atoms.filter((atom) => atom.kind === "pseudocode_line")).toHaveLength(21);
    expect(page.quality.highRiskCoverage).toBe(1);
    expect(page.quality.publishable).toBe(true);
  });

  it("does not split sentence items inside TeX formulas", () => {
    const items = splitSentences("把 $16!$ 读成 $16\\times15$；阶乘必须继续乘到 $1$，因此候选数量远大于 240");
    expect(items).toEqual(["把 $16!$ 读成 $16\\times15$；阶乘必须继续乘到 $1$，因此候选数量远大于 240"]);
  });

  it.each([["introduction", 25], ["chapter-2", 47]] as const)("builds every %s page in continuous order", (deck, count) => {
    const markdown = Array.from({ length: count }, (_, index) => `### 2.${index + 1} 第${index + 1}页：页面 ${index + 1}\n\n本页解释页面 ${index + 1} 的主要对象、关系、前提和结论\n\n- 不能跳过输入条件\n\n课堂问答：\n\n- 问：本页核心关系是什么？答：输入经过规则得到输出`).join("\n\n");
    const pages = Array.from({ length: count }, (_, index) => buildFullCoursePage({ deck, pageNumber: index + 1, markdown, imageUrl: `/page-${index + 1}.png`, materialVersionId: `${deck}-full-v2` }));
    expect(pages.map((page) => page.pageNumber)).toEqual(Array.from({ length: count }, (_, index) => index + 1));
    expect(pages.every((page) => page.lessonSections?.map((section) => section.kind).join(",") === "learning_objectives,main_content,prior_knowledge,full_explanation,misconceptions")).toBe(true);
    expect(pages.every((page) => page.questionBank?.length === 4)).toBe(true);
    expect(pages.every((page) => page.quality.publishable)).toBe(true);
  });
});
