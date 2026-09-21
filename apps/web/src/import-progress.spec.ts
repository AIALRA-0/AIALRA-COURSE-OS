import type { GenerationCostEntry, GenerationJob } from "@course-os/contracts";
import { describe, expect, it } from "vitest";
import { formatProgressCount, summarizeImportProgress } from "./import-progress.js";
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
});
