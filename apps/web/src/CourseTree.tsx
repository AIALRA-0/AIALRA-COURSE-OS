import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import type { CourseTreeNode, TreeNodeCapability, WorkspaceTree } from "@course-os/contracts";
import { Icon } from "./Icon.js";

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
  openMaterial?: (node: CourseTreeNode) => void;
  openReadWeave: (node: CourseTreeNode) => void;
  history: (node: CourseTreeNode) => void;
  properties?: (node: CourseTreeNode) => void;
  openTrash?: () => void;
}

type TreeMenuState = { node: CourseTreeNode; x: number; y: number };

export function CourseTree({ tree, selectedPageId, collapsed = false, onCollapse, onSelectPage, onImport, onCreateCourse, onSettings, actions }: {
  tree?: WorkspaceTree;
  selectedPageId?: string;
  collapsed?: boolean;
  onCollapse?: () => void;
  onSelectPage: (releaseId: string, pageId: string) => void;
  onImport: () => void;
  onCreateCourse: () => void;
  onSettings: () => void;
  actions?: CourseTreeActions;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<TreeMenuState>();
  const [focusedNodeId, setFocusedNodeId] = useState<string>();
  const [draggingNodeId, setDraggingNodeId] = useState<string>();
  const [pointerDraggingNodeId, setPointerDraggingNodeId] = useState<string>();
  const [dropTargetId, setDropTargetId] = useState<string>();
  const [dragAnnouncement, setDragAnnouncement] = useState("");
  const rootNodes = useMemo(() => [...(tree?.courses ?? []), ...(tree?.rootMaterials ?? [])], [tree]);
  const visibleNodes = useMemo(() => filterTree(rootNodes, query), [query, rootNodes]);

  useEffect(() => {
    if (!tree) return;
    setExpanded((current) => new Set([...current, ...rootNodes.flatMap((node) => [node.id, ...collectExpandable(node)])]));
  }, [rootNodes, tree]);

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

    <label className="tree-search">
      <Icon name="search" />
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索课程、材料或页面" />
      <kbd>⌘ K</kbd>
    </label>

    <div className="tree-toolbar">
      <span>正式课程</span>
      <button data-action="tree-import-material" onClick={onImport}><Icon name="upload" />导入材料</button>
    </div>

    <nav className="tree-scroll" aria-label="正式课程">
      {visibleNodes.length === 0 && <div className="tree-empty"><Icon name="search" /><span>{query ? "没有匹配的课程或材料" : "还没有课程或材料"}</span></div>}
      {visibleNodes.map((node) => <TreeNode key={node.id} node={node} allNodes={allNodes} depth={0} expanded={expanded} selectedPageId={selectedPageId} focusedNodeId={focusedNodeId} onFocus={setFocusedNodeId} onToggle={toggle} onSelectPage={onSelectPage} onOpenMenu={openMenu} forceOpen={Boolean(query)} actions={actions} draggingNodeId={draggingNodeId} pointerDraggingNodeId={pointerDraggingNodeId} dropTargetId={dropTargetId} onDragStart={(item) => { setDraggingNodeId(item.id); setDragAnnouncement(`正在拖动 ${item.title}，请移动到课程或材料上`); }} onPointerDragStart={(item) => { setPointerDraggingNodeId(item.id); setDragAnnouncement(`正在拖动 ${item.title}，请移动到课程或材料上`); }} onDragOver={(item) => setDropTargetId(item.id)} onDrop={handleDrop} onDragEnd={finishDrag} />)}
      {tree?.trash && <TreeNode key={tree.trash.id} node={tree.trash} allNodes={allNodes} depth={0} expanded={expanded} selectedPageId={selectedPageId} focusedNodeId={focusedNodeId} onFocus={setFocusedNodeId} onToggle={toggle} onSelectPage={onSelectPage} onOpenMenu={openMenu} forceOpen={Boolean(query)} actions={actions} draggingNodeId={draggingNodeId} pointerDraggingNodeId={pointerDraggingNodeId} dropTargetId={dropTargetId} onDragStart={(node) => { setDraggingNodeId(node.id); setDragAnnouncement(`正在拖动 ${node.title}，请移动到课程或材料上`); }} onPointerDragStart={(node) => { setPointerDraggingNodeId(node.id); setDragAnnouncement(`正在拖动 ${node.title}，请移动到课程或材料上`); }} onDragOver={(node) => setDropTargetId(node.id)} onDrop={handleDrop} onDragEnd={finishDrag} />}
    </nav>

    <div className="sidebar-footer">
      <div className="workspace-avatar">A</div>
      <div><strong>个人工作区</strong><span>ReadWeave 权威存储</span></div>
      <button className="icon-button" data-action="tree-open-settings" aria-label="工作区设置" onClick={onSettings} title="工作区设置"><Icon name="settings" /></button>
    </div>
    <div className="sr-only" aria-live="polite" id="tree-drag-status">{dragAnnouncement}</div>
    {menu && actions && <TreeContextMenu menu={menu} actions={actions} onClose={() => setMenu(undefined)} />}
  </aside>;
}

function TreeNode({ node, allNodes, depth, expanded, selectedPageId, focusedNodeId, onFocus, onToggle, onSelectPage, onOpenMenu, forceOpen, actions, draggingNodeId, pointerDraggingNodeId, dropTargetId, onDragStart, onPointerDragStart, onDragOver, onDrop, onDragEnd }: {
  node: CourseTreeNode;
  allNodes: CourseTreeNode[];
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
  const selected = node.pageId === selectedPageId;
  const can = (capability: TreeNodeCapability) => Boolean(node.capabilities?.includes(capability));
  const activate = () => {
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
  return <div className="tree-node" data-node-id={node.id} data-dragging={draggingNodeId === node.id || pointerDraggingNodeId === node.id ? "true" : undefined} draggable={draggable} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", node.id); onDragStart(node); }} onDragEnd={onDragEnd}>
    <div className={`tree-row ${selected ? "selected" : ""} ${focusedNodeId === node.id ? "focused" : ""} ${dropTargetId === node.id ? "drop-target" : ""}`} data-depth={depth} data-node-kind={node.kind} style={{ "--tree-depth-px": `${depth * 20}px` } as CSSProperties} onContextMenu={(event) => onOpenMenu(node, event)} onDragOver={(event) => { if (!draggingNodeId || draggingNodeId === node.id) return; const source = flattenTree(allNodes).find(({ node: candidate }) => candidate.id === draggingNodeId)?.node; if (!source || !isValidDrop(source, node)) return; event.preventDefault(); event.dataTransfer.dropEffect = node.kind === "trash" ? "move" : "move"; onDragOver(node); }} onDrop={(event) => { event.preventDefault(); onDrop(node); }}>
      {draggable && <span className="tree-drag-handle" data-action="tree-drag" role="img" aria-label={`拖动 ${node.title}`} title="拖动到其他课程或调整顺序；键盘请使用 Alt+上/下箭头" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); onFocus(node.id); setPointerCaptureSafe(event.currentTarget, event.pointerId); onPointerDragStart(node); }}><Icon name="grip" /></span>}
      <button className="tree-main-button" data-action={`tree-open-${node.kind}`} onClick={activate} onFocus={() => onFocus(node.id)} onKeyDown={onKeyDown} aria-current={selected ? "page" : undefined} aria-expanded={hasChildren ? open : undefined} title={node.subtitle ? `${node.title} — ${node.subtitle}` : node.title}>
        <span className={`tree-chevron ${hasChildren ? "" : "empty"}`} aria-hidden="true"><Icon name={open ? "chevronDown" : "chevronRight"} /></span>
        <span className={`tree-kind kind-${node.kind}`}><Icon name={node.kind === "course" ? "book" : node.kind === "trash" ? "trash" : node.kind === "material" ? "layers" : node.kind === "section" ? "folder" : node.kind === "module" ? "layers" : node.kind === "release" ? "publish" : "document"} /></span>
        <span className="tree-copy"><strong>{node.title}</strong></span>
        {node.status && <span className={`status-dot status-${node.status}`} title={node.status} />}
      </button>
      {actions && <button className="tree-row-actions" data-action="tree-open-actions" onClick={(event) => onOpenMenu(node, event)} onFocus={() => onFocus(node.id)} aria-label={`打开 ${node.title} 的操作菜单`} aria-haspopup="menu" title="更多操作"><span aria-hidden="true">…</span></button>}
    </div>
    {hasChildren && open && <div>{node.children.map((child) => <TreeNode key={child.id} node={child} allNodes={allNodes} depth={depth + 1} expanded={expanded} selectedPageId={selectedPageId} focusedNodeId={focusedNodeId} onFocus={onFocus} onToggle={onToggle} onSelectPage={onSelectPage} onOpenMenu={onOpenMenu} forceOpen={forceOpen} actions={actions} draggingNodeId={draggingNodeId} pointerDraggingNodeId={pointerDraggingNodeId} dropTargetId={dropTargetId} onDragStart={onDragStart} onPointerDragStart={onPointerDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragEnd={onDragEnd} />)}</div>}
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
  if (!needle) return nodes;
  return nodes.flatMap((node) => {
    const children = filterTree(node.children, query);
    return node.title.toLocaleLowerCase().includes(needle) || node.subtitle?.toLocaleLowerCase().includes(needle) || children.length ? [{ ...node, children }] : [];
  });
}

function setPointerCaptureSafe(element: Element, pointerId: number): void {
  if (element instanceof HTMLElement && element.setPointerCapture) element.setPointerCapture(pointerId);
}
