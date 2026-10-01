import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { IdempotentWriteContext, QuestionSelection } from "@course-os/contracts";
import { EtapiReadWeaveCourseApi } from "./etapi.js";
import { FileReadWeaveCourseApi, HttpReadWeaveCourseApi } from "./index.js";

const selection: QuestionSelection = {
  id: "selection-1", sessionId: "session-1", courseReleaseId: "release-1", pageId: "page-1",
  seed: "stable-seed", questionIds: ["question-1"],
  questionSnapshots: [{
    id: "question-1", pageId: "page-1", objectiveId: "objective-1", kind: "multiple_choice",
    prompt: "Select", options: ["A", "B"], expectedAnswer: "A", explanation: "A is correct.",
    sourceAnchorIds: [], status: "approved", version: 3, generatedBy: "test"
  }],
  createdAt: "2026-09-30T00:00:00.000Z"
};

describe("getQuestionSelection", () => {
  it("reads an exact persisted File selection and returns a detached snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-selection-file-"));
    const api = new FileReadWeaveCourseApi(join(root, "readweave.json"));
    await api.saveQuestionSelection(selection, writeContext("selection-write"));

    const found = await api.getQuestionSelection(selection.id);
    expect(found).toEqual(selection);
    expect(await api.getQuestionSelection("other-selection")).toBeUndefined();
    found!.questionSnapshots![0]!.expectedAnswer = "mutated caller copy";
    expect((await api.getQuestionSelection(selection.id))?.questionSnapshots?.[0]?.expectedAnswer).toBe("A");
  });

  it("reads the ETAPI activity reference by exact selection ID", async () => {
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "test", parentNoteId: "root" });
    Object.defineProperty(api, "readActivityReference", {
      value: async () => ({ questionSelections: [selection] })
    });

    expect(await api.getQuestionSelection(selection.id)).toEqual(selection);
    expect(await api.getQuestionSelection("other-selection")).toBeUndefined();
  });

  it("maps only HTTP 404 to unknown and propagates other service errors", async () => {
    const fetch404: typeof fetch = async () => new Response("missing", { status: 404 });
    const missingReader = new HttpReadWeaveCourseApi("https://readweave.test", "token", fetch404);
    await expect(missingReader.getQuestionSelection("missing")).resolves.toBeUndefined();

    const fetch400: typeof fetch = async () => new Response("bad request", { status: 400 });
    const failingReader = new HttpReadWeaveCourseApi("https://readweave.test", "token", fetch400);
    await expect(failingReader.getQuestionSelection("broken")).rejects.toThrow("READWEAVE_HTTP_400");

    const fetchById = vi.fn<typeof fetch>(async () => Response.json(selection));
    const reader = new HttpReadWeaveCourseApi("https://readweave.test", "token", fetchById);
    await expect(reader.getQuestionSelection("selection/1")).resolves.toEqual(selection);
    const requested = new URL(String(fetchById.mock.calls[0]?.[0]));
    expect(requested.pathname).toBe("/question-selections/selection%2F1");
  });
});

function writeContext(idempotencyKey: string): IdempotentWriteContext {
  return { idempotencyKey, actor: "test", workspaceId: "personal", schemaVersion: "2.1.0", requestId: idempotencyKey };
}
