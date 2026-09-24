import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRouterInput, TeachingPackage } from "./model-router.js";
import { policyExplanationFramework, policyFormatRules, policyFormulaExplanation, policySkill, teachingPackageSchema } from "./generation-harness.js";
import {
  normalizePlannedOpening,
  normalizePlannedQuestionPunctuation,
  normalizePlannedSourceIntroductions,
  plannedContentIssues,
  plannedFormatIssues,
  plannedInstructions,
  planningPrompt,
  projectPlannedOutputToSchema,
  writePlannedLesson
} from "./planned-teaching.js";

const explanation = [
  "## 从输入开始",
  "",
  "输入是处理开始时已经具备的信息，它决定规则作用于什么对象。先保持输入中的数值、变量和条件，再按照本页说明执行相应操作，得到的结果才可以与预期目标比较。",
  "",
  "## 检查处理结果",
  "",
  "若任一输入条件改变，就要重新执行相应步骤。只有在输入、规则和比较条件保持一致时，前后结果才具有可比性。核对时逐项检查条件与操作，发现差异后再定位输出变化的来源。"
].join("\n");

function teachingPackage(): TeachingPackage {
  return {
    chapterBridgeMarkdown: "",
    learningObjectives: ["给定输入以后，能够按顺序说明它怎样变成结果"],
    mainContentMarkdown: "- 输入确定处理对象与初始条件\n- 输出记录规则执行后的结果",
    priorKnowledge: ["输入（Input）：处理开始时已经具备的信息，它决定规则作用于什么对象"],
    fullExplanationMarkdown: explanation,
    misconceptions: ["**错误理解：** 输入变化后可以保留原结果\n\n**错因：** 忽略了结果依赖输入\n\n**正确判断：** 应当重新计算\n\n**核对方法：** 逐项检查输入条件"],
    coverageEvidence: [],
    questions: [
      { kind: "comprehension", prompt: "输入条件改变时，为什么要重新核对输出？", options: [], expectedAnswer: "因为输出取决于输入条件，条件改变后需要重新计算", explanation: "重新核对可以确认变化是否影响处理结果" },
      { kind: "comprehension", prompt: "怎样确认两个结果可以比较？", options: [], expectedAnswer: "保持输入、规则和比较条件一致", explanation: "相同条件下的结果才可以直接比较" },
      { kind: "multiple_choice", prompt: "发现输入条件改变后应当怎样做？", options: ["重新计算结果", "沿用旧结果", "删除输入条件", "忽略处理规则"], expectedAnswer: "重新计算结果", explanation: "结果依赖输入条件，因此改变输入后应重新执行规则" },
      { kind: "multiple_choice", prompt: "比较处理前后的结果时应先确认什么？", options: ["输入条件相同", "页面颜色相同", "标题长度相同", "文字位置相同"], expectedAnswer: "输入条件相同", explanation: "先确认条件一致，才能判断结果变化来自哪里" }
    ]
  };
}

function input(): ModelRouterInput {
  return {
    pageTitle: "输入与输出",
    pageNumber: 2,
    sourceText: "输入经过规则处理后得到输出",
    writingPolicySnapshotId: "writing-policy:test",
    language: "zh-CN",
    qualityMode: "balanced",
    idempotencyKey: "planned-teaching-test"
  };
}

describe("planned teaching core writer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("makes exactly one freeform plan call and one full TeachingPackage call", async () => {
    const calls: Array<Parameters<Parameters<typeof writePlannedLesson>[1]>[0]> = [];
    const content = teachingPackage();
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request);
      if (request.phase === "plan") return "先解释输入，再说明规则和结果";
      return { content, provider: "test-provider", model: "test-model" };
    });

    expect(calls.map(request => request.phase)).toEqual(["plan", "teaching"]);
    expect(calls[0]?.schema).toBeUndefined();
    expect(calls[0]?.instructions).toContain("不输出 JSON");
    expect(calls[1]?.schema).toBe(teachingPackageSchema);
    expect(calls[1]?.instructions).toContain("chapterBridgeMarkdown 必须是空字符串");
    expect(calls[1]?.prompt).toContain("仅用于安排讲解顺序，不是事实来源");
    expect(result.trace).toMatchObject({
      plan: "先解释输入，再说明规则和结果",
      phases: [{ phase: "plan" }, { phase: "teaching", provider: "test-provider", model: "test-model" }]
    });
    expect(result.trace.coreFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.content.coverageEvidence).toEqual([]);
    expect(result.content.chapterBridgeMarkdown).toBe("");
    expect(result.trace.formatWarnings).toBeUndefined();
  });

  it("uses a supplied freeform plan without calling the plan model", async () => {
    const supplied = "先说明对象，再讲解操作顺序";
    const calls: string[] = [];
    const result = await writePlannedLesson({ ...input(), teachingPlan: supplied } as ModelRouterInput, async request => {
      calls.push(request.phase);
      return teachingPackage();
    });

    expect(calls).toEqual(["teaching"]);
    expect(result.trace.plan).toBe(supplied);
    expect(result.content.chapterBridgeMarkdown).toBe("");
  });

  it("uses one focused repair for a machine-shape error", async () => {
    const calls: string[] = [];
    const incomplete: Record<string, unknown> = { ...teachingPackage() };
    delete incomplete.mainContentMarkdown;
    const complete = teachingPackage();
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      if (request.phase === "plan") return "讲解顺序";
      if (request.phase === "teaching") return incomplete;
      expect(request.schema).toBe(teachingPackageSchema);
      expect(request.prompt).toContain("result.mainContentMarkdown:required");
      return complete;
    });

    expect(calls).toEqual(["plan", "teaching", "format_repair"]);
    expect(result.content.mainContentMarkdown).toBe(complete.mainContentMarkdown);
    expect(result.trace.formatWarnings).toBeUndefined();
  });

  it("tries at most one format repair and accepts valid output with remaining format warnings", async () => {
    const calls: string[] = [];
    const formatted = teachingPackage();
    formatted.priorKnowledge = ["输入：处理开始时已经具备的信息"];
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      if (request.phase === "plan") return "先解释输入";
      return formatted;
    });

    expect(calls).toEqual(["plan", "teaching", "format_repair"]);
    expect(result.content.priorKnowledge).toEqual(formatted.priorKnowledge);
    expect(result.trace.formatWarnings?.[0]?.phase).toBe("teaching");
    expect(result.trace.formatWarnings?.[0]?.issues).toContain("TEACHING_PRESENTATION:priorKnowledge:TERM_PAIR_MISSING");
  });

  it("keeps plannedContentIssues limited to machine shape and accepts empty bridge and coverage", () => {
    const content = teachingPackage();
    expect(plannedContentIssues(content, input())).toEqual([]);

    const missingField: Record<string, unknown> = { ...content };
    delete missingField.questions;
    expect(plannedContentIssues(missingField, input())).toContain("result.questions:required");

    expect(plannedContentIssues({
      ...content,
      chapterBridgeMarkdown: "",
      coverageEvidence: [],
      fullExplanationMarkdown: "简短讲解"
    }, input())).toEqual([]);
  });

  it("returns a usable page with a short explanation and no generated questions", async () => {
    const calls: string[] = [];
    const partial: Record<string, unknown> = {
      ...teachingPackage(),
      fullExplanationMarkdown: "简短讲解"
    };
    delete partial.questions;
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      if (request.phase === "plan") return "先解释对象";
      return partial;
    });

    expect(calls).toEqual(["plan", "teaching"]);
    expect(result.content.questions).toEqual([]);
    expect(result.content.fullExplanationMarkdown).toBe("简短讲解");
    expect(result.trace.qualityWarnings?.[0]?.issues).toEqual([
      "TEACHING_QUALITY:EXPLANATION_SHORT",
      "TEACHING_QUALITY:QUESTION_COUNT:0"
    ]);
  });

  it("keeps deterministic typography and provider-shape normalizers", () => {
    const opening = normalizePlannedOpening({
      chapterBridgeMarkdown: "",
      priorKnowledge: ["输入（input）：已经知道的信息。"],
      learningObjectives: ["理解输入（input）如何得到结果。"]
    });
    expect(opening.chapterBridgeMarkdown).toBe("");
    expect(opening.priorKnowledge?.[0]).toContain("输入（Input）：");
    expect(opening.learningObjectives?.[0]).toContain("输入（Input）");

    const source = normalizePlannedSourceIntroductions({
      fullExplanationMarkdown: "原文：\n> A quoted source\n\n工艺节点（tech node）决定输出。"
    });
    expect(source.fullExplanationMarkdown).toContain("课件原文如下：");
    expect(source.fullExplanationMarkdown).toContain("工艺节点（Tech Node）");
    const question = normalizePlannedQuestionPunctuation({
      questions: [{ kind: "comprehension", prompt: "应该怎样做。", options: [], expectedAnswer: "重新计算。", explanation: "结果取决于输入。" }]
    });
    expect(question.questions?.[0]?.expectedAnswer).toBe("重新计算");

    const schema = { type: "object", properties: {
      questions: { type: "array", items: { type: "object", properties: {
        kind: { type: "string", enum: ["comprehension", "multiple_choice"] }, prompt: { type: "string" }
      }, required: ["kind", "prompt"], additionalProperties: false } }
    }, required: ["questions"], additionalProperties: false };
    expect(projectPlannedOutputToSchema({ questions: [
      { kind: "understanding", prompt: "先说明原因" },
      { type: "choice", prompt: "选择正确说法" }
    ] }, schema)).toEqual({ questions: [
      { kind: "comprehension", prompt: "先说明原因" },
      { kind: "multiple_choice", prompt: "选择正确说法" }
    ] });
  });

  it("retains formatting findings as warnings instead of content gates", () => {
    const malformed = { priorKnowledge: ["输入：缺少可核验的英文名称"] } as Partial<TeachingPackage>;
    expect(plannedFormatIssues(malformed)).toContain("TEACHING_PRESENTATION:priorKnowledge:TERM_PAIR_MISSING");
    const instructions = plannedInstructions(["fullExplanationMarkdown", "coverageEvidence"]);
    expect(instructions).toContain("一次写出所有主体栏目");
    expect(instructions).toContain("FMT-001");
    for (const policy of [policySkill, policyFormatRules, policyExplanationFramework, policyFormulaExplanation]) {
      expect(instructions).toContain(policy.trim());
    }
    expect(planningPrompt).toContain("不输出 JSON");
  });
});
