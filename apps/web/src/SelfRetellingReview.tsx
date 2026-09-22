import { useEffect, useMemo, useState } from "react";
import type { CourseRelease, SelfRetelling } from "@course-os/contracts";
import { api } from "./api.js";
import { selfRetellingCards } from "./self-retelling-model.js";
import "./self-retelling.css";

export function SelfRetellingReview({ releases, onClose }: { releases: CourseRelease[]; onClose: () => void }) {
  const [records, setRecords] = useState<SelfRetelling[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [reviewedThisRun, setReviewedThisRun] = useState<Set<string>>(() => new Set());
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.selfRetellings().then((items) => active && setRecords(items))
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : "卡片暂时无法读取"))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);
  const cards = useMemo(() => selfRetellingCards(releases, records, Date.now(), !showAll).filter((card) => !reviewedThisRun.has(`${card.release.id}\u0000${card.page.id}`)), [releases, records, showAll, reviewedThisRun]);
  const current = cards[0];

  const rate = async (result: "again" | "remembered") => {
    if (!current || saving) return;
    setSaving(true); setError("");
    try {
      const saved = await api.reviewSelfRetelling(current.release.id, current.page.id, result);
      setRecords((items) => items.map((item) => item.releaseId === saved.releaseId && item.pageId === saved.pageId ? saved : item));
      if (showAll) setReviewedThisRun((items) => new Set(items).add(`${saved.releaseId}\u0000${saved.pageId}`));
      setRevealed(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "复习结果未保存，请重试"); }
    finally { setSaving(false); }
  };

  return <main className="self-retelling-review">
    <header className="self-retelling-review-header"><div><span>FLASHCARDS</span><h1>自我重述卡片</h1><p>正面是课件页标题，翻面后查看你自己的重述。</p></div><button className="quiet-button" data-action="close-self-retelling-review" onClick={onClose}>返回复习中心</button></header>
    <div className="self-retelling-review-toolbar"><span>{loading ? "正在读取卡片…" : `${cards.length} 张${showAll ? "卡片" : "待复习卡片"}`}</span><button className="quiet-button" data-action="toggle-all-self-retelling-cards" disabled={loading} onClick={() => { setShowAll((value) => !value); setReviewedThisRun(new Set()); setRevealed(false); }}>{showAll ? "只看待复习" : "查看全部卡片"}</button></div>
    {error && <p className="self-retelling-message is-error" role="alert">{error}</p>}
    {!loading && !current ? <section className="self-retelling-empty"><h2>{showAll ? records.length ? "本轮卡片已完成" : "还没有已提交的重述" : "当前没有到期卡片"}</h2><p>{showAll ? records.length ? "本轮复习已保存。你可以返回复习中心，或切换到待复习卡片。" : "先在教学页提交自我重述，系统就会用页面标题和你的回答建立卡片。" : "新提交的重述会立即进入复习队列；稍后再次复习会按你的选择安排时间。"}</p><button className="quiet-button" onClick={onClose}>返回复习中心</button></section> : current && <article className="self-retelling-card" aria-live="polite">
      <div className="self-retelling-card-meta"><span>{current.release.courseTitle} · 第 {current.page.pageNumber} 页</span><span>{current.retelling.nextReviewAt && Date.parse(current.retelling.nextReviewAt) <= Date.now() ? "待复习" : "已安排复习"}</span></div>
      <h2>{current.page.title}</h2>
      {revealed ? <div className="self-retelling-card-answer"><h3>我的重述</h3><p>{current.retelling.answer}</p></div> : <button className="primary-button" data-action="reveal-self-retelling-answer" onClick={() => setRevealed(true)}>显示我的回答</button>}
      <details className="self-retelling-source"><summary>预览原始课件页</summary><img src={current.page.imageUrl} alt={`第 ${current.page.pageNumber} 页原始课件`} loading="lazy" /></details>
      {revealed && <div className="self-retelling-ratings"><button className="quiet-button" data-action="rate-self-retelling-again" disabled={saving} onClick={() => void rate("again")}>{saving ? "正在保存" : "再复习 · 10 分钟后"}</button><button className="primary-button" data-action="rate-self-retelling-remembered" disabled={saving} onClick={() => void rate("remembered")}>{saving ? "正在保存" : "已记住 · 明天复习"}</button></div>}
    </article>}
  </main>;
}
