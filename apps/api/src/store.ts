import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AssessmentAttempt, GenerationJob, GenerationPlan, ImportRecord, LearningSession, ModelProviderConfig, ModelRoutePolicy, OrderedEvent, ReviewPlan, ReviewSession, SearchProviderConfig, SearchRoutePolicy, SelfRetelling } from "@course-os/contracts";
import { advanceTaskIncarnation, pickTaskDismissals, reconcileTaskDismissals, writeJsonAtomic } from "@course-os/storage";
import pg from "pg";
import type { PlannedCheckpoint } from "./planned-teaching.js";
import { defaultCourseSearchRoutePolicy, mergeCourseSearchProviderDefaults } from "./search-providers.js";
import { defaultCourseModelRoutePolicy, mergeCourseModelProviderDefaults, mergeCourseModelRoutePolicyDefaults } from "./provider-settings.js";

export interface OperationalState {
  schemaVersion: "1.0.0";
  imports: ImportRecord[];
  jobs: GenerationJob[];
  generationCheckpoints: Record<string, PlannedCheckpoint>;
  generationPlans: GenerationPlan[];
  sessions: LearningSession[];
  reviewPlans: ReviewPlan[];
  reviewSessions: ReviewSession[];
  attempts: AssessmentAttempt[];
  selfRetellings: Record<string, SelfRetelling>;
  modelProviders: ModelProviderConfig[];
  modelRoutePolicy: ModelRoutePolicy;
  searchProviders: SearchProviderConfig[];
  searchRoutePolicy: SearchRoutePolicy;
  events: OrderedEvent[];
  idempotency: Record<string, { kind: string; objectId: string }>;
}

export type TaskIndex = Pick<OperationalState, "imports" | "jobs" | "generationPlans"> & {
  taskDismissals?: ReturnType<typeof pickTaskDismissals>;
};
export type ModelSettings = Pick<OperationalState, "modelProviders" | "modelRoutePolicy">;

export type ImportMutationState = Pick<OperationalState, "imports" | "idempotency">;
export interface ImportOperationRead {
  association?: OperationalState["idempotency"][string];
  record?: ImportRecord;
}
export interface ImportMutationContext {
  appendEvent<T>(streamId: string, type: string, payload: T): void;
}

export interface GenerationPlanDetailRead {
  plan?: GenerationPlan;
  jobs: GenerationJob[];
  events: OrderedEvent[];
}

const generationPlanDetailEventTypes = new Set([
  "generation.stage.started", "generation.stage.completed", "generation.stage.skipped",
  "generation.page.core_saved", "generation.page.completed", "generation.cost.recorded"
]);

export type LearningSessionPatch = Partial<Pick<LearningSession,
  "currentPageId" | "currentAnchorId" | "explanationScroll" | "zoom" | "panX" | "panY">>;

export interface GenerationJobMutationContext {
  /** Events already recorded for this job, in stream order. */
  events: OrderedEvent[];
  /** Checkpoints keyed by page ID, scoped to this job. */
  checkpoints: Record<string, PlannedCheckpoint>;
  appendEvent<T>(type: string, payload: T): void;
  setCheckpoint(pageId: string, checkpoint: PlannedCheckpoint): void;
  deleteCheckpoint(pageId: string): void;
}

export const EMPTY: OperationalState = {
  schemaVersion: "1.0.0",
  imports: [],
  jobs: [],
  generationCheckpoints: {},
  generationPlans: [],
  sessions: [],
  reviewPlans: [],
  reviewSessions: [],
  attempts: [],
  selfRetellings: {},
  modelProviders: mergeCourseModelProviderDefaults([]),
  modelRoutePolicy: defaultCourseModelRoutePolicy(),
  searchProviders: mergeCourseSearchProviderDefaults([]),
  searchRoutePolicy: defaultCourseSearchRoutePolicy(),
  events: [],
  idempotency: {}
};

export class OperationalStore {
  readonly bus = new EventEmitter();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly statePath: string) {
    this.bus.setMaxListeners(100);
  }

  async read(): Promise<OperationalState> {
    try {
      return normalizeOperationalState(JSON.parse(await readFile(this.statePath, "utf8")) as Partial<OperationalState>);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY);
      throw error;
    }
  }

  async readModelSettings(): Promise<ModelSettings> {
    const state = await this.read();
    return { modelProviders: state.modelProviders, modelRoutePolicy: state.modelRoutePolicy };
  }

  async getImport(id: string, workspaceId: string): Promise<ImportRecord | undefined> {
    return (await this.read()).imports.find(item => item.id === id && item.workspaceId === workspaceId);
  }

  async readImportByOperation(key: string, workspaceId: string): Promise<ImportOperationRead> {
    const state = await this.read();
    const association = state.idempotency[key];
    const record = association?.kind === "import"
      ? state.imports.find(item => item.id === association.objectId && item.workspaceId === workspaceId) : undefined;
    return { association, record };
  }

  async readImportGenerationPlan(id: string, workspaceId: string): Promise<GenerationPlan | undefined> {
    const state = await this.read();
    const record = state.imports.find(item => item.id === id && item.workspaceId === workspaceId);
    if (!record) return undefined;
    return state.generationPlans.find(plan => plan.id === record.generationPlanId && plan.workspaceId === workspaceId)
      ?? state.generationPlans.filter(plan => plan.sourceImportId === id && plan.workspaceId === workspaceId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  /** Conversion writes may change imports and request associations, never job/history projections. */
  async mutateImports<T>(change: (state: ImportMutationState, context: ImportMutationContext) => T | Promise<T>): Promise<T> {
    return this.mutate(async state => {
      const scope: ImportMutationState = { imports: state.imports, idempotency: state.idempotency };
      const result = await change(scope, { appendEvent: (streamId, type, payload) => {
        assertImportEvent(scope, streamId, type);
        this.appendEvent(state, streamId, type, payload);
      } });
      state.imports = scope.imports;
      state.idempotency = scope.idempotency;
      return result;
    });
  }

  async readSelfRetellings(workspaceId: string, releaseId?: string): Promise<SelfRetelling[]> {
    const retellings = Object.values((await this.read()).selfRetellings)
      .filter(item => item.workspaceId === workspaceId && (!releaseId || item.releaseId === releaseId));
    return structuredClone(retellings);
  }

  /** Read only the fields needed by the task tree and import detail screens. */
  async readTaskIndex(): Promise<TaskIndex> {
    let value: Partial<OperationalState>;
    try {
      value = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<OperationalState>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { imports: [], jobs: [], generationPlans: [] };
      throw error;
    }
    const taskDismissals = pickTaskDismissals(value.idempotency);
    return {
      imports: Array.isArray(value.imports) ? value.imports : [],
      jobs: Array.isArray(value.jobs) ? value.jobs : [],
      generationPlans: Array.isArray(value.generationPlans) ? value.generationPlans : [],
      ...(Object.keys(taskDismissals).length ? { taskDismissals } : {})
    };
  }

  /** Read only one workspace plan, its jobs, and events used by its detail response. */
  async readGenerationPlanDetail(id: string, workspaceId: string): Promise<GenerationPlanDetailRead> {
    let value: Partial<OperationalState>;
    try {
      value = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<OperationalState>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { jobs: [], events: [] };
      throw error;
    }
    const plans = Array.isArray(value.generationPlans) ? value.generationPlans : [];
    const storedJobs = Array.isArray(value.jobs) ? value.jobs : [];
    const storedEvents = Array.isArray(value.events) ? value.events : [];
    const plan = plans.find(item => item.id === id && item.workspaceId === workspaceId);
    if (!plan) return { jobs: [], events: [] };
    const jobs = storedJobs.filter(job => job.planId === plan.id
      || job.id === plan.currentJobId || job.id === plan.lastJobId);
    const planJobIds = new Set(storedJobs.filter(job => job.planId === plan.id).map(job => job.id));
    const events = storedEvents.filter(event => planJobIds.has(event.streamId)
      && generationPlanDetailEventTypes.has(event.type));
    return { plan, jobs, events };
  }

  async readGenerationJobEvents(jobId: string): Promise<OrderedEvent[]> {
    return (await this.read()).events.filter((event) => event.streamId === jobId);
  }

  async mutate<T>(change: (state: OperationalState) => T | Promise<T>): Promise<T> {
    let result!: T;
    const emitted: OrderedEvent[] = [];
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      const state = await this.read();
      const before = state.events.length;
      const previousTasks = { imports: state.imports.map(record => ({ ...record })), generationPlans: state.generationPlans.map(record => ({ ...record })), jobs: state.jobs.map(record => ({ ...record })) };
      result = await change(state);
      reconcileTaskDismissals(state, previousTasks);
      emitted.push(...state.events.slice(before));
      await writeJsonAtomic(this.statePath, state);
    });
    await this.writeChain;
    for (const event of emitted) this.bus.emit(event.streamId, event);
    return result;
  }

  /** Bypass accumulated background writes for user control actions. */
  async urgentMutate<T>(change: (state: OperationalState) => T | Promise<T>): Promise<T> {
    return this.mutate(change);
  }

  async findLearningSession(id: string): Promise<LearningSession | undefined> {
    return (await this.read()).sessions.find(session => session.id === id);
  }

  async createLearningSession(session: LearningSession): Promise<LearningSession> {
    return this.mutate(state => {
      state.sessions.push(session);
      return session;
    });
  }

  async patchLearningSession(id: string, workspaceId: string, patch: LearningSessionPatch): Promise<LearningSession | undefined> {
    return this.mutate(state => {
      const session = state.sessions.find(item => item.id === id && (item.workspaceId ?? workspaceId) === workspaceId);
      if (!session) return undefined;
      Object.assign(session, patch, { updatedAt: new Date().toISOString() });
      return session;
    });
  }

  /** Mutate one job and its private progress records without exposing the full operational state. */
  async mutateGenerationJob<T>(
    jobId: string,
    change: (job: GenerationJob, context: GenerationJobMutationContext) => T | Promise<T>
  ): Promise<{ job: GenerationJob; result: T } | undefined> {
    let result!: T;
    const job = await this.mutate(async state => {
      const current = state.jobs.find(item => item.id === jobId);
      if (!current) return undefined;
      const context = localGenerationJobMutationContext(state, current, this);
      result = await change(current, context);
      if (current.id !== jobId) throw new Error("GENERATION_JOB_ID_IMMUTABLE");
      return structuredClone(current);
    });
    return job ? { job, result } : undefined;
  }

  appendEvent<T>(state: OperationalState, streamId: string, type: string, payload: T): OrderedEvent<T> {
    const event: OrderedEvent<T> = {
      id: state.events.length === 0 ? 1 : (state.events.at(-1)?.id ?? 0) + 1,
      streamId,
      type,
      occurredAt: new Date().toISOString(),
      payload
    };
    state.events.push(event);
    return event;
  }
}

export interface PostgresOperationalStoreOptions {
  connectionString: string;
  max?: number;
}

/** Persist legacy state callbacks alongside the row-scoped generation-job path. */
export class PostgresOperationalStore extends OperationalStore {
  private readonly pool: pg.Pool;
  private readonly ready: Promise<void>;
  private postgresWriteChain: Promise<void> = Promise.resolve();
  private readonly schemaPath = fileURLToPath(new URL("../../../infra/postgres/operational-schema.postgres", import.meta.url));

  constructor(options: PostgresOperationalStoreOptions) {
    super("");
    this.pool = new pg.Pool({ connectionString: options.connectionString, max: options.max ?? 24 });
    this.ready = this.initialize();
  }

  async whenReady(): Promise<void> {
    await this.ready;
  }

  override async read(): Promise<OperationalState> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await client.query<{ state: Partial<OperationalState> }>("SELECT state FROM operational_state WHERE id = 1");
      const state = normalizeOperationalState(result.rows[0]?.state);
      await this.projectPostgresState(client, state);
      await client.query("COMMIT");
      return state;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  override async readModelSettings(): Promise<ModelSettings> {
    await this.ready;
    const result = await this.pool.query<Partial<ModelSettings>>(
      `SELECT state->'modelProviders' AS "modelProviders",
        state->'modelRoutePolicy' AS "modelRoutePolicy"
       FROM operational_state WHERE id = 1`
    );
    return normalizeModelSettings(result.rows[0]);
  }

  override async getImport(id: string, workspaceId: string): Promise<ImportRecord | undefined> {
    await this.ready;
    const result = await this.pool.query<{ record: ImportRecord }>(
      `SELECT entry.record FROM operational_state,
       jsonb_array_elements(COALESCE(state->'imports', '[]'::jsonb)) AS entry(record)
       WHERE operational_state.id = 1 AND entry.record->>'id' = $1
         AND entry.record->>'workspaceId' = $2 LIMIT 1`, [id, workspaceId]
    );
    return result.rows[0]?.record;
  }

  override async readImportByOperation(key: string, workspaceId: string): Promise<ImportOperationRead> {
    await this.ready;
    const result = await this.pool.query<ImportOperationRead>(
      `SELECT state->'idempotency'->$1 AS association,
         (SELECT entry.record FROM jsonb_array_elements(COALESCE(state->'imports', '[]'::jsonb)) AS entry(record)
          WHERE state->'idempotency'->$1->>'kind' = 'import'
            AND entry.record->>'id' = state->'idempotency'->$1->>'objectId'
            AND entry.record->>'workspaceId' = $2 LIMIT 1) AS record
       FROM operational_state WHERE id = 1`, [key, workspaceId]
    );
    return { association: result.rows[0]?.association ?? undefined, record: result.rows[0]?.record ?? undefined };
  }

  override async readImportGenerationPlan(id: string, workspaceId: string): Promise<GenerationPlan | undefined> {
    await this.ready;
    const result = await this.pool.query<{ plan: GenerationPlan }>(
      `SELECT entry.plan FROM operational_state,
       jsonb_array_elements(COALESCE(state->'generationPlans', '[]'::jsonb)) AS entry(plan),
       jsonb_array_elements(COALESCE(state->'imports', '[]'::jsonb)) AS source(record)
       WHERE operational_state.id = 1 AND source.record->>'id' = $1
         AND source.record->>'workspaceId' = $2 AND entry.plan->>'workspaceId' = $2
         AND (entry.plan->>'id' = source.record->>'generationPlanId' OR entry.plan->>'sourceImportId' = $1)
       ORDER BY (entry.plan->>'id' = source.record->>'generationPlanId') DESC NULLS LAST,
         entry.plan->>'createdAt' DESC LIMIT 1`, [id, workspaceId]
    );
    return result.rows[0]?.plan;
  }

  override async mutateImports<T>(change: (state: ImportMutationState, context: ImportMutationContext) => T | Promise<T>): Promise<T> {
    let result!: T;
    this.postgresWriteChain = this.postgresWriteChain.catch(() => undefined).then(async () => {
      result = await this.writePostgresImports(change);
    });
    await this.postgresWriteChain;
    return result;
  }

  override async readSelfRetellings(workspaceId: string, releaseId?: string): Promise<SelfRetelling[]> {
    await this.ready;
    const result = await this.pool.query<{ records: SelfRetelling[] }>(
      `SELECT COALESCE(jsonb_agg(entry.value), '[]'::jsonb) AS records
       FROM operational_state
       CROSS JOIN LATERAL jsonb_each(
         CASE WHEN jsonb_typeof(state->'selfRetellings') = 'object'
           THEN state->'selfRetellings' ELSE '{}'::jsonb END
       ) AS entry(key, value)
       WHERE operational_state.id = 1
         AND entry.value->>'workspaceId' = $1
         AND ($2::text IS NULL OR entry.value->>'releaseId' = $2)`,
      [workspaceId, releaseId ?? null]
    );
    return result.rows[0]?.records ?? [];
  }

  override async readTaskIndex(): Promise<TaskIndex> {
    await this.ready;
    const result = await this.pool.query<TaskIndex & { relationalJobs: GenerationJob[] }>(
      `SELECT state->'imports' AS imports, state->'jobs' AS jobs,
        state->'generationPlans' AS "generationPlans",
        (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each(CASE WHEN jsonb_typeof(state->'idempotency') = 'object'
           THEN state->'idempotency' ELSE '{}'::jsonb END) AS entry(key, value)
         WHERE entry.key LIKE 'course-os:task-dismissal:v1:%'
           AND entry.value->>'kind' = 'taskdismissal') AS "taskDismissals",
        COALESCE((SELECT jsonb_agg(job_data ORDER BY created_at, id) FROM generation_jobs WHERE job_data IS NOT NULL), '[]'::jsonb) AS "relationalJobs"
       FROM operational_state WHERE id = 1`
    );
    const row = result.rows[0];
    if (!row) return { imports: [], jobs: [], generationPlans: [] };
    return {
      imports: Array.isArray(row.imports) ? row.imports : [],
      jobs: mergeGenerationJobs(Array.isArray(row.jobs) ? row.jobs : [], row.relationalJobs ?? []),
      generationPlans: Array.isArray(row.generationPlans) ? row.generationPlans : [],
      ...(Object.keys(row.taskDismissals ?? {}).length ? { taskDismissals: row.taskDismissals } : {})
    };
  }

  override async readGenerationPlanDetail(id: string, workspaceId: string): Promise<GenerationPlanDetailRead> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const planResult = await client.query<{ plan: GenerationPlan | null }>(
      `SELECT entry.plan
       FROM operational_state,
            jsonb_array_elements(COALESCE(state->'generationPlans', '[]'::jsonb)) AS entry(plan)
       WHERE operational_state.id = 1 AND entry.plan->>'id' = $1 AND entry.plan->>'workspaceId' = $2
       LIMIT 1`, [id, workspaceId]
      );
      const plan = planResult.rows[0]?.plan;
      if (!plan) {
        await client.query("COMMIT");
        return { jobs: [], events: [] };
      }
      const selectedIds = [...new Set([...(plan.jobIds ?? []), plan.currentJobId, plan.lastJobId]
        .filter((jobId): jobId is string => Boolean(jobId)))];
      const [legacyResult, relationalResult] = await Promise.all([
        client.query<{ job: GenerationJob }>(
        `SELECT entry.job
         FROM operational_state,
              jsonb_array_elements(COALESCE(state->'jobs', '[]'::jsonb)) WITH ORDINALITY AS entry(job, position)
         WHERE operational_state.id = 1
           AND (entry.job->>'planId' = $1 OR entry.job->>'id' = ANY($2::text[]))
         ORDER BY entry.position`, [plan.id, selectedIds]
        ),
        client.query<{ job_data: GenerationJob }>(
        `SELECT job_data FROM generation_jobs
         WHERE job_data->>'planId' = $1 OR id::text = ANY($2::text[])
         ORDER BY created_at, id`, [plan.id, selectedIds]
        )
      ]);
      const jobs = mergeGenerationJobs(legacyResult.rows.map(row => row.job), relationalResult.rows.map(row => row.job_data));
      const planJobIds = [...new Set(jobs.filter(job => job.planId === plan.id).map(job => job.id))];
      const [legacyEventsResult, relationalEventsResult] = await Promise.all([
        client.query<{ event: OrderedEvent }>(
        `SELECT entry.event
         FROM operational_state,
              jsonb_array_elements(COALESCE(state->'events', '[]'::jsonb)) AS entry(event)
         WHERE operational_state.id = 1
           AND entry.event->>'streamId' = ANY($1::text[])
           AND entry.event->>'type' = ANY($2::text[])`,
        [planJobIds, [...generationPlanDetailEventTypes]]
        ),
        client.query<{ id: string; stream_id: string; event_type: string; payload: unknown; occurred_at: Date }>(
        `SELECT id, stream_id, event_type, payload, occurred_at FROM ordered_events
         WHERE stream_id = ANY($1::text[]) AND event_type = ANY($2::text[]) ORDER BY id`,
        [planJobIds, [...generationPlanDetailEventTypes]]
        )
      ]);
      const baseEvents = legacyEventsResult.rows.map(row => row.event);
      const eventMap = new Map(baseEvents.map(event => [event.id, event]));
      for (const row of relationalEventsResult.rows) {
        const event: OrderedEvent = {
          id: Number(row.id), streamId: row.stream_id, type: row.event_type,
          occurredAt: new Date(row.occurred_at).toISOString(), payload: row.payload
        };
        eventMap.set(event.id, event);
      }
      await client.query("COMMIT");
      return { plan, jobs, events: [...eventMap.values()].sort((left, right) => left.id - right.id) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  override async readGenerationJobEvents(jobId: string): Promise<OrderedEvent[]> {
    await this.ready;
    const [legacyResult, relationalResult] = await Promise.all([
      this.pool.query<{ event: OrderedEvent }>(
        `SELECT entry.event
         FROM operational_state,
              jsonb_array_elements(COALESCE(state->'events', '[]'::jsonb)) AS entry(event)
         WHERE operational_state.id = 1 AND entry.event->>'streamId' = $1`, [jobId]
      ),
      this.pool.query<{ id: string; stream_id: string; event_type: string; payload: unknown; occurred_at: Date }>(
        "SELECT id, stream_id, event_type, payload, occurred_at FROM ordered_events WHERE stream_id = $1 ORDER BY id", [jobId]
      )
    ]);
    return mergeOrderedEvents(legacyResult.rows.map(row => row.event), relationalResult.rows);
  }

  override async mutate<T>(change: (state: OperationalState) => T | Promise<T>): Promise<T> {
    let result!: T;
    this.postgresWriteChain = this.postgresWriteChain.catch(() => undefined).then(async () => {
      result = await this.writePostgresState(change);
    });
    await this.postgresWriteChain;
    return result;
  }

  override async urgentMutate<T>(change: (state: OperationalState) => T | Promise<T>): Promise<T> {
    return this.writePostgresState(change);
  }

  override async findLearningSession(id: string): Promise<LearningSession | undefined> {
    await this.ready;
    const result = await this.pool.query<{ session: LearningSession }>(
      `SELECT entry.session FROM operational_state,
       jsonb_array_elements(COALESCE(state->'sessions', '[]'::jsonb)) AS entry(session)
       WHERE operational_state.id = 1 AND entry.session->>'id' = $1 LIMIT 1`, [id]
    );
    return result.rows[0]?.session;
  }

  override async createLearningSession(session: LearningSession): Promise<LearningSession> {
    await this.ready;
    const result = await this.pool.query(
      `UPDATE operational_state
       SET state = jsonb_set(state, '{sessions}', COALESCE(state->'sessions', '[]'::jsonb) || $1::jsonb),
           updated_at = now()
       WHERE id = 1`, [JSON.stringify(session)]
    );
    if (result.rowCount !== 1) throw new Error("OPERATIONAL_STATE_MISSING");
    return session;
  }

  override async patchLearningSession(id: string, workspaceId: string, patch: LearningSessionPatch): Promise<LearningSession | undefined> {
    await this.ready;
    const changes = { ...patch, updatedAt: new Date().toISOString() };
    const result = await this.pool.query<{ session: LearningSession }>(
      `WITH target AS (
         SELECT position - 1 AS index
         FROM operational_state,
              jsonb_array_elements(COALESCE(state->'sessions', '[]'::jsonb)) WITH ORDINALITY AS entry(session, position)
         WHERE operational_state.id = 1 AND entry.session->>'id' = $1
           AND COALESCE(entry.session->>'workspaceId', $2) = $2
         LIMIT 1
       )
       UPDATE operational_state AS store
       SET state = jsonb_set(store.state, ARRAY['sessions', target.index::text],
         (store.state #> ARRAY['sessions', target.index::text]) || $3::jsonb),
           updated_at = now()
       FROM target WHERE store.id = 1
       RETURNING store.state #> ARRAY['sessions', target.index::text] AS session`,
      [id, workspaceId, JSON.stringify(changes)]
    );
    return result.rows[0]?.session;
  }

  override async mutateGenerationJob<T>(
    jobId: string,
    change: (job: GenerationJob, context: GenerationJobMutationContext) => T | Promise<T>
  ): Promise<{ job: GenerationJob; result: T } | undefined> {
    await this.ready;
    const client = await this.pool.connect();
    const emitted: OrderedEvent[] = [];
    try {
      await client.query("BEGIN");
      const locked = await client.query<{ job_data: GenerationJob | null }>(
        "SELECT job_data FROM generation_jobs WHERE id = $1 FOR UPDATE", [jobId]
      );
      if (!locked.rows[0]) {
        await client.query("COMMIT");
        return undefined;
      }
      const job = locked.rows[0].job_data;
      if (!job) throw new Error(`GENERATION_JOB_PROJECTION_MISSING:${jobId}`);
      const eventRows = await client.query<{ id: string; stream_id: string; event_type: string; payload: unknown; occurred_at: Date }>(
        "SELECT id, stream_id, event_type, payload, occurred_at FROM ordered_events WHERE stream_id = $1 ORDER BY id", [jobId]
      );
      const checkpointRows = await client.query<{ page_id: string; checkpoint: PlannedCheckpoint }>(
        "SELECT page_id, checkpoint FROM generation_job_checkpoints WHERE job_id = $1 ORDER BY page_id", [jobId]
      );
      const context = postgresGenerationJobMutationContext(job, eventRows.rows, checkpointRows.rows);
      const previousJob = { ...job };
      const result = await change(job, context);
      if (job.id !== jobId) throw new Error("GENERATION_JOB_ID_IMMUTABLE");
      advanceTaskIncarnation(job, previousJob);
      await updateGenerationJob(client, job);
      for (const pending of context.pendingEvents) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO ordered_events (stream_id, event_type, payload, occurred_at)
           VALUES ($1, $2, $3::jsonb, $4::timestamptz) RETURNING id`,
          [jobId, pending.type, JSON.stringify(pending.payload), pending.occurredAt]
        );
        pending.event.id = Number(inserted.rows[0]!.id);
        emitted.push(pending.event);
      }
      for (const [pageId, checkpoint] of context.checkpointChanges) {
        if (checkpoint === undefined) {
          await client.query("DELETE FROM generation_job_checkpoints WHERE job_id = $1 AND page_id = $2", [jobId, pageId]);
        } else {
          await client.query(
            `INSERT INTO generation_job_checkpoints (job_id, page_id, checkpoint) VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (job_id, page_id) DO UPDATE SET checkpoint = EXCLUDED.checkpoint`,
            [jobId, pageId, JSON.stringify(checkpoint)]
          );
        }
      }
      await client.query("COMMIT");
      for (const event of emitted) this.bus.emit(event.streamId, event);
      return { job: structuredClone(job), result };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.ready.catch(() => undefined);
    await this.pool.end();
  }

  private async initialize(): Promise<void> {
    await this.pool.query(await readFile(this.schemaPath, "utf8"));
    await this.pool.query("INSERT INTO operational_state (id, state) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING", [JSON.stringify(EMPTY)]);
  }

  private async projectPostgresState(client: pg.PoolClient, state: OperationalState): Promise<void> {
    const jobRows = await client.query<{ job_data: GenerationJob }>(
      "SELECT job_data FROM generation_jobs WHERE job_data IS NOT NULL ORDER BY created_at, id"
    );
    const eventRows = await client.query<{ id: string; stream_id: string; event_type: string; payload: unknown; occurred_at: Date }>(
      "SELECT id, stream_id, event_type, payload, occurred_at FROM ordered_events ORDER BY id"
    );
    const checkpointRows = await client.query<{ job_id: string; page_id: string; checkpoint: PlannedCheckpoint }>(
      "SELECT job_id, page_id, checkpoint FROM generation_job_checkpoints ORDER BY job_id, page_id"
    );
    state.jobs = mergeGenerationJobs(state.jobs, jobRows.rows.map(row => row.job_data));
    state.events = mergeOrderedEvents(state.events, eventRows.rows);
    for (const row of checkpointRows.rows) state.generationCheckpoints[`${row.job_id}:${row.page_id}`] = row.checkpoint;
  }

  private async writePostgresState<T>(change: (state: OperationalState) => T | Promise<T>): Promise<T> {
    await this.ready;
    const client = await this.pool.connect();
    let emitted: OrderedEvent[] = [];
    let result!: T;
    try {
      await client.query("BEGIN");
      const locked = await client.query<{ state: Partial<OperationalState> }>("SELECT state FROM operational_state WHERE id = 1 FOR UPDATE");
      const state = normalizeOperationalState(locked.rows[0]?.state);
      await this.projectPostgresState(client, state);
      const before = structuredClone(state);
      const beforeEvents = state.events.length;
      result = await change(state);
      reconcileTaskDismissals(state, before);
      await persistChangedGenerationJobs(client, before.jobs, state.jobs);
      await persistChangedCheckpoints(client, before.generationCheckpoints, state.generationCheckpoints, state.jobs);
      emitted = state.events.slice(beforeEvents);
      for (const event of emitted) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO ordered_events (stream_id, event_type, payload, occurred_at)
           VALUES ($1, $2, $3::jsonb, $4::timestamptz) RETURNING id`,
          [event.streamId, event.type, JSON.stringify(event.payload), event.occurredAt]
        );
        event.id = Number(inserted.rows[0]!.id);
      }
      state.events.sort((left, right) => left.id - right.id);
      await client.query("UPDATE operational_state SET state = $1::jsonb, updated_at = now() WHERE id = 1", [JSON.stringify(state)]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    for (const event of emitted) this.bus.emit(event.streamId, event);
    return result;
  }

  private async writePostgresImports<T>(change: (state: ImportMutationState, context: ImportMutationContext) => T | Promise<T>): Promise<T> {
    await this.ready;
    const client = await this.pool.connect();
    const emitted: OrderedEvent[] = [];
    let result!: T;
    try {
      await client.query("BEGIN");
      const locked = await client.query<ImportMutationState>(
        `SELECT state->'imports' AS imports, state->'idempotency' AS idempotency
         FROM operational_state WHERE id = 1 FOR UPDATE`
      );
      if (!locked.rows[0]) throw new Error("OPERATIONAL_STATE_MISSING");
      const scope: ImportMutationState = {
        imports: locked.rows[0].imports ?? [], idempotency: locked.rows[0].idempotency ?? {}
      };
      const beforeImports = structuredClone(scope.imports);
      const beforeImportJson = JSON.stringify(scope.imports);
      const beforeIdempotencyJson = JSON.stringify(scope.idempotency);
      result = await change(scope, { appendEvent: (streamId, type, payload) => {
        assertImportEvent(scope, streamId, type);
        emitted.push({ id: 0, streamId, type, payload, occurredAt: new Date().toISOString() });
      } });
      const previous = new Map(beforeImports.map(record => [record.id, record]));
      for (const record of scope.imports) {
        const before = previous.get(record.id);
        if (before) advanceTaskIncarnation(record, before);
      }
      const importsJson = JSON.stringify(scope.imports);
      const idempotencyJson = JSON.stringify(scope.idempotency);
      const values: string[] = [];
      let expression = "state";
      if (importsJson !== beforeImportJson) {
        values.push(importsJson);
        expression = `jsonb_set(${expression}, '{imports}', $${values.length}::jsonb)`;
      }
      if (idempotencyJson !== beforeIdempotencyJson) {
        values.push(idempotencyJson);
        expression = `jsonb_set(${expression}, '{idempotency}', $${values.length}::jsonb)`;
      }
      for (const event of emitted) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO ordered_events (stream_id, event_type, payload, occurred_at)
           VALUES ($1, $2, $3::jsonb, $4::timestamptz) RETURNING id`,
          [event.streamId, event.type, JSON.stringify(event.payload), event.occurredAt]
        );
        event.id = Number(inserted.rows[0]!.id);
      }
      if (values.length) await client.query(
        `UPDATE operational_state SET state = ${expression}, updated_at = now() WHERE id = 1`, values
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
    for (const event of emitted) this.bus.emit(event.streamId, event);
    return result;
  }
}

function assertImportEvent(state: ImportMutationState, streamId: string, type: string): void {
  if (!state.imports.some(record => record.id === streamId)
    || !/^(import|conversion|readweave)\./.test(type)) throw new Error("IMPORT_EVENT_SCOPE_INVALID");
}

interface PendingGenerationEvent {
  type: string;
  payload: unknown;
  occurredAt: string;
  event: OrderedEvent;
}

interface InternalGenerationJobMutationContext extends GenerationJobMutationContext {
  pendingEvents: PendingGenerationEvent[];
  checkpointChanges: Map<string, PlannedCheckpoint | undefined>;
}

function localGenerationJobMutationContext(
  state: OperationalState,
  job: GenerationJob,
  store: OperationalStore
): GenerationJobMutationContext {
  const prefix = `${job.id}:`;
  const checkpoints = Object.fromEntries(Object.entries(state.generationCheckpoints)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, checkpoint]) => [key.slice(prefix.length), checkpoint]));
  const events = state.events.filter(event => event.streamId === job.id);
  return {
    events,
    checkpoints,
    appendEvent<T>(type: string, payload: T) {
      events.push(store.appendEvent(state, job.id, type, payload));
    },
    setCheckpoint(pageId, checkpoint) {
      state.generationCheckpoints[`${job.id}:${pageId}`] = checkpoint;
      checkpoints[pageId] = checkpoint;
    },
    deleteCheckpoint(pageId) {
      delete state.generationCheckpoints[`${job.id}:${pageId}`];
      delete checkpoints[pageId];
    }
  };
}

function postgresGenerationJobMutationContext(
  job: GenerationJob,
  eventRows: Array<{ id: string; stream_id: string; event_type: string; payload: unknown; occurred_at: Date }>,
  checkpointRows: Array<{ page_id: string; checkpoint: PlannedCheckpoint }>
): InternalGenerationJobMutationContext {
  const events = eventRows.map(row => ({
    id: Number(row.id), streamId: row.stream_id, type: row.event_type,
    occurredAt: new Date(row.occurred_at).toISOString(), payload: row.payload
  }));
  const checkpoints = Object.fromEntries(checkpointRows.map(row => [row.page_id, row.checkpoint]));
  const pendingEvents: PendingGenerationEvent[] = [];
  const checkpointChanges = new Map<string, PlannedCheckpoint | undefined>();
  return {
    events,
    checkpoints,
    pendingEvents,
    checkpointChanges,
    appendEvent<T>(type: string, payload: T) {
      const occurredAt = new Date().toISOString();
      const event: OrderedEvent<T> = {
        id: (events.at(-1)?.id ?? 0) + 1,
        streamId: job.id,
        type,
        occurredAt,
        payload
      };
      events.push(event);
      pendingEvents.push({ type, payload, occurredAt, event });
    },
    setCheckpoint(pageId, checkpoint) {
      checkpoints[pageId] = checkpoint;
      checkpointChanges.set(pageId, checkpoint);
    },
    deleteCheckpoint(pageId) {
      delete checkpoints[pageId];
      checkpointChanges.set(pageId, undefined);
    }
  };
}

function mergeGenerationJobs(base: GenerationJob[], relational: GenerationJob[]): GenerationJob[] {
  const byId = new Map(relational.map(job => [job.id, job]));
  const seen = new Set<string>();
  const merged = base.map(job => {
    seen.add(job.id);
    return byId.get(job.id) ?? job;
  });
  for (const job of relational) if (!seen.has(job.id)) merged.push(job);
  return merged;
}

function mergeOrderedEvents(
  base: OrderedEvent[],
  relational: Array<{ id: string; stream_id: string; event_type: string; payload: unknown; occurred_at: Date }>
): OrderedEvent[] {
  const events = new Map(base.map(event => [event.id, event]));
  for (const row of relational) {
    const event: OrderedEvent = {
      id: Number(row.id), streamId: row.stream_id, type: row.event_type,
      occurredAt: new Date(row.occurred_at).toISOString(), payload: row.payload
    };
    events.set(event.id, event);
  }
  return [...events.values()].sort((left, right) => left.id - right.id);
}

async function updateGenerationJob(client: pg.PoolClient, job: GenerationJob): Promise<void> {
  await client.query(
    `UPDATE generation_jobs SET
       workspace_id = $2, material_version_id = $3, state = $4, budget_usd = $5, spent_usd = $6,
       page_ids = $7::jsonb, completed_page_ids = $8::jsonb, failed_page_ids = $9::jsonb,
       attempt = $10, cancel_requested = $11, lease_owner = $12, lease_expires_at = $13::timestamptz,
       created_at = $14::timestamptz, updated_at = $15::timestamptz, job_data = $16::jsonb
     WHERE id = $1`,
    generationJobValues(job)
  );
}

function generationJobValues(job: GenerationJob): unknown[] {
  return [
    job.id, job.workspaceId, job.materialVersionId, job.state, job.budgetUsd, job.spentUsd,
    JSON.stringify(job.pageIds), JSON.stringify(job.completedPageIds), JSON.stringify(job.failedPageIds),
    job.attempt, job.cancelRequested, job.lease?.owner ?? null, job.lease?.expiresAt ?? null,
    job.createdAt, job.updatedAt, JSON.stringify(job)
  ];
}

async function persistChangedGenerationJobs(
  client: pg.PoolClient,
  before: GenerationJob[],
  after: GenerationJob[]
): Promise<void> {
  const oldJobs = new Map(before.map(job => [job.id, job]));
  for (const job of after) {
    const previous = oldJobs.get(job.id);
    if (previous && JSON.stringify(previous) === JSON.stringify(job)) continue;
    const values = generationJobValues(job);
    await client.query(
      `INSERT INTO generation_jobs (
         id, workspace_id, idempotency_key, material_version_id, state, budget_usd, spent_usd,
         page_ids, completed_page_ids, failed_page_ids, attempt, cancel_requested,
         lease_owner, lease_expires_at, created_at, updated_at, job_data
       ) VALUES (
         $1::uuid, $2, 'generation-job:' || $1::uuid::text, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
         $10, $11, $12, $13::timestamptz, $14::timestamptz, $15::timestamptz, $16::jsonb
       )
       ON CONFLICT (id) DO UPDATE SET
         workspace_id = EXCLUDED.workspace_id, material_version_id = EXCLUDED.material_version_id,
         state = EXCLUDED.state, budget_usd = EXCLUDED.budget_usd, spent_usd = EXCLUDED.spent_usd,
         page_ids = EXCLUDED.page_ids, completed_page_ids = EXCLUDED.completed_page_ids,
         failed_page_ids = EXCLUDED.failed_page_ids, attempt = EXCLUDED.attempt,
         cancel_requested = EXCLUDED.cancel_requested, lease_owner = EXCLUDED.lease_owner,
         lease_expires_at = EXCLUDED.lease_expires_at, created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at, job_data = EXCLUDED.job_data
       WHERE generation_jobs.job_data IS NOT DISTINCT FROM $17::jsonb OR generation_jobs.job_data IS NULL`,
      [...values, previous ? JSON.stringify(previous) : null]
    );
  }
}

async function persistChangedCheckpoints(
  client: pg.PoolClient,
  before: Record<string, PlannedCheckpoint>,
  after: Record<string, PlannedCheckpoint>,
  jobs: GenerationJob[]
): Promise<void> {
  const jobIds = [...jobs].map(job => job.id).sort((left, right) => right.length - left.length);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const hadPrevious = Object.hasOwn(before, key);
    const hasCurrent = Object.hasOwn(after, key);
    if (hadPrevious === hasCurrent && JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    const parts = splitGenerationCheckpointKey(key, jobIds);
    if (!parts) continue;
    if (!hasCurrent) {
      await client.query(
        `DELETE FROM generation_job_checkpoints WHERE job_id = $1 AND page_id = $2
         AND checkpoint IS NOT DISTINCT FROM $3::jsonb`,
        [parts.jobId, parts.pageId, hadPrevious ? JSON.stringify(before[key]) : null]
      );
      continue;
    }
    await client.query(
      `INSERT INTO generation_job_checkpoints (job_id, page_id, checkpoint) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (job_id, page_id) DO UPDATE SET checkpoint = EXCLUDED.checkpoint
       WHERE generation_job_checkpoints.checkpoint IS NOT DISTINCT FROM $4::jsonb`,
      [parts.jobId, parts.pageId, JSON.stringify(after[key]), hadPrevious ? JSON.stringify(before[key]) : null]
    );
  }
}

function splitGenerationCheckpointKey(key: string, jobIds: string[]): { jobId: string; pageId: string } | undefined {
  const jobId = jobIds.find(candidate => key.startsWith(`${candidate}:`));
  if (!jobId) return undefined;
  return { jobId, pageId: key.slice(jobId.length + 1) };
}

function normalizeOperationalState(value: Partial<OperationalState> | undefined): OperationalState {
  return {
    schemaVersion: "1.0.0",
    imports: Array.isArray(value?.imports) ? value.imports : [],
    jobs: Array.isArray(value?.jobs) ? value.jobs : [],
    generationCheckpoints: value?.generationCheckpoints && typeof value.generationCheckpoints === "object" ? value.generationCheckpoints : {},
    generationPlans: Array.isArray(value?.generationPlans) ? value.generationPlans : [],
    sessions: Array.isArray(value?.sessions) ? value.sessions : [],
    reviewPlans: Array.isArray(value?.reviewPlans) ? value.reviewPlans : [],
    reviewSessions: Array.isArray(value?.reviewSessions) ? value.reviewSessions : [],
    attempts: Array.isArray(value?.attempts) ? value.attempts : [],
    selfRetellings: value?.selfRetellings && typeof value.selfRetellings === "object" && !Array.isArray(value.selfRetellings) ? value.selfRetellings : {},
    ...normalizeModelSettings(value),
    searchProviders: mergeCourseSearchProviderDefaults(Array.isArray(value?.searchProviders) ? value.searchProviders : []),
    searchRoutePolicy: value?.searchRoutePolicy && Array.isArray(value.searchRoutePolicy.rules)
      ? value.searchRoutePolicy
      : defaultCourseSearchRoutePolicy(),
    events: Array.isArray(value?.events) ? value.events : [],
    idempotency: value?.idempotency && typeof value.idempotency === "object" ? value.idempotency : {}
  } as OperationalState;
}

function normalizeModelSettings(value: Partial<OperationalState> | undefined): ModelSettings {
  return {
    modelProviders: mergeCourseModelProviderDefaults(Array.isArray(value?.modelProviders) ? value.modelProviders : []),
    modelRoutePolicy: mergeCourseModelRoutePolicyDefaults(value?.modelRoutePolicy)
  };
}
