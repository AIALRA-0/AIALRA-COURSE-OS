import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { GenerationJob, GenerationPlan, ImportRecord, LearningSession, OrderedEvent } from "@course-os/contracts";
import { describe, expect, it, vi } from "vitest";
import { EMPTY, OperationalStore, PostgresOperationalStore } from "./store.js";
import type { OperationalState } from "./store.js";
import type { PlannedCheckpoint } from "./planned-teaching.js";
import { dismissFailedTasks, isTaskDismissed, selectFailedTasks } from "@course-os/storage";
import { withReadBudget } from "@course-os/readweave-adapter";

const connectionString = process.env.COURSE_OS_TEST_DATABASE_URL;
if (connectionString && !new URL(connectionString).pathname.toLowerCase().includes("test")) {
  throw new Error("COURSE_OS_TEST_DATABASE_URL must point to an isolated test database");
}
const postgresDescribe = connectionString ? describe : describe.skip;
const schemaPath = fileURLToPath(new URL("../../../infra/postgres/operational-schema.postgres", import.meta.url));

describe("OperationalStore generation job mutation", () => {
  it("reads events from one generation job stream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "course-os-job-events-"));
    try {
      const store = new OperationalStore(join(directory, "operations.json"));
      const job = makeJob(randomUUID());
      await store.mutate(state => {
        state.jobs.push(job);
        store.appendEvent(state, job.id, "generation.page.core_saved", { pageId: "page-1" });
        store.appendEvent(state, "another-job", "generation.page.core_saved", { pageId: "page-2" });
      });

      await expect(store.readGenerationJobEvents(job.id)).resolves.toMatchObject([
        { streamId: job.id, type: "generation.page.core_saved", payload: { pageId: "page-1" } }
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns the updated job and persists scoped events and checkpoints", async () => {
    const directory = await mkdtemp(join(tmpdir(), "course-os-job-store-"));
    try {
      const store = new OperationalStore(join(directory, "operations.json"));
      const job = makeJob(randomUUID());
      await store.mutate(state => { state.jobs.push(job); });
      const changed = await store.mutateGenerationJob(job.id, (current, context) => {
        current.attempt += 1;
        context.appendEvent("job.running", { attempt: current.attempt });
        context.setCheckpoint("page-1", makeCheckpoint("local-checkpoint"));
        return current.attempt;
      });

      expect(changed).toMatchObject({ job: { id: job.id, attempt: 1 }, result: 1 });
      const projected = await store.read();
      expect(projected.events.some(event => event.streamId === job.id && event.type === "job.running")).toBe(true);
      expect(projected.generationCheckpoints[`${job.id}:page-1`]).toMatchObject({ fingerprint: "local-checkpoint" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("OperationalStore learning session mutation", () => {
  it("creates, resumes, and patches only the requested workspace session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "course-os-session-store-"));
    try {
      const store = new OperationalStore(join(directory, "operations.json"));
      const session = makeSession(randomUUID());
      await store.createLearningSession(session);
      expect(await store.findLearningSession(session.id)).toEqual(session);
      expect(await store.patchLearningSession(session.id, "other", { zoom: 2 })).toBeUndefined();
      expect(await store.patchLearningSession(session.id, session.workspaceId!, { zoom: 2 }))
        .toMatchObject({ id: session.id, zoom: 2, currentPageId: "page-1" });
      expect((await store.read()).sessions).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("scoped import storage", () => {
  it("keeps File import events, operation replay and recovery incarnations after reopening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "course-os-import-scope-"));
    try {
      const path = join(directory, "operations.json");
      const store = new OperationalStore(path);
      const record = makeImport(randomUUID());
      const emitted: OrderedEvent[] = [];
      store.bus.on(record.id, event => emitted.push(event));
      await store.mutateImports((state, context) => {
        expect(Object.keys(state).sort()).toEqual(["idempotency", "imports"]);
        state.imports.push(record);
        state.idempotency["import-operation"] = { kind: "import", objectId: record.id };
        context.appendEvent(record.id, "import.accepted", { synthetic: true });
      });
      expect(emitted).toHaveLength(1);
      expect(await store.readImportByOperation("import-operation", record.workspaceId)).toMatchObject({ record });
      expect((await store.readImportByOperation("import-operation", "other")).record).toBeUndefined();
      await store.mutateImports(state => { state.imports[0]!.state = "processing"; });
      const reopened = new OperationalStore(path);
      await reopened.mutateImports(state => { state.imports[0]!.state = "failed"; });
      expect(await reopened.getImport(record.id, record.workspaceId)).toMatchObject({ state: "failed", taskIncarnation: 2 });
      expect(await reopened.readGenerationJobEvents(record.id)).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe("OperationalStore model settings projection", () => {
  it("returns only model settings with the established defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "course-os-model-settings-"));
    try {
      const store = new OperationalStore(join(directory, "operations.json"));
      const settings = await store.readModelSettings();
      expect(settings).toEqual({
        modelProviders: EMPTY.modelProviders,
        modelRoutePolicy: EMPTY.modelRoutePolicy
      });
      expect(Object.keys(settings).sort()).toEqual(["modelProviders", "modelRoutePolicy"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("OperationalStore self-retelling reads", () => {
  it("filters retellings by workspace and optional release from the existing state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "course-os-self-retelling-read-"));
    try {
      const store = new OperationalStore(join(directory, "operations.json"));
      await store.mutate(state => {
        state.selfRetellings = {
          selected: { workspaceId: "personal", releaseId: "release-1", pageId: "page-1", answer: "selected",
            answeredAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nextReviewAt: "2026-01-02T00:00:00.000Z" },
          anotherRelease: { workspaceId: "personal", releaseId: "release-2", pageId: "page-2", answer: "other release",
            answeredAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nextReviewAt: "2026-01-02T00:00:00.000Z" },
          anotherWorkspace: { workspaceId: "other", releaseId: "release-1", pageId: "page-3", answer: "other workspace",
            answeredAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nextReviewAt: "2026-01-02T00:00:00.000Z" }
        };
      });

      await expect(store.readSelfRetellings("personal", "release-1")).resolves.toMatchObject([
        { workspaceId: "personal", releaseId: "release-1", pageId: "page-1", answer: "selected" }
      ]);
      await expect(store.readSelfRetellings("personal")).resolves.toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("TaskIndex dismissal projection", () => {
  it("resurfaces a new identical import failure after a persisted recovery transition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "course-os-dismiss-recovery-"));
    try {
      const store = new OperationalStore(join(directory, "operations.json"));
      const record: ImportRecord = { id: "synthetic-failed-import", workspaceId: "personal", originalName: "synthetic.pdf", mediaType: "application/pdf",
        kind: "pdf", sizeBytes: 10, sha256: "synthetic", casPath: "synthetic", source: "synthetic", license: "synthetic", sensitivity: "private",
        state: "failed", generationState: "queued", issues: ["SYNTHETIC_FAILURE"], createdAt: "2026-10-03T00:00:00.000Z" };
      await store.mutate(state => { state.imports.push(record); });
      const context = { workspaceId: "personal", actor: "test-actor", idempotencyKey: "clear-synthetic-import", hasActiveWrites: () => false };
      const selected = selectFailedTasks(await store.readTaskIndex(), "personal");
      await store.mutate(state => dismissFailedTasks(state, selected, context));
      expect(selectFailedTasks(await store.readTaskIndex(), "personal")).toEqual([]);
      await store.mutate(state => { state.imports[0]!.state = "processing"; });
      await store.mutate(state => { state.imports[0]!.state = "failed"; });
      expect(selectFailedTasks(await store.readTaskIndex(), "personal")).toHaveLength(1);
      const stale = await store.mutate(state => dismissFailedTasks(state, selected, { ...context, idempotencyKey: "old-confirmation-new-key" }));
      expect(stale.results[0]).toMatchObject({ status: "skipped", reason: "TASK_CHANGED" });
      // Replaying the old confirmation returns its receipt, without hiding the new failure.
      await store.mutate(state => dismissFailedTasks(state, selected, context));
      expect(selectFailedTasks(await store.readTaskIndex(), "personal")).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects an unused old confirmation across an identical failure cycle with a fixed clock and after reopening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "course-os-dismiss-incarnation-"));
    const at = "2026-10-03T00:00:00.000Z";
    const fixedClock = vi.spyOn(Date.prototype, "toISOString").mockReturnValue(at);
    try {
      const path = join(directory, "operations.json");
      const store = new OperationalStore(path);
      const record: ImportRecord = { id: "same-failure-import", workspaceId: "personal", originalName: "synthetic.pdf", mediaType: "application/pdf",
        kind: "pdf", sizeBytes: 10, sha256: "synthetic", casPath: "synthetic", source: "synthetic", license: "synthetic", sensitivity: "private",
        state: "failed", generationState: "queued", issues: ["SAME_FAILURE"], createdAt: at };
      Object.assign(record, { updatedAt: at });
      await store.mutate(state => { state.imports.push(record); });
      const oldConfirmation = selectFailedTasks(await store.readTaskIndex(), "personal");
      // The old confirmation has never been submitted; request replay cannot protect it.
      await store.mutate(state => { state.imports[0]!.state = "processing"; });
      const reopened = new OperationalStore(path);
      await reopened.mutate(state => { state.imports[0]!.state = "failed"; });
      const current = selectFailedTasks(await reopened.readTaskIndex(), "personal");
      expect(current[0]!.fingerprint).not.toBe(oldConfirmation[0]!.fingerprint);
      const persisted = JSON.parse(await readFile(path, "utf8")) as { imports: Array<ImportRecord & { taskIncarnation: number; updatedAt: string }> };
      expect(persisted.imports[0]).toMatchObject({ state: "failed", updatedAt: at, taskIncarnation: 2 });
      const context = { workspaceId: "personal", actor: "test-actor", idempotencyKey: "unused-old-confirmation", hasActiveWrites: () => false };
      expect((await reopened.mutate(state => dismissFailedTasks(state, oldConfirmation, context))).results[0])
        .toMatchObject({ status: "skipped", reason: "TASK_CHANGED" });
      expect(selectFailedTasks(await reopened.readTaskIndex(), "personal")).toHaveLength(1);
      expect((await reopened.mutate(state => dismissFailedTasks(state, current, { ...context, idempotencyKey: "new-confirmation" }))).results[0]?.status).toBe("dismissed");
    } finally {
      fixedClock.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("protects standalone jobs across row-scoped recovery and same-state stale projections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "course-os-job-dismiss-incarnation-"));
    try {
      const path = join(directory, "operations.json");
      const store = new OperationalStore(path);
      const job = { ...makeJob(randomUUID()), state: "failed" as const };
      await store.mutate(state => { state.jobs.push(job); });
      const oldConfirmation = selectFailedTasks(await store.readTaskIndex(), job.workspaceId);
      await store.mutateGenerationJob(job.id, current => { current.state = "running"; });
      const reopened = new OperationalStore(path);
      await reopened.mutateGenerationJob(job.id, current => { current.state = "failed"; });
      // All public job fields, including timestamps and attempt, are restored.
      await reopened.mutate(state => { state.jobs[0] = { ...job }; });
      const stored = JSON.parse(await readFile(path, "utf8")) as { jobs: Array<GenerationJob & { taskIncarnation: number }> };
      expect(stored.jobs[0]).toMatchObject({ ...job, taskIncarnation: 2 });
      const context = { workspaceId: job.workspaceId, actor: "test-actor", idempotencyKey: "stale-job-confirmation", hasActiveWrites: () => false };
      expect((await reopened.mutate(state => dismissFailedTasks(state, oldConfirmation, context))).results[0])
        .toMatchObject({ status: "skipped", reason: "TASK_CHANGED" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("protects generation plans across identical failed/running/failed snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "course-os-plan-dismiss-incarnation-"));
    try {
      const path = join(directory, "operations.json");
      const store = new OperationalStore(path);
      const at = "2026-10-03T00:00:00.000Z";
      const plan: GenerationPlan = { id: "plan-incarnation", workspaceId: "personal", materialVersionId: "synthetic", qualityMode: "balanced", language: "zh-CN",
        writingPolicySnapshotId: "synthetic", pageIds: ["synthetic-page"], completedPageIds: [], failedPageIds: ["synthetic-page"], jobIds: [],
        budgetUsd: 0, spentUsd: 0, holdForReview: false, state: "failed", createdAt: at, updatedAt: at };
      await store.mutate(state => { state.generationPlans.push(plan); });
      const oldConfirmation = selectFailedTasks(await store.readTaskIndex(), "personal");
      await store.mutate(state => { state.generationPlans[0]!.state = "running"; });
      const reopened = new OperationalStore(path);
      await reopened.mutate(state => { state.generationPlans[0]!.state = "failed"; });
      expect((await reopened.mutate(state => dismissFailedTasks(state, oldConfirmation, {
        workspaceId: "personal", actor: "test-actor", idempotencyKey: "stale-plan-confirmation", hasActiveWrites: () => false
      }))).results[0]).toMatchObject({ status: "skipped", reason: "TASK_CHANGED" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("reopens only task markers, without normalizing full operational state or exposing original request keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "course-os-task-dismiss-index-"));
    try {
      const path = join(directory, "operations.json");
      const store = new OperationalStore(path);
      const job = { ...makeJob(randomUUID()), state: "failed" as const };
      await store.mutate(state => {
        state.jobs.push(job);
        state.idempotency["original-request"] = { kind: "job", objectId: job.id };
        store.appendEvent(state, job.id, "generation.cost.recorded", { syntheticCost: 0.01 });
      });
      const selected = selectFailedTasks(await store.readTaskIndex(), job.workspaceId);
      const context = { workspaceId: job.workspaceId, actor: "test-actor", idempotencyKey: "clear-failed", hasActiveWrites: () => false };
      const receipt = await store.mutate(state => dismissFailedTasks(state, selected, context));
      const reopened = new OperationalStore(path);
      const fullRead = vi.spyOn(reopened, "read").mockRejectedValue(new Error("FULL_OPERATIONAL_READ_NOT_ALLOWED"));
      try {
        const index = await reopened.readTaskIndex();
        expect(fullRead).not.toHaveBeenCalled();
        expect(index.jobs).toEqual([job]);
        expect(Object.values(index.taskDismissals ?? {}).map(entry => entry.kind)).toEqual(["taskdismissal"]);
        expect(JSON.stringify(index)).not.toContain("original-request");
        expect(JSON.stringify(index)).not.toContain("syntheticCost");
        expect(isTaskDismissed(index, job.workspaceId, { kind: "job", id: job.id })).toBe(true);
      } finally { fullRead.mockRestore(); }
      expect(await reopened.mutate(state => dismissFailedTasks(state, selected, context))).toEqual(receipt);
      const saved = await reopened.read();
      expect(saved.events).toHaveLength(1);
      expect(saved.idempotency["original-request"]).toEqual({ kind: "job", objectId: job.id });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("selects only per-task markers in PostgreSQL SQL and keeps legacy marker-free TaskIndex shape", async () => {
    // Test the read method without initializing or connecting to any database.
    const store = Object.create(PostgresOperationalStore.prototype) as PostgresOperationalStore;
    const query = vi.fn().mockImplementation(async (sql: string) => ({ rows: sql.startsWith("WITH source AS MATERIALIZED")
      ? [{ imports: [], jobs: [], generationPlans: [], relationalJobs: [], taskDismissals: {} }] : [] }));
    const release = vi.fn();
    const connect = vi.fn().mockResolvedValue({ query, release });
    Object.assign(store, { ready: Promise.resolve(), pool: { connect } });
    expect(await store.readTaskIndex()).toEqual({ imports: [], jobs: [], generationPlans: [] });
    expect(connect).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]![0]).toBe("BEGIN READ ONLY");
    expect(query.mock.calls[1]![0]).toMatch(/^SET LOCAL statement_timeout = \d+$/);
    expect(query.mock.calls.at(-1)![0]).toBe("COMMIT");
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
    const sql = query.mock.calls.find(([text]) => text.startsWith("WITH source AS MATERIALIZED"))![0] as string;
    expect(sql).toContain("SELECT state || '{}'::jsonb AS state FROM operational_state WHERE id = 1");
    expect(sql).toContain("entry.value->>'kind' = 'taskdismissal'");
    expect(sql).toContain("entry.key LIKE 'course-os:task-dismissal:v1:%'");
    expect(sql).not.toMatch(/SELECT\s+state\s+FROM/i);
    expect(sql).not.toContain("state->'events'");
    expect(sql).not.toContain("state->'selfRetellings'");
    expect(sql).not.toContain("state->'generationCheckpoints'");
  });
});

interface PostgresFixture {
  pool: pg.Pool;
  store: PostgresOperationalStore;
  originalState: Partial<OperationalState>;
  jobs: GenerationJob[];
}

postgresDescribe("PostgreSQL operational job storage", () => {
  it("reads one canonical job without querying operational state and overrides the legacy copy", async () => {
    const job = makeJob(randomUUID());
    const fixture = await startFixture([job]);
    try {
      const canonical = { ...job, state: "running" as const, attempt: 3, cancelRequested: true,
        lease: { owner: "synthetic-worker", fenceToken: 4, expiresAt: new Date(Date.now()+60000).toISOString() } };
      await fixture.pool.query("UPDATE generation_jobs SET job_data=$2::jsonb WHERE id=$1", [job.id, JSON.stringify(canonical)]);
      const fullRead = vi.spyOn(fixture.store, "read").mockRejectedValue(new Error("FULL_STATE_FORBIDDEN"));
      const indexRead = vi.spyOn(fixture.store, "readTaskIndex").mockRejectedValue(new Error("TASK_INDEX_FORBIDDEN"));
      const query = vi.spyOn(fixture.store as unknown as { readQuery(text: string, values: unknown[]): Promise<unknown> }, "readQuery");
      expect(await fixture.store.readGenerationJob(job.id)).toEqual(canonical);
      expect(query).toHaveBeenCalledExactlyOnceWith(
        "SELECT job_data FROM generation_jobs WHERE id::text = $1 AND job_data IS NOT NULL", [job.id]
      );
      expect(fullRead).not.toHaveBeenCalled();
      expect(indexRead).not.toHaveBeenCalled();
    } finally { await stopFixture(fixture); }
  }, 15000);

  it("reads one legacy job only when canonical job data is absent and returns missing safely", async () => {
    const job = makeJob(randomUUID());
    const fixture = await startFixture([job]);
    try {
      await fixture.pool.query("DELETE FROM generation_jobs WHERE id=$1", [job.id]);
      const fullRead = vi.spyOn(fixture.store, "read").mockRejectedValue(new Error("FULL_STATE_FORBIDDEN"));
      const indexRead = vi.spyOn(fixture.store, "readTaskIndex").mockRejectedValue(new Error("TASK_INDEX_FORBIDDEN"));
      const query = vi.spyOn(fixture.store as unknown as { readQuery(text: string, values: unknown[]): Promise<unknown> }, "readQuery");
      expect(await fixture.store.readGenerationJob(job.id)).toEqual(job);
      expect(query).toHaveBeenCalledTimes(2);
      expect(query.mock.calls[0]![0]).not.toContain("operational_state");
      expect(query.mock.calls[1]![0]).toContain("state->'jobs'");
      expect(query.mock.calls[1]![1]).toEqual([job.id]);
      await expect(fixture.store.readGenerationJob(randomUUID())).resolves.toBeUndefined();
      expect(fullRead).not.toHaveBeenCalled();
      expect(indexRead).not.toHaveBeenCalled();
    } finally { await stopFixture(fixture); }
  }, 15000);

  it("gives background recovery its own finite budget while retaining a shorter foreground deadline", async () => {
    const store = new PostgresOperationalStore({ connectionString: connectionString!, max: 1 });
    await store.whenReady();
    try {
      const reader = store as unknown as { readQuery(text: string): Promise<pg.QueryResult> };
      await expect(reader.readQuery("SELECT pg_sleep(8.1)"))
        .resolves.toHaveProperty("rowCount", 1);
      await expect(withReadBudget({ timeoutMs: 300 }, () => reader.readQuery("SELECT pg_sleep(2)")))
        .rejects.toThrow("READ_DEADLINE_EXCEEDED");
      await expect(store.getImport("missing-synthetic-import", "synthetic")).resolves.toBeUndefined();
    } finally { await store.close(); }
  }, 20000);

  it("bounds a real read query in PostgreSQL and leaves the next read usable", async () => {
    const store = new PostgresOperationalStore({ connectionString: connectionString!, max: 1 });
    await store.whenReady();
    try {
      const reader = store as unknown as { readQuery(text: string): Promise<pg.QueryResult> };
      const started = performance.now();
      await expect(withReadBudget({ timeoutMs: 300 }, () => reader.readQuery("SELECT pg_sleep(2)")))
        .rejects.toThrow("READ_DEADLINE_EXCEEDED");
      expect(performance.now() - started).toBeLessThan(1200);
      await expect(store.getImport("missing-synthetic-import", "synthetic")).resolves.toBeUndefined();
      const pool = (store as unknown as { pool: pg.Pool }).pool;
      const timeout = await pool.query("SHOW statement_timeout");
      expect(timeout.rows[0].statement_timeout).toBe("0");
      expect(pool.waitingCount).toBe(0);
      console.log(JSON.stringify({ probe: "pg-read-budget-sleep", elapsedMs: performance.now() - started, nextReadUsable: true }));
    } finally { await store.close(); }
  }, 15000);

  it("bounds pool queue wait and releases a client acquired after the request expires", async () => {
    const store = new PostgresOperationalStore({ connectionString: connectionString!, max: 1 });
    await store.whenReady();
    const pool = (store as unknown as { pool: pg.Pool }).pool;
    const held = await pool.connect();
    let heldReleased = false;
    try {
      await expect(withReadBudget({ timeoutMs: 100 }, () => store.getImport("missing", "synthetic")))
        .rejects.toThrow("READ_DEADLINE_EXCEEDED");
      held.release();
      heldReleased = true;
      await expect(store.readImportByOperation("missing", "synthetic"))
        .resolves.toEqual({ association: undefined, record: undefined });
      await expect(store.readImportGenerationPlan("missing", "synthetic")).resolves.toBeUndefined();
      expect(await store.readTaskIndex()).toHaveProperty("imports");
      expect(pool.waitingCount).toBe(0);
      expect(pool.idleCount).toBe(1);
    } finally {
      if (!heldReleased) held.release();
      await store.close();
    }
  }, 15000);

  it("scopes import writes, rolls back events, and preserves history, markers and unrelated associations", async () => {
    const job = { ...makeJob(randomUUID()), state: "failed" as const };
    const fixture = await startFixture([job], true);
    const record = makeImport(job.id);
    try {
      await fixture.store.mutateImports((state, context) => {
        state.imports.push(record);
        state.idempotency["unrelated-operation"] = { kind: "job", objectId: job.id };
        context.appendEvent(record.id, "import.accepted", { synthetic: true });
      });
      expect(await fixture.store.getImport(record.id, record.workspaceId)).toMatchObject({ attemptStartedAt: record.createdAt });
      const baseline = (await fixture.pool.query<{ state: OperationalState }>("SELECT state FROM operational_state WHERE id=1")).rows[0]!.state;
      const emitted: OrderedEvent[] = [];
      fixture.store.bus.on(record.id, event => emitted.push(event));
      const fullRead = vi.spyOn(fixture.store, "read").mockRejectedValue(new Error("FULL_STATE_FORBIDDEN"));
      await fixture.store.mutateImports((state, context) => {
        expect(Object.keys(state).sort()).toEqual(["idempotency", "imports"]);
        state.imports.find(item => item.id === record.id)!.state = "processing";
        state.idempotency["scoped-import-operation"] = { kind: "import", objectId: record.id };
        context.appendEvent(record.id, "conversion.started", { synthetic: true });
      });
      expect(await fixture.store.getImport(record.id, record.workspaceId)).toMatchObject({
        state: "processing", taskIncarnation: 1, attemptStartedAt: record.createdAt
      });
      expect(await fixture.store.getImport(record.id, "other")).toBeUndefined();
      expect(await fixture.store.readImportByOperation("scoped-import-operation", record.workspaceId)).toMatchObject({ record: { id: record.id } });
      expect(await fixture.store.readImportByOperation("scoped-import-operation", "other")).toMatchObject({ association: { kind: "import" }, record: undefined });
      expect(await fixture.store.readImportByOperation("unrelated-operation", record.workspaceId)).toEqual({ association: { kind: "job", objectId: job.id }, record: undefined });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.id).toBeGreaterThan(0);
      expect(await fixture.store.readGenerationJobEvents(record.id)).toContainEqual(emitted[0]);
      const persisted = (await fixture.pool.query<{ state: OperationalState }>("SELECT state FROM operational_state WHERE id=1")).rows[0]!.state;
      expect({ ...persisted, imports: baseline.imports, idempotency: baseline.idempotency }).toEqual(baseline);
      await expect(fixture.store.mutateImports((state, context) => {
        state.imports.find(item => item.id === record.id)!.state = "failed";
        context.appendEvent(record.id, "import.failed", { synthetic: true });
        throw new Error("ROLLBACK_SYNTHETIC");
      })).rejects.toThrow("ROLLBACK_SYNTHETIC");
      await expect(fixture.store.mutateImports((_state, context) => context.appendEvent(record.id, "generation.cost.recorded", {})))
        .rejects.toThrow("IMPORT_EVENT_SCOPE_INVALID");
      expect(emitted).toHaveLength(1);
      expect(await fixture.store.getImport(record.id, record.workspaceId)).toMatchObject({ state: "processing", taskIncarnation: 1 });
      fullRead.mockRestore();
      await fixture.store.mutateImports((state, context) => {
        state.imports.find(item => item.id === record.id)!.state = "failed";
        context.appendEvent(record.id, "import.failed", { synthetic: true });
      });
      const firstEnd = (await fixture.store.getImport(record.id, record.workspaceId))!.endedAt;
      expect(firstEnd).toBeTypeOf("string");
      await fixture.store.mutateImports((_state, context) => context.appendEvent(record.id, "import.failed", { duplicate: true }));
      expect((await fixture.store.getImport(record.id, record.workspaceId))!.endedAt).toBe(firstEnd);
      await fixture.store.mutateImports((state, context) => {
        state.imports.find(item => item.id === record.id)!.state = "processing";
        context.appendEvent(record.id, "conversion.started", { retry: true });
      });
      const restarted = await fixture.store.getImport(record.id, record.workspaceId);
      const latestImportEvent = (await fixture.store.readGenerationJobEvents(record.id)).at(-1)!;
      expect(restarted).toMatchObject({ state: "processing", attemptStartedAt: latestImportEvent.occurredAt });
      expect(restarted!.endedAt).toBeUndefined();
      await fixture.store.mutateImports(state => { state.imports.find(item => item.id === record.id)!.state = "failed"; });
      const selected = selectFailedTasks(await fixture.store.readTaskIndex(), record.workspaceId).filter(task => task.id === record.id);
      const cleanupContext = { workspaceId: record.workspaceId, actor: "synthetic", idempotencyKey: "scoped-import-dismiss", hasActiveWrites: () => false };
      await fixture.store.mutate(state => dismissFailedTasks(state, selected, cleanupContext));
      await fixture.store.mutateImports(state => { state.imports.find(item => item.id === record.id)!.state = "processing"; });
      await fixture.store.mutateImports(state => { state.imports.find(item => item.id === record.id)!.state = "failed"; });
      expect(isTaskDismissed(await fixture.store.readTaskIndex(), record.workspaceId, { kind: "import", id: record.id })).toBe(false);
      expect((await fixture.store.mutate(state => dismissFailedTasks(state, selected, { ...cleanupContext, idempotencyKey: "stale-scoped-import" }))).results[0])
        .toMatchObject({ reason: "TASK_CHANGED" });
    } finally { await stopFixture(fixture); }
  });

  it("serializes scoped imports with the same global row lock and concurrent idempotency replay", async () => {
    const job = makeJob(randomUUID());
    const fixture = await startFixture([job]);
    const blocker = await fixture.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM operational_state WHERE id=1 FOR UPDATE");
      const record = makeImport(job.id);
      let callbackEntered = false;
      const create = () => fixture.store.mutateImports((state, context) => {
        callbackEntered = true;
        const existing = state.idempotency["same-import-key"];
        if (existing) return state.imports.find(item => item.id === existing.objectId)!;
        state.imports.push(record);
        state.idempotency["same-import-key"] = { kind: "import", objectId: record.id };
        context.appendEvent(record.id, "import.accepted", {});
        return record;
      });
      const first = create();
      const replay = create();
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(callbackEntered).toBe(false);
      const session = makeSession(randomUUID());
      await blocker.query("UPDATE operational_state SET state=jsonb_set(state,'{sessions}',COALESCE(state->'sessions','[]'::jsonb)||$1::jsonb) WHERE id=1", [JSON.stringify(session)]);
      await blocker.query("COMMIT");
      expect((await Promise.all([first, replay])).map(item => item.id)).toEqual([record.id, record.id]);
      expect(await fixture.store.findLearningSession(session.id)).toEqual(session);
      expect(await fixture.store.readGenerationJobEvents(record.id)).toHaveLength(1);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await stopFixture(fixture);
    }
  });

  it("measures scoped imports against full mutation with bounded synthetic history", async () => {
    const job = makeJob(randomUUID());
    const fixture = await startFixture([job]);
    const record = makeImport(job.id);
    try {
      const state = { ...structuredClone(EMPTY), imports: [record], jobs: [job],
        events: Array.from({ length: 45306 }, (_, i) => ({ id: i + 1, streamId: job.id, type: "synthetic.history", payload: { text: "x".repeat(280) }, occurredAt: job.createdAt })),
        generationCheckpoints: { [`${job.id}:page-1`]: { ...makeCheckpoint("bounded-history"), evidence: "x".repeat(3000000) } } };
      await fixture.pool.query("UPDATE operational_state SET state=$1::jsonb WHERE id=1", [JSON.stringify(state)]);
      await fixture.pool.query("INSERT INTO ordered_events (stream_id,event_type,payload,occurred_at) SELECT $1,'synthetic.history',jsonb_build_object('text',repeat('x',280)),now() FROM generate_series(1,41365)", [job.id]);
      const beforeBytes = (await fixture.pool.query("SELECT octet_length(state::text)::int AS bytes FROM operational_state WHERE id=1")).rows[0].bytes;
      let started = performance.now();
      await fixture.store.mutate(current => { current.imports[0]!.state = "processing"; });
      const fullMutationMs = performance.now() - started;
      const before = (await fixture.pool.query("SELECT md5((state-'imports'-'idempotency')::text) AS hash FROM operational_state WHERE id=1")).rows[0].hash;
      started = performance.now();
      await fixture.store.mutateImports((current, context) => {
        current.imports[0]!.state = "syncing";
        context.appendEvent(record.id, "readweave.sync.started", { synthetic: true });
      });
      const scopedMutationMs = performance.now() - started;
      started = performance.now();
      await fixture.store.getImport(record.id, record.workspaceId);
      const scopedReadMs = performance.now() - started;
      const after = (await fixture.pool.query("SELECT md5((state-'imports'-'idempotency')::text) AS hash FROM operational_state WHERE id=1")).rows[0].hash;
      expect(after).toBe(before);
      console.log(JSON.stringify({ probe: "scoped-import-isolated-pg", beforeBytes, fullMutationMs, scopedMutationMs, scopedReadMs, restUnchanged: after === before }));
    } finally { await stopFixture(fixture); }
  }, 60000);

  it("advances job incarnations under the row lock and rejects a stale failure confirmation", async () => {
    const job = { ...makeJob(randomUUID()), state: "failed" as const };
    const fixture = await startFixture([job]);
    try {
      const oldConfirmation = selectFailedTasks(await fixture.store.readTaskIndex(), job.workspaceId).filter(task => task.id === job.id);
      await fixture.store.mutateGenerationJob(job.id, current => { current.state = "running"; });
      await fixture.store.mutateGenerationJob(job.id, current => { current.state = "failed"; });
      const rows = await fixture.pool.query<{ job_data: GenerationJob & { taskIncarnation: number } }>("SELECT job_data FROM generation_jobs WHERE id = $1", [job.id]);
      expect(rows.rows[0]!.job_data).toMatchObject({ ...job, taskIncarnation: 2 });
      expect((await fixture.store.mutate(state => dismissFailedTasks(state, oldConfirmation, {
        workspaceId: job.workspaceId, actor: "test-actor", idempotencyKey: `old-confirmation:${job.id}`, hasActiveWrites: () => false
      }))).results[0]).toMatchObject({ status: "skipped", reason: "TASK_CHANGED" });
    } finally { await stopFixture(fixture); }
  });
  it("persists dismissal markers in existing JSON state while retaining relational jobs, costs and idempotency", async () => {
    const job = { ...makeJob(randomUUID()), state: "failed" as const };
    const fixture = await startFixture([job]);
    try {
      await fixture.store.mutate(state => { state.idempotency[`original:${job.id}`] = { kind: "job", objectId: job.id }; });
      const selected = selectFailedTasks(await fixture.store.readTaskIndex(), job.workspaceId).filter(task => task.id === job.id);
      expect(selected).toHaveLength(1);
      const context = { workspaceId: job.workspaceId, actor: "test-actor", idempotencyKey: `dismiss:${job.id}`, hasActiveWrites: () => false };
      const receipt = await fixture.store.mutate(state => dismissFailedTasks(state, selected, context));
      expect(receipt.results[0]?.status).toBe("dismissed");
      const index = await fixture.store.readTaskIndex();
      expect(isTaskDismissed(index, job.workspaceId, { kind: "job", id: job.id })).toBe(true);
      expect(Object.values(index.taskDismissals ?? {}).every(entry => entry.kind === "taskdismissal")).toBe(true);
      const persisted = await fixture.pool.query<{ state: OperationalState }>("SELECT state FROM operational_state WHERE id = 1");
      expect(persisted.rows[0]!.state.idempotency[`original:${job.id}`]).toEqual({ kind: "job", objectId: job.id });
      const relational = await fixture.pool.query<{ job_data: GenerationJob }>("SELECT job_data FROM generation_jobs WHERE id = $1", [job.id]);
      expect(relational.rows[0]?.job_data).toMatchObject({ id: job.id, state: "failed", spentUsd: job.spentUsd });
      expect(await fixture.store.mutate(state => dismissFailedTasks(state, selected, context))).toEqual(receipt);
    } finally { await stopFixture(fixture); }
  });
  it("merges one job's legacy events with relational events taking precedence by ID", async () => {
    const job = makeJob(randomUUID());
    const fixture = await startFixture([job]);
    try {
      await fixture.store.mutateGenerationJob(job.id, (_current, context) => {
        context.appendEvent("generation.stage.completed", { source: "relational" });
      });
      const relationalResult = await fixture.pool.query<{ id: string; occurred_at: Date }>(
        "SELECT id, occurred_at FROM ordered_events WHERE stream_id = $1", [job.id]
      );
      const relational = relationalResult.rows[0]!;
      const legacyOnlyIdResult = await fixture.pool.query<{ id: string }>(
        "SELECT nextval(pg_get_serial_sequence('ordered_events', 'id')::regclass)::text AS id"
      );
      const occurredAt = new Date(relational.occurred_at).toISOString();
      const legacyEvents: OrderedEvent[] = [
        { id: Number(legacyOnlyIdResult.rows[0]!.id), streamId: job.id, type: "generation.stage.started", occurredAt, payload: { source: "legacy-only" } },
        { id: Number(relational.id), streamId: job.id, type: "generation.stage.started", occurredAt, payload: { source: "legacy-conflict" } }
      ];
      await fixture.pool.query(
        `UPDATE operational_state
         SET state = jsonb_set(state, '{events}',
           (CASE WHEN jsonb_typeof(state->'events') = 'array' THEN state->'events' ELSE '[]'::jsonb END) || $1::jsonb)
         WHERE id = 1`, [JSON.stringify(legacyEvents)]
      );

      const events = await fixture.store.readGenerationJobEvents(job.id);
      expect(events).toHaveLength(2);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: legacyEvents[0]!.id, payload: { source: "legacy-only" } }),
        expect.objectContaining({ id: Number(relational.id), type: "generation.stage.completed", payload: { source: "relational" } })
      ]));
    } finally {
      await stopFixture(fixture);
    }
  });

  it("reads model settings with the same defaults without calling the full-state reader", async () => {
    const fixture = await startFixture([]);
    try {
      await fixture.pool.query(
        "UPDATE operational_state SET state = state || '{\"modelProviders\":[],\"modelRoutePolicy\":null}'::jsonb WHERE id = 1"
      );
      const fullRead = vi.spyOn(fixture.store, "read").mockRejectedValue(new Error("FULL_STATE_READ"));
      const query = vi.spyOn((fixture.store as unknown as { pool: pg.Pool }).pool, "query");
      await expect(fixture.store.readModelSettings()).resolves.toEqual({
        modelProviders: EMPTY.modelProviders,
        modelRoutePolicy: EMPTY.modelRoutePolicy
      });
      expect(fullRead).not.toHaveBeenCalled();
      const sql = String(query.mock.calls.at(-1)?.[0]);
      expect(sql).toContain("state->'modelProviders'");
      expect(sql).toContain("state->'modelRoutePolicy'");
      expect(sql).not.toContain("state->'events'");
      expect(sql).not.toMatch(/\bSELECT\s+(?:\w+\.)?state\s*(?=,|\bAS\b|\bFROM\b)/i);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("reads workspace retellings from the existing JSON field without loading full operational state", async () => {
    const fixture = await startFixture([]);
    try {
      const records = {
        personal: { workspaceId: "personal", releaseId: "release-1", pageId: "page-1", answer: "owned",
          answeredAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nextReviewAt: "2026-01-02T00:00:00.000Z" },
        anotherRelease: { workspaceId: "personal", releaseId: "release-2", pageId: "page-2", answer: "other release",
          answeredAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nextReviewAt: "2026-01-02T00:00:00.000Z" },
        anotherWorkspace: { workspaceId: "other", releaseId: "release-1", pageId: "page-3", answer: "other workspace",
          answeredAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nextReviewAt: "2026-01-02T00:00:00.000Z" }
      };
      await fixture.pool.query(
        "UPDATE operational_state SET state = jsonb_set(state, '{selfRetellings}', $1::jsonb, true) WHERE id = 1",
        [JSON.stringify(records)]
      );
      const fullRead = vi.spyOn(fixture.store, "read").mockRejectedValue(new Error("FULL_STATE_READ"));
      const query = vi.spyOn((fixture.store as unknown as { pool: pg.Pool }).pool, "query");

      await expect(fixture.store.readSelfRetellings("personal", "release-1")).resolves.toEqual([records.personal]);

      expect(fullRead).not.toHaveBeenCalled();
      const sql = String(query.mock.calls.at(-1)?.[0]);
      expect(sql).toContain("jsonb_each");
      expect(sql).toContain("entry.value->>'workspaceId'");
      expect(sql).toContain("entry.value->>'releaseId'");
      expect(sql).not.toMatch(/SELECT\s+(?:\w+\.)?state\s*(?=,|\bAS\b|\bFROM\b)/i);
      fullRead.mockRestore();
    } finally {
      await stopFixture(fixture);
    }
  });

  it("reads one plan's jobs and events without loading all operational state", async () => {
    const planId = randomUUID();
    const selectedJob = { ...makeJob(randomUUID()), planId };
    const unrelatedJob = { ...makeJob(randomUUID()), planId: randomUUID() };
    const fixture = await startFixture([selectedJob, unrelatedJob]);
    const now = new Date().toISOString();
    const plan: GenerationPlan = {
      id: planId, workspaceId: selectedJob.workspaceId, materialVersionId: selectedJob.materialVersionId,
      qualityMode: "quality", language: "zh-CN", writingPolicySnapshotId: "policy-test",
      pageIds: ["page-1"], completedPageIds: [], failedPageIds: [], jobIds: [selectedJob.id],
      budgetUsd: 1, spentUsd: 0, holdForReview: false, state: "running", createdAt: now, updatedAt: now
    };
    try {
      await fixture.store.mutate((state) => { state.generationPlans.push(plan); });
      await fixture.store.mutateGenerationJob(selectedJob.id, (_job, context) => {
        context.appendEvent("generation.stage.started", { stage: "teach" });
      });
      await fixture.store.mutateGenerationJob(unrelatedJob.id, (_job, context) => {
        context.appendEvent("generation.stage.started", { stage: "teach", unrelated: true });
      });
      const fullRead = vi.spyOn(fixture.store, "read").mockRejectedValue(new Error("FULL_STATE_READ"));
      const query = vi.spyOn(fixture.store as unknown as { readQuery(text: string, values: unknown[]): Promise<unknown> }, "readQuery");
      const detail = await fixture.store.readGenerationPlanDetail(planId, selectedJob.workspaceId);
      expect(query).toHaveBeenCalledOnce();
      expect(query.mock.calls[0]![0]).toContain("WITH source AS MATERIALIZED");
      expect(detail.plan?.id).toBe(planId);
      expect(detail.jobs.map((job) => job.id)).toEqual([selectedJob.id]);
      expect(detail.events).toHaveLength(1);
      expect(detail.events[0]?.streamId).toBe(selectedJob.id);
      expect(await fixture.store.readGenerationPlanDetail(planId, "other-workspace")).toEqual({ jobs: [], events: [] });
      expect(await fixture.store.readGenerationPlanDetail(randomUUID(), selectedJob.workspaceId)).toEqual({ jobs: [], events: [] });
      expect(fullRead).not.toHaveBeenCalled();
      fullRead.mockRestore();
    } finally {
      await stopFixture(fixture);
    }
  }, 15000);

  it("preserves plan detail legacy order, canonical precedence and event eligibility after job merging", async () => {
    const planId = randomUUID();
    const legacyJob = { ...makeJob(randomUUID()), planId };
    const canonicalJob = { ...makeJob(randomUUID()), planId };
    const redirectedJob = { ...makeJob(randomUUID()), planId };
    const linkedJob = { ...makeJob(randomUUID()), planId: randomUUID() };
    const fixture = await startFixture([legacyJob, redirectedJob, canonicalJob, linkedJob]);
    const now = new Date().toISOString();
    const plan: GenerationPlan = {
      id: planId, workspaceId: legacyJob.workspaceId, materialVersionId: legacyJob.materialVersionId,
      qualityMode: "quality", language: "zh-CN", writingPolicySnapshotId: "policy-test",
      pageIds: ["page-1"], completedPageIds: [], failedPageIds: [], jobIds: [canonicalJob.id, ""],
      currentJobId: linkedJob.id, lastJobId: redirectedJob.id,
      budgetUsd: 1, spentUsd: 0, holdForReview: false, state: "running", createdAt: now, updatedAt: now
    };
    try {
      await fixture.store.mutate(state => { state.generationPlans.push(plan); });
      await fixture.store.mutateGenerationJob(canonicalJob.id, (_job, context) => {
        context.appendEvent("generation.stage.started", { authority: "canonical" });
      });
      const relationalEvent = (await fixture.store.readGenerationJobEvents(canonicalJob.id))[0]!;
      const changedCanonical = { ...canonicalJob, attempt: 3, cancelRequested: true };
      const changedRedirected = { ...redirectedJob, planId: randomUUID(), attempt: 2 };
      await fixture.pool.query("UPDATE generation_jobs SET job_data=$2::jsonb WHERE id=$1", [canonicalJob.id, JSON.stringify(changedCanonical)]);
      await fixture.pool.query("UPDATE generation_jobs SET job_data=$2::jsonb WHERE id=$1", [redirectedJob.id, JSON.stringify(changedRedirected)]);
      await fixture.pool.query("DELETE FROM generation_jobs WHERE id=$1", [legacyJob.id]);
      const baseId = Number((await fixture.pool.query("SELECT COALESCE(MAX(id),0)::text AS id FROM ordered_events")).rows[0].id)+10;
      const legacyEvent: OrderedEvent = { id: baseId, streamId: legacyJob.id, type: "generation.stage.completed", occurredAt: now, payload: { authority: "legacy" } };
      const events: OrderedEvent[] = [
        { ...relationalEvent, payload: { authority: "stale-json" } }, legacyEvent,
        { ...legacyEvent, id: baseId+1, streamId: linkedJob.id },
        { ...legacyEvent, id: baseId+2, streamId: redirectedJob.id },
        { ...legacyEvent, id: baseId+3, type: "job.queued" }
      ];
      await fixture.pool.query("UPDATE operational_state SET state=jsonb_set(jsonb_set(state,'{jobs}',$1::jsonb),'{events}',$2::jsonb) WHERE id=1",
        [JSON.stringify([legacyJob, redirectedJob, linkedJob]), JSON.stringify(events)]);
      const detail = await fixture.store.readGenerationPlanDetail(planId, legacyJob.workspaceId);
      expect(detail.plan).toEqual(plan);
      expect(detail.jobs).toEqual([legacyJob, changedRedirected, linkedJob, changedCanonical]);
      expect(detail.events).toEqual([relationalEvent, legacyEvent]);
    } finally { await stopFixture(fixture); }
  }, 15000);

  it("updates one session without changing the generation projection", async () => {
    const fixture = await startFixture([]);
    const session = makeSession(randomUUID());
    try {
      const before = await fixture.pool.query<{ jobs: unknown; events: unknown }>(
        "SELECT state->'jobs' AS jobs, state->'events' AS events FROM operational_state WHERE id = 1"
      );
      await fixture.store.createLearningSession(session);
      expect(await fixture.store.findLearningSession(session.id)).toEqual(session);
      expect(await fixture.store.patchLearningSession(session.id, "other", { zoom: 2 })).toBeUndefined();
      const updated = await fixture.store.patchLearningSession(session.id, session.workspaceId!, { zoom: 2 });
      expect(updated).toMatchObject({ id: session.id, zoom: 2, currentPageId: "page-1" });
      const projected = await fixture.store.read();
      expect(projected.sessions.filter(item => item.id === session.id)).toHaveLength(1);
      const after = await fixture.pool.query<{ jobs: unknown; events: unknown }>(
        "SELECT state->'jobs' AS jobs, state->'events' AS events FROM operational_state WHERE id = 1"
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("creates a new generation job through the production mutation path", async () => {
    const fixture = await startFixture([]);
    const job = makeJob(randomUUID());
    fixture.jobs.push(job);
    try {
      await fixture.store.mutate(state => { state.jobs.push(job); });
      expect((await fixture.store.readTaskIndex()).jobs.find(item => item.id === job.id)).toMatchObject({ state: "queued" });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("backfills legacy job state, events, and checkpoints into the read projection", async () => {
    const job = makeJob(randomUUID());
    const fixture = await startFixture([job], true);
    try {
      const projected = await fixture.store.read();
      expect(projected.jobs.find(item => item.id === job.id)).toEqual(job);
      expect(projected.generationCheckpoints[`${job.id}:page-1`]).toMatchObject({ fingerprint: "legacy-checkpoint" });
      expect(projected.events).toContainEqual(expect.objectContaining({
        streamId: job.id, type: "job.queued", payload: { source: "legacy-json" }
      } satisfies Partial<OrderedEvent>));

      const changed = await fixture.store.mutateGenerationJob(job.id, (current, context) => {
        current.state = "running";
        current.attempt = 1;
        context.appendEvent("generation.stage.started", { pageId: "page-1", stage: "teach" });
        context.setCheckpoint("page-1", makeCheckpoint("scoped-checkpoint"));
        return current.attempt;
      });
      expect(changed).toMatchObject({ job: { id: job.id, state: "running", attempt: 1 }, result: 1 });

      const after = await fixture.store.read();
      expect(after.jobs.find(item => item.id === job.id)).toMatchObject({ state: "running", attempt: 1 });
      expect(after.generationCheckpoints[`${job.id}:page-1`]).toMatchObject({ fingerprint: "scoped-checkpoint" });
      expect(after.events.some(event => event.streamId === job.id && event.type === "generation.stage.started")).toBe(true);
      expect((await fixture.store.readTaskIndex()).jobs.find(item => item.id === job.id)).toMatchObject({ state: "running" });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("commits a job B mutation while another transaction holds the job A row lock", async () => {
    const [jobA, jobB] = [makeJob(randomUUID()), makeJob(randomUUID())];
    const fixture = await startFixture([jobA, jobB]);
    const blockerPool = new pg.Pool({ connectionString, max: 1 });
    const blocker = await blockerPool.connect();
    let timer: NodeJS.Timeout | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM generation_jobs WHERE id = $1 FOR UPDATE", [jobA.id]);

      let timedOut = false;
      const mutation = fixture.store.mutateGenerationJob(jobB.id, current => {
        current.attempt += 1;
        current.state = "running";
        return current.attempt;
      });
      const timeout = new Promise<undefined>(resolve => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(undefined);
        }, 2_000);
      });
      const result = await Promise.race([mutation, timeout]);
      expect(timedOut).toBe(false);
      expect(result).toMatchObject({ job: { id: jobB.id, state: "running", attempt: 1 }, result: 1 });
    } finally {
      if (timer) clearTimeout(timer);
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await blockerPool.end();
      await stopFixture(fixture);
    }
  });
});

postgresDescribe("scoped generation tasks", () => {
  it("persists job and plan timing before their scoped Postgres projections are serialized", async () => {
    const planId = randomUUID();
    const job = { ...makeJob(randomUUID()), planId };
    const fixture = await startFixture([job]);
    const at = job.createdAt;
    const plan: GenerationPlan = {
      id: planId, workspaceId: job.workspaceId, materialVersionId: job.materialVersionId,
      qualityMode: "balanced", language: "en-US", writingPolicySnapshotId: "synthetic-policy",
      pageIds: [...job.pageIds], completedPageIds: [], failedPageIds: [], jobIds: [job.id],
      budgetUsd: 1, spentUsd: 0, holdForReview: false, state: "queued", createdAt: at, updatedAt: at
    };
    try {
      await fixture.store.mutateGenerationTasks(state => {
        state.generationPlans.push(plan);
        fixture.store.appendEvent(state, plan.id, "plan.queued", {});
      }, { planId, readEvents: true });
      expect((await fixture.store.readTaskIndex()).generationPlans[0]).toMatchObject({ attemptStartedAt: at });
      await fixture.store.mutateGenerationJob(job.id, (current, context) => {
        current.attempt = 1;
        current.state = "running";
        context.appendEvent("job.running", { attempt: current.attempt });
      });
      expect(await fixture.store.readGenerationJob(job.id)).toMatchObject({ attemptStartedAt: at });
      const canonicalStart = (await fixture.pool.query<{ job_data: GenerationJob }>(
        "SELECT job_data FROM generation_jobs WHERE id=$1", [job.id]
      )).rows[0]!.job_data.attemptStartedAt;
      expect(canonicalStart).toBe(at);

      await fixture.store.mutateGenerationJob(job.id, (current, context) => {
        current.state = "failed";
        context.appendEvent("job.failed", {});
      });
      const firstJobEnd = (await fixture.store.readGenerationJob(job.id))!.endedAt;
      expect(firstJobEnd).toBeTypeOf("string");
      await fixture.store.mutateGenerationJob(job.id, (_current, context) => context.appendEvent("job.failed", { duplicate: true }));
      expect((await fixture.store.readGenerationJob(job.id))!.endedAt).toBe(firstJobEnd);
      await fixture.store.mutateGenerationJob(job.id, (current, context) => {
        current.attempt = 2;
        current.state = "running";
        context.appendEvent("job.running", { attempt: current.attempt });
      });
      const latestJobEvent = (await fixture.store.readGenerationJobEvents(job.id)).at(-1)!;
      expect(await fixture.store.readGenerationJob(job.id)).toMatchObject({ attemptStartedAt: latestJobEvent.occurredAt });
      expect((await fixture.store.readGenerationJob(job.id))!.endedAt).toBeUndefined();

      await fixture.store.mutateGenerationTasks(state => {
        state.generationPlans[0]!.state = "awaiting_review";
        fixture.store.appendEvent(state, plan.id, "plan.awaiting_review", {});
      }, { planId, readEvents: true });
      const firstPlanEnd = (await fixture.store.readTaskIndex()).generationPlans[0]!.endedAt;
      expect(firstPlanEnd).toBeTypeOf("string");
      await fixture.store.mutateGenerationTasks(state => {
        fixture.store.appendEvent(state, plan.id, "plan.awaiting_review", { repeated: true });
      }, { planId, readEvents: true });
      expect((await fixture.store.readTaskIndex()).generationPlans[0]!.endedAt).toBe(firstPlanEnd);
      await fixture.store.mutateGenerationTasks(state => {
        state.generationPlans[0]!.state = "queued";
        fixture.store.appendEvent(state, plan.id, "plan.retry.queued", {});
      }, { planId, readEvents: true });
      const latestPlanEvent = (await fixture.store.readGenerationJobEvents(plan.id)).at(-1)!;
      expect((await fixture.store.readTaskIndex()).generationPlans[0]).toMatchObject({ attemptStartedAt: latestPlanEvent.occurredAt });
      expect((await fixture.store.readTaskIndex()).generationPlans[0]!.endedAt).toBeUndefined();
    } finally {
      await stopFixture(fixture);
    }
  });

  it("persists replay once, reopens canonical jobs and preserves all history and checkpoint bytes", async () => {
    const original = makeJob(randomUUID());
    const fixture = await startFixture([original], true);
    const added = makeJob(randomUUID());
    fixture.jobs.push(added);
    let reopened: PostgresOperationalStore | undefined;
    try {
      // Large synthetic history is persisted in both formats, but never belongs
      // to the metadata mutation scope. Generate it in SQL, not in the reader.
      await fixture.pool.query(`WITH inserted AS (
        INSERT INTO ordered_events(stream_id,event_type,payload,occurred_at)
        SELECT $1, 'synthetic.history', jsonb_build_object('body',repeat('h',1000000)), now()
        FROM generate_series(1,19)
        RETURNING id,stream_id,event_type,payload,occurred_at
      ) UPDATE operational_state SET state=jsonb_set(state,'{events}',
        COALESCE(state->'events','[]'::jsonb) || (SELECT jsonb_agg(jsonb_build_object(
          'id',id,'streamId',stream_id,'type',event_type,'payload',payload,'occurredAt',occurred_at)
          ORDER BY id) FROM inserted)) WHERE id=1`, [original.id]);
      await fixture.pool.query(`UPDATE operational_state SET state=jsonb_set(state,'{generationCheckpoints}',
        COALESCE(state->'generationCheckpoints','{}'::jsonb) || jsonb_build_object($1::text,
          jsonb_set($2::jsonb,'{content,chapterBridgeMarkdown}',to_jsonb(repeat('c',3000000))))) WHERE id=1`,
        [`${original.id}:heavy-page`, JSON.stringify(makeCheckpoint("synthetic-heavy"))]);
      await fixture.pool.query(`INSERT INTO generation_job_checkpoints(job_id,page_id,checkpoint)
        SELECT $1,'heavy-page',state->'generationCheckpoints'->$2 FROM operational_state WHERE id=1`,
        [original.id, `${original.id}:heavy-page`]);
      const size = await fixture.pool.query(`SELECT octet_length((state->'events')::text) AS events,
        octet_length((state->'generationCheckpoints')::text) AS checkpoints
        FROM operational_state WHERE id=1`);
      expect(size.rows[0].events).toBeGreaterThan(19000000);
      expect(size.rows[0].checkpoints).toBeGreaterThan(3000000);
      const baseline = await fixture.pool.query(`SELECT
        md5((state - 'imports' - 'generationPlans' - 'idempotency')::text) AS rest,
        (SELECT md5(COALESCE(jsonb_agg(to_jsonb(c) ORDER BY job_id, page_id), '[]'::jsonb)::text)
          FROM generation_job_checkpoints c) AS checkpoints,
        (SELECT md5(COALESCE(jsonb_agg(to_jsonb(e) ORDER BY id),'[]'::jsonb)::text)
          FROM ordered_events e WHERE stream_id=$1) AS events
        FROM operational_state WHERE id=1`, [original.id]);
      const emissions: OrderedEvent[] = [];
      fixture.store.bus.on(added.id, event => emissions.push(event));
      const fullRead = vi.spyOn(fixture.store, "read").mockRejectedValue(new Error("FULL_STATE_FORBIDDEN"));
      const persist = () => fixture.store.mutateGenerationTasks(state => {
        expect(Object.keys(state).sort()).toEqual(["events", "generationPlans", "idempotency", "imports", "jobs"]);
        expect(state.events).toEqual([]);
        expect(state.jobs.find(job => job.id === original.id)).toEqual(original);
        const key = `synthetic-task:${added.id}`;
        if (state.idempotency[key]) return false;
        state.jobs.push(added);
        state.idempotency[key] = { kind: "job", objectId: added.id };
        fixture.store.appendEvent(state, added.id, "job.queued", { synthetic: true });
        return true;
      });
      expect(await persist()).toBe(true);
      expect(await persist()).toBe(false);
      expect(fullRead).not.toHaveBeenCalled();
      fullRead.mockRestore();
      expect(emissions).toHaveLength(1);
      expect((await fixture.store.readGenerationJobEvents(added.id))).toHaveLength(1);
      const after = await fixture.pool.query(`SELECT
        md5((state - 'imports' - 'generationPlans' - 'idempotency')::text) AS rest,
        (SELECT md5(COALESCE(jsonb_agg(to_jsonb(c) ORDER BY job_id, page_id), '[]'::jsonb)::text)
          FROM generation_job_checkpoints c) AS checkpoints,
        (SELECT md5(COALESCE(jsonb_agg(to_jsonb(e) ORDER BY id),'[]'::jsonb)::text)
          FROM ordered_events e WHERE stream_id=$1) AS events
        FROM operational_state WHERE id=1`, [original.id]);
      expect(after.rows).toEqual(baseline.rows);
      reopened = new PostgresOperationalStore({ connectionString: connectionString!, max: 2 });
      await reopened.whenReady();
      expect(await reopened.readGenerationJob(added.id)).toEqual(added);
      expect(await reopened.mutateGenerationTasks(state => Boolean(state.idempotency[`synthetic-task:${added.id}`]))).toBe(true);
      const sizes = await fixture.pool.query(`SELECT
        octet_length(state::text) AS "stateBytes",
        octet_length((state->'events')::text) AS "legacyEventBytes",
        octet_length((state->'generationCheckpoints')::text) AS "legacyCheckpointBytes",
        octet_length(jsonb_build_object('imports',state->'imports','jobs',state->'jobs',
          'generationPlans',state->'generationPlans','idempotency',state->'idempotency')::text) AS "taskFieldBytes",
        (SELECT COALESCE(sum(octet_length(job_data::text)),0)::int FROM generation_jobs) AS "canonicalJobBytes",
        (SELECT COALESCE(sum(octet_length(payload::text)),0)::int FROM ordered_events) AS "relationalEventPayloadBytes",
        (SELECT COALESCE(sum(octet_length(checkpoint::text)),0)::int FROM generation_job_checkpoints) AS "relationalCheckpointBytes"
        FROM operational_state WHERE id=1`);
      const scopedStart = performance.now();
      await fixture.store.mutateGenerationTasks(state => {
        state.idempotency[`synthetic-bench-scoped:${added.id}`] = { kind: "job", objectId: added.id };
      });
      const scopedMs = performance.now()-scopedStart;
      const fullStart = performance.now();
      await fixture.store.mutate(state => {
        state.idempotency[`synthetic-bench-full:${added.id}`] = { kind: "job", objectId: added.id };
      });
      const fullMs = performance.now()-fullStart;
      // One scoped and one existing full mutation, same association change.
      // Record measurements without a hardware-dependent timing assertion.
      const benchmark = { fixture: "isolated-synthetic-19MB-events-3MB-checkpoints",
        measurements: 1, scopedMs, fullMs, ...sizes.rows[0] };
      console.info("scoped generation task benchmark", JSON.stringify(benchmark));
      const benchmarkPath = process.env.COURSE_OS_TASK_BENCH_OUTPUT;
      if (benchmarkPath) await writeFile(benchmarkPath, JSON.stringify(benchmark,null,2)+"\n", "utf8");
    } finally { await reopened?.close(); await stopFixture(fixture); }
  }, 30000);

  it("loads only selected plan streams and event types with canonical events and jobs taking precedence", async () => {
    const planId = randomUUID();
    const selected = { ...makeJob(randomUUID()), planId };
    const unrelated = { ...makeJob(randomUUID()), planId: randomUUID() };
    const redirected = { ...makeJob(randomUUID()), planId };
    const fixture = await startFixture([selected, unrelated, redirected]);
    try {
      await fixture.store.mutateGenerationJob(selected.id, (_job, context) => {
        context.appendEvent("generation.page.core_saved", { pageId: "canonical-page" });
        context.appendEvent("job.running", { synthetic: true });
      });
      await fixture.store.mutateGenerationJob(redirected.id, job => { job.planId = unrelated.planId; });
      const canonical = (await fixture.store.readGenerationJobEvents(selected.id))[0]!;
      const ids = await fixture.pool.query<{ id: string }>("SELECT nextval(pg_get_serial_sequence('ordered_events','id'))::text AS id FROM generate_series(1,3)");
      const legacyOnly: OrderedEvent = { ...canonical, id: Number(ids.rows[0]!.id), type: "generation.cost.recorded", payload: { provider: "synthetic", model: "synthetic" } };
      const excluded = [
        { ...legacyOnly, id: Number(ids.rows[1]!.id), streamId: unrelated.id },
        { ...legacyOnly, id: Number(ids.rows[2]!.id), streamId: redirected.id }
      ];
      await fixture.pool.query(`UPDATE operational_state SET state=jsonb_set(state,'{events}',
        COALESCE(state->'events','[]'::jsonb) || $1::jsonb) WHERE id=1`,
        [JSON.stringify([{ ...canonical, payload: { pageId: "stale-page" } }, legacyOnly, ...excluded])]);
      await fixture.store.mutateGenerationTasks(state => {
        expect(state.events).toEqual([canonical, legacyOnly]);
        expect(state.jobs.find(job => job.id === redirected.id)?.planId).toBe(unrelated.planId);
        fixture.store.appendEvent(state, selected.id, "generation.page.completed", { pageId: "canonical-page", bridgeCompleted: true });
      }, { planId, readEvents: true });
      await fixture.store.mutateGenerationTasks(state => {
        expect(state.events).toHaveLength(3);
        expect(state.events.map(event => event.payload)).not.toContainEqual({ pageId: "stale-page" });
      }, { planId, readEvents: true });
    } finally { await stopFixture(fixture); }
  }, 15000);

  it("rolls back changed jobs and staged events when a concurrent worker advances its fence", async () => {
    const [first, job] = [makeJob(randomUUID()), makeJob(randomUUID())].sort((left,right) => left.id.localeCompare(right.id));
    const fixture = await startFixture([first!, job!]);
    let release!: () => void;
    let entered!: () => void;
    const taskEntered = new Promise<void>(resolve => { entered = resolve; });
    const taskRelease = new Promise<void>(resolve => { release = resolve; });
    let task: Promise<unknown> | undefined;
    const conflictKey = `synthetic-conflict:${job!.id}`;
    const emissions: OrderedEvent[] = [];
    fixture.store.bus.on(job!.id, event => emissions.push(event));
    try {
      task = fixture.store.mutateGenerationTasks(async state => {
        state.jobs.find(item => item.id === first!.id)!.cancelRequested = true;
        state.jobs.find(item => item.id === job!.id)!.cancelRequested = true;
        state.idempotency[conflictKey] = { kind: "job", objectId: job!.id };
        fixture.store.appendEvent(state, job!.id, "synthetic.task.staged", { synthetic: true });
        entered();
        await taskRelease;
      });
      const rejected = expect(task).rejects.toThrow(`GENERATION_JOB_WRITE_CONFLICT:${job!.id}`);
      await taskEntered;
      await fixture.store.mutateGenerationJob(job!.id, current => {
        current.state = "running";
        current.attempt = 2;
        current.lease = { owner: "synthetic-worker", fenceToken: 7, expiresAt: new Date(Date.now()+60000).toISOString() };
      });
      release();
      await rejected;
      expect(await fixture.store.readGenerationJob(first!.id)).toEqual(first);
      expect(await fixture.store.readGenerationJob(job!.id)).toMatchObject({ attempt: 2, cancelRequested: false, lease: { fenceToken: 7 } });
      expect(emissions).toEqual([]);
      expect(await fixture.store.readGenerationJobEvents(job!.id)).toEqual([]);
      expect(await fixture.store.mutateGenerationTasks(state => Boolean(state.idempotency[conflictKey]))).toBe(false);
      await fixture.store.mutateGenerationTasks(state => {
        state.jobs.find(item => item.id === job!.id)!.cancelRequested = true;
      });
      expect(await fixture.store.readGenerationJob(job!.id)).toMatchObject({ attempt: 2, cancelRequested: true, lease: { fenceToken: 7 } });
      const legacy = await fixture.pool.query<{ job: GenerationJob }>(`SELECT entry.job FROM operational_state,
        jsonb_array_elements(state->'jobs') AS entry(job) WHERE entry.job->>'id'=$1`, [job!.id]);
      expect(legacy.rows[0]!.job).toMatchObject({ attempt: 2, cancelRequested: true, lease: { fenceToken: 7 } });
    } finally { release(); await task?.catch(() => undefined); await stopFixture(fixture); }
  }, 15000);

  it("waits only for the selected worker and sees its latest lease fence before the callback", async () => {
    const job = { ...makeJob(randomUUID()), planId: randomUUID() };
    const fixture = await startFixture([job]);
    const blockerPool = new pg.Pool({ connectionString, max: 1 });
    const blocker = await blockerPool.connect();
    let task: Promise<unknown> | undefined;
    let transactionOpen = false;
    const originalQuery = pg.Client.prototype.query;
    const query = vi.spyOn(pg.Client.prototype,"query");
    let lockSent!: () => void;
    const selectedLock = new Promise<void>(resolve => { lockSent = resolve; });
    query.mockImplementation((function(this: pg.Client, ...args: unknown[]) {
      // Signal after the real row-lock query is submitted. The worker is still
      // uncommitted, so the task must wait and then read the committed fence.
      const result = Reflect.apply(originalQuery, this, args);
      if (typeof args[0] === "string" && args[0].includes("WHERE job_data->>'planId' = $1 OR id::text = $2")) lockSent();
      return result;
    }) as typeof pg.Client.prototype.query);
    try {
      await blocker.query("BEGIN");
      transactionOpen = true;
      const latest = { ...job, attempt: 4, state: "running" as const,
        lease: { owner: "synthetic-selected-worker", fenceToken: 11, expiresAt: new Date(Date.now()+60000).toISOString() } };
      await blocker.query("UPDATE generation_jobs SET job_data=$2::jsonb WHERE id=$1", [job.id,JSON.stringify(latest)]);
      task = fixture.store.mutateGenerationTasks(state => {
        const current = state.jobs.find(item => item.id === job.id)!;
        expect(current).toEqual(latest);
        current.cancelRequested = true;
      }, { planId: job.planId });
      await selectedLock;
      await blocker.query("COMMIT");
      transactionOpen = false;
      await task;
      expect(await fixture.store.readGenerationJob(job.id)).toMatchObject({ attempt: 4, cancelRequested: true, lease: { fenceToken: 11 } });
    } finally {
      if (transactionOpen) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await task?.catch(() => undefined);
      query.mockRestore();
      await blockerPool.end();
      await stopFixture(fixture);
    }
  }, 15000);

  it("commits task and page B mutations while page A remains row locked", async () => {
    const [jobA, jobB] = [{ ...makeJob(randomUUID()), planId: randomUUID() }, { ...makeJob(randomUUID()), planId: randomUUID() }];
    const fixture = await startFixture([jobA, jobB]);
    const blockerPool = new pg.Pool({ connectionString, max: 1 });
    const blocker = await blockerPool.connect();
    let timer: NodeJS.Timeout | undefined;
    let mutation: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM generation_jobs WHERE id=$1 FOR UPDATE", [jobA.id]);
      mutation = fixture.store.mutateGenerationTasks(state => {
        state.jobs.find(item => item.id === jobB.id)!.cancelRequested = true;
        state.idempotency[`synthetic-independent:${jobB.id}`] = { kind: "job", objectId: jobB.id };
        fixture.store.appendEvent(state,jobB.id,"synthetic.task.independent", { synthetic: true });
        return "committed";
      }, { planId: jobB.planId }).then(async result => {
        await fixture.store.mutateGenerationJob(jobB.id, current => { current.attempt = 3; });
        return result;
      });
      const timeout = new Promise<string>(resolve => { timer = setTimeout(() => resolve("PAGE_A_BLOCKED_B"), 3000); });
      expect(await Promise.race([mutation,timeout])).toBe("committed");
      expect(await fixture.store.readGenerationJob(jobB.id)).toMatchObject({ attempt: 3, cancelRequested: true });
      expect(await fixture.store.readGenerationJob(jobA.id)).toEqual(jobA);
    } finally {
      if (timer) clearTimeout(timer);
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await mutation?.catch(() => undefined);
      await blockerPool.end();
      await stopFixture(fixture);
    }
  }, 15000);
});

async function startFixture(jobs: GenerationJob[], includeLegacyProgress = false): Promise<PostgresFixture> {
  const pool = new pg.Pool({ connectionString, max: 3 });
  await pool.query(await readFile(schemaPath, "utf8"));
  const stateResult = await pool.query<{ state: Partial<OperationalState> }>("SELECT state FROM operational_state WHERE id = 1");
  const originalState = structuredClone(stateResult.rows[0]?.state ?? {});
  const currentJobs = Array.isArray(originalState.jobs) ? originalState.jobs : [];
  const events = Array.isArray(originalState.events) ? originalState.events : [];
  const checkpoints = originalState.generationCheckpoints && typeof originalState.generationCheckpoints === "object"
    ? originalState.generationCheckpoints
    : {};
  const additions: Partial<OperationalState> = {
    jobs: [...currentJobs, ...jobs],
    events: [...events],
    generationCheckpoints: { ...checkpoints }
  };
  if (includeLegacyProgress) {
    const lastIds = await pool.query<{ sql_id: string; json_id: string }>(`
      SELECT COALESCE((SELECT MAX(id) FROM ordered_events), 0)::text AS sql_id,
        COALESCE((SELECT MAX(CASE WHEN event->>'id' ~ '^[0-9]+$' THEN (event->>'id')::bigint END)
          FROM operational_state AS source
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(source.state->'events') = 'array' THEN source.state->'events' ELSE '[]'::jsonb END
          ) AS legacy(event)), 0)::text AS json_id
    `);
    const eventId = Math.max(Number(lastIds.rows[0]!.sql_id), Number(lastIds.rows[0]!.json_id)) + 1;
    (additions.events as OrderedEvent[]).push({
      id: eventId, streamId: jobs[0]!.id, type: "job.queued", occurredAt: new Date().toISOString(), payload: { source: "legacy-json" }
    });
    additions.generationCheckpoints![`${jobs[0]!.id}:page-1`] = makeCheckpoint("legacy-checkpoint");
  }
  await pool.query("UPDATE operational_state SET state = $1::jsonb, updated_at = now() WHERE id = 1", [JSON.stringify({ ...originalState, ...additions })]);
  await pool.query(await readFile(schemaPath, "utf8"));
  const store = new PostgresOperationalStore({ connectionString: connectionString!, max: 3 });
  await store.whenReady();
  return { pool, store, originalState, jobs };
}

async function stopFixture(fixture: PostgresFixture): Promise<void> {
  await fixture.store.close();
  await fixture.pool.query("DELETE FROM ordered_events WHERE stream_id = ANY($1::text[])", [fixture.jobs.map(job => job.id)]);
  await fixture.pool.query("DELETE FROM generation_jobs WHERE id = ANY($1::uuid[])", [fixture.jobs.map(job => job.id)]);
  await fixture.pool.query("UPDATE operational_state SET state = $1::jsonb, updated_at = now() WHERE id = 1", [JSON.stringify(fixture.originalState)]);
  await fixture.pool.end();
}

function makeJob(id: string): GenerationJob {
  const at = new Date().toISOString();
  return {
    id,
    workspaceId: "postgres-store-spec",
    materialVersionId: "release-postgres-store-spec",
    state: "queued",
    budgetUsd: 1,
    spentUsd: 0,
    pageIds: ["page-1"],
    completedPageIds: [],
    failedPageIds: [],
    attempt: 0,
    cancelRequested: false,
    createdAt: at,
    updatedAt: at
  };
}

function makeImport(id: string): ImportRecord {
  return { id, workspaceId: "scoped-import-spec", originalName: "synthetic.pdf", mediaType: "application/pdf", kind: "pdf", sizeBytes: 10,
    sha256: "synthetic", casPath: "synthetic", source: "synthetic", license: "synthetic", sensitivity: "private", state: "accepted",
    autoGenerate: false, generationState: "not_requested", issues: [], createdAt: new Date().toISOString() };
}

function makeSession(id: string): LearningSession {
  return {
    id, workspaceId: "postgres-session-spec", courseReleaseId: "release-session-spec", currentPageId: "page-1",
    explanationScroll: 0, zoom: 1, panX: 0, panY: 0, updatedAt: new Date().toISOString()
  };
}

function makeCheckpoint(fingerprint: string): PlannedCheckpoint {
  return {
    fingerprint,
    content: { chapterBridgeMarkdown: fingerprint },
    completedPhases: ["opening"],
    trace: { version: 1, plan: {} as PlannedCheckpoint["trace"]["plan"], phases: [] }
  };
}
