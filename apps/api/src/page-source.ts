import type { PageLesson } from "@course-os/contracts";

export function preparePageForGeneration(page: PageLesson): PageLesson {
  return structuredClone(page);
}

function learningSourceText(text: string): string {
  return text.split(/\r?\n/).filter((line) => !/^\s*(?:\d+\s*\/\s*\d+|page\s+\d+\s+of\s+\d+)\s*$/iu.test(line)).join("\n").trim();
}

export function buildGenerationSourceText(page: PageLesson): string {
  const extractedText = page.anchors
    .filter((anchor) => typeof anchor.text === "string" && anchor.text.trim().length > 0)
    .map((anchor) => `### ${anchor.label.replace(/^第\s*\d+\s*页离线提取文本$/u, "提取文字")}\n${learningSourceText(anchor.text!)}`)
    .join("\n\n");
  const priorMaterial = !extractedText && page.quality.publishable
    ? page.blocks.map((block) => block.markdown?.trim()).filter(Boolean).join("\n\n") : "";
  return extractedText ? `## 离线提取来源文本\n${extractedText}`
    : priorMaterial ? `## 可用的旧版讲解（供重写参考，不代表原图文字）\n${priorMaterial}`
      : "## 离线提取来源文本\n当前页面没有可用的离线文字，请以原始页面图像为准";
}
