import type { TeachingPackage, SemanticAuditResult } from "./model-router.js";

/** Apply only unambiguous minimal corrections; never accept a wholesale model rewrite. */
export function applySemanticAuditFindings(content: TeachingPackage, findings: SemanticAuditResult["findings"]): { content: TeachingPackage; fields: string[] } {
  const corrected = structuredClone(content);
  const fields: string[] = [];
  for (const finding of findings) {
    if (!finding.original.trim() || !finding.replacement.trim() || !finding.evidence.trim()
      || finding.original.length > 1200 || finding.replacement.length > 1200 || finding.evidence.length > 500) throw new Error("TEACHING_SEMANTIC_AUDIT_INVALID");
    let value: string;
    let set: (text: string) => void;
    if (finding.field === "fullExplanationMarkdown" || finding.field === "mainContentMarkdown" || finding.field === "chapterBridgeMarkdown") {
      value = corrected[finding.field] || "";
      set = (text) => { corrected[finding.field as "fullExplanationMarkdown" | "mainContentMarkdown" | "chapterBridgeMarkdown"] = text; };
    } else if (/^(?:misconceptions|priorKnowledge|learningObjectives):[0-9]+$/.test(finding.field)) {
      const field = finding.field.split(":")[0] as "misconceptions" | "priorKnowledge" | "learningObjectives";
      const index = Number(finding.field.split(":")[1]);
      value = corrected[field][index] ?? "";
      set = (text) => { corrected[field][index] = text; };
    } else if (/^questions:[0-9]+:(?:prompt|expectedAnswer|explanation)$/.test(finding.field)) {
      const [, position, field] = finding.field.split(":");
      const question = corrected.questions[Number(position)];
      if (!question) throw new Error("TEACHING_SEMANTIC_AUDIT_FIELD_INVALID");
      const key = field as "prompt" | "expectedAnswer" | "explanation";
      value = question[key];
      set = (text) => { question[key] = text; };
    } else if (/^questions:[0-9]+:options:[0-9]+$/.test(finding.field)) {
      const [, position, , optionPosition] = finding.field.split(":");
      const options = corrected.questions[Number(position)]?.options;
      if (!options || options[Number(optionPosition)] === undefined) throw new Error("TEACHING_SEMANTIC_AUDIT_FIELD_INVALID");
      value = options[Number(optionPosition)]!;
      set = (text) => { options[Number(optionPosition)] = text; };
    } else throw new Error("TEACHING_SEMANTIC_AUDIT_FIELD_INVALID");
    const at = value.indexOf(finding.original);
    if (finding.original === finding.replacement) throw new Error("TEACHING_SEMANTIC_AUDIT_QUOTE_INVALID");
    if (at < 0) {
      // A later audit can repeat a correction already applied by the first
      // source pass. Treat one exact replacement as an idempotent finding;
      // every genuinely missing or ambiguous quote still fails closed.
      const replacementAt = value.indexOf(finding.replacement);
      if (replacementAt >= 0 && value.lastIndexOf(finding.replacement) === replacementAt) continue;
      throw new Error("TEACHING_SEMANTIC_AUDIT_QUOTE_INVALID");
    }
    if (value.lastIndexOf(finding.original) !== at) throw new Error("TEACHING_SEMANTIC_AUDIT_QUOTE_INVALID");
    const updated = value.slice(0, at) + finding.replacement + value.slice(at + finding.original.length);
    set(updated);
    if (finding.field === "fullExplanationMarkdown") {
      for (const evidence of corrected.coverageEvidence) {
        // An excerpt containing the exact corrected words changes in the same
        // transaction. Never replace an unrelated excerpt with an entire paragraph.
        if (!evidence.explanation.includes(finding.original)) continue;
        const excerpt = evidence.explanation.replace(finding.original, finding.replacement);
        if (updated.includes(excerpt)) evidence.explanation = excerpt;
      }
    }
    fields.push(finding.field);
  }
  return { content: corrected, fields };
}
