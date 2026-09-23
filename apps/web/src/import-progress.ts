import type { GenerationCostEntry, GenerationJob, GenerationStage, GenerationStageActivitySummary } from "@course-os/contracts";
import type { ImportProgressSummary, ProgressCount, WebGenerationPlan, WebImportRecord } from "./types.js";

type UnknownRecord = Record<string, unknown>;

const progressContainers = ["progress", "generationProgress", "progressSnapshot", "metrics", "status"] as const;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function readValue(source: UnknownRecord, keys: readonly string[]): unknown {
  for (const key of keys) if (key in source) return source[key];
  return undefined;
}

function readNumber(source: UnknownRecord, keys: readonly string[]): number | undefined {
  return finiteNumber(readValue(source, keys));
}

function countFrom(value: unknown, completedKeys: readonly string[], totalKeys: readonly string[]): ProgressCount | undefined {
  const object = asRecord(value);
  if (!object) return undefined;
  const completed = readNumber(object, completedKeys);
  const total = readNumber(object, totalKeys);
  return completed !== undefined && total !== undefined && total >= completed ? { completed, total } : undefined;
}

function countFromSources(
  sources: readonly UnknownRecord[],
  valueKeys: readonly string[],
  completedKeys: readonly string[],
  totalKeys: readonly string[]
): ProgressCount | undefined {
  for (const source of sources) {
    const direct = countFrom(readValue(source, valueKeys), completedKeys, totalKeys);
    if (direct) return direct;
    const directCompleted = readNumber(source, completedKeys);
    const directTotal = readNumber(source, totalKeys);
    if (directCompleted !== undefined && directTotal !== undefined && directTotal >= directCompleted) {
      return { completed: directCompleted, total: directTotal };
    }
  }
  return undefined;
}

function nestedSources(record: WebImportRecord, plan?: WebGenerationPlan): UnknownRecord[] {
  const sources: UnknownRecord[] = [];
  for (const root of [record, plan]) {
    const object = asRecord(root);
    if (!object) continue;
    sources.push(object);
    for (const container of progressContainers) {
      const nested = asRecord(object[container]);
      if (nested) sources.push(nested);
    }
  }
  return sources;
}

function arrayLength(source: UnknownRecord, keys: readonly string[]): number | undefined {
  const value = readValue(source, keys);
  return Array.isArray(value) ? value.length : undefined;
}

function countFromArrays(
  sources: readonly UnknownRecord[],
  completedArrayKeys: readonly string[],
  totalArrayKeys: readonly string[],
  totalNumberKeys: readonly string[]
): ProgressCount | undefined {
  for (const source of sources) {
    const completed = arrayLength(source, completedArrayKeys);
    if (completed === undefined) continue;
    const total = arrayLength(source, totalArrayKeys) ?? readNumber(source, totalNumberKeys);
    if (total !== undefined && total >= completed) return { completed, total };
  }
  return undefined;
}

function firstNumber(sources: readonly UnknownRecord[], keys: readonly string[]): number | undefined {
  for (const source of sources) {
    const value = readNumber(source, keys);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstText(sources: readonly UnknownRecord[], keys: readonly string[]): string | undefined {
  for (const source of sources) {
    const value = readValue(source, keys);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function progressSources(sources: readonly UnknownRecord[], keys: readonly string[]): UnknownRecord[] {
  return sources.flatMap((source) => {
    const nested = asRecord(readValue(source, keys));
    return nested ? [nested] : [];
  });
}

export function summarizeImportProgress(
  record: WebImportRecord,
  plan: WebGenerationPlan | undefined,
  activeJobs: readonly GenerationJob[] | undefined,
  costs: readonly GenerationCostEntry[]
): ImportProgressSummary {
  const sources = nestedSources(record, plan);
  const conversionSources = [...progressSources(sources, ["conversion", "conversionProgress", "convert"]), ...sources];
  const coreSources = [...progressSources(sources, ["core", "bodyCore", "body", "teaching", "generation", "lesson"]), ...sources];
  const crossPageSources = [...progressSources(sources, ["crossPage", "crossPageCarryover", "carryover", "handoff", "bridge", "cross_page"]), ...sources];

  let conversion = countFromSources(
    conversionSources,
    ["conversion", "conversionProgress", "conversionStatus"],
    ["completed", "done", "finished", "converted", "completedPages", "completedPageCount", "convertedPageCount", "conversionCompletedPages", "conversionCompletedPageCount"],
    ["total", "totalPages", "pageCount", "totalPageCount", "conversionTotalPages", "conversionTotalPageCount"]
  ) ?? countFromArrays(sources, ["convertedPageIds", "conversionCompletedPageIds"], ["pageIds"], ["totalPages", "totalPageCount"]);
  if (!conversion && record.state === "ready" && record.pageIds?.length && !record.id?.startsWith(STANDALONE_GENERATION_TASK_PREFIX)) {
    conversion = { completed: record.pageIds.length, total: record.pageIds.length };
  }

  let core = countFromSources(
    coreSources,
    ["core", "bodyCore", "bodyCoreProgress", "coreProgress", "teachingProgress"],
    ["completed", "done", "finished", "completedPages", "completedPageCount", "coreCompleted", "coreCompletedPageCount", "bodyCoreCompleted", "bodyCoreCompletedPageCount"],
    ["total", "totalPages", "pageCount", "totalPageCount", "coreTotal", "coreTotalPageCount", "bodyCoreTotal", "bodyCoreTotalPageCount"]
  ) ?? countFromArrays(coreSources, ["coreCompletedPageIds", "bodyCoreCompletedPageIds"], ["pageIds"], ["coreTotal", "coreTotalPageCount"])
    ?? (plan && plan.pageIds.length > 0 ? { completed: plan.completedPageIds.length, total: plan.pageIds.length }
      : record.generationJobId && record.pageIds?.length
        ? { completed: (record.generationCompletedPageIds?.length ?? 0) + (record.generationFailedPageIds?.length ?? 0), total: record.pageIds.length }
        : undefined);

  let crossPage = countFromSources(
    crossPageSources,
    ["crossPage", "crossPageCarryover", "carryover", "handoff", "bridge", "crossPageProgress", "carryoverProgress"],
    ["completed", "done", "finished", "completedPages", "completedPageCount", "crossPageCompleted", "crossPageCompletedPages", "carryoverCompleted", "carryoverCompletedPages"],
    ["total", "totalPages", "pageCount", "totalPageCount", "crossPageTotal", "crossPageTotalPages", "carryoverTotal", "carryoverTotalPages"]
  ) ?? countFromArrays(crossPageSources, ["crossPageCompletedPageIds", "carryoverCompletedPageIds", "bridgeCompletedPageIds"], ["pageIds"], ["crossPageTotal", "carryoverTotal"]);
  if (plan?.retryOfPlanId && record.pageIds?.length && record.generationCompletedPageIds) {
    core = { completed: record.generationCompletedPageIds.length, total: record.pageIds.length };
    crossPage = undefined;
  }

  const explicitRepairCount = firstNumber(sources, ["repairCount", "repairs", "repairAttempts", "completedRepairCount"])
    ?? firstNumber(progressSources(sources, ["repair", "repairProgress"]), ["count", "completed", "done", "attempts"]);
  const observedRepairCount = costs.filter((entry) => entry.stage === "repair").length;
  const repairCount = explicitRepairCount ?? (observedRepairCount > 0 ? observedRepairCount : undefined);

  const concurrencySource = [...progressSources(sources, ["concurrency", "runningConcurrency"]), ...sources];
  const running = firstNumber(concurrencySource, ["running", "active", "current", "runningConcurrency", "activeConcurrency"])
    ?? (activeJobs ? activeJobs.length : plan?.activeJobIds?.length);
  const limit = firstNumber(concurrencySource, ["limit", "max", "cap", "maxConcurrency"])
    ?? plan?.maxConcurrency;
  const concurrency = running !== undefined || limit !== undefined ? { running, limit } : undefined;

  const latestCost = costs.slice().sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1);
  const provider = latestCost?.provider ?? firstText(sources, ["actualProvider", "provider", "providerId"])
    ?? plan?.modelRoutes?.[0]?.provider;
  const model = latestCost?.model ?? firstText(sources, ["actualModel", "model", "modelId"])
    ?? plan?.modelRoutes?.[0]?.model;

  const directCost = firstNumber(sources, ["cumulativeCostUsd", "totalCostUsd", "spentUsd", "costUsd"]);
  const planCost = plan?.spentUsd;
  const knownEntryCosts = costs.filter((entry) => entry.costBasis !== "not_available");
  const entryCostMicrousd = knownEntryCosts.reduce((sum, entry) => sum + (entry.costBasis === "provider_reported" ? entry.actualMicrousd : entry.estimatedMicrousd), 0);
  const trustedDirectCost = directCost && directCost > 0 ? directCost : undefined;
  const trustedPlanCost = planCost && planCost > 0 ? planCost : undefined;
  const cumulativeEntryCost = plan?.retryOfPlanId && knownEntryCosts.length > 0 ? entryCostMicrousd / 1_000_000 : undefined;
  const candidateCost = cumulativeEntryCost ?? trustedDirectCost ?? trustedPlanCost
    ?? (knownEntryCosts.length > 0 ? entryCostMicrousd / 1_000_000 : directCost ?? planCost);
  const unverifiedZero = candidateCost === 0 && knownEntryCosts.length === 0 && Boolean(plan &&
    (plan.state === "running" || plan.state === "queued" || plan.completedPageIds.length + plan.failedPageIds.length > 0));
  const costUsd = unverifiedZero ? undefined : candidateCost;
  const costBasis = cumulativeEntryCost === undefined && (trustedDirectCost !== undefined || trustedPlanCost !== undefined)
    ? undefined
    : knownEntryCosts.length === 0
      ? undefined
      : knownEntryCosts.every((entry) => entry.costBasis === "provider_reported")
        ? "reported"
        : knownEntryCosts.every((entry) => entry.costBasis === "price_snapshot")
          ? "estimated"
          : "mixed";

  return { conversion, core, crossPage, repairCount, concurrency, provider, model, costUsd, costBasis };
}

export function formatProgressCount(value?: ProgressCount): string {
  return value ? `${value.completed}/${value.total}` : "—";
}

export type ImportTaskState = "queued" | "running" | "completed" | "failed" | "cancelled" | "paused" | "awaiting_review";

export const STANDALONE_GENERATION_TASK_PREFIX = "generation-job:";

export function standaloneGenerationJobId(taskId: string): string | undefined {
  return taskId.startsWith(STANDALONE_GENERATION_TASK_PREFIX)
    ? taskId.slice(STANDALONE_GENERATION_TASK_PREFIX.length) || undefined
    : undefined;
}

export function getImportTaskState(record: Pick<WebImportRecord, "state" | "generationState" | "autoGenerate">): ImportTaskState {
  const state = record.generationState;
  if (record.state === "failed" || record.state === "rejected" || state === "failed") return "failed";
  if (state === "cancelled") return "cancelled";
  if (state === "paused") return "paused";
  if (state === "awaiting_review") return "awaiting_review";
  if (state === "completed") return "completed";
  if (state === "running" || state === "pending_sync" || record.state === "processing" || record.state === "syncing") return "running";
  if (state === "queued" || record.state === "accepted" || record.state === "quarantined") return "queued";
  if (record.state === "ready" && (record.autoGenerate === false || state === "not_requested")) return "completed";
  return record.state === "ready" ? "queued" : "running";
}

export function importTaskStateLabel(state: ImportTaskState): string {
  return ({
    queued: "排队中",
    running: "正在处理",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    paused: "已暂停",
    awaiting_review: "待检查"
  } satisfies Record<ImportTaskState, string>)[state];
}

export function importProgressTitle(record: WebImportRecord, plan: WebGenerationPlan | undefined, retryingFailed: boolean): string {
  const taskState = getImportTaskState(record);
  const planState = plan?.state;
  const failed = taskState === "failed" || planState === "failed";
  const cancelled = taskState === "cancelled" || planState === "cancelled";
  if (record.autoGenerate === false || record.generationState === "not_requested") return "材料导入完成，尚未生成讲解";
  if (retryingFailed) return "正在重试失败页面";
  if (failed) return "讲解生成失败";
  if (cancelled) return "生成任务已取消";
  if (taskState === "paused") return "生成任务已暂停";
  if (taskState === "awaiting_review") return "等待检查";
  if (planState === "completed" || taskState === "completed") return "全部讲解已经生成";
  if (record.generationJobId && taskState === "queued") return "生成任务排队中";
  if (record.generationJobId && taskState === "running") return "正在生成讲解";
  return plan ? "正在后台并行生成讲解" : "正在建立生成队列";
}

export type ImportActivity = {
  stage: string;
  stageCode?: GenerationStage;
  stageStatus?: GenerationStageActivitySummary["status"];
  phase?: string;
  phaseStatus?: GenerationStageActivitySummary["phaseStatus"];
  busy: boolean;
  progressPercent?: number;
  progressScope?: string;
  lastActivityAt?: string;
  ageSeconds?: number;
  stale: boolean;
};

function timestamp(sources: readonly unknown[], keys: readonly string[]): string | undefined {
  const values = sources.flatMap((value) => {
    const source = asRecord(value);
    if (!source) return [];
    return keys.flatMap((key) => {
      const value = source[key];
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return [];
      return [value];
    });
  });
  return values.sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function explicitPercent(sources: readonly UnknownRecord[]): number | undefined {
  for (const source of sources) {
    const progress = asRecord(source.progress) ?? source;
    for (const key of ["overallPercent", "overallProgressPercent"]) {
      const value = finiteNumber(progress[key]);
      if (value !== undefined && value <= 100) return Math.round(value);
    }
  }
  return undefined;
}

/** Produces only progress backed by persisted counters or timestamps. */
export function getImportActivity(
  record: WebImportRecord,
  plan: WebGenerationPlan | undefined,
  activeJobs: readonly GenerationJob[],
  costs: readonly GenerationCostEntry[],
  now = Date.now()
): ImportActivity {
  const state = getImportTaskState(record);
  const planState = plan?.state;
  const generationIsActive = record.generationState === "running" || record.generationState === "pending_sync";
  const generationActivity = planState === "running"
    ? activeJobs.reduce<GenerationStageActivitySummary | undefined>((latest, job) => {
      if (job.state !== "running" && job.state !== "pending_sync") return latest;
      const candidate = job.latestStageActivity;
      if (!candidate || !Number.isFinite(Date.parse(candidate.occurredAt))) return latest;
      return !latest || Date.parse(candidate.occurredAt) > Date.parse(latest.occurredAt) ? candidate : latest;
    }, undefined)
    : !plan && generationIsActive
      ? record.generationActivity ?? activeJobs.find((job) => job.id === record.generationJobId)?.latestStageActivity
      : undefined;
  const busy = state === "running" || planState === "running";
  const stageLabels: Record<GenerationStage, string> = {
    extract: "页面解析",
    atomize: "页面结构化",
    teach: "正文讲解",
    review: "质量检查",
    repair: "内容修复",
    semantic_audit: "语义审校",
    question_refill: "题目补充",
    search: "外部检索"
  };
  const stage = record.state === "ready" && generationActivity
    ? stageLabels[generationActivity.stage]
    : record.state === "quarantined" || record.state === "accepted"
    ? "安全检查与排队"
    : record.state === "processing"
      ? "页面转换"
      : record.state === "syncing"
        ? "写入课程草稿"
        : record.state !== "ready"
          ? "导入已停止"
        : record.generationState === "failed" ? "生成失败"
          : record.generationState === "cancelled" ? "生成已取消"
            : record.generationState === "paused" ? "生成已暂停"
              : record.generationState === "completed" ? "全部页面生成完成"
                : record.generationJobId && record.generationState === "pending_sync" ? "写入课程草稿"
                  : record.generationJobId && record.generationState === "queued" ? "等待生成任务启动"
                    : record.generationJobId && record.generationState === "running" ? "生成页面讲解"
                : record.autoGenerate === false || record.generationState === "not_requested"
            ? "材料导入完成"
            : !plan
              ? "建立生成队列"
              : planState === "queued"
                ? "等待生成任务启动"
                : planState === "running"
                  ? plan.coreCompletedPageIds && plan.bridgeCompletedPageIds
                    && plan.coreCompletedPageIds.length >= plan.pageIds.length
                    ? "生成跨页承接"
                    : activeJobs.length > 0 ? "生成页面讲解" : "等待任务状态更新"
                  : planState === "completed" ? "全部页面生成完成"
                    : planState === "failed" ? "生成失败"
                      : planState === "cancelled" ? "生成已取消"
                        : planState === "awaiting_review" ? "等待检查"
                          : "生成任务状态未知";

  let progressPercent = explicitPercent(nestedSources(record, plan));
  let progressScope = progressPercent === undefined ? undefined : "整体流程";
  if (record.state === "ready" && record.autoGenerate === false) { progressPercent = 100; progressScope = "材料导入"; }
  if (plan && plan.pageIds.length > 0 && plan.coreCompletedPageIds && plan.bridgeCompletedPageIds) {
    const total = plan.pageIds.length * 2;
    const complete = plan.coreCompletedPageIds.length + plan.bridgeCompletedPageIds.length;
    progressPercent = Math.round(Math.min(1, complete / total) * 100);
    progressScope = "讲解生成";
  } else if (record.state === "processing") {
    const conversion = summarizeImportProgress(record, plan, activeJobs, costs).conversion;
    if (conversion?.total) {
      progressPercent = Math.round(Math.min(1, conversion.completed / conversion.total) * 100);
      progressScope = "页面转换";
    }
  } else if (planState === "running" && plan?.coreCompletedPageIds?.length !== undefined) {
    if (plan.coreCompletedPageIds.length < plan.pageIds.length) {
      progressPercent = Math.round(Math.min(1, plan.coreCompletedPageIds.length / plan.pageIds.length) * 100);
      progressScope = "正文讲解";
    } else if (plan.bridgeCompletedPageIds) {
      progressPercent = Math.round(Math.min(1, plan.bridgeCompletedPageIds.length / plan.pageIds.length) * 100);
      progressScope = "跨页承接";
    }
  }
  if (!plan && record.generationJobId) {
    if (record.state === "ready" && record.generationState === "completed") {
      progressPercent = 100;
      progressScope = "讲解生成";
    } else {
      progressPercent = undefined;
      progressScope = undefined;
    }
  }
  if (planState === "completed") { progressPercent = 100; progressScope = "讲解生成"; }
  if (plan?.retryOfPlanId && record.pageIds?.length && record.generationCompletedPageIds) {
    progressPercent = Math.round(record.generationCompletedPageIds.length / record.pageIds.length * 100);
    progressScope = "讲解生成";
  }
  if (state === "failed" || state === "cancelled" || state === "paused" || state === "awaiting_review") { progressPercent = undefined; progressScope = undefined; }

  const activitySources = nestedSources(record, plan);
  const lastActivityAt = generationActivity?.occurredAt;
  const resolvedLastActivityAt = lastActivityAt
    ?? timestamp([...activitySources, ...activeJobs], ["lastProgressAt", "lastEventAt", "updatedAt", "convertedAt", "createdAt"])
    ?? timestamp(costs, ["createdAt"]);
  const ageSeconds = resolvedLastActivityAt ? Math.max(0, Math.floor((now - Date.parse(resolvedLastActivityAt)) / 1000)) : undefined;
  return {
    stage,
    stageCode: generationActivity?.stage,
    stageStatus: generationActivity?.status,
    phase: generationActivity?.phase,
    phaseStatus: generationActivity?.phaseStatus,
    busy,
    progressPercent,
    progressScope,
    lastActivityAt: resolvedLastActivityAt,
    ageSeconds,
    stale: busy && ageSeconds !== undefined && ageSeconds >= 120
  };
}

export function formatActivityAge(ageSeconds?: number): string {
  if (ageSeconds === undefined) return "暂无可核对的更新时间";
  if (ageSeconds < 60) return `${ageSeconds} 秒前`;
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
}
