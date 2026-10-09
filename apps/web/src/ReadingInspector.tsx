import { useState, type RefObject, type KeyboardEvent } from "react";
import type { CourseRelease, PageLesson } from "@course-os/contracts";
import { Icon } from "./Icon.js";
import { SlideViewer, type ViewState } from "./SlideViewer.js";
import type { ImageResourceCache } from "./reading-prefetch.js";

const chapters = [
  ["chapter_bridge", "承上启下"], ["prior_knowledge", "先验知识"],
  ["learning_objectives", "学习目标"], ["full_explanation", "完整讲解"],
  ["main_content", "主要内容"], ["misconceptions", "易错点"], ["questions", "问答与自我重述"],
] as const;

export function ReadingInspector({ release, page, view, onView, imageResources, lessonRef, onClose, onSwap, terminalError } : {
  release: CourseRelease; page: PageLesson; view: ViewState; onView: (next: ViewState) => void;
  imageResources: ImageResourceCache; lessonRef: RefObject<HTMLDivElement | null>;
  onClose: () => void; onSwap: () => void; terminalError?: string;
}) {
  const [tab, setTab] = useState<"source" | "outline">("source");
  const selectTab = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "source" : event.key === "End" ? "outline" : tab === "source" ? "outline" : "source";
    setTab(next);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-inspector-tab="${next}"]`)?.focus();
  };
  const jump = (kind: string) => {
    const root = lessonRef.current;
    if (!root) return;
    if (kind === "questions") {
      // The existing observer mounts practice as the reader approaches it.
      const marker = root.querySelector<HTMLElement>(".lesson-interactive-marker");
      if (marker) root.scrollTo({ top: marker.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 24, behavior: "auto" });
    } else {
      const section = root.querySelector<HTMLElement>(`[data-lesson-section="${kind}"]`);
      if (section) root.scrollTo({ top: section.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 24, behavior: "auto" });
    }
  };
  const state = release.lifecycle === "draft_source" ? "当前预览草稿" : release.lifecycle === "published" ? `已发布 v${release.version}` : "课程材料";
  return <aside className="reading-inspector" aria-label="本页检查器">
    <header className="workbench-panel-header"><h2><Icon name="document" />本页</h2><div>
      <button type="button" className="icon-button" data-action="inspector-swap-panes" aria-label="交换原图与讲解位置" title="交换原图与讲解位置" onClick={onSwap}><Icon name="swap" /></button>
      <button type="button" className="icon-button" data-action="inspector-close-source" aria-label="收起原始课件" title="收起原始课件" onClick={onClose}><Icon name="close" /></button>
    </div></header>
    <div className="reading-inspector-tabs" role="tablist" aria-label="本页工具">
      <button role="tab" id="reading-source-tab" aria-controls="reading-source-panel" aria-selected={tab === "source"} tabIndex={tab === "source" ? 0 : -1} data-inspector-tab="source" onClick={() => setTab("source")} onKeyDown={selectTab}>原图</button>
      <button role="tab" id="reading-outline-tab" aria-controls="reading-outline-panel" aria-selected={tab === "outline"} tabIndex={tab === "outline" ? 0 : -1} data-inspector-tab="outline" onClick={() => setTab("outline")} onKeyDown={selectTab}>页面信息</button>
    </div>
    <div className="reading-inspector-scroll">
      <div id="reading-source-panel" role="tabpanel" aria-labelledby="reading-source-tab" hidden={tab !== "source"} className="reading-source-panel">
        {terminalError ? <p className="empty-inline" role="alert">{terminalError}</p> : <SlideViewer imageUrl={page.imageUrl} title={page.title} value={view} onChange={onView} imageResources={imageResources} />}
        <div className="source-caption"><Icon name="document" /><span>第 {page.pageNumber} 页原图</span><small>放大或全屏查看细节</small></div>
      </div>
      <div id="reading-outline-panel" role="tabpanel" aria-labelledby="reading-outline-tab" hidden={tab !== "outline"} className="reading-outline-panel">
        <div className="page-identity"><Icon name="document" /><div><strong>{page.title}</strong><span>{state}</span></div></div>
        <dl className="page-properties"><div><dt>课程</dt><dd>{release.courseTitle}</dd></div><div><dt>材料</dt><dd>{release.moduleTitle}</dd></div><div><dt>页面</dt><dd>{page.pageNumber} / {release.pages.length}</dd></div><div><dt>已有题库</dt><dd>{page.questionBank?.length ?? 0} 题</dd></div></dl>
      </div>
      <nav className="reading-outline" aria-label="本页教学目录"><h3>阅读目录</h3>{chapters.map(([kind, title], index) => <button key={kind} type="button" data-action={`reading-jump:${kind}`} onClick={() => jump(kind)}><span>{String(index + 1).padStart(2, "0")}</span>{title}<Icon name="chevronRight" /></button>)}</nav>
    </div>
    <footer className="reading-inspector-footer"><Icon name="document" /><span>第 {page.pageNumber} / {release.pages.length} 页</span><span>{release.lifecycle === "draft_source" ? "草稿" : "材料"}</span></footer>
  </aside>;
}
