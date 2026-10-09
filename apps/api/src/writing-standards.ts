import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface WritingStandardSource {
  path: string;
  sourcePath: string;
  sha256: string;
}

export interface WritingStandardsBundle {
  version: string;
  files: WritingStandardSource[];
  aggregateSha256: string;
  policySnapshotId: string;
  writing: string;
  style: string;
}

export const writingStandardsDirectory = fileURLToPath(new URL("../../../config/generation-harness/", import.meta.url));
export const writingStandardsMarker = "[COURSE_OS_APCF_WRITING_STYLE_V1]";

/** Keep every normative paragraph; teaching examples are not additional rules. */
export function compileWritingStandard(source: string, expectedIds: string[]): string {
  const rules: Array<{ id: string; lines: string[] }> = [];
  let fenced = false;
  let examples = false;
  for (const line of source.replace(/\r\n?/gu, "\n").split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const heading = !fenced ? /^## (S?\d+)\. /u.exec(line) : null;
    if (heading) {
      rules.push({ id: heading[1]!, lines: [line] });
      examples = false;
    } else if (line === "**Bad**") {
      examples = true;
    } else if (rules.length && !examples) {
      rules[rules.length - 1]!.lines.push(line);
    }
  }
  if (JSON.stringify(rules.map(rule => rule.id)) !== JSON.stringify(expectedIds)) {
    throw new Error("WRITING_STANDARD_RULE_COVERAGE_MISMATCH");
  }
  return rules.map(rule => rule.lines.join("\n").trim()).join("\n\n");
}

export function loadWritingStandards(directory = writingStandardsDirectory): WritingStandardsBundle {
  const manifest = JSON.parse(readFileSync(resolve(directory, "../writing-policy-manifest.json"), "utf8")) as {
    standardVersion: string; files: WritingStandardSource[]; aggregateSha256: string; policySnapshotId: string;
  };
  if (manifest.standardVersion !== "v0.1" || manifest.files.length !== 2) throw new Error("WRITING_STANDARD_MANIFEST_INVALID");
  const sources = manifest.files.map(file => {
    if (!/^(writing|style)-standard-source\.md$/u.test(file.path)) throw new Error("WRITING_STANDARD_PATH_INVALID");
    const bytes = readFileSync(resolve(directory, file.path));
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`WRITING_STANDARD_HASH_MISMATCH:${file.path}`);
    return bytes.toString("utf8");
  });
  // Same canonical ordering as stableStringify used by the policy endpoint.
  const aggregate = createHash("sha256").update(JSON.stringify(manifest.files.map(({ path, sha256 }) => ({ path, sha256 })))).digest("hex");
  if (aggregate !== manifest.aggregateSha256 || manifest.policySnapshotId !== `writing-policy:${aggregate.slice(0, 16)}`) {
    throw new Error("WRITING_STANDARD_MANIFEST_HASH_MISMATCH");
  }
  if (manifest.files[0]!.path !== "writing-standard-source.md" || manifest.files[1]!.path !== "style-standard-source.md") {
    throw new Error("WRITING_STANDARD_SOURCE_ORDER_INVALID");
  }
  return {
    version: manifest.standardVersion, files: manifest.files, aggregateSha256: aggregate, policySnapshotId: manifest.policySnapshotId,
    writing: compileWritingStandard(sources[0]!, Array.from({ length: 29 }, (_, i) => String(i + 1))),
    style: compileWritingStandard(sources[1]!, Array.from({ length: 15 }, (_, i) => `S${String(i).padStart(2, "0")}`))
  };
}

export function approvedWritingInstructions(language: string): string {
  const bundle = loadWritingStandards();
  return `${writingStandardsMarker}\n当前规范：APCF Writing / Style ${bundle.version}；快照 ${bundle.policySnapshotId}\n以下包含全部 29 条 Writing 和 S00–S14 Style 的原则、触发、必须、例外及停止条件，逐字来自校验过的规范；Bad / Good 示范不作为额外规则重复输入\n\n${bundle.writing}\n\n${bundle.style}\n\n适用边界：以上规则约束你自行成文的讲解、目标、总结、易错点、题干、选项、答案、解释、承接及复习说明；不要把工程报告或 CHECKLIST 当成课件栏目。JSON 键、机器协议、原文引用、原始代码、公式符号和来源数据受保护，不能翻译、重排或改写。七段教学栏目、数组字段等固定载体按当前产品合同填写；已明确的逐式符号解释要求继续执行。规划与页面理解只输出所请求的内部结果，不添加交付报告或自评；不确定性只限制对应结论，不把识别缺口伪装成页面缺失。${language === "en" ? "本次成文语言是英文；使用自然英文，中文专属格式只适用于实际出现的中文段落，其他理解、因果、来源保护和信息密度规则仍然适用" : "英文输出保持正常英文句法，中文术语规则不改变逐字英文来源"}`;
}

/** All provider transports share this boundary; do not duplicate the policy. */
export function withApprovedWritingInstructions(instructions: string, language: string): string {
  // Validate the bundle even when the upstream prompt already contains it.
  const approved = approvedWritingInstructions(language);
  return instructions.includes(approved) ? instructions : `${approved}\n\n${instructions}`;
}
