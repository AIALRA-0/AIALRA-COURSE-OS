/**
 * Adapted from THU-MAIC/OpenMAIC, MIT, commit
 * 1c70e86a13b07ea1ed6a6b160582e2e05aecdb3c:
 * generation/src/prompt-formatters.ts and pipeline-types.ts.
 * Course OS reads existing slides; first/last-page positions do not prescribe
 * greetings or claim that the reader has already studied another page.
 * See OPENMAIC-LICENSE.txt for the upstream license.
 */
export interface SceneGenerationContext {
  pageIndex: number;
  totalPages: number;
  allTitles: string[];
  previousSpeeches: string[];
}

/** Build a course context string for injection into teaching prompts. */
export function buildCourseContext(ctx?: SceneGenerationContext): string {
  if (!ctx) return "";
  const lines: string[] = [];
  lines.push("Course Outline:");
  ctx.allTitles.forEach((t, i) => {
    const marker = i === ctx.pageIndex - 1 ? " ← current" : "";
    lines.push(`  ${i + 1}. ${t}${marker}`);
  });
  lines.push("");
  lines.push("All pages belong to the SAME course material. Use the outline for scope and sequence, not as proof of page facts or of what the learner has already learned.");
  lines.push("");
  if (ctx.pageIndex === 1) {
    lines.push("Position: This is the FIRST page. Introduce the concrete subject of this material.");
  } else if (ctx.pageIndex === ctx.totalPages) {
    lines.push("Position: This is the LAST page. Summarize the material without inventing later content.");
  } else {
    lines.push(`Position: Page ${ctx.pageIndex} of ${ctx.totalPages} (middle of the course).`);
  }
  if (ctx.previousSpeeches.length > 0) {
    lines.push("");
    lines.push("Previous page speech (for transition reference):");
    const lastSpeech = ctx.previousSpeeches[ctx.previousSpeeches.length - 1]!;
    lines.push(`  "...${lastSpeech.slice(-150)}"`);
  }
  return lines.join("\n");
}
