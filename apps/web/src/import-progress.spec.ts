import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GenerationCostEntry, GenerationJob } from "@course-os/contracts";
import { describe, expect, it } from "vitest";
import { applyImportSourceEvent, deliveredPageProgress, formatActivityAge, formatProgressCount, getImportActivity, getImportStageProgress, getImportTaskPollingMode, getImportTaskState, getImportTaskStatus, getImportTaskTiming, importProgressTitle, importTaskStateLabel, standaloneGenerationJobId, summarizeImportProgress, summarizeImportStageEvents } from "./import-progress.js";
import type { WebGenerationPlan, WebImportRecord } from "./types.js";
import { formatTaskConcurrency, ImportProgress } from "./App.js";

function record(value: Record<string, unknown>): WebImportRecord {
  return value as unknown as WebImportRecord;
}

describe("task concurrency display", () => {
  it("reports occupied core slots separately from tasks waiting for storage", () => {
    const activeJobs = Array.from({ length: 16 }, (_, index) => ({ id: `job-${index}`, state: "running" })) as GenerationJob[];
    const source = record({ state: "ready", pageIds: [], issues: [] });
    const currentPlan = plan({ state: "running", pageIds: [], completedPageIds: [], failedPageIds: [], maxConcurrency: 14, progress: { concurrency: { running: 2, limit: 14 } } });
    const summary = summarizeImportProgress(source, currentPlan, activeJobs, []);
    expect(summary.concurrency).toEqual({ running: 2, limit: 14 });
    expect(formatTaskConcurrency(summary.concurrency)).toBe("2 页正在生成正文 · 正文并发上限14");
    expect(activeJobs).toHaveLength(16);
    expect(currentPlan.maxConcurrency).toBe(14);
  });
  it.each([
    [{ running: 16 }, "16 页正在生成正文 · 正文并发上限待确认"],
    [{ limit: 14 }, "正文生成并发待确认 · 正文并发上限14"],
    [{ running: 0, limit: 14 }, "0 页正在生成正文 · 正文并发上限14"],
    [undefined, "—"]
  ])("keeps unavailable metrics unknown for %j", (value, expected) => {
    expect(formatTaskConcurrency(value)).toBe(expected);
  });
});

function plan(value: Record<string, unknown>): WebGenerationPlan {
  return value as unknown as WebGenerationPlan;
}

describe("actual pipeline stages", () => {
  const ids = ["p1", "p2", "p3", "p4"];
  const source = () => record({ id: "import-stages", state: "ready", autoGenerate: true, generationState: "running", pageIds: ids, issues: [], generationCompletedPageIds: [], generationFailedPageIds: [] });
  const current = (value: Record<string, unknown> = {}) => plan({ id: "plan-stages", state: "running", pageIds: ids, completedPageIds: [], failedPageIds: [], ...value });
  const step = (rows: ReturnType<typeof getImportStageProgress>, id: string) => rows.find(row => row.id === id)!;

  it("keeps conversion and source saving visible before any body exists", () => {
    const rows = getImportStageProgress(record({ id: "import-stages", state: "processing", autoGenerate: true,
      conversionProgress: { stage: "saving_pages", pageCount: 4, completedPages: 2 } }));
    expect(rows.map(row => row.label)).toEqual(["上传", "转换", "资料保存", "材料登记", "识图", "生成", "正文保存", "承接"]);
    expect(step(rows, "conversion")).toMatchObject({ state: "complete", count: { completed: 4, total: 4 } });
    expect(step(rows, "source_save")).toMatchObject({ state: "active", count: { completed: 2, total: 4 } });
    expect(step(rows, "core_save").count).toBeUndefined();
  });

  it("keeps unknown total and stage duration unknown instead of inventing a count", () => {
    const rows = getImportStageProgress(record({ state: "processing", conversionProgress: { stage: "counting_pages", completedPages: 0 } }));
    expect(step(rows, "conversion")).toMatchObject({ state: "active", detail: "识别总页数", timing: "阶段耗时未记录" });
    expect(step(rows, "conversion").count).toBeUndefined();
  });

  it("shows prepared source, pending registration and live model work together while syncing", () => {
    const syncing = { ...source(), state: "syncing" as const, preparedSourceSha256: "prepared-hash", sourceRegistration: { state: "pending" as const, updatedAt: "2026-10-01T00:00:00Z" } };
    const jobs = [{ id: "job-1", state: "running", pageIds: ["p1"], latestStageActivity: { stage: "teach", status: "started", phase: "teaching", phaseStatus: "started", occurredAt: "2026-10-01T00:00:01Z" } }] as GenerationJob[];
    const rows = getImportStageProgress(syncing, current(), jobs);
    expect(step(rows, "source_save")).toMatchObject({ state: "complete", detail: "原图与文字资料已准备；课程来源另待材料登记确认" });
    expect(step(rows, "registration")).toMatchObject({ state: "active", detail: "材料来源等待权威保存确认；已准备的来源可用于生成" });
    expect(step(rows, "generation").state).toBe("active");
    expect(step(rows, "core_save").count).toEqual({ completed: 0, total: 4 });
    expect(getImportActivity(syncing, current(), jobs, []).stage).toBe("正文讲解");
    const confirmed = getImportStageProgress({ ...syncing, sourceRegistration: { ...syncing.sourceRegistration, state: "confirmed" } }, current(), jobs);
    expect(step(confirmed, "registration").state).toBe("complete");
    const rejected = getImportStageProgress({ ...syncing, sourceRegistration: { ...syncing.sourceRegistration, state: "failed", issue: "来源写入失败" } }, current(), jobs);
    expect(step(rejected, "registration").state).toBe("failed");
    expect(step(rejected, "source_save").state).toBe("complete");
  });

  it("counts real events once and keeps generated, saved, failed and skipped outcomes distinct", () => {
    const event = (id: number, type: string, payload: Record<string, unknown>) => ({ id, type, occurredAt: "2026-10-01T00:00:00Z", streamId: "job-1", payload });
    const events = [
      event(1, "generation.stage.started", { pageId: "p1", stage: "extract", activity: "visual_understanding" }),
      event(2, "generation.stage.completed", { pageId: "p1", stage: "extract", activity: "visual_understanding" }),
      event(3, "generation.stage.skipped", { pageId: "p2", stage: "extract", activity: "visual_understanding" }),
      event(4, "generation.stage.completed", { pageId: "p1", stage: "teach" }),
      event(5, "generation.page.storage_retry", { pageId: "p1", reusedTeaching: true, attempt: 1 }),
      event(6, "generation.page.storage_retry", { pageId: "p1", reusedTeaching: true, attempt: 2 }),
      event(7, "generation.page.failed", { pageId: "p3", issue: "PROVIDER_TIMEOUT" }),
      event(8, "generation.stage.completed", { pageId: "foreign", stage: "teach" })
    ];
    const snapshot = summarizeImportStageEvents([...events, events[5]!], ids);
    expect(snapshot.vision).toMatchObject({ completed: 1, skipped: 1, total: 4 });
    expect(snapshot.generation).toMatchObject({ completed: 1, failed: 1, total: 4 });
    expect(snapshot.core_save).toMatchObject({ completed: 0, total: 4, pendingSave: 1, storageRetrying: 1 });
    const rows = getImportStageProgress(source(), current({ jobIds: ["job-1"], events }));
    expect(step(rows, "core_save").detail).toBe("1 页内容已生成，等待正文保存确认 · 1 页正在自动重试保存");
    const completed = summarizeImportStageEvents([...events, event(9, "generation.page.core_saved", { pageId: "p1" }), event(10, "generation.page.core_saved", { pageId: "p1", bridgeCompleted: true }), event(11, "generation.stage.completed", { pageId: "p1", phase: "bridge", stage: "teach" })], ids);
    expect(completed.core_save).toMatchObject({ completed: 1, pendingSave: 0, storageRetrying: 0 });
    expect(completed.bridge).toMatchObject({ completed: 1 });
  });

  it("settles a terminal incomplete page only when its failure event is included", () => {
    const event = (id: number, type: string, payload: Record<string, unknown>) => ({ id, type, streamId: "job-1", payload });
    const events = [
      event(1, "generation.stage.started", { pageId: "p1", stage: "teach" }),
      event(2, "generation.page.failed", { pageId: "p1", issue: "GENERATION_CORE_FULL_EXPLANATION_REQUIRED" }),
      event(3, "generation.page.core_saved", { pageId: "p2", bridgeCompleted: false }),
      event(4, "generation.stage.started", { pageId: "p2", stage: "teach", phase: "bridge" }),
      event(5, "generation.stage.skipped", { pageId: "p2", stage: "teach", phase: "bridge", incomplete: true, coreReadable: true }),
      event(6, "generation.page.failed", { pageId: "p2", issue: "PROVIDER_TIMEOUT" })
    ];
    // A filtered history cannot establish that the previously started model stopped.
    const withoutFailures = summarizeImportStageEvents(events.filter(event => event.type !== "generation.page.failed"), ["p1", "p2"]);
    expect(withoutFailures.generation).toMatchObject({ running: 1, failed: 0 });
    const completeHistory = summarizeImportStageEvents(events, ["p1", "p2"]);
    expect(completeHistory.generation).toMatchObject({ completed: 1, running: 0, failed: 1 });
    expect(completeHistory.core_save).toMatchObject({ completed: 1, pendingSave: 0 });
    expect(completeHistory.bridge).toMatchObject({ completed: 0, running: 0, failed: 1 });
  });

  it("settles storage retry failure separately from returned teaching and later save confirmation", () => {
    const event = (id: number, type: string, payload: Record<string, unknown>) => ({ id, type, streamId: "job-1", payload });
    const events = [
      event(1, "generation.stage.completed", { pageId: "p1", stage: "teach" }),
      event(2, "generation.stage.completed", { pageId: "p1", stage: "review" }),
      event(3, "generation.page.storage_retry", { pageId: "p1", reusedTeaching: true, attempt: 1 })
    ];
    const retrying = summarizeImportStageEvents(events, ["p1"]);
    expect(retrying.generation).toMatchObject({ completed: 1, running: 0, failed: 0 });
    expect(retrying.core_save).toMatchObject({ completed: 0, running: 1, pendingSave: 1, storageRetrying: 1 });
    const failedEvents = [...events, event(4, "generation.page.failed", { pageId: "p1", issue: "READWEAVE_UNAVAILABLE", failureRoute: { category: "storage" } })];
    const failed = summarizeImportStageEvents(failedEvents, ["p1"]);
    expect(failed.generation).toMatchObject({ completed: 1, running: 0, failed: 0 });
    expect(failed.core_save).toMatchObject({ completed: 0, running: 0, failed: 1, pendingSave: 1, storageRetrying: 0 });
    const confirmed = summarizeImportStageEvents([...failedEvents, event(5, "generation.page.core_saved", { pageId: "p1" })], ["p1"]);
    expect(confirmed.core_save).toMatchObject({ completed: 1, running: 0, failed: 0, pendingSave: 0, storageRetrying: 0 });
  });

  it("keeps source retries automatic and ignores replayed or out-of-order import events", () => {
    const started = applyImportSourceEvent({ lastEventId: 0 }, "import.pipeline.started", { planId: "plan-1" }, 3);
    const retry = applyImportSourceEvent(started, "readweave.source.retry", { attempt: 2 }, 4);
    expect(retry).toMatchObject({ pipelineStarted: true, retryAttempt: 2, confirmed: false });
    const rows = getImportStageProgress({ ...source(), state: "syncing", sourceRegistration: { state: "pending", updatedAt: "2026-10-01T00:00:00Z" }, sourceRetryAttempt: retry.retryAttempt }, current());
    expect(step(rows, "registration").detail).toBe("正在自动重试材料来源保存（第 2 次），等待权威确认；讲解可并行生成");
    const confirmed = applyImportSourceEvent(retry, "readweave.source.confirmed", { pages: 4 }, 5);
    expect(confirmed.retryAttempt).toBeUndefined();
    expect(applyImportSourceEvent(confirmed, "readweave.source.retry", { attempt: 2 }, 4)).toBe(confirmed);
    expect(applyImportSourceEvent(confirmed, "generation.pipeline.started", {}, 6)).toBe(confirmed);
  });

  it("prefers saved-page counters aggregated from server events over an older plan ID array", () => {
    const result = summarizeImportProgress(source(), current({ coreCompletedPageIds: [], bridgeCompletedPageIds: [],
      progress: { core: { completed: 2, total: 4 }, crossPage: { completed: 1, total: 4 } }
    }), [], []);
    expect(result.core).toEqual({ completed: 2, total: 4 });
    expect(result.crossPage).toEqual({ completed: 1, total: 4 });
  });

  it("renders live teaching beside pending authoritative registration rather than a save-only status", () => {
    const markup = renderToStaticMarkup(createElement(ImportProgress, {
      record: { ...source(), state: "syncing", preparedSourceSha256: "prepared", sourceRegistration: { state: "pending", updatedAt: "2026-10-01T00:00:00Z" } },
      plan: current(), activeJobs: [{ id: "job-1", state: "running", pageIds: ["p1"], latestStageActivity: { stage: "teach", status: "started", phase: "teaching", phaseStatus: "started" } } as GenerationJob],
      costs: [], costReadUnavailable: false, retryingFailed: false,
      onRetryFailed: () => {}, onClose: () => {}, onOpen: () => {}, onGenerate: () => {}
    }));
    expect(markup).toContain("材料保存与讲解生成正在并行进行");
    expect(markup).toContain('data-stage="registration" data-milestone-state="active"');
    expect(markup).toContain('data-stage="generation" data-milestone-state="active"');
    expect(markup).toContain("当前阶段</dt><dd>材料登记、生成");
    expect(markup).not.toContain("写入课程草稿");
  });

  it("shows vision, generation and carryover running at the same time from existing stage activity", () => {
    const jobs = [
      { phase: "page_understanding", stage: "extract" }, { phase: "teaching", stage: "teach" }, { phase: "bridge", stage: "teach" }
    ].map((activity, index) => ({ id: `job-${index}`, state: "running", pageIds: [ids[index]!], latestStageActivity: { ...activity, status: "started", phaseStatus: "started" } })) as GenerationJob[];
    const rows = getImportStageProgress(source(), current({ coreCompletedPageIds: ["p1"], bridgeCompletedPageIds: [] }), jobs);
    expect(["vision", "generation", "bridge"].map(id => step(rows, id).state)).toEqual(["active", "active", "active"]);
    expect(step(rows, "vision").count).toBeUndefined();
    expect(step(rows, "core_save").count).toEqual({ completed: 1, total: 4 });
  });

  it("separates generated content awaiting automatic storage retries from model failure", () => {
    const rows = getImportStageProgress(source(), current({ coreCompletedPageIds: ["p1"], bridgeCompletedPageIds: [], stageSummary: {
      generation: { completed: 3, total: 4, running: 1, failed: 0 },
      core_save: { completed: 1, total: 4, pendingSave: 2, storageRetrying: 1 }
    } }));
    expect(step(rows, "generation")).toMatchObject({ state: "active", count: { completed: 3, total: 4 } });
    expect(step(rows, "core_save")).toMatchObject({ state: "active", count: { completed: 1, total: 4 }, detail: "2 页内容已生成，等待正文保存确认 · 1 页正在自动重试保存" });
    expect(step(rows, "core_save").detail).not.toContain("按");
  });

  it("does not count failed or skipped vision pages as successful completion", () => {
    const rows = getImportStageProgress(source(), current({ stageSummary: {
      vision: { completed: 2, total: 4, failed: 1, skipped: 1 },
      generation: { completed: 1, total: 4, failed: 1 }
    } }));
    expect(step(rows, "vision")).toMatchObject({ state: "failed", count: { completed: 2, total: 4 } });
    expect(step(rows, "generation").state).toBe("failed");
    expect(step(rows, "generation").detail).toContain("生成阶段失败");
  });

  it("recognizes a returned teaching result without presenting it as saved or assigning an unproved page total", () => {
    for (const activity of [{ stage: "teach", status: "completed", phase: "teaching", phaseStatus: "completed" }, { stage: "review", status: "completed" }]) {
      const job = { id: "job-1", state: "running", pageIds: ["p1"], latestStageActivity: activity } as GenerationJob;
      const rows = getImportStageProgress(source(), current({ coreCompletedPageIds: [] }), [job]);
      expect(step(rows, "core_save")).toMatchObject({ state: "active", count: { completed: 0, total: 4 }, detail: "已收到生成内容，等待正文保存确认" });
      expect(step(rows, "generation").count).toBeUndefined();
    }
  });

  it("retains saved core after bridge failure and filters duplicate or unrelated saved IDs", () => {
    const rows = getImportStageProgress({ ...source(), generationState: "failed", generationFailedPageIds: ["p2"] }, current({ state: "failed", failedPageIds: ["p2"],
      coreCompletedPageIds: ["p1", "p2", "p2", "foreign"], bridgeCompletedPageIds: ["p1", "p1", "foreign"], stageSummary: { bridge: { completed: 1, total: 4, failed: 1 } }
    }));
    expect(step(rows, "core_save").count).toEqual({ completed: 2, total: 4 });
    expect(step(rows, "bridge")).toMatchObject({ state: "failed", count: { completed: 1, total: 4 } });
  });

  it("does not turn skipped generation into completed generation or show import steps for a standalone job", () => {
    const skipped = getImportStageProgress({ ...source(), autoGenerate: false, generationState: "not_requested" });
    expect(skipped.slice(4).every(row => row.state === "skipped" && row.count === undefined)).toBe(true);
    const standalone = getImportStageProgress({ ...source(), id: "generation-job:job-1" });
    expect(standalone.map(row => row.id)).toEqual(["vision", "generation", "core_save", "bridge"]);
  });

  it("uses real stage timestamps and freezes stage duration after completion", () => {
    const stages = current({ stageSummary: {
      vision: { state: "running", startedAt: "2026-10-01T00:00:00Z" },
      generation: { state: "completed", startedAt: "2026-10-01T00:00:00Z", endedAt: "2026-10-01T00:01:00Z" }
    } });
    const rows = getImportStageProgress(source(), stages, [], Date.parse("2026-10-01T00:02:00Z"));
    expect(step(rows, "vision").timing).toBe("阶段耗时 2 分");
    expect(step(rows, "generation").timing).toBe("阶段耗时 1 分");
  });

  it("renders separate stage counts before generation with no unified process percentage", () => {
    const markup = renderToStaticMarkup(createElement(ImportProgress, {
      record: record({ id: "import-stages", state: "processing", originalName: "test.pdf", autoGenerate: true, issues: [],
        conversionProgress: { stage: "saving_pages", pageCount: 4, completedPages: 2 } }),
      activeJobs: [], costs: [], costReadUnavailable: false, retryingFailed: false,
      onRetryFailed: () => {}, onClose: () => {}, onOpen: () => {}, onGenerate: () => {}
    }));
    expect(markup).toContain('aria-label="各阶段实际进度"');
    expect(markup).toContain("4/4 页");
    expect(markup).toContain("2/4 页");
    expect(markup).toContain("讲解完整保存 0/4 页");
    expect(markup).not.toContain('aria-valuetext="讲解完整保存 0%"');
    expect(markup).not.toContain("总完成度");
  });
});

function cost(stage: GenerationCostEntry["stage"], createdAt: string, values: Partial<GenerationCostEntry> = {}): GenerationCostEntry {
  return {
    id: `${stage}-${createdAt}`,
    workspaceId: "workspace-1",
    courseId: "course-1",
    materialVersionId: "material-1",
    jobId: "job-1",
    stage,
    provider: "provider-a",
    model: "model-a",
    inputTokens: 10,
    outputTokens: 20,
    cachedInputTokens: 0,
    unitPriceSnapshot: {
      id: "price-1",
      provider: "provider-a",
      model: "model-a",
      currency: "USD",
      capturedAt: createdAt,
      source: "test",
      inputMicrousdPerMillion: 1,
      outputMicrousdPerMillion: 1,
      cachedInputMicrousdPerMillion: 1
    },
    estimatedMicrousd: 1_000,
    actualMicrousd: 1_100,
    durationMs: 10,
    retries: 0,
    status: "succeeded",
    qualityPassed: true,
    createdAt,
    ...values
  };
}

describe("import progress summary", () => {
  it("counts successful delivery once, excluding failed and unrelated pages", () => {
    const source = record({ state: "ready", autoGenerate: true, generationState: "failed", pageIds: ["p1", "p2", "p3", "p4"], generationCompletedPageIds: ["p1", "p1", "p2", "foreign"], generationFailedPageIds: ["p2", "p3"] });
    expect(deliveredPageProgress(source)).toEqual({ completed: 1, total: 4 });
    expect(getImportActivity(source, undefined, [], []).progressPercent).toBe(25);
  });
  it("does not disguise recent heartbeats as fresh work or invent progress without a total", () => {
    const source = record({ state: "processing", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:10:00Z", lastProgressAt: "2026-10-01T00:01:00Z" });
    const activity = getImportActivity(source, undefined, [], [], Date.parse("2026-10-01T00:10:00Z"));
    expect(activity.progressPercent).toBeUndefined();
    expect(activity.ageSeconds).toBe(540);
    expect(activity.stale).toBe(true);
  });
  it("keeps the completed conversion count visible after automatic generation starts", () => {
    const result = summarizeImportProgress(
      record({ id: "import-1", state: "ready", generationJobId: "job-1", pageIds: ["p1", "p2", "p3", "p4"], issues: [] }),
      plan({ pageIds: ["p1", "p2", "p3", "p4"], completedPageIds: [], failedPageIds: [] }),
      [], []
    );
    expect(result.conversion).toEqual({ completed: 4, total: 4 });
  });

  it("does not present an unsettled running model bill as zero cost", () => {
    const result = summarizeImportProgress(
      record({ id: "import-1", state: "ready", pageIds: ["p1"], issues: [] }),
      plan({ state: "running", pageIds: ["p1"], completedPageIds: [], failedPageIds: [], spentUsd: 0 }),
      [], []
    );
    expect(result.costUsd).toBeUndefined();
  });

  it("shows whole-material completion while a one-page continuation runs", () => {
    const source = record({ id: "import-1", state: "ready", autoGenerate: true,
      generationState: "running", pageIds: ["p1", "p2", "p3", "p4"],
      generationCompletedPageIds: ["p1", "p2", "p4"], issues: [] });
    const continuation = plan({ retryOfPlanId: "old-plan", state: "running", pageIds: ["p3"],
      completedPageIds: [], failedPageIds: [], coreCompletedPageIds: [], bridgeCompletedPageIds: [] });
    const summary = summarizeImportProgress(source, continuation, [], []);
    expect(summary.core).toEqual({ completed: 3, total: 4 });
    expect(summary.crossPage).toBeUndefined();
    expect(getImportActivity(source, continuation, [], []).progressPercent).toBe(75);
  });

  it("adds earlier page costs to a continuation instead of showing only the retry", () => {
    const source = record({ id: "import-1", state: "ready", pageIds: ["p1", "p2"], issues: [] });
    const continuation = plan({ retryOfPlanId: "old-plan", state: "completed", pageIds: ["p2"],
      completedPageIds: ["p2"], failedPageIds: [], spentUsd: 0.08 });
    const entries = [
      cost("teach", "2026-09-23T00:00:00Z", { id: "first", estimatedMicrousd: 100_000, costBasis: "price_snapshot" }),
      cost("teach", "2026-09-23T00:01:00Z", { id: "retry", estimatedMicrousd: 80_000, costBasis: "price_snapshot" })
    ];
    const summary = summarizeImportProgress(source, continuation, [], entries);
    expect(summary.costUsd).toBe(0.18);
    expect(summary.costBasis).toBe("estimated");
  });

  it("includes a positive unreported reserve as an estimate while actual cost is unknown", () => {
    const summary = summarizeImportProgress(
      record({ id: "import-reserve", state: "ready", pageIds: ["p1"], issues: [] }),
      plan({ state: "failed", pageIds: ["p1"], completedPageIds: [], failedPageIds: ["p1"], spentUsd: 0 }),
      [], [cost("teach", "2026-09-23T00:00:00Z", {
        id: "unreported-reserve", actualMicrousd: null, estimatedMicrousd: 25_000, costBasis: "not_available"
      })]
    );
    expect(summary.costUsd).toBe(0.025);
    expect(summary.costBasis).toBe("estimated");
  });

  it("derives legacy fields without inventing unavailable cross-page progress", () => {
    const result = summarizeImportProgress(
      record({ state: "ready", autoGenerate: true, pageIds: ["page-1", "page-2"], issues: [] }),
      plan({ pageIds: ["page-1", "page-2"], completedPageIds: ["page-1"], failedPageIds: ["page-2"], maxConcurrency: 4, spentUsd: 0.0123 }),
      [{ id: "job-1" }, { id: "job-2" }] as GenerationJob[],
      [
        cost("teach", "2026-09-21T10:00:00.000Z"),
        cost("repair", "2026-09-21T10:01:00.000Z", { provider: "provider-b", model: "model-b" })
      ]
    );

    expect(result.conversion).toEqual({ completed: 2, total: 2 });
    expect(result.core).toEqual({ completed: 1, total: 2 });
    expect(result.crossPage).toBeUndefined();
    expect(result.repairCount).toBe(1);
    expect(result.concurrency).toEqual({ running: undefined, limit: 4 });
    expect(result.provider).toBe("provider-b");
    expect(result.model).toBe("model-b");
    expect(result.costUsd).toBe(0.0123);
  });

  it("uses newly returned progress fields when the backend provides them", () => {
    const result = summarizeImportProgress(
      record({
        state: "processing",
        progress: {
          conversion: { completed: 3, total: 8 },
          bodyCore: { completed: 2, total: 8 },
          crossPageCarryover: { completed: 1, total: 8 },
          repairCount: 4,
          concurrency: { running: 3, limit: 5 },
          provider: "provider-new",
          model: "model-new",
          cumulativeCostUsd: 0.0421
        }
      }),
      undefined,
      undefined,
      []
    );

    expect(result.conversion).toEqual({ completed: 3, total: 8 });
    expect(result.core).toEqual({ completed: 2, total: 8 });
    expect(result.crossPage).toEqual({ completed: 1, total: 8 });
    expect(result.repairCount).toBe(4);
    expect(result.concurrency).toEqual({ running: 3, limit: 5 });
    expect(result.provider).toBe("provider-new");
    expect(result.model).toBe("model-new");
    expect(result.costUsd).toBe(0.0421);
  });

  it("keeps repair count unknown without repair cost entries and honors an explicit count", () => {
    const costs = [
      cost("teach", "2026-09-21T10:00:00.000Z"),
      cost("teach", "2026-09-21T10:01:00.000Z"),
      cost("review", "2026-09-21T10:02:00.000Z")
    ];
    const withoutCount = summarizeImportProgress(record({ state: "ready", autoGenerate: true }), undefined, undefined, costs);
    const withCount = summarizeImportProgress(
      record({ state: "ready", autoGenerate: true, progress: { repairCount: 3 } }),
      undefined,
      undefined,
      costs
    );

    expect(withoutCount.repairCount).toBeUndefined();
    expect(withCount.repairCount).toBe(3);
  });

  it("leaves metrics unknown when neither the new nor legacy data proves them", () => {
    const result = summarizeImportProgress(record({ state: "processing" }), undefined, undefined, []);

    expect(result.conversion).toBeUndefined();
    expect(result.core).toBeUndefined();
    expect(result.crossPage).toBeUndefined();
    expect(result.repairCount).toBeUndefined();
    expect(result.concurrency).toBeUndefined();
    expect(result.costUsd).toBeUndefined();
    expect(formatProgressCount(result.crossPage)).toBe("—");
  });

  it("does not report an old generated lesson as free when its cost ledger is missing", () => {
    const result = summarizeImportProgress(
      record({ state: "ready", autoGenerate: true, pageIds: ["p1"] }),
      plan({ pageIds: ["p1"], completedPageIds: ["p1"], failedPageIds: [], spentUsd: 0 }),
      [], []
    );
    expect(result.costUsd).toBeUndefined();
  });

  it("uses recorded usage when a completed plan retained a zero spent counter", () => {
    const result = summarizeImportProgress(
      record({ state: "ready", autoGenerate: true, pageIds: ["p1"] }),
      plan({ pageIds: ["p1"], completedPageIds: ["p1"], failedPageIds: [], spentUsd: 0 }),
      [], [cost("teach", "2026-09-22T10:00:00.000Z", { costBasis: "price_snapshot", estimatedMicrousd: 15_000 })]
    );
    expect(result.costUsd).toBe(0.015);
    expect(result.costBasis).toBe("estimated");
  });

  it("classifies importing, queued, active, completed, failed and stopped tasks distinctly", () => {
    expect(getImportTaskState(record({ state: "processing" }))).toBe("running");
    expect(getImportTaskState(record({ state: "ready", autoGenerate: true, generationState: "queued" }))).toBe("queued");
    expect(getImportTaskState(record({ state: "ready", autoGenerate: true, generationState: "running" }))).toBe("running");
    expect(getImportTaskState(record({ state: "ready", autoGenerate: true, generationState: "completed" }))).toBe("completed");
    expect(getImportTaskState(record({ state: "ready", autoGenerate: true, generationState: "failed" }))).toBe("failed");
    expect(getImportTaskState(record({ state: "ready", autoGenerate: true, generationState: "cancelled" }))).toBe("cancelled");
    expect(importTaskStateLabel("running")).toBe("正在处理");
  });

  it("describes the saved draft, explicit no-generation choice, and partial failure with their existing actions", () => {
    const notGenerated = record({ state: "ready", autoGenerate: false, generationState: "not_requested", pageIds: ["p1", "p2"] });
    expect(getImportTaskStatus(notGenerated)).toEqual({
      state: "completed", fact: "材料已导入，讲解未生成", action: "generate"
    });

    const draft = record({
      state: "ready", autoGenerate: true, generationState: "awaiting_review", pageIds: ["p1", "p2"],
      generationCompletedPageIds: ["p1", "p2"], generationFailedPageIds: []
    });
    const reviewPlan = plan({
      state: "awaiting_review", pageIds: ["p1", "p2"], completedPageIds: ["p1", "p2"], failedPageIds: []
    });
    expect(getImportTaskStatus(draft, reviewPlan)).toEqual({
      state: "awaiting_review", fact: "讲解草稿已生成，可阅读；尚未发布", action: "open_draft"
    });
    expect(getImportActivity(draft, reviewPlan, [], [], 0).stage).toBe("讲解草稿已生成，可阅读；尚未发布");
    expect(importTaskStateLabel("awaiting_review")).toBe("已停止，查看详情");

    const unexplainedReview = record({ state: "ready", autoGenerate: true, generationState: "awaiting_review" });
    expect(getImportTaskStatus(unexplainedReview)).toEqual({
      state: "awaiting_review", fact: "任务状态需同步；当前没有可确认的待办项"
    });
    expect(getImportTaskStatus(unexplainedReview).fact).not.toContain("待检查");

    const partial = record({
      state: "ready", autoGenerate: true, generationState: "failed", pageIds: ["p1", "p2", "p3"],
      generationCompletedPageIds: ["p1", "p2"], generationFailedPageIds: ["p3"]
    });
    expect(getImportTaskStatus(partial, plan({
      state: "failed", pageIds: ["p1", "p2", "p3"], completedPageIds: ["p1", "p2"], failedPageIds: ["p3"]
    }))).toEqual({
      state: "failed", fact: "讲解部分生成：2/3 页已生成，1 页失败", action: "retry_failed"
    });
    expect(importProgressTitle(notGenerated, undefined, false)).toBe("材料已导入，讲解未生成");
  });

  it("uses merged plan and job state to choose active, idle, and stopped polling", () => {
    const source = record({ state: "ready", autoGenerate: true, generationState: "queued", generationPlanId: "plan-1" });
    const runningPlan = plan({ state: "running", pageIds: ["p1"], completedPageIds: [], failedPageIds: [] });
    expect(getImportTaskState(source, runningPlan)).toBe("running");
    expect(getImportTaskPollingMode(source, runningPlan)).toBe("active");
    expect(getImportTaskPollingMode(source, plan({ state: "awaiting_review" }))).toBe("idle");
    expect(getImportTaskPollingMode(record({
      state: "ready", autoGenerate: false, generationState: "not_requested"
    }))).toBe("stopped");
    expect(getImportTaskPollingMode(record({ state: "ready", generationState: "failed" }))).toBe("stopped");
  });

  it("times only the current retry attempt and freezes terminal duration at endedAt", () => {
    const source = record({
      state: "ready", autoGenerate: true, generationJobId: "job-1", generationState: "running",
      createdAt: "2026-10-01T00:00:00.000Z"
    });
    const retryJob = {
      id: "job-1", state: "running", attempt: 2,
      createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-03T10:00:00.000Z",
      attemptStartedAt: "2026-10-03T10:00:00.000Z", pageIds: ["p1"],
      completedPageIds: [], failedPageIds: []
    } as unknown as GenerationJob;
    const running = getImportTaskTiming(source, undefined, [retryJob], Date.parse("2026-10-03T10:01:05.000Z"));
    expect(running).toMatchObject({
      phase: "running", attempt: 2, elapsedSeconds: 65,
      label: "本次耗时 1 分 5 秒（含本次排队时间）"
    });

    const completed = getImportTaskTiming(record({
      ...source, generationState: "completed"
    }), undefined, [{
      ...retryJob, state: "completed", endedAt: "2026-10-03T10:01:00.000Z"
    } as unknown as GenerationJob], Date.parse("2026-10-03T10:10:00.000Z"));
    expect(completed).toMatchObject({
      phase: "ended", attempt: 2, elapsedSeconds: 60,
      label: "本次耗时 1 分（含本次排队时间）"
    });

    const retryQueued = getImportTaskTiming(record({
      ...source, generationState: "queued"
    }), undefined, [{
      ...retryJob, state: "queued", endedAt: "2026-10-03T10:01:00.000Z"
    } as unknown as GenerationJob], Date.parse("2026-10-03T10:10:00.000Z"));
    expect(retryQueued).toMatchObject({
      phase: "queued", label: "排队中"
    });
    expect(retryQueued).not.toHaveProperty("elapsedSeconds");
  });

  it("stops pause and review timing and marks old or malformed terminal timing unknown", () => {
    const paused = getImportTaskTiming(record({
      state: "ready", autoGenerate: true, generationState: "paused", generationJobId: "job-p",
      attemptStartedAt: "2026-10-03T10:00:00.000Z", endedAt: "2026-10-03T10:02:00.000Z"
    }), undefined, [], Date.parse("2026-10-03T10:20:00.000Z"));
    expect(paused).toMatchObject({ phase: "paused", elapsedSeconds: 120, label: "本次耗时 2 分（含本次排队时间）" });

    const awaiting = getImportTaskTiming(record({
      state: "ready", autoGenerate: true, generationState: "awaiting_review", generationPlanId: "plan-r"
    }), plan({
      state: "awaiting_review", attemptStartedAt: "2026-10-03T10:00:00.000Z",
      endedAt: "2026-10-03T10:02:00.000Z", pageIds: ["p1"], completedPageIds: ["p1"], failedPageIds: []
    }), [], Date.parse("2026-10-03T10:20:00.000Z"));
    expect(awaiting).toMatchObject({
      phase: "awaiting_review", elapsedSeconds: 120,
      label: "本次耗时 2 分（含本次排队时间）"
    });

    const oldTerminal = getImportTaskTiming(record({
      state: "ready", autoGenerate: true, generationState: "completed",
      createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-03T10:00:00.000Z"
    }), undefined, [], Date.parse("2026-10-03T10:20:00.000Z"));
    expect(oldTerminal).toMatchObject({ phase: "ended", label: "已结束，耗时未记录" });
    expect(oldTerminal).not.toHaveProperty("elapsedSeconds");

    const malformed = getImportTaskTiming(record({
      state: "ready", autoGenerate: true, generationState: "running",
      attemptStartedAt: "not-a-time"
    }), undefined, [], Number.NaN);
    expect(malformed).toMatchObject({ phase: "running", label: "运行中，耗时暂不可核对" });
    expect(malformed).not.toHaveProperty("elapsedSeconds");

    const reversed = getImportTaskTiming(record({
      state: "ready", autoGenerate: true, generationState: "failed",
      attemptStartedAt: "2026-10-03T10:03:00.000Z", endedAt: "2026-10-03T10:02:00.000Z"
    }), undefined, [], Date.parse("2026-10-03T10:20:00.000Z"));
    expect(reversed).toMatchObject({ phase: "ended", label: "已结束，耗时未记录" });
    expect(reversed).not.toHaveProperty("elapsedSeconds");

    const importedWithoutGeneration = getImportTaskTiming(record({
      state: "ready", autoGenerate: false, generationState: "not_requested",
      attemptStartedAt: "2026-10-03T10:00:00.000Z", endedAt: "2026-10-03T10:02:05.000Z"
    }), undefined, [], Date.parse("2026-10-03T10:20:00.000Z"));
    expect(importedWithoutGeneration).toMatchObject({
      phase: "ended", elapsedSeconds: 125,
      label: "本次耗时 2 分 5 秒（含本次排队时间）"
    });
  });

  it("restores standalone generation state and uses the persisted stage activity without inventing a percentage", () => {
    const task = record({
      id: "generation-job:job-1",
      state: "ready",
      autoGenerate: true,
      generationJobId: "job-1",
      generationState: "running",
      pageIds: ["p1", "p2", "p3", "p4"],
      generationCompletedPageIds: ["p1", "p2"],
      generationFailedPageIds: [],
      updatedAt: "2026-09-22T10:00:00.000Z"
    });
    const summary = summarizeImportProgress(task, undefined, [
      {
        id: "job-1",
        state: "running",
        updatedAt: "2026-09-22T10:00:30.000Z",
        latestStageActivity: {
          stage: "teach",
          status: "started",
          phase: "explanation",
          phaseStatus: "started",
          occurredAt: "2026-09-22T10:00:45.000Z"
        }
      } as GenerationJob
    ], []);
    const activity = getImportActivity(task, undefined, [
      {
        id: "job-1",
        state: "running",
        updatedAt: "2026-09-22T10:00:30.000Z",
        latestStageActivity: {
          stage: "teach",
          status: "started",
          phase: "explanation",
          phaseStatus: "started",
          occurredAt: "2026-09-22T10:00:45.000Z"
        }
      } as GenerationJob
    ], [], Date.parse("2026-09-22T10:01:00.000Z"));

    expect(summary.core).toEqual({ completed: 2, total: 4 });
    expect(getImportTaskState(task)).toBe("running");
    expect(activity).toMatchObject({
      stage: "正文讲解",
      stageCode: "teach",
      stageStatus: "started",
      phase: "explanation",
      phaseStatus: "started",
      progressPercent: 50,
      lastActivityAt: "2026-09-22T10:00:45.000Z",
      ageSeconds: 15,
      stale: false
    });
    expect(standaloneGenerationJobId("generation-job:job-1")).toBe("job-1");
    expect(standaloneGenerationJobId("import-1")).toBeUndefined();
  });

  it("does not show a fabricated 0 percent while a standalone job has no completed pages", () => {
    const activity = getImportActivity(record({
      id: "generation-job:job-1",
      state: "ready",
      autoGenerate: true,
      generationJobId: "job-1",
      generationState: "running",
      pageIds: ["p1", "p2"],
      generationCompletedPageIds: [],
      generationFailedPageIds: [],
      updatedAt: "2026-09-22T10:00:00.000Z"
    }), undefined, [], [], Date.parse("2026-09-22T10:00:30.000Z"));

    expect(activity.progressPercent).toBe(0);
    expect(activity.stage).toBe("生成页面讲解");
  });

  it("ignores the last stage activity after a standalone job finishes", () => {
    const activity = getImportActivity(record({
      id: "generation-job:job-1",
      state: "ready",
      autoGenerate: true,
      generationJobId: "job-1",
      generationState: "completed",
      pageIds: ["p1"],
      generationCompletedPageIds: ["p1"],
      generationActivity: {
        stage: "review",
        status: "completed",
        occurredAt: "2026-09-22T10:00:30.000Z"
      },
      updatedAt: "2026-09-22T10:01:00.000Z"
    }), undefined, [], [], Date.parse("2026-09-22T10:02:00.000Z"));

    expect(activity).toMatchObject({
      stage: "全部页面生成完成",
      stageCode: undefined,
      phase: undefined,
      progressPercent: 100,
      lastActivityAt: undefined
    });
  });

  it("uses stage activity while a job is syncing and keeps queued jobs at the queue stage", () => {
    const activity = {
      stage: "teach" as const,
      status: "started" as const,
      phase: "opening",
      phaseStatus: "started" as const,
      occurredAt: "2026-09-22T10:00:30.000Z"
    };
    const pendingSync = getImportActivity(record({
      state: "ready",
      autoGenerate: true,
      generationJobId: "job-1",
      generationState: "pending_sync",
      generationActivity: activity,
      updatedAt: "2026-09-22T10:00:00.000Z"
    }), undefined, [], [], Date.parse("2026-09-22T10:01:00.000Z"));
    const queued = getImportActivity(record({
      state: "ready",
      autoGenerate: true,
      generationJobId: "job-1",
      generationState: "queued",
      generationActivity: activity,
      updatedAt: "2026-09-22T10:00:00.000Z"
    }), undefined, [], [], Date.parse("2026-09-22T10:01:00.000Z"));

    expect(pendingSync).toMatchObject({ stage: "正文讲解", phase: "opening", lastActivityAt: activity.occurredAt });
    expect(queued).toMatchObject({ stage: "等待生成任务启动", phase: undefined, lastActivityAt: undefined });
  });

  it("maps all standalone job terminal states to distinct task states and truthful stages", () => {
    const cases = [
      ["queued", "queued", "等待生成任务启动"],
      ["pending_sync", "running", "写入课程草稿"],
      ["completed", "completed", "全部页面生成完成"],
      ["failed", "failed", "生成失败"],
      ["cancelled", "cancelled", "生成已取消"],
      ["paused", "paused", "生成已暂停"]
    ] as const;
    for (const [generationState, expectedState, expectedStage] of cases) {
      const task = record({ state: "ready", autoGenerate: true, generationJobId: "job-1", generationState, pageIds: ["p1"] });
      expect(getImportTaskState(task)).toBe(expectedState);
      expect(getImportActivity(task, undefined, [], [], 0).stage).toBe(expectedStage);
    }
  });

  it("shows imported-but-not-generated for a ready material with auto-generation disabled", () => {
    const task = record({
      id: "b926c0c9-test",
      state: "ready",
      autoGenerate: false,
      generationState: "not_requested",
      pageIds: ["p1", "p2", "p3"],
      issues: []
    });

    expect(getImportTaskState(task)).toBe("completed");
    expect(getImportActivity(task, undefined, [], [], 0)).toMatchObject({
      stage: "材料导入完成",
      progressPercent: 100,
      progressScope: "总完成度"
    });
    expect(importProgressTitle(task, undefined, false)).toBe("材料已导入，讲解未生成");
  });

  it("does not invent a percentage when active work has no persisted counters", () => {
    const result = getImportActivity(
      record({ state: "ready", autoGenerate: true, generationState: "running", updatedAt: "2026-09-22T10:00:00.000Z" }),
      plan({ id: "plan-1", state: "running", pageIds: ["p1", "p2"], updatedAt: "2026-09-22T10:00:20.000Z" }),
      [{ id: "job-1", state: "running", updatedAt: "2026-09-22T10:00:30.000Z" }] as GenerationJob[],
      [],
      Date.parse("2026-09-22T10:01:00.000Z")
    );

    expect(result.stage).toBe("生成页面讲解");
    expect(result.progressPercent).toBe(0);
    expect(result.ageSeconds).toBeUndefined();
    expect(result.stale).toBe(false);
  });

  it("shows an exact conversion-stage percentage only when page counters are available", () => {
    const result = getImportActivity(
      record({
        state: "processing",
        progress: { conversion: { completed: 3, total: 8 } },
        conversionProgress: { pageCount: 8, completedPages: 3 },
        updatedAt: "2026-09-22T10:00:00.000Z"
      }),
      undefined,
      [],
      [],
      Date.parse("2026-09-22T10:00:10.000Z")
    );
    expect(result.stage).toBe("页面转换");
    expect(result.progressPercent).toBe(0);
    expect(result.progressScope).toBe("总完成度");
  });

  it("uses actual completed core and bridge page counts and flags a stale heartbeat", () => {
    const result = getImportActivity(
      record({ state: "ready", autoGenerate: true, generationState: "running" }),
      plan({
        id: "plan-1",
        state: "running",
        pageIds: ["p1", "p2", "p3", "p4"],
        coreCompletedPageIds: ["p1", "p2", "p3", "p4"],
        bridgeCompletedPageIds: ["p1", "p2"],
        updatedAt: "2026-09-22T09:56:00.000Z"
      }),
      [],
      [],
      Date.parse("2026-09-22T10:00:00.000Z")
    );

    expect(result.stage).toBe("生成跨页承接");
    expect(result.progressPercent).toBe(0);
    expect(result.ageSeconds).toBeUndefined();
    expect(result.stale).toBe(false);
    expect(formatActivityAge(240)).toBe("4 分钟前");
  });

  it("shows the newest active plan job stage and phase while preserving counter progress", () => {
    const activeJobs = [
      {
        id: "older-job",
        state: "running",
        latestStageActivity: {
          stage: "repair",
          status: "started",
          phase: "opening_repair",
          phaseStatus: "started",
          occurredAt: "2026-09-22T10:59:30.000Z"
        }
      },
      {
        id: "newer-job",
        state: "running",
        latestStageActivity: {
          stage: "teach",
          status: "started",
          phase: "explanation",
          phaseStatus: "started",
          occurredAt: "2026-09-22T10:59:50.000Z"
        }
      },
      {
        id: "queued-retry-with-old-history",
        state: "queued",
        latestStageActivity: {
          stage: "review",
          status: "completed",
          occurredAt: "2026-09-22T10:59:55.000Z"
        }
      }
    ] as unknown as GenerationJob[];
    const result = getImportActivity(
      record({ state: "ready", autoGenerate: true }),
      plan({
        id: "plan-1",
        state: "running",
        pageIds: Array.from({ length: 10 }, (_, index) => `p${index + 1}`),
        coreCompletedPageIds: Array.from({ length: 10 }, (_, index) => `p${index + 1}`),
        bridgeCompletedPageIds: Array.from({ length: 7 }, (_, index) => `p${index + 1}`)
      }),
      activeJobs,
      [],
      Date.parse("2026-09-22T11:00:00.000Z")
    );

    expect(result).toMatchObject({
      stage: "正文讲解",
      stageCode: "teach",
      stageStatus: "started",
      phase: "explanation",
      phaseStatus: "started",
      progressPercent: 0,
      progressScope: "总完成度",
      lastActivityAt: "2026-09-22T10:59:50.000Z",
      ageSeconds: 10
    });
  });

  it("marks a completed plan complete and keeps failed progress from implying success", () => {
    const completed = getImportActivity(
      record({ state: "ready", autoGenerate: true }),
      plan({ id: "plan-1", state: "completed", pageIds: ["p1"], completedPageIds: ["p1"] }), [], [], 0
    );
    const failed = getImportActivity(
      record({ state: "ready", autoGenerate: true }),
      plan({ id: "plan-2", state: "failed", pageIds: ["p1"] }), [], [], 0
    );
    expect(completed.progressPercent).toBe(100);
    expect(failed.progressPercent).toBe(0);
    expect(failed.stage).toBe("生成失败");
  });

  it("does not paint an unknown or failed percentage as a full success bar", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.import-progress i\s*\{[^}]*width:\s*0\s*;/);
    expect(css).toMatch(/\.import-task-workspace dl\s*\{[^}]*display:\s*grid\s*;/);
    expect(css).toContain(".import-task-workspace .import-progress.is-failed");
    expect(css).toMatch(/\.task-state-queued\s*\{[^}]*background:\s*var\(--blue\)/);
    expect(css).toMatch(/\.task-state-running\s*\{[^}]*background:\s*var\(--blue\)/);
    expect(css).toMatch(/\.task-state-completed\s*\{[^}]*background:\s*var\(--green\)/);
    expect(css).toMatch(/\.task-state-failed\s*\{[^}]*background:\s*var\(--red\)/);
    expect(css).toMatch(/\.task-state-cancelled,\s*\.task-state-paused\s*\{[^}]*background:\s*var\(--faint\)/);
  });
});
