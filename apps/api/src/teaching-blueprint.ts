import { createHash } from "node:crypto";
import type { PageLesson, TeachingBlueprint, TeachingBlueprintStep } from "@course-os/contracts";
import { stableStringify } from "@course-os/domain";

const requiredSections = ["learning_objectives", "main_content", "prior_knowledge", "full_explanation", "misconceptions"] as const;

export function buildTeachingBlueprint(page: PageLesson, sourceText: string, language: string, qualityMode: string, writingPolicySnapshotId: string, imageAvailable: boolean): TeachingBlueprint {
  const atomIds = page.atoms.map((atom) => atom.id);
  const requirementIds = page.coverageRequirements.map((requirement) => requirement.id);
  const steps: TeachingBlueprintStep[] = [
    { id: `${page.id}:purpose`, kind: "purpose", objective: "先说明这页要解决的具体问题和学习结果", atomIds: [], requirementIds: [], output: "一句话结论和学习目标" },
    { id: `${page.id}:objects`, kind: "object_reading", objective: "按页面顺序解释所有有效对象及其含义", atomIds, requirementIds: [], output: "逐项解释文字、公式、图形、表格或代码" },
    { id: `${page.id}:relations`, kind: "relationship", objective: "解释对象之间的关系、因果和执行顺序", atomIds, requirementIds, output: "把覆盖要求组织成连贯的因果链" },
    { id: `${page.id}:example`, kind: "example", objective: "给出一个可复算或可复现的最小例子", atomIds, requirementIds: [], output: "展示前提、步骤和结果含义" },
    { id: `${page.id}:boundary`, kind: "boundary", objective: "说明适用条件、边界、失败条件和易错点", atomIds, requirementIds, output: "只保留帮助判断和行动的边界信息" },
    { id: `${page.id}:recap`, kind: "recap", objective: "回收结论并指出下一步", atomIds: [], requirementIds: [], output: "不重复正文的简短回收" }
  ];
  const blueprintWithoutHash = {
    version: "1.0.0" as const,
    pageId: page.id,
    pageNumber: page.pageNumber,
    resourcePackage: { version: "1.0.0" as const, pageId: page.id, pageTitle: page.title, sourceText: sourceText.slice(0, 45_000), sourceAnchorIds: page.anchors.map((anchor) => anchor.id), atomIds, imageAvailable },
    requirementPackage: { version: "1.0.0" as const, requirements: page.coverageRequirements, objective: `理解第 ${page.pageNumber} 页：${page.title}`, requiredSections: [...requiredSections] },
    rulePackage: { version: "1.0.0" as const, language, qualityMode, rules: ["遵循写作策略快照", "来源、背景和推断分开", "按蓝图步骤组织讲解", "每个要求绑定真实 atomId", "避免重复句和装饰性说明", "公式使用合法 KaTeX", "每页 2 道理解题和 2 道选择题"], questionRule: { comprehension: 2, multipleChoice: 2, optionsPerMultipleChoice: 4 } },
    steps,
    writingPolicySnapshotId
  };
  return { ...blueprintWithoutHash, sha256: createHash("sha256").update(stableStringify(blueprintWithoutHash)).digest("hex") };
}

export function validateTeachingBlueprint(page: PageLesson, blueprint: TeachingBlueprint): string[] {
  const validAtoms = new Set(page.atoms.map((atom) => atom.id));
  const validRequirements = new Set(page.coverageRequirements.map((requirement) => requirement.id));
  const issues: string[] = [];
  for (const step of blueprint.steps) {
    for (const atomId of step.atomIds) if (!validAtoms.has(atomId)) issues.push(`BLUEPRINT_UNKNOWN_ATOM:${atomId}`);
    for (const requirementId of step.requirementIds) if (!validRequirements.has(requirementId)) issues.push(`BLUEPRINT_UNKNOWN_REQUIREMENT:${requirementId}`);
  }
  const covered = new Set(blueprint.steps.flatMap((step) => step.requirementIds));
  for (const requirement of page.coverageRequirements) if (!covered.has(requirement.id)) issues.push(`BLUEPRINT_REQUIREMENT_UNASSIGNED:${requirement.id}`);
  if (blueprint.steps.length !== 6) issues.push("BLUEPRINT_STEP_COUNT_INVALID");
  if (blueprint.resourcePackage.atomIds.some((id) => !validAtoms.has(id))) issues.push("BLUEPRINT_RESOURCE_ATOM_INVALID");
  return issues;
}
