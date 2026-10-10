import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CourseRelease, LessonSection, PageLesson, PageQuestion, PseudoCodeLine, QuestionBankItem, QuestionSelection, ReadWeavePageQuestions } from "@course-os/contracts";
import { evaluateQuestionAnswer } from "@course-os/contracts";
import { formatMisconception, parsePriorKnowledgeDefinitions } from "@course-os/quality";
import { api } from "./api.js";
import { Markdown } from "./Markdown.js";
import { QuestionBatchControls, QuestionChoiceList } from "./QuestionInputs.js";
import { SelfRetellingPanel } from "./SelfRetellingPanel.js";
import { createQuestionBatchState, isQuestionAnswerSaved, previewQuestionBank, questionAnswerKey, questionKindLabel, readQuestionBatchState, sameQuestionPreview, uniquePracticeQuestions, writeQuestionBatchState, type QuestionBatchSize, type QuestionBatchState } from "./question-preview.js";

export function ExplanationPanel({ release, page, sessionId, onEnterStudio, loadRootRef, generatedReady, unpublishedDraftRevision }: { release: CourseRelease; page: PageLesson; sessionId?: string; onEnterStudio?: () => void; loadRootRef?: { current: HTMLElement | null }; generatedReady?: boolean; unpublishedDraftRevision?: number }) {
  const sections = useMemo(() => normalizeSections(page), [page]);
  const bodyReadable = page.lessonSections?.length
    ? page.lessonSections.some(section => section.kind === "full_explanation" && section.markdown?.trim())
    : page.blocks.some(block => block.kind === "deep_dive" && block.markdown.trim());
  const summaryReady = page.lessonSections?.length
    ? page.lessonSections.some(section => section.kind === "main_content" && section.markdown?.trim())
    : page.blocks.some(block => block.kind === "core" && block.markdown.trim());
  const bridgeReady = page.lessonSections?.some(section => section.kind === "chapter_bridge" && section.markdown?.trim());
  const pseudocode = page.atoms.filter((atom): atom is PseudoCodeLine => atom.kind === "pseudocode_line");
  const [interactiveReady, setInteractiveReady] = useState(false);
  const interactiveMarkerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sessionId) return;
    // This page is already open. Reuse the same request when the learner reaches its questions.
    void api.selectQuestions(page.id, sessionId).catch(() => undefined);
  }, [page.id, page.questionBank, sessionId]);
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
  return <section className="explanation-panel" aria-label="教师讲解">
    <header className="lesson-header"><div><span className="eyebrow">第 {page.pageNumber} 页 · {release.lifecycle === "draft_source" ? "当前预览草稿" : release.lifecycle === "published" ? `已发布 v${release.version}${unpublishedDraftRevision ? " · 有未发布修改（当前预览草稿）" : ""}` : unpublishedDraftRevision ? "当前预览草稿" : "课程材料"}</span><h2>{page.teachingTitle ?? page.title}</h2></div><span className={`quality-badge ${bodyReadable && summaryReady && bridgeReady ? "pass" : "hold"}`}>{!bodyReadable ? "讲解尚未生成" : !summaryReady ? "正文可读 · 主要内容待补齐" : bridgeReady ? "教学内容可读" : "正文可读 · 承接待补齐"}</span></header>
    {sections.map((section, index) => <LessonSectionView key={section.id} section={section} number={String(index + 1).padStart(2, "0")}>{section.kind === "full_explanation" && pseudocode.length > 0 && <PseudoCodeWalkthrough lines={pseudocode} />}</LessonSectionView>)}
    <div ref={interactiveMarkerRef} className="lesson-interactive-marker" aria-hidden="true" />
    {interactiveReady && <>
      <article className="lesson-block random-questions"><SectionTitle number="07" english="ACTIVE RECALL" title="问答" /><RandomQuestions release={release} page={page} sessionId={sessionId} onEnterStudio={onEnterStudio} /><SelfRetellingPanel release={release} page={page} /><QuestionHistory key={page.id} pageId={page.id} /></article>
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
  return formatMisconception(normalizeMalformedBoldLabelClosers(value));
}

export function displayPriorKnowledge(value: string): string {
  return value.replace(/^([ \t]*)\*\*([^*\r\n]{1,100}?[：:])[ \t]*\*\*/u, "$1$2");
}

function normalizeMalformedBoldLabelClosers(value: string): string {
  const parts = value.split(/(\r?\n)/u);
  let output = "";
  let plain = "";
  let fence: { marker: "`" | "~"; length: number } | undefined;
  const flushPlain = () => {
    output += normalizeOutsideInlineCode(plain);
    plain = "";
  };

  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]!;
    const newline = parts[index + 1] ?? "";
    if (fence) {
      output += line + newline;
      const closing = /^[ \t]{0,3}(`+|~+)[ \t]*$/u.exec(line)?.[1];
      if (closing?.[0] === fence.marker && closing.length >= fence.length) fence = undefined;
      continue;
    }
    const opening = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (opening) {
      flushPlain();
      output += line + newline;
      fence = { marker: opening[0] as "`" | "~", length: opening.length };
      continue;
    }
    plain += line + newline;
  }
  flushPlain();
  return output;
}

function normalizeOutsideInlineCode(value: string): string {
  let output = "";
  let plainStart = 0;
  let index = 0;
  while (index < value.length) {
    if (value[index] !== "`" || isEscapedMarkdownDelimiter(value, index)) { index += 1; continue; }
    let openingEnd = index + 1;
    while (value[openingEnd] === "`") openingEnd += 1;
    const length = openingEnd - index;
    let closingStart = openingEnd;
    let closingEnd = -1;
    while (closingStart < value.length) {
      const next = value.indexOf("`", closingStart);
      if (next < 0) break;
      let runEnd = next + 1;
      while (value[runEnd] === "`") runEnd += 1;
      if (runEnd - next === length && !isEscapedMarkdownDelimiter(value, next)) {
        closingStart = next;
        closingEnd = runEnd;
        break;
      }
      closingStart = runEnd;
    }
    if (closingEnd < 0) { index = openingEnd; continue; }
    output += normalizeLabelText(value.slice(plainStart, index)) + value.slice(index, closingEnd);
    plainStart = closingEnd;
    index = closingEnd;
  }
  return output + normalizeLabelText(value.slice(plainStart));
}

function isEscapedMarkdownDelimiter(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function normalizeLabelText(value: string): string {
  const repairedLegacyClosers = value.replace(/(^|[；;][ \t]*)([ \t]*(?:[-*+][ \t]+)?\*\*[^*\r\n]{1,100}?[：:])[ \t]+\*\*/gmu, (match, preceding: string, label: string, offset: number, source: string) => {
    const next = source[offset + match.length];
    const separator = next && /[\p{L}\p{N}]/u.test(next) ? " " : "";
    return `${preceding}${label}**${separator}`;
  });
  return repairedLegacyClosers.replace(/(^|[；;][ \t]*)([ \t]*(?:[-*+][ \t]+)?\*\*[^*\r\n]{1,100}?[：:])\*\*(?=[\p{L}\p{N}])/gmu, "$1$2** ");
}

function LessonSectionView({ section, number, children }: { section?: LessonSection; number: string; children?: ReactNode }) {
  if (!section) return null;
  if (section.kind === "prior_knowledge") {
    const definitions = parsePriorKnowledgeDefinitions([...(section.items ?? []).map(item => item.text), ...(section.markdown ? [section.markdown] : [])]);
    return <article className="lesson-block section-prior_knowledge" data-lesson-section={section.kind}><SectionTitle number={number} english="prior knowledge" title={section.title} /><ul className="sentence-list">{definitions.map((text, index) => <li key={index}><Markdown>{displayPriorKnowledge(text)}</Markdown></li>)}</ul>{children}</article>;
  }
  const visibleItem = (text: string) => section.kind === "misconceptions" ? displayMisconception(text)
      : section.kind === "learning_objectives" || section.kind === "main_content" || section.kind === "full_explanation" ? normalizeMalformedBoldLabelClosers(text) : text;
  const visibleMarkdown = (text: string) => section.kind === "misconceptions" ? displayMisconception(text)
    : section.kind === "learning_objectives" || section.kind === "main_content" || section.kind === "full_explanation" ? normalizeMalformedBoldLabelClosers(text) : text;
  return <article className={`lesson-block section-${section.kind}`} data-lesson-section={section.kind} aria-label={section.kind === "main_content" ? "本页要点" : undefined}><SectionTitle number={number} english={section.kind.replaceAll("_", " ")} title={section.title} />{section.items?.length ? <ul className="sentence-list">{section.items.map((item) => <li key={item.id}><Markdown>{visibleItem(item.text)}</Markdown></li>)}</ul> : null}{section.markdown ? <Markdown nestedHeadings>{visibleMarkdown(section.markdown)}</Markdown> : null}{children}</article>;
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

export function QuestionHistory({ pageId }: { pageId: string }) {
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<ReadWeavePageQuestions>({ pageId, questions: [] });
  const [legacy, setLegacy] = useState<PageQuestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let running = false;
    const refresh = async () => {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      setLoading(true);
      const [nativeResult, legacyResult] = await Promise.allSettled([
        api.readweaveQuestions(pageId, { signal: controller.signal }),
        api.pageQuestions(pageId, { signal: controller.signal })
      ]);
      if (controller.signal.aborted) return;
      if (nativeResult.status === "fulfilled") setRecords(nativeResult.value);
      if (legacyResult.status === "fulfilled") setLegacy(legacyResult.value);
      setError([
        nativeResult.status === "rejected" ? "ReadWeave 问答记录暂时无法读取" : "",
        legacyResult.status === "rejected" ? "Course OS 历史问答暂时无法读取" : ""
      ].filter(Boolean).join("；"));
      setLoading(false);
      running = false;
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [open, pageId, retry]);
  return <details className="qa-records" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>学习问答记录</summary>
    {open && <>
      {loading && <p role="status">正在读取已保存的问答记录…</p>}
      <ReadWeaveQuestions records={records} legacy={legacy} error={error} loading={loading} />
      {error && <button className="quiet-button" type="button" disabled={loading} onClick={() => setRetry(value => value + 1)}>重试读取问答记录</button>}
    </>}
  </details>;
}

function ReadWeaveQuestions({ records, legacy, error, loading }: { records: ReadWeavePageQuestions; legacy: PageQuestion[]; error: string; loading: boolean }) {
  const historical = legacy.filter((item) => item.status === "active");
  return <div className="qa-history">
    <p className="empty-inline">在 ReadWeave 打开本页原图并直接提问，保存后的问题会自动出现在这里</p>
    {records.noteUrl && <p><a href={records.noteUrl} target="_blank" rel="noopener noreferrer">在 ReadWeave 打开本页与原图 ↗</a></p>}
    {error && <p className="qa-action-error" role="alert">{error}</p>}
    {records.questions.length ? records.questions.map((item) => <article key={item.objectId}><header><strong>{item.title}</strong></header>{item.excerpt && <p>{item.excerpt}</p>}</article>) : !loading && !error ? <p className="empty-inline">本页尚无已保存的 ReadWeave 问答</p> : null}
    {historical.length > 0 && <details><summary>查看此前在 Course OS 保存的 {historical.length} 条问答</summary>{historical.map((item) => <article key={item.id}><header><strong>{item.question}</strong></header><Markdown>{item.response}</Markdown></article>)}</details>}
  </div>;
}
function RandomQuestions({ release, page, sessionId, onEnterStudio }: { release: CourseRelease; page: PageLesson; sessionId?: string; onEnterStudio?: () => void }) {
  const [batchState, setBatchState] = useState<QuestionBatchState>(() => sessionId ? readQuestionBatchState(sessionId, page.id) : createQuestionBatchState("", page.id));
  const batchStateRef = useRef(batchState);
  const [selection, setSelection] = useState<QuestionSelection>();
  const [questions, setQuestions] = useState<QuestionBankItem[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [feedbackState, setFeedbackState] = useState<Record<string, "correct" | "incorrect" | "unverified" | "error">>({});
  const [pendingQuestionKeys, setPendingQuestionKeys] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(Boolean(sessionId));
  const [available, setAvailable] = useState(() => uniquePracticeQuestions(page.questionBank ?? []).length);
  const [draftCount, setDraftCount] = useState(() => page.questionBank?.filter((item) => item && typeof item === "object" && item.status === "draft").length ?? 0);
  const [previewQuestions, setPreviewQuestions] = useState<QuestionBankItem[]>([]);
  const [attemptsState, setAttemptsState] = useState<"loading" | "ready" | "error">("loading");
  const [savedAnswers, setSavedAnswers] = useState<Record<string, string>>({});
  const pendingRef = useRef(new Set<string>());
  const idempotencyKeysRef = useRef(new Map<string, string>());
  const selectionRequestSerial = useRef(0);
  const previewRef = useRef<QuestionBankItem[]>([]);

  const saveBatchState = (state: QuestionBatchState) => {
    batchStateRef.current = state;
    setBatchState(state);
    if (sessionId) writeQuestionBatchState(sessionId, page.id, state);
  };

  const preparePreview = (state: QuestionBatchState, serial: number) => {
    void previewQuestionBank(page.questionBank ?? [], state.activeSeed, state.activeCount, state.activeExcludedQuestionIds).then((items) => {
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
      const selectedById = new Map(selectedQuestions.map((item) => [item.id, item]));
      const latest = new Map<string, (typeof attempts)[number]>();
      for (const attempt of attempts.sort((a, b) => a.attemptedAt.localeCompare(b.attemptedAt))) {
        const item = selectedById.get(attempt.questionId);
        if (!item || (attempt.questionVersion !== undefined && attempt.questionVersion !== item.version)) continue;
        latest.set(questionAnswerKey(selected.id, item.id, item.version), attempt);
      }
      setAnswers((current) => {
        const next = { ...current };
        for (const [key, attempt] of latest) if (!next[key]) next[key] = attempt.answer;
        return next;
      });
      setSavedAnswers((current) => {
        const next = { ...current };
        for (const [key, attempt] of latest) next[key] = attempt.answer;
        return next;
      });
      setFeedback((current) => {
        const next = { ...current };
        for (const [key] of latest) {
          const item = selectedQuestions.find((question) => questionAnswerKey(selected.id, question.id, question.version) === key);
          if (item && !next[key]) next[key] = item.explanation;
        }
        return next;
      });
      setFeedbackState((current) => {
        const next = { ...current };
        for (const [key, attempt] of latest) if (!next[key]) next[key] = attempt.correct === null ? "unverified" : attempt.correct ? "correct" : "incorrect";
        return next;
      });
      setAttemptsState("ready");
    }).catch(() => { if (serial === selectionRequestSerial.current) setAttemptsState("error"); });
  };

  const loadSelection = (state: QuestionBatchState, serial: number, allowRepeat = false) => {
    if (!sessionId) return;
    setLoading(true);
    setSelection(undefined);
    setQuestions([]);
    previewRef.current = [];
    setPreviewQuestions([]);
    setAttemptsState("loading");
    setFeedback((current) => ({ ...current, load: "" }));
    preparePreview(state, serial);
    void api.selectQuestions(page.id, sessionId, state.activeSeed, state.activeCount, state.activeExcludedQuestionIds, allowRepeat).then((result) => {
      if (serial !== selectionRequestSerial.current) return;
      const previewMatched = previewRef.current.length > 0 && sameQuestionPreview(previewRef.current, result.questions);
      setAnswers((current) => {
        const next = { ...current };
        for (const item of result.questions) {
          const previewKey = questionAnswerKey(state.activeSeed, item.id, item.version);
          const activeKey = questionAnswerKey(result.selection.id, item.id, item.version);
          if (next[previewKey] && !next[activeKey]) next[activeKey] = next[previewKey];
        }
        return next;
      });
      saveBatchState({ ...state, usedQuestionIds: [...new Set([...state.usedQuestionIds, ...result.selection.questionIds])] });
      setSelection(result.selection);
      setQuestions(result.questions);
      setAvailable(result.available);
      setDraftCount(result.draftCount ?? 0);
      setFeedback((current) => ({ ...current, load: previewMatched || !previewRef.current.length ? "" : "本组已按首次保存的题目版本恢复。" }));
      setLoading(false);
      restoreSavedAnswers(result.selection, result.questions, serial);
    }).catch((error) => {
      if (serial === selectionRequestSerial.current) {
        setFeedback((current) => ({ ...current, load: error instanceof Error ? error.message : "题库暂时无法读取" }));
        setLoading(false);
      }
    });
  };

  useEffect(() => {
    setAvailable(uniquePracticeQuestions(page.questionBank ?? []).length);
    setDraftCount(page.questionBank?.filter((item) => item && typeof item === "object" && item.status === "draft").length ?? 0);
  }, [page.id, page.questionBank]);

  useEffect(() => {
    if (!sessionId) { setLoading(false); return; }
    const state = readQuestionBatchState(sessionId, page.id);
    batchStateRef.current = state;
    setBatchState(state);
    const serial = ++selectionRequestSerial.current;
    loadSelection(state, serial);
    return () => { if (selectionRequestSerial.current === serial) selectionRequestSerial.current++; };
  }, [page.id, page.questionBank, sessionId]);

  const chooseAnotherPair = (replayExhaustedBank = false) => {
    if (!sessionId) return;
    const current = batchStateRef.current;
    const nextIndex = current.batchIndex + 1;
    const nextState: QuestionBatchState = {
      ...current,
      batchIndex: nextIndex,
      activeSeed: sessionId + ":" + page.id + ":batch:" + nextIndex,
      activeCount: current.requestedCount,
      usedQuestionIds: replayExhaustedBank ? [] : current.usedQuestionIds,
      activeExcludedQuestionIds: replayExhaustedBank ? [] : current.usedQuestionIds
    };
    saveBatchState(nextState);
    loadSelection(nextState, ++selectionRequestSerial.current, replayExhaustedBank);
  };

  const changeRequestedCount = (value: string) => {
    const count = Number(value) as QuestionBatchSize;
    if (![2, 3, 5].includes(count)) return;
    saveBatchState({ ...batchStateRef.current, requestedCount: count });
  };

  const submit = async (item: QuestionBankItem) => {
    if (!sessionId || !selection || attemptsState !== "ready") return;
    const answerKey = questionAnswerKey(selection.id, item.id, item.version);
    const answer = answers[answerKey]?.trim();
    if (!answer || pendingRef.current.has(answerKey)) return;
    pendingRef.current.add(answerKey);
    setPendingQuestionKeys(new Set(pendingRef.current));
    const verdict = evaluateQuestionAnswer(item, answer);
    setFeedbackState((current) => ({ ...current, [answerKey]: verdict === null ? "unverified" : verdict ? "correct" : "incorrect" }));
    setFeedback((current) => ({ ...current, [answerKey]: item.explanation }));
    const replayKey = answerKey + ":" + answer;
    const idempotencyKey = idempotencyKeysRef.current.get(replayKey) ?? crypto.randomUUID();
    idempotencyKeysRef.current.set(replayKey, idempotencyKey);
    try {
      const result = await api.questionAttempt({ selectionId: selection.id, sessionId, courseReleaseId: release.id, pageId: page.id, questionId: item.id, questionVersion: item.version, answer, usedHintLevel: 0 }, idempotencyKey);
      idempotencyKeysRef.current.delete(replayKey);
      setSavedAnswers((current) => ({ ...current, [answerKey]: result.attempt.answer }));
      setFeedbackState((current) => ({ ...current, [answerKey]: result.evaluationState }));
      setFeedback((current) => ({ ...current, [answerKey]: result.feedback }));
    } catch (error) {
      setFeedbackState((current) => ({ ...current, [answerKey]: "error" }));
      setFeedback((current) => ({ ...current, [answerKey]: error instanceof Error ? error.message : "作答保存失败" }));
    } finally {
      pendingRef.current.delete(answerKey);
      setPendingQuestionKeys(new Set(pendingRef.current));
    }
  };

  const bankNotice = draftCount > 0;
  if (!sessionId) return <><QuestionBankStatus available={available} draftCount={draftCount} onEnterStudio={onEnterStudio} /><p className="empty-inline">{available ? "建立学习会话后即可练习本页 " + available + " 道合格题目" : "本页目前没有符合条件的可练习题目"}</p></>;
  if (loading && !previewQuestions.length) return <p className="empty-inline" role="status">正在恢复本组题目并核对已保存的作答</p>;
  if (!loading && !questions.length) return <><QuestionBankStatus available={available} draftCount={draftCount} onEnterStudio={onEnterStudio} /><p className="empty-inline">{feedback.load || (available > 0 ? "本页合格题目都已练过；可以明确选择从头再练。" : "本页目前没有符合条件的可练习题目。")}</p>{available > 0 && !feedback.load && <button type="button" className="quiet-button" data-action="questions-restart" onClick={() => chooseAnotherPair(true)}>从头再练</button>}</>;
  const visibleQuestions = loading ? previewQuestions : questions;
  return <>{loading && <p className="empty-inline" role="status">正在保存本组 {batchState.activeCount} 道题；可以先填写答案，保存完成后即可提交</p>}{!loading && attemptsState === "loading" && <p className="empty-inline" role="status">正在恢复本次已保存的作答记录</p>}{!loading && attemptsState === "error" && <p className="empty-inline" role="alert">作答记录暂时无法读取，提交已暂停 <button type="button" className="quiet-button" onClick={() => selection && restoreSavedAnswers(selection, questions, selectionRequestSerial.current)}>重试读取</button></p>}{feedback.load && <p className="empty-inline" role="status">{feedback.load}</p>}{bankNotice && <QuestionBankStatus available={available} draftCount={draftCount} onEnterStudio={onEnterStudio} />}<QuestionBatchControls requestedCount={batchState.requestedCount} actualCount={visibleQuestions.length} pending={loading} onChange={changeRequestedCount} /><div className="question-stack">{visibleQuestions.map((item, index) => { const answerKey = questionAnswerKey(selection?.id ?? batchState.activeSeed, item.id, item.version); const pending = pendingQuestionKeys.has(answerKey); const state = feedbackState[answerKey]; const isChoice = item.kind === "multiple_choice"; return <section key={item.id + ":" + item.version} data-question-id={item.id} data-question-version={item.version} className="question-card"><header><span>{String(index + 1).padStart(2, "0")}</span><strong>{questionKindLabel(item.kind)}</strong></header><div className="question-prompt" id={`question-prompt-${answerKey}`}><Markdown>{item.prompt}</Markdown></div>{isChoice ? <QuestionChoiceList labelledBy={`question-prompt-${answerKey}`} name={answerKey} options={item.options!} answer={answers[answerKey]} disabled={pending} onChange={value => setAnswers(current => ({ ...current, [answerKey]: value }))} /> : <textarea value={answers[answerKey] || ""} disabled={pending} onChange={(event) => setAnswers((current) => ({ ...current, [answerKey]: event.target.value }))} placeholder="不用照抄原文，先用自己的话回答" />}<button className="primary" disabled={!selection || attemptsState !== "ready" || !answers[answerKey]?.trim() || pending || isQuestionAnswerSaved(answers[answerKey], savedAnswers[answerKey])} aria-busy={pending} title={!selection ? "正在保存本次选题" : attemptsState === "loading" ? "正在核对已有作答" : attemptsState === "error" ? "请先重试读取作答" : !answers[answerKey]?.trim() ? "请先作答" : pending ? "正在保存本题作答" : isQuestionAnswerSaved(answers[answerKey], savedAnswers[answerKey]) ? "本题作答已保存" : undefined} onClick={() => void submit(item)}>{pending ? "正在保存" : !selection ? "等待选题保存" : attemptsState !== "ready" ? "等待作答记录" : isQuestionAnswerSaved(answers[answerKey], savedAnswers[answerKey]) ? "已保存" : "提交并保存记录"}</button>{pending && <p className="answer-progress" role="status">作答正在保存，请稍候</p>}{state && <QuestionAnswerFeedback state={state} feedback={feedback[answerKey] ?? ""} saving={pending} />}</section>; })}</div>{!loading && <button type="button" className="quiet-button" data-action="questions-another-pair" onClick={() => chooseAnotherPair()}>换一组题</button>}</>;
}
export function QuestionAnswerFeedback({ state, feedback, saving = false }: { state: "correct" | "incorrect" | "unverified" | "error"; feedback: string; saving?: boolean }) {
  const symbol = state === "correct" ? "✅" : state === "incorrect" ? "❌" : undefined;
  const title = saving ? state === "correct" ? "判题结果：回答正确；记录正在保存"
    : state === "incorrect" ? "判题结果：回答未完全正确；记录正在保存"
      : "尚未判定对错；记录正在保存"
    : state === "correct" ? "回答正确：记录已保存"
    : state === "incorrect" ? "回答未完全正确：记录已保存，还需要复习"
      : state === "error" ? "保存失败：答案仍保留在输入框"
        : "作答已保存：尚未判定对错";
  return <div className={"answer answer-" + state} aria-live="polite"><strong>{symbol && <><span aria-hidden="true">{symbol}</span>{" "}</>}{title}</strong>{feedback && <div><strong>{state === "error" ? "请检查后重试" : state === "unverified" ? "参考思路是" : "正确思路是"}：</strong><Markdown>{feedback}</Markdown></div>}</div>;
}

export function QuestionBankStatus({ available, draftCount, onEnterStudio }: { available: number; draftCount: number; onEnterStudio?: () => void }) {
  if (available > 0 && draftCount === 0) return null;
  const message = available === 0
    ? draftCount > 0 ? `当前没有已确认的合格题；${draftCount} 道草稿题不会参与练习` : "当前没有符合条件的可练习题目"
    : `当前有 ${available} 道合格题可以练习；另有 ${draftCount} 道草稿题尚未确认`;
  return <div className="question-bank-status"><div><strong>{available === 0 ? "暂无可练习题目" : "题库状态"}</strong><span>{message}</span></div>{onEnterStudio && <button className="quiet-button" data-action="questions-open-studio" onClick={onEnterStudio}>管理题库</button>}</div>;
}

function normalizeSections(page: PageLesson): LessonSection[] {
  const anchorIds = page.anchors.map((item) => item.id); const atomIds = page.atoms.map((item) => item.id);
  const sectionTitles: Array<[LessonSection["kind"], string]> = [["chapter_bridge", "承上启下"], ["prior_knowledge", "先验知识"], ["learning_objectives", "学习目标"], ["full_explanation", "完整讲解"], ["main_content", "主要内容"], ["misconceptions", "易错点"]];
  if (page.lessonSections?.length) {
    const byKind = new Map(page.lessonSections.map((section) => [section.kind, section]));
    return sectionTitles.map(([kind, title]) => {
      const section = byKind.get(kind);
      if (kind === "chapter_bridge" && !section?.markdown?.trim()) return { id: `${page.id}:section:chapter_bridge`, kind, title, markdown: "承上启下尚未补齐；当前页教学结构未完成", sourceAnchorIds: anchorIds, atomIds };
      if (!section) return { id: `${page.id}:section:${kind}`, kind, title, markdown: kind === "full_explanation" ? "完整讲解尚未生成；已有摘要保留" : "本节内容尚未生成，请进入制作模式补齐后再发布", sourceAnchorIds: anchorIds, atomIds };
      if (kind === "main_content") return { ...section, title, markdown: section.markdown?.trim() ? summaryMarkdown(section.markdown) : "主要内容尚未补齐；完整讲解保留" };
      if (kind === "full_explanation" && !section.markdown?.trim() && !section.items?.some((item) => item.text.trim())) {
        return { ...section, markdown: "完整讲解尚未生成；已有摘要保留" };
      }
      return { ...section, title };
    }).filter((section): section is LessonSection => Boolean(section));
  }
  const find = (...kinds: string[]) => page.blocks.filter((item) => kinds.includes(item.kind)).map((item) => item.markdown).join("\n\n");
  const items = (prefix: string, text: string) => (prefix === "prior" ? parsePriorKnowledgeDefinitions(text) : splitOutsideMath(text)).map((textValue, index) => ({ id: `${page.id}:${prefix}:${index + 1}`, text: textValue, sourceAnchorIds: anchorIds }));
  const main = page.blocks.find((item) => item.kind === "core")?.markdown || find("core");
  const fullExplanation = find("deep_dive", "example", "check");
  return [{ id: `${page.id}:section:bridge`, kind: "chapter_bridge", title: "承上启下", markdown: "承上启下尚未补齐；当前页教学结构未完成", sourceAnchorIds: anchorIds, atomIds }, { id: `${page.id}:section:prior`, kind: "prior_knowledge", title: "先验知识", items: items("prior", find("prerequisite")), sourceAnchorIds: anchorIds, atomIds }, { id: `${page.id}:section:objective`, kind: "learning_objectives", title: "学习目标", items: items("objective", find("objective")), sourceAnchorIds: anchorIds, atomIds }, { id: `${page.id}:section:full`, kind: "full_explanation", title: "完整讲解", markdown: fullExplanation.trim() ? fullExplanation : "完整讲解尚未生成；已有摘要保留", sourceAnchorIds: anchorIds, atomIds }, { id: `${page.id}:section:main`, kind: "main_content", title: "主要内容", markdown: summaryMarkdown(main) || "本节内容尚未生成，请进入制作模式补齐后再发布", sourceAnchorIds: anchorIds, atomIds }, { id: `${page.id}:section:misconceptions`, kind: "misconceptions", title: "易错点", items: items("misconception", find("misconception")), sourceAnchorIds: anchorIds, atomIds }];
}

export function summaryMarkdown(markdown: string): string {
  if (!/^\s*[-*+]\s+/m.test(markdown)) return markdown;
  return markdown.replace(/^\s*#{1,6}\s+[^\n]+\n+/u, "").trim();
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
