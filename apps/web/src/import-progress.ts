import type { GenerationCostEntry, GenerationJob } from "@course-os/contracts";
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
  if (!conversion && record.pageIds?.length) conversion = { completed: record.pageIds.length, total: record.pageIds.length };

  const core = countFromSources(
    coreSources,
    ["core", "bodyCore", "bodyCoreProgress", "coreProgress", "teachingProgress"],
    ["completed", "done", "finished", "completedPages", "completedPageCount", "coreCompleted", "coreCompletedPageCount", "bodyCoreCompleted", "bodyCoreCompletedPageCount"],
    ["total", "totalPages", "pageCount", "totalPageCount", "coreTotal", "coreTotalPageCount", "bodyCoreTotal", "bodyCoreTotalPageCount"]
  ) ?? countFromArrays(coreSources, ["coreCompletedPageIds", "bodyCoreCompletedPageIds"], ["pageIds"], ["coreTotal", "coreTotalPageCount"])
    ?? (plan && plan.pageIds.length > 0 ? { completed: plan.completedPageIds.length, total: plan.pageIds.length } : undefined);

  const crossPage = countFromSources(
    crossPageSources,
    ["crossPage", "crossPageCarryover", "carryover", "handoff", "bridge", "crossPageProgress", "carryoverProgress"],
    ["completed", "done", "finished", "completedPages", "completedPageCount", "crossPageCompleted", "crossPageCompletedPages", "carryoverCompleted", "carryoverCompletedPages"],
    ["total", "totalPages", "pageCount", "totalPageCount", "crossPageTotal", "crossPageTotalPages", "carryoverTotal", "carryoverTotalPages"]
  ) ?? countFromArrays(crossPageSources, ["crossPageCompletedPageIds", "carryoverCompletedPageIds", "bridgeCompletedPageIds"], ["pageIds"], ["crossPageTotal", "carryoverTotal"]);

  const explicitRepairCount = firstNumber(sources, ["repairCount", "repairs", "repairAttempts", "completedRepairCount"])
    ?? firstNumber(progressSources(sources, ["repair", "repairProgress"]), ["count", "completed", "done", "attempts"]);
  const repairCount = explicitRepairCount ?? (costs.length > 0 ? costs.filter((entry) => entry.stage === "repair").length : undefined);

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
  const costUsd = directCost ?? planCost ?? (knownEntryCosts.length > 0 ? entryCostMicrousd / 1_000_000 : undefined);
  const costBasis = directCost !== undefined || planCost !== undefined
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
