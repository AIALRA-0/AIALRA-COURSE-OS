import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { TeachingBlueprint } from "@course-os/contracts";
import { formatMisconception, normalizeEnglishTermCase, normalizeHumanReadableChineseMarkdown, normalizePackedTeachingProse, validateHumanReadableChinese, validateMarkdownMath, validateTeachingPresentation } from "@course-os/quality";
import { teachingPackageSchema, writingPolicyInstructions } from "./generation-harness.js";
import { alignPlanQuestionObjectives, assignUnplacedPlanFacts, bindExactCoverageLines, bindMissingPlanFactAtoms, completeTeachingPlanTransport, fillMissingPlanObjectiveText, plannedCoverageIssues, removeUnknownPlanFactReferences, schemaIssues, teachingPlanSchema, teachingSectionMemory, validateTeachingPlan, type TeachingPlan, type TeachingResearchEvidence } from "./teaching-plan.js";
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
  coreFingerprint?: string;
  previousCoreFingerprint?: string;
  phases: Array<{ phase: string; provider: string; model: string; usage: ModelRouterUsage; attempt?: number }>;
  formatWarnings?: Array<{ phase: string; issues: string[] }>;
  researchEvidence?: TeachingResearchEvidence[];
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
  ["priorKnowledge", "learningObjectives"],
  ["fullExplanationMarkdown", "coverageEvidence"],
  ["mainContentMarkdown", "misconceptions", "questions"]
] as const;
const phases = ["opening", "explanation", "consolidation"];
const partialSchema = (fields: readonly string[]) => ({ type: "object", properties: Object.fromEntries(fields.map(field => [field, (teachingPackageSchema.properties as Record<string, unknown>)[field]])), required: fields, additionalProperties: false });
const isFormattingIssue = (issue: string) => issue.startsWith("TEACHING_FORMAT:") || issue.startsWith("TEACHING_PRESENTATION:");
const countPhaseRepairCalls = (trace: PlannedTrace, phase: string) => trace.phases.filter(entry =>
  entry.phase === `${phase}_repair` || entry.phase === `${phase}_repair_invalid_json`).length;

function recordFormatWarnings(trace: PlannedTrace, phase: string, issues: string[]) {
  const formatIssues = issues.filter(isFormattingIssue);
  if (!formatIssues.length) return;
  const existing = trace.formatWarnings?.find(warning => warning.phase === phase);
  if (existing) existing.issues = [...new Set([...existing.issues, ...formatIssues])];
  else (trace.formatWarnings ??= []).push({ phase, issues: [...new Set(formatIssues)] });
}

function normalizeQuestionKind(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const key = value.trim().toLocaleLowerCase().replace(/[\s-]+/gu, "_");
  if (/选择|choice|multiple/u.test(key)) return "multiple_choice";
  if (/理解|comprehension|understanding|short_answer|open_ended/u.test(key)) return "comprehension";
  return value;
}

/**
 * Keep provider formatting drift from blocking an otherwise valid stage
 * result. The schema remains authoritative: unknown keys are removed, while
 * missing required values and invalid values are still rejected by
 * `schemaIssues` below.
 */
export function projectPlannedOutputToSchema(value: unknown, schema: any, phase = ""): unknown {
  let candidate = value;
  if (schema?.type === "object" && candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const entries = Object.entries(candidate as Record<string, unknown>);
    const knownKeys = new Set(Object.keys(schema.properties ?? {}));
    const wrapped = entries.length === 1 && !knownKeys.has(entries[0]![0]) ? entries[0]![1] : undefined;
    if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) candidate = wrapped;
  }
  if (phase.startsWith("plan") && candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const record = candidate as Record<string, unknown>;
    candidate = {
      ...record,
      ...(Array.isArray(record.prerequisites) ? { prerequisites: record.prerequisites.slice(0, 5) } : {}),
      ...(Array.isArray(record.facts) ? { facts: record.facts.map(item => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const fact = item as Record<string, unknown>;
        return {
          ...fact,
          atomId: fact.atomId ?? fact.sourceAtomId ?? fact.sourceAtom ?? fact.atom,
          observation: fact.observation ?? fact.text ?? fact.statement,
          qualification: fact.qualification ?? fact.condition ?? fact.scope ?? ""
        };
      }) } : {}),
      ...(Array.isArray(record.questions) ? { questions: record.questions.map(item => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const question = item as Record<string, unknown>;
        return { ...question, kind: normalizeQuestionKind(question.kind ?? question.type) };
      }) } : {})
    };
  }
  if (schema?.type === "object" && typeof candidate === "string") {
    const keys = Object.keys(schema.properties ?? {});
    if (keys.length === 1) candidate = { [keys[0]!]: candidate };
  }
  if (schema?.type === "object" && candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const original = candidate as Record<string, unknown>;
    const kind = original.kind ?? original.type;
    const record = schema.properties?.kind && kind !== undefined ? { ...original, kind: normalizeQuestionKind(kind) } : original;
    return Object.fromEntries(Object.entries(schema.properties ?? {})
      .filter(([key]) => key in record)
      .map(([key, childSchema]) => [key, projectPlannedOutputToSchema(record[key], childSchema, phase)]));
  }
  if (schema?.type === "array" && typeof candidate === "string" && candidate.trim()) {
    const lines = candidate.split(/\r?\n/u)
      .map(line => line.trim().replace(/^[-*+]\s+/u, "").replace(/^\d+[.)]\s+/u, ""))
      .filter(Boolean);
    const items = lines.length ? lines : [candidate.trim()];
    return items.map(item => projectPlannedOutputToSchema(item, schema.items, phase));
  }
  if (schema?.type === "array" && Array.isArray(candidate)) {
    return candidate.map(item => projectPlannedOutputToSchema(item, schema.items, phase));
  }
  return candidate;
}

/** Mechanical punctuation only; keep the answer text and matching options intact. */
export function normalizePlannedQuestionPunctuation<T extends Partial<TeachingPackage>>(content: T): T {
  if (!Array.isArray(content.questions)) return content;
  const normalizeAnswer = (value: unknown) => typeof value === "string"
    ? normalizePackedTeachingProse(normalizeHumanReadableChineseMarkdown(value)) : value;
  const questions = (content.questions as unknown[]).map(question => {
    if (!question || typeof question !== "object" || Array.isArray(question)) return question;
    const candidate = question as Record<string, unknown>;
    return { ...candidate,
      prompt: normalizeAnswer(candidate.prompt),
      options: Array.isArray(candidate.options) ? candidate.options.map(option => typeof option === "string"
        ? normalizeHumanReadableChineseMarkdown(option) : option) : candidate.options,
      expectedAnswer: candidate.kind === "comprehension" ? normalizeAnswer(candidate.expectedAnswer)
        : typeof candidate.expectedAnswer === "string" ? normalizeHumanReadableChineseMarkdown(candidate.expectedAnswer) : candidate.expectedAnswer,
      explanation: normalizeAnswer(candidate.explanation)
    };
  });
  return { ...content, questions: questions as TeachingPackage["questions"] };
}

export function normalizePlannedSourceIntroductions<T extends Partial<TeachingPackage>>(content: T): T {
  if (typeof content.fullExplanationMarkdown !== "string") return content;
  const introduced = content.fullExplanationMarkdown.replace(/^([ \t]*)原文[：:][ \t]*$/gmu, "$1课件原文如下：");
  return { ...content, fullExplanationMarkdown: normalizePackedTeachingProse(normalizeEnglishTermCase(normalizeHumanReadableChineseMarkdown(introduced))) };
}

/** Apply the same deterministic Chinese typography pass to every opening field. */
export function normalizePlannedOpening<T extends Partial<TeachingPackage>>(content: T): T {
  const normalize = (value: string) => normalizePackedTeachingProse(normalizeEnglishTermCase(normalizeHumanReadableChineseMarkdown(value)));
  const normalized = {
    ...content,
    chapterBridgeMarkdown: typeof content.chapterBridgeMarkdown === "string" ? normalize(content.chapterBridgeMarkdown) : content.chapterBridgeMarkdown,
    priorKnowledge: Array.isArray(content.priorKnowledge) ? content.priorKnowledge.slice(0, 5).map(value => typeof value === "string" ? normalize(value) : value) as string[] : content.priorKnowledge,
    learningObjectives: Array.isArray(content.learningObjectives) ? content.learningObjectives.slice(0, 4).map(value => typeof value === "string" ? normalize(value) : value) as string[] : content.learningObjectives
  } as T;
  if (content.chapterBridgeMarkdown === undefined) delete normalized.chapterBridgeMarkdown;
  if (content.priorKnowledge === undefined) delete normalized.priorKnowledge;
  if (content.learningObjectives === undefined) delete normalized.learningObjectives;
  return normalized;
}

/** Reconcile a provider's omitted transport field with the authoritative requirement package. */
export function normalizePlannedCoverageFields<T extends Partial<TeachingPackage>>(content: T, blueprint: TeachingBlueprint): T {
  if (!Array.isArray(content.coverageEvidence)) return content;
  const required = new Map(blueprint.requirementPackage.requirements.map((item) => [item.atomId, item.requiredFields]));
  const atomIds = new Set(blueprint.resourcePackage.atomIds);
  return {
    ...content,
    coverageEvidence: content.coverageEvidence.map((rawEvidence) => {
      const evidence = rawEvidence as unknown;
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return rawEvidence;
      if ("coveredFields" in evidence && Array.isArray(evidence.coveredFields) && evidence.coveredFields.length > 0) return rawEvidence;
      const atomId = "atomId" in evidence && typeof evidence.atomId === "string" ? evidence.atomId : undefined;
      const fields = atomId ? required.get(atomId) : undefined;
      if (fields?.length) return { ...evidence, coveredFields: [...new Set(fields)] };
      return atomId && atomIds.has(atomId) ? { ...evidence, coveredFields: ["observation"] } : rawEvidence;
    })
  };
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
  const presentationIssues = validateTeachingPresentation({
    chapterBridgeMarkdown: content.chapterBridgeMarkdown,
    priorKnowledge: content.priorKnowledge || [],
    learningObjectives: content.learningObjectives || [],
    fullExplanationMarkdown: content.fullExplanationMarkdown || "",
    mainContentMarkdown: content.mainContentMarkdown || "",
    misconceptions: content.misconceptions || [],
    questions: content.questions || []
  });
  issues.push(...presentationIssues.filter(issue => content.chapterBridgeMarkdown !== undefined
    || !issue.startsWith("TEACHING_PRESENTATION:chapterBridgeMarkdown:")));
  for (const prior of content.priorKnowledge || []) {
    const label = prior.trim().replace(/^[-*+]\s+/u, "").split("：", 1)[0] ?? "";
    if (/\p{Script=Han}/u.test(label) && !/（[A-Za-z][A-Za-z0-9\s&/,，.'’-]{1,80}）/u.test(label)) {
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

function plannedCoreContentIssues(content: Partial<TeachingPackage>, input: ModelRouterInput, plan?: TeachingPlan): string[] {
  const coreFields = ["learningObjectives", "mainContentMarkdown", "priorKnowledge", "fullExplanationMarkdown",
    "misconceptions", "coverageEvidence", "questions"] as const;
  const issues = schemaIssues(content, partialSchema(coreFields));
  if (issues.length) return issues;
  const complete = content as TeachingPackage;
  issues.push(...plannedCoverageIssues(complete, input.blueprint!, plan));
  const values = [...complete.priorKnowledge, ...complete.learningObjectives, complete.fullExplanationMarkdown,
    complete.mainContentMarkdown, ...complete.misconceptions,
    ...complete.questions.flatMap(question => [question.prompt, ...question.options || [], question.expectedAnswer, question.explanation])];
  for (const text of values) issues.push(...validateMarkdownMath(text));
  if (complete.questions.filter(question => question.kind === "comprehension").length !== 2) issues.push("PLAN_QUESTION_MIX");
  for (const question of complete.questions) {
    const options = question.options || [];
    if (question.kind === "comprehension" ? options.length !== 0
      : options.length !== 4 || new Set(options).size !== 4 || !options.includes(question.expectedAnswer)) issues.push("PLAN_QUESTION_ANSWER_INVALID");
  }
  return [...new Set(issues)];
}

/** Bounded core calls followed by one dependency-aware bridge call; no audit loop. */
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
    return projectPlannedOutputToSchema(result.content, request.schema, request.phase);
  };
  const planRequest: PlannedCall = { phase: "plan", instructions: `${planningPrompt}\n\n${writingPolicyInstructions(input.language)}\n\n外部检索不是固定步骤。只有课件来源不足以核实正式术语、外部方法或时效性事实，且 externalSearchAvailable 为 true 时，才填写最多两项 researchQueries，并为每项选择 web、academic、terminology 或 temporal 类型；课件已经给出的事实、公式推导和页面之间的承接不得检索。没有真实缺口时省略 researchQueries 或返回空数组`,
    prompt: JSON.stringify({ title: input.pageTitle, pageNumber: input.pageNumber,
      source: input.sourceText, previousTeaching: "正文核心独立生成，不读取前页；只根据本页来源建立教学结构",
      atomIds: blueprint.resourcePackage.atomIds, requirements: blueprint.requirementPackage.requirements,
      externalSearchAvailable: Boolean(input.searchEvidence) }),
    schema: teachingPlanSchema, image: input.sourceImageDataUrl, maxOutputTokens: 6500 };
  const normalizePlan = (value: unknown) => alignPlanQuestionObjectives(fillMissingPlanObjectiveText(assignUnplacedPlanFacts(
    removeUnknownPlanFactReferences(bindMissingPlanFactAtoms(completeTeachingPlanTransport(value, blueprint), blueprint)))));
  let plan = resume?.plan ?? normalizePlan(await run(planRequest));
  let planIssues = validateTeachingPlan(plan, blueprint);
  for (let round = 0; round < 2 && planIssues.length; round++) {
    const repairedPlan = await run({ ...planRequest, phase: "plan_repair", prompt: JSON.stringify({ originalInput: JSON.parse(planRequest.prompt), currentPlan: plan, issues: planIssues,
      instruction: "只修正列出的问题，保留已正确的事实和步骤；可以只返回需要替换的顶层字段；每个来源要求都需对应事实，每个事实都需有讲解位置；每个学习目标至少对应一道题，四道题仍须恰好两道理解题和两道选择题" }) }) as Partial<TeachingPlan>;
    plan = normalizePlan({ ...plan, ...repairedPlan });
    planIssues = validateTeachingPlan(plan, blueprint);
  }
  if (planIssues.some(issue => issue.startsWith("PLAN_FACT_UNASSIGNED:"))) {
    plan = assignUnplacedPlanFacts(plan);
    planIssues = validateTeachingPlan(plan, blueprint);
  }
  if (planIssues.some(issue => issue.startsWith("PLAN_OBJECTIVE_UNTESTED:"))) {
    plan = alignPlanQuestionObjectives(plan);
    planIssues = validateTeachingPlan(plan, blueprint);
  }
  if (planIssues.length) {
    trace.plan = plan;
    await save({ plan, content: {}, completedPhases: [] });
    throw new Error(`TEACHING_PLAN_INVALID:${planIssues.join(",")}`);
  }
  trace.plan = plan;
  let content: Partial<TeachingPackage> = resume ? structuredClone(resume.content) : {};
  const completedPhases = resume ? [...resume.completedPhases] : [];
  if ((plan.researchQueries?.length ?? 0) > 0 && !trace.researchEvidence?.length && input.searchEvidence) {
    trace.researchEvidence = await input.searchEvidence(plan.researchQueries ?? []);
  }
  if (!resume?.plan) await save({ plan, content, completedPhases });
  for (let index = 0; index < fieldsByPhase.length; index++) {
    const fields = fieldsByPhase[index]!;
    const schema = partialSchema(fields);
    const request: PlannedCall = { phase: phases[index]!, instructions: plannedInstructions(fields, input.language),
      prompt: JSON.stringify({ language: input.language, pageTitle: input.pageTitle, plan,
        // Only the explanation phase may see candidate external background.
        // Opening and consolidation remain derived from SOURCE and taught text.
        externalEvidence: index === 1 ? trace.researchEvidence : undefined,
        previousTeaching: index === 0 ? plan.knownStartingPoint : undefined,
        precedingSections: teachingSectionMemory(content), fields,
        coverageRequirements: index === 1 ? blueprint.requirementPackage.requirements : undefined,
        externalEvidenceRule: index === 1 && trace.researchEvidence?.length
          ? "搜索摘要只是候选外部背景，不是已核实的课件来源。只能在明确标注为外部背景时谨慎使用，并保留标题、网址和提供方；不得覆盖 SOURCE，不得写成课件原文或确定事实，证据不足时必须保留不确定性"
          : undefined,
        instruction: index === 0 ? "只写先验知识和学习目标；从学习者已经具备的日常理解自然引入本页对象，不编写前页回顾或承接段"
          : index === 1 ? "前部知识已讲过，只应用，按计划逐步解释当前课件，不扩写后续章节；搜索摘要仅是候选外部背景，不能冒充 SOURCE"
          : "依据实际完整讲解生成总结、辨析和问题，遵守计划题目顺序，不引入正文未讲的结论" }),
      schema, maxOutputTokens: index === 1 ? 9000 : 5000 };
    if (completedPhases.includes(phases[index]!)) continue;
    const pending = resume?.pending;
    const pendingContent = pending && pending.phase === phases[index] ? pending.content : undefined;
    let partial = pendingContent
      ? structuredClone(pendingContent)
      : await run(request) as Partial<TeachingPackage>;
    if (index === 0) partial = normalizePlannedOpening(partial);
    if (index === 2) {
      partial = normalizePlannedQuestionPunctuation(partial);
      if (Array.isArray(partial.misconceptions)) partial.misconceptions = partial.misconceptions
        .map(value => typeof value === "string" ? formatMisconception(value) : value) as string[];
    }
    if (index === 1) partial = bindExactCoverageLines(normalizePlannedCoverageFields(normalizePlannedSourceIntroductions(partial), blueprint));
    let issues = schemaIssues(partial, schema);
    if (index === 1 && !issues.length) issues.push(...plannedCoverageIssues(partial as TeachingPackage, blueprint, plan), ...validateMarkdownMath(partial.fullExplanationMarkdown!));
    if (index === 2 && !issues.length) issues.push(...plannedCoreContentIssues({ ...content, ...partial }, input, plan));
    if (!issues.length) issues.push(...plannedFormatIssues(partial));
    if (issues.length) await save({ plan, content, completedPhases, pending: { phase: phases[index]!, content: partial, issues } });
    let repairCalls = countPhaseRepairCalls(trace, phases[index]!);
    for (let round = 0; round < 2 && issues.length && repairCalls < 2; round++) {
      const tickets = generationRepairTickets(phases[index]!, partial, issues, blueprint.resourcePackage.atomIds);
      if (tickets.length === 0) break;
      for (const ticket of tickets) {
        if (repairCalls >= 2) break;
        const patch = await run({ phase: `${request.phase}_repair`,
          instructions: `${plannedInstructions([ticket.field], input.language)}\n${ticket.instruction}`,
          prompt: JSON.stringify({ pageTitle: input.pageTitle, issue: ticket.issues, field: ticket.field,
            currentField: partial[ticket.field], explanation: ticket.field === "coverageEvidence" ? partial.fullExplanationMarkdown : undefined,
            requirements: ticket.field === "coverageEvidence" ? blueprint.requirementPackage.requirements : undefined,
            facts: ticket.field === "coverageEvidence" ? plan.facts : undefined,
            precedingSections: ticket.field === "coverageEvidence" ? undefined : teachingSectionMemory(content) }),
          schema: partialSchema([ticket.field]), maxOutputTokens: ticket.field === "fullExplanationMarkdown" ? 9000 : 3500 }) as Partial<TeachingPackage>;
        repairCalls++;
        const candidateWasSchemaValid = schemaIssues(partial, schema).length === 0;
        let repaired: Partial<TeachingPackage> | undefined;
        try {
          repaired = applyGenerationRepair(partial, ticket, patch);
        } catch (error) {
          // A model can return the unchanged field. Keep the last valid checkpoint
          // and let the next bounded round diagnose the real remaining issue.
          if (!(error instanceof Error) || error.message !== "GENERATION_REPAIR_NO_CHANGE") throw error;
        }
        if (repaired) {
          if (index === 2) {
            repaired = normalizePlannedQuestionPunctuation(repaired);
            if (Array.isArray(repaired.misconceptions)) repaired.misconceptions = repaired.misconceptions
              .map(value => typeof value === "string" ? formatMisconception(value) : value) as string[];
          }
          if (index === 0) repaired = normalizePlannedOpening(repaired);
          if (index === 1) repaired = bindExactCoverageLines(normalizePlannedCoverageFields(normalizePlannedSourceIntroductions(repaired), blueprint));
          // A field repair must not turn a schema-valid phase into an invalid one.
          if (!candidateWasSchemaValid || schemaIssues(repaired, schema).length === 0) partial = repaired;
        }
        await save({ plan, content, completedPhases, pending: { phase: phases[index]!, content: partial, issues } });
      }
      issues = schemaIssues(partial, schema);
      if (index === 1 && !issues.length) issues.push(...plannedCoverageIssues(partial as TeachingPackage, blueprint, plan), ...validateMarkdownMath(partial.fullExplanationMarkdown!));
      if (index === 2 && !issues.length) issues.push(...plannedCoreContentIssues({ ...content, ...partial }, input, plan));
      if (!issues.length) issues.push(...plannedFormatIssues(partial));
      if (issues.length) await save({ plan, content, completedPhases, pending: { phase: phases[index]!, content: partial, issues } });
    }
    if (issues.length && !issues.every(isFormattingIssue)) throw new Error(`TEACHING_${request.phase.toUpperCase()}_INVALID:${issues.join(",")}`);
    recordFormatWarnings(trace, phases[index]!, issues);
    content = { ...content, ...partial };
    completedPhases.push(phases[index]!);
    await save({ plan, content, completedPhases });
  }

  const coreFingerprint = createHash("sha256").update(JSON.stringify({
    learningObjectives: content.learningObjectives,
    priorKnowledge: content.priorKnowledge,
    fullExplanationMarkdown: content.fullExplanationMarkdown,
    mainContentMarkdown: content.mainContentMarkdown,
    misconceptions: content.misconceptions,
    coverageEvidence: content.coverageEvidence,
    questions: content.questions
  })).digest("hex");
  trace.coreFingerprint = coreFingerprint;
  const previous = input.resolvePreviousPageContext
    ? await input.resolvePreviousPageContext()
    : { context: input.previousPageContext, fingerprint: input.previousPageContext
      ? createHash("sha256").update(input.previousPageContext).digest("hex") : undefined };
  const dependencyChanged = completedPhases.includes("bridge")
    && trace.previousCoreFingerprint !== previous.fingerprint;
  if (dependencyChanged) {
    completedPhases.splice(completedPhases.indexOf("bridge"), 1);
    delete content.chapterBridgeMarkdown;
  }
  trace.previousPageContext = previous.context;
  trace.previousCoreFingerprint = previous.fingerprint;
  if (!completedPhases.includes("bridge")) {
    const fields = ["chapterBridgeMarkdown"] as const;
    const schema = partialSchema(fields);
    const request: PlannedCall = {
      phase: "bridge",
      instructions: plannedInstructions(fields, input.language),
      prompt: JSON.stringify({
        language: input.language,
        pageTitle: input.pageTitle,
        previousTeaching: previous.context || "这是当前材料的第一页；从课程主题和本页要解决的问题自然起步，不虚构上一页",
        currentPageCore: teachingSectionMemory(content),
        fields,
        instruction: "只写承上启下段。先用自然中文准确回收前页已经讲清的知识，再指出本页接着解决的问题；不得重复本页完整讲解，不得引入来源外的新结论；独立问题分行，中英文与标点严格遵守写作策略"
      }),
      schema,
      maxOutputTokens: 2600
    };
    let partial = normalizePlannedOpening(await run(request) as Partial<TeachingPackage>);
    let issues = [...schemaIssues(partial, schema), ...plannedFormatIssues(partial)];
    let repairCalls = countPhaseRepairCalls(trace, "bridge");
    for (let round = 0; round < 2 && issues.length && repairCalls < 2; round++) {
      const tickets = generationRepairTickets("bridge", partial, issues, blueprint.resourcePackage.atomIds);
      if (tickets.length === 0) break;
      for (const ticket of tickets) {
        if (repairCalls >= 2) break;
        const patch = await run({
          phase: "bridge_repair",
          instructions: `${plannedInstructions([ticket.field], input.language)}\n${ticket.instruction}`,
          prompt: JSON.stringify({ pageTitle: input.pageTitle, issue: ticket.issues, field: ticket.field,
            currentField: partial[ticket.field], previousTeaching: previous.context,
            currentPageCore: teachingSectionMemory(content) }),
          schema: partialSchema([ticket.field]),
          maxOutputTokens: 2600
        }) as Partial<TeachingPackage>;
        repairCalls++;
        const candidateWasSchemaValid = schemaIssues(partial, schema).length === 0;
        try {
          const repaired = normalizePlannedOpening(applyGenerationRepair(partial, ticket, patch));
          // Keep the last valid candidate if a formatting patch damages its schema.
          if (!candidateWasSchemaValid || schemaIssues(repaired, schema).length === 0) partial = repaired;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "GENERATION_REPAIR_NO_CHANGE") throw error;
        }
      }
      issues = [...schemaIssues(partial, schema), ...plannedFormatIssues(partial)];
    }
    if (issues.length && !issues.every(isFormattingIssue)) throw new Error(`TEACHING_BRIDGE_INVALID:${issues.join(",")}`);
    recordFormatWarnings(trace, "bridge", issues);
    content = { ...content, ...partial };
    completedPhases.push("bridge");
    await save({ plan, content, completedPhases });
  }
  const finalIssues = plannedContentIssues(content as TeachingPackage, input, plan);
  if (finalIssues.length) throw new Error(`TEACHING_BRIDGE_INVALID:${finalIssues.join(",")}`);
  return { content: content as TeachingPackage, trace };
}
