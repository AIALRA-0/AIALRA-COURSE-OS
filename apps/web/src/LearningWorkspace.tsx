import { lazy, Suspense, useEffect, useRef, useState, type Dispatch, type SetStateAction, type CSSProperties, type ReactNode } from "react";
import type { CourseRelease, LearningSession } from "@course-os/contracts";
import { Icon } from "./Icon.js";
import { PaneResizeHandle } from "./PaneResizeHandle.js";
import { ReadingInspector } from "./ReadingInspector.js";
import { readViewPreference, saveViewPreference } from "./view-preferences.js";
import type { ImageResourceCache } from "./reading-prefetch.js";
import type { ViewState } from "./SlideViewer.js";
import { preloadExplanationPanel } from "./reader-core.js";
import { normalizeSourceWidth, sourceWidthLimit, SOURCE_MIN_WIDTH, SOURCE_MAX_WIDTH } from "./reading-layout.js";
const ExplanationPanel = lazy(() => preloadExplanationPanel().then(module => ({ default: module.ExplanationPanel })));
type MobileMode = "visual" | "lesson" | "practice";
function WorkspaceLoader({ compact = false }: { compact?: boolean }) { return <div className={`workspace-loader ${compact ? "compact" : ""}`} role="status"><div className="loader" /><span>正在准备阅读内容</span></div>; }

export function LearningWorkspace({ modeTabs, release, pageIndex, setPageIndex, onPrefetchPage, imageResources, session, view, updateView, mobileMode, setMobileMode, pageDockOpen, setPageDockOpen, rightCollapsed, onToggleRight, onEnterStudio, unpublishedDraftRevision, generatedReady, contentReady = true, contentError, contentNotice, contentReviewRequired = false, contentUnavailable = false, contentTerminalError = false, onRetryContent }: {
  modeTabs: ReactNode;
  release: CourseRelease;
  pageIndex: number;
  setPageIndex: Dispatch<SetStateAction<number>>;
  onPrefetchPage: (index: number, priority?: number) => void;
  imageResources: ImageResourceCache;
  session?: LearningSession;
  view: ViewState;
  updateView: (next: ViewState) => void;
  mobileMode: MobileMode;
  setMobileMode: (mode: MobileMode) => void;
  pageDockOpen: boolean;
  setPageDockOpen: Dispatch<SetStateAction<boolean>>;
  rightCollapsed: boolean;
  onToggleRight: () => void;
  onEnterStudio: () => void;
  unpublishedDraftRevision?: number;
  generatedReady?: boolean;
  contentReady?: boolean;
  contentError?: string;
  contentNotice?: string;
  contentReviewRequired?: boolean;
  contentUnavailable?: boolean;
  contentTerminalError?: boolean;
  onRetryContent?: () => void;
}) {
  const page = release.pages[pageIndex]!;
  const canShowContent = contentReady && !contentTerminalError;
  const lessonColumnRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const lessonStripRef = useRef<HTMLElement>(null);
  const [sourceHidden, setSourceHidden] = useState(false);
  const [panesSwapped, setPanesSwapped] = useState(() => readViewPreference("course-os-source-side") !== "left");
  const [sourceWidth, setSourceWidth] = useState(() => normalizeSourceWidth(readViewPreference("course-os-inspector-width")));
  const sourceLimit = availableWidth > 0 ? sourceWidthLimit(availableWidth) : SOURCE_MAX_WIDTH;
  const visibleSourceWidth = Math.min(sourceWidth, sourceLimit);
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const measure = () => setAvailableWidth(workspace.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);
  const [layoutNotice, setLayoutNotice] = useState("");
  useEffect(() => {
    if (!saveViewPreference("course-os-inspector-width", String(sourceWidth)) || !saveViewPreference("course-os-source-side", panesSwapped ? "right" : "left")) {
      setLayoutNotice("布局偏好无法保存在此浏览器，本次调整仍可使用");
    } else setLayoutNotice("");
  }, [sourceWidth, panesSwapped]);
  const toggleLessonPane = () => { if (!rightCollapsed && sourceHidden) setSourceHidden(false); onToggleRight(); };


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

  return <div ref={workspaceRef} className={`learning-workspace ${panesSwapped ? "panes-swapped" : ""} ${sourceHidden ? "source-is-collapsed" : ""} ${rightCollapsed ? "right-is-collapsed" : ""}`} style={{ "--source-width": `${visibleSourceWidth}px` } as CSSProperties}>
    {modeTabs}
    <header className="learning-header">
      <div><div className="breadcrumbs"><span>{release.courseTitle}</span><Icon name="chevronRight" /><span>{release.moduleTitle}</span></div><span className="reading-document-label"><Icon name="book" />教学讲解</span></div>
      <div className="learning-header-actions"><div className="reading-layout-tools" role="group" aria-label="阅读面板布局">
        <button className="icon-button" data-action="toggle-source-pane" aria-label={sourceHidden ? "展开原始课件" : "收起原始课件"} title={sourceHidden ? "展开原始课件" : "收起原始课件"} aria-pressed={!sourceHidden} onClick={() => { if (!sourceHidden && rightCollapsed) onToggleRight(); setSourceHidden(value => !value); }}><Icon name="eye" /></button>
        <button className="icon-button" data-action="swap-reading-panes" aria-label="交换原图与讲解位置" title="交换原图与讲解位置" aria-pressed={panesSwapped} onClick={() => setPanesSwapped(value => !value)}><Icon name="swap" /></button>
      </div><button className="quiet-button" data-action="learn-open-studio" onClick={onEnterStudio}><Icon name="edit" />制作本页</button><div className="learning-progress"><span>阅读位置</span><strong>{pageIndex + 1} / {release.pages.length}</strong><div><i style={{ width: `${(pageIndex + 1) / release.pages.length * 100}%` }} /></div></div></div>
      {layoutNotice && <span className="layout-preference-notice" role="status">{layoutNotice}</span>}
    </header>

    <nav className="mobile-tabs" aria-label="手机学习模式">
      <button className={mobileMode === "visual" ? "active" : ""} data-action="mobile-visual" onClick={() => setMobileMode("visual")}>原始课件</button>
      <button className={mobileMode === "lesson" ? "active" : ""} data-action="mobile-lesson" onClick={() => { if (rightCollapsed) onToggleRight(); setMobileMode("lesson"); }}>老师讲解</button>
      <button className={mobileMode === "practice" ? "active" : ""} data-action="mobile-practice" onClick={() => { if (rightCollapsed) onToggleRight(); setMobileMode("practice"); }}>提问与测验</button>
    </nav>

    <main className={`learning-grid mode-${mobileMode} ${rightCollapsed ? "right-is-collapsed" : ""} ${sourceHidden ? "source-is-collapsed" : ""} ${panesSwapped ? "panes-swapped" : ""}`} style={{ "--source-width": `${visibleSourceWidth}px` } as CSSProperties}>
      {sourceHidden && <aside className="source-collapsed-rail"><button className="icon-button" data-action="expand-source-pane" aria-label="展开原始课件" title="展开原始课件" onClick={() => setSourceHidden(false)}><Icon name="eye" /></button></aside>}
      <div className="visual-column"><ReadingInspector release={release} page={page} view={view} onView={updateView} imageResources={imageResources} lessonRef={lessonColumnRef} onClose={() => { if (rightCollapsed) onToggleRight(); setSourceHidden(true); }} onSwap={() => setPanesSwapped(value => !value)} onStudio={onEnterStudio} terminalError={contentTerminalError ? contentError || "当前页面已无权访问或已删除" : undefined} /></div>
      {!sourceHidden && !rightCollapsed && <PaneResizeHandle value={visibleSourceWidth} onChange={setSourceWidth} onCancel={() => setSourceWidth(sourceWidth)} reversed={panesSwapped} min={SOURCE_MIN_WIDTH} max={sourceLimit} unit="px" />}
      {rightCollapsed
          ? <aside className="right-collapsed-rail"><button data-action="right-expand-learn" onClick={toggleLessonPane} aria-label="展开教学栏" title="展开教学栏"><Icon name="chevronLeft" /><span>展开讲解</span></button></aside>
        : <div className="lesson-column" ref={lessonColumnRef}><div className="column-collapse-row"><span><Icon name="book" />讲解</span><button data-action="right-collapse-learn" onClick={toggleLessonPane} aria-label="收起教学栏" title="收起教学栏"><Icon name="chevronRight" /></button></div>{canShowContent && contentReviewRequired && contentNotice && <p className="empty-inline" role="status">{contentNotice}<button type="button" className="quiet-button" data-action="candidate-open-studio" onClick={onEnterStudio}>进入制作模式</button></p>}{canShowContent ? <Suspense fallback={<WorkspaceLoader compact />}><ExplanationPanel key={page.id} release={release} page={page} sessionId={session?.id} onEnterStudio={onEnterStudio} loadRootRef={lessonColumnRef} generatedReady={generatedReady} unpublishedDraftRevision={unpublishedDraftRevision} /></Suspense> : <div className="workspace-loader compact" role={contentTerminalError ? "alert" : "status"}>{!contentError && !contentTerminalError && !contentUnavailable && <div className="loader" />}<span>{contentUnavailable ? contentNotice : contentError ? `目标页讲解载入失败：${contentError}` : release.lifecycle === "draft_source" ? "正在载入候选讲解" : "正在载入本页讲解"}</span>{contentUnavailable ? <button type="button" className="quiet-button" data-action="candidate-open-studio" onClick={onEnterStudio}>进入制作模式</button> : contentError && onRetryContent && <button type="button" className="quiet-button compact" onClick={onRetryContent}>重试</button>}</div>}</div>}
    </main>

    <footer className={`page-dock ${pageDockOpen ? "expanded" : "collapsed"}`}>
      <div className="page-dock-summary">
        <button data-action="page-previous" disabled={pageIndex === 0} title={pageIndex === 0 ? "已经是第一页" : "打开上一页"} onMouseEnter={() => onPrefetchPage(pageIndex - 1)} onFocus={() => onPrefetchPage(pageIndex - 1)} onPointerDown={() => onPrefetchPage(pageIndex - 1, 20)} onClick={() => setPageIndex((index) => index - 1)}><Icon name="arrowLeft" />上一页</button>
        <button className="page-dock-toggle" data-action="toggle-page-dock" onClick={() => setPageDockOpen((open) => !open)} aria-expanded={pageDockOpen}><span>第 {page.pageNumber} 页 · {page.title}</span><small>{pageDockOpen ? "收起全部页面" : `展开全部 ${release.pages.length} 页`}</small><Icon name={pageDockOpen ? "chevronUp" : "chevronDown"} /></button>
        <button className="button-icon-trailing" data-action="page-next" disabled={pageIndex === release.pages.length - 1} title={pageIndex === release.pages.length - 1 ? "已经是最后一页" : "打开下一页"} onMouseEnter={() => onPrefetchPage(pageIndex + 1)} onFocus={() => onPrefetchPage(pageIndex + 1)} onPointerDown={() => onPrefetchPage(pageIndex + 1, 20)} onClick={() => setPageIndex((index) => index + 1)}>下一页<Icon name="arrowRight" /></button>
      </div>
      {pageDockOpen && <nav className="lesson-strip" ref={lessonStripRef} aria-label="课程全部页面">{release.pages.map((item, index) => <button key={item.id} data-action="page-select" className={index === pageIndex ? "active" : ""} aria-current={index === pageIndex ? "page" : undefined} onMouseEnter={() => onPrefetchPage(index)} onFocus={() => onPrefetchPage(index)} onPointerDown={() => onPrefetchPage(index, 20)} onClick={() => setPageIndex(index)}><span>{item.pageNumber}</span><div><strong>{item.title}</strong><small>{item.quality.publishable ? "讲解已生成" : "讲解草稿"}</small></div></button>)}</nav>}
    </footer>
  </div>;
}
