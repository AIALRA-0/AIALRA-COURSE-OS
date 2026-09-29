import type { PageLesson } from "@course-os/contracts";
import { buildCourseContext } from "./upstream/openmaic-course-context.js";

/** Source context is available before generation; never wait for another page. */
export function buildGenerationCourseContext(pages: PageLesson[], pageId: string): string {
  const ordered = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  const index = ordered.findIndex(page => page.id === pageId);
  if (index < 0) return "";
  const outline = buildCourseContext({ pageIndex: index + 1, totalPages: ordered.length,
    allTitles: ordered.map(page => page.title), previousSpeeches: [] });
  const neighbors = [ordered[index - 1], ordered[index + 1]].filter((page): page is PageLesson => Boolean(page));
  const context = neighbors.map(page => {
    // Only extracted source text, never another model's draft or guessed facts.
    const text = page.anchors.map(anchor => anchor.text?.trim()).filter(Boolean).join("\n");
    return `Page ${page.pageNumber}: ${page.title}\n${text || "（邻页无文字层；标题仅供定位）"}`;
  }).join("\n\n");
  return `${outline}\n\nNeighbor source context (not current-page observations):\n${context}`;
}

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
  return extractedText ? `## 离线提取来源文本\n${extractedText}`
    : "## 离线提取来源文本\n当前页面没有可用的离线文字，请以原始页面图像为准";
}
