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

  it("splits an imported slide into checkable text regions instead of one whole-page claim", () => {
    const imported = {
      ...page,
      anchors: [{ ...page.anchors[0]!, text: "EDGE-GNN: EDGE EMBEDDING\nW_e ∈ R32×64\n节点向量是 32 维\n17/27" }],
      atoms: [{ kind: "image_region", id: "whole-page", label: "整页来源画面", observation: "原始画面" }],
      coverageRequirements: [{ id: "whole-page:requirement", atomId: "whole-page", requiredFields: ["label", "observation"], risk: "general" }]
    } as PageLesson;
    const prepared = preparePageForGeneration(imported);
    const regions = prepared.atoms.filter((atom) => atom.kind === "text_region");
    expect(prepared.coverageRequirements.find(item => item.atomId === "whole-page")?.requiredFields).toEqual(["observation"]);
    expect(regions).toHaveLength(3);
    expect(regions.map((atom) => atom.observation).join("\n")).toContain("32×64");
    expect(regions.map((atom) => atom.observation).join("\n")).not.toContain("17/27");
    expect(prepared.coverageRequirements.filter((item) => item.atomId.includes("source-text-region")).every((item) => item.requiredFields.join() === "observation")).toBe(true);
    expect(buildGenerationSourceText(prepared)).not.toContain("17/27");
    expect(prepared.anchors[0]?.text).toContain("17/27");
    expect(prepared.coverageRequirements.filter((item) => item.risk === "high")).toHaveLength(2);
    const blueprint = buildTeachingBlueprint(prepared, buildGenerationSourceText(prepared), "zh-CN", "quality", "writing-policy:test", true);
    expect(validateTeachingBlueprint(prepared, blueprint)).toEqual([]);
  });

  it("keeps slide headings as source context without demanding a teaching claim for them", () => {
    const imported = {
      ...page,
      title: "TINY MDP EXAMPLE",
      anchors: [{ ...page.anchors[0]!, text: "TINY MDP EXAMPLE\nSetup\nSingle state: s\nTwo actions: a1, a2" }],
      atoms: [{ kind: "image_region", id: "whole-page", label: "整页来源画面", observation: "原始画面" }],
      coverageRequirements: []
    } as PageLesson;
    const prepared = preparePageForGeneration(imported);
    expect(prepared.atoms.filter((atom) => atom.kind === "text_region")).toHaveLength(4);
    expect(prepared.coverageRequirements.map((item) => item.atomId)).toEqual([
      "page:1:source-text-region:3", "page:1:source-text-region:4"
    ]);
    expect(buildGenerationSourceText(prepared)).toContain("TINY MDP EXAMPLE");
    expect(buildGenerationSourceText(prepared)).toContain("Two actions: a1, a2");
  });

  it("does not mistake capitalized factual statements or formulas for headings", () => {
    const imported = {
      ...page,
      anchors: [{ ...page.anchors[0]!, text: "OVERVIEW\nONLY ONE MATRIX FOR ALL EDGES\nW_e ∈ R32×64\nMacro order: place larger ones first" }],
      atoms: [{ kind: "image_region", id: "whole-page", label: "整页来源画面", observation: "原始画面" }],
      coverageRequirements: []
    } as PageLesson;
    const prepared = preparePageForGeneration(imported);
    expect(prepared.coverageRequirements.map((item) => item.atomId)).toEqual([
      "page:1:source-text-region:2", "page:1:source-text-region:3", "page:1:source-text-region:4"
    ]);
  });

  it("classifies the visible slide instead of serialized bookkeeping or English prose", () => {
    const imported = {
      ...page,
      title: "EDGE-GNN: EDGE EMBEDDING",
      anchors: [{ ...page.anchors[0]!, text: "Formula\nOnly one matrix for all edges\nW_e ∈ R32×64\ne_ij = W_e [v_i; v_j] + b" }],
      atoms: [{ kind: "image_region", id: "whole-page", label: "整页来源画面", observation: "原始画面" }],
      coverageRequirements: [{ id: "whole-page:requirement", atomId: "whole-page", requiredFields: ["label", "observation"], risk: "general" }]
    } as PageLesson;
    const prepared = preparePageForGeneration(imported);
    const blueprint = buildTeachingBlueprint(prepared, buildGenerationSourceText(prepared), "zh-CN", "quality", "writing-policy:test", true);
    expect(blueprint.resourcePackage).toMatchObject({ pageKind: "formula", sourceDensity: "sparse" });
    expect(blueprint.resourcePackage.sourceText).not.toContain("whole-page:requirement");
  });

  it("does not treat ordinary prose containing 'for' as pseudocode", () => {
    const imported = {
      ...page,
      title: "EDGE-GNN: WHY?",
      anchors: [{ ...page.anchors[0]!, text: "A learned representation encoder for the given netlist\nPre-train it with labelled data" }],
      atoms: [{ kind: "image_region", id: "whole-page", label: "整页来源画面", observation: "原始画面" }]
    } as PageLesson;
    const prepared = preparePageForGeneration(imported);
    const blueprint = buildTeachingBlueprint(prepared, buildGenerationSourceText(prepared), "zh-CN", "quality", "writing-policy:test", true);
    expect(blueprint.resourcePackage).toMatchObject({ pageKind: "concept", sourceDensity: "sparse" });
  });

  it("recognizes a sparse slide with Unicode mathematical symbols as a formula page", () => {
    const imported = {
      ...page,
      title: "公式示例",
      anchors: [{ ...page.anchors[0]!, text: "策略参数 𝜃𝜃1 = 0，𝜃𝜃2 = 0；梯度更新 𝜃𝜃 ← 𝜃𝜃 + 𝛼𝛼 ∇𝜃𝜃 log 𝜋𝜋" }],
      atoms: [{ kind: "image_region", id: "whole-page", label: "整页来源画面", observation: "原始画面" }]
    } as PageLesson;
    const blueprint = buildTeachingBlueprint(imported, "", "zh-CN", "quality", "writing-policy:test", true);
    expect(blueprint.resourcePackage).toMatchObject({ pageKind: "formula", sourceDensity: "sparse" });
  });

  it("classifies a flow slide as a diagram even when text extraction misses graphic labels", () => {
    const imported = {
      ...page,
      title: "OVERALL FLOW",
      anchors: [{ ...page.anchors[0]!, text: "Macro placement then standard-cell placement" }],
      atoms: [{ kind: "image_region", id: "whole-page", label: "整页来源画面", observation: "原始画面" }]
    } as PageLesson;
    const blueprint = buildTeachingBlueprint(imported, "", "zh-CN", "quality", "writing-policy:test", true);
    expect(blueprint.resourcePackage).toMatchObject({ pageKind: "diagram", sourceDensity: "sparse" });
  });
});
