import { AsyncLocalStorage } from "node:async_hooks";

export interface ReadBudgetOptions {
  /** Absolute Unix time in milliseconds. */
  deadline?: number;
  /** Relative limit in milliseconds, measured when the scope starts. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ReadBudget {
  signal: AbortSignal;
  deadline?: number;
}

type ReadBudgetErrorCode = "READ_DEADLINE_EXCEEDED" | "READ_CANCELLED";

const readBudgetStorage = new AsyncLocalStorage<ReadBudget>();

export function currentReadBudget(): ReadBudget | undefined {
  return readBudgetStorage.getStore();
}

export async function withReadBudget<T>(options: ReadBudgetOptions, fn: () => T | Promise<T>): Promise<T> {
  const parent = currentReadBudget();
  const startedAt = Date.now();
  const deadlines = [
    parent?.deadline,
    finiteDeadline(options.deadline),
    Number.isFinite(options.timeoutMs) ? startedAt + options.timeoutMs! : undefined
  ].filter((value): value is number => value !== undefined);
  const deadline = deadlines.length ? Math.min(...deadlines) : undefined;
  const controller = new AbortController();
  const budget: ReadBudget = deadline === undefined
    ? { signal: controller.signal }
    : { signal: controller.signal, deadline };
  const sources = [...new Set([parent?.signal, options.signal].filter((value): value is AbortSignal => value !== undefined))];
  const listeners = sources.map((source) => {
    const abort = () => controller.abort(readBudgetAbortError(source));
    if (source.aborted) abort();
    else source.addEventListener("abort", abort, { once: true });
    return { source, abort };
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleDeadline = () => {
    if (deadline === undefined || controller.signal.aborted) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      controller.abort(makeReadBudgetError("READ_DEADLINE_EXCEEDED"));
      return;
    }
    timer = setTimeout(scheduleDeadline, Math.min(remaining, 2_147_483_647));
  };
  scheduleDeadline();

  try {
    return await readBudgetStorage.run(budget, async () => {
      assertReadBudgetActive(budget);
      return raceWithBudgetSignal(Promise.resolve().then(fn), budget);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    for (const { source, abort } of listeners) source.removeEventListener("abort", abort);
  }
}

/** Run a shared operation with its own scope, detached from its first caller's scope. */
export function withIndependentReadBudget<T>(options: ReadBudgetOptions, fn: () => T | Promise<T>): Promise<T> {
  return readBudgetStorage.exit(() => withReadBudget(options, fn));
}

export function readBudgetAbortError(signal: AbortSignal, deadline?: number): Error {
  if (isReadBudgetError(signal.reason)) return signal.reason;
  if (deadline !== undefined && Date.now() >= deadline) return makeReadBudgetError("READ_DEADLINE_EXCEEDED");
  return makeReadBudgetError("READ_CANCELLED");
}

export function assertReadBudgetActive(budget: ReadBudget): void {
  if (budget.signal.aborted) throw readBudgetAbortError(budget.signal, budget.deadline);
  if (budget.deadline !== undefined && Date.now() >= budget.deadline) {
    throw makeReadBudgetError("READ_DEADLINE_EXCEEDED");
  }
}

function raceWithBudgetSignal<T>(work: Promise<T>, budget: ReadBudget): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      budget.signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => finish(() => reject(readBudgetAbortError(budget.signal, budget.deadline)));
    budget.signal.addEventListener("abort", onAbort, { once: true });
    if (budget.signal.aborted) {
      onAbort();
      return;
    }
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

function finiteDeadline(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function isReadBudgetError(value: unknown): value is Error {
  return value instanceof Error
    && (value.message === "READ_DEADLINE_EXCEEDED" || value.message === "READ_CANCELLED");
}

function makeReadBudgetError(code: ReadBudgetErrorCode): Error {
  const error = new Error(code);
  error.name = code;
  return error;
}
