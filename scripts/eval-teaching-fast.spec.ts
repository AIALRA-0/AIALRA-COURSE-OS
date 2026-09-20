import { describe, expect, it } from "vitest";
import type { PageLesson } from "@course-os/contracts";
import { compareFastEvaluations, runFastEvaluation, type FastEvaluationManifest, type FastEvaluationSource } from "./lib/eval-teaching-fast.js";

function page(id: string, pageNumber: number, title: string, publishable = true): PageLesson {
  return {
    id, pageNumber, title, imageUrl: "/fixture.svg", anchors: [], atoms: [], blocks: [],
    lessonFlowVersion: 2, teachingCompositionVersion: 1,
    teachingTrace: { version: 1, plan: {}, phases: [] },
    lessonSections: [
      { kind: "learning_objectives", title: "目标", items: [{ text: "目标" }] },
      { kind: "main_content", title: "内容", markdown: "内容" },
      { kind: "prior_knowledge", title: "先验", items: [{ text: "知识：说明" }] },
      { kind: "full_explanation", title: "讲解", markdown: "这是一个足够长的教学解释".repeat(80) },
      { kind: "misconceptions", title: "易错点", items: [{ text: "错误认识：说明；错因：说明；正确判断：说明；核对方法：说明" }] }
    ],
    questionBank: [1, 2, 3, 4].map((index) => ({ id: `${id}:q${index}`, pageId: id, objectiveId: "objective", kind: index < 3 ? "comprehension" : "multiple_choice", prompt: "问题", options: index < 3 ? [] : ["A", "B", "C", "D"], expectedAnswer: index < 3 ? "答案" : "A", explanation: "说明", sourceAnchorIds: [], status: "approved", version: 1, generatedBy: "fixture" })),
    coverageRequirements: [], coverageClaims: [], quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable, issues: publishable ? [] : ["fixture-content-failure"] }
  } as unknown as PageLesson;
}

function source(): FastEvaluationSource {
  return {
    releases: [{ id: "candidate-release", moduleId: "fixture-module", moduleTitle: "Synthetic Teaching", version: 1, lifecycle: "published", pages: [page("fixture-1", 1, "Formula page"), page("fixture-2", 2, "Broken page", false)] }],
    costEntries: [{ pageId: "fixture-1", provider: "fixture", model: "fixture-model", stage: "teach", estimatedMicrousd: 10, actualMicrousd: 8, durationMs: 12, status: "succeeded" }],
    generationErrors: [{ pageId: "fixture-1", code: "PROVIDER_RATE_LIMIT" }, { pageId: "fixture-2", code: "CONTENT_SCHEMA_INVALID" }],
    repairTickets: [{ pageId: "fixture-1", stage: "repair", status: "applied" }]
  };
}

const manifest: FastEvaluationManifest = { schemaVersion: 1, seed: "fixture-seed", concurrency: 2, selection: { featureTags: ["visual"] } };

describe("fast teaching evaluation", () => {
  it("selects deterministically, preserves metadata, and separates provider from content failures", async () => {
    const result = await runFastEvaluation(source(), manifest, "fixture");
    expect(result.selectedPageCount).toBe(2);
    expect(result.failureCounts.provider).toBe(1);
    expect(result.failureCounts.content).toBeGreaterThan(0);
    const costRow = result.rows.find((row) => row.pageId === "fixture-1");
    expect(costRow?.metadata.cost.entryCount).toBe(1);
    expect(costRow?.metadata.repairs).toHaveLength(1);
    const repeated = await runFastEvaluation(source(), manifest, "fixture");
    expect(repeated.rows.map((row) => row.key)).toEqual(result.rows.map((row) => row.key));
    const degraded = await runFastEvaluation({ ...source(), errors: [{ code: "NETWORK_TIMEOUT" }] }, manifest, "fixture");
    expect(degraded.failureCounts.network).toBe(1);
  });

  it("compares matched pages without requiring a ReadWeave or Docker call", async () => {
    const baseline = await runFastEvaluation(source(), { ...manifest, seed: "baseline" }, "baseline");
    const candidate = await runFastEvaluation({ ...source(), costEntries: [], releases: [{ ...source().releases![0] as object, pages: [page("fixture-1", 1, "Formula page")] }] }, { ...manifest, seed: "candidate" }, "candidate");
    const comparison = compareFastEvaluations(baseline, candidate);
    expect(comparison.matchedPageCount).toBe(1);
    expect(comparison.baselineOnly).toContain("fixture-2");
    expect(comparison.costDeltaMicrousd).toBe(-8);
  });
});
