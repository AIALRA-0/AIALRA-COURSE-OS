import { describe, expect, it } from "vitest";
import type { GenerationCostEntry } from "@course-os/contracts";
import type { WebGenerationPlan, WebImportRecord } from "./types.js";
import { applyTaskEvent, mergeTaskRoutes, taskEventJobIds, type TaskEventEvidence } from "./ImportTaskEvents.js";

const empty = (): TaskEventEvidence => ({ routes: [], retries: [] });
describe("existing generation event evidence", () => {
  it("subscribes only to current and last task even when the plan has 56 jobs", () => {
    const record = { generationJobId: "job-old" } as WebImportRecord;
    const plan = { currentJobId: "job-current", lastJobId: "job-last", jobIds: Array.from({ length: 56 }, (_, index) => `job-${index}`) } as WebGenerationPlan;
    expect(taskEventJobIds(record, plan)).toEqual(["job-current", "job-last"]);
    expect(taskEventJobIds(record)).toEqual(["job-old"]);
    expect(taskEventJobIds(record, { ...plan, lastJobId: "job-current" })).toEqual(["job-current"]);
    expect(taskEventJobIds({} as WebImportRecord)).toEqual([]);
  });
  it("merges cost routes with observed events instead of hiding either source", () => {
    const events = [{ label: "页面理解", provider: "vision", model: "vision-model" }];
    const cost = { stage: "teach", provider: "teaching", model: "teaching-model" } as GenerationCostEntry;
    const merged = mergeTaskRoutes(events, [cost, cost]);
    expect(merged).toEqual([...events, { label: "正文讲解（成本记录）", provider: "teaching", model: "teaching-model" }]);
    expect(mergeTaskRoutes(merged, [])).toEqual(merged);
  });
  it("keeps page-understanding and teaching routes distinct", () => {
    const vision = applyTaskEvent(empty(), "generation.stage.completed", { stage: "extract", phase: "page_understanding", provider: "opencode-go", model: "gpt-5.6-luna" });
    const teaching = applyTaskEvent(vision, "generation.stage.completed", { stage: "teach", phase: "teaching", provider: "kuafu", model: "deepseek-v4.1-flash" });
    expect(teaching.routes).toEqual([
      { label: "页面理解", provider: "opencode-go", model: "gpt-5.6-luna" },
      { label: "正文讲解", provider: "kuafu", model: "deepseek-v4.1-flash" }
    ]);
  });
  it("uses retry attempts only as retry evidence and clears them at terminal page events", () => {
    const retry = applyTaskEvent(empty(), "generation.page.storage_retry", { pageId: "p30", attempt: 1, reusedTeaching: true });
    const again = applyTaskEvent(retry, "generation.page.storage_retry", { pageId: "p30", attempt: 2, reusedTeaching: true });
    expect(again.retries).toEqual([{ pageId: "p30", attempt: 2, reusedTeaching: true }]);
    expect(again.routes).toEqual([]);
    expect(applyTaskEvent(again, "generation.page.completed", { pageId: "p30" }).retries).toEqual([]);
    expect(applyTaskEvent(again, "generation.page.failed", { pageId: "p30" }).retries).toEqual([]);
  });
  it("rejects malformed payloads and invented retry counts", () => {
    const evidence = empty();
    for (const payload of [null, [], {}, { pageId: "p1", attempt: -1 }, { pageId: "p1", attempt: "2" }]) {
      expect(applyTaskEvent(evidence, "generation.page.storage_retry", payload)).toBe(evidence);
    }
    expect(applyTaskEvent(evidence, "generation.stage.completed", { phase: "teaching" })).toBe(evidence);
  });
  it("deduplicates repeated routes while keeping an actual fallback route", () => {
    const first = applyTaskEvent(empty(), "generation.stage.completed", { stage: "teach", provider: "one", model: "a" });
    const repeat = applyTaskEvent(first, "generation.stage.completed", { stage: "teach", provider: "one", model: "a" });
    const fallback = applyTaskEvent(repeat, "generation.stage.completed", { stage: "teach", provider: "two", model: "b" });
    expect(repeat.routes).toHaveLength(1);
    expect(fallback.routes).toHaveLength(2);
  });
});
