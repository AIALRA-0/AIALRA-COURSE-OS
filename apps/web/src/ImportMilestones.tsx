import type { GenerationJob } from "@course-os/contracts";
import { Icon } from "./Icon.js";
import { formatProgressCount, getImportTaskStatus, standaloneGenerationJobId, summarizeImportProgress } from "./import-progress.js";
import type { WebGenerationPlan, WebImportRecord } from "./types.js";

type Milestone = { label: string; state: "complete" | "active" | "waiting" | "failed" | "stopped" | "unknown"; detail: string };

export function importMilestones(record: WebImportRecord, plan?: WebGenerationPlan, jobs: readonly GenerationJob[] = []): Milestone[] {
  const summary = summarizeImportProgress(record, plan, jobs, []);
  const status = getImportTaskStatus(record, plan, jobs);
  const stopped = record.state === "failed" || record.state === "rejected";
  const converted = record.state === "syncing" || record.state === "ready" || record.conversionProgress?.stage === "completed";
  const conversionCountUnconfirmed = converted && (!summary.conversion || summary.conversion.total <= 0
    || summary.conversion.completed !== summary.conversion.total || record.conversionProgress?.stage === "failed"
    || (record.conversionProgress?.pageCount !== undefined && record.conversionProgress.completedPages !== record.conversionProgress.pageCount));
  const count = summary.conversion ? `${formatProgressCount(summary.conversion)} 页` : "页数待确认";
  const generation: Milestone = record.state !== "ready"
    ? { label: "讲解生成", state: "waiting", detail: stopped ? "尚未开始" : "等待材料保存" }
    : status.action === "generate"
      ? { label: "讲解生成", state: "waiting", detail: "未启用自动生成" }
      : status.action === "open_draft"
        ? { label: "讲解生成", state: "complete", detail: status.fact }
        : { label: "讲解生成", state: status.state === "failed" ? "failed" : status.state === "running" ? "active"
          : status.state === "cancelled" || status.state === "paused" ? "stopped" : status.state === "queued" ? "waiting" : "unknown", detail: status.fact };
  if (standaloneGenerationJobId(record.id)) return [generation];
  return [
    { label: "上传接单", state: record.state === "rejected" ? "failed" : "complete", detail: record.state === "rejected" ? "文件被拒绝" : "服务端已接单" },
    { label: "页面转换", state: conversionCountUnconfirmed ? "unknown" : converted ? "complete" : record.conversionProgress?.stage === "failed" ? "failed" : stopped ? "unknown" : record.state === "processing" ? "active" : "waiting",
      detail: conversionCountUnconfirmed ? `转换已结束，计数待核对 · ${count}` : converted ? `已转换 · ${count}` : record.conversionProgress?.stage === "failed" ? `转换失败 · ${count}` : stopped ? `已停止，阶段待核对 · ${count}` : record.state === "processing" ? `转换中 · ${count}` : "等待检查与转换" },
    { label: "材料保存", state: record.state === "ready" ? "complete" : record.state === "syncing" ? "active" : stopped ? "unknown" : "waiting",
      detail: record.state === "ready" ? "材料来源已保存，讲解另行生成" : record.state === "syncing" ? "正在保存材料来源，尚未确认完成" : stopped ? "未确认保存" : "等待转换完成" },
    generation
  ];
}

export function ImportMilestones({ record, plan, jobs }: { record: WebImportRecord; plan?: WebGenerationPlan; jobs: readonly GenerationJob[] }) {
  const summary = summarizeImportProgress(record, plan, jobs, []);
  const failures = new Set([...(record.generationFailedPageIds ?? []), ...(plan?.failedPageIds ?? [])]).size;
  return <><ol className="import-milestones" aria-label="导入与生成里程碑">
    {importMilestones(record, plan, jobs).map((step, index) => <li key={step.label} data-milestone-state={step.state} aria-current={step.state === "active" ? "step" : undefined}>
      <span className="import-milestone-marker" aria-hidden="true">{step.state === "complete" ? <Icon name="check" /> : step.state === "failed" ? <Icon name="warning" /> : index + 1}</span>
      <div><strong>{step.label}</strong><span>{step.detail}</span></div>
    </li>)}
  </ol>{record.state === "ready" && record.autoGenerate !== false && record.generationState !== "not_requested" && <div className="import-generation-checkpoints" aria-label="讲解保存与完整性">
    <span>正文可读：<strong>{formatProgressCount(summary.core)}</strong></span>
    <span>跨页承接完成：<strong>{formatProgressCount(summary.crossPage)}</strong></span>
    <span>失败页面：<strong>{failures}</strong></span>
    <small>正文保存后可读；承接或费用写入失败不代表已保存的正文丢失</small>
  </div>}</>;
}
