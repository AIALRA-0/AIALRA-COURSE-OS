import { readFile } from "node:fs/promises";
import type { GenerationCostEntry, GenerationJob } from "@course-os/contracts";
import { describe, expect, it } from "vitest";
import { formatActivityAge, formatProgressCount, getImportActivity, getImportTaskState, importTaskStateLabel, summarizeImportProgress } from "./import-progress.js";
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
  });
});
