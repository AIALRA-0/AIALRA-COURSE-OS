import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { CostRollup, CourseRelease, ExplanationBlock, GenerationCostEntry, GenerationHarnessCurrent, GenerationJob, LessonDraft, PageLesson, QualityValidationResult, QuestionBankItem, ReadWeaveSyncStatus, WritingPolicyCurrent } from "@course-os/contracts";
import { api } from "./api.js";
import { Icon } from "./Icon.js";
import { Markdown } from "./Markdown.js";
import { SlideViewer } from "./SlideViewer.js";

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

export function StudioWorkspace({ release, page, sync, rightCollapsed, onToggleRight, onPublished, onChanged }: {
  release: CourseRelease;
  page: PageLesson;
  sync?: ReadWeaveSyncStatus;
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
  const [busy, setBusy] = useState<"load" | "save" | "validate" | "publish" | "generate" | "refill" | "">("load");
  const [generationJob, setGenerationJob] = useState<GenerationJob>();
  const [notice, setNotice] = useState("");
  const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 });

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
      setNotice(result.added.length ? `已补充 ${result.added.length} 道待审核题目，请逐题检查后保存` : "题库已经有足够的正式题目或待审核题目");
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

  return (
    <div className="studio-workspace">
      <header className="workspace-header">
        <div className="workspace-title">
          <div className="breadcrumbs"><span>{release.courseTitle}</span><Icon name="chevronRight" /><span>{release.moduleTitle}</span><Icon name="chevronRight" /><strong>第 {page.pageNumber} 页</strong></div>
          <div className="title-line"><h1>{workingPage.title}</h1><span className={`draft-pill ${dirty ? "dirty" : ""}`}>{dirty ? "有未保存修改" : draft?.revision ? `草稿修订 ${draft.revision}` : "基于正式版本"}</span></div>
        </div>
        <div className="workspace-actions">
          <button className="quiet-button" disabled={Boolean(busy)} title={busy ? "请等待当前操作结束" : "只重新生成当前页面"} onClick={generate}><Icon name="sparkles" />{busy === "generate" ? "建立任务中" : "生成本页"}</button>
          <button className="quiet-button" onClick={() => setEditorMode(editorMode === "edit" ? "preview" : "edit")}><Icon name={editorMode === "edit" ? "eye" : "edit"} />{editorMode === "edit" ? "预览" : "编辑"}</button>
          <button className="quiet-button" disabled={!dirty || Boolean(busy)} title={!dirty ? "当前没有需要保存的修改" : busy ? "请等待当前操作结束" : "保存到 ReadWeave 草稿"} onClick={save}><Icon name="cloud" />{busy === "save" ? "同步中" : "保存草稿"}</button>
          <button className="quiet-button" disabled={Boolean(busy)} title={busy ? "请等待当前操作结束" : "运行确定性发布检查"} onClick={validate}><Icon name="check" />质量检查</button>
          <button className="primary-button" disabled={Boolean(busy)} title={busy ? "请等待当前操作结束" : "通过质量门后发布不可变版本"} onClick={publish}><Icon name="publish" />{busy === "publish" ? "发布中" : "发布版本"}</button>
        </div>
      </header>

      {notice && <div className={`studio-notice ${notice.includes("失败") || notice.includes("阻止") ? "error" : ""}`}><Icon name={notice.includes("失败") || notice.includes("阻止") ? "warning" : "check"} /><span>{notice}</span></div>}

      <div className={`studio-columns ${rightCollapsed ? "right-is-collapsed" : ""}`}>
        <main className="studio-canvas">
          <section className="source-stage">
            <div className="section-heading"><div><span className="section-kicker">SOURCE PAGE</span><h2>原始材料</h2></div><span className="source-meta">第 {page.pageNumber} 页 · {workingPage.anchors.length} 个来源锚点</span></div>
            <div className="studio-slide"><SlideViewer imageUrl={workingPage.imageUrl} title={workingPage.title} value={view} onChange={setView} /></div>
          </section>

          <section className="lesson-editor">
            <div className="section-heading"><div><span className="section-kicker">TEACHING DRAFT</span><h2>教授级讲解</h2></div><div className="segmented"><button className={editorMode === "edit" ? "active" : ""} onClick={() => setEditorMode("edit")}>编辑</button><button className={editorMode === "preview" ? "active" : ""} onClick={() => setEditorMode("preview")}>学习预览</button></div></div>
            <div className="editor-block-list">
              {workingPage.blocks.map((block, index) => (
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
          </section>
        </main>

        {rightCollapsed
          ? <aside className="studio-right-rail"><button onClick={onToggleRight} aria-label="展开检查栏" title="展开检查栏"><Icon name="chevronLeft" /><span>展开检查</span></button></aside>
          : <aside className="studio-inspector">
          <div className="column-collapse-row"><span>制作检查</span><button onClick={onToggleRight} aria-label="收起检查栏" title="收起检查栏"><Icon name="chevronRight" /></button></div>
          <div className="inspector-tabs">
            <button className={inspector === "quality" ? "active" : ""} onClick={() => setInspector("quality")}>质量</button>
            <button className={inspector === "source" ? "active" : ""} onClick={() => setInspector("source")}>来源</button>
            <button className={inspector === "model" ? "active" : ""} onClick={() => setInspector("model")}>模型</button>
            <button className={inspector === "cost" ? "active" : ""} onClick={() => setInspector("cost")}>成本</button>
          </div>
          {inspector === "quality" && <QualityInspector page={workingPage} validation={validation} coverage={coverage} />}
          {inspector === "source" && <SourceInspector page={workingPage} draft={draft} sync={sync} />}
          {inspector === "model" && <ModelInspector release={release} page={workingPage} job={generationJob} />}
          {inspector === "cost" && <CostInspector release={release} page={workingPage} job={generationJob} />}
        </aside>}
      </div>
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
    <header className="question-bank-editor-heading"><div><span className="section-kicker">QUESTION BANK</span><h3>随机问题题库</h3><p>每页至少保留 4 道通过审核的题目；补充题先进入草稿状态，不会直接进入正式学习</p></div><button className="quiet-button" disabled={busy || dirty || approved >= 4} title={dirty ? "请先保存当前修改" : approved >= 4 ? "正式题目已经达到 4 道" : "建立待审核题目"} onClick={onRefill}>{busy ? "补充中" : "补齐题库"}</button></header>
    <div className="question-bank-summary"><strong>{approved} / 4</strong><span>正式题目</span><em>{questions.filter((item) => item.status === "draft").length} 道待审核</em></div>
    {questions.length === 0 && <p className="empty-inline">当前页面还没有题目，可以点击补齐题库建立审核草稿</p>}
    <div className="question-bank-list">{questions.map((question, index) => <QuestionBankRow key={question.id} index={index} question={question} onChange={onChange} />)}</div>
  </section>;
}

function QuestionBankRow({ index, question, onChange }: { index: number; question: QuestionBankItem; onChange: (questionId: string, patch: Partial<QuestionBankItem>) => void }) {
  return <article className="question-bank-row">
    <header><span>{String(index + 1).padStart(2, "0")}</span><select value={question.kind} onChange={(event) => onChange(question.id, { kind: event.target.value as QuestionBankItem["kind"], options: event.target.value === "multiple_choice" ? question.options ?? [question.expectedAnswer] : undefined })}><option value="comprehension">理解题</option><option value="multiple_choice">选择题</option></select><select value={question.status} onChange={(event) => onChange(question.id, { status: event.target.value as QuestionBankItem["status"] })}><option value="draft">待审核</option><option value="approved">已通过</option><option value="retired">已停用</option></select></header>
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
    || approvedQuestions.some((item) => item.kind === "comprehension" || item.kind === "multiple_choice");
  return <div className="inspector-body">
    <div className={`quality-hero ${pass ? "pass" : "hold"}`}><Icon name={pass ? "check" : "warning"} /><div><strong>{pass ? "满足发布要求" : "需要继续审核"}</strong><span>{pass ? "全部确定性质量门已通过" : "正式版本不会被草稿直接覆盖"}</span></div></div>
    <InspectorSection title="覆盖率">
      <Metric label="高风险元素" value={`${Math.round(high * 100)}%`} tone={high === 1 ? "good" : "bad"} />
      <Metric label="一般必需元素" value={`${Math.round(general * 100)}%`} tone={general >= .98 ? "good" : "bad"} />
      <Metric label="覆盖声明" value={`${coverage.covered}/${coverage.total}`} tone={coverage.covered >= coverage.total ? "good" : "neutral"} />
    </InspectorSection>
    <InspectorSection title="结构检查">
      <CheckRow ok={validation?.mathValid ?? page.quality.mathValid} label="数学公式严格解析" />
      <CheckRow ok={(validation?.pseudocodeLines ?? 0) === (validation?.explainedPseudocodeLines ?? 0)} label="伪代码逐行状态说明" />
      <CheckRow ok={page.anchors.length > 0} label="来源锚点可追溯" />
      <CheckRow ok={hasActiveUnderstandingCheck} label="包含主动理解检查" title={approvedQuestions.length > 0 ? `当前页已有 ${approvedQuestions.length} 道已审核理解题；发布质量门要求题库，不要求额外建立 check 块` : undefined} />
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
      <Definition label="实际成本" value={latest ? formatMicrousd(latest.actualMicrousd) : "$0.0000"} />
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
      {harness && <details className="prompt-inspector"><summary>查看系统提示词、用户模板与 Schema</summary><pre>{`SYSTEM\n${harness.systemPrompt}\n\nUSER TEMPLATE\n${harness.userPrompt}\n\nSCHEMA\n${JSON.stringify(harness.schema, null, 2)}`}</pre></details>}
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
  const currentPage = rollups.find((item) => item.scope === "page" && item.scopeId === page.id);
  const pageEntries = entries.filter((item) => item.pageId === page.id).slice().reverse();
  const used = course?.actualMicrousd ?? Math.round(release.costUsd * 1_000_000);
  const cash = course?.cashCostMicrousd ?? pageEntries.reduce((sum, item) => sum + (item.cashCostMicrousd ?? 0), 0);
  const quota = course?.quotaConsumedMicrousd ?? pageEntries.reduce((sum, item) => sum + (item.quotaConsumedMicrousd ?? 0), 0);
  const estimated = course?.estimatedMicrousd ?? used;
  const estimatedCash = course?.estimatedCashCostMicrousd ?? pageEntries.reduce((sum, item) => sum + (item.estimatedCashCostMicrousd ?? item.cashCostMicrousd ?? 0), 0);
  const estimatedQuota = course?.estimatedQuotaConsumedMicrousd ?? pageEntries.reduce((sum, item) => sum + (item.estimatedQuotaConsumedMicrousd ?? item.quotaConsumedMicrousd ?? 0), 0);
  const projectedCourseCost = course && course.callCount > 0 ? Math.round(estimated / course.callCount * release.pages.length) : 0;
  const snapshot = pageEntries.find((entry) => entry.unitPriceSnapshot.source !== "价格未配置")?.unitPriceSnapshot;
  return <div className="inspector-body cost-inspector">
    <div className="cost-hero"><div><span>课程累计</span><strong>{formatMicrousd(used)}</strong><small>API 等价总额</small></div><div><span>本页累计</span><strong>{formatMicrousd(currentPage?.actualMicrousd ?? 0)}</strong><small>{pageEntries.length} 次调用</small></div></div>
    <div className="cost-ledger-grid"><div><span>现金支出</span><strong>{formatMicrousd(cash)}</strong><small>按量供应商实际计费</small></div><div><span>套餐额度折算</span><strong>{formatMicrousd(quota)}</strong><small>OpenCode Go 使用量</small></div><div><span>预计完课成本</span><strong>{formatMicrousd(projectedCourseCost)}</strong><small>按当前平均调用外推</small></div><div><span>预计总成本</span><strong>{formatMicrousd(estimated)}</strong><small>已记录调用的价格快照估算</small></div></div>
    <div className="cost-source"><span className="live-dot" /><span>{snapshot ? `价格快照 ${snapshot.capturedAt.slice(0, 10)} · ${snapshot.source}` : "尚未取得可用价格快照，已显示供应商回报或待配置状态"}</span></div>
    <div className="budget-card"><div><span>质量模式硬预算</span><strong>$8.00</strong></div><div className="budget-track"><span style={{ width: `${Math.min(100, used / 8_000_000 * 100)}%` }} /></div><small>{used >= 8_000_000 ? "已经达到硬预算，新的模型调用会被阻止" : used >= 6_400_000 ? "已经达到 80%，非必要补题会停止" : `还可使用 ${formatMicrousd(8_000_000 - used)}`}</small></div>
    <InspectorSection title="现金与额度账本"><div className="cost-accounting"><Definition label="已用 API 等价总额" value={formatMicrousd(used)} /><Definition label="现金支出" value={formatMicrousd(cash)} /><Definition label="套餐额度折算" value={formatMicrousd(quota)} /><Definition label="预计现金支出" value={formatMicrousd(estimatedCash)} /><Definition label="预计套餐额度" value={formatMicrousd(estimatedQuota)} /></div></InspectorSection>
    {job && <InspectorSection title="当前任务"><Definition label="任务状态" value={job.state} /><Definition label="页面进度" value={`${job.completedPageIds.length}/${job.pageIds.length}`} /><Definition label="任务花费" value={`$${job.spentUsd.toFixed(4)}`} /></InspectorSection>}
    <InspectorSection title="按阶段"><div className="cost-bars">{(course?.byStage ?? []).map((item) => <div key={item.stage}><span>{stageLabel(item.stage)}</span><i><b style={{ width: `${course?.actualMicrousd ? item.actualMicrousd / course.actualMicrousd * 100 : 0}%` }} /></i><strong>{formatMicrousd(item.actualMicrousd)}</strong></div>)}</div></InspectorSection>
    <InspectorSection title="按模型"><div className="cost-bars">{(course?.byModel ?? []).map((item) => <div key={item.model}><span>{item.model}</span><i><b style={{ width: `${course?.actualMicrousd ? item.actualMicrousd / course.actualMicrousd * 100 : 0}%` }} /></i><strong>{formatMicrousd(item.actualMicrousd)}</strong></div>)}</div></InspectorSection>
    <InspectorSection title={`本页调用明细 · ${pageEntries.length}`}>{pageEntries.length ? <div className="cost-entry-list">{pageEntries.map((entry) => <article key={entry.id}><header><strong>{entry.model}</strong><span>{formatMicrousd(entry.actualMicrousd)}</span></header><p>{stageLabel(entry.stage)} · {entry.inputTokens} 输入 · {entry.outputTokens} 输出 · {entry.durationMs} ms</p><small>{entry.status === "succeeded" ? `质量检查${entry.qualityPassed ? "通过" : "未通过"}` : entry.status === "cancelled" ? "调用已取消" : "调用失败"}</small></article>)}</div> : <p className="empty-inline">本页还没有模型调用记录</p>}</InspectorSection>
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
