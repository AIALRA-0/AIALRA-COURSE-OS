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

/** Product heading exception; keep the complete Writing/Style sources verbatim. */
export const generatedHeadingInstructions = "生成主要标题合同：仅对自行生成的页面标题、章节／分区标题及实质内容的 Markdown 标题，凡含任何英文（包括缩写和中英混排），必须写成“中文 English”，中文在前、对应英文在后，以空格分隔，不使用中文或英文括号；例如“Attention”或“注意力（Attention）”写成“注意力 Attention”，“Self-Attention”写成“自注意力 Self-Attention”，“注意力 Attention”保持该形式。纯中文标题保持原样，不为它补英文；已有标题编号与 Markdown 层级继续保留。fullExplanationMarkdown 以 Markdown H1 或 H2 主要标题开头，首个主要标题就是当前页教学标题；输入的来源标题含英文时，首个教学标题必须保留对应英文并配上准确中文，例如来源标题“Attention”对应“## 1. 注意力 Attention”，不得用“本次实际问题”“完整讲解”等通用标题替代本页主题。该标题合同在英文语言任务中同样执行，英文任务的正文仍用自然英文；仅在生成主要标题上优先于通用名称括号规则、示例和成文语言要求，阶段提示不得覆盖本标题合同，正文术语与定义继续遵守完整 Writing／Style。原文引用及其中的标题、原始图片及可见标签、代码、文件名和来源作品标题受保护，逐字转写或引用时保持原样；自行拟写的教学标题不能借来源保护规避本合同。任务未要求标题时不新增标题。输出前在同一次成文中逐个复读生成主要标题，不输出检查过程";

/** Validate rule coverage without changing any source text, including examples. */
export function compileWritingStandard(source: string, expectedIds: string[]): string {
  const ids: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of source.split(/\r\n?|\n/u)) {
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*$/u.exec(line)?.[1];
      if (closing && closing[0] === fence.marker && closing.length >= fence.length) fence = undefined;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (opening && (opening[1]![0] !== "`" || !opening[2]!.includes("`"))) {
      fence = { marker: opening[1]![0]!, length: opening[1]!.length };
      continue;
    }
    const heading = /^## (S?\d+)\. /u.exec(line);
    if (heading) ids.push(heading[1]!);
  }
  if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) {
    throw new Error("WRITING_STANDARD_RULE_COVERAGE_MISMATCH");
  }
  return source;
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
  return `${writingStandardsMarker}\n当前规范：APCF Writing / Style ${bundle.version}；快照 ${bundle.policySnapshotId}\n以下为校验过的 Writing 1–29 和 Style S00–S14 全文，原样包含文件前言、全部规则及 Bad / Good 示例；示例用于理解相应规则，不改变其适用边界\n\n${bundle.writing}\n\n${bundle.style}\n\n适用边界：以上规则约束你自行成文的讲解、目标、总结、易错点、题干、选项、答案、解释、承接及复习说明；不要把工程报告或 CHECKLIST 当成课件栏目。JSON 键、机器协议、原文引用、原始代码、公式符号和来源数据受保护，不能翻译、重排或改写。七段教学栏目、数组字段等固定载体按当前产品合同填写；已明确的逐式符号解释要求继续执行。规划与页面理解只输出所请求的内部结果，不添加交付报告或自评；不确定性只限制对应结论，不把识别缺口伪装成页面缺失。${language === "en" ? "本次成文语言是英文；使用自然英文，中文专属格式只适用于实际出现的中文段落，其他理解、因果、来源保护和信息密度规则仍然适用" : "英文输出保持正常英文句法，中文术语规则不改变逐字英文来源"}\n\n${generatedHeadingInstructions}`;
}

/** All provider transports share this boundary; do not duplicate the policy. */
export function withApprovedWritingInstructions(instructions: string, language: string): string {
  // Validate the bundle even when the upstream prompt already contains it.
  const approved = approvedWritingInstructions(language);
  // Keep the heading override once, after all phase-specific instructions.
  // The complete source bundle stays intact and remains the deduplication key.
  const sourcePolicy = approved.slice(0, -generatedHeadingInstructions.length).trimEnd();
  const phaseInstructions = instructions.replaceAll(generatedHeadingInstructions, "").trimEnd();
  const composed = phaseInstructions.includes(sourcePolicy) ? phaseInstructions : `${sourcePolicy}\n\n${phaseInstructions}`;
  return `${composed}\n\n${generatedHeadingInstructions}`;
}
