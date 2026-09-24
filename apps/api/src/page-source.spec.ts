import { describe, expect, it } from "vitest";
import type { PageLesson } from "@course-os/contracts";
import { buildGenerationSourceText, preparePageForGeneration } from "./page-source.js";

const page = {
  id: "page:1", pageNumber: 1, title: "示例", imageUrl: "",
  anchors: [{ id: "a1", pageId: "page:1", kind: "text", label: "提取文字", text: "Stage 1: Desired Results\nStage 2: Assessment Evidence\n5" }],
  atoms: [{ kind: "text_region", id: "footer-5", label: "5", observation: "5" }],
  blocks: [], coverageRequirements: [{ id: "footer-5:req", atomId: "footer-5", requiredFields: ["observation"], risk: "general" }],
  coverageClaims: [], quality: { highRiskCoverage: 0, generalCoverage: 0, mathValid: true, publishable: false, issues: [] }
} as PageLesson;

describe("page source", () => {
  it("passes extracted words without converting OCR lines into teaching obligations", () => {
    const source = buildGenerationSourceText(page);
    expect(source).toContain("Stage 1: Desired Results");
    expect(source).toContain("Stage 2: Assessment Evidence");
    expect(source).toContain("\n5");
    expect(source).not.toContain("footer-5:req");
    expect(source).not.toContain("requiredFields");
  });

  it("does not pass an old draft as original slide text when extracted text exists", () => {
    const withDraft = { ...page, blocks: [{ id: "old", title: "旧版", kind: "core", markdown: "旧模型解释", sourceAnchorIds: [], atomIds: [] }] } as PageLesson;
    const source = buildGenerationSourceText(withDraft);
    expect(source).not.toContain("旧模型解释");
    expect(preparePageForGeneration(withDraft)).not.toBe(withDraft);
  });

  it("labels a published explanation as reference only when text extraction is empty", () => {
    const old = { ...page, anchors: [], quality: { ...page.quality, publishable: true }, blocks: [{ id: "old", title: "旧版", kind: "core", markdown: "旧版解释", sourceAnchorIds: [], atomIds: [] }] } as PageLesson;
    expect(buildGenerationSourceText(old)).toContain("旧版讲解（供重写参考，不代表原图文字）");
    expect(buildGenerationSourceText(old)).toContain("旧版解释");
  });
});
