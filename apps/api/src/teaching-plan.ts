import type { PageLesson, TeachingBlueprint } from "@course-os/contracts";
import type { TeachingPackage } from "./model-router.js";

/** Content decisions, distinct from the versioned writing policy. */
export interface TeachingPlan {
  problem: string;
  knownStartingPoint: string;
  scopeBoundary: string;
  facts: Array<{ id: string; atomId: string; observation: string; qualification: string }>;
  prerequisites: Array<{ name: string; explanation: string }>;
  steps: Array<{ id: string; factIds: string[]; dependsOn: string[]; explanation: string; example: string; boundary: string }>;
  objectives: Array<{ id: string; startingPoint: string; outcome: string; stepIds: string[] }>;
  questions: Array<{ objectiveId: string; stepId: string; kind: "comprehension" | "multiple_choice"; focus: string }>;
}

const string = { type: "string", minLength: 1 };
const strings = { type: "array", items: string };
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const array = (items: unknown, minItems: number, maxItems: number) => ({ type: "array", items, minItems, maxItems });
export const teachingPlanSchema = object({
  problem: string, knownStartingPoint: string, scopeBoundary: string,
  facts: array(object({ id: string, atomId: string, observation: string, qualification: { type: "string" } }), 1, 48),
  prerequisites: array(object({ name: string, explanation: string }), 1, 5),
  steps: array(object({ id: string, factIds: strings, dependsOn: strings, explanation: string, example: { type: "string" }, boundary: { type: "string" } }), 1, 16),
  objectives: array(object({ id: string, startingPoint: string, outcome: string, stepIds: strings }), 1, 4),
  questions: array(object({ objectiveId: string, stepId: string, kind: { type: "string", enum: ["comprehension", "multiple_choice"] }, focus: string }), 4, 4)
});

/** Strict local validation also applies when a provider does not enforce schemas. */
export function schemaIssues(value: unknown, schema: any, path = "result"): string[] {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path}:object`];
    const record = value as Record<string, unknown>;
    return [
      ...(schema.required || []).filter((key: string) => !(key in record)).map((key: string) => `${path}.${key}:required`),
      ...Object.keys(record).flatMap(key => schema.properties[key] ? schemaIssues(record[key], schema.properties[key], `${path}.${key}`)
        : schema.additionalProperties === false ? [`${path}.${key}:unknown`] : [])
    ];
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${path}:array`];
    return [...(value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity) ? [`${path}:length`] : []),
      ...value.flatMap((item, index) => schemaIssues(item, schema.items, `${path}.${index}`))];
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return [`${path}:string`];
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return [`${path}:length`];
    if (schema.enum && !schema.enum.includes(value)) return [`${path}:enum`];
  }
  return [];
}

export function validateTeachingPlan(plan: TeachingPlan, blueprint: TeachingBlueprint): string[] {
  const issues = schemaIssues(plan, teachingPlanSchema);
  if (issues.length) return issues;
  const atoms = new Set(blueprint.resourcePackage.atomIds);
  const facts = new Set(plan.facts.map(fact => fact.id));
  const steps = new Set<string>();
  const assigned = new Set<string>();
  if (facts.size !== plan.facts.length) issues.push("PLAN_DUPLICATE_FACT");
  for (const fact of plan.facts) if (!atoms.has(fact.atomId)) issues.push(`PLAN_UNKNOWN_ATOM:${fact.atomId}`);
  for (const step of plan.steps) {
    if (steps.has(step.id)) issues.push(`PLAN_DUPLICATE_STEP:${step.id}`);
    for (const dependency of step.dependsOn) if (!steps.has(dependency)) issues.push(`PLAN_FORWARD_DEPENDENCY:${dependency}`);
    steps.add(step.id);
    for (const fact of step.factIds) {
      if (!facts.has(fact)) issues.push(`PLAN_UNKNOWN_FACT:${fact}`);
      // Reusing a fact as an input is not teaching its definition twice. The
      // first referencing step owns its explanation; later steps may apply it.
      assigned.add(fact);
    }
  }
  for (const fact of facts) if (!assigned.has(fact)) issues.push(`PLAN_FACT_UNASSIGNED:${fact}`);
  for (const requirement of blueprint.requirementPackage.requirements) {
    if (!plan.facts.some(fact => fact.atomId === requirement.atomId)) issues.push(`PLAN_SOURCE_UNASSIGNED:${requirement.atomId}`);
  }
  const objectives = new Set(plan.objectives.map(goal => goal.id));
  if (objectives.size !== plan.objectives.length) issues.push("PLAN_DUPLICATE_OBJECTIVE");
  for (const goal of plan.objectives) {
    if (!goal.stepIds.length || goal.stepIds.some(id => !steps.has(id))) issues.push(`PLAN_OBJECTIVE_UNTAUGHT:${goal.id}`);
    if (!plan.questions.some(question => question.objectiveId === goal.id)) issues.push(`PLAN_OBJECTIVE_UNTESTED:${goal.id}`);
  }
  for (const question of plan.questions) {
    if (!objectives.has(question.objectiveId) || !steps.has(question.stepId)
      || !plan.objectives.find(goal => goal.id === question.objectiveId)?.stepIds.includes(question.stepId)) issues.push("PLAN_QUESTION_UNTAUGHT");
  }
  if (plan.questions.filter(question => question.kind === "comprehension").length !== 2) issues.push("PLAN_QUESTION_MIX");
  return [...new Set(issues)];
}

/** Extract generated teaching only. OCR and images never become preceding knowledge. */
export function previousLessonContext(page: PageLesson | undefined): string | undefined {
  if (!page?.lessonSections?.some(section => section.kind === "full_explanation" && section.markdown?.trim())) return undefined;
  const sections = page.lessonSections.filter(section => ["prior_knowledge", "full_explanation", "main_content"].includes(section.kind));
  return JSON.stringify({ pageId: page.id, pageNumber: page.pageNumber, title: page.title,
    sections: sections.map(section => ({ kind: section.kind,
      text: compressText(section.markdown || section.items?.map(item => item.text).join("\n") || "", section.kind === "full_explanation" ? 3600 : 1400) })) });
}

/** Keep whole blocks spread across the text, preserving the ending and its conditions. */
export function compressText(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const blocks = text.split(/\n\s*\n/u).filter(Boolean);
  const selected = new Set<number>();
  let remaining = budget;
  const indices = [0, blocks.length - 1, ...blocks.map((_, index) => index)];
  for (const index of indices) {
    if (selected.has(index)) continue;
    const block = blocks[index]!;
    if (block.length + 2 <= remaining) { selected.add(index); remaining -= block.length + 2; }
  }
  return [...selected].sort((a, b) => a - b).map(index => blocks[index]).join("\n\n")
    || "前文没有可在当前预算内完整引用的段落；不要假定学习者已经理解它";
}

export function teachingSectionMemory(content: Partial<TeachingPackage>) {
  return {
    alreadyIntroduced: content.priorKnowledge ?? [],
    bridge: content.chapterBridgeMarkdown ?? "",
    objectives: content.learningObjectives ?? [],
    explanation: compressText(content.fullExplanationMarkdown ?? "", 6500),
    summary: content.mainContentMarkdown ?? ""
  };
}

export function plannedCoverageIssues(content: TeachingPackage, blueprint: TeachingBlueprint): string[] {
  const issues: string[] = [];
  for (const evidence of content.coverageEvidence) {
    if (!blueprint.resourcePackage.atomIds.includes(evidence.atomId)) issues.push(`PLAN_EVIDENCE_UNKNOWN_ATOM:${evidence.atomId}`);
    if (!content.fullExplanationMarkdown.includes(evidence.explanation)) issues.push(`PLAN_EVIDENCE_QUOTE_MISSING:${evidence.atomId}`);
    const valid = new Set(blueprint.requirementPackage.requirements.filter(r => r.atomId === evidence.atomId).flatMap(r => r.requiredFields));
    if (evidence.coveredFields.some(field => !valid.has(field))) issues.push(`PLAN_EVIDENCE_UNKNOWN_FIELD:${evidence.atomId}`);
  }
  for (const requirement of blueprint.requirementPackage.requirements) {
    const fields = new Set(content.coverageEvidence.filter(evidence => evidence.atomId === requirement.atomId).flatMap(evidence => evidence.coveredFields));
    const missing = requirement.requiredFields.filter(field => !fields.has(field));
    if (missing.length) issues.push(`PLAN_EVIDENCE_MISSING:${requirement.atomId}:${missing.join("+")}`);
  }
  return [...new Set(issues)];
}
