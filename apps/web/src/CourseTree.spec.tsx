import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CourseTreeNode } from "@course-os/contracts";
import { buildCourseTreeSearchResults, CourseTree, failedCourseTreeTaskIds, moveSearchIndex, resolveCourseTreeSearchActivation, resolveSearchInputKeyAction, resolveTreeMenuKeyAction, type CourseTreeSearchMaterial } from "./CourseTree.js";
import { Icon } from "./Icon.js";

describe("CourseTree background task entries", () => {
  it("places a persisted import under its course rather than in the unrelated task section", () => {
    const course = {
      id: "course-1", kind: "course", title: "EE680", children: [], capabilities: [],
      workspaceId: "workspace-1", parentId: null
    } as unknown as CourseTreeNode;
    const markup = renderToStaticMarkup(createElement(CourseTree, {
      tree: { workspaceId: "workspace-1", title: "课程空间", courses: [course], rootMaterials: [], updatedAt: "2026-09-22T10:00:00.000Z" },
      backgroundTasks: [{ id: "task-running", courseId: "course-1", title: "Lecture.pptx", detail: "正在处理 · 2/8 页", state: "running" }],
      onSelectTask: vi.fn(), onSelectPage: vi.fn(), onImport: vi.fn(), onCreateCourse: vi.fn()
    }));
    expect(markup).toContain('aria-labelledby="tree-task-section-heading"');
    expect(markup).toContain('class="tree-task-section"');
    expect(markup.indexOf('</nav>')).toBeLessThan(markup.indexOf('aria-labelledby="tree-task-section-heading"'));
    expect(markup.indexOf("EE680")).toBeLessThan(markup.indexOf("Lecture.pptx"));
  });
  it("renders tasks with their real status class and opens the selected task entry", () => {
    const markup = renderToStaticMarkup(createElement(CourseTree, {
      tree: { workspaceId: "workspace-1", title: "课程空间", courses: [], rootMaterials: [], updatedAt: "2026-09-22T10:00:00.000Z" },
      backgroundTasks: [
        { id: "task-running", title: "Lecture.pptx", detail: "正在处理 · 2/8 页", state: "running", progress: { percent: 25, completed: 2, total: 8 } },
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
    }));

    expect(markup).toContain('data-action="tree-open-task"');
    expect(markup).toContain('data-task-state="running"');
    expect(markup).toContain('class="tree-task-indicator tree-task-indicator-determinate task-state-running"');
    expect(markup).toContain('data-task-state="completed"');
    expect(markup).toContain('class="tree-task-indicator tree-task-indicator-static task-state-queued"');
    expect(markup).toContain('class="tree-task-indicator tree-task-indicator-static task-state-failed"');
    expect(markup).toContain('class="tree-task-indicator tree-task-indicator-static task-state-cancelled"');
    expect(markup).toContain('class="tree-task-indicator tree-task-indicator-determinate task-state-running" data-progress-mode="determinate" data-progress-percent="25"');
    expect(markup).toContain('<span class="task-state-label task-state-running">正在处理</span>');
    expect(markup).toContain('<span class="task-state-label task-state-completed">已完成</span>');
    expect(markup).toContain('<span class="task-state-label task-state-failed">失败</span>');
    expect(markup).toContain('aria-label="Lecture.pptx，正在处理 · 2/8 页"');
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
      onSelectTask: vi.fn(), onSelectPage: vi.fn(), onImport: vi.fn(), onCreateCourse: vi.fn()
    }));
    expect(markup).toContain('data-task-id="generation-job:job-1"');
    expect(markup).toContain('class="tree-task-section"');
    expect(markup).toContain('class="tree-task-indicator tree-task-indicator-indeterminate task-state-running"');
    expect(markup.indexOf("EE680")).toBeLessThan(markup.indexOf("生成任务 abc123"));
  });

  it("keeps current progress and failed tasks visible while collapsing completed task history", () => {
    const markup = renderToStaticMarkup(createElement(CourseTree, {
      tree: { workspaceId: "workspace-1", title: "课程空间", courses: [], rootMaterials: [], updatedAt: "2026-09-22T10:00:00.000Z" },
      backgroundTasks: [
        { id: "task-running", title: "Lecture.pptx", detail: "正在处理 · 2/8 页", state: "running" },
        { id: "task-failed", title: "Lecture.pptx", detail: "失败 · 第 3 页 · 上游超时", state: "failed", unresolved: true },
        { id: "task-recovered", title: "Old attempt.pptx", detail: "失败 · 后续重试已完成", state: "failed", unresolved: false },
        { id: "task-done", title: "Lecture.pptx", detail: "已完成 · 8/8 页", state: "completed" },
        { id: "task-cancelled", title: "Old attempt.pptx", detail: "已取消", state: "cancelled" }
      ],
      onSelectPage: vi.fn(), onImport: vi.fn(), onCreateCourse: vi.fn()
    }));

    expect(markup).toContain('aria-label="当前任务"');
    expect(markup).toContain('aria-label="需处理"');
    expect(markup).toContain('<details class="tree-task-attention" aria-label="需处理">');
    expect(markup).toContain("失败 · 第 3 页 · 上游超时");
    expect(markup).toContain('<details class="tree-task-history">');
    const attentionStart = markup.indexOf('aria-label="需处理"');
    const historyStart = markup.indexOf('<details class="tree-task-history">');
    const historyEnd = markup.indexOf("</details>", historyStart);
    const attentionMarkup = markup.slice(attentionStart, historyStart);
    const historyMarkup = markup.slice(historyStart, historyEnd);
    expect(attentionMarkup).toContain('data-task-id="task-failed"');
    expect(attentionMarkup).not.toContain('data-task-id="task-recovered"');
    expect(historyMarkup).toContain('data-task-id="task-failed"');
    expect(historyMarkup).toContain('data-task-id="task-recovered"');
    expect(historyMarkup).toContain('data-task-id="task-done"');
    expect(historyMarkup).toContain('data-task-id="task-cancelled"');
    expect(markup.indexOf('data-task-id="task-running"')).toBeLessThan(historyStart);
    expect(markup).not.toContain('<details class="tree-task-history" open');
    expect(markup).not.toContain('<details class="tree-task-attention" aria-label="需处理" open');
    expect(markup).not.toContain('data-action="tree-clear-failed-tasks"');
  });

  it("animates only unknown fresh running progress and sends a deduplicated failed-only clear request", () => {
    const failedTasks = [
      { id: "failed-1", title: "First failed.pdf", detail: "失败", state: "failed" as const },
      { id: "failed-2", title: "Second failed.pdf", detail: "失败", state: "failed" as const },
      { id: "done-1", title: "Completed.pdf", detail: "已完成", state: "completed" as const }
    ];
    expect(failedCourseTreeTaskIds([...failedTasks, { ...failedTasks[1]! }])).toEqual(["failed-1", "failed-2"]);

    const markup = renderToStaticMarkup(createElement(CourseTree, {
      tree: { workspaceId: "workspace-1", title: "课程空间", courses: [], rootMaterials: [], updatedAt: "2026-09-22T10:00:00.000Z" },
      backgroundTasks: [
        { id: "running-unknown", title: "Unknown.pdf", detail: "正在处理", state: "running", progress: { indeterminate: true } },
        { id: "running-stale", title: "Stale.pdf", detail: "正在处理", state: "running", progress: { indeterminate: true, stale: true } },
        { id: "failed-static", title: "Failed.pdf", detail: "失败", state: "failed", unresolved: true, progress: { indeterminate: true } },
        ...failedTasks.slice(0, 2)
      ],
      onClearFailed: vi.fn(),
      clearFailedBusy: true,
      onSelectPage: vi.fn(), onImport: vi.fn(), onCreateCourse: vi.fn()
    }));
    const taskButton = (taskId: string) => {
      const taskMarker = `data-task-id="${taskId}"`;
      const markerIndex = markup.indexOf(taskMarker);
      const rowStart = markup.lastIndexOf('<button type="button" class="tree-task-row', markerIndex);
      const rowEnd = markup.indexOf("</button>", markerIndex) + "</button>".length;
      return markup.slice(rowStart, rowEnd);
    };
    expect(taskButton("running-unknown")).toContain('data-progress-mode="indeterminate"');
    expect(taskButton("running-stale")).toContain('data-progress-mode="stale"');
    expect(taskButton("failed-static")).toContain('data-progress-mode="static"');
    expect(markup).toContain('class="tree-task-clear-failed" data-action="tree-clear-failed-tasks" disabled="" aria-busy="true" aria-label="清除失败任务（3）"');

    const disclosureRow = markup.indexOf('class="tree-task-disclosure-row"');
    const attentionEnd = markup.indexOf("</details>", disclosureRow);
    const clearAction = markup.indexOf('class="tree-task-clear-failed"', disclosureRow);
    expect(disclosureRow).toBeGreaterThanOrEqual(0);
    expect(clearAction).toBeGreaterThan(attentionEnd);
  });
});

describe("CourseTree workbench semantics", () => {
  it("exposes workspace headings, searchable input naming, current tree state, and stable row actions", () => {
    const material = {
      id: "material-current", kind: "material", title: "Linear Algebra", currentReleaseId: "release-current", releaseId: "release-current", children: [], capabilities: ["open_studio"]
    } as unknown as CourseTreeNode;
    const markup = renderToStaticMarkup(createElement(CourseTree, {
      tree: { workspaceId: "workspace-1", title: "EE680 Workspace", courses: [material], rootMaterials: [], updatedAt: "2026-10-09T10:00:00.000Z" },
      selectedPageId: "page-current",
      searchMaterials: [{ materialNodeId: material.id, releaseId: "release-current", version: 1, pages: [{ id: "page-current", pageNumber: 1, title: "Introduction" }] }],
      actions: { rename: vi.fn(), duplicate: vi.fn(), move: vi.fn(), trash: vi.fn(), openStudio: vi.fn(), openReadWeave: vi.fn(), history: vi.fn() },
      onSelectPage: vi.fn(), onImport: vi.fn(), onCreateCourse: vi.fn()
    }));

    expect(markup).toContain('<h2 class="sidebar-title" id="course-tree-title">课程</h2>');
    expect(markup).toContain('<h3 class="tree-toolbar-heading">项目文件</h3>');
    expect(markup).not.toContain('sidebar-footer');
    expect(markup).toContain('aria-label="筛选课程、材料或页面"');
    expect(markup).toContain('role="search" aria-label="筛选项目文件"');
    expect(markup).toContain('aria-label="项目文件"');
    expect(markup).toContain('data-action-slot="tree-project-actions"');
    expect(markup).toContain('data-action="tree-create-course"');
    expect(markup).toContain('data-action="tree-import-material"');
    expect(markup).not.toContain('data-action="tree-open-settings"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('aria-haspopup="menu" aria-expanded="false"');
    expect(markup).toContain('data-action-slot="tree-row-actions"');
    expect(markup).toContain('data-action="tree-open-material"');
    expect(markup).toContain('data-action="tree-open-actions"');
  });

  it("keeps current-version and runtime status in one compact row status beside an ellipsizable title", () => {
    const title = "A long current course material title that should stay on one tree row";
    const material = {
      id: "material-current", kind: "material", title, currentReleaseId: "release-current", releaseId: "release-current",
      revision: 5, status: "needs_review", children: [], capabilities: ["open_studio"]
    } as unknown as CourseTreeNode;
    const course = { id: "course-current", kind: "course", title: "EE680", children: [material], capabilities: [] } as unknown as CourseTreeNode;
    const markup = renderToStaticMarkup(createElement(CourseTree, {
      tree: { workspaceId: "workspace-1", title: "课程工作区", courses: [course], rootMaterials: [], updatedAt: "2026-10-09T10:00:00.000Z" },
      searchMaterials: [{ materialNodeId: material.id, releaseId: "release-current", version: 5, lifecycle: "published", pages: [] }],
      onSelectPage: vi.fn(), onImport: vi.fn(), onCreateCourse: vi.fn()
    }));
    const rowButton = markup.slice(markup.lastIndexOf("<button", markup.indexOf('data-action="tree-open-material"')), markup.indexOf("</button>", markup.indexOf('data-action="tree-open-material"')) + "</button>".length);

    expect(rowButton).toContain(`title="${title}"`);
    expect(rowButton).toContain('data-publication-status="published"');
    expect(rowButton).toContain('data-runtime-status="needs_review"');
    expect(rowButton).toContain('aria-label="材料版本：已发布 v5；材料状态：需要审核"');
    expect(rowButton).toContain('title="材料版本：已发布 v5；材料状态：需要审核"');
    expect(rowButton).toContain("已发布 · 待审");
    expect(rowButton.match(/class="status-dot/g)).toHaveLength(1);
  });

  it("supports wrapped arrow movement, Home/End, and Escape for context menus", () => {
    expect(resolveTreeMenuKeyAction("ArrowDown", 1, 3)).toEqual({ kind: "focus", index: 2 });
    expect(resolveTreeMenuKeyAction("ArrowDown", 2, 3)).toEqual({ kind: "focus", index: 0 });
    expect(resolveTreeMenuKeyAction("ArrowUp", 0, 3)).toEqual({ kind: "focus", index: 2 });
    expect(resolveTreeMenuKeyAction("Home", 2, 3)).toEqual({ kind: "focus", index: 0 });
    expect(resolveTreeMenuKeyAction("End", 0, 3)).toEqual({ kind: "focus", index: 2 });
    expect(resolveTreeMenuKeyAction("Escape", 1, 3)).toEqual({ kind: "close", restoreFocus: true });
    expect(resolveTreeMenuKeyAction("ArrowDown", -1, 0)).toEqual({ kind: "none" });
  });
});

describe("CourseTree search navigation", () => {
  const currentMaterial = {
    id: "material-current", kind: "material", title: "Linear Algebra", currentReleaseId: "release-current", releaseId: "release-current",
    revision: 4, status: "draft", children: []
  } as unknown as CourseTreeNode;
  const treeNodes = [
    {
      id: "course-1", kind: "course", title: "EE680", status: "published", children: [
        currentMaterial,
        { id: "material-archived", kind: "material", title: "Archived Linear Algebra", archived: true, children: [] },
        { id: "release-history", kind: "release", title: "Historical Release", children: [{ id: "old-page", kind: "page", title: "Archived Eigenvalues", pageId: "old-page", releaseId: "release-old", children: [] }] }
      ]
    } as unknown as CourseTreeNode,
    { id: "trash", kind: "trash", title: "Trash Eigenvalues", children: [] } as unknown as CourseTreeNode
  ];
  const searchMaterials: CourseTreeSearchMaterial[] = [
    { materialNodeId: "material-current", releaseId: "release-current", version: 4, lifecycle: "draft_source", pages: [{ id: "page-current", pageNumber: 7, title: "Eigenvalues and Stability" }] },
    { materialNodeId: "material-current", releaseId: "release-old", version: 3, lifecycle: "published", pages: [{ id: "page-old", pageNumber: 6, title: "Archived Eigenvalues" }] }
  ];

  it("returns current page targets while excluding archived, trash, and release history", () => {
    const results = buildCourseTreeSearchResults(treeNodes, "eigenvalues", searchMaterials);

    expect(results.map(({ node }) => node.pageId)).toEqual(["page-current"]);
    expect(results[0]?.node.releaseId).toBe("release-current");
    expect(resolveCourseTreeSearchActivation(results[0]!.node)).toEqual({ kind: "page", releaseId: "release-current", pageId: "page-current" });
    expect(results[0]?.detail).toContain("草稿");
    expect(results[0]?.detail).not.toContain("v4");
    expect(buildCourseTreeSearchResults(treeNodes, "trash", searchMaterials)).toHaveLength(0);
    expect(buildCourseTreeSearchResults(treeNodes, "archived", searchMaterials)).toHaveLength(0);
  });

  it("keeps the ordinary tree at the material level and highlights the material containing the selected page", () => {
    const markup = renderToStaticMarkup(createElement(CourseTree, {
      tree: { workspaceId: "workspace-1", title: "课程空间", courses: treeNodes.slice(0, 1), rootMaterials: [], updatedAt: "2026-09-30T10:00:00.000Z" },
      selectedPageId: "page-current",
      searchMaterials,
      actions: { openMaterial: vi.fn(), rename: vi.fn(), duplicate: vi.fn(), move: vi.fn(), trash: vi.fn(), openStudio: vi.fn(), openReadWeave: vi.fn(), history: vi.fn() },
      onSelectPage: vi.fn(), onImport: vi.fn(), onCreateCourse: vi.fn()
    }));

    expect(markup).not.toContain('data-node-id="page-current"');
    expect(markup).toContain('data-node-id="material-current"');
    expect(markup).toContain('data-action="tree-open-material"');
    const selectedMaterialRow = markup.slice(markup.indexOf('data-node-id="material-current"'), markup.indexOf('</div>', markup.indexOf('data-node-id="material-current"')));
    expect(selectedMaterialRow).toContain('class="tree-row selected ');
    expect(selectedMaterialRow).toContain('aria-current="page"');
  });

  it("wraps arrow selection and resolves page, material, and course activation to their intended actions", () => {
    expect(moveSearchIndex(0, -1, 3)).toBe(2);
    expect(moveSearchIndex(2, 1, 3)).toBe(0);
    expect(moveSearchIndex(-1, 1, 3)).toBe(0);
    expect(moveSearchIndex(0, 1, 0)).toBe(-1);

    expect(resolveCourseTreeSearchActivation({ id: "page", kind: "page", title: "Page", pageId: "page-9", releaseId: "release-2", children: [] } as CourseTreeNode))
      .toEqual({ kind: "page", releaseId: "release-2", pageId: "page-9" });
    expect(resolveCourseTreeSearchActivation(currentMaterial))
      .toEqual({ kind: "material", node: currentMaterial, restoreReadingPosition: true });
    expect(resolveCourseTreeSearchActivation(treeNodes[0]!)).toEqual({ kind: "container" });
  });

  it("maps search arrows, Enter, Escape, and typing without navigating while typing", () => {
    const results = buildCourseTreeSearchResults(treeNodes, "eigenvalues", searchMaterials);
    const down = resolveSearchInputKeyAction("ArrowDown", 0, results.length + 1);
    const up = resolveSearchInputKeyAction("ArrowUp", 0, results.length + 1);
    const enter = resolveSearchInputKeyAction("Enter", 0, results.length);

    expect(down).toEqual({ kind: "move", index: 1 });
    expect(up).toEqual({ kind: "move", index: 1 });
    expect(enter).toEqual({ kind: "activate", index: 0 });
    expect(results[enter.kind === "activate" ? enter.index : -1]?.node).toMatchObject({ pageId: "page-current", releaseId: "release-current" });
    expect(resolveSearchInputKeyAction("Escape", 0, results.length)).toEqual({ kind: "close" });
    expect(resolveSearchInputKeyAction("e", 0, results.length)).toEqual({ kind: "none" });
    expect(resolveSearchInputKeyAction("Enter", 0, 0)).toEqual({ kind: "none" });
  });

  it("leaves IME navigation keys to composition and clears a query before closing search", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Enter", "Escape"]) {
      expect(resolveSearchInputKeyAction(key, 0, 2, { isComposing: true, hasQuery: true, searchOpen: true })).toEqual({ kind: "none" });
    }
    expect(resolveSearchInputKeyAction("Escape", 0, 2, { hasQuery: true, searchOpen: false })).toEqual({ kind: "close" });
    expect(resolveSearchInputKeyAction("Escape", 0, 0, { hasQuery: false, searchOpen: true })).toEqual({ kind: "close" });
    expect(resolveSearchInputKeyAction("Escape", 0, 0, { hasQuery: false, searchOpen: false })).toEqual({ kind: "none" });
    expect(resolveSearchInputKeyAction("Enter", 0, 2, { searchOpen: false })).toEqual({ kind: "none" });
  });

  it("shows version publication labels on materials only and keeps review status separate", () => {
    const publishedMaterial = {
      id: "material-published", kind: "material", title: "Published Material", currentReleaseId: "release-published", revision: 8,
      status: "needs_review", children: []
    } as unknown as CourseTreeNode;
    const draft = { ...currentMaterial, id: "material-draft", title: "Draft Material", currentReleaseId: "release-draft", revision: 4 };
    const markup = renderToStaticMarkup(createElement(CourseTree, {
      tree: { workspaceId: "workspace-1", title: "课程空间", courses: [{ ...treeNodes[0]!, children: [publishedMaterial, draft] }], rootMaterials: [], updatedAt: "2026-09-30T10:00:00.000Z" },
      searchMaterials: [
        { materialNodeId: "material-published", releaseId: "release-published", version: 8, lifecycle: "published", pages: [] },
        { materialNodeId: "material-draft", releaseId: "release-draft", version: 4, lifecycle: "draft_source", pages: [] }
      ],
      onSelectPage: vi.fn(), onImport: vi.fn(), onCreateCourse: vi.fn()
    }));

    expect(markup).toContain("已发布 v8");
    expect(markup).toContain("草稿");
    expect(markup).not.toContain("草稿 v4");
    expect(markup).not.toContain("材料版本：草稿 v4");
    expect(markup).toContain("材料状态：需要审核");
    expect(markup).toContain("材料来源已保存；草稿标签不代表讲解已生成");
    expect(markup).not.toContain('aria-label="状态：已发布"');
    expect(markup).not.toContain('aria-label="材料版本：已发布 v0"');
    const courseButtonStart = markup.indexOf('<button class="tree-main-button"');
    const courseButtonEnd = markup.indexOf("</button>", courseButtonStart);
    expect(markup.slice(courseButtonStart, courseButtonEnd)).not.toContain('class="status-dot');
  });

  it("retains a revision label on a historical draft page", () => {
    const historicalDraft = {
      ...currentMaterial,
      children: [{ id: "old-draft-page", kind: "page", title: "Archived draft page", pageId: "old-draft-page", releaseId: "release-old-draft", children: [] }]
    } as unknown as CourseTreeNode;
    const results = buildCourseTreeSearchResults([historicalDraft], "Archived draft page", [
      { materialNodeId: historicalDraft.id, releaseId: "release-old-draft", version: 3, lifecycle: "draft_source", pages: [{ id: "old-draft-page", pageNumber: 2, title: "Archived draft page" }] }
    ]);
    expect(results[0]?.detail).toContain("草稿 v3");
  });

  it("retains the published revision label on a historical page", () => {
    const historicalPage = {
      ...currentMaterial,
      children: [{ id: "published-history-page", kind: "page", title: "Published history page", pageId: "published-history-page", releaseId: "release-published-history", children: [] }]
    } as unknown as CourseTreeNode;
    const results = buildCourseTreeSearchResults([historicalPage], "Published history page", [
      { materialNodeId: historicalPage.id, releaseId: "release-published-history", version: 6, lifecycle: "published", pages: [{ id: "published-history-page", pageNumber: 4, title: "Published history page" }] }
    ]);
    expect(results[0]?.detail).toContain("已发布 v6");
  });
});

describe("shared directional chevron icon", () => {
  it("uses distinct centered paths so named directions do not depend on CSS compensation", () => {
    const names = ["chevronRight", "chevronDown", "chevronLeft", "chevronUp"] as const;
    const paths = names.map((name) => renderToStaticMarkup(createElement(Icon, { name })).match(/<path d="([^"]+)"/)?.[1]);
    expect(new Set(paths).size).toBe(4);
    expect(paths[0]).toBe("m8.5 5 7 7-7 7");
  });
});
