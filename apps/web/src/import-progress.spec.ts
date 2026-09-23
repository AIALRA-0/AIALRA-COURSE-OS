import { readFile } from "node:fs/promises";
import type { GenerationCostEntry, GenerationJob } from "@course-os/contracts";
import { describe, expect, it } from "vitest";
import { formatActivityAge, formatProgressCount, getImportActivity, getImportTaskState, importProgressTitle, importTaskStateLabel, standaloneGenerationJobId, summarizeImportProgress } from "./import-progress.js";
import type { WebGenerationPlan, WebImportRecord } from "./types.js";

function record(value: Record<string, unknown>): WebImportRecord {
  return value as unknown as WebImportRecord;
}

function plan(value: Record<string, unknown>): WebGenerationPlan {
  return value as unknown as WebGenerationPlan;
}

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
  it("keeps the completed conversion count visible after automatic generation starts", () => {
    const result = summarizeImportProgress(
      record({ id: "import-1", state: "ready", generationJobId: "job-1", pageIds: ["p1", "p2", "p3", "p4"], issues: [] }),
      plan({ pageIds: ["p1", "p2", "p3", "p4"], completedPageIds: [], failedPageIds: [] }),
      [], []
    );
    expect(result.conversion).toEqual({ completed: 4, total: 4 });
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
    expect(result.concurrency).toEqual({ running: 2, limit: 4 });
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
      progressPercent: undefined,
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

    expect(activity.progressPercent).toBeUndefined();
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
      lastActivityAt: "2026-09-22T10:01:00.000Z"
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
    expect(queued).toMatchObject({ stage: "等待生成任务启动", phase: undefined, lastActivityAt: "2026-09-22T10:00:00.000Z" });
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
      progressScope: "材料导入"
    });
    expect(importProgressTitle(task, undefined, false)).toBe("材料导入完成，尚未生成讲解");
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
    expect(result.progressPercent).toBeUndefined();
    expect(result.ageSeconds).toBe(30);
    expect(result.stale).toBe(false);
  });

  it("shows an exact conversion-stage percentage only when page counters are available", () => {
    const result = getImportActivity(
      record({
        state: "processing",
        progress: { conversion: { completed: 3, total: 8 } },
        updatedAt: "2026-09-22T10:00:00.000Z"
      }),
      undefined,
      [],
      [],
      Date.parse("2026-09-22T10:00:10.000Z")
    );
    expect(result.stage).toBe("页面转换");
    expect(result.progressPercent).toBe(38);
    expect(result.progressScope).toBe("页面转换");
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
    expect(result.progressPercent).toBe(75);
    expect(result.ageSeconds).toBe(240);
    expect(result.stale).toBe(true);
    expect(formatActivityAge(result.ageSeconds)).toBe("4 分钟前");
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
      progressPercent: 85,
      progressScope: "讲解生成",
      lastActivityAt: "2026-09-22T10:59:50.000Z",
      ageSeconds: 10
    });
  });

  it("marks a completed plan complete and keeps failed progress from implying success", () => {
    const completed = getImportActivity(
      record({ state: "ready", autoGenerate: true }),
      plan({ id: "plan-1", state: "completed", pageIds: ["p1"] }), [], [], 0
    );
    const failed = getImportActivity(
      record({ state: "ready", autoGenerate: true }),
      plan({ id: "plan-2", state: "failed", pageIds: ["p1"] }), [], [], 0
    );
    expect(completed.progressPercent).toBe(100);
    expect(failed.progressPercent).toBeUndefined();
    expect(failed.stage).toBe("生成失败");
  });

  it("does not paint an unknown or failed percentage as a full success bar", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.import-progress i\s*\{[^}]*width:\s*0\s*;/);
    expect(css).toMatch(/\.import-task-workspace dl\s*\{[^}]*display:\s*grid\s*;/);
    expect(css).toContain(".import-task-workspace .import-progress.is-failed");
    expect(css).toMatch(/\.task-state-queued\s*\{[^}]*background:\s*var\(--blue\)/);
    expect(css).toMatch(/\.task-state-running\s*\{[^}]*background:\s*var\(--amber\)/);
    expect(css).toMatch(/\.task-state-completed\s*\{[^}]*background:\s*var\(--green\)/);
    expect(css).toMatch(/\.task-state-failed\s*\{[^}]*background:\s*var\(--red\)/);
    expect(css).toMatch(/\.task-state-cancelled,\s*\.task-state-paused\s*\{[^}]*background:\s*var\(--faint\)/);
  });
});
