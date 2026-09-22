import { describe, expect, it } from "vitest";
import type { CourseRelease, SelfRetelling } from "@course-os/contracts";
import { readingProgress, selfRetellingCards } from "./self-retelling-model.js";

const now = Date.parse("2026-09-22T12:00:00.000Z");
const release = { id: "r1", pageIds: ["p1", "p2", "p3"], pages: [
  { id: "p1", pageNumber: 1, title: "标题一" }, { id: "p2", pageNumber: 2, title: "标题二" }, { id: "p3", pageNumber: 3, title: "标题三" }
] } as CourseRelease;
const record = (pageId: string, answer: string, nextReviewAt?: string): SelfRetelling => ({ workspaceId: "personal", releaseId: "r1", pageId, answer, answeredAt: "2026-09-22T11:00:00.000Z", updatedAt: "2026-09-22T11:00:00.000Z", nextReviewAt });

describe("self retelling progress and cards", () => {
  it("counts answered pages only, once per page, and ignores blank or unrelated records", () => {
    expect(readingProgress(release.pageIds, [record("p1", "已回答"), record("p1", "再次回答"), record("p2", "  "), record("outside", "无关")])).toEqual({ answered: 1, total: 3, percent: 33 });
  });

  it("handles empty releases without dividing by zero", () => {
    expect(readingProgress([], [])).toEqual({ answered: 0, total: 0, percent: 0 });
  });

  it("uses page titles and returns only due answered cards by default", () => {
    const cards = selfRetellingCards([release], [record("p1", "我的解释"), record("p2", "稍后", new Date(now + 60_000).toISOString())], now);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ page: { title: "标题一" }, retelling: { answer: "我的解释" } });
  });

  it("allows viewing scheduled cards when requested", () => {
    expect(selfRetellingCards([release], [record("p2", "计划中", new Date(now + 60_000).toISOString())], now, false)).toHaveLength(1);
  });
});
