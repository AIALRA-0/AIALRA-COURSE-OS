import { describe, expect, it } from "vitest";
import type { PageLesson } from "@course-os/contracts";
import { buildGenerationSourceText, buildTeachingBlueprint, preparePageForGeneration, validateTeachingBlueprint } from "./teaching-blueprint.js";

const page = {
  id: "page:1", pageNumber: 1, title: "示例", imageUrl: "", anchors: [{ id: "a1", pageId: "page:1", kind: "text", label: "标题" }],
  atoms: [{ kind: "diagram_node", id: "atom:1", label: "节点", observation: "一个节点" }], blocks: [],
  coverageRequirements: [{ id: "req:1", atomId: "atom:1", requiredFields: ["observation"], risk: "high" }], coverageClaims: [],
  quality: { highRiskCoverage: 0, generalCoverage: 0, mathValid: true, publishable: false, issues: [] }
} as PageLesson;

describe("teaching blueprint", () => {
  it("builds a stable package that assigns every requirement", () => {
    const result = buildTeachingBlueprint(page, "来源文本", "zh-CN", "quality", "writing-policy:test", true);
    expect(result.version).toBe("2.0.0");
    expect(result.steps).toHaveLength(6);
    expect(result.resourcePackage).toMatchObject({ pageKind: "diagram", sourceDensity: "sparse" });
    expect(result.steps.find((step) => step.kind === "example")?.required).toBe(true);
    expect(result.steps.find((step) => step.kind === "relationship")?.requirementIds).toEqual(["req:1"]);
    expect(validateTeachingBlueprint(page, result)).toEqual([]);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a blueprint with an unknown atom", () => {
    const result = buildTeachingBlueprint(page, "来源文本", "zh-CN", "balanced", "writing-policy:test", false);
    result.steps[1]!.atomIds.push("atom:missing");
    expect(validateTeachingBlueprint(page, result)).toContain("BLUEPRINT_UNKNOWN_ATOM:atom:missing");
  });

  it("uses only first-party extracted text and removes impossible coverage fields", () => {
    const inherited = {
      ...page,
      anchors: [{ ...page.anchors[0]!, text: "原始幻灯片文字" }],
      coverageRequirements: [{ ...page.coverageRequirements[0]!, requiredFields: ["label", "observation", "inference"] }],
      blocks: [{ id: "old", title: "旧模型讲解", kind: "deep_dive", markdown: "这段旧讲解绝不能再次成为来源", sourceAnchorIds: [], atomIds: [] }]
    } as PageLesson;
    const prepared = preparePageForGeneration(inherited);
    expect(prepared.coverageRequirements[0]?.requiredFields).toEqual(["label", "observation"]);
    const source = buildGenerationSourceText(prepared);
    expect(source).toContain("原始幻灯片文字");
    expect(source).not.toContain("这段旧讲解绝不能再次成为来源");
  });
});
