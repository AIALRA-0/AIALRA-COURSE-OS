import { createHash } from "node:crypto";
import { validateMarkdownMath } from "@course-os/quality";
import type { TeachingPackage } from "./model-router.js";

export type RepairField = keyof TeachingPackage;
export interface GenerationRepairTicket {
  phase: string;
  field: RepairField;
  issues: string[];
  expectedHash: string;
  instruction: string;
  atomIds?: string[];
}

export function repairHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
}

const explanationFields: RepairField[] = ["fullExplanationMarkdown", "coverageEvidence"];
const closingFields: RepairField[] = ["mainContentMarkdown", "misconceptions", "questions"];
const openingFields: RepairField[] = ["chapterBridgeMarkdown", "priorKnowledge", "learningObjectives"];

/** Turn every validation finding into a bounded field edit, never a phase rewrite. */
export function generationRepairTickets(phase: string, candidate: Partial<TeachingPackage>, issues: string[], knownAtomIds?: readonly string[]): GenerationRepairTicket[] {
  const allowed = phase === "explanation" ? explanationFields : phase === "consolidation" ? closingFields : openingFields;
  const groups = new Map<RepairField, string[]>();
  for (const issue of issues) {
    let field: RepairField | undefined;
    if (/^PLAN_(?:EVIDENCE|FACT_EVIDENCE)/u.test(issue)) field = "coverageEvidence";
    else if (/^result\./u.test(issue)) field = issue.slice(7).split(/[.:]/u)[0] as RepairField;
    else if (issue === "PLAN_QUESTION_MIX" || issue === "PLAN_QUESTION_ANSWER_INVALID") field = "questions";
    else if (issue.startsWith("MATH_") || issue.includes("MATH_") || issue.includes("DELIMITER")) {
      field = allowed.find(key => {
        const value = candidate[key];
        return typeof value === "string" ? validateMarkdownMath(value).length > 0
          : Array.isArray(value) && value.some(item => validateMarkdownMath(typeof item === "string" ? item : JSON.stringify(item)).length > 0);
      });
    }
    // Keep safe tickets even when another finding needs a separate diagnosis.
    // The caller revalidates every issue and cannot mark the phase complete.
    if (!field || !allowed.includes(field)) continue;
    groups.set(field, [...(groups.get(field) ?? []), issue]);
  }
  return [...groups].map(([field, fieldIssues]) => ({
    phase, field, issues: fieldIssues, expectedHash: repairHash(candidate[field]),
    ...(field === "coverageEvidence" ? { atomIds: fieldIssues.flatMap(issue => {
      const match = /^PLAN_(?:EVIDENCE_(?:QUOTE_MISSING|UNKNOWN_ATOM|UNKNOWN_FIELD|MISSING)|FACT_EVIDENCE_MISSING):(.+)$/u.exec(issue);
      if (!match) return [];
      const raw = match[1]!;
      if (issue.startsWith("PLAN_EVIDENCE_UNKNOWN_ATOM:")) return [raw];
      if (knownAtomIds?.length) return knownAtomIds.filter(id => raw === id || raw.startsWith(`${id}:`));
      return [raw];
    }) } : {}),
    instruction: field === "coverageEvidence"
      ? "仅修正覆盖证据：atomId 必须真实存在，explanation 必须逐字摘录完整讲解中的连续原文，coveredFields 只能声明该引文真正解释的内容；不得改写正文或虚构证据"
      : `仅修正 ${field} 字段中列出的问题；保留其余已正确的事实、条件、数值、公式和段落，不输出其他字段`
  })).filter(ticket => ticket.field !== "coverageEvidence" || !knownAtomIds?.length || (ticket.atomIds?.length ?? 0) > 0);
}

export function applyGenerationRepair<T extends Partial<TeachingPackage>>(candidate: T, ticket: GenerationRepairTicket, patch: Partial<TeachingPackage>): T {
  if (repairHash(candidate[ticket.field]) !== ticket.expectedHash) throw new Error("GENERATION_REPAIR_STALE");
  if (Object.keys(patch).length !== 1 || !Object.prototype.hasOwnProperty.call(patch, ticket.field)) throw new Error("GENERATION_REPAIR_SCOPE_INVALID");
  if (repairHash(patch[ticket.field]) === ticket.expectedHash) throw new Error("GENERATION_REPAIR_NO_CHANGE");
  const before = candidate[ticket.field], after = patch[ticket.field];
  if (ticket.field === "coverageEvidence" && Array.isArray(before) && Array.isArray(after) && ticket.atomIds?.length) {
    const protectedClaims = (entries: typeof before) => entries.filter(item => item && typeof item === "object"
      && "atomId" in item && !ticket.atomIds!.includes(String(item.atomId)));
    if (repairHash(protectedClaims(before)) !== repairHash(protectedClaims(after))) throw new Error("GENERATION_REPAIR_SCOPE_INVALID");
  }
  if (typeof before === "string" && typeof after === "string") {
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix
      && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    if (Math.max(before.length - prefix - suffix, after.length - prefix - suffix) > 1200) throw new Error("GENERATION_REPAIR_SCOPE_INVALID");
  }
  return { ...candidate, [ticket.field]: patch[ticket.field] };
}
