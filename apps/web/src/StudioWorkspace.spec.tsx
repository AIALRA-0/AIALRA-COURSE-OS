import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CourseRelease, PageLesson, QuestionBankItem } from "@course-os/contracts";
import { StudioWorkspace } from "./StudioWorkspace.js";

function render(questions: QuestionBankItem[] = [], rightCollapsed = false) {
  const page = {
    id: "page-1", pageNumber: 1, title: "制作测试", imageUrl: "/source.png", anchors: [], atoms: [], blocks: [],
    questionBank: questions, coverageRequirements: [], coverageClaims: [],
    quality: { highRiskCoverage: 0, generalCoverage: 0, mathValid: true, publishable: false, issues: [] }
  } as unknown as PageLesson;
  const release = { id: "release-1", courseId: "course-1", courseTitle: "课程", moduleId: "module-1", moduleTitle: "模块" } as CourseRelease;
  return renderToStaticMarkup(createElement(StudioWorkspace, {
    release, page, rightCollapsed, imageResources: undefined as never,
    onToggleRight: vi.fn(), onPublished: vi.fn(), onChanged: vi.fn()
  }));
}

describe("Studio empty and question editor states", () => {
  it("shows the initial loading state, empty question guidance and all existing actions", () => {
    const markup = render();
    expect(markup).toContain("正在读取讲解草稿");
    expect(markup).toContain("当前页面还没有题目，可以点击补齐题库");
    for (const action of ["studio-generate-page", "studio-toggle-preview", "studio-save-draft", "studio-validate", "studio-publish"]) {
      expect(markup).toContain(`data-action="${action}"`);
    }
    expect(markup).toContain('aria-label="页面工作状态"');
  });

  it("uses labeled shared native selects without losing choice options or answers", () => {
    const question = { id: "q-1", kind: "multiple_choice", status: "draft", prompt: "选择正确解释", options: ["选项甲", "选项乙"], expectedAnswer: "选项甲", explanation: "原答案说明" } as QuestionBankItem;
    const markup = render([question]);
    expect(markup.match(/<select\b/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="第 1 题类型"');
    expect(markup).toContain('aria-label="第 1 题状态"');
    expect(markup).toContain('<option value="multiple_choice" selected="">选择题</option>');
    expect(markup).toContain('<option value="draft" selected="">草稿</option>');
    expect(markup).toContain('<option value="retired">已停用</option>');
    expect(markup).toContain("选项甲\n选项乙");
    expect(markup).toContain("原答案说明");
  });

  it("keeps the inspector reopen action and editing surface when collapsed", () => {
    const markup = render([], true);
    expect(markup).toContain('aria-label="展开检查栏"');
    expect(markup).toContain('class="studio-editor-content"');
    expect(markup).not.toContain('id="studio-inspector-panel"');
  });
});
