import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CourseRelease, IdempotentWriteContext } from "@course-os/contracts";
import { ContentAddressedStore, writeJsonAtomic } from "@course-os/storage";
import { EMPTY_STATE, EtapiReadWeaveCourseApi, FileReadWeaveCourseApi, HttpReadWeaveCourseApi, permanentlyDeleteTrashBatch,
  type ReadWeaveFileState, type TrashDeleteOptions } from "./index.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const at = "2026-10-03T00:00:00.000Z";
const context: IdempotentWriteContext = { workspaceId: "personal", actor: "authenticated-test", idempotencyKey: "delete-confirmed", schemaVersion: "2.1.0", requestId: "request-test" };
const safe: TrashDeleteOptions = { checkExternalReferences: async () => ({ active: false, answers: false }) };
function release(id: string, courseId: string): CourseRelease {
  return { id, courseId, courseTitle: "Synthetic", moduleId: "m", moduleTitle: "Synthetic", version: 1, publishedAt: at,
    pageIds: [`${id}:page`], pages: [{ id: `${id}:page`, pageNumber: 1, title: "Synthetic", imageUrl: "/api/v1/media/shared",
      anchors: [], atoms: [], blocks: [], coverageRequirements: [], coverageClaims: [],
      quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable: true, issues: [] } }],
    assessments: [], manifestHash: "synthetic", writingPolicySnapshotId: "synthetic", modelRoute: "none", qualityHarnessVersion: "none", costUsd: 0 };
}
async function fixture(change?: (state: ReadWeaveFileState) => void) {
  const directory = await mkdtemp(join(tmpdir(), "course-os-trash-safety-")); directories.push(directory);
  const path = join(directory, "state.json");
  const s = structuredClone(EMPTY_STATE);
  s.courses = [{ id: "a", workspaceId: "personal", title: "Synthetic A", status: "archived", revision: 1, createdAt: at, updatedAt: at },
    { id: "b", workspaceId: "personal", title: "Synthetic B", status: "active", revision: 1, createdAt: at, updatedAt: at }];
  s.releases = [release("r-a", "a"), release("r-b", "b")];
  s.treeNodes = [{ id: "material:a:m", materialId: "material:a:m", kind: "material", title: "Synthetic", parentId: "a", revision: 1, children: [] },
    { id: "material:b:m", materialId: "material:b:m", kind: "material", title: "Synthetic", parentId: "b", revision: 1, children: [] }];
  s.trash = [{ id: "trash-a", workspaceId: "personal", nodeId: "a", nodeKind: "course", title: "Synthetic A", deletedAt: at,
    deletedBy: "test", snapshotHash: "original-snapshot", restoreAvailable: true }];
  s.idempotency = { "original-import": { kind: "import", objectId: "retained-original-import" } };
  change?.(s);
  await writeJsonAtomic(path, s);
  return { directory, path, state: s, api: new FileReadWeaveCourseApi(path), read: async () => JSON.parse(await readFile(path, "utf8")) as ReadWeaveFileState };
}

describe("permanent trash deletion safety", () => {
  it("deletes only the confirmed subtree, keeps shared CAS bytes and surviving releases, and replays safely after restart", async () => {
    const f = await fixture();
    const cas = new ContentAddressedStore(join(f.directory, "cas"));
    const media = await cas.put(Buffer.from("synthetic shared source bytes"));
    await f.api.permanentlyDeleteTrash("trash-a", context, at, safe);
    const saved = await f.read();
    expect(saved.courses.map(course => course.id)).toEqual(["b"]);
    expect(saved.releases.map(item => item.id)).toEqual(["r-b"]);
    expect(saved.treeNodes.map(node => node.id)).toEqual(["material:b:m"]);
    expect(saved.trash).toEqual([]);
    expect(saved.idempotency["original-import"]).toEqual(f.state.idempotency["original-import"]);
    await expect(cas.get(media.sha256)).resolves.toEqual(Buffer.from("synthetic shared source bytes"));
    await expect(new FileReadWeaveCourseApi(f.path).permanentlyDeleteTrash("trash-a", context, at, safe)).resolves.toBeUndefined();
    await expect(f.api.permanentlyDeleteTrash("trash-a", context, "another-confirmation", safe)).rejects.toThrow("READWEAVE_TRASH_IDEMPOTENCY_CONFLICT");
  });

  it("checks workspace and confirmed deletion time under the write lock", async () => {
    const f = await fixture();
    await expect(f.api.permanentlyDeleteTrash("trash-a", { ...context, workspaceId: "other" }, at, safe)).rejects.toThrow("READWEAVE_TRASH_WORKSPACE_MISMATCH");
    await expect(f.api.permanentlyDeleteTrash("trash-a", context, "2026-10-02T00:00:00.000Z", safe)).rejects.toThrow("READWEAVE_TRASH_CHANGED");
    await expect(f.api.permanentlyDeleteTrash("trash-a", context, at, { ...safe, expectedRevision: 0 })).rejects.toThrow("READWEAVE_TRASH_CHANGED");
    expect(await f.read()).toEqual(f.state);
  });

  it("rejects a queued delete when an earlier queued restore has made the object live", async () => {
    const f = await fixture();
    const restored = f.api.restoreTrash("trash-a", { ...context, idempotencyKey: "restore-first" });
    const deletion = expect(f.api.permanentlyDeleteTrash("trash-a", context, at, safe)).rejects.toThrow("READWEAVE_TRASH_NOT_DELETED");
    await restored;
    await deletion;
    expect((await f.read()).courses.find(course => course.id === "a")?.status).toBe("active");
  });

  it("protects saved answers and assessment activity without changing their records", async () => {
    const f = await fixture(s => { s.questionAttempts.push({ id: "answer-1", selectionId: "selection-1", sessionId: "session-1", courseReleaseId: "r-a", pageId: "r-a:page",
      questionId: "q-1", objectiveId: "o-1", answer: "synthetic answer", correct: false, usedHintLevel: 0, attemptedAt: at }); });
    await expect(f.api.permanentlyDeleteTrash("trash-a", context, at, safe)).rejects.toThrow("READWEAVE_TRASH_ANSWERS_PROTECTED");
    expect(await f.read()).toEqual(f.state);
  });

  it("protects answers saved in native QA records as well as ordinary attempts", async () => {
    const f = await fixture(s => { s.questions.push({ id: "native-qa", sessionId: "session-1", courseReleaseId: "r-a", pageId: "r-a:page", anchorIds: [],
      learnerAttempt: "synthetic own answer", question: "synthetic", hintLevel: 1, response: "synthetic", reviewPolicy: "include", status: "active", revision: 1, createdAt: at, updatedAt: at }); });
    await expect(f.api.permanentlyDeleteTrash("trash-a", context, at, safe)).rejects.toThrow("READWEAVE_TRASH_ANSWERS_PROTECTED");
    expect(await f.read()).toEqual(f.state);
  });

  it("checks a node's ancestor workspace rather than trusting a mismatched trash label", async () => {
    const f = await fixture(s => {
      s.courses[1]!.workspaceId = "other";
      s.treeNodes[0]!.parentId = "b"; s.treeNodes[0]!.archived = true;
      s.trash[0]!.nodeId = s.treeNodes[0]!.id; s.trash[0]!.nodeKind = "material";
    });
    await expect(f.api.permanentlyDeleteTrash("trash-a", context, at, safe)).rejects.toThrow("READWEAVE_TRASH_WORKSPACE_MISMATCH");
    expect(await f.read()).toEqual(f.state);
  });

  it("requires the API's external reference check and skips pending writes and own retelling answers", async () => {
    const f = await fixture();
    await expect(f.api.permanentlyDeleteTrash("trash-a", context, at)).rejects.toThrow("READWEAVE_TRASH_EXTERNAL_REFERENCES_UNCHECKED");
    await expect(f.api.permanentlyDeleteTrash("trash-a", context, at, { checkExternalReferences: async () => ({ active: true, answers: false }) }))
      .rejects.toThrow("READWEAVE_TRASH_ACTIVITY_PROTECTED");
    await expect(f.api.permanentlyDeleteTrash("trash-a", context, at, { checkExternalReferences: async () => ({ active: false, answers: true }) }))
      .rejects.toThrow("READWEAVE_TRASH_ANSWERS_PROTECTED");
    expect(await f.read()).toEqual(f.state);
  });

  it("protects materials moved into a retained course instead of deleting their source release", async () => {
    const f = await fixture(s => { s.treeNodes[0]!.parentId = "b"; s.treeNodes[0]!.currentReleaseId = "r-a"; });
    await expect(f.api.permanentlyDeleteTrash("trash-a", context, at, safe)).rejects.toThrow("READWEAVE_TRASH_SHARED_REFERENCE");
    expect(await f.read()).toEqual(f.state);
  });

  it("reports partial bulk results and only replays the exact confirmed successful items", async () => {
    const f = await fixture();
    const selected = [{ id: "trash-a", deletedAt: at }, { id: "missing", deletedAt: at }, { id: "trash-a", deletedAt: at }];
    const first = await permanentlyDeleteTrashBatch(f.api, selected, context, safe);
    expect(first).toEqual([{ id: "trash-a", status: "deleted" }, { id: "missing", status: "skipped", reason: "READWEAVE_TRASH_NOT_FOUND" }]);
    expect(await permanentlyDeleteTrashBatch(new FileReadWeaveCourseApi(f.path), selected, context, safe)).toEqual(first);
  });

  it("reports ETAPI and unverified HTTP permanent delete unsupported without remote or local writes", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const etapi = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "test-only", parentNoteId: "root", fetchImpl });
    const http = new HttpReadWeaveCourseApi("http://readweave", "test-only", fetchImpl);
    for (const api of [etapi, http]) {
      expect(await permanentlyDeleteTrashBatch(api, [{ id: "virtual-or-note-trash", deletedAt: at }], context))
        .toEqual([{ id: "virtual-or-note-trash", status: "skipped", reason: "READWEAVE_PERMANENT_DELETE_UNSUPPORTED" }]);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
