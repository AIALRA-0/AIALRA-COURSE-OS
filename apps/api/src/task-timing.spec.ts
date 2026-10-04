import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerationJob, GenerationPlan, ImportRecord } from "@course-os/contracts";
import { describe, expect, it } from "vitest";
import { OperationalStore } from "./store.js";
import { applyTaskTimingEvent, isNewGenerationJobAttempt, type TaskTimingRecord } from "./task-timing.js";

describe("task timing maintenance", () => {
  it("freezes repeated end events and resets the interval at a restart", () => {
    const task: TaskTimingRecord & { updatedAt: string } = {
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-04T00:00:00.000Z"
    };
    applyTaskTimingEvent(task, "job.running", "2026-01-01T00:10:00.000Z");
    expect(task.attemptStartedAt).toBe(task.createdAt);
    applyTaskTimingEvent(task, "generation.stage.started", "2026-01-02T00:00:00.000Z");
    expect(task.attemptStartedAt).toBe(task.createdAt);

    applyTaskTimingEvent(task, "job.failed", "2026-01-02T00:00:00.000Z");
    applyTaskTimingEvent(task, "job.failed", "2026-01-03T00:00:00.000Z");
    expect(task.endedAt).toBe("2026-01-02T00:00:00.000Z");

    applyTaskTimingEvent(task, "job.running", "2026-01-03T00:00:00.000Z", { restart: true });
    expect(task).toEqual({
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-04T00:00:00.000Z",
      attemptStartedAt: "2026-01-03T00:00:00.000Z"
    });
    applyTaskTimingEvent(task, "job.completed", "2026-01-03T01:00:00.000Z");
    expect(task.endedAt).toBe("2026-01-03T01:00:00.000Z");
  });

  it("treats awaiting review as a pause and preserves a repeated plan start", () => {
    const plan: TaskTimingRecord = { createdAt: "2026-02-01T00:00:00.000Z" };
    applyTaskTimingEvent(plan, "plan.queued", "2026-02-01T00:01:00.000Z");
    applyTaskTimingEvent(plan, "plan.running", "2026-02-01T00:05:00.000Z");
    applyTaskTimingEvent(plan, "plan.running", "2026-02-01T00:10:00.000Z");
    expect(plan.attemptStartedAt).toBe(plan.createdAt);

    applyTaskTimingEvent(plan, "plan.awaiting_review", "2026-02-01T01:00:00.000Z");
    applyTaskTimingEvent(plan, "plan.awaiting_review", "2026-02-01T02:00:00.000Z");
    expect(plan.endedAt).toBe("2026-02-01T01:00:00.000Z");
    applyTaskTimingEvent(plan, "plan.retry.queued", "2026-02-01T03:00:00.000Z");
    expect(plan).toEqual({
      createdAt: "2026-02-01T00:00:00.000Z",
      attemptStartedAt: "2026-02-01T03:00:00.000Z"
    });
  });

  it("freezes a job pause or review wait until its next running event", () => {
    const job: TaskTimingRecord = { createdAt: "2026-02-15T00:00:00.000Z" };
    applyTaskTimingEvent(job, "job.running", "2026-02-15T00:05:00.000Z");
    applyTaskTimingEvent(job, "job.paused", "2026-02-15T01:00:00.000Z");
    applyTaskTimingEvent(job, "job.awaiting_review", "2026-02-15T02:00:00.000Z");
    expect(job.endedAt).toBe("2026-02-15T01:00:00.000Z");
    applyTaskTimingEvent(job, "job.running", "2026-02-15T03:00:00.000Z");
    expect(job).toEqual({ createdAt: "2026-02-15T00:00:00.000Z", attemptStartedAt: "2026-02-15T03:00:00.000Z" });
  });

  it("starts a newly created replacement plan from its own createdAt", () => {
    const replacement: TaskTimingRecord = { createdAt: "2026-02-20T12:00:00.000Z" };
    applyTaskTimingEvent(replacement, "plan.queued", "2026-02-20T12:00:02.000Z");
    expect(replacement.attemptStartedAt).toBe(replacement.createdAt);
    expect(replacement.endedAt).toBeUndefined();
  });

  it("detects one new job attempt without resetting repeated running events", () => {
    const history = [{ streamId: "job-1", type: "job.running", payload: { attempt: 2 } }];
    expect(isNewGenerationJobAttempt(2, "job-1", history)).toBe(false);
    expect(isNewGenerationJobAttempt(3, "job-1", history)).toBe(true);
    expect(isNewGenerationJobAttempt(3, "another-job", history)).toBe(true);
  });

  it("persists import, job, and plan timing before file-store serialization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "course-os-task-timing-"));
    const path = join(directory, "operations.json");
    try {
      const store = new OperationalStore(path);
      const createdAt = "2026-03-01T00:00:00.000Z";
      const imported = makeImport(randomUUID(), createdAt);
      const job = makeJob(randomUUID(), createdAt);
      const plan = makePlan(randomUUID(), createdAt);
      await store.mutate(state => {
        state.jobs.push(job);
        state.generationPlans.push(plan);
        store.appendEvent(state, plan.id, "plan.queued", {});
      });

      await store.mutateImports((state, context) => {
        state.imports.push(imported);
        context.appendEvent(imported.id, "import.accepted", {});
      });
      expect(await store.getImport(imported.id, imported.workspaceId)).toMatchObject({ attemptStartedAt: createdAt });
      await store.mutateImports((state, context) => {
        state.imports[0]!.state = "processing";
        context.appendEvent(imported.id, "conversion.started", {});
      });
      expect(await store.getImport(imported.id, imported.workspaceId)).toMatchObject({ attemptStartedAt: createdAt });

      await store.mutateImports((state, context) => {
        state.imports[0]!.state = "failed";
        context.appendEvent(imported.id, "import.failed", {});
      });
      const firstImportEnd = (await store.getImport(imported.id, imported.workspaceId))!.endedAt;
      expect(firstImportEnd).toBeTypeOf("string");
      await store.mutateImports((_state, context) => context.appendEvent(imported.id, "import.failed", {}));
      expect((await store.getImport(imported.id, imported.workspaceId))!.endedAt).toBe(firstImportEnd);

      const restartedImport = await store.mutateImports((state, context) => {
        state.imports[0]!.state = "processing";
        context.appendEvent(imported.id, "conversion.started", {});
        return state.imports[0];
      });
      const latestImportStart = (await store.readGenerationJobEvents(imported.id)).at(-1)!.occurredAt;
      expect(restartedImport).toMatchObject({ attemptStartedAt: latestImportStart });
      expect(restartedImport!.endedAt).toBeUndefined();

      await store.mutateGenerationJob(job.id, (current, context) => {
        current.attempt = 1;
        current.state = "running";
        context.appendEvent("job.running", { attempt: current.attempt });
      });
      expect(await store.readGenerationJob(job.id)).toMatchObject({ attemptStartedAt: createdAt });
      await store.mutateGenerationJob(job.id, (current, context) => {
        current.state = "failed";
        context.appendEvent("job.failed", {});
      });
      const firstJobEnd = (await store.readGenerationJob(job.id))!.endedAt;
      expect(firstJobEnd).toBeTypeOf("string");
      await store.mutateGenerationJob(job.id, (_current, context) => context.appendEvent("job.failed", {}));
      expect((await store.readGenerationJob(job.id))!.endedAt).toBe(firstJobEnd);
      await store.mutateGenerationJob(job.id, (current, context) => {
        current.attempt = 2;
        current.state = "running";
        context.appendEvent("job.running", { attempt: current.attempt });
      });
      const latestJobEvent = (await store.readGenerationJobEvents(job.id)).at(-1)!;
      expect(await store.readGenerationJob(job.id)).toMatchObject({ attemptStartedAt: latestJobEvent.occurredAt });
      expect((await store.readGenerationJob(job.id))!.endedAt).toBeUndefined();

      expect((await store.readTaskIndex()).generationPlans[0]).toMatchObject({ attemptStartedAt: createdAt });
      await store.mutate(state => store.appendEvent(state, plan.id, "plan.awaiting_review", {}));
      const firstPlanEnd = (await store.readTaskIndex()).generationPlans[0]!.endedAt;
      expect(firstPlanEnd).toBeTypeOf("string");
      await store.mutate(state => store.appendEvent(state, plan.id, "plan.awaiting_review", {}));
      expect((await store.readTaskIndex()).generationPlans[0]!.endedAt).toBe(firstPlanEnd);
      await store.mutate(state => store.appendEvent(state, plan.id, "plan.retry.queued", {}));
      const latestPlanEvent = (await store.readGenerationJobEvents(plan.id)).at(-1)!;
      expect((await store.readTaskIndex()).generationPlans[0]).toMatchObject({ attemptStartedAt: latestPlanEvent.occurredAt });
      expect((await store.readTaskIndex()).generationPlans[0]!.endedAt).toBeUndefined();

      const persisted = JSON.parse(await readFile(path, "utf8")) as {
        imports: ImportRecord[];
        jobs: GenerationJob[];
        generationPlans: GenerationPlan[];
      };
      expect(persisted.imports[0]).toMatchObject({ attemptStartedAt: latestImportStart });
      expect(persisted.jobs[0]).toMatchObject({ attemptStartedAt: latestJobEvent.occurredAt });
      expect(persisted.generationPlans[0]).toMatchObject({ attemptStartedAt: latestPlanEvent.occurredAt });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not infer a missing historical end from updatedAt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "course-os-task-timing-legacy-"));
    try {
      const store = new OperationalStore(join(directory, "operations.json"));
      const legacy = { ...makeJob(randomUUID(), "2026-01-01T00:00:00.000Z"), state: "failed" as const, updatedAt: "2026-01-05T00:00:00.000Z" };
      await store.mutate(state => { state.jobs.push(legacy); });
      expect((await store.readGenerationJob(legacy.id))!.endedAt).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function makeImport(id: string, createdAt: string): ImportRecord {
  return {
    id, workspaceId: "timing-spec", originalName: "synthetic.pdf", mediaType: "application/pdf", kind: "pdf",
    sizeBytes: 1, sha256: "synthetic", casPath: "synthetic", source: "synthetic", license: "synthetic",
    sensitivity: "private", state: "accepted", issues: [], createdAt
  };
}

function makeJob(id: string, createdAt: string): GenerationJob {
  return {
    id, workspaceId: "timing-spec", materialVersionId: "synthetic", state: "queued", budgetUsd: 1, spentUsd: 0,
    pageIds: ["page-1"], completedPageIds: [], failedPageIds: [], attempt: 0, cancelRequested: false,
    createdAt, updatedAt: createdAt
  };
}

function makePlan(id: string, createdAt: string): GenerationPlan {
  return {
    id, workspaceId: "timing-spec", materialVersionId: "synthetic", qualityMode: "balanced", language: "en-US",
    writingPolicySnapshotId: "synthetic-policy", pageIds: ["page-1"], completedPageIds: [], failedPageIds: [],
    jobIds: [], budgetUsd: 1, spentUsd: 0, holdForReview: false, state: "queued", createdAt, updatedAt: createdAt
  };
}
