import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CourseTree } from "./CourseTree.js";

describe("CourseTree background task entries", () => {
  it("renders tasks with their real status class and opens the selected task entry", () => {
    const markup = renderToStaticMarkup(createElement(CourseTree, {
      tree: { workspaceId: "workspace-1", title: "课程空间", courses: [], rootMaterials: [], updatedAt: "2026-09-22T10:00:00.000Z" },
      backgroundTasks: [
        { id: "task-running", title: "Lecture.pptx", detail: "正在处理 · 2/8 页", state: "running" },
        { id: "task-done", title: "Completed.pdf", detail: "已完成 · 8/8 页", state: "completed" }
      ],
      selectedTaskId: "task-running",
      onSelectTask: vi.fn(),
      onSelectPage: vi.fn(),
      onImport: vi.fn(),
      onCreateCourse: vi.fn(),
      onSettings: vi.fn()
    }));

    expect(markup).toContain('data-action="tree-open-task"');
    expect(markup).toContain('data-task-state="running"');
    expect(markup).toContain('class="task-state-dot task-state-running"');
    expect(markup).toContain('data-task-state="completed"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("Lecture.pptx");
    expect(markup).toContain("2/8 页");
  });
});
