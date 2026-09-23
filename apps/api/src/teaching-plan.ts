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
  problem: string, knownStartingPoint: string, scopeBoundary: { type: "string" },
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

function transportText(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const joined = value.map(item => transportText(item, "")).filter(Boolean).join("；");
    return joined || fallback;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "observation", "explanation", "outcome", "focus", "name", "label"]) {
      const text = transportText(record[key], "");
      if (text) return text;
    }
  }
  return fallback;
}

function transportStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => transportText(item, "")).filter(Boolean);
  const text = transportText(value, "");
  return text ? [text] : [];
}

/**
 * Convert provider transport drift into the same source-grounded plan shape.
 * Content still comes from the provider when present; missing bookkeeping is
 * derived from the authoritative Blueprint so malformed JSON cannot block a
 * page or trigger repeated model calls merely to restore IDs and labels.
 */
export function completeTeachingPlanTransport(value: unknown, blueprint: TeachingBlueprint): TeachingPlan {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const sourceLines = blueprint.resourcePackage.sourceText.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const validAtoms = new Set(blueprint.resourcePackage.atomIds);
  const requiredAtoms = [...new Set(blueprint.requirementPackage.requirements.map(item => item.atomId))];
  const atomOrder = requiredAtoms.length ? requiredAtoms : blueprint.resourcePackage.atomIds;
  const rawFacts = Array.isArray(raw.facts) ? raw.facts : [];
  const facts: TeachingPlan["facts"] = rawFacts.slice(0, 48).map((item, index) => {
    const fact = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const proposedAtom = transportText(fact.atomId ?? fact.sourceAtomId, "");
    return {
      id: transportText(fact.id, `fact-${index + 1}`),
      atomId: validAtoms.has(proposedAtom) ? proposedAtom : atomOrder[index % Math.max(1, atomOrder.length)] ?? blueprint.resourcePackage.atomIds[0] ?? `source-${index + 1}`,
      observation: transportText(fact.observation ?? fact.text ?? fact.statement, sourceLines[index % Math.max(1, sourceLines.length)] ?? blueprint.resourcePackage.pageTitle),
      qualification: transportText(fact.qualification ?? fact.condition ?? fact.scope, "")
    };
  });
  const factIds = new Set(facts.map(fact => fact.id));
  for (const [index, atomId] of atomOrder.entries()) {
    if (facts.some(fact => fact.atomId === atomId)) continue;
    let id = `fact-${facts.length + 1}`;
    while (factIds.has(id)) id += "-source";
    factIds.add(id);
    facts.push({ id, atomId,
      observation: sourceLines[index % Math.max(1, sourceLines.length)] ?? blueprint.resourcePackage.pageTitle,
      qualification: "" });
  }
  if (facts.length === 0) facts.push({ id: "fact-1", atomId: blueprint.resourcePackage.atomIds[0] ?? "page-source",
    observation: blueprint.resourcePackage.sourceText || blueprint.resourcePackage.pageTitle, qualification: "" });

  const rawSteps = Array.isArray(raw.steps) && raw.steps.length ? raw.steps : blueprint.steps.filter(step => step.required);
  const steps: TeachingPlan["steps"] = rawSteps.slice(0, 16).map((item, index) => {
    const step = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const blueprintStep = blueprint.steps[index % blueprint.steps.length];
    const id = transportText(step.id, `step-${index + 1}`);
    const selectedFacts = transportStrings(step.factIds).filter(factId => factIds.has(factId));
    return { id,
      factIds: selectedFacts.length ? [...new Set(selectedFacts)] : [facts[index % facts.length]!.id],
      dependsOn: transportStrings(step.dependsOn).filter(dependency => dependency !== id),
      explanation: transportText(step.explanation, blueprintStep?.objective ?? blueprint.requirementPackage.objective),
      example: transportText(step.example, ""),
      boundary: transportText(step.boundary, "") };
  });
  if (steps.length === 0) steps.push({ id: "step-1", factIds: facts.map(fact => fact.id), dependsOn: [],
    explanation: blueprint.requirementPackage.objective, example: "", boundary: "" });
  const stepIds = new Set(steps.map(step => step.id));
  for (const [index, step] of steps.entries()) step.dependsOn = step.dependsOn.filter(id => stepIds.has(id) && steps.findIndex(item => item.id === id) < index);

  const rawObjectives = Array.isArray(raw.objectives) && raw.objectives.length ? raw.objectives : [raw];
  const objectives: TeachingPlan["objectives"] = rawObjectives.slice(0, 4).map((item, index) => {
    const objective = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const selectedSteps = transportStrings(objective.stepIds).filter(stepId => stepIds.has(stepId));
    const ownedSteps = selectedSteps.length ? selectedSteps : [steps[index % steps.length]!.id];
    return { id: transportText(objective.id, `objective-${index + 1}`),
      startingPoint: transportText(objective.startingPoint, transportText(raw.knownStartingPoint, "已经能够识别页面中的标题、文字、符号和图示")),
      outcome: transportText(objective.outcome, ownedSteps.map(stepId => steps.find(step => step.id === stepId)?.explanation).filter(Boolean).join("；") || blueprint.requirementPackage.objective),
      stepIds: ownedSteps };
  });
  const rawQuestions = Array.isArray(raw.questions) ? raw.questions : [];
  const questions: TeachingPlan["questions"] = Array.from({ length: 4 }, (_, index) => {
    const item = rawQuestions[index];
    const question = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const proposedStep = transportText(question.stepId, "");
    const stepId = stepIds.has(proposedStep) ? proposedStep : objectives[index % objectives.length]!.stepIds[0]!;
    const objective = objectives.find(goal => goal.stepIds.includes(stepId)) ?? objectives[index % objectives.length]!;
    return { objectiveId: objective.id, stepId,
      kind: index < 2 ? "comprehension" : "multiple_choice",
      focus: transportText(question.focus, objective.outcome) };
  });
  const rawPrerequisites = Array.isArray(raw.prerequisites) ? raw.prerequisites : [];
  const prerequisites: TeachingPlan["prerequisites"] = rawPrerequisites.slice(0, 5).map((item, index) => {
    const prerequisite = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    return { name: transportText(prerequisite.name, `基础概念 ${index + 1}`),
      explanation: transportText(prerequisite.explanation, transportText(raw.knownStartingPoint, "先识别本页明确给出的对象")) };
  });
  if (prerequisites.length === 0) prerequisites.push({ name: "页面对象", explanation: transportText(raw.knownStartingPoint, "先识别本页明确给出的对象、符号和关系") });
  const researchQueries = (Array.isArray(raw.researchQueries) ? raw.researchQueries : []).slice(0, 2).flatMap((item, index) => {
    const query = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const atomId = transportText(query.atomId, "");
    const text = transportText(query.query, "");
    const reason = transportText(query.reason, "");
    if (!validAtoms.has(atomId) || !text || !reason) return [];
    const kind = ["web", "academic", "terminology", "temporal"].includes(String(query.kind))
      ? query.kind as TeachingResearchQuery["kind"] : undefined;
    return [{ id: transportText(query.id, `research-${index + 1}`), atomId, query: text, reason, ...(kind ? { kind } : {}) }];
  });
  return {
    problem: transportText(raw.problem, blueprint.requirementPackage.objective),
    knownStartingPoint: transportText(raw.knownStartingPoint, "已经能够识别页面中的标题、文字、符号和图示"),
    // Scope is useful only when the source establishes a boundary that changes
    // how the learner should interpret this page. An empty value is valid.
    scopeBoundary: transportText(raw.scopeBoundary, ""),
    facts, prerequisites, steps, objectives, questions,
    ...(researchQueries.length ? { researchQueries } : {})
  };
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
    sectionResponsibilities: {
      priorKnowledge: "只补本页理解所需的前提并完成必要定义；完整讲解应用这些知识，不重复整段定义",
      learningObjectives: "只说明读完后能完成什么；不提前讲解步骤和答案",
      chapterBridgeMarkdown: "只连接前页已建立的知识与本页问题；不复述前页正文或本页讲解",
      fullExplanationMarkdown: "唯一完整教学路径，按具体对象、关系、机制逐步深入",
      mainContentMarkdown: "只压缩完整讲解的核心结论，不重新解释定义、推导或例子",
      misconceptions: "只指出具体误解、成因、正确判断和核对方式，不重讲整段正文",
      questions: "只检验已讲内容的理解与迁移，不把答案复制成讲解"
    },
    // Later stages need the concepts already introduced, not another copy of
    // their full definitions. The plan and source still carry the facts.
    alreadyIntroduced: (content.priorKnowledge ?? []).map(item => item.split(/[：:]/u, 1)[0]?.trim() || item),
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
export function bindExactCoverageLines<T extends Partial<TeachingPackage>>(content: T, plan?: TeachingPlan): T {
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
    // When a provider paraphrases or truncates its coverage quote, an exact
    // span shared by a source-backed plan fact and the teaching text is a
    // safer witness than asking the model to invent another quotation.
    const factLine = matched || contained || excerpt || titleHeading || evidence.coveredFields.some(field => field !== "observation")
      ? undefined
      : plan?.facts.filter(fact => fact.atomId === evidence.atomId).flatMap(fact =>
        sourceLines.map(line => ({ line, overlap: sharedExcerpt(fact.observation.toLocaleLowerCase(), line.toLocaleLowerCase()).length }))
          .filter(candidate => candidate.overlap >= Math.max(12, Math.ceil(fact.observation.length * 0.5))))
        .sort((left, right) => right.overlap - left.overlap)[0]?.line;
    if (!matched && !contained && !excerpt && !titleHeading && !factLine) return evidence;
    changed = true;
    return { ...evidence, explanation: matched || contained || excerpt || titleHeading || factLine! };
  });
  return changed ? { ...content, coverageEvidence } : content;
}
