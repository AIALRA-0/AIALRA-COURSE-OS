import { afterEach, describe, expect, it, vi } from "vitest";
import { validateMarkdownMath } from "@course-os/quality";
import type { PageLesson } from "@course-os/contracts";
import { buildTeachingBlueprint } from "./teaching-blueprint.js";
import { assignUnplacedPlanFacts, plannedCoverageIssues, previousLessonContext, validateTeachingPlan, teachingSectionMemory, type TeachingPlan } from "./teaching-plan.js";
import { writePlannedLesson, plannedFormatIssues, plannedInstructions } from "./planned-teaching.js";
import { policySkill, policyFormatRules, policyExplanationFramework, policyFormulaExplanation } from "./generation-harness.js";
import { applyGenerationRepair, generationRepairTickets } from "./generation-repair.js";
import { HttpProviderTeachingClient, ModelRouterGenerationError, type ModelRouterInput, type TeachingPackage } from "./model-router.js";
import { applyTeachingPackage } from "./app.js";

const quote = "先确定实际需要处理的对象，再观察处理前后的变化，这样才能把操作与结果对应起来";
const usage = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 200, apiEquivalentUsd: 0.001, durationMs: 10 };
const opening = { chapterBridgeMarkdown: "前页已经说明输入是开始处理时掌握的信息\n\n本页继续说明怎样从输入得到可以核对的结果", priorKnowledge: ["输入：它是处理开始前已经具备的信息；它为当前操作提供具体对象；规则读取这些信息后才决定结果；开始计算前需要先确认输入；输入与处理结束后的输出不同"], learningObjectives: ["给定输入以后，能够按顺序说明它怎样变成结果"] };
const explanation = { fullExplanationMarkdown: `### 从具体对象开始\n\n${quote}\n\n处理之前先保留输入的数值和条件，随后只执行材料允许的操作，再把得到的结果与目标比较\n\n### 核对结果\n\n如果输入条件发生变化，应当重新计算对应结果，而不能把之前得到的结论直接用在新的对象上，比较时也要保持其他条件相同`, coverageEvidence: [{ atomId: "a", coveredFields: ["observation"], explanation: quote }] };
const closing = { mainContentMarkdown: "- 输入提供具体对象，规则决定允许的变化\n- 结果需要在相同条件下与原目标进行比较", misconceptions: ["错误理解：输入变化后可以保留原结果\n\n错因：忽略了结果依赖输入\n\n正确判断：应当重新计算\n\n核对方法：逐项检查输入条件"], questions: [0, 1, 2, 3].map(index => ({ kind: index < 2 ? "comprehension" : "multiple_choice", prompt: `第 ${index + 1} 个练习应当怎样核对输入条件`, options: index < 2 ? [] : ["核对输入", "只看输出", "改变规则", "删除条件"], expectedAnswer: "核对输入", explanation: "因为结果依赖输入，必须先确认输入条件相同，再按照规则计算和比较结果" })) };

it("supplies every byte of the approved writing skill to each Chinese generation phase", () => {
  const instructions = plannedInstructions(["priorKnowledge"], "zh-CN");
  for (const fullFile of [policySkill, policyFormatRules, policyExplanationFramework, policyFormulaExplanation]) {
    expect(instructions).toContain(fullFile.trim());
  }
  expect(plannedInstructions(["priorKnowledge"], "en")).not.toContain(policyFormatRules.trim());
});

it("routes local typography findings to the field that can be repaired", () => {
  const issues = plannedFormatIssues({ priorKnowledge: ["期望值（expected value）：用概率加权说明结果。"] });
  expect(issues).toContain("TEACHING_PRESENTATION:priorKnowledge:ENGLISH_NAME_CASE");
  expect(issues).toContain("TEACHING_FORMAT:priorKnowledge:WRITING_CHINESE_FULL_STOP_FORBIDDEN");
  expect(generationRepairTickets("opening", { priorKnowledge: ["期望值（expected value）：用概率加权说明结果。"] }, issues)
    .map(ticket => ticket.field)).toEqual(["priorKnowledge"]);
});

function fixture(title = "概念") {
  const page = { id: "p", pageNumber: 2, title, imageUrl: "", anchors: [], blocks: [], atoms: [{ id: "a", kind: "text_region", label: title, observation: "输入经过规则处理" }], coverageRequirements: [{ id: "r", atomId: "a", requiredFields: ["observation"], risk: "high" }], coverageClaims: [], quality: { issues: [], highRiskCoverage: 0, generalCoverage: 0, mathValid: true, publishable: false } } as PageLesson;
  const plan: TeachingPlan = { problem: `解释${title}`, knownStartingPoint: "输入与输出", scopeBoundary: "只解释当前材料给出的操作", facts: [{ id: "f", atomId: "a", observation: "输入经过规则处理", qualification: "保持条件" }], prerequisites: [{ name: "输入", explanation: "开始时已知的信息" }], steps: [{ id: "s", factIds: ["f"], dependsOn: [], explanation: `讲解${title}的对象与关系`, example: "", boundary: "输入条件不变" }], objectives: [{ id: "g", startingPoint: "已知输入", outcome: "能核对输出", stepIds: ["s"] }], questions: [0, 1, 2, 3].map(index => ({ objectiveId: "g", stepId: "s", kind: index < 2 ? "comprehension" : "multiple_choice", focus: `问题${index}` })) };
  const input: ModelRouterInput = { pageTitle: title, pageNumber: 2, sourceText: "本页来源", previousPageContext: "前页已经教过输入", sourceImageDataUrl: "data:image/png;base64,aA==", writingPolicySnapshotId: "writing-policy:test", language: "zh-CN", qualityMode: "quality", idempotencyKey: "test", maxCostUsd: 0.06, blueprint: buildTeachingBlueprint(page, "", "zh-CN", "quality", "writing-policy:test", true) };
  return { page, input, plan };
}

describe("planned teaching", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("also supplies the full skill at planning time", async () => {
    const { input, plan } = fixture();
    await writePlannedLesson(input, async request => {
      if (request.phase === "plan") for (const fullFile of [policySkill, policyFormatRules, policyExplanationFramework, policyFormulaExplanation]) {
        expect(request.instructions).toContain(fullFile.trim());
      }
      return { content: request.phase === "plan" ? plan : request.phase === "opening" ? opening
        : request.phase === "explanation" ? explanation : closing, provider: "deepseek", model: "flash", usage };
    });
  });
  it("places a source fact omitted from step assignments without changing its text", () => {
    const { input, plan } = fixture();
    plan.facts.push({ id: "f11", atomId: "a", observation: "另一个来源事实", qualification: "保留原条件" });
    expect(validateTeachingPlan(plan, input.blueprint!)).toContain("PLAN_FACT_UNASSIGNED:f11");
    const placed = assignUnplacedPlanFacts(plan);
    expect(placed.steps[0]?.factIds).toEqual(["f", "f11"]);
    expect(placed.facts).toEqual(plan.facts);
    expect(validateTeachingPlan(placed, input.blueprint!)).toEqual([]);
  });
  it("routes the four failed sample signatures to exact fields without a page rewrite", () => {
    for (const issue of [
      "PLAN_EVIDENCE_QUOTE_MISSING:source-text-region:8",
      "PLAN_FACT_EVIDENCE_MISSING:source-text-region:1",
      "PLAN_EVIDENCE_QUOTE_MISSING:source-text-region:16"
    ]) {
      const tickets = generationRepairTickets("explanation", explanation, [issue]);
      expect(tickets.map(ticket => ticket.field)).toEqual(["coverageEvidence"]);
    }
    expect(generationRepairTickets("consolidation", { mainContentMarkdown: "错误公式 \\(x" },
      ["MATH_UNCLOSED_INLINE_DELIMITER"]).map(ticket => ticket.field)).toEqual(["mainContentMarkdown"]);
    expect(generationRepairTickets("explanation", explanation, ["UNCLASSIFIED_ISSUE"])).toEqual([]);
  });
  it("rejects stale, unchanged and out-of-scope repair patches", () => {
    const ticket = generationRepairTickets("explanation", explanation, ["PLAN_EVIDENCE_QUOTE_MISSING:a"])[0]!;
    expect(() => applyGenerationRepair({ ...explanation, coverageEvidence: [] }, ticket, { coverageEvidence: explanation.coverageEvidence })).toThrow("GENERATION_REPAIR_STALE");
    expect(() => applyGenerationRepair(explanation, ticket, { coverageEvidence: explanation.coverageEvidence })).toThrow("GENERATION_REPAIR_NO_CHANGE");
    expect(() => applyGenerationRepair(explanation, ticket, { coverageEvidence: [], fullExplanationMarkdown: "changed" })).toThrow("GENERATION_REPAIR_SCOPE_INVALID");
    const preserved = { ...explanation, coverageEvidence: [...explanation.coverageEvidence, { atomId: "b", coveredFields: ["observation"], explanation: quote }] };
    const scoped = generationRepairTickets("explanation", preserved, ["PLAN_EVIDENCE_QUOTE_MISSING:a"])[0]!;
    expect(() => applyGenerationRepair(preserved, scoped, { coverageEvidence: [] })).toThrow("GENERATION_REPAIR_SCOPE_INVALID");
  });
  it("applies only the ticketed evidence when a model also rewrites protected claims", () => {
    const original = { ...explanation, coverageEvidence: [
      { atomId: "a", coveredFields: ["observation"], explanation: "旧的错误引文" },
      { atomId: "b", coveredFields: ["observation"], explanation: "保持不变的引文" }
    ] };
    const ticket = generationRepairTickets("explanation", original, ["PLAN_EVIDENCE_QUOTE_MISSING:a"], ["a", "b"])[0]!;
    const result = applyGenerationRepair(original, ticket, { coverageEvidence: [
      { atomId: "a", coveredFields: ["observation"], explanation: quote },
      { atomId: "b", coveredFields: ["observation"], explanation: "模型不应改动的引文" }
    ] });
    expect(result.coverageEvidence).toEqual([
      { atomId: "a", coveredFields: ["observation"], explanation: quote },
      original.coverageEvidence[1]
    ]);
  });
  it("creates a scoped repair ticket when a required field is absent", () => {
    const ticket = generationRepairTickets("opening", {}, ["result.learningObjectives:required"])[0]!;
    expect(ticket.field).toBe("learningObjectives");
    expect(applyGenerationRepair({}, ticket, { learningObjectives: opening.learningObjectives })).toEqual({ learningObjectives: opening.learningObjectives });
  });
  it("resumes a failed explanation from its private checkpoint and repairs only evidence", async () => {
    const { input, plan } = fixture();
    input.teachingFingerprint = "fixed-source-policy-harness";
    let checkpoint: NonNullable<ModelRouterInput["resumeTeaching"]> | undefined;
    input.onTeachingCheckpoint = async value => { checkpoint = structuredClone(value); };
    const calls: string[] = [];
    const bad = { ...explanation, coverageEvidence: [{ atomId: "a", coveredFields: ["observation"], explanation: "并未出现在讲解中的引文" }] };
    await expect(writePlannedLesson(input, async request => {
      calls.push(request.phase);
      if (request.phase === "explanation_repair") throw new Error("PROVIDER_TIMEOUT");
      return { content: request.phase === "plan" ? plan : request.phase === "opening" ? opening : bad,
        provider: "deepseek", model: "flash", usage };
    })).rejects.toThrow("PROVIDER_TIMEOUT");
    expect(checkpoint?.completedPhases).toEqual(["opening"]);
    expect(checkpoint?.pending?.phase).toBe("explanation");
    input.resumeTeaching = checkpoint;
    calls.length = 0;
    const result = await writePlannedLesson(input, async request => {
      calls.push(request.phase);
      return { content: request.phase === "explanation_repair" ? { coverageEvidence: explanation.coverageEvidence } : closing,
        provider: "deepseek", model: "flash", usage };
    });
    expect(calls).toEqual(["explanation_repair", "consolidation"]);
    expect(result.content.fullExplanationMarkdown).toBe(explanation.fullExplanationMarkdown);
    expect(checkpoint?.completedPhases).toEqual(["opening", "explanation", "consolidation"]);
  });
  it("retries a transient provider failure only for the current stage", async () => {
    const { input, plan } = fixture();
    const calls: string[] = [];
    const result = await writePlannedLesson(input, async request => {
      calls.push(request.phase);
      if (request.phase === "opening" && calls.filter(phase => phase === "opening").length === 1) throw new Error("MODEL_PROVIDER_FAILED:429");
      return { content: request.phase === "plan" ? plan : request.phase === "opening" ? opening
        : request.phase === "explanation" ? explanation : closing, provider: "deepseek", model: "flash", usage };
    });
    expect(calls).toEqual(["plan", "opening", "opening", "explanation", "consolidation"]);
    expect(result.content.fullExplanationMarkdown).toBe(explanation.fullExplanationMarkdown);
  });
  it("saves each accepted patch before a later repair call fails", async () => {
    const { input, plan } = fixture();
    input.teachingFingerprint = "two-repairs";
    const snapshots: NonNullable<ModelRouterInput["resumeTeaching"]>[] = [];
    input.onTeachingCheckpoint = async value => { snapshots.push(structuredClone(value)); };
    const bad = { ...closing, mainContentMarkdown: "错误公式 \\(x", questions: closing.questions.map((question, index) => index === 3 ? { ...question, expectedAnswer: "不存在的选项" } : question) };
    await expect(writePlannedLesson(input, async request => {
      if (request.phase === "consolidation_repair" && (request.schema.required as string[])[0] === "questions") throw new Error("PROVIDER_AUTH");
      return { content: request.phase === "plan" ? plan : request.phase === "opening" ? opening
        : request.phase === "explanation" ? explanation : request.phase === "consolidation" ? bad
          : { mainContentMarkdown: closing.mainContentMarkdown }, provider: "deepseek", model: "flash", usage };
    })).rejects.toThrow("PROVIDER_AUTH");
    const saved = snapshots.at(-1)!;
    expect(saved.pending?.content.mainContentMarkdown).toBe(closing.mainContentMarkdown);
    expect(saved.pending?.content.questions?.[3]?.expectedAnswer).toBe("不存在的选项");
  });
  it.each([
    { page: 4, phase: "explanation", issue: "PLAN_EVIDENCE_QUOTE_MISSING", bad: { ...explanation, coverageEvidence: [{ atomId: "a", coveredFields: ["observation"], explanation: "缺失的逐字引文" }] }, patch: { coverageEvidence: explanation.coverageEvidence } },
    { page: 7, phase: "consolidation", issue: "MATH_UNCLOSED_INLINE_DELIMITER", bad: { ...closing, mainContentMarkdown: "总结公式 \\(x" }, patch: { mainContentMarkdown: closing.mainContentMarkdown } },
    { page: 12, phase: "explanation", issue: "PLAN_FACT_EVIDENCE_MISSING", bad: { ...explanation, coverageEvidence: [] }, patch: { coverageEvidence: explanation.coverageEvidence } },
    { page: 16, phase: "explanation", issue: "PLAN_EVIDENCE_QUOTE_MISSING", bad: { ...explanation, coverageEvidence: [{ atomId: "a", coveredFields: ["observation"], explanation: "另一处缺失引文" }] }, patch: { coverageEvidence: explanation.coverageEvidence } }
  ])("closes page $page's recorded failure class by one field patch", async ({ page, phase, issue, bad, patch }) => {
    const { input, plan } = fixture();
    input.pageNumber = page;
    if (phase === "explanation") expect(plannedCoverageIssues(bad as TeachingPackage, input.blueprint!, plan).some(value => value.startsWith(issue))).toBe(true);
    else expect(validateMarkdownMath((bad as typeof closing).mainContentMarkdown)).toContain(issue);
    const calls: string[] = [];
    const result = await writePlannedLesson(input, async request => {
      calls.push(request.phase);
      const content = request.phase === "plan" ? plan : request.phase === "opening" ? opening
        : request.phase === `${phase}_repair` ? patch
          : request.phase === phase ? bad : request.phase === "explanation" ? explanation : closing;
      return { content, provider: "deepseek", model: "flash", usage };
    });
    expect(calls).toEqual(["plan", "opening", "explanation", ...(phase === "explanation" ? ["explanation_repair", "consolidation"] : ["consolidation", "consolidation_repair"])]);
    expect(result.content).toMatchObject({ ...opening, ...explanation, ...closing });
  });
  it("keeps repair capacity for consolidation after explanation repair, matching page 7", async () => {
    const { input, plan } = fixture();
    const calls: string[] = [];
    const result = await writePlannedLesson(input, async request => {
      calls.push(request.phase);
      const content = request.phase === "plan" ? plan : request.phase === "opening" ? opening
        : request.phase === "explanation" ? { ...explanation, coverageEvidence: [] }
          : request.phase === "explanation_repair" ? { coverageEvidence: explanation.coverageEvidence }
            : request.phase === "consolidation" ? { ...closing, mainContentMarkdown: "总结公式 \\(x" }
              : { mainContentMarkdown: closing.mainContentMarkdown };
      return { content, provider: "deepseek", model: "flash", usage };
    });
    expect(calls).toEqual(["plan", "opening", "explanation", "explanation_repair", "consolidation", "consolidation_repair"]);
    expect(result.content.mainContentMarkdown).toBe(closing.mainContentMarkdown);
  });
  it("keeps repair capacity for explanation after opening repair, matching page 12", async () => {
    const { input, plan } = fixture();
    const calls: string[] = [];
    const result = await writePlannedLesson(input, async request => {
      calls.push(request.phase);
      const content = request.phase === "plan" ? plan : request.phase === "opening" ? { ...opening, learningObjectives: [] }
        : request.phase === "opening_repair" ? { learningObjectives: opening.learningObjectives }
          : request.phase === "explanation" ? { ...explanation, coverageEvidence: [] }
            : request.phase === "explanation_repair" ? { coverageEvidence: explanation.coverageEvidence } : closing;
      return { content, provider: "deepseek", model: "flash", usage };
    });
    expect(calls).toEqual(["plan", "opening", "opening_repair", "explanation", "explanation_repair", "consolidation"]);
    expect(result.content.coverageEvidence).toEqual(explanation.coverageEvidence);
  });
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
    const outputs = [plan, opening, { ...explanation, coverageEvidence: [] }, { coverageEvidence: explanation.coverageEvidence }, closing];
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
  it("bounds planned chat calls without unbounded reasoning", async () => {
    const { input, plan } = fixture();
    const outputs = [plan, opening, explanation, closing];
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toMatchObject({ thinking: { type: "disabled" } });
      return Response.json({ model: "deepseek-v4-flash", choices: [{ message: { content: JSON.stringify(outputs.shift()) } }], usage: { prompt_tokens: 100, completion_tokens: 200, cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetcher);
    await new HttpProviderTeachingClient({ providerId: "opencode-go", model: "deepseek-v4-flash", baseUrl: "https://test.invalid", apiKey: "test", protocol: "chat_completions" }).generateTeachingPackage(input);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("sends only the current section responsibilities with the versioned formatting contract", () => {
    const prompt = plannedInstructions(["fullExplanationMarkdown", "coverageEvidence"]);
    expect(prompt).toContain("fullExplanationMarkdown：");
    expect(prompt).not.toContain("priorKnowledge：");
    expect(prompt).toContain("# 中文教学正文格式");
    expect(prompt).toContain("FMT-001");
  });
  it("persists actual visual observations as coverage rather than teaching importer labels", () => {
    const { page, plan } = fixture();
    page.atoms[0] = { id: "a", kind: "image_region", label: "image", observation: "imported" };
    page.coverageRequirements = [];
    page.blocks = [{ id: "core", kind: "core", title: "正文", markdown: "来源", sourceAnchorIds: [], atomIds: ["a"] }];
    const result = applyTeachingPackage(page, { ...opening, ...explanation, ...closing } as any, true, "multimodal", { version: 1, plan, phases: [] });
    expect(result.coverageRequirements).toHaveLength(1);
    expect(result.coverageRequirements[0]?.requiredFields).toEqual(["observation"]);
    expect(result.coverageClaims[0]?.coveredFields).toEqual(["observation"]);
  });
  it("does not repeat a token-exhausted request as a JSON repair", async () => {
    const { input } = fixture();
    const fetcher = vi.fn(async () => Response.json({ model: "deepseek-v4-flash", choices: [{ finish_reason: "length", message: { content: "" } }], usage: { prompt_tokens: 100, completion_tokens: 10000 } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(new HttpProviderTeachingClient({ providerId: "opencode-go", model: "deepseek-v4-flash", baseUrl: "https://test.invalid", apiKey: "test", protocol: "chat_completions" }).generateTeachingPackage(input)).rejects.toThrow("MODEL_PROVIDER_OUTPUT_LIMIT");
    expect(fetcher).toHaveBeenCalledTimes(1);
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
  it("retries invalid JSON only once and retains the failed call in costs and the trace", async () => {
    const { input, plan } = fixture();
    const outputs = [JSON.stringify(plan), "not JSON", JSON.stringify(opening), JSON.stringify(explanation), JSON.stringify(closing)];
    const fetcher = vi.fn(async () => Response.json({ model: "deepseek-v4-flash", output_text: outputs.shift(), usage: { input_tokens: 100, output_tokens: 200, cost: 0.001 } }));
    vi.stubGlobal("fetch", fetcher);
    const result = await new HttpProviderTeachingClient({ providerId: "opencode-go", model: "deepseek-v4-flash", baseUrl: "https://test.invalid", apiKey: "test", protocol: "responses" }).generateTeachingPackage(input);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(result.usage.apiEquivalentUsd).toBeCloseTo(0.005);
    expect(result.teachingTrace?.phases.map(phase => phase.phase)).toEqual(["plan", "opening_invalid_json", "opening_json_repair", "explanation", "consolidation"]);
  });
});
