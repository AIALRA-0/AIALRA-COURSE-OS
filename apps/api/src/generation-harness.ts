import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const harnessDir = resolve(fileURLToPath(new URL("../../../config/generation-harness/", import.meta.url)));
const apiSourceDir = resolve(fileURLToPath(new URL("../../../apps/api/src/", import.meta.url)));
const readHarnessFile = (name: string): string => readFileSync(resolve(harnessDir, name), "utf8");

export const policySkill = readHarnessFile("policy-skill.md");
export const policyFormatRules = readHarnessFile("policy-format-rules.md");
export const policyExplanationFramework = readHarnessFile("policy-explanation-framework.md");
export const policyFormulaExplanation = readHarnessFile("policy-formula-explanation.md");
export const teachingPackageSchema = JSON.parse(readHarnessFile("teaching-package.schema.json")) as Record<string, unknown>;

const harnessManifest = JSON.parse(readHarnessFile("harness-manifest.json")) as {
  id: string;
  version: string;
  taskContract: "GENERATE + TEACHING";
  promptFiles: string[];
  schemaFile: string;
};

export interface GenerationHarnessSnapshot {
  id: string;
  version: string;
  taskContract: "GENERATE + TEACHING";
  files: Array<{ path: string; sha256: string }>;
  aggregateSha256: string;
}

export function generationHarnessFileSha256(value: string | Buffer): string {
  const canonical = (typeof value === "string" ? value : value.toString("utf8")).replace(/\r\n?/gu, "\n");
  return createHash("sha256").update(canonical).digest("hex");
}

/** Every Chinese-writing model call receives the complete approved snapshot. */
export function writingPolicyInstructions(language: string): string {
  if (language === "en") return "";
  const fullPolicy = [policySkill, policyFormatRules, policyExplanationFramework, policyFormulaExplanation]
    .map((part) => part.trim()).join("\n\n---\n\n");
  return `以下是当前批准写作技能的四份完整原文，不是节选。逐份通读后按适用的成文规则输出；文件操作、中间件命令和交付流程由 Course OS 执行，不写入学习正文\n\n${fullPolicy}`;
}

export function currentGenerationHarness(): GenerationHarnessSnapshot {
  const files = harnessManifest.promptFiles.concat(harnessManifest.schemaFile)
    .map((name) => ({ path: name, sha256: generationHarnessFileSha256(readHarnessFile(name)) }));
  // Content semantics are pinned; runtime orchestration can change without
  // invalidating work already in progress.
  for (const name of ["generation-harness.ts", "model-router.ts", "model-usage-meter.ts", "pricing.ts", "planned-teaching.ts"]) {
    files.push({ path: `apps/api/src/${name}`, sha256: generationHarnessFileSha256(readFileSync(resolve(apiSourceDir, name))) });
  }
  files.push({ path: "packages/quality/src/presentation.ts", sha256: generationHarnessFileSha256(readFileSync(resolve(apiSourceDir, "../../../packages/quality/src/presentation.ts"))) });
  const aggregateSha256 = createHash("sha256").update(JSON.stringify({ version: harnessManifest.version, files })).digest("hex");
  return { id: harnessManifest.id, version: harnessManifest.version, taskContract: harnessManifest.taskContract, files, aggregateSha256 };
}
