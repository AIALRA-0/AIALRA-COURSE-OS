import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { CourseTreeNode, TreeNodeCapability, WorkspaceTree } from "@course-os/contracts";
import { Icon } from "./Icon.js";
import { importTaskStateLabel, type ImportTaskState } from "./import-progress.js";

export type CourseTreeTask = { id: string; courseId?: string; parentNodeId?: string; title: string; detail: string; state: ImportTaskState; unresolved?: boolean };

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

type TreeMenuState = { node: CourseTreeNode; x: number; y: number };

const treeStatusPresentation = {
  published: { icon: "check", label: "已发布", visibleLabel: "已发布" },
  draft: { icon: "document", label: "草稿", visibleLabel: "草稿" },
  syncing: { icon: "history", label: "正在同步", visibleLabel: "同步" },
  needs_review: { icon: "review", label: "需要审核", visibleLabel: "待审" },
  conflict: { icon: "warning", label: "存在冲突", visibleLabel: "冲突" }
} as const;

export function CourseTree({ tree, selectedPageId, selectedTaskId, backgroundTasks = [], searchMaterials = [], onSelectTask, collapsed = false, onCollapse, sidebarWidth, onResizeStart, onResizeKeyboard, onSelectPage, onImport, onCreateCourse, onSettings, actions }: {
  tree?: WorkspaceTree;
  selectedPageId?: string;
  selectedTaskId?: string;
  backgroundTasks?: CourseTreeTask[];
  searchMaterials?: CourseTreeSearchMaterial[];
  onSelectTask?: (taskId: string) => void;
  collapsed?: boolean;
  onCollapse?: () => void;
  sidebarWidth?: number;
  onResizeStart?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeKeyboard?: (delta: number) => void;
  onSelectPage: (releaseId: string, pageId: string) => void;
  onImport: () => void;
  onCreateCourse: () => void;
  onSettings: () => void;
  actions?: CourseTreeActions;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const rootNodes = useMemo(() => [...(tree?.courses ?? []), ...(tree?.rootMaterials ?? [])], [tree]);
  const searchableNodes = useMemo(() => addSearchPageNodes(rootNodes, searchMaterials, Boolean(query.trim()), selectedPageId), [rootNodes, searchMaterials, query, selectedPageId]);
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
  const focusSearchAfterExpand = useRef(false);
  const visibleNodes = useMemo(() => {
    return query.trim() ? filterTree(searchableNodes.filter(isSearchableNode), query) : searchableNodes;
  }, [query, searchableNodes]);
  const searchResults = useMemo(() => buildCourseTreeSearchResults(searchableNodes, query, searchMaterials), [searchableNodes, query, searchMaterials]);

  useEffect(() => {
    if (!tree) return;
    setExpanded((current) => new Set([...current, ...rootNodes.flatMap((node) => [node.id, ...collectExpandable(node)])]));
  }, [rootNodes, tree]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "k") return;
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(true);
      if (collapsed) {
        focusSearchAfterExpand.current = true;
        onCollapse?.();
      } else searchInput.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [collapsed, onCollapse]);

  useEffect(() => {
    if (collapsed || !focusSearchAfterExpand.current) return;
    focusSearchAfterExpand.current = false;
    searchInput.current?.focus();
  }, [collapsed]);

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
    const selectedNode = flattenSearchableTree(searchableNodes).find((node) => node.pageId === selectedPageId);
    if (!selectedNode) return;
    const path = findTreePath(searchableNodes, selectedNode.id);
    setExpanded((current) => new Set([...current, ...path.map((node) => node.id)]));
    setPendingScrollNodeId(selectedNode.id);
  }, [selectedPageId, searchableNodes]);

  useEffect(() => {
    const close = () => setMenu(undefined);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("blur", close); };
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
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (searchResults.length === 0) return;
      event.preventDefault();
      setSearchOpen(true);
      setActiveSearchIndex((index) => moveSearchIndex(index, event.key === "ArrowDown" ? 1 : -1, searchResults.length));
      return;
    }
    if (event.key === "Enter" && searchOpen && searchResults.length > 0) {
      event.preventDefault();
      activateSearchResult(searchResults[activeSearchIndex] ?? searchResults[0]!);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
    }
  };

  const openMenu = (node: CourseTreeNode, event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 270;
    const height = 380;
    setFocusedNodeId(node.id);
    setMenu({ node, x: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)) });
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

  if (collapsed) return <aside className="course-sidebar course-sidebar-collapsed" aria-label="课程项目树已收起">
    <button className="sidebar-expand-button" data-action="tree-expand" onClick={onCollapse} aria-label="展开课程项目树" title="展开课程项目树"><Icon name="chevronRight" /></button>
    <button className="sidebar-rail-button" data-action="tree-create-course" onClick={onCreateCourse} aria-label="新建课程" title="新建课程"><Icon name="plus" /></button>
    <button className="sidebar-rail-button" data-action="tree-import-material" onClick={onImport} aria-label="导入材料" title="导入材料"><Icon name="upload" /></button>
    <button className="sidebar-rail-button sidebar-rail-bottom" data-action="tree-open-settings" onClick={onSettings} aria-label="工作区设置" title="工作区设置"><Icon name="settings" /></button>
  </aside>;

  return <aside className="course-sidebar" aria-label="课程项目树">
    <div className="sidebar-heading">
      <div><span className="sidebar-kicker">课程空间</span><strong>{tree?.title || "Course OS"}</strong></div>
      <div className="sidebar-heading-actions">
        <button className="icon-button" data-action="tree-create-course" aria-label="新建课程" onClick={onCreateCourse} title="新建课程"><Icon name="plus" /></button>
        <button className="icon-button" data-action="tree-collapse" aria-label="收起课程项目树" onClick={onCollapse} title="收起课程项目树"><Icon name="chevronLeft" /></button>
      </div>
    </div>

    <div ref={searchContainer} style={{ position: "relative", zIndex: 30 }}>
      <label className="tree-search">
        <Icon name="search" />
        <input
          ref={searchInput}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActiveSearchIndex(0); setSearchOpen(true); }}
          onFocus={() => { if (query) setSearchOpen(true); }}
          onKeyDown={onSearchKeyDown}
          placeholder="搜索课程、材料或页面"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={searchOpen && Boolean(query.trim())}
          aria-controls="course-tree-search-results"
          aria-activedescendant={searchOpen && searchResults[activeSearchIndex] ? `course-tree-search-result-${activeSearchIndex}` : undefined}
        />
        <kbd>⌘ K</kbd>
      </label>
      {searchOpen && query.trim() && <div id="course-tree-search-results" role="listbox" aria-label="课程树搜索结果" style={{ position: "absolute", top: "calc(100% - 8px)", left: 12, right: 12, maxHeight: 280, overflowY: "auto", padding: 4, border: "1px solid var(--line)", borderRadius: 8, background: "var(--panel)", boxShadow: "0 10px 28px rgb(0 0 0 / 18%)" }}>
        {searchResults.length === 0 ? <div role="status" style={{ padding: "10px 12px", color: "var(--muted)", fontSize: 12 }}>没有匹配的课程、材料或页面</div> : searchResults.map((result, index) => <button
          key={result.id}
          id={`course-tree-search-result-${index}`}
          type="button"
          role="option"
          aria-selected={index === activeSearchIndex}
          data-action="tree-search-result"
          data-result-kind={result.node.kind}
          onMouseEnter={() => setActiveSearchIndex(index)}
          onClick={() => activateSearchResult(result)}
          style={{ display: "grid", width: "100%", gridTemplateColumns: "minmax(0, 1fr)", gap: 2, padding: "8px 10px", border: 0, borderRadius: 6, background: index === activeSearchIndex ? "var(--soft)" : "transparent", color: "var(--ink)", textAlign: "left", cursor: "pointer" }}
        ><strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{result.label}</strong><small style={{ color: "var(--muted)", fontSize: 10 }}>{result.detail}</small></button>)}
      </div>}
    </div>

    <div className="tree-toolbar">
      <span>正式课程</span>
      <button data-action="tree-import-material" onClick={onImport}><Icon name="upload" />导入材料</button>
    </div>

    <div className="tree-scroll">
      <nav aria-label="正式课程">
      {visibleNodes.length === 0 && <div className="tree-empty"><Icon name="search" /><span>{!tree ? "正在载入课程目录" : query ? "没有匹配的课程、材料或页面" : "还没有课程或材料"}</span></div>}
      {visibleNodes.map((node) => <TreeNode key={node.id} node={node} allNodes={allNodes} searchMaterials={searchMaterials} searchActive={Boolean(query.trim())} onActivateSearch={activateSearchNode} depth={0} expanded={expanded} selectedPageId={selectedPageId} focusedNodeId={focusedNodeId} onFocus={setFocusedNodeId} onToggle={toggle} onSelectPage={onSelectPage} onOpenMenu={openMenu} forceOpen={Boolean(query.trim())} actions={actions} draggingNodeId={draggingNodeId} pointerDraggingNodeId={pointerDraggingNodeId} dropTargetId={dropTargetId} onDragStart={(item) => { setDraggingNodeId(item.id); setDragAnnouncement(`正在拖动 ${item.title}，请移动到课程或材料上`); }} onPointerDragStart={(item) => { setPointerDraggingNodeId(item.id); setDragAnnouncement(`正在拖动 ${item.title}，请移动到课程或材料上`); }} onDragOver={(item) => setDropTargetId(item.id)} onDrop={handleDrop} onDragEnd={finishDrag} />)}
      {!query.trim() && tree?.trash && <TreeNode key={tree.trash.id} node={tree.trash} allNodes={allNodes} searchMaterials={searchMaterials} searchActive={false} onActivateSearch={activateSearchNode} depth={0} expanded={expanded} selectedPageId={selectedPageId} focusedNodeId={focusedNodeId} onFocus={setFocusedNodeId} onToggle={toggle} onSelectPage={onSelectPage} onOpenMenu={openMenu} forceOpen={false} actions={actions} draggingNodeId={draggingNodeId} pointerDraggingNodeId={pointerDraggingNodeId} dropTargetId={dropTargetId} onDragStart={(node) => { setDraggingNodeId(node.id); setDragAnnouncement(`正在拖动 ${node.title}，请移动到课程或材料上`); }} onPointerDragStart={(node) => { setPointerDraggingNodeId(node.id); setDragAnnouncement(`正在拖动 ${node.title}，请移动到课程或材料上`); }} onDragOver={(node) => setDropTargetId(node.id)} onDrop={handleDrop} onDragEnd={finishDrag} />}
      </nav>
      <TaskRows tasks={backgroundTasks} query={query} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />
    </div>

    <div className="sidebar-footer">
      <div className="workspace-avatar">A</div>
      <div><strong>个人工作区</strong><span>ReadWeave 权威存储</span></div>
      <button className="icon-button" data-action="tree-open-settings" aria-label="工作区设置" onClick={onSettings} title="工作区设置"><Icon name="settings" /></button>
    </div>
    {onResizeStart && <div
      className="sidebar-resize-handle"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-valuemin={220}
      aria-valuemax={420}
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
    {menu && actions && <TreeContextMenu menu={menu} actions={actions} onClose={() => setMenu(undefined)} />}
  </aside>;
}

function TaskRows({ tasks, query, selectedTaskId, onSelectTask }: {
  tasks: CourseTreeTask[]; query: string; selectedTaskId?: string;
  onSelectTask?: (taskId: string) => void;
}) {
  const needle = query.trim().toLocaleLowerCase();
  const matchesQuery = (task: CourseTreeTask) => !needle || `${task.title} ${task.detail}`.toLocaleLowerCase().includes(needle);
  const current = tasks.filter((task) => task.state === "queued" || task.state === "running" || task.state === "paused" || task.state === "awaiting_review").filter(matchesQuery);
  const needsAttention = tasks.filter((task) => task.state === "failed" && task.unresolved === true).filter(matchesQuery);
  const history = needle ? [] : tasks.filter((task) => task.state === "completed" || task.state === "cancelled" || task.state === "failed").filter(matchesQuery);
  if (current.length + needsAttention.length + history.length === 0) return null;
  return <section className="tree-task-section" aria-label="后台任务">
    {current.length > 0 && <TaskGroup title="当前任务" tasks={current} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />}
    {needsAttention.length > 0 && <details className="tree-task-attention" aria-label="需处理" open={Boolean(query)}>
      <summary><span>需处理的更新</span><span className="tree-task-count">{needsAttention.length}</span></summary>
      <TaskList tasks={needsAttention} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />
    </details>}
    {history.length > 0 && <details className="tree-task-history" open={Boolean(query)}>
      <summary><span>历史记录</span><span className="tree-task-count">{history.length}</span></summary>
      <TaskList tasks={history} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />
    </details>}
  </section>;
}

function TaskGroup({ title, tasks, selectedTaskId, onSelectTask }: {
  title: string; tasks: CourseTreeTask[]; selectedTaskId?: string; onSelectTask?: (taskId: string) => void;
}) {
  return <div className="tree-task-group" role="group" aria-label={title}>
    <div className="tree-task-heading"><span>{title}</span><span className="tree-task-count">{tasks.length}</span></div>
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
    const summary = detail ? `${stateLabel} · ${detail}` : stateLabel;
    return <button
      type="button"
      className={`tree-task-row ${selectedTaskId === task.id ? "selected" : ""}`}
      data-action="tree-open-task"
      data-task-id={task.id}
      data-task-state={task.state}
      key={task.id}
      onClick={() => onSelectTask?.(task.id)}
      aria-current={selectedTaskId === task.id ? "page" : undefined}
      aria-label={`${task.title}，${summary}`}
      title={`${task.title} · ${summary}`}
    ><span className={`task-state-dot task-state-${task.state}`} aria-hidden="true" /><span className="tree-task-copy"><strong>{task.title}</strong><small><span className={`task-state-label task-state-${task.state}`}>{stateLabel}</span><span>{detail}</span></small></span><Icon name="chevronRight" /></button>;
  })}</div>;
}

function TreeNode({ node, allNodes, searchMaterials, searchActive, onActivateSearch, depth, expanded, selectedPageId, focusedNodeId, onFocus, onToggle, onSelectPage, onOpenMenu, forceOpen, actions, draggingNodeId, pointerDraggingNodeId, dropTargetId, onDragStart, onPointerDragStart, onDragOver, onDrop, onDragEnd }: {
  node: CourseTreeNode;
  allNodes: CourseTreeNode[];
  searchMaterials: CourseTreeSearchMaterial[];
  searchActive: boolean;
  onActivateSearch: (node: CourseTreeNode) => void;
  depth: number;
  expanded: Set<string>;
  selectedPageId?: string;
  focusedNodeId?: string;
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
  const selected = Boolean(node.pageId && node.pageId === selectedPageId);
  const can = (capability: TreeNodeCapability) => Boolean(node.capabilities?.includes(capability));
  const activate = () => {
    if (searchActive) { onActivateSearch(node); return; }
    onFocus(node.id);
    if (node.pageId && node.releaseId) onSelectPage(node.releaseId, node.pageId);
    else if (node.kind === "material" && actions?.openMaterial) actions.openMaterial(node);
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
  const materialInfo = node.kind === "material" ? searchMaterials.find((item) => item.materialNodeId === node.id && item.releaseId === (node.currentReleaseId ?? node.releaseId)) : undefined;
  const publication = node.kind === "material" ? materialPublication(node, materialInfo) : undefined;
  const runtime = node.kind === "material" ? materialRuntimeStatus(node.status) : undefined;
  return <div className="tree-node" data-node-id={node.id} data-dragging={draggingNodeId === node.id || pointerDraggingNodeId === node.id ? "true" : undefined} draggable={draggable} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", node.id); onDragStart(node); }} onDragEnd={onDragEnd}>
    <div className={`tree-row ${selected ? "selected" : ""} ${focusedNodeId === node.id ? "focused" : ""} ${dropTargetId === node.id ? "drop-target" : ""}`} data-depth={depth} data-node-kind={node.kind} style={{ "--tree-depth-px": `${depth * 20}px` } as CSSProperties} onContextMenu={(event) => onOpenMenu(node, event)} onDragOver={(event) => { if (!draggingNodeId || draggingNodeId === node.id) return; const source = flattenTree(allNodes).find(({ node: candidate }) => candidate.id === draggingNodeId)?.node; if (!source || !isValidDrop(source, node)) return; event.preventDefault(); event.dataTransfer.dropEffect = node.kind === "trash" ? "move" : "move"; onDragOver(node); }} onDrop={(event) => { event.preventDefault(); onDrop(node); }}>
      {draggable && <span className="tree-drag-handle" data-action="tree-drag" role="img" aria-label={`拖动 ${node.title}`} title="拖动到其他课程或调整顺序；键盘请使用 Alt+上/下箭头" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); onFocus(node.id); setPointerCaptureSafe(event.currentTarget, event.pointerId); onPointerDragStart(node); }}><Icon name="grip" /></span>}
      <button className="tree-main-button" data-action={`tree-open-${node.kind}`} onClick={activate} onFocus={() => onFocus(node.id)} onKeyDown={onKeyDown} aria-current={selected ? "page" : undefined} aria-expanded={hasChildren ? open : undefined} title={node.subtitle ? `${node.title} — ${node.subtitle}` : node.title}>
        <span className={`tree-chevron ${hasChildren ? "" : "empty"}`} aria-hidden="true"><Icon name={open ? "chevronDown" : "chevronRight"} /></span>
        <span className={`tree-kind kind-${node.kind}`}><Icon name={node.kind === "course" ? "book" : node.kind === "trash" ? "trash" : node.kind === "material" ? "layers" : node.kind === "section" ? "folder" : node.kind === "module" ? "layers" : node.kind === "release" ? "publish" : "document"} /></span>
        <span className="tree-copy"><strong>{node.title}</strong></span>
        {publication && <span className={`status-dot status-${publication.status}`} role="img" aria-label={`材料版本：${publication.label}`} title={publication.label}><Icon name={treeStatusPresentation[publication.status].icon} /><span>{publication.label}</span></span>}
        {runtime && <span className={`status-dot status-${runtime}`} role="img" aria-label={`材料状态：${treeStatusPresentation[runtime].label}`} title={treeStatusPresentation[runtime].label}><Icon name={treeStatusPresentation[runtime].icon} /><span>{treeStatusPresentation[runtime].visibleLabel}</span></span>}
      </button>
      {actions && <button className="tree-row-actions" data-action="tree-open-actions" onClick={(event) => onOpenMenu(node, event)} onFocus={() => onFocus(node.id)} aria-label={`打开 ${node.title} 的操作菜单`} aria-haspopup="menu" title="更多操作"><span aria-hidden="true">…</span></button>}
    </div>
    {hasChildren && open && <div>{node.children.map((child) => <TreeNode key={child.id} node={child} allNodes={allNodes} searchMaterials={searchMaterials} searchActive={searchActive} onActivateSearch={onActivateSearch} depth={depth + 1} expanded={expanded} selectedPageId={selectedPageId} focusedNodeId={focusedNodeId} onFocus={onFocus} onToggle={onToggle} onSelectPage={onSelectPage} onOpenMenu={onOpenMenu} forceOpen={forceOpen} actions={actions} draggingNodeId={draggingNodeId} pointerDraggingNodeId={pointerDraggingNodeId} dropTargetId={dropTargetId} onDragStart={onDragStart} onPointerDragStart={onPointerDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragEnd={onDragEnd} />)}</div>}
  </div>;
}

function TreeContextMenu({ menu, actions, onClose }: { menu: TreeMenuState; actions: CourseTreeActions; onClose: () => void }) {
  const firstItem = useRef<HTMLButtonElement>(null);
  const node = menu.node;
  const can = (capability: TreeNodeCapability) => Boolean(node.capabilities?.includes(capability));
  useEffect(() => { firstItem.current?.focus(); }, []);
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
  return <div className="tree-context-menu" style={{ left: menu.x, top: menu.y }} role="menu" aria-label={`${node.title} 的操作`} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
  }}>
    {menuItems.map((item, index) => <MenuItem key={`${item.label}:${index}`} actionId={`tree-menu-${index + 1}`} buttonRef={index === 0 ? firstItem : undefined} icon={item.icon} label={item.label} danger={item.danger} disabled={item.disabled} title={item.title} onClick={() => run(item.action)} />)}
  </div>;
}

function MenuItem({ actionId, icon, label, onClick, danger = false, disabled = false, title, buttonRef }: { actionId: string; icon: "plus" | "upload" | "edit" | "archive" | "settings" | "history" | "copy" | "move" | "trash" | "play"; label: string; onClick: () => void; danger?: boolean; disabled?: boolean; title?: string; buttonRef?: React.RefObject<HTMLButtonElement | null> }) {
  return <button ref={buttonRef} className={danger ? "tree-menu-item danger" : "tree-menu-item"} data-action={actionId} role="menuitem" disabled={disabled} title={title} onClick={onClick}><Icon name={icon} /><span>{label}</span></button>;
}

function collectExpandable(node: CourseTreeNode): string[] { return node.children.flatMap((child) => [child.id, ...collectExpandable(child)]); }

function addSearchPageNodes(nodes: CourseTreeNode[], searchMaterials: CourseTreeSearchMaterial[], includeAllPages: boolean, selectedPageId?: string): CourseTreeNode[] {
  return nodes.map((node) => {
    const children = addSearchPageNodes(node.children, searchMaterials, includeAllPages, selectedPageId);
    if (node.kind !== "material") return { ...node, children };
    const material = findCurrentSearchMaterial(node, searchMaterials);
    if (!material) return { ...node, children };
    const pages = material.pages
      .filter((page) => includeAllPages || page.id === selectedPageId)
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
  const version = material?.version ?? node.revision;
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
