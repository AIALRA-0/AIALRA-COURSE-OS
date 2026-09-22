import { useEffect, useMemo, useState } from "react";
import type { CourseRelease, PageLesson, SelfRetelling } from "@course-os/contracts";
import { api } from "./api.js";
import { readingProgress } from "./self-retelling-model.js";
import "./self-retelling.css";

export function SelfRetellingPanel({ release, page }: { release: CourseRelease; page: PageLesson }) {
  const [records, setRecords] = useState<SelfRetelling[]>([]);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const progress = useMemo(() => readingProgress(release.pageIds, records), [release.pageIds, records]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setAnswer("");
    api.selfRetellings(release.id).then((items) => {
      if (!active) return;
      setRecords(items);
      setAnswer(items.find((item) => item.pageId === page.id)?.answer ?? "");
      setError("");
    }).catch((reason) => active && setError(reason instanceof Error ? reason.message : "读取自我重述失败")).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [page.id, release.id]);

  const save = async () => {
    const value = answer.trim();
    if (!value || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const saved = await api.saveSelfRetelling(release.id, page.id, value, crypto.randomUUID());
      setRecords((current) => [...current.filter((item) => item.pageId !== saved.pageId), saved]);
      setAnswer(saved.answer);
      setNotice("重述已保存，本页已计入阅读进度");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重述未保存，请重试");
    } finally { setSaving(false); }
  };

  return <article className="self-retelling-panel" aria-labelledby="self-retelling-title">
    <header className="self-retelling-heading"><div><span>ACTIVE RECALL</span><h3 id="self-retelling-title">看完讲解后，用自己的话重述</h3><p>不用照抄。说清本页要解决的问题、关键关系和结论。</p></div><strong className="self-retelling-progress">阅读进度 {progress.answered}/{progress.total} · {progress.percent}%</strong></header>
    <label className="self-retelling-input"><span>我的重述（必填）</span><textarea value={answer} onChange={(event) => setAnswer(event.target.value)} maxLength={12_000} rows={5} required aria-required="true" disabled={saving || loading} placeholder={loading ? "正在读取已保存的回答…" : "先合上讲解，用自己的话写出你记住的内容"} /></label>
    <div className="self-retelling-footer"><span>{answer.trim().length} / 12000</span><button className="primary-button" data-action="save-self-retelling" disabled={saving || loading || !answer.trim()} aria-busy={saving} onClick={() => void save()}>{saving ? "正在保存" : records.some((item) => item.pageId === page.id) ? "更新重述" : "提交重述"}</button></div>
    {error && <p className="self-retelling-message is-error" role="alert">{error}</p>}
    {notice && <p className="self-retelling-message" role="status">{notice}</p>}
  </article>;
}
