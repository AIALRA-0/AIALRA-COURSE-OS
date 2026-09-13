import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TeachingBlueprint } from "@course-os/contracts";

const harnessDir = resolve(fileURLToPath(new URL("../../../config/generation-harness/", import.meta.url)));
const apiSourceDir = resolve(fileURLToPath(new URL("../../../apps/api/src/", import.meta.url)));
const readHarnessFile = (name: string): string => readFileSync(resolve(harnessDir, name), "utf8");
export const teachingSystemPromptTemplate = readHarnessFile("teaching-system-prompt.md");
export const teachingUserPromptTemplate = readHarnessFile("teaching-user-prompt.md");
export const teachingBlueprint = readHarnessFile("teaching-blueprint.md");
export const policyFormatRules = readHarnessFile("policy-format-rules.md");
export const policyExplanationFramework = readHarnessFile("policy-explanation-framework.md");
export const policyFormulaExplanation = readHarnessFile("policy-formula-explanation.md");
export const teachingPackageSchema = JSON.parse(readHarnessFile("teaching-package.schema.json")) as Record<string, unknown>;
const harnessManifest = JSON.parse(readHarnessFile("harness-manifest.json")) as { id: string; version: string; taskContract: "GENERATE + TEACHING" };

export interface PromptInput {
  pageTitle: string;
  pageNumber: number;
  sourceText: string;
  sourceImageDataUrl?: string;
  writingPolicySnapshotId: string;
  language?: string;
  qualityMode?: string;
  blueprint?: TeachingBlueprint;
  previousPageContext?: string;
  repair?: {
    issues: string[];
    maximumExplanationCharacters: number;
    previousTeachingPackage: {
      learningObjectives: string[];
      mainContentMarkdown: string;
      priorKnowledge: string[];
      fullExplanationMarkdown: string;
      misconceptions: string[];
      coverageEvidence: Array<{ atomId: string; coveredFields: string[]; explanation: string }>;
      questions: Array<{ kind: "comprehension" | "multiple_choice"; prompt: string; options?: string[]; expectedAnswer: string; explanation: string }>;
    };
  };
}

export interface GenerationHarnessSnapshot {
  id: string;
  version: string;
  taskContract: "GENERATE + TEACHING";
  files: Array<{ path: string; sha256: string }>;
  aggregateSha256: string;
}

const targetLanguage = (language: string): string => language === "en" ? "English" : "简体中文";
const render = (template: string, values: Record<string, string>): string => Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, value), template);

export function professorInstructions(language: string): string {
  const systemPrompt = render(teachingSystemPromptTemplate, { LANGUAGE: targetLanguage(language) }).trim();
  if (language === "en") return systemPrompt;
  return `${systemPrompt}\n\n---\n\n${policyFormatRules.trim()}\n\n---\n\n${policyExplanationFramework.trim()}\n\n---\n\n${policyFormulaExplanation.trim()}`;
}

export function modelInput(input: PromptInput): string | Array<{ role: "user"; content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "high" }> }> {
  const text = render(teachingUserPromptTemplate, {
    WRITING_POLICY_SNAPSHOT_ID: input.writingPolicySnapshotId,
    LANGUAGE: targetLanguage(input.language || "zh-CN"),
    QUALITY_MODE: input.qualityMode || "balanced",
    PAGE_NUMBER: String(input.pageNumber),
    PAGE_TITLE: input.pageTitle,
    SOURCE_TEXT: input.sourceText.slice(0, 45_000),
    PREVIOUS_PAGE_CONTEXT: input.previousPageContext?.slice(0, 2_000) || "未提供可靠的前页来源；不要编写前页或上一章回顾"
  }).trim();
  // Source atoms and requirements already appear in SOURCE_TEXT. Send only the
  // decisions the blueprint adds, rather than a second copy of the source.
  const blueprintText = input.blueprint ? `\n\n## 本页讲解安排\n${JSON.stringify({
    pageKind: input.blueprint.resourcePackage.pageKind,
    sourceDensity: input.blueprint.resourcePackage.sourceDensity,
    imageAvailable: input.blueprint.resourcePackage.imageAvailable,
    steps: input.blueprint.steps.map(({ kind, objective, required }) => ({ kind, objective, required }))
  })}` : "";
  const repairText = input.repair ? [
    "\n\n## 局部修复任务",
    "下面的对象是上一轮模型草稿，不是 SOURCE，不能用它替代原始课件",
    `只修复这些已验证问题：${input.repair.issues.join("、")}`,
    ...(input.repair.issues.includes("TEACHING_MISCONCEPTION_REASON_MISSING") ? ["每条易错点都要指出误解的具体内容、为什么错，以及正确判断与可执行的核对方法，不能只把结论换一种说法"] : []),
    ...(input.repair.issues.some((issue) => issue.includes("UNPAIRED_ENGLISH")) ? ["逐字段检查承上启下、目标、定义、完整讲解、总结、易错点和四道题的题干与答案解释。普通英文名称或缩写每次出现都要改用已核实的中文名称；首次必须按策略写成中文全称（官方英文全称），缩写放在中文名称之前，不把缩写塞进全角括号。尤其不能让题目解释重新裸用正文已经解释过的缩写。保留课件原始代码标识和合法数学符号"] : []),
    ...(input.repair.issues.includes("TEACHING_PRIOR_DEFINITION_INCOMPLETE") ? ["逐条重写 priorKnowledge：每项只占一个列表项，格式为‘中文全称（已核实的官方英文全称）：是什么；具体做什么；怎样工作；何时使用；如何区分’。按内容选择三至五个完整分句，用中文分号隔开；每句至少十二字，不要把五种关系挤成逗号串，也不要编造英文名称"] : []),
    ...(input.repair.issues.includes("TEACHING_BRIDGE_NEEDS_BLOCKS") ? ["chapterBridgeMarkdown 中前页已知事实与本页要解决的问题必须用空行分成两个自然段；两个独立问题必须分行，不要用分号挤在一个长句里"] : []),
    `fullExplanationMarkdown 最多 ${input.repair.maximumExplanationCharacters} 个字符，必须在完整表达来源事实的前提下压缩到此范围内`,
    "返回完整 TeachingPackage JSON，不得只返回补丁",
    "保留原始课件中的主体、条件、否定、数字、变量、范围和因果关系",
    "保留所有有效 atomId 覆盖声明，并保持恰好 2 道理解题和 2 道选择题",
    "不要新增来源没有提供的事实，不要删掉为理解公式、图形、表格或流程所必需的内容",
    JSON.stringify(input.repair.previousTeachingPackage)
  ].join("\n") : "";
  const finalText = `${text}${blueprintText}${repairText}`;
  if (!input.sourceImageDataUrl) return finalText;
  return [{ role: "user", content: [{ type: "input_text", text: finalText }, { type: "input_image", image_url: input.sourceImageDataUrl, detail: "high" }] }];
}

export function currentGenerationHarness(): GenerationHarnessSnapshot {
  const files = ["teaching-system-prompt.md", "teaching-user-prompt.md", "teaching-blueprint.md", "teaching-package.schema.json", "policy-format-rules.md", "policy-explanation-framework.md", "policy-formula-explanation.md"].map((name) => ({ path: name, sha256: createHash("sha256").update(readHarnessFile(name)).digest("hex") }));
  for (const name of ["generation-harness.ts", "teaching-blueprint.ts", "model-router.ts"]) {
    files.push({ path: `apps/api/src/${name}`, sha256: createHash("sha256").update(readFileSync(resolve(apiSourceDir, name))).digest("hex") });
  }
  files.push({ path: "packages/quality/src/index.ts", sha256: createHash("sha256").update(readFileSync(resolve(apiSourceDir, "../../../packages/quality/src/index.ts"))).digest("hex") });
  const aggregateSha256 = createHash("sha256").update(JSON.stringify({ version: harnessManifest.version, files })).digest("hex");
  return { id: harnessManifest.id, version: harnessManifest.version, taskContract: harnessManifest.taskContract, files, aggregateSha256 };
}
