import { createHash } from "node:crypto";

// Structural types let the API use its existing OperationalStore transaction.
// No task, content, cost or request-idempotency entity is removed.
export interface CleanupTaskRecord {
  id: string;
  workspaceId: string;
  state: string;
  materialVersionId?: string;
  pageIds?: string[];
  sourceImportId?: string;
  planId?: string;
  retryOfPlanId?: string;
  generationPlanId?: string;
  generationJobId?: string;
  generationJobIds?: string[];
  generationState?: string;
  jobIds?: string[];
  activeJobIds?: string[];
  currentJobId?: string;
  lastJobId?: string;
  attempt?: number;
  /** Internal persisted incarnation, advanced by the owning store on task transitions. */
  taskIncarnation?: number;
  updatedAt?: string;
  createdAt?: string;
  lastErrorCode?: string;
  completedPageIds?: string[];
  failedPageIds?: string[];
  generationCompletedPageIds?: string[];
  generationFailedPageIds?: string[];
  lease?: { expiresAt: string };
}

export interface TaskCleanupState {
  imports: CleanupTaskRecord[];
  generationPlans: CleanupTaskRecord[];
  jobs: CleanupTaskRecord[];
  idempotency?: Record<string, { kind: string; objectId: string }>;
  taskDismissals?: Record<string, { kind: string; objectId: string }>;
}

export interface TaskReference {
  kind: "import" | "plan" | "job";
  id: string;
}

export interface FailedTaskSelection extends TaskReference {
  fingerprint: string;
}

export interface FailedTaskGroup extends FailedTaskSelection {
  workspaceId: string;
  members: TaskReference[];
  materialVersionIds: string[];
  pageIds: string[];
}

export interface TaskDismissalContext {
  workspaceId: string;
  actor: string;
  idempotencyKey: string;
  /** Must check live import conversions, recovery and pending writes inside mutate. */
  hasActiveWrites: (task: FailedTaskGroup) => boolean | Promise<boolean>;
  now?: string;
}

export interface TaskDismissalReceipt {
  workspaceId: string;
  dismissedAt: string;
  dismissedBy: string;
  results: Array<TaskReference & {
    status: "dismissed" | "already_dismissed" | "skipped";
    reason?: "TASK_NOT_FOUND" | "WORKSPACE_MISMATCH" | "TASK_NOT_FAILED" | "TASK_CHANGED" | "TASK_ACTIVE";
    members?: TaskReference[];
  }>;
  retainedEntities: true;
}

type Entry = { ref: TaskReference; record: CleanupTaskRecord };
const activeStates = new Set(["quarantined", "accepted", "processing", "syncing", "queued", "running", "pending_sync", "paused", "awaiting_review"]);
const prefix = "course-os:task-dismissal:v1:";
const requestPrefix = "course-os:task-dismiss-request:v1:";
const key = (ref: TaskReference) => JSON.stringify([ref.kind, ref.id]);
const markerKey = (workspaceId: string, ref: TaskReference) => prefix + JSON.stringify([workspaceId, ref.kind, ref.id]);

/** Only per-task markers belong in the lightweight TaskIndex, never request receipts. */
export function pickTaskDismissals(idempotency: TaskCleanupState["idempotency"]): NonNullable<TaskCleanupState["taskDismissals"]> {
  return Object.fromEntries(Object.entries(idempotency ?? {}).filter(([entryKey, entry]) => entryKey.startsWith(prefix) && entry.kind === "taskdismissal"));
}

function markers(state: TaskCleanupState): NonNullable<TaskCleanupState["taskDismissals"]> {
  return state.taskDismissals ?? pickTaskDismissals(state.idempotency);
}

function entries(state: Pick<TaskCleanupState, "imports" | "generationPlans" | "jobs">): Entry[] {
  return [
    ...state.imports.map(record => ({ ref: { kind: "import" as const, id: record.id }, record })),
    ...state.generationPlans.map(record => ({ ref: { kind: "plan" as const, id: record.id }, record })),
    ...state.jobs.map(record => ({ ref: { kind: "job" as const, id: record.id }, record }))
  ];
}

function linkedReferences(entry: Entry): TaskReference[] {
  const r = entry.record;
  const result: TaskReference[] = [];
  if (r.sourceImportId) result.push({ kind: "import", id: r.sourceImportId });
  for (const id of [r.generationPlanId, r.planId, r.retryOfPlanId]) if (id) result.push({ kind: "plan", id });
  for (const id of [r.generationJobId, r.currentJobId, r.lastJobId, ...(r.generationJobIds ?? []), ...(r.jobIds ?? []), ...(r.activeJobIds ?? [])]) {
    if (id) result.push({ kind: "job", id });
  }
  return result;
}

function groups(state: Pick<TaskCleanupState, "imports" | "generationPlans" | "jobs">): Entry[][] {
  const all = entries(state);
  const byId = new Map(all.map(entry => [key(entry.ref), entry]));
  const edges = new Map(all.map(entry => [key(entry.ref), new Set<string>()]));
  for (const entry of all) for (const ref of linkedReferences(entry)) {
    const to = key(ref);
    if (!byId.has(to)) continue;
    edges.get(key(entry.ref))!.add(to);
    edges.get(to)!.add(key(entry.ref));
  }
  const seen = new Set<string>();
  const result: Entry[][] = [];
  for (const entry of all) {
    if (seen.has(key(entry.ref))) continue;
    const members: Entry[] = [];
    const queue = [key(entry.ref)];
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      members.push(byId.get(id)!);
      queue.push(...edges.get(id)!);
    }
    members.sort((a, b) => key(a.ref).localeCompare(key(b.ref)));
    result.push(members);
  }
  return result;
}

function describe(members: Entry[]): FailedTaskGroup {
  const representative = members.find(entry => entry.ref.kind === "import")
    ?? members.find(entry => entry.ref.kind === "plan" && !entry.record.retryOfPlanId)
    ?? members.find(entry => entry.ref.kind === "plan") ?? members[0]!;
  // Exclude cost, titles and content; include the failed incarnation and its relations.
  const evidence = members.map(({ ref, record: r }) => ({
    ...ref, workspaceId: r.workspaceId, state: r.state, generationState: r.generationState,
    createdAt: r.createdAt, updatedAt: r.updatedAt, attempt: r.attempt, taskIncarnation: r.taskIncarnation, lastErrorCode: r.lastErrorCode,
    materialVersionId: r.materialVersionId, pageIds: r.pageIds,
    completedPageIds: r.completedPageIds ?? r.generationCompletedPageIds,
    failedPageIds: r.failedPageIds ?? r.generationFailedPageIds,
    links: linkedReferences({ ref, record: r }).sort((a, b) => key(a).localeCompare(key(b))), lease: r.lease
  }));
  return {
    ...representative.ref, workspaceId: representative.record.workspaceId,
    fingerprint: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
    members: members.map(entry => entry.ref),
    materialVersionIds: [...new Set(members.flatMap(entry => entry.record.materialVersionId ? [entry.record.materialVersionId] : []))],
    pageIds: [...new Set(members.flatMap(entry => entry.record.pageIds ?? []))]
  };
}

function failed(members: Entry[]): boolean {
  const root = describe(members);
  const r = members.find(entry => key(entry.ref) === key(root))!.record;
  return r.state === "failed" || (root.kind === "import" && r.state === "rejected") || (root.kind === "import" && r.state === "ready" && r.generationState === "failed")
    || (root.kind === "import" && r.state === "ready" && members.some(entry => entry.ref.kind === "plan" && entry.record.state === "failed"));
}

function active(entry: Entry, now: number): boolean {
  const r = entry.record;
  const failedImport = entry.ref.kind === "import" && ["failed", "rejected"].includes(r.state);
  return activeStates.has(r.state) || Boolean(!failedImport && r.generationState && activeStates.has(r.generationState))
    || Boolean(r.lease && (!Number.isFinite(Date.parse(r.lease.expiresAt)) || Date.parse(r.lease.expiresAt) > now));
}

/** Snapshot exact terminal candidates for confirmation; active checks run again at execution. */
export function selectFailedTasks(state: TaskCleanupState, workspaceId: string): FailedTaskGroup[] {
  const saved = markers(state);
  return groups(state).filter(members => members.every(entry => entry.record.workspaceId === workspaceId) && failed(members))
    .map(describe).filter(task => saved[markerKey(workspaceId, task)]?.objectId !== task.fingerprint);
}

/** Use for task list, history and search projections; retain direct entity/detail reads. */
export function isTaskDismissed(state: TaskCleanupState, workspaceId: string, ref: TaskReference): boolean {
  const members = groups(state).find(group => group.some(entry => key(entry.ref) === key(ref)));
  if (!members || !members.every(entry => entry.record.workspaceId === workspaceId) || !failed(members)) return false;
  const current = describe(members);
  const saved = markers(state);
  return saved[markerKey(workspaceId, ref)]?.kind === "taskdismissal"
    && saved[markerKey(workspaceId, ref)]?.objectId === current.fingerprint;
}

/** Compute relationships once for list/history/search, preserving original entity records. */
export function filterDismissedTasks<T extends TaskCleanupState>(state: T, workspaceId: string): T {
  const saved = markers(state);
  if (!Object.keys(saved).length) return state;
  const hidden = new Set<string>();
  for (const members of groups(state)) {
    if (!members.every(entry => entry.record.workspaceId === workspaceId) || !failed(members)) continue;
    const task = describe(members);
    for (const ref of task.members) if (saved[markerKey(workspaceId, ref)]?.kind === "taskdismissal"
      && saved[markerKey(workspaceId, ref)]?.objectId === task.fingerprint) hidden.add(key(ref));
  }
  return { ...state, imports: state.imports.filter(record => !hidden.has(key({ kind: "import", id: record.id }))),
    generationPlans: state.generationPlans.filter(record => !hidden.has(key({ kind: "plan", id: record.id }))),
    jobs: state.jobs.filter(record => !hidden.has(key({ kind: "job", id: record.id }))) } as T;
}

/** Use under the existing write lock, including the PostgreSQL job row lock. */
export function advanceTaskIncarnation(record: CleanupTaskRecord, before: CleanupTaskRecord): void {
  if (record.id !== before.id || record.workspaceId !== before.workspaceId) throw new Error("TASK_IDENTITY_CHANGED");
  const incarnation = before.taskIncarnation ?? 0;
  if (!Number.isSafeInteger(incarnation) || incarnation < 0 || incarnation === Number.MAX_SAFE_INTEGER) throw new Error("TASK_INCARNATION_INVALID");
  if (record.state === before.state && record.generationState === before.generationState) {
    // A same-state write from an older projection must not erase the stored fence.
    if (before.taskIncarnation === undefined) delete record.taskIncarnation;
    else record.taskIncarnation = incarnation;
    return;
  }
  record.taskIncarnation = incarnation + 1;
}

/** Existing store write hook: a resumed task must not inherit an old dismissal. */
export function reconcileTaskDismissals(state: TaskCleanupState & { idempotency: NonNullable<TaskCleanupState["idempotency"]> }, previousTasks?: Pick<TaskCleanupState, "imports" | "generationPlans" | "jobs">): void {
  if (previousTasks) {
    const previous = new Map(entries(previousTasks).map(entry => [key(entry.ref), entry.record]));
    for (const { ref, record } of entries(state)) {
      const before = previous.get(key(ref));
      if (before) advanceTaskIncarnation(record, before);
    }
  }
  const saved = pickTaskDismissals(state.idempotency);
  if (!Object.keys(saved).length) return;
  const valid = new Map<string, string>();
  for (const members of groups(state)) {
    const workspaceId = members[0]!.record.workspaceId;
    if (!members.every(entry => entry.record.workspaceId === workspaceId) || !failed(members)) continue;
    const task = describe(members);
    for (const ref of task.members) valid.set(markerKey(workspaceId, ref), task.fingerprint);
  }
  for (const [entryKey, entry] of Object.entries(saved)) {
    if (valid.get(entryKey) !== entry.objectId) delete state.idempotency[entryKey];
  }
}

/** Call ONLY inside the existing store.mutate callback, never mutate a read snapshot. */
export async function dismissFailedTasks(state: TaskCleanupState & { idempotency: NonNullable<TaskCleanupState["idempotency"]> }, selected: FailedTaskSelection[], context: TaskDismissalContext): Promise<TaskDismissalReceipt> {
  if (!context.workspaceId.trim() || !context.actor.trim() || !context.idempotencyKey.trim() || typeof context.hasActiveWrites !== "function") throw new Error("TASK_DISMISS_CONTEXT_REQUIRED");
  if (selected.some(item => !["import", "plan", "job"].includes(item.kind) || !item.id || !/^[a-f0-9]{64}$/.test(item.fingerprint))) throw new Error("TASK_DISMISS_SELECTION_INVALID");
  const unique = [...new Map(selected.map(item => [key(item), item])).values()].sort((a, b) => key(a).localeCompare(key(b)));
  if (selected.some(item => unique.find(candidate => key(candidate) === key(item))?.fingerprint !== item.fingerprint)) throw new Error("TASK_DISMISS_SELECTION_CONFLICT");
  const requestKey = requestPrefix + JSON.stringify([context.workspaceId, context.idempotencyKey]);
  const requestFingerprint = JSON.stringify(unique.map(({ kind, id, fingerprint }) => ({ kind, id, fingerprint })));
  const replay = state.idempotency[requestKey];
  if (replay) {
    if (replay.kind !== "task_dismiss_receipt") throw new Error("TASK_DISMISS_IDEMPOTENCY_CONFLICT");
    const saved = JSON.parse(replay.objectId) as { requestFingerprint: string; receipt: TaskDismissalReceipt };
    if (saved.requestFingerprint !== requestFingerprint) throw new Error("TASK_DISMISS_IDEMPOTENCY_CONFLICT");
    return structuredClone(saved.receipt);
  }
  const now = context.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new Error("TASK_DISMISS_TIME_INVALID");
  const receipt: TaskDismissalReceipt = { workspaceId: context.workspaceId, dismissedAt: now, dismissedBy: context.actor, results: [], retainedEntities: true };
  const handled = new Set<string>();
  for (const selection of unique) {
    const members = groups(state).find(group => group.some(entry => key(entry.ref) === key(selection)));
    const task = members ? describe(members) : undefined;
    if (task && handled.has(key(task))) continue;
    if (task) handled.add(key(task));
    let reason: TaskDismissalReceipt["results"][number]["reason"];
    if (!members || !task) reason = "TASK_NOT_FOUND";
    else if (members.some(entry => entry.record.workspaceId !== context.workspaceId)) reason = "WORKSPACE_MISMATCH";
    else if (!failed(members)) reason = "TASK_NOT_FAILED";
    else if (task.fingerprint !== selection.fingerprint) reason = "TASK_CHANGED";
    else {
      const activeReference = members.some(entry => active(entry, Date.parse(now)));
      if (activeReference || await context.hasActiveWrites(task)) reason = "TASK_ACTIVE";
    }
    if (reason) { receipt.results.push({ ...selection, status: "skipped", reason }); continue; }
    const already = isTaskDismissed(state, context.workspaceId, selection);
    for (const ref of task!.members) state.idempotency[markerKey(context.workspaceId, ref)] = { kind: "taskdismissal", objectId: task!.fingerprint };
    receipt.results.push({ kind: task!.kind, id: task!.id, status: already ? "already_dismissed" : "dismissed", members: task!.members });
  }
  state.idempotency[requestKey] = { kind: "task_dismiss_receipt", objectId: JSON.stringify({ requestFingerprint, receipt }) };
  return receipt;
}
