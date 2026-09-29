import type { QuestionBankItem } from "@course-os/contracts";
import { describe, expect, it } from "vitest";
import { previewQuestionBank, sameQuestionPreview } from "./question-preview.js";

const item = (id: string, kind: QuestionBankItem["kind"], status: QuestionBankItem["status"] = "approved") => ({
  id, kind, status
}) as QuestionBankItem;

describe("current-page question preview", () => {
  it("uses the server's SHA-256 seed order and excludes drafts", async () => {
    const bank = [item("c1", "comprehension"), item("m2", "multiple_choice"), item("c2", "comprehension"), item("m1", "multiple_choice"), item("draft", "comprehension", "draft")];
    const seed = "session-1:page-1:2026-09-29";
    expect((await previewQuestionBank(bank, seed)).map(({ id }) => id)).toEqual(["c2", "m1"]);
    expect((await previewQuestionBank(bank, seed, 4)).map(({ id }) => id)).toEqual(["c2", "m1", "c1", "m2"]);
  });

  it("rejects a changed question even when its ID stayed the same", () => {
    const before = [{ ...item("c1", "comprehension"), prompt: "旧题干", version: 1 }];
    expect(sameQuestionPreview(before, before)).toBe(true);
    expect(sameQuestionPreview(before, [{ ...before[0]!, prompt: "新题干" }])).toBe(false);
  });
});
