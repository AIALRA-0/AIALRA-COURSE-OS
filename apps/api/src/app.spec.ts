import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileReadWeaveCourseApi, type ReadWeaveCourseApi } from "@course-os/readweave-adapter";
import { sha256Text } from "@course-os/domain";
import type { CourseProject, CourseRelease, GenerationCostEntry, GenerationJob, GenerationPlan, IdempotentWriteContext, ImportRecord, LessonDraft, QuestionBankItem, ReleaseManifest } from "@course-os/contracts";
import { unpairedEnglishTeachingFields, validateTeachingNarrative } from "@course-os/quality";
import { applyTeachingPackage, buildReadingTree, createApp, createDefaultDependencies, evaluateQuestionAnswer, executeGenerationJob, normalizeGeneratedMathPunctuation, normalizeMultipartFilename, normalizeTeachingPackageMath, resumeIncompleteJobs, safeReadWeaveFailureKind } from "./app.js";
import { modelRoutePolicyForRuntime } from "./provider-settings.js";
import { ModelRouterGenerationError, currentGenerationHarness, providerRouterFromSettings, type ModelRouterClient, type TeachingGenerationResult, type TeachingPackage } from "./model-router.js";
import { ReadingRuntime } from "./reading-runtime.js";

afterEach(() => vi.restoreAllMocks());

const gunzipAsync = promisify(gunzip);

async function testApp() {
  const root = await mkdtemp(join(tmpdir(), "course-os-api-"));
  const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
  return createApp(createDefaultDependencies(root, readweave));
}

async function seededApp(modelRouter?: ModelRouterClient, seededRelease = testRelease()) {
  const root = await mkdtemp(join(tmpdir(), "course-os-api-seeded-"));
  const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
  const release = seededRelease;
  await readweave.publishRelease(release, testManifest(release.id), {
    idempotencyKey: "seed-release",
    actor: "test",
    workspaceId: "personal",
    schemaVersion: "2.1.0",
    requestId: "seed-release"
  });
  const dependencies = createDefaultDependencies(root, readweave, modelRouter);
  return { app: createApp(dependencies), dependencies, operations: dependencies.operations, readweave, release };
}

async function seededReplicaDraftApp() {
  const formalRelease = { ...testRelease(), lifecycle: "published" as const };
  const { app, dependencies, readweave, release } = await seededApp(undefined, formalRelease);
  const page = structuredClone(release.pages[0]!);
  const initialDraft: LessonDraft = {
    id: "draft:page-1", workspaceId: "personal", courseId: release.courseId, moduleId: release.moduleId,
    sourceReleaseId: release.id, pageId: "page-1", revision: 0, status: "ready", page,
    changedBlockIds: page.blocks.map((block) => block.id), contentHash: "replica-draft-revision-1", updatedAt: new Date().toISOString()
  };
  const firstDraft = await readweave.saveDraft(initialDraft, 0, {
    idempotencyKey: "replica-draft-revision-1", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "replica-draft-revision-1"
  });
  const draft = await readweave.saveDraft({
    ...firstDraft, page: { ...firstDraft.page, title: "副本中的已保存版本 2" }, contentHash: "replica-draft-revision-2", updatedAt: new Date().toISOString()
  }, firstDraft.revision, {
    idempotencyKey: "replica-draft-revision-2", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "replica-draft-revision-2"
  });
  const course: CourseProject = {
    id: release.courseId, workspaceId: "personal", title: release.courseTitle, status: "active",
    createdAt: release.publishedAt, updatedAt: release.publishedAt
  };
  const reading = new ReadingRuntime(join(dependencies.dataDir, "reading"), readweave, "personal",
    "authority:app-spec-draft-patch", () => buildReadingTree([course], [], [], "personal"));
  await reading.initialize();
  await reading.replica.replace({
    courses: [course], releases: [release], drafts: [draft],
    tree: buildReadingTree([course], [], [], "personal"), trash: []
  });
  dependencies.reading = reading;
  return { app, dependencies, readweave, release, reading, draft };
}

describe("Course OS API", () => {
  it.each(["slides.pptx", "先验知识_示例.pptx", "café.pdf", "😀.pptx"])("preserves decoded filenames and repairs browser UTF-8 multipart bytes for %s", name => {
    expect(normalizeMultipartFilename(name)).toBe(name);
    expect(normalizeMultipartFilename(Buffer.from(name, "utf8").toString("latin1"))).toBe(name);
  });
  it("keeps a browser Unicode upload name in the saved import record", async () => {
    const { dependencies } = await seededApp();
    const previous = process.env.COURSE_OS_EXTERNAL_WORKER;
    process.env.COURSE_OS_EXTERNAL_WORKER = "true";
    try {
      const app = createApp(dependencies);
      const accepted = await request(app).post("/api/v1/imports").set("Idempotency-Key", "unicode-browser-filename")
        .field("autoGenerate", "false").attach("file", Buffer.from("# Filename source"), { filename: "中文课件.md", contentType: "text/markdown" }).expect(201);
      expect(accepted.body.originalName).toBe("中文课件.md");
      expect((await dependencies.operations.getImport(accepted.body.id, "personal"))?.originalName).toBe("中文课件.md");
    } finally {
      if (previous === undefined) delete process.env.COURSE_OS_EXTERNAL_WORKER;
      else process.env.COURSE_OS_EXTERNAL_WORKER = previous;
    }
  });
  it("blocks fenced media before CAS while retaining unindexed import previews and workspace isolation", async () => {
    const { app, dependencies, reading } = await seededReplicaDraftApp();
    const image = await dependencies.cas.put(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"));
    const casRead = vi.spyOn(dependencies.cas, "get");
    const visibility = vi.spyOn(reading.replica, "getMediaVisibility");
    try {
      visibility.mockReturnValue("blocked");
      await request(app).get(`/api/v1/media/${image.sha256}`).expect(404);
      expect(casRead).not.toHaveBeenCalled();
      await request(app).get(`/api/v1/media/${image.sha256}`).set("X-Workspace-Id", "other-workspace").expect(403);
      expect(casRead).not.toHaveBeenCalled();
      visibility.mockReturnValue("confirmed");
      await request(app).get(`/api/v1/media/${image.sha256}`).expect(200);
      visibility.mockReturnValue("unindexed");
      await request(app).get(`/api/v1/media/${image.sha256}`).expect(200);
      expect(casRead).toHaveBeenCalledTimes(2);
    } finally { reading.close(); }
  });
  it("confirms repeated course and metadata operations using the original key without duplicate writes", async () => {
    const { app, readweave } = await seededApp();
    const created = await request(app).post("/api/v1/courses").set("Idempotency-Key", "synthetic-course-lost-response")
      .send({ title: "Recovery course" }).expect(201);
    const replayed = await request(app).post("/api/v1/courses").set("Idempotency-Key", "synthetic-course-lost-response")
      .send({ title: "Recovery course" }).expect(201);
    expect(replayed.body.id).toBe(created.body.id);
    expect((await readweave.listCourses()).filter(course => course.id === created.body.id)).toHaveLength(1);
    const path = `/api/v1/tree/nodes/${encodeURIComponent(created.body.id)}`;
    const patch = { title: "Renamed recovery course", expectedRevision: created.body.revision ?? 0 };
    const first = await request(app).patch(path).set("Idempotency-Key", "synthetic-rename-lost-response").send(patch).expect(200);
    const second = await request(app).patch(path).set("Idempotency-Key", "synthetic-rename-lost-response").send(patch).expect(200);
    expect(second.body).toEqual(first.body);
    expect(second.body.revision).toBe((created.body.revision ?? 0) + 1);
  });
  it("replays a completed trash deletion after its row is gone while keeping unknown selectors at 404", async () => {
    const { app, readweave, release } = await seededApp();
    const materialId = `material:${release.courseId}:${release.moduleId}`;
    const trashed = (await request(app).post(`/api/v1/tree/nodes/${encodeURIComponent(materialId)}:trash`)
      .set("Idempotency-Key", "trash-delete-replay-trash").expect(201)).body;
    const path = `/api/v1/trash/${encodeURIComponent(trashed.id)}`;
    const selectorHeaders = { "Idempotency-Key": "trash-delete-lost-response", "X-Trash-Deleted-At": trashed.deletedAt };

    await request(app).delete(path).set(selectorHeaders).expect(204);
    expect((await readweave.listTrash()).some(item => item.id === trashed.id)).toBe(false);
    await request(app).delete(path).set(selectorHeaders).expect(204);

    await request(app).delete("/api/v1/trash/unknown-trash").set("Idempotency-Key", "trash-delete-no-selector").expect(404);
    await request(app).delete("/api/v1/trash/unknown-trash")
      .set({ "Idempotency-Key": "trash-delete-unknown", "X-Trash-Deleted-At": trashed.deletedAt }).expect(404);
    await request(app).delete("/api/v1/trash/unknown-trash")
      .set({ ...selectorHeaders, "X-Trash-Deleted-At": trashed.deletedAt }).expect(404);
    await request(app).delete(path)
      .set({ ...selectorHeaders, "X-Workspace-Id": "other-workspace" }).expect(404);
  });
  it("reports adapter deletion capability separately from the presence of a trash button", async () => {
    const { app, readweave } = await seededApp();
    await request(app).get("/api/v1/trash/capabilities").expect(200).expect(({ body }) => {
      expect(body).toEqual({ directPermanentDelete: true, requiresNativeUi: false });
    });
    vi.spyOn(readweave, "getTrashCapabilities").mockResolvedValue({ directPermanentDelete: false, requiresNativeUi: true, reason: "READWEAVE_NATIVE_ERASE_REQUIRED" });
    await request(app).get("/api/v1/trash/capabilities").expect(200).expect(({ body }) => {
      expect(body).toEqual({ directPermanentDelete: false, requiresNativeUi: true, reason: "READWEAVE_NATIVE_ERASE_REQUIRED" });
    });
  });
  it("previews native erasure only for the current workspace and frozen trash snapshot", async () => {
    const { app, dependencies, readweave, release } = await seededApp();
    const materialId = `material:${release.courseId}:${release.moduleId}`;
    const trashed = (await request(app).post(`/api/v1/tree/nodes/${encodeURIComponent(materialId)}:trash`)
      .set("Idempotency-Key", "native-preview-trash").expect(201)).body;
    const snapshotHash = trashed.snapshotHash || "native-snapshot-a";
    vi.spyOn(readweave, "getTrashCapabilities").mockResolvedValue({ directPermanentDelete: false, requiresNativeUi: true, canConfirmNativeErase: true });
    const preview = vi.fn(async (trashId: string, _context: IdempotentWriteContext, deletedAt?: string,
      selector?: { expectedSnapshotHash?: string; expectedRevision?: number }) => ({
      trashId, workspaceId: "personal", nodeId: materialId, deletedAt: deletedAt!, snapshotHash: selector?.expectedSnapshotHash || snapshotHash,
      rootNoteIds: ["root-note-a"], nativeLinks: [{ noteId: "root-note-a", url: "https://readweave.example/notes/root-note-a", title: "课程根笔记" }],
      noteIds: ["root-note-a", "child-note-a"]
    }));
    (readweave as ReadWeaveCourseApi).previewTrashNativeErase = preview;
    const path = `/api/v1/trash/${encodeURIComponent(trashed.id)}:preview-native-erase`;
    const headers = { "Idempotency-Key": "native-preview-current", "X-Workspace-Id": "personal" };

    await request(app).post(path).set({ ...headers, "X-Workspace-Id": "another-workspace" })
      .send({ deletedAt: trashed.deletedAt, snapshotHash }).expect(404);
    await request(app).post(path).set(headers)
      .send({ deletedAt: "2026-01-01T00:00:00.000Z", snapshotHash }).expect(409);
    await request(app).post(path).set(headers)
      .send({ deletedAt: trashed.deletedAt, snapshotHash: "stale-snapshot" }).expect(409);
    expect(preview).not.toHaveBeenCalled();

    const result = await request(app).post(path).set(headers)
      .send({ deletedAt: trashed.deletedAt, snapshotHash }).expect(200);
    expect(result.body).toMatchObject({ trashId: trashed.id, workspaceId: "personal", snapshotHash, rootNoteIds: ["root-note-a"] });
    expect(preview).toHaveBeenCalledWith(trashed.id, expect.objectContaining({ workspaceId: "personal" }), trashed.deletedAt,
      { expectedSnapshotHash: snapshotHash, expectedRevision: undefined }, expect.objectContaining({ checkExternalReferences: expect.any(Function) }));
    const confirmDelete = vi.spyOn(readweave, "permanentlyDeleteTrash").mockResolvedValue(undefined);
    const deletePath = `/api/v1/trash/${encodeURIComponent(trashed.id)}`;
    await request(app).delete(deletePath).set("Idempotency-Key", "native-confirm-missing-snapshot")
      .set("X-Trash-Deleted-At", trashed.deletedAt).expect(400);
    await request(app).delete(deletePath).set("Idempotency-Key", "native-confirm-stale-snapshot")
      .set("X-Trash-Deleted-At", trashed.deletedAt).set("X-Trash-Snapshot-Hash", "stale-snapshot").expect(409);
    await request(app).delete(deletePath).set("Idempotency-Key", "native-confirm-current-snapshot")
      .set("X-Trash-Deleted-At", trashed.deletedAt).set("X-Trash-Snapshot-Hash", snapshotHash).expect(204);
    expect(confirmDelete).toHaveBeenCalledWith(trashed.id, expect.objectContaining({ idempotencyKey: "native-confirm-current-snapshot" }), trashed.deletedAt,
      expect.objectContaining({ expectedSnapshotHash: snapshotHash, checkExternalReferences: expect.any(Function) }));
    confirmDelete.mockRejectedValueOnce(new Error("READWEAVE_NATIVE_ERASE_UNVERIFIED"));
    await request(app).delete(deletePath).set("Idempotency-Key", "native-confirm-unverified-evidence")
      .set("X-Trash-Deleted-At", trashed.deletedAt).set("X-Trash-Snapshot-Hash", snapshotHash)
      .expect(409).expect(({ body }) => expect(body.error.message).toContain("原生擦除成功记录"));
  });
  it("blocks native erase preview when the API external-reference check reports a protected activity", async () => {
    const { app, dependencies, readweave, release } = await seededApp();
    const materialId = `material:${release.courseId}:${release.moduleId}`;
    const trashed = (await request(app).post(`/api/v1/tree/nodes/${encodeURIComponent(materialId)}:trash`)
      .set("Idempotency-Key", "native-preview-protected-trash").expect(201)).body;
    vi.spyOn(readweave, "getTrashCapabilities").mockResolvedValue({ directPermanentDelete: false, requiresNativeUi: true, canConfirmNativeErase: true });
    vi.spyOn(dependencies.operations, "read").mockResolvedValue({
      ...(await dependencies.operations.read()),
      jobs: [{ workspaceId: "personal", state: "running", materialVersionId: release.id, pageIds: [] } as unknown as GenerationJob]
    });
    const preview = vi.fn(async (_trashId: string, _context: IdempotentWriteContext, _deletedAt: string | undefined,
      _selector: { expectedSnapshotHash?: string; expectedRevision?: number } | undefined,
      options?: { checkExternalReferences?: (scope: { trashId: string; workspaceId: string; nodeIds: string[]; courseIds: string[]; releaseIds: string[]; pageIds: string[] }) => Promise<{ active: boolean; answers: boolean }> }) => {
      const reference = await options?.checkExternalReferences?.({ trashId: trashed.id, workspaceId: "personal", nodeIds: [materialId], courseIds: [], releaseIds: [release.id], pageIds: [] });
      if (reference?.active || reference?.answers) throw new Error("READWEAVE_TRASH_ACTIVITY_PROTECTED");
      throw new Error("test expected a protected reference");
    });
    (readweave as ReadWeaveCourseApi).previewTrashNativeErase = preview;
    await request(app).post(`/api/v1/trash/${encodeURIComponent(trashed.id)}:preview-native-erase`)
      .set("Idempotency-Key", "native-preview-protected").send({ deletedAt: trashed.deletedAt, snapshotHash: trashed.snapshotHash })
      .expect(409).expect(({ body }) => expect(body.error.code).toBe("TRASH_REFERENCE_PROTECTED"));
  });
  it("confirms an archived operation replay without resurrecting a trashed node or accepting another workspace", async () => {
    const { app, readweave } = await seededApp();
    const created = await request(app).post("/api/v1/courses").set("Idempotency-Key", "archive-replay-course")
      .send({ title: "Archive recovery course" }).expect(201);
    const path = `/api/v1/tree/nodes/${encodeURIComponent(created.body.id)}`;
    const patch = { archived: true, expectedRevision: created.body.revision ?? 0 };
    const saved = await request(app).patch(path).set("Idempotency-Key", "archive-lost-response").send(patch).expect(200);
    const replay = await request(app).patch(path).set("Idempotency-Key", "archive-lost-response").send(patch).expect(200);
    expect(replay.body).toEqual(saved.body);
    const foreign = await request(app).patch(path).set("X-Workspace-Id", "other-workspace")
      .set("Idempotency-Key", "archive-lost-response").send(patch);
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    const restore = { archived: false, expectedRevision: saved.body.revision };
    await request(app).patch(path).set("Idempotency-Key", "archive-restore").send(restore).expect(200);
    await request(app).post(`${path}:trash`).set("Idempotency-Key", "archive-trash").expect(201);
    const resurrection = await request(app).patch(path).set("Idempotency-Key", "archive-unauthorized-resurrection")
      .send({ archived: false, expectedRevision: restore.expectedRevision + 1 });
    expect(resurrection.status).toBeGreaterThanOrEqual(400);
    expect((await readweave.listTrash()).some(record => record.nodeId === created.body.id && record.restoreAvailable)).toBe(true);
  });
  it.each(["accepted", "processing", "syncing"] as const)("protects %s imports with an empty worker map during permanent material deletion", async importState => {
    for (const reference of ["parentNodeId", "incrementalFromMaterialVersionId", "materialVersionId"] as const) {
      const { app, operations, readweave, release } = await seededApp();
      const materialId = `material:${release.courseId}:${release.moduleId}`;
      const trashed = (await request(app).post(`/api/v1/tree/nodes/${encodeURIComponent(materialId)}:trash`)
        .set("Idempotency-Key", "trash-own-material").expect(201)).body;
      // Seed persistent work only: no converter is started and activeImports has no worker entry.
      const record: ImportRecord = { id: `own-pending-${reference}`, workspaceId: "personal", courseId: release.courseId,
        originalName: "synthetic.pdf", mediaType: "application/pdf", kind: "pdf", sizeBytes: 8, sha256: "synthetic", casPath: "/synthetic/quarantine",
        source: "user_upload", license: "private", sensitivity: "private", state: importState, autoGenerate: false, issues: [], createdAt: "2026-10-03T00:00:00Z",
        [reference]: reference === "parentNodeId" ? materialId : release.id };
      await operations.mutate(state => { state.imports.push(record); });
      const deletion = vi.spyOn(readweave, "permanentlyDeleteTrash");
      const bulk = await request(app).post("/api/v1/trash:empty").set("Idempotency-Key", "empty-own-trash")
        .send({ items: [{ id: trashed.id, deletedAt: trashed.deletedAt }] }).expect(200);
      expect(bulk.body).toMatchObject({ cleared: [], failed: [], skipped: [{ id: trashed.id, reason: "READWEAVE_TRASH_ACTIVITY_PROTECTED" }] });
      const single = await request(app).delete(`/api/v1/trash/${encodeURIComponent(trashed.id)}`)
        .set("Idempotency-Key", "delete-own-trash").set("X-Trash-Deleted-At", trashed.deletedAt);
      expect(single.status).not.toBe(204);
      expect(single.body.error).toBeDefined();
      await expect(deletion.mock.results.at(-1)!.value).rejects.toThrow("READWEAVE_TRASH_ACTIVITY_PROTECTED");
      expect(await readweave.getRelease(release.id)).toEqual(release);
      expect((await readweave.listTrash()).find(item => item.id === trashed.id)?.restoreAvailable).toBe(true);
      expect((await operations.read()).imports).toEqual([record]);
    }
  });

  it.each([
    { workspaceId: "personal", state: "ready" as const },
    { workspaceId: "other", state: "processing" as const }
  ])("does not block permanent deletion for an inactive or other-workspace import ($workspaceId/$state)", async importScope => {
    const { app, operations, readweave, release } = await seededApp();
    const materialId = `material:${release.courseId}:${release.moduleId}`;
    const trashed = (await request(app).post(`/api/v1/tree/nodes/${encodeURIComponent(materialId)}:trash`)
      .set("Idempotency-Key", "trash-own-material").expect(201)).body;
    const record: ImportRecord = { id: "unprotected-import", ...importScope, courseId: release.courseId, parentNodeId: materialId,
      incrementalFromMaterialVersionId: release.id, materialVersionId: release.id,
      originalName: "synthetic.pdf", mediaType: "application/pdf", kind: "pdf", sizeBytes: 8, sha256: "synthetic", casPath: "/synthetic/quarantine",
      source: "user_upload", license: "private", sensitivity: "private", autoGenerate: false, issues: [], createdAt: "2026-10-03T00:00:00Z" };
    await operations.mutate(state => { state.imports.push(record); });
    await request(app).delete(`/api/v1/trash/${encodeURIComponent(trashed.id)}`)
      .set("Idempotency-Key", "delete-own-trash").set("X-Trash-Deleted-At", trashed.deletedAt).expect(204);
    expect(await readweave.getRelease(release.id)).toBeUndefined();
    expect((await operations.read()).imports).toEqual([record]);
  });

  it("clears selected terminal failures persistently without deleting evidence or request associations", async () => {
    const { app, operations, readweave, release } = await seededApp();
    const item: ImportRecord = { id: "failed-record", workspaceId: "personal", originalName: "broken.pdf", mediaType: "application/pdf", kind: "pdf", sizeBytes: 8,
      sha256: "synthetic", casPath: "/synthetic/quarantine", source: "user_upload", license: "private", sensitivity: "private", state: "rejected", generationState: "queued", issues: ["INVALID_PDF"], createdAt: "2026-10-01T00:00:00Z" };
    const activeJob: GenerationJob = { id: "active-failed-job", workspaceId: "personal", sourceImportId: "active-import",
      materialVersionId: release.id, state: "failed", pageIds: release.pageIds, completedPageIds: [], failedPageIds: release.pageIds,
      budgetUsd: 1, spentUsd: 0, attempt: 1, cancelRequested: false, createdAt: item.createdAt, updatedAt: item.createdAt,
      lease: { owner: "synthetic-worker", fenceToken: 2, expiresAt: new Date(Date.now()+60000).toISOString() } };
    await operations.mutate(state => {
      state.imports.push(item, { ...item, id: "active-import", state: "failed", generationJobId: activeJob.id });
      state.jobs.push(activeJob);
      state.idempotency["original-upload"] = { kind: "import", objectId: item.id };
      operations.appendEvent(state, activeJob.id, "job.failed", { synthetic: true });
    });
    const before = JSON.stringify(await readweave.getRelease(release.id));
    const listed = (await request(app).get("/api/v1/imports").expect(200)).body;
    const fingerprint = listed.find((task: { id: string }) => task.id === item.id).cleanupFingerprint;
    const originalState = await operations.read();
    // File mode delegates to full mutation internally. Capture that delegate,
    // then reject direct route calls to the full method.
    const fileMutation = operations.mutate.bind(operations);
    const scopedMutation = vi.spyOn(operations,"mutateGenerationTasks").mockImplementation(change => fileMutation(change));
    const fullMutation = vi.spyOn(operations,"mutate").mockRejectedValue(new Error("DIRECT_FULL_MUTATION_FORBIDDEN"));
    const action = () => request(app).post("/api/v1/imports:clear-failed").set("Idempotency-Key", "clear-selected").send({ taskIds: [item.id], fingerprints: { [item.id]: fingerprint } }).expect(200);
    expect((await action()).body.cleared).toEqual([item.id]);
    expect((await action()).body.cleared).toEqual([item.id]);
    const activeFingerprint = listed.find((task: { id: string }) => task.id === "active-import").cleanupFingerprint;
    const protectedTask = await request(app).post("/api/v1/imports:clear-failed").set("Idempotency-Key","clear-active-lease")
      .send({ taskIds: ["active-import"], fingerprints: { "active-import": activeFingerprint } }).expect(200);
    expect(protectedTask.body).toMatchObject({ cleared: [], skipped: [{ id: "active-import", reason: "TASK_ACTIVE" }], retainedEntities: true });
    expect(scopedMutation).toHaveBeenCalledTimes(3);
    expect(fullMutation).not.toHaveBeenCalled();
    const retained = await operations.read();
    expect({ ...retained, idempotency: originalState.idempotency }).toEqual(originalState);
    expect((await request(app).get("/api/v1/imports")).body.map((task: { id: string }) => task.id)).toEqual(["active-import"]);
    await request(app).get(`/api/v1/imports/${item.id}`).expect(200);
    expect((await operations.read()).idempotency["original-upload"]).toEqual({ kind: "import", objectId: item.id });
    expect(JSON.stringify(await readweave.getRelease(release.id))).toBe(before);
    const recovered = await request(app).get("/api/v1/import-operations/original-upload").expect(200);
    expect(recovered.body.id).toBe(item.id);
    await request(app).get("/api/v1/import-operations/original-upload").set("X-Workspace-Id", "other").expect(404);
  });

  it("does not clear a failed task that changed after confirmation or a new failure outside the selection", async () => {
    const { app, operations } = await seededApp();
    const record: ImportRecord = { id: "failed-before-confirmation", workspaceId: "personal", originalName: "source.pdf", mediaType: "application/pdf", kind: "pdf", sizeBytes: 8,
      sha256: "synthetic", casPath: "/synthetic/quarantine", source: "user_upload", license: "private", sensitivity: "private", state: "failed", issues: [], createdAt: "2026-10-01T00:00:00Z" };
    await operations.mutate(state => { state.imports.push(record); });
    const listed = (await request(app).get("/api/v1/imports")).body[0];
    await operations.mutate(state => { state.imports[0]!.state = "processing"; state.imports.push({ ...record, id: "new-failure" }); });
    const result = await request(app).post("/api/v1/imports:clear-failed").set("Idempotency-Key", "race-clear").send({ taskIds: [record.id], fingerprints: { [record.id]: listed.cleanupFingerprint } }).expect(200);
    expect(result.body.cleared).toEqual([]);
    expect(result.body.skipped).toHaveLength(1);
    expect((await request(app).get("/api/v1/imports")).body).toHaveLength(2);
  });

  it("restores import tasks from the server without leaking another workspace or a private path", async () => {
    const { app, operations } = await seededApp();
    const base: ImportRecord = {
      id: "import-personal", workspaceId: "personal", courseId: "course-1", originalName: "Lecture.pdf",
      mediaType: "application/pdf", kind: "pdf", sizeBytes: 10, sha256: "sha", casPath: "/synthetic/source.pdf",
      source: "user_upload", license: "private_course_material", sensitivity: "private",
      state: "processing", issues: [], createdAt: "2026-09-22T10:00:00.000Z"
    };
    await operations.mutate((state) => { state.imports.push(base, { ...base, id: "import-other", workspaceId: "other" }); });
    const first = await request(app).get("/api/v1/imports").set("X-Workspace-Id", "personal").expect(200);
    const afterRefresh = await request(app).get("/api/v1/imports").set("X-Workspace-Id", "personal").expect(200);
    expect(first.body).toEqual(afterRefresh.body);
    expect(first.body).toMatchObject([{ id: "import-personal", courseId: "course-1", state: "processing" }]);
    expect(JSON.stringify(first.body)).not.toContain("/synthetic/source.pdf");
    await request(app).get("/api/v1/imports/import-other").set("X-Workspace-Id", "personal").expect(404);
    expect((await request(app).get("/api/v1/imports").set("X-Workspace-Id", "other").expect(200)).body).toHaveLength(1);
  });
  it("loads ordinary import details with workspace-scoped exact reads", async () => {
    const { app, operations } = await seededApp();
    const record: ImportRecord = {
      id: "b7e369a0-403e-4a89-884e-6576858a2f88", workspaceId: "personal", originalName: "Lecture.pdf", mediaType: "application/pdf", kind: "pdf",
      sizeBytes: 10, sha256: "sha", casPath: "/synthetic/source.pdf", source: "user_upload", license: "private_course_material",
      sensitivity: "private", state: "processing", issues: [], createdAt: "2026-09-22T10:00:00.000Z"
    };
    await operations.mutate((state) => { state.imports.push(record); });
    const getImport = vi.spyOn(operations, "getImport");
    const readTaskIndex = vi.spyOn(operations, "readTaskIndex");

    const detail = await request(app).get(`/api/v1/imports/${record.id}`).expect(200);

    expect(detail.body).toMatchObject({ id: record.id, workspaceId: "personal", state: "processing" });
    expect(getImport).toHaveBeenCalledWith(record.id, "personal");
    expect(readTaskIndex).not.toHaveBeenCalled();
  });
  it("keeps live generation-plan fields on ordinary import details without a task-index read", async () => {
    const { app, operations } = await seededApp();
    const createdAt = "2026-09-22T10:00:00.000Z";
    const plan: GenerationPlan = {
      id: "plan-for-import-detail", workspaceId: "personal", materialVersionId: "material-version-detail",
      qualityMode: "balanced", language: "zh-CN", writingPolicySnapshotId: "writing-policy:test",
      pageIds: ["page-1", "page-2"], completedPageIds: ["page-1"], failedPageIds: [],
      coreCompletedPageIds: ["page-1"], bridgeCompletedPageIds: [], jobIds: ["detail-job"], activeJobIds: ["detail-job"],
      currentJobId: "detail-job", maxConcurrency: 1, budgetUsd: 1, spentUsd: 0, holdForReview: false,
      state: "running", createdAt, updatedAt: "2026-09-22T10:01:00.000Z"
    };
    const record: ImportRecord = {
      id: "b7e369a0-403e-4a89-884e-6576858a2f88", workspaceId: "personal", originalName: "Lecture.pdf", mediaType: "application/pdf", kind: "pdf",
      sizeBytes: 10, sha256: "sha", casPath: "/synthetic/source.pdf", source: "user_upload", license: "private_course_material",
      sensitivity: "private", state: "ready", autoGenerate: true, generationPlanId: plan.id,
      issues: [], createdAt
    };
    await operations.mutate((state) => { state.imports.push(record); state.generationPlans.push(plan); });
    const readTaskIndex = vi.spyOn(operations, "readTaskIndex");

    const detail = await request(app).get(`/api/v1/imports/${record.id}`).expect(200);

    expect(detail.body).toMatchObject({
      id: record.id, generationPlanId: plan.id, generationJobId: "detail-job", generationJobIds: ["detail-job"],
      generationCompletedPageIds: ["page-1"], generationFailedPageIds: [], generationState: "running"
    });
    expect(readTaskIndex).not.toHaveBeenCalled();
  });
  it("returns one read-deadline response when import record reads finish after the deadline", async () => {
    const { app, operations } = await seededApp();
    const originalGetImport = operations.getImport.bind(operations);
    let releaseReads!: () => void;
    let signalReadsStarted!: () => void;
    let signalReadsFinished!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseReads = resolve; });
    const readsStarted = new Promise<void>((resolve) => { signalReadsStarted = resolve; });
    const readsFinished = new Promise<void>((resolve) => { signalReadsFinished = resolve; });
    let readCount = 0;
    let finishedReadCount = 0;
    vi.spyOn(operations, "getImport").mockImplementation(async (id, workspaceId) => {
      const currentRead = ++readCount;
      if (readCount === 2) signalReadsStarted();
      try {
        await readGate;
        if (currentRead === 2) throw new Error("LATE_IMPORT_READ_FAILURE");
        return await originalGetImport(id, workspaceId);
      } finally {
        finishedReadCount += 1;
        if (finishedReadCount === 2) signalReadsFinished();
      }
    });
    const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fastLateRead = request(app).get("/api/v1/imports/late-import-success").then((response) => response);
    const failedLateRead = request(app).get("/api/v1/imports/late-import-error").then((response) => response);

    try {
      await readsStarted;
      const [successResponse, errorResponse] = await Promise.all([fastLateRead, failedLateRead]);
      expect(successResponse.status).toBe(504);
      expect(successResponse.body).toMatchObject({ error: { code: "READ_DEADLINE_EXCEEDED" } });
      expect(errorResponse.status).toBe(504);
      expect(errorResponse.body).toMatchObject({ error: { code: "READ_DEADLINE_EXCEEDED" } });
    } finally {
      releaseReads();
    }

    await readsFinished;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const errorLogText = JSON.stringify(loggedErrors.mock.calls);
    expect(loggedErrors).toHaveBeenCalledTimes(3);
    expect(errorLogText.match(/READ_DEADLINE_EXCEEDED/gu)).toHaveLength(2);
    expect(errorLogText).toContain("LATE_IMPORT_READ_FAILURE");
    expect(errorLogText).not.toContain("startsWith");
  }, 15_000);
  it("does not send a second lesson or image response after the read deadline and permits a fresh read", async () => {
    const { app, dependencies, reading, release } = await seededReplicaDraftApp();
    const path = `/api/v1/pages/page-1/lesson?releaseId=${encodeURIComponent(release.id)}`;
    const source = await reading.replica.getPageSource("personal", "page-1", release.id);
    expect(source).toBeDefined();
    let releaseLate!: () => void;
    const gate = new Promise<void>(resolve => { releaseLate = resolve; });
    const pageRead = vi.spyOn(reading.replica, "getPageSource").mockImplementationOnce(async () => { await gate; return source; });
    const mediaRead = vi.spyOn(dependencies.cas, "get").mockImplementationOnce(async () => { await gate; return Buffer.from("late-image"); });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const [lesson, image] = await Promise.all([
        request(app).get(path),
        request(app).get(`/api/v1/media/${"a".repeat(64)}`)
      ]);
      expect(lesson.status).toBe(504);
      expect(image.status).toBe(504);
      expect(lesson.body.error.code).toBe("READ_DEADLINE_EXCEEDED");
      expect(image.body.error.code).toBe("READ_DEADLINE_EXCEEDED");
    } finally { releaseLate(); }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(pageRead).toHaveBeenCalledOnce();
    expect(mediaRead).toHaveBeenCalledOnce();
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/HEADERS_SENT|headers after|write after end/u);
    expect(warnings.mock.calls.filter(call => String(call[0]).includes("late_response_ignored"))).toHaveLength(2);
    const recovered = await request(app).get(path).expect(200);
    expect(recovered.body.page.id).toBe("page-1");
  }, 15_000);
  it("returns a workspace-scoped latest stage and ignores historical phase fields", async () => {
    const { app, operations } = await seededApp();
    const job: GenerationJob = {
      id: "generation-stage-summary",
      workspaceId: "personal",
      materialVersionId: "release-1",
      state: "running",
      budgetUsd: 1,
      spentUsd: 0,
      pageIds: ["page-1"],
      completedPageIds: [],
      failedPageIds: [],
      attempt: 1,
      cancelRequested: false,
      createdAt: "2026-09-22T10:00:00.000Z",
      updatedAt: "2026-09-22T10:00:00.000Z"
    };
    const otherWorkspaceJob = { ...job, id: "generation-stage-summary-other", workspaceId: "other" };
    await operations.mutate((state) => {
      state.jobs.push(job, otherWorkspaceJob);
      const append = (streamId: string, type: string, payload: Record<string, unknown>, occurredAt: string) => {
        const event = operations.appendEvent(state, streamId, type, payload);
        event.occurredAt = occurredAt;
      };
      append(job.id, "generation.stage.started", { stage: "teach", pageId: "page-1", secret: "private-stage-payload" }, "2026-09-22T10:05:00.000Z");
      append(job.id, "generation.stage.started", { stage: "teach", phase: "explanation", pageId: "page-1", prompt: "private prompt" }, "2026-09-22T10:06:00.000Z");
      append(job.id, "generation.stage.completed", {
        stage: "teach",
        phase: "explanation",
        apiKey: "private-provider-key",
        plan: { content: "private generation plan that must not appear in the job response" }
      }, "2026-09-22T10:07:00.000Z");
      append(job.id, "generation.stage.completed", {
        stage: "teach", pageId: "page-1", planningMode: "source-plan"
      }, "2026-09-22T10:07:30.000Z");
      append(job.id, "generation.page.completed", { stage: "review", pageId: "page-1" }, "2026-09-22T10:08:00.000Z");
      append(otherWorkspaceJob.id, "generation.stage.started", { stage: "repair", phase: "opening_repair" }, "2026-09-22T10:09:00.000Z");
      append(job.id, "generation.stage.started", { stage: "unknown", phase: "private-secret" }, "2026-09-22T10:10:00.000Z");
    });

    const taskIndex = await operations.readTaskIndex();
    const scopedEvents = await operations.readGenerationJobEvents(job.id);
    vi.spyOn(operations, "readTaskIndex").mockResolvedValue(taskIndex);
    const eventRead = vi.spyOn(operations, "readGenerationJobEvents").mockResolvedValue(scopedEvents);
    const fullRead = vi.spyOn(operations, "read").mockRejectedValue(new Error("FULL_STATE_READ"));

    const detail = await request(app).get(`/api/v1/generation-jobs/${job.id}`).set("X-Workspace-Id", "personal").expect(200);
    expect(detail.body.latestStageActivity).toEqual({
      stage: "teach",
      status: "completed",
      occurredAt: "2026-09-22T10:07:30.000Z"
    });
    expect(Object.keys(detail.body.latestStageActivity).sort()).toEqual(["occurredAt", "stage", "status"]);
    expect(JSON.stringify(detail.body)).not.toContain("private-stage-payload");
    expect(JSON.stringify(detail.body)).not.toContain("private prompt");
    expect(JSON.stringify(detail.body)).not.toContain("private-provider-key");
    expect(JSON.stringify(detail.body)).not.toContain("private generation plan");
    await request(app).get(`/api/v1/generation-jobs/${otherWorkspaceJob.id}`).set("X-Workspace-Id", "personal").expect(404);
    expect(eventRead).toHaveBeenCalledTimes(1);
    expect(fullRead).not.toHaveBeenCalled();
  });
  it("attaches sanitized latest stage summaries and ignores historical phases in a plan", async () => {
    const { app, operations, release } = await seededApp();
    const planId = "plan-stage-summary";
    const timestamp = "2026-09-22T10:00:00.000Z";
    const plan: GenerationPlan = {
      id: planId,
      workspaceId: "personal",
      materialVersionId: release.id,
      qualityMode: "balanced",
      language: "en",
      writingPolicySnapshotId: "writing-policy:test",
      pageIds: ["page-1", "page-2", "page-3"],
      completedPageIds: [],
      failedPageIds: [],
      coreCompletedPageIds: [],
      bridgeCompletedPageIds: [],
      jobIds: ["plan-stage-job-1", "plan-stage-job-2", "plan-stage-job-completed"],
      activeJobIds: ["plan-stage-job-1", "plan-stage-job-2"],
      currentJobId: "plan-stage-job-1",
      maxConcurrency: 2,
      budgetUsd: 2,
      spentUsd: 0,
      holdForReview: false,
      state: "running",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const makeJob = (id: string, state: GenerationJob["state"]): GenerationJob => ({
      id,
      workspaceId: "personal",
      materialVersionId: release.id,
      planId,
      state,
      budgetUsd: 1,
      spentUsd: 0,
      pageIds: ["page-1"],
      completedPageIds: [],
      failedPageIds: [],
      attempt: 1,
      cancelRequested: false,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const [firstJob, secondJob, completedJob] = [
      makeJob("plan-stage-job-1", "running"),
      makeJob("plan-stage-job-2", "running"),
      makeJob("plan-stage-job-completed", "completed")
    ];
    await operations.mutate((state) => {
      state.generationPlans.push(plan);
      state.jobs.push(firstJob!, secondJob!, completedJob!);
      const append = (streamId: string, type: string, payload: Record<string, unknown>, occurredAt: string) => {
        const event = operations.appendEvent(state, streamId, type, payload);
        event.occurredAt = occurredAt;
      };
      append(firstJob!.id, "generation.stage.started", { stage: "teach", phase: "opening", prompt: "private stage prompt" }, "2026-09-22T10:01:00.000Z");
      append(secondJob!.id, "generation.stage.started", { stage: "teach", phase: "opening" }, "2026-09-22T10:02:00.000Z");
      append(secondJob!.id, "generation.stage.completed", {
        stage: "teach",
        phase: "explanation",
        plan: { content: "private generation plan payload" }
      }, "2026-09-22T10:03:00.000Z");
      append(completedJob!.id, "generation.stage.started", { stage: "repair", phase: "opening_repair", secret: "inactive job event" }, "2026-09-22T10:04:00.000Z");
      append(completedJob!.id, "generation.stage.completed", { stage: "repair" }, "2026-09-22T10:04:30.000Z");
      append(firstJob!.id, "generation.page.core_saved", { pageId: "page-1" }, "2026-09-22T10:05:00.000Z");
      append(secondJob!.id, "generation.page.completed", { pageId: "page-2", bridgeCompleted: true }, "2026-09-22T10:06:00.000Z");
      append(secondJob!.id, "generation.cost.recorded", { provider: "test-provider", model: "test-model" }, "2026-09-22T10:07:00.000Z");
    });

    const fullRead = vi.spyOn(operations, "read").mockRejectedValue(new Error("DETAIL_ROUTE_USED_FULL_READ"));
    const response = await request(app).get(`/api/v1/generation-plans/${planId}`).expect(200);
    expect(fullRead).not.toHaveBeenCalled();
    expect(response.body.activeJobs).toHaveLength(2);
    expect(response.body.activeJobs[0].latestStageActivity).toEqual({
      stage: "teach",
      status: "started",
      occurredAt: "2026-09-22T10:01:00.000Z"
    });
    expect(response.body.activeJobs[1].latestStageActivity).toEqual({
      stage: "teach",
      status: "completed",
      occurredAt: "2026-09-22T10:03:00.000Z"
    });
    expect(response.body.currentJob.latestStageActivity).toEqual(response.body.activeJobs[0].latestStageActivity);
    expect(response.body.progress).toMatchObject({
      core: { completed: 1, total: 3 },
      crossPage: { completed: 1, total: 3 },
      repairCount: 1,
      concurrency: { running: 0, limit: 2 },
      provider: "test-provider",
      model: "test-model",
      costUsd: 0
    });
    expect(JSON.stringify(response.body)).not.toContain("private stage prompt");
    expect(JSON.stringify(response.body)).not.toContain("private generation plan payload");
    expect(JSON.stringify(response.body)).not.toContain("inactive job event");
    await request(app).get(`/api/v1/generation-plans/${planId}`).set("X-Workspace-Id", "other")
      .expect(404).expect(({ body }) => expect(body.error.code).toBe("GENERATION_PLAN_NOT_FOUND"));
  });
  it("indexes independent generation jobs under their course and restores their task page after refresh", async () => {
    const release = testRelease();
    release.id = "release-independent-job-index";
    const { app, operations, readweave } = await seededApp(undefined, release);
    const job: GenerationJob = {
      id: "3ad73f91-0000-4000-8000-000000000001",
      workspaceId: "personal",
      materialVersionId: release.id,
      state: "running",
      budgetUsd: 1,
      spentUsd: 0.02,
      pageIds: ["page-1", "page-2", "page-3"],
      completedPageIds: ["page-1"],
      failedPageIds: [],
      attempt: 1,
      cancelRequested: false,
      createdAt: "2026-09-22T10:00:00.000Z",
      updatedAt: "2026-09-22T10:01:00.000Z"
    };
    const importedMaterial: ImportRecord = {
      id: "import-task-metadata",
      workspaceId: "personal",
      courseId: release.courseId,
      originalName: "Lecture.pdf",
      mediaType: "application/pdf",
      kind: "pdf",
      sizeBytes: 10,
      sha256: "sha",
      casPath: "/private/lecture.pdf",
      source: "user_upload",
      license: "private_course_material",
      sensitivity: "private",
      state: "ready",
      issues: [],
      materialVersionId: release.id,
      pageIds: release.pageIds,
      createdAt: "2026-09-22T09:00:00.000Z"
    };
    await operations.mutate((state) => {
      state.imports.push(importedMaterial);
      state.jobs.push(
        job,
        { ...job, id: "job-with-plan-but-no-import", planId: "plan-independent" },
        { ...job, id: "job-other-workspace", workspaceId: "other" }
      );
    });
    const getRelease = vi.spyOn(readweave, "getRelease");
    const listCourses = vi.spyOn(readweave, "listCourses");

    const taskId = `generation-job:${job.id}`;
    const first = await request(app).get("/api/v1/imports").set("X-Workspace-Id", "personal").expect(200);
    expect(first.body).toContainEqual(expect.objectContaining({
      id: taskId,
      workspaceId: "personal",
      courseId: release.courseId,
      generationJobId: job.id,
      generationState: "running",
      pageIds: job.pageIds,
      generationCompletedPageIds: ["page-1"],
      state: "ready"
    }));
    expect(first.body.some((task: { id: string }) => task.id === "generation-job:job-with-plan-but-no-import")).toBe(false);
    expect(first.body.some((task: { id: string }) => task.id === "generation-job:job-other-workspace")).toBe(false);
    expect(JSON.stringify(first.body)).not.toContain("casPath");
    expect(getRelease).not.toHaveBeenCalled();
    expect(listCourses).not.toHaveBeenCalled();
    const refreshed = await request(app).get("/api/v1/imports").set("X-Workspace-Id", "personal").expect(200);
    expect(refreshed.body).toEqual(first.body);

    const detail = await request(app).get(`/api/v1/imports/${encodeURIComponent(taskId)}`).set("X-Workspace-Id", "personal").expect(200);
    expect(detail.body).toMatchObject({ id: taskId, generationJobId: job.id, generationState: "running", updatedAt: job.updatedAt });
    const detailAfterRefresh = await request(app).get(`/api/v1/imports/${encodeURIComponent(taskId)}`).set("X-Workspace-Id", "personal").expect(200);
    expect(detailAfterRefresh.body).toEqual(detail.body);
    await operations.mutate((state) => {
      const current = state.jobs.find((item) => item.id === job.id)!;
      current.state = "completed";
      current.completedPageIds = [...current.pageIds];
      current.updatedAt = "2026-09-22T10:02:00.000Z";
    });
    const completedAfterRefresh = await request(app).get(`/api/v1/imports/${encodeURIComponent(taskId)}`).set("X-Workspace-Id", "personal").expect(200);
    expect(completedAfterRefresh.body).toMatchObject({ generationState: "completed", generationCompletedPageIds: job.pageIds, updatedAt: "2026-09-22T10:02:00.000Z" });
    await request(app).get(`/api/v1/imports/${encodeURIComponent(taskId)}`).set("X-Workspace-Id", "other").expect(404);
  });
  it("does not fan out historical plan pages or source-linked jobs into separate import tasks", async () => {
    const release = testRelease();
    release.id = "release-with-many-historical-jobs";
    const { app, operations } = await seededApp(undefined, release);
    const importedMaterial: ImportRecord = {
      id: "import-with-linked-jobs",
      workspaceId: "personal",
      courseId: release.courseId,
      originalName: "Lecture.pptx",
      mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      kind: "pptx",
      sizeBytes: 10,
      sha256: "sha",
      casPath: "/private/lecture.pptx",
      source: "user_upload",
      license: "private_course_material",
      sensitivity: "private",
      state: "ready",
      issues: [],
      generationPlanId: "historical-plan-1",
      materialVersionId: release.id,
      pageIds: release.pageIds,
      createdAt: "2026-09-22T09:00:00.000Z"
    };
    const baseJob: GenerationJob = {
      id: "historical-job-template",
      workspaceId: "personal",
      materialVersionId: release.id,
      state: "completed",
      budgetUsd: 1,
      spentUsd: 0.02,
      pageIds: ["page-1"],
      completedPageIds: ["page-1"],
      failedPageIds: [],
      attempt: 1,
      cancelRequested: false,
      createdAt: "2026-09-22T10:00:00.000Z",
      updatedAt: "2026-09-22T10:01:00.000Z"
    };
    const historicalPlanJobs = Array.from({ length: 611 }, (_, index) => ({
      ...baseJob,
      id: `historical-plan-job-${index + 1}`,
      planId: `historical-plan-${Math.floor(index / 40) + 1}`,
      pageIds: [`page-${index + 1}`],
      completedPageIds: [`page-${index + 1}`]
    }));
    const linkedJobs = Array.from({ length: 12 }, (_, index) => ({
      ...baseJob,
      id: `source-linked-job-${index + 1}`,
      sourceImportId: importedMaterial.id
    }));
    const independentJobs = Array.from({ length: 3 }, (_, index) => ({
      ...baseJob,
      id: `standalone-job-${index + 1}`,
      state: "queued" as const,
      completedPageIds: []
    }));
    const existingPlan: GenerationPlan = {
      id: "historical-plan-1",
      workspaceId: "personal",
      materialVersionId: release.id,
      sourceImportId: importedMaterial.id,
      qualityMode: "balanced",
      language: "zh-CN",
      writingPolicySnapshotId: "test-writing-policy",
      pageIds: historicalPlanJobs.slice(0, 40).flatMap((job) => job.pageIds),
      completedPageIds: ["page-1"],
      failedPageIds: [],
      jobIds: historicalPlanJobs.slice(0, 40).map((job) => job.id),
      budgetUsd: 1,
      spentUsd: 0.02,
      holdForReview: false,
      state: "running",
      createdAt: "2026-09-22T09:00:00.000Z",
      updatedAt: "2026-09-22T10:01:00.000Z"
    };
    await operations.mutate((state) => {
      state.imports.push(importedMaterial);
      state.generationPlans.push(existingPlan);
      state.jobs.push(...historicalPlanJobs, ...linkedJobs, ...independentJobs, {
        ...baseJob,
        id: "standalone-job-other-workspace",
        workspaceId: "other",
        state: "queued",
        completedPageIds: []
      });
    });

    const response = await request(app).get("/api/v1/imports").set("X-Workspace-Id", "personal").expect(200);
    const taskIds = response.body.map((task: { id: string }) => task.id);
    expect(taskIds).toHaveLength(4);
    expect(taskIds).toContain(importedMaterial.id);
    expect(response.body.find((task: { id: string }) => task.id === importedMaterial.id)).toMatchObject({
      generationState: "running",
      generationCompletedPageIds: existingPlan.completedPageIds
    });
    expect(taskIds).toEqual(expect.arrayContaining(independentJobs.map((job) => `generation-job:${job.id}`)));
    expect(taskIds.some((id: string) => id.startsWith("generation-job:historical-plan-job-") || id.startsWith("generation-job:source-linked-job-") || id === "generation-job:standalone-job-other-workspace")).toBe(false);
  });
  it("records a safe ReadWeave failure kind without exposing a private response", () => {
    expect(safeReadWeaveFailureKind(new Error("READWEAVE_ETAPI_503:private response"))).toBe("http_503");
    expect(safeReadWeaveFailureKind(new Error("READWEAVE_ETAPI_NETWORK:This operation was aborted"))).toBe("timeout");
    expect(safeReadWeaveFailureKind(new Error("READWEAVE_DRAFT_READBACK_MISMATCH"))).toBe("readback_mismatch");
    expect(safeReadWeaveFailureKind(new Error("READWEAVE_PAGE_OVERVIEW_CONFLICT:private detail"))).toBe("readweave_page_overview_conflict");
  });
  it("reads a structured page and its release without listing every release", async () => {
    const release = testRelease();
    release.id = "structured-release";
    release.pageIds = ["structured-release:page:1"];
    release.pages[0]!.id = release.pageIds[0]!;
    const { app, readweave } = await seededApp(undefined, release);
    const listReleases = vi.spyOn(readweave, "listReleases").mockRejectedValue(new Error("FULL_RELEASE_SCAN_FORBIDDEN"));
    expect((await request(app).get("/api/v1/pages/structured-release:page:1/lesson").expect(200)).body.page.id).toBe(release.pageIds[0]);
    expect((await request(app).get("/api/v1/releases/structured-release").expect(200)).body.id).toBe(release.id);
    expect(listReleases).not.toHaveBeenCalled();
  });

  it("returns a lightweight release index without sending lesson bodies", async () => {
    const release = testRelease();
    release.assessments = [{ id: "assessment-index", objectiveId: "objective-1", pageId: "page-1", prompt: "assessment body", expectedAnswer: "answer body", transfer: false }];
    release.pages[0]!.atoms = [{ kind: "text_region", id: "atom-index", label: "index atom", observation: "atom body" }];
    const { app, readweave } = await seededApp(undefined, release);
    const fullRead = vi.spyOn(readweave, "listReleases");
    const indexRead = vi.spyOn(readweave, "listReleaseIndexes");
    const full = await request(app).get("/api/v1/releases").expect(200);
    const index = await request(app).get("/api/v1/releases?view=index").expect(200);
    const fullRelease = full.body.find((item: CourseRelease) => item.id === release.id) as CourseRelease;
    const indexed = index.body.find((item: CourseRelease) => item.id === release.id) as CourseRelease;
    expect(fullRead).toHaveBeenCalledTimes(1);
    expect(indexRead).toHaveBeenCalledTimes(1);
    expect(fullRelease.assessments).toEqual(release.assessments);
    expect(fullRelease.pages[0]!.atoms).toEqual(release.pages[0]!.atoms);
    expect(fullRelease.pages[0]!.blocks).toEqual(release.pages[0]!.blocks);
    expect(fullRelease.pages[0]!.questionBank).toEqual(release.pages[0]!.questionBank);
    expect(indexed.pages).toHaveLength(release.pages.length);
    expect(indexed).toEqual({
      ...fullRelease,
      assessments: [],
      pages: fullRelease.pages.map((page) => ({
        id: page.id,
        pageNumber: page.pageNumber,
        title: page.title,
        imageUrl: page.imageUrl,
        anchors: [],
        atoms: [],
        blocks: [],
        lessonSections: [],
        questionBank: [],
        coverageRequirements: [],
        coverageClaims: [],
        quality: page.quality
      }))
    });
    expect(indexed.pages[0]!.quality).toEqual(release.pages[0]!.quality);
    expect(JSON.stringify(index.body)).not.toContain("assessment body");
    expect(JSON.stringify(index.body)).not.toContain("atom body");
    expect(JSON.stringify(index.body)).not.toContain("原始讲解");
    expect(JSON.stringify(index.body).length).toBeLessThan(JSON.stringify(full.body).length);
  });

  it("gzips the release index only when accepted and preserves its JSON bytes", async () => {
    const { app } = await seededApp();
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_UNAVAILABLE");
      const getIndex = (acceptEncoding?: string) => new Promise<{ headers: import("node:http").IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
        const req = httpRequest({
          host: "127.0.0.1",
          port: address.port,
          path: "/api/v1/releases?view=index",
          headers: acceptEncoding === undefined ? undefined : { "Accept-Encoding": acceptEncoding }
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.end();
      });

      const plain = await getIndex("identity");
      const compressed = await getIndex("gzip");
      const refused = await getIndex("gzip;q=0");
      const varyTokens = (plain.headers.vary ?? "").split(",").map((token) => token.trim().toLowerCase());
      expect(varyTokens).toContain("accept-encoding");
      expect(plain.headers["content-encoding"]).toBeUndefined();
      expect(refused.headers["content-encoding"]).toBeUndefined();
      expect(compressed.headers["content-encoding"]).toBe("gzip");
      expect((compressed.headers.vary ?? "").toLowerCase()).toContain("accept-encoding");
      expect(plain.headers["server-timing"]).toMatch(/serialize;dur=[\d.]+/);
      expect(plain.headers["server-timing"]).not.toMatch(/gzip;dur=/);
      expect(compressed.headers["server-timing"]).toMatch(/gzip;dur=[\d.]+/);
      expect(await gunzipAsync(compressed.body)).toEqual(plain.body);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("serves the learner lesson from a saved draft snapshot without waiting for block reconciliation", async () => {
    const { app, readweave } = await seededApp();
    const snapshot = await readweave.getDraftByPage("page-1");
    const fastRead = vi.fn(async () => snapshot);
    (readweave as ReadWeaveCourseApi).getDraftSnapshotByPage = fastRead;
    const reconciledRead = vi.spyOn(readweave, "getDraftByPage").mockRejectedValue(new Error("SLOW_BLOCK_RECONCILIATION"));
    await request(app).get("/api/v1/pages/page-1/lesson").expect(200);
    expect(fastRead).toHaveBeenCalledWith("page-1");
    expect(reconciledRead).not.toHaveBeenCalled();
  });

  it("previews only the exact ready formal draft and keeps selected-question answers immutable", async () => {
    const { app, readweave, release } = await seededApp();
    const page = structuredClone(release.pages[0]!);
    page.blocks[0]!.markdown = "UNPUBLISHED FORMAL PREVIEW";
    page.questionBank = page.questionBank!.map((item) => ({
      ...item,
      prompt: `FORMAL PREVIEW: ${item.prompt}`,
      version: item.version + 1,
      ...(item.kind === "comprehension" ? { expectedAnswer: "formal preview answer v1" } : {})
    }));
    const draft = await readweave.saveDraft({
      id: "draft:page-1", workspaceId: "personal", courseId: release.courseId, moduleId: release.moduleId,
      sourceReleaseId: release.id, pageId: "page-1", revision: 0, status: "ready", page,
      changedBlockIds: page.blocks.map((block) => block.id), contentHash: "formal-preview-ready", updatedAt: new Date().toISOString()
    }, 0, { idempotencyKey: "formal-preview-ready", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "formal-preview-ready" });

    const draftRead = vi.spyOn(readweave, "getDraftByPage");
    draftRead.mockResolvedValueOnce({ ...draft, sourceReleaseId: "wrong-release" });
    const wrongRelease = await request(app).get("/api/v1/pages/page-1/lesson").expect(200);
    expect(wrongRelease.body.page).toEqual(release.pages[0]);
    expect(wrongRelease.body).not.toHaveProperty("unpublishedDraftRevision");
    draftRead.mockResolvedValueOnce({ ...draft, status: "needs_review" });
    const wrongStatus = await request(app).get("/api/v1/pages/page-1/lesson").expect(200);
    expect(wrongStatus.body.page).toEqual(release.pages[0]);
    expect(wrongStatus.body).not.toHaveProperty("unpublishedDraftRevision");

    const lesson = await request(app).get("/api/v1/pages/page-1/lesson").expect(200);
    expect(lesson.body).toMatchObject({ page, unpublishedDraftRevision: draft.revision });
    const session = await request(app).post("/api/v1/sessions").send({ courseReleaseId: release.id }).expect(201);
    const selected = await request(app).post("/api/v1/pages/page-1/questions:select").set("Idempotency-Key", "formal-preview-select")
      .send({ sessionId: session.body.id, seed: "formal-preview", count: 2 }).expect(201);
    expect(selected.body.questions.every((item: QuestionBankItem) => item.prompt.startsWith("FORMAL PREVIEW:"))).toBe(true);
    expect(selected.body.selection.questionSnapshots).toEqual(selected.body.questions);
    const selectedShortAnswer = selected.body.questions.find((item: QuestionBankItem) => item.kind === "comprehension") as QuestionBankItem;
    expect(selectedShortAnswer.expectedAnswer).toBe("formal preview answer v1");

    const updatedPage = {
      ...draft.page,
      questionBank: draft.page.questionBank!.map((item) => item.kind === "comprehension"
        ? { ...item, expectedAnswer: "formal preview answer v2", version: item.version + 1 }
        : item)
    };
    await readweave.saveDraft({ ...draft, page: updatedPage, contentHash: "formal-preview-updated" }, draft.revision,
      { idempotencyKey: "formal-preview-update", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "formal-preview-update" });
    const attempted = await request(app).post("/api/v1/question-attempts").set("Idempotency-Key", "formal-preview-attempt")
      .send({ selectionId: selected.body.selection.id, sessionId: session.body.id, courseReleaseId: release.id, pageId: "page-1",
        questionId: selectedShortAnswer.id, answer: selectedShortAnswer.expectedAnswer, usedHintLevel: 0 }).expect(201);
    expect(attempted.body.attempt).toMatchObject({ correct: true, questionVersion: selectedShortAnswer.version });
  });

  it("keeps historical questions off the lesson's critical path and reads them only on demand", async () => {
    const { app, readweave } = await seededApp();
    const historicalRead = vi.spyOn(readweave, "listQuestions").mockResolvedValue([]);
    const lesson = await request(app).get("/api/v1/pages/page-1/lesson").expect(200);
    expect(lesson.body.page.id).toBe("page-1");
    expect(lesson.body.qaRecords).toEqual([]);
    expect(historicalRead).not.toHaveBeenCalled();
    await request(app).get("/api/v1/pages/page-1/lesson?includeQa=1").expect(200);
    expect(historicalRead).toHaveBeenCalledWith("page-1");
    historicalRead.mockClear();
    await request(app).get("/api/v1/pages/page-1/questions").expect(200);
    expect(historicalRead).toHaveBeenCalledWith("page-1");
    await request(app).get("/api/v1/pages/page-1/questions").set("X-Workspace-Id", "another-workspace").expect(404);
    expect(historicalRead).toHaveBeenCalledTimes(1);
  });

  it("serves candidate previews from a saved snapshot while preserving reconciled editor reads", async () => {
    const { app, readweave } = await seededApp();
    const snapshot = await readweave.getDraftByPage("page-1");
    const fastRead = vi.fn(async () => snapshot);
    (readweave as ReadWeaveCourseApi).getDraftSnapshotByPage = fastRead;
    const reconciledRead = vi.spyOn(readweave, "getDraftByPage").mockResolvedValue(snapshot);
    await request(app).get("/api/v1/pages/page-1/draft?view=snapshot").expect(200);
    expect(fastRead).toHaveBeenCalledWith("page-1");
    expect(reconciledRead).not.toHaveBeenCalled();
    await request(app).get("/api/v1/pages/page-1/draft").expect(200);
    expect(reconciledRead).toHaveBeenCalledWith("page-1");
  });

  it("quotes exact source headings and translates a formula-heading reference without changing its symbol", () => {
    const content = testTeachingResult(0).content;
    content.chapterBridgeMarkdown = "上一页把 EDGE-GNN 接入了网络";
    content.fullExplanationMarkdown += "\n\n页面的 Formula 区块给出公式，Where 区块列出维度，Intuition 一句话解释用途\n\n图中 What is happening 一栏列出计算顺序\n\n```txt\nWhat is $W_e$ 一栏\n```";
    content.misconceptions = ["核对 What is $W_e$? 区块的原图说明，不能把矩阵当成每条边各有一份"];
    const normalized = normalizeTeachingPackageMath(content,
      "EDGE-GNN: EDGE EMBEDDING\nFormula\nWhere\nIntuition\nWhat is happening?\nWhat is W_e?", "EDGE-GNN: EDGE EMBEDDING");
    expect(normalized.chapterBridgeMarkdown).toContain("“EDGE-GNN”");
    expect(normalized.fullExplanationMarkdown).toContain("“Formula” 区块");
    expect(normalized.fullExplanationMarkdown).toContain("“Where” 区块");
    expect(normalized.fullExplanationMarkdown).toContain("“Intuition” 一句话");
    expect(normalized.fullExplanationMarkdown).toContain("“What is happening”");
    expect(normalized.fullExplanationMarkdown).toContain("```txt\nWhat is $W_e$ 一栏\n```");
    expect(normalized.misconceptions[0]).toContain("解释 $W_e$ 的区块");
    expect(normalized.misconceptions[0]).not.toContain("What is");
    expect(unpairedEnglishTeachingFields({ ...normalized, sourceTitle: "EDGE-GNN: EDGE EMBEDDING" })).toEqual([]);
  });

  it("keeps source labels quoted across the explanation and misconception fields", () => {
    const content = testTeachingResult(0).content;
    content.fullExplanationMarkdown += "\n\n左栏是 Setup 部分，右栏给出“Update Rule”并解释参数怎样变化";
    content.misconceptions = ["回到页面 Update Rule 一行，核对梯度是否已经展开"];
    const normalized = normalizeTeachingPackageMath(content, "Setup\nUpdate Rule", "TINY MDP EXAMPLE");
    expect(normalized.fullExplanationMarkdown).toContain("“Setup” 部分");
    expect(normalized.misconceptions[0]).toContain("“Update Rule” 一行");
    expect(unpairedEnglishTeachingFields({ ...normalized, sourceTitle: "TINY MDP EXAMPLE" })).toEqual([]);
  });

  it("delimits bare exponent and subscript notation before teaching validation", () => {
    const content = testTeachingResult(0).content;
    content.questions[0]!.explanation = "把 e^0 = 1 代入，再比较 x_1 与 x_2";
    const normalized = normalizeTeachingPackageMath(content);
    expect(normalized.questions[0]!.explanation).toBe("把 $e^0$ = 1 代入，再比较 $x_1$ 与 $x_2$");
  });

  it("repairs sample compound math while retaining source anchor relationships", () => {
    const content = testTeachingResult(0).content;
    content.fullExplanationMarkdown = "交换 $e_i$ 与 e_{i+1}，并使用 N_{i+1}；概率项为 e^{-Δcost/T}";
    const normalized = normalizeTeachingPackageMath(content);
    expect(normalized.fullExplanationMarkdown).toContain("$e_{i+1}$");
    expect(normalized.fullExplanationMarkdown).toContain("$N_{i+1}$");
    expect(normalized.fullExplanationMarkdown).toContain("$e^{-\\Delta cost/T}$");

    const sourcePage = {
      ...testRelease().pages[0]!,
      anchors: [{ id: "source-anchor-1" }] as never[],
      blocks: testRelease().pages[0]!.blocks.map((block) => ({ ...block, sourceAnchorIds: ["source-anchor-1"] }))
    };
    const compiled = applyTeachingPackage(sourcePage, normalized, false);
    expect(compiled.lessonSections?.every((section) => section.sourceAnchorIds.includes("source-anchor-1"))).toBe(true);
    expect(compiled.blocks[0]!.sourceAnchorIds).toEqual(["source-anchor-1"]);
  });

  it("removes page-number commentary while preserving the surrounding lesson", () => {
    const content = testTeachingResult(0).content;
    content.fullExplanationMarkdown = "先解释宏单元怎样进入放置流程\n\n页面右下角的“12/27”是页码，不属于讲解对象\n\n再解释布线结果怎样产生";
    const normalized = normalizeTeachingPackageMath(content);
    expect(normalized.fullExplanationMarkdown).toBe("先解释宏单元怎样进入放置流程\n\n\n再解释布线结果怎样产生");
    expect(validateTeachingNarrative({ ...normalized, strictWritingStyle: true })).not.toContain("TEACHING_LAYOUT_COMMENTARY");
  });

  it("caps a structured teaching summary losslessly without another model call", () => {
    const content = testTeachingResult(0).content;
    content.mainContentMarkdown = ["第一项", "第二项", "第三项", "第四项", "第五项", "第六项"].map((item) => `- ${item}`).join("\n");
    const normalized = normalizeTeachingPackageMath(content);
    expect(normalized.mainContentMarkdown.split("\n")).toEqual(["- 第一项", "- 第二项", "- 第三项", "- 第四项", "- 第五项；第六项"]);
  });

  it("removes a generic summary heading and turns each remaining fact into a list item", () => {
    const content = testTeachingResult(0).content;
    content.mainContentMarkdown = "## 主要内容\n\n先确认输入\n再计算结果\n最后核对边界";
    expect(normalizeTeachingPackageMath(content).mainContentMarkdown).toBe("- 先确认输入\n- 再计算结果\n- 最后核对边界");
  });

  it("translates an unquoted source count while preserving a quoted source label", () => {
    const content = testTeachingResult(0).content;
    content.fullExplanationMarkdown = "训练使用 10K designs，即一万个设计样本；原图标签“labelled data (10K designs)”保持原样";
    expect(normalizeTeachingPackageMath(content).fullExplanationMarkdown).toBe("训练使用 10,000 个设计样本，即一万个设计样本；原图标签“labelled data (10K designs)”保持原样");
  });

  it("normalizes labelled design counts and removes lowercase dictionary glosses", () => {
    const content = testTeachingResult(0).content;
    content.fullExplanationMarkdown = "使用 10K 个带标签设计 训练；拥塞程度（congestion）和密度（density）用于比较；原图“10K labelled designs（congestion）”保持原样";
    expect(normalizeTeachingPackageMath(content).fullExplanationMarkdown)
      .toBe("使用 10,000 个带标签设计样本训练；拥塞程度和密度用于比较；原图“10K labelled designs（congestion）”保持原样");
  });

  it("normalizes abbreviation placement and repeated teaching terms", () => {
    const content = testTeachingResult(0).content;
    content.priorKnowledge = ["马尔可夫决策过程（Markov Decision Process, MDP）：一种序贯决策框架；描述状态与动作；按转移产生结果；用于连续决策；不同于单步分类；补充说明适用边界"];
    content.fullExplanationMarkdown += "\n\n动作概率由软最大函数函数计算";
    const normalized = normalizeTeachingPackageMath(content);
    expect(normalized.priorKnowledge[0]).toMatch(/^MDP 马尔可夫决策过程（Markov Decision Process）：/u);
    expect(normalized.priorKnowledge[0]!.split("；")).toHaveLength(6);
    expect(normalized.priorKnowledge[0]).toContain("不同于单步分类；补充说明适用边界");
    expect(normalized.fullExplanationMarkdown).toContain("动作概率由软最大函数计算");
    expect(normalized.fullExplanationMarkdown).not.toContain("函数函数");
  });

  it("renders source diagram labels as quotations instead of code", () => {
    const content = testTeachingResult(0).content;
    content.fullExplanationMarkdown += "\n\n椭圆标记 `Agent`，方框写着 `Macro order: place larger ones first`";
    const normalized = normalizeTeachingPackageMath(content, "Agent\nMacro order: place larger ones first");
    expect(normalized.fullExplanationMarkdown).toContain("椭圆标记 “Agent”");
    expect(normalized.fullExplanationMarkdown).toContain("方框写着 “Macro order: place larger ones first”");
  });
  it("serves a workspace-scoped native QA note without scanning every release", async () => {
    const { app, readweave, release } = await seededApp();
    const pageId = release.pages[0]!.id;
    const nativeReader = vi.fn(async (requestedPageId: string, workspaceId: string) => workspaceId === "personal"
      ? { pageId: requestedPageId, noteUrl: "https://readweave.example.com/#root/known-page", questions: [] }
      : { pageId: requestedPageId, questions: [] });
    Object.assign(readweave, { listNativePageQuestions: nativeReader });
    const listReleases = vi.spyOn(readweave, "listReleases");
    const result = await request(app).get(`/api/v1/pages/${encodeURIComponent(pageId)}/readweave-questions`).set("X-Workspace-Id", "personal").expect(200);
    expect(result.body.noteUrl).toBe("https://readweave.example.com/#root/known-page");
    expect(nativeReader).toHaveBeenCalledWith(pageId, "personal");
    expect(listReleases).not.toHaveBeenCalled();
    await request(app).get(`/api/v1/pages/${encodeURIComponent(pageId)}/readweave-questions`).set("X-Workspace-Id", "other-workspace").expect(404);
  });

  it("uses the generated bilingual lesson title without changing the source title or body", () => {
    const source = { ...testRelease().pages[0]!, title: "Attention" };
    for (const heading of ["注意力 Attention", "注意力（Attention）", "1. 注意力 Attention"]) {
      const content = { ...testTeachingResult(0).content, fullExplanationMarkdown: `## ${heading}\n\n讲解内容` };
      const compiled = applyTeachingPackage(source, content, true);
      expect(compiled.title).toBe("Attention");
      expect(compiled.teachingTitle).toBe("注意力 Attention");
      expect(compiled.anchors).toEqual(source.anchors);
      expect(compiled.lessonSections?.find(section => section.kind === "full_explanation")?.markdown).toBe(content.fullExplanationMarkdown);
    }
    for (const body of ["## Attention\n\n正文", "```markdown\n## 注意力 Attention\n```", "## 核心思路\n\n正文"]) {
      expect(applyTeachingPackage(source, { ...testTeachingResult(0).content, fullExplanationMarkdown: body }, true).teachingTitle).toBeUndefined();
    }
  });

  it("preserves the complete body even when its opening and long lines also appear in the summary", () => {
    const content = testTeachingResult(0).content;
    content.mainContentMarkdown = "这里定义当前移动的增益，并说明满足平衡约束后才可以执行这次移动";
    content.fullExplanationMarkdown = `${content.mainContentMarkdown}\n\n## 为什么最后一步还要单独看\n${content.mainContentMarkdown}\n\n这一段保留计算与后续状态变化，不应该只留下章节标题`;
    for (const trace of [undefined, { version: 1 as const, plan: "", phases: [] }]) {
      const page = applyTeachingPackage(testRelease().pages[0]!, content, true, "text_only", trace);
      expect(page.lessonSections?.find(section => section.kind === "full_explanation")?.markdown)
        .toBe(content.fullExplanationMarkdown);
    }
  });

  it("keeps generated paragraph and list boundaries after page compilation", () => {
    const content = testTeachingResult(0).content;
    content.misconceptions = ["错误理解：差值就是平方；错因：两步运算被混为一谈；正确判断：先相减再平方；核对方法：分别计算两步"];
    content.learningObjectives = ["核对两个结果：\n\n- 先核对差值\n- 再核对平方"];
    const page = applyTeachingPackage(testRelease().pages[0]!, content, true);
    const restored = JSON.parse(JSON.stringify(page));
    expect(restored.lessonSections.find((s: {kind: string}) => s.kind === "learning_objectives").items[0].text).toBe(content.learningObjectives[0]);
    const misconception = restored.lessonSections.find((s: {kind: string}) => s.kind === "misconceptions").items[0].text;
    expect(misconception.split("\n\n")).toHaveLength(4);
    for (const role of ["错误理解", "错因", "正确判断", "核对方法"]) expect(misconception).toContain(`- **${role}**：`);
  });

  it("splits a long generated paragraph without touching Markdown objects", async () => {
    const { normalizePackedTeachingProse } = await import("./app.js");
    const long = `第一句${"用于解释关系".repeat(22)}。第二句${"用于解释条件".repeat(22)}。`;
    expect(normalizePackedTeachingProse(long)).toContain("。\n\n第二句");
    const table = "| 方法 | 限制 |\n| --- | --- |\n| 解析方法 | 无法直接处理不可微指标 |";
    expect(normalizePackedTeachingProse(table)).toBe(table);
    const semicolons = `第一项${"用于解释关系".repeat(22)}；第二项${"用于解释条件".repeat(22)}；`;
    expect(normalizePackedTeachingProse(semicolons)).toContain("关系\n\n第二项");
  });
  it("moves Chinese list punctuation outside strict inline math without changing valid TeX", () => {
    expect(normalizeGeneratedMathPunctuation("权重 $\u0000lambda$ 与 $\\gamma$"))
      .toBe("权重 $\\lambda$ 与 $\\gamma$");
    expect(normalizeGeneratedMathPunctuation("普通文本中有 \u0000unknown 控制字符"))
      .toContain("\u0000unknown");
    expect(normalizeGeneratedMathPunctuation("权重 $0.5、3、0.2$ 用于示例")).toBe("权重 $0.5$、$3$、$0.2$ 用于示例");
    expect(normalizeGeneratedMathPunctuation("公式 $F(x)=0.5L(x)$ 保持原样")).toBe("公式 $F(x)=0.5L(x)$ 保持原样");
    expect(normalizeGeneratedMathPunctuation("文字 $\\text{甲、乙}$ 不做破坏性拆分")).toBe("文字 $\\text{甲、乙}$ 不做破坏性拆分");
    expect(normalizeGeneratedMathPunctuation("得到 $G_2=2+0=2。$")).toBe("得到 $G_2=2+0=2$。");
    expect(normalizeGeneratedMathPunctuation("比较 $gain_{后}(f)-gain_{前}(f)$")).toBe("比较 $gain_{\\text{后}}(f)-gain_{\\text{前}}(f)$");
    expect(normalizeGeneratedMathPunctuation("曲线 $对应线性端点，$ 再比较")).toBe("曲线 对应线性端点， 再比较");
    expect(normalizeGeneratedMathPunctuation("换算 $1000\\text{ μm}=1\\text{ mm}$")).toBe("换算 $1000\\,\\mu\\mathrm{m}=1\\text{ mm}$");
    expect(normalizeGeneratedMathPunctuation("$$\\frac12+\u000crac12=1。$$")).toBe("$$\\frac12+\\frac12=1$$。");
    expect(normalizeGeneratedMathPunctuation("系数 $\u0009ext{Wirelength}$ 与 $\\gamma$")).toBe("系数 $\\text{Wirelength}$ 与 $\\gamma$");
    expect(normalizeGeneratedMathPunctuation("参数 $\u0009heta_1=0.1$ 与 $\u0008eta_1=0.2$")).toBe("参数 $\\theta_1=0.1$ 与 $\\beta_1=0.2$");
    expect(normalizeGeneratedMathPunctuation("第 16 行先让 $MT$ 加一，再计算 $\\Delta cost = cost(NE) - cost(E)"))
      .toBe("第 16 行先让 $MT$ 加一，再计算 $\\Delta cost = cost(NE) - cost(E)$");
    expect(normalizeGeneratedMathPunctuation("价格约 $5 美元，https://example.test/x_1 保持原样"))
      .toBe("价格约 $5 美元，https://example.test/x_1 保持原样");
  });
  it("corrects a near-miss technical term only when the page's own formula supplies one unambiguous spelling", () => {
    const content = {
      chapterBridgeMarkdown: "", learningObjectives: [], priorKnowledge: [], misconceptions: [], coverageEvidence: [], questions: [],
      mainContentMarkdown: "拥塞项是 congcyion，连接 connection 保持原样",
      fullExplanationMarkdown: "公式 $$r=-\\text{congestion}$$ 中的 congcyion 表示拥塞；`congcyion` 是代码示例"
    } as TeachingPackage;
    const normalized = normalizeTeachingPackageMath(content);
    expect(normalized.fullExplanationMarkdown).toContain("公式 $$r=-\\text{congestion}$$ 中的 congestion 表示拥塞");
    expect(normalized.fullExplanationMarkdown).toContain("`congcyion` 是代码示例");
    expect(normalized.mainContentMarkdown).toContain("congestion，连接 connection 保持原样");
  });
  it("uses the established Chinese term for bare softmax while preserving source quotations and code", () => {
    const content = {
      chapterBridgeMarkdown: "", learningObjectives: ["解释 softmax 的作用"],
      mainContentMarkdown: "- 用 softmax 得到概率", priorKnowledge: ["软最大函数（Softmax Function）：把向量转换成概率分布；用于选择动作；通过指数和归一化计算；在需要可微概率时使用；与直接取最大值不同"],
      fullExplanationMarkdown: "策略由 softmax 控制，原图标签“softmax”保持原样，代码 `softmax(x)` 保持原样",
      misconceptions: [], coverageEvidence: [], questions: []
    } as TeachingPackage;
    const normalized = normalizeTeachingPackageMath(content);
    expect(normalized.learningObjectives[0]).toBe("解释软最大函数的作用");
    expect(normalized.mainContentMarkdown).toContain("用软最大函数得到概率");
    expect(normalized.priorKnowledge[0]).toContain("软最大函数（Softmax Function）");
    expect(normalized.fullExplanationMarkdown).toContain("策略由软最大函数控制");
    expect(normalized.fullExplanationMarkdown).toContain("原图标签“softmax”保持原样");
    expect(normalized.fullExplanationMarkdown).toContain("代码 `softmax(x)` 保持原样");
  });

  it("reports liveness without waiting for ReadWeave", async () => {
    const { app, readweave } = await seededApp();
    const listReleases = vi.spyOn(readweave, "listReleases").mockRejectedValue(new Error("READWEAVE_OFFLINE"));
    const response = await request(app).get("/healthz").expect(200);
    expect(response.body).toEqual({ status: "ok", apiVersion: "2.4.0" });
    expect(listReleases).not.toHaveBeenCalled();
  });

  it("deduplicates an import by idempotency key", async () => {
    const app = await testApp();
    const source = Buffer.from("# Introduction\nAlgorithms and inputs");
    const first = await request(app).post("/api/v1/imports").set("Idempotency-Key", "import-1").field("autoGenerate", "false").attach("file", source, { filename: "lecture.md", contentType: "text/markdown" }).expect(201);
    await waitForImport(app, first.body.id);
    const second = await request(app).post("/api/v1/imports").set("Idempotency-Key", "import-1").field("autoGenerate", "false").attach("file", source, { filename: "lecture.md", contentType: "text/markdown" }).expect(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it("converts a syllabus into page images and ReadWeave drafts", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-api-import-"));
    const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
    const app = createApp(createDefaultDependencies(root, readweave));
    const course = await request(app).post("/api/v1/courses").set("Idempotency-Key", "import-course").send({ title: "通用算法课" }).expect(201);
    const accepted = await request(app).post("/api/v1/imports").set("Idempotency-Key", "syllabus-import").field("courseId", course.body.id).field("qualityMode", "quality").field("language", "zh-CN").field("autoGenerate", "false").attach("file", Buffer.from("# Week 1\nAlgorithms and complexity\n\n# Week 2\nGraphs and cuts"), { filename: "syllabus.md", contentType: "text/markdown" }).expect(201);
    const ready = await waitForImport(app, accepted.body.id);
    expect(ready).toMatchObject({ state: "ready", courseId: course.body.id, qualityMode: "quality", language: "zh-CN", autoGenerate: false, generationState: "not_requested" });
    expect(ready.pageIds).toHaveLength(1);
    expect(ready.draftIds).toHaveLength(1);
    const releases = await request(app).get("/api/v1/releases").expect(200);
    expect(releases.body.find((item: CourseRelease) => item.id === ready.materialVersionId)).toMatchObject({ lifecycle: "draft_source", pages: [{ pageNumber: 1 }] });
    const draft = await readweave.getDraftByPage(ready.pageIds[0]);
    expect(draft).toMatchObject({ status: "needs_review", revision: 1 });
    expect(draft?.page.imageUrl).toMatch(/^\/api\/v1\/media\/[a-f0-9]{64}$/);
    expect((await request(app).get("/healthz").expect(200)).body.status).toBe("ok");
  }, 45_000);

  it("persists truthful conversion stage and saved-page progress on the import task", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-api-import-progress-"));
    const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
    const dependencies = createDefaultDependencies(root, readweave);
    let reportPageCount!: () => void;
    let continueConversion!: () => void;
    const pageCountReported = new Promise<void>((resolve) => { reportPageCount = resolve; });
    const conversionGate = new Promise<void>((resolve) => { continueConversion = resolve; });
    dependencies.conversion = { enqueueAndWait: async (input, onProgress) => {
      const startedAt = new Date().toISOString();
      const publish = async (stage: "rendering_pages" | "finalizing" | "completed", completedPages: number, pageCount?: number) => {
        await onProgress?.({ requestId: input.id, stage, ...(pageCount === undefined ? {} : { pageCount }), completedPages, updatedAt: new Date().toISOString() });
      };
      await publish("rendering_pages", 0, 2);
      reportPageCount();
      await conversionGate;
      await mkdir(input.outputDir, { recursive: true });
      const pages = await Promise.all([1, 2].map(async (pageNumber) => {
        const imagePath = join(input.outputDir, `page-${pageNumber}.svg`);
        await writeFile(imagePath, `<svg xmlns="http://www.w3.org/2000/svg"><text>Page ${pageNumber}</text></svg>`);
        return { pageNumber, title: `Page ${pageNumber}`, text: `Source page ${pageNumber}`, imagePath, imageMediaType: "image/svg+xml" as const };
      }));
      await publish("finalizing", 2, 2);
      const completedAt = new Date().toISOString();
      await publish("completed", 2, 2);
      return { requestId: input.id, state: "completed" as const, pages, issues: [], startedAt, completedAt };
    } };
    const app = createApp(dependencies);
    const accepted = await request(app).post("/api/v1/imports").set("Idempotency-Key", "import-progress-persist")
      .field("autoGenerate", "false").attach("file", Buffer.from("# Progress source\nOne\ntwo"), { filename: "progress.md", contentType: "text/markdown" }).expect(201);

    await pageCountReported;
    const processing = await request(app).get(`/api/v1/imports/${accepted.body.id}`).expect(200);
    expect(processing.body).toMatchObject({ state: "processing", conversionProgress: { stage: "rendering_pages", pageCount: 2, completedPages: 0 } });
    continueConversion();
    const ready = await waitForImport(app, accepted.body.id);
    expect(ready).toMatchObject({ state: "ready", conversionProgress: { stage: "completed", pageCount: 2, completedPages: 2 } });
    expect(Object.keys(ready.conversionProgress).sort()).toEqual(["completedPages", "pageCount", "stage", "updatedAt"]);
    expect((await dependencies.operations.read()).imports.find((item) => item.id === accepted.body.id)?.conversionProgress)
      .toMatchObject({ stage: "completed", pageCount: 2, completedPages: 2 });
  }, 45_000);

  it("imports an inserted slide through the upload API without rewriting unrelated teaching drafts", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-api-incremental-upload-"));
    const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
    const dependencies = createDefaultDependencies(root, readweave);
    let conversionCount = 0;
    dependencies.conversion = { enqueueAndWait: async (input) => {
      conversionCount += 1;
      const titles = conversionCount === 1 ? ["Alpha", "Beta", "Gamma"] : ["Alpha", "Inserted", "Beta", "Gamma"];
      await mkdir(input.outputDir, { recursive: true });
      const pages = await Promise.all(titles.map(async (title, index) => {
        const imagePath = join(input.outputDir, `page-${index + 1}.svg`);
        await writeFile(imagePath, `<svg xmlns="http://www.w3.org/2000/svg"><text>${title}</text></svg>`);
        return { pageNumber: index + 1, title, text: `${title} source content`, imagePath, imageMediaType: "image/svg+xml" as const };
      }));
      return { requestId: input.id, state: "completed" as const, pages, issues: [], startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    } };
    const app = createApp(dependencies);
    const first = await request(app).post("/api/v1/imports").set("Idempotency-Key", "incremental-first")
      .field("autoGenerate", "false").attach("file", Buffer.from("# first version"), { filename: "slides.md", contentType: "text/markdown" }).expect(201);
    const original = await waitForImport(app, first.body.id);
    expect(original.state).toBe("ready");
    const originalGamma = (await readweave.getDraftByPage(original.pageIds[2]))!;
    originalGamma.page.blocks[0]!.markdown = "Original verified Gamma teaching";
    const savedGamma = await readweave.saveDraft(originalGamma, originalGamma.revision, {
      idempotencyKey: "gamma-teaching", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "gamma-teaching"
    });
    const destination = await request(app).post("/api/v1/courses").set("Idempotency-Key", "incremental-destination")
      .send({ id: "incremental-destination", title: "Moved material" }).expect(201);
    const materialId = `material:${original.courseId}:material:${original.id}`;
    await request(app).post(`/api/v1/tree/nodes/${encodeURIComponent(materialId)}/move`)
      .set("Idempotency-Key", "incremental-material-move").send({ parentId: destination.body.id, expectedRevision: 0 }).expect(200);
    await request(app).patch(`/api/v1/tree/nodes/${original.courseId}`)
      .set("Idempotency-Key", "incremental-owner-archive").send({ archived: true, expectedRevision: 0 }).expect(200);
    const second = await request(app).post("/api/v1/imports").set("Idempotency-Key", "incremental-second")
      .field("autoGenerate", "false").field("courseId", destination.body.id)
      .field("previousMaterialVersionId", original.materialVersionId)
      .attach("file", Buffer.from("# second version with inserted page"), { filename: "slides.md", contentType: "text/markdown" }).expect(201);
    const updated = await waitForImport(app, second.body.id);
    expect(updated.state, JSON.stringify(updated.issues)).toBe("ready");
    expect(updated.courseId).toBe(original.courseId);
    const movedTree = await request(app).get("/api/v1/workspaces/personal/tree").expect(200);
    expect(movedTree.body.courses.find((course: { id: string }) => course.id === destination.body.id).children)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: materialId, parentId: destination.body.id })]));
    const versions = await request(app).get(`/api/v1/tree/nodes/${encodeURIComponent(materialId)}/versions`).expect(200);
    expect(versions.body.map((version: { id: string }) => version.id)).toEqual(expect.arrayContaining([original.materialVersionId, updated.materialVersionId]));
    expect(updated.pageIds).toHaveLength(4);
    const newGamma = await readweave.getDraftByPage(updated.pageIds[3]);
    expect(newGamma?.page.blocks[0]?.markdown).toBe(savedGamma.page.blocks[0]?.markdown);
    expect(newGamma?.status).toBe(savedGamma.status);
    const event = (await dependencies.operations.read()).events.find(item => item.streamId === updated.id && item.type === "import.ready");
    expect(event?.payload).toMatchObject({ insertedPageIds: [updated.pageIds[1]], affectedPageIds: updated.pageIds.slice(0, 3), regeneratedPageIds: [],
      preservedPageIds: expect.arrayContaining([{ previousPageId: original.pageIds[2], pageId: updated.pageIds[3] }]) });
    const replay = await request(app).post("/api/v1/imports").set("Idempotency-Key", "incremental-second")
      .field("autoGenerate", "false").field("courseId", destination.body.id)
      .field("previousMaterialVersionId", original.materialVersionId)
      .attach("file", Buffer.from("# second version with inserted page"), { filename: "slides.md", contentType: "text/markdown" }).expect(200);
    expect(replay.body.id).toBe(updated.id);
    expect(conversionCount).toBe(2);
  }, 45_000);

  it("creates one idempotent draft generation job after an import without publishing a release", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-api-auto-generate-"));
    const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
    const dependencies = createDefaultDependencies(root, readweave);
    const app = createApp(dependencies);
    const source = Buffer.from("# Partitioning\nSplit the system into smaller connected parts");
    const accepted = await request(app).post("/api/v1/imports").set("Idempotency-Key", "auto-generate-import").field("qualityMode", "economy").attach("file", source, { filename: "partitioning.md", contentType: "text/markdown" }).expect(201);
    const ready = await waitForImport(app, accepted.body.id);
    expect(ready).toMatchObject({ state: "ready", autoGenerate: true });
    expect(["queued", "running", "failed"]).toContain(ready.generationState);
    expect(ready.generationJobId).toBeTruthy();
    const job = await waitForJob(app, ready.generationJobId);
    expect(job).toMatchObject({ sourceImportId: ready.id, qualityMode: "economy", language: "zh-CN", writingPolicySnapshotId: "writing-policy:0f709dc81c74650d", budgetUsd: 2 });
    const replay = await request(app).post("/api/v1/imports").set("Idempotency-Key", "auto-generate-import").attach("file", source, { filename: "partitioning.md", contentType: "text/markdown" }).expect(200);
    expect(replay.body.id).toBe(ready.id);
    expect((await dependencies.operations.read()).jobs).toHaveLength(1);
    expect((await readweave.listReleases()).filter((release) => release.lifecycle !== "draft_source")).toHaveLength(0);
  }, 45_000);

  it("makes a 56-page source ready without synchronizing 56 empty ReadWeave drafts before generation", async () => {
    const previous = process.env.COURSE_OS_EXTERNAL_WORKER;
    process.env.COURSE_OS_EXTERNAL_WORKER = "true";
    try {
      const root = await mkdtemp(join(tmpdir(), "course-os-import-source-ready-"));
      const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
      const dependencies = createDefaultDependencies(root, readweave);
      const emptySave = vi.spyOn(readweave, "saveDraft").mockRejectedValue(new Error("EMPTY_DRAFT_MUST_NOT_DELAY_GENERATION"));
      const draftLookup = vi.spyOn(readweave, "getDraftByPage").mockRejectedValue(new Error("FRESH_SOURCE_HAS_NO_DRAFTS"));
      dependencies.conversion = { enqueueAndWait: async input => {
        await mkdir(input.outputDir, { recursive: true });
        const pages = await Promise.all(Array.from({ length: 56 }, async (_, index) => {
          const imagePath = join(input.outputDir, `page-${index + 1}.svg`);
          await writeFile(imagePath, `<svg xmlns="http://www.w3.org/2000/svg"><text>Page ${index + 1}</text></svg>`);
          return { pageNumber: index + 1, title: `Page ${index + 1}`, text: `Source ${index + 1}`, imagePath, imageMediaType: "image/svg+xml" as const };
        }));
        return { requestId: input.id, state: "completed" as const, pages, issues: [], startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
      } };
      const app = createApp(dependencies);
      const accepted = await request(app).post("/api/v1/imports").set("Idempotency-Key", "source-ready-56")
        .field("autoGenerate", "true").attach("file", Buffer.from("# Isolated source"), { filename: "source.md", contentType: "text/markdown" }).expect(201);
      const ready = await waitForImport(app, accepted.body.id);
      expect(ready).toMatchObject({ state: "ready", conversionProgress: { pageCount: 56, completedPages: 56 } });
      expect(ready.generationPlanId).toBeTruthy();
      const source = await readweave.getRelease(ready.materialVersionId);
      expect(source?.pages.map(page => page.pageNumber)).toEqual(Array.from({ length: 56 }, (_, index) => index + 1));
      expect(emptySave).not.toHaveBeenCalled();
      expect(draftLookup).not.toHaveBeenCalled();
      for (const page of source!.pages) {
        const image = await dependencies.cas.get(page.imageUrl.split("/").at(-1)!);
        expect(image.toString()).toContain(`Page ${page.pageNumber}`);
      }
    } finally {
      if (previous === undefined) delete process.env.COURSE_OS_EXTERNAL_WORKER;
      else process.env.COURSE_OS_EXTERNAL_WORKER = previous;
    }
  }, 15_000);

  it("overlaps teaching with source registration without writing a draft before authority confirmation", async () => {
    const modelRouter: ModelRouterClient = { generateTeachingPackage: vi.fn(async () => testTeachingResult(0)) };
    const { app, dependencies, readweave } = await seededApp(modelRouter);
    let allowRegistration!: () => void;
    const registrationGate = new Promise<void>(resolve => { allowRegistration = resolve; });
    const register = readweave.registerDraftSource.bind(readweave);
    const registration = vi.spyOn(readweave, "registerDraftSource").mockImplementation(async (...args) => {
      await registrationGate;
      return register(...args);
    });
    const save = vi.spyOn(readweave, "saveDraftWithCost");
    try {
      const accepted = await request(app).post("/api/v1/imports").set("Idempotency-Key", "source-model-overlap")
        .field("autoGenerate", "true").attach("file", Buffer.from("# Pipeline\n\nA source definition and a worked example."), { filename: "pipeline.md", contentType: "text/markdown" }).expect(201);
      await vi.waitFor(() => expect(modelRouter.generateTeachingPackage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      expect(registration).toHaveBeenCalledTimes(1);
      expect(save).not.toHaveBeenCalled();
      const pending = await dependencies.operations.getImport(accepted.body.id, "personal");
      expect(pending).toMatchObject({ state: "syncing", sourceRegistration: { state: "pending" } });
      expect(pending?.generationPlanId).toBeTruthy();
      await vi.waitFor(async () => {
        const detail = await request(app).get(`/api/v1/generation-plans/${pending!.generationPlanId}`).expect(200);
        expect(detail.body.plan.stageSummary.generation).toMatchObject({ completed: 1, total: 1 });
        expect(detail.body.plan.stageSummary.core_save).toMatchObject({ completed: 0, total: 1, pendingSave: 1 });
      }, { timeout: 5000 });
      allowRegistration();
      const ready = await waitForImport(app, accepted.body.id);
      const job = await waitForJob(app, ready.generationJobId);
      expect(job).toMatchObject({ state: "completed", failedPageIds: [], completedPageIds: ready.pageIds });
      expect(modelRouter.generateTeachingPackage).toHaveBeenCalledTimes(1);
      expect(await readweave.getDraftByPage(ready.pageIds[0])).toBeDefined();
      const done = await request(app).get(`/api/v1/generation-plans/${ready.generationPlanId}`).expect(200);
      expect(done.body.plan.stageSummary.core_save).toMatchObject({ completed: 1, total: 1, pendingSave: 0 });
    } finally { allowRegistration(); }
  }, 20_000);

  it("refills the core slot from durable paid output while source registration remains blocked", async () => {
    const previous = process.env.COURSE_OS_GENERATION_CONCURRENCY;
    process.env.COURSE_OS_GENERATION_CONCURRENCY = "1";
    let allowRegistration!: () => void;
    const registrationGate = new Promise<void>(resolve => { allowRegistration = resolve; });
    const modelRouter: ModelRouterClient = { generateTeachingPackage: vi.fn(async () => testTeachingResult(0.002)) };
    const { dependencies, readweave } = await seededApp(modelRouter);
    dependencies.conversion = { enqueueAndWait: async input => {
      await mkdir(input.outputDir, { recursive: true });
      const pages = await Promise.all([1, 2].map(async pageNumber => {
        const imagePath = join(input.outputDir, `page-${pageNumber}.svg`);
        await writeFile(imagePath, `<svg xmlns="http://www.w3.org/2000/svg"><text>Page ${pageNumber}</text></svg>`);
        return { pageNumber, title: `Page ${pageNumber}`, text: `Definition and worked example ${pageNumber}`, imagePath, imageMediaType: "image/svg+xml" as const };
      }));
      return { requestId: input.id, state: "completed" as const, pages, issues: [], startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    } };
    const app = createApp(dependencies);
    const register = readweave.registerDraftSource.bind(readweave);
    vi.spyOn(readweave, "registerDraftSource").mockImplementation(async (...args) => { await registrationGate; return register(...args); });
    const save = vi.spyOn(readweave, "saveDraftWithCost");
    try {
      const accepted = await request(app).post("/api/v1/imports").set("Idempotency-Key", "core-slot-refill-before-save")
        .field("autoGenerate", "true").attach("file", Buffer.from("# Two independent pages"), { filename: "refill.md", contentType: "text/markdown" }).expect(201);
      await vi.waitFor(() => expect(modelRouter.generateTeachingPackage).toHaveBeenCalledTimes(2), { timeout: 10_000 });
      const pending = await dependencies.operations.getImport(accepted.body.id, "personal");
      expect(pending?.sourceRegistration?.state).toBe("pending");
      await vi.waitFor(async () => {
        const detail = await request(app).get(`/api/v1/generation-plans/${pending!.generationPlanId}`).expect(200);
        expect(detail.body.progress.concurrency).toEqual({ running: 0, limit: 1 });
        expect(detail.body.activeJobs).toHaveLength(2);
        expect(detail.body.plan.stageSummary.core_save).toMatchObject({ completed: 0, total: 2, pendingSave: 2 });
        const state = await dependencies.operations.read();
        for (const job of detail.body.activeJobs) {
          expect(state.generationCheckpoints[`${job.id}:${job.pageIds[0]}`])
            .toMatchObject({ teaching: { content: testTeachingResult(0.002).content }, teachingCost: { actualMicrousd: 2000 } });
        }
      }, { timeout: 5000 });
      expect(save).not.toHaveBeenCalled();
      allowRegistration();
      const ready = await waitForImport(app, accepted.body.id);
      const done = await waitForPlan(app, ready.generationPlanId);
      expect(done).toMatchObject({ state: "completed", completedPageIds: ready.pageIds, failedPageIds: [] });
      expect(modelRouter.generateTeachingPackage).toHaveBeenCalledTimes(2);
      expect(save).toHaveBeenCalledTimes(2);
    } finally {
      allowRegistration();
      if (previous === undefined) delete process.env.COURSE_OS_GENERATION_CONCURRENCY;
      else process.env.COURSE_OS_GENERATION_CONCURRENCY = previous;
    }
  }, 20_000);

  it("keeps paid teaching recoverable when authority registration is rejected", async () => {
    const modelRouter: ModelRouterClient = { generateTeachingPackage: vi.fn(async () => testTeachingResult(0.002)) };
    const { app, dependencies, readweave } = await seededApp(modelRouter);
    let rejectRegistration!: () => void;
    const gate = new Promise<void>(resolve => { rejectRegistration = resolve; });
    vi.spyOn(readweave, "registerDraftSource").mockImplementation(async () => {
      await gate;
      throw new Error("READWEAVE_ETAPI_403:denied");
    });
    const save = vi.spyOn(readweave, "saveDraftWithCost");
    try {
      const accepted = await request(app).post("/api/v1/imports").set("Idempotency-Key", "source-rejected-after-model")
        .field("autoGenerate", "true").attach("file", Buffer.from("# Denied registration\n\nA preserved definition."), { filename: "denied.md", contentType: "text/markdown" }).expect(201);
      await vi.waitFor(() => expect(modelRouter.generateTeachingPackage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      rejectRegistration();
      const failedImport = await waitForImport(app, accepted.body.id);
      expect(failedImport).toMatchObject({ state: "failed", sourceRegistration: { state: "failed" },
        conversionProgress: { stage: "completed", completedPages: 1, pageCount: 1 } });
      const job = await waitForJob(app, failedImport.generationJobId);
      expect(job).toMatchObject({ state: "failed", spentUsd: 0.002 });
      expect(save).not.toHaveBeenCalled();
      const state = await dependencies.operations.read();
      expect(state.generationCheckpoints[`${job.id}:${job.pageIds[0]}`])
        .toMatchObject({ teaching: { content: testTeachingResult(0.002).content }, teachingCost: { actualMicrousd: 2000 } });
      expect(state.events.filter(event => event.streamId === job.id && event.type === "generation.cost.pending"))
        .toHaveLength(1);
    } finally { rejectRegistration(); }
  }, 20_000);

  it("confirms a source committed before its response was lost without duplicating the source", async () => {
    const previous = process.env.COURSE_OS_EXTERNAL_WORKER;
    process.env.COURSE_OS_EXTERNAL_WORKER = "true";
    try {
      const { app, readweave } = await seededApp();
      const register = readweave.registerDraftSource.bind(readweave);
      const spy = vi.spyOn(readweave, "registerDraftSource").mockImplementation(async (...args) => {
        await register(...args);
        throw new Error("READWEAVE_ETAPI_NETWORK:response lost after commit");
      });
      const accepted = await request(app).post("/api/v1/imports").set("Idempotency-Key", "source-commit-lost-response")
        .field("autoGenerate", "true").attach("file", Buffer.from("# Response loss\n\nPreserve this source."), { filename: "lost.md", contentType: "text/markdown" }).expect(201);
      const ready = await waitForImport(app, accepted.body.id);
      expect(ready).toMatchObject({ state: "ready", sourceRegistration: { state: "confirmed" } });
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await readweave.listReleases()).filter(source => source.id === ready.materialVersionId)).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.COURSE_OS_EXTERNAL_WORKER;
      else process.env.COURSE_OS_EXTERNAL_WORKER = previous;
    }
  }, 15_000);

  it("fails generation when no configured model is available instead of saving a local substitute", async () => {
    const { app, readweave } = await seededApp();
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "missing-provider-job")
      .send({ materialVersionId: "test-release-v1", pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    const job = await waitForJob(app, created.body.id);
    expect(job.state).toBe("failed");
    expect(await readweave.getDraftByPage("page-1")).toBeUndefined();
  });

  it("returns a safe candidate writing policy without private paths", async () => {
    const policy = await request(await testApp()).get("/api/v1/writing-policy/current").expect(200);
    expect(policy.body).toMatchObject({ policySnapshotId: "writing-policy:0f709dc81c74650d", sourceCommit: "", status: "approved", taskContract: "GENERATE + TEACHING", validator: { status: "passed" } });
    expect(policy.body.promptTemplate).toContain("SOURCE");
    expect(JSON.stringify(policy.body)).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\/|\/srv\//);
  });

  it("reports the phases used by planned lesson generation", async () => {
    const harness = await request(await testApp()).get("/api/v1/generation-harness/current").expect(200);
    expect(harness.body).toMatchObject({ phases: ["plan", "teaching", "format_repair"], maximumRepairCalls: 1 });
  });

  it("creates an idempotent isolated candidate without changing the formal release", async () => {
    const { app, readweave } = await seededApp();
    const created = await request(app).post("/api/v1/release-candidates")
      .set("Idempotency-Key", "candidate-release-1")
      .send({ baseReleaseId: "test-release-v1", releaseId: "test-release-v2-candidate", budgetUsd: 2, qualityMode: "economy" })
      .expect(202);
    expect(created.body.candidate).toMatchObject({ id: "test-release-v2-candidate", lifecycle: "draft_source", candidateBaseReleaseId: "test-release-v1", pageIds: ["test-release-v2-candidate:page:1"], writingPolicySnapshotId: "writing-policy:0f709dc81c74650d" });
    expect(created.body.candidate.pages[0].id).not.toBe("page-1");
    expect(created.body.candidate.pages[0].blocks[0].id).toContain("test-release-v2-candidate:page:1");
    expect((await readweave.listReleases()).filter((item) => item.lifecycle !== "draft_source")).toHaveLength(1);
    const replay = await request(app).post("/api/v1/release-candidates")
      .set("Idempotency-Key", "candidate-release-1")
      .send({ baseReleaseId: "test-release-v1", releaseId: "test-release-v2-candidate" })
      .expect(200);
    expect(replay.body.candidate.id).toBe(created.body.candidate.id);
    expect((await readweave.listReleases()).filter((item) => item.id === "test-release-v2-candidate")).toHaveLength(1);
  }, 45_000);

  it("runs independent pages concurrently while keeping one job per page", async () => {
    let releaseGeneration!: () => void;
    const generationGate = new Promise<void>((resolve) => { releaseGeneration = resolve; });
    const { app, operations, readweave, release } = await seededApp({ generateTeachingPackage: async () => { await generationGate; return testTeachingResult(0); } }, testReleaseWithPages(3));
    const created = await request(app).post("/api/v1/release-candidates")
      .set("Idempotency-Key", "candidate-plan-serial")
      .send({ baseReleaseId: release.id, releaseId: "test-release-v2-serial-candidate", budgetUsd: 2, qualityMode: "economy" })
      .expect(202);
    expect(created.body.draftIds).toHaveLength(3);
    expect(await readweave.listDrafts()).toHaveLength(0);
    const running = await request(app).get(`/api/v1/generation-plans/${created.body.generationPlan.id}`).expect(200);
    expect(running.body.plan).toMatchObject({ maxConcurrency: 14 });
    expect(running.body.plan.jobIds).toHaveLength(3);
    expect(running.body.activeJobs).toHaveLength(3);
    expect(running.body.progress).toMatchObject({
      core: { completed: 0, total: 3 },
      crossPage: { completed: 0, total: 3 },
      concurrency: { running: 3, limit: 14 },
      costUsd: 0
    });
    releaseGeneration();
    const completed = await waitForPlan(app, created.body.generationPlan.id);
    expect(completed).toMatchObject({ state: "completed", pageIds: [
      "test-release-v2-serial-candidate:page:1",
      "test-release-v2-serial-candidate:page:2",
      "test-release-v2-serial-candidate:page:3"
    ], completedPageIds: [
      "test-release-v2-serial-candidate:page:1",
      "test-release-v2-serial-candidate:page:2",
      "test-release-v2-serial-candidate:page:3"
    ] });
    expect(completed.jobIds).toHaveLength(3);
    const jobs = (await operations.read()).jobs.filter((job) => job.planId === completed.id);
    expect(jobs).toHaveLength(3);
    expect(jobs.every((job) => job.pageIds.length === 1)).toBe(true);
    expect(jobs.map((job) => job.batchIndex)).toEqual([0, 1, 2]);
    expect(jobs.every((job) => job.batchCount === 3)).toBe(true);
    expect(await readweave.listDrafts()).toHaveLength(3);
  }, 45_000);

  it("holds a selected candidate anchor plan for review without generating other pages", async () => {
    const { app, readweave, release } = await seededApp({ generateTeachingPackage: async () => testTeachingResult(0) }, testReleaseWithPages(8));
    const created = await request(app).post("/api/v1/release-candidates")
      .set("Idempotency-Key", "candidate-plan-anchors")
      .send({ baseReleaseId: release.id, releaseId: "test-release-v2-anchor-candidate", pageNumbers: [1, 2, 3, 4, 5, 6], holdForReview: true, budgetUsd: 2, qualityMode: "economy" })
      .expect(202);
    expect(created.body.draftIds).toHaveLength(6);
    expect(await readweave.listDrafts()).toHaveLength(6);
    const completed = await waitForPlan(app, created.body.generationPlan.id);
    expect(completed).toMatchObject({ state: "completed", pageIds: [
      "test-release-v2-anchor-candidate:page:1",
      "test-release-v2-anchor-candidate:page:2",
      "test-release-v2-anchor-candidate:page:3",
      "test-release-v2-anchor-candidate:page:4",
      "test-release-v2-anchor-candidate:page:5",
      "test-release-v2-anchor-candidate:page:6"
    ] });
    expect(completed.completedPageIds).toHaveLength(6);
    expect(completed.jobIds).toHaveLength(6);
    const candidate = await readweave.getRelease("test-release-v2-anchor-candidate");
    expect(candidate?.lifecycle).toBe("draft_source");
    expect((await readweave.getRelease(release.id))?.lifecycle).not.toBe("draft_source");
  }, 45_000);

  it("continues after a failed page and retries only that page", async () => {
    const keys: string[] = [];
    let firstPageFailed = false;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async (input) => {
        keys.push(input.idempotencyKey);
        // Parallel workers need not reach the model in page-number order.
        // Inject the failure into its intended page, rather than the first call.
        if (input.idempotencyKey.includes("test-release-v2-retry-candidate:page:1") && !firstPageFailed) {
          firstPageFailed = true;
          throw new ModelRouterGenerationError("MODEL_ROUTER_FAILED:TEMPORARY", "gpt-5.6-sol", { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, apiEquivalentUsd: 0, durationMs: 10 });
        }
        return testTeachingResult(0.001);
      }
    };
    const { app, operations, release } = await seededApp(modelRouter, testReleaseWithPages(2));
    const created = await request(app).post("/api/v1/release-candidates")
      .set("Idempotency-Key", "candidate-plan-retry")
      .send({ baseReleaseId: release.id, releaseId: "test-release-v2-retry-candidate", budgetUsd: 2, qualityMode: "economy" })
      .expect(202);
    const failedPlan = await waitForPlan(app, created.body.generationPlan.id);
    expect(failedPlan).toMatchObject({ state: "failed", failedPageIds: ["test-release-v2-retry-candidate:page:1"], completedPageIds: ["test-release-v2-retry-candidate:page:2"] });
    const failedJob = (await operations.read()).jobs.find((job) => job.id === failedPlan.jobIds[0]);
    expect(failedJob?.failedPageIds).toEqual(["test-release-v2-retry-candidate:page:1"]);
    await request(app).post(`/api/v1/generation-jobs/${failedJob!.id}:retry`).set("Idempotency-Key", "candidate-plan-retry-page").expect(202);
    const recovered = await waitForPlan(app, failedPlan.id);
    expect(recovered).toMatchObject({ state: "completed", failedPageIds: [], completedPageIds: ["test-release-v2-retry-candidate:page:1", "test-release-v2-retry-candidate:page:2"] });
    expect(keys).toHaveLength(3);
    expect(keys.slice(0, 2).filter(key => key.includes("test-release-v2-retry-candidate:page:1"))).toHaveLength(1);
    expect(keys.slice(0, 2).filter(key => key.includes("test-release-v2-retry-candidate:page:2"))).toHaveLength(1);
    expect(keys[2]).toContain("test-release-v2-retry-candidate:page:1");
  }, 60_000);

  it("retries a failed plan page under the active Harness and records each billed attempt once", async () => {
    let calls = 0;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async () => {
        calls += 1;
        if (calls === 1) throw new ModelRouterGenerationError("PROVIDER_AUTH", "synthetic-vision", testTeachingResult(0.002).usage, "deepseek");
        return testTeachingResult(0.001);
      }
    };
    const releaseWithCurrentPolicy = { ...testRelease(), writingPolicySnapshotId: "writing-policy:0f709dc81c74650d" };
    const { app, operations, release } = await seededApp(modelRouter, releaseWithCurrentPolicy);
    const created = await request(app).post("/api/v1/generation-plans")
      .set("Idempotency-Key", "failed-plan-retry-create")
      .send({ materialVersionId: release.id, pageIds: release.pageIds, budgetUsd: 2, qualityMode: "economy" })
      .expect(202);
    const failed = await waitForPlan(app, created.body.plan.id);
    expect(failed).toMatchObject({ state: "failed", completedPageIds: [], failedPageIds: ["page-1"] });
    await operations.mutate((state) => {
      const plan = state.generationPlans.find((item) => item.id === failed.id)!;
      plan.harnessSnapshotId = "obsolete-harness";
      plan.writingPolicySnapshotId = "writing-policy:stale";
      for (const job of state.jobs.filter((item) => item.planId === failed.id)) {
        job.harnessSnapshotId = "obsolete-harness";
        job.writingPolicySnapshotId = "writing-policy:stale";
      }
    });
    await request(app).post(`/api/v1/generation-plans/${failed.id}:retry-failed`)
      .set("Idempotency-Key", "failed-plan-retry-stale-policy")
      .expect(409)
      .expect((response) => expect(response.body.error).toMatchObject({ code: "WRITING_POLICY_SNAPSHOT_CHANGED" }));
    await operations.mutate((state) => {
      const plan = state.generationPlans.find((item) => item.id === failed.id)!;
      plan.writingPolicySnapshotId = "writing-policy:0f709dc81c74650d";
      for (const job of state.jobs.filter((item) => item.planId === failed.id)) {
        job.writingPolicySnapshotId = plan.writingPolicySnapshotId;
      }
    });
    const retried = await request(app).post(`/api/v1/generation-plans/${failed.id}:retry-failed`)
      .set("Idempotency-Key", "failed-plan-retry-run")
      .expect(202);
    expect(retried.body.plan.harnessSnapshotId).toBe(currentGenerationHarness().aggregateSha256);
    expect(retried.body.jobs).toHaveLength(1);
    expect(retried.body.jobs[0].harnessSnapshotId).toBe(currentGenerationHarness().aggregateSha256);
    expect(retried.body.jobs[0].attempt).toBe(0);
    expect(retried.body.jobs[0].lastErrorCode).toBeUndefined();
    const completed = await waitForPlan(app, failed.id);
    expect(completed).toMatchObject({ state: "completed", completedPageIds: ["page-1"], failedPageIds: [], spentUsd: 0.003 });
    const costs = await request(app).get(`/api/v1/costs?jobId=${retried.body.jobs[0].id}`).expect(200);
    expect(costs.body.entries).toHaveLength(2);
    expect(new Set(costs.body.entries.map((entry: { id: string }) => entry.id)).size).toBe(2);
    const retryEvent = (await operations.read()).events.find(item => item.streamId === failed.id && item.type === "plan.retry.queued");
    expect(retryEvent?.payload).toMatchObject({
      previousHarnessSnapshotId: "obsolete-harness",
      harnessSnapshotId: currentGenerationHarness().aggregateSha256
    });
    await request(app).post(`/api/v1/generation-plans/${failed.id}:retry-failed`)
      .set("Idempotency-Key", "failed-plan-retry-run")
      .expect(200);
  }, 60_000);

  it("retries a saved core's missing bridge on its existing job after an approved Harness change", async () => {
    let coreCalls = 0;
    let bridgeCalls = 0;
    let bridgeAvailable = false;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async () => {
        coreCalls += 1;
        return testTeachingResult(0.001);
      },
      generateBridge: async ({ pageNumber }) => {
        bridgeCalls += 1;
        if (pageNumber === 2 && !bridgeAvailable) {
          throw new ModelRouterGenerationError("MODEL_PROVIDER_FAILED:429", "deepseek-v4-flash", {
            inputTokens: 20, cachedInputTokens: 0, outputTokens: 0, apiEquivalentUsd: 0, durationMs: 25
          }, "kuafu");
        }
        return { markdown: `Bridge for page ${pageNumber}`, provider: "kuafu", model: "deepseek-v4.1-flash",
          usage: testTeachingResult(0.001).usage };
      }
    };
    const source = { ...testReleaseWithPages(2), writingPolicySnapshotId: "writing-policy:0f709dc81c74650d" };
    const { app, operations, readweave, release } = await seededApp(modelRouter, source);
    const completedPageId = release.pageIds[0]!;
    const bridgePageId = release.pageIds[1]!;
    const created = await request(app).post("/api/v1/generation-plans")
      .set("Idempotency-Key", "partial-snapshot-create")
      .send({ materialVersionId: release.id, pageIds: release.pageIds, budgetUsd: 2, qualityMode: "economy" })
      .expect(202);
    const oldPlan = await waitForPlan(app, created.body.plan.id);
    expect(oldPlan).toMatchObject({ state: "failed", completedPageIds: [completedPageId], failedPageIds: [bridgePageId] });
    expect(coreCalls).toBe(2);
    expect(bridgeCalls).toBe(2);
    const beforeRetry = await operations.read();
    const originalFailedJob = beforeRetry.jobs.find(item => item.planId === oldPlan.id && item.failedPageIds.includes(bridgePageId))!;
    const originalCompletedJob = beforeRetry.jobs.find(item => item.planId === oldPlan.id && item.completedPageIds.includes(completedPageId))!;
    const coreDraft = await readweave.getDraftByPage(bridgePageId);
    expect(coreDraft?.generationJobId).toBe(originalFailedJob.id);
    expect(coreDraft?.page.lessonSections?.some(section => section.kind === "chapter_bridge" && section.markdown?.trim())).toBe(false);
    expect(beforeRetry.events.some(item => item.streamId === originalFailedJob.id && item.type === "generation.page.core_saved"
      && (item.payload as { pageId?: string }).pageId === bridgePageId)).toBe(true);
    const completedJobHarness = "completed-job-original-harness";
    const obsoleteHarness = "obsolete-harness-before-bridge-retry";
    await operations.mutate(state => {
      const old = state.generationPlans.find(item => item.id === oldPlan.id)!;
      old.harnessSnapshotId = obsoleteHarness;
      const failedJob = state.jobs.find(item => item.id === originalFailedJob.id)!;
      failedJob.harnessSnapshotId = obsoleteHarness;
      state.jobs.find(item => item.id === originalCompletedJob.id)!.harnessSnapshotId = completedJobHarness;
      old.sourceImportId = "import-continuation-test";
      state.imports.push({ id: "import-continuation-test", workspaceId: "personal", materialVersionId: release.id,
        pageIds: [...release.pageIds], generationPlanId: old.id, generationState: "failed",
        generationCompletedPageIds: [...old.completedPageIds], generationFailedPageIds: [...old.failedPageIds],
        originalName: "sample.pdf", kind: "pdf", state: "ready", autoGenerate: true,
        createdAt: new Date().toISOString(), sensitivity: "private" } as ImportRecord);
    });
    bridgeAvailable = true;
    const retried = await request(app).post(`/api/v1/generation-plans/${oldPlan.id}:retry-failed`)
      .set("Idempotency-Key", "partial-snapshot-retry").expect(202);
    expect(retried.body.plan.id).toBe(oldPlan.id);
    expect(retried.body.plan.retryOfPlanId).toBeUndefined();
    expect(retried.body.jobs).toHaveLength(1);
    expect(retried.body.jobs[0].id).toBe(originalFailedJob.id);
    expect(retried.body.jobs[0].harnessSnapshotId).toBe(currentGenerationHarness().aggregateSha256);
    const completed = await waitForPlan(app, oldPlan.id);
    expect(completed).toMatchObject({ state: "completed", completedPageIds: [completedPageId, bridgePageId], failedPageIds: [] });
    expect(coreCalls).toBe(2);
    expect(bridgeCalls).toBe(3);
    const bridgedDraft = await readweave.getDraftByPage(bridgePageId);
    expect(bridgedDraft?.page.blocks).toEqual(coreDraft?.page.blocks);
    expect(bridgedDraft?.page.questionBank).toEqual(coreDraft?.page.questionBank);
    expect(bridgedDraft?.page.lessonSections?.some(section => section.kind === "chapter_bridge" && section.markdown?.trim())).toBe(true);
    const snapshot = await operations.read();
    expect(snapshot.generationPlans).toHaveLength(1);
    expect(snapshot.generationPlans.find(item => item.id === oldPlan.id)).toMatchObject({
      state: "completed", completedPageIds: [completedPageId, bridgePageId], failedPageIds: [],
      harnessSnapshotId: currentGenerationHarness().aggregateSha256,
      coreCompletedPageIds: [completedPageId, bridgePageId]
    });
    expect(snapshot.events.some(item => item.streamId === originalFailedJob.id && item.type === "generation.page.core_saved"
      && (item.payload as { pageId?: string }).pageId === bridgePageId)).toBe(true);
    expect(snapshot.jobs.find(item => item.id === originalCompletedJob.id)?.harnessSnapshotId).toBe(completedJobHarness);
    const retryEvent = snapshot.events.find(item => item.streamId === oldPlan.id && item.type === "plan.retry.queued");
    expect(retryEvent?.payload).toMatchObject({
      previousHarnessSnapshotId: obsoleteHarness,
      harnessSnapshotId: currentGenerationHarness().aggregateSha256
    });
    expect(snapshot.imports.find(item => item.id === "import-continuation-test")).toMatchObject({
      generationState: "completed", generationPlanId: oldPlan.id,
      generationCompletedPageIds: [completedPageId, bridgePageId], generationFailedPageIds: []
    });
    const detail = await request(app).get("/api/v1/imports/import-continuation-test").expect(200);
    expect(detail.body).toMatchObject({ generationState: "completed", generationCompletedPageIds: [completedPageId, bridgePageId], generationFailedPageIds: [] });
    const listing = await request(app).get("/api/v1/imports").expect(200);
    expect(listing.body.find((item: ImportRecord) => item.id === "import-continuation-test"))
      .toMatchObject({ materialVersionId: release.id, generationState: "completed", generationCompletedPageIds: [completedPageId, bridgePageId], generationFailedPageIds: [] });
    const costs = await request(app).get(`/api/v1/costs?jobId=${originalFailedJob.id}`).expect(200);
    expect(costs.body.entries.filter((entry: { stage: string; status: string; id: string }) =>
      entry.stage === "teach" && entry.status === "succeeded" && !entry.id.endsWith(":bridge"))).toHaveLength(1);
    expect(costs.body.entries.filter((entry: { id: string }) => entry.id.endsWith(":bridge"))).toHaveLength(2);
    const replay = await request(app).post(`/api/v1/generation-plans/${oldPlan.id}:retry-failed`)
      .set("Idempotency-Key", "partial-snapshot-retry").expect(200);
    expect(replay.body.plan.id).toBe(oldPlan.id);
  }, 60_000);

  it("deduplicates the same uploaded source even when the idempotency key changes", async () => {
    const app = await testApp();
    const source = Buffer.from("# Same source\nThe source must be stored once");
    const first = await request(app).post("/api/v1/imports").set("Idempotency-Key", "import-source-1").field("autoGenerate", "false").attach("file", source, { filename: "same.md", contentType: "text/markdown" }).expect(201);
    await waitForImport(app, first.body.id);
    const second = await request(app).post("/api/v1/imports").set("Idempotency-Key", "import-source-2").field("autoGenerate", "false").attach("file", source, { filename: "same.md", contentType: "text/markdown" }).expect(200);
    expect(second.body.id).toBe(first.body.id);
  }, 45_000);

  it("starts generation when a deduplicated ready source has no previous plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-api-deduplicated-generation-"));
    const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
    const dependencies = createDefaultDependencies(root, readweave);
    const app = createApp(dependencies);
    const source = Buffer.from("# Existing source\nGenerate its teaching page after conversion");
    const first = await request(app).post("/api/v1/imports").set("Idempotency-Key", "deduplicated-no-generation")
      .field("autoGenerate", "false").attach("file", source, { filename: "existing.md", contentType: "text/markdown" }).expect(201);
    await waitForImport(app, first.body.id);
    const second = await request(app).post("/api/v1/imports").set("Idempotency-Key", "deduplicated-start-generation")
      .field("autoGenerate", "true").attach("file", source, { filename: "existing.md", contentType: "text/markdown" }).expect(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.generationPlanId).toBeTruthy();
    const terminal = await waitForPlan(app, second.body.generationPlanId);
    if (!terminal || !["failed", "cancelled"].includes(terminal.state)) {
      await dependencies.operations.mutate((state) => {
        const plan = state.generationPlans.find((item) => item.id === second.body.generationPlanId);
        if (plan) { plan.state = "cancelled"; plan.activeJobIds = []; }
        for (const job of state.jobs.filter((item) => item.planId === second.body.generationPlanId)) {
          job.state = "cancelled";
          job.cancelRequested = true;
        }
      });
    }
    const third = await request(app).post("/api/v1/imports").set("Idempotency-Key", "deduplicated-restart-generation")
      .field("autoGenerate", "true").attach("file", source, { filename: "existing.md", contentType: "text/markdown" }).expect(200);
    expect(third.body.generationPlanId).not.toBe(second.body.generationPlanId);
    const snapshot = await dependencies.operations.read();
    expect(snapshot.imports).toHaveLength(1);
    expect(snapshot.generationPlans).toHaveLength(2);
    expect(snapshot.jobs).toHaveLength(2);
  }, 45_000);

  it("rejects a generation plan when its release uses a different writing policy snapshot", async () => {
    const { app, release } = await seededApp();
    await request(app).post("/api/v1/generation-plans").set("Idempotency-Key", "policy-mismatch-plan").send({ materialVersionId: release.id, pageIds: release.pageIds, budgetUsd: 2 }).expect(409).expect((response) => {
      expect(response.body.error).toMatchObject({ code: "WRITING_POLICY_SNAPSHOT_CHANGED" });
    });
  });

  it("dismisses an exact rejected import while retaining its request and evidence", async () => {
    const { app, operations } = await seededApp();
    const rejected = await request(app)
      .post("/api/v1/imports")
      .set("Idempotency-Key", "rejected-import")
      .attach("file", Buffer.from("not a pdf"), { filename: "broken.pdf", contentType: "application/pdf" })
      .expect(422);
    const originalState = await operations.read();
    const fileMutation = operations.mutate.bind(operations);
    const scopedMutation = vi.spyOn(operations,"mutateGenerationTasks").mockImplementation(change => fileMutation(change));
    const fullMutation = vi.spyOn(operations,"mutate").mockRejectedValue(new Error("DIRECT_FULL_MUTATION_FORBIDDEN"));
    await request(app).delete(`/api/v1/imports/${rejected.body.id}`).set("Idempotency-Key", "dismiss-rejected").expect(204);
    await request(app).get(`/api/v1/imports/${rejected.body.id}`).expect(200);
    expect((await request(app).get("/api/v1/imports")).body).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: rejected.body.id })]));
    await request(app).delete(`/api/v1/imports/${rejected.body.id}`).set("Idempotency-Key", "dismiss-rejected").expect(204);
    expect(scopedMutation).toHaveBeenCalledTimes(1);
    expect(fullMutation).not.toHaveBeenCalled();
    const retained = await operations.read();
    expect({ ...retained, idempotency: originalState.idempotency }).toEqual(originalState);
    expect(retained.idempotency["rejected-import"]).toEqual(originalState.idempotency["rejected-import"]);
  });

  it("rejects a job over the hard budget", async () => {
    await request(await testApp()).post("/api/v1/generation-jobs").set("Idempotency-Key", "job-1").send({ materialVersionId: "m1", pageIds: [], budgetUsd: 8.01 }).expect(422);
  });

  it("rejects generation jobs without a real material page", async () => {
    const { app, release } = await seededApp();
    await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "job-no-pages").send({ materialVersionId: release.id, pageIds: [], budgetUsd: 4 }).expect(422);
    await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "job-wrong-page").send({ materialVersionId: release.id, pageIds: ["missing-page"], budgetUsd: 4 }).expect(422);
  });

  it("resumes a learning session without creating a duplicate and preserves its view", async () => {
    const { app, operations, release } = await seededApp();
    const created = await request(app).post("/api/v1/sessions")
      .send({ courseReleaseId: release.id }).expect(201);
    const id = created.body.id as string;
    await request(app).patch(`/api/v1/sessions/${id}`)
      .send({ currentPageId: release.pageIds[0], zoom: 1.5, panX: 24 }).expect(200);
    const sessionLookup = vi.spyOn(operations, "findLearningSession");
    const resumed = await request(app).post("/api/v1/sessions")
      .send({ courseReleaseId: release.id, sessionId: id }).expect(200);
    expect(resumed.body).toMatchObject({ id, zoom: 1.5, panX: 24 });
    expect(sessionLookup).not.toHaveBeenCalled();
    expect((await operations.read()).sessions.filter(session => session.id === id)).toHaveLength(1);
    await request(app).patch(`/api/v1/sessions/${id}`).set("X-Workspace-Id", "other")
      .send({ zoom: 3 }).expect(404);
  });

  it("loads a question session through the scoped lookup and keeps workspace authorization", async () => {
    const { app, operations, release } = await seededApp();
    const created = await request(app).post("/api/v1/sessions").send({ courseReleaseId: release.id }).expect(201);
    const sessionLookup = vi.spyOn(operations, "findLearningSession").mockResolvedValue(created.body);
    const fullRead = vi.spyOn(operations, "read").mockRejectedValue(new Error("FULL_STATE_READ"));

    await request(app).post(`/api/v1/sessions/${created.body.id}/questions`).set("X-Workspace-Id", "other")
      .set("Idempotency-Key", "qa-other-workspace").send({ pageId: "page-1", question: "test" }).expect(404);
    await request(app).post(`/api/v1/sessions/${created.body.id}/questions`).set("X-Workspace-Id", "personal")
      .set("Idempotency-Key", "qa-scoped-session").send({ pageId: "page-1", question: "test" }).expect(201);

    expect(sessionLookup).toHaveBeenCalledTimes(2);
    expect(fullRead).not.toHaveBeenCalled();
  });

  it("reuses the scoped session while preserving question-selection idempotency", async () => {
    const { app, dependencies, operations, readweave, release } = await seededApp();
    const session = await request(app).post("/api/v1/sessions").send({ courseReleaseId: release.id }).expect(201);
    const sessionLookup = vi.spyOn(operations, "findLearningSession");
    const saveSelection = vi.spyOn(readweave, "saveQuestionSelection");
    const select = (seed: string, key: string) => request(app).post("/api/v1/pages/page-1/questions:select")
      .set("Idempotency-Key", key).send({ sessionId: session.body.id, seed, count: 2 });

    const first = await select("returning-seed", "returning-select-1").expect(201);
    const returned = await select("returning-seed", "returning-select-after-refresh").expect(201);
    expect(returned.body.selection.id).toBe(first.body.selection.id);
    expect(returned.body.questions.map((item: QuestionBankItem) => item.id))
      .toEqual(first.body.questions.map((item: QuestionBankItem) => item.id));
    expect(sessionLookup).not.toHaveBeenCalled();
    expect(saveSelection.mock.calls[0]?.[1].idempotencyKey).toMatch(/^question-selection:/);
    expect(saveSelection).toHaveBeenCalledTimes(1);

    const changed = await select("explicitly-changed-seed", "returning-select-3").expect(201);
    expect(changed.body.selection.id).not.toBe(first.body.selection.id);
    const restartedApp = createApp(dependencies);
    const afterRestart = await request(restartedApp).post("/api/v1/pages/page-1/questions:select")
      .set("Idempotency-Key", "returning-select-after-restart").send({ sessionId: session.body.id, seed: "returning-seed", count: 2 }).expect(201);
    expect(afterRestart.body.selection.id).toBe(first.body.selection.id);
    await request(app).post("/api/v1/pages/page-1/questions:select").set("X-Workspace-Id", "other")
      .set("Idempotency-Key", "returning-select-other").send({ sessionId: session.body.id, seed: "returning-seed", count: 2 }).expect(404);
  });

  it("selects variable-sized stable batches, avoids previously used questions, and permits a genuinely empty bank", async () => {
    const variableRelease = testRelease();
    variableRelease.pages[0]!.questionBank!.push({ ...variableRelease.pages[0]!.questionBank![0]!, id: "q-c-3", prompt: "第三个简答问题" });
    const { app, readweave, release } = await seededApp(undefined, variableRelease);
    const session = await request(app).post("/api/v1/sessions").send({ courseReleaseId: release.id }).expect(201);
    const select = (body: Record<string, unknown>, key: string) => request(app).post("/api/v1/pages/page-1/questions:select")
      .set("Idempotency-Key", key).send({ sessionId: session.body.id, ...body });

    const defaultBatch = await select({ seed: "dynamic-batch" }, "dynamic-default").expect(201);
    expect(defaultBatch.body.selection.count).toBe(3);
    expect(defaultBatch.body.questions).toHaveLength(3);
    expect(defaultBatch.body.questions.map((item: QuestionBankItem) => item.kind)).toEqual(["multiple_choice", "multiple_choice", "comprehension"]);
    expect(defaultBatch.body.selection.questionSnapshots).toEqual(defaultBatch.body.questions);

    const refreshed = await select({ seed: "dynamic-batch" }, "dynamic-refreshed").expect(201);
    expect(refreshed.body.selection.id).toBe(defaultBatch.body.selection.id);
    expect(refreshed.body.questions).toEqual(defaultBatch.body.questions);
    const sameSeedDifferentCount = await select({ seed: "dynamic-batch", count: 2 }, "dynamic-count-changed").expect(201);
    expect(sameSeedDifferentCount.body.selection.id).not.toBe(defaultBatch.body.selection.id);
    expect(sameSeedDifferentCount.body.selection.count).toBe(2);
    expect(sameSeedDifferentCount.body.questions).toHaveLength(2);
    expect(sameSeedDifferentCount.body.questions.some((item: QuestionBankItem) => defaultBatch.body.selection.questionIds.includes(item.id))).toBe(false);

    const nextBatch = await select({ seed: "dynamic-batch-2", count: 5 }, "dynamic-next").expect(201);
    expect(nextBatch.body.selection.count).toBe(5);
    expect(nextBatch.body.questions).toEqual([]);

    const exhausted = await select({ seed: "dynamic-exhausted", count: 3 }, "dynamic-exhausted").expect(201);
    expect(exhausted.body.available).toBe(5);
    expect(exhausted.body.questions).toEqual([]);
    expect(await readweave.listQuestionAttempts()).toHaveLength(0);

    const restartedForPractice = await select({ seed: "dynamic-restart", count: 3, allowRepeat: true }, "dynamic-restart").expect(201);
    expect(restartedForPractice.body.questions).toHaveLength(3);

    const secondSession = await request(app).post("/api/v1/sessions").send({ courseReleaseId: release.id }).expect(201);
    const fiveQuestionBatch = await request(app).post("/api/v1/pages/page-1/questions:select").set("Idempotency-Key", "dynamic-five")
      .send({ sessionId: secondSession.body.id, seed: "dynamic-five", count: 5 }).expect(201);
    expect(fiveQuestionBatch.body.questions).toHaveLength(5);

    await select({ seed: "invalid-count", count: 1 }, "dynamic-invalid").expect(422);

    const emptyRelease = testRelease();
    emptyRelease.id = "empty-question-bank-release";
    emptyRelease.pages[0]!.questionBank = [];
    const empty = await seededApp(undefined, emptyRelease);
    const emptySession = await request(empty.app).post("/api/v1/sessions").send({ courseReleaseId: empty.release.id }).expect(201);
    const noQuestions = await request(empty.app).post("/api/v1/pages/page-1/questions:select").set("Idempotency-Key", "empty-bank-select")
      .send({ sessionId: emptySession.body.id, seed: "empty-bank" }).expect(201);
    expect(noQuestions.body).toMatchObject({ available: 0, questions: [], selection: { count: 3, questionIds: [], questionSnapshots: [] } });
  });

  it("does not mark a paraphrased free-text answer wrong or change mastery", async () => {
    const { app, readweave, release } = await seededApp();
    const session = await request(app).post("/api/v1/sessions").send({ courseReleaseId: release.id }).expect(201);
    const selected = await request(app).post("/api/v1/pages/page-1/questions:select").set("Idempotency-Key", "free-text-select").send({ sessionId: session.body.id, seed: "free-text-seed", count: 2 }).expect(201);
    const question = selected.body.questions.find((item: QuestionBankItem) => item.kind === "comprehension") as QuestionBankItem;
    const payload = { selectionId: selected.body.selection.id, sessionId: session.body.id, courseReleaseId: release.id, pageId: "page-1", questionId: question.id, answer: "先确认起点，按步骤处理，再看结果", usedHintLevel: 0 };
    const saved = await request(app).post("/api/v1/question-attempts").set("Idempotency-Key", "free-text-attempt").send(payload).expect(201);
    expect(saved.body).toMatchObject({ attempt: { correct: null }, mastery: null, evaluationState: "unverified" });
    const restored = await request(app).get(`/api/v1/pages/page-1/question-attempts?sessionId=${session.body.id}&selectionId=${selected.body.selection.id}`).expect(200);
    expect(restored.body).toMatchObject([{ id: saved.body.attempt.id, answer: payload.answer }]);
    await request(app).get(`/api/v1/pages/page-1/question-attempts?sessionId=${session.body.id}&selectionId=${selected.body.selection.id}`).set("X-Workspace-Id", "other").expect(404);
    expect(saved.headers["server-timing"]).toMatch(/release;dur=.+save;dur=/);
    await request(app).post("/api/v1/question-attempts").set("Idempotency-Key", "free-text-attempt").send(payload).expect(201);
    expect(await readweave.listQuestionAttempts()).toHaveLength(1);
    expect(await readweave.listAssessmentAttempts()).toHaveLength(0);
    expect(await readweave.listMastery()).toHaveLength(0);
  });

  it("accepts equivalent numeric answers while keeping choice grading exact", () => {
    const comprehension = { ...testRelease().pages[0]!.questionBank![0]!, expectedAnswer: "0.1225" };
    expect(evaluateQuestionAnswer(comprehension, "0.1225000")).toBe(true);
    expect(evaluateQuestionAnswer(comprehension, "0.35")).toBe(false);
    expect(evaluateQuestionAnswer(comprehension, "差值平方后是 0.1225")).toBe(null);
    const choice = testRelease().pages[0]!.questionBank![2]!;
    expect(evaluateQuestionAnswer(choice, "忽略条件")).toBe(false);
  });

  it("stores QA changes and generation costs with the simplified teaching stage", async () => {
    const { app, operations, readweave, release } = await seededApp({ generateTeachingPackage: async () => testTeachingResult(0) });
    const session = await request(app).post("/api/v1/sessions").send({ courseReleaseId: release.id }).expect(201);
    const asked = await request(app).post(`/api/v1/sessions/${session.body.id}/questions`).set("Idempotency-Key", "qa-create").send({ pageId: "page-1", learnerAttempt: "先比较输入", question: "为什么要检查前提", hintLevel: 1, anchorIds: [] }).expect(201);
    expect(asked.body).toMatchObject({ reviewPolicy: "include", status: "active", revision: 1 });
    const excluded = await request(app).patch(`/api/v1/questions/${asked.body.id}/review-policy`).set("Idempotency-Key", "qa-exclude").send({ baseRevision: 1, reviewPolicy: "exclude" }).expect(200);
    expect(excluded.body).toMatchObject({ reviewPolicy: "exclude", revision: 2 });
    const retracted = await request(app).post(`/api/v1/questions/${asked.body.id}:retract`).set("Idempotency-Key", "qa-retract").send({ baseRevision: 2 }).expect(200);
    expect(retracted.body).toMatchObject({ status: "retracted", revision: 3 });

    const first = await request(app).post("/api/v1/pages/page-1/questions:select").set("Idempotency-Key", "select-1").send({ sessionId: session.body.id, seed: "fixed-seed", count: 2 }).expect(201);
    const second = await request(app).post("/api/v1/pages/page-1/questions:select").set("Idempotency-Key", "select-2").send({ sessionId: session.body.id, seed: "fixed-seed", count: 2 }).expect(201);
    expect(second.body.questions.map((item: { id: string }) => item.id)).toEqual(first.body.questions.map((item: { id: string }) => item.id));
    expect(first.body.questions.map((item: { kind: string }) => item.kind)).toEqual(["multiple_choice", "comprehension"]);
    const question = first.body.questions[0];
    const attemptPayload = { selectionId: first.body.selection.id, sessionId: session.body.id, courseReleaseId: release.id, pageId: "page-1", questionId: question.id, answer: question.expectedAnswer, usedHintLevel: 0 };
    const savedAttempt = await request(app).post("/api/v1/question-attempts").set("Idempotency-Key", "attempt-1").send(attemptPayload).expect(201);
    const replayedAttempt = await request(app).post("/api/v1/question-attempts").set("Idempotency-Key", "attempt-1").send({ ...attemptPayload, answer: "这次请求不应新增记录" }).expect(201);
    expect(replayedAttempt.body).toMatchObject({ attempt: { id: savedAttempt.body.attempt.id, answer: question.expectedAnswer }, mastery: savedAttempt.body.mastery });
    expect(await readweave.listQuestionAttempts()).toHaveLength(1);
    expect(await readweave.listAssessmentAttempts()).toHaveLength(1);

    const createdJob = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "generate-page-1").send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 4 }).expect(202);
    const completed = await waitForJob(app, createdJob.body.id);
    expect(completed).toMatchObject({ state: "completed", completedPageIds: ["page-1"], spentUsd: 0 });
    const costs = await request(app).get(`/api/v1/costs?jobId=${createdJob.body.id}`).expect(200);
    expect(costs.body.entries).toHaveLength(1);
    expect(costs.body.rollups.find((item: { scope: string }) => item.scope === "job").actualMicrousd).toBe(0);
    const events = (await operations.read()).events.filter((event) => event.streamId === createdJob.body.id);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "generation.stage.started",
      "generation.stage.completed",
      "generation.page.completed",
      "job.completed"
    ]));
    expect(events.some((event) => event.type === "generation.stage.completed" && (event.payload as { stage?: string }).stage === "teach")).toBe(true);
    expect(events.some((event) => event.type === "generation.stage.completed" && (event.payload as { stage?: string }).stage === "atomize")).toBe(false);
  }, 15_000);

  it("records the persisted ReadWeave draft hash in the completed-page event", async () => {
    const { app, operations, readweave, release } = await seededApp({ generateTeachingPackage: async () => testTeachingResult(0) });
    const originalSave = readweave.saveDraft.bind(readweave);
    vi.spyOn(readweave, "saveDraft").mockImplementation((draft, revision, context, asset) =>
      originalSave({ ...draft, contentHash: `remote:${draft.contentHash}` }, revision, context, asset));
    const originalSaveWithCost = readweave.saveDraftWithCost.bind(readweave);
    vi.spyOn(readweave, "saveDraftWithCost").mockImplementation((draft, revision, context, cost) =>
      originalSaveWithCost({ ...draft, contentHash: `remote:${draft.contentHash}` }, revision, context, cost));
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "persisted-hash-job").send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 4 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed" });
    const saved = await readweave.getDraftByPage("page-1");
    const event = (await operations.read()).events.find((item) => item.streamId === created.body.id && item.type === "generation.page.completed");
    expect(saved?.contentHash).toMatch(/^remote:/);
    expect(saved?.generationJobId).toBe(created.body.id);
    expect(event?.payload).toMatchObject({ contentHash: saved?.contentHash, draftRevision: saved?.revision });
  }, 15_000);

  it("falls back to core_saved when ReadWeave drops generationJobId", async () => {
    const previousExternalWorker = process.env.COURSE_OS_EXTERNAL_WORKER;
    process.env.COURSE_OS_EXTERNAL_WORKER = "true";
    try {
      const modelRouter: ModelRouterClient = { generateTeachingPackage: vi.fn(async () => testTeachingResult(0.025)) };
      const { app, dependencies, operations, readweave, release } = await seededApp(modelRouter);
      const originalSave = readweave.saveDraftWithCost.bind(readweave);
      vi.spyOn(readweave, "saveDraftWithCost").mockImplementation((draft, revision, context, cost, asset) =>
        originalSave({ ...draft, generationJobId: undefined }, revision, context, cost, asset));
      const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "recover-core-saved-page")
        .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 4 }).expect(202);
      const initialGeneration = await modelRouter.generateTeachingPackage({
        pageTitle: release.pages[0]!.title, pageNumber: 1, sourceText: "模拟中断前已完成的教学包生成",
        writingPolicySnapshotId: release.writingPolicySnapshotId, language: "zh-CN", qualityMode: "balanced",
        idempotencyKey: "pre-crash-model-call", stage: "teach", maxCostUsd: 4
      });
      const generatedPage = applyTeachingPackage(release.pages[0]!, initialGeneration.content, true, "text_only");
      const savedCost = testGenerationCost(created.body.id, release, "page-1");
      const persisted = await readweave.saveDraftWithCost({
        id: "draft:page-1", workspaceId: "personal", courseId: release.courseId, moduleId: release.moduleId,
        sourceReleaseId: release.id, pageId: "page-1", revision: 0, status: "ready", page: generatedPage,
        changedBlockIds: generatedPage.blocks.map(block => block.id), contentHash: "crash-window-draft-hash",
        updatedAt: new Date().toISOString()
      }, 0, { idempotencyKey: "crash-window-draft", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "crash-window-draft" }, savedCost);
      expect(persisted.generationJobId).toBeUndefined();
      await operations.mutateGenerationJob(created.body.id, (job, context) => {
        job.state = "running";
        job.attempt = 1;
        context.appendEvent("generation.page.core_saved", {
          pageId: "page-1", draftRevision: persisted.revision, contentHash: persisted.contentHash,
          costEntryIds: [savedCost.id], publishable: persisted.page.quality.publishable, bridgeCompleted: false
        });
      });

      delete process.env.COURSE_OS_EXTERNAL_WORKER;
      await resumeIncompleteJobs(dependencies);
      const recovered = await waitForJob(app, created.body.id);

      expect(recovered).toMatchObject({ state: "completed", completedPageIds: ["page-1"], failedPageIds: [], spentUsd: 0.025 });
      expect.soft(modelRouter.generateTeachingPackage).toHaveBeenCalledTimes(1);
      expect.soft(await readweave.getDraftByPage("page-1")).toEqual(persisted);
      const recordedCosts = await readweave.listCostEntries({ jobId: created.body.id });
      expect(recordedCosts).toEqual([savedCost]);
      expect((await operations.read()).events.filter((item) => item.streamId === created.body.id && item.type === "generation.cost.recorded")).toHaveLength(1);

      const otherJob = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "new-job-regenerates-old-draft")
        .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 4 }).expect(202);
      await waitForJob(app, otherJob.body.id);
      expect(modelRouter.generateTeachingPackage).toHaveBeenCalledTimes(2);
      expect((await readweave.getDraftByPage("page-1"))?.revision).toBe(persisted.revision + 1);
    } finally {
      if (previousExternalWorker === undefined) delete process.env.COURSE_OS_EXTERNAL_WORKER;
      else process.env.COURSE_OS_EXTERNAL_WORKER = previousExternalWorker;
    }
  }, 15_000);

  it("cannot reconcile a model charge when interruption precedes the first durable page receipt", async () => {
    const previousExternalWorker = process.env.COURSE_OS_EXTERNAL_WORKER;
    process.env.COURSE_OS_EXTERNAL_WORKER = "true";
    try {
      const modelRouter: ModelRouterClient = { generateTeachingPackage: vi.fn(async () => testTeachingResult(0.025)) };
      const { app, dependencies, operations, readweave, release } = await seededApp(modelRouter);
      const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "lost-pre-persistence-receipt")
        .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 4 }).expect(202);
      // This mock response represents a provider call that may already be billed; the crash leaves no draft, cost, or core_saved event.
      await modelRouter.generateTeachingPackage({
        pageTitle: release.pages[0]!.title, pageNumber: 1, sourceText: "模型已响应，但尚无持久化回执",
        writingPolicySnapshotId: release.writingPolicySnapshotId, language: "zh-CN", qualityMode: "balanced",
        idempotencyKey: "unpersisted-model-response", stage: "teach", maxCostUsd: 4
      });
      await operations.mutateGenerationJob(created.body.id, (job) => {
        job.state = "running";
        job.attempt = 1;
      });

      delete process.env.COURSE_OS_EXTERNAL_WORKER;
      await resumeIncompleteJobs(dependencies);
      const recovered = await waitForJob(app, created.body.id);

      expect(recovered).toMatchObject({ state: "completed", spentUsd: 0.025 });
      expect(modelRouter.generateTeachingPackage).toHaveBeenCalledTimes(2);
      expect(await readweave.listCostEntries({ jobId: created.body.id })).toHaveLength(1);
      expect((await operations.read()).events.filter((item) => item.streamId === created.body.id && item.type === "generation.cost.recorded")).toHaveLength(1);
    } finally {
      if (previousExternalWorker === undefined) delete process.env.COURSE_OS_EXTERNAL_WORKER;
      else process.env.COURSE_OS_EXTERNAL_WORKER = previousExternalWorker;
    }
  }, 15_000);

  it("recovers a bridge draft before its matching core_saved receipt by job metadata", async () => {
    const previousExternalWorker = process.env.COURSE_OS_EXTERNAL_WORKER;
    process.env.COURSE_OS_EXTERNAL_WORKER = "true";
    try {
      const modelRouter: ModelRouterClient = { generateTeachingPackage: vi.fn(async () => testTeachingResult(0.025)) };
      const { app, dependencies, operations, readweave, release } = await seededApp(modelRouter);
      const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "bridge-draft-before-receipt")
        .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 4 }).expect(202);
      const generation = await modelRouter.generateTeachingPackage({
        pageTitle: release.pages[0]!.title, pageNumber: 1, sourceText: "模拟桥接草稿写入前的教学包响应",
        writingPolicySnapshotId: release.writingPolicySnapshotId, language: "zh-CN", qualityMode: "balanced",
        idempotencyKey: "bridge-window-model-response", stage: "teach", maxCostUsd: 4
      });
      const coreCost = testGenerationCost(created.body.id, release, "page-1");
      const corePage = applyTeachingPackage(release.pages[0]!, generation.content, true, "text_only");
      const coreDraft = await readweave.saveDraftWithCost({
        id: "draft:page-1", generationJobId: created.body.id, workspaceId: "personal", courseId: release.courseId, moduleId: release.moduleId,
        sourceReleaseId: release.id, pageId: "page-1", revision: 0, status: "ready", page: corePage,
        changedBlockIds: corePage.blocks.map(block => block.id), contentHash: "bridge-window-core-hash",
        updatedAt: new Date().toISOString()
      }, 0, { idempotencyKey: "bridge-window-core", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "bridge-window-core" }, coreCost);
      const bridgedPage = applyTeachingPackage(release.pages[0]!, {
        ...generation.content, chapterBridgeMarkdown: "本页承接上一页已经确认的结论"
      }, true, "text_only");
      const bridgeCost = { ...testGenerationCost(created.body.id, release, "page-1"), id: `${coreCost.id}:bridge` };
      const bridgeDraft = await readweave.saveDraftWithCost({
        ...coreDraft, page: bridgedPage, revision: coreDraft.revision, contentHash: "bridge-window-saved-hash",
        updatedAt: new Date().toISOString()
      }, coreDraft.revision, { idempotencyKey: "bridge-window-write", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "bridge-window-write" }, bridgeCost);
      await operations.mutateGenerationJob(created.body.id, (job, context) => {
        job.state = "running";
        job.attempt = 1;
        context.appendEvent("generation.page.core_saved", {
          pageId: "page-1", draftRevision: coreDraft.revision, contentHash: coreDraft.contentHash,
          costEntryIds: [coreCost.id], publishable: coreDraft.page.quality.publishable, bridgeCompleted: false
        });
      });

      // The only core_saved receipt points to the prior draft revision; the durable job field identifies this bridge revision.
      delete process.env.COURSE_OS_EXTERNAL_WORKER;
      await resumeIncompleteJobs(dependencies);
      const recovered = await waitForJob(app, created.body.id);

      expect(recovered).toMatchObject({ state: "completed", completedPageIds: ["page-1"], spentUsd: 0.05 });
      expect(modelRouter.generateTeachingPackage).toHaveBeenCalledTimes(1);
      expect(await readweave.getDraftByPage("page-1")).toEqual(bridgeDraft);
      expect((await operations.read()).events.filter((item) => item.streamId === created.body.id && item.type === "generation.cost.recorded")).toHaveLength(2);
    } finally {
      if (previousExternalWorker === undefined) delete process.env.COURSE_OS_EXTERNAL_WORKER;
      else process.env.COURSE_OS_EXTERNAL_WORKER = previousExternalWorker;
    }
  }, 15_000);

  it("accounts for an authority-saved main repair after restart without repeating model calls or cost", async () => {
    const previousExternalWorker = process.env.COURSE_OS_EXTERNAL_WORKER;
    process.env.COURSE_OS_EXTERNAL_WORKER = "true";
    try {
      const modelRouter: ModelRouterClient = {
        generateTeachingPackage: vi.fn(async () => testTeachingResult(0.001))
      };
      const { app, dependencies, operations, readweave, release } = await seededApp(modelRouter);
      const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "repair-cost-restart-gap")
        .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 4 }).expect(202);

      const partialResult = testTeachingResult(0.025);
      partialResult.content.mainContentMarkdown = "";
      const partialPage = applyTeachingPackage(release.pages[0]!, partialResult.content, true, "text_only");
      const teachCost = testGenerationCost(created.body.id, release, "page-1");
      const writeContext = (idempotencyKey: string): IdempotentWriteContext => ({ idempotencyKey, actor: "test", workspaceId: "personal",
        schemaVersion: "2.4.0", requestId: idempotencyKey });
      const partialDraft = await readweave.saveDraftWithCost({
        id: "draft:page-1", generationJobId: created.body.id, workspaceId: "personal", courseId: release.courseId,
        moduleId: release.moduleId, sourceReleaseId: release.id, pageId: "page-1", revision: 0, status: "needs_review",
        page: partialPage, changedBlockIds: partialPage.blocks.map(block => block.id), contentHash: "pre-repair-core",
        updatedAt: new Date().toISOString()
      }, 0, writeContext("pre-repair-core-save"), teachCost);

      const repairedPage = structuredClone(partialPage);
      repairedPage.lessonSections = (repairedPage.lessonSections ?? []).map(section => section.kind === "main_content"
        ? { ...section, markdown: "- BP 主结论已由格式修复补齐。" } : section);
      repairedPage.blocks = repairedPage.blocks.map(block => block.kind === "core"
        ? { ...block, markdown: "- BP 主结论已由格式修复补齐。" } : block);
      const repairCost: GenerationCostEntry = {
        ...testGenerationCost(created.body.id, release, "page-1"),
        id: `${teachCost.id}:main-content-format-repair`, stage: "repair", actualMicrousd: 5_000,
        estimatedMicrousd: 5_000, cashCostMicrousd: 5_000, estimatedCashCostMicrousd: 5_000
      };
      const repairedDraft = await readweave.saveDraftWithCost({
        ...partialDraft, page: repairedPage, status: "ready", contentHash: "authority-saved-main-repair",
        updatedAt: new Date().toISOString()
      }, partialDraft.revision, writeContext("authority-saved-main-repair"), repairCost);

      await operations.mutateGenerationJob(created.body.id, (job, context) => {
        job.state = "running";
        job.attempt = 2;
        job.spentUsd = 0.025;
        context.appendEvent("generation.cost.recorded", { costEntryId: teachCost.id, status: "succeeded",
          actualMicrousd: teachCost.actualMicrousd, spentUsd: job.spentUsd });
        context.appendEvent("generation.page.core_saved", { pageId: "page-1", draftRevision: partialDraft.revision,
          contentHash: partialDraft.contentHash, costEntryIds: [teachCost.id], publishable: false, bridgeCompleted: false });
      });

      delete process.env.COURSE_OS_EXTERNAL_WORKER;
      await resumeIncompleteJobs(dependencies);

      expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", completedPageIds: ["page-1"],
        failedPageIds: [], spentUsd: 0.03 });
      expect(modelRouter.generateTeachingPackage).not.toHaveBeenCalled();
      expect(await readweave.getDraftByPage("page-1")).toEqual(repairedDraft);
      expect(await readweave.listCostEntries({ jobId: created.body.id, pageId: "page-1" }))
        .toEqual(expect.arrayContaining([teachCost, repairCost]));
      const events = (await operations.read()).events.filter(event => event.streamId === created.body.id);
      expect(events.filter(event => event.type === "generation.cost.recorded"
        && (event.payload as { costEntryId?: string }).costEntryId === teachCost.id)).toHaveLength(1);
      expect(events.filter(event => event.type === "generation.cost.recorded"
        && (event.payload as { costEntryId?: string }).costEntryId === repairCost.id)).toHaveLength(1);
    } finally {
      if (previousExternalWorker === undefined) delete process.env.COURSE_OS_EXTERNAL_WORKER;
      else process.env.COURSE_OS_EXTERNAL_WORKER = previousExternalWorker;
    }
  }, 15_000);

  it("recovers a saved model response after exhausted storage retries without regenerating completed pages", async () => {
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: vi.fn(async () => testTeachingResult(0))
    };
    const { app, dependencies, readweave, release } = await seededApp(modelRouter, testReleaseWithPages(2));
    const originalSave = readweave.saveDraftWithCost.bind(readweave);
    let saveFailures = 6;
    vi.spyOn(readweave, "saveDraftWithCost").mockImplementation((draft, revision, context, cost, asset) => {
      if (draft.pageId === "page-2" && saveFailures > 0) {
        saveFailures -= 1;
        return Promise.reject(new Error("READWEAVE_ETAPI_503:temporary"));
      }
      return originalSave(draft, revision, context, cost, asset);
    });
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "retry-only-unsaved-page")
      .send({ materialVersionId: release.id, pageIds: release.pageIds, budgetUsd: 4 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({
      state: "completed", completedPageIds: ["page-1"], failedPageIds: ["page-2"]
    });
    expect(saveFailures).toBe(0);
    // A restart replaces the prior writer after its terminal cleanup finishes.
    await executeGenerationJob(created.body.id, dependencies);
    const completedDraft = await readweave.getDraftByPage("page-1");

    expect((await dependencies.operations.read()).generationCheckpoints[`${created.body.id}:page-2`])
      .toMatchObject({ kind: "page-generation-recovery-v1", teaching: { content: testTeachingResult(0).content } });
    vi.mocked(modelRouter.generateTeachingPackage).mockImplementation(async () => { throw new Error("MUST_REUSE_PAID_RESPONSE"); });
    const restarted = createApp(createDefaultDependencies(dependencies.dataDir, readweave, modelRouter));
    await request(restarted).post(`/api/v1/generation-jobs/${created.body.id}:retry`).set("Idempotency-Key", "retry-only-page-2").expect(202);
    expect(await waitForJob(restarted, created.body.id)).toMatchObject({ state: "completed", completedPageIds: ["page-2"], failedPageIds: [] });

    expect(modelRouter.generateTeachingPackage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(modelRouter.generateTeachingPackage).mock.calls.map(([input]) => input.pageNumber)).toEqual([1, 2]);
    expect(await readweave.getDraftByPage("page-1")).toEqual(completedDraft);
  }, 15_000);

  it("automatically retries transient lesson persistence while reusing the completed model response", async () => {
    const modelRouter: ModelRouterClient = { generateTeachingPackage: vi.fn(async () => testTeachingResult(0)) };
    const { app, dependencies, readweave, release } = await seededApp(modelRouter);
    const save = readweave.saveDraftWithCost.bind(readweave);
    let failures = 2;
    vi.spyOn(readweave, "saveDraftWithCost").mockImplementation((...args) => {
      if (failures-- > 0) return Promise.reject(new Error("READWEAVE_ETAPI_503:temporary"));
      return save(...args);
    });
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "recover-transient-store")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 4 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ completedPageIds: ["page-1"], failedPageIds: [] });
    expect(modelRouter.generateTeachingPackage).toHaveBeenCalledTimes(1);
    const state = await dependencies.operations.read();
    expect(state.events.filter(event => event.streamId === created.body.id && event.type === "generation.page.storage_retry")).toHaveLength(1);
    expect(await readweave.getDraftByPage("page-1")).toBeDefined();
  }, 15_000);

  it("starts teaching while the visual cost write is still pending", async () => {
    const modelRouter: ModelRouterClient = {
      understandPage: vi.fn(async () => ({ sourceDescription: "A diagram shows source data", teachingPlan: "Explain the diagram", provider: "synthetic", model: "vision", usage: testTeachingResult(0.001).usage })),
      generateTeachingPackage: vi.fn(async () => testTeachingResult(0.001))
    };
    const source = testRelease();
    const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><text>source</text></svg>');
    source.pages[0]!.imageUrl = `/api/v1/media/${sha256Text(image.toString())}`;
    const { app, dependencies, readweave, release } = await seededApp(modelRouter, source);
    await dependencies.cas.put(image);
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const append = readweave.appendCostEntry.bind(readweave);
    vi.spyOn(readweave, "appendCostEntry").mockImplementation(async (cost, context) => {
      if (cost.stage === "extract") await gate;
      return append(cost, context);
    });
    try {
      const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "parallel-vision-cost")
        .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 4 }).expect(202);
      await vi.waitFor(() => expect(modelRouter.generateTeachingPackage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      expect(await readweave.getDraftByPage("page-1")).toBeUndefined();
      unblock();
      expect(await waitForJob(app, created.body.id)).toMatchObject({ completedPageIds: ["page-1"], failedPageIds: [] });
      expect(await readweave.listCostEntries({ jobId: created.body.id })).toHaveLength(2);
      expect(modelRouter.generateTeachingPackage).toHaveBeenCalledTimes(1);
    } finally { unblock(); }
  }, 20_000);

  it("retains a completed visual observation while transient cost persistence recovers", async () => {
    const usage = testTeachingResult(0.001).usage;
    const modelRouter: ModelRouterClient = {
      understandPage: vi.fn(async () => ({ sourceDescription: "The image shows a simple source page", teachingPlan: "Explain the source", provider: "synthetic", model: "vision", usage })),
      generateTeachingPackage: vi.fn(async () => testTeachingResult(0.001))
    };
    const source = testRelease();
    const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><text>source</text></svg>');
    source.pages[0]!.imageUrl = `/api/v1/media/${sha256Text(image.toString())}`;
    const { app, dependencies, readweave, release } = await seededApp(modelRouter, source);
    await dependencies.cas.put(image);
    const append = readweave.appendCostEntry.bind(readweave);
    let failed = false;
    vi.spyOn(readweave, "appendCostEntry").mockImplementation((cost, context) => {
      if (cost.stage === "extract" && !failed) { failed = true; return Promise.reject(new Error("READWEAVE_ETAPI_503:temporary")); }
      return append(cost, context);
    });
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "recover-visual-cost")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 4 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ completedPageIds: ["page-1"], failedPageIds: [] });
    expect(modelRouter.understandPage).toHaveBeenCalledTimes(1);
    expect(modelRouter.generateTeachingPackage).toHaveBeenCalledTimes(1);
    const costs = await readweave.listCostEntries({ jobId: created.body.id });
    expect(costs).toHaveLength(2);
    expect(costs.filter(cost => cost.stage === "extract")).toHaveLength(1);
  }, 15_000);

  it("adds refill questions as drafts and keeps the refill idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-api-refill-"));
    const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
    const release = testRelease();
    release.id = "refill-release-v1";
    release.pages[0]!.questionBank = release.pages[0]!.questionBank!.slice(0, 2);
    release.pageIds = [release.pages[0]!.id];
    const refillContext: IdempotentWriteContext = {
      idempotencyKey: "refill-release",
      actor: "test",
      workspaceId: "personal",
      requestId: "refill-release",
      schemaVersion: "2.1.0"
    };
    await readweave.publishRelease(release, { ...testManifest(release.id), courseReleaseId: release.id }, {
      ...refillContext,
      idempotencyKey: "refill-release",
    });
    const app = createApp(createDefaultDependencies(root, readweave));
    const session = await request(app).post("/api/v1/sessions").send({ courseReleaseId: release.id }).expect(201);
    const first = await request(app).post(`/api/v1/pages/page-1/questions:refill`).set("Idempotency-Key", "refill-1").send({ baseRevision: 0 }).expect(201);
    expect(first.body).toMatchObject({ pageId: "page-1", available: 2, draftCount: 2, revision: 1 });
    expect(first.body.added).toHaveLength(2);
    expect(first.body.added.every((item: QuestionBankItem) => item.status === "draft")).toBe(true);
    const second = await request(app).post(`/api/v1/pages/page-1/questions:refill`).set("Idempotency-Key", "refill-2").send({ baseRevision: 1 }).expect(200);
    expect(second.body).toMatchObject({ added: [], available: 2, draftCount: 2, revision: 1 });
    expect(session.body.courseReleaseId).toBe(release.id);
  });

  it("selects and grades current ready candidate snapshots without live reconciliation, with idempotent replay", async () => {
    const { app, dependencies, readweave } = await seededApp();
    const candidate = testRelease();
    candidate.id = "candidate-questions-v2";
    candidate.lifecycle = "draft_source";
    candidate.pageIds = ["candidate-page-1"];
    candidate.pages = replaceTestIds(candidate.pages, "page-1", "candidate-page-1");
    candidate.pages[0]!.questionBank = [];
    await readweave.registerDraftSource(candidate, {
      idempotencyKey: "candidate-questions-source", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "candidate-questions-source"
    });
    const session = await request(app).post("/api/v1/sessions").send({ courseReleaseId: candidate.id }).expect(201);
    const snapshotRead = vi.fn(readweave.getDraftByPage.bind(readweave));
    (readweave as ReadWeaveCourseApi).getDraftSnapshotByPage = snapshotRead;
    const liveRead = vi.spyOn(readweave, "getDraftByPage").mockRejectedValue(new Error("SLOW_BLOCK_RECONCILIATION"));
    const selectionUrl = "/api/v1/pages/candidate-page-1/questions:select";
    await request(app).post(selectionUrl).set("Idempotency-Key", "candidate-not-ready").send({ sessionId: session.body.id, count: 2 }).expect(409);

    const draftQuestions = testRelease().pages[0]!.questionBank!.map((question) => ({ ...question, id: `candidate-${question.id}`, pageId: "candidate-page-1" }));
    await readweave.saveDraft({
      id: "draft:candidate-page-1", workspaceId: "personal", courseId: candidate.courseId, moduleId: candidate.moduleId,
      sourceReleaseId: candidate.id, pageId: "candidate-page-1", revision: 0, status: "ready",
      page: { ...candidate.pages[0]!, quality: { ...candidate.pages[0]!.quality, publishable: false, issues: ["非阻断质量提示"] }, questionBank: draftQuestions }, changedBlockIds: [], contentHash: "candidate-ready-hash",
      updatedAt: new Date().toISOString()
    }, 0, { idempotencyKey: "candidate-questions-ready", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "candidate-questions-ready" });

    const selected = await request(app).post(selectionUrl).set("Idempotency-Key", "candidate-select")
      .send({ sessionId: session.body.id, seed: "candidate-seed", count: 2 }).expect(201);
    expect(selected.body.available).toBe(4);
    expect(selected.body.questions).toHaveLength(2);
    expect(selected.body.questions.every((question: QuestionBankItem) => question.id.startsWith("candidate-"))).toBe(true);
    const question = selected.body.questions[0] as QuestionBankItem;
    const payload = { selectionId: selected.body.selection.id, sessionId: session.body.id, courseReleaseId: candidate.id,
      pageId: "candidate-page-1", questionId: question.id, answer: question.expectedAnswer, usedHintLevel: 0 };
    const saved = await request(app).post("/api/v1/question-attempts").set("Idempotency-Key", "candidate-attempt").send(payload).expect(201);
    expect(saved.body.attempt).toMatchObject({ correct: true, questionVersion: question.version });
    const replayed = await request(app).post("/api/v1/question-attempts").set("Idempotency-Key", "candidate-attempt").send(payload).expect(201);
    expect(replayed.body.attempt.id).toBe(saved.body.attempt.id);
    expect(await readweave.listQuestionAttempts()).toHaveLength(1);
    expect(await readweave.listAssessmentAttempts()).toHaveLength(1);

    const readyDraft = (await snapshotRead("candidate-page-1"))!;
    const saveSelection = vi.spyOn(readweave, "saveQuestionSelection");
    for (const [field, value] of [
      ["workspaceId", "other-workspace"], ["courseId", "other-course"],
      ["sourceReleaseId", "other-source"], ["status", "needs_review"]
    ] as const) {
      snapshotRead.mockResolvedValueOnce({ ...readyDraft, [field]: value });
      await request(app).post(selectionUrl).set("Idempotency-Key", `candidate-reject-${field}`)
        .send({ sessionId: session.body.id, count: 2 }).expect(409);
      snapshotRead.mockResolvedValueOnce({ ...readyDraft, [field]: value });
      await request(app).post("/api/v1/question-attempts").set("Idempotency-Key", `candidate-attempt-reject-${field}`)
        .send(payload).expect(409);
    }
    expect(saveSelection).not.toHaveBeenCalled();
    expect(await readweave.listQuestionAttempts()).toHaveLength(1);

    const updatedQuestion = { ...draftQuestions[0]!, id: "candidate-updated-question", expectedAnswer: "updated answer" };
    await readweave.saveDraft({ ...readyDraft, page: { ...readyDraft.page, questionBank: [updatedQuestion] } }, readyDraft.revision,
      { idempotencyKey: "candidate-questions-update", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "candidate-questions-update" });
    const restartedWithOldBatch = createApp(dependencies);
    const restoredSelection = await request(restartedWithOldBatch).post(selectionUrl).set("Idempotency-Key", "candidate-select-old-after-restart")
      .send({ sessionId: session.body.id, seed: "candidate-seed", count: 2 }).expect(201);
    expect(restoredSelection.body.selection.id).toBe(selected.body.selection.id);
    expect(restoredSelection.body.questions).toEqual(selected.body.questions);
    const updatedSelection = await request(app).post(selectionUrl).set("Idempotency-Key", "candidate-select-updated")
      .send({ sessionId: session.body.id, seed: "updated-seed", count: 2 }).expect(201);
    expect(updatedSelection.body.available).toBe(1);
    expect(updatedSelection.body.questions).toEqual([updatedQuestion]);
    const updatedAttempt = await request(app).post("/api/v1/question-attempts").set("Idempotency-Key", "candidate-attempt-updated")
      .send({ ...payload, selectionId: updatedSelection.body.selection.id, questionId: updatedQuestion.id, answer: updatedQuestion.expectedAnswer }).expect(201);
    expect(updatedAttempt.body.attempt.correct).toBe(true);
    expect(snapshotRead).toHaveBeenCalledWith("candidate-page-1");
    expect(liveRead).not.toHaveBeenCalled();
  });

  it("lets only one concurrent dispatcher claim and execute a queued page job", async () => {
    const previousExternalWorker = process.env.COURSE_OS_EXTERNAL_WORKER;
    process.env.COURSE_OS_EXTERNAL_WORKER = "true";
    try {
      const modelRouter: ModelRouterClient = { generateTeachingPackage: async () => testTeachingResult(0.005) };
      const { app, dependencies, operations, release } = await seededApp(modelRouter);
      const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "concurrent-dispatch-job")
        .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
      await Promise.all([
        executeGenerationJob(created.body.id, dependencies),
        executeGenerationJob(created.body.id, dependencies)
      ]);
      const state = await operations.read();
      const events = state.events.filter((event) => event.streamId === created.body.id);
      expect(events.filter((event) => event.type === "job.running")).toHaveLength(1);
      expect(events.filter((event) => event.type === "generation.stage.started" && (event.payload as Record<string, unknown>).pageId === "page-1" && (event.payload as Record<string, unknown>).stage === "extract")).toHaveLength(1);
      expect(state.jobs.find((job) => job.id === created.body.id)?.attempt).toBe(1);
    } finally {
      if (previousExternalWorker === undefined) delete process.env.COURSE_OS_EXTERNAL_WORKER;
      else process.env.COURSE_OS_EXTERNAL_WORKER = previousExternalWorker;
    }
  });

  it("limits whole page jobs across independent submissions before they claim a lease", async () => {
    const previousExternalWorker = process.env.COURSE_OS_EXTERNAL_WORKER;
    const previousConcurrency = process.env.COURSE_OS_GENERATION_CONCURRENCY;
    process.env.COURSE_OS_EXTERNAL_WORKER = "true";
    process.env.COURSE_OS_GENERATION_CONCURRENCY = "2";
    let releaseTeaching!: () => void;
    const teachingGate = new Promise<void>((resolve) => { releaseTeaching = resolve; });
    let active = 0;
    let peak = 0;
    let entered = 0;
    try {
      const modelRouter: ModelRouterClient = { generateTeachingPackage: async () => {
        active += 1;
        entered += 1;
        peak = Math.max(peak, active);
        await teachingGate;
        active -= 1;
        return testTeachingResult(0.001);
      } };
      const { app, dependencies, release } = await seededApp(modelRouter, testReleaseWithPages(3));
      const ids: string[] = [];
      for (const pageId of release.pageIds) {
        const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", `whole-page-cap-${pageId}`)
          .send({ materialVersionId: release.id, pageIds: [pageId], budgetUsd: 1 }).expect(202);
        ids.push(created.body.id);
      }
      const executions = ids.map((id) => executeGenerationJob(id, dependencies));
      // File-backed fixtures contend with the full suite on Windows; the cap
      // assertion must measure concurrent entries, not a 1-second disk budget.
      await vi.waitFor(() => expect(entered).toBe(2), { timeout: 5000 });
      expect(peak).toBe(2);
      releaseTeaching();
      await Promise.all(executions);
      expect(entered).toBe(3);
      expect(peak).toBe(2);
    } finally {
      releaseTeaching();
      if (previousExternalWorker === undefined) delete process.env.COURSE_OS_EXTERNAL_WORKER;
      else process.env.COURSE_OS_EXTERNAL_WORKER = previousExternalWorker;
      if (previousConcurrency === undefined) delete process.env.COURSE_OS_GENERATION_CONCURRENCY;
      else process.env.COURSE_OS_GENERATION_CONCURRENCY = previousConcurrency;
    }
  }, 60_000);

  it("records failed provider usage in the authoritative cost ledger", async () => {
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async () => {
        throw new ModelRouterGenerationError("MODEL_ROUTER_FAILED:DEADLINE_EXCEEDED", "gpt-5.6-sol", {
          inputTokens: 120,
          cachedInputTokens: 40,
          outputTokens: 80,
          apiEquivalentUsd: 0.0123,
          durationMs: 180_000
        });
      }
    };
    const { app, release } = await seededApp(modelRouter);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "failed-cost-job").send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 7 }).expect(202);
    const failed = await waitForJob(app, created.body.id);
    expect(failed).toMatchObject({ state: "failed", failedPageIds: ["page-1"], spentUsd: 0.0123 });
    const costs = await request(app).get(`/api/v1/costs?jobId=${created.body.id}`).expect(200);
    expect(costs.body.entries).toEqual([expect.objectContaining({ status: "failed", model: "gpt-5.6-sol", actualMicrousd: 12_300, inputTokens: 120, outputTokens: 80 })]);
    expect(costs.body.rollups.find((item: { scope: string }) => item.scope === "job").actualMicrousd).toBe(12_300);
  }, 60_000);

  it("records a provider fault's unknown actual and positive reserve as estimate", async () => {
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async () => {
        throw new ModelRouterGenerationError("MODEL_PROVIDER_FAILED:524", "deepseek-flash", {
          inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, apiEquivalentUsd: 0.005,
          unreportedCostReserveUsd: 0.025, durationMs: 80
        }, "deepseek");
      }
    };
    const { app, release } = await seededApp(modelRouter);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "unknown-provider-cost-job")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    const failed = await waitForJob(app, created.body.id);
    expect(failed).toMatchObject({ state: "failed", failedPageIds: ["page-1"], spentUsd: 0.03 });
    const costs = await request(app).get(`/api/v1/costs?jobId=${created.body.id}`).expect(200);
    expect(costs.body.entries).toEqual([expect.objectContaining({
      status: "failed", actualMicrousd: null, knownActualMicrousd: 5_000, estimatedMicrousd: 30_000,
      cashCostMicrousd: null, quotaConsumedMicrousd: null, costBasis: "not_available"
    })]);
    expect(costs.body.rollups.find((item: { scope: string }) => item.scope === "job")).toMatchObject({
      actualMicrousd: null, knownActualMicrousd: 5_000, estimatedMicrousd: 30_000,
      cashCostMicrousd: null, quotaConsumedMicrousd: null
    });
  }, 60_000);

  it("keeps a known-zero deterministic local receipt at zero", async () => {
    const localResult = { ...testTeachingResult(0), provider: "deterministic-local-fallback", model: "deterministic-local-v1" };
    const { app, release } = await seededApp({ generateTeachingPackage: async () => localResult });
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "known-local-zero-cost")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", spentUsd: 0 });
    const costs = await request(app).get(`/api/v1/costs?jobId=${created.body.id}`).expect(200);
    expect(costs.body.entries).toEqual([expect.objectContaining({
      actualMicrousd: 0, knownActualMicrousd: 0, cashCostMicrousd: 0, quotaConsumedMicrousd: 0, costBasis: "provider_reported"
    })]);
    expect(costs.body.rollups.find((item: { scope: string }) => item.scope === "job")).toMatchObject({ actualMicrousd: 0, knownActualMicrousd: 0 });
  }, 60_000);

  it("does not restart a page after invalid final model output", async () => {
    let calls = 0;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async () => {
        calls += 1;
        throw new ModelRouterGenerationError("MODEL_PROVIDER_OUTPUT_JSON_INVALID", "deepseek-v4.1-flash", {
          inputTokens: 80, cachedInputTokens: 0, outputTokens: 20, apiEquivalentUsd: 0.002, durationMs: 50
        }, "kuafu");
      }
    };
    const { app, operations, release } = await seededApp(modelRouter);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "agent-output-recovery")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    const job = await waitForJob(app, created.body.id);
    expect(job).toMatchObject({ state: "failed", attempt: 1, completedPageIds: [], failedPageIds: ["page-1"] });
    expect(calls).toBe(1);
    const events = (await operations.read()).events.filter((event) => event.streamId === created.body.id);
    expect(events.some((event) => event.type === "generation.page.agent_repair_queued")).toBe(false);
    const costs = await request(app).get(`/api/v1/costs?jobId=${created.body.id}`).expect(200);
    expect(costs.body.entries).toEqual([expect.objectContaining({ status: "failed", actualMicrousd: 2_000 })]);
  }, 60_000);

  it("records already billed usage after cancellation without saving a stale draft", async () => {
    const beforeEnv = process.env.COURSE_OS_EXTERNAL_WORKER;
    process.env.COURSE_OS_EXTERNAL_WORKER = "true";
    let releaseModel!: (result: TeachingGenerationResult) => void;
    let enteredModel!: () => void;
    const entered = new Promise<void>(resolve => { enteredModel = resolve; });
    const pending = new Promise<TeachingGenerationResult>(resolve => { releaseModel = resolve; });
    try {
      const {app,release,dependencies,readweave} = await seededApp({generateTeachingPackage:async()=>{enteredModel();return pending;}});
      const urgent = vi.spyOn(dependencies.operations,"urgentMutate");
      const save = vi.spyOn(readweave,"saveDraft");
      const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key","cancel-paid-job").send({materialVersionId:release.id,pageIds:["page-1"],budgetUsd:1}).expect(202);
      const execution = executeGenerationJob(created.body.id,dependencies);
      await entered;
      await request(app).post(`/api/v1/generation-jobs/${created.body.id}:cancel`).set("Idempotency-Key","cancel-paid-request").send({}).expect(200);
      expect(urgent).toHaveBeenCalledTimes(1);
      releaseModel(testTeachingResult(0.005));
      await execution;
      const job = await request(app).get(`/api/v1/generation-jobs/${created.body.id}`).expect(200);
      expect(job.body).toMatchObject({state:"cancelled",spentUsd:0.005});
      expect(save).not.toHaveBeenCalled();
      const costs = await request(app).get(`/api/v1/costs?jobId=${created.body.id}`).expect(200);
      expect(costs.body.entries).toHaveLength(1);
      expect(costs.body.entries[0].actualMicrousd).toBe(5000);
    } finally {
      releaseModel?.(testTeachingResult(0.005));
      if(beforeEnv===undefined)delete process.env.COURSE_OS_EXTERNAL_WORKER;else process.env.COURSE_OS_EXTERNAL_WORKER=beforeEnv;
    }
  });

  it("keeps the readable body but records an incomplete page when bridge generation fails", async () => {
    let bridgeCalls = 0;
    let coreCalls = 0;
    let bridgeAvailable = false;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async () => { coreCalls += 1; return testTeachingResult(0.001); },
      generateBridge: async () => {
        bridgeCalls += 1;
        if (bridgeAvailable) return { markdown: "从本课程要解决的问题开始，理解当前页的输入与输出关系", provider: "kuafu",
          model: "deepseek-v4.1-flash", usage: testTeachingResult(0.001).usage };
        throw new ModelRouterGenerationError("MODEL_PROVIDER_FAILED:429", "deepseek-v4-flash", {
          inputTokens: 20, cachedInputTokens: 0, outputTokens: 0, apiEquivalentUsd: 0, durationMs: 25
        }, "kuafu");
      }
    };
    const { app, operations, readweave, release } = await seededApp(modelRouter);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "unsupported-bridge-test").send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "failed", completedPageIds: [], failedPageIds: ["page-1"] });
    expect(bridgeCalls).toBe(1);
    const draft = await readweave.getDraftByPage("page-1");
    expect(draft?.status).toBe("ready");
    expect(draft?.page.lessonSections?.some((section) => section.kind === "chapter_bridge")).toBe(false);
    expect((await operations.read()).events.some(event => event.type === "generation.page.core_saved")).toBe(true);
    expect((await operations.read()).events.some(event => event.type === "generation.page.completed")).toBe(false);
    bridgeAvailable = true;
    await request(app).post(`/api/v1/generation-jobs/${created.body.id}:retry`).set("Idempotency-Key", "bridge-only-retry").send({}).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", completedPageIds: ["page-1"], failedPageIds: [] });
    const completed = await readweave.getDraftByPage("page-1");
    expect(coreCalls).toBe(1);
    expect(bridgeCalls).toBe(2);
    expect(completed?.page.blocks).toEqual(draft?.page.blocks);
    expect(completed?.page.questionBank).toEqual(draft?.page.questionBank);
    expect(completed?.page.lessonSections?.find(section => section.kind === "chapter_bridge")?.markdown).toContain("当前页");
    expect(completed?.revision).toBe((draft?.revision ?? 0) + 1);
  }, 60_000);

  it.each(["save503", "readback503", "revisionConflict"] as const)("resumes the durable paid bridge after %s without calling or charging it again", async (failure) => {
    const priorWorker = process.env.COURSE_OS_EXTERNAL_WORKER;
    process.env.COURSE_OS_EXTERNAL_WORKER = "true";
    try {
      const core = vi.fn(async () => testTeachingResult(0.001));
      const bridge = vi.fn(async () => ({ markdown: "已付费的承上启下内容", provider: "kuafu", model: "deepseek-v4.1-flash",
        usage: testTeachingResult(0.002).usage }));
      const { app, dependencies, operations, readweave, release } = await seededApp({ generateTeachingPackage: core, generateBridge: bridge });
      const save = readweave.saveDraftWithCost.bind(readweave);
      const read = readweave.getDraftByPage.bind(readweave);
      let fail = true;
      let bridgeSaved = false;
      let originalWriteKey: string | undefined;
      vi.spyOn(readweave, "saveDraftWithCost").mockImplementation(async (...args) => {
        if (args[0].page.lessonSections?.some(section => section.kind === "chapter_bridge")) {
          const state = await operations.read();
          const receipt = state.generationCheckpoints[`${args[0].generationJobId}:page-1`];
          expect(receipt && "kind" in receipt && receipt.bridge?.response.markdown).toBe("已付费的承上启下内容");
          expect(receipt && "kind" in receipt && receipt.bridge?.cost.id).toBe(args[3].id);
          originalWriteKey ??= args[2].idempotencyKey;
          expect(args[2].idempotencyKey).toBe(originalWriteKey);
          if (fail && failure !== "readback503") throw new Error(failure === "save503"
            ? "READWEAVE_ETAPI_503: bridge save unavailable" : "READWEAVE_REVISION_CONFLICT: bridge save rejected");
          const result = await save(...args);
          bridgeSaved = true;
          return result;
        }
        return save(...args);
      });
      vi.spyOn(readweave, "getDraftByPage").mockImplementation(async pageId => {
        if (fail && failure === "readback503" && bridgeSaved) throw new Error("READWEAVE_ETAPI_503: bridge readback unavailable");
        return read(pageId);
      });
      const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", `paid-bridge-${failure}`)
        .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
      await executeGenerationJob(created.body.id, dependencies);
      expect((await operations.readGenerationJob(created.body.id))?.state).toBe("failed");
      const before = await read("page-1");
      const checkpoint = (await operations.read()).generationCheckpoints[`${created.body.id}:page-1`];
      expect(checkpoint && "kind" in checkpoint && checkpoint.bridge?.cost.id).toContain("attempt:1");
      expect(bridge).toHaveBeenCalledTimes(1);
      fail = false;
      await request(app).post(`/api/v1/generation-jobs/${created.body.id}:retry`).set("Idempotency-Key", `paid-bridge-retry-${failure}`).send({}).expect(202);
      const restarted = createDefaultDependencies(dependencies.dataDir, readweave, { generateTeachingPackage: core, generateBridge: bridge });
      await executeGenerationJob(created.body.id, restarted);
      expect(await operations.readGenerationJob(created.body.id)).toMatchObject({ state: "completed", attempt: 2, spentUsd: 0.003 });
      expect(core).toHaveBeenCalledTimes(1);
      expect(bridge).toHaveBeenCalledTimes(1);
      const after = await read("page-1");
      expect(after?.page.blocks).toEqual(before?.page.blocks);
      expect(after?.page.questionBank).toEqual(before?.page.questionBank);
      expect(after?.page.lessonSections?.find(section => section.kind === "chapter_bridge")?.markdown).toBe("已付费的承上启下内容");
      const costs = await readweave.listCostEntries({ jobId: created.body.id });
      expect(costs).toHaveLength(2);
      expect(costs.filter(cost => cost.id.endsWith(":bridge"))).toHaveLength(1);
      expect(costs.find(cost => cost.id.endsWith(":bridge"))?.id).toContain("attempt:1");
      expect((await operations.readGenerationJobEvents(created.body.id)).filter(event => event.type === "generation.cost.recorded")).toHaveLength(2);
    } finally {
      if (priorWorker === undefined) delete process.env.COURSE_OS_EXTERNAL_WORKER;
      else process.env.COURSE_OS_EXTERNAL_WORKER = priorWorker;
    }
  }, 15_000);

  it("rejects a paid bridge checkpoint over a newer authority edit without regenerating the body or bridge", async () => {
    const priorWorker = process.env.COURSE_OS_EXTERNAL_WORKER;
    process.env.COURSE_OS_EXTERNAL_WORKER = "true";
    try {
      const core = vi.fn(async () => testTeachingResult(0.001));
      const bridge = vi.fn(async () => ({ markdown: "旧正文对应的桥接", provider: "kuafu", model: "deepseek-v4.1-flash",
        usage: testTeachingResult(0.002).usage }));
      const { app, dependencies, operations, readweave, release } = await seededApp({ generateTeachingPackage: core, generateBridge: bridge });
      const save = readweave.saveDraftWithCost.bind(readweave);
      let edited: LessonDraft | undefined;
      vi.spyOn(readweave, "saveDraftWithCost").mockImplementation(async (...args) => {
        if (!edited && args[0].page.lessonSections?.some(section => section.kind === "chapter_bridge")) {
          const base = (await readweave.getDraftByPage("page-1"))!;
          const page = structuredClone(base.page);
          page.blocks[0]!.markdown = "User's newer authoritative edit";
          edited = await readweave.saveDraft({ ...base, page, contentHash: "newer-authority-edit" }, base.revision,
            { idempotencyKey: "user-edit-during-bridge", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "user-edit-during-bridge" });
        }
        return save(...args);
      });
      const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "paid-bridge-newer-edit")
        .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
      await executeGenerationJob(created.body.id, dependencies);
      expect((await operations.readGenerationJob(created.body.id))?.state).toBe("failed");
      await request(app).post(`/api/v1/generation-jobs/${created.body.id}:retry`).set("Idempotency-Key", "paid-bridge-newer-edit-retry").send({}).expect(202);
      await executeGenerationJob(created.body.id, dependencies);
      expect(await operations.readGenerationJob(created.body.id)).toMatchObject({ state: "failed", lastErrorCode: "READWEAVE_REVISION_CONFLICT" });
      expect((await operations.readGenerationJobEvents(created.body.id)).some(event =>
        (event.payload as { backendFailureKind?: string }).backendFailureKind === "revision_conflict")).toBe(true);
      expect(await readweave.getDraftByPage("page-1")).toEqual(edited);
      expect(core).toHaveBeenCalledTimes(1);
      expect(bridge).toHaveBeenCalledTimes(1);
      expect((await readweave.listCostEntries({ jobId: created.body.id })).filter(cost => cost.id.endsWith(":bridge"))).toHaveLength(1);
    } finally {
      if (priorWorker === undefined) delete process.env.COURSE_OS_EXTERNAL_WORKER;
      else process.env.COURSE_OS_EXTERNAL_WORKER = priorWorker;
    }
  }, 15_000);

  it.each(["previousContext", "sourceContract"] as const)("refuses to mix a paid bridge checkpoint with changed %s", async (change) => {
    const priorWorker = process.env.COURSE_OS_EXTERNAL_WORKER;
    process.env.COURSE_OS_EXTERNAL_WORKER = "true";
    try {
      const core = vi.fn(async () => testTeachingResult(0.001));
      const bridge = vi.fn(async () => ({ markdown: "已付费的原上下文桥接", provider: "kuafu", model: "deepseek-v4.1-flash",
        usage: testTeachingResult(0.002).usage }));
      const { app, dependencies, operations, readweave, release } = await seededApp(
        { generateTeachingPackage: core, generateBridge: bridge }, testReleaseWithPages(2));
      const save = readweave.saveDraftWithCost.bind(readweave);
      vi.spyOn(readweave, "saveDraftWithCost").mockImplementation(async (...args) => {
        if (args[0].page.lessonSections?.some(section => section.kind === "chapter_bridge")) {
          throw new Error("READWEAVE_REVISION_CONFLICT: preserve bridge receipt before retry");
        }
        return save(...args);
      });
      const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", `bridge-context-${change}`)
        .send({ materialVersionId: release.id, pageIds: ["page-2"], budgetUsd: 1 }).expect(202);
      await executeGenerationJob(created.body.id, dependencies);
      expect((await operations.readGenerationJob(created.body.id))?.state).toBe("failed");
      const current = await readweave.getDraftByPage("page-2");
      if (change === "previousContext") {
        const page = structuredClone(release.pages[0]!);
        page.lessonSections = [{ id: "edited-predecessor", kind: "full_explanation", title: "新前页讲解",
          markdown: "The predecessor core now states a different premise", sourceAnchorIds: [], atomIds: [] }];
        await readweave.saveDraft({ id: "draft:page-1", workspaceId: "personal", courseId: release.courseId,
          moduleId: release.moduleId, sourceReleaseId: release.id, pageId: "page-1", revision: 0, status: "ready",
          page, changedBlockIds: [], contentHash: "changed-predecessor-core", updatedAt: new Date().toISOString() }, 0,
          { idempotencyKey: "changed-predecessor-core", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "changed-predecessor-core" });
      } else {
        await operations.mutateGenerationJob(created.body.id, job => { job.language = "en"; });
      }
      await request(app).post(`/api/v1/generation-jobs/${created.body.id}:retry`).set("Idempotency-Key", `bridge-context-retry-${change}`).send({}).expect(202);
      await executeGenerationJob(created.body.id, dependencies);
      expect((await operations.readGenerationJob(created.body.id))?.state).toBe("failed");
      expect(await readweave.getDraftByPage("page-2")).toEqual(current);
      expect(core).toHaveBeenCalledTimes(1);
      expect(bridge).toHaveBeenCalledTimes(1);
      expect((await readweave.listCostEntries({ jobId: created.body.id })).filter(cost => cost.id.endsWith(":bridge"))).toHaveLength(1);
    } finally {
      if (priorWorker === undefined) delete process.env.COURSE_OS_EXTERNAL_WORKER;
      else process.env.COURSE_OS_EXTERNAL_WORKER = priorWorker;
    }
  }, 15_000);

  it("saves a completed bridge and its cost in one ReadWeave mutation", async () => {
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async () => testTeachingResult(0.001),
      generateBridge: async () => ({ markdown: "上一页的结果引出本页的问题。", provider: "kuafu",
        model: "deepseek-v4.1-flash", usage: testTeachingResult(0.001).usage })
    };
    const { app, readweave, release } = await seededApp(modelRouter);
    const bundled = vi.spyOn(readweave, "saveDraftWithCost");
    const separateCost = vi.spyOn(readweave, "appendCostEntry");
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "bundled-bridge-cost")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", completedPageIds: ["page-1"] });
    expect(bundled).toHaveBeenCalledTimes(2);
    expect(separateCost).not.toHaveBeenCalled();
    expect(await readweave.listCostEntries({ jobId: created.body.id })).toHaveLength(2);
    expect((await readweave.getDraftByPage("page-1"))?.page.lessonSections?.some(section => section.kind === "chapter_bridge")).toBe(true);
  }, 60_000);

  it("records one final format repair inside the page generation and bills the combined call once", async () => {
    let generationCalls = 0;
    let formatRepairCalls = 0;
    let fieldRepairCalls = 0;
    let auditCalls = 0;
    const reportedPhases: string[] = [];
    const usage = testTeachingResult(0.003).usage;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async (input) => {
        generationCalls += 1;
        for (const phase of ["plan", "teaching", "format_repair"]) {
          if (phase === "format_repair") formatRepairCalls += 1;
          reportedPhases.push(phase);
          await input.onTeachingPhase?.(phase, "started");
          await input.onTeachingPhase?.(phase, "completed", usage);
        }
        const result = testTeachingResult(0.003);
        result.content.fullExplanationMarkdown += "\n\n最终格式修复后的内容保留在交付页面中";
        result.schemaRetries = 1;
        return result;
      },
      repairTeachingFields: async () => {
        fieldRepairCalls += 1;
        return testTeachingResult(0);
      },
      auditTeachingPackage: async () => {
        auditCalls += 1;
        return { provider: "test", model: "test", usage, findings: [], sourceChecks: [] };
      }
    };
    const { app, operations, readweave, release } = await seededApp(modelRouter);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "app-final-format-repair")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);

    expect(await waitForJob(app, created.body.id)).toMatchObject({
      state: "completed", completedPageIds: ["page-1"], failedPageIds: [], spentUsd: 0.003
    });
    expect(generationCalls).toBe(1);
    expect(formatRepairCalls).toBe(1);
    expect(reportedPhases).toEqual(["plan", "teaching", "format_repair"]);
    expect(fieldRepairCalls).toBe(0);
    expect(auditCalls).toBe(0);
    const draft = await readweave.getDraftByPage("page-1");
    expect(draft?.status).toBe("ready");
    expect(draft?.page.lessonSections?.find((section) => section.kind === "full_explanation")?.markdown)
      .toContain("最终格式修复后的内容");
    const events = (await operations.read()).events.filter((event) => event.streamId === created.body.id);
    expect(events.filter((event) => event.type === "generation.stage.started"
      && (event.payload as { stage?: string }).stage === "repair")).toHaveLength(1);
    expect(events.some((event) => (event.payload as { phase?: string }).phase === "semantic_audit")).toBe(false);
    const costs = await request(app).get(`/api/v1/costs?jobId=${created.body.id}`).expect(200);
    expect(costs.body.entries).toHaveLength(1);
    expect(costs.body.entries[0]).toMatchObject({ status: "succeeded", actualMicrousd: 3_000 });
  }, 60_000);

  it("rejects a missing full explanation without substituting summary or reporting completion", async () => {
    const partialResult = testTeachingResult(0.001);
    partialResult.content.fullExplanationMarkdown = "";
    const { app, readweave, operations, release } = await seededApp({ generateTeachingPackage: async () => partialResult });
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "missing-body-final-contract")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "failed", completedPageIds: [], failedPageIds: ["page-1"] });
    expect(await readweave.getDraftByPage("page-1")).toBeUndefined();
    const events = (await operations.read()).events.filter(event => event.streamId === created.body.id);
    expect(events.some(event => event.type === "generation.page.core_saved")).toBe(false);
    expect(events.some(event => event.type === "generation.page.completed")).toBe(false);
    const costs = await request(app).get(`/api/v1/costs?jobId=${created.body.id}`).expect(200);
    expect(costs.body.entries).toHaveLength(1);
    expect(costs.body.entries[0].actualMicrousd).toBe(1000);
  }, 60_000);

  it("preserves a paid explanation with missing BP main as a nonpublishable review draft", async () => {
    const partialResult = testTeachingResult(0.001);
    partialResult.content.mainContentMarkdown = "";
    const { app, readweave, operations, release } = await seededApp({ generateTeachingPackage: async () => partialResult });
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "missing-summary-final-contract")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "failed", completedPageIds: [], failedPageIds: ["page-1"], spentUsd: 0.001 });
    const draft = await readweave.getDraftByPage("page-1");
    expect(draft?.status).toBe("needs_review");
    expect(draft?.page.quality.publishable).toBe(false);
    expect(draft?.page.quality.issues).toContain("GENERATION_CORE_MAIN_CONTENT_REQUIRED");
    expect(draft?.page.lessonSections?.find(section => section.kind === "full_explanation")?.markdown)
      .toBe(partialResult.content.fullExplanationMarkdown);
    expect(draft?.page.lessonSections?.find(section => section.kind === "main_content")?.markdown).toBe("");
    const events = (await operations.read()).events.filter(event => event.streamId === created.body.id);
    const review = events.find(event => event.type === "generation.stage.completed"
      && (event.payload as { stage?: string }).stage === "review")?.payload as { issueCount: number; publishable: boolean } | undefined;
    expect(review?.publishable).toBe(false);
    expect(review?.issueCount).toBe(draft?.page.quality.issues.length);
    expect(events.some(event => event.type === "generation.page.core_saved")).toBe(false);
    expect(events.some(event => event.type === "generation.page.completed")).toBe(false);
    const costs = await request(app).get(`/api/v1/costs?jobId=${created.body.id}`).expect(200);
    expect(costs.body.entries).toHaveLength(1);
  }, 60_000);

  it("repairs only the missing BP main from a legacy core receipt and preserves the saved page", async () => {
    const calls: Array<Parameters<NonNullable<ModelRouterClient["generateTeachingPackage"]>>[0]> = [];
    const repairedMain = "- BP 输出应明确列出节点集合与边集合。";
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async input => {
        calls.push(input);
        if (input.repairMissingMainContent) {
          await input.onTeachingPhase?.("format_repair", "started");
          const usage = testTeachingResult(0.0005).usage;
          await input.onTeachingPhase?.("format_repair", "completed", usage);
          return {
            content: { ...input.repairMissingMainContent, mainContentMarkdown: repairedMain } as TeachingPackage,
            provider: "kuafu", model: "deepseek-v4.1-flash", usage, schemaRetries: 1
          };
        }
        const partial = testTeachingResult(0.001);
        partial.content.mainContentMarkdown = "";
        return partial;
      }
    };
    const { app, operations, readweave, release } = await seededApp(modelRouter);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "legacy-missing-main-recovery")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "failed", failedPageIds: ["page-1"] });

    const partialDraft = await readweave.getDraftByPage("page-1");
    expect(partialDraft).toBeDefined();
    const legacyPage = structuredClone(partialDraft!.page);
    legacyPage.quality = { ...legacyPage.quality, publishable: false,
      issues: [...new Set([...legacyPage.quality.issues.filter(issue => issue !== "GENERATION_CORE_MAIN_CONTENT_REQUIRED"), "misconceptions:ITEMS_REQUIRED"])] };
    const retainedQualityIssues = [...legacyPage.quality.issues];
    const legacyDraft = await readweave.saveDraft({
      ...partialDraft!, status: "needs_review", page: legacyPage, contentHash: "legacy-ready-core-with-empty-main",
      updatedAt: new Date().toISOString()
    }, partialDraft!.revision, {
      idempotencyKey: "legacy-ready-core-with-empty-main", actor: "test", workspaceId: "personal",
      schemaVersion: "2.4.0", requestId: "legacy-ready-core-with-empty-main"
    });
    const oldCosts = await readweave.listCostEntries({ jobId: created.body.id, pageId: "page-1" });
    await operations.mutateGenerationJob(created.body.id, (_job, context) => {
      context.appendEvent("generation.page.core_saved", { pageId: "page-1", draftRevision: legacyDraft.revision,
        contentHash: legacyDraft.contentHash, costEntryIds: oldCosts.map(cost => cost.id), publishable: false, bridgeCompleted: false });
    });
    const sectionsBefore = legacyDraft.page.lessonSections?.filter(section => section.kind !== "main_content");
    const blocksBefore = legacyDraft.page.blocks.filter(block => block.kind !== "core");
    const questionBankBefore = structuredClone(legacyDraft.page.questionBank);
    const imageUrlBefore = legacyDraft.page.imageUrl;

    await request(app).post(`/api/v1/generation-jobs/${created.body.id}:retry`).set("Idempotency-Key", "legacy-main-format-repair")
      .send({}).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", completedPageIds: ["page-1"], failedPageIds: [] });

    expect(calls).toHaveLength(2);
    expect(calls.filter(call => !call.repairMissingMainContent)).toHaveLength(1);
    expect(calls[1]?.repairMissingMainContent).toMatchObject({
      mainContentMarkdown: "", fullExplanationMarkdown: legacyDraft.page.lessonSections?.find(section => section.kind === "full_explanation")?.markdown
    });
    expect(calls[1]?.onTeachingPhase).toBeDefined();
    const repaired = await readweave.getDraftByPage("page-1");
    expect(repaired?.status).toBe("ready");
    expect(repaired?.page.quality).toMatchObject({ publishable: false, issues: retainedQualityIssues });
    expect(repaired?.page.imageUrl).toBe(imageUrlBefore);
    expect(repaired?.page.anchors).toEqual(legacyDraft.page.anchors);
    expect(repaired?.page.atoms).toEqual(legacyDraft.page.atoms);
    expect(repaired?.page.questionBank).toEqual(questionBankBefore);
    expect(repaired?.page.lessonSections?.filter(section => section.kind !== "main_content")).toEqual(sectionsBefore);
    expect(repaired?.page.blocks.filter(block => block.kind !== "core")).toEqual(blocksBefore);
    expect(repaired?.page.lessonSections?.find(section => section.kind === "main_content")?.markdown).toBe(repairedMain);
    expect(repaired?.page.blocks.find(block => block.kind === "core")?.markdown).toBe(repairedMain);
    const events = (await operations.read()).events.filter(event => event.streamId === created.body.id);
    expect(events.filter(event => event.type === "generation.stage.started"
      && (event.payload as { stage?: string }).stage === "repair")).toHaveLength(1);
    expect(events.filter(event => event.type === "generation.stage.started"
      && (event.payload as { stage?: string }).stage === "teach")).toHaveLength(1);
    expect((await readweave.listCostEntries({ jobId: created.body.id, pageId: "page-1" })).map(cost => cost.stage)).toContain("repair");
  }, 60_000);

  it("does not make a complete Slim teaching page fail solely for legacy coverage fields", async () => {
    const candidate = testRelease();
    candidate.lifecycle = "draft_source";
    candidate.pages[0]!.atoms = [{ kind: "text_region", id: "source-atom", label: "来源片段", observation: "输入经过规则得到输出" }];
    candidate.pages[0]!.coverageRequirements = [{ id: "source-requirement", atomId: "source-atom", requiredFields: ["observation"], risk: "high" }];
    const { app, readweave, release } = await seededApp({ generateTeachingPackage: async () => testTeachingResult(0.001) }, candidate);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "slim-coverage-is-diagnostic")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", completedPageIds: ["page-1"] });
    const draft = await readweave.getDraftByPage("page-1");
    expect(draft?.page.quality.issues.some((issue) => issue.includes(":MISSING:"))).toBe(false);
    const validation = await request(app).post("/api/v1/pages/page-1:validate").expect(200);
    expect(validation.body.issues.some((issue: string) => issue.includes(":MISSING:"))).toBe(false);
    expect(validation.body.publishable).toBe(true);
    expect(draft?.page.quality.publishable).toBe(true);
  }, 60_000);
  it("uses the requested batch budget for a page instead of a hidden fixed cap", async () => {
    const limits: number[] = [];
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async (input) => {
        limits.push(input.maxCostUsd ?? -1);
        return testTeachingResult(0.08);
      }
    };
    const { app, release } = await seededApp(modelRouter);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "selected-budget-job")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 2 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", completedPageIds: ["page-1"], spentUsd: 0.08 });
    expect(limits[0]).toBe(2);
  }, 60_000);

  it("records the call and stops a job when actual cost crosses its hard budget", async () => {
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async () => testTeachingResult(0.02)
    };
    const { app, release } = await seededApp(modelRouter);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "hard-budget-job").send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 0.01 }).expect(202);
    const stopped = await waitForJob(app, created.body.id);
    expect(stopped).toMatchObject({ state: "failed", completedPageIds: ["page-1"], spentUsd: 0.02 });
    const costs = await request(app).get(`/api/v1/costs?jobId=${created.body.id}`).expect(200);
    expect(costs.body.entries).toEqual([expect.objectContaining({ status: "succeeded", actualMicrousd: 20_000 })]);
  }, 60_000);

  it("retries only failed pages with a new provider key for the next attempt", async () => {
    const keys: string[] = [];
    let calls = 0;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async (input) => {
        keys.push(input.idempotencyKey);
        calls += 1;
        if (calls === 1) throw new ModelRouterGenerationError("MODEL_ROUTER_FAILED:TEMPORARY", "gpt-5.6-sol", { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, apiEquivalentUsd: 0, durationMs: 100 });
        return testTeachingResult(0.015);
      }
    };
    const { app, release } = await seededApp(modelRouter);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "retry-source-job").send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 7 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "failed", failedPageIds: ["page-1"], attempt: 1 });
    await request(app).post(`/api/v1/generation-jobs/${created.body.id}:retry`).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", completedPageIds: ["page-1"], failedPageIds: [], attempt: 2, spentUsd: 0.015 });
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[0]).toContain(":attempt:1:");
    expect(keys[1]).toContain(":attempt:2:");
    const costs = await request(app).get(`/api/v1/costs?jobId=${created.body.id}`).expect(200);
    expect(costs.body.entries.map((item: { status: string; actualMicrousd: number }) => ({ status: item.status, actualMicrousd: item.actualMicrousd }))).toEqual([{ status: "failed", actualMicrousd: 0 }, { status: "succeeded", actualMicrousd: 15_000 }]);
  }, 60_000);

  it("resumes cancelled jobs from unfinished pages and replays a keyed retry", async () => {
    const previousExternalWorker = process.env.COURSE_OS_EXTERNAL_WORKER;
    process.env.COURSE_OS_EXTERNAL_WORKER = "true";
    try {
      const { app, operations, release } = await seededApp(undefined, testReleaseWithPages(3));
      const created = await request(app).post("/api/v1/generation-jobs")
        .set("Idempotency-Key", "cancelled-resume-job")
        .send({ materialVersionId: release.id, pageIds: release.pageIds, budgetUsd: 4 })
        .expect(202);
      const checkpoint = {
        fingerprint: "resume-checkpoint",
        content: { opening: "已完成" },
        completedPhases: ["opening"],
        trace: { version: 1, plan: undefined, phases: [] }
      } as never;
      await operations.mutate((state) => {
        const job = state.jobs.find((item) => item.id === created.body.id)!;
        Object.assign(job, {
          state: "cancelled",
          cancelRequested: true,
          completedPageIds: [release.pageIds[0]!],
          planId: "resume-plan"
        });
        state.generationCheckpoints[job.id + ":" + release.pageIds[1]!] = checkpoint;
        state.jobs.push({
          ...structuredClone(job),
          id: "resume-plan-sibling",
          state: "queued",
          pageIds: [release.pageIds[2]!],
          completedPageIds: [],
          failedPageIds: [],
          cancelRequested: false
        });
      });

      const retryUrl = "/api/v1/generation-jobs/" + created.body.id + ":retry";
      await request(app).post(retryUrl).set("Idempotency-Key", "cancelled-resume-retry")
        .expect(409).expect(({ body }) => expect(body.error.code).toBe("GENERATION_PLAN_BUSY"));
      await operations.mutate((state) => {
        state.jobs.find((item) => item.id === "resume-plan-sibling")!.state = "completed";
      });

      const resumed = await request(app).post(retryUrl).set("Idempotency-Key", "cancelled-resume-retry").expect(202);
      expect(resumed.body).toMatchObject({
        state: "queued",
        pageIds: release.pageIds.slice(1),
        completedPageIds: [],
        failedPageIds: [],
        cancelRequested: false
      });
      const replay = await request(app).post(retryUrl).set("Idempotency-Key", "cancelled-resume-retry").expect(200);
      expect(replay.body.id).toBe(created.body.id);

      const state = await operations.read();
      expect(state.generationCheckpoints[created.body.id + ":" + release.pageIds[1]!]).toEqual(checkpoint);
      expect(state.events.filter((event) => event.streamId === created.body.id && event.type === "job.retry.queued")).toHaveLength(1);
    } finally {
      if (previousExternalWorker === undefined) delete process.env.COURSE_OS_EXTERNAL_WORKER;
      else process.env.COURSE_OS_EXTERNAL_WORKER = previousExternalWorker;
    }
  });

  it("requeues a still-leased running job after restart without regenerating completed pages", async () => {
    const previousExternalWorker = process.env.COURSE_OS_EXTERNAL_WORKER;
    const previousWorkerToken = process.env.COURSE_OS_WORKER_TOKEN;
    process.env.COURSE_OS_EXTERNAL_WORKER = "true";
    process.env.COURSE_OS_WORKER_TOKEN = "synthetic-worker-token";
    try {
      const generatedPages: number[] = [];
      const modelRouter: ModelRouterClient = {
        generateTeachingPackage: async input => {
          generatedPages.push(input.pageNumber);
          return testTeachingResult(0.001);
        }
      };
      const { app, dependencies, readweave, release } = await seededApp(modelRouter, testReleaseWithPages(2));
      const accepted = await request(app).post("/api/v1/generation-jobs")
        .set("Idempotency-Key", "leased-restart-job")
        .send({ materialVersionId: release.id, pageIds: release.pageIds, budgetUsd: 4 })
        .expect(202);
      const completedPage = release.pages[0]!;
      await readweave.saveDraft({
        id: `draft:${completedPage.id}`, workspaceId: "personal", courseId: release.courseId, moduleId: release.moduleId,
        sourceReleaseId: release.id, pageId: completedPage.id, revision: 0, status: "ready",
        page: completedPage, changedBlockIds: [], contentHash: "completed-before-restart", updatedAt: new Date().toISOString()
      }, 0, {
        idempotencyKey: "restart-seed-completed-page", actor: "test", workspaceId: "personal",
        schemaVersion: "2.4.0", requestId: "restart-seed-completed-page"
      });
      const now = Date.now();
      await dependencies.operations.mutate(state => {
        const job = state.jobs.find(item => item.id === accepted.body.id)!;
        Object.assign(job, {
          state: "running", attempt: 4, completedPageIds: [completedPage.id],
          lease: { owner: "previous-api", fenceToken: 7, expiresAt: new Date(now + 60_000).toISOString() }
        });
      });

      // A new API process opens the same temporary operational store. The external
      // worker then picks up the recovered queued job through its normal endpoint.
      const restartedDependencies = createDefaultDependencies(dependencies.dataDir, readweave, modelRouter);
      const restartedApp = createApp(restartedDependencies);
      await resumeIncompleteJobs(restartedDependencies);

      const recovered = (await restartedDependencies.operations.readTaskIndex()).jobs.find(item => item.id === accepted.body.id)!;
      expect(recovered).toMatchObject({ state: "queued", attempt: 4, completedPageIds: [completedPage.id] });
      expect(Date.parse(recovered.lease!.expiresAt)).toBeGreaterThan(Date.now());

      await request(restartedApp).post(`/api/internal/worker/jobs/${accepted.body.id}/run`)
        .set("X-Course-Worker-Token", "synthetic-worker-token")
        .set("X-Workspace-Id", "personal")
        .expect(202);
      const finished = await waitForJob(restartedApp, accepted.body.id);

      expect(finished).toMatchObject({
        state: "completed", attempt: 5,
        lease: { owner: `course-os-worker:${process.pid}`, fenceToken: 8 },
        completedPageIds: release.pageIds
      });
      expect(generatedPages).toEqual([2]);
      const recoveredEvents = (await restartedDependencies.operations.read()).events
        .filter(event => event.streamId === accepted.body.id && event.type === "job.recovered");
      expect(recoveredEvents).toHaveLength(1);
      expect(recoveredEvents[0]?.payload).toMatchObject({ previousState: "running", attempt: 4 });
    } finally {
      if (previousExternalWorker === undefined) delete process.env.COURSE_OS_EXTERNAL_WORKER;
      else process.env.COURSE_OS_EXTERNAL_WORKER = previousExternalWorker;
      if (previousWorkerToken === undefined) delete process.env.COURSE_OS_WORKER_TOKEN;
      else process.env.COURSE_OS_WORKER_TOKEN = previousWorkerToken;
    }
  }, 45_000);

  it("creates an empty general-purpose course before any material is imported", async () => {
    const app = await testApp();
    const created = await request(app).post("/api/v1/courses").set("Idempotency-Key", "course-create-1").send({ title: "线性代数", description: "公式、推导和应用" }).expect(201);
    expect(created.body).toMatchObject({ title: "线性代数", status: "active" });
    const tree = await request(app).get("/api/v1/workspaces/personal/tree").expect(200);
    expect(tree.body).toMatchObject({ treeVersion: "2.4.0", trash: { kind: "trash", title: "回收站" } });
    expect(tree.body.courses[0]).toMatchObject({ title: "线性代数", status: "published", children: [] });
    expect(tree.body.courses[0].children.some((node: { title: string }) => node.title === "当前材料")).toBe(false);
  });

  it("builds the sidebar tree from lightweight projections without loading release pages or drafts", async () => {
    const { app, readweave, release } = await seededApp();
    const listReleases = vi.spyOn(readweave, "listReleases").mockRejectedValue(new Error("HEAVY_RELEASE_READ_MUST_NOT_RUN"));
    const listDrafts = vi.spyOn(readweave, "listDrafts").mockRejectedValue(new Error("HEAVY_DRAFT_READ_MUST_NOT_RUN"));
    const tree = await request(app).get("/api/v1/workspaces/personal/tree").expect(200);
    expect(tree.body.courses[0].children[0]).toMatchObject({
      kind: "material",
      currentReleaseId: release.id,
      pageCount: 1
    });
    const material = tree.body.courses[0].children[0];
    await request(app).patch(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}`)
      .set("Idempotency-Key", "lightweight-tree-write")
      .send({ expectedRevision: material.revision, title: "轻量写入" })
      .expect(200);
    expect(listReleases).not.toHaveBeenCalled();
    expect(listDrafts).not.toHaveBeenCalled();
  });

  it("keeps persisted material properties and its release pointer when a newer release is published", async () => {
    const { app, readweave, release } = await seededApp();
    const firstTree = await request(app).get("/api/v1/workspaces/personal/tree").expect(200);
    const material = firstTree.body.courses[0].children[0];
    await request(app).patch(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}`)
      .set("Idempotency-Key", "persist-material-title")
      .send({ expectedRevision: material.revision, title: "保留的材料名称", currentReleaseId: release.id })
      .expect(200);
    const nextRelease = { ...structuredClone(release), id: "test-release-v2", version: release.version + 1, publishedAt: new Date(Date.now() + 1_000).toISOString() };
    await readweave.publishRelease(nextRelease, testManifest(nextRelease.id), {
      idempotencyKey: "publish-next-release",
      actor: "test",
      workspaceId: "personal",
      schemaVersion: "2.4.0",
      requestId: "publish-next-release"
    });
    const nextTree = await request(app).get("/api/v1/workspaces/personal/tree").expect(200);
    expect(nextTree.body.courses[0].children[0]).toMatchObject({
      title: "保留的材料名称",
      releaseId: release.id,
      currentReleaseId: release.id,
      pageCount: nextRelease.pages.length
    });
  });

  it("retains renamed material properties while an unpinned selection follows a newer published release", async () => {
    const { app, readweave, release } = await seededApp();
    const initial = await request(app).get("/api/v1/workspaces/personal/tree").expect(200);
    const material = initial.body.courses[0].children[0];
    await request(app).patch(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}`)
      .set("Idempotency-Key", "rename-derived-material")
      .send({ expectedRevision: material.revision, title: "Renamed unpinned material" }).expect(200);
    const newer = { ...structuredClone(release), id: "test-release-derived-v2", version: release.version + 1,
      publishedAt: new Date(Date.now() + 1_000).toISOString() };
    await readweave.publishRelease(newer, testManifest(newer.id), {
      idempotencyKey: "publish-derived-newer", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "publish-derived-newer"
    });
    const tree = await request(app).get("/api/v1/workspaces/personal/tree").expect(200);
    expect(tree.body.courses[0].children[0]).toMatchObject({ title: "Renamed unpinned material", currentReleaseId: newer.id, releaseId: newer.id });
  });

  it("switches a material current release only to a complete owned draft source", async () => {
    const { app, readweave, release } = await seededApp();
    const tree = await request(app).get("/api/v1/workspaces/personal/tree?view=library").expect(200);
    const course = tree.body.courses[0];
    const material = course.children[0];
    const secondPage = replaceTestIds(structuredClone(release.pages[0]!), release.pages[0]!.id, "page-2");
    secondPage.pageNumber = 2;
    const origin = {
      ...structuredClone(release),
      id: "origin-draft-source",
      version: 0,
      lifecycle: "draft_source" as const,
      pageIds: [...release.pageIds, secondPage.id],
      pages: [...structuredClone(release.pages), secondPage]
    };
    await readweave.registerDraftSource(origin, {
      idempotencyKey: "tree-pointer-origin-source", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "tree-pointer-origin-source"
    });

    await request(app).patch(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}`)
      .set("Idempotency-Key", "tree-pointer-unready")
      .send({ expectedRevision: material.revision, currentReleaseId: origin.id })
      .expect(409)
      .expect((response) => expect(response.body.error.code).toBe("TREE_CURRENT_RELEASE_NOT_READY"));

    const page = structuredClone(origin.pages[0]!);
    await readweave.saveDraft({
      id: "draft:origin-page-1", workspaceId: "personal", courseId: origin.courseId, moduleId: origin.moduleId,
      sourceReleaseId: origin.id, pageId: page.id, revision: 0, status: "ready", page,
      changedBlockIds: page.blocks.map((block) => block.id), contentHash: "origin-ready-page", updatedAt: new Date().toISOString()
    }, 0, {
      idempotencyKey: "tree-pointer-origin-ready-page", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "tree-pointer-origin-ready-page"
    });

    await request(app).patch(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}`)
      .set("Idempotency-Key", "tree-pointer-partial")
      .send({ expectedRevision: material.revision, currentReleaseId: origin.id })
      .expect(409)
      .expect((response) => expect(response.body.error.code).toBe("TREE_CURRENT_RELEASE_NOT_READY"));

    await readweave.saveDraft({
      id: "draft:origin-page-2", workspaceId: "personal", courseId: origin.courseId, moduleId: origin.moduleId,
      sourceReleaseId: origin.id, pageId: secondPage.id, revision: 0, status: "ready", page: secondPage,
      changedBlockIds: secondPage.blocks.map((block) => block.id), contentHash: "origin-ready-page-2", updatedAt: new Date().toISOString()
    }, 0, {
      idempotencyKey: "tree-pointer-origin-ready-page-2", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "tree-pointer-origin-ready-page-2"
    });

    const switched = await request(app).patch(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}`)
      .set("Idempotency-Key", "tree-pointer-ready")
      .send({ expectedRevision: material.revision, currentReleaseId: origin.id })
      .expect(200);
    expect(switched.body).toMatchObject({ id: material.id, kind: "material", currentReleaseId: origin.id, releaseId: origin.id, revision: material.revision + 1 });
    const replayed = await request(app).patch(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}`)
      .set("Idempotency-Key", "tree-pointer-ready")
      .send({ expectedRevision: material.revision, currentReleaseId: origin.id })
      .expect(200);
    expect(replayed.body).toMatchObject({ currentReleaseId: origin.id, revision: switched.body.revision });
    await request(app).patch(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}`)
      .set("Idempotency-Key", "tree-pointer-stale-cas")
      .send({ expectedRevision: material.revision, currentReleaseId: release.id })
      .expect(409);
    const afterRejectedCas = await request(app).get("/api/v1/workspaces/personal/tree?view=library").expect(200);
    expect(afterRejectedCas.body.courses[0].children[0]).toMatchObject({ currentReleaseId: origin.id });
    await expect(readweave.getRelease(release.id)).resolves.toMatchObject({ id: release.id, version: release.version, pages: release.pages });

    const foreignMaterialRelease = { ...structuredClone(origin), id: "other-material-source", moduleId: "different-module" };
    await readweave.registerDraftSource(foreignMaterialRelease, {
      idempotencyKey: "tree-pointer-other-material", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "tree-pointer-other-material"
    });
    await request(app).patch(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}`)
      .set("Idempotency-Key", "tree-pointer-foreign-material")
      .send({ expectedRevision: switched.body.revision, currentReleaseId: foreignMaterialRelease.id })
      .expect(422)
      .expect((response) => expect(response.body.error.code).toBe("TREE_CURRENT_RELEASE_OWNERSHIP"));

    await request(app).patch(`/api/v1/tree/nodes/${encodeURIComponent(course.id)}`)
      .set("Idempotency-Key", "tree-pointer-course-node")
      .send({ expectedRevision: course.revision, currentReleaseId: origin.id })
      .expect(422)
      .expect((response) => expect(response.body.error.code).toBe("TREE_CURRENT_RELEASE_MATERIAL_ONLY"));
  });

  it("supports revision-checked course-tree CRUD, trash recovery and exact ReadWeave links", async () => {
    const { app, release, readweave } = await seededApp();
    const firstTree = await request(app).get("/api/v1/workspaces/personal/tree?view=library").expect(200);
    const course = firstTree.body.courses[0];
    const material = course.children[0];
    expect(course.children).toHaveLength(1);
    expect(material).toMatchObject({ kind: "material", materialId: `material:${release.courseId}:${release.moduleId}`, currentReleaseId: release.id });
    const renamed = await request(app).patch(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}`).set("Idempotency-Key", "tree-rename").send({ expectedRevision: material.revision, title: "第一章：数组" }).expect(200);
    expect(renamed.body).toMatchObject({ id: material.id, kind: "material", title: "第一章：数组", revision: material.revision + 1 });
    await request(app).patch(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}`).set("Idempotency-Key", "tree-stale").send({ expectedRevision: material.revision, title: "错误名称" }).expect(409);

    const secondCourse = await request(app).post("/api/v1/courses").set("Idempotency-Key", "tree-course-2").send({ title: "数据结构" }).expect(201);
    const moved = await request(app).post(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}:move`).set("Idempotency-Key", "tree-move").send({ expectedRevision: renamed.body.revision, parentId: secondCourse.body.id, sortOrder: 0 }).expect(200);
    expect(moved.body).toMatchObject({ id: material.id, parentId: secondCourse.body.id, sortOrder: 0 });
    const movedTree = await request(app).get("/api/v1/workspaces/personal/tree").expect(200);
    expect(movedTree.body.courses.find((node: { id: string }) => node.id === secondCourse.body.id).children).toEqual([expect.objectContaining({ id: material.id, parentId: secondCourse.body.id })]);

    const duplicate = await request(app).post(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}:duplicate`).set("Idempotency-Key", "tree-duplicate").expect(201);
    expect(duplicate.body).toMatchObject({ kind: "material", title: "第一章：数组 副本", revision: 0, parentId: secondCourse.body.id });
    const trashed = await request(app).post(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}:trash`).set("Idempotency-Key", "tree-trash").expect(201);
    expect(trashed.body).toMatchObject({ nodeId: material.id, nodeKind: "material", restoreAvailable: true, originalParentId: secondCourse.body.id });
    const trash = await request(app).get("/api/v1/trash").expect(200);
    expect(trash.body).toEqual([expect.objectContaining({ id: trashed.body.id, nodeId: material.id })]);
    const restored = await request(app).post(`/api/v1/trash/${encodeURIComponent(trashed.body.id)}:restore`).set("Idempotency-Key", "tree-restore").send({ restoreMode: "original" }).expect(200);
    expect(restored.body).toMatchObject({ id: material.id, kind: "material", archived: false, parentId: secondCourse.body.id });
    const link = await request(app).get(`/api/v1/readweave/links/${encodeURIComponent(material.readweaveNoteId)}`).expect(200);
    expect(link.body).toEqual(expect.objectContaining({ host: "readweave.example.com", verified: true, url: `https://readweave.example.com/#root/${encodeURIComponent(material.readweaveNoteId)}` }));
    await request(app).get("/api/v1/tree/nodes/module-tree-1/properties").expect(409).expect((response) => {
      expect(response.body.error).toMatchObject({ code: "TREE_NODE_STALE" });
      expect(response.body.error.message).not.toContain("READWEAVE_TREE_NODE_NOT_FOUND");
    });
  });

  it("hides a trashed material from release indexes and old page links until it is restored", async () => {
    const seedRelease = testRelease();
    const linkedPage = replaceTestIds(structuredClone(seedRelease.pages[0]!), "page-1", `${seedRelease.id}:page:1`);
    linkedPage.pageNumber = 2;
    seedRelease.pages.push(linkedPage);
    seedRelease.pageIds.push(linkedPage.id);
    const { app, release, readweave } = await seededApp(undefined, seedRelease);
    const otherRelease = structuredClone(release);
    otherRelease.id = "test-release-other-material";
    otherRelease.moduleId = "module-other";
    otherRelease.moduleTitle = "有效材料";
    otherRelease.pages = otherRelease.pages.map((page) => replaceTestIds(page, page.id, `${page.id}-other`));
    otherRelease.pageIds = otherRelease.pages.map((page) => page.id);
    await readweave.publishRelease(otherRelease, testManifest(otherRelease.id), {
      idempotencyKey: "publish-other-material",
      actor: "test",
      workspaceId: "personal",
      schemaVersion: "2.4.0",
      requestId: "publish-other-material"
    });

    const initialTree = await request(app).get("/api/v1/workspaces/personal/tree").expect(200);
    const material = initialTree.body.courses[0].children.find((node: { currentReleaseId: string }) => node.currentReleaseId === release.id);
    expect(material).toMatchObject({ id: `material:${release.courseId}:${release.moduleId}`, kind: "material" });
    const initialIndex = await request(app).get("/api/v1/releases?view=index").expect(200);
    expect(initialIndex.body.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([release.id, otherRelease.id]));

    const trashed = await request(app).post(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}:trash`)
      .set("Idempotency-Key", "trash-indexed-material")
      .expect(201);
    expect(trashed.body).toMatchObject({ nodeId: material.id, nodeKind: "material", restoreAvailable: true });

    const hiddenIndex = await request(app).get("/api/v1/releases?view=index").expect(200);
    expect(hiddenIndex.body.map((item: { id: string }) => item.id)).toEqual([otherRelease.id]);
    const hiddenReleases = await request(app).get("/api/v1/releases").expect(200);
    expect(hiddenReleases.body.map((item: { id: string }) => item.id)).toEqual([otherRelease.id]);
    await request(app).get(`/api/v1/releases/${release.id}`).expect(404);
    await request(app).get(`/api/v1/pages/${release.pages[0]!.id}/lesson`).expect(404);
    await request(app).get(`/api/v1/pages/${release.pages[1]!.id}/lesson`).expect(404);
    await request(app).get(`/api/v1/pages/${release.pages[0]!.id}/draft?view=snapshot`).expect(404);
    await request(app).get(`/api/v1/releases/${otherRelease.id}`).expect(200);
    await request(app).get(`/api/v1/pages/${otherRelease.pages[0]!.id}/lesson`).expect(200);
    await request(app).get(`/api/v1/pages/${otherRelease.pages[0]!.id}/draft?view=snapshot`).expect(200);

    await request(app).post(`/api/v1/trash/${encodeURIComponent(trashed.body.id)}:restore`)
      .set("Idempotency-Key", "restore-indexed-material")
      .send({ restoreMode: "original" })
      .expect(200);
    const restoredIndex = await request(app).get("/api/v1/releases?view=index").expect(200);
    expect(restoredIndex.body.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([release.id, otherRelease.id]));
    await request(app).get(`/api/v1/releases/${release.id}`).expect(200);
    await request(app).get(`/api/v1/pages/${release.pages[0]!.id}/lesson`).expect(200);
    await request(app).get(`/api/v1/pages/${release.pages[1]!.id}/lesson`).expect(200);
    await request(app).get(`/api/v1/pages/${release.pages[0]!.id}/draft?view=snapshot`).expect(200);
  });

  it("locates imported page sources without copying unrelated full releases", async () => {
    const { app, readweave, release } = await seededApp();
    const scan = vi.spyOn(readweave, "listReleases").mockRejectedValue(new Error("FULL_LESSON_SCAN_FORBIDDEN"));
    const ownerRead = vi.spyOn(readweave, "getRelease");
    const snapshot = await request(app).get(`/api/v1/pages/${release.pages[0]!.id}/draft?view=snapshot`).expect(200);
    expect(snapshot.body.pageId).toBe(release.pages[0]!.id);
    expect(scan).not.toHaveBeenCalled();
    expect(ownerRead).toHaveBeenCalledWith(release.id);
    await request(app).get("/api/v1/pages/missing-import-page/draft?view=snapshot").expect(404);
  });

  it("previews matching ready formal replica drafts and keeps selected-question answers stable", async () => {
    const formalRelease = { ...testRelease(), lifecycle: "published" as const };
    const { app, dependencies, release } = await seededApp(undefined, formalRelease);
    const course: CourseProject = {
      id: release.courseId, workspaceId: "personal", title: release.courseTitle, status: "active",
      createdAt: release.publishedAt, updatedAt: release.publishedAt
    };
    const previewPage = structuredClone(release.pages[0]!);
    previewPage.blocks[0]!.markdown = "REPLICA FORMAL PREVIEW BODY";
    previewPage.questionBank = previewPage.questionBank!.map((item) => ({
      ...item,
      prompt: `REPLICA PREVIEW: ${item.prompt}`,
      version: item.version + 1,
      ...(item.kind === "comprehension" ? { expectedAnswer: "replica preview answer v1" } : {})
    }));
    const makeDraft = (revision: number, status: LessonDraft["status"], page: LessonDraft["page"]): LessonDraft => ({
      id: "draft:page-1", workspaceId: "personal", courseId: release.courseId, moduleId: release.moduleId,
      sourceReleaseId: release.id, pageId: "page-1", revision, status, page,
      changedBlockIds: page.blocks.map((block) => block.id), contentHash: `replica-preview-${revision}`,
      updatedAt: new Date(Date.UTC(2026, 9, revision)).toISOString()
    });
    const readyDraft = makeDraft(1, "ready", previewPage);
    const reading = new ReadingRuntime(join(dependencies.dataDir, "reading"), dependencies.readweave, "personal",
      "authority:app-spec-formal-preview", () => buildReadingTree([course], [], [], "personal"));
    await reading.initialize();
    await reading.replica.replace({
      courses: [course], releases: [release], drafts: [readyDraft],
      tree: buildReadingTree([course], [], [], "personal"), trash: []
    });
    dependencies.reading = reading;

    const existingReplicaSource = await reading.replica.getPageSource("personal", "page-1", release.id);
    expect(existingReplicaSource).toBeDefined();
    vi.spyOn(reading.replica, "getPageSource").mockResolvedValueOnce({
      ...existingReplicaSource!, draft: { ...readyDraft, sourceReleaseId: "wrong-release" }
    });
    const wrongRelease = await request(app).get("/api/v1/pages/page-1/lesson").expect(200);
    expect(wrongRelease.body.page).toEqual(release.pages[0]);
    expect(wrongRelease.body).not.toHaveProperty("unpublishedDraftRevision");

    const needsReview = makeDraft(2, "needs_review", previewPage);
    expect(await reading.replica.upsertDraft(needsReview)).toBe(true);
    const wrongStatus = await request(app).get("/api/v1/pages/page-1/lesson").expect(200);
    expect(wrongStatus.body.page).toEqual(release.pages[0]);
    expect(wrongStatus.body).not.toHaveProperty("unpublishedDraftRevision");

    const readyAgain = makeDraft(3, "ready", previewPage);
    expect(await reading.replica.upsertDraft(readyAgain)).toBe(true);
    const lesson = await request(app).get("/api/v1/pages/page-1/lesson").expect(200);
    expect(lesson.body).toMatchObject({ releaseId: release.id, page: previewPage, unpublishedDraftRevision: 3 });
    const session = await request(app).post("/api/v1/sessions").send({ courseReleaseId: release.id }).expect(201);
    const selected = await request(app).post("/api/v1/pages/page-1/questions:select").set("Idempotency-Key", "replica-formal-preview-select")
      .send({ sessionId: session.body.id, seed: "replica-formal-preview", count: 2 }).expect(201);
    expect(selected.body.questions.every((item: QuestionBankItem) => item.prompt.startsWith("REPLICA PREVIEW:"))).toBe(true);
    expect(selected.body.selection.questionSnapshots).toEqual(selected.body.questions);
    const selectedShortAnswer = selected.body.questions.find((item: QuestionBankItem) => item.kind === "comprehension") as QuestionBankItem;
    expect(selectedShortAnswer.expectedAnswer).toBe("replica preview answer v1");

    const updatedPage = {
      ...previewPage,
      questionBank: previewPage.questionBank!.map((item) => item.kind === "comprehension"
        ? { ...item, expectedAnswer: "replica preview answer v2", version: item.version + 1 }
        : item)
    };
    expect(await reading.replica.upsertDraft(makeDraft(4, "ready", updatedPage))).toBe(true);
    const attempted = await request(app).post("/api/v1/question-attempts").set("Idempotency-Key", "replica-formal-preview-attempt")
      .send({ selectionId: selected.body.selection.id, sessionId: session.body.id, courseReleaseId: release.id, pageId: "page-1",
        questionId: selectedShortAnswer.id, answer: selectedShortAnswer.expectedAnswer, usedHintLevel: 0 }).expect(201);
    expect(attempted.body.attempt).toMatchObject({ correct: true, questionVersion: selectedShortAnswer.version });
  });

  it("reports an ungenerated draft-source snapshot as non-retryable PAGE_NOT_GENERATED", async () => {
    const source = testRelease();
    source.lifecycle = "draft_source";
    source.pages[0]!.quality.issues = ["TEACHING_GENERATION_REQUIRED"];
    const { app, dependencies, readweave, release } = await seededApp(undefined, source);
    const course: CourseProject = {
      id: release.courseId, workspaceId: "personal", title: release.courseTitle, status: "active",
      createdAt: release.publishedAt, updatedAt: release.publishedAt
    };
    const reading = new ReadingRuntime(join(dependencies.dataDir, "reading"), readweave, "personal",
      "authority:app-spec-snapshot", () => buildReadingTree([course], [], [], "personal"));
    await reading.initialize();
    await reading.replica.replace({
      courses: [course], releases: [release], drafts: [],
      tree: buildReadingTree([course], [], [], "personal"), trash: []
    });
    dependencies.reading = reading;

    const response = await request(app).get("/api/v1/pages/page-1/draft?view=snapshot").expect(409);
    expect(response.body.error).toMatchObject({ code: "PAGE_NOT_GENERATED", retryable: false });
    const lesson = await request(app).get(`/api/v1/pages/page-1/lesson?releaseId=${release.id}`).expect(409);
    expect(lesson.body.error).toMatchObject({ code: "PAGE_NOT_GENERATED", retryable: false });
    const otherWorkspace = await request(app).get(`/api/v1/pages/page-1/lesson?releaseId=${release.id}`)
      .set("X-Workspace-Id", "another-workspace").expect(404);
    expect(otherWorkspace.body.error).toMatchObject({ code: "PAGE_NOT_FOUND", retryable: false });
  });

  it("adds passive Server-Timing phases to release indexes, draft snapshots, media reads and release details", async () => {
    const { app, dependencies, release } = await seededApp();

    const index = await request(app).get("/api/v1/releases?view=index").set("Accept-Encoding", "identity").expect(200);
    expect(index.headers["server-timing"]).toMatch(/index;dur=[\d.]+/);
    expect(index.headers["server-timing"]).toMatch(/source-course;dur=[\d.]+/);
    expect(index.headers["server-timing"]).toMatch(/trash;dur=[\d.]+/);
    expect(index.headers["server-timing"]).toMatch(/filter;dur=[\d.]+/);
    expect(index.headers["server-timing"]).toMatch(/serialize;dur=[\d.]+/);
    expect(index.body.map((item: { id: string }) => item.id)).toContain(release.id);

    const snapshot = await request(app).get(`/api/v1/pages/${release.pages[0]!.id}/draft?view=snapshot`).expect(200);
    expect(snapshot.headers["server-timing"]).toMatch(/source;dur=[\d.]+/);
    expect(snapshot.headers["server-timing"]).toMatch(/draft;dur=[\d.]+/);

    const mediaBytes = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
    const mediaRecord = await dependencies.cas.put(mediaBytes);
    const media = await request(app).get(`/api/v1/media/${mediaRecord.sha256}`).expect(200);
    expect(media.headers["server-timing"]).toMatch(/cas;dur=[\d.]+/);
    expect(media.body).toEqual(mediaBytes);

    const detail = await request(app).get(`/api/v1/releases/${release.id}`).expect(200);
    expect(detail.headers["server-timing"]).toMatch(/release;dur=[\d.]+/);
    expect(detail.body.id).toBe(release.id);
  });

  it("builds a current-release mastery map and replays review attempts idempotently", async () => {
    const { app, readweave, release } = await seededApp();
    const tree = await request(app).get("/api/v1/workspaces/personal/tree").expect(200);
    const material = tree.body.courses[0].children[0];
    await request(app).get(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}/properties`).expect(200).expect((response) => {
      expect(response.body).toMatchObject({ nodeId: material.id, kind: "material", title: material.title, pageCount: 1, syncState: "connected" });
    });
    await request(app).get(`/api/v1/tree/nodes/${encodeURIComponent("page-1")}/properties`).expect(200).expect((response) => {
      expect(response.body).toMatchObject({ nodeId: "page-1", kind: "page", sourceReleaseId: release.id });
    });
    const map = await request(app).get("/api/v1/review-map").expect(200);
    expect(map.body).toMatchObject({ releaseCount: 1, pageCount: 1, summary: { total: 1, due: 0, unseen: 1 } });
    expect(map.body.objectives[0]).toMatchObject({ objectiveId: "section-objective", releaseId: release.id, pageId: "page-1", state: "unseen", due: false });

    const created = await request(app).post("/api/v1/review-sessions").set("Idempotency-Key", "review-session-manual").send({ source: "manual", objectiveIds: ["section-objective"], seed: "review-seed" }).expect(201);
    expect(created.body.session).toMatchObject({ source: "manual", status: "active", currentObjectiveId: "section-objective" });
    const first = await request(app).post(`/api/v1/review-sessions/${created.body.session.id}/attempts`).set("Idempotency-Key", "review-attempt-1").send({ answer: "输入经过规则得到输出", usedHintLevel: 0 }).expect(201);
    expect(first.body).toMatchObject({ attempt: { correct: true, objectiveId: "section-objective" }, mastery: { state: "practicing", unaidedCorrect: true }, session: { status: "completed" } });
    const replay = await request(app).post(`/api/v1/review-sessions/${created.body.session.id}/attempts`).set("Idempotency-Key", "review-attempt-1").send({ answer: "重复提交不应再次推进", usedHintLevel: 0 }).expect(200);
    expect(replay.body).toMatchObject({ attempt: { id: first.body.attempt.id, correct: true }, session: { status: "completed" } });
    expect(await readweave.listQuestionAttempts()).toHaveLength(1);
    expect(await readweave.listAssessmentAttempts()).toHaveLength(1);
  });

  it("requires review selection before preparation and starts only a ready plan", async () => {
    const { app, operations, readweave } = await seededApp();
    await request(app).get("/api/v1/review-map").expect(200);
    expect((await operations.read()).reviewPlans).toHaveLength(0);
    expect((await operations.read()).reviewSessions).toHaveLength(0);
    await request(app).post("/api/v1/review-plans").set("Idempotency-Key", "review-plan-empty").send({ source: "manual", objectiveIds: [] }).expect(422);

    const created = await request(app).post("/api/v1/review-plans").set("Idempotency-Key", "review-plan-1").send({ source: "manual", objectiveIds: ["section-objective"], seed: "fixed-plan", budgetUsd: 4 }).expect(201);
    expect(created.body.plan).toMatchObject({ status: "ready", objectiveIds: ["section-objective"], cost: { reusedQuestionCount: 1, generatedQuestionCount: 0 } });
    expect(created.body.plan.items[0]).toMatchObject({ status: "ready", questionIds: ["q-c-1"] });
    expect(await readweave.getReviewPlan(created.body.plan.id)).toMatchObject({ status: "ready", revision: 1 });
    const replay = await request(app).post("/api/v1/review-plans").set("Idempotency-Key", "review-plan-1").send({ source: "manual", objectiveIds: ["section-objective"], seed: "different" }).expect(200);
    expect(replay.body.plan.id).toBe(created.body.plan.id);

    const started = await request(app).post(`/api/v1/review-plans/${encodeURIComponent(created.body.plan.id)}:start`).set("Idempotency-Key", "review-start-1").expect(201);
    expect(started.body.session).toMatchObject({ status: "active", reviewPlanId: created.body.plan.id, questionIdsByObjective: { "section-objective": ["q-c-1"] } });
    const startReplay = await request(app).post(`/api/v1/review-plans/${encodeURIComponent(created.body.plan.id)}:start`).set("Idempotency-Key", "review-start-1").expect(200);
    expect(startReplay.body.session.id).toBe(started.body.session.id);
  });

  it("keeps provider credentials server-side and validates workspace settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-api-settings-"));
    const app = createApp(createDefaultDependencies(root, new FileReadWeaveCourseApi(join(root, "readweave.json"))));
    const settings = await request(app).get("/api/v1/settings").expect(200);
    expect(settings.body).toMatchObject({ workspaceId: "personal", baseFontScale: 1.1 });
    const saved = await request(app).patch("/api/v1/settings").set("Idempotency-Key", "settings-save").send({ theme: "dark", baseFontScale: 1.3 }).expect(200);
    expect(saved.body).toMatchObject({ theme: "dark", baseFontScale: 1.3 });
    const credential = await request(app).put("/api/v1/model-providers/deepseek/credential").set("Idempotency-Key", "provider-secret").send({ secret: "synthetic-example-deepseek-token" }).expect(200);
    expect(credential.body).toMatchObject({ id: "deepseek", credential: { configured: true, maskedValue: "••••oken" } });
    expect(JSON.stringify(credential.body)).not.toContain("synthetic-example-deepseek-token");
    await request(app).patch("/api/v1/model-providers/deepseek").set("Idempotency-Key", "provider-config").send({ baseUrl: "http://external.example.invalid" }).expect(422);
    const providerConfig = await request(app).patch("/api/v1/model-providers/deepseek").set("Idempotency-Key", "provider-config-local").send({ baseUrl: "http://localhost:8045", enabled: true }).expect(200);
    expect(providerConfig.body).toMatchObject({ id: "deepseek", baseUrl: "http://localhost:8045", enabled: true });
    const providers = await request(app).get("/api/v1/model-providers").expect(200);
    expect(JSON.stringify(providers.body)).not.toContain("synthetic-example-deepseek-token");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "deepseek-flash" }] })
      : Response.json({ status: "completed", output_text: "{\"ok\":true}" }));
    expect((await request(app).post("/api/v1/model-providers/deepseek:test").expect(200)).body).toMatchObject({
      credential: { configured: true, maskedValue: "••••oken" }, health: { state: "connected" }
    });
  });

  it("creates, edits, reads and deletes a provider without resurrecting its default or credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-provider-crud-"));
    const dependencies = createDefaultDependencies(root, new FileReadWeaveCourseApi(join(root, "readweave.json")));
    const app = createApp(dependencies);
    const model = { id: "sample-model", displayName: "Sample Model", protocol: "responses", supportsVision: true,
      supportsJsonSchema: true, supportsReasoning: false, billingMode: "metered" };
    const created = await request(app).post("/api/v1/model-providers").set("Idempotency-Key", "provider-add")
      .send({ id: "sample-provider", displayName: "Sample", baseUrl: "https://api.example.org/v1", enabled: true, models: [model] }).expect(201);
    expect(created.body).toMatchObject({ id: "sample-provider", displayName: "Sample" });
    const replay = await request(app).post("/api/v1/model-providers").set("Idempotency-Key", "provider-add")
      .send({ id: "sample-provider", displayName: "Sample", baseUrl: "https://api.example.org/v1", enabled: true, models: [model] }).expect(201);
    expect(replay.body.id).toBe(created.body.id);
    await request(app).patch("/api/v1/model-providers/sample-provider").set("Idempotency-Key", "provider-edit")
      .send({ displayName: "Edited", models: [{ ...model, displayName: "Edited Model" }] }).expect(200);
    await request(app).put("/api/v1/model-providers/sample-provider/credential").set("Idempotency-Key", "provider-key")
      .send({ secret: "synthetic-provider-secret" }).expect(200);
    expect((await request(app).get("/api/v1/model-providers").expect(200)).body.find((item: { id: string }) => item.id === "sample-provider"))
      .toMatchObject({ displayName: "Edited", credential: { configured: true } });
    await request(app).delete("/api/v1/model-providers/sample-provider").set("Idempotency-Key", "provider-delete").expect(204);
    await request(app).delete("/api/v1/model-providers/sample-provider").set("Idempotency-Key", "provider-delete").expect(204);
    expect((await request(app).get("/api/v1/model-providers").expect(200)).body.some((item: { id: string }) => item.id === "sample-provider")).toBe(false);
    expect(await dependencies.credentialVault!.get("model-provider:sample-provider")).toBeUndefined();
    expect((await dependencies.operations.read()).modelProviders.find(item => item.id === "sample-provider")?.archived).toBe(true);
  });

  it("keeps native model and search routing inside Course OS instead of the ReadWeave adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-native-providers-"));
    const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
    vi.spyOn(readweave, "listModelProviders").mockRejectedValue(new Error("READWEAVE_PROVIDER_REGISTRY_MUST_NOT_BE_USED"));
    vi.spyOn(readweave, "getModelRoutePolicy").mockRejectedValue(new Error("READWEAVE_PROVIDER_ROUTE_MUST_NOT_BE_USED"));
    const dependencies = createDefaultDependencies(root, readweave);
    const app = createApp(dependencies);

    await dependencies.credentialVault!.set("model-provider:deepseek", "synthetic-existing-deepseek-token");
    await dependencies.credentialVault!.set("search-provider:tinyfish", "synthetic-existing-search-token");

    const models = await request(app).get("/api/v1/model-providers").expect(200);
    expect(models.body.find((provider: { id: string }) => provider.id === "kuafu")).toMatchObject({ enabled: false, baseUrl: "https://api.kuafushe.cc/v1" });
    expect(models.body.find((provider: { id: string }) => provider.id === "kimi-coding")).toMatchObject({
      enabled: false, baseUrl: "https://api.kimi.com/coding/v1",
      models: [expect.objectContaining({ id: "kimi-for-coding-highspeed", protocol: "chat_completions" })]
    });
    expect(models.body.find((provider: { id: string }) => provider.id === "codex")).toMatchObject({
      enabled: false, baseUrl: "",
      models: expect.arrayContaining([expect.objectContaining({ id: "gpt-5.6-luna", protocol: "responses" })])
    });
    expect(models.body.some((provider: { id: string }) => provider.id === "aialra-router")).toBe(false);
    expect(models.body.find((provider: { id: string }) => provider.id === "deepseek")).toMatchObject({
      credential: { configured: true, maskedValue: "••••" }, vault: { backend: "course_os_vault", state: "configured" }
    });
    expect(JSON.stringify(models.body)).not.toContain("synthetic-existing-deepseek-token");
    const modelPolicy = await request(app).get("/api/v1/model-route-policy").expect(200);
    expect(modelPolicy.body.routes.map((route: { providerId: string }) => route.providerId)).toEqual(["kuafu", "kuafu-backup", "opencode-go", "deepseek", "codex", "kimi-coding"]);
    await request(app).put("/api/v1/model-route-policy").set("Idempotency-Key", "invalid-duplicate-model-route")
      .send({ ...modelPolicy.body, routes: [modelPolicy.body.routes[0], modelPolicy.body.routes[0]] }).expect(422);
    await request(app).put("/api/v1/model-route-policy").set("Idempotency-Key", "valid-kuafu-backup-route")
      .send({ ...modelPolicy.body, routes: modelPolicy.body.routes.slice(0, 2) }).expect(200);
    const kuafuRoute = modelPolicy.body.routes.find((route: { providerId: string }) => route.providerId === "kuafu");
    const singleKuafuPolicy = await request(app).put("/api/v1/model-route-policy").set("Idempotency-Key", "delete-kuafu-backup-route")
      .send({ ...modelPolicy.body, routes: [kuafuRoute] }).expect(200);
    expect(singleKuafuPolicy.body.routes.map((route: { providerId: string }) => route.providerId)).toEqual(["kuafu"]);
    expect((await request(app).get("/api/v1/model-route-policy").expect(200)).body.routes).toEqual(singleKuafuPolicy.body.routes);
    const noOrderedRoutes = await request(app).put("/api/v1/model-route-policy").set("Idempotency-Key", "delete-last-model-route")
      .send({ ...singleKuafuPolicy.body, routes: [] }).expect(200);
    expect(noOrderedRoutes.body.routes).toEqual([]);
    expect((await request(app).get("/api/v1/model-route-policy").expect(200)).body).toMatchObject({
      routes: [], rules: modelPolicy.body.rules
    });
    const resolvedPolicy = await dependencies.operations.read();
    expect(resolvedPolicy.modelRoutePolicy.routes).toEqual([]);
    const providerFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toBe("https://api.deepseek.com/responses");
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "deepseek-flash" });
      return Response.json({ model: "deepseek-flash", output_text: JSON.stringify(testTeachingResult(0).content),
        usage: { input_tokens: 100, output_tokens: 200, total_cost: 0.001 } });
    });
    const routeResolver = providerRouterFromSettings({ load: async () => ({
      providers: resolvedPolicy.modelProviders,
      policy: modelRoutePolicyForRuntime(resolvedPolicy.modelRoutePolicy),
      credential: async () => "synthetic-route-resolver-token"
    }) });
    const routeResult = await routeResolver.generateTeachingPackage({
      pageTitle: "per-stage route fallback", pageNumber: 1, sourceText: "已知输入与处理规则",
      writingPolicySnapshotId: "route-fallback-test", language: "zh-CN", qualityMode: "balanced",
      idempotencyKey: "route-fallback-test"
    });
    expect(routeResult.provider).toBe("deepseek");
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(routeResult.usage.apiEquivalentUsd).toBe(0.002);

    const searches = await request(app).get("/api/v1/search-providers").expect(200);
    expect(searches.body.map((provider: { id: string }) => provider.id)).toEqual(["tinyfish", "octen", "openalex", "parallel", "exa", "jina", "serper"]);
    expect(searches.body.find((provider: { id: string }) => provider.id === "tinyfish")).toMatchObject({
      credential: { configured: true, maskedValue: "••••" }, vault: { backend: "course_os_vault", state: "configured" }
    });
    expect(JSON.stringify(searches.body)).not.toContain("synthetic-existing-search-token");
    await request(app).patch("/api/v1/search-providers/openalex").set("Idempotency-Key", "native-search-config")
      .send({ enabled: true, maxResults: 6 }).expect(200);
    const policy = await request(app).put("/api/v1/search-route-policy").set("Idempotency-Key", "native-search-policy")
      .send({ workspaceId: "personal", rules: [{ kind: "terminology", providerId: "openalex", enabled: true }], allowProviderFallback: false, maxResults: 6, updatedAt: new Date(0).toISOString() }).expect(200);
    expect(policy.body.rules).toEqual([{ kind: "terminology", providerId: "openalex", enabled: true }]);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
    expect((await request(app).post("/api/v1/search-providers/openalex:test").expect(200)).body).toMatchObject({
      credential: { configured: false }, health: { state: "connected" }
    });
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ results: [] }));
    expect((await request(app).post("/api/v1/search-providers/tinyfish:test").expect(200)).body).toMatchObject({
      credential: { configured: true, maskedValue: "••••" }, health: { state: "connected" }
    });
    expect(readweave.listModelProviders).not.toHaveBeenCalled();
    expect(readweave.getModelRoutePolicy).not.toHaveBeenCalled();
  });

  it("supports tree, optimistic draft editing, validation, conflicts and immutable publishing", async () => {
    const { app, release } = await seededApp();
    const tree = await request(app).get("/api/v1/workspaces/personal/tree").expect(200);
    expect(tree.body.courses[0]).toMatchObject({ title: "测试课程" });
    expect(tree.body.courses[0].children).toEqual([expect.objectContaining({ kind: "material", pageCount: 1 })]);
    expect(tree.body.trash).toMatchObject({ kind: "trash", title: "回收站" });

    const virtual = await request(app).get("/api/v1/pages/page-1/draft").expect(200);
    expect(virtual.body).toMatchObject({ revision: 0, pageId: "page-1" });
    const page = { ...virtual.body.page, title: "人工修订后的页面" };
    const saved = await request(app).patch("/api/v1/pages/page-1/draft").set("Idempotency-Key", "save-draft-1").send({ baseRevision: 0, page }).expect(200);
    expect(saved.body).toMatchObject({ revision: 1, status: "needs_review" });

    const validation = await request(app).post("/api/v1/pages/page-1:validate").expect(200);
    expect(validation.body).toMatchObject({ publishable: true, revision: 1 });

    const stale = await request(app).patch("/api/v1/pages/page-1/draft").set("Idempotency-Key", "save-draft-stale").send({ baseRevision: 0, page }).expect(409);
    expect(stale.body.error.details.conflictId).toContain("conflict:page-1:");
    expect((await request(app).get("/api/v1/conflicts").expect(200)).body).toHaveLength(1);

    const published = await request(app).post("/api/v1/releases").set("Idempotency-Key", "publish-v2").send({ baseReleaseId: release.id, releaseId: "test-release-v2" }).expect(201);
    expect(published.body).toMatchObject({ id: "test-release-v2", version: 2, modelRoute: "quality-gated-draft-v2" });
    expect((await request(app).get("/api/v1/releases/test-release-v2/manifest").expect(200)).body.courseReleaseId).toBe("test-release-v2");
  });

  it("promotes a valid edited draft to ready only when requested", async () => {
    const { app } = await seededApp();
    const virtual = await request(app).get("/api/v1/pages/page-1/draft").expect(200);
    const correctedPage = { ...virtual.body.page, title: "修订后的页面" };

    const firstSave = await request(app).patch("/api/v1/pages/page-1/draft").set("Idempotency-Key", "ready-draft-first-save")
      .send({ baseRevision: 0, page: correctedPage }).expect(200);
    expect(firstSave.body).toMatchObject({ revision: 1, status: "needs_review" });

    const promoted = await request(app).patch("/api/v1/pages/page-1/draft").set("Idempotency-Key", "ready-draft-promotion")
      .send({ baseRevision: 1, page: correctedPage, keepReady: true }).expect(200);
    expect(promoted.body).toMatchObject({ revision: 2, status: "ready" });

    const offlineMisconceptionsPage = {
      ...correctedPage,
      lessonSections: correctedPage.lessonSections.map((section: { kind: string; items?: unknown[] }) =>
        section.kind === "misconceptions" ? { ...section, items: [] } : section)
    };
    const recovered = await request(app).patch("/api/v1/pages/page-1/draft").set("Idempotency-Key", "ready-draft-offline-misconceptions")
      .send({ baseRevision: 2, page: offlineMisconceptionsPage, keepReady: true }).expect(200);
    expect(recovered.body).toMatchObject({ revision: 3, status: "ready" });
    expect((await request(app).post("/api/v1/pages/page-1:validate").expect(200)).body.issues)
      .toContain("misconceptions:ITEMS_REQUIRED");

    const invalidPage = {
      ...offlineMisconceptionsPage,
      blocks: offlineMisconceptionsPage.blocks.map((block: { id: string; markdown: string }, index: number) => index === 0
        ? { ...block, markdown: `${block.markdown}\n损坏公式 \\[x^2` }
        : block)
    };
    const rejected = await request(app).patch("/api/v1/pages/page-1/draft").set("Idempotency-Key", "ready-draft-invalid")
      .send({ baseRevision: 3, page: invalidPage, keepReady: true }).expect(422);
    expect(rejected.body.error.code).toBe("DRAFT_NOT_PUBLISHABLE");
    expect(rejected.body.error.details.issues.some((issue: string) => issue.includes("MATH_UNCLOSED_DISPLAY_DELIMITER"))).toBe(true);
    expect(await request(app).get("/api/v1/pages/page-1/draft").then((response) => response.body)).toMatchObject({ revision: 3, status: "ready" });
  });

  it("rejects a draft PATCH pinned to another release without mutating the saved draft", async () => {
    const { app, readweave, release } = await seededApp();
    const virtual = await request(app).get("/api/v1/pages/page-1/draft").expect(200);
    const saved = await request(app).patch("/api/v1/pages/page-1/draft").set("Idempotency-Key", "draft-release-owner")
      .send({ baseRevision: 0, page: virtual.body.page }).expect(200);
    const otherRelease = { ...structuredClone(release), id: "test-release-v2", version: 2 };
    await readweave.publishRelease(otherRelease, testManifest(otherRelease.id), {
      idempotencyKey: "publish-draft-release-conflict",
      actor: "test",
      workspaceId: "personal",
      schemaVersion: "2.4.0",
      requestId: "publish-draft-release-conflict"
    });
    const before = await readweave.getDraftByPage("page-1");

    const rejected = await request(app).patch("/api/v1/pages/page-1/draft").set("Idempotency-Key", "draft-wrong-release")
      .send({ baseRevision: saved.body.revision, page: { ...saved.body.page, title: "错误版本的修改" }, releaseId: otherRelease.id })
      .expect(409);

    expect(rejected.body.error).toMatchObject({ code: "DRAFT_RELEASE_CONFLICT", retryable: false });
    expect(await readweave.getDraftByPage("page-1")).toEqual(before);
    expect(before).toMatchObject({ sourceReleaseId: release.id, revision: 1 });
  });

  it("patches a confirmed replica draft when remote release and draft preflight reads are unavailable", async () => {
    const { app, readweave, release, draft } = await seededReplicaDraftApp();
    const releaseRead = vi.spyOn(readweave, "getRelease").mockRejectedValue(new Error("READ_DEADLINE_EXCEEDED:release-index"));
    const draftRead = vi.spyOn(readweave, "getDraftByPage").mockRejectedValue(new Error("READ_DEADLINE_EXCEEDED:draft-read"));
    const save = vi.spyOn(readweave, "saveDraft");
    const page = { ...draft.page, title: "副本离线时恢复的人工修订" };

    const patched = await request(app).patch("/api/v1/pages/page-1/draft")
      .set("X-Workspace-Id", "personal").set("Idempotency-Key", "replica-preflight-save")
      .send({ baseRevision: draft.revision, releaseId: release.id, page, keepReady: true }).expect(200);

    expect(patched.body).toMatchObject({ revision: draft.revision + 1, status: "ready", page: { title: page.title } });
    expect(releaseRead).not.toHaveBeenCalled();
    expect(draftRead).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[1]).toBe(draft.revision);

    releaseRead.mockRestore();
    draftRead.mockRestore();
    save.mockRestore();
    expect(await readweave.getDraftByPage("page-1")).toMatchObject({ revision: draft.revision + 1, page: { title: page.title } });
  });

  it("keeps authoritative draft CAS conflicts when the replica preflight is stale", async () => {
    const { app, readweave, release, draft } = await seededReplicaDraftApp();
    const authoritativePage = { ...draft.page, title: "权威端已先保存的版本" };
    await readweave.saveDraft({ ...draft, page: authoritativePage, contentHash: "authoritative-revision-3" }, draft.revision, {
      idempotencyKey: "authority-advances-after-replica", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "authority-advances-after-replica"
    });
    const releaseRead = vi.spyOn(readweave, "getRelease").mockRejectedValue(new Error("READ_DEADLINE_EXCEEDED:release-index"));
    const draftRead = vi.spyOn(readweave, "getDraftByPage").mockRejectedValue(new Error("READ_DEADLINE_EXCEEDED:draft-read"));
    const save = vi.spyOn(readweave, "saveDraft");

    const rejected = await request(app).patch("/api/v1/pages/page-1/draft")
      .set("X-Workspace-Id", "personal").set("Idempotency-Key", "replica-preflight-stale-cas")
      .send({ baseRevision: draft.revision, releaseId: release.id, page: { ...draft.page, title: "陈旧副本的覆盖尝试" } }).expect(409);

    expect(rejected.body.error.details.conflictId).toContain("conflict:page-1:");
    expect(releaseRead).not.toHaveBeenCalled();
    expect(draftRead).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
    releaseRead.mockRestore();
    draftRead.mockRestore();
    save.mockRestore();
    expect(await readweave.getDraftByPage("page-1")).toMatchObject({ revision: draft.revision + 1, page: { title: authoritativePage.title } });
  });

  it("does not write a confirmed draft through a different workspace", async () => {
    const { app, readweave, release, draft } = await seededReplicaDraftApp();
    const save = vi.spyOn(readweave, "saveDraft");

    await request(app).patch("/api/v1/pages/page-1/draft")
      .set("X-Workspace-Id", "another-workspace").set("Idempotency-Key", "replica-preflight-wrong-workspace")
      .send({ baseRevision: draft.revision, releaseId: release.id, page: { ...draft.page, title: "跨工作区修改" } }).expect(404);

    expect(save).not.toHaveBeenCalled();
    expect(await readweave.getDraftByPage("page-1")).toMatchObject({ revision: draft.revision, page: { title: draft.page.title } });
  });
});

async function waitForImport(app: ReturnType<typeof createApp>, importId: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const current = await request(app).get(`/api/v1/imports/${importId}`).expect(200);
    if (["ready", "failed", "rejected"].includes(current.body.state)) return current.body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("IMPORT_TEST_TIMEOUT");
}

async function waitForJob(app: ReturnType<typeof createApp>, jobId: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const current = await request(app).get(`/api/v1/generation-jobs/${jobId}`).expect(200);
    if (["completed", "failed", "cancelled"].includes(current.body.state)) return current.body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("GENERATION_TEST_TIMEOUT");
}

async function waitForPlan(app: ReturnType<typeof createApp>, planId: string) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const current = await request(app).get(`/api/v1/generation-plans/${planId}`).expect(200);
    if (["awaiting_review", "completed", "failed", "cancelled"].includes(current.body.plan.state)) return current.body.plan;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("GENERATION_PLAN_TEST_TIMEOUT");
}

function testReleaseWithPages(count: number): CourseRelease {
  const release = testRelease();
  const firstPage = release.pages[0]!;
  const sourceIds = collectTestObjectIds(firstPage);
  const pages = Array.from({ length: count }, (_, index) => {
    let page = replaceTestIds(structuredClone(firstPage), "page-1", `page-${index + 1}`);
    if (index > 0) for (const sourceId of sourceIds) if (sourceId !== "page-1") page = replaceTestIds(page, sourceId, `${sourceId}:page:${index + 1}`);
    return page;
  });
  pages.forEach((page, index) => {
    page.pageNumber = index + 1;
    page.title = `测试页面 ${index + 1}`;
  });
  release.pageIds = pages.map((page) => page.id);
  release.pages = pages;
  return release;
}

function collectTestObjectIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectTestObjectIds);
  if (!value || typeof value !== "object") return [];
  const result: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "id" && typeof child === "string" && child) result.push(child);
    result.push(...collectTestObjectIds(child));
  }
  return result;
}

function replaceTestIds<T>(value: T, from: string, to: string): T {
  if (typeof value === "string") return value.split(from).join(to) as T;
  if (Array.isArray(value)) return value.map((item) => replaceTestIds(item, from, to)) as T;
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) result[key] = replaceTestIds(child, from, to);
    return result as T;
  }
  return value;
}

function testRelease(): CourseRelease {
  return {
    id: "test-release-v1",
    courseId: "test-course",
    courseTitle: "测试课程",
    moduleId: "module-1",
    moduleTitle: "第一章",
    version: 1,
    publishedAt: "2026-08-29T00:00:00.000Z",
    pageIds: ["page-1"],
    pages: [{
      id: "page-1",
      pageNumber: 1,
      title: "原始页面",
      imageUrl: "/page.png",
      anchors: [{ id: "source-anchor-1", pageId: "page-1", kind: "text", label: "测试原始课件文字", text: "输入经过规则处理得到输出，执行前需要确认输入满足条件，执行后核对输出与目标" }],
      atoms: [],
      blocks: [{ id: "block-1", title: "核心解释", kind: "core", markdown: "原始讲解", sourceAnchorIds: [], atomIds: [] }],
      lessonSections: [
        { id: "section-objective", kind: "learning_objectives", title: "学习目标", items: [{ id: "objective-1", text: "能够解释测试页面的核心概念", sourceAnchorIds: [] }], sourceAnchorIds: [], atomIds: [] },
        { id: "section-main", kind: "main_content", title: "主要内容", markdown: "测试页面说明输入、规则和输出之间的关系", sourceAnchorIds: [], atomIds: [] },
        { id: "section-prior", kind: "prior_knowledge", title: "先验知识列表", items: [{ id: "prior-1", text: "先知道输入和输出分别代表什么", sourceAnchorIds: [] }], sourceAnchorIds: [], atomIds: [] },
        { id: "section-full", kind: "full_explanation", title: "完整讲解", markdown: "测试页面从输入开始，按照明确规则得到输出，并用一个例子检查结果", sourceAnchorIds: [], atomIds: [] },
        { id: "section-misconception", kind: "misconceptions", title: "易错点列表", items: [{ id: "misconception-1", text: "不要跳过输入条件直接套用结论", sourceAnchorIds: [] }], sourceAnchorIds: [], atomIds: [] }
      ],
      questionBank: [
        { id: "q-c-1", pageId: "page-1", objectiveId: "section-objective", kind: "comprehension", prompt: "核心关系是什么", expectedAnswer: "输入经过规则得到输出", explanation: "先识别输入，再执行规则，最后核对输出", sourceAnchorIds: [], status: "approved", version: 1, generatedBy: "test" },
        { id: "q-c-2", pageId: "page-1", objectiveId: "section-objective", kind: "comprehension", prompt: "为什么要检查前提", expectedAnswer: "前提决定规则是否适用", explanation: "缺少前提时不能直接使用结论", sourceAnchorIds: [], status: "approved", version: 1, generatedBy: "test" },
        { id: "q-m-1", pageId: "page-1", objectiveId: "section-objective", kind: "multiple_choice", prompt: "第一步应该做什么", options: ["识别输入", "忽略条件", "直接写结论", "只看标题"], expectedAnswer: "识别输入", explanation: "输入决定后续规则", sourceAnchorIds: [], status: "approved", version: 1, generatedBy: "test" },
        { id: "q-m-2", pageId: "page-1", objectiveId: "section-objective", kind: "multiple_choice", prompt: "最后一步应该做什么", options: ["核对输出", "删除规则", "忽略结果", "改变题意"], expectedAnswer: "核对输出", explanation: "输出需要回到目标检查", sourceAnchorIds: [], status: "approved", version: 1, generatedBy: "test" }
      ],
      coverageRequirements: [],
      coverageClaims: [],
      quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable: true, issues: [] }
    }],
    assessments: [],
    manifestHash: "manifest-hash-v1",
    writingPolicySnapshotId: "policy-v1",
    modelRoute: "deterministic-test",
    qualityHarnessVersion: "quality-v1",
    costUsd: 0
  };
}

function testManifest(releaseId: string): ReleaseManifest {
  return {
    id: `${releaseId}:manifest`,
    schemaVersion: "2.1.0",
    courseReleaseId: releaseId,
    sourceHashes: [],
    pageHashes: [],
    explanationHashes: [],
    assessmentHashes: [],
    writingPolicySnapshotId: "policy-v1",
    modelRoutes: ["deterministic-test"],
    qualityHarnessVersion: "quality-v1",
    costInputs: [],
    createdAt: "2026-08-29T00:00:00.000Z"
  };
}

function testTeachingResult(apiEquivalentUsd: number): TeachingGenerationResult {
  return {
    provider: "aialra-model-router" as const,
    model: "gpt-5.6-terra",
    usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 200, apiEquivalentUsd, durationMs: 500 },
    content: {
      learningObjectives: ["能够说明输入、处理规则和输出之间的关系"],
      mainContentMarkdown: "- 先识别输入并检查前提\n- 再按照规则处理对象\n- 最后检查输出是否满足目标",
      priorKnowledge: ["输入与输出：输入是规则处理之前已经确认的对象和条件，输出是执行规则后得到的结果；先把两者分开，才能判断处理过程有没有达到目标；规则按照已经确认的输入改变对象的状态，不能拿结果代替处理过程；当需要核对处理结果时，先明确输入条件，再比较输出与目标是否一致"],
      fullExplanationMarkdown: [
        "## 一次完整演算\n\n把输入设为 $2$，规则设为增加 $3$，这是用于说明步骤的教学示例\n\n1. 先确认输入是已经知道的 $2$\n2. 按规则计算 $2+3=5$，得到中间处理结果\n3. 检查输出 $5$ 与增加 $3$ 的目标是否一致\n\n如果输入没有给出，只能写出增加的规则，不能提前宣布输出已经确定",
        "## 输入、规则和输出\n这页要把输入、处理规则和输出连成一条可以检查的流程，读者最后要能说明每一步为什么发生\n输入是处理开始前已经知道的信息，规则限定允许执行的步骤，输出是处理结束后的结果",
        "## 状态怎样向前推进\n先确认输入，再按规则处理对象，处理过程会把状态推进到新的结果，最后必须把输出和目标重新比较\n假设输入已经满足前提，先记录初始状态，再执行规则并写出中间状态，最后检查结果是否满足目标",
        "## 不能跳过的检查\n如果输入条件缺失，规则就不能直接套用，输出看起来合理也不能替代前提检查；只看最后数字会漏掉过程中的错误\n下一步应回到具体输入，逐项核对对象、规则、状态变化和结果"
      ].join("\n\n"),
      misconceptions: ["错误地跳过输入条件直接套用结论，因为规则只对满足前提的对象有效；正确做法是先检查输入和条件，再核对输出是否达到目标"],
      coverageEvidence: [],
      questions: [
        { kind: "comprehension" as const, prompt: "输入决定了什么", options: [], expectedAnswer: "输入决定处理对象", explanation: "先确认输入对象及其满足的条件，再把规则作用于这个对象；如果输入没有确定，就无法判断规则是否适用，也无法核对处理后的输出是否对应目标" },
        { kind: "comprehension" as const, prompt: "为什么检查输出", options: [], expectedAnswer: "确认结果满足目标", explanation: "执行完规则只表示处理过程结束，不能保证结果符合目标；需要把得到的输出与预先确定的目标逐项比较，发现差异时回到输入和处理步骤查原因" },
        { kind: "multiple_choice" as const, prompt: "第一步应该做什么", options: ["识别输入", "忽略条件", "直接结论", "删除规则"], expectedAnswer: "识别输入", explanation: "正确选项是识别输入，因为规则必须有明确的处理对象；直接写结论会跳过输入条件，无法判断处理结果从哪里来，也不能检查规则是否适用" },
        { kind: "multiple_choice" as const, prompt: "最后一步应该做什么", options: ["核对输出", "忽略目标", "删除结果", "改变题意"], expectedAnswer: "核对输出", explanation: "正确选项是核对输出，因为结果还要与目标和条件比较；忽略目标只看输出数值，无法判断处理是否成功，改变题意更不能替代结果检验" }
      ]
    }
  };
}

function testGenerationCost(jobId: string, release: CourseRelease, pageId: string): GenerationCostEntry {
  return {
    id: `cost:${jobId}:fence:1:attempt:1:${pageId}:teach`, workspaceId: "personal", courseId: release.courseId,
    materialVersionId: release.id, pageId, objectId: `draft:${pageId}`, jobId, stage: "teach",
    provider: "aialra-model-router", model: "gpt-5.6-terra", inputTokens: 100, outputTokens: 200, cachedInputTokens: 0,
    unitPriceSnapshot: { id: "test-price", provider: "aialra-model-router", model: "gpt-5.6-terra", currency: "USD",
      capturedAt: "2026-09-24T00:00:00.000Z", source: "test", inputMicrousdPerMillion: 0,
      outputMicrousdPerMillion: 0, cachedInputMicrousdPerMillion: 0 },
    estimatedMicrousd: 25_000, actualMicrousd: 25_000, durationMs: 500, retries: 0, status: "succeeded",
    qualityPassed: true, billingMode: "metered", cashCostMicrousd: 25_000, quotaConsumedMicrousd: 0,
    estimatedCashCostMicrousd: 25_000, estimatedQuotaConsumedMicrousd: 0, costBasis: "provider_reported",
    createdAt: "2026-09-24T00:00:00.000Z"
  };
}
