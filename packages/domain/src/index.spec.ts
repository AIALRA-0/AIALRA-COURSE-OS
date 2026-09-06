import { describe, expect, it } from "vitest";
import type { AssessmentAttempt, GenerationJob } from "@course-os/contracts";
import { applyAttempt, budgetState, claimGenerationLease, isGenerationLeaseCurrent, registerCost, transitionJob } from "./index.js";

const job: GenerationJob = {
  id: "job-1",
  workspaceId: "personal",
  materialVersionId: "material-1",
  state: "queued",
  budgetUsd: 8,
  spentUsd: 0,
  pageIds: ["page-1"],
  completedPageIds: [],
  failedPageIds: [],
  attempt: 0,
  cancelRequested: false,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z"
};

describe("generation job", () => {
  it("rejects invalid state transitions", () => {
    expect(() => transitionJob(job, "completed")).toThrow("JOB_TRANSITION_INVALID");
  });

  it("warns at 80 percent and blocks cost above the hard budget", () => {
    const running = transitionJob(job, "running");
    const warning = registerCost(running, 6.4);
    expect(budgetState(warning)).toBe("warning");
    expect(() => registerCost(warning, 1.61)).toThrow("JOB_BUDGET_EXCEEDED");
  });

  it("fences stale workers after a new lease is claimed", () => {
    const running = transitionJob(job, "running");
    const first = claimGenerationLease(running, "worker-a", new Date("2026-08-28T00:00:00.000Z"));
    const second = claimGenerationLease({ ...first, state: "running" }, "worker-b", new Date("2026-08-28T00:01:00.000Z"));
    expect(isGenerationLeaseCurrent(second, "worker-a", first.lease!.fenceToken, new Date("2026-08-28T00:02:00.000Z"))).toBe(false);
    expect(isGenerationLeaseCurrent(second, "worker-b", second.lease!.fenceToken, new Date("2026-08-28T00:02:00.000Z"))).toBe(true);
  });
});

describe("mastery", () => {
  it("does not mark mastery after viewing an answer or one unaided answer", () => {
    const attempt: AssessmentAttempt = {
      id: "attempt-1",
      itemId: "item-1",
      objectiveId: "objective-1",
      answer: "answer",
      correct: true,
      usedHintLevel: 6,
      attemptedAt: "2026-08-28T00:00:00.000Z"
    };
    expect(applyAttempt(undefined, attempt).state).not.toBe("mastered");
    expect(applyAttempt(undefined, { ...attempt, usedHintLevel: 0 }).state).toBe("practicing");
  });

  it("requires unaided and transfer evidence for mastery", () => {
    const first = applyAttempt(undefined, {
      id: "attempt-1",
      itemId: "item-1",
      objectiveId: "objective-1",
      answer: "answer",
      correct: true,
      usedHintLevel: 0,
      attemptedAt: "2026-08-28T00:00:00.000Z"
    });
    const transfer = applyAttempt(first, {
      id: "attempt-2",
      itemId: "item-1:transfer",
      objectiveId: "objective-1",
      answer: "answer",
      correct: true,
      usedHintLevel: 0,
      attemptedAt: "2026-09-05T00:00:00.000Z"
    });
    expect(transfer.state).toBe("mastered");
  });
});
