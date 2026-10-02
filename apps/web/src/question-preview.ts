import type { QuestionBankItem, QuestionKind } from "@course-os/contracts";

export const QUESTION_BATCH_SIZES = [2, 3, 5] as const;
export type QuestionBatchSize = typeof QUESTION_BATCH_SIZES[number];

export function isQuestionAnswerSaved(answer: string | undefined, savedAnswer: string | undefined): boolean {
  return Boolean(answer?.trim()) && savedAnswer !== undefined && answer!.trim() === savedAnswer;
}

export interface QuestionBatchState {
  batchIndex: number;
  activeSeed: string;
  activeCount: QuestionBatchSize;
  requestedCount: QuestionBatchSize;
  usedQuestionIds: string[];
  activeExcludedQuestionIds: string[];
}

export function createQuestionBatchState(sessionId: string, pageId: string, today = new Date().toISOString().slice(0, 10)): QuestionBatchState {
  return {
    batchIndex: 0,
    activeSeed: `${sessionId}:${pageId}:${today}`,
    activeCount: 3,
    requestedCount: 3,
    usedQuestionIds: [],
    activeExcludedQuestionIds: []
  };
}

export function parseQuestionBatchState(serialized: string | null, sessionId: string, pageId: string, today?: string): QuestionBatchState {
  const fallback = createQuestionBatchState(sessionId, pageId, today);
  if (!serialized) return fallback;
  try {
    const value = JSON.parse(serialized) as Partial<QuestionBatchState>;
    const validCount = (count: unknown): count is QuestionBatchSize => QUESTION_BATCH_SIZES.includes(count as QuestionBatchSize);
    if (!Number.isSafeInteger(value.batchIndex) || (value.batchIndex ?? -1) < 0
      || typeof value.activeSeed !== "string" || !value.activeSeed.startsWith(`${sessionId}:${pageId}:`)
      || !validCount(value.activeCount) || !validCount(value.requestedCount)
      || !Array.isArray(value.usedQuestionIds) || !value.usedQuestionIds.every((id) => typeof id === "string")
      || !Array.isArray(value.activeExcludedQuestionIds) || !value.activeExcludedQuestionIds.every((id) => typeof id === "string")) return fallback;
    return {
      batchIndex: value.batchIndex!,
      activeSeed: value.activeSeed,
      activeCount: value.activeCount,
      requestedCount: value.requestedCount,
      usedQuestionIds: [...new Set(value.usedQuestionIds)],
      activeExcludedQuestionIds: [...new Set(value.activeExcludedQuestionIds)]
    };
  } catch {
    return fallback;
  }
}

export function questionBatchStorageKey(sessionId: string, pageId: string): string {
  return `course-os:question-batch:${JSON.stringify([sessionId, pageId])}`;
}

export function readQuestionBatchState(sessionId: string, pageId: string): QuestionBatchState {
  if (typeof window === "undefined") return createQuestionBatchState(sessionId, pageId);
  try {
    return parseQuestionBatchState(window.sessionStorage.getItem(questionBatchStorageKey(sessionId, pageId)), sessionId, pageId);
  } catch {
    return createQuestionBatchState(sessionId, pageId);
  }
}

export function writeQuestionBatchState(sessionId: string, pageId: string, state: QuestionBatchState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(questionBatchStorageKey(sessionId, pageId), JSON.stringify(state));
  } catch {
    // The in-memory batch remains usable when browser storage is unavailable.
  }
}

export function questionKindLabel(kind: QuestionKind): string {
  return kind === "multiple_choice" ? "单选题" : "简答题";
}

export function questionOptionLabel(index: number): string {
  return `${String.fromCharCode(65 + index)}.`;
}

export function questionAnswerKey(selectionId: string, questionId: string, version: number): string {
  return JSON.stringify([selectionId, questionId, version]);
}

export async function previewQuestionBank(
  bank: QuestionBankItem[],
  seed: string,
  count = 3,
  excludedQuestionIds: string[] = []
): Promise<QuestionBankItem[]> {
  const excluded = new Set(excludedQuestionIds);
  const approved = uniquePracticeQuestions(bank).filter((item) => !excluded.has(item.id));
  const scored = await Promise.all(approved.map(async (item) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${seed}:${item.id}`));
    const score = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { item, score };
  }));
  const ordered = (kind: QuestionKind) => scored.filter(({ item }) => item.kind === kind)
    .sort((left, right) => left.score.localeCompare(right.score)).map(({ item }) => item);
  const singleChoice = ordered("multiple_choice");
  const shortAnswer = ordered("comprehension");
  const plan = questionKindPlan(count);
  const selected: QuestionBankItem[] = [];
  for (const kind of plan) {
    const preferred = kind === "multiple_choice" ? singleChoice : shortAnswer;
    const fallback = kind === "multiple_choice" ? shortAnswer : singleChoice;
    const item = preferred.shift() ?? fallback.shift();
    if (item) selected.push(item);
  }
  return selected;
}

export function isPracticeReadyQuestion(item: QuestionBankItem): boolean {
  if (!item || typeof item !== "object"
    || typeof item.id !== "string" || !item.id.trim()
    || typeof item.pageId !== "string" || !item.pageId.trim()
    || typeof item.objectiveId !== "string" || !item.objectiveId.trim()
    || typeof item.prompt !== "string" || !item.prompt.trim()
    || typeof item.expectedAnswer !== "string" || !item.expectedAnswer.trim()
    || typeof item.explanation !== "string" || !item.explanation.trim()
    || item.status !== "approved"
    || !Number.isInteger(item.version) || item.version < 1) return false;
  if (item.kind === "comprehension") return true;
  if (item.kind !== "multiple_choice" || !Array.isArray(item.options)
    || !item.options.every((option) => typeof option === "string" && Boolean(option.trim()))) return false;
  const options = item.options?.map((option) => option.trim()).filter(Boolean) ?? [];
  return options.length >= 2
    && new Set(options.map(normalizeChoice)).size >= 2
    && options.some((option) => normalizeChoice(option) === normalizeChoice(item.expectedAnswer));
}

export function uniquePracticeQuestions(bank: QuestionBankItem[]): QuestionBankItem[] {
  const byId = new Map<string, QuestionBankItem>();
  for (const item of bank) {
    if (!isPracticeReadyQuestion(item)) continue;
    const current = byId.get(item.id);
    if (!current || item.version > current.version) byId.set(item.id, item);
  }
  return [...byId.values()];
}

export function sameQuestionPreview(preview: QuestionBankItem[], saved: QuestionBankItem[]): boolean {
  const signature = (items: QuestionBankItem[]) => JSON.stringify(items.map(({ id, pageId, objectiveId, version, kind, prompt, options, expectedAnswer, explanation }) =>
    ({ id, pageId, objectiveId, version, kind, prompt, options, expectedAnswer, explanation })));
  return signature(preview) === signature(saved);
}

function questionKindPlan(count: number): QuestionKind[] {
  if (count === 2) return ["multiple_choice", "comprehension"];
  if (count === 3) return ["multiple_choice", "multiple_choice", "comprehension"];
  if (count === 5) return ["multiple_choice", "multiple_choice", "comprehension", "multiple_choice", "multiple_choice"];
  const choiceCount = Math.min(count, Math.max(1, Math.round(count * 2 / 3)));
  return Array.from({ length: Math.max(0, count) }, (_, index) => index < choiceCount ? "multiple_choice" : "comprehension");
}

function normalizeChoice(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s，。,.；;：:]/g, "");
}
