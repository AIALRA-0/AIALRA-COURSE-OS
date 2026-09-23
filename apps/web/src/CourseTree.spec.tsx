import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CourseTreeNode } from "@course-os/contracts";
import { CourseTree } from "./CourseTree.js";

describe("CourseTree background task entries", () => {
  it("places a persisted import under its course rather than in the unrelated task section", () => {
    const course = {
      id: "course-1", kind: "course", title: "EE680", children: [], capabilities: [],
      workspaceId: "workspace-1", parentId: null
    } as unknown as CourseTreeNode;
    const markup = renderToStaticMarkup(createElement(CourseTree, {
      tree: { workspaceId: "workspace-1", title: "课程空间", courses: [course], rootMaterials: [], updatedAt: "2026-09-22T10:00:00.000Z" },
      backgroundTasks: [{ id: "task-running", courseId: "course-1", title: "Lecture.pptx", detail: "正在处理 · 2/8 页", state: "running" }],
      onSelectTask: vi.fn(), onSelectPage: vi.fn(), onImport: vi.fn(), onCreateCourse: vi.fn(), onSettings: vi.fn()
    }));
    expect(markup).toContain('aria-label="课程后台任务"');
    expect(markup).toContain('class="tree-task-section tree-task-nested"');
    expect(markup.indexOf("EE680")).toBeLessThan(markup.indexOf("Lecture.pptx"));
    expect(markup).not.toContain('aria-label="未归类后台任务"');
  });
  it("renders tasks with their real status class and opens the selected task entry", () => {
    const markup = renderToStaticMarkup(createElement(CourseTree, {
      tree: { workspaceId: "workspace-1", title: "课程空间", courses: [], rootMaterials: [], updatedAt: "2026-09-22T10:00:00.000Z" },
      backgroundTasks: [
        { id: "task-running", title: "Lecture.pptx", detail: "正在处理 · 2/8 页", state: "running" },
        { id: "task-queued", title: "Queued.pdf", detail: "排队中 · 0/8 页", state: "queued" },
        { id: "task-done", title: "Completed.pdf", detail: "已完成 · 8/8 页", state: "completed" },
        { id: "generation-job:task-failed", title: "Failed.pptx", detail: "失败 · 1/8 页", state: "failed" },
        { id: "task-cancelled", title: "Cancelled.pdf", detail: "已取消", state: "cancelled" }
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
    expect(markup).toContain('class="task-state-dot task-state-queued"');
    expect(markup).toContain('class="task-state-dot task-state-failed"');
    expect(markup).toContain('class="task-state-dot task-state-cancelled"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("Lecture.pptx");
    expect(markup).toContain("2/8 页");
  });

  it("places a standalone generation-job task beneath the course that owns its material", () => {
    const course = {
      id: "course-1", kind: "course", title: "EE680", children: [], capabilities: [],
      workspaceId: "workspace-1", parentId: null
    } as unknown as CourseTreeNode;
    const markup = renderToStaticMarkup(createElement(CourseTree, {
      tree: { workspaceId: "workspace-1", title: "课程空间", courses: [course], rootMaterials: [], updatedAt: "2026-09-22T10:00:00.000Z" },
      backgroundTasks: [{ id: "generation-job:job-1", courseId: "course-1", title: "第一章 · 生成任务 abc123", detail: "正在处理 · 1/4 页", state: "running" }],
      onSelectTask: vi.fn(), onSelectPage: vi.fn(), onImport: vi.fn(), onCreateCourse: vi.fn(), onSettings: vi.fn()
    }));
    expect(markup).toContain('data-task-id="generation-job:job-1"');
    expect(markup).toContain('class="tree-task-section tree-task-nested"');
    expect(markup).toContain('class="task-state-dot task-state-running"');
    expect(markup.indexOf("EE680")).toBeLessThan(markup.indexOf("生成任务 abc123"));
    expect(markup).not.toContain('aria-label="未归类后台任务"');
  });
});
