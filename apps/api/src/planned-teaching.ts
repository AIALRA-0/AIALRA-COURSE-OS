import { readFileSync } from "node:fs";
import { validateMarkdownMath } from "@course-os/quality";
import { policyFormatRules, teachingPackageSchema } from "./generation-harness.js";
import { plannedCoverageIssues, schemaIssues, teachingPlanSchema, teachingSectionMemory, validateTeachingPlan, type TeachingPlan } from "./teaching-plan.js";
import type { ModelRouterInput, ModelRouterUsage, TeachingPackage } from "./model-router.js";

const readPrompt = (name: string) => readFileSync(new URL(`../../../config/generation-harness/${name}`, import.meta.url), "utf8");
export const planningPrompt = readPrompt("page-plan-prompt.md");
export const plannedWritingPrompt = readPrompt("planned-writing-prompt.md");
export interface PlannedCall {
  phase: string;
  instructions: string;
  prompt: string;
  schema: Record<string, unknown>;
  image?: string;
  maxOutputTokens: number;
}
export interface PlannedTrace {
  version: 1;
  plan: TeachingPlan;
  previousPageContext?: string;
  phases: Array<{ phase: string; provider: string; model: string; usage: ModelRouterUsage }>;
}

const fieldsByPhase = [
  ["chapterBridgeMarkdown", "priorKnowledge", "learningObjectives"],
  ["fullExplanationMarkdown", "coverageEvidence"],
  ["mainContentMarkdown", "misconceptions", "questions"]
] as const;
const phases = ["opening", "explanation", "consolidation"];
const partialSchema = (fields: readonly string[]) => ({ type: "object", properties: Object.fromEntries(fields.map(field => [field, (teachingPackageSchema.properties as Record<string, unknown>)[field]])), required: fields, additionalProperties: false });

export function plannedContentIssues(content: TeachingPackage, input: ModelRouterInput): string[] {
  const issues = schemaIssues(content, teachingPackageSchema);
  if (issues.length) return issues;
  issues.push(...plannedCoverageIssues(content, input.blueprint!));
  const values = [content.chapterBridgeMarkdown || "", ...content.priorKnowledge, ...content.learningObjectives,
    content.fullExplanationMarkdown, content.mainContentMarkdown, ...content.misconceptions,
    ...content.questions.flatMap(question => [question.prompt, ...question.options || [], question.expectedAnswer, question.explanation])];
  for (const text of values) issues.push(...validateMarkdownMath(text));
  if (content.questions.filter(question => question.kind === "comprehension").length !== 2) issues.push("PLAN_QUESTION_MIX");
  for (const question of content.questions) {
    const options = question.options || [];
    if (question.kind === "comprehension" ? options.length !== 0
      : options.length !== 4 || new Set(options).size !== 4 || !options.includes(question.expectedAnswer)) issues.push("PLAN_QUESTION_ANSWER_INVALID");
  }
  return [...new Set(issues)];
}

/** Four bounded calls, with real prior output passed forward; no audit loop. */
export async function writePlannedLesson(input: ModelRouterInput,
  call: (request: PlannedCall) => Promise<{ content: unknown; provider: string; model: string; usage: ModelRouterUsage }>) {
  const blueprint = input.blueprint!;
  const trace: PlannedTrace = { version: 1, plan: undefined as unknown as TeachingPlan, previousPageContext: input.previousPageContext, phases: [] };
  let repairUsed = false;
  const run = async (request: PlannedCall) => {
    await input.onTeachingPhase?.(request.phase, "started");
    let result: Awaited<ReturnType<typeof call>>;
    try { result = await call(request); }
    catch (error) {
      if (repairUsed || !(error instanceof Error) || error.message !== "MODEL_PROVIDER_OUTPUT_JSON_INVALID") throw error;
      const failed = error as Error & { provider?: string; model?: string; usage?: ModelRouterUsage };
      if (failed.provider && failed.model && failed.usage) trace.phases.push({ phase: `${request.phase}_invalid_json`, provider: failed.provider, model: failed.model, usage: failed.usage });
      repairUsed = true;
      request = { ...request, phase: `${request.phase}_repair`, instructions: `${request.instructions}\n上次返回不是合法 JSON，只返回一个完整 JSON 对象，字符串内换行与反斜杠必须按 JSON 转义，不输出对象外的文字` };
      await input.onTeachingPhase?.(request.phase, "started");
      result = await call(request);
    }
    trace.phases.push({ phase: request.phase, provider: result.provider, model: result.model, usage: result.usage });
    await input.onTeachingPhase?.(request.phase, "completed", result.usage);
    return result.content;
  };
  const planRequest: PlannedCall = { phase: "plan", instructions: planningPrompt,
    prompt: JSON.stringify({ title: input.pageTitle, pageNumber: input.pageNumber,
      source: input.sourceText, previousTeaching: input.previousPageContext || "无前页讲解，不假定已有前页知识",
      atomIds: blueprint.resourcePackage.atomIds, requirements: blueprint.requirementPackage.requirements }),
    schema: teachingPlanSchema, image: input.sourceImageDataUrl, maxOutputTokens: 4800 };
  let plan = await run(planRequest) as TeachingPlan;
  let planIssues = validateTeachingPlan(plan, blueprint);
  if (planIssues.length && !repairUsed) {
    repairUsed = true;
    plan = await run({ ...planRequest, phase: "plan_repair", prompt: JSON.stringify({ originalInput: JSON.parse(planRequest.prompt), currentPlan: plan, issues: planIssues,
      instruction: "只修正列出的问题，保留已正确的事实和步骤；每个来源要求都需对应事实，每个事实都需有讲解位置" }) }) as TeachingPlan;
    planIssues = validateTeachingPlan(plan, blueprint);
  }
  if (planIssues.length) throw new Error(`TEACHING_PLAN_INVALID:${planIssues.join(",")}`);
  trace.plan = plan;
  let content: Partial<TeachingPackage> = {};
  for (let index = 0; index < fieldsByPhase.length; index++) {
    const fields = fieldsByPhase[index]!;
    const schema = partialSchema(fields);
    const request: PlannedCall = { phase: phases[index]!, instructions: `${plannedWritingPrompt}\n\n${policyFormatRules}`,
      prompt: JSON.stringify({ language: input.language, pageTitle: input.pageTitle, plan,
        previousTeaching: index === 0 ? input.previousPageContext : undefined,
        precedingSections: teachingSectionMemory(content), fields,
        coverageRequirements: index === 1 ? blueprint.requirementPackage.requirements : undefined,
        instruction: index === 0 ? "先写承接和先验知识，再从已建立的对象描述学习目标"
          : index === 1 ? "前部知识已讲过，只应用，按计划逐步解释当前课件，不扩写后续章节"
          : "依据实际完整讲解生成总结、辨析和问题，遵守计划题目顺序，不引入正文未讲的结论" }),
      schema, maxOutputTokens: index === 1 ? 6500 : 3200 };
    let partial = await run(request) as Partial<TeachingPackage>;
    let issues = schemaIssues(partial, schema);
    if (index === 1 && !issues.length) issues.push(...plannedCoverageIssues(partial as TeachingPackage, blueprint), ...validateMarkdownMath(partial.fullExplanationMarkdown!));
    if (index === 2 && !issues.length) issues.push(...plannedContentIssues({ ...content, ...partial } as TeachingPackage, input));
    if (issues.length && !repairUsed) {
      repairUsed = true;
      partial = await run({ ...request, phase: `${request.phase}_repair`,
        prompt: JSON.stringify({ originalInput: JSON.parse(request.prompt), currentFields: partial, issues,
          instruction: "只修复当前阶段字段的已列问题，保留其余内容，不输出其他字段" }) }) as Partial<TeachingPackage>;
      issues = schemaIssues(partial, schema);
      if (index === 1 && !issues.length) issues.push(...plannedCoverageIssues(partial as TeachingPackage, blueprint), ...validateMarkdownMath(partial.fullExplanationMarkdown!));
      if (index === 2 && !issues.length) issues.push(...plannedContentIssues({ ...content, ...partial } as TeachingPackage, input));
    }
    if (issues.length) throw new Error(`TEACHING_${request.phase.toUpperCase()}_INVALID:${issues.join(",")}`);
    content = { ...content, ...partial };
  }
  return { content: content as TeachingPackage, trace };
}
