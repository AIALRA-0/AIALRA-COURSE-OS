import type { PageLesson, TeachingBlueprint } from "@course-os/contracts";
import type { TeachingPackage } from "./model-router.js";
import type { SearchRouteKind } from "@course-os/contracts";

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
  researchQueries?: TeachingResearchQuery[];
}

export interface TeachingResearchQuery {
  id: string;
  atomId: string;
  query: string;
  reason: string;
  kind?: SearchRouteKind;
}

export interface TeachingResearchEvidence {
  queryId: string;
  provider: string;
  title: string;
  url: string;
  snippet: string;
  /** Search results are discovery hints, not verified source material. */
  status: "candidate";
}

const string = { type: "string", minLength: 1 };
const strings = { type: "array", items: string };
const object = (properties: Record<string, unknown>, optional: string[] = []) => ({ type: "object", properties, required: Object.keys(properties).filter(key => !optional.includes(key)), additionalProperties: false });
const array = (items: unknown, minItems: number, maxItems: number) => ({ type: "array", items, minItems, maxItems });
export const teachingPlanSchema = object({
  problem: string, knownStartingPoint: string, scopeBoundary: string,
  facts: array(object({ id: string, atomId: string, observation: string, qualification: { type: "string" } }), 1, 48),
  prerequisites: array(object({ name: string, explanation: string }), 1, 5),
  steps: array(object({ id: string, factIds: strings, dependsOn: strings, explanation: string, example: { type: "string" }, boundary: { type: "string" } }), 1, 16),
  objectives: array(object({ id: string, startingPoint: string, outcome: string, stepIds: strings }), 1, 4),
  questions: array(object({ objectiveId: string, stepId: string, kind: { type: "string", enum: ["comprehension", "multiple_choice"] }, focus: string }), 4, 4),
  researchQueries: array(object({ id: string, atomId: string, query: { type: "string", minLength: 3, maxLength: 240 }, reason: string,
    kind: { type: "string", enum: ["web", "academic", "terminology", "temporal"] } }, ["kind"]), 0, 2)
}, ["researchQueries"]);

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
  const researchIds = new Set<string>();
  for (const query of plan.researchQueries ?? []) {
    if (researchIds.has(query.id)) issues.push(`PLAN_DUPLICATE_RESEARCH:${query.id}`);
    researchIds.add(query.id);
    if (!atoms.has(query.atomId)) issues.push(`PLAN_RESEARCH_UNKNOWN_ATOM:${query.atomId}`);
  }
  return [...new Set(issues)];
}

/** Bind an existing source fact to the nearest already planned teaching step. */
export function assignUnplacedPlanFacts(plan: TeachingPlan): TeachingPlan {
  const result = structuredClone(plan);
  const assigned = new Set(result.steps.flatMap(step => step.factIds));
  for (const [index, fact] of result.facts.entries()) {
    if (assigned.has(fact.id)) continue;
    const nearest = result.facts.slice(0, index).reverse().find(item => assigned.has(item.id))
      ?? result.facts.slice(index + 1).find(item => assigned.has(item.id));
    const step = result.steps.find(item => item.factIds.includes(nearest?.id ?? "")) ?? result.steps.at(-1);
    if (!step) continue;
    step.factIds.push(fact.id);
    assigned.add(fact.id);
  }
  return result;
}

/** Remove invented transport references while preserving every real source fact. */
export function removeUnknownPlanFactReferences(plan: TeachingPlan): TeachingPlan {
  if (!plan || typeof plan !== "object"
    || !Array.isArray((plan as Partial<TeachingPlan>).facts)
    || !Array.isArray((plan as Partial<TeachingPlan>).steps)) return plan;
  const result = structuredClone(plan);
  const facts = new Set(result.facts.map(fact => fact.id));
  const assigned = new Set<string>();
  for (const step of result.steps) {
    const before = step.factIds;
    step.factIds = [...new Set(before.filter(factId => facts.has(factId)))];
    for (const factId of step.factIds) assigned.add(factId);
    if (step.factIds.length > 0 || before.length === 0) continue;
    const replacement = result.facts.find(fact => !assigned.has(fact.id));
    if (replacement) {
      step.factIds.push(replacement.id);
      assigned.add(replacement.id);
    }
  }
  return result;
}

/** Fix an objectiveId label only when the question already tests one of that objective's steps. */
export function alignPlanQuestionObjectives(plan: TeachingPlan): TeachingPlan {
  if (!plan || typeof plan !== "object"
    || !Array.isArray((plan as Partial<TeachingPlan>).objectives)
    || !Array.isArray((plan as Partial<TeachingPlan>).questions)) return plan;
  const result = structuredClone(plan);
  // A question is taught when its selected step belongs to the selected
  // objective. Provider schemas occasionally preserve the right step but copy
  // an adjacent objectiveId. The step is the more specific binding, so repair
  // that transport label without asking the model to rewrite any teaching.
  for (const question of result.questions) {
    const owner = result.objectives.find(goal => goal.stepIds.includes(question.stepId));
    if (owner) question.objectiveId = owner.id;
  }
  for (const goal of result.objectives) {
    if (result.questions.some(question => question.objectiveId === goal.id)) continue;
    const candidate = result.questions.find(question => goal.stepIds.includes(question.stepId)
      && result.questions.filter(other => other.objectiveId === question.objectiveId).length > 1);
    if (candidate) candidate.objectiveId = goal.id;
  }
  return result;
}

/** Fill omitted objective prose from the plan itself, without inventing facts. */
export function fillMissingPlanObjectiveText(plan: TeachingPlan): TeachingPlan {
  if (!plan || typeof plan !== "object" || !Array.isArray((plan as Partial<TeachingPlan>).objectives)) return plan;
  const result = structuredClone(plan) as TeachingPlan;
  const steps = new Map((Array.isArray(result.steps) ? result.steps : []).map(step => [step.id, step]));
  for (const objective of result.objectives) {
    if (!objective || typeof objective !== "object") continue;
    if (typeof objective.startingPoint !== "string" || !objective.startingPoint.trim()) {
      objective.startingPoint = result.knownStartingPoint;
    }
    if (typeof objective.outcome !== "string" || !objective.outcome.trim()) {
      const taught = (Array.isArray(objective.stepIds) ? objective.stepIds : [])
        .map(stepId => steps.get(stepId)?.explanation?.trim())
        .filter((value): value is string => Boolean(value));
      objective.outcome = taught.join("；") || result.problem;
    }
  }
  return result;
}

/**
 * Provider adapters may omit the transport-only atomId while preserving the
 * source-ordered facts. Bind only missing IDs to the next still-uncovered
 * source requirement; invalid IDs and insufficient facts remain validation
 * failures.
 */
export function bindMissingPlanFactAtoms(plan: TeachingPlan, blueprint: TeachingBlueprint): TeachingPlan {
  if (!plan || typeof plan !== "object" || !Array.isArray((plan as Partial<TeachingPlan>).facts)) return plan;
  const result = structuredClone(plan) as TeachingPlan & { facts: Array<TeachingPlan["facts"][number] & { atomId?: string; qualification?: string }> };
  const requiredAtomIds = [...new Set(blueprint.requirementPackage.requirements.map(requirement => requirement.atomId))];
  const validAtomIds = new Set(blueprint.resourcePackage.atomIds);
  const alreadyBound = new Set(result.facts.map(fact => fact.atomId).filter((atomId): atomId is string => Boolean(atomId) && validAtomIds.has(atomId!)));
  let nextRequired = 0;
  for (const fact of result.facts) {
    if (fact.qualification === undefined) fact.qualification = "";
    // Provider-generated IDs are transport labels, not authority. Preserve a
    // valid source binding, but repair a missing or invented ID by source order.
    if (fact.atomId !== undefined && validAtomIds.has(fact.atomId)) continue;
    while (nextRequired < requiredAtomIds.length && alreadyBound.has(requiredAtomIds[nextRequired]!)) nextRequired++;
    const atomId = requiredAtomIds[nextRequired];
    if (!atomId) continue;
    fact.atomId = atomId;
    alreadyBound.add(atomId);
    nextRequired++;
  }
  return result as TeachingPlan;
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

export function plannedCoverageIssues(content: TeachingPackage, blueprint: TeachingBlueprint, plan?: TeachingPlan): string[] {
  const issues: string[] = [];
  for (const evidence of content.coverageEvidence) {
    if (!blueprint.resourcePackage.atomIds.includes(evidence.atomId)) issues.push(`PLAN_EVIDENCE_UNKNOWN_ATOM:${evidence.atomId}`);
    if (!content.fullExplanationMarkdown.includes(evidence.explanation)) issues.push(`PLAN_EVIDENCE_QUOTE_MISSING:${evidence.atomId}`);
    const requirements = blueprint.requirementPackage.requirements.filter(r => r.atomId === evidence.atomId);
    // Image locators may gain actual observations during visual planning.
    const valid = new Set(requirements.length ? requirements.flatMap(r => r.requiredFields) : ["observation"]);
    if (evidence.coveredFields.some(field => !valid.has(field))) issues.push(`PLAN_EVIDENCE_UNKNOWN_FIELD:${evidence.atomId}`);
  }
  for (const requirement of blueprint.requirementPackage.requirements) {
    const fields = new Set(content.coverageEvidence.filter(evidence => evidence.atomId === requirement.atomId).flatMap(evidence => evidence.coveredFields));
    const missing = requirement.requiredFields.filter(field => !fields.has(field));
    if (missing.length) issues.push(`PLAN_EVIDENCE_MISSING:${requirement.atomId}:${missing.join("+")}`);
  }
  const teachableFacts = plan?.facts.filter(fact => !/^(?:(?:本页|该页|页面)(?:顶部|上方|左侧|右侧)?的?)?(?:标题|页码)(?:为|是|：)/u.test(fact.observation.trim())) ?? [];
  for (const atomId of new Set(teachableFacts.map(fact => fact.atomId))) {
    if (!content.coverageEvidence.some(evidence => evidence.atomId === atomId)) issues.push(`PLAN_FACT_EVIDENCE_MISSING:${atomId}`);
  }
  return [...new Set(issues)];
}

/** Rebind a model's multi-paragraph claim only to its own exact line in the explanation. */
export function bindExactCoverageLines<T extends Partial<TeachingPackage>>(content: T): T {
  if (!content.fullExplanationMarkdown || !content.coverageEvidence) return content;
  const explanation = content.fullExplanationMarkdown;
  const sourceLines = explanation.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const punctuationKey = (line: string) => line.replace(/[，,；;。](?:以及|并且)/gu, "，").replace(/[，,；;。]/gu, "，");
  const sharedExcerpt = (left: string, right: string): string => {
    if (left.length > 400 || right.length > 500) return "";
    let previous = new Uint16Array(right.length + 1);
    let best = "";
    for (let i = 1; i <= left.length; i++) {
      const current = new Uint16Array(right.length + 1);
      for (let j = 1; j <= right.length; j++) {
        if (left[i - 1] !== right[j - 1]) continue;
        current[j] = previous[j - 1]! + 1;
        if (current[j]! > best.length) best = left.slice(i - current[j]!, i);
      }
      previous = current;
    }
    return best.trim();
  };
  let changed = false;
  const coverageEvidence = content.coverageEvidence.map(evidence => {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return evidence;
    if (typeof evidence.explanation !== "string") return evidence;
    if (explanation.includes(evidence.explanation)) return evidence;
    const candidateLines = evidence.explanation.split(/\r?\n/u).map(line => line.trim()).filter(line => line.length >= 24)
      .sort((left, right) => right.length - left.length);
    const matched = candidateLines.flatMap(line => sourceLines.filter(sourceLine =>
      sourceLine === line || sourceLine.replace(/^[-*+]\s+/u, "") === line ||
      punctuationKey(sourceLine) === punctuationKey(line) ||
      punctuationKey(sourceLine.replace(/^[-*+]\s+/u, "")) === punctuationKey(line)))[0];
    const contained = matched ? undefined : candidateLines.flatMap(line => sourceLines.filter(sourceLine => {
      const bare = sourceLine.replace(/^[-*+]\s+/u, "");
      return (bare.length >= Math.max(24, Math.ceil(line.length * 0.4)) && line.includes(bare))
        || (bare.startsWith("$") && bare.length >= 16 && line.startsWith(bare));
    }))[0];
    const excerpt = matched || contained ? "" : candidateLines.flatMap(line => sourceLines.map(sourceLine => sharedExcerpt(line, sourceLine))
      .filter(span => span.length >= Math.max(24, Math.ceil(line.length * 0.4))))
      .sort((left, right) => right.length - left.length)[0];
    // A title is a navigation cue. Its subject may be taught under a clearer
    // heading without repeating the source title as an annotation in prose.
    const sourceTitle = /^页面标题是\s*([^，。；\n]+)/u.exec(evidence.explanation)?.[1] ?? "";
    const titleTerms = [...sourceTitle.matchAll(/[A-Za-z][A-Za-z0-9-]{3,}/gu)]
      .map(match => match[0].toLocaleLowerCase()).sort((left, right) => right.length - left.length);
    const titleHeading = matched || contained || excerpt || !titleTerms.length ? undefined
      : sourceLines.find(line => /^#{1,6}\s/u.test(line)
        && titleTerms.some(term => line.toLocaleLowerCase().includes(term)));
    if (!matched && !contained && !excerpt && !titleHeading) return evidence;
    changed = true;
    return { ...evidence, explanation: matched || contained || excerpt || titleHeading! };
  });
  return changed ? { ...content, coverageEvidence } : content;
}
