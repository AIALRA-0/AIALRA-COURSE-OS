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
export const teachingPackageSchema = JSON.parse(readHarnessFile("teaching-package.schema.json")) as Record<string, unknown>;

export interface PromptInput {
  pageTitle: string;
  pageNumber: number;
  sourceText: string;
  sourceImageDataUrl?: string;
  writingPolicySnapshotId: string;
  language?: string;
  qualityMode?: string;
  blueprint?: TeachingBlueprint;
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
  return render(teachingSystemPromptTemplate, { LANGUAGE: targetLanguage(language) }).trim();
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
  const finalText = `${text}${blueprintText}`;
  if (!input.sourceImageDataUrl) return finalText;
  return [{ role: "user", content: [{ type: "input_text", text: finalText }, { type: "input_image", image_url: input.sourceImageDataUrl, detail: "high" }] }];
}

export function currentGenerationHarness(): GenerationHarnessSnapshot {
  const files = ["teaching-system-prompt.md", "teaching-user-prompt.md", "teaching-blueprint.md", "teaching-package.schema.json"].map((name) => ({ path: name, sha256: createHash("sha256").update(readHarnessFile(name)).digest("hex") }));
  const aggregateSha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return { id: "course-os-teaching", version: "1.2.0", taskContract: "GENERATE + TEACHING", files, aggregateSha256 };
}
