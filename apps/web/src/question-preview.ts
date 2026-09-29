import type { QuestionBankItem } from "@course-os/contracts";

// Match the server's seed and SHA-256 ordering so the preview never substitutes a different pair.
export async function previewQuestionBank(bank: QuestionBankItem[], seed: string, count = 2): Promise<QuestionBankItem[]> {
  const approved = bank.filter((item) => item.status === "approved");
  const scored = await Promise.all(approved.map(async (item) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${seed}:${item.id}`));
    const score = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { item, score };
  }));
  const ordered = (kind: QuestionBankItem["kind"]) => scored.filter(({ item }) => item.kind === kind)
    .sort((left, right) => left.score.localeCompare(right.score)).map(({ item }) => item);
  const comprehension = ordered("comprehension");
  const choice = ordered("multiple_choice");
  const selected: QuestionBankItem[] = [];
  while (selected.length < count && (comprehension.length || choice.length)) {
    const preferred = selected.length % 2 === 0 ? comprehension : choice;
    const fallback = preferred.length ? preferred : selected.length % 2 === 0 ? choice : comprehension;
    const item = fallback.shift();
    if (item) selected.push(item);
  }
  return selected;
}

export function sameQuestionPreview(preview: QuestionBankItem[], saved: QuestionBankItem[]): boolean {
  const signature = (items: QuestionBankItem[]) => JSON.stringify(items.map(({ id, version, kind, prompt, options, expectedAnswer }) => ({ id, version, kind, prompt, options, expectedAnswer })));
  return signature(preview) === signature(saved);
}
