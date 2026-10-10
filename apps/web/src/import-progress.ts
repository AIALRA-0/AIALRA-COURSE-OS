import { summarizeImportStageEvents } from "@course-os/contracts";
export { summarizeImportStageEvents } from "@course-os/contracts";
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
  return completed !== undefined && total !== undefined && Number.isInteger(completed) && Number.isInteger(total) && total >= completed ? { completed, total } : undefined;
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
    if (directCompleted !== undefined && directTotal !== undefined && Number.isInteger(directCompleted) && Number.isInteger(directTotal) && directTotal >= directCompleted) {
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
    ?? countFromArrays(sources, ["generationCompletedPageIds"], ["pageIds"], ["coreTotal", "coreTotalPageCount"])
    ?? (plan && plan.pageIds.length > 0 ? { completed: plan.completedPageIds.length, total: plan.pageIds.length }
      : record.generationJobId && record.pageIds?.length
        ? { completed: new Set(record.generationCompletedPageIds ?? []).size, total: record.pageIds.length }
        : undefined);

  let crossPage = countFromSources(
    crossPageSources,
    ["crossPage", "crossPageCarryover", "carryover", "handoff", "bridge", "crossPageProgress", "carryoverProgress"],
    ["completed", "done", "finished", "completedPages", "completedPageCount", "crossPageCompleted", "crossPageCompletedPages", "carryoverCompleted", "carryoverCompletedPages"],
    ["total", "totalPages", "pageCount", "totalPageCount", "crossPageTotal", "crossPageTotalPages", "carryoverTotal", "carryoverTotalPages"]
  ) ?? countFromArrays(crossPageSources, ["crossPageCompletedPageIds", "carryoverCompletedPageIds", "bridgeCompletedPageIds", "generationBridgeCompletedPageIds"], ["pageIds"], ["crossPageTotal", "carryoverTotal"]);
  if (plan?.retryOfPlanId && record.pageIds?.length && record.generationCompletedPageIds) {
    core = { completed: new Set(record.generationCompletedPageIds.filter(id => record.pageIds!.includes(id))).size, total: new Set(record.pageIds).size };
    crossPage = undefined;
  }
  // Explicit core/bridge IDs acknowledge their own saves even if a later stage failed.
  const pageIds = record.pageIds?.length ? record.pageIds : plan?.pageIds;
  if (pageIds?.length) {
    const allowed = new Set(pageIds);
    const count = (ids: unknown): ProgressCount | undefined => Array.isArray(ids)
      ? { completed: new Set(ids.filter((id): id is string => typeof id === "string" && allowed.has(id))).size, total: allowed.size } : undefined;
    const coreIds = record.generationCoreCompletedPageIds ?? (!plan?.retryOfPlanId ? plan?.coreCompletedPageIds : undefined);
    const bridgeIds = record.generationBridgeCompletedPageIds ?? (!plan?.retryOfPlanId ? plan?.bridgeCompletedPageIds : undefined);
    const planProgress = asRecord(plan?.progress);
    core = count(record.generationCoreCompletedPageIds)
      ?? (!plan?.retryOfPlanId ? countFrom(planProgress?.core, ["completed"], ["total"]) ?? count(coreIds) : undefined) ?? core;
    crossPage = count(record.generationBridgeCompletedPageIds)
      ?? (!plan?.retryOfPlanId ? countFrom(planProgress?.crossPage, ["completed"], ["total"]) ?? count(bridgeIds) : undefined) ?? crossPage;
    if (!coreIds && !(asRecord(asRecord(plan?.progress)?.core))) {
      const failed = new Set([...(record.generationFailedPageIds ?? []), ...(plan?.failedPageIds ?? [])]);
      core = count([...(record.generationCompletedPageIds ?? []), ...(plan?.completedPageIds ?? [])].filter(id => !failed.has(id))) ?? core;
    }
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

export type ImportStageProgress = {
  id: string;
  label: string;
  state: "complete" | "active" | "waiting" | "failed" | "stopped" | "unknown" | "skipped";
  count?: ProgressCount;
  detail: string;
  timing?: string;
};

export type ImportSourceEventEvidence = { lastEventId: number; retryAttempt?: number; confirmed?: boolean; pipelineStarted?: boolean };

export function applyImportSourceEvent(previous: ImportSourceEventEvidence, type: string, value: unknown, id: number): ImportSourceEventEvidence {
  const payload = asRecord(value);
  if (!payload || !Number.isInteger(id) || id <= previous.lastEventId) return previous;
  if (type === "readweave.source.retry") {
    const attempt = readNumber(payload, ["attempt"]);
    return attempt !== undefined && Number.isInteger(attempt) && attempt > 0 ? { ...previous, lastEventId: id, retryAttempt: attempt, confirmed: false } : previous;
  }
  if (type === "readweave.source.confirmed") return { ...previous, lastEventId: id, retryAttempt: undefined, confirmed: true };
  if (type === "import.pipeline.started") return { ...previous, lastEventId: id, pipelineStarted: true };
  return previous;
}

export function getImportStageProgress(record: WebImportRecord, plan?: WebGenerationPlan, jobs: readonly GenerationJob[] = [], now = Date.now()): ImportStageProgress[] {
  const summary = summarizeImportProgress(record, plan, jobs, []);
  const standalone = Boolean(standaloneGenerationJobId(record.id ?? ""));
  const taskState = getImportTaskState(record, plan, jobs);
  const stopped = ["failed", "cancelled", "paused", "awaiting_review", "completed"].includes(taskState);
  const generationRequested = record.autoGenerate !== false && record.generationState !== "not_requested";
  const rows: ImportStageProgress[] = [];
  const totalIds = record.pageIds?.length ? record.pageIds : plan?.pageIds;
  const total = totalIds?.length;
  const validIds = totalIds ? new Set(totalIds) : undefined;
  const countIds = (ids: unknown): ProgressCount | undefined => Array.isArray(ids) && total !== undefined
    ? { completed: new Set(ids.filter((id): id is string => typeof id === "string" && (!validIds || validIds.has(id)))).size, total }
    : undefined;
  const coreIds = readValue(record, ["generationCoreCompletedPageIds"]) ?? (!plan?.retryOfPlanId ? plan?.coreCompletedPageIds : undefined);
  const bridgeIds = readValue(record, ["generationBridgeCompletedPageIds"]) ?? (!plan?.retryOfPlanId ? plan?.bridgeCompletedPageIds : undefined);

  const eventSources = [record, plan, ...jobs].map(asRecord).filter((source): source is UnknownRecord => Boolean(source));
  const events = eventSources.flatMap(source => Array.isArray(source.events) ? source.events : []);
  const allowedStreams = new Set([record.id, record.generationJobId, ...(record.generationJobIds ?? []), ...(plan?.jobIds ?? []), ...jobs.map(job => job.id)]);
  const eventSummary = summarizeImportStageEvents(events.filter(value => { const event = asRecord(value); return event && (event.streamId === undefined || allowedStreams.has(String(event.streamId))); }), totalIds ?? []);
  const stageSnapshot = (keys: string[]): UnknownRecord | undefined => {
    for (const source of [...(plan ? [plan] : []), record]) {
      const snapshot = asRecord(asRecord(source)?.stageSummary);
      if (!snapshot) continue;
      for (const key of keys) {
        const stage = asRecord(snapshot[key]);
        if (stage) return stage;
      }
    }
    for (const key of keys) { const stage = asRecord(eventSummary[key]); if (stage) return stage; }
    return undefined;
  };
  const add = (id: string, label: string, state: ImportStageProgress["state"], detail: string, count?: ProgressCount, keys: string[] = [id]) => {
    const snapshot = stageSnapshot(keys);
    const snapshotCount = countFrom(snapshot, ["completed"], ["total"]);
    const running = snapshot && readNumber(snapshot, ["running"]);
    const failed = snapshot && readNumber(snapshot, ["failed"]);
    const skipped = snapshot && readNumber(snapshot, ["skipped"]);
    const snapshotState = snapshot?.state ?? snapshot?.status;
    if (snapshotCount) count = snapshotCount;
    if (running !== undefined && running > 0) { state = stopped && !jobs.some(job => job.state === "running" || job.state === "pending_sync") ? "stopped" : "active"; detail = state === "stopped" ? `${running} 页阶段结果待确认` : `${running} 页处理中`; }
    else if (failed !== undefined && failed > 0 || snapshotState === "failed") { state = "failed"; detail = `阶段失败${failed ? ` · ${failed} 页` : ""}`; }
    else if (snapshotState === "completed" || snapshotState === "complete") { state = "complete"; detail = "已完成"; }
    else if (snapshotState === "running" || snapshotState === "started") { state = stopped ? "stopped" : "active"; detail = stopped ? "已停止" : "处理中"; }
    else if (snapshotState === "skipped") { state = "skipped"; detail = "已跳过"; }
    else if (snapshotCount && snapshotCount.total > 0 && snapshotCount.completed === snapshotCount.total) { state = "complete"; detail = "已完成"; }
    if (running && failed) detail += ` · ${failed} 页失败`;
    if (skipped) detail += ` · ${skipped} 页跳过`;
    const startedAt = timestampMillis(snapshot, "attemptStartedAt") ?? (typeof snapshot?.startedAt === "string" ? Date.parse(snapshot.startedAt) : undefined);
    const endedAt = timestampMillis(snapshot, "endedAt");
    const end = state === "active" ? now : endedAt;
    const duration = startedAt !== undefined && end !== undefined && end >= startedAt ? formatTaskDuration((end - startedAt) / 1000) : undefined;
    rows.push({ id, label, state, count, detail, ...(duration ? { timing: `阶段耗时 ${duration}` } : state === "active" ? { timing: "阶段耗时未记录" } : {}) });
  };

  if (!standalone) {
    add("upload", "上传", "complete", "文件已收到；已建立后台任务");
    const conversionStage = record.conversionProgress?.stage;
    const converting = record.state === "processing" && conversionStage !== "saving_pages";
    const converted = ["syncing", "ready"].includes(record.state) || ["saving_pages", "completed"].includes(conversionStage ?? "");
    const conversionCount = conversionStage === "saving_pages" && record.conversionProgress?.pageCount !== undefined
      ? { completed: record.conversionProgress.pageCount, total: record.conversionProgress.pageCount } : summary.conversion;
    const verifiedConversion = converted && conversionCount && conversionCount.total > 0 && conversionCount.completed === conversionCount.total;
    add("conversion", "转换", conversionStage === "failed" ? "failed" : verifiedConversion ? "complete" : converting ? "active" : converted || stopped ? "unknown" : "waiting",
      conversionStage === "failed" ? "转换失败" : verifiedConversion ? "原图与文字转换完成" : converting ? conversionStageLabel(record) : converted ? "转换已结束，页数待核对" : stopped ? "转换结果待核对" : "等待转换", conversionCount);
    const saving = conversionStage === "saving_pages";
    const registration = record.sourceRegistration;
    const sourceConfirmed = registration?.state === "confirmed" || !registration && record.state === "ready";
    const assetsPrepared = Boolean(record.preparedSourceSha256) || saving && summary.conversion && summary.conversion.total > 0 && summary.conversion.completed === summary.conversion.total;
    const assetsCount = (assetsPrepared || sourceConfirmed) && total ? { completed: total, total } : saving ? summary.conversion : undefined;
    add("source_save", "资料保存", assetsPrepared || sourceConfirmed ? "complete" : saving || record.state === "syncing" ? "active" : stopped ? "unknown" : "waiting",
      sourceConfirmed ? "原图与文字资料已保存" : assetsPrepared ? "原图与文字资料已准备；课程来源另待材料登记确认" : saving ? "正在保存原图与文字资料" : record.state === "syncing" ? "等待资料保存确认" : stopped ? "资料保存结果待核对" : "等待可保存的转换结果", assetsCount);
    add("registration", "材料登记", registration?.state === "failed" ? "failed" : registration?.state === "confirmed" || record.state === "ready" ? "complete" : registration?.state === "pending" || record.state === "syncing" ? "active" : stopped ? "unknown" : "waiting",
      registration?.state === "failed" ? `材料登记失败${registration.issue ? ` · ${registration.issue}` : ""}` : registration?.state === "confirmed" || record.state === "ready" ? "课程材料来源已确认登记" : registration?.state === "pending" ? "材料来源等待权威保存确认；已准备的来源可用于生成" : record.state === "syncing" ? "正在登记课程材料，等待确认" : stopped ? "材料登记结果待核对" : "等待材料登记");
    const sourceRetry = readNumber(record, ["sourceRetryAttempt"]);
    if (registration?.state === "pending" && sourceRetry && Number.isInteger(sourceRetry)) {
      rows.find(row => row.id === "registration")!.detail = `正在自动重试材料来源保存（第 ${sourceRetry} 次），等待权威确认；讲解可并行生成`;
    }
  }

  const activityRows = (keys: string[]) => jobs.filter(job => ["running", "pending_sync"].includes(job.state) && job.latestStageActivity
    && keys.includes(job.latestStageActivity.phase ?? job.latestStageActivity.stage));
  const vision = activityRows(["page_understanding", "visual_understanding", "extract"]);
  const teaching = activityRows(["plan", "teaching", "format_repair", "teach", "repair", "review", "semantic_audit"]);
  const bridging = activityRows(["bridge"]);
  const active = (items: GenerationJob[]) => items.some(job => job.latestStageActivity?.phaseStatus === "started" || (!job.latestStageActivity?.phaseStatus && job.latestStageActivity?.status === "started"));
  const idleState = !generationRequested ? "skipped" : stopped ? "unknown" : "waiting";
  const idleDetail = !generationRequested ? "未启用生成" : stopped ? "阶段结果待核对" : "等待任务进展";
  const savedCore = summary.core ?? countIds(coreIds);
  const savedBridge = summary.crossPage ?? countIds(bridgeIds);
  const coreComplete = savedCore && savedCore.total > 0 && savedCore.completed === savedCore.total;
  add("vision", "识图", active(vision) ? "active" : idleState, active(vision) ? "正在理解页面图文" : idleDetail, undefined, ["vision", "visual_understanding", "page_understanding", "extract"]);
  add("generation", "生成", active(teaching) ? "active" : coreComplete ? "complete" : idleState,
    active(teaching) ? "正在生成、检查或修复正文" : coreComplete ? "正文已生成" : idleDetail, coreComplete ? savedCore : undefined, ["generation", "teaching", "teach"]);
  const pendingSync = jobs.some(job => job.state === "pending_sync") || record.generationState === "pending_sync";
  add("core_save", "正文保存", coreComplete ? "complete" : pendingSync ? "active" : idleState,
    coreComplete ? "正文已保存，可阅读" : pendingSync ? "正在保存生成结果，等待确认" : savedCore?.completed ? "已有正文可阅读，其余等待保存确认" : idleDetail, generationRequested ? savedCore : undefined, ["core_save", "core_saved"]);
  const bridgeComplete = savedBridge && savedBridge.total > 0 && savedBridge.completed === savedBridge.total;
  add("bridge", "承接", active(bridging) ? "active" : bridgeComplete ? "complete" : idleState,
    active(bridging) ? "正在生成跨页承接" : bridgeComplete ? "跨页承接已保存" : idleDetail, generationRequested ? savedBridge : undefined);
  const generation = rows.find(row => row.id === "generation")!;
  const saving = rows.find(row => row.id === "core_save")!;
  const generated = generation.count;
  const saved = saving.count;
  const pending = stageSnapshot(["core_save", "core_saved"]);
  const pendingCount = pending && readNumber(pending, ["pendingSave"]);
  const retryCount = pending && readNumber(pending, ["storageRetrying"]);
  const awaitingSave = pendingCount ?? (generated && saved && generated.total === saved.total ? Math.max(0, generated.completed - saved.completed) : undefined);
  if (awaitingSave && generationRequested) {
    saving.detail = `${awaitingSave} 页内容已生成，等待正文保存确认${retryCount ? ` · ${retryCount} 页正在自动重试保存` : ""}`;
    if (!stopped) saving.state = "active";
  }
  else if (retryCount && generationRequested) { saving.detail = `${retryCount} 页正在自动重试保存，等待确认`; if (!stopped) saving.state = "active"; }
  const savedIds = new Set(Array.isArray(coreIds) ? coreIds : [...(record.generationCompletedPageIds ?? []), ...(plan?.completedPageIds ?? [])]);
  const resultAwaitingSave = jobs.some(job => job.state === "running" && job.pageIds?.some(id => !savedIds.has(id))
    && (job.latestStageActivity?.phase === "teaching" && job.latestStageActivity.phaseStatus === "completed"
      || ["teach", "review"].includes(job.latestStageActivity?.stage ?? "") && !job.latestStageActivity?.phase && job.latestStageActivity?.status === "completed"));
  if (!awaitingSave && resultAwaitingSave && generationRequested) {
    saving.state = "active";
    saving.detail = "已收到生成内容，等待正文保存确认";
  }
  if (generation.state === "failed") generation.detail = `生成阶段失败${generation.count ? ` · 已生成 ${formatProgressCount(generation.count)} 页` : ""}`;
  return rows;
}

export function importStageStateLabel(state: ImportStageProgress["state"]): string {
  return ({ complete: "已完成", active: "运行中", waiting: "等待中", failed: "失败", stopped: "已停止", unknown: "待核对", skipped: "已跳过" })[state];
}

/** Upload bytes are transport evidence only, never import acceptance. */
export function formatUploadStatus(sent: number, total?: number): string {
  return Number.isFinite(sent) && sent >= 0 && total !== undefined && Number.isFinite(total) && total > 0 && sent <= total
    ? `正在上传 ${Math.floor(sent / total * 100)}%`
    : "正在上传文件";
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
  const normalIntervalNote = "（含本次排队时间）";
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
  const stage = (record.state === "ready" || record.state === "syncing") && generationActivity
    ? stageLabels[generationActivity.stage]
    : record.state === "quarantined" || record.state === "accepted"
    ? "等待转换"
    : record.state === "processing"
      ? conversionStageLabel(record)
      : record.state === "syncing"
        ? "保存材料来源"
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
