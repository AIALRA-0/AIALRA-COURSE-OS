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

function repairInstructions(language: string): string {
  const completePolicy = writingPolicyInstructions(language);
  return "你只修复请求中 targetFields 指定的最终 JSON 字段；其余教学内容已经保存，不得重写或返回。先完整阅读以下格式规则与写作策略，再输出修复字段组成的 JSON 对象。"
    + "\n\n" + writingFormatContract
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
  providerDiagnostic?: ProviderOutputDiagnostic;
}

interface ProviderOutputDiagnostic {
  responseId?: string;
  finishReason?: string;
  status?: string;
  rawOutputType: string;
  rawOutputChars?: number;
  rawFields?: Record<string, { type: string; length?: number }>;
}

export interface PlannedTrace {
  version: 1;
  plan: string;
  /** Private page evidence for offline source-fidelity review, never provider logs. */
  sourceDescription?: string;
  phases: PlannedPhaseReceipt[];
  /** Passive timing of local final-output checks; never a delivery gate. */
  formatCheckMs?: number;
  formatWarnings?: Array<{ phase: string; issues: string[] }>;
  qualityWarnings?: Array<{ phase: string; issues: string[] }>;
  /** Metadata only; the private model response text is never stored here. */
  initialOutputDiagnostic?: {
    provider?: ProviderOutputDiagnostic;
    parsedFields?: Record<string, { type: string; length?: number }>;
    normalizedFields?: Record<string, { type: string; length?: number }>;
    parseIssue?: string;
  };
  repairDiagnostic?: {
    initialShapeIssues: string[];
    initialQuestionCount: number;
    targetFields: string[];
    repairedShapeIssues?: string[];
    repairedQuestionCount?: number;
    parseIssue?: string;
    providerError?: string;
  };
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
  if (/理解|简答|问答|comprehension|understanding|short_?answer|open_?ended|free_?text|essay/u.test(key)) return "comprehension";
  return value;
}

function providerQuizQuestions(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  const quiz = value as Record<string, unknown>;
  for (const key of ["questions", "quizQuestions", "items"]) {
    if (Array.isArray(quiz[key]) && quiz[key].length) return quiz[key];
  }
  const groups = Object.values(quiz).filter(Array.isArray);
  return groups.length ? groups.flat() : undefined;
}

/** Preserve the model's explanation when a compatible provider returns it as structured text. */
function explanationText(value: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.map(item => explanationText(item, depth + 1)).filter(Boolean).join("\n\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const preferred = ["text", "content", "explanation", "reason", "rationale", "analysis", "steps", "why"]
    .filter(key => key in record);
  return (preferred.length ? preferred.map(key => record[key]) : Object.values(record))
    .map(item => explanationText(item, depth + 1)).filter(Boolean).join("\n\n");
}

/** Project harmless provider wrappers and aliases into a requested JSON shape. */
export function projectPlannedOutputToSchema(value: unknown, schema: any, _phase = ""): unknown {
  let candidate = value;
  if (schema?.type === "string" && Array.isArray(candidate) && candidate.length > 0
    && candidate.every(item => typeof item === "string" && item.trim())) {
    return candidate.map(item => item.trim()).join("\n\n");
  }
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
    // Compatible relays sometimes rename or split the final question array
    // despite strict JSON Schema. These aliases preserve already-written work.
    const taggedQuestions = (items: unknown, kind: "comprehension" | "multiple_choice") =>
      Array.isArray(items) ? items.map(item => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const question = item as Record<string, unknown>;
        return { ...question, kind: question.kind ?? kind };
      }) : [];
    const splitQuestions = [
      ...taggedQuestions(Array.isArray(record.understandingQuestions) && record.understandingQuestions.length
        ? record.understandingQuestions : record.comprehensionQuestions, "comprehension"),
      ...taggedQuestions(Array.isArray(record.multipleChoiceQuestions) && record.multipleChoiceQuestions.length
        ? record.multipleChoiceQuestions : record.choiceQuestions, "multiple_choice")
    ];
    const questionChoices = [record.questions, record.exercises, record.quizQuestions, record.assessmentQuestions,
      providerQuizQuestions(record.quiz), record.practiceQuestions, splitQuestions];
    const sourceQuestions = questionChoices.find(item => Array.isArray(item) && item.length === 4)
      ?? questionChoices.find(item => Array.isArray(item) && item.length > 0)
      ?? record.questions ?? [];
    const rawOptions = record.options ?? record.choices;
    const options = rawOptions && typeof rawOptions === "object" && !Array.isArray(rawOptions)
      ? Object.values(rawOptions as Record<string, unknown>) : rawOptions;
    const recognizedKind = normalizeQuestionKind(record.kind ?? record.type);
    const questionKind = recognizedKind === "comprehension" || recognizedKind === "multiple_choice"
      ? recognizedKind : Array.isArray(options) && options.length >= 2 ? "multiple_choice" : "comprehension";
    const rawAnswer = record.expectedAnswer ?? record.answer ?? record.correctAnswer;
    const expectedAnswer = typeof rawAnswer === "string" && /^[A-D]$/iu.test(rawAnswer.trim())
      && rawOptions && typeof rawOptions === "object" && !Array.isArray(rawOptions)
      ? (rawOptions as Record<string, unknown>)[rawAnswer.trim().toUpperCase()] ?? rawAnswer : rawAnswer;
    const rawExplanation = record.explanation ?? record.rationale ?? record.reason;
    const normalized = schema.properties?.kind ? {
      ...record,
      kind: questionKind,
      prompt: record.prompt ?? record.question ?? record.stem,
      options: options ?? (questionKind === "comprehension" ? [] : undefined),
      expectedAnswer,
      explanation: explanationText(rawExplanation) || (typeof expectedAnswer === "string" ? expectedAnswer : undefined)
    } : schema.properties?.fullExplanationMarkdown ? {
      ...record,
      chapterBridgeMarkdown: record.chapterBridgeMarkdown ?? record.chapterBridge ?? "",
      learningObjectives: record.learningObjectives ?? record.objectives ?? [],
      ...((record.mainContentMarkdown ?? record.mainContentSummaryMarkdown ?? record.mainContent ?? record.keyPoints ?? record.keyContent ?? record.keyTakeawaysMarkdown ?? record.keyTakeaways ?? record.mainSummaryMarkdown ?? record.mainContentSummary ?? record.mainPoints ?? record.keyPointsMarkdown ?? record.summary) !== undefined
        ? { mainContentMarkdown: record.mainContentMarkdown ?? record.mainContentSummaryMarkdown ?? record.mainContent ?? record.keyPoints ?? record.keyContent ?? record.keyTakeawaysMarkdown ?? record.keyTakeaways ?? record.mainSummaryMarkdown ?? record.mainContentSummary ?? record.mainPoints ?? record.keyPointsMarkdown ?? record.summary } : {}),
      priorKnowledge: record.priorKnowledge ?? record.prerequisites ?? [],
      ...((record.fullExplanationMarkdown ?? record.fullExplanation ?? record.completeExplanationMarkdown ?? record.lessonContentMarkdown ?? record.lectureMarkdown ?? record.lessonMarkdown ?? record.teachingContentMarkdown ?? record.explanationMarkdown ?? record.explanation) !== undefined
        ? { fullExplanationMarkdown: record.fullExplanationMarkdown ?? record.fullExplanation ?? record.completeExplanationMarkdown ?? record.lessonContentMarkdown ?? record.lectureMarkdown ?? record.lessonMarkdown ?? record.teachingContentMarkdown ?? record.explanationMarkdown ?? record.explanation } : {}),
      misconceptions: record.misconceptions ?? record.commonMistakes ?? [],
      coverageEvidence: record.coverageEvidence ?? [],
      questions: sourceQuestions
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
  providerDiagnostic?: ProviderOutputDiagnostic;
}

function outputFieldSummary(value: unknown): Record<string, { type: string; length?: number }> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, {
    type: Array.isArray(field) ? "array" : field === null ? "null" : typeof field,
    ...(Array.isArray(field) || typeof field === "string" ? { length: field.length } : {})
  }]));
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
        ...(record.usage && typeof record.usage === "object" ? { usage: record.usage as ModelRouterUsage } : {}),
        ...(record.providerDiagnostic && typeof record.providerDiagnostic === "object"
          ? { providerDiagnostic: record.providerDiagnostic as ProviderOutputDiagnostic } : {})
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
  // Some compatible relays return the summary as a JSON list even when the
  // requested field is Markdown. This is a lossless formatting conversion,
  // so it should not spend the page's only model repair call.
  let source = value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const main = record.mainContentMarkdown ?? record.mainContentSummaryMarkdown ?? record.mainContent ?? record.keyPoints
      ?? record.keyContent ?? record.keyTakeawaysMarkdown ?? record.keyTakeaways
      ?? record.mainSummaryMarkdown ?? record.mainContentSummary ?? record.mainPoints
      ?? record.keyPointsMarkdown ?? record.summary;
    if (Array.isArray(main) && main.length > 0 && main.every(item => typeof item === "string" && item.trim())) {
      source = { ...record, mainContentMarkdown: main.map(item => /^\s*[-*+]\s/u.test(item)
        ? item.trim() : `- ${item.trim()}`).join("\n") };
    }
  }
  const projected = projectPlannedOutputToSchema(source, teachingPackageSchema, "teaching");
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
  if (content.questions.some(question => question.explanation.trim() === question.expectedAnswer.trim())) {
    issues.push("TEACHING_QUALITY:QUESTION_EXPLANATION_EQUALS_ANSWER");
  }
  if (issues.length) trace.qualityWarnings = [{ phase: "teaching", issues }];
}

function questionsNeedRepair(value: TeachingPackage | undefined): boolean {
  const questions = value?.questions;
  if (!Array.isArray(questions) || questions.length !== 4) return true;
  const comprehension = questions.filter(question => question.kind === "comprehension");
  const choices = questions.filter(question => question.kind === "multiple_choice");
  return comprehension.length !== 2 || choices.length !== 2
    || choices.some(question => !Array.isArray(question.options) || question.options.length !== 4
      || !question.options.includes(question.expectedAnswer));
}

function repairFieldsFor(issues: string[], formatIssues: string[], questionsIncomplete: boolean): string[] {
  const fields = new Set<string>();
  for (const issue of [...issues, ...formatIssues]) {
    for (const field of Object.keys(schemaProperties)) {
      if (issue.includes(`result.${field}`) || issue.includes(`:${field}:`)) fields.add(field);
    }
  }
  if (questionsIncomplete) fields.add("questions");
  return [...fields];
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
      ...(result.providerDiagnostic ? { providerDiagnostic: result.providerDiagnostic } : {}),
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
  let initialProviderDiagnostic: ProviderOutputDiagnostic | undefined;
  try {
    const initialResult = await run(teachingRequest);
    initialRaw = initialResult.content;
    initialProviderDiagnostic = initialResult.providerDiagnostic;
  } catch (error) {
    const recoverable = error instanceof Error ? transientInvalidProviderOutput(error) : undefined;
    if (recoverable === undefined) throw error;
    initialRaw = recoverable;
  }

  const initialParsed = parseTeachingOutput(initialRaw);
  const initialCheckStarted = performance.now();
  const initialCandidate = initialParsed.issue ? undefined : normalizeTeachingOutput(initialParsed.content);
  trace.initialOutputDiagnostic = {
    ...(initialProviderDiagnostic ? { provider: initialProviderDiagnostic } : {}),
    ...(initialParsed.issue ? { parseIssue: initialParsed.issue } : {}),
    ...(outputFieldSummary(initialParsed.content) ? { parsedFields: outputFieldSummary(initialParsed.content) } : {}),
    ...(outputFieldSummary(initialCandidate) ? { normalizedFields: outputFieldSummary(initialCandidate) } : {})
  };
  const initialShapeIssues = initialParsed.issue
    ? [initialParsed.issue]
    : plannedContentIssues(initialCandidate as TeachingPackage);
  const initialFormatIssues = initialShapeIssues.length === 0
    ? plannedFormatIssues(initialCandidate as TeachingPackage) : [];
  const incompleteQuestions = questionsNeedRepair(initialCandidate);
  trace.formatCheckMs = Math.round(performance.now() - initialCheckStarted);
  let accepted = initialCandidate;
  let repairedCandidate: TeachingPackage | undefined;
  let finalShapeIssues = initialShapeIssues;
  let finalFormatIssues = initialFormatIssues;

  // Style findings remain visible in the trace. Only broken machine output
  // and incomplete final question structure consume the single repair call.
  if (initialShapeIssues.length || incompleteQuestions) {
    const validCore = initialCandidate && typeof initialCandidate.mainContentMarkdown === "string"
      && !!initialCandidate.mainContentMarkdown.trim()
      && typeof initialCandidate.fullExplanationMarkdown === "string"
      && !!initialCandidate.fullExplanationMarkdown.trim();
    const onlyQuestionShapeErrors = initialShapeIssues.every(issue => issue.startsWith("result.questions"));
    const repairFields = validCore && incompleteQuestions && onlyQuestionShapeErrors
      ? ["questions"] : repairFieldsFor(initialShapeIssues, [], incompleteQuestions);
    const questionOnlyRepair = repairFields.length === 1 && repairFields[0] === "questions";
    trace.repairDiagnostic = {
      initialShapeIssues,
      initialQuestionCount: Array.isArray(initialCandidate?.questions) ? initialCandidate.questions.length : 0,
      targetFields: repairFields
    };
    const repairSchema = !initialParsed.issue && repairFields.length > 0 ? {
      type: "object",
      properties: Object.fromEntries(repairFields.map(field => [field, field === "questions"
        ? { ...schemaProperties.questions, minItems: 4, maxItems: 4 }
        : schemaProperties[field]])),
      required: repairFields,
      additionalProperties: false
    } : teachingPackageSchema;
    const currentFields = initialCandidate && repairFields.length > 0
      ? Object.fromEntries(repairFields.map(field => [field, (initialCandidate as unknown as Record<string, unknown>)[field]]))
      : initialParsed.raw;
    const repairPrompt = JSON.stringify({
      pageTitle: input.pageTitle,
      source: input.sourceText.slice(0, questionOnlyRepair ? 4_000 : 8_000),
      currentOutput: currentFields,
      ...(initialCandidate ? {
        mainContentMarkdown: initialCandidate.mainContentMarkdown?.slice(0, questionOnlyRepair ? 1_000 : 2_000),
        fullExplanationMarkdown: initialCandidate.fullExplanationMarkdown?.slice(0, questionOnlyRepair ? 2_000 : 5_000)
      } : {}),
      targetFields: repairFields,
      machineShapeIssues: initialShapeIssues,
      contentFormatIssues: [],
      instruction: "只返回 targetFields 中列出的字段。保留已有教学事实，不重写其他字段。questions 必须是 2 道理解题和 2 道四选一选择题。"
    });
    try {
      const repairedRaw = (await run({
        phase: "format_repair",
        instructions: repairInstructions(input.language),
        prompt: repairPrompt,
        schema: repairSchema,
        maxOutputTokens: repairFields.includes("fullExplanationMarkdown") || repairSchema === teachingPackageSchema ? 9_000 : 5_000
      })).content;
      const repairedParsed = parseTeachingOutput(repairedRaw);
      if (repairedParsed.issue) trace.repairDiagnostic.parseIssue = repairedParsed.issue;
      if (!repairedParsed.issue) {
        const repairedCheckStarted = performance.now();
        const patch = projectPlannedOutputToSchema(repairedParsed.content, repairSchema);
        repairedCandidate = normalizeTeachingOutput({ ...initialCandidate, ...patch as object });
        const repairedShapeIssues = plannedContentIssues(repairedCandidate);
        trace.repairDiagnostic.repairedShapeIssues = repairedShapeIssues;
        trace.repairDiagnostic.repairedQuestionCount = Array.isArray(repairedCandidate.questions)
          ? repairedCandidate.questions.length : 0;
        if (repairedShapeIssues.length === 0) {
          accepted = repairedCandidate;
          finalShapeIssues = [];
          finalFormatIssues = plannedFormatIssues(repairedCandidate);
        }
        trace.formatCheckMs += Math.round(performance.now() - repairedCheckStarted);
      }
    } catch (error) {
      // A failed repair may still leave a complete lesson body in the first response.
      trace.repairDiagnostic.providerError = error instanceof Error ? error.message.split(":", 1)[0] : "unknown";
    }
  }

  if (finalShapeIssues.length) {
    const salvageCheckStarted = performance.now();
    const salvaged = salvageFinalTeachingPackage(initialCandidate, repairedCandidate);
    if (salvaged) {
      accepted = salvaged;
      finalShapeIssues = plannedContentIssues(salvaged);
      finalFormatIssues = plannedFormatIssues(salvaged);
    }
    trace.formatCheckMs += Math.round(performance.now() - salvageCheckStarted);
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
