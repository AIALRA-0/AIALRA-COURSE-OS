import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { dismissFailedTasks, filterDismissedTasks, isTaskDismissed, pickTaskDismissals, selectFailedTasks, writeJsonAtomic,
  type CleanupTaskRecord, type TaskCleanupState, type TaskDismissalContext } from "./index.js";

const at = "2026-10-03T00:00:00.000Z";
const context: TaskDismissalContext = { workspaceId: "personal", actor: "authenticated-test-actor", idempotencyKey: "clear-1", now: at, hasActiveWrites: () => false };
type State = TaskCleanupState & { idempotency: NonNullable<TaskCleanupState["idempotency"]>; events: unknown[]; answers: unknown[] };
function task(id: string, patch: Partial<CleanupTaskRecord> = {}): CleanupTaskRecord {
  return { id, workspaceId: "personal", state: "failed", materialVersionId: "material-1", pageIds: ["page-1"], createdAt: at, updatedAt: at, ...patch };
}
function state(): State {
  return { imports: [task("import-1", { state: "ready", generationState: "failed", generationPlanId: "plan-1" })],
    generationPlans: [task("plan-1", { sourceImportId: "import-1", jobIds: ["job-1"] })],
    jobs: [task("job-1", { planId: "plan-1", sourceImportId: "import-1", attempt: 1 })],
    idempotency: { "original-import-key": { kind: "import", objectId: "import-1" }, "original-generation-key": { kind: "job", objectId: "job-1" } },
    events: [{ type: "generation.cost.recorded", cost: 0.01 }], answers: [{ id: "own-answer", answer: "synthetic" }] };
}

describe("persistent failed-task dismissal", () => {
  it("deduplicates import/plan/job aliases, survives reopening, and retains every original entity", async () => {
    const s = state();
    const before = structuredClone(s);
    const [selected] = selectFailedTasks(s, "personal");
    expect(selected?.members).toHaveLength(3);
    const receipt = await dismissFailedTasks(s, [selected!, { ...selected!, kind: "job", id: "job-1" }], context);
    expect(receipt.results).toHaveLength(1);
    expect(receipt.results[0]).toMatchObject({ status: "dismissed", members: selected!.members });
    expect({ ...s, idempotency: before.idempotency }).toEqual(before);
    for (const ref of selected!.members) expect(isTaskDismissed(s, "personal", ref)).toBe(true);
    const directory = await mkdtemp(join(tmpdir(), "course-os-dismiss-"));
    try {
      const path = join(directory, "operations.json");
      await writeJsonAtomic(path, s);
      const reopened = JSON.parse(await readFile(path, "utf8")) as State;
      expect(selectFailedTasks(reopened, "personal")).toEqual([]);
      expect(await dismissFailedTasks(reopened, [selected!, { ...selected!, kind: "job", id: "job-1" }], context)).toEqual(receipt);
      expect(reopened.idempotency["original-import-key"]).toEqual(before.idempotency["original-import-key"]);
      expect(filterDismissedTasks({ ...before, idempotency: undefined, taskDismissals: pickTaskDismissals(s.idempotency) }, "personal"))
        .toMatchObject({ imports: [], jobs: [], generationPlans: [] });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("checks current state after confirmation and does not hide a later failure on replay", async () => {
    const s = state();
    const selected = selectFailedTasks(s, "personal");
    const receipt = await dismissFailedTasks(s, selected, context);
    s.jobs[0]!.attempt = 2;
    s.jobs[0]!.updatedAt = "2026-10-03T01:00:00.000Z";
    expect(selectFailedTasks(s, "personal")).toHaveLength(1);
    expect(await dismissFailedTasks(s, selected, context)).toEqual(receipt);
    expect(isTaskDismissed(s, "personal", selected[0]!)).toBe(false);
    expect((await dismissFailedTasks(s, selected, { ...context, idempotencyKey: "stale-confirmation" })).results[0])
      .toMatchObject({ status: "skipped", reason: "TASK_CHANGED" });
  });

  it("skips live leases and active recovery plans sharing the same failed import", async () => {
    const s = state();
    s.jobs[0]!.lease = { expiresAt: "2026-10-03T02:00:00.000Z" };
    const selected = selectFailedTasks(s, "personal");
    expect((await dismissFailedTasks(s, selected, context)).results[0]).toMatchObject({ status: "skipped", reason: "TASK_ACTIVE" });
    delete s.jobs[0]!.lease;
    s.generationPlans.push(task("retry-plan", { retryOfPlanId: "plan-1", state: "queued" }));
    const retrySelection = selectFailedTasks(s, "personal");
    expect((await dismissFailedTasks(s, retrySelection, { ...context, idempotencyKey: "recovery" })).results[0])
      .toMatchObject({ status: "skipped", reason: "TASK_ACTIVE" });
  });

  it("checks pending writes at execution and preserves skipped receipts under duplicate clicks", async () => {
    const s = state();
    const selected = selectFailedTasks(s, "personal");
    let calls = 0;
    const receipt = await dismissFailedTasks(s, selected, { ...context, hasActiveWrites: async () => { calls++; return true; } });
    expect(receipt.results[0]).toMatchObject({ status: "skipped", reason: "TASK_ACTIVE" });
    expect(await dismissFailedTasks(s, selected, context)).toEqual(receipt);
    expect(calls).toBe(1);
    expect(pickTaskDismissals(s.idempotency)).toEqual({});
  });

  it("dismisses failed/rejected imports with placeholder queued generationState but no actual active children", async () => {
    for (const failure of ["failed", "rejected"]) {
      const s = state();
      s.imports = [task("rejected-import", { state: failure, generationState: "queued" })];
      s.jobs = []; s.generationPlans = [];
      expect((await dismissFailedTasks(s, selectFailedTasks(s, "personal"), context)).results[0]).toMatchObject({ status: "dismissed" });
    }
  });

  it("dismisses an ended failure without changing independent active work on the same material and page", async () => {
    const s = state();
    const independentPlan = task("independent-review", { state: "awaiting_review", jobIds: ["independent-completed"] });
    const completedJob = task("independent-completed", { state: "completed", planId: independentPlan.id });
    s.generationPlans.push(independentPlan);
    s.jobs.push(completedJob);
    s.jobs.push(task("independent-active", { state: "pending_sync" }));
    const before = structuredClone(s);
    expect((await dismissFailedTasks(s, selectFailedTasks(s, "personal"), context)).results[0])
      .toMatchObject({ status: "dismissed" });
    expect({ ...s, idempotency: before.idempotency }).toEqual(before);
    expect(isTaskDismissed(s, "personal", { kind: "plan", id: "plan-1" })).toBe(true);
    expect(filterDismissedTasks(s, "personal").generationPlans).toEqual([independentPlan]);
    expect(filterDismissedTasks(s, "personal").jobs).toEqual([completedJob, before.jobs.at(-1)]);
  });

  it("rejects workspace mismatch and excludes completed, rejected and currently running tasks", async () => {
    const s = state();
    const other = task("other-failed", { workspaceId: "other", materialVersionId: "other-material", pageIds: [] });
    s.jobs.push(other, task("completed", { state: "completed" }), task("running", { state: "running" }), task("rejected", { state: "rejected" }));
    const selected = selectFailedTasks(s, "other");
    expect((await dismissFailedTasks(s, selected, context)).results[0]).toMatchObject({ reason: "WORKSPACE_MISMATCH" });
    expect(selectFailedTasks(s, "personal")).toHaveLength(1);
    await expect(dismissFailedTasks(s, [], { ...context, actor: "" })).rejects.toThrow("TASK_DISMISS_CONTEXT_REQUIRED");
  });

  it("only marks selected failures and rejects reuse of a request key for a different selection", async () => {
    const s = state();
    s.jobs.push(task("standalone-failed", { materialVersionId: "another-material", pageIds: ["other-page"] }));
    const selected = selectFailedTasks(s, "personal");
    await dismissFailedTasks(s, [selected[0]!], context);
    expect(selectFailedTasks(s, "personal")).toHaveLength(1);
    await expect(dismissFailedTasks(s, [selected[1]!], context)).rejects.toThrow("TASK_DISMISS_IDEMPOTENCY_CONFLICT");
  });
});
