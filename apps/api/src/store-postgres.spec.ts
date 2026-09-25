import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { GenerationJob, GenerationPlan, LearningSession, OrderedEvent } from "@course-os/contracts";
import { describe, expect, it, vi } from "vitest";
import { OperationalStore, PostgresOperationalStore } from "./store.js";
import type { OperationalState } from "./store.js";
import type { PlannedCheckpoint } from "./planned-teaching.js";

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

interface PostgresFixture {
  pool: pg.Pool;
  store: PostgresOperationalStore;
  originalState: Partial<OperationalState>;
  jobs: GenerationJob[];
}

postgresDescribe("PostgreSQL operational job storage", () => {
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
      const detail = await fixture.store.readGenerationPlanDetail(planId, selectedJob.workspaceId);
      expect(detail.plan?.id).toBe(planId);
      expect(detail.jobs.map((job) => job.id)).toEqual([selectedJob.id]);
      expect(detail.events).toHaveLength(1);
      expect(detail.events[0]?.streamId).toBe(selectedJob.id);
      expect((await fixture.store.readGenerationPlanDetail(planId, "other-workspace")).plan).toBeUndefined();
      expect(fullRead).not.toHaveBeenCalled();
      fullRead.mockRestore();
    } finally {
      await stopFixture(fixture);
    }
  });

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
