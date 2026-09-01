import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type { AssessmentAttempt, GenerationJob, GenerationPlan, ImportRecord, LearningSession, OrderedEvent, ReviewPlan, ReviewSession } from "@course-os/contracts";
import { writeJsonAtomic } from "@course-os/storage";
import pg from "pg";

export interface OperationalState {
  schemaVersion: "1.0.0";
  imports: ImportRecord[];
  jobs: GenerationJob[];
  generationPlans: GenerationPlan[];
  sessions: LearningSession[];
  reviewPlans: ReviewPlan[];
  reviewSessions: ReviewSession[];
  attempts: AssessmentAttempt[];
  events: OrderedEvent[];
  idempotency: Record<string, { kind: string; objectId: string }>;
}

export const EMPTY: OperationalState = {
  schemaVersion: "1.0.0",
  imports: [],
  jobs: [],
  generationPlans: [],
  sessions: [],
  reviewPlans: [],
  reviewSessions: [],
  attempts: [],
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

  async mutate<T>(change: (state: OperationalState) => T | Promise<T>): Promise<T> {
    let result!: T;
    const emitted: OrderedEvent[] = [];
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      const state = await this.read();
      const before = state.events.length;
      result = await change(state);
      emitted.push(...state.events.slice(before));
      await writeJsonAtomic(this.statePath, state);
    });
    await this.writeChain;
    for (const event of emitted) this.bus.emit(event.streamId, event);
    return result;
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

/**
 * Persist runtime orchestration state in one locked PostgreSQL row
 * while keeping the same transaction callback used by the local store
 */
export class PostgresOperationalStore extends OperationalStore {
  private readonly pool: pg.Pool;
  private readonly ready: Promise<void>;
  private postgresWriteChain: Promise<void> = Promise.resolve();

  constructor(options: PostgresOperationalStoreOptions) {
    super("");
    this.pool = new pg.Pool({ connectionString: options.connectionString, max: options.max ?? 6 });
    this.ready = this.initialize();
  }

  async whenReady(): Promise<void> {
    await this.ready;
  }

  override async read(): Promise<OperationalState> {
    await this.ready;
    const result = await this.pool.query<{ state: Partial<OperationalState> }>("SELECT state FROM operational_state WHERE id = 1");
    return normalizeOperationalState(result.rows[0]?.state);
  }

  override async mutate<T>(change: (state: OperationalState) => T | Promise<T>): Promise<T> {
    let result!: T;
    let emitted: OrderedEvent[] = [];
    this.postgresWriteChain = this.postgresWriteChain.catch(() => undefined).then(async () => {
      await this.ready;
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query<{ state: Partial<OperationalState> }>("SELECT state FROM operational_state WHERE id = 1 FOR UPDATE");
        const state = normalizeOperationalState(locked.rows[0]?.state);
        const before = state.events.length;
        result = await change(state);
        emitted = state.events.slice(before);
        await client.query("UPDATE operational_state SET state = $1::jsonb, updated_at = now() WHERE id = 1", [JSON.stringify(state)]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
    await this.postgresWriteChain;
    for (const event of emitted) this.bus.emit(event.streamId, event);
    return result;
  }

  async close(): Promise<void> {
    await this.ready.catch(() => undefined);
    await this.pool.end();
  }

  private async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS operational_state (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query("INSERT INTO operational_state (id, state) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING", [JSON.stringify(EMPTY)]);
  }
}

function normalizeOperationalState(value: Partial<OperationalState> | undefined): OperationalState {
  return {
    schemaVersion: "1.0.0",
    imports: Array.isArray(value?.imports) ? value.imports : [],
    jobs: Array.isArray(value?.jobs) ? value.jobs : [],
    generationPlans: Array.isArray(value?.generationPlans) ? value.generationPlans : [],
    sessions: Array.isArray(value?.sessions) ? value.sessions : [],
    reviewPlans: Array.isArray(value?.reviewPlans) ? value.reviewPlans : [],
    reviewSessions: Array.isArray(value?.reviewSessions) ? value.reviewSessions : [],
    attempts: Array.isArray(value?.attempts) ? value.attempts : [],
    events: Array.isArray(value?.events) ? value.events : [],
    idempotency: value?.idempotency && typeof value.idempotency === "object" ? value.idempotency : {}
  } as OperationalState;
}
