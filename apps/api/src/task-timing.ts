export interface TaskTimingRecord {
  createdAt: string;
  attemptStartedAt?: string;
  endedAt?: string;
}

export type TaskTimingCollection = "imports" | "jobs" | "generationPlans";

const taskTimingCollections: Record<string, TaskTimingCollection | undefined> = {
  "import.accepted": "imports",
  "conversion.started": "imports",
  "import.ready": "imports",
  "import.failed": "imports",
  "import.rejected": "imports",
  "job.running": "jobs",
  "job.started": "jobs",
  "job.paused": "jobs",
  "job.awaiting_review": "jobs",
  "job.completed": "jobs",
  "job.failed": "jobs",
  "job.cancelled": "jobs",
  "plan.queued": "generationPlans",
  "plan.retry.queued": "generationPlans",
  "plan.running": "generationPlans",
  "plan.awaiting_review": "generationPlans",
  "plan.completed": "generationPlans",
  "plan.failed": "generationPlans",
  "plan.cancelled": "generationPlans"
};

const startEvents = new Set([
  "import.accepted", "conversion.started", "job.running", "job.started",
  "plan.queued", "plan.retry.queued", "plan.running"
]);

const endEvents = new Set([
  "import.ready", "import.failed", "import.rejected",
  "job.paused", "job.awaiting_review",
  "job.completed", "job.failed", "job.cancelled",
  // Awaiting review is a pause: stop the current interval until work resumes.
  "plan.awaiting_review", "plan.completed", "plan.failed", "plan.cancelled"
]);

const jobStartEvents = new Set(["job.running", "job.started"]);

export function taskTimingCollectionForEvent(type: string): TaskTimingCollection | undefined {
  return taskTimingCollections[type];
}

/**
 * A first start uses createdAt so the initial queue wait is included. A real
 * restart starts a fresh interval, while duplicate starts and end events are
 * idempotent. Only an emitted event can set endedAt; updatedAt is never used.
 */
export function applyTaskTimingEvent(
  task: TaskTimingRecord,
  type: string,
  occurredAt: string,
  options: { restart?: boolean } = {}
): void {
  if (startEvents.has(type)) {
    if (options.restart || type === "plan.retry.queued" || task.endedAt) {
      task.attemptStartedAt = occurredAt;
      delete task.endedAt;
    } else if (!task.attemptStartedAt) {
      task.attemptStartedAt = task.createdAt;
    }
    return;
  }

  if (!endEvents.has(type)) return;
  if (!task.attemptStartedAt) task.attemptStartedAt = task.createdAt;
  task.endedAt ??= occurredAt;
}

interface JobStartEvent {
  streamId: string;
  type: string;
  payload: unknown;
}

/** Detect a new running attempt without treating repeated same-attempt events as restarts. */
export function isNewGenerationJobAttempt(
  attempt: number,
  streamId: string,
  events: readonly JobStartEvent[]
): boolean {
  if (!Number.isFinite(attempt)) return false;
  const previous = [...events].reverse().find(event => event.streamId === streamId && jobStartEvents.has(event.type));
  if (!previous) return attempt > 1;
  const previousAttempt = (previous.payload as { attempt?: unknown } | undefined)?.attempt;
  return typeof previousAttempt === "number" ? attempt > previousAttempt : attempt > 1;
}
