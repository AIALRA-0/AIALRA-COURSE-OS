import { readFileSync } from "node:fs";
import { formatMisconception, normalizeEnglishTermCase, normalizeHumanReadableChineseMarkdown, normalizePackedTeachingProse, validateHumanReadableChinese, validateMarkdownMath, validateTeachingPresentation } from "@course-os/quality";
import { teachingPackageSchema, writingPolicyInstructions } from "./generation-harness.js";
import { alignPlanQuestionObjectives, assignUnplacedPlanFacts, bindExactCoverageLines, plannedCoverageIssues, schemaIssues, teachingPlanSchema, teachingSectionMemory, validateTeachingPlan, type TeachingPlan } from "./teaching-plan.js";
import type { ModelRouterInput, ModelRouterUsage, TeachingPackage } from "./model-router.js";
import { applyGenerationRepair, generationRepairTickets } from "./generation-repair.js";
import { classifyGenerationFailure } from "./generation-errors.js";

const readPrompt = (name: string) => readFileSync(new URL(`../../../config/generation-harness/${name}`, import.meta.url), "utf8");
export const planningPrompt = readPrompt("page-plan-prompt.md");
export const plannedWritingPrompt = readPrompt("planned-writing-prompt.md");
export const writingFormatContract = readPrompt("writing-format-contract.md");
export function plannedInstructions(fields: readonly string[], language = "zh-CN") {
  const fieldNames = Object.keys(teachingPackageSchema.properties as Record<string, unknown>);
  const selected = plannedWritingPrompt.split("\n").filter(line => !fieldNames.some(field => line.startsWith(`${field}：`))
    || fields.some(field => line.startsWith(`${field}：`))).join("\n");
  const completePolicy = writingPolicyInstructions(language);
  return `${selected}\n\n${writingFormatContract}${completePolicy ? `\n\n---\n\n${completePolicy}` : ""}`;
}
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
  phases: Array<{ phase: string; provider: string; model: string; usage: ModelRouterUsage; attempt?: number }>;
}
export interface PlannedCheckpoint {
  fingerprint: string;
  plan?: TeachingPlan;
  content: Partial<TeachingPackage>;
  completedPhases: string[];
  pending?: { phase: string; content: Partial<TeachingPackage>; issues: string[] };
  trace: PlannedTrace;
}

const fieldsByPhase = [
  ["chapterBridgeMarkdown", "priorKnowledge", "learningObjectives"],
  ["fullExplanationMarkdown", "coverageEvidence"],
  ["mainContentMarkdown", "misconceptions", "questions"]
] as const;
const phases = ["opening", "explanation", "consolidation"];
const partialSchema = (fields: readonly string[]) => ({ type: "object", properties: Object.fromEntries(fields.map(field => [field, (teachingPackageSchema.properties as Record<string, unknown>)[field]])), required: fields, additionalProperties: false });

/** Mechanical punctuation only; keep the answer text and matching options intact. */
export function normalizePlannedQuestionPunctuation<T extends Partial<TeachingPackage>>(content: T): T {
  if (!content.questions) return content;
  const normalizeAnswer = (value: string) => normalizePackedTeachingProse(normalizeHumanReadableChineseMarkdown(value));
  return { ...content, questions: content.questions.map(question => ({ ...question,
    prompt: normalizeAnswer(question.prompt),
    options: question.options?.map(normalizeHumanReadableChineseMarkdown),
    expectedAnswer: question.kind === "comprehension" ? normalizeAnswer(question.expectedAnswer)
      : normalizeHumanReadableChineseMarkdown(question.expectedAnswer),
    explanation: normalizeAnswer(question.explanation)
  })) };
}

export function normalizePlannedSourceIntroductions<T extends Partial<TeachingPackage>>(content: T): T {
  if (!content.fullExplanationMarkdown) return content;
  const introduced = content.fullExplanationMarkdown.replace(/^([ \t]*)原文[：:][ \t]*$/gmu, "$1课件原文如下：");
  return { ...content, fullExplanationMarkdown: normalizePackedTeachingProse(normalizeEnglishTermCase(normalizeHumanReadableChineseMarkdown(introduced))) };
}

/** Check the actual phase output while its own fields can still be repaired. */
export function plannedFormatIssues(content: Partial<TeachingPackage>): string[] {
  const visible: Partial<Record<keyof TeachingPackage, string[]>> = {
    chapterBridgeMarkdown: content.chapterBridgeMarkdown === undefined ? undefined : [content.chapterBridgeMarkdown],
    priorKnowledge: content.priorKnowledge,
    learningObjectives: content.learningObjectives,
    fullExplanationMarkdown: content.fullExplanationMarkdown === undefined ? undefined : [content.fullExplanationMarkdown],
    mainContentMarkdown: content.mainContentMarkdown === undefined ? undefined : [content.mainContentMarkdown],
    misconceptions: content.misconceptions,
    questions: content.questions?.flatMap(question => [question.prompt, ...question.options || [], question.expectedAnswer, question.explanation])
  };
  const issues = Object.entries(visible).flatMap(([field, values]) => (values || []).flatMap(value =>
    validateHumanReadableChinese(value).map(issue => `TEACHING_FORMAT:${field}:${issue}`)));
  issues.push(...validateTeachingPresentation({
    chapterBridgeMarkdown: content.chapterBridgeMarkdown,
    priorKnowledge: content.priorKnowledge || [],
    learningObjectives: content.learningObjectives || [],
    fullExplanationMarkdown: content.fullExplanationMarkdown || "",
    mainContentMarkdown: content.mainContentMarkdown || "",
    misconceptions: content.misconceptions || [],
    questions: content.questions || []
  }));
  for (const prior of content.priorKnowledge || []) {
    const label = prior.trim().replace(/^[-*+]\s+/u, "").split("：", 1)[0] ?? "";
    if (/\p{Script=Han}/u.test(label) && !/（[A-Za-z][A-Za-z\s&/,，-]{1,80}）/u.test(label)) {
      issues.push("TEACHING_PRESENTATION:priorKnowledge:TERM_PAIR_MISSING");
    }
  }
  for (const value of content.misconceptions || []) {
    const roles = ["错误理解", "错因", "正确判断", "核对方法"];
    const paragraphs = value.trim().split(/\n\s*\n/u);
    if (paragraphs.length !== roles.length || paragraphs.some((paragraph, index) =>
      !paragraph.startsWith(`**${roles[index]}：** `))) {
      issues.push("TEACHING_PRESENTATION:misconceptions:ROLE_LABEL_MISSING");
    }
  }
  return [...new Set(issues)];
}

export function plannedContentIssues(content: TeachingPackage, input: ModelRouterInput, plan?: TeachingPlan): string[] {
  const issues = schemaIssues(content, teachingPackageSchema);
  if (issues.length) return issues;
  issues.push(...plannedCoverageIssues(content, input.blueprint!, plan));
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
  const resume = input.resumeTeaching?.fingerprint === input.teachingFingerprint ? input.resumeTeaching : undefined;
  const trace: PlannedTrace = resume ? structuredClone(resume.trace)
    : { version: 1, plan: undefined as unknown as TeachingPlan, previousPageContext: input.previousPageContext, phases: [] };
  const jsonRepairs = new Set<string>();
  const save = async (checkpoint: Omit<PlannedCheckpoint, "fingerprint" | "trace">) => {
    if (!input.teachingFingerprint || !input.onTeachingCheckpoint) return;
    const saved: PlannedCheckpoint = { fingerprint: input.teachingFingerprint, ...structuredClone(checkpoint), trace: structuredClone(trace) };
    await input.onTeachingCheckpoint(saved);
    // The configured fallback receives this same request object; it must resume
    // the last committed phase instead of starting a second whole-page attempt.
    input.resumeTeaching = saved;
  };
  const run = async (request: PlannedCall) => {
    await input.onTeachingPhase?.(request.phase, "started");
    let result: Awaited<ReturnType<typeof call>>;
    try { result = await call(request); }
    catch (error) {
      const route = classifyGenerationFailure(error);
      if (route.category === "provider" && route.action === "retry_stage") {
        await new Promise(resolve => setTimeout(resolve, 500));
        result = await call(request);
      } else {
      if (!(error instanceof Error) || error.message !== "MODEL_PROVIDER_OUTPUT_JSON_INVALID" || jsonRepairs.has(request.phase)) throw error;
      const failed = error as Error & { provider?: string; model?: string; usage?: ModelRouterUsage };
      if (failed.provider && failed.model && failed.usage) trace.phases.push({ phase: `${request.phase}_invalid_json`, provider: failed.provider, model: failed.model, usage: failed.usage, attempt: input.generationAttempt });
      jsonRepairs.add(request.phase);
      request = { ...request, phase: `${request.phase}_json_repair`, instructions: `${request.instructions}\n上次返回不是合法 JSON，只返回一个完整 JSON 对象，字符串内换行与反斜杠必须按 JSON 转义，不输出对象外的文字` };
      await input.onTeachingPhase?.(request.phase, "started");
      result = await call(request);
      }
    }
    trace.phases.push({ phase: request.phase, provider: result.provider, model: result.model, usage: result.usage, attempt: input.generationAttempt });
    await input.onTeachingPhase?.(request.phase, "completed", result.usage);
    return result.content;
  };
  const planRequest: PlannedCall = { phase: "plan", instructions: `${planningPrompt}\n\n${writingPolicyInstructions(input.language)}`,
    prompt: JSON.stringify({ title: input.pageTitle, pageNumber: input.pageNumber,
      source: input.sourceText, previousTeaching: input.previousPageContext || "无前页讲解，不假定已有前页知识",
      atomIds: blueprint.resourcePackage.atomIds, requirements: blueprint.requirementPackage.requirements }),
    schema: teachingPlanSchema, image: input.sourceImageDataUrl, maxOutputTokens: 6500 };
  let plan = resume?.plan ?? await run(planRequest) as TeachingPlan;
  let planIssues = validateTeachingPlan(plan, blueprint);
  for (let round = 0; round < 2 && planIssues.length; round++) {
    plan = await run({ ...planRequest, phase: "plan_repair", prompt: JSON.stringify({ originalInput: JSON.parse(planRequest.prompt), currentPlan: plan, issues: planIssues,
      instruction: "只修正列出的问题，保留已正确的事实和步骤；每个来源要求都需对应事实，每个事实都需有讲解位置；每个学习目标至少对应一道题，四道题仍须恰好两道理解题和两道选择题" }) }) as TeachingPlan;
    planIssues = validateTeachingPlan(plan, blueprint);
  }
  if (planIssues.length && planIssues.every(issue => issue.startsWith("PLAN_FACT_UNASSIGNED:"))) {
    plan = assignUnplacedPlanFacts(plan);
    planIssues = validateTeachingPlan(plan, blueprint);
  }
  if (planIssues.length && planIssues.every(issue => issue.startsWith("PLAN_OBJECTIVE_UNTESTED:"))) {
    plan = alignPlanQuestionObjectives(plan);
    planIssues = validateTeachingPlan(plan, blueprint);
  }
  if (planIssues.length) throw new Error(`TEACHING_PLAN_INVALID:${planIssues.join(",")}`);
  trace.plan = plan;
  let content: Partial<TeachingPackage> = resume ? structuredClone(resume.content) : {};
  const completedPhases = resume ? [...resume.completedPhases] : [];
  if (!resume?.plan) await save({ plan, content, completedPhases });
  for (let index = 0; index < fieldsByPhase.length; index++) {
    const fields = fieldsByPhase[index]!;
    const schema = partialSchema(fields);
    const request: PlannedCall = { phase: phases[index]!, instructions: plannedInstructions(fields, input.language),
      prompt: JSON.stringify({ language: input.language, pageTitle: input.pageTitle, plan,
        previousTeaching: index === 0 ? plan.knownStartingPoint : undefined,
        precedingSections: teachingSectionMemory(content), fields,
        coverageRequirements: index === 1 ? blueprint.requirementPackage.requirements : undefined,
        instruction: index === 0 ? "先写承接和先验知识，再从已建立的对象描述学习目标"
          : index === 1 ? "前部知识已讲过，只应用，按计划逐步解释当前课件，不扩写后续章节"
          : "依据实际完整讲解生成总结、辨析和问题，遵守计划题目顺序，不引入正文未讲的结论" }),
      schema, maxOutputTokens: index === 1 ? 9000 : 5000 };
    if (completedPhases.includes(phases[index]!)) continue;
    const pending = resume?.pending;
    const pendingContent = pending && pending.phase === phases[index] ? pending.content : undefined;
    let partial = pendingContent
      ? structuredClone(pendingContent)
      : await run(request) as Partial<TeachingPackage>;
    if (index === 2) {
      partial = normalizePlannedQuestionPunctuation(partial);
      if (partial.misconceptions) partial.misconceptions = partial.misconceptions.map(formatMisconception);
    }
    if (index === 1) partial = bindExactCoverageLines(normalizePlannedSourceIntroductions(partial));
    let issues = schemaIssues(partial, schema);
    if (index === 1 && !issues.length) issues.push(...plannedCoverageIssues(partial as TeachingPackage, blueprint, plan), ...validateMarkdownMath(partial.fullExplanationMarkdown!));
    if (index === 2 && !issues.length) issues.push(...plannedContentIssues({ ...content, ...partial } as TeachingPackage, input, plan));
    if (!issues.length) issues.push(...plannedFormatIssues(partial));
    if (issues.length) await save({ plan, content, completedPhases, pending: { phase: phases[index]!, content: partial, issues } });
    for (let round = 0; round < 2 && issues.length; round++) {
      const tickets = generationRepairTickets(phases[index]!, partial, issues, blueprint.resourcePackage.atomIds);
      if (tickets.length === 0) break;
      for (const ticket of tickets) {
        const patch = await run({ phase: `${request.phase}_repair`,
          instructions: `${plannedInstructions([ticket.field], input.language)}\n${ticket.instruction}`,
          prompt: JSON.stringify({ pageTitle: input.pageTitle, issue: ticket.issues, field: ticket.field,
            currentField: partial[ticket.field], explanation: ticket.field === "coverageEvidence" ? partial.fullExplanationMarkdown : undefined,
            requirements: ticket.field === "coverageEvidence" ? blueprint.requirementPackage.requirements : undefined,
            facts: ticket.field === "coverageEvidence" ? plan.facts : undefined,
            precedingSections: ticket.field === "coverageEvidence" ? undefined : teachingSectionMemory(content) }),
          schema: partialSchema([ticket.field]), maxOutputTokens: ticket.field === "fullExplanationMarkdown" ? 9000 : 3500 }) as Partial<TeachingPackage>;
        try {
          partial = applyGenerationRepair(partial, ticket, patch);
        } catch (error) {
          // A model can return the unchanged field. Keep the last valid checkpoint
          // and let the next bounded round diagnose the real remaining issue.
          if (!(error instanceof Error) || error.message !== "GENERATION_REPAIR_NO_CHANGE") throw error;
        }
        if (index === 2) {
          partial = normalizePlannedQuestionPunctuation(partial);
          if (partial.misconceptions) partial.misconceptions = partial.misconceptions.map(formatMisconception);
        }
        if (index === 1) partial = bindExactCoverageLines(normalizePlannedSourceIntroductions(partial));
        await save({ plan, content, completedPhases, pending: { phase: phases[index]!, content: partial, issues } });
      }
      issues = schemaIssues(partial, schema);
      if (index === 1 && !issues.length) issues.push(...plannedCoverageIssues(partial as TeachingPackage, blueprint, plan), ...validateMarkdownMath(partial.fullExplanationMarkdown!));
      if (index === 2 && !issues.length) issues.push(...plannedContentIssues({ ...content, ...partial } as TeachingPackage, input, plan));
      if (!issues.length) issues.push(...plannedFormatIssues(partial));
      if (issues.length) await save({ plan, content, completedPhases, pending: { phase: phases[index]!, content: partial, issues } });
    }
    if (issues.length) throw new Error(`TEACHING_${request.phase.toUpperCase()}_INVALID:${issues.join(",")}`);
    content = { ...content, ...partial };
    completedPhases.push(phases[index]!);
    await save({ plan, content, completedPhases });
  }
  return { content: content as TeachingPackage, trace };
}
