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
  ) ?? countFromArrays(coreSources, ["coreCompletedPageIds", "bodyCoreCompletedPageIds", "generationCoreCompletedPageIds"], ["pageIds"], ["coreTotal", "coreTotalPageCount"])
    ?? (plan && plan.pageIds.length > 0 ? { completed: plan.completedPageIds.length, total: plan.pageIds.length }
      : record.generationJobId && record.pageIds?.length
        ? { completed: new Set(record.generationCompletedPageIds ?? []).size, total: record.pageIds.length }
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
  const accountedEntryCosts = costs.filter((entry) => entry.costBasis !== "not_available" || entry.estimatedMicrousd > 0);
  const entryCostMicrousd = accountedEntryCosts.reduce((sum, entry) => sum + (entry.costBasis === "provider_reported" && entry.actualMicrousd !== null ? entry.actualMicrousd : entry.estimatedMicrousd), 0);
  const trustedDirectCost = directCost && directCost > 0 ? directCost : undefined;
  const trustedPlanCost = planCost && planCost > 0 ? planCost : undefined;
  const cumulativeEntryCost = plan?.retryOfPlanId && accountedEntryCosts.length > 0 ? entryCostMicrousd / 1_000_000 : undefined;
  const candidateCost = cumulativeEntryCost ?? trustedDirectCost ?? trustedPlanCost
    ?? (accountedEntryCosts.length > 0 ? entryCostMicrousd / 1_000_000 : directCost ?? planCost);
  const unverifiedZero = candidateCost === 0 && accountedEntryCosts.length === 0 && Boolean(plan &&
    (plan.state === "running" || plan.state === "queued" || plan.completedPageIds.length + plan.failedPageIds.length > 0));
  const costUsd = unverifiedZero ? undefined : candidateCost;
  const costBasis = cumulativeEntryCost === undefined && (trustedDirectCost !== undefined || trustedPlanCost !== undefined)
    ? undefined
    : accountedEntryCosts.length === 0
      ? undefined
      : accountedEntryCosts.every((entry) => entry.costBasis === "provider_reported" && entry.actualMicrousd !== null)
        ? "reported"
        : accountedEntryCosts.every((entry) => entry.costBasis === "price_snapshot" || entry.costBasis === "not_available")
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

export type ImportTaskAction = "open_draft" | "generate" | "retry_failed";

export type ImportTaskStatus = {
  state: ImportTaskState;
  fact: string;
  action?: ImportTaskAction;
};

export type ImportTaskPollMode = "active" | "idle" | "stopped";

function jobState(job: GenerationJob): string | undefined {
  const value = asRecord(job)?.state;
  return typeof value === "string" ? value : undefined;
}

function jobMatchesRecord(job: GenerationJob, record: Pick<WebImportRecord, "id" | "generationJobId">): boolean {
  const standaloneId = typeof record.id === "string" ? standaloneGenerationJobId(record.id) : undefined;
  return job.id === record.generationJobId || job.id === standaloneId;
}

function currentTaskJob(record: Pick<WebImportRecord, "id" | "generationJobId">, jobs: readonly GenerationJob[]): GenerationJob | undefined {
  const matched = jobs.find(job => jobMatchesRecord(job, record));
  if (matched) return matched;
  return [...jobs].reverse().find(job => ["queued", "running", "pending_sync", "paused"].includes(jobState(job) ?? ""))
    ?? jobs.at(-1);
}

export function getImportTaskState(
  record: Pick<WebImportRecord, "state" | "generationState" | "autoGenerate" | "id" | "generationJobId">,
  plan?: WebGenerationPlan,
  jobs: readonly GenerationJob[] = []
): ImportTaskState {
  const importState = record.state;
  if (importState === "failed" || importState === "rejected") return "failed";
  if (importState === "processing" || importState === "syncing") return "running";
  if (importState === "accepted" || importState === "quarantined") return "queued";

  const activeJob = jobs.find(job => ["running", "pending_sync"].includes(jobState(job) ?? ""));
  const queuedJob = jobs.find(job => jobState(job) === "queued");
  const pausedJob = jobs.find(job => jobState(job) === "paused");
  if (activeJob) return "running";
  if (queuedJob) return "queued";
  if (pausedJob) return "paused";

  const planState = typeof plan?.state === "string" ? plan.state : undefined;
  const state = planState ?? record.generationState;
  if (state === "failed") return "failed";
  if (state === "cancelled") return "cancelled";
  if (state === "paused") return "paused";
  if (state === "awaiting_review") return "awaiting_review";
  if (state === "completed") return "completed";
  if (state === "running" || state === "pending_sync") return "running";
  if (state === "queued") return "queued";
  if (record.state === "ready" && (record.autoGenerate === false || state === "not_requested")) return "completed";
  return record.state === "ready" ? "queued" : "running";
}

type TaskPageCounts = { total: number; completed: number; failed: number };

function taskPageCounts(record: WebImportRecord, plan?: WebGenerationPlan, jobs: readonly GenerationJob[] = []): TaskPageCounts {
  const recordPages = Array.isArray(record.pageIds) ? record.pageIds.filter((id): id is string => typeof id === "string") : [];
  const planPages = Array.isArray(plan?.pageIds) ? plan.pageIds : [];
  const retryPlan = Boolean(plan?.retryOfPlanId);
  const allPageIds = retryPlan ? recordPages : planPages.length > 0 ? planPages : recordPages;
  const totalIds = new Set([...allPageIds, ...jobs.flatMap(job => Array.isArray(job.pageIds) ? job.pageIds : [])]);
  const completedIds = new Set([
    ...(Array.isArray(record.generationCompletedPageIds) ? record.generationCompletedPageIds : []),
    ...(Array.isArray(plan?.completedPageIds) ? plan.completedPageIds : []),
    ...jobs.flatMap(job => Array.isArray(job.completedPageIds) ? job.completedPageIds : [])
  ]);
  const failedIds = new Set([
    ...(Array.isArray(record.generationFailedPageIds) ? record.generationFailedPageIds : []),
    ...(Array.isArray(plan?.failedPageIds) ? plan.failedPageIds : []),
    ...jobs.flatMap(job => Array.isArray(job.failedPageIds) ? job.failedPageIds : [])
  ]);
  const activeIds = new Set(jobs.filter(job => ["queued", "running", "pending_sync"].includes(jobState(job) ?? "")
    || plan?.activeJobIds?.includes(job.id)).flatMap(job => Array.isArray(job.pageIds) ? job.pageIds : []));
  const failed = [...failedIds].filter(id => !completedIds.has(id) && !activeIds.has(id));
  const completed = [...completedIds].filter(id => !failedIds.has(id));
  return {
    total: totalIds.size || Math.max(completed.length + failed.length, 0),
    completed: completed.length,
    failed: failed.length
  };
}

function hasGenerationEvidence(record: WebImportRecord, plan?: WebGenerationPlan, jobs: readonly GenerationJob[] = []): boolean {
  return Boolean(plan || jobs.length || record.generationJobId || record.generationPlanId
    || (record.generationState && record.generationState !== "not_requested"));
}

export function getImportTaskStatus(
  record: WebImportRecord,
  plan?: WebGenerationPlan,
  jobs: readonly GenerationJob[] = [],
  retryingFailed = false
): ImportTaskStatus {
  const state = getImportTaskState(record, plan, jobs);
  if (record.state === "failed" || record.state === "rejected") return { state, fact: "材料导入失败" };
  if (record.state !== "ready") {
    return { state, fact: state === "queued" ? "材料正在等待转换" : "材料正在导入" };
  }

  const hasGeneration = hasGenerationEvidence(record, plan, jobs);
  if (!hasGeneration && (record.autoGenerate === false || record.generationState === "not_requested")) {
    return { state, fact: "材料已导入，讲解未生成", action: "generate" };
  }
  if (retryingFailed) return { state, fact: "正在重试失败页面" };

  const counts = taskPageCounts(record, plan, jobs);
  if (counts.failed > 0) {
    const fact = counts.completed > 0
      ? `讲解部分生成：${counts.completed}/${counts.total || "?"} 页已生成，${counts.failed} 页失败`
      : `讲解生成失败：${counts.failed} 页失败${counts.total ? `（共 ${counts.total} 页）` : ""}`;
    return { state, fact, ...(state === "failed" ? { action: "retry_failed" as const } : {}) };
  }

  if (state === "awaiting_review") {
    const allPagesSaved = counts.total > 0 && counts.completed >= counts.total;
    return allPagesSaved
      ? { state, fact: "讲解草稿已生成，可阅读；尚未发布", action: "open_draft" }
      : { state, fact: "任务状态需同步；当前没有可确认的待办项" };
  }
  if (state === "paused") return { state, fact: "讲解生成已暂停" };
  if (state === "cancelled") return { state, fact: "讲解生成已取消" };
  if (state === "queued") return { state, fact: "讲解任务排队中" };
  if (state === "running") return { state, fact: "正在生成讲解" };

  if (state === "failed") return { state, fact: "讲解生成失败；失败页面数量暂不可核对" };
  if (state === "completed") {
    if (counts.total > 0 && counts.completed < counts.total) {
      return { state, fact: `任务状态需同步；已保存 ${counts.completed}/${counts.total} 页讲解` };
    }
    return { state, fact: "讲解草稿已生成，可阅读；尚未发布", action: "open_draft" };
  }
  return { state, fact: "讲解生成状态暂不可核对" };
}

export function getImportTaskPollingMode(
  record: Pick<WebImportRecord, "state" | "generationState" | "autoGenerate" | "id" | "generationJobId">,
  plan?: WebGenerationPlan,
  jobs: readonly GenerationJob[] = []
): ImportTaskPollMode {
  if (record.state === "failed" || record.state === "rejected") return "stopped";
  if (record.state === "accepted" || record.state === "quarantined" || record.state === "processing" || record.state === "syncing") return "active";
  const state = getImportTaskState(record, plan, jobs);
  if (state === "queued" || state === "running") return "active";
  if (state === "paused" || state === "awaiting_review") return "idle";
  return "stopped";
}

export type ImportTaskTiming = {
  state: ImportTaskState;
  phase: "queued" | "running" | "paused" | "awaiting_review" | "ended";
  attempt?: number;
  elapsedSeconds?: number;
  label: string;
};

function timestampMillis(source: unknown, key: "attemptStartedAt" | "endedAt"): number | undefined {
  const value = asRecord(source)?.[key];
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatTaskDuration(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const total = Math.floor(seconds);
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  if (minutes < 60) return `${minutes} 分${remainder ? ` ${remainder} 秒` : ""}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours} 小时${remainingMinutes ? ` ${remainingMinutes} 分` : ""}`;
}

export function getImportTaskTiming(
  record: WebImportRecord,
  plan?: WebGenerationPlan,
  jobs: readonly GenerationJob[] = [],
  now = Date.now()
): ImportTaskTiming {
  const state = getImportTaskState(record, plan, jobs);
  const phase: ImportTaskTiming["phase"] = state === "queued" ? "queued"
    : state === "running" ? "running"
      : state === "paused" ? "paused"
        : state === "awaiting_review" ? "awaiting_review" : "ended";
  const job = currentTaskJob(record, jobs);
  const generation = record.state === "ready" && hasGenerationEvidence(record, plan, jobs);

  let timingSource: unknown = record;
  if (generation && plan) {
    timingSource = plan;
    if ((phase === "running" || phase === "paused") && timestampMillis(plan, "attemptStartedAt") === undefined && job) timingSource = job;
  } else if (generation && job) {
    timingSource = job;
  }

  const attemptValue = asRecord(timingSource)?.attempt ?? asRecord(job)?.attempt;
  const attempt = typeof attemptValue === "number" && Number.isInteger(attemptValue) && attemptValue > 0 ? attemptValue : undefined;
  let elapsedSeconds: number | undefined;
  if (phase !== "queued") {
    const startedAt = timestampMillis(timingSource, "attemptStartedAt");
    const stopped = phase !== "running";
    const endedAt = stopped ? timestampMillis(timingSource, "endedAt") : Number.isFinite(now) ? now : undefined;
    if (startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt) {
      elapsedSeconds = (endedAt - startedAt) / 1000;
    }
  }

  const duration = elapsedSeconds === undefined ? undefined : formatTaskDuration(elapsedSeconds);
  const normalIntervalNote = "（首轮含排队，重试从重新运行开始）";
  const label = phase === "queued" ? "排队中"
    : phase === "running" ? duration ? `本次耗时 ${duration}${normalIntervalNote}` : "运行中，耗时暂不可核对"
      : phase === "paused" ? duration ? `本次耗时 ${duration}${normalIntervalNote}` : "已暂停，耗时未记录"
        : phase === "awaiting_review" ? duration ? `本次耗时 ${duration}${normalIntervalNote}` : "耗时未记录"
          : duration ? `本次耗时 ${duration}${normalIntervalNote}` : "已结束，耗时未记录";
  return { state, phase, ...(attempt !== undefined ? { attempt } : {}), ...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}), label };
}

export function importTaskStateLabel(state: ImportTaskState): string {
  return ({
    queued: "排队中",
    running: "正在处理",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    paused: "已暂停",
    awaiting_review: "已停止，查看详情"
  } satisfies Record<ImportTaskState, string>)[state];
}

export function importProgressTitle(record: WebImportRecord, plan: WebGenerationPlan | undefined, retryingFailed: boolean): string {
  return getImportTaskStatus(record, plan, [], retryingFailed).fact;
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
  overall?: ProgressCount;
  lastActivityAt?: string;
  ageSeconds?: number;
  stale: boolean;
};

function conversionStageLabel(record: WebImportRecord): string {
  const stage = asRecord(record.conversionProgress)?.stage;
  return typeof stage === "string" ? ({ queued: "等待转换", preparing: "准备转换工具", counting_pages: "识别总页数", rendering_pages: "转换原图", extracting_text: "提取页面文字", finalizing: "核对转换结果", saving_pages: "保存原图", completed: "转换完成", failed: "转换失败" } as Record<string, string>)[stage] || "页面转换" : "页面转换";
}

/** Completed IDs mean the existing delivery contract is saved, not just processed. */
export function deliveredPageProgress(record: WebImportRecord, plan?: WebGenerationPlan): ProgressCount | undefined {
  const ids = record.pageIds?.length ? record.pageIds : plan?.pageIds;
  const total = ids?.length || readNumber(asRecord(record.conversionProgress) ?? {}, ["totalPages", "total", "pageCount"]);
  if (!total) return undefined;
  if (record.autoGenerate === false || record.generationState === "not_requested") {
    return { completed: record.state === "ready" ? new Set(ids ?? []).size : 0, total };
  }
  const failed = new Set([...(record.generationFailedPageIds ?? []), ...(plan?.failedPageIds ?? [])]);
  const valid = ids ? new Set(ids) : undefined;
  const saved = record.generationCompletedPageIds ?? plan?.completedPageIds ?? [];
  const completed = new Set(saved.filter(id => !failed.has(id) && (!valid || valid.has(id)))).size;
  return { completed: Math.min(total, completed), total };
}

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
  const state = getImportTaskState(record, plan, activeJobs);
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
    ? "等待转换"
    : record.state === "processing"
      ? conversionStageLabel(record)
      : record.state === "syncing"
        ? "写入课程草稿"
        : record.state !== "ready"
          ? "导入已停止"
        : record.generationState === "failed" ? "生成失败"
          : record.generationState === "cancelled" ? "生成已取消"
              : record.generationState === "paused" ? "生成已暂停"
                : state === "awaiting_review" ? getImportTaskStatus(record, plan, activeJobs).fact
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
                      : planState === "awaiting_review" ? getImportTaskStatus(record, plan, activeJobs).fact
                          : "生成任务状态未知";

  const overall = deliveredPageProgress(record, plan);
  const progressPercent = overall ? Math.round(overall.completed / overall.total * 100) : undefined;
  const progressScope = overall ? "总完成度" : undefined;

  const activitySources = nestedSources(record, plan);
  const lastActivityAt = generationActivity?.occurredAt;
  const resolvedLastActivityAt = lastActivityAt
    ?? timestamp([record.conversionProgress], ["updatedAt"])
    ?? timestamp([record, plan], ["lastProgressAt", "convertedAt", "createdAt"])
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
    overall,
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
