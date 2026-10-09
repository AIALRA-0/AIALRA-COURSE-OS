import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { CourseTreeNode, TreeNodeCapability, WorkspaceTree } from "@course-os/contracts";
import { Icon } from "./Icon.js";
import "./course-navigator.css";
import { importTaskStateLabel, type ImportTaskState } from "./import-progress.js";

export interface CourseTreeTaskProgress {
  percent?: number;
  completed?: number;
  total?: number;
  indeterminate?: boolean;
  stale?: boolean;
}

export type CourseTreeTask = { id: string; courseId?: string; parentNodeId?: string; title: string; detail: string; state: ImportTaskState; unresolved?: boolean; progress?: CourseTreeTaskProgress };

export interface CourseTreeActions {
  createModule?: (course: CourseTreeNode) => void;
  importMaterial?: (node: CourseTreeNode) => void;
  rename: (node: CourseTreeNode) => void;
  duplicate: (node: CourseTreeNode) => void;
  move: (node: CourseTreeNode) => void;
  moveTo?: (node: CourseTreeNode, parentId: string | null, sortOrder?: number) => void;
  reorder?: (node: CourseTreeNode, direction: "up" | "down") => void;
  trash: (node: CourseTreeNode) => void;
  openStudio: (node: CourseTreeNode) => void;
  openMaterial?: (node: CourseTreeNode, options?: { restoreReadingPosition?: boolean }) => void;
  openReadWeave: (node: CourseTreeNode) => void;
  history: (node: CourseTreeNode) => void;
  properties?: (node: CourseTreeNode) => void;
  openTrash?: () => void;
}

export interface CourseTreeSearchMaterial {
  materialNodeId: string;
  releaseId: string;
  version: number;
  lifecycle?: "draft_source" | "published";
  pages: Array<{ id: string; pageNumber: number; title: string }>;
}

export interface CourseTreeSearchResult {
  id: string;
  node: CourseTreeNode;
  label: string;
  detail: string;
}

type TreeMenuState = { node: CourseTreeNode; x: number; y: number; restoreFocusTo?: HTMLElement };

export type TreeMenuKeyAction = { kind: "focus"; index: number } | { kind: "close"; restoreFocus: boolean } | { kind: "none" };

export function resolveTreeMenuKeyAction(key: string, activeIndex: number, itemCount: number): TreeMenuKeyAction {
  if (key === "Escape") return { kind: "close", restoreFocus: true };
  if (itemCount <= 0) return { kind: "none" };
  if (key === "Home") return { kind: "focus", index: 0 };
  if (key === "End") return { kind: "focus", index: itemCount - 1 };
  if (key === "ArrowDown") return { kind: "focus", index: (activeIndex + 1 + itemCount) % itemCount };
  if (key === "ArrowUp") return { kind: "focus", index: (activeIndex - 1 + itemCount) % itemCount };
  return { kind: "none" };
}

const treeStatusPresentation = {
  published: { icon: "check", label: "已发布", visibleLabel: "已发布" },
  draft: { icon: "document", label: "草稿", visibleLabel: "草稿" },
  syncing: { icon: "history", label: "正在同步", visibleLabel: "同步" },
  needs_review: { icon: "review", label: "需要审核", visibleLabel: "待审" },
  conflict: { icon: "warning", label: "存在冲突", visibleLabel: "冲突" }
} as const;

export function CourseTree({ tree, selectedPageId, selectedTaskId, backgroundTasks = [], searchMaterials = [], onSelectTask, onClearFailed, clearFailedBusy = false, collapsed = false, onCollapse, sidebarWidth, sidebarMaxWidth = 640, onResizeStart, onResizeKeyboard, onSelectPage, onImport, onCreateCourse, actions }: {
  tree?: WorkspaceTree;
  selectedPageId?: string;
  selectedTaskId?: string;
  backgroundTasks?: CourseTreeTask[];
  searchMaterials?: CourseTreeSearchMaterial[];
  onSelectTask?: (taskId: string) => void;
  onClearFailed?: (requestedIds: string[]) => void;
  clearFailedBusy?: boolean;
  collapsed?: boolean;
  onCollapse?: () => void;
  sidebarWidth?: number;
  sidebarMaxWidth?: number;
  onResizeStart?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeKeyboard?: (delta: number) => void;
  onSelectPage: (releaseId: string, pageId: string) => void;
  onImport: () => void;
  onCreateCourse: () => void;
  actions?: CourseTreeActions;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const rootNodes = useMemo(() => [...(tree?.courses ?? []), ...(tree?.rootMaterials ?? [])], [tree]);
  const searchableNodes = useMemo(() => addSearchPageNodes(rootNodes, searchMaterials, Boolean(query.trim())), [rootNodes, searchMaterials, query]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(rootNodes.flatMap((node) => [node.id, ...collectExpandable(node)])));
  const [menu, setMenu] = useState<TreeMenuState>();
  const [focusedNodeId, setFocusedNodeId] = useState<string>();
  const [pendingScrollNodeId, setPendingScrollNodeId] = useState<string>();
  const [draggingNodeId, setDraggingNodeId] = useState<string>();
  const [pointerDraggingNodeId, setPointerDraggingNodeId] = useState<string>();
  const [dropTargetId, setDropTargetId] = useState<string>();
  const [dragAnnouncement, setDragAnnouncement] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const searchContainer = useRef<HTMLDivElement>(null);
  const visibleNodes = useMemo(() => {
    return query.trim() ? filterTree(searchableNodes.filter(isSearchableNode), query) : searchableNodes;
  }, [query, searchableNodes]);
  const searchResults = useMemo(() => buildCourseTreeSearchResults(searchableNodes, query, searchMaterials), [searchableNodes, query, searchMaterials]);

  useEffect(() => {
    if (!tree) return;
    setExpanded((current) => new Set([...current, ...rootNodes.flatMap((node) => [node.id, ...collectExpandable(node)])]));
  }, [rootNodes, tree]);

  useEffect(() => {
    const close = (event: globalThis.MouseEvent) => {
      if (!searchContainer.current?.contains(event.target as Node)) setSearchOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  useEffect(() => {
    if (!pendingScrollNodeId) return;
    const target = [...document.querySelectorAll<HTMLElement>("[data-node-id]")]
      .find((element) => element.dataset.nodeId === pendingScrollNodeId);
    if (!target) return;
    target.scrollIntoView?.({ block: "nearest" });
    setPendingScrollNodeId(undefined);
  }, [pendingScrollNodeId, selectedPageId, visibleNodes]);

  useEffect(() => {
    if (!selectedPageId) return;
    const selectedPageNode = query.trim()
      ? flattenSearchableTree(searchableNodes).find((node) => node.pageId === selectedPageId)
      : undefined;
    const selectedNode = selectedPageNode ?? findCurrentMaterialForPage(rootNodes, searchMaterials, selectedPageId);
    if (!selectedNode) return;
    const path = findTreePath(searchableNodes, selectedNode.id);
    setExpanded((current) => new Set([...current, ...path.map((node) => node.id)]));
    setPendingScrollNodeId(selectedNode.id);
  }, [selectedPageId, searchableNodes, rootNodes, searchMaterials, query]);

  useEffect(() => {
    const close = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".tree-context-menu")) return;
      setMenu(undefined);
    };
    document.addEventListener("pointerdown", close);
    const closeOnBlur = () => setMenu(undefined);
    window.addEventListener("blur", closeOnBlur);
    return () => { document.removeEventListener("pointerdown", close); window.removeEventListener("blur", closeOnBlur); };
  }, []);

  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
    setActiveSearchIndex(0);
  };

  const clearSearchAndFocus = () => {
    closeSearch();
    searchInput.current?.focus();
  };

  const activateSearchNode = (node: CourseTreeNode) => {
    const activation = resolveCourseTreeSearchActivation(node);
    const targetNode = node.kind === "page" && node.parentId ? node.parentId : node.id;
    const path = findTreePath(searchableNodes, targetNode);
    setExpanded((current) => new Set([...current, ...path.map((item) => item.id), ...(node.kind === "page" ? [node.id] : [])]));
    setFocusedNodeId(node.id);
    setPendingScrollNodeId(node.id);
    if (activation.kind === "page") {
      onSelectPage(activation.releaseId, activation.pageId);
      closeSearch();
      return;
    }
    if (activation.kind === "material") {
      actions?.openMaterial?.(activation.node, { restoreReadingPosition: true });
      closeSearch();
      return;
    }
    // A course or folder result locates and expands its subtree without choosing a child page.
    closeSearch();
  };

  const activateSearchResult = (result: CourseTreeSearchResult) => activateSearchNode(result.node);

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const isComposing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
    const action = resolveSearchInputKeyAction(event.key, activeSearchIndex, searchResults.length, {
      isComposing,
      hasQuery: query.length > 0,
      searchOpen
    });
    if (action.kind === "none") {
      if (isComposing && ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) event.stopPropagation();
      return;
    }
    if (action.kind === "move") {
      event.preventDefault();
      setSearchOpen(true);
      setActiveSearchIndex(action.index);
      return;
    }
    if (action.kind === "activate") {
      event.preventDefault();
      activateSearchResult(searchResults[action.index]!);
      return;
    }
    if (action.kind === "close") {
      event.preventDefault();
      event.stopPropagation();
      if (query.length > 0) clearSearchAndFocus();
      else {
        setSearchOpen(false);
        setActiveSearchIndex(0);
        searchInput.current?.focus();
      }
    }
  };

  const openMenu = (node: CourseTreeNode, event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 270;
    const height = 380;
    const restoreFocusTo = event.currentTarget instanceof HTMLButtonElement
      ? event.currentTarget
      : event.currentTarget.querySelector<HTMLButtonElement>(".tree-main-button") ?? undefined;
    setFocusedNodeId(node.id);
    setMenu({ node, x: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)), restoreFocusTo });
  };

  const closeMenu = (restoreFocus = false) => {
    const target = menu?.restoreFocusTo;
    setMenu(undefined);
    if (restoreFocus && target) window.requestAnimationFrame(() => target.focus());
  };

  const allNodes = useMemo(() => [...rootNodes, ...(tree?.trash ? [tree.trash] : [])], [rootNodes, tree]);
  const findNode = (nodeId: string): CourseTreeNode | undefined => flattenTree(allNodes).find(({ node }) => node.id === nodeId)?.node;
  const finishDrag = () => { setDraggingNodeId(undefined); setPointerDraggingNodeId(undefined); setDropTargetId(undefined); setDragAnnouncement(""); };
  const handleDrop = (target?: CourseTreeNode) => {
    const source = (pointerDraggingNodeId || draggingNodeId) ? findNode(pointerDraggingNodeId || draggingNodeId!) : undefined;
    if (!source || !actions?.moveTo || !isDraggableNode(source)) return finishDrag();
    if (target && !isValidDrop(source, target)) return finishDrag();
    if (target?.kind === "trash") {
      actions.trash(source);
      return finishDrag();
    }
    const parentId = source.kind === "course" ? null : target?.kind === "course" ? target.id : target?.kind === "material" ? target.parentId ?? null : null;
    const sortOrder = target?.kind === "material" || target?.kind === "course" ? (target.sortOrder ?? 0) - 0.5 : target?.sortOrder;
    actions.moveTo(source, parentId, sortOrder);
    finishDrag();
  };

  useEffect(() => {
    if (!pointerDraggingNodeId) return;
    const updateTargetFromPoint = (event: PointerEvent) => {
      const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-node-id]");
      const target = element ? findNode(element.dataset.nodeId || "") : undefined;
      if (target && target.id !== pointerDraggingNodeId && isValidDrop(findNode(pointerDraggingNodeId)!, target)) setDropTargetId(target.id);
      else setDropTargetId(undefined);
    };
    const finishPointerDrop = (event: PointerEvent) => {
      const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-node-id]");
      const target = element ? findNode(element.dataset.nodeId || "") : undefined;
      handleDrop(target);
    };
    window.addEventListener("pointermove", updateTargetFromPoint);
    window.addEventListener("pointerup", finishPointerDrop, { once: true });
    window.addEventListener("pointercancel", finishDrag, { once: true });
    return () => {
      window.removeEventListener("pointermove", updateTargetFromPoint);
      window.removeEventListener("pointerup", finishPointerDrop);
      window.removeEventListener("pointercancel", finishDrag);
    };
  }, [pointerDraggingNodeId, allNodes, actions]);

  if (collapsed) return <aside className="course-sidebar course-sidebar-collapsed course-navigator" aria-label="课程项目树已收起">
    <button type="button" className="sidebar-expand-button" data-action="tree-expand" onClick={onCollapse} aria-label="展开课程项目树" title="展开课程项目树"><Icon name="chevronRight" /></button>
    <button type="button" className="sidebar-rail-button" data-action="tree-create-course" onClick={onCreateCourse} aria-label="新建课程" title="新建课程"><Icon name="plus" /></button>
    <button type="button" className="sidebar-rail-button" data-action="tree-import-material" onClick={onImport} aria-label="导入材料" title="导入材料"><Icon name="upload" /></button>
  </aside>;

  return <aside className="course-sidebar course-navigator" aria-labelledby="course-tree-title">
    <header className="sidebar-heading">
      <div className="course-navigator-title"><Icon name="book" /><h2 className="sidebar-title" id="course-tree-title">课程</h2></div>
      <div className="sidebar-heading-actions" data-action-slot="tree-heading-actions">
        <button type="button" className="icon-button" data-action="tree-collapse" aria-label="收起课程项目树" onClick={onCollapse} title="收起课程项目树"><Icon name="chevronLeft" /></button>
      </div>
    </header>

    <div ref={searchContainer} className="tree-search-slot" data-action-slot="tree-search" role="search" aria-label="筛选项目文件">
      <div className="tree-search">
        <Icon name="search" />
        <input
          ref={searchInput}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActiveSearchIndex(0); setSearchOpen(true); }}
          onFocus={() => { if (query) setSearchOpen(true); }}
          onKeyDown={onSearchKeyDown}
          aria-label="筛选课程、材料或页面"
          placeholder="筛选课程、材料或页面"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={searchOpen && Boolean(query.trim())}
          aria-controls={searchOpen && Boolean(query.trim()) ? "course-tree-search-results" : undefined}
          aria-activedescendant={searchOpen && searchResults[activeSearchIndex] ? `course-tree-search-result-${activeSearchIndex}` : undefined}
        />
        {query.length > 0 && <button type="button" className="tree-search-clear" data-action="tree-search-clear" data-action-slot="tree-search-clear" aria-label="清除搜索内容" title="清除搜索内容" onClick={clearSearchAndFocus}><Icon name="close" /></button>}
      </div>
      {searchOpen && query.trim() && <div id="course-tree-search-results" className="tree-search-results" role="listbox" aria-label="课程树搜索结果">
        {searchResults.length === 0 ? <div className="tree-search-empty" role="status">没有匹配的课程、材料或页面</div> : searchResults.map((result, index) => <button
          key={result.id}
          id={`course-tree-search-result-${index}`}
          type="button"
          className="tree-search-result"
          role="option"
          aria-selected={index === activeSearchIndex}
          data-action="tree-search-result"
          data-result-kind={result.node.kind}
          onMouseEnter={() => setActiveSearchIndex(index)}
          onClick={() => activateSearchResult(result)}
        ><strong className="tree-search-result-title">{result.label}</strong><small className="tree-search-result-detail">{result.detail}</small></button>)}
      </div>}
    </div>

    <div className="tree-toolbar" role="group" aria-label="项目文件工具">
      <div className="tree-toolbar-title"><Icon name="folder" /><h3 className="tree-toolbar-heading">项目文件</h3></div>
      <div className="tree-toolbar-actions" data-action-slot="tree-project-actions">
        <button type="button" className="tree-toolbar-action" data-action="tree-create-course" onClick={onCreateCourse} aria-label="新建课程" title="新建课程"><Icon name="plus" /></button>
        <button type="button" className="tree-toolbar-action" data-action="tree-import-material" onClick={onImport} aria-label="导入材料" title="导入材料"><Icon name="upload" /></button>
      </div>
    </div>

    <div className="tree-scroll">
      <nav aria-label="项目文件">
      {visibleNodes.length === 0 && <div className="tree-empty"><Icon name="search" /><span>{!tree ? "正在载入课程目录" : query ? "没有匹配的课程、材料或页面" : "还没有课程或材料"}</span></div>}
      {visibleNodes.map((node) => <TreeNode key={node.id} node={node} allNodes={allNodes} searchMaterials={searchMaterials} searchActive={Boolean(query.trim())} onActivateSearch={activateSearchNode} depth={0} expanded={expanded} selectedPageId={selectedPageId} focusedNodeId={focusedNodeId} openMenuNodeId={menu?.node.id} onFocus={setFocusedNodeId} onToggle={toggle} onSelectPage={onSelectPage} onOpenMenu={openMenu} forceOpen={Boolean(query.trim())} actions={actions} draggingNodeId={draggingNodeId} pointerDraggingNodeId={pointerDraggingNodeId} dropTargetId={dropTargetId} onDragStart={(item) => { setDraggingNodeId(item.id); setDragAnnouncement(`正在拖动 ${item.title}，请移动到课程或材料上`); }} onPointerDragStart={(item) => { setPointerDraggingNodeId(item.id); setDragAnnouncement(`正在拖动 ${item.title}，请移动到课程或材料上`); }} onDragOver={(item) => setDropTargetId(item.id)} onDrop={handleDrop} onDragEnd={finishDrag} />)}
      {!query.trim() && tree?.trash && <TreeNode key={tree.trash.id} node={tree.trash} allNodes={allNodes} searchMaterials={searchMaterials} searchActive={false} onActivateSearch={activateSearchNode} depth={0} expanded={expanded} selectedPageId={selectedPageId} focusedNodeId={focusedNodeId} openMenuNodeId={menu?.node.id} onFocus={setFocusedNodeId} onToggle={toggle} onSelectPage={onSelectPage} onOpenMenu={openMenu} forceOpen={false} actions={actions} draggingNodeId={draggingNodeId} pointerDraggingNodeId={pointerDraggingNodeId} dropTargetId={dropTargetId} onDragStart={(node) => { setDraggingNodeId(node.id); setDragAnnouncement(`正在拖动 ${node.title}，请移动到课程或材料上`); }} onPointerDragStart={(node) => { setPointerDraggingNodeId(node.id); setDragAnnouncement(`正在拖动 ${node.title}，请移动到课程或材料上`); }} onDragOver={(node) => setDropTargetId(node.id)} onDrop={handleDrop} onDragEnd={finishDrag} />}
      </nav>
      <TaskRows tasks={backgroundTasks} query={query} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} onClearFailed={onClearFailed} clearFailedBusy={clearFailedBusy} />
    </div>

    <div className="course-bottom-space" aria-hidden="true" />
    {onResizeStart && <div
      className="sidebar-resize-handle"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-valuemin={180}
      aria-valuemax={sidebarMaxWidth}
      aria-valuenow={sidebarWidth}
      aria-label="调整课程树宽度"
      title="拖动调整课程树宽度；键盘使用左右箭头"
      onPointerDown={onResizeStart}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          onResizeKeyboard?.(event.key === "ArrowRight" ? 16 : -16);
        }
      }}
    />}
    <div className="sr-only" aria-live="polite" id="tree-drag-status">{dragAnnouncement}</div>
    {menu && actions && <TreeContextMenu menu={menu} actions={actions} onClose={closeMenu} />}
  </aside>;
}

function TaskRows({ tasks, query, selectedTaskId, onSelectTask, onClearFailed, clearFailedBusy }: {
  tasks: CourseTreeTask[]; query: string; selectedTaskId?: string;
  onSelectTask?: (taskId: string) => void;
  onClearFailed?: (requestedIds: string[]) => void;
  clearFailedBusy: boolean;
}) {
  const needle = query.trim().toLocaleLowerCase();
  const matchesQuery = (task: CourseTreeTask) => !needle || `${task.title} ${task.detail}`.toLocaleLowerCase().includes(needle);
  const current = tasks.filter((task) => task.state === "queued" || task.state === "running" || task.state === "paused" || task.state === "awaiting_review").filter(matchesQuery);
  const needsAttention = tasks.filter((task) => task.state === "failed" && task.unresolved === true).filter(matchesQuery);
  const history = needle ? [] : tasks.filter((task) => task.state === "completed" || task.state === "cancelled" || task.state === "failed").filter(matchesQuery);
  const failedIds = failedCourseTreeTaskIds(tasks);
  if (current.length + needsAttention.length + history.length === 0) return null;
  return <section className="tree-task-section" aria-labelledby="tree-task-section-heading">
    <h3 className="sr-only" id="tree-task-section-heading">后台任务</h3>
    {current.length > 0 && <TaskGroup title="当前任务" tasks={current} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />}
    {(needsAttention.length > 0 || (failedIds.length > 0 && onClearFailed)) && <div className="tree-task-disclosure-row">
      {needsAttention.length > 0
        ? <details className="tree-task-attention" aria-label="需处理" open={Boolean(query)}>
          <summary><span className="tree-task-summary-chevron" aria-hidden="true"><Icon name="chevronRight" /></span><span>需处理的更新</span><span className="tree-task-count">{needsAttention.length}</span></summary>
          <TaskList tasks={needsAttention} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />
        </details>
        : failedIds.length > 0 && onClearFailed && <span className="tree-task-failure-label">失败任务</span>}
      {onClearFailed && failedIds.length > 0 && <button
        type="button"
        className="tree-task-clear-failed"
        data-action="tree-clear-failed-tasks"
        disabled={clearFailedBusy}
        aria-busy={clearFailedBusy || undefined}
        aria-label={`清除失败任务（${failedIds.length}）`}
        title={clearFailedBusy ? "正在清除失败任务" : "清除全部当前失败任务"}
        onClick={() => onClearFailed(failedIds)}
      ><Icon name="trash" /><span>清除失败</span><span className="tree-task-count">{failedIds.length}</span></button>}
    </div>}
    {history.length > 0 && <details className="tree-task-history" open={Boolean(query)}>
      <summary><span className="tree-task-summary-chevron" aria-hidden="true"><Icon name="chevronRight" /></span><span>历史记录</span><span className="tree-task-count">{history.length}</span></summary>
      <TaskList tasks={history} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />
    </details>}
  </section>;
}

function TaskGroup({ title, tasks, selectedTaskId, onSelectTask }: {
  title: string; tasks: CourseTreeTask[]; selectedTaskId?: string; onSelectTask?: (taskId: string) => void;
}) {
  return <div className="tree-task-group" role="group" aria-label={title}>
    <div className="tree-task-heading"><span role="heading" aria-level={4}>{title}</span><span className="tree-task-count">{tasks.length}</span></div>
    <TaskList tasks={tasks} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />
  </div>;
}

function TaskList({ tasks, selectedTaskId, onSelectTask }: {
  tasks: CourseTreeTask[]; selectedTaskId?: string; onSelectTask?: (taskId: string) => void;
}) {
  return <div className="tree-task-list">{tasks.map((task) => {
    const stateLabel = importTaskStateLabel(task.state);
    const detail = task.detail.trim().startsWith(stateLabel)
      ? task.detail.trim().slice(stateLabel.length).replace(/^\s*(?:[·:：—-]\s*)?/, "").trim()
      : task.detail;
    const progress = courseTreeTaskProgressLabel(task.progress);
    const progressPercent = courseTreeTaskProgressPercent(task.progress);
    const visibleProgress = progress && !detail.includes(progress) ? progress : undefined;
    const summary = [stateLabel, visibleProgress, detail].filter(Boolean).join(" · ");
    return <div className="tree-task-entry" key={task.id}>
      <button
        type="button"
        className={`tree-task-row ${selectedTaskId === task.id ? "selected" : ""}`}
        data-action="tree-open-task"
        data-task-id={task.id}
        data-task-state={task.state}
        onClick={() => onSelectTask?.(task.id)}
        aria-current={selectedTaskId === task.id ? "page" : undefined}
        aria-label={`${task.title}，${summary}`}
        title={`${task.title} · ${summary}`}
      ><TaskProgressIndicator task={task} percent={progressPercent} /><span className="tree-task-copy"><strong>{task.title}</strong><small><span className={`task-state-label task-state-${task.state}`}>{stateLabel}</span>{visibleProgress && <span className="tree-task-progress">{visibleProgress}</span>}<span>{detail}</span></small></span><Icon name="chevronRight" /></button>
    </div>;
  })}</div>;
}

function courseTreeTaskProgressLabel(progress?: CourseTreeTaskProgress): string | undefined {
  if (!progress) return undefined;
  const hasCount = Number.isFinite(progress.completed) && Number.isFinite(progress.total)
    && progress.total! > 0 && progress.completed! >= 0 && progress.completed! <= progress.total!;
  const percent = validProgressPercent(progress.percent);
  return hasCount ? `${progress.completed}/${progress.total}` : percent === undefined ? undefined : `${percent}%`;
}

function courseTreeTaskProgressPercent(progress?: CourseTreeTaskProgress): number | undefined {
  if (!progress) return undefined;
  const percent = validProgressPercent(progress.percent);
  if (percent !== undefined) return percent;
  if (!Number.isFinite(progress.completed) || !Number.isFinite(progress.total)
    || progress.total! <= 0 || progress.completed! < 0 || progress.completed! > progress.total!) return undefined;
  return Math.round(progress.completed! / progress.total! * 100);
}

function validProgressPercent(value?: number): number | undefined {
  return Number.isFinite(value) && value! >= 0 && value! <= 100 ? Math.round(value!) : undefined;
}

function TaskProgressIndicator({ task, percent }: { task: CourseTreeTask; percent?: number }) {
  const stale = task.progress?.stale === true;
  const indeterminate = task.state === "running" && percent === undefined && !stale && task.progress?.indeterminate !== false;
  const mode = percent !== undefined ? "determinate" : indeterminate ? "indeterminate" : stale ? "stale" : "static";
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const dashLength = percent === undefined ? 0 : circumference * percent / 100;
  return <svg
    className={`tree-task-indicator tree-task-indicator-${mode} task-state-${task.state}`}
    data-progress-mode={mode}
    data-progress-percent={percent}
    data-progress-stale={stale || undefined}
    viewBox="0 0 16 16"
    aria-hidden="true"
  >
    <circle className="tree-task-indicator-track" cx="8" cy="8" r={radius} />
    <circle className="tree-task-indicator-value" cx="8" cy="8" r={radius} transform="rotate(-90 8 8)" style={mode === "indeterminate" ? undefined : { strokeDasharray: `${dashLength} ${circumference}` }} />
  </svg>;
}

export function failedCourseTreeTaskIds(tasks: readonly CourseTreeTask[]): string[] {
  return [...new Set(tasks.filter((task) => task.state === "failed").map((task) => task.id))];
}

function TreeNode({ node, allNodes, searchMaterials, searchActive, onActivateSearch, depth, expanded, selectedPageId, focusedNodeId, openMenuNodeId, onFocus, onToggle, onSelectPage, onOpenMenu, forceOpen, actions, draggingNodeId, pointerDraggingNodeId, dropTargetId, onDragStart, onPointerDragStart, onDragOver, onDrop, onDragEnd }: {
  node: CourseTreeNode;
  allNodes: CourseTreeNode[];
  searchMaterials: CourseTreeSearchMaterial[];
  searchActive: boolean;
  onActivateSearch: (node: CourseTreeNode) => void;
  depth: number;
  expanded: Set<string>;
  selectedPageId?: string;
  focusedNodeId?: string;
  openMenuNodeId?: string;
  onFocus: (id: string) => void;
  onToggle: (id: string) => void;
  onSelectPage: (releaseId: string, pageId: string) => void;
  onOpenMenu: (node: CourseTreeNode, event: MouseEvent<HTMLElement>) => void;
  forceOpen: boolean;
  actions?: CourseTreeActions;
  draggingNodeId?: string;
  pointerDraggingNodeId?: string;
  dropTargetId?: string;
  onDragStart: (node: CourseTreeNode) => void;
  onPointerDragStart: (node: CourseTreeNode) => void;
  onDragOver: (node: CourseTreeNode) => void;
  onDrop: (node?: CourseTreeNode) => void;
  onDragEnd: () => void;
}) {
  const hasChildren = node.children.length > 0;
  const open = forceOpen || expanded.has(node.id);
  const materialInfo = node.kind === "material" ? searchMaterials.find((item) => item.materialNodeId === node.id && item.releaseId === (node.currentReleaseId ?? node.releaseId)) : undefined;
  const selected = Boolean(node.pageId && node.pageId === selectedPageId)
    || Boolean(node.kind === "material" && selectedPageId && materialInfo?.pages.some((page) => page.id === selectedPageId));
  const can = (capability: TreeNodeCapability) => Boolean(node.capabilities?.includes(capability));
  const activate = () => {
    if (searchActive) { onActivateSearch(node); return; }
    onFocus(node.id);
    if (node.pageId && node.releaseId) onSelectPage(node.releaseId, node.pageId);
    else if (node.kind === "material" && actions?.openMaterial) actions.openMaterial(node, { restoreReadingPosition: true });
    else if (node.kind === "trash" && actions?.openTrash) actions.openTrash();
    else if (hasChildren) onToggle(node.id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Enter") { event.preventDefault(); activate(); return; }
    if (event.key === "F2" && can("rename")) { event.preventDefault(); actions?.rename(node); return; }
    if (event.key === "Delete" && can("trash")) { event.preventDefault(); actions?.trash(node); return; }
    if (event.shiftKey && event.key === "F10") { event.preventDefault(); onOpenMenu(node, event as unknown as MouseEvent<HTMLElement>); return; }
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && can("reorder")) { event.preventDefault(); actions?.reorder?.(node, event.key === "ArrowUp" ? "up" : "down"); }
  };
  const draggable = isDraggableNode(node);
  const publication = node.kind === "material" ? materialPublication(node, materialInfo) : undefined;
  const runtime = node.kind === "material" ? materialRuntimeStatus(node.status) : undefined;
  const statusKind = runtime ?? publication?.status;
  const statusText = [
    publication ? publication.status === "published" ? "已发布" : "草稿" : undefined,
    runtime ? treeStatusPresentation[runtime].visibleLabel : undefined
  ].filter(Boolean).join(" · ");
  const statusDescription = [
    publication ? `材料版本：${publication.label}` : undefined,
    materialInfo?.lifecycle === "draft_source" ? "材料来源已保存；草稿标签不代表讲解已生成" : undefined,
    runtime ? `材料状态：${treeStatusPresentation[runtime].label}` : undefined
  ].filter((label): label is string => Boolean(label)).join("；");
  return <div className="tree-node" data-node-id={node.id} data-dragging={draggingNodeId === node.id || pointerDraggingNodeId === node.id ? "true" : undefined} draggable={draggable} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", node.id); onDragStart(node); }} onDragEnd={onDragEnd}>
    <div className={`tree-row ${selected ? "selected" : ""} ${focusedNodeId === node.id ? "focused" : ""} ${dropTargetId === node.id ? "drop-target" : ""}`} data-depth={depth} data-node-kind={node.kind} style={{ "--tree-depth-px": `${depth * 20}px` } as CSSProperties} onContextMenu={(event) => onOpenMenu(node, event)} onDragOver={(event) => { if (!draggingNodeId || draggingNodeId === node.id) return; const source = flattenTree(allNodes).find(({ node: candidate }) => candidate.id === draggingNodeId)?.node; if (!source || !isValidDrop(source, node)) return; event.preventDefault(); event.dataTransfer.dropEffect = node.kind === "trash" ? "move" : "move"; onDragOver(node); }} onDrop={(event) => { event.preventDefault(); onDrop(node); }}>
      {draggable && <span className="tree-drag-handle" data-action="tree-drag" role="img" aria-label={`拖动 ${node.title}`} title="拖动到其他课程或调整顺序；键盘请使用 Alt+上/下箭头" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); onFocus(node.id); setPointerCaptureSafe(event.currentTarget, event.pointerId); onPointerDragStart(node); }}><Icon name="grip" /></span>}
      <button className="tree-main-button" data-action={`tree-open-${node.kind}`} onClick={activate} onFocus={() => onFocus(node.id)} onKeyDown={onKeyDown} aria-current={selected ? "page" : undefined} aria-expanded={hasChildren ? open : undefined} title={node.subtitle ? `${node.title} — ${node.subtitle}` : node.title}>
        <span className={`tree-chevron ${hasChildren ? "" : "empty"} ${open ? "is-open" : ""}`} aria-hidden="true"><Icon name="chevronRight" /></span>
        <span className={`tree-kind kind-${node.kind}`}><Icon name={node.kind === "course" ? "book" : node.kind === "trash" ? "trash" : node.kind === "material" ? "layers" : node.kind === "section" ? "folder" : node.kind === "module" ? "layers" : node.kind === "release" ? "publish" : "document"} /></span>
        <span className="tree-copy"><strong>{node.title}</strong></span>
        {statusKind && statusText && <span className={`status-dot status-${statusKind} tree-row-status`} data-publication-status={publication?.status} data-runtime-status={runtime} role="img" aria-label={statusDescription} title={statusDescription}><Icon name={treeStatusPresentation[statusKind].icon} /><span>{statusText}</span></span>}
      </button>
      {actions && <button className="tree-row-actions" data-action="tree-open-actions" data-action-slot="tree-row-actions" onClick={(event) => onOpenMenu(node, event)} onFocus={() => onFocus(node.id)} aria-label={`打开 ${node.title} 的操作菜单`} aria-haspopup="menu" aria-expanded={openMenuNodeId === node.id} aria-controls={openMenuNodeId === node.id ? "course-tree-context-menu" : undefined} title="更多操作"><span aria-hidden="true">…</span></button>}
    </div>
    {hasChildren && open && <div>{node.children.map((child) => <TreeNode key={child.id} node={child} allNodes={allNodes} searchMaterials={searchMaterials} searchActive={searchActive} onActivateSearch={onActivateSearch} depth={depth + 1} expanded={expanded} selectedPageId={selectedPageId} focusedNodeId={focusedNodeId} openMenuNodeId={openMenuNodeId} onFocus={onFocus} onToggle={onToggle} onSelectPage={onSelectPage} onOpenMenu={onOpenMenu} forceOpen={forceOpen} actions={actions} draggingNodeId={draggingNodeId} pointerDraggingNodeId={pointerDraggingNodeId} dropTargetId={dropTargetId} onDragStart={onDragStart} onPointerDragStart={onPointerDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragEnd={onDragEnd} />)}</div>}
  </div>;
}

function TreeContextMenu({ menu, actions, onClose }: { menu: TreeMenuState; actions: CourseTreeActions; onClose: (restoreFocus?: boolean) => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedItemIndex, setFocusedItemIndex] = useState(0);
  const node = menu.node;
  const can = (capability: TreeNodeCapability) => Boolean(node.capabilities?.includes(capability));
  useEffect(() => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const firstEnabled = items[0];
    if (firstEnabled) {
      const index = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])].indexOf(firstEnabled);
      setFocusedItemIndex(index);
      firstEnabled.focus();
    }
  }, []);
  const run = (action: () => void) => { onClose(); action(); };
  const menuItems: Array<{ label: string; icon: "plus" | "upload" | "edit" | "archive" | "settings" | "history" | "copy" | "move" | "trash" | "play"; action: () => void; danger?: boolean; disabled?: boolean; title?: string }> = [];
  if (can("create_module") && actions.createModule) menuItems.push({ icon: "plus", label: "新建模块", action: () => actions.createModule!(node) });
  if (can("import_material") && actions.importMaterial) menuItems.push({ icon: "upload", label: "导入材料到这里", action: () => actions.importMaterial!(node) });
  if (node.kind === "material" && actions.openMaterial) menuItems.push({ icon: "play", label: "打开材料", action: () => actions.openMaterial!(node) });
  if (can("open_studio")) menuItems.push({ icon: "edit", label: "在制作模式打开", action: () => actions.openStudio(node) });
  if (node.kind === "trash" && actions.openTrash) menuItems.push({ icon: "trash", label: "查看回收站", action: actions.openTrash });
  if (can("open_readweave")) menuItems.push({
    icon: "archive",
    label: node.readweaveNoteId ? "在 ReadWeave 打开" : "在 ReadWeave 打开（尚无精确笔记）",
    action: () => { if (node.readweaveNoteId) actions.openReadWeave(node); },
    disabled: !node.readweaveNoteId,
    title: node.readweaveNoteId ? undefined : "当前节点尚未建立 ReadWeave 精确笔记链接"
  });
  if (can("properties") && actions.properties) menuItems.push({ icon: "settings", label: "查看属性和同步状态", action: () => actions.properties!(node) });
  if (can("history")) menuItems.push({ icon: "history", label: "查看版本历史", action: () => actions.history(node) });
  if (can("rename")) menuItems.push({ icon: "edit", label: "重命名", action: () => actions.rename(node) });
  if (can("duplicate")) menuItems.push({ icon: "copy", label: "复制为新草稿", action: () => actions.duplicate(node) });
  if (can("move")) menuItems.push({ icon: "move", label: "移动到其他位置", action: () => actions.move(node) });
  if (can("trash")) menuItems.push({ icon: "trash", label: "移入回收站", action: () => actions.trash(node), danger: true });
  if (menuItems.length === 0) return null;
  return <div ref={menuRef} id="course-tree-context-menu" className="tree-context-menu" data-action-slot="tree-context-menu" style={{ left: menu.x, top: menu.y }} role="menu" aria-label={`${node.title} 的操作`} onClick={(event) => event.stopPropagation()} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose();
  }} onKeyDown={(event) => {
    const allItems = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const enabledItems = allItems.filter((item) => !item.disabled);
    const activeIndex = enabledItems.indexOf(document.activeElement as HTMLButtonElement);
    const action = resolveTreeMenuKeyAction(event.key, activeIndex < 0 ? 0 : activeIndex, enabledItems.length);
    if (action.kind === "focus") {
      event.preventDefault();
      const next = enabledItems[action.index];
      if (next) {
        setFocusedItemIndex(allItems.indexOf(next));
        next.focus();
      }
    } else if (action.kind === "close") {
      event.preventDefault();
      onClose(action.restoreFocus);
    }
  }}>
    {menuItems.map((item, index) => <MenuItem key={`${item.label}:${index}`} actionId={`tree-menu-${index + 1}`} tabIndex={index === focusedItemIndex ? 0 : -1} icon={item.icon} label={item.label} danger={item.danger} disabled={item.disabled} title={item.title} onClick={() => run(item.action)} />)}
  </div>;
}

function MenuItem({ actionId, icon, label, onClick, danger = false, disabled = false, title, tabIndex }: { actionId: string; icon: "plus" | "upload" | "edit" | "archive" | "settings" | "history" | "copy" | "move" | "trash" | "play"; label: string; onClick: () => void; danger?: boolean; disabled?: boolean; title?: string; tabIndex: number }) {
  return <button type="button" className={danger ? "tree-menu-item danger" : "tree-menu-item"} data-action={actionId} role="menuitem" tabIndex={tabIndex} disabled={disabled} title={title} onClick={onClick}><Icon name={icon} /><span>{label}</span></button>;
}

function collectExpandable(node: CourseTreeNode): string[] { return node.children.flatMap((child) => [child.id, ...collectExpandable(child)]); }

function addSearchPageNodes(nodes: CourseTreeNode[], searchMaterials: CourseTreeSearchMaterial[], includeAllPages: boolean): CourseTreeNode[] {
  return nodes.map((node) => {
    const children = addSearchPageNodes(node.children, searchMaterials, includeAllPages);
    if (node.kind !== "material") return { ...node, children };
    const material = findCurrentSearchMaterial(node, searchMaterials);
    if (!material) return { ...node, children };
    const pages = (includeAllPages ? material.pages : [])
      .filter((page) => !children.some((child) => child.pageId === page.id))
      .map((page): CourseTreeNode => ({
        id: page.id,
        kind: "page",
        title: page.title,
        releaseId: material.releaseId,
        pageId: page.id,
        pageNumber: page.pageNumber,
        parentId: node.id,
        children: []
      }));
    return { ...node, children: [...children, ...pages] };
  });
}

function findCurrentSearchMaterial(node: CourseTreeNode, searchMaterials: CourseTreeSearchMaterial[]): CourseTreeSearchMaterial | undefined {
  const currentReleaseId = node.currentReleaseId ?? node.releaseId;
  return searchMaterials.find((item) => item.materialNodeId === node.id && item.releaseId === currentReleaseId);
}

function findCurrentMaterialForPage(nodes: CourseTreeNode[], searchMaterials: CourseTreeSearchMaterial[], pageId: string): CourseTreeNode | undefined {
  return flattenTree(nodes).find(({ node }) => node.kind === "material"
    && findCurrentSearchMaterial(node, searchMaterials)?.pages.some((page) => page.id === pageId))?.node;
}

function isSearchableNode(node: CourseTreeNode): boolean {
  return node.kind !== "trash" && node.kind !== "release" && !node.archived && node.visibility !== "archived";
}

export function buildCourseTreeSearchResults(nodes: CourseTreeNode[], query: string, searchMaterials: CourseTreeSearchMaterial[] = []): CourseTreeSearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const nodesWithPages = addSearchPageNodes(nodes, searchMaterials, true);
  return flattenSearchableTree(nodesWithPages)
    .filter((node) => [node.title, node.subtitle ?? "", node.pageNumber === undefined ? "" : String(node.pageNumber)]
      .some((value) => value.toLocaleLowerCase().includes(needle)))
    .map((node): CourseTreeSearchResult => {
      const path = findTreePath(nodesWithPages, node.id);
      const ancestors = path.slice(0, -1).map((item) => item.title).join(" · ");
      if (node.kind === "page") {
        const material = searchMaterials.find((item) => item.releaseId === node.releaseId && item.pages.some((page) => page.id === node.pageId));
        const parentMaterial = path.at(-2);
        const version = material && parentMaterial ? materialPublication(parentMaterial, material)?.label : material ? `v${material.version}` : "当前版本";
        return { id: `page:${node.releaseId}:${node.pageId}`, node, label: `第 ${node.pageNumber ?? "?"} 页 · ${node.title}`, detail: [ancestors, version].filter(Boolean).join(" · ") };
      }
      const label = `${treeNodeKindLabel(node.kind)} · ${node.title}`;
      const material = node.kind === "material" ? findCurrentSearchMaterial(node, searchMaterials) : undefined;
      const publication = material ? materialPublication(node, material)?.label : undefined;
      const detail = [ancestors, publication, node.kind === "material" && node.pageCount ? `${node.pageCount} 页` : undefined]
        .filter(Boolean).join(" · ");
      return { id: `${node.kind}:${node.id}`, node, label, detail };
    });
}

export function moveSearchIndex(currentIndex: number, direction: 1 | -1, resultCount: number): number {
  if (resultCount <= 0) return -1;
  if (currentIndex < 0) return direction === 1 ? 0 : resultCount - 1;
  return (currentIndex + direction + resultCount) % resultCount;
}

export type SearchInputKeyAction =
  | { kind: "move"; index: number }
  | { kind: "activate"; index: number }
  | { kind: "close" }
  | { kind: "none" };

export function resolveSearchInputKeyAction(key: string, activeIndex: number, resultCount: number, options: { isComposing?: boolean; hasQuery?: boolean; searchOpen?: boolean } = {}): SearchInputKeyAction {
  if (options.isComposing) return { kind: "none" };
  if (key === "ArrowDown" || key === "ArrowUp") {
    if (resultCount <= 0) return { kind: "none" };
    return { kind: "move", index: moveSearchIndex(activeIndex, key === "ArrowDown" ? 1 : -1, resultCount) };
  }
  if (key === "Enter") {
    if (resultCount <= 0 || options.searchOpen === false) return { kind: "none" };
    return { kind: "activate", index: activeIndex >= 0 && activeIndex < resultCount ? activeIndex : 0 };
  }
  if (key === "Escape") {
    if (options.hasQuery) return { kind: "close" };
    if (options.searchOpen === false) return { kind: "none" };
    return { kind: "close" };
  }
  return { kind: "none" };
}

export type CourseTreeSearchActivation =
  | { kind: "page"; releaseId: string; pageId: string }
  | { kind: "material"; node: CourseTreeNode; restoreReadingPosition: true }
  | { kind: "container" };

export function resolveCourseTreeSearchActivation(node: CourseTreeNode): CourseTreeSearchActivation {
  if (node.pageId && node.releaseId) return { kind: "page", releaseId: node.releaseId, pageId: node.pageId };
  if (node.kind === "material") return { kind: "material", node, restoreReadingPosition: true };
  return { kind: "container" };
}

function flattenSearchableTree(nodes: CourseTreeNode[]): CourseTreeNode[] {
  return nodes.flatMap((node) => isSearchableNode(node)
    ? [node, ...flattenSearchableTree(node.children)]
    : []);
}

function findTreePath(nodes: CourseTreeNode[], nodeId: string): CourseTreeNode[] {
  for (const node of nodes) {
    if (node.id === nodeId) return [node];
    const nested = findTreePath(node.children, nodeId);
    if (nested.length) return [node, ...nested];
  }
  return [];
}

function treeNodeKindLabel(kind: CourseTreeNode["kind"]): string {
  if (kind === "course") return "课程";
  if (kind === "material") return "材料";
  if (kind === "module") return "模块";
  if (kind === "section") return "文件夹";
  if (kind === "page") return "页面";
  return "项目";
}

function materialPublication(node: CourseTreeNode, material?: CourseTreeSearchMaterial): { status: "published" | "draft"; label: string } | undefined {
  const status = material?.lifecycle === "published" ? "published"
    : material?.lifecycle === "draft_source" ? "draft"
      : node.status === "published" || node.status === "draft" ? node.status : undefined;
  if (!status) return undefined;
  const currentReleaseId = node.currentReleaseId ?? node.releaseId;
  const historical = Boolean(material && currentReleaseId && material.releaseId !== currentReleaseId);
  const version = status === "published" || historical ? material?.version ?? node.revision : undefined;
  return { status, label: `${status === "published" ? "已发布" : "草稿"}${version === undefined ? "" : ` v${version}`}` };
}

function materialRuntimeStatus(status?: CourseTreeNode["status"]): "syncing" | "needs_review" | "conflict" | undefined {
  return status === "syncing" || status === "needs_review" || status === "conflict" ? status : undefined;
}

function isDraggableNode(node: CourseTreeNode): boolean { return node.kind === "course" || node.kind === "material"; }

function isValidDrop(source: CourseTreeNode, target: CourseTreeNode): boolean {
  if (source.id === target.id || !isDraggableNode(source)) return false;
  if (target.kind === "trash") return source.kind === "material";
  if (source.kind === "course") return target.kind === "course";
  return target.kind === "course" || target.kind === "material";
}

function flattenTree(nodes: CourseTreeNode[], depth = 0): Array<{ node: CourseTreeNode; depth: number }> {
  return nodes.flatMap((node) => [{ node, depth }, ...flattenTree(node.children, depth + 1)]);
}

function filterTree(nodes: CourseTreeNode[], query: string): CourseTreeNode[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return nodes.filter(isSearchableNode);
  return nodes.flatMap((node) => {
    if (!isSearchableNode(node)) return [];
    const children = filterTree(node.children, query);
    return node.title.toLocaleLowerCase().includes(needle) || node.subtitle?.toLocaleLowerCase().includes(needle) || (node.pageNumber !== undefined && String(node.pageNumber).includes(needle)) || children.length ? [{ ...node, children }] : [];
  });
}

function setPointerCaptureSafe(element: Element, pointerId: number): void {
  if (element instanceof HTMLElement && element.setPointerCapture) element.setPointerCapture(pointerId);
}
