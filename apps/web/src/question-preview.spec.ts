import type { QuestionBankItem } from "@course-os/contracts";
import { describe, expect, it } from "vitest";
import { createQuestionBatchState, isPracticeReadyQuestion, isQuestionAnswerSaved, parseQuestionBatchState, previewQuestionBank, questionAnswerKey, questionKindLabel, questionOptionLabel, sameQuestionPreview, uniquePracticeQuestions, type QuestionBatchState } from "./question-preview.js";

const item = (id: string, kind: QuestionBankItem["kind"], status: QuestionBankItem["status"] = "approved") => ({
  id,
  pageId: "page-1",
  objectiveId: "objective-1",
  kind,
  prompt: `问题 ${id}`,
  options: kind === "multiple_choice" ? ["正确选项", "其他选项"] : undefined,
  expectedAnswer: kind === "multiple_choice" ? "正确选项" : `参考要点 ${id}`,
  explanation: `解析 ${id}`,
  sourceAnchorIds: [],
  status,
  version: 1,
  generatedBy: "test"
}) as QuestionBankItem;

describe("current-page question preview", () => {
  it("never reports an empty or unconfirmed answer as saved", () => {
    expect(isQuestionAnswerSaved(undefined, undefined)).toBe(false);
    expect(isQuestionAnswerSaved("", "")).toBe(false);
    expect(isQuestionAnswerSaved("   ", undefined)).toBe(false);
    expect(isQuestionAnswerSaved("A", undefined)).toBe(false);
    expect(isQuestionAnswerSaved("A", "B")).toBe(false);
    expect(isQuestionAnswerSaved(" A ", "A")).toBe(true);
  });
  it("matches the server seed order, prefers two single-choice questions and one short answer, and honors the batch size", async () => {
    const bank = [item("c1", "comprehension"), item("m2", "multiple_choice"), item("c2", "comprehension"), item("m1", "multiple_choice"), item("draft", "comprehension", "draft")];
    const seed = "session-1:page-1:2026-09-29";

    expect((await previewQuestionBank(bank, seed)).map(({ id }) => id)).toEqual(["m1", "m2", "c2"]);
    expect((await previewQuestionBank(bank, seed, 2)).map(({ id }) => id)).toEqual(["m1", "c2"]);
    expect((await previewQuestionBank(bank, seed, 5)).map(({ id }) => id)).toEqual(["m1", "m2", "c2", "c1"]);
    expect((await previewQuestionBank(bank, seed, 3, ["m1", "c2"])).map(({ id }) => id)).toEqual(["m2", "c1"]);
  });

  it("rejects damaged or incomplete saved questions without inventing replacements", () => {
    const malformed = { ...item("bad", "multiple_choice"), options: ["only one"] } as QuestionBankItem;
    const wrongType = { ...item("wrong-type", "multiple_choice"), options: ["ok", 4] } as unknown as QuestionBankItem;
    expect(isPracticeReadyQuestion(item("valid", "multiple_choice"))).toBe(true);
    expect(isPracticeReadyQuestion(malformed)).toBe(false);
    expect(isPracticeReadyQuestion(wrongType)).toBe(false);
    expect(uniquePracticeQuestions([item("same-id", "comprehension"), { ...item("same-id", "comprehension"), version: 2 }])).toHaveLength(1);
    expect(uniquePracticeQuestions([item("same-id", "comprehension"), { ...item("same-id", "comprehension"), version: 2 }])[0]?.version).toBe(2);
  });

  it("uses explicit single-choice labels and keeps answer state tied to selection and question version", () => {
    expect(questionKindLabel("multiple_choice")).toBe("单选题");
    expect(questionKindLabel("comprehension")).toBe("简答题");
    expect(questionOptionLabel(0)).toBe("A.");
    expect(questionOptionLabel(1)).toBe("B.");
    expect(questionAnswerKey("selection-a", "q1", 1)).not.toBe(questionAnswerKey("selection-b", "q1", 1));
    expect(questionAnswerKey("selection-a", "q1", 1)).not.toBe(questionAnswerKey("selection-a", "q1", 2));
  });

  it("restores the active count, stable seed, and exhausted-question history after refresh", () => {
    const initial = createQuestionBatchState("session-1", "page-1", "2026-09-29");
    const active: QuestionBatchState = {
      ...initial,
      batchIndex: 2,
      activeSeed: "session-1:page-1:batch:2",
      activeCount: 5,
      requestedCount: 2,
      usedQuestionIds: ["q1", "q2"],
      activeExcludedQuestionIds: ["q1", "q2"]
    };

    expect(parseQuestionBatchState(JSON.stringify(active), "session-1", "page-1", "2026-09-30")).toEqual(active);
    expect(parseQuestionBatchState("invalid", "session-1", "page-1", "2026-09-30")).toEqual(createQuestionBatchState("session-1", "page-1", "2026-09-30"));
  });

  it("detects a changed question even when its ID stayed the same", () => {
    const before = [{ ...item("c1", "comprehension"), prompt: "旧题干", version: 1 }];
    expect(sameQuestionPreview(before, before)).toBe(true);
    expect(sameQuestionPreview(before, [{ ...before[0]!, prompt: "新题干" }])).toBe(false);
    expect(sameQuestionPreview(before, [{ ...before[0]!, version: 2 }])).toBe(false);
  });
});
