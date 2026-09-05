import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CourseRelease, LessonSection, PageLesson, PageQuestion, PseudoCodeLine, QuestionBankItem, QuestionSelection } from "@course-os/contracts";
import { api } from "./api.js";
import { Markdown } from "./Markdown.js";

export function ExplanationPanel({ release, page, sessionId, onEnterStudio, loadRootRef }: { release: CourseRelease; page: PageLesson; sessionId?: string; onEnterStudio?: () => void; loadRootRef?: { current: HTMLElement | null } }) {
  const sections = useMemo(() => normalizeSections(page), [page]);
  const pseudocode = page.atoms.filter((atom): atom is PseudoCodeLine => atom.kind === "pseudocode_line");
  const [qaRecords, setQaRecords] = useState<PageQuestion[]>([]);
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
    }, { root: loadRootRef?.current ?? null, rootMargin: "600px 0px" });
    observer.observe(marker);
    return () => observer.disconnect();
  }, [page.id, loadRootRef]);
  useEffect(() => {
    if (!interactiveReady) return;
    let active = true;
    api.lesson(page.id).then((lesson) => active && setQaRecords(lesson.qaRecords)).catch(() => active && setQaRecords([]));
    return () => { active = false; };
  }, [interactiveReady, page.id]);
  return <section className="explanation-panel" aria-label="教师讲解">
    <header className="lesson-header"><div><span className="eyebrow">第 {page.pageNumber} 页</span><h2>{page.title}</h2></div><span className={`quality-badge ${page.quality.publishable ? "pass" : "hold"}`}>{page.quality.publishable ? "讲解已生成" : "讲解草稿"}</span></header>
    <LessonSectionView section={sections[0]} />
    <LessonSectionView section={sections[1]} />
    <LessonSectionView section={sections[2]} />
    <LessonSectionView section={sections[3]}>{pseudocode.length > 0 && <PseudoCodeWalkthrough lines={pseudocode} />}</LessonSectionView>
    <LessonSectionView section={sections[4]} />
    <div ref={interactiveMarkerRef} className="lesson-interactive-marker" aria-hidden="true" />
    {interactiveReady && <>
      <article className="lesson-block random-questions"><SectionTitle number="06" english="ACTIVE RECALL" title="随机问题" /><RandomQuestions release={release} page={page} sessionId={sessionId} onEnterStudio={onEnterStudio} /></article>
      <article className="lesson-block qa-records"><SectionTitle number="07" english="QUESTION AND ANSWER" title="QA记录" /><QuestionBox page={page} sessionId={sessionId} onSaved={(question) => setQaRecords((current) => [...current, question])} /><QARecordList records={qaRecords} onChanged={(updated) => setQaRecords((current) => current.map((item) => item.id === updated.id ? updated : item))} /></article>
    </>}
  </section>;
}

function SectionTitle({ number, english, title }: { number: string; english: string; title: string }) {
  return <div className="lesson-section-title"><span>{number}</span><div><small>{sectionDescriptor(english)}</small><h3>{title}</h3></div></div>;
}

function sectionDescriptor(value: string): string {
  const normalized = value.toLocaleLowerCase().replaceAll("_", " ").trim();
  return ({
    "learning objectives": "本页要学会",
    "main content": "先抓住这页在讲什么",
    "prior knowledge": "读懂本页前需要知道",
    "full explanation": "把原理讲透",
    misconceptions: "最容易混淆的地方",
    "question and answer": "学习过程中留下的问题",
    "active recall": "现在检验是否真的理解"
  } as Record<string, string>)[normalized] || "本节说明";
}

function LessonSectionView({ section, children }: { section?: LessonSection; children?: ReactNode }) {
  if (!section) return null;
  const number = ({ learning_objectives: "01", main_content: "02", prior_knowledge: "03", full_explanation: "04", misconceptions: "05" } as Record<string, string>)[section.kind] ?? "00";
  return <article className={`lesson-block section-${section.kind}`}><SectionTitle number={number} english={section.kind.replaceAll("_", " ")} title={section.title} />{section.items?.length ? <ul className="sentence-list">{section.items.map((item) => <li key={item.id}>{item.text}</li>)}</ul> : null}{section.markdown ? <Markdown>{section.markdown}</Markdown> : null}{children}</article>;
}

function PseudoCodeWalkthrough({ lines }: { lines: PseudoCodeLine[] }) {
  return <section className="pseudocode-walkthrough"><h4>伪代码逐行讲解</h4><p>先看每一行直接做了什么，再展开查看它读取和修改了哪些状态</p><div className="line-list">{lines.map((line) => <details key={line.id} className="code-line" open={line.lineNumber <= 3}><summary data-action="pseudocode-toggle"><span className="line-number">{line.lineNumber}</span><div className="code-line-heading"><code>{line.code}</code><span className="code-line-label">这一行做什么</span><strong>{teacherSummaryFor(line)}</strong></div></summary><div className="code-line-body"><div className="code-line-state"><div><span>执行前</span><p>{line.preState}</p></div><span className="code-line-arrow" aria-hidden="true">→</span><div><span>执行后</span><p>{line.postState}</p></div></div><dl><div><dt>读取对象</dt><dd>{line.reads.length ? line.reads.join("、") : "不读取运行变量"}</dd></div><div><dt>修改对象</dt><dd>{line.writes.length ? line.writes.join("、") : "不修改运行变量"}</dd></div><div><dt>副作用</dt><dd>{line.sideEffects.length ? line.sideEffects.join("；") : "没有额外副作用"}</dd></div><div><dt>复杂度</dt><dd>{line.complexityRelation}</dd></div></dl></div></details>)}</div></section>;
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

function QuestionBox({ page, sessionId, onSaved }: { page: PageLesson; sessionId?: string; onSaved: (question: PageQuestion) => void }) {
  const [question, setQuestion] = useState(""); const [attempt, setAttempt] = useState(""); const [hintLevel, setHintLevel] = useState(1); const [answer, setAnswer] = useState(""); const [busy, setBusy] = useState(false);
  const ask = async () => { if (!sessionId || !question.trim()) return; setBusy(true); try { const result = await api.ask(sessionId, { pageId: page.id, question, learnerAttempt: attempt, hintLevel, anchorIds: page.anchors.map((anchor) => anchor.id) }); setAnswer(result.response); setHintLevel((value) => Math.min(6, value + 1)); onSaved(result); } catch (error) { setAnswer(error instanceof Error ? error.message : "提问失败，记录尚未写入 ReadWeave"); } finally { setBusy(false); } };
  return <div className="interactive-card qa-composer"><span className="eyebrow">提示阶梯 {hintLevel}/6</span><h4>卡在哪里，直接问老师</h4><label>你已经尝试到哪一步<textarea value={attempt} onChange={(event) => setAttempt(event.target.value)} placeholder="先写下自己的思路，哪怕只有半步" /></label><label>你的问题<textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：为什么这里要除以 2" /></label><button className="primary" data-action="qa-save" aria-describedby="qa-save-reason" title={!sessionId ? "学习会话尚未建立" : !question.trim() ? "请先填写问题" : undefined} disabled={!sessionId || !question.trim() || busy} onClick={ask}>{busy ? "正在保存到 ReadWeave" : "提问并自动保存"}</button><span id="qa-save-reason" className="sr-only">{!sessionId ? "学习会话尚未建立" : !question.trim() ? "请先填写问题" : "提交后会写入 ReadWeave"}</span>{answer && <div className="answer"><Markdown>{answer}</Markdown></div>}</div>;
}

function QARecordList({ records, onChanged }: { records: PageQuestion[]; onChanged: (record: PageQuestion) => void }) {
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const active = records.filter((item) => item.status === "active");
  const updatePolicy = async (record: PageQuestion) => {
    setBusyId(`policy:${record.id}`); setError("");
    try { onChanged(await api.setQuestionReviewPolicy(record, record.reviewPolicy === "include" ? "exclude" : "include")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "复习策略保存失败"); }
    finally { setBusyId(""); }
  };
  const retract = async (record: PageQuestion) => {
    setBusyId(`retract:${record.id}`); setError("");
    try { onChanged(await api.retractQuestion(record)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "问答撤回失败"); }
    finally { setBusyId(""); }
  };
  if (!active.length) return <>{error && <p className="qa-action-error">{error}</p>}<p className="empty-inline">本页还没有保存的实时问答</p></>;
  return <div className="qa-history">{active.map((record) => <article key={record.id}><header><strong>{record.question}</strong><span>提示 {record.hintLevel}/6</span></header><Markdown>{record.response}</Markdown><footer><button data-action="qa-toggle-review" disabled={Boolean(busyId)} title={busyId ? "正在保存上一项问答操作" : undefined} onClick={() => void updatePolicy(record)}>{busyId === `policy:${record.id}` ? "保存中" : record.reviewPolicy === "include" ? "从复习中排除" : "加入复习"}</button><button className="danger-text" data-action="qa-retract" disabled={Boolean(busyId)} title={busyId ? "正在保存上一项问答操作" : undefined} onClick={() => void retract(record)}>{busyId === `retract:${record.id}` ? "撤回中" : "撤回记录"}</button></footer></article>)}{error && <p className="qa-action-error">{error}</p>}</div>;
}

function RandomQuestions({ release, page, sessionId, onEnterStudio }: { release: CourseRelease; page: PageLesson; sessionId?: string; onEnterStudio?: () => void }) {
  const [selection, setSelection] = useState<QuestionSelection>(); const [questions, setQuestions] = useState<QuestionBankItem[]>([]); const [answers, setAnswers] = useState<Record<string, string>>({}); const [feedback, setFeedback] = useState<Record<string, string>>({}); const [pendingQuestionIds, setPendingQuestionIds] = useState<Set<string>>(() => new Set()); const [loading, setLoading] = useState(false); const [available, setAvailable] = useState(() => page.questionBank?.filter((item) => item.status === "approved").length ?? 0); const [draftCount, setDraftCount] = useState(() => page.questionBank?.filter((item) => item.status === "draft").length ?? 0);
  const pendingRef = useRef(new Set<string>()); const idempotencyKeysRef = useRef(new Map<string, string>());
  useEffect(() => { setAvailable(page.questionBank?.filter((item) => item.status === "approved").length ?? 0); setDraftCount(page.questionBank?.filter((item) => item.status === "draft").length ?? 0); }, [page.id, page.questionBank]);
  useEffect(() => { if (!sessionId) return; setLoading(true); api.selectQuestions(page.id, sessionId).then((result) => { setSelection(result.selection); setQuestions(result.questions); setAvailable(result.available); setDraftCount(result.draftCount ?? 0); }).catch((error) => setFeedback({ load: error instanceof Error ? error.message : "随机问题加载失败" })).finally(() => setLoading(false)); }, [page.id, sessionId]);
  const submit = async (item: QuestionBankItem) => {
    const answer = answers[item.id]?.trim();
    if (!selection || !sessionId || !answer || pendingRef.current.has(item.id)) return;
    pendingRef.current.add(item.id);
    setPendingQuestionIds(new Set(pendingRef.current));
    const replayKey = `${selection.id}:${item.id}:${answer}`;
    const idempotencyKey = idempotencyKeysRef.current.get(replayKey) ?? crypto.randomUUID();
    idempotencyKeysRef.current.set(replayKey, idempotencyKey);
    try {
      const result = await api.questionAttempt({ selectionId: selection.id, sessionId, courseReleaseId: release.id, pageId: page.id, questionId: item.id, answer, usedHintLevel: 0 }, idempotencyKey);
      idempotencyKeysRef.current.delete(replayKey);
      setFeedback((current) => ({ ...current, [item.id]: `${result.attempt.correct ? "回答正确" : "还需要复习"}：${result.feedback}` }));
    } catch (error) {
      setFeedback((current) => ({ ...current, [item.id]: error instanceof Error ? error.message : "作答保存失败" }));
    } finally {
      pendingRef.current.delete(item.id);
      setPendingQuestionIds(new Set(pendingRef.current));
    }
  };
  const bankNotice = available < 4 || draftCount > 0;
  if (!sessionId) return <><QuestionBankStatus available={available} draftCount={draftCount} onEnterStudio={onEnterStudio} /> <p className="empty-inline">学习会话建立后会抽取 1道理解题和 1道选择题</p></>;
  if (loading) return <p className="empty-inline">正在从 ReadWeave 抽取问题</p>;
  if (!questions.length) return <><QuestionBankStatus available={available} draftCount={draftCount} onEnterStudio={onEnterStudio} /><p className="empty-inline">{feedback.load || "本页题库尚未达到发布要求，请从制作模式补齐题目"}</p></>;
  return <>{bankNotice && <QuestionBankStatus available={available} draftCount={draftCount} onEnterStudio={onEnterStudio} />}<div className="question-stack">{questions.map((item, index) => { const pending = pendingQuestionIds.has(item.id); return <section key={item.id} className="question-card"><header><span>{String(index + 1).padStart(2, "0")}</span><strong>{item.kind === "comprehension" ? "理解题" : "选择题"}</strong></header><p>{item.prompt}</p>{item.options?.length ? <div className="choice-list">{item.options.map((option) => <label key={option}><input type="radio" name={item.id} value={option} checked={answers[item.id] === option} disabled={pending} onChange={(event) => setAnswers((current) => ({ ...current, [item.id]: event.target.value }))} />{option}</label>)}</div> : <textarea value={answers[item.id] || ""} disabled={pending} onChange={(event) => setAnswers((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="不用照抄原文，先用自己的话回答" />}<button className="primary" disabled={!answers[item.id]?.trim() || pending} aria-busy={pending} title={!answers[item.id]?.trim() ? "请先作答" : pending ? "正在保存本题作答" : undefined} onClick={() => void submit(item)}>{pending ? "正在保存" : "提交并保存记录"}</button>{feedback[item.id] && <p className="answer" aria-live="polite">{feedback[item.id]}</p>}</section>; })}</div></>;
}

function QuestionBankStatus({ available, draftCount, onEnterStudio }: { available: number; draftCount: number; onEnterStudio?: () => void }) {
  if (available >= 4 && draftCount === 0) return null;
  return <div className="question-bank-status"><div><strong>题库尚未就绪</strong><span>当前有 {available} 道可用题目，另有 {draftCount} 道草稿题；补齐 4 道可用题目后即可练习</span></div>{onEnterStudio && <button className="quiet-button" data-action="questions-open-studio" onClick={onEnterStudio}>去制作模式补齐</button>}</div>;
}

function normalizeSections(page: PageLesson): LessonSection[] {
  const anchorIds = page.anchors.map((item) => item.id); const atomIds = page.atoms.map((item) => item.id);
  const sectionTitles: Array<[LessonSection["kind"], string]> = [["learning_objectives", "学习目标"], ["main_content", "主要内容"], ["prior_knowledge", "先验知识列表"], ["full_explanation", "完整讲解"], ["misconceptions", "易错点列表"]];
  if (page.lessonSections?.length) {
    const byKind = new Map(page.lessonSections.map((section) => [section.kind, section]));
    const main = byKind.get("main_content")?.markdown;
    return sectionTitles.map(([kind, title]) => {
      const section = byKind.get(kind);
      if (!section) return { id: `${page.id}:section:${kind}`, kind, title, markdown: "本节内容尚未生成，请进入制作模式补齐后再发布", sourceAnchorIds: anchorIds, atomIds };
      if (kind !== "full_explanation" || !section.markdown || !main) return section;
      const distinctExplanation = removeRepeatedOpening(main, section.markdown);
      return distinctExplanation ? { ...section, markdown: distinctExplanation } : section;
    });
  }
  const find = (...kinds: string[]) => page.blocks.filter((item) => kinds.includes(item.kind)).map((item) => item.markdown).join("\n\n");
  const items = (prefix: string, text: string) => splitOutsideMath(text).map((textValue, index) => ({ id: `${page.id}:${prefix}:${index + 1}`, text: textValue, sourceAnchorIds: anchorIds }));
  const main = page.blocks.find((item) => item.kind === "core")?.markdown || find("core");
  return [{ id: `${page.id}:section:objective`, kind: "learning_objectives", title: "学习目标", items: items("objective", find("objective")), sourceAnchorIds: anchorIds, atomIds }, { id: `${page.id}:section:main`, kind: "main_content", title: "主要内容", markdown: main || "本节内容尚未生成，请进入制作模式补齐后再发布", sourceAnchorIds: anchorIds, atomIds }, { id: `${page.id}:section:prior`, kind: "prior_knowledge", title: "先验知识列表", items: items("prior", find("prerequisite")), sourceAnchorIds: anchorIds, atomIds }, { id: `${page.id}:section:full`, kind: "full_explanation", title: "完整讲解", markdown: find("core", "example", "deep_dive", "check") || "本节内容尚未生成，请进入制作模式补齐后再发布", sourceAnchorIds: anchorIds, atomIds }, { id: `${page.id}:section:misconceptions`, kind: "misconceptions", title: "易错点列表", items: items("misconception", find("misconception")), sourceAnchorIds: anchorIds, atomIds }];
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
