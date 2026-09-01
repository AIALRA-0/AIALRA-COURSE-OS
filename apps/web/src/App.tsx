import { lazy, Suspense, useEffect, useMemo, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction, type CSSProperties } from "react";
import type { CourseConflict, CourseRelease, CourseTreeNode, GenerationCostEntry, GenerationJob, GenerationPlan, ImportRecord, LearningSession, MasteryRecord, ModelProviderConfig, ModelRoutePolicy, ReadWeaveSyncStatus, ReviewMap, TrashRecord, WorkspaceMode, WorkspaceSettings, WorkspaceTree } from "@course-os/contracts";
import { api } from "./api.js";
import { CourseTree, type CourseTreeActions } from "./CourseTree.js";
import { Icon } from "./Icon.js";
import { SlideViewer, type ViewState } from "./SlideViewer.js";

const ExplanationPanel = lazy(() => import("./ExplanationPanel.js").then((module) => ({ default: module.ExplanationPanel })));
const ReviewWorkspace = lazy(() => import("./ReviewWorkspace.js").then((module) => ({ default: module.ReviewWorkspace })));
const StudioWorkspace = lazy(() => import("./StudioWorkspace.js").then((module) => ({ default: module.StudioWorkspace })));

type MobileMode = "visual" | "lesson" | "practice";
type UtilityPanel = "search" | "sync" | "account" | "settings" | "trash" | null;
type TreeTextAction = { kind: "module" | "rename"; node: CourseTreeNode };

const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_DEFAULT_WIDTH = 276;

function clampSidebarWidth(value: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(value)));
}

function readSidebarWidth(): number {
  const saved = Number(localStorage.getItem("course-os-sidebar-width"));
  return Number.isFinite(saved) ? clampSidebarWidth(saved) : SIDEBAR_DEFAULT_WIDTH;
}

export function App() {
  const initialNavigation = useRef(readNavigationHash());
  const [releases, setReleases] = useState<CourseRelease[]>([]);
  const [tree, setTree] = useState<WorkspaceTree>();
  const [sync, setSync] = useState<ReadWeaveSyncStatus>();
  const [conflicts, setConflicts] = useState<CourseConflict[]>([]);
  const [reviewQueue, setReviewQueue] = useState<MasteryRecord[]>([]);
  const [reviewMap, setReviewMap] = useState<ReviewMap>();
  const [releaseId, setReleaseId] = useState(initialNavigation.current.releaseId);
  const [pageIndex, setPageIndex] = useState(initialNavigation.current.pageIndex);
  const [mode, setMode] = useState<WorkspaceMode>(initialNavigation.current.mode);
  const [session, setSession] = useState<LearningSession>();
  const [view, setView] = useState<ViewState>({ zoom: 1, panX: 0, panY: 0 });
  const [mobileMode, setMobileMode] = useState<MobileMode>("visual");
  const [theme, setTheme] = useState<"light" | "dark">((localStorage.getItem("course-os-theme") as "light" | "dark") || "light");
  const [importOpen, setImportOpen] = useState(false);
  const [importParentNodeId, setImportParentNodeId] = useState<string>();
  const [createCourseOpen, setCreateCourseOpen] = useState(false);
  const [utilityPanel, setUtilityPanel] = useState<UtilityPanel>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(() => localStorage.getItem("course-os-left-collapsed") === "true");
  const [rightCollapsed, setRightCollapsed] = useState(() => localStorage.getItem("course-os-right-collapsed") === "true");
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const sidebarResizeCleanup = useRef<(() => void) | undefined>(undefined);
  const [historyNode, setHistoryNode] = useState<CourseTreeNode>();
  const [moveNode, setMoveNode] = useState<CourseTreeNode>();
  const [textAction, setTextAction] = useState<TreeTextAction>();
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const refreshMetadata = async () => {
    const [workspaceTree, syncStatus, openConflicts, queue, workspaceSettings, map] = await Promise.all([
      api.workspaceTree(),
      api.syncStatus().catch((): ReadWeaveSyncStatus => ({ state: "offline", authority: "readweave", mode: "http", pendingWrites: 0, conflicts: 0, message: "ReadWeave 暂时不可访问" })),
      api.conflicts().catch(() => []),
      api.reviewQueue().catch(() => []),
      api.settings().catch(() => undefined),
      api.reviewMap().catch(() => undefined)
    ]);
    setTree(workspaceTree);
    setSync(syncStatus);
    setConflicts(openConflicts.filter((item) => item.status === "open"));
    setReviewQueue(queue);
    setReviewMap(map);
    if (workspaceSettings) {
      document.documentElement.style.setProperty("--course-font-scale", String(workspaceSettings.baseFontScale));
      if (workspaceSettings.theme === "light" || workspaceSettings.theme === "dark") setTheme(workspaceSettings.theme);
    }
  };

  useEffect(() => {
    Promise.all([api.releases(), refreshMetadata()]).then(([items]) => {
      setReleases(items);
      if (!items.some((item) => item.id === initialNavigation.current.releaseId)) setReleaseId(defaultRelease(items)?.id || "");
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "无法载入课程空间"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const followHashNavigation = () => {
      const navigation = readNavigationHash();
      initialNavigation.current = navigation;
      if (navigation.releaseId) setReleaseId(navigation.releaseId);
      setPageIndex(navigation.pageIndex);
      setMode(navigation.mode);
    };
    window.addEventListener("hashchange", followHashNavigation);
    return () => window.removeEventListener("hashchange", followHashNavigation);
  }, []);

  const release = useMemo(() => releases.find((item) => item.id === releaseId), [releaseId, releases]);
  const page = release?.pages[pageIndex];

  useEffect(() => {
    if (!release) return;
    setPageIndex((index) => Math.min(release.pages.length - 1, Math.max(0, index)));
    const savedSession = localStorage.getItem(`course-os-session:${release.id}`) || undefined;
    api.createSession(release.id, savedSession).then((created) => {
      setSession(created);
      localStorage.setItem(`course-os-session:${release.id}`, created.id);
      const restoredIndex = release.pages.findIndex((candidate) => candidate.id === created.currentPageId);
      if (!initialNavigation.current.hasExplicitPage && restoredIndex >= 0) setPageIndex(restoredIndex);
      setView({ zoom: created.zoom, panX: created.panX, panY: created.panY });
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "无法恢复学习位置"));
  }, [release?.id]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("course-os-theme", theme);
  }, [theme]);

  useEffect(() => { localStorage.setItem("course-os-left-collapsed", String(leftCollapsed)); }, [leftCollapsed]);
  useEffect(() => { localStorage.setItem("course-os-right-collapsed", String(rightCollapsed)); }, [rightCollapsed]);
  useEffect(() => { localStorage.setItem("course-os-sidebar-width", String(sidebarWidth)); }, [sidebarWidth]);
  useEffect(() => () => sidebarResizeCleanup.current?.(), []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setUtilityPanel("search");
      }
      if (event.key === "Escape") {
        setUtilityPanel(null);
        setMobileTreeOpen(false);
        setHistoryNode(undefined);
        setMoveNode(undefined);
        setTextAction(undefined);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!release || !page) return;
    const navigation = new URLSearchParams(location.hash.slice(1));
    navigation.set("mode", mode);
    navigation.set("release", release.id);
    navigation.set("page", String(pageIndex + 1));
    if (mode !== "review") {
      navigation.delete("reviewPlan");
      navigation.delete("reviewSession");
    }
    location.hash = navigation.toString();
    const activeSession = session?.courseReleaseId === release.id ? session : undefined;
    if (activeSession) api.updateSession(activeSession.id, { currentPageId: page.id }).then(setSession).catch(() => undefined);
  }, [mode, pageIndex, page?.id, release?.id]);

  const updateView = (next: ViewState) => {
    setView(next);
    const activeSession = session?.courseReleaseId === release?.id ? session : undefined;
    if (activeSession) api.updateSession(activeSession.id, next).then(setSession).catch(() => undefined);
  };

  const selectPage = (nextReleaseId: string, pageId: string) => {
    const nextRelease = releases.find((item) => item.id === nextReleaseId);
    const nextIndex = nextRelease?.pages.findIndex((item) => item.id === pageId) ?? -1;
    if (nextRelease && nextIndex >= 0) {
      initialNavigation.current.hasExplicitPage = true;
      setReleaseId(nextRelease.id);
      setPageIndex(nextIndex);
    }
  };

  const handlePublished = (published: CourseRelease) => {
    setReleases((current) => [published, ...current]);
    setReleaseId(published.id);
    setPageIndex(Math.min(pageIndex, published.pages.length - 1));
    refreshMetadata().catch(() => undefined);
  };

  const handleImported = (record: ImportRecord) => {
    Promise.all([api.releases(), refreshMetadata()]).then(([items]) => {
      setReleases(items);
      if (record.materialVersionId && items.some((item) => item.id === record.materialVersionId)) {
        setReleaseId(record.materialVersionId);
        setPageIndex(0);
        setMode("studio");
      }
    }).catch(() => undefined);
  };

  const runTreeAction = async (action: () => Promise<unknown>, success: string, pending = "正在保存…", refresh = true) => {
    setToast(pending);
    try { await action(); if (refresh) await refreshMetadata(); setToast(success); }
    catch (reason) { setToast(reason instanceof Error ? reason.message : "课程树操作失败"); }
  };

  const updateTreeAfterRename = (updated: CourseTreeNode) => {
    const replace = (nodes: CourseTreeNode[]): CourseTreeNode[] => nodes.map((node) => node.id === updated.id
      ? { ...node, ...updated, children: node.children }
      : { ...node, children: replace(node.children) });
    setTree((current) => current ? { ...current, courses: replace(current.courses), rootMaterials: replace(current.rootMaterials ?? []) } : current);
  };

  const adjustSidebarWidth = (delta: number) => setSidebarWidth((current) => clampSidebarWidth(current + delta));
  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 900) return;
    event.preventDefault();
    sidebarResizeCleanup.current?.();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const move = (moveEvent: globalThis.PointerEvent) => setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      sidebarResizeCleanup.current = undefined;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    sidebarResizeCleanup.current = finish;
  };

  const shellStyle = { "--course-sidebar": `${sidebarWidth}px` } as CSSProperties;

  const openTreeNode = (node: CourseTreeNode, nextMode: "learn" | "studio") => {
    const candidateReleaseId = node.currentReleaseId ?? node.releaseId;
    const candidateRelease = releases.find((item) => item.id === candidateReleaseId)
      ?? releases.find((item) => item.courseId === node.id && item.lifecycle !== "draft_source")
      ?? (node.kind === "course" ? releases.find((item) => item.courseId === node.id) : undefined);
    const candidatePage = candidateRelease?.pages[0];
    if (!candidateRelease || !candidatePage) {
      setToast("这个材料还没有可打开的正式页面");
      return;
    }
    selectPage(candidateRelease.id, candidatePage.id);
    setMode(nextMode);
  };

  const reorderTreeNode = async (node: CourseTreeNode, direction: "up" | "down") => {
    const siblings = node.kind === "course"
      ? (tree?.courses ?? []).filter((candidate) => candidate.kind === "course")
      : node.parentId
        ? (tree?.courses.find((course) => course.id === node.parentId)?.children ?? [])
        : (tree?.rootMaterials ?? []);
    const index = siblings.findIndex((candidate) => candidate.id === node.id);
    const target = index < 0 ? undefined : siblings[index + (direction === "up" ? -1 : 1)];
    if (!target) { setToast(direction === "up" ? "已经是最前面" : "已经是最后面"); return; }
    const sourceOrder = node.sortOrder ?? index;
    const targetOrder = target.sortOrder ?? (direction === "up" ? index - 1 : index + 1);
    await runTreeAction(async () => {
      await api.updateTreeNode(node, { sortOrder: targetOrder });
      await api.updateTreeNode(target, { sortOrder: sourceOrder });
    }, "顺序已更新");
  };

  const treeActions: CourseTreeActions = {
    createModule: (node) => setTextAction({ kind: "module", node }),
    importMaterial: (node) => { setImportParentNodeId(node.id); setImportOpen(true); },
    rename: (node) => setTextAction({ kind: "rename", node }),
    duplicate: (node) => void runTreeAction(() => api.duplicateTreeNode(node).then(() => undefined), "已建立新的草稿副本"),
    move: (node) => setMoveNode(node),
    moveTo: (node, parentId, sortOrder) => void runTreeAction(() => api.updateTreeNode(node, { parentId, sortOrder }).then(() => undefined), "项目位置已更新"),
    reorder: (node, direction) => void reorderTreeNode(node, direction),
    trash: (node) => {
      if (window.confirm(`确定把“${node.title}”移入回收站吗`)) void runTreeAction(() => api.trashTreeNode(node).then(() => undefined), "已移入回收站");
    },
    openMaterial: (node) => openTreeNode(node, "learn"),
    openStudio: (node) => {
      if (node.pageId && node.releaseId) { selectPage(node.releaseId, node.pageId); setMode("studio"); }
      else openTreeNode(node, "studio");
    },
    openReadWeave: (node) => { if (node.readweaveNoteId) void runTreeAction(async () => { const link = await api.deepLink(node.readweaveNoteId!); if (!link.verified) throw new Error("这个 ReadWeave 目标尚未验证"); window.open(link.url, "_blank", "noopener,noreferrer"); }, "已打开 ReadWeave 精细笔记"); },
    history: (node) => setHistoryNode(node),
    properties: (node) => void runTreeAction(async () => { const properties = await api.treeNodeProperties(node.id); setToast(`${properties.title} · 修订 ${properties.revision} · ${properties.syncState === "connected" ? "已同步" : "未同步"}`); }, "节点属性已读取"),
    openTrash: () => setUtilityPanel("trash")
  };

  if (error) return <main className="empty-state"><span className="empty-logo">CO</span><h1>Course OS 暂时无法启动</h1><p>{error}</p><button className="primary-button" data-action="app-reload" onClick={() => location.reload()}>重新载入</button></main>;
  if (loading) return <main className="empty-state"><div className="loader" /><h1>正在建立课程工作区</h1><p>正在读取 ReadWeave、课程树和固定发布版本</p></main>;
  if (!release || !page) return <div className="product-shell" style={shellStyle}>
    <header className="product-topbar"><div className="product-brand"><span className="brand-symbol"><span>C</span><span>O</span></span><div><strong>Course OS</strong><small>Course intelligence workspace</small></div></div><div className="product-actions"><button className="mobile-tree-button icon-button" data-action="open-mobile-tree" onClick={() => setMobileTreeOpen(true)} aria-label="打开课程项目树" title="打开课程项目树"><Icon name="panel" /></button><button className={`sync-indicator sync-${sync?.state || "offline"}`} data-action="open-sync-panel" onClick={() => setUtilityPanel("sync")}><span className="live-dot"/><span>{sync?.state === "connected" ? "ReadWeave 已连接" : "等待 ReadWeave"}</span></button><button className="profile-button" data-action="open-account" onClick={() => setUtilityPanel("account")} aria-label="账户菜单">A</button></div></header>
       <div className={`product-body ${leftCollapsed ? "left-collapsed" : ""}`}><CourseTree tree={tree} collapsed={leftCollapsed} onCollapse={() => setLeftCollapsed((value) => !value)} sidebarWidth={sidebarWidth} onResizeStart={startSidebarResize} onResizeKeyboard={adjustSidebarWidth} actions={treeActions} onSelectPage={() => undefined} onImport={() => setImportOpen(true)} onCreateCourse={() => setCreateCourseOpen(true)} onSettings={() => setUtilityPanel("settings")} /><section className="product-content empty-course-workspace"><span className="empty-logo">CO</span><h1>建立第一门课程</h1><p>先建立课程项目，再导入 PPTX、PDF 或 syllabus，系统会在 ReadWeave 中建立对应知识树</p><div><button className="primary-button" data-action="empty-create-course" onClick={() => setCreateCourseOpen(true)}><Icon name="plus" />新建课程</button><button className="quiet-button" data-action="empty-import-material" onClick={() => setImportOpen(true)}><Icon name="upload" />导入材料</button></div></section></div>
     <MobileTreeDrawer tree={tree} actions={treeActions} onClose={() => setMobileTreeOpen(false)} open={mobileTreeOpen} onSelectPage={() => setMobileTreeOpen(false)} onImport={() => { setMobileTreeOpen(false); setImportOpen(true); }} onCreateCourse={() => { setMobileTreeOpen(false); setCreateCourseOpen(true); }} onSettings={() => { setMobileTreeOpen(false); setUtilityPanel("settings"); }} />
     {importOpen && <ImportDialog courses={tree?.courses ?? []} parentNodeId={importParentNodeId} onClose={() => { setImportOpen(false); setImportParentNodeId(undefined); }} onImported={handleImported} />}
    {createCourseOpen && <CreateCourseDialog onClose={() => setCreateCourseOpen(false)} onCreated={() => refreshMetadata().catch(() => undefined)} />}
    {utilityPanel && <UtilityDialog panel={utilityPanel} releases={releases} sync={sync} conflicts={conflicts} theme={theme} onTheme={setTheme} onSelectPage={selectPage} onRefresh={refreshMetadata} onOpenTrash={() => setUtilityPanel("trash")} onClose={() => setUtilityPanel(null)} />}
    {historyNode && <HistoryDialog node={historyNode} releases={releases} onClose={() => setHistoryNode(undefined)} onSelectPage={selectPage} />}
    {textAction && <TreeTextDialog action={textAction} onClose={() => setTextAction(undefined)} onSubmit={(title) => { const action = textAction; setTextAction(undefined); if (action.kind === "module") void runTreeAction(() => api.createModule(action.node.id, title).then(() => undefined), "模块已建立"); else if (title !== action.node.title) void runTreeAction(() => api.updateTreeNode(action.node, { title }).then((updated) => { updateTreeAfterRename(updated); }), "名称已更新", "正在保存名称…", false); }} />}
    {moveNode && <MoveNodeDialog node={moveNode} tree={tree} onClose={() => setMoveNode(undefined)} onMove={(parentId) => { void runTreeAction(() => api.updateTreeNode(moveNode, { parentId }).then(() => undefined), "节点位置已更新"); setMoveNode(undefined); }} />}
    {toast && <div className="app-toast" role="status">{toast}</div>}
  </div>;

  return (
    <div className="product-shell" style={shellStyle}>
      <header className="product-topbar">
        <div className="product-brand"><span className="brand-symbol"><span>C</span><span>O</span></span><div><strong>Course OS</strong><small>Course intelligence workspace</small></div></div>

        <nav className="mode-switcher" aria-label="工作模式">
          <ModeButton actionId="mode-learn" active={mode === "learn"} icon="play" label="学习" onClick={() => setMode("learn")} />
          <ModeButton actionId="mode-studio" active={mode === "studio"} icon="edit" label="制作" onClick={() => setMode("studio")} />
          <ModeButton actionId="mode-review" active={mode === "review"} icon="review" label="复习" onClick={() => setMode("review")} />
        </nav>

         <div className="product-actions">
           <button className="mobile-tree-button icon-button" data-action="open-mobile-tree" onClick={() => setMobileTreeOpen(true)} aria-label="打开课程项目树" title="打开课程项目树"><Icon name="panel" /></button>
           <button className={`sync-indicator sync-${sync?.state || "offline"}`} data-action="open-sync-panel" onClick={() => setUtilityPanel("sync")}><span className="live-dot"/><span>{sync?.state === "connected" ? "ReadWeave 已同步" : "同步状态异常"}</span>{conflicts.length > 0 && <b>{conflicts.length}</b>}</button>
          <button className="command-button" data-action="open-global-search" onClick={() => setUtilityPanel("search")}><Icon name="command" /><span>全局搜索</span><kbd>⌘ K</kbd></button>
          <button className="icon-button" data-action="toggle-theme" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={theme === "light" ? "切换深色模式" : "切换浅色模式"}><Icon name={theme === "light" ? "moon" : "sun"} /></button>
          <button className="profile-button" data-action="open-account" onClick={() => setUtilityPanel("account")} aria-label="账户菜单">A</button>
        </div>
      </header>

      <div className={`product-body ${leftCollapsed ? "left-collapsed" : ""}`}>
        <CourseTree tree={tree} collapsed={leftCollapsed} onCollapse={() => setLeftCollapsed((value) => !value)} sidebarWidth={sidebarWidth} onResizeStart={startSidebarResize} onResizeKeyboard={adjustSidebarWidth} actions={treeActions} selectedPageId={page.id} onSelectPage={selectPage} onImport={() => setImportOpen(true)} onCreateCourse={() => setCreateCourseOpen(true)} onSettings={() => setUtilityPanel("settings")} />
        <section className="product-content">
          <Suspense fallback={<WorkspaceLoader />}>
            {mode === "studio" && <StudioWorkspace key={`${release.id}:${page.id}`} release={release} page={page} sync={sync} rightCollapsed={rightCollapsed} onToggleRight={() => setRightCollapsed((value) => !value)} onPublished={handlePublished} onChanged={() => refreshMetadata().catch(() => undefined)} />}
            {mode === "learn" && <LearningWorkspace release={release} pageIndex={pageIndex} setPageIndex={setPageIndex} session={session?.courseReleaseId === release.id ? session : undefined} view={view} updateView={updateView} mobileMode={mobileMode} setMobileMode={setMobileMode} rightCollapsed={rightCollapsed} onToggleRight={() => setRightCollapsed((value) => !value)} onEnterStudio={() => setMode("studio")} />}
             {mode === "review" && <ReviewWorkspace releases={releases} reviewMap={reviewMap} onOpenPage={(nextReleaseId, pageId) => { selectPage(nextReleaseId, pageId); setMode("learn"); }} onReviewChanged={refreshMetadata} />}
          </Suspense>
        </section>
      </div>

      <MobileTreeDrawer tree={tree} selectedPageId={page.id} actions={treeActions} onClose={() => setMobileTreeOpen(false)} open={mobileTreeOpen} onSelectPage={(nextReleaseId, nextPageId) => { setMobileTreeOpen(false); selectPage(nextReleaseId, nextPageId); }} onImport={() => { setMobileTreeOpen(false); setImportOpen(true); }} onCreateCourse={() => { setMobileTreeOpen(false); setCreateCourseOpen(true); }} onSettings={() => { setMobileTreeOpen(false); setUtilityPanel("settings"); }} />
       {importOpen && <ImportDialog courses={tree?.courses ?? []} parentNodeId={importParentNodeId} onClose={() => { setImportOpen(false); setImportParentNodeId(undefined); }} onImported={handleImported} />}
      {createCourseOpen && <CreateCourseDialog onClose={() => setCreateCourseOpen(false)} onCreated={() => refreshMetadata().catch(() => undefined)} />}
      {utilityPanel && <UtilityDialog panel={utilityPanel} releases={releases} sync={sync} conflicts={conflicts} theme={theme} onTheme={setTheme} onSelectPage={selectPage} onRefresh={refreshMetadata} onOpenTrash={() => setUtilityPanel("trash")} onClose={() => setUtilityPanel(null)} />}
      {historyNode && <HistoryDialog node={historyNode} releases={releases} onClose={() => setHistoryNode(undefined)} onSelectPage={selectPage} />}
      {textAction && <TreeTextDialog action={textAction} onClose={() => setTextAction(undefined)} onSubmit={(title) => { const action = textAction; setTextAction(undefined); if (action.kind === "module") void runTreeAction(() => api.createModule(action.node.id, title).then(() => undefined), "模块已建立"); else if (title !== action.node.title) void runTreeAction(() => api.updateTreeNode(action.node, { title }).then((updated) => { updateTreeAfterRename(updated); }), "名称已更新", "正在保存名称…", false); }} />}
      {moveNode && <MoveNodeDialog node={moveNode} tree={tree} onClose={() => setMoveNode(undefined)} onMove={(parentId) => { void runTreeAction(() => api.updateTreeNode(moveNode, { parentId }).then(() => undefined), "节点位置已更新"); setMoveNode(undefined); }} />}
      {toast && <div className="app-toast" role="status">{toast}</div>}
    </div>
  );
}

function ModeButton({ actionId, active, icon, label, onClick }: { actionId: string; active: boolean; icon: "edit" | "play" | "review"; label: string; onClick: () => void }) {
  return <button className={active ? "active" : ""} data-action={actionId} onClick={onClick}><Icon name={icon} />{label}</button>;
}

function MobileTreeDrawer({ tree, selectedPageId, actions, open, onClose, onSelectPage, onImport, onCreateCourse, onSettings }: {
  tree?: WorkspaceTree;
  selectedPageId?: string;
  actions: CourseTreeActions;
  open: boolean;
  onClose: () => void;
  onSelectPage: (releaseId: string, pageId: string) => void;
  onImport: () => void;
  onCreateCourse: () => void;
  onSettings: () => void;
}) {
  if (!open) return null;
  return <div className="mobile-tree-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="mobile-tree-drawer" role="dialog" aria-modal="true" aria-label="课程项目树" onMouseDown={(event) => event.stopPropagation()}>
      <CourseTree tree={tree} selectedPageId={selectedPageId} collapsed={false} onCollapse={onClose} onSelectPage={onSelectPage} onImport={onImport} onCreateCourse={onCreateCourse} onSettings={onSettings} actions={actions} />
    </div>
  </div>;
}

function LearningWorkspace({ release, pageIndex, setPageIndex, session, view, updateView, mobileMode, setMobileMode, rightCollapsed, onToggleRight, onEnterStudio }: {
  release: CourseRelease;
  pageIndex: number;
  setPageIndex: Dispatch<SetStateAction<number>>;
  session?: LearningSession;
  view: ViewState;
  updateView: (next: ViewState) => void;
  mobileMode: MobileMode;
  setMobileMode: (mode: MobileMode) => void;
  rightCollapsed: boolean;
  onToggleRight: () => void;
  onEnterStudio: () => void;
}) {
  const page = release.pages[pageIndex]!;
  const [pageDockOpen, setPageDockOpen] = useState(false);
  const lessonColumnRef = useRef<HTMLDivElement>(null);
  const lessonStripRef = useRef<HTMLElement>(null);

  useEffect(() => {
    lessonColumnRef.current?.scrollTo({ top: 0, behavior: "auto" });
    if (!pageDockOpen) return;
    const strip = lessonStripRef.current;
    const active = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !active) return;
    strip.scrollTo({
      left: active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2,
      behavior: "auto",
    });
  }, [page.id, pageDockOpen, release.id]);

  return <div className="learning-workspace">
    <header className="learning-header">
      <div><div className="breadcrumbs"><span>{release.courseTitle}</span><Icon name="chevronRight" /><span>{release.moduleTitle}</span></div><h1>{page.title}</h1></div>
      <div className="learning-header-actions"><button className="quiet-button" data-action="learn-open-studio" onClick={onEnterStudio}><Icon name="edit" />制作本页</button><div className="learning-progress"><span>学习进度</span><strong>{pageIndex + 1} / {release.pages.length}</strong><div><i style={{ width: `${(pageIndex + 1) / release.pages.length * 100}%` }} /></div></div></div>
    </header>

    <nav className="mobile-tabs" aria-label="手机学习模式">
      <button className={mobileMode === "visual" ? "active" : ""} data-action="mobile-visual" onClick={() => setMobileMode("visual")}>原始课件</button>
      <button className={mobileMode === "lesson" ? "active" : ""} data-action="mobile-lesson" onClick={() => setMobileMode("lesson")}>老师讲解</button>
      <button className={mobileMode === "practice" ? "active" : ""} data-action="mobile-practice" onClick={() => setMobileMode("practice")}>提问与测验</button>
    </nav>

    <main className={`learning-grid mode-${mobileMode} ${rightCollapsed ? "right-is-collapsed" : ""}`}>
      <div className="visual-column"><SlideViewer imageUrl={page.imageUrl} title={page.title} value={view} onChange={updateView} /></div>
      {rightCollapsed
          ? <aside className="right-collapsed-rail"><button data-action="right-expand-learn" onClick={onToggleRight} aria-label="展开教学栏" title="展开教学栏"><Icon name="chevronLeft" /><span>展开讲解</span></button></aside>
        : <div className="lesson-column" ref={lessonColumnRef}><div className="column-collapse-row"><span>老师讲解</span><button data-action="right-collapse-learn" onClick={onToggleRight} aria-label="收起教学栏" title="收起教学栏"><Icon name="chevronRight" /></button></div><Suspense fallback={<WorkspaceLoader compact />}><ExplanationPanel release={release} page={page} sessionId={session?.id} onEnterStudio={onEnterStudio} /></Suspense></div>}
    </main>

    <footer className={`page-dock ${pageDockOpen ? "expanded" : "collapsed"}`}>
      <div className="page-dock-summary">
        <button data-action="page-previous" disabled={pageIndex === 0} title={pageIndex === 0 ? "已经是第一页" : "打开上一页"} onClick={() => setPageIndex((index) => index - 1)}><Icon name="arrowLeft" />上一页</button>
        <button className="page-dock-toggle" data-action="toggle-page-dock" onClick={() => setPageDockOpen((open) => !open)} aria-expanded={pageDockOpen}><span>第 {page.pageNumber} 页 · {page.title}</span><small>{pageDockOpen ? "收起全部页面" : `展开全部 ${release.pages.length} 页`}</small><Icon name={pageDockOpen ? "chevronUp" : "chevronDown"} /></button>
        <button data-action="page-next" disabled={pageIndex === release.pages.length - 1} title={pageIndex === release.pages.length - 1 ? "已经是最后一页" : "打开下一页"} onClick={() => setPageIndex((index) => index + 1)}>下一页<Icon name="arrowRight" /></button>
      </div>
      {pageDockOpen && <nav className="lesson-strip" ref={lessonStripRef} aria-label="课程全部页面">{release.pages.map((item, index) => <button key={item.id} data-action="page-select" className={index === pageIndex ? "active" : ""} aria-current={index === pageIndex ? "page" : undefined} onClick={() => setPageIndex(index)}><span>{item.pageNumber}</span><div><strong>{item.title}</strong><small>{item.quality.publishable ? "讲解已验证" : "等待审核"}</small></div></button>)}</nav>}
    </footer>
  </div>;
}

function UtilityDialog({ panel, releases, sync, conflicts, theme, onTheme, onSelectPage, onRefresh, onOpenTrash, onClose }: {
  panel: Exclude<UtilityPanel, null>;
  releases: CourseRelease[];
  sync?: ReadWeaveSyncStatus;
  conflicts: CourseConflict[];
  theme: "light" | "dark";
  onTheme: (theme: "light" | "dark") => void;
  onSelectPage: (releaseId: string, pageId: string) => void;
  onRefresh: () => Promise<void>;
  onOpenTrash: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const latestReleases = releases.filter((release) => !releases.some((candidate) => candidate.moduleId === release.moduleId && candidate.version > release.version));
  const results = latestReleases.flatMap((release) => release.pages.map((page) => ({ release, page }))).filter(({ release, page }) => {
    const needle = query.trim().toLocaleLowerCase();
    return !needle || `${release.courseTitle} ${release.moduleTitle} ${page.title} ${page.pageNumber}`.toLocaleLowerCase().includes(needle);
  }).slice(0, 40);
  const refresh = async () => { setRefreshing(true); try { await onRefresh(); } finally { setRefreshing(false); } };
  return <div className="modal-backdrop utility-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="utility-dialog" role="dialog" aria-modal="true" aria-label={panelTitle(panel)}>
      <header><div><span className="section-kicker">COURSE OS</span><h2>{panelTitle(panel)}</h2></div><button className="icon-button" data-action="close-utility-panel" onClick={onClose} aria-label="关闭"><span aria-hidden="true">×</span></button></header>
      {panel === "search" && <div className="utility-content"><label className="utility-search"><Icon name="search" /><input data-action="search-pages" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索课程、材料、页面或页码" /></label><div className="search-results">{results.map(({ release, page }) => <button key={`${release.id}:${page.id}`} data-action="search-open-page" onClick={() => { onSelectPage(release.id, page.id); onClose(); }}><span>{page.pageNumber}</span><div><strong>{page.title}</strong><small>{release.courseTitle} · {release.moduleTitle}</small></div><Icon name="arrowRight" /></button>)}{results.length === 0 && <p className="empty-inline">没有找到匹配页面</p>}</div></div>}
      {panel === "sync" && <div className="utility-content"><div className={`sync-card sync-${sync?.state || "offline"}`}><span className="live-dot"/><div><strong>{sync?.state === "connected" ? "ReadWeave 已连接" : "ReadWeave 尚未连接"}</strong><span>{sync?.message || "尚未取得同步说明"}</span></div></div><dl className="utility-definitions"><div><dt>权威来源</dt><dd>ReadWeave</dd></div><div><dt>待写入</dt><dd>{sync?.pendingWrites ?? 0}</dd></div><div><dt>冲突</dt><dd>{conflicts.length}</dd></div></dl>{conflicts.length > 0 && <div className="conflict-summary">{conflicts.map((conflict) => <p key={conflict.id}><Icon name="warning" />{conflict.objectType} · {conflict.objectId}</p>)}</div>}<button className="primary-button" data-action="refresh-sync-status" aria-describedby="refresh-sync-status-reason" disabled={refreshing} onClick={refresh}>{refreshing ? "正在重新检查" : "重新检查同步状态"}</button><span id="refresh-sync-status-reason" className="sr-only">{refreshing ? "正在读取 ReadWeave 连接和待同步操作" : "重新读取 ReadWeave 连接、待写入和冲突状态"}</span></div>}
      {panel === "settings" && <SettingsPanel theme={theme} onTheme={onTheme} sync={sync} onOpenTrash={onOpenTrash} />}
      {panel === "trash" && <TrashPanel onRefresh={onRefresh} />}
      {panel === "account" && <div className="utility-content account-panel"><span className="account-avatar">A</span><h3>Personal workspace</h3><p>当前课程内容由 ReadWeave 统一保存，身份验证由 Authentik 管理</p><a className="primary-button" href="/_aialra_auth/logout">退出登录</a></div>}
    </section>
  </div>;
}

function panelTitle(panel: Exclude<UtilityPanel, null>) {
  return ({ search: "全局课程搜索", sync: "ReadWeave 同步状态", account: "账户", settings: "工作区设置", trash: "回收站" })[panel];
}

type SettingsTab = "general" | "appearance" | "learning" | "readweave" | "providers" | "routing" | "data" | "diagnostics";

function SettingsPanel({ theme, onTheme, sync, onOpenTrash }: { theme: "light" | "dark"; onTheme: (theme: "light" | "dark") => void; sync?: ReadWeaveSyncStatus; onOpenTrash: () => void }) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [settings, setSettings] = useState<WorkspaceSettings>({ workspaceId: "personal", language: "zh-CN", theme, baseFontScale: 1.1, defaultQualityMode: "balanced", learningAutoAdvance: false, showEnglishLabels: false, updatedAt: new Date(0).toISOString() });
  const [providers, setProviders] = useState<ModelProviderConfig[]>([]);
  const [policy, setPolicy] = useState<ModelRoutePolicy>({ workspaceId: "personal", rules: [], allowAialraEmergencyFallback: false, updatedAt: new Date(0).toISOString() });
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [trashCount, setTrashCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([api.settings(), api.modelProviders(), api.modelRoutePolicy(), api.trash()]).then(([loadedSettings, loadedProviders, loadedPolicy, trash]) => {
      setSettings(loadedSettings);
      if (loadedSettings.theme === "light" || loadedSettings.theme === "dark") onTheme(loadedSettings.theme);
      setProviders(loadedProviders);
      setPolicy(loadedPolicy);
      setTrashCount(trash.length);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "设置读取失败"));
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--course-font-scale", String(settings.baseFontScale));
  }, [settings.baseFontScale]);

  const saveSettings = async () => {
    setBusy(true); setError("");
    try {
      const saved = await api.saveSettings(settings);
      setSettings(saved);
      if (saved.theme === "light" || saved.theme === "dark") onTheme(saved.theme);
      localStorage.setItem("course-os-language", saved.language);
      localStorage.setItem("course-os-budget", saved.defaultQualityMode);
      setNotice("工作区设置已保存");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "设置保存失败"); }
    finally { setBusy(false); }
  };

  const savePolicy = async () => {
    setBusy(true); setError("");
    try { setPolicy(await api.saveModelRoutePolicy(policy)); setNotice("模型路由规则已保存"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "路由规则保存失败"); }
    finally { setBusy(false); }
  };

  const saveSecret = async (providerId: string) => {
    const secret = secrets[providerId]?.trim();
    if (!secret) return;
    setBusy(true); setError("");
    try {
      const saved = await api.saveProviderCredential(providerId, secret);
      setProviders((current) => current.map((provider) => provider.id === providerId ? { ...provider, credential: saved.credential } : provider));
      setSecrets((current) => ({ ...current, [providerId]: "" }));
      setNotice("接口密钥已加密保存，页面不会回显完整密钥");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "接口密钥保存失败"); }
    finally { setBusy(false); }
  };

  const saveProvider = async (provider: ModelProviderConfig) => {
    setBusy(true); setError("");
    try {
      const saved = await api.updateModelProvider(provider.id, { baseUrl: provider.baseUrl, enabled: provider.enabled });
      setProviders((current) => current.map((item) => item.id === provider.id ? saved : item));
      setNotice(`${provider.displayName} 设置已保存`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "供应商设置保存失败"); }
    finally { setBusy(false); }
  };

  const testProvider = async (providerId: string) => {
    setBusy(true); setError("");
    try {
      const checked = await api.testProvider(providerId);
      setProviders((current) => current.map((provider) => provider.id === providerId ? checked : provider));
      setNotice(checked.health?.message || "供应商检查完成");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "供应商连接检查失败"); }
    finally { setBusy(false); }
  };

  const updateSetting = <K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));
  const tabs: Array<[SettingsTab, string]> = [["general", "通用"], ["appearance", "外观与字号"], ["learning", "学习偏好"], ["readweave", "ReadWeave"], ["providers", "模型供应商"], ["routing", "模型路由"], ["data", "数据与版本"], ["diagnostics", "诊断"]];
  return <div className="settings-page">
    <aside className="settings-nav"><div className="settings-nav-title"><strong>工作区设置</strong></div>{tabs.map(([key, label]) => <button key={key} data-action={`settings-tab:${key}`} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}<Icon name="chevronRight" /></button>)}<div className="settings-nav-foot"><span className={`settings-health health-${sync?.state || "offline"}`} /><span>{sync?.state === "connected" ? "ReadWeave 已连接" : "等待连接"}</span></div></aside>
    <main className="settings-main">
      <header className="settings-main-header"><div><h3>{tabs.find(([key]) => key === tab)?.[1]}</h3></div></header>
      <div className="settings-main-content">
        {tab === "general" && <SettingsSection title="工作区行为" description="这些设置会影响新导入材料和整个课程播放器"><SettingsField label="内容语言"><select value={settings.language} onChange={(event) => updateSetting("language", event.target.value as WorkspaceSettings["language"])}><option value="zh-CN">简体中文</option><option value="en">English</option></select></SettingsField><SettingsField label="默认生成质量"><select value={settings.defaultQualityMode} onChange={(event) => updateSetting("defaultQualityMode", event.target.value as WorkspaceSettings["defaultQualityMode"])}><option value="economy">经济：优先节省额度</option><option value="balanced">平衡：默认选择</option><option value="quality">质量：更长讲解和更严格评审</option></select></SettingsField><SettingsSaveButton busy={busy} onClick={saveSettings} /></SettingsSection>}
        {tab === "appearance" && <SettingsSection title="让内容更容易看清" description="字体比例保存在个人工作区，不会改变课程发布内容"><SettingsField label="界面主题"><select value={settings.theme === "system" ? theme : settings.theme} onChange={(event) => { const next = event.target.value as WorkspaceSettings["theme"]; updateSetting("theme", next); if (next !== "system") onTheme(next); }}><option value="light">亮色</option><option value="dark">暗色</option><option value="system">跟随系统</option></select></SettingsField><SettingsField label="正文大小"><select value={settings.baseFontScale} onChange={(event) => updateSetting("baseFontScale", Number(event.target.value) as WorkspaceSettings["baseFontScale"])}><option value="1">标准</option><option value="1.1">较大</option><option value="1.2">大字</option><option value="1.3">特大</option></select></SettingsField><SettingsField label="显示英文辅助标签"><input type="checkbox" checked={settings.showEnglishLabels} onChange={(event) => updateSetting("showEnglishLabels", event.target.checked)} />保留英文术语标签</SettingsField><SettingsSaveButton busy={busy} onClick={saveSettings} /></SettingsSection>}
        {tab === "learning" && <SettingsSection title="学习节奏" description="学习位置、缩放和未提交答案会在刷新后恢复"><SettingsField label="学习完成一页后自动进入下一页"><input type="checkbox" checked={settings.learningAutoAdvance} onChange={(event) => updateSetting("learningAutoAdvance", event.target.checked)} />开启自动翻页</SettingsField><div className="settings-callout"><Icon name="target" /><span>完整答案不会直接生成掌握证据，系统还需要无提示和延迟或迁移题表现</span></div><SettingsSaveButton busy={busy} onClick={saveSettings} /></SettingsSection>}
        {tab === "readweave" && <SettingsSection title="ReadWeave 权威连接" description="正式讲解、问答、题库、掌握状态和复习记录统一保存在 ReadWeave"><div className={`settings-connection ${sync?.state || "offline"}`}><span className="live-dot" /><div><strong>{sync?.state === "connected" ? "连接正常" : "当前无法确认连接"}</strong><span>{sync?.message || "等待 Course OS 读取连接状态"}</span></div></div><SettingsRow label="公开跳转" value="由服务器验证" /><SettingsRow label="浏览器密钥" value="不会下发" /><SettingsRow label="当前待写入" value={String(sync?.pendingWrites ?? 0)} /><SettingsRow label="未解决冲突" value={String(sync?.conflicts ?? 0)} /></SettingsSection>}
        {tab === "providers" && <SettingsSection title="模型供应商" description="密钥只提交给服务端加密保存，浏览器只看到配置状态和末尾四位"><div className="provider-list">{providers.map((provider) => <article className="provider-card" key={provider.id}><header><div><strong>{provider.displayName}</strong><span>{provider.baseUrl || "应急路由，默认关闭"}</span></div><span className={`provider-status ${provider.credential.configured ? "configured" : "unconfigured"}`}>{provider.credential.configured ? provider.credential.maskedValue || "已配置" : "未配置"}</span></header><div className="provider-models">{provider.models.map((model) => <span key={model.id}>{model.displayName} · {model.protocol} · {model.billingMode === "subscription_quota" ? "套餐额度" : model.billingMode === "metered" ? "按量计费" : "未标记"}</span>)}</div><div className="provider-config"><label><span>接口地址</span><input value={provider.baseUrl} disabled={provider.id === "aialra-router"} placeholder="https://..." onChange={(event) => setProviders((current) => current.map((item) => item.id === provider.id ? { ...item, baseUrl: event.target.value } : item))} /></label><label className="provider-enabled"><input type="checkbox" checked={provider.enabled} onChange={(event) => setProviders((current) => current.map((item) => item.id === provider.id ? { ...item, enabled: event.target.checked } : item))} />允许路由使用</label><button className="quiet-button" disabled={busy} onClick={() => void saveProvider(provider)}>保存配置</button></div><div className="provider-actions"><input type="password" value={secrets[provider.id] || ""} placeholder={provider.credential.configured ? "输入新密钥以替换" : "粘贴接口密钥"} onChange={(event) => setSecrets((current) => ({ ...current, [provider.id]: event.target.value }))} autoComplete="new-password" /><button className="quiet-button" disabled={busy || !secrets[provider.id]?.trim()} onClick={() => void saveSecret(provider.id)}>保存密钥</button><button className="quiet-button" disabled={busy} onClick={() => void testProvider(provider.id)}>测试连接</button></div>{provider.health && <p className="provider-health"><span className={`settings-health health-${provider.health.state}`} />{provider.health.message}</p>}</article>)}</div></SettingsSection>}
        {tab === "routing" && <SettingsSection title="阶段模型路由" description="优先使用 OpenCode Go 或 DeepSeek，AIALRA 只作为手动打开的应急回退"><div className="route-editor">{policy.rules.map((rule, index) => { const provider = providers.find((item) => item.id === rule.providerId); return <div className="route-editor-row" key={`${rule.stage}-${index}`}><strong>{routeStageLabel(rule.stage)}</strong><select value={rule.providerId} onChange={(event) => setPolicy((current) => ({ ...current, rules: current.rules.map((item, itemIndex) => itemIndex === index ? { ...item, providerId: event.target.value } : item) }))}>{providers.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select><select value={rule.modelId} onChange={(event) => setPolicy((current) => ({ ...current, rules: current.rules.map((item, itemIndex) => itemIndex === index ? { ...item, modelId: event.target.value } : item) }))} aria-label={`${routeStageLabel(rule.stage)}模型`}><option value={rule.modelId}>{rule.modelId}</option>{provider?.models.filter((item) => item.id !== rule.modelId).map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></div>; })}</div><label className="settings-checkbox"><input type="checkbox" checked={policy.allowAialraEmergencyFallback} onChange={(event) => setPolicy((current) => ({ ...current, allowAialraEmergencyFallback: event.target.checked }))} />允许手动启用 AIALRA 应急回退</label><SettingsSaveButton busy={busy} onClick={savePolicy} /></SettingsSection>}
        {tab === "data" && <SettingsSection title="数据与版本" description="正式版本不可原位修改，删除默认进入 ReadWeave 回收站"><SettingsRow label="权威内容" value="ReadWeave" /><SettingsRow label="回收站记录" value={`${trashCount} 条`} /><SettingsRow label="正式发布" value="不可变，可回滚" /><SettingsRow label="原始材料" value="私有、内容寻址、去重保存" /><div className="settings-callout"><Icon name="archive" /><span>测试课程、黄金样本和旧发布版本仍用于回归，但不会混入正式课程树</span></div><button className="quiet-button settings-trash-button" data-action="settings-open-trash" onClick={onOpenTrash}>打开回收站<Icon name="arrowRight" /></button></SettingsSection>}
        {tab === "diagnostics" && <SettingsSection title="连接与诊断" description="这里显示可核对的状态，不显示密钥"><SettingsRow label="Course OS API" value="已载入当前页面" /><SettingsRow label="ReadWeave" value={sync?.state === "connected" ? "已连接" : "离线或待检查"} /><SettingsRow label="同步队列" value={`${sync?.pendingWrites ?? 0} 条待处理`} /><SettingsRow label="冲突" value={`${sync?.conflicts ?? 0} 条`} /><button className="primary-button" data-action="settings-reload" aria-describedby="settings-reload-reason" disabled={busy} onClick={() => window.location.reload()}>重新载入并重试</button><span id="settings-reload-reason" className="sr-only">{busy ? "当前有设置操作正在保存" : "重新载入页面并重新检查连接"}</span></SettingsSection>}
        {notice && <p className="settings-notice"><Icon name="check" />{notice}</p>}
        {error && <p className="settings-error"><Icon name="warning" />{error}</p>}
      </div>
    </main>
  </div>;
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { return <section className="settings-section"><div className="settings-section-heading"><h4>{title}</h4><p>{description}</p></div>{children}</section>; }
function SettingsField({ label, children }: { label: string; children: React.ReactNode }) { return <label className="settings-field"><span>{label}</span>{children}</label>; }
function SettingsRow({ label, value }: { label: string; value: string }) { return <div className="settings-row"><span>{label}</span><strong>{value}</strong></div>; }
function SettingsSaveButton({ busy, onClick }: { busy: boolean; onClick: () => void }) { return <><button className="primary-button settings-save" data-action="settings-save" aria-describedby="settings-save-reason" disabled={busy} onClick={onClick}>{busy ? "保存中" : "保存设置"}</button><span id="settings-save-reason" className="sr-only">{busy ? "正在保存工作区设置" : "保存当前设置到 Course OS"}</span></>; }
function routeStageLabel(stage: string) { return ({ extract: "来源提取", atomize: "页面拆解", teach: "教授讲解", review: "独立评审", repair: "局部修复", question_refill: "补充题目", qa: "课堂问答" } as Record<string, string>)[stage] || stage; }

function WorkspaceLoader({ compact = false }: { compact?: boolean }) {
  return <div className={`workspace-loader ${compact ? "compact" : ""}`}><div className="loader" /><span>正在准备课程工具</span></div>;
}

function ImportDialog({ courses, parentNodeId, onClose, onImported }: { courses: WorkspaceTree["courses"]; parentNodeId?: string; onClose: () => void; onImported: (record: ImportRecord) => void }) {
  const [file, setFile] = useState<File>();
  const [courseId, setCourseId] = useState(courses[0]?.id || "");
  const [record, setRecord] = useState<ImportRecord>();
  const [qualityMode, setQualityMode] = useState(localStorage.getItem("course-os-budget") || "balanced");
  const [language, setLanguage] = useState(localStorage.getItem("course-os-language") || "zh-CN");
  const [autoGenerate, setAutoGenerate] = useState(true);
  const [generationPlan, setGenerationPlan] = useState<GenerationPlan>();
  const [generationJob, setGenerationJob] = useState<GenerationJob>();
  const [generationCosts, setGenerationCosts] = useState<GenerationCostEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const completedNotified = useRef(false);
  useEffect(() => {
    if (!record || ["failed", "rejected"].includes(record.state)) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const updated = await api.importRecord(record.id);
        if (cancelled) return;
        setRecord(updated);
        if (updated.state === "ready" && !completedNotified.current) {
          completedNotified.current = true;
          onImported(updated);
        }
        if (updated.generationPlanId) {
          const [planResult, costs] = await Promise.all([
            api.generationPlan(updated.generationPlanId),
            api.costs(updated.materialVersionId ? { materialVersionId: updated.materialVersionId } : {})
          ]);
          if (!cancelled) {
            setGenerationPlan(planResult.plan);
            setGenerationJob(planResult.currentJob);
            setGenerationCosts(costs.entries);
          }
        } else if (updated.generationJobId) {
          const [job, costs] = await Promise.all([api.generationJob(updated.generationJobId), api.costs({ jobId: updated.generationJobId })]);
          if (!cancelled) {
            setGenerationPlan(undefined);
            setGenerationJob(job);
            setGenerationCosts(costs.entries);
          }
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取导入与生成进度");
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [record?.id]);
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const imported = await api.importMaterial(file, courseId || undefined, { qualityMode, language, parentNodeId, autoGenerate });
      setRecord(imported);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "材料导入失败"); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <header><div><span className="section-kicker">NEW MATERIAL</span><h2 id="import-title">导入课程材料</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><span aria-hidden="true">×</span></button></header>
      {!record ? <>
        <label className={`drop-zone ${file ? "has-file" : ""}`}>
          <input type="file" accept=".pptx,.pdf,.md,.txt" onChange={(event) => setFile(event.target.files?.[0])} />
          <span className="drop-icon"><Icon name={file ? "check" : "upload"} /></span>
          <strong>{file ? file.name : "选择 PPTX、PDF 或 syllabus"}</strong>
          <p>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB · 将先执行安全检查` : "原始材料保持私有，上传后先隔离检查再进入解析"}</p>
          <span className="file-types">PPTX · PDF · MD · TXT</span>
        </label>
        <div className="import-options"><label><span>目标课程</span><select value={courseId} onChange={(event) => setCourseId(event.target.value)}><option value="">暂不归类</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label><label><span>生成质量</span><select value={qualityMode} onChange={(event) => setQualityMode(event.target.value)}><option value="economy">经济</option><option value="balanced">平衡</option><option value="quality">质量</option></select></label><label><span>内容语言</span><select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="zh-CN">简体中文</option><option value="en">English</option></select></label></div>
        <label className="import-auto-generate"><input type="checkbox" checked={autoGenerate} onChange={(event) => setAutoGenerate(event.target.checked)} /><span><strong>导入后自动生成整套讲解</strong><small>默认开启，只写入候选草稿，不会自动发布正式课程</small></span></label>
        {error && <p className="dialog-error"><Icon name="warning" />{error}</p>}
        <footer><button className="quiet-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!file || busy} onClick={upload}><Icon name="sparkles" />{busy ? "正在安全检查" : "导入并开始解析"}</button></footer>
      </> : <ImportProgress record={record} plan={generationPlan} job={generationJob} costs={generationCosts} onClose={onClose} />}
    </section>
  </div>;
}

function ImportProgress({ record, plan, job, costs, onClose }: { record: ImportRecord; plan?: GenerationPlan; job?: GenerationJob; costs: GenerationCostEntry[]; onClose: () => void }) {
  const importInfo = importStatus(record.state);
  const auto = record.autoGenerate !== false;
  const planState = plan?.state;
  const terminalJob = !auto || Boolean(planState && ["awaiting_review", "completed", "failed", "cancelled"].includes(planState)) || Boolean(!plan && job && ["completed", "failed", "cancelled"].includes(job.state));
  const finished = ["failed", "rejected"].includes(record.state) || (record.state === "ready" && terminalJob);
  const generated = plan?.completedPageIds.length ?? job?.completedPageIds.length ?? 0;
  const total = plan?.pageIds.length ?? job?.pageIds.length ?? record.pageIds?.length ?? 0;
  const generationProgress = total ? generated / total : 0;
  const progress = record.state === "ready" && auto ? 65 + generationProgress * 35 : importInfo.progress;
  const failed = plan?.failedPageIds.length ?? job?.failedPageIds.length ?? 0;
  const latestCost = costs.at(-1);
  const spentUsd = plan?.spentUsd ?? job?.spentUsd ?? 0;
  const failedState = record.state === "failed" || record.state === "rejected" || planState === "failed" || job?.state === "failed";
  const statusTitle = record.state !== "ready" ? importInfo.title : !auto ? "材料草稿已经就绪" : !plan && !job ? "正在建立整套生成任务" : planState === "awaiting_review" ? "候选讲解已暂停，等待审核" : planState === "completed" || job?.state === "completed" ? "候选讲解已经生成" : planState === "failed" || job?.state === "failed" ? "生成任务已停止" : planState === "cancelled" || job?.state === "cancelled" ? "生成任务已取消" : "正在逐页生成候选讲解";
  const statusDetail = record.state !== "ready" ? importInfo.detail : !auto ? "已按你的选择跳过自动生成" : plan ? `已完成 ${generated}/${total} 页${failed ? `，失败 ${failed} 页，可只重试失败页面` : ""}${planState === "awaiting_review" ? "，当前批次已暂停" : ""}` : job ? `已完成 ${generated}/${total} 页${failed ? `，失败 ${failed} 页，可只重试失败页面` : ""}` : "转换结果已保存，正在建立唯一的幂等生成计划";
  return <div className={`import-success import-state-${record.state}`}><span>{failedState ? <Icon name="warning" /> : finished ? <Icon name="check" /> : <span className="loader" />}</span><h3>{statusTitle}</h3><p>{record.originalName}</p><div className="import-progress" aria-label="导入与生成进度"><i style={{ width: `${progress}%` }} /></div><p className="import-status-copy">{statusDetail}</p><dl><div><dt>转换页数</dt><dd>{record.pageIds?.length ?? "—"}</dd></div><div><dt>生成进度</dt><dd>{auto ? `${generated}/${total || "—"}` : "未启用"}</dd></div><div><dt>失败页面</dt><dd>{failed}</dd></div><div><dt>实际模型</dt><dd>{latestCost ? `${latestCost.provider} / ${latestCost.model}` : "等待首次调用"}</dd></div><div><dt>累计成本</dt><dd>${spentUsd.toFixed(4)}</dd></div><div><dt>发布状态</dt><dd>候选草稿，未发布</dd></div></dl>{record.issues.length > 0 && <p className="dialog-error"><Icon name="warning" />{record.issues.join(" · ")}</p>}<button className="primary-button" disabled={!finished} onClick={onClose}>{finished ? "打开课程工作区" : "正在处理"}</button></div>;
}

function importStatus(state: ImportRecord["state"]): { title: string; detail: string; progress: number } {
  if (state === "accepted" || state === "quarantined") return { title: "安全检查已通过", detail: "材料正在进入无网络转换环境", progress: 20 };
  if (state === "processing") return { title: "正在逐页离线转换", detail: "系统正在生成原始页面图片并提取页面文字", progress: 55 };
  if (state === "syncing") return { title: "正在写入 ReadWeave", detail: "逐页草稿、来源锚点和原始页面图正在同步", progress: 82 };
  if (state === "ready") return { title: "材料草稿已经就绪", detail: "可以继续逐页编辑、生成讲解和执行质量审核", progress: 100 };
  return { title: "材料没有完成导入", detail: "系统已经停止处理，请根据下方错误修复材料后重试", progress: 100 };
}

function CreateCourseDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api.createCourse(title.trim(), description.trim() || undefined);
      await onCreated();
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "课程创建失败"); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="import-dialog compact-dialog" role="dialog" aria-modal="true" aria-labelledby="create-course-title">
      <header><div><span className="section-kicker">NEW COURSE</span><h2 id="create-course-title">建立课程项目</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><span aria-hidden="true">×</span></button></header>
      <div className="dialog-form"><label><span>课程名称</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如 数字系统设计" /></label><label><span>课程说明</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="课程目标、适用对象或材料范围" rows={4} /></label></div>
      <p className="dialog-hint"><Icon name="book" />创建后会同时在 ReadWeave 建立课程知识树</p>
      {error && <p className="dialog-error"><Icon name="warning" />{error}</p>}
      <footer><button className="quiet-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!title.trim() || busy} onClick={create}>{busy ? "正在建立" : "建立课程"}</button></footer>
    </section>
  </div>;
}

function TreeTextDialog({ action, onClose, onSubmit }: { action: TreeTextAction; onClose: () => void; onSubmit: (title: string) => void }) {
  const [title, setTitle] = useState(action.kind === "rename" ? action.node.title : "");
  const heading = action.kind === "rename" ? `重命名“${action.node.title}”` : "新建课程模块";
  const submit = () => {
    const value = title.trim();
    if (value) onSubmit(value);
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="import-dialog compact-dialog tree-text-dialog" role="dialog" aria-modal="true" aria-labelledby="tree-text-title">
      <header><div><span className="section-kicker">COURSE TREE</span><h2 id="tree-text-title">{heading}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><span aria-hidden="true">×</span></button></header>
      <div className="dialog-form"><label><span>{action.kind === "rename" ? "新名称" : "模块名称"}</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); }} placeholder={action.kind === "rename" ? "输入新的名称" : "例如 第一章：基础概念"} /></label><p className="dialog-hint"><Icon name="edit" />发布版本保持不可变，修改只会写入新的树节点或草稿</p></div>
      <footer><button className="quiet-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!title.trim()} onClick={submit}>{action.kind === "rename" ? "保存名称" : "建立模块"}</button></footer>
    </section>
  </div>;
}

function MoveNodeDialog({ node, tree, onClose, onMove }: { node: CourseTreeNode; tree?: WorkspaceTree; onClose: () => void; onMove: (parentId: string | null) => void }) {
  const [parentId, setParentId] = useState(node.parentId ?? "");
  const descendants = useMemo(() => new Set(collectNodeIds(node)), [node]);
  const allowedKinds = node.kind === "course" ? [] : node.kind === "material" ? ["course"] : ["course", "material"];
  const targets = flattenTree(tree?.courses ?? []).filter(({ node: candidate }) => !descendants.has(candidate.id) && allowedKinds.includes(candidate.kind));
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="import-dialog compact-dialog move-dialog" role="dialog" aria-modal="true" aria-labelledby="move-node-title">
      <header><div><span className="section-kicker">MOVE ITEM</span><h2 id="move-node-title">移动“{node.title}”</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><span aria-hidden="true">×</span></button></header>
      <div className="dialog-form"><label><span>目标位置</span><select value={parentId} onChange={(event) => setParentId(event.target.value)}><option value="">课程根目录</option>{targets.map(({ node: target, depth }) => <option key={target.id} value={target.id}>{`${"　".repeat(depth)}${target.title}`}</option>)}</select></label><p className="dialog-hint"><Icon name="move" />移动只改变课程树位置，不会修改已发布内容</p></div>
      <footer><button className="quiet-button" onClick={onClose}>取消</button><button className="primary-button" onClick={() => onMove(parentId || null)}>确认移动</button></footer>
    </section>
  </div>;
}

function TrashPanel({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [items, setItems] = useState<TrashRecord[]>([]);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = async () => {
    setError("");
    try { setItems(await api.trash()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "回收站读取失败"); }
  };
  useEffect(() => { void load(); }, []);
  const restore = async (item: TrashRecord, restoreMode: "original" | "root") => {
    setBusyId(item.id); setError(""); setNotice("");
    try { await api.restoreTrash(item, restoreMode); await load(); await onRefresh(); setNotice(restoreMode === "original" ? "项目已经恢复到原路径" : "项目已经恢复到工作区根目录"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "项目恢复失败"); }
    finally { setBusyId(""); }
  };
  const permanentlyDelete = async (item: TrashRecord) => {
    if (!window.confirm(`永久删除“${item.title}”及其关联记录吗？这个操作无法撤回`)) return;
    setBusyId(item.id); setError(""); setNotice("");
    try { await api.permanentlyDeleteTrash(item); await load(); await onRefresh(); setNotice("项目已经永久删除"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "永久删除失败"); }
    finally { setBusyId(""); }
  };
  return <div className="utility-content trash-panel"><div className="trash-intro"><div><strong>回收站</strong><p>移入回收站不会立即破坏 ReadWeave 历史记录，恢复前仍保留原对象和修订</p></div><button className="quiet-button" onClick={() => void load()} disabled={Boolean(busyId)}>重新载入</button></div><div className="trash-list">{items.map((item) => { const remotePermanentDeleteUnavailable = Boolean(item.readweaveNoteId); const canRestoreOriginal = Boolean(item.originalParentId || item.originalPath?.length); return <article className="trash-item" key={item.id}><div><strong>{item.title}</strong><span>{item.nodeKind} · 删除于 {formatDateTime(item.deletedAt)}</span><small>{item.restoreAvailable ? `原路径：${item.originalPath?.join(" / ") || "未记录"}` : "已处理"}</small></div><div className="trash-actions"><button className="quiet-button" disabled={busyId === item.id || !item.restoreAvailable || !canRestoreOriginal} title={!canRestoreOriginal ? "原路径已经不存在，请选择恢复到工作区根目录" : busyId ? "正在处理上一项操作" : undefined} onClick={() => void restore(item, "original")}>恢复原路径</button><button className="quiet-button" disabled={busyId === item.id || !item.restoreAvailable} title={busyId ? "正在处理上一项操作" : undefined} onClick={() => void restore(item, "root")}>恢复到根目录</button><button className="quiet-button danger-button" disabled={busyId === item.id || remotePermanentDeleteUnavailable} title={remotePermanentDeleteUnavailable ? "当前 ReadWeave 接口没有安全的单条永久删除能力，只能保留在回收站" : busyId ? "正在处理上一项操作" : "永久删除后无法恢复"} onClick={() => void permanentlyDelete(item)}>永久删除</button></div></article>; })}{items.length === 0 && !error && <p className="empty-inline">回收站是空的</p>}</div>{notice && <p className="settings-notice"><Icon name="check" />{notice}</p>}{error && <p className="settings-error"><Icon name="warning" />{error}</p>}</div>;
}

function HistoryDialog({ node, releases, onClose, onSelectPage }: { node: CourseTreeNode; releases: CourseRelease[]; onClose: () => void; onSelectPage: (releaseId: string, pageId: string) => void }) {
  const materialSource = node.kind === "material" ? releases.find((release) => release.id === (node.currentReleaseId ?? node.releaseId)) : undefined;
  const versions = releases
    .filter((release) => node.kind === "course"
      ? release.courseId === node.id
      : release.courseId === materialSource?.courseId && release.moduleId === materialSource?.moduleId)
    .sort((left, right) => right.version - left.version);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="import-dialog history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title">
      <header><div><span className="section-kicker">VERSION HISTORY</span><h2 id="history-title">{node.title} 的版本历史</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><span aria-hidden="true">×</span></button></header>
      <div className="history-list">
        {versions.length === 0 && <p className="empty-inline">这个节点暂时没有可查看的历史版本</p>}
        {versions.map((release) => <article key={release.id}><div><strong>v{release.version} · {release.moduleTitle}</strong><span>{release.pages.length} 页 · {release.lifecycle === "published" ? "正式版本" : "草稿来源"}</span></div><button className="quiet-button" onClick={() => { const first = release.pages[0]; if (first) { onSelectPage(release.id, first.id); onClose(); } }}>打开第一页<Icon name="arrowRight" /></button></article>)}
      </div>
      <footer><button className="quiet-button" onClick={onClose}>关闭</button></footer>
    </section>
  </div>;
}

function readNavigationHash(): { releaseId: string; pageIndex: number; hasExplicitPage: boolean; mode: WorkspaceMode } {
  const hash = new URLSearchParams(location.hash.slice(1));
  const requestedPage = Number(hash.get("page") || 1);
  const requestedMode = hash.get("mode");
  return {
    releaseId: hash.get("release") || "",
    pageIndex: Number.isFinite(requestedPage) ? Math.max(0, Math.trunc(requestedPage) - 1) : 0,
    hasExplicitPage: hash.has("page"),
    mode: requestedMode === "studio" || requestedMode === "review" || requestedMode === "learn" ? requestedMode : "learn"
  };
}

function defaultRelease(items: CourseRelease[]): CourseRelease | undefined {
  return [...items].filter((item) => item.lifecycle !== "draft_source").sort((a, b) => b.version - a.version || b.publishedAt.localeCompare(a.publishedAt))[0] ?? items[0];
}

function flattenTree(nodes: CourseTreeNode[], depth = 0): Array<{ node: CourseTreeNode; depth: number }> {
  return nodes.flatMap((node) => [{ node, depth }, ...flattenTree(node.children, depth + 1)]);
}

function collectNodeIds(node: CourseTreeNode): string[] {
  return [node.id, ...node.children.flatMap(collectNodeIds)];
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}
