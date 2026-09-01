import { useEffect, useMemo, useState } from "react";
import type { CourseRelease, QuestionBankItem, ReviewMap, ReviewPlan, ReviewSession } from "@course-os/contracts";
import { api } from "./api.js";
import { Icon } from "./Icon.js";

type ReviewObjective = ReviewMap["objectives"][number];
type PendingReviewResult = { feedback: string; correct: boolean; session: ReviewSession };
type GroupPage = { key: string; pageNumber: number; pageTitle: string; objectives: ReviewObjective[] };
type GroupModule = { key: string; moduleId: string; moduleTitle: string; pages: GroupPage[] };
type GroupCourse = { key: string; courseId: string; courseTitle: string; modules: GroupModule[] };

export function ReviewWorkspace({ releases, reviewMap, onOpenPage, onReviewChanged }: {
  releases: CourseRelease[];
  reviewMap?: ReviewMap;
  onOpenPage: (releaseId: string, pageId: string) => void;
  onReviewChanged?: () => Promise<void> | void;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [courseFilter, setCourseFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const [timeFilter, setTimeFilter] = useState("all");
  const [selectedObjectiveIds, setSelectedObjectiveIds] = useState<string[]>([]);
  const [selectionSource, setSelectionSource] = useState<"due" | "manual">("manual");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [plan, setPlan] = useState<ReviewPlan>();
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState("");
  const [session, setSession] = useState<ReviewSession>();
  const [sessionObjective, setSessionObjective] = useState<ReviewObjective>();
  const [sessionQuestion, setSessionQuestion] = useState<QuestionBankItem>();
  const [answer, setAnswer] = useState("");
  const [hintLevel, setHintLevel] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [pendingResult, setPendingResult] = useState<PendingReviewResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const objectives = reviewMap?.objectives ?? [];
  const items = useMemo(() => objectives.filter((objective) => {
    if (courseFilter !== "all" && objective.courseId !== courseFilter) return false;
    if (stateFilter !== "all" && objective.state !== stateFilter) return false;
    if (timeFilter === "due" && !objective.due) return false;
    if (timeFilter === "week" && (!objective.nextReviewAt || new Date(objective.nextReviewAt).getTime() > Date.now() + 7 * 86_400_000)) return false;
    return true;
  }), [courseFilter, objectives, stateFilter, timeFilter]);

  const selectedObjectives = useMemo(() => selectedObjectiveIds.map((id) => objectives.find((item) => item.objectiveId === id)).filter((item): item is ReviewObjective => Boolean(item)), [objectives, selectedObjectiveIds]);
  const groups = useMemo(() => groupObjectives(items), [items]);
  const availableQuestionCount = useMemo(() => selectedObjectives.reduce((total, objective) => {
    const page = releases.find((release) => release.id === objective.releaseId)?.pages.find((candidate) => candidate.id === objective.pageId);
    const release = releases.find((candidate) => candidate.id === objective.releaseId);
    const available = page?.questionBank?.filter((item) => item.status === "approved" && item.objectiveId === objective.objectiveId).length
      || release?.assessments?.filter((item) => item.objectiveId === objective.objectiveId).length
      || 0;
    return total + (available > 0 ? 1 : 0);
  }, 0), [releases, selectedObjectives]);
  const missingQuestionCount = Math.max(0, selectedObjectives.length - availableQuestionCount);

  const loadSession = (next: ReviewSession, objective?: ReviewObjective, planId?: string, question?: QuestionBankItem) => {
    setSession(next);
    setSessionObjective(objective);
    setSessionQuestion(question);
    setAnswer("");
    setHintLevel(0);
    setFeedback("");
    setPendingResult(undefined);
    writeReviewHash(planId ?? next.reviewPlanId ?? plan?.id, next.id);
  };

  useEffect(() => {
    const params = new URLSearchParams(location.hash.slice(1));
    const planId = params.get("reviewPlan");
    const sessionId = params.get("reviewSession");
    let cancelled = false;
    const restore = async () => {
      try {
        if (planId) {
          const result = await api.reviewPlan(planId);
          if (!cancelled) {
            setPlan(result.plan);
            setSelectedObjectiveIds(result.plan.objectiveIds);
            setSelectionSource(result.plan.source);
          }
        }
        if (sessionId) {
          const result = await api.reviewSession(sessionId);
          if (!cancelled) loadSession(result.session, result.objective, planId ?? result.session.reviewPlanId, result.question);
        } else if (!planId) {
          const result = await api.currentReviewSession();
          if (!cancelled && result.session) loadSession(result.session, result.objective, result.session.reviewPlanId, result.question);
        }
      } catch (reason) {
        if (!cancelled) setPlanError(reason instanceof Error ? reason.message : "复习状态恢复失败，请重试");
      }
    };
    void restore();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!session?.currentObjectiveId || sessionObjective) return;
    setSessionObjective(objectives.find((item) => item.objectiveId === session.currentObjectiveId));
  }, [objectives, session, sessionObjective]);

  const toggleSelection = (objectiveId: string) => {
    setPlan(undefined);
    setPlanError("");
    setSelectedObjectiveIds((current) => current.includes(objectiveId) ? current.filter((id) => id !== objectiveId) : [...current, objectiveId]);
    writeReviewHash();
  };

  const setSelection = (ids: string[], source: "due" | "manual") => {
    setSelectedObjectiveIds([...new Set(ids)]);
    setSelectionSource(source);
    setPlan(undefined);
    setPlanError("");
    writeReviewHash();
  };

  const toggleGroup = (_key: string, objectiveIds: string[]) => {
    const allSelected = objectiveIds.length > 0 && objectiveIds.every((id) => selectedObjectiveIds.includes(id));
    const next = allSelected
      ? selectedObjectiveIds.filter((id) => !objectiveIds.includes(id))
      : [...new Set([...selectedObjectiveIds, ...objectiveIds])];
    setSelection(next, "manual");
  };

  const toggleExpanded = (key: string) => setExpandedGroups((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const preparePlan = async () => {
    if (!selectedObjectiveIds.length || planBusy) return;
    setPlanBusy(true); setPlanError(""); setError("");
    try {
      const result = await api.createReviewPlan({ source: selectionSource, objectiveIds: selectedObjectiveIds, budgetUsd: 4, seed: `${selectionSource}:${selectedObjectiveIds.join(",")}` });
      setPlan(result.plan);
      writeReviewHash(result.plan.id);
    } catch (reason) { setPlanError(reason instanceof Error ? reason.message : "复习内容准备失败，请重试"); }
    finally { setPlanBusy(false); }
  };

  const retryPlan = async () => {
    if (!plan || planBusy) return;
    setPlanBusy(true); setPlanError("");
    try { setPlan((await api.retryReviewPlan(plan.id)).plan); }
    catch (reason) { setPlanError(reason instanceof Error ? reason.message : "失败部分重试失败，请稍后再试"); }
    finally { setPlanBusy(false); }
  };

  const cancelPlan = async () => {
    if (!plan || planBusy) return;
    setPlanBusy(true); setPlanError("");
    try { setPlan((await api.cancelReviewPlan(plan.id)).plan); }
    catch (reason) { setPlanError(reason instanceof Error ? reason.message : "复习计划取消失败，请重试"); }
    finally { setPlanBusy(false); }
  };

  const startPlan = async () => {
    if (!plan || plan.status !== "ready" || planBusy) return;
    setPlanBusy(true); setPlanError(""); setError("");
    try {
      const result = await api.startReviewPlan(plan.id);
      loadSession(result.session, result.objective, plan.id, result.question);
      setPlan((current) => current ? { ...current, status: "started", startedAt: new Date().toISOString() } : current);
      writeReviewHash(plan.id, result.session.id);
    } catch (reason) { setPlanError(reason instanceof Error ? reason.message : "复习会话启动失败，请确认复习内容已经同步"); }
    finally { setPlanBusy(false); }
  };

  const submitAnswer = async () => {
    if (!session || !answer.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const result = await api.reviewSessionAttempt(session.id, { answer, usedHintLevel: hintLevel, questionId: sessionQuestion?.id });
      setSession(result.session);
      setFeedback(result.feedback || (result.attempt.correct ? "回答正确" : "需要回到课程页重新定位错误步骤"));
      setPendingResult({ feedback: result.feedback || "", correct: result.attempt.correct, session: result.session });
      await onReviewChanged?.();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "作答尚未保存，请重试"); }
    finally { setBusy(false); }
  };

  const advanceAfterResult = async () => {
    if (!pendingResult || busy) return;
    setBusy(true); setError("");
    try {
      if (pendingResult.session.currentObjectiveId) {
        const next = await api.reviewSession(pendingResult.session.id);
        setSession(next.session);
        setSessionObjective(next.objective);
        setSessionQuestion(next.question);
        writeReviewHash(plan?.id ?? next.session.reviewPlanId, next.session.id);
        setAnswer(""); setHintLevel(0); setFeedback(""); setPendingResult(undefined);
      } else {
        setPendingResult(undefined); setSessionObjective(undefined); setFeedback("");
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "下一道复习题载入失败，请重试"); }
    finally { setBusy(false); }
  };

  const skip = async () => {
    if (!session || busy) return;
    setBusy(true); setError("");
    try {
      const result = await api.skipReviewSession(session.id);
      setSession(result.session); setSessionObjective(result.objective); setSessionQuestion(result.question); writeReviewHash(plan?.id ?? result.session.reviewPlanId, result.session.id); setAnswer(""); setHintLevel(0); setFeedback(""); setPendingResult(undefined);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "跳过操作失败"); }
    finally { setBusy(false); }
  };

  const currentPage = sessionObjective ? releases.find((release) => release.id === sessionObjective.releaseId)?.pages.find((page) => page.id === sessionObjective.pageId) : undefined;
  if (session && sessionObjective && (session.status === "active" || pendingResult)) return <ReviewSessionView objective={sessionObjective} question={sessionQuestion} page={currentPage} answer={answer} hintLevel={hintLevel} feedback={feedback} resultShown={Boolean(pendingResult)} resultCorrect={pendingResult?.correct ?? false} nextLabel={pendingResult?.session.currentObjectiveId ? "下一道复习题" : "完成复习"} busy={busy} error={error} onAnswer={setAnswer} onHint={() => setHintLevel((level) => Math.min(6, level + 1))} onSubmit={submitAnswer} onNext={advanceAfterResult} onSkip={skip} onOpenPage={() => onOpenPage(sessionObjective.releaseId, sessionObjective.pageId)} />;
  if (session?.status === "completed" && !pendingResult) return <div className="review-complete"><span className="review-complete-icon"><Icon name="check" /></span><h1>这次复习完成了</h1><p>你完成了 {session.objectiveIds.length} 个目标，结果已经写入 ReadWeave</p><div className="review-complete-actions"><button className="primary-button" data-action="review-return-map" onClick={() => { setSession(undefined); setSessionObjective(undefined); setSessionQuestion(undefined); setPlan(undefined); setSelectedObjectiveIds([]); writeReviewHash(); }}>回到掌握地图</button><button className="quiet-button" data-action="review-open-first-page" onClick={() => { const objective = objectives.find((item) => item.objectiveId === session.objectiveIds[0]); if (objective) onOpenPage(objective.releaseId, objective.pageId); }}>打开教学页</button></div></div>;

  if (!reviewMap) return <div className="review-unavailable"><span><Icon name="warning" /></span><h1>掌握地图暂时不可用</h1><p>ReadWeave 当前没有返回复习数据，已有课程不会受影响，恢复连接后可以继续读取掌握记录</p><button className="primary-button" data-action="review-reload-map" aria-describedby="review-reload-map-reason" disabled={busy} onClick={() => { setBusy(true); setError(""); Promise.resolve(onReviewChanged?.()).catch((reason) => setError(reason instanceof Error ? reason.message : "复习数据载入失败")).finally(() => setBusy(false)); }}>{busy ? "正在重试" : "重试读取"}</button><span id="review-reload-map-reason" className="sr-only">{busy ? "正在重新读取掌握地图" : "重新读取当前正式课程的掌握记录"}</span>{error && <p className="review-error"><Icon name="warning" />{error}</p>}</div>;

  const due = reviewMap.summary.due;
  const needsReview = reviewMap.summary.needsReview;
  const mastered = reviewMap.summary.mastered;
  return <div className="review-workspace">
    <header className="review-header">
      <div><span className="section-kicker">REVIEW CENTER</span><h1>把学过的内容真正留下来</h1><p>先选择要复习的目标，再准备内容，最后开始复习，不在打开页面时自动生成</p></div>
      <div className="review-date"><span>今天</span><strong>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date())}</strong></div>
    </header>

    <section className="review-stats">
      <StatCard actionId="review-select-due" icon="review" label="今日待复习" value={String(due)} detail={due ? "点击后选择今日到期目标" : "当前没有到期任务，可主动选择"} tone="amber" onClick={() => setSelection(objectives.filter((item) => item.due).map((item) => item.objectiveId), "due")} disabled={!due || planBusy} disabledReason={!due ? "当前没有到期任务，请从掌握地图选择目标" : planBusy ? "正在准备复习内容" : undefined} />
      <StatCard actionId="review-filter-needs" icon="target" label="需要巩固" value={String(needsReview)} detail="错误或依赖提示的目标" tone="red" onClick={() => { setStateFilter("needs_review"); setTimeFilter("all"); }} />
      <StatCard actionId="review-filter-mastered" icon="check" label="已经掌握" value={String(mastered)} detail="含无提示与迁移证据" tone="green" onClick={() => setStateFilter("mastered")} />
      <StatCard icon="layers" label="课程页面" value={String(reviewMap.pageCount)} detail={`${reviewMap.releaseCount} 个当前正式版本`} tone="blue" />
    </section>

    <div className="review-grid review-selection-grid">
      <section className="review-queue-panel">
        <div className="panel-heading"><div><h2>掌握地图</h2><span>{items.length} 个目标 · 勾选后生成复习内容</span></div><button className="quiet-button" data-action="review-toggle-filters" onClick={() => setFiltersOpen((open) => !open)} aria-expanded={filtersOpen}><Icon name="more" />筛选</button></div>
        <div className="review-selection-toolbar"><button className="quiet-button compact" data-action="review-select-due" aria-describedby="review-select-due-reason" onClick={() => setSelection(objectives.filter((item) => item.due).map((item) => item.objectiveId), "due")} disabled={!due || planBusy}>选择今日到期</button><span id="review-select-due-reason" className="sr-only">{!due ? "当前没有到期目标" : planBusy ? "正在准备复习内容" : "选择所有当前到期目标"}</span><button className="quiet-button compact" data-action="review-select-unmastered" aria-describedby="review-select-unmastered-reason" onClick={() => setSelection(objectives.filter((item) => item.state !== "mastered").map((item) => item.objectiveId), "manual")} disabled={planBusy}>选择未掌握</button><span id="review-select-unmastered-reason" className="sr-only">{planBusy ? "正在准备复习内容" : "选择尚未掌握、正在练习或需要复习的目标"}</span><button className="quiet-button compact" data-action="review-clear-selection" aria-describedby="review-clear-selection-reason" onClick={() => setSelection([], "manual")} disabled={!selectedObjectiveIds.length || planBusy}>清空选择</button><span id="review-clear-selection-reason" className="sr-only">{!selectedObjectiveIds.length ? "当前没有已选择的目标" : planBusy ? "正在准备复习内容" : "清除本次复习选择"}</span></div>
        {filtersOpen && <div className="review-filters"><label><span>课程</span><select data-action="review-filter-course" value={courseFilter} onChange={(event) => setCourseFilter(event.target.value)}><option value="all">全部课程</option>{[...new Map(objectives.map((objective) => [objective.courseId, objective.courseTitle])).entries()].map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label><label><span>掌握状态</span><select data-action="review-filter-state" value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}><option value="all">全部状态</option><option value="unseen">尚未学习</option><option value="introduced">已经接触</option><option value="practicing">正在练习</option><option value="mastered">已经掌握</option><option value="needs_review">需要复习</option></select></label><label><span>到期时间</span><select data-action="review-filter-time" value={timeFilter} onChange={(event) => setTimeFilter(event.target.value)}><option value="all">全部时间</option><option value="due">已经到期</option><option value="week">未来 7 天</option></select></label><button className="quiet-button" data-action="review-clear-filters" onClick={() => { setCourseFilter("all"); setStateFilter("all"); setTimeFilter("all"); }}>清除筛选</button></div>}
        {planError && <p className="review-error"><Icon name="warning" />{planError}</p>}
        {items.length === 0 ? <div className="review-empty"><span><Icon name="layers" /></span><h3>没有符合筛选条件的目标</h3><p>可以清除筛选，或从正式课程页面开始学习</p></div> : <div className="review-map-groups">{groups.map((course) => <CourseGroupView key={course.key} group={course} expandedGroups={expandedGroups} selectedObjectiveIds={selectedObjectiveIds} onToggleExpanded={toggleExpanded} onToggleGroup={toggleGroup} onToggleObjective={toggleSelection} onOpenPage={onOpenPage} disabled={planBusy} />)}</div>}
      </section>

      <ReviewPlanPanel plan={plan} selectedCount={selectedObjectiveIds.length} availableQuestionCount={availableQuestionCount} missingQuestionCount={missingQuestionCount} budgetUsd={4} busy={planBusy} error={planError} onPrepare={() => void preparePlan()} onRetry={() => void retryPlan()} onCancel={() => void cancelPlan()} onStart={() => void startPlan()} />
    </div>
  </div>;
}

function CourseGroupView({ group, expandedGroups, selectedObjectiveIds, onToggleExpanded, onToggleGroup, onToggleObjective, onOpenPage, disabled }: { group: GroupCourse; expandedGroups: Set<string>; selectedObjectiveIds: string[]; onToggleExpanded: (key: string) => void; onToggleGroup: (key: string, ids: string[]) => void; onToggleObjective: (id: string) => void; onOpenPage: (releaseId: string, pageId: string) => void; disabled: boolean }) {
  const courseIds = group.modules.flatMap((module) => module.pages.flatMap((page) => page.objectives.map((item) => item.objectiveId)));
  const courseOpen = expandedGroups.has(group.key);
  return <section className="review-course-group"><GroupHeader label={group.courseTitle} detail={`${courseIds.length} 个学习目标`} open={courseOpen} selected={courseIds} selectedObjectiveIds={selectedObjectiveIds} onToggle={() => onToggleExpanded(group.key)} onSelect={() => onToggleGroup(group.key, courseIds)} disabled={disabled} />{courseOpen && <div className="review-module-groups">{group.modules.map((module) => { const ids = module.pages.flatMap((page) => page.objectives.map((item) => item.objectiveId)); const open = expandedGroups.has(module.key); return <section className="review-module-group" key={module.key}><GroupHeader label={module.moduleTitle} detail={`${ids.length} 个学习目标`} open={open} selected={ids} selectedObjectiveIds={selectedObjectiveIds} onToggle={() => onToggleExpanded(module.key)} onSelect={() => onToggleGroup(module.key, ids)} disabled={disabled} />{open && <div className="review-page-groups">{module.pages.map((page) => <div className="review-page-group" key={page.key}>{page.objectives.map((objective) => <ReviewObjectiveRow key={objective.objectiveId} objective={objective} selected={selectedObjectiveIds.includes(objective.objectiveId)} disabled={disabled} onToggle={() => onToggleObjective(objective.objectiveId)} onOpenPage={() => onOpenPage(objective.releaseId, objective.pageId)} />)}</div>)}</div>}</section>;})}</div>}</section>;
}

function GroupHeader({ label, detail, open, selected, selectedObjectiveIds, onToggle, onSelect, disabled }: { label: string; detail: string; open: boolean; selected: string[]; selectedObjectiveIds: string[]; onToggle: () => void; onSelect: () => void; disabled: boolean }) {
  const allSelected = selected.length > 0 && selected.every((id) => selectedObjectiveIds.includes(id));
  const key = label.toLocaleLowerCase().replace(/\s+/g, "-");
  return <div className="review-group-header"><button className="review-group-toggle" data-action={`review-group-toggle:${key}`} onClick={onToggle} aria-expanded={open}><Icon name={open ? "chevronDown" : "chevronRight"} /><span><strong>{label}</strong><small>{detail}</small></span></button><label className="review-group-check" title={allSelected ? "取消选择这一组" : "选择这一组"}><input type="checkbox" data-action={`review-group-select:${key}`} checked={allSelected} disabled={disabled || selected.length === 0} aria-describedby={`review-group-select-reason:${key}`} onChange={onSelect} /><span>选择</span><span id={`review-group-select-reason:${key}`} className="sr-only">{disabled ? "正在准备复习内容" : selected.length === 0 ? "这一组没有可选择的学习目标" : allSelected ? "取消选择这一组" : "选择这一组"}</span></label></div>;
}

function ReviewObjectiveRow({ objective, selected, disabled, onToggle, onOpenPage }: { objective: ReviewObjective; selected: boolean; disabled: boolean; onToggle: () => void; onOpenPage: () => void }) {
  const reasonId = `review-objective-reason:${objective.objectiveId}`;
  return <article className={`review-objective-row ${selected ? "is-selected" : ""}`}><label className="review-objective-check"><input type="checkbox" data-action="review-select-objective" checked={selected} disabled={disabled} aria-describedby={reasonId} onChange={onToggle} /><span /></label><div className="review-objective-copy"><div><span className={`mastery-state state-${objective.state}`}>{masteryLabel(objective.state)}</span><span className="review-page-label">第 {objective.pageNumber} 页</span></div><h3>{objective.objectiveText}</h3><p>{objective.pageTitle}</p><div className="review-evidence"><span><Icon name={objective.unaidedCorrect ? "check" : "warning"} />无提示作答</span><span><Icon name={objective.delayedOrTransferCorrect ? "check" : "warning"} />延迟或迁移证据</span><span><Icon name={objective.hintDependencyCount ? "warning" : "check"} />提示 {objective.hintDependencyCount} 次</span></div>{objective.lastMisconception && <small className="review-misconception">最近错因：{objective.lastMisconception}</small>}<span id={reasonId} className="sr-only">{disabled ? "复习内容准备中，暂时不能修改选择" : selected ? "取消选择这个学习目标" : "选择这个学习目标"}</span></div><button className="quiet-button compact review-open-page" data-action="review-open-objective-page" onClick={onOpenPage}>打开教学页<Icon name="arrowRight" /></button></article>;
}

function ReviewPlanPanel({ plan, selectedCount, availableQuestionCount, missingQuestionCount, budgetUsd, busy, error, onPrepare, onRetry, onCancel, onStart }: { plan?: ReviewPlan; selectedCount: number; availableQuestionCount: number; missingQuestionCount: number; budgetUsd: number; busy: boolean; error: string; onPrepare: () => void; onRetry: () => void; onCancel: () => void; onStart: () => void }) {
  const status = plan?.status;
  const prepareReason = selectedCount === 0 ? "请先在左侧选择至少一个学习目标" : busy ? "正在准备复习内容" : "根据当前选择准备复习题目，并同步到 ReadWeave";
  return <aside className="review-plan-panel"><div className="panel-heading"><div><h2>本次复习</h2><span>{statusLabel(status)}</span></div><span className={`plan-status status-${status || "empty"}`}>{statusLabel(status)}</span></div><div className="review-plan-summary"><div><span>已选目标</span><strong>{selectedCount}</strong></div><div><span>可复用题目</span><strong>{availableQuestionCount}</strong></div><div><span>需要准备</span><strong>{missingQuestionCount}</strong></div><div><span>预计新增费用</span><strong>{formatUsd(plan?.cost.estimatedMicrousd ?? 0)}</strong></div></div><dl className="review-plan-details"><div><dt>预算上限</dt><dd>{formatUsd(budgetUsd * 1_000_000)}</dd></div><div><dt>已用成本</dt><dd>{formatUsd(plan?.cost.actualMicrousd ?? 0)}</dd></div><div><dt>ReadWeave</dt><dd>{plan?.syncState === "connected" ? "已同步" : plan?.syncState === "offline" ? "等待连接" : "等待同步"}</dd></div></dl>{error && <p className="review-error"><Icon name="warning" />{error}</p>}<div className="review-plan-actions">{!plan && <button className="primary-button" data-action="review-prepare-plan" aria-describedby="review-prepare-reason" disabled={busy || selectedCount === 0} title={selectedCount === 0 ? "请先选择至少一个学习目标" : undefined} onClick={onPrepare}>{busy ? "正在准备复习内容" : "生成复习内容"}</button>}{!plan && <span id="review-prepare-reason" className="sr-only">{prepareReason}</span>}{plan?.status === "preparing" && <button className="quiet-button" data-action="review-cancel-plan" aria-describedby="review-cancel-plan-reason" disabled={busy} onClick={onCancel}>{busy ? "正在处理" : "取消生成"}</button>}{plan?.status === "preparing" && <span id="review-cancel-plan-reason" className="sr-only">{busy ? "正在取消复习计划" : "取消尚未完成的复习内容准备"}</span>}{(plan?.status === "failed" || plan?.status === "sync_pending") && <><button className="primary-button" data-action="review-retry-plan" aria-describedby="review-retry-plan-reason" disabled={busy} onClick={onRetry}>{busy ? "正在重试" : plan.status === "sync_pending" ? "重试保存" : "只重试失败部分"}</button><span id="review-retry-plan-reason" className="sr-only">{busy ? "正在重试复习计划" : plan.status === "sync_pending" ? "重新保存到 ReadWeave" : "只重新准备失败的复习目标"}</span><button className="quiet-button" data-action="review-cancel-plan" disabled={busy} onClick={onCancel}>取消计划</button></>}{plan?.status === "ready" && <><button className="primary-button" data-action="review-start-plan" aria-describedby="review-start-plan-reason" disabled={busy} onClick={onStart}>{busy ? "正在开始" : "开始复习"}</button><span id="review-start-plan-reason" className="sr-only">{busy ? "正在创建复习会话" : "复习内容已准备并同步，可以开始复习"}</span><button className="quiet-button" data-action="review-cancel-plan" disabled={busy} onClick={onCancel}>取消计划</button></>}{plan?.status === "started" && <p className="plan-inline-note">复习会话正在进行中</p>}{plan?.status === "cancelled" && <p className="plan-inline-note">计划已取消，可以重新选择目标</p>}</div>{!plan && selectedCount === 0 && <p className="plan-disabled-reason">请先在左侧选择至少一个学习目标</p>}<p className="plan-policy-note">打开复习中心只读取掌握地图，不创建会话，不生成题目，也不调用模型</p></aside>;
}

function ReviewSessionView({ objective, question, page, answer, hintLevel, feedback, resultShown, resultCorrect, nextLabel, busy, error, onAnswer, onHint, onSubmit, onNext, onSkip, onOpenPage }: { objective: ReviewObjective; question?: QuestionBankItem; page?: CourseRelease["pages"][number]; answer: string; hintLevel: number; feedback: string; resultShown: boolean; resultCorrect: boolean; nextLabel: string; busy: boolean; error: string; onAnswer: (value: string) => void; onHint: () => void; onSubmit: () => void; onNext: () => void; onSkip: () => void; onOpenPage: () => void }) {
  const isChoice = question?.kind === "multiple_choice" && Boolean(question.options?.length);
  const hintReason = resultShown ? "已经提交回答，请先查看结果" : hintLevel >= 6 ? "提示已经达到最后一层" : busy ? "正在保存上一项操作" : "逐步获得下一层提示，并记录提示依赖";
  const answerReason = resultShown ? "已经提交回答" : !answer.trim() ? "请先填写回答" : busy ? "正在保存上一项回答" : "提交当前回答并保存复习结果";
  return <div className="review-session-workspace"><header className="review-session-header"><div><span className="section-kicker">ACTIVE REVIEW</span><h1>现在复习：{objective.moduleTitle}</h1><p>{objective.courseTitle} · 第 {objective.pageNumber} 页 · {objective.pageTitle}</p></div><button className="quiet-button" data-action="review-session-open-page" onClick={onOpenPage}><Icon name="eye" />打开教学页</button></header><main className="review-session-grid"><section className="review-session-visual">{page ? <img src={page.imageUrl} alt={`第 ${page.pageNumber} 页原始课件`} /> : <div className="review-no-visual">原始页面暂时不可用</div>}</section><section className="review-session-card"><div className="review-question-meta"><span className={`mastery-state state-${objective.state}`}>{masteryLabel(objective.state)}</span><span>{isChoice ? "选择题" : "理解题"}</span></div><h2>{question?.prompt || "请用自己的话解释这个学习目标"}</h2><p className="review-objective-text">{objective.objectiveText}</p>{isChoice ? <fieldset className="review-choice-list" disabled={resultShown}><legend>选择一个答案</legend>{question?.options?.map((option) => <label key={option}><input type="radio" name={`review-${objective.objectiveId}`} value={option} checked={answer === option} onChange={(event) => onAnswer(event.target.value)} />{option}</label>)}</fieldset> : <label><span>你的回答</span><textarea value={answer} disabled={resultShown} onChange={(event) => onAnswer(event.target.value)} placeholder="先写出你的思路，再提交检查" rows={8} /></label>}<div className="review-session-actions"><button className="quiet-button" data-action="review-session-hint" aria-describedby="review-session-hint-reason" disabled={busy || resultShown || hintLevel >= 6} onClick={onHint}>需要提示{hintLevel ? ` · 已使用 ${hintLevel} 层` : ""}</button><span id="review-session-hint-reason" className="sr-only">{hintReason}</span><button className="quiet-button" data-action="review-session-skip" aria-describedby="review-session-skip-reason" disabled={busy || resultShown} onClick={onSkip}>跳过</button><span id="review-session-skip-reason" className="sr-only">{resultShown ? "已经提交回答，请先进入下一题" : busy ? "正在保存上一项操作" : "跳过当前目标并记录跳过状态"}</span>{resultShown ? <button className="primary-button" data-action="review-session-next" aria-describedby="review-session-next-reason" disabled={busy} onClick={onNext}>{busy ? "正在载入" : nextLabel}</button> : <button className="primary-button" data-action="review-session-submit" aria-describedby="review-session-submit-reason" disabled={busy || !answer.trim()} onClick={onSubmit}>{busy ? "正在保存" : "提交回答"}</button>}<span id="review-session-next-reason" className="sr-only">{busy ? "正在载入下一道复习题" : "查看结果后进入下一道复习题或结束复习"}</span><span id="review-session-submit-reason" className="sr-only">{answerReason}</span></div>{hintLevel > 0 && !resultShown && <p className="review-hint"><strong>第 {hintLevel} 层提示</strong>：先把目标拆成对象、关系和结论，再检查你的回答是否说明了为什么</p>}{feedback && <div className={`review-feedback ${resultCorrect ? "is-correct" : "is-incorrect"}`}><Icon name={resultCorrect ? "check" : "warning"} /><p>{feedback}</p></div>}{error && <p className="review-error"><Icon name="warning" />{error}</p>}</section></main></div>;
}

function StatCard({ actionId, icon, label, value, detail, tone, onClick, disabled, disabledReason }: { actionId?: string; icon: "review" | "target" | "check" | "layers"; label: string; value: string; detail: string; tone: string; onClick?: () => void; disabled?: boolean; disabledReason?: string }) {
  const content = <><span className="stat-icon"><Icon name={icon} /></span><span className="stat-copy"><span>{label}</span><strong>{value}</strong><small>{detail}</small></span></>;
  const reasonId = actionId ? `${actionId}-reason` : undefined;
  return onClick ? <><button className={`stat-card tone-${tone}`} data-action={actionId} disabled={disabled} aria-describedby={reasonId} onClick={onClick}>{content}</button>{disabled && reasonId && <span id={reasonId} className="sr-only">{disabledReason || "当前状态下暂时不能执行此操作"}</span>}</> : <article className={`stat-card tone-${tone}`}>{content}</article>;
}

function groupObjectives(items: ReviewObjective[]): GroupCourse[] {
  const courseMap = new Map<string, GroupCourse>();
  for (const objective of items) {
    const course = courseMap.get(objective.courseId) ?? { key: `course:${objective.courseId}`, courseId: objective.courseId, courseTitle: objective.courseTitle, modules: [] };
    let module = course.modules.find((item) => item.moduleId === objective.moduleId);
    if (!module) { module = { key: `module:${objective.moduleId}`, moduleId: objective.moduleId, moduleTitle: objective.moduleTitle, pages: [] }; course.modules.push(module); }
    let page = module.pages.find((item) => item.pageNumber === objective.pageNumber && item.pageTitle === objective.pageTitle);
    if (!page) { page = { key: `page:${objective.pageId}`, pageNumber: objective.pageNumber, pageTitle: objective.pageTitle, objectives: [] }; module.pages.push(page); }
    page.objectives.push(objective);
    courseMap.set(objective.courseId, course);
  }
  return [...courseMap.values()];
}

function statusLabel(status?: ReviewPlan["status"]): string {
  return ({ preparing: "正在准备", ready: "内容已准备", sync_pending: "等待同步", failed: "准备失败", cancelled: "已取消", started: "复习进行中" } as Record<string, string>)[status || ""] || "尚未选择目标";
}

function formatUsd(microusd: number): string {
  return `$${(microusd / 1_000_000).toFixed(4)}`;
}

function masteryLabel(state: string) { return ({ unseen: "尚未学习", introduced: "已经接触", practicing: "正在练习", mastered: "已经掌握", needs_review: "需要复习" } as Record<string, string>)[state] || state; }

function writeReviewHash(planId?: string, sessionId?: string) {
  const params = new URLSearchParams(location.hash.slice(1));
  params.set("mode", "review");
  if (planId) params.set("reviewPlan", planId); else params.delete("reviewPlan");
  if (sessionId) params.set("reviewSession", sessionId); else params.delete("reviewSession");
  history.replaceState(null, "", `#${params.toString()}`);
}
