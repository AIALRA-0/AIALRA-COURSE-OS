import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TeachingBlueprint } from "@course-os/contracts";

const harnessDir = resolve(fileURLToPath(new URL("../../../config/generation-harness/", import.meta.url)));
const readHarnessFile = (name: string): string => readFileSync(resolve(harnessDir, name), "utf8");
export const teachingSystemPromptTemplate = readHarnessFile("teaching-system-prompt.md");
export const teachingUserPromptTemplate = readHarnessFile("teaching-user-prompt.md");
export const teachingBlueprint = readHarnessFile("teaching-blueprint.md");
export const policyFormatRules = readHarnessFile("policy-format-rules.md");
export const policyExplanationFramework = readHarnessFile("policy-explanation-framework.md");
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
  return `${systemPrompt}\n\n---\n\n${policyFormatRules.trim()}\n\n---\n\n${policyExplanationFramework.trim()}`;
}

export function modelInput(input: PromptInput): string | Array<{ role: "user"; content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "high" }> }> {
  const text = render(teachingUserPromptTemplate, {
    WRITING_POLICY_SNAPSHOT_ID: input.writingPolicySnapshotId,
    LANGUAGE: targetLanguage(input.language || "zh-CN"),
    QUALITY_MODE: input.qualityMode || "balanced",
    PAGE_NUMBER: String(input.pageNumber),
    PAGE_TITLE: input.pageTitle,
    SOURCE_TEXT: input.sourceText.slice(0, 45_000)
  }).trim();
  const blueprintText = input.blueprint ? `\n\n## 教学蓝图（必须遵循）\n${JSON.stringify(input.blueprint)}` : "";
  const repairText = input.repair ? [
    "\n\n## 局部修复任务",
    "下面的对象是上一轮模型草稿，不是 SOURCE，不能用它替代原始课件",
    `只修复这些已验证问题：${input.repair.issues.join("、")}`,
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
  const files = ["teaching-system-prompt.md", "teaching-user-prompt.md", "teaching-blueprint.md", "teaching-package.schema.json", "policy-format-rules.md", "policy-explanation-framework.md"].map((name) => ({ path: name, sha256: createHash("sha256").update(readHarnessFile(name)).digest("hex") }));
  const aggregateSha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return { id: harnessManifest.id, version: harnessManifest.version, taskContract: harnessManifest.taskContract, files, aggregateSha256 };
}
