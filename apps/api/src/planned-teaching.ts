import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { formatMisconception, normalizeEnglishTermCase, normalizeHumanReadableChineseMarkdown, normalizePackedTeachingProse, validateHumanReadableChinese, validateTeachingPresentation } from "@course-os/quality";
import { teachingPackageSchema, writingPolicyInstructions } from "./generation-harness.js";
import type { ModelRouterInput, ModelRouterUsage, TeachingPackage } from "./model-router.js";
import type { TeachingPlan } from "./teaching-plan.js";

const invalidProviderOutputs = new WeakMap<Error, string>();
const MAX_INVALID_PROVIDER_OUTPUT_CHARS = 12_000;

/** Keep malformed provider text transient and out of enumerable errors and traces. */
export function rememberInvalidProviderOutput(error: Error, output: unknown): void {
  if (typeof output === "string" && output) invalidProviderOutputs.set(error, output.slice(0, MAX_INVALID_PROVIDER_OUTPUT_CHARS));
}

export function transientInvalidProviderOutput(error: Error): string | undefined {
  return invalidProviderOutputs.get(error);
}

const readPrompt = (name: string) => readFileSync(new URL("../../../config/generation-harness/" + name, import.meta.url), "utf8");
export const planningPrompt = readPrompt("page-plan-prompt.md");
export const plannedWritingPrompt = readPrompt("planned-writing-prompt.md");
export const writingFormatContract = readPrompt("writing-format-contract.md");

export function plannedInstructions(_fields: readonly string[], language = "zh-CN"): string {
  const completePolicy = writingPolicyInstructions(language);
  return plannedWritingPrompt + "\n\n" + writingFormatContract
    + (completePolicy ? "\n\n---\n\n" + completePolicy : "");
}

export interface PlannedCall {
  phase: string;
  instructions: string;
  prompt: string;
  maxOutputTokens: number;
  schema?: Record<string, unknown>;
  image?: string;
}

export interface PlannedPhaseReceipt {
  phase: string;
  provider: string;
  model: string;
  usage: ModelRouterUsage;
  attempt?: number;
}

export interface PlannedTrace {
  version: 1;
  plan: string;
  phases: PlannedPhaseReceipt[];
  formatWarnings?: Array<{ phase: string; issues: string[] }>;
  qualityWarnings?: Array<{ phase: string; issues: string[] }>;
  coreFingerprint?: string;
}

/** The historical checkpoint shape remains readable for persisted records. */
export interface PlannedCheckpoint {
  fingerprint: string;
  plan?: TeachingPlan;
  content: Partial<TeachingPackage>;
  completedPhases: string[];
  pending?: { phase: string; content: Partial<TeachingPackage>; issues: string[] };
  trace: {
    version: 1;
    plan: TeachingPlan;
    previousPageContext?: string;
    previousCoreFingerprint?: string;
    coreFingerprint?: string;
    phases: PlannedPhaseReceipt[];
    formatWarnings?: Array<{ phase: string; issues: string[] }>;
    researchEvidence?: unknown[];
  };
}

function normalizeQuestionKind(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const key = value.trim().toLocaleLowerCase().replace(/[\s-]+/gu, "_");
  if (/选择|choice|multiple/u.test(key)) return "multiple_choice";
  if (/理解|comprehension|understanding|short_answer|open_ended/u.test(key)) return "comprehension";
  return value;
}

/** Project harmless provider wrappers and aliases into a requested JSON shape. */
export function projectPlannedOutputToSchema(value: unknown, schema: any, _phase = ""): unknown {
  let candidate = value;
  const keys = Object.keys(schema?.properties ?? {});
  const onlyField = schema?.type === "object" && keys.length === 1 ? keys[0] : undefined;
  if (onlyField && schema.properties[onlyField]?.type === "array") {
    if (Array.isArray(candidate)) candidate = { [onlyField]: candidate };
    else if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const entries = Object.entries(candidate as Record<string, unknown>);
      if (entries.length === 1 && entries[0]![0] !== onlyField && Array.isArray(entries[0]![1])) {
        candidate = { [onlyField]: entries[0]![1] };
      }
    }
  }
  if (schema?.type === "object" && typeof candidate === "string" && keys.length === 1) {
    candidate = { [keys[0]!]: candidate };
  }
  if (schema?.type === "object" && candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const entries = Object.entries(candidate as Record<string, unknown>);
    const knownKeys = new Set(keys);
    if (entries.length === 1 && !knownKeys.has(entries[0]![0])
      && entries[0]![1] && typeof entries[0]![1] === "object" && !Array.isArray(entries[0]![1])) {
      candidate = entries[0]![1];
    }
  }
  if (schema?.type === "object" && candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const record = candidate as Record<string, unknown>;
    const normalized = schema.properties?.kind ? {
      ...record,
      kind: normalizeQuestionKind(record.kind ?? record.type),
      prompt: record.prompt ?? record.question ?? record.stem,
      options: record.options ?? record.choices,
      expectedAnswer: record.expectedAnswer ?? record.answer ?? record.correctAnswer,
      explanation: record.explanation ?? record.rationale ?? record.reason
    } : schema.properties?.fullExplanationMarkdown ? {
      ...record,
      chapterBridgeMarkdown: record.chapterBridgeMarkdown ?? record.chapterBridge ?? "",
      learningObjectives: record.learningObjectives ?? record.objectives ?? [],
      ...((record.mainContentMarkdown ?? record.mainContent ?? record.summary) !== undefined
        ? { mainContentMarkdown: record.mainContentMarkdown ?? record.mainContent ?? record.summary } : {}),
      priorKnowledge: record.priorKnowledge ?? record.prerequisites ?? [],
      ...((record.fullExplanationMarkdown ?? record.fullExplanation ?? record.explanation) !== undefined
        ? { fullExplanationMarkdown: record.fullExplanationMarkdown ?? record.fullExplanation ?? record.explanation } : {}),
      misconceptions: record.misconceptions ?? record.commonMistakes ?? [],
      coverageEvidence: record.coverageEvidence ?? [],
      questions: record.questions ?? []
    } : record;
    return Object.fromEntries(Object.entries(schema.properties ?? {})
      .filter(([key]) => key in normalized)
      .map(([key, childSchema]) => [key, projectPlannedOutputToSchema(normalized[key], childSchema)]));
  }
  if (schema?.type === "array" && typeof candidate === "string" && candidate.trim()) {
    const items = candidate.split(/\r?\n/u).map(line =>
      line.trim().replace(/^[-*+]\s+/u, "").replace(/^\d+[.)]\s+/u, "")).filter(Boolean);
    return (items.length ? items : [candidate.trim()])
      .map(item => projectPlannedOutputToSchema(item, schema.items));
  }
  if (schema?.type === "array" && Array.isArray(candidate)) {
    return candidate.map(item => projectPlannedOutputToSchema(item, schema.items));
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
    return {
      ...candidate,
      prompt: normalizeAnswer(candidate.prompt),
      options: Array.isArray(candidate.options) ? candidate.options.map(option =>
        typeof option === "string" ? normalizeHumanReadableChineseMarkdown(option) : option) : candidate.options,
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
  return {
    ...content,
    fullExplanationMarkdown: normalizePackedTeachingProse(
      normalizeEnglishTermCase(normalizeHumanReadableChineseMarkdown(introduced)))
  };
}

/** Apply the deterministic typography pass to the fields normalized by the old opening stage. */
export function normalizePlannedOpening<T extends Partial<TeachingPackage>>(content: T): T {
  const normalize = (value: string) =>
    normalizePackedTeachingProse(normalizeEnglishTermCase(normalizeHumanReadableChineseMarkdown(value)));
  const normalized = {
    ...content,
    chapterBridgeMarkdown: typeof content.chapterBridgeMarkdown === "string" ? normalize(content.chapterBridgeMarkdown) : content.chapterBridgeMarkdown,
    priorKnowledge: Array.isArray(content.priorKnowledge)
      ? content.priorKnowledge.slice(0, 5).map(value => typeof value === "string" ? normalize(value) : value) as string[]
      : content.priorKnowledge,
    learningObjectives: Array.isArray(content.learningObjectives)
      ? content.learningObjectives.slice(0, 4).map(value => typeof value === "string" ? normalize(value) : value) as string[]
      : content.learningObjectives
  } as T;
  if (content.chapterBridgeMarkdown === undefined) delete normalized.chapterBridgeMarkdown;
  if (content.priorKnowledge === undefined) delete normalized.priorKnowledge;
  if (content.learningObjectives === undefined) delete normalized.learningObjectives;
  return normalized;
}

const schemaObject = teachingPackageSchema as Record<string, any>;
const schemaProperties = schemaObject.properties as Record<string, any>;

/** Machine shape only: required fields and JSON types, with nonempty core body text. */
function machineShapeIssues(value: unknown, schema: any, path = "result"): string[] {
  if (schema?.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [path + ":object"];
    const record = value as Record<string, unknown>;
    return [
      ...(schema.required ?? []).filter((key: string) => !(key in record)).map((key: string) => path + "." + key + ":required"),
      ...Object.keys(record).flatMap(key => schema.properties?.[key]
        ? machineShapeIssues(record[key], schema.properties[key], path + "." + key)
        : schema.additionalProperties === false ? [path + "." + key + ":unknown"] : [])
    ];
  }
  if (schema?.type === "array") {
    if (!Array.isArray(value)) return [path + ":array"];
    return value.flatMap((item, index) => machineShapeIssues(item, schema.items, path + "." + index));
  }
  if (schema?.type === "string") {
    if (typeof value !== "string") return [path + ":string"];
    return schema.enum && !schema.enum.includes(value) ? [path + ":enum"] : [];
  }
  if (schema?.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return [path + ":number"];
  if (schema?.type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) return [path + ":integer"];
  if (schema?.type === "boolean" && typeof value !== "boolean") return [path + ":boolean"];
  if (schema?.enum && !schema.enum.includes(value)) return [path + ":enum"];
  return [];
}

function coreBodyIssues(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  return (["mainContentMarkdown", "fullExplanationMarkdown"] as const).flatMap(field =>
    typeof record[field] === "string" && record[field].trim() ? [] : ["result." + field + ":empty"]);
}

export function plannedFormatIssues(content: Partial<TeachingPackage>): string[] {
  const questions = Array.isArray(content.questions) ? content.questions : [];
  const visible: Partial<Record<keyof TeachingPackage, unknown[]>> = {
    chapterBridgeMarkdown: typeof content.chapterBridgeMarkdown === "string" ? [content.chapterBridgeMarkdown] : undefined,
    priorKnowledge: Array.isArray(content.priorKnowledge) ? content.priorKnowledge : undefined,
    learningObjectives: Array.isArray(content.learningObjectives) ? content.learningObjectives : undefined,
    fullExplanationMarkdown: typeof content.fullExplanationMarkdown === "string" ? [content.fullExplanationMarkdown] : undefined,
    mainContentMarkdown: typeof content.mainContentMarkdown === "string" ? [content.mainContentMarkdown] : undefined,
    misconceptions: Array.isArray(content.misconceptions) ? content.misconceptions : undefined,
    questions: questions.flatMap(question => question && typeof question === "object"
      ? [question.prompt, ...(Array.isArray(question.options) ? question.options : []), question.expectedAnswer, question.explanation]
      : [])
  };
  const issues = Object.entries(visible).flatMap(([field, values]) => (values || []).flatMap(value =>
    typeof value === "string" ? validateHumanReadableChinese(value).map(issue => "TEACHING_FORMAT:" + field + ":" + issue) : []));
  const presentationQuestions = questions.filter(question => question && typeof question === "object");
  const presentationIssues = validateTeachingPresentation({
    chapterBridgeMarkdown: content.chapterBridgeMarkdown ?? "",
    priorKnowledge: (Array.isArray(content.priorKnowledge) ? content.priorKnowledge : []).filter((value): value is string => typeof value === "string"),
    learningObjectives: (Array.isArray(content.learningObjectives) ? content.learningObjectives : []).filter((value): value is string => typeof value === "string"),
    fullExplanationMarkdown: typeof content.fullExplanationMarkdown === "string" ? content.fullExplanationMarkdown : "",
    mainContentMarkdown: typeof content.mainContentMarkdown === "string" ? content.mainContentMarkdown : "",
    misconceptions: (Array.isArray(content.misconceptions) ? content.misconceptions : []).filter((value): value is string => typeof value === "string"),
    questions: presentationQuestions as TeachingPackage["questions"]
  });
  issues.push(...presentationIssues);
  for (const prior of (Array.isArray(content.priorKnowledge) ? content.priorKnowledge : []).filter((value): value is string => typeof value === "string")) {
    const label = prior.trim().replace(/^[-*+]\s+/u, "").split("：", 1)[0] ?? "";
    if (/\p{Script=Han}/u.test(label) && !/（[A-Za-z][A-Za-z0-9\s&/,，.'’-]{1,80}）/u.test(label)) {
      issues.push("TEACHING_PRESENTATION:priorKnowledge:TERM_PAIR_MISSING");
    }
  }
  for (const value of (Array.isArray(content.misconceptions) ? content.misconceptions : []).filter((item): item is string => typeof item === "string")) {
    const roles = ["错误理解", "错因", "正确判断", "核对方法"];
    const paragraphs = value.trim().split(/\n\s*\n/u);
    if (paragraphs.length !== roles.length || paragraphs.some((paragraph, index) =>
      !paragraph.startsWith("**" + roles[index] + "：** "))) {
      issues.push("TEACHING_PRESENTATION:misconceptions:ROLE_LABEL_MISSING");
    }
  }
  return [...new Set(issues)];
}

/** Kept for app callers; this export intentionally checks structure, not lesson quality or coverage. */
export function plannedContentIssues(content: unknown, _input?: ModelRouterInput, _plan?: TeachingPlan): string[] {
  return [...machineShapeIssues(content, schemaObject), ...coreBodyIssues(content)];
}

interface CallResult {
  content: unknown;
  provider?: string;
  model?: string;
  usage?: ModelRouterUsage;
}

function unpackCallResult(value: unknown): CallResult {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const hasReceipt = "provider" in record || "model" in record || "usage" in record;
    if ("content" in record && hasReceipt) {
      return {
        content: record.content,
        ...(typeof record.provider === "string" ? { provider: record.provider } : {}),
        ...(typeof record.model === "string" ? { model: record.model } : {}),
        ...(record.usage && typeof record.usage === "object" ? { usage: record.usage as ModelRouterUsage } : {})
      };
    }
  }
  return { content: value };
}

function parseTeachingOutput(value: unknown): { content?: unknown; raw?: string; issue?: string } {
  if (typeof value === "string") {
    try {
      return { content: JSON.parse(value) };
    } catch {
      return { raw: value, issue: "result:json" };
    }
  }
  return { content: value };
}

function normalizeTeachingOutput(value: unknown): TeachingPackage {
  const projected = projectPlannedOutputToSchema(value, teachingPackageSchema, "teaching");
  if (!projected || typeof projected !== "object" || Array.isArray(projected)) return projected as TeachingPackage;
  let normalized = normalizePlannedOpening(normalizePlannedQuestionPunctuation(
    normalizePlannedSourceIntroductions(projected as Partial<TeachingPackage>)));
  if (Array.isArray(normalized.misconceptions)) {
    normalized = {
      ...normalized,
      misconceptions: normalized.misconceptions.map(value =>
        typeof value === "string" ? formatMisconception(value) : value)
    };
  }
  return {
    ...normalized,
    chapterBridgeMarkdown: normalized.chapterBridgeMarkdown === undefined ? "" : normalized.chapterBridgeMarkdown,
    coverageEvidence: normalized.coverageEvidence === undefined ? [] : normalized.coverageEvidence,
    questions: normalized.questions === undefined ? [] : normalized.questions
  } as TeachingPackage;
}

/** Keep the model's valid lesson text when one malformed question survives the single repair. */
function salvageFinalTeachingPackage(
  initial: TeachingPackage | undefined, repaired: TeachingPackage | undefined
): TeachingPackage | undefined {
  const usable = (value: unknown): value is string => typeof value === "string" && !!value.trim();
  const mainContent = [repaired?.mainContentMarkdown, initial?.mainContentMarkdown].find(usable);
  const explanation = [repaired?.fullExplanationMarkdown, initial?.fullExplanationMarkdown].find(usable);
  if (!mainContent && !explanation) return undefined;
  const candidate = { ...initial, ...repaired } as TeachingPackage;
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string") : [];
  const validItems = <T>(value: unknown, schema: unknown): T[] => Array.isArray(value)
    ? value.filter(item => machineShapeIssues(item, schema).length === 0) as T[] : [];
  return {
    ...candidate,
    mainContentMarkdown: mainContent ?? explanation!.split(/\n\s*\n/u).filter(Boolean).slice(0, 3).join("\n\n"),
    fullExplanationMarkdown: explanation ?? mainContent!,
    chapterBridgeMarkdown: typeof candidate.chapterBridgeMarkdown === "string" ? candidate.chapterBridgeMarkdown : "",
    learningObjectives: strings(candidate.learningObjectives),
    priorKnowledge: strings(candidate.priorKnowledge),
    misconceptions: strings(candidate.misconceptions),
    coverageEvidence: validItems(candidate.coverageEvidence, schemaProperties.coverageEvidence.items),
    questions: validItems(candidate.questions, schemaProperties.questions.items)
  };
}

function recordFormatWarnings(trace: PlannedTrace, issues: string[]): void {
  if (issues.length) trace.formatWarnings = [{ phase: "teaching", issues: [...new Set(issues)] }];
}

function recordQualityWarnings(trace: PlannedTrace, content: TeachingPackage): void {
  const issues: string[] = [];
  if (content.fullExplanationMarkdown.length < 120) issues.push("TEACHING_QUALITY:EXPLANATION_SHORT");
  if (content.questions.length !== 4) issues.push("TEACHING_QUALITY:QUESTION_COUNT:" + content.questions.length);
  if (issues.length) trace.qualityWarnings = [{ phase: "teaching", issues }];
}

function outputAsPlanText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** One freeform planning call, one full-package call, and at most one format repair. */
export async function writePlannedLesson(
  input: ModelRouterInput,
  call: (request: PlannedCall) => Promise<unknown>
): Promise<{ content: TeachingPackage; trace: PlannedTrace }> {
  const trace: PlannedTrace = { version: 1, plan: "", phases: [] };
  const run = async (request: PlannedCall): Promise<CallResult> => {
    await input.onTeachingPhase?.(request.phase, "started");
    const result = unpackCallResult(await call(request));
    trace.phases.push({
      phase: request.phase,
      provider: result.provider ?? "unknown",
      model: result.model ?? "unknown",
      usage: result.usage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, apiEquivalentUsd: null, durationMs: 0 },
      ...(input.generationAttempt !== undefined ? { attempt: input.generationAttempt } : {})
    });
    await input.onTeachingPhase?.(request.phase, "completed", result.usage);
    return result;
  };

  const suppliedPlan = (input as ModelRouterInput & { teachingPlan?: string }).teachingPlan;
  if (typeof suppliedPlan === "string") {
    trace.plan = suppliedPlan;
  } else {
    const planResult = await run({
      phase: "plan",
      instructions: planningPrompt,
      prompt: JSON.stringify({ title: input.pageTitle, source: input.sourceText }),
      maxOutputTokens: 2500,
      ...(input.sourceImageDataUrl ? { image: input.sourceImageDataUrl } : {})
    });
    trace.plan = outputAsPlanText(planResult.content);
  }

  const fields = Object.keys(schemaProperties);
  const teachingRequest: PlannedCall = {
    phase: "teaching",
    instructions: plannedInstructions(fields, input.language)
      + "\n\n本次只生成核心教学包。chapterBridgeMarkdown 必须是空字符串。计划只用于安排讲解顺序，不是事实来源；事实、公式、数字、条件和边界以 SOURCE 为准，计划与 SOURCE 不一致时舍弃计划内容。",
    prompt: JSON.stringify({
      language: input.language,
      pageTitle: input.pageTitle,
      pageNumber: input.pageNumber,
      source: input.sourceText,
      teachingPlan: trace.plan,
      planUse: "仅用于安排讲解顺序，不是事实来源",
      sourceAuthority: "事实、公式、数字、条件和边界以本页课件来源为准",
      chapterBridgeMarkdown: ""
    }),
    schema: teachingPackageSchema,
    maxOutputTokens: 15_000,
    ...(input.sourceImageDataUrl ? { image: input.sourceImageDataUrl } : {})
  };

  let initialRaw: unknown;
  try {
    initialRaw = (await run(teachingRequest)).content;
  } catch (error) {
    const recoverable = error instanceof Error ? transientInvalidProviderOutput(error) : undefined;
    if (recoverable === undefined) throw error;
    initialRaw = recoverable;
  }

  const initialParsed = parseTeachingOutput(initialRaw);
  const initialCandidate = initialParsed.issue ? undefined : normalizeTeachingOutput(initialParsed.content);
  const initialShapeIssues = initialParsed.issue
    ? [initialParsed.issue]
    : plannedContentIssues(initialCandidate as TeachingPackage);
  const initialFormatIssues = initialShapeIssues.length === 0
    ? plannedFormatIssues(initialCandidate as TeachingPackage) : [];
  let accepted = initialCandidate;
  let repairedCandidate: TeachingPackage | undefined;
  let finalShapeIssues = initialShapeIssues;
  let finalFormatIssues = initialFormatIssues;

  if (initialShapeIssues.length || initialFormatIssues.length) {
    const repairPrompt = JSON.stringify({
      currentOutput: initialParsed.issue ? initialParsed.raw : initialCandidate,
      machineShapeIssues: initialShapeIssues,
      contentFormatIssues: initialFormatIssues,
      instruction: "只修复列出的 JSON 结构或呈现格式问题。保留原有教学内容与事实，不补充新事实，不重写未指出的内容。返回完整 TeachingPackage。"
    });
    try {
      const repairedRaw = (await run({
        phase: "format_repair",
        instructions: plannedInstructions(fields, input.language)
          + "\n\n这是一次有范围的最终格式修复。只修复提示中列出的问题，保持原教学内容与事实不变，并返回完整 TeachingPackage。",
        prompt: repairPrompt,
        schema: teachingPackageSchema,
        maxOutputTokens: 9_000
      })).content;
      const repairedParsed = parseTeachingOutput(repairedRaw);
      if (!repairedParsed.issue) {
        repairedCandidate = normalizeTeachingOutput(repairedParsed.content);
        const repairedShapeIssues = plannedContentIssues(repairedCandidate);
        if (repairedShapeIssues.length === 0) {
          accepted = repairedCandidate;
          finalShapeIssues = [];
          finalFormatIssues = plannedFormatIssues(repairedCandidate);
        }
      }
    } catch (error) {
      // A failed repair may still leave a complete lesson body in the first response.
    }
  }

  if (finalShapeIssues.length) {
    const salvaged = salvageFinalTeachingPackage(initialCandidate, repairedCandidate);
    if (salvaged) {
      accepted = salvaged;
      finalShapeIssues = plannedContentIssues(salvaged);
      finalFormatIssues = plannedFormatIssues(salvaged);
    }
  }

  if (finalShapeIssues.length || !accepted) {
    throw new Error("TEACHING_PACKAGE_INVALID:" + finalShapeIssues.join(","));
  }
  recordFormatWarnings(trace, finalFormatIssues);
  recordQualityWarnings(trace, accepted);

  const core = {
    learningObjectives: accepted.learningObjectives,
    mainContentMarkdown: accepted.mainContentMarkdown,
    priorKnowledge: accepted.priorKnowledge,
    fullExplanationMarkdown: accepted.fullExplanationMarkdown,
    misconceptions: accepted.misconceptions,
    coverageEvidence: accepted.coverageEvidence,
    questions: accepted.questions
  };
  trace.coreFingerprint = createHash("sha256").update(JSON.stringify(core)).digest("hex");
  return { content: accepted, trace };
}
