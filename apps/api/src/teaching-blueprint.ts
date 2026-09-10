import { createHash } from "node:crypto";
import type { PageLesson, TeachingBlueprint, TeachingBlueprintStep } from "@course-os/contracts";
import { stableStringify } from "@course-os/domain";

const requiredSections = ["learning_objectives", "main_content", "prior_knowledge", "full_explanation", "misconceptions"] as const;

export function buildTeachingBlueprint(page: PageLesson, sourceText: string, language: string, qualityMode: string, writingPolicySnapshotId: string, imageAvailable: boolean): TeachingBlueprint {
  const atomIds = page.atoms.map((atom) => atom.id);
  const requirementIds = page.coverageRequirements.map((requirement) => requirement.id);
  const pageKind = classifyTeachingPage(page, sourceText);
  const sourceDensity = classifySourceDensity(sourceText);
  const technicalPage = ["formula", "diagram", "table", "code", "mixed"].includes(pageKind);
  const steps: TeachingBlueprintStep[] = [
    { id: `${page.id}:purpose`, kind: "purpose", objective: "用日常语言说明这页要解决的问题和可验证学习结果", atomIds: [], requirementIds: [], output: "根据页面类型决定是否需要独立开头", required: true },
    { id: `${page.id}:objects`, kind: "object_reading", objective: "按页面自然顺序识别全部有效对象，排除装饰与重复页眉页脚", atomIds, requirementIds: [], output: "解释怎样阅读原对象以及每项内容说明什么", required: true },
    { id: `${page.id}:relations`, kind: "relationship", objective: "补齐必要前提，再解释对象之间的关系、因果和执行顺序", atomIds, requirementIds, output: "使用由实际内容命名的自然区块", required: pageKind !== "cover" },
    { id: `${page.id}:example`, kind: "example", objective: "仅在来源包含计算、抽象机制或多步操作时给出可复算或可复现示范", atomIds, requirementIds: [], output: "来源不足时不生成例子，不补造数字", required: technicalPage },
    { id: `${page.id}:boundary`, kind: "boundary", objective: "在条件首次使用的位置说明否定、范围、例外、失败条件和易错点", atomIds, requirementIds, output: "没有真实边界时不制造空泛警告", required: pageKind !== "cover" },
    { id: `${page.id}:recap`, kind: "recap", objective: "仅在复杂页面需要回收时总结对象、关系、结论和下一步", atomIds: [], requirementIds: [], output: "不得重复正文或套用固定结尾", required: sourceDensity === "dense" }
  ];
  const blueprintWithoutHash = {
    version: "2.0.0" as const,
    pageId: page.id,
    pageNumber: page.pageNumber,
    resourcePackage: { version: "2.0.0" as const, pageId: page.id, pageTitle: page.title, sourceText: sourceText.slice(0, 45_000), sourceAnchorIds: page.anchors.map((anchor) => anchor.id), atomIds, imageAvailable, pageKind, sourceDensity },
    requirementPackage: { version: "2.0.0" as const, requirements: page.coverageRequirements, objective: `让零基础读者能够理解并使用第 ${page.pageNumber} 页“${page.title}”中的全部有效内容`, requiredSections: [...requiredSections] },
    rulePackage: { version: "2.0.0" as const, language, qualityMode, rules: ["执行批准写作策略的全部格式与解释规则", "正文结构服从页面内容而不是固定模板", "来源、背景和推断不能混写", "每个要求绑定真实 atomId 和正文证据", "避免重复句、装饰性说明和流水线标签", "保留条件、否定、数字、变量、范围与因果", "专业术语首次完整定义", "公式使用合法 KaTeX", "每页 2 道理解题和 2 道选择题"], questionRule: { comprehension: 2, multipleChoice: 2, optionsPerMultipleChoice: 4 } },
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
  const stepKinds = new Set(blueprint.steps.map((step) => step.kind));
  if (!stepKinds.has("purpose") || !stepKinds.has("object_reading")) issues.push("BLUEPRINT_CORE_STEPS_MISSING");
  if (stepKinds.size !== blueprint.steps.length) issues.push("BLUEPRINT_STEP_KIND_DUPLICATE");
  if (blueprint.resourcePackage.atomIds.some((id) => !validAtoms.has(id))) issues.push("BLUEPRINT_RESOURCE_ATOM_INVALID");
  return issues;
}

function classifyTeachingPage(page: PageLesson, sourceText: string): TeachingBlueprint["resourcePackage"]["pageKind"] {
  const value = `${page.title}\n${sourceText}`;
  const kinds = new Set(page.atoms.map((atom) => atom.kind));
  if (/(目录|大纲|outline|agenda|contents)/i.test(page.title)) return "agenda";
  if (kinds.has("pseudocode_line") || kinds.has("code_block") || /```|\b(?:for|while|if|else|return)\b/i.test(sourceText)) return "code";
  if (/\|[^\n]+\|[^\n]+\|/.test(sourceText)) return "table";
  if (kinds.has("math_expression") || /\\(?:frac|sum|prod|int|sqrt|begin)|[$][^$\n]+[$]/.test(sourceText)) return "formula";
  if (kinds.has("diagram_node") || kinds.has("diagram_edge")) return "diagram";
  const mediaSignals = [/(图|figure|diagram|graph)/i.test(value), /(表|table)/i.test(value), /(公式|equation)/i.test(value)].filter(Boolean).length;
  if (mediaSignals > 1) return "mixed";
  if (page.pageNumber === 1 && page.atoms.every((atom) => atom.kind === "image_region")) return "cover";
  return "concept";
}

function classifySourceDensity(sourceText: string): TeachingBlueprint["resourcePackage"]["sourceDensity"] {
  const visibleCharacters = sourceText.replace(/```[\s\S]*?```/g, "").replace(/[\s{}[\]\"':,]/g, "").length;
  if (visibleCharacters < 500) return "sparse";
  if (visibleCharacters > 2_000) return "dense";
  return "normal";
}
