import { describe, expect, it } from "vitest";
import type { PageLesson } from "@course-os/contracts";
import { buildTeachingBlueprint, validateTeachingBlueprint } from "./teaching-blueprint.js";

const page = {
  id: "page:1", pageNumber: 1, title: "示例", imageUrl: "", anchors: [{ id: "a1", pageId: "page:1", kind: "text", label: "标题" }],
  atoms: [{ kind: "diagram_node", id: "atom:1", label: "节点", observation: "一个节点" }], blocks: [],
  coverageRequirements: [{ id: "req:1", atomId: "atom:1", requiredFields: ["observation"], risk: "high" }], coverageClaims: [],
  quality: { highRiskCoverage: 0, generalCoverage: 0, mathValid: true, publishable: false, issues: [] }
} as PageLesson;

describe("teaching blueprint", () => {
  it("builds a stable package that assigns every requirement", () => {
    const result = buildTeachingBlueprint(page, "来源文本", "zh-CN", "quality", "writing-policy:test", true);
    expect(result.version).toBe("1.0.0");
    expect(result.steps).toHaveLength(6);
    expect(result.steps.find((step) => step.kind === "relationship")?.requirementIds).toEqual(["req:1"]);
    expect(validateTeachingBlueprint(page, result)).toEqual([]);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a blueprint with an unknown atom", () => {
    const result = buildTeachingBlueprint(page, "来源文本", "zh-CN", "balanced", "writing-policy:test", false);
    result.steps[1]!.atomIds.push("atom:missing");
    expect(validateTeachingBlueprint(page, result)).toContain("BLUEPRINT_UNKNOWN_ATOM:atom:missing");
  });
});
