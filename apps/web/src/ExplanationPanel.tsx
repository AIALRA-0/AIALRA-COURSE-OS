import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CourseRelease, LessonSection, PageLesson, PageQuestion, PseudoCodeLine, QuestionBankItem, QuestionSelection, ReadWeavePageQuestions } from "@course-os/contracts";
import { formatMisconception } from "@course-os/quality";
import { api } from "./api.js";
import { Markdown } from "./Markdown.js";
import { SelfRetellingPanel } from "./SelfRetellingPanel.js";
import { previewQuestionBank, sameQuestionPreview } from "./question-preview.js";

export function ExplanationPanel({ release, page, sessionId, onEnterStudio, loadRootRef, generatedReady }: { release: CourseRelease; page: PageLesson; sessionId?: string; onEnterStudio?: () => void; loadRootRef?: { current: HTMLElement | null }; generatedReady?: boolean }) {
  const sections = useMemo(() => normalizeSections(page), [page]);
  const pseudocode = page.atoms.filter((atom): atom is PseudoCodeLine => atom.kind === "pseudocode_line");
  const [qaRecords, setQaRecords] = useState<PageQuestion[]>([]);
  const [nativeQuestions, setNativeQuestions] = useState<ReadWeavePageQuestions>({ pageId: page.id, questions: [] });
  const [nativeQuestionsError, setNativeQuestionsError] = useState("");
  const [interactiveReady, setInteractiveReady] = useState(false);
  const interactiveMarkerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setInteractiveReady(false);
    const marker = interactiveMarkerRef.current;
    if (!marker || typeof IntersectionObserver === "undefined") {
      setInteractiveReady(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setInteractiveReady(true);
        observer.disconnect();
      }
    }, { root: loadRootRef?.current ?? null, rootMargin: "1600px 0px" });
    observer.observe(marker);
    return () => observer.disconnect();
  }, [page.id, loadRootRef]);
  useEffect(() => {
    if (!interactiveReady) return;
    let active = true;
    api.lesson(page.id).then((lesson) => active && setQaRecords(lesson.qaRecords)).catch(() => active && setQaRecords([]));
    return () => { active = false; };
  }, [interactiveReady, page.id]);
  useEffect(() => {
    if (!interactiveReady) return;
    let active = true;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      api.readweaveQuestions(page.id).then((result) => {
        if (active) { setNativeQuestions(result); setNativeQuestionsError(""); }
      }).catch(() => { if (active) setNativeQuestionsError("ReadWeave 问答记录暂时无法读取"); });
    };
    setNativeQuestions({ pageId: page.id, questions: [] });
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [interactiveReady, page.id]);
  return <section className="explanation-panel" aria-label="教师讲解">
    <header className="lesson-header"><div><span className="eyebrow">第 {page.pageNumber} 页</span><h2>{page.title}</h2></div><span className={`quality-badge ${generatedReady || page.quality.publishable ? "pass" : "hold"}`}>{generatedReady || page.quality.publishable ? "讲解已生成" : "讲解草稿"}</span></header>
    {sections.map((section, index) => <LessonSectionView key={section.id} section={section} number={String(index + 1).padStart(2, "0")}>{section.kind === "full_explanation" && pseudocode.length > 0 && <PseudoCodeWalkthrough lines={pseudocode} />}</LessonSectionView>)}
    <div ref={interactiveMarkerRef} className="lesson-interactive-marker" aria-hidden="true" />
    {interactiveReady && <>
      <SelfRetellingPanel release={release} page={page} />
      <article className="lesson-block random-questions"><SectionTitle number={String(sections.length + 1).padStart(2, "0")} english="ACTIVE RECALL" title="随机问题" /><RandomQuestions release={release} page={page} sessionId={sessionId} onEnterStudio={onEnterStudio} /></article>
      <article className="lesson-block qa-records"><SectionTitle number={String(sections.length + 2).padStart(2, "0")} english="QUESTION AND ANSWER" title="ReadWeave 问答" /><ReadWeaveQuestions records={nativeQuestions} legacy={qaRecords} error={nativeQuestionsError} /></article>
    </>}
  </section>;
}

function SectionTitle({ number, english, title }: { number: string; english: string; title: string }) {
  return <div className="lesson-section-title"><span>{number}</span><div><small>{sectionDescriptor(english)}</small><h3>{title}</h3></div></div>;
}

function sectionDescriptor(value: string): string {
  const normalized = value.toLocaleLowerCase().replaceAll("_", " ").trim();
  return ({
    "chapter bridge": "上一页如何接到这里",
    "learning objectives": "本页要学会",
    "main content": "读完后回收关键关系",
    "prior knowledge": "读懂本页前需要知道",
    "full explanation": "把原理讲透",
    misconceptions: "最容易混淆的地方",
    "question and answer": "学习过程中留下的问题",
    "active recall": "现在检验是否真的理解"
  } as Record<string, string>)[normalized] || "本节说明";
}

export function displayMisconception(value: string): string {
  return formatMisconception(value);
}

function LessonSectionView({ section, number, children }: { section?: LessonSection; number: string; children?: ReactNode }) {
  if (!section) return null;
  const visible = (text: string) => section.kind === "misconceptions" ? displayMisconception(text) : text;
  return <article className={`lesson-block section-${section.kind}`} aria-label={section.kind === "main_content" ? "本页要点" : undefined}><SectionTitle number={number} english={section.kind.replaceAll("_", " ")} title={section.title} />{section.items?.length ? <ul className="sentence-list">{section.items.map((item) => <li key={item.id}><Markdown>{visible(item.text)}</Markdown></li>)}</ul> : null}{section.markdown ? <Markdown nestedHeadings>{visible(section.markdown)}</Markdown> : null}{children}</article>;
}

function PseudoCodeWalkthrough({ lines }: { lines: PseudoCodeLine[] }) {
  return <section className="pseudocode-walkthrough"><h4>伪代码逐行讲解</h4><p>先看每一行直接做了什么，再展开查看它读取和修改了哪些状态</p><div className="line-list">{lines.map((line) => <details key={line.id} className="code-line" open={line.lineNumber <= 3}><summary data-action="pseudocode-toggle"><span className="line-number">{line.lineNumber}</span><div className="code-line-heading"><code>{line.code}</code><span className="code-line-label">这一行做什么</span><strong><Markdown inline>{teacherSummaryFor(line)}</Markdown></strong></div></summary><div className="code-line-body"><div className="code-line-state"><div><span>执行前</span><p><Markdown inline>{line.preState}</Markdown></p></div><span className="code-line-arrow" aria-hidden="true">→</span><div><span>执行后</span><p><Markdown inline>{line.postState}</Markdown></p></div></div><dl><div><dt>读取对象</dt><dd>{line.reads.length ? <Markdown inline>{line.reads.join("、")}</Markdown> : "不读取运行变量"}</dd></div><div><dt>修改对象</dt><dd>{line.writes.length ? <Markdown inline>{line.writes.join("、")}</Markdown> : "不修改运行变量"}</dd></div><div><dt>副作用</dt><dd>{line.sideEffects.length ? <Markdown inline>{line.sideEffects.join("；")}</Markdown> : "没有额外副作用"}</dd></div><div><dt>复杂度</dt><dd><Markdown inline>{line.complexityRelation}</Markdown></dd></div></dl></div></details>)}</div></section>;
}

function teacherSummaryFor(line: PseudoCodeLine): string {
  if (line.teacherSummary?.trim()) return line.teacherSummary.trim();
  const legacy: Record<string, string> = {
    "Algorithm KL": "这一行先声明要执行 Kernighan–Lin 算法，后面的代码会围绕一轮轮顶点交换来改进分区",
    "begin": "这一行进入算法主体，接下来按固定顺序执行初始化、候选交换和正式提交",
    "INITIALIZE();": "这一行先把分区、锁定表、交换记录表和每个顶点的 D 值准备好，后面的每一轮交换都要在这份初始状态上计算",
    "while (IMPROVE(table) = TRUE) do": "这一行检查上一轮是否真的带来了正收益，只有还有改进空间时才继续下一轮",
    "comment: repeat after improvement": "这一行是在提醒读者，外层循环会在上一轮有改进时重新开始，而不是只执行一次",
    "while (UNLOCK(A) = TRUE) do": "这一行检查 A 中是否还有没有用过的顶点，只要还有，就继续寻找下一对候选顶点",
    "comment: tentative exchanges": "这一行是在说明内层循环先记录试探交换，最后再从整张表中决定哪些交换真正保留",
    "for (each a in A) do": "这一行依次取出 A 中的顶点作为候选 a，让算法有机会比较每一个未锁定顶点",
    "if (a = unlocked) then": "这一行先排除本轮已经用过的 a，避免同一个顶点在同一轮中被重复交换",
    "for (each b in B) do": "这一行对当前的 a 依次检查 B 中的顶点 b，从所有跨分区组合里寻找更好的交换",
    "if (b = unlocked) then": "这一行先排除本轮已经用过的 b，只有未锁定的 b 才能参与收益比较",
    "if (D_max < D(a) + D(b)) then": "这一行把当前 a 和 b 的联合收益与目前记录的最大收益比较，发现更好组合才更新记录",
    "D_max = D(a) + D(b);": "这一行把当前候选对的收益保存为新的最大值，后面就能知道哪一对暂时最好",
    "a_max = a;": "这一行记住最佳候选对在 A 中的顶点，确保后面执行交换时不会丢失它",
    "b_max = b;": "这一行记住最佳候选对在 B 中的顶点，和 a_max 一起确定要试探的交换",
    "TENT-EXCHGE(a_max,b_max);": "这一行先试探性地交换当前最佳顶点对，用交换后的分区计算后续候选收益，但暂时还不作最终承诺",
    "LOCK(a_max,b_max);": "这一行把刚选过的两个顶点锁起来，保证它们在当前 pass 中不会再次参加候选交换",
    "LOG(table);": "这一行把本次交换的顶点和收益追加到记录表，后面会根据整张表选择最有利的交换前缀",
    "D_max = -infinity;": "这一行把最大收益清空为负无穷，为下一轮候选搜索重新寻找第一名做准备",
    "ACTUAL-EXCHGE(table);": "这一行从记录表中找出累计收益最大的正前缀，只正式执行这部分交换并撤销其余试探结果",
    "end.": "这一行结束算法，因为外层循环已经找不到正收益改进，当前分区就是本次搜索得到的结果"
  };
  return legacy[line.code] || `这一行执行“${line.semantic}”，并把得到的状态交给后续步骤继续处理`;
}

function ReadWeaveQuestions({ records, legacy, error }: { records: ReadWeavePageQuestions; legacy: PageQuestion[]; error: string }) {
  const historical = legacy.filter((item) => item.status === "active");
  return <div className="qa-history">
    <p className="empty-inline">在 ReadWeave 打开本页原图并直接提问，保存后的问题会自动出现在这里</p>
    {records.noteUrl && <p><a href={records.noteUrl} target="_blank" rel="noopener noreferrer">在 ReadWeave 打开本页与原图 ↗</a></p>}
    {error && <p className="qa-action-error" role="alert">{error}</p>}
    {records.questions.length ? records.questions.map((item) => <article key={item.objectId}><header><strong>{item.title}</strong></header>{item.excerpt && <p>{item.excerpt}</p>}</article>) : <p className="empty-inline">本页尚无已保存的 ReadWeave 问答</p>}
    {historical.length > 0 && <details><summary>查看此前在 Course OS 保存的 {historical.length} 条问答</summary>{historical.map((item) => <article key={item.id}><header><strong>{item.question}</strong></header><Markdown>{item.response}</Markdown></article>)}</details>}
  </div>;
}
function RandomQuestions({ release, page, sessionId, onEnterStudio }: { release: CourseRelease; page: PageLesson; sessionId?: string; onEnterStudio?: () => void }) {
  const [selection, setSelection] = useState<QuestionSelection>(); const [questions, setQuestions] = useState<QuestionBankItem[]>([]); const [answers, setAnswers] = useState<Record<string, string>>({}); const [feedback, setFeedback] = useState<Record<string, string>>({}); const [feedbackState, setFeedbackState] = useState<Record<string, "correct" | "incorrect" | "unverified" | "error">>({}); const [pendingQuestionIds, setPendingQuestionIds] = useState<Set<string>>(() => new Set()); const [loading, setLoading] = useState(Boolean(sessionId)); const [available, setAvailable] = useState(() => page.questionBank?.filter((item) => item.status === "approved").length ?? 0); const [draftCount, setDraftCount] = useState(() => page.questionBank?.filter((item) => item.status === "draft").length ?? 0);
  const [previewQuestions, setPreviewQuestions] = useState<QuestionBankItem[]>([]);
  const [attemptsState, setAttemptsState] = useState<"loading" | "ready" | "error">("loading");
  const [savedAnswers, setSavedAnswers] = useState<Record<string, string>>({});
  const pendingRef = useRef(new Set<string>()); const idempotencyKeysRef = useRef(new Map<string, string>()); const selectionRequestSerial = useRef(0); const previewRef = useRef<QuestionBankItem[]>([]);
  const preparePreview = (seed: string, serial: number) => {
    void previewQuestionBank(page.questionBank ?? [], seed).then((items) => {
      if (serial !== selectionRequestSerial.current) return;
      previewRef.current = items;
      setPreviewQuestions(items);
    }).catch(() => undefined);
  };
  const restoreSavedAnswers = (selected: QuestionSelection, selectedQuestions: QuestionBankItem[], serial: number) => {
    if (!sessionId) return;
    setAttemptsState("loading");
    void api.questionAttempts(page.id, sessionId, selected.id).then((attempts) => {
      if (serial !== selectionRequestSerial.current) return;
      const latest = new Map(attempts.sort((a, b) => a.attemptedAt.localeCompare(b.attemptedAt)).map((item) => [item.questionId, item]));
      setAnswers((current) => {
        const next = { ...current };
        for (const [id, attempt] of latest) if (!next[id]) next[id] = attempt.answer;
        return next;
      });
      setSavedAnswers((current) => {
        const next = { ...current };
        for (const [id, attempt] of latest) next[id] = attempt.answer;
        return next;
      });
      setFeedback((current) => {
        const next = { ...current };
        for (const item of selectedQuestions) if (latest.has(item.id) && !next[item.id]) next[item.id] = item.explanation;
        return next;
      });
      setFeedbackState((current) => {
        const next = { ...current };
        for (const [id, attempt] of latest) if (!next[id]) next[id] = attempt.correct === null ? "unverified" : attempt.correct ? "correct" : "incorrect";
        return next;
      });
      setAttemptsState("ready");
    }).catch(() => { if (serial === selectionRequestSerial.current) setAttemptsState("error"); });
  };
  useEffect(() => { setAvailable(page.questionBank?.filter((item) => item.status === "approved").length ?? 0); setDraftCount(page.questionBank?.filter((item) => item.status === "draft").length ?? 0); }, [page.id, page.questionBank]);
  useEffect(() => {
    if (!sessionId) return;
    const serial = ++selectionRequestSerial.current;
    const seed = `${sessionId}:${page.id}:${new Date().toISOString().slice(0, 10)}`;
    setLoading(true);
    setSelection(undefined);
    setQuestions([]);
    previewRef.current = [];
    setPreviewQuestions([]);
    setAttemptsState("loading");
    setSavedAnswers({});
    preparePreview(seed, serial);
    void api.selectQuestions(page.id, sessionId, seed).then((result) => {
      if (serial !== selectionRequestSerial.current) return;
      if (previewRef.current.length && !sameQuestionPreview(previewRef.current, result.questions)) {
        setAnswers({});
        setFeedback({ load: "题库在准备期间发生变化，请检查新题目后重新作答" });
      }
      setSelection(result.selection); setQuestions(result.questions); setAvailable(result.available); setDraftCount(result.draftCount ?? 0);
      restoreSavedAnswers(result.selection, result.questions, serial);
    }).catch((error) => { if (serial === selectionRequestSerial.current) { setPreviewQuestions([]); setFeedback({ load: error instanceof Error ? error.message : "随机问题加载失败" }); } })
      .finally(() => { if (serial === selectionRequestSerial.current) setLoading(false); });
    return () => { selectionRequestSerial.current += 1; };
  }, [page.id, sessionId]);
  const chooseAnotherPair = async () => {
    if (!sessionId || loading) return;
    const serial = ++selectionRequestSerial.current;
    const seed = crypto.randomUUID();
    setLoading(true);
    setSelection(undefined); setQuestions([]); setPreviewQuestions([]); previewRef.current = [];
    setAnswers({}); setFeedback({}); setFeedbackState({}); setSavedAnswers({}); setAttemptsState("loading");
    preparePreview(seed, serial);
    try {
      const result = await api.selectQuestions(page.id, sessionId, seed);
      if (serial !== selectionRequestSerial.current) return;
      if (previewRef.current.length && !sameQuestionPreview(previewRef.current, result.questions)) {
        setAnswers({});
        setFeedback({ load: "题库在准备期间发生变化，请检查新题目后重新作答" });
      }
      setSelection(result.selection); setQuestions(result.questions); setAvailable(result.available); setDraftCount(result.draftCount ?? 0);
      restoreSavedAnswers(result.selection, result.questions, serial);
    } catch (error) { if (serial === selectionRequestSerial.current) { setPreviewQuestions([]); setFeedback({ load: error instanceof Error ? error.message : "换题失败" }); } }
    finally { if (serial === selectionRequestSerial.current) setLoading(false); }
  };
  const submit = async (item: QuestionBankItem) => {
    const answer = answers[item.id]?.trim();
    if (!selection || !sessionId || !answer || attemptsState !== "ready" || pendingRef.current.has(item.id)) return;
    pendingRef.current.add(item.id);
    setPendingQuestionIds(new Set(pendingRef.current));
    setFeedback((current) => ({ ...current, [item.id]: "" }));
    const replayKey = `${selection.id}:${item.id}:${answer}`;
    const idempotencyKey = idempotencyKeysRef.current.get(replayKey) ?? crypto.randomUUID();
    idempotencyKeysRef.current.set(replayKey, idempotencyKey);
    try {
      const result = await api.questionAttempt({ selectionId: selection.id, sessionId, courseReleaseId: release.id, pageId: page.id, questionId: item.id, answer, usedHintLevel: 0 }, idempotencyKey);
      idempotencyKeysRef.current.delete(replayKey);
      setSavedAnswers((current) => ({ ...current, [item.id]: result.attempt.answer }));
      setFeedbackState((current) => ({ ...current, [item.id]: result.evaluationState }));
      setFeedback((current) => ({ ...current, [item.id]: result.feedback }));
    } catch (error) {
      setFeedbackState((current) => ({ ...current, [item.id]: "error" }));
      setFeedback((current) => ({ ...current, [item.id]: error instanceof Error ? error.message : "作答保存失败" }));
    } finally {
      pendingRef.current.delete(item.id);
      setPendingQuestionIds(new Set(pendingRef.current));
    }
  };
  const bankNotice = available < 4 || draftCount > 0;
  if (!sessionId) return <><QuestionBankStatus available={available} draftCount={draftCount} onEnterStudio={onEnterStudio} /> <p className="empty-inline">学习会话建立后会抽取 1道理解题和 1道选择题</p></>;
  if (loading && !previewQuestions.length) return <p className="empty-inline" role="status">ReadWeave 正在读取本页题库并保存选题，完成后会自动显示两道可作答的问题</p>;
  if (!loading && !questions.length) return <><QuestionBankStatus available={available} draftCount={draftCount} onEnterStudio={onEnterStudio} /><p className="empty-inline">{feedback.load || "本页题库尚未达到发布要求，请从制作模式补齐题目"}</p></>;
  const visibleQuestions = loading ? previewQuestions : questions;
  return <>{loading && <p className="empty-inline" role="status">本页两道题已可先填写；ReadWeave 正在保存选题，保存并核对旧作答后即可提交</p>}{!loading && attemptsState === "loading" && <p className="empty-inline" role="status">正在恢复本次已保存的作答记录</p>}{!loading && attemptsState === "error" && <p className="empty-inline" role="alert">作答记录暂时无法读取，提交已暂停 <button type="button" className="quiet-button" onClick={() => selection && restoreSavedAnswers(selection, questions, selectionRequestSerial.current)}>重试读取</button></p>}{feedback.load && <p className="empty-inline" role="status">{feedback.load}</p>}{bankNotice && <QuestionBankStatus available={available} draftCount={draftCount} onEnterStudio={onEnterStudio} />}<div className="question-stack">{visibleQuestions.map((item, index) => { const pending = pendingQuestionIds.has(item.id); const state = feedbackState[item.id]; return <section key={item.id} data-question-id={item.id} className="question-card"><header><span>{String(index + 1).padStart(2, "0")}</span><strong>{item.kind === "comprehension" ? "理解题" : "选择题"}</strong></header><div className="question-prompt"><Markdown>{item.prompt}</Markdown></div>{item.options?.length ? <div className="choice-list">{item.options.map((option) => <label key={option}><input type="radio" name={item.id} value={option} checked={answers[item.id] === option} disabled={pending} onChange={(event) => setAnswers((current) => ({ ...current, [item.id]: event.target.value }))} /><span className="choice-copy"><Markdown inline>{option}</Markdown></span></label>)}</div> : <textarea value={answers[item.id] || ""} disabled={pending} onChange={(event) => setAnswers((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="不用照抄原文，先用自己的话回答" />}<button className="primary" disabled={!selection || attemptsState !== "ready" || !answers[item.id]?.trim() || pending || answers[item.id]?.trim() === savedAnswers[item.id]} aria-busy={pending} title={!selection ? "正在保存本次选题" : attemptsState === "loading" ? "正在核对已有作答" : attemptsState === "error" ? "请先重试读取作答" : !answers[item.id]?.trim() ? "请先作答" : pending ? "正在保存本题作答" : answers[item.id]?.trim() === savedAnswers[item.id] ? "本题作答已保存" : undefined} onClick={() => void submit(item)}>{pending ? "正在保存" : !selection ? "等待选题保存" : attemptsState !== "ready" ? "等待作答记录" : answers[item.id]?.trim() === savedAnswers[item.id] ? "已保存" : "提交并保存记录"}</button>{pending && <p className="answer-progress" role="status">作答正在保存，请稍候</p>}{feedback[item.id] && <div className={`answer answer-${state || "unverified"}`} aria-live="polite"><strong>{state === "correct" ? "回答正确：记录已保存" : state === "incorrect" ? "还需要复习：答案没有满足当前学习目标" : state === "error" ? "保存失败：答案仍保留在输入框" : "作答已保存：这道理解题暂不能自动判定"}</strong><div><strong>{state === "error" ? "请检查后重试" : state === "unverified" ? "参考思路是" : "正确思路是"}：</strong><Markdown children={feedback[item.id]!} /></div></div>}</section>; })}</div>{!loading && <button className="quiet-button" data-action="questions-another-pair" onClick={() => void chooseAnotherPair()}>换一组题</button>}</>;
}

function QuestionBankStatus({ available, draftCount, onEnterStudio }: { available: number; draftCount: number; onEnterStudio?: () => void }) {
  if (available >= 4 && draftCount === 0) return null;
  return <div className="question-bank-status"><div><strong>题库尚未就绪</strong><span>当前有 {available} 道可用题目，另有 {draftCount} 道草稿题；补齐 4 道可用题目后即可练习</span></div>{onEnterStudio && <button className="quiet-button" data-action="questions-open-studio" onClick={onEnterStudio}>去制作模式补齐</button>}</div>;
}

function normalizeSections(page: PageLesson): LessonSection[] {
  const anchorIds = page.anchors.map((item) => item.id); const atomIds = page.atoms.map((item) => item.id);
  const sectionTitles: Array<[LessonSection["kind"], string]> = [["chapter_bridge", "承上启下"], ["prior_knowledge", "先验知识"], ["learning_objectives", "学完能做什么"], ["full_explanation", "完整讲解"], ["main_content", "主要内容"], ["misconceptions", "易错点"]];
  if (page.lessonSections?.length) {
    const byKind = new Map(page.lessonSections.map((section) => [section.kind, section]));
    const main = byKind.get("main_content")?.markdown;
    return sectionTitles.map(([kind, title]) => {
      const section = byKind.get(kind);
      if (kind === "chapter_bridge" && !section) return undefined;
      if (!section) return { id: `${page.id}:section:${kind}`, kind, title, markdown: "本节内容尚未生成，请进入制作模式补齐后再发布", sourceAnchorIds: anchorIds, atomIds };
      if (kind === "main_content" && section.markdown) return { ...section, markdown: summaryMarkdown(section.markdown) };
      if (page.lessonFlowVersion === 2 || kind !== "full_explanation" || !section.markdown || !main) return section;
      const distinctExplanation = removeRepeatedOpening(main, section.markdown);
      return distinctExplanation ? { ...section, markdown: distinctExplanation } : section;
    }).filter((section): section is LessonSection => Boolean(section));
  }
  const find = (...kinds: string[]) => page.blocks.filter((item) => kinds.includes(item.kind)).map((item) => item.markdown).join("\n\n");
  const items = (prefix: string, text: string) => splitOutsideMath(text).map((textValue, index) => ({ id: `${page.id}:${prefix}:${index + 1}`, text: textValue, sourceAnchorIds: anchorIds }));
  const main = page.blocks.find((item) => item.kind === "core")?.markdown || find("core");
  return [{ id: `${page.id}:section:prior`, kind: "prior_knowledge", title: "先验知识", items: items("prior", find("prerequisite")), sourceAnchorIds: anchorIds, atomIds }, { id: `${page.id}:section:objective`, kind: "learning_objectives", title: "学完能做什么", items: items("objective", find("objective")), sourceAnchorIds: anchorIds, atomIds }, { id: `${page.id}:section:full`, kind: "full_explanation", title: "完整讲解", markdown: removeRepeatedOpening(main, find("core", "example", "deep_dive", "check")) || "本节内容尚未生成，请进入制作模式补齐后再发布", sourceAnchorIds: anchorIds, atomIds }, { id: `${page.id}:section:main`, kind: "main_content", title: "主要内容", markdown: summaryMarkdown(main) || "本节内容尚未生成，请进入制作模式补齐后再发布", sourceAnchorIds: anchorIds, atomIds }, { id: `${page.id}:section:misconceptions`, kind: "misconceptions", title: "易错点", items: items("misconception", find("misconception")), sourceAnchorIds: anchorIds, atomIds }];
}

export function summaryMarkdown(markdown: string): string {
  if (!/^\s*[-*+]\s+/m.test(markdown)) return markdown;
  return markdown.replace(/^\s*#{1,6}\s+[^\n]+\n+/u, "").trim();
}

/**
 * Older releases stored the short main-content list again at the beginning
 * of the full explanation. Keep the persisted data intact, but do not make a
 * learner read the same opening twice.
 */
function removeRepeatedOpening(main: string, full: string): string {
  const mainText = main.trim();
  const fullText = full.trim();
  if (mainText.length < 24 || !fullText.startsWith(mainText)) return fullText;
  const remainder = fullText.slice(mainText.length).trim();
  return remainder || fullText;
}

function splitOutsideMath(source: string): string[] {
  const text = source.replace(/^[-*]\s*/gm, "");
  const result: string[] = [];
  let current = "";
  let delimiter: "$" | "$$" | "\\(" | "\\[" | undefined;
  const push = () => {
    const value = current.trim().replace(/[，；：,.]$/, "").trim();
    if (value) result.push(value);
    current = "";
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    const escaped = index > 0 && text[index - 1] === "\\";
    if (delimiter) {
      current += character;
      if (delimiter === "$$" && text.startsWith("$$", index) && !escaped) {
        current += "$";
        index += 1;
        delimiter = undefined;
      } else if (delimiter === "$" && character === "$" && !escaped) {
        delimiter = undefined;
      } else if (delimiter === "\\(" && text.startsWith("\\)", index)) {
        current += ")";
        index += 1;
        delimiter = undefined;
      } else if (delimiter === "\\[" && text.startsWith("\\]", index)) {
        current += "]";
        index += 1;
        delimiter = undefined;
      }
      continue;
    }
    if (text.startsWith("$$", index) && !escaped) { current += "$$"; index += 1; delimiter = "$$"; continue; }
    if (text.startsWith("\\(", index) && !escaped) { current += "\\("; index += 1; delimiter = "\\("; continue; }
    if (text.startsWith("\\[", index) && !escaped) { current += "\\["; index += 1; delimiter = "\\["; continue; }
    if (character === "$" && !escaped && text.indexOf("$", index + 1) >= 0) { current += character; delimiter = "$"; continue; }
    if (character === "\n" || character === "。" || character === "！" || character === "？" || character === "!" || character === "?") { push(); continue; }
    current += character;
  }
  push();
  return result.length ? result.slice(0, 8) : ["本页没有单独列出的项目，需要结合完整讲解继续核对"];
}
