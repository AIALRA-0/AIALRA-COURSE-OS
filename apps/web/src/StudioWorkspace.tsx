import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { CostRollup, CourseRelease, ExplanationBlock, GenerationCostEntry, GenerationHarnessCurrent, GenerationJob, LessonDraft, PageLesson, QualityValidationResult, QuestionBankItem, ReadWeaveSyncStatus, WritingPolicyCurrent } from "@course-os/contracts";
import { api } from "./api.js";
import { Icon } from "./Icon.js";
import { Markdown } from "./Markdown.js";
import type { ImageResourceCache } from "./reading-prefetch.js";
import { SlideViewer } from "./SlideViewer.js";
import { WorkbenchSelect } from "./WorkbenchSelect.js";
import "./studio-workbench.css";

const BLOCK_LABELS: Record<ExplanationBlock["kind"], string> = {
  objective: "学习目标",
  prerequisite: "前置知识",
  core: "教授讲解",
  example: "完整例题",
  misconception: "常见误区",
  check: "理解检查",
  deep_dive: "逐元素详解",
  qa: "课堂问答",
  source_status: "来源状态"
};

const INSPECTOR_TABS = ["quality", "source", "model", "cost"] as const;
type InspectorTab = typeof INSPECTOR_TABS[number];

export function StudioWorkspace({ release, page, sync, imageResources, rightCollapsed, onToggleRight, onPublished, onChanged }: {
  release: CourseRelease;
  page: PageLesson;
  sync?: ReadWeaveSyncStatus;
  imageResources: ImageResourceCache;
  rightCollapsed: boolean;
  onToggleRight: () => void;
  onPublished: (release: CourseRelease) => void;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<LessonDraft>();
  const [workingPage, setWorkingPage] = useState<PageLesson>(page);
  const [changedBlocks, setChangedBlocks] = useState<Set<string>>(new Set());
  const [validation, setValidation] = useState<QualityValidationResult>();
  const [editorMode, setEditorMode] = useState<"edit" | "preview">("edit");
  const [inspector, setInspector] = useState<"quality" | "source" | "model" | "cost">("quality");
  const inspectorTabsRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<"load" | "save" | "validate" | "publish" | "generate" | "refill" | "">("load");
  const [generationJob, setGenerationJob] = useState<GenerationJob>();
  const [notice, setNotice] = useState("");
  const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 });
  const visibleBlocks = useMemo(() => workingPage.blocks.filter((block) => block.kind !== "source_status"), [workingPage.blocks]);

  useEffect(() => {
    let active = true;
    setBusy("load");
    setNotice("");
    api.draft(page.id).then((loaded) => {
      if (!active) return;
      setDraft(loaded);
      setWorkingPage(structuredClone(loaded.page));
      setChangedBlocks(new Set());
      setValidation(undefined);
    }).catch((error) => active && setNotice(error instanceof Error ? error.message : "草稿加载失败"))
      .finally(() => active && setBusy(""));
    return () => { active = false; };
  }, [page.id]);

  const dirty = changedBlocks.size > 0;
  const updateBlock = (blockId: string, patch: Partial<ExplanationBlock>) => {
    setWorkingPage((current) => ({ ...current, blocks: current.blocks.map((block) => block.id === blockId ? { ...block, ...patch } : block) }));
    setChangedBlocks((current) => new Set(current).add(blockId));
    setValidation(undefined);
  };

  const updateQuestion = (questionId: string, patch: Partial<QuestionBankItem>) => {
    setWorkingPage((current) => ({ ...current, questionBank: (current.questionBank ?? []).map((item) => item.id === questionId ? { ...item, ...patch } : item) }));
    setChangedBlocks((current) => new Set(current).add("question-bank"));
    setValidation(undefined);
  };

  const save = async () => {
    if (!draft || !dirty) return draft;
    setBusy("save");
    setNotice("");
    try {
      const saved = await api.saveDraft(draft, workingPage, [...changedBlocks]);
      setDraft(saved);
      setWorkingPage(structuredClone(saved.page));
      setChangedBlocks(new Set());
      setNotice(`草稿已同步到 ReadWeave · 修订 ${saved.revision}`);
      onChanged();
      return saved;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "草稿保存失败");
      onChanged();
      return undefined;
    } finally { setBusy(""); }
  };

  const validate = async () => {
    if (dirty && !(await save())) return;
    setBusy("validate");
    try {
      const result = await api.validateDraft(page.id);
      setValidation(result);
      setNotice(result.publishable ? "质量门已通过，可以发布新版本" : `发现 ${result.issues.length} 个发布阻断项`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "质量检查失败"); }
    finally { setBusy(""); }
  };

  const publish = async () => {
    if (dirty && !(await save())) return;
    const checked = validation ?? await api.validateDraft(page.id);
    setValidation(checked);
    if (!checked.publishable) {
      setNotice(`发布被质量门阻止，共 ${checked.issues.length} 个问题`);
      return;
    }
    setBusy("publish");
    try {
      const published = await api.publish(release.id);
      setNotice(`版本 v${published.version} 已发布`);
      onPublished(published);
    } catch (error) { setNotice(error instanceof Error ? error.message : "发布失败"); }
    finally { setBusy(""); }
  };

  const generate = async () => {
    const materialVersionId = release.id;
    setBusy("generate");
    setNotice("");
    try {
      const created = await api.createGenerationJob(materialVersionId, [page.id], 4);
      setGenerationJob(created);
      setInspector("cost");
      setNotice("本页生成任务已经建立，系统只会处理当前页面");
    } catch (error) { setNotice(error instanceof Error ? error.message : "本页生成任务建立失败"); }
    finally { setBusy(""); }
  };

  const refillQuestions = async () => {
    if (!draft) return;
    if (dirty) {
      setNotice("请先保存当前修改，再补充题库");
      return;
    }
    setBusy("refill");
    setNotice("");
    try {
      const result = await api.refillQuestions(page.id, draft.revision);
      setDraft(result.draft);
      setWorkingPage(structuredClone(result.draft.page));
      setChangedBlocks(new Set());
      setValidation(undefined);
      setNotice(result.added.length ? `已补充 ${result.added.length} 道题目，保存后即可用于练习` : "题库已经有足够的可用题目");
      onChanged();
    } catch (error) { setNotice(error instanceof Error ? error.message : "题库补充失败"); }
    finally { setBusy(""); }
  };

  useEffect(() => {
    if (!generationJob || ["completed", "failed", "cancelled"].includes(generationJob.state)) return;
    const timer = window.setInterval(() => api.generationJob(generationJob.id).then((job) => {
      setGenerationJob(job);
      if (job.state === "completed") setNotice(`本页生成完成，记录成本 $${job.spentUsd.toFixed(4)}`);
      if (job.state === "failed") setNotice("本页生成失败，请在成本页签查看任务状态");
    }).catch(() => undefined), 600);
    return () => window.clearInterval(timer);
  }, [generationJob?.id, generationJob?.state]);

  const coverage = useMemo(() => ({
    covered: workingPage.coverageClaims.filter((claim) => claim.status === "covered").length,
    total: workingPage.coverageRequirements.length
  }), [workingPage]);
  const footerStatus = busy === "load" ? "正在读取草稿"
    : busy === "save" ? "正在同步草稿"
      : busy === "validate" ? "正在运行质量检查"
        : busy === "publish" ? "正在发布版本"
          : busy === "generate" ? "正在建立生成任务"
            : busy === "refill" ? "正在补充题库"
              : dirty ? "有未保存修改"
                : draft ? `草稿修订 ${draft.revision}` : "草稿尚未建立";

  const onInspectorTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = INSPECTOR_TABS.indexOf(inspector);
    const nextIndex = event.key === "ArrowRight" ? (currentIndex + 1) % INSPECTOR_TABS.length
      : event.key === "ArrowLeft" ? (currentIndex - 1 + INSPECTOR_TABS.length) % INSPECTOR_TABS.length
        : event.key === "Home" ? 0
          : event.key === "End" ? INSPECTOR_TABS.length - 1
            : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const nextTab = INSPECTOR_TABS[nextIndex]!;
    setInspector(nextTab);
    inspectorTabsRef.current?.querySelector<HTMLButtonElement>(`[data-inspector-tab="${nextTab}"]`)?.focus();
  };

  return (
    <div className="studio-workspace studio-workbench-v2">
      <header className="workspace-header studio-workbench-header">
        <div className="workspace-title">
          <nav className="breadcrumbs" aria-label="当前位置"><span>{release.courseTitle}</span><Icon name="chevronRight" /><span>{release.moduleTitle}</span><Icon name="chevronRight" /><strong aria-current="page">第 {page.pageNumber} 页</strong></nav>
          <div className="title-line"><h1>{workingPage.title}</h1><span className={`draft-pill ${dirty ? "dirty" : ""}`}>{dirty ? "有未保存修改" : draft?.revision ? `草稿修订 ${draft.revision}` : "基于正式版本"}</span></div>
        </div>
        <div className="workspace-actions" role="group" aria-label="页面制作操作" data-action-slot="studio-header-actions">
          <button type="button" className="quiet-button" data-action="studio-generate-page" aria-label={busy === "generate" ? "正在建立生成任务" : "生成本页"} disabled={Boolean(busy)} title={busy ? "请等待当前操作结束" : "只重新生成当前页面"} onClick={generate}><Icon name="sparkles" />{busy === "generate" ? "建立任务中" : "生成本页"}</button>
          <button type="button" className="quiet-button" data-action="studio-toggle-preview" aria-label={editorMode === "edit" ? "学习预览" : "返回编辑"} aria-pressed={editorMode === "preview"} onClick={() => setEditorMode(editorMode === "edit" ? "preview" : "edit")}><Icon name={editorMode === "edit" ? "eye" : "edit"} />{editorMode === "edit" ? "预览" : "编辑"}</button>
          <button type="button" className="quiet-button" data-action="studio-save-draft" aria-label={busy === "save" ? "正在同步草稿" : "保存草稿"} disabled={!dirty || Boolean(busy)} title={!dirty ? "当前没有需要保存的修改" : busy ? "请等待当前操作结束" : "保存到 ReadWeave 草稿"} onClick={save}><Icon name="cloud" />{busy === "save" ? "同步中" : "保存草稿"}</button>
          <button type="button" className="quiet-button" data-action="studio-validate" aria-label="质量检查" disabled={Boolean(busy)} title={busy ? "请等待当前操作结束" : "运行确定性发布检查"} onClick={validate}><Icon name="check" />质量检查</button>
          <button type="button" className="primary-button" data-action="studio-publish" aria-label={busy === "publish" ? "正在发布版本" : "发布版本"} disabled={Boolean(busy)} title={busy ? "请等待当前操作结束" : "通过质量门后发布不可变版本"} onClick={publish}><Icon name="publish" />{busy === "publish" ? "发布中" : "发布版本"}</button>
        </div>
      </header>

      {notice && <div className={`studio-notice ${notice.includes("失败") || notice.includes("阻止") ? "error" : ""}`} role={notice.includes("失败") || notice.includes("阻止") ? "alert" : "status"}><Icon name={notice.includes("失败") || notice.includes("阻止") ? "warning" : "check"} /><span>{notice}</span></div>}

      <div className={`studio-columns ${rightCollapsed ? "right-is-collapsed" : ""}`}>
        <main className="studio-canvas">
          <section className="source-stage">
            <div className="section-heading"><div><span className="section-kicker">SOURCE PAGE</span><h2>原始材料</h2></div><span className="source-meta">第 {page.pageNumber} 页 · {workingPage.anchors.length} 个来源锚点</span></div>
            <div className="studio-slide"><SlideViewer imageUrl={workingPage.imageUrl} title={workingPage.title} value={view} onChange={setView} imageResources={imageResources} /></div>
          </section>

          <section className="lesson-editor">
            <div className="section-heading"><div><span className="section-kicker">TEACHING DRAFT</span><h2>教授级讲解</h2></div><div className="segmented" role="group" aria-label="讲解显示模式" data-action-slot="studio-editor-mode"><button type="button" className={editorMode === "edit" ? "active" : ""} aria-pressed={editorMode === "edit"} onClick={() => setEditorMode("edit")}>编辑</button><button type="button" className={editorMode === "preview" ? "active" : ""} aria-pressed={editorMode === "preview"} onClick={() => setEditorMode("preview")}>学习预览</button></div></div>
            <div className="studio-editor-content">
              <div className="editor-block-list">
                {visibleBlocks.length === 0 && <div className="studio-editor-empty" role="status"><Icon name="document" /><div><strong>{busy === "load" ? "正在读取讲解草稿" : "本页还没有讲解草稿"}</strong><p>{busy === "load" ? "题库与讲解读取完成后显示在这里" : "可使用“生成本页”建立讲解，题库仍可在下方编辑"}</p></div></div>}
                {visibleBlocks.map((block, index) => (
                  <article key={block.id} className={`editor-block ${changedBlocks.has(block.id) ? "changed" : ""}`}>
                    <header><span className="block-index">{String(index + 1).padStart(2, "0")}</span><div><span>{BLOCK_LABELS[block.kind]}</span><input value={block.title} onChange={(event) => updateBlock(block.id, { title: event.target.value })} aria-label={`${BLOCK_LABELS[block.kind]}标题`} /></div><span className="block-state">{changedBlocks.has(block.id) ? "已修改" : "已同步"}</span></header>
                    {editorMode === "edit"
                      ? <textarea value={block.markdown} onChange={(event) => updateBlock(block.id, { markdown: event.target.value })} aria-label={`${block.title}内容`} />
                      : <div className="block-preview"><Markdown>{block.markdown}</Markdown></div>}
                    <footer><span><Icon name="target" />{block.atomIds.length} 个教学元素</span><span><Icon name="archive" />{block.sourceAnchorIds.length} 个来源锚点</span></footer>
                  </article>
                ))}
              </div>
              <QuestionBankEditor page={workingPage} dirty={dirty} busy={busy === "refill"} onRefill={() => void refillQuestions()} onChange={updateQuestion} />
            </div>
          </section>
        </main>

        {rightCollapsed
          ? <aside className="studio-right-rail" aria-label="制作检查"><button type="button" onClick={onToggleRight} aria-expanded={false} aria-label="展开检查栏" title="展开检查栏"><Icon name="chevronLeft" /><span>展开检查</span></button></aside>
          : <aside className="studio-inspector" aria-labelledby="studio-inspector-heading">
          <div className="column-collapse-row"><h2 className="inspector-title" id="studio-inspector-heading">制作检查</h2><button type="button" onClick={onToggleRight} aria-expanded={true} aria-label="收起检查栏" title="收起检查栏"><Icon name="chevronRight" /></button></div>
          <div ref={inspectorTabsRef} className="inspector-tabs" role="tablist" aria-label="制作检查内容">
            <button type="button" id="studio-inspector-tab-quality" data-inspector-tab="quality" role="tab" aria-selected={inspector === "quality"} tabIndex={inspector === "quality" ? 0 : -1} aria-controls="studio-inspector-panel" className={inspector === "quality" ? "active" : ""} onClick={() => setInspector("quality")} onKeyDown={onInspectorTabKeyDown}>质量</button>
            <button type="button" id="studio-inspector-tab-source" data-inspector-tab="source" role="tab" aria-selected={inspector === "source"} tabIndex={inspector === "source" ? 0 : -1} aria-controls="studio-inspector-panel" className={inspector === "source" ? "active" : ""} onClick={() => setInspector("source")} onKeyDown={onInspectorTabKeyDown}>来源</button>
            <button type="button" id="studio-inspector-tab-model" data-inspector-tab="model" role="tab" aria-selected={inspector === "model"} tabIndex={inspector === "model" ? 0 : -1} aria-controls="studio-inspector-panel" className={inspector === "model" ? "active" : ""} onClick={() => setInspector("model")} onKeyDown={onInspectorTabKeyDown}>模型</button>
            <button type="button" id="studio-inspector-tab-cost" data-inspector-tab="cost" role="tab" aria-selected={inspector === "cost"} tabIndex={inspector === "cost" ? 0 : -1} aria-controls="studio-inspector-panel" className={inspector === "cost" ? "active" : ""} onClick={() => setInspector("cost")} onKeyDown={onInspectorTabKeyDown}>成本</button>
          </div>
          <div id="studio-inspector-panel" className="studio-inspector-panel" role="tabpanel" tabIndex={0} aria-labelledby={`studio-inspector-tab-${inspector}`}>
            {inspector === "quality" && <QualityInspector page={workingPage} validation={validation} coverage={coverage} />}
            {inspector === "source" && <SourceInspector page={workingPage} draft={draft} sync={sync} />}
            {inspector === "model" && <ModelInspector release={release} page={workingPage} job={generationJob} />}
            {inspector === "cost" && <CostInspector release={release} page={workingPage} job={generationJob} />}
          </div>
        </aside>}
      </div>
      <footer className="studio-workbench-footer" aria-label="页面工作状态">
        <span className={`studio-footer-state${dirty ? " is-dirty" : ""}`} role="status"><i aria-hidden="true" />{footerStatus}</span>
        <span>{visibleBlocks.length} 个讲解区块</span>
        <span>{workingPage.anchors.length} 个来源锚点</span>
      </footer>
    </div>
  );
}

function QuestionBankEditor({ page, dirty, busy, onRefill, onChange }: {
  page: PageLesson;
  dirty: boolean;
  busy: boolean;
  onRefill: () => void;
  onChange: (questionId: string, patch: Partial<QuestionBankItem>) => void;
}) {
  const questions = page.questionBank ?? [];
  const approved = questions.filter((item) => item.status === "approved").length;
  return <section className="question-bank-editor">
    <header className="question-bank-editor-heading"><div><span className="section-kicker">QUESTION BANK</span><h3>随机问题题库</h3><p>题量按本页内容组织；保存后的有效题目即可用于学习，按需补充题库</p></div><button className="quiet-button" disabled={busy || dirty || approved >= 4} title={dirty ? "请先保存当前修改" : approved >= 4 ? "可用题目已经达到 4 道" : "补齐题目"} onClick={onRefill}>{busy ? "补充中" : "补齐题库"}</button></header>
    <div className="question-bank-summary"><strong>{approved}</strong><span>可用题目</span><em>{questions.filter((item) => item.status === "draft").length} 道草稿</em></div>
    {questions.length === 0 && <p className="empty-inline">当前页面还没有题目，可以点击补齐题库</p>}
    <div className="question-bank-list">{questions.map((question, index) => <QuestionBankRow key={question.id} index={index} question={question} onChange={onChange} />)}</div>
  </section>;
}

function QuestionBankRow({ index, question, onChange }: { index: number; question: QuestionBankItem; onChange: (questionId: string, patch: Partial<QuestionBankItem>) => void }) {
  return <article className="question-bank-row">
    <header><span>{String(index + 1).padStart(2, "0")}</span><WorkbenchSelect aria-label={`第 ${index + 1} 题类型`} value={question.kind} onChange={(kind) => onChange(question.id, { kind: kind as QuestionBankItem["kind"], options: kind === "multiple_choice" ? question.options ?? [question.expectedAnswer] : undefined })} options={[{ value: "comprehension", label: "理解题" }, { value: "multiple_choice", label: "选择题" }]} /><WorkbenchSelect aria-label={`第 ${index + 1} 题状态`} value={question.status} onChange={(status) => onChange(question.id, { status: status as QuestionBankItem["status"] })} options={[{ value: "draft", label: "草稿" }, { value: "approved", label: "可用" }, { value: "retired", label: "已停用" }]} /></header>
    <label><span>题目</span><textarea value={question.prompt} onChange={(event) => onChange(question.id, { prompt: event.target.value })} /></label>
    {question.kind === "multiple_choice" && <label><span>选项</span><textarea value={(question.options ?? []).join("\n")} onChange={(event) => onChange(question.id, { options: event.target.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) })} placeholder="每行一个选项" /></label>}
    <div className="question-bank-fields"><label><span>标准答案</span><input value={question.expectedAnswer} onChange={(event) => onChange(question.id, { expectedAnswer: event.target.value })} /></label><label><span>答案说明</span><textarea value={question.explanation} onChange={(event) => onChange(question.id, { explanation: event.target.value })} /></label></div>
  </article>;
}

function QualityInspector({ page, validation, coverage }: { page: PageLesson; validation?: QualityValidationResult; coverage: { covered: number; total: number } }) {
  const high = validation?.highRiskCoverage ?? page.quality.highRiskCoverage;
  const general = validation?.generalCoverage ?? page.quality.generalCoverage;
  const pass = validation?.publishable ?? page.quality.publishable;
  const approvedQuestions = (page.questionBank ?? []).filter((item) => item.status === "approved");
  const hasActiveUnderstandingCheck = page.blocks.some((block) => block.kind === "check" && block.markdown.trim())
    || approvedQuestions.length > 0;
  return <div className="inspector-body">
    <div className={`quality-hero ${pass ? "pass" : "hold"}`}><Icon name={pass ? "check" : "warning"} /><div><strong>{pass ? "满足发布要求" : "还需要补齐内容"}</strong><span>{pass ? "全部确定性质量检查已通过" : "补齐缺失内容后即可保存或发布"}</span></div></div>
    <InspectorSection title="覆盖率">
      <Metric label="高风险元素" value={`${Math.round(high * 100)}%`} tone={high === 1 ? "good" : "bad"} />
      <Metric label="一般必需元素" value={`${Math.round(general * 100)}%`} tone={general >= .98 ? "good" : "bad"} />
      <Metric label="覆盖声明" value={`${coverage.covered}/${coverage.total}`} tone={coverage.covered >= coverage.total ? "good" : "neutral"} />
    </InspectorSection>
    <InspectorSection title="结构检查">
      <CheckRow ok={validation?.mathValid ?? page.quality.mathValid} label="数学公式严格解析" />
      <CheckRow ok={(validation?.pseudocodeLines ?? 0) === (validation?.explainedPseudocodeLines ?? 0)} label="伪代码逐行状态说明" />
      <CheckRow ok={page.anchors.length > 0} label="来源锚点可追溯" />
      <CheckRow ok={hasActiveUnderstandingCheck} label="包含主动理解练习" title={approvedQuestions.length > 0 ? `当前页已有 ${approvedQuestions.length} 道可用题目，已满足主动理解检查` : undefined} />
    </InspectorSection>
    {validation?.issues.length ? <InspectorSection title={`阻断项 · ${validation.issues.length}`}><ul className="issue-list">{validation.issues.slice(0, 8).map((issue) => <li key={issue}>{issue}</li>)}</ul></InspectorSection> : null}
  </div>;
}

function SourceInspector({ page, draft, sync }: { page: PageLesson; draft?: LessonDraft; sync?: ReadWeaveSyncStatus }) {
  const [deepLink, setDeepLink] = useState<{ url: string; verified: boolean }>();
  useEffect(() => {
    let active = true;
    if (!draft?.readweaveNoteId) { setDeepLink(undefined); return () => { active = false; }; }
    api.deepLink(draft.readweaveNoteId).then((link) => active && setDeepLink(link)).catch(() => active && setDeepLink(undefined));
    return () => { active = false; };
  }, [draft?.readweaveNoteId]);
  return <div className="inspector-body">
    <div className={`sync-card sync-${sync?.state || "offline"}`}><span className="live-dot"/><div><strong>{sync?.state === "connected" ? "ReadWeave 已连接" : "ReadWeave 状态待确认"}</strong><span>{sync?.message || "正在读取同步状态"}</span></div></div>
    {deepLink?.verified && <a className="readweave-link" href={deepLink.url} target="_blank" rel="noreferrer"><Icon name="archive" /><span><strong>在 ReadWeave 精细编辑</strong><small>已验证当前页面的权威笔记和全部子对象</small></span><Icon name="chevronRight" /></a>}
    {draft?.readweaveNoteId && !deepLink && <p className="empty-inline">ReadWeave 深链接正在验证，连接恢复后可以重试</p>}
    <InspectorSection title="当前对象">
      <Definition label="页面 ID" value={page.id} />
      <Definition label="草稿修订" value={String(draft?.revision ?? 0)} />
      <Definition label="内容哈希" value={(draft?.contentHash || "—").slice(0, 16)} />
      <Definition label="ReadWeave 笔记" value={draft?.readweaveNoteId || "首次保存后建立"} />
    </InspectorSection>
    <InspectorSection title={`来源锚点 · ${page.anchors.length}`}>
      <div className="anchor-list">{page.anchors.map((anchor) => <div key={anchor.id}><span className={`anchor-kind kind-${anchor.kind}`}>{anchor.kind}</span><strong>{anchor.label}</strong>{anchor.text && <small>{anchor.text}</small>}</div>)}</div>
    </InspectorSection>
  </div>;
}

function ModelInspector({ release, page, job }: { release: CourseRelease; page: PageLesson; job?: GenerationJob }) {
  const [policy, setPolicy] = useState<WritingPolicyCurrent>();
  const [harness, setHarness] = useState<GenerationHarnessCurrent>();
  const [entries, setEntries] = useState<GenerationCostEntry[]>([]);
  const [error, setError] = useState("");
  const load = () => Promise.all([api.writingPolicy(), api.generationHarness(), api.costs({ pageId: page.id })]).then(([nextPolicy, nextHarness, costs]) => { setPolicy(nextPolicy); setHarness(nextHarness); setEntries(costs.entries); setError(""); }).catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取策略与模型记录"));
  useEffect(() => { void load(); }, [page.id, job?.state]);
  const latest = entries.at(-1);
  return <div className="inspector-body">
    <div className="route-summary"><span className="route-icon"><Icon name="sparkles" /></span><div><strong>{latest ? `${latest.provider} / ${latest.model}` : "等待模型调用"}</strong><span>{latest ? `${latest.durationMs} ms · ${latest.qualityPassed ? "质量检查通过" : "等待质量修复"}` : "这里显示实际调用，不展示预设模型"}</span></div></div>
    <InspectorSection title="当前任务实证">
      <Definition label="供应商" value={latest?.provider || "尚无调用"} />
      <Definition label="模型" value={latest?.model || "尚无调用"} />
      <Definition label="调用费用" value={latest ? latest.costBasis === "provider_reported" && latest.actualMicrousd !== null ? `${formatMicrousd(latest.actualMicrousd)}（供应商回报）` : latest.costBasis === "price_snapshot" ? `${formatMicrousd(latest.estimatedMicrousd)}（价格估算）` : "费用未知" : "尚无调用"} />
      <Definition label="耗时" value={latest ? `${latest.durationMs} ms` : "—"} />
      <Definition label="质量结果" value={latest ? latest.qualityPassed ? "通过" : "未通过" : "等待生成"} />
    </InspectorSection>
    <InspectorSection title="写作策略快照">
      <Definition label="状态" value={policy ? policy.status === "candidate" ? "候选版本" : "已批准" : "读取中"} />
      <Definition label="策略 ID" value={policy?.policySnapshotId || release.writingPolicySnapshotId} />
      <Definition label="来源提交" value={policy?.sourceCommit || "—"} />
      <Definition label="任务契约" value={policy?.taskContract || "—"} />
      <Definition label="验证器" value={policy ? `${policy.validator.status} · ${policy.validator.sourceVerification}` : "读取中"} />
      {policy && <p className="policy-summary">{policy.summary}</p>}
      {policy && <details className="prompt-inspector"><summary>查看本轮实际提示词模板</summary><pre>{policy.promptTemplate}</pre></details>}
    </InspectorSection>
    <InspectorSection title="生成 Harness">
      <Definition label="Harness" value={harness ? `${harness.id} · v${harness.version}` : "读取中"} />
      <Definition label="聚合哈希" value={harness?.aggregateSha256.slice(0, 16) || "—"} />
      {harness && <details className="prompt-inspector"><summary>查看教学蓝图、系统提示词、用户模板与 Schema</summary><pre>{`TEACHING BLUEPRINT\n${harness.blueprint}\n\nSYSTEM\n${harness.systemPrompt}\n\nUSER TEMPLATE\n${harness.userPrompt}\n\nSCHEMA\n${JSON.stringify(harness.schema, null, 2)}`}</pre></details>}
    </InspectorSection>
    <InspectorSection title="当前发布证据">
      <Definition label="使用路线" value={release.modelRoute} />
      <Definition label="质量版本" value={release.qualityHarnessVersion} />
      <Definition label="累计成本" value={`$${release.costUsd.toFixed(4)}`} />
    </InspectorSection>
    {error && <p className="dialog-error"><Icon name="warning" />{error}</p>}
    <button className="quiet-button" onClick={load}>刷新策略与模型记录</button>
  </div>;
}

function CostInspector({ release, page, job }: { release: CourseRelease; page: PageLesson; job?: GenerationJob }) {
  const [entries, setEntries] = useState<GenerationCostEntry[]>([]);
  const [rollups, setRollups] = useState<CostRollup[]>([]);
  const [error, setError] = useState("");
  const load = () => api.costs({ courseId: release.courseId }).then((result) => { setEntries(result.entries); setRollups(result.rollups); setError(""); }).catch((reason) => setError(reason instanceof Error ? reason.message : "成本账本读取失败"));
  useEffect(() => { load(); }, [release.courseId, job?.state]);
  const course = rollups.find((item) => item.scope === "course" && item.scopeId === release.courseId);
  const pageEntries = entries.filter((item) => item.pageId === page.id).slice().reverse();
  const accounted = (entry: GenerationCostEntry) => entry.costBasis === "provider_reported" && entry.actualMicrousd !== null ? entry.actualMicrousd : entry.estimatedMicrousd;
  const used = entries.reduce((sum, item) => sum + accounted(item), 0);
  const pageUsed = pageEntries.reduce((sum, item) => sum + accounted(item), 0);
  const cashKnownSubtotal = entries.reduce((sum, item) => sum + (item.cashCostMicrousd ?? 0), 0);
  const quotaKnownSubtotal = entries.reduce((sum, item) => sum + (item.quotaConsumedMicrousd ?? 0), 0);
  const cash = entries.some((item) => item.cashCostMicrousd === null) ? `${formatMicrousd(cashKnownSubtotal)} + 未知` : formatMicrousd(cashKnownSubtotal);
  const quota = entries.some((item) => item.quotaConsumedMicrousd === null) ? `${formatMicrousd(quotaKnownSubtotal)} + 未知` : formatMicrousd(quotaKnownSubtotal);
  const estimated = entries.reduce((sum, item) => sum + item.estimatedMicrousd, 0);
  const estimatedCash = course?.estimatedCashCostMicrousd ?? pageEntries.reduce((sum, item) => sum + (item.estimatedCashCostMicrousd ?? item.cashCostMicrousd ?? 0), 0);
  const estimatedQuota = course?.estimatedQuotaConsumedMicrousd ?? pageEntries.reduce((sum, item) => sum + (item.estimatedQuotaConsumedMicrousd ?? item.quotaConsumedMicrousd ?? 0), 0);
  const projectedCourseCost = entries.length > 0 ? Math.round(estimated / entries.length * release.pages.length) : 0;
  const unknownCosts = entries.filter((item) => item.costBasis === "not_available").length;
  const snapshot = pageEntries.find((entry) => entry.unitPriceSnapshot.source !== "价格未配置")?.unitPriceSnapshot;
  return <div className="inspector-body cost-inspector">
    <div className="cost-hero"><div><span>课程累计</span><strong>{formatMicrousd(used)}</strong><small>供应商回报与价格估算合计</small></div><div><span>本页累计</span><strong>{formatMicrousd(pageUsed)}</strong><small>{pageEntries.length} 次调用</small></div></div>
    <div className="cost-ledger-grid"><div><span>供应商回报费用</span><strong>{cash}</strong><small>不是账单确认金额</small></div><div><span>套餐额度折算</span><strong>{quota}</strong><small>仅含供应商回报</small></div><div><span>预计完课成本</span><strong>{formatMicrousd(projectedCourseCost)}</strong><small>按当前平均调用外推</small></div><div><span>价格估算与预留</span><strong>{formatMicrousd(estimated)}</strong><small>{unknownCosts ? `${unknownCosts} 次调用实际费用未知` : "所有调用均可估算"}</small></div></div>
    <div className="cost-source"><span className="live-dot" /><span>{snapshot ? `价格快照 ${snapshot.capturedAt.slice(0, 10)} · ${snapshot.source}` : "尚未取得可用价格快照，已显示供应商回报或待配置状态"}</span></div>
    <div className="budget-card"><div><span>新生成单页调用上限</span><strong>$0.06</strong></div><div className="budget-track"><span style={{ width: `${Math.min(100, pageUsed / 60_000 * 100)}%` }} /></div><small>按模型回报或价格快照核算，达到上限会停止后续调用；首次调用的计费须在返回后确认</small></div>
    <InspectorSection title="现金与额度账本"><div className="cost-accounting"><Definition label="已用 API 等价总额" value={formatMicrousd(used)} /><Definition label="现金支出" value={cash} /><Definition label="套餐额度折算" value={quota} /><Definition label="预计现金支出" value={formatMicrousd(estimatedCash)} /><Definition label="预计套餐额度" value={formatMicrousd(estimatedQuota)} /></div></InspectorSection>
    {job && <InspectorSection title="当前任务"><Definition label="任务状态" value={job.state} /><Definition label="页面进度" value={`${job.completedPageIds.length}/${job.pageIds.length}`} /><Definition label="任务花费" value={`$${job.spentUsd.toFixed(4)}`} /></InspectorSection>}
    <InspectorSection title="按阶段"><div className="cost-bars">{(course?.byStage ?? []).map((item) => { const amount = entries.filter((entry) => entry.stage === item.stage).reduce((sum, entry) => sum + accounted(entry), 0); return <div key={item.stage}><span>{stageLabel(item.stage)}</span><i><b style={{ width: `${used ? amount / used * 100 : 0}%` }} /></i><strong>{formatMicrousd(amount)}</strong></div>; })}</div></InspectorSection>
    <InspectorSection title="按模型"><div className="cost-bars">{(course?.byModel ?? []).map((item) => { const amount = entries.filter((entry) => entry.model === item.model).reduce((sum, entry) => sum + accounted(entry), 0); return <div key={item.model}><span>{item.model}</span><i><b style={{ width: `${used ? amount / used * 100 : 0}%` }} /></i><strong>{formatMicrousd(amount)}</strong></div>; })}</div></InspectorSection>
    <InspectorSection title={`本页调用明细 · ${pageEntries.length}`}>{pageEntries.length ? <div className="cost-entry-list">{pageEntries.map((entry) => <article key={entry.id}><header><strong>{entry.model}</strong><span>{entry.costBasis === "not_available" ? `实际费用未知${entry.estimatedMicrousd > 0 ? `（预留估算 ${formatMicrousd(entry.estimatedMicrousd)}）` : ""}` : `${formatMicrousd(accounted(entry))}${entry.costBasis === "provider_reported" ? "（供应商回报）" : "（估算）"}`}</span></header><p>{stageLabel(entry.stage)} · {entry.inputTokens} 输入 · {entry.outputTokens} 输出 · {entry.durationMs} ms</p><small>{entry.status === "succeeded" ? `质量检查${entry.qualityPassed ? "通过" : "未通过"}` : entry.status === "cancelled" ? "调用已取消" : "调用失败"}</small></article>)}</div> : <p className="empty-inline">本页还没有模型调用记录</p>}</InspectorSection>
    {error && <p className="dialog-error"><Icon name="warning" />{error}</p>}
    <button className="quiet-button" onClick={load}>刷新成本账本</button>
  </div>;
}

function formatMicrousd(value: number) { return `$${(value / 1_000_000).toFixed(4)}`; }
function stageLabel(stage: string) { return ({ extract: "来源提取", atomize: "页面拆解", teach: "教授讲解", review: "教学评审", repair: "局部修复", question_refill: "题库补充" } as Record<string, string>)[stage] || stage; }

function InspectorSection({ title, children }: { title: string; children: ReactNode }) { return <section className="inspector-section"><h3>{title}</h3>{children}</section>; }
function Metric({ label, value, tone }: { label: string; value: string; tone: string }) { return <div className="metric-row"><span>{label}</span><strong className={`metric-${tone}`}>{value}</strong></div>; }
function CheckRow({ ok, label, title }: { ok: boolean; label: string; title?: string }) { return <div className="check-row" title={title}><span className={ok ? "ok" : "fail"}><Icon name={ok ? "check" : "warning"} /></span><span>{label}</span></div>; }
function Definition({ label, value }: { label: string; value: string }) { return <div className="definition-row"><span>{label}</span><code title={value}>{value}</code></div>; }
