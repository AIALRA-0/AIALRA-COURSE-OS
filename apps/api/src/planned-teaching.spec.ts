import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMisconception, validateMarkdownMath } from "@course-os/quality";
import type { PageLesson } from "@course-os/contracts";
import { buildTeachingBlueprint } from "./teaching-blueprint.js";
import { alignPlanQuestionObjectives, assignUnplacedPlanFacts, bindExactCoverageLines, bindMissingPlanFactAtoms, completeTeachingPlanTransport, fillMissingPlanObjectiveText, plannedCoverageIssues, previousLessonContext, removeUnknownPlanFactReferences, teachingPlanSchema, validateTeachingPlan, teachingSectionMemory, type TeachingPlan } from "./teaching-plan.js";
import { planningPrompt, plannedWritingPrompt, writePlannedLesson, plannedFormatIssues, plannedInstructions, normalizePlannedCoverageFields, normalizePlannedOpening, normalizePlannedQuestionPunctuation, normalizePlannedSourceIntroductions, projectPlannedOutputToSchema } from "./planned-teaching.js";
import { policySkill, policyFormatRules, policyExplanationFramework, policyFormulaExplanation, semanticAuditPrompt } from "./generation-harness.js";
import { applyGenerationRepair, generationRepairTickets } from "./generation-repair.js";
import { HttpProviderTeachingClient, ModelRouterGenerationError, type ModelRouterInput, type TeachingPackage } from "./model-router.js";
import { applyTeachingPackage, stablePreviousPageContext } from "./app.js";

const quote = "先确定实际需要处理的对象，再观察处理前后的变化，这样才能把操作与结果对应起来";
const usage = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 200, apiEquivalentUsd: 0.001, durationMs: 10 };
const opening = { chapterBridgeMarkdown: "前页已经说明输入是开始处理时掌握的信息\n\n本页继续说明怎样从输入得到可以核对的结果", priorKnowledge: ["输入（Input）：它是处理开始前已经具备的信息；它为当前操作提供具体对象；规则读取这些信息后才决定结果；开始计算前需要先确认输入；输入与处理结束后的输出不同"], learningObjectives: ["给定输入以后，能够按顺序说明它怎样变成结果"] };
const bridge = { chapterBridgeMarkdown: opening.chapterBridgeMarkdown };
const explanation = { fullExplanationMarkdown: `### 从具体对象开始\n\n${quote}\n\n处理之前先保留输入的数值和条件，随后只执行材料允许的操作，再把得到的结果与目标比较\n\n### 核对结果\n\n如果输入条件发生变化，应当重新计算对应结果，而不能把之前得到的结论直接用在新的对象上，比较时也要保持其他条件相同`, coverageEvidence: [{ atomId: "a", coveredFields: ["observation"], explanation: quote }] };
const formatOnlyExplanation = { ...explanation, fullExplanationMarkdown: `### 从具体对象开始\n\n${quote}${"仍需核对输入条件并按规则检查输出结果".repeat(12)}\n\n### 核对结果\n\n如果输入条件发生变化，应当重新计算对应结果，而不能把之前得到的结论直接用在新的对象上` };
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
it("tells the repair Agent how to split combined bilingual names one to one", () => {
  const priorKnowledge = ["逻辑值与数字信号（Logic Value, Digital Signal）：说明两种相关对象"];
  const issues = plannedFormatIssues({ priorKnowledge });
  expect(issues.some(issue => issue.includes("BILINGUAL_TERM_SHAPE") && issue.includes("priorKnowledge"))).toBe(true);
  expect(generationRepairTickets("opening", { priorKnowledge }, issues)[0]?.instruction)
    .toContain("中文 A（English A）与中文 B（English B）");
});
it("keeps incomplete provider fields available for Schema-guided Agent repair", () => {
  const incomplete = { questions: [{ kind: "multiple_choice", options: ["正确项", null] }] } as unknown as Partial<TeachingPackage>;
  expect(() => normalizePlannedQuestionPunctuation(incomplete)).not.toThrow();
  expect(normalizePlannedQuestionPunctuation(incomplete).questions?.[0]).toMatchObject({ kind: "multiple_choice", options: ["正确项", null] });
  expect(() => normalizePlannedOpening({ priorKnowledge: [null], learningObjectives: [undefined] } as never)).not.toThrow();
});
it("targets the atom at an invalid coverage array index", () => {
  const candidate = { ...explanation, coverageEvidence: [
    explanation.coverageEvidence[0]!,
    { atomId: "b", coveredFields: ["observation"] }
  ] } as unknown as Partial<TeachingPackage>;
  const [ticket] = generationRepairTickets("explanation", candidate,
    ["result.coverageEvidence.1.explanation:required"], ["a", "b"]);
  expect(ticket).toMatchObject({ field: "coverageEvidence", atomIds: ["b"] });
  expect(applyGenerationRepair(candidate, ticket!, { coverageEvidence: [
    { atomId: "b", coveredFields: ["observation"], explanation: quote }
  ] }).coverageEvidence).toEqual([
    explanation.coverageEvidence[0],
    { atomId: "b", coveredFields: ["observation"], explanation: quote }
  ]);
});
it("keeps retry context frozen even when a previous page finishes later", () => {
  const checkpoint = { trace: { previousPageContext: "首次尝试使用的前页讲解" } } as Pick<import("./planned-teaching.js").PlannedCheckpoint, "trace">;
  expect(stablePreviousPageContext(checkpoint, "稍后才完成的新讲解")).toBe("首次尝试使用的前页讲解");
  expect(stablePreviousPageContext({ trace: {} } as typeof checkpoint, "稍后才出现的讲解")).toBeUndefined();
  expect(stablePreviousPageContext(undefined, "首次读取到的讲解")).toBe("首次读取到的讲解");
});
it.each([
  ["缺少英文名称", "布局质量指标：衡量布局结果的多个数值", true],
  ["名称已有配对", "布局质量指标（Layout Quality Metrics）：衡量布局结果的多个数值", false],
  ["官方大小写", "方法名称（eBay）：保留官方名称", false],
  ["带撇号的正式英文名称", "欧姆定律（Ohm's Law）：说明电压、电流和电阻的关系", false],
  ["带弯撇号的正式英文名称", "泊松分布（Poisson’s Distribution）：说明计数的概率分布", false],
  ["英文全称与缩写", "最差负时序裕量（Worst Negative Slack，WNS）：指最严重的时序违例", false],
  ["定义内遗漏不靠猜译补齐", "拥塞（Congestion）：它影响布局质量", false],
  ["来源标签不能冒充名称", "网表（Netlist）：记录模块之间的连接", false]
])("checks prerequisite name pairing: %s", (_name, prior, missing) => {
  const issues = plannedFormatIssues({ priorKnowledge: [prior] });
  expect(issues.includes("TEACHING_PRESENTATION:priorKnowledge:TERM_PAIR_MISSING")).toBe(missing);
});
it("requires four colon-labelled misconception paragraphs", () => {
  const malformed = "误以为全部指标都最小\n\n错因是忽略了反例\n\n正确判断：逐列比较\n\n核对方法：检查每一列";
  const issues = plannedFormatIssues({ misconceptions: [malformed] });
  expect(issues).toContain("TEACHING_PRESENTATION:misconceptions:ROLE_LABEL_MISSING");
  const plain = "错误理解：全部指标都最小\n\n错因：忽略反例\n\n正确判断：逐列比较\n\n核对方法：检查每列";
  expect(plannedFormatIssues({ misconceptions: [plain] })).toContain("TEACHING_PRESENTATION:misconceptions:ROLE_LABEL_MISSING");
  expect(plannedFormatIssues({ misconceptions: [formatMisconception(plain)] })).not.toContain("TEACHING_PRESENTATION:misconceptions:ROLE_LABEL_MISSING");
  expect(generationRepairTickets("consolidation", { misconceptions: [malformed] }, issues)[0]?.instruction)
    .toContain("错误理解：、错因：、正确判断：、核对方法：");
});
it("rebinds a long coverage claim to its own exact explained line", () => {
  const line = "- $K$ 是集合中芯片设计的数量；它决定外层平均要除以几";
  const original = { fullExplanationMarkdown: `## 平均目标\n\n${line}`, coverageEvidence: [
    { atomId: "a", coveredFields: ["observation"], explanation: `公式如下\n\n${line.slice(2)}\n\n继续解释` }
  ] };
  const result = bindExactCoverageLines(original);
  expect(result.coverageEvidence[0]?.explanation).toBe(line);
  expect(original.coverageEvidence[0]?.explanation).toContain("继续解释");
  expect(bindExactCoverageLines({ ...original, coverageEvidence: [{ ...original.coverageEvidence[0]!, explanation: "另一段完全无关的解释" }] })).toEqual(
    { ...original, coverageEvidence: [{ ...original.coverageEvidence[0]!, explanation: "另一段完全无关的解释" }] });
});
it("fills omitted coverage fields from the authoritative requirement package before validation", () => {
  const page = { id: "page-1", pageNumber: 1, title: "输入", blocks: [], atoms: [{ id: "a", kind: "text", text: quote, risk: "general" }],
    anchors: [], coverageRequirements: [{ atomId: "a", requiredFields: ["observation", "meaning"], risk: "general" }], coverageClaims: [],
    lessonSections: [], questionBank: [], quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable: true, issues: [] } } as unknown as PageLesson;
  const blueprint = buildTeachingBlueprint(page, quote, "zh-CN", "balanced", "writing-policy:test", true);
  const input: Partial<TeachingPackage> = { coverageEvidence: [{ atomId: "a", explanation: quote } as TeachingPackage["coverageEvidence"][number]] };
  const normalized = normalizePlannedCoverageFields(input, blueprint);
  expect(normalized.coverageEvidence?.[0]?.coveredFields).toEqual(["observation", "meaning"]);
  const existing = normalizePlannedCoverageFields({ coverageEvidence: [{ atomId: "a", explanation: quote, coveredFields: ["observation"] }] }, blueprint);
  expect(existing.coverageEvidence?.[0]?.coveredFields).toEqual(["observation"]);
  const empty = normalizePlannedCoverageFields({ coverageEvidence: [{ atomId: "a", explanation: quote, coveredFields: [] }] }, blueprint);
  expect(empty.coverageEvidence?.[0]?.coveredFields).toEqual(["observation", "meaning"]);
  expect(() => normalizePlannedCoverageFields({ coverageEvidence: [null, "invalid"] } as never, blueprint)).not.toThrow();
  expect(() => bindExactCoverageLines({ fullExplanationMarkdown: quote, coverageEvidence: [null, "invalid", { atomId: "a" }] } as never)).not.toThrow();
});
it("projects a provider string into a string array without coercing non-string items", () => {
  const schema = { type: "object", properties: { items: { type: "array", items: { type: "string" } } } };
  expect(projectPlannedOutputToSchema({ items: "- 第一项\n第二项\n* 第三项" }, schema)).toEqual({ items: ["第一项", "第二项", "第三项"] });
  expect(projectPlannedOutputToSchema({ items: ["保留", 7] }, schema)).toEqual({ items: ["保留", 7] });
});
it("wraps a plain provider string for a single-field phase object", () => {
  const schema = { type: "object", properties: { chapterBridgeMarkdown: { type: "string" } }, required: ["chapterBridgeMarkdown"], additionalProperties: false };
  expect(projectPlannedOutputToSchema("承接上一页以后进入当前问题", schema, "bridge"))
    .toEqual({ chapterBridgeMarkdown: "承接上一页以后进入当前问题" });
});
it("fills observation only for a known atom without a requirement and preserves unknown atoms", () => {
  const { input } = fixture();
  const blueprint = { ...input.blueprint!, requirementPackage: { ...input.blueprint!.requirementPackage, requirements: [] } };
  const normalized = normalizePlannedCoverageFields({ coverageEvidence: [
    { atomId: "a", explanation: quote } as unknown as TeachingPackage["coverageEvidence"][number],
    { atomId: "unknown", explanation: quote } as unknown as TeachingPackage["coverageEvidence"][number]
  ] }, blueprint);
  expect(normalized.coverageEvidence?.[0]?.coveredFields).toEqual(["observation"]);
  expect(normalized.coverageEvidence?.[1]).toEqual({ atomId: "unknown", explanation: quote });
});
it("normalizes all opening fields with the existing deterministic typography pass", () => {
  const normalized = normalizePlannedOpening({
    chapterBridgeMarkdown: "上一页说明输入。\n\n本页继续说明 output（output）。",
    priorKnowledge: ["输入（input）：处理开始前已经知道的信息。"],
    learningObjectives: ["理解输入（input）如何得到结果。"]
  });
  expect(normalized.chapterBridgeMarkdown).not.toContain("。");
  expect(normalized.priorKnowledge?.[0]).toContain("输入（Input）：");
  expect(normalized.learningObjectives?.[0]).toContain("输入（Input）");
  expect(plannedFormatIssues(normalized)).not.toContain("TEACHING_FORMAT:chapterBridgeMarkdown:WRITING_CHINESE_FULL_STOP_FORBIDDEN");
});
it("rebinds a citation after punctuation-only teaching repair", () => {
  const actual = "这一页要回答三个问题：它是什么；为什么需要它；怎样使用它";
  const content = bindExactCoverageLines({ fullExplanationMarkdown: actual, coverageEvidence: [
    { atomId: "a", coveredFields: ["observation"], explanation: "这一页要回答三个问题：它是什么，为什么需要它，以及怎样使用它" }
  ] });
  expect(content.coverageEvidence[0]?.explanation).toBe(actual);
});
it("rebinds an exact surviving excerpt after a scoped explanation repair", () => {
  const original = "$\\theta$：人工智能模型的可学习参数（learnable parameters of the AI model），也就是训练过程中会被不断调整的那些数值，模型对同一块芯片给出什么布局，由这组参数决定";
  const repaired = "- $\\theta$：人工智能模型的可学习参数，也就是训练过程中会被不断调整的那些数值，模型对同一块芯片给出什么布局，由这组参数决定；原文没有指定模型类别";
  const result = bindExactCoverageLines({ fullExplanationMarkdown: repaired, coverageEvidence: [
    { atomId: "a", coveredFields: ["observation"], explanation: original }
  ] });
  expect(result.coverageEvidence[0]!.explanation.length).toBeGreaterThanOrEqual(24);
  expect(repaired).toContain(result.coverageEvidence[0]!.explanation);
  expect(result.coverageEvidence[0]!.explanation).toContain("训练过程中会被不断调整");
});
it("binds a shortened source definition to the actual explained bullet", () => {
  const actual = "- $\\theta$：人工智能模型的可学习参数";
  const content = bindExactCoverageLines({ fullExplanationMarkdown: actual, coverageEvidence: [
    { atomId: "a", coveredFields: ["observation"], explanation: "$\\theta$：人工智能模型的可学习参数（learnable parameters of the AI model）" }
  ] });
  expect(content.coverageEvidence[0]?.explanation).toBe(actual);
});
it("turns a bare source quote label into a sentence without losing the quote", () => {
  const value = "原文：\n> A quoted source\n\n页面对这个目标的说明是：\n> More evidence";
  const normalized = normalizePlannedSourceIntroductions({ fullExplanationMarkdown: value });
  expect(normalized.fullExplanationMarkdown).toContain("课件原文如下：\n> A quoted source");
  expect(plannedFormatIssues(normalized)).not.toContain("TEACHING_FORMAT:fullExplanationMarkdown:WRITING_COLON_PSEUDO_HEADING");
});
it("normalizes Chinese full stops in planned explanation before its coverage is checked", () => {
  const normalized = normalizePlannedSourceIntroductions({ fullExplanationMarkdown: "先看网表。再看编码器如何读取它。最后对照输出" });
  expect(normalized.fullExplanationMarkdown).not.toContain("。");
  expect(plannedFormatIssues(normalized)).not.toContain("TEACHING_FORMAT:fullExplanationMarkdown:WRITING_CHINESE_FULL_STOP_FORBIDDEN");
});
it("applies bilingual term capitalization during the same planning phase as validation", () => {
  const normalized = normalizePlannedSourceIntroductions({ fullExplanationMarkdown: "网表元数据包含工艺节点（tech node）与画布尺寸（canvas size）" });
  expect(normalized.fullExplanationMarkdown).toContain("工艺节点（Tech Node）与画布尺寸（Canvas Size）");
  expect(plannedFormatIssues(normalized)).not.toContain("TEACHING_PRESENTATION:fullExplanationMarkdown:ENGLISH_NAME_CASE");
});
it("normalizes question punctuation without changing answer-option equality", () => {
  const content = normalizePlannedQuestionPunctuation({ questions: [{ kind: "multiple_choice" as const,
    prompt: "应该选哪一个。", options: ["正确选项。", "错误选项。", "另一选项。", "最后一项。"],
    expectedAnswer: "正确选项。", explanation: "因为这个答案符合条件。" }] });
  expect(content.questions?.[0]?.expectedAnswer).toBe("正确选项");
  expect(content.questions?.[0]?.options).toContain(content.questions?.[0]?.expectedAnswer);
  expect(plannedFormatIssues(content)).not.toContain("TEACHING_FORMAT:questions:WRITING_CHINESE_FULL_STOP_FORBIDDEN");
});
it("splits a long comprehension answer into readable paragraphs before checking it", () => {
  const sentence = "状态说明智能体当前能看到什么，并列出网表、节点、边和画布的必要信息；";
  const content = normalizePlannedQuestionPunctuation({ questions: [{ kind: "comprehension" as const,
    prompt: "本页状态包含什么", options: [], expectedAnswer: sentence.repeat(6), explanation: "逐项回到来源检查" }] });
  expect(content.questions?.[0]?.expectedAnswer).toContain("\n\n");
  expect(plannedFormatIssues(content)).not.toContain("TEACHING_PRESENTATION:questions:PROSE_PACKED");
});
it("realigns a question label to the objective that owns its existing step", () => {
  const plan: TeachingPlan = { problem: "比较结果", knownStartingPoint: "已有输入", scopeBoundary: "只看本页", facts: [], prerequisites: [],
    steps: [{ id: "s1", factIds: [], dependsOn: [], explanation: "解释输入", example: "", boundary: "" },
      { id: "s2", factIds: [], dependsOn: [], explanation: "解释输出", example: "", boundary: "" }],
    objectives: [{ id: "o1", startingPoint: "输入", outcome: "核对输入", stepIds: ["s1"] },
      { id: "o2", startingPoint: "输出", outcome: "核对输出", stepIds: ["s2"] }],
    questions: [{ objectiveId: "o1", stepId: "s1", kind: "comprehension", focus: "核对输入" },
      { objectiveId: "o1", stepId: "s2", kind: "comprehension", focus: "核对输出" }]
  };
  expect(alignPlanQuestionObjectives(plan).questions.map(q => q.objectiveId)).toEqual(["o1", "o2"]);
  const unrelated = structuredClone(plan);
  unrelated.questions[1]!.stepId = "s1";
  expect(alignPlanQuestionObjectives(unrelated)).toEqual(unrelated);
});
it("fills omitted objective prose from existing plan text without a provider repair", () => {
  const plan: TeachingPlan = { problem: "比较结果", knownStartingPoint: "已有输入", scopeBoundary: "只看本页", facts: [], prerequisites: [],
    steps: [{ id: "s1", factIds: [], dependsOn: [], explanation: "能够根据输入核对结果", example: "", boundary: "" }],
    objectives: [{ id: "o1", stepIds: ["s1"] } as TeachingPlan["objectives"][number]],
    questions: [{ objectiveId: "o1", stepId: "s1", kind: "comprehension", focus: "核对结果" }]
  };
  const normalized = fillMissingPlanObjectiveText(plan);
  expect(normalized.objectives[0]).toMatchObject({ startingPoint: "已有输入", outcome: "能够根据输入核对结果" });
});
it("keeps absent scope metadata empty instead of manufacturing a boundary statement", () => {
  const { input, plan } = fixture();
  const normalized = completeTeachingPlanTransport({ ...plan, scopeBoundary: "" }, input.blueprint!);
  expect(normalized.scopeBoundary).toBe("");
  expect(validateTeachingPlan(normalized, input.blueprint!)).toEqual([]);
});
it("gives each teaching section a distinct role and uses prior sections as short dependencies", () => {
  const memory = teachingSectionMemory({ ...opening, ...explanation, ...closing } as TeachingPackage);
  expect(memory.sectionResponsibilities.priorKnowledge).toContain("不重复整段定义");
  expect(memory.sectionResponsibilities.fullExplanationMarkdown).toContain("逐步深入");
  expect(memory.sectionResponsibilities.mainContentMarkdown).toContain("只压缩");
  expect(memory.sectionResponsibilities.misconceptions).toContain("不重讲整段正文");
  expect(memory.alreadyIntroduced).toEqual(["输入（Input）"]);
});
it("keeps absence inventories and evidence-boundary narration out of the planned lesson", () => {
  expect(planningPrompt).toContain("没有这种边界时返回空字符串");
  expect(planningPrompt).toContain("不要把“本页没有定义、没有分类、没有判定标准、后续才讲”等缺失项列成事实");
  expect(plannedWritingPrompt).toContain("不得把来源标签、审计过程或“本页没有定义、分类、判定标准”“后续才讲”等缺失清单写成主体内容");
  expect(plannedWritingPrompt).toContain("只有当明确缺少的前提会使当前推理无法成立或可能被误读时");
});
it("keeps qualitative growth claims separate from exact bounds across planning, writing, and audit", () => {
  for (const prompt of [planningPrompt, plannedWritingPrompt, semanticAuditPrompt]) {
    expect(prompt).toContain("定性渐进增长");
    expect(prompt).toContain("最小合法输入");
    expect(prompt).toContain("边界情形");
  }
  expect(semanticAuditPrompt).toContain("只替换该字段中的精确式");
  expect(semanticAuditPrompt).toContain("不得仅因这项可修复问题判整页失败");
});
it("instructs generation to progress between sections without copying definitions", () => {
  expect(plannedWritingPrompt).toContain("各字段承担不同工作");
  expect(plannedWritingPrompt).toContain("不要在新章节重新完整解释同一个定义");
  expect(plannedWritingPrompt).toContain("每段都推进理解");
  expect(plannedWritingPrompt).toContain("mainContentMarkdown：只写二至五条高层总结");
});
it("completes a severely partial provider plan from the authoritative blueprint", () => {
  const { input } = fixture("输入与输出");
  const plan = completeTeachingPlanTransport({ knownStartingPoint: "已经知道输入是什么",
    facts: [{ atomId: "invented", observation: { text: "输入经过规则处理" } }],
    steps: [{ id: "s1", factIds: [1], explanation: { text: "说明输入怎样变成输出" } }] }, input.blueprint!);
  const normalized = alignPlanQuestionObjectives(assignUnplacedPlanFacts(removeUnknownPlanFactReferences(bindMissingPlanFactAtoms(plan, input.blueprint!))));
  expect(validateTeachingPlan(normalized, input.blueprint!)).toEqual([]);
  expect(normalized.facts[0]).toMatchObject({ id: "fact-1", atomId: "a", observation: "输入经过规则处理" });
  expect(normalized.questions).toHaveLength(4);
});
it("does not demand a teaching quote for a title-only source fact", () => {
  const { input, plan } = fixture("术语");
  plan.facts[0]!.observation = "页面标题为 TERMINOLOGY";
  expect(plannedCoverageIssues({ ...opening, ...explanation, ...closing, coverageEvidence: [] } as TeachingPackage,
    { ...input.blueprint!, requirementPackage: { ...input.blueprint!.requirementPackage, requirements: [] } }, plan))
    .not.toContain("PLAN_FACT_EVIDENCE_MISSING:a");
  plan.facts[0]!.observation = "页面顶部标题为 TERMINOLOGY，表明本页主题是术语约定";
  expect(plannedCoverageIssues({ ...opening, ...explanation, ...closing, coverageEvidence: [] } as TeachingPackage,
    { ...input.blueprint!, requirementPackage: { ...input.blueprint!.requirementPackage, requirements: [] } }, plan))
    .not.toContain("PLAN_FACT_EVIDENCE_MISSING:a");
  plan.facts[0]!.observation = "芯片由功能块组成";
  expect(plannedCoverageIssues({ ...opening, ...explanation, ...closing, coverageEvidence: [] } as TeachingPackage,
    { ...input.blueprint!, requirementPackage: { ...input.blueprint!.requirementPackage, requirements: [] } }, plan))
    .toContain("PLAN_FACT_EVIDENCE_MISSING:a");
});
it("targets actual lowercase English parentheses in a bounded repair ticket", () => {
  const candidate = { fullExplanationMarkdown: "平均而言（On average），这是期望值（Expected value），官方名称（eBay）" };
  const [ticket] = generationRepairTickets("explanation", candidate,
    ["TEACHING_PRESENTATION:fullExplanationMarkdown:ENGLISH_NAME_CASE"]);
  expect(ticket?.instruction).toContain("On average");
  expect(ticket?.instruction).toContain("Expected value");
  expect(ticket?.instruction).not.toContain("具体的英文括号：eBay");
  expect(ticket?.instruction).toContain("普通英文解释短语应删除英文");
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
        : request.phase === "explanation" ? explanation : request.phase === "bridge" ? bridge : closing, provider: "deepseek", model: "flash", usage };
    });
  });
  it("keeps a title-page plan focused on its stated topic without passing the page number", async () => {
    const { page, input, plan } = fixture("EE 680: Reinforcement Learning Floorplanning");
    page.pageNumber = 1;
    page.atoms = [{ id: "a", kind: "image_region", label: "整页来源画面", observation: "EE 680: Reinforcement Learning Floorplanning\nCourse overview" } as PageLesson["atoms"][number]];
    page.anchors = [{ id: "title", pageId: page.id, kind: "text", label: "标题与副标题", text: "EE 680: Reinforcement Learning Floorplanning\nCourse overview" }];
    page.coverageRequirements = [];
    input.pageTitle = page.title;
    input.pageNumber = 1;
    input.sourceText = "EE 680: Reinforcement Learning Floorplanning\nCourse overview";
    input.blueprint = buildTeachingBlueprint(page, input.sourceText, "zh-CN", "quality", "writing-policy:test", true);
    expect(input.blueprint.resourcePackage.pageKind).toBe("cover");

    plan.problem = "说明课程主题与课程范围";
    plan.facts[0]!.observation = "标题标出课程名称，副标题概括课程范围";
    plan.steps[0]!.explanation = "结合标题与副标题说明课程主题和讨论范围";
    const phases: string[] = [];
    const result = await writePlannedLesson(input, async request => {
      phases.push(request.phase);
      if (request.phase === "plan") {
        const planInput = JSON.parse(request.prompt) as Record<string, unknown>;
        expect(planInput).not.toHaveProperty("pageNumber");
        expect(request.instructions).toContain("定位元数据");
        return { content: plan, provider: "deepseek", model: "flash", usage };
      }
      return { content: request.phase === "opening" ? opening : request.phase === "explanation" ? explanation
        : request.phase === "bridge" ? bridge : closing, provider: "deepseek", model: "flash", usage };
    });
    expect(phases).not.toContain("plan_repair");
    expect(result.trace.plan.facts[0]?.observation).toBe("标题标出课程名称，副标题概括课程范围");
  });

  it("keeps numerical body facts intact while omitting page-number metadata from the plan request", async () => {
    const { page, input, plan } = fixture("Batch processing");
    const source = "Each round processes 32 samples in 4 groups; four rounds process 128 samples";
    page.anchors = [{ id: "body", pageId: page.id, kind: "text", label: "正文", text: source }];
    page.atoms[0] = { id: "a", kind: "text_region", label: "正文", observation: source } as PageLesson["atoms"][number];
    input.sourceText = source;
    input.blueprint = buildTeachingBlueprint(page, source, "zh-CN", "quality", "writing-policy:test", false);
    plan.facts[0]!.observation = "每轮处理 32 个样本并分为 4 组，4 轮共处理 128 个样本";
    plan.steps[0]!.explanation = "按每轮 32 个样本和 4 组核对每组数量，再累计 4 轮的 128 个样本";
    let plannedInput: Record<string, unknown> | undefined;
    const result = await writePlannedLesson(input, async request => {
      if (request.phase === "plan") {
        plannedInput = JSON.parse(request.prompt) as Record<string, unknown>;
        return { content: plan, provider: "deepseek", model: "flash", usage };
      }
      return { content: request.phase === "opening" ? opening : request.phase === "explanation" ? explanation
        : request.phase === "bridge" ? bridge : closing, provider: "deepseek", model: "flash", usage };
    });
    expect(plannedInput?.source).toContain("32");
    expect(plannedInput).not.toHaveProperty("pageNumber");
    expect(result.trace.plan.facts[0]?.observation).toContain("32");
    expect(result.trace.plan.facts[0]?.observation).toContain("128");
    expect(result.trace.phases.map(phase => phase.phase)).not.toContain("plan_repair");
  });
  it("searches only declared evidence gaps and carries normalized evidence into writing", async () => {
    const { input, plan } = fixture("外部方法");
    plan.researchQueries = [{ id: "rq1", atomId: "a", query: "official method terminology", reason: "课件使用方法名但没有给出正式名称来源" }];
    const searchEvidence = vi.fn(async () => [{ queryId: "rq1", provider: "openalex", title: "Official terminology", url: "https://example.test/source", snippet: "Unverified search excerpt", status: "candidate" as const }]);
    input.searchEvidence = searchEvidence;
    const writingPrompts: Array<Record<string, unknown>> = [];
    await writePlannedLesson(input, async request => {
      if (request.phase !== "plan") writingPrompts.push(JSON.parse(request.prompt) as Record<string, unknown>);
      return { content: request.phase === "plan" ? plan : request.phase === "opening" ? opening
        : request.phase === "explanation" ? explanation : request.phase === "bridge" ? bridge : closing, provider: "deepseek", model: "flash", usage };
    });
    expect(searchEvidence).toHaveBeenCalledOnce();
    expect(searchEvidence).toHaveBeenCalledWith(plan.researchQueries);
    const explanationPrompts = writingPrompts.filter(prompt => Array.isArray(prompt.fields) && prompt.fields.includes("fullExplanationMarkdown"));
    const otherPrompts = writingPrompts.filter(prompt => !Array.isArray(prompt.fields) || !prompt.fields.includes("fullExplanationMarkdown"));
    expect(explanationPrompts
      .every(prompt => JSON.stringify(prompt.externalEvidence).includes("Unverified search excerpt"))).toBe(true);
    expect(explanationPrompts
      .every(prompt => String(prompt.externalEvidenceRule).includes("候选外部背景")
        && String(prompt.externalEvidenceRule).includes("不得覆盖 SOURCE"))).toBe(true);
    expect(otherPrompts.every(prompt => prompt.externalEvidence === undefined)).toBe(true);
  });
  it("does not call search when the teaching plan has no external evidence gap", async () => {
    const { input, plan } = fixture("来源充分");
    const searchEvidence = vi.fn(async () => []);
    input.searchEvidence = searchEvidence;
    await writePlannedLesson(input, async request => ({ content: request.phase === "plan" ? plan : request.phase === "opening" ? opening
      : request.phase === "explanation" ? explanation : request.phase === "bridge" ? bridge : closing, provider: "deepseek", model: "flash", usage }));
    expect(searchEvidence).not.toHaveBeenCalled();
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
  it("removes invented fact references and places every real fact once", () => {
    const { input, plan } = fixture();
    plan.steps[0]!.factIds = ["invented"];
    const repaired = removeUnknownPlanFactReferences(plan);
    expect(repaired.steps[0]?.factIds).toEqual(["f"]);
    expect(repaired.facts).toEqual(plan.facts);
    expect(validateTeachingPlan(repaired, input.blueprint!)).toEqual([]);
  });
  it("keeps an incomplete plan on the bounded repair path instead of crashing", () => {
    const { input } = fixture();
    const incomplete = { problem: "说明当前问题" } as TeachingPlan;
    expect(() => removeUnknownPlanFactReferences(bindMissingPlanFactAtoms(incomplete, input.blueprint!))).not.toThrow();
    expect(validateTeachingPlan(incomplete, input.blueprint!)).toContain("result.facts:required");
  });
  it("fills a missing plan heading locally without spending a provider repair", async () => {
    const { input, plan } = fixture();
    const broken = { ...plan, problem: undefined } as unknown as TeachingPlan;
    const result = await writePlannedLesson(input, async request => ({
      content: request.phase === "plan" ? broken
        : request.phase === "opening" ? opening
        : request.phase === "explanation" ? explanation
        : request.phase === "bridge" ? bridge : closing,
      provider: "deepseek", model: "flash", usage
    }));
    expect(result.trace.phases.map(phase => phase.phase)).not.toContain("plan_repair");
    expect(result.trace.plan.problem).toBe(`让零基础读者能够理解并使用《${input.pageTitle}》中的有效内容`);
    expect(result.trace.plan.facts).toEqual(plan.facts);
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
  it("binds a source title to a matching teaching heading without adding title commentary", () => {
    const content = { fullExplanationMarkdown: "## Edge-GNN 是什么\n\n先解释编码器如何处理网表\n\n## 为什么要预训练它",
      coverageEvidence: [{ atomId: "title", coveredFields: ["observation"],
        explanation: "页面标题是 EDGE-GNN: WHY? ，它要交代的是 Edge-GNN 为什么存在" }] };
    expect(bindExactCoverageLines(content).coverageEvidence[0]?.explanation).toBe("## Edge-GNN 是什么");
    const unrelated = { ...content, fullExplanationMarkdown: "## 无关章节\n\n先解释另一项内容" };
    expect(bindExactCoverageLines(unrelated).coverageEvidence[0]?.explanation).toBe(content.coverageEvidence[0]?.explanation);
  });
  it("rejects stale, unchanged and out-of-scope repair patches", () => {
    const ticket = generationRepairTickets("explanation", explanation, ["PLAN_EVIDENCE_QUOTE_MISSING:a"])[0]!;
    expect(() => applyGenerationRepair({ ...explanation, coverageEvidence: [] }, ticket, { coverageEvidence: explanation.coverageEvidence })).toThrow("GENERATION_REPAIR_STALE");
    expect(() => applyGenerationRepair(explanation, ticket, { coverageEvidence: explanation.coverageEvidence })).toThrow("GENERATION_REPAIR_NO_CHANGE");
    const projected = applyGenerationRepair(explanation, ticket, { coverageEvidence: [], fullExplanationMarkdown: "changed" });
    expect(projected.fullExplanationMarkdown).toBe(explanation.fullExplanationMarkdown);
    expect(() => applyGenerationRepair(explanation, ticket, { fullExplanationMarkdown: "changed" })).toThrow("GENERATION_REPAIR_SCOPE_INVALID");
    const preserved = { ...explanation, coverageEvidence: [...explanation.coverageEvidence, { atomId: "b", coveredFields: ["observation"], explanation: quote }] };
    const scoped = generationRepairTickets("explanation", preserved, ["PLAN_EVIDENCE_QUOTE_MISSING:a"])[0]!;
    expect(applyGenerationRepair(preserved, scoped, { coverageEvidence: [] }).coverageEvidence)
      .toEqual([{ atomId: "b", coveredFields: ["observation"], explanation: quote }]);
  });
  it("accepts both scattered typography corrections and a fenced whole-field repair", () => {
    const original = `## 起点\n${"先看对象再判断结果".repeat(50)}。\n\n## 过程\n${"保持原有事实和条件".repeat(50)}。`;
    const ticket = generationRepairTickets("explanation", { fullExplanationMarkdown: original },
      ["TEACHING_FORMAT:fullExplanationMarkdown:WRITING_CHINESE_FULL_STOP_FORBIDDEN"])[0]!;
    expect(applyGenerationRepair({ fullExplanationMarkdown: original }, ticket,
      { fullExplanationMarkdown: original.replaceAll("。", "") }).fullExplanationMarkdown).not.toContain("。");
    expect(applyGenerationRepair({ fullExplanationMarkdown: original }, ticket,
      { fullExplanationMarkdown: "替换后的同字段讲解".repeat(350) }).fullExplanationMarkdown)
      .toBe("替换后的同字段讲解".repeat(350));
  });
  it("uses the second bounded repair round when the first patch changes nothing", async () => {
    const { input, plan } = fixture();
    const badOpening = { ...opening, priorKnowledge: [opening.priorKnowledge[0]!.replace("输入（Input）：", "输入：")] };
    const responses = [plan, badOpening, { priorKnowledge: badOpening.priorKnowledge }, { priorKnowledge: opening.priorKnowledge }, explanation, closing, bridge];
    const calls: string[] = [];
    await writePlannedLesson(input, async request => {
      calls.push(request.phase);
      return { content: responses.shift(), provider: "deepseek", model: "flash", usage };
    });
    expect(calls).toEqual(["plan", "opening", "opening_repair", "opening_repair", "explanation", "consolidation", "bridge"]);
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
  it("accepts a valid atom replacement for an invalid evidence atom", () => {
    const original = { ...explanation, coverageEvidence: [
      { atomId: "invented", coveredFields: ["observation"], explanation: "旧的错误引文" }
    ] };
    const ticket = generationRepairTickets("explanation", original,
      ["PLAN_EVIDENCE_UNKNOWN_ATOM:invented"], ["a", "b"])[0]!;
    const result = applyGenerationRepair(original, ticket, { coverageEvidence: [
      { atomId: "a", coveredFields: ["observation"], explanation: quote }
    ] });
    expect(result.coverageEvidence).toEqual([{ atomId: "a", coveredFields: ["observation"], explanation: quote }]);
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
      return { content: request.phase === "explanation_repair" ? { coverageEvidence: explanation.coverageEvidence }
        : request.phase === "bridge" ? bridge : closing,
        provider: "deepseek", model: "flash", usage };
    });
    expect(calls).toEqual(["explanation_repair", "consolidation", "bridge"]);
    expect(result.content.fullExplanationMarkdown).toBe(explanation.fullExplanationMarkdown);
    expect(checkpoint?.completedPhases).toEqual(["opening", "explanation", "consolidation", "bridge"]);
  });
  it("retries a transient provider failure only for the current stage", async () => {
    const { input, plan } = fixture();
    const calls: string[] = [];
    const result = await writePlannedLesson(input, async request => {
      calls.push(request.phase);
      if (request.phase === "opening" && calls.filter(phase => phase === "opening").length === 1) throw new Error("MODEL_PROVIDER_FAILED:429");
      return { content: request.phase === "plan" ? plan : request.phase === "opening" ? opening
        : request.phase === "explanation" ? explanation : request.phase === "bridge" ? bridge : closing, provider: "deepseek", model: "flash", usage };
    });
    expect(calls).toEqual(["plan", "opening", "opening", "explanation", "consolidation", "bridge"]);
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
          : request.phase === phase ? bad : request.phase === "explanation" ? explanation : request.phase === "bridge" ? bridge : closing;
      return { content, provider: "deepseek", model: "flash", usage };
    });
    expect(calls).toEqual(["plan", "opening", "explanation", ...(phase === "explanation" ? ["explanation_repair", "consolidation", "bridge"] : ["consolidation", "consolidation_repair", "bridge"])]);
    expect(result.content).toMatchObject({ ...opening, ...explanation, ...closing,
      misconceptions: closing.misconceptions.map(formatMisconception) });
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
              : request.phase === "bridge" ? bridge : { mainContentMarkdown: closing.mainContentMarkdown };
      return { content, provider: "deepseek", model: "flash", usage };
    });
    expect(calls).toEqual(["plan", "opening", "explanation", "explanation_repair", "consolidation", "consolidation_repair", "bridge"]);
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
            : request.phase === "explanation_repair" ? { coverageEvidence: explanation.coverageEvidence }
              : request.phase === "bridge" ? bridge : closing;
      return { content, provider: "deepseek", model: "flash", usage };
    });
    expect(calls).toEqual(["plan", "opening", "opening_repair", "explanation", "explanation_repair", "consolidation", "bridge"]);
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
  it("finishes every core phase before waiting for the previous-page dependency", async () => {
    const { input, plan } = fixture();
    let releaseDependency!: (value: { context: string; fingerprint: string }) => void;
    input.resolvePreviousPageContext = () => new Promise(resolve => { releaseDependency = resolve; });
    const calls: string[] = [];
    const running = writePlannedLesson(input, async request => {
      calls.push(request.phase);
      return { content: request.phase === "plan" ? plan : request.phase === "opening" ? opening
        : request.phase === "explanation" ? explanation : request.phase === "bridge" ? bridge : closing,
      provider: "deepseek", model: "flash", usage };
    });
    await vi.waitFor(() => expect(calls).toEqual(["plan", "opening", "explanation", "consolidation"]));
    releaseDependency({ context: "前页已经完成正文核心", fingerprint: "previous-core-v1" });
    const result = await running;
    expect(calls).toEqual(["plan", "opening", "explanation", "consolidation", "bridge"]);
    expect(result.trace.previousCoreFingerprint).toBe("previous-core-v1");
    expect(result.trace.coreFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("regenerates only the bridge when the predecessor core fingerprint changes", async () => {
    const { input, plan } = fixture();
    input.teachingFingerprint = "same-page-core";
    input.resumeTeaching = {
      fingerprint: "same-page-core",
      plan,
      content: { ...opening, ...explanation, ...closing } as TeachingPackage,
      completedPhases: ["opening", "explanation", "consolidation", "bridge"],
      trace: { version: 1, plan, previousPageContext: "旧前页正文", previousCoreFingerprint: "old-core", phases: [] }
    };
    input.resolvePreviousPageContext = async () => ({ context: "新前页正文", fingerprint: "new-core" });
    const calls: string[] = [];
    const result = await writePlannedLesson(input, async request => {
      calls.push(request.phase);
      return { content: bridge, provider: "deepseek", model: "flash", usage };
    });
    expect(calls).toEqual(["bridge"]);
    expect(result.trace.previousCoreFingerprint).toBe("new-core");
    expect(result.content.fullExplanationMarkdown).toBe(explanation.fullExplanationMarkdown);
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
    const outputs = [plan, opening, explanation, closing, bridge];
    const result = await writePlannedLesson(input, async request => {
      calls.push(request);
      return { content: outputs[calls.length - 1], provider: "deepseek", model: "model", usage };
    });
    expect(calls.map(call => call.phase)).toEqual(["plan", "opening", "explanation", "consolidation", "bridge"]);
    expect(calls.filter(call => call.image)).toHaveLength(1);
    expect(JSON.parse(calls[2].prompt).precedingSections.alreadyIntroduced).toEqual(["输入（Input）"]);
    expect(JSON.parse(calls[2].prompt).precedingSections.sectionResponsibilities.fullExplanationMarkdown).toContain("逐步深入");
    expect(JSON.parse(calls[3].prompt).precedingSections.explanation).toBe(explanation.fullExplanationMarkdown);
    expect(result.content.questions).toHaveLength(4);
    expect(result.trace.plan.problem).toBe(`解释${title}`);
  });
  it("allows one local repair without regenerating preceding sections", async () => {
    const { input, plan } = fixture();
    const phases: string[] = [];
    const outputs = [plan, opening, { ...explanation, coverageEvidence: [] }, { coverageEvidence: explanation.coverageEvidence }, closing, bridge];
    await writePlannedLesson(input, async request => {
      phases.push(request.phase);
      return { content: outputs[phases.length - 1], provider: "deepseek", model: "model", usage };
    });
    expect(phases).toEqual(["plan", "opening", "explanation", "explanation_repair", "consolidation", "bridge"]);
  });
  it("keeps a schema-valid explanation when two format repairs return a too-short replacement", async () => {
    const { input, plan } = fixture();
    input.teachingFingerprint = "format-repair-schema-guard";
    const calls: string[] = [];
    const checkpoints: NonNullable<ModelRouterInput["resumeTeaching"]>[] = [];
    input.onTeachingCheckpoint = async value => { checkpoints.push(structuredClone(value)); };
    const result = await writePlannedLesson(input, async request => {
      calls.push(request.phase);
      return { content: request.phase === "plan" ? plan : request.phase === "opening" ? opening
        : request.phase === "explanation" ? formatOnlyExplanation
          : request.phase === "explanation_repair" ? { fullExplanationMarkdown: "仅返回一条过短的修复" }
            : request.phase === "bridge" ? bridge : closing,
      provider: "deepseek", model: "flash", usage };
    });
    expect(calls).toEqual(["plan", "opening", "explanation", "explanation_repair", "explanation_repair", "consolidation", "bridge"]);
    expect(result.content.fullExplanationMarkdown).toBe(formatOnlyExplanation.fullExplanationMarkdown);
    expect(result.trace.formatWarnings).toEqual([{ phase: "explanation", issues: ["TEACHING_PRESENTATION:fullExplanationMarkdown:PROSE_PACKED"] }]);
    expect(checkpoints.at(-1)?.trace.formatWarnings).toEqual(result.trace.formatWarnings);
    const pendingExplanation = checkpoints.filter(checkpoint => checkpoint.pending?.phase === "explanation");
    expect(pendingExplanation.length).toBeGreaterThan(0);
    expect(pendingExplanation.every(checkpoint => (checkpoint.pending?.content.fullExplanationMarkdown?.length ?? 0) >= 120)).toBe(true);
    expect(pendingExplanation.every(checkpoint => !checkpoint.pending?.issues.includes("result.fullExplanationMarkdown:length"))).toBe(true);
  });
  it("does not repeat format repairs already recorded in a resumed checkpoint", async () => {
    const { input, plan } = fixture();
    input.teachingFingerprint = "resume-after-two-format-repairs";
    input.resumeTeaching = {
      fingerprint: input.teachingFingerprint,
      plan,
      content: { priorKnowledge: opening.priorKnowledge, learningObjectives: opening.learningObjectives },
      completedPhases: ["opening"],
      pending: { phase: "explanation", content: formatOnlyExplanation, issues: [
        "TEACHING_FORMAT:fullExplanationMarkdown:WRITING_COLON_PSEUDO_HEADING",
        "TEACHING_PRESENTATION:fullExplanationMarkdown:PROSE_PACKED"
      ] },
      trace: { version: 1, plan, phases: [0, 1].map(() => ({ phase: "explanation_repair", provider: "deepseek", model: "flash", usage })) }
    };
    const calls: string[] = [];
    const result = await writePlannedLesson(input, async request => {
      calls.push(request.phase);
      return { content: request.phase === "bridge" ? bridge : closing, provider: "deepseek", model: "flash", usage };
    });
    expect(calls).toEqual(["consolidation", "bridge"]);
    expect(result.content.fullExplanationMarkdown).toBe(formatOnlyExplanation.fullExplanationMarkdown);
    expect(result.trace.formatWarnings?.[0]).toMatchObject({ phase: "explanation", issues: ["TEACHING_PRESENTATION:fullExplanationMarkdown:PROSE_PACKED"] });
  });
  it("still fails after two repairs when a structural explanation issue remains", async () => {
    const { input, plan } = fixture();
    const invalidExplanation = { ...explanation, coverageEvidence: [{ atomId: "a", coveredFields: ["observation"] }] };
    const calls: string[] = [];
    await expect(writePlannedLesson(input, async request => {
      calls.push(request.phase);
      return { content: request.phase === "plan" ? plan : request.phase === "opening" ? opening
        : request.phase === "explanation" ? invalidExplanation
          : request.phase === "explanation_repair" ? { coverageEvidence: invalidExplanation.coverageEvidence }
            : request.phase === "bridge" ? bridge : closing,
      provider: "deepseek", model: "flash", usage };
    })).rejects.toThrow("TEACHING_EXPLANATION_INVALID:result.coverageEvidence.0.explanation:required");
    expect(calls).toEqual(["plan", "opening", "explanation", "explanation_repair", "explanation_repair"]);
  });
  it("assigns an unplaced plan fact locally without a provider repair", async () => {
    const { input, plan } = fixture();
    const broken = structuredClone(plan);
    broken.steps[0]!.factIds = [];
    const phases: string[] = [];
    const outputs = [broken, opening, explanation, closing, bridge];
    await writePlannedLesson(input, async request => {
      phases.push(request.phase);
      return { content: outputs[phases.length - 1], provider: "deepseek", model: "model", usage };
    });
    expect(phases).toEqual(["plan", "opening", "explanation", "consolidation", "bridge"]);
  });
  it("realigns shared-step objective coverage without a provider repair", async () => {
    const { input, plan } = fixture();
    const broken = structuredClone(plan);
    broken.objectives.push({ id: "second", startingPoint: "已有输出", outcome: "检查另一种条件", stepIds: ["s"] });
    const calls: string[] = [];
    const outputs = [broken, opening, explanation, closing, bridge];
    await writePlannedLesson(input, async request => {
      calls.push(request.phase);
      return { content: outputs.shift(), provider: "deepseek", model: "flash", usage };
    });
    expect(calls).toEqual(["plan", "opening", "explanation", "consolidation", "bridge"]);
  });
  it("persists a locally completed plan instead of blocking on provider transport omissions", async () => {
    const { input, plan } = fixture();
    input.teachingFingerprint = "resume-invalid-plan";
    const checkpoints: Array<NonNullable<ModelRouterInput["resumeTeaching"]>> = [];
    input.onTeachingCheckpoint = async value => { checkpoints.push(structuredClone(value)); };
    const broken = { ...structuredClone(plan), facts: [] };
    const calls: string[] = [];
    await writePlannedLesson(input, async request => {
      calls.push(request.phase);
      return { content: request.phase === "plan" ? broken : request.phase === "opening" ? opening
        : request.phase === "explanation" ? explanation : request.phase === "bridge" ? bridge : closing, provider: "deepseek", model: "flash", usage };
    });
    expect(calls).toEqual(["plan", "opening", "explanation", "consolidation", "bridge"]);
    expect(checkpoints[0]?.plan?.facts.length).toBeGreaterThan(0);
    expect(checkpoints[0]?.completedPhases).toEqual([]);
  });
  it("removes provider metadata and maps a plan fact text alias without weakening validation", () => {
    const { plan } = fixture();
    const drifted = {
      pageId: "page:16",
      pageNumber: 16,
      title: "EDGE-GNN: WHY?",
      ...plan,
      facts: plan.facts.map((fact, index) => index === 0
        ? { id: fact.id, atomId: fact.atomId, text: fact.observation, qualification: fact.qualification, providerNote: "echo" }
        : fact)
    };
    const normalized = projectPlannedOutputToSchema(drifted, teachingPlanSchema, "plan") as TeachingPlan;
    expect(normalized).not.toHaveProperty("pageId");
    expect(normalized.facts[0]).toEqual(plan.facts[0]);
    expect(validateTeachingPlan(normalized, fixture().input.blueprint!)).toEqual([]);
  });
  it("unwraps one provider transport object before applying the stage schema", () => {
    const { plan } = fixture();
    expect(projectPlannedOutputToSchema({ plan }, teachingPlanSchema, "plan")).toEqual(plan);
    const schema = { type: "object", properties: { mainContentMarkdown: { type: "string" } }, required: ["mainContentMarkdown"], additionalProperties: false };
    expect(projectPlannedOutputToSchema({ result: { mainContentMarkdown: "- 结论" } }, schema, "consolidation_repair"))
      .toEqual({ mainContentMarkdown: "- 结论" });
  });
  it("normalizes provider question kind aliases and caps prerequisite planning", () => {
    const { plan } = fixture();
    const drifted = {
      ...plan,
      prerequisites: [...plan.prerequisites, ...Array.from({ length: 7 }, (_, index) => ({ name: `补充${index}`, explanation: "只用于模拟供应商超额输出" }))],
      questions: plan.questions.map((question, index) => ({ ...question, kind: index < 2 ? "理解题" : "multiple-choice" }))
    };
    const normalized = projectPlannedOutputToSchema(drifted, teachingPlanSchema, "plan") as TeachingPlan;
    expect(normalized.prerequisites).toHaveLength(5);
    expect(normalized.questions.map(question => question.kind)).toEqual(["comprehension", "comprehension", "multiple_choice", "multiple_choice"]);
  });
  it("normalizes provider question kind aliases inside consolidation output", () => {
    const schema = { type: "object", properties: {
      questions: { type: "array", items: { type: "object", properties: {
        kind: { type: "string", enum: ["comprehension", "multiple_choice"] },
        prompt: { type: "string" }
      }, required: ["kind", "prompt"], additionalProperties: false }
    } }, required: ["questions"], additionalProperties: false };
    expect(projectPlannedOutputToSchema({ questions: [
      { kind: "understanding", prompt: "先说明原因" },
      { type: "choice", prompt: "选择正确说法" }
    ] }, schema, "consolidation")).toEqual({ questions: [
      { kind: "comprehension", prompt: "先说明原因" },
      { kind: "multiple_choice", prompt: "选择正确说法" }
    ] });
  });
  it("does not inject an undefined optional research query kind", () => {
    const { input, plan } = fixture("外部方法");
    plan.researchQueries = [{ id: "rq1", atomId: "a", query: "official method terminology", reason: "课件缺少正式名称来源" }];
    const normalized = projectPlannedOutputToSchema(plan, teachingPlanSchema, "plan") as TeachingPlan;
    expect(normalized.researchQueries?.[0]).not.toHaveProperty("kind");
    expect(validateTeachingPlan(normalized, input.blueprint!)).toEqual([]);
  });
  it("binds missing or invented provider fact IDs to real source requirements in order", () => {
    const { input, plan } = fixture();
    const missing = structuredClone(plan) as TeachingPlan;
    delete (missing.facts[0] as Partial<TeachingPlan["facts"][number]>).atomId;
    delete (missing.facts[0] as Partial<TeachingPlan["facts"][number]>).qualification;
    const bound = bindMissingPlanFactAtoms(missing, input.blueprint!);
    expect(bound.facts[0]).toMatchObject({ atomId: "a", qualification: "" });
    expect(validateTeachingPlan(bound, input.blueprint!)).toEqual([]);
    const invented = structuredClone(plan) as TeachingPlan;
    invented.facts[0]!.atomId = "provider-invented-atom";
    expect(bindMissingPlanFactAtoms(invented, input.blueprint!).facts[0]?.atomId).toBe("a");
    expect(validateTeachingPlan(bindMissingPlanFactAtoms(invented, input.blueprint!), input.blueprint!)).toEqual([]);
  });
  it("leaves a structurally incomplete plan for the bounded repair path instead of throwing", () => {
    const { input } = fixture();
    const incomplete = { problem: "说明当前问题" } as TeachingPlan;
    expect(() => bindMissingPlanFactAtoms(incomplete, input.blueprint!)).not.toThrow();
    expect(validateTeachingPlan(bindMissingPlanFactAtoms(incomplete, input.blueprint!), input.blueprint!)).toContain("result.facts:required");
  });
  it("uses one provider and bills all five actual calls without audit requests", async () => {
    const { input, plan } = fixture();
    const outputs = [plan, opening, explanation, closing, bridge];
    const fetcher = vi.fn(async () => Response.json({ model: "deepseek-v4-flash", output_text: JSON.stringify(outputs.shift()), usage: { input_tokens: 100, output_tokens: 200, cost: 0.001 } }));
    vi.stubGlobal("fetch", fetcher);
    const result = await new HttpProviderTeachingClient({ providerId: "opencode-go", model: "deepseek-v4-flash", baseUrl: "https://test.invalid", apiKey: "test", protocol: "responses" }).generateTeachingPackage(input);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(result.usage.apiEquivalentUsd).toBeCloseTo(0.005);
    expect(result.teachingTrace?.phases).toHaveLength(5);
  });
  it("bounds planned chat calls without unbounded reasoning", async () => {
    const { input, plan } = fixture();
    const outputs = [plan, opening, explanation, closing, bridge];
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toMatchObject({ thinking: { type: "disabled" } });
      return Response.json({ model: "deepseek-v4-flash", choices: [{ message: { content: JSON.stringify(outputs.shift()) } }], usage: { prompt_tokens: 100, completion_tokens: 200, cost: 0.001 } });
    });
    vi.stubGlobal("fetch", fetcher);
    await new HttpProviderTeachingClient({ providerId: "opencode-go", model: "deepseek-v4-flash", baseUrl: "https://test.invalid", apiKey: "test", protocol: "chat_completions" }).generateTeachingPackage(input);
    expect(fetcher).toHaveBeenCalledTimes(5);
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
    const outputs = [JSON.stringify(plan), "not JSON", JSON.stringify(opening), JSON.stringify(explanation), JSON.stringify(closing), JSON.stringify(bridge)];
    const fetcher = vi.fn(async () => Response.json({ model: "deepseek-v4-flash", output_text: outputs.shift(), usage: { input_tokens: 100, output_tokens: 200, cost: 0.001 } }));
    vi.stubGlobal("fetch", fetcher);
    const result = await new HttpProviderTeachingClient({ providerId: "opencode-go", model: "deepseek-v4-flash", baseUrl: "https://test.invalid", apiKey: "test", protocol: "responses" }).generateTeachingPackage(input);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(result.usage.apiEquivalentUsd).toBeCloseTo(0.006);
    expect(result.teachingTrace?.phases.map(phase => phase.phase)).toEqual(["plan", "opening_invalid_json", "opening_json_repair", "explanation", "consolidation", "bridge"]);
  });
});
