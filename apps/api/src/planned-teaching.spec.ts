import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageLesson } from "@course-os/contracts";
import { buildTeachingBlueprint } from "./teaching-blueprint.js";
import { previousLessonContext, validateTeachingPlan, teachingSectionMemory, type TeachingPlan } from "./teaching-plan.js";
import { writePlannedLesson } from "./planned-teaching.js";
import { HttpProviderTeachingClient, ModelRouterGenerationError, type ModelRouterInput } from "./model-router.js";

const quote = "先确定实际需要处理的对象，再观察处理前后的变化，这样才能把操作与结果对应起来";
const usage = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 200, apiEquivalentUsd: 0.001, durationMs: 10 };
const opening = { chapterBridgeMarkdown: "前页已经说明输入是开始处理时掌握的信息\n\n本页继续说明怎样从输入得到可以核对的结果", priorKnowledge: ["输入：它是处理开始前已经具备的信息；它为当前操作提供具体对象；规则读取这些信息后才决定结果；开始计算前需要先确认输入；输入与处理结束后的输出不同"], learningObjectives: ["给定输入以后，能够按顺序说明它怎样变成结果"] };
const explanation = { fullExplanationMarkdown: `### 从具体对象开始\n\n${quote}\n\n处理之前先保留输入的数值和条件，随后只执行材料允许的操作，再把得到的结果与目标比较\n\n### 核对结果\n\n如果输入条件发生变化，应当重新计算对应结果，而不能把之前得到的结论直接用在新的对象上，比较时也要保持其他条件相同`, coverageEvidence: [{ atomId: "a", coveredFields: ["observation"], explanation: quote }] };
const closing = { mainContentMarkdown: "- 输入提供具体对象，规则决定允许的变化\n- 结果需要在相同条件下与原目标进行比较", misconceptions: ["错误理解：输入变化后可以保留原结果\n\n错因：忽略了结果依赖输入\n\n正确判断：应当重新计算\n\n核对方法：逐项检查输入条件"], questions: [0, 1, 2, 3].map(index => ({ kind: index < 2 ? "comprehension" : "multiple_choice", prompt: `第 ${index + 1} 个练习应当怎样核对输入条件`, options: index < 2 ? [] : ["核对输入", "只看输出", "改变规则", "删除条件"], expectedAnswer: "核对输入", explanation: "因为结果依赖输入，必须先确认输入条件相同，再按照规则计算和比较结果" })) };

function fixture(title = "概念") {
  const page = { id: "p", pageNumber: 2, title, imageUrl: "", anchors: [], blocks: [], atoms: [{ id: "a", kind: "text_region", label: title, observation: "输入经过规则处理" }], coverageRequirements: [{ id: "r", atomId: "a", requiredFields: ["observation"], risk: "high" }], coverageClaims: [], quality: { issues: [], highRiskCoverage: 0, generalCoverage: 0, mathValid: true, publishable: false } } as PageLesson;
  const plan: TeachingPlan = { problem: `解释${title}`, knownStartingPoint: "输入与输出", scopeBoundary: "只解释当前材料给出的操作", facts: [{ id: "f", atomId: "a", observation: "输入经过规则处理", qualification: "保持条件" }], prerequisites: [{ name: "输入", explanation: "开始时已知的信息" }], steps: [{ id: "s", factIds: ["f"], dependsOn: [], explanation: `讲解${title}的对象与关系`, example: "", boundary: "输入条件不变" }], objectives: [{ id: "g", startingPoint: "已知输入", outcome: "能核对输出", stepIds: ["s"] }], questions: [0, 1, 2, 3].map(index => ({ objectiveId: "g", stepId: "s", kind: index < 2 ? "comprehension" : "multiple_choice", focus: `问题${index}` })) };
  const input: ModelRouterInput = { pageTitle: title, pageNumber: 2, sourceText: "本页来源", previousPageContext: "前页已经教过输入", sourceImageDataUrl: "data:image/png;base64,aA==", writingPolicySnapshotId: "writing-policy:test", language: "zh-CN", qualityMode: "quality", idempotencyKey: "test", maxCostUsd: 0.06, blueprint: buildTeachingBlueprint(page, "", "zh-CN", "quality", "writing-policy:test", true) };
  return { page, input, plan };
}

describe("planned teaching", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("uses generated previous teaching without OCR or images", () => {
    const { page } = fixture();
    expect(previousLessonContext(page)).toBeUndefined();
    page.anchors = [{ id: "ocr", pageId: page.id, kind: "text", label: "ocr", text: "OCR_MUST_NOT_BECOME_PRIOR_KNOWLEDGE" }];
    page.lessonSections = [{ id: "full", kind: "full_explanation", title: "完整讲解", markdown: "前页实际教授的内容", sourceAnchorIds: [], atomIds: [] }];
    const context = previousLessonContext(page)!;
    expect(context).toContain("前页实际教授的内容");
    expect(context).not.toContain("OCR_MUST");
    expect(context).not.toContain("imageUrl");
  });
  it("rejects missing sources, cycles and untested objectives while allowing application of an earlier fact", () => {
    const { input, plan } = fixture();
    expect(validateTeachingPlan(plan, input.blueprint!)).toEqual([]);
    plan.steps.push({ ...plan.steps[0]!, id: "other", dependsOn: ["other"] });
    plan.objectives.push({ id: "uncovered", startingPoint: "已知", outcome: "目标", stepIds: ["missing"] });
    plan.facts[0]!.atomId = "not-source";
    const issues = validateTeachingPlan(plan, input.blueprint!);
    expect(issues).not.toContain("PLAN_FACT_TAUGHT_TWICE:f");
    expect(issues).toContain("PLAN_FORWARD_DEPENDENCY:other");
    expect(issues).toContain("PLAN_OBJECTIVE_UNTESTED:uncovered");
    expect(issues).toContain("PLAN_SOURCE_UNASSIGNED:a");
  });
  it.each(["公式与运算", "表格对比", "流程与代码"])("passes real preceding output through four phases for %s", async title => {
    const { input, plan } = fixture(title);
    const calls: any[] = [];
    const outputs = [plan, opening, explanation, closing];
    const result = await writePlannedLesson(input, async request => {
      calls.push(request);
      return { content: outputs[calls.length - 1], provider: "deepseek", model: "model", usage };
    });
    expect(calls.map(call => call.phase)).toEqual(["plan", "opening", "explanation", "consolidation"]);
    expect(calls.filter(call => call.image)).toHaveLength(1);
    expect(JSON.parse(calls[2].prompt).precedingSections.alreadyIntroduced).toEqual(opening.priorKnowledge);
    expect(JSON.parse(calls[3].prompt).precedingSections.explanation).toBe(explanation.fullExplanationMarkdown);
    expect(result.content.questions).toHaveLength(4);
    expect(result.trace.plan.problem).toBe(`解释${title}`);
  });
  it("allows one local repair without regenerating preceding sections", async () => {
    const { input, plan } = fixture();
    const phases: string[] = [];
    const outputs = [plan, opening, { ...explanation, coverageEvidence: [] }, explanation, closing];
    await writePlannedLesson(input, async request => {
      phases.push(request.phase);
      return { content: outputs[phases.length - 1], provider: "deepseek", model: "model", usage };
    });
    expect(phases).toEqual(["plan", "opening", "explanation", "explanation_repair", "consolidation"]);
  });
  it("repairs an unassigned plan fact before writing, within the same single repair budget", async () => {
    const { input, plan } = fixture();
    const broken = structuredClone(plan);
    broken.steps[0]!.factIds = [];
    const phases: string[] = [];
    const outputs = [broken, plan, opening, explanation, closing];
    await writePlannedLesson(input, async request => {
      phases.push(request.phase);
      return { content: outputs[phases.length - 1], provider: "deepseek", model: "model", usage };
    });
    expect(phases).toEqual(["plan", "plan_repair", "opening", "explanation", "consolidation"]);
  });
  it("uses one provider and bills all four actual calls without audit requests", async () => {
    const { input, plan } = fixture();
    const outputs = [plan, opening, explanation, closing];
    const fetcher = vi.fn(async () => Response.json({ model: "deepseek-v4-flash", output_text: JSON.stringify(outputs.shift()), usage: { input_tokens: 100, output_tokens: 200, cost: 0.001 } }));
    vi.stubGlobal("fetch", fetcher);
    const result = await new HttpProviderTeachingClient({ providerId: "opencode-go", model: "deepseek-v4-flash", baseUrl: "https://test.invalid", apiKey: "test", protocol: "responses" }).generateTeachingPackage(input);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(result.usage.apiEquivalentUsd).toBeCloseTo(0.004);
    expect(result.teachingTrace?.phases).toHaveLength(4);
  });
  it("preserves charges and stage if a later provider request fails", async () => {
    const { input, plan } = fixture();
    let count = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ++count === 1
      ? Response.json({ model: "deepseek-v4-flash", output_text: JSON.stringify(plan), usage: { input_tokens: 100, output_tokens: 200, cost: 0.001 } })
      : Response.json({ error: { message: "failure" }, usage: { cost: 0 } }, { status: 503 })));
    try {
      await new HttpProviderTeachingClient({ providerId: "opencode-go", model: "deepseek-v4-flash", baseUrl: "https://test.invalid", apiKey: "test", protocol: "responses" }).generateTeachingPackage(input);
      expect.fail("must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelRouterGenerationError);
      expect((error as ModelRouterGenerationError).usage.apiEquivalentUsd).toBeCloseTo(0.001);
      expect((error as ModelRouterGenerationError).responseShape).toBe("opening");
    }
  });
});
