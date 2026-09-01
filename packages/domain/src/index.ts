import { createHash } from "node:crypto";
import type { GenerationJob, JobState, MasteryRecord, AssessmentAttempt, ReleaseManifest } from "@course-os/contracts";

const JOB_TRANSITIONS: Record<JobState, JobState[]> = {
  queued: ["running", "cancelled"],
  running: ["pending_sync", "paused", "cancelled", "failed", "queued"],
  pending_sync: ["completed", "paused", "cancelled", "failed"],
  completed: ["queued"],
  paused: ["queued", "cancelled"],
  cancelled: [],
  failed: ["queued", "cancelled"]
};

export function transitionJob(job: GenerationJob, next: JobState, at = new Date()): GenerationJob {
  if (!JOB_TRANSITIONS[job.state].includes(next)) {
    throw new Error(`JOB_TRANSITION_INVALID:${job.state}->${next}`);
  }
  return { ...job, state: next, updatedAt: at.toISOString() };
}

export function registerCost(job: GenerationJob, costUsd: number): GenerationJob {
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new Error("JOB_COST_INVALID");
  }
  const spentUsd = roundMoney(job.spentUsd + costUsd);
  if (spentUsd > job.budgetUsd) {
    throw new Error("JOB_BUDGET_EXCEEDED");
  }
  return { ...job, spentUsd, updatedAt: new Date().toISOString() };
}

export function budgetState(job: GenerationJob): "ok" | "warning" | "exhausted" {
  if (job.budgetUsd <= 0 || job.spentUsd >= job.budgetUsd) return "exhausted";
  if (job.spentUsd / job.budgetUsd >= 0.8) return "warning";
  return "ok";
}

const REVIEW_INTERVALS_DAYS = [1, 3, 7, 14, 30] as const;

export function applyAttempt(
  previous: MasteryRecord | undefined,
  attempt: AssessmentAttempt,
  now = new Date()
): MasteryRecord {
  const current = previous ?? {
    objectiveId: attempt.objectiveId,
    state: "unseen" as const,
    unaidedCorrect: false,
    delayedOrTransferCorrect: false,
    intervalStep: 0,
    algorithmVersion: "review-ladder-v1" as const,
    updatedAt: now.toISOString()
  };

  const unaidedCorrect = current.unaidedCorrect || (attempt.correct && attempt.usedHintLevel === 0);
  const delayedOrTransferCorrect = current.delayedOrTransferCorrect || (attempt.correct && attempt.usedHintLevel === 0 && isTransferAttempt(attempt));
  const mastered = unaidedCorrect && delayedOrTransferCorrect;
  const successful = attempt.correct && attempt.usedHintLevel === 0;
  const intervalStep = successful
    ? Math.min(current.intervalStep + 1, REVIEW_INTERVALS_DAYS.length - 1)
    : Math.max(0, current.intervalStep - 2);
  const state = mastered ? "mastered" : successful ? "practicing" : "needs_review";
  const nextReviewAt = addDays(now, REVIEW_INTERVALS_DAYS[intervalStep]!).toISOString();

  return {
    ...current,
    state,
    unaidedCorrect,
    delayedOrTransferCorrect,
    intervalStep,
    nextReviewAt,
    updatedAt: now.toISOString()
  };
}

function isTransferAttempt(attempt: AssessmentAttempt): boolean {
  return attempt.itemId.includes(":transfer") || attempt.itemId.includes(":delayed");
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashManifest(manifest: ReleaseManifest): string {
  return sha256Text(stableStringify(manifest));
}
