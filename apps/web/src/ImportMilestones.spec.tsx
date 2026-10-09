import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImportMilestones, importMilestones } from "./ImportMilestones.js";
import { formatUploadStatus, summarizeImportProgress } from "./import-progress.js";
import type { WebGenerationPlan, WebImportRecord } from "./types.js";

const pages = Array.from({ length: 56 }, (_, index) => `p${index}`);
function record(values: Record<string, unknown>): WebImportRecord {
  return { id: "import-test", state: "processing", issues: [], autoGenerate: true, ...values } as unknown as WebImportRecord;
}
function conversion(stage: string, completedPages = 28) {
  return { stage, pageCount: 56, completedPages, updatedAt: "2026-10-09T22:00:00Z" };
}

describe("import milestones preserve service evidence", () => {
  it("does not equate a full conversion counter with saved course material", () => {
    const steps = importMilestones(record({ conversionProgress: conversion("rendering_pages", 56) }));
    expect(steps.map(step => step.state)).toEqual(["complete", "active", "waiting", "waiting"]);
    expect(steps[1]!.detail).toContain("56/56");
    expect(steps[3]!.detail).toBe("等待材料保存");
  });
  it("shows conversion complete and material saving before generation starts", () => {
    const steps = importMilestones(record({ state: "syncing", conversionProgress: conversion("completed", 56) }));
    expect(steps.map(step => step.state)).toEqual(["complete", "complete", "active", "waiting"]);
    expect(steps[2]!.detail).toContain("尚未确认完成");
  });
  it.each([28, 60])("does not mark ready conversion successful when its counter is %s/56", completed => {
    const source = record({ state: "ready", pageIds: pages, conversionProgress: conversion("completed", completed) });
    const steps = importMilestones(source);
    expect(steps[1]!.state).toBe("unknown");
    expect(steps[1]!.detail).toContain("转换已结束，计数待核对");
    expect(steps[2]!.state).toBe("complete");
    const markup = renderToStaticMarkup(<ImportMilestones record={source} jobs={[]} />);
    const conversionItem = markup.match(/<li[^>]*data-milestone-state="unknown"[^>]*>[\s\S]*?<\/li>/)?.[0];
    expect(conversionItem).toContain("页面转换");
    expect(conversionItem).not.toContain('data-icon-name="check"');
  });
  it("retains saved material when generation has partly failed", () => {
    const steps = importMilestones(record({ state: "ready", pageIds: pages, generationState: "failed", generationCompletedPageIds: ["p0"], generationFailedPageIds: ["p1"] }));
    expect(steps.map(step => step.state)).toEqual(["complete", "complete", "complete", "failed"]);
    expect(steps[3]!.detail).toContain("1/56");
    expect(steps[3]!.detail).toContain("1 页失败");
  });
  it("does not claim material saved after a conversion failure", () => {
    const steps = importMilestones(record({ state: "failed", conversionProgress: conversion("failed") }));
    expect(steps.map(step => step.state)).toEqual(["complete", "failed", "unknown", "waiting"]);
    expect(steps[2]!.detail).toBe("未确认保存");
  });
  it("keeps unknown page counts unconfirmed", () => {
    const steps = importMilestones(record({ conversionProgress: { stage: "counting_pages", updatedAt: "2026-10-09T22:00:00Z" } }));
    expect(steps[1]!.detail).toContain("页数待确认");
    expect(steps[1]!.detail).not.toContain("0%");
  });
  it("keeps material-only imports distinct from generated lessons", () => {
    const steps = importMilestones(record({ state: "ready", autoGenerate: false, generationState: "not_requested", pageIds: pages }));
    expect(steps.map(step => step.state)).toEqual(["complete", "complete", "complete", "waiting"]);
    expect(steps[3]!.detail).toBe("未启用自动生成");
  });
  it("requires confirmed page delivery despite a completed generation flag", () => {
    const steps = importMilestones(record({ state: "ready", generationState: "completed", pageIds: pages, generationCompletedPageIds: ["p0"] }));
    expect(steps[3]!.state).toBe("unknown");
    expect(steps[3]!.detail).toContain("状态需同步");
  });
  it("marks a fully delivered draft complete without claiming publication", () => {
    const steps = importMilestones(record({ state: "ready", generationState: "completed", pageIds: pages, generationCompletedPageIds: pages }));
    expect(steps[3]!.state).toBe("complete");
    expect(steps[3]!.detail).toContain("尚未发布");
  });
  it("does not invent upload milestones for a standalone generation task", () => {
    const steps = importMilestones(record({ id: "generation-job:job-test", state: "ready", generationState: "running", pageIds: pages }));
    expect(steps).toHaveLength(1);
    expect(steps[0]!.label).toBe("讲解生成");
  });
  it("renders an accessible current step and explicit failure details", () => {
    const markup = renderToStaticMarkup(<ImportMilestones record={record({ conversionProgress: conversion("rendering_pages") })} jobs={[]} />);
    expect(markup).toContain('aria-label="导入与生成里程碑"');
    expect(markup.match(/aria-current="step"/g)).toHaveLength(1);
    expect(markup).toContain("28/56 页");
  });
  it("preserves readable body counts even where bridge or cost storage failed", () => {
    const source = record({ state: "ready", pageIds: pages, generationState: "running",
      generationCoreCompletedPageIds: pages.slice(0, 30), generationBridgeCompletedPageIds: pages.slice(0, 20),
      generationCompletedPageIds: pages.slice(0, 20), generationFailedPageIds: pages.slice(20, 46) });
    const markup = renderToStaticMarkup(<ImportMilestones record={source} jobs={[]} />);
    expect(markup).toContain("正文可读：<strong>30/56</strong>");
    expect(markup).toContain("跨页承接完成：<strong>20/56</strong>");
    expect(markup).toContain("失败页面：<strong>26</strong>");
    expect(markup).not.toContain("正文丢失：26");
  });
  it("prefers explicit readable body evidence over whole-page completion", () => {
    const source = record({ state: "ready", pageIds: pages, generationCompletedPageIds: pages.slice(0, 20) });
    const plan = { pageIds: pages, completedPageIds: pages.slice(0, 20), coreCompletedPageIds: pages.slice(0, 30), failedPageIds: [], state: "running" } as unknown as WebGenerationPlan;
    expect(summarizeImportProgress(source, plan, [], []).core).toEqual({ completed: 30, total: 56 });
  });
});

describe("upload transport status", () => {
  it("uses confirmed byte totals and labels completion as upload only", () => {
    expect(formatUploadStatus(93, 100)).toBe("正在上传 93%");
    expect(formatUploadStatus(100, 100)).toBe("正在上传 100%");
  });
  it.each([[93, undefined], [93, 0], [93, -1], [101, 100], [-1, 100], [NaN, 100], [93, Infinity]])("does not invent percentages from invalid byte counts %s/%s", (sent, total) => {
    expect(formatUploadStatus(sent, total)).toBe("正在上传文件");
  });
});
