import { useEffect, useState } from "react";
import type { GenerationCostEntry, GenerationJob } from "@course-os/contracts";
import type { WebGenerationPlan, WebImportRecord } from "./types.js";
import { Icon } from "./Icon.js";

type Route = { label: string; provider: string; model: string };
type Retry = { pageId: string; attempt: number; reusedTeaching: boolean };
export type TaskEventEvidence = { routes: Route[]; retries: Retry[] };
const labels: Record<string, string> = {
  page_understanding: "页面理解", visual_understanding: "页面理解", extract: "页面解析",
  teaching: "正文讲解", teach: "正文讲解", plan: "教学规划", bridge: "跨页承接",
  format_repair: "格式修复", repair: "内容修复", review: "质量检查", semantic_audit: "语义审校"
};

export function applyTaskEvent(previous: TaskEventEvidence, type: string, value: unknown): TaskEventEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return previous;
  const payload = value as Record<string, unknown>;
  const pageId = typeof payload.pageId === "string" ? payload.pageId : undefined;
  if (type === "generation.page.storage_retry" && pageId && typeof payload.attempt === "number" && Number.isInteger(payload.attempt) && payload.attempt > 0) {
    return { ...previous, retries: [...previous.retries.filter(item => item.pageId !== pageId), { pageId, attempt: payload.attempt, reusedTeaching: payload.reusedTeaching === true }] };
  }
  if (["generation.page.completed", "generation.page.failed"].includes(type) && pageId) {
    return { ...previous, retries: previous.retries.filter(item => item.pageId !== pageId) };
  }
  if (type.startsWith("generation.stage.") && typeof payload.provider === "string" && typeof payload.model === "string") {
    const phase = typeof payload.phase === "string" ? payload.phase : typeof payload.activity === "string" && labels[payload.activity] ? payload.activity : String(payload.stage ?? "");
    const label = labels[phase] ?? phase;
    if (!label || !payload.provider.trim() || !payload.model.trim()) return previous;
    const route = { label, provider: payload.provider, model: payload.model };
    return { ...previous, routes: [...previous.routes.filter(item => item.label !== label || item.provider !== route.provider || item.model !== route.model), route].slice(-24) };
  }
  return previous;
}

export function taskEventJobIds(record: WebImportRecord, plan?: WebGenerationPlan): string[] {
  const current = plan?.currentJobId || record.generationJobId;
  return [...new Set([current, plan?.lastJobId].filter((id): id is string => Boolean(id)))].sort();
}

export function mergeTaskRoutes(routes: readonly Route[], costs: readonly GenerationCostEntry[]): Route[] {
  const costRoutes = costs.filter(cost => cost.provider && cost.model).map(cost => ({
    label: `${labels[cost.stage] ?? cost.stage}（成本记录）`, provider: cost.provider, model: cost.model
  }));
  return [...new Map([...routes, ...costRoutes].map(route => [JSON.stringify(route), route])).values()];
}

export function ImportTaskEvents({ record, plan, costs }: { record: WebImportRecord; plan?: WebGenerationPlan; jobs: readonly GenerationJob[]; costs: readonly GenerationCostEntry[] }) {
  const materialKey = record.materialVersionId || plan?.materialVersionId || record.id;
  const [evidence, setEvidence] = useState<TaskEventEvidence & { materialKey: string }>({ materialKey, routes: [], retries: [] });
  const [unavailable, setUnavailable] = useState(false);
  const ids = taskEventJobIds(record, plan);
  const subscriptionKey = JSON.stringify(ids);
  const costKey = JSON.stringify(mergeTaskRoutes([], costs));
  useEffect(() => {
    setEvidence(previous => ({
      materialKey, routes: mergeTaskRoutes(previous.materialKey === materialKey ? previous.routes : [], costs),
      retries: previous.materialKey === materialKey ? previous.retries : []
    }));
  }, [materialKey, costKey]);
  useEffect(() => {
    setEvidence(previous => ({ materialKey, routes: previous.materialKey === materialKey ? previous.routes : [], retries: [] }));
    setUnavailable(false);
    let disposed = false;
    const streams = ids.map(id => {
      const stream = new EventSource(`${import.meta.env.VITE_API_BASE_URL || ""}/api/v1/generation-jobs/${encodeURIComponent(id)}/events`);
      for (const type of ["generation.stage.started", "generation.stage.completed", "generation.stage.skipped", "generation.page.storage_retry", "generation.page.completed", "generation.page.failed"]) {
        stream.addEventListener(type, event => {
          if (disposed) return;
          try { const payload: unknown = JSON.parse((event as MessageEvent<string>).data); setEvidence(previous => ({ materialKey, ...applyTaskEvent(previous.materialKey === materialKey ? previous : { routes: [], retries: [] }, type, payload) })); } catch { /* Malformed event is not task evidence. */ }
        });
      }
      stream.onerror = () => { stream.close(); if (!disposed) setUnavailable(true); };
      return stream;
    });
    return () => { disposed = true; streams.forEach(stream => stream.close()); };
  }, [materialKey, subscriptionKey]);
  const routes = mergeTaskRoutes(evidence.materialKey === materialKey ? evidence.routes : [], costs);
  const failedIds = new Set([...(record.generationFailedPageIds ?? []), ...(plan?.failedPageIds ?? [])]);
  const completeIds = new Set([...(record.generationCompletedPageIds ?? []), ...(plan?.completedPageIds ?? [])]);
  const active = record.state === "ready" && (plan?.state === "running" || record.generationState === "running" || record.generationState === "pending_sync");
  const retries = evidence.materialKey === materialKey && active && !unavailable ? evidence.retries.filter(item => !failedIds.has(item.pageId) && !completeIds.has(item.pageId)) : [];
  return <>
    {retries.length > 0 && <div className="import-storage-retry" role="status">{retries.map(item => {
      const index = record.pageIds?.indexOf(item.pageId) ?? -1;
      return <p key={item.pageId}>{index >= 0 ? `第 ${index + 1} 页` : "当前页"}正在重试保存（本页第 {item.attempt} 次）{item.reusedTeaching ? "，复用已生成正文" : ""}；等待保存确认，不计入完成页数</p>;
    })}</div>}
    <details className="task-technical-details import-stage-routes" open={routes.length > 1}>
      <summary><Icon name="chevronDown" /><span>各阶段实际供应商 / 模型</span></summary>
      {routes.length ? <dl>{routes.map(route => <div key={JSON.stringify(route)}><dt>{route.label}</dt><dd>{route.provider} / {route.model}</dd></div>)}</dl> : <p className="empty-inline">尚无可核对的阶段线路记录</p>}
      {unavailable && <p className="empty-inline">阶段事件暂不可读，显示已取得记录；重试保存状态待确认</p>}
    </details>
  </>;
}
