import type { QuestionBankItem } from "./index.js";

/** Deterministic feedback shared by the learner preview and the authoritative save. */
export function evaluateQuestionAnswer(item: QuestionBankItem, answer: string): boolean | null {
  const normalize = (value: string) => value.toLowerCase().replace(/[\s，。,.；;：:]/g, "");
  if (normalize(answer) === normalize(item.expectedAnswer)) return true;
  if (item.kind === "multiple_choice") {
    const options = Array.isArray(item.options) ? item.options.filter((option): option is string => typeof option === "string") : [];
    if (options.length < 2) return null;
    return options.some((option) => normalize(option) === normalize(answer)) ? false : null;
  }
  const numeric = (value: string): number | undefined => {
    const normalized = value.trim().replace(/^\$|\$$/g, "").replace(/,/g, "");
    return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized) ? Number(normalized) : undefined;
  };
  const expected = numeric(item.expectedAnswer);
  const supplied = numeric(answer);
  if (expected !== undefined && supplied !== undefined) return Math.abs(expected - supplied) <= Math.max(1e-9, Math.abs(expected) * 1e-9);
  return null;
}
