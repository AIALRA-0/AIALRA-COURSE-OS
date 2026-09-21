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

function englishCaseTargets(value: unknown): string[] {
  const visible = (typeof value === "string" ? value : JSON.stringify(value) ?? "")
    .replace(/```[\s\S]*?```|`[^`\n]+`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$|“[^”\n]*”/gu, "");
  const minorWords = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "vs", "with"]);
  return [...new Set([...visible.matchAll(/（([A-Za-z][A-Za-z ]{2,80})）/gu)]
    .map(match => match[1]!)
    .filter(name => name.split(/\s+/u).some((word, index) => /^[a-z]+$/u.test(word) && (index === 0 || !minorWords.has(word)))))];
}

/** Count disjoint changed passages instead of the entire span between distant edits. */
function repairEditSize(before: string, after: string): number {
  const changedSpan = (left: string, right: string) => {
    let prefix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
    let suffix = 0;
    while (suffix < left.length - prefix && suffix < right.length - prefix
      && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
    return Math.max(left.length - prefix - suffix, right.length - prefix - suffix);
  };
  const left = before.split("\n");
  const right = after.split("\n");
  if (left.length * right.length > 250_000) return changedSpan(before, after);
  const width = right.length + 1;
  const common = new Uint16Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
    common[i * width + j] = left[i] === right[j] ? common[(i + 1) * width + j + 1]! + 1
      : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
  }
  let i = 0, j = 0, edited = 0;
  let removed: string[] = [], inserted: string[] = [];
  const flush = () => { edited += changedSpan(removed.join("\n"), inserted.join("\n")); removed = []; inserted = []; };
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { flush(); i++; j++; }
    else if (j === right.length || i < left.length && common[(i + 1) * width + j]! >= common[i * width + j + 1]!) removed.push(left[i++]!);
    else inserted.push(right[j++]!);
    if (edited > 1200) return edited;
  }
  flush();
  return edited;
}

/** Turn every validation finding into a bounded field edit, never a phase rewrite. */
export function generationRepairTickets(phase: string, candidate: Partial<TeachingPackage>, issues: string[], knownAtomIds?: readonly string[]): GenerationRepairTicket[] {
  const allowed = phase === "explanation" ? explanationFields : phase === "consolidation" ? closingFields : openingFields;
  const groups = new Map<RepairField, string[]>();
  for (const issue of issues) {
    let field: RepairField | undefined;
    if (/^PLAN_(?:EVIDENCE|FACT_EVIDENCE)/u.test(issue)) field = "coverageEvidence";
    else if (/^result\./u.test(issue)) field = issue.slice(7).split(/[.:]/u)[0] as RepairField;
    else if (/^TEACHING_(?:FORMAT|PRESENTATION):/u.test(issue)) {
      const parts = issue.split(":");
      const candidate = [parts[1], parts.at(-1)].find(part => allowed.includes(part as RepairField));
      field = candidate as RepairField | undefined;
    }
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
    ...(field === "coverageEvidence" ? { atomIds: [...new Set(fieldIssues.flatMap(issue => {
      const match = /^PLAN_(?:EVIDENCE_(?:QUOTE_MISSING|UNKNOWN_ATOM|UNKNOWN_FIELD|MISSING)|FACT_EVIDENCE_MISSING):(.+)$/u.exec(issue);
      if (!match) {
        const indexed = /^result\.coverageEvidence\.(\d+)(?:[.:]|$)/u.exec(issue);
        const claim = indexed && Array.isArray(candidate.coverageEvidence)
          ? candidate.coverageEvidence[Number(indexed[1])]
          : undefined;
        const atomId = claim && typeof claim === "object" && "atomId" in claim ? String(claim.atomId) : "";
        return atomId && (!knownAtomIds?.length || knownAtomIds.includes(atomId)) ? [atomId] : [];
      }
      const raw = match[1]!;
      if (issue.startsWith("PLAN_EVIDENCE_UNKNOWN_ATOM:")) return [raw];
      if (knownAtomIds?.length) return knownAtomIds.filter(id => raw === id || raw.startsWith(`${id}:`));
      return [raw];
    }))] } : {}),
    instruction: field === "coverageEvidence"
      ? "仅修正覆盖证据：atomId 必须真实存在，explanation 必须逐字摘录完整讲解中的连续原文，coveredFields 只能声明该引文真正解释的内容；不得改写正文或虚构证据"
      : `仅修正 ${field} 字段中列出的问题；保留其余已正确的事实、条件、数值、公式和段落，不输出其他字段。${fieldIssues.some(issue => issue.includes(":TERM_PAIR_MISSING")) ? "先验知识的知识点名称缺少对应英文：核对来源和计划中同一概念的英语原名，写成中文名称（English Name）：，不能猜译或把普通解释短语当正式名称；定义内部实际使用的专业术语也按相同规则配对。" : ""}${fieldIssues.some(issue => issue.includes(":BILINGUAL_TERM_SHAPE")) ? "中英文名称必须逐个一一对应：把‘中文 A 与中文 B（English A, English B）’拆成‘中文 A（English A）与中文 B（English B）’；使用全角中文括号，括号内不并列多个英文名称，不改变定义内容。" : ""}${fieldIssues.some(issue => /result\.questions\.\d+\.prompt:string/u.test(issue)) ? "四道题的每个对象都必须包含非空字符串 prompt；根据当前题目 focus、标准答案和解析补出明确题干，不能省略 prompt，也不能把题干写成数组或对象。" : ""}${fieldIssues.some(issue => /result\.questions\.\d+\.kind:enum/u.test(issue)) ? "题型只能填写 comprehension 或 multiple_choice；理解题使用 comprehension，选择题使用 multiple_choice，不能使用 understanding、choice 或中文别名。" : ""}${fieldIssues.some(issue => issue.includes(":ROLE_LABEL_MISSING")) ? "每处易错点必须依次保留四个段落，段首分别是错误理解：、错因：、正确判断：、核对方法：；只补齐标签与段落边界，不改事实。" : ""}${fieldIssues.some(issue => issue.includes(":ENGLISH_NAME_CASE")) ? `逐一处理这些具体的英文括号：${englishCaseTargets(candidate[field]).join("、")}。先判定它是不是有来源对应的正式名称；普通英文解释短语应删除英文、保留已经写明的中文意思，不能只改为标题式大小写伪装成术语；真正的英文名称才按官方或学术通用写法调整主要实词首字母。` : ""}只有纯公式独占一行时才使用居中的 $$ 公式块；包含文字的条目和段落保持左对齐；并列的符号解释、步骤和比较项分行列举，子项缩进；删除普通中文句号，长段落按语义换行，不改原始引文、代码和公式字符`
  })).filter(ticket => ticket.field !== "coverageEvidence" || !knownAtomIds?.length || (ticket.atomIds?.length ?? 0) > 0);
}

export function applyGenerationRepair<T extends Partial<TeachingPackage>>(candidate: T, ticket: GenerationRepairTicket, patch: Partial<TeachingPackage>): T {
  if (repairHash(candidate[ticket.field]) !== ticket.expectedHash) throw new Error("GENERATION_REPAIR_STALE");
  if (Object.keys(patch).length !== 1 || !Object.prototype.hasOwnProperty.call(patch, ticket.field)) throw new Error("GENERATION_REPAIR_SCOPE_INVALID");
  const before = candidate[ticket.field];
  let after = patch[ticket.field];
  if (ticket.field === "coverageEvidence" && Array.isArray(before) && Array.isArray(after) && ticket.atomIds?.length) {
    const beforeClaims = before as TeachingPackage["coverageEvidence"];
    const afterClaims = after as TeachingPackage["coverageEvidence"];
    const belongsToTicket = (item: unknown) => Boolean(item && typeof item === "object" && "atomId" in item
      && ticket.atomIds!.includes(String(item.atomId)));
    const changedClaims = afterClaims.filter(belongsToTicket);
    if (changedClaims.length === 0) throw new Error("GENERATION_REPAIR_SCOPE_INVALID");
    const merged: TeachingPackage["coverageEvidence"] = [];
    let inserted = false;
    for (const item of beforeClaims) {
      if (belongsToTicket(item)) {
        if (!inserted) merged.push(...changedClaims);
        inserted = true;
      } else merged.push(item);
    }
    if (!inserted) merged.push(...changedClaims);
    // The model may return the whole array and rewrite unrelated claims. Only
    // the ticketed atom is applied; all other claims remain byte-for-byte.
    after = merged as typeof after;
  }
  if (repairHash(after) === ticket.expectedHash) throw new Error("GENERATION_REPAIR_NO_CHANGE");
  if (typeof before === "string" && typeof after === "string") {
    if (repairEditSize(before, after) > 1200) throw new Error("GENERATION_REPAIR_SCOPE_INVALID");
  }
  return { ...candidate, [ticket.field]: after };
}
