import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileReadWeaveCourseApi } from "@course-os/readweave-adapter";
import type { ConversionRequest, ConversionResult, LessonDraft, PdfLayoutInspection, PdfLayoutSelection } from "@course-os/contracts";
import { buildReadingTree, createApp, createDefaultDependencies } from "./app.js";
import type { ModelRouterClient } from "./model-router.js";
import { ReadingRuntime } from "./reading-runtime.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("PDF layout import integration", () => {
  it("retries a failed conversion only with a new operation key and retains the import identity", async () => {
    const fixture = await createFixture();
    const original = fixture.dependencies.conversion;
    const requestIds: string[] = [];
    fixture.dependencies.conversion = { enqueueAndWait: async input => {
      requestIds.push(input.id);
      if (requestIds.length === 1) return { requestId: input.id, state: "failed", pages: [], issues: ["CONVERSION_PROCESS_FAILED"],
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
      return original.enqueueAndWait(input);
    } };
    const bytes = syntheticPdf("retry-same-import");
    const first = await postPdf(fixture.app, bytes, { idempotencyKey: "failed-conversion-original" }).expect(201);
    expect((await waitForImport(fixture.app, first.body.id)).state).toBe("failed");
    const replay = await postPdf(fixture.app, bytes, { idempotencyKey: "failed-conversion-original" }).expect(200);
    expect(replay.body.state).toBe("failed");
    expect(requestIds).toHaveLength(1);
    const retry = await postPdf(fixture.app, bytes, { idempotencyKey: "failed-conversion-explicit-retry" }).expect(200);
    expect(retry.body.id).toBe(first.body.id);
    const ready = await waitForImport(fixture.app, first.body.id);
    expect(ready.state).toBe("ready");
    expect(requestIds).toHaveLength(2);
    expect(requestIds[1]).not.toBe(requestIds[0]);
    expect(ready.attemptStartedAt).not.toBe(ready.createdAt);
    expect(fixture.modelCall).not.toHaveBeenCalled();
    expect((await fixture.dependencies.operations.read()).imports).toHaveLength(1);
  });

  it("scopes identical PDF page IDs by workspace and import while deduplicating within one workspace", async () => {
    const fixture = await createFixture();
    const bytes = syntheticPdf("same-pdf-across-workspaces");
    const workspaceA = "personal";
    const workspaceB = "same-pdf-workspace-b";

    const firstResponse = await postPdf(fixture.app, bytes, {
      idempotencyKey: "same-pdf-workspace-a-first", workspaceId: workspaceA
    }).expect(201);
    const first = await waitForImport(fixture.app, firstResponse.body.id, workspaceA);
    expect(first.state).toBe("ready");

    const secondResponse = await postPdf(fixture.app, bytes, {
      idempotencyKey: "same-pdf-workspace-b-first", workspaceId: workspaceB
    }).expect(201);
    const second = await waitForImport(fixture.app, secondResponse.body.id, workspaceB);
    expect(second.state).toBe("ready");
    expect(second.issues).not.toContain("READWEAVE_IMPORT_DRAFT_CONFLICT");

    const firstSource = await fixture.readweave.getRelease(first.materialVersionId);
    const secondSource = await fixture.readweave.getRelease(second.materialVersionId);
    expect(firstSource?.pageIds).toEqual(first.pageIds);
    expect(secondSource?.pageIds).toEqual(second.pageIds);
    expect(first.pageIds).toHaveLength(1);
    expect(second.pageIds).toHaveLength(1);
    expect(first.pageIds[0]).not.toBe(second.pageIds[0]);

    const repeatedResponse = await postPdf(fixture.app, bytes, {
      idempotencyKey: "same-pdf-workspace-a-dedup", workspaceId: workspaceA
    }).expect(200);
    const repeated = await waitForImport(fixture.app, repeatedResponse.body.id, workspaceA);
    expect(repeated.id).toBe(first.id);
    expect(repeated.pageIds).toEqual(first.pageIds);
    expect((await fixture.dependencies.operations.read()).imports).toHaveLength(2);
  }, 30_000);

  it("resumes an existing source with the same page IDs and preserves its saved draft", async () => {
    const fixture = await createFixture();
    const originalSaveDraft = fixture.readweave.saveDraft.bind(fixture.readweave);
    let failSecondPageOnce = true;
    vi.spyOn(fixture.readweave, "saveDraft").mockImplementation(async (draft, expectedRevision, context, sourceAsset) => {
      if (draft.page.pageNumber === 2 && failSecondPageOnce) {
        failSecondPageOnce = false;
        throw new Error("READWEAVE_UNAVAILABLE_INJECTED_AFTER_SOURCE_REGISTER");
      }
      return originalSaveDraft(draft, expectedRevision, context, sourceAsset);
    });
    const bytes = syntheticPdf("same-import-resume-source");
    const layout: PdfLayoutSelection = { mode: "auto" };
    const firstResponse = await postPdf(fixture.app, bytes, {
      idempotencyKey: "same-import-resume-first", layout
    }).expect(201);
    const failed = await waitForImport(fixture.app, firstResponse.body.id);
    expect(failed.state).toBe("failed");

    const materialVersionId = `material-version:${failed.id}`;
    const firstSource = await fixture.readweave.getRelease(materialVersionId);
    expect(firstSource).toBeDefined();
    if (!firstSource) throw new Error("PDF_IMPORT_SOURCE_NOT_REGISTERED_BEFORE_RETRY");
    expect(firstSource.pageIds).toHaveLength(2);
    const firstDraft = await fixture.readweave.getDraftByPage(firstSource.pageIds[0]!);
    expect(firstDraft).toBeDefined();
    if (!firstDraft) throw new Error("PDF_IMPORT_FIRST_DRAFT_NOT_SAVED_BEFORE_RETRY");

    const answeredPage = structuredClone(firstDraft.page);
    const core = answeredPage.blocks.find(block => block.kind === "core");
    if (!core) throw new Error("PDF_IMPORT_TEST_CORE_BLOCK_MISSING");
    core.markdown = `${core.markdown}\n\nExisting reviewed draft must survive retry.`;
    const reviewedDraft = await fixture.readweave.saveDraft({
      ...firstDraft,
      page: answeredPage,
      changedBlockIds: [...new Set([...firstDraft.changedBlockIds, core.id])],
      contentHash: createHash("sha256").update(JSON.stringify(answeredPage)).digest("hex"),
      updatedAt: new Date().toISOString()
    }, firstDraft.revision, {
      idempotencyKey: "same-import-resume-preserve-draft",
      actor: "test",
      workspaceId: "personal",
      schemaVersion: "2.4.0",
      requestId: "same-import-resume-preserve-draft"
    });

    // Model a source saved before scoped import identities and the shared
    // unclassified course existed. Retry must retain its whole page objects.
    const legacyOwner = await request(fixture.app).post("/api/v1/courses")
      .set("X-Workspace-Id", "personal")
      .set("Idempotency-Key", "same-import-legacy-owner")
      .send({ id: "pdf-layout-legacy-import-owner", title: "Legacy import owner" })
      .expect(201);
    const authorityPath = join(fixture.dependencies.dataDir, "readweave.json");
    const authority = JSON.parse(await readFile(authorityPath, "utf8"));
    const legacyPageIds = firstSource.pageIds.map((_, index) => `page:legacy-pdf-layout-source:${index + 1}`);
    const keepLegacyReferences = <T,>(value: T): T => {
      let serialized = JSON.stringify(value);
      firstSource.pageIds.forEach((id, index) => { serialized = serialized.replaceAll(id, legacyPageIds[index]!); });
      return JSON.parse(serialized);
    };
    authority.releases = authority.releases.map((release: typeof firstSource) => release.id !== materialVersionId ? release : {
      ...keepLegacyReferences(release), courseId: legacyOwner.body.id,
      courseTitle: legacyOwner.body.title, moduleId: "legacy-import-module"
    });
    authority.drafts = authority.drafts.map((draft: LessonDraft) => draft.sourceReleaseId !== materialVersionId ? draft : {
      ...keepLegacyReferences(draft), courseId: legacyOwner.body.id, moduleId: "legacy-import-module"
    });
    await writeFile(authorityPath, JSON.stringify(authority), "utf8");
    const preservedDraft = await fixture.readweave.getDraftByPage(legacyPageIds[0]!);
    expect(preservedDraft).toBeDefined();

    const retryResponse = await postPdf(fixture.app, bytes, {
      idempotencyKey: "same-import-resume-retry", layout
    }).expect(200);
    const ready = await waitForImport(fixture.app, retryResponse.body.id);
    expect(ready.state).toBe("ready");
    expect(ready.id).toBe(failed.id);
    expect(ready.pageIds).toEqual(legacyPageIds);
    const resumedSource = await fixture.readweave.getRelease(materialVersionId);
    expect(resumedSource).toMatchObject({ pageIds: legacyPageIds, courseId: legacyOwner.body.id, moduleId: "legacy-import-module" });
    const resumedDraft = await fixture.readweave.getDraftByPage(legacyPageIds[0]!);
    expect(resumedDraft).toMatchObject({
      id: preservedDraft!.id,
      revision: reviewedDraft.revision,
      contentHash: reviewedDraft.contentHash,
      page: { blocks: expect.arrayContaining([expect.objectContaining({
        id: keepLegacyReferences(core).id, markdown: expect.stringContaining("Existing reviewed draft must survive retry.")
      })]) }
    });
    expect(resumedDraft?.page).toEqual(preservedDraft?.page);
  }, 30_000);

  it("returns an inspection preview without creating an import, generation task, course, or model call", async () => {
    const fixture = await createFixture();
    const response = await request(fixture.app).post("/api/v1/imports:inspect")
      .field("pdfLayout", JSON.stringify({ mode: "auto" }))
      .attach("file", syntheticPdf("inspection-only"), { filename: "inspection.pdf", contentType: "application/pdf" })
      .expect(200);

    expect(response.body).toMatchObject({
      version: "synthetic-layout-v1",
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      physicalPageCount: 1,
      logicalPageCount: 2,
      pages: [{ physicalPage: 1, mode: "top-bottom", regions: expect.any(Array) }],
      previews: [{ physicalPage: 1, imageDataUrl: expect.stringMatching(/^data:image\/svg\+xml;base64,/) }]
    });
    expect(fixture.conversion.executions).toHaveLength(1);
    expect(fixture.conversion.executions[0]).toMatchObject({ kind: "pdf", purpose: "inspect", pdfLayout: { mode: "auto" } });

    const state = await fixture.dependencies.operations.read();
    expect(state.imports).toEqual([]);
    expect(state.jobs).toEqual([]);
    expect(state.generationPlans).toEqual([]);
    expect(fixture.modelCall).not.toHaveBeenCalled();
    expect(await fixture.readweave.listCourses()).toEqual([]);
    expect(await fixture.readweave.listReleases()).toEqual([]);
  });

  it("rejects a missing file, a non-PDF, and a layout choice outside the inspected document", async () => {
    const fixture = await createFixture();

    const missing = await request(fixture.app).post("/api/v1/imports:inspect").expect(400);
    expect(missing.body.error.code).toBe("FILE_REQUIRED");

    const wrongType = await request(fixture.app).post("/api/v1/imports:inspect")
      .attach("file", Buffer.from("# This is a text document"), { filename: "notes.md", contentType: "text/markdown" })
      .expect(422);
    expect(wrongType.body.error.code).toBe("PDF_INSPECTION_REJECTED");
    expect(fixture.conversion.requests).toEqual([]);

    const unsafe = await postPdf(fixture.app, syntheticPdf("unsafe-selection"), {
      idempotencyKey: "pdf-layout-unsafe-selection",
      layout: { mode: "auto", choices: { "2": "top-bottom" } }
    }).expect(422);
    expect(unsafe.body.error.code).toBe("PDF_LAYOUT_UNAVAILABLE");

    const state = await fixture.dependencies.operations.read();
    expect(state.imports).toEqual([]);
    expect(state.jobs).toEqual([]);
    expect(state.generationPlans).toEqual([]);
    expect(fixture.modelCall).not.toHaveBeenCalled();
    expect(fixture.conversion.executions.filter((item) => item.purpose === "inspect")).toHaveLength(1);
    expect(fixture.conversion.executions.filter((item) => item.purpose !== "inspect")).toEqual([]);
    expect(await fixture.readweave.listCourses()).toEqual([]);
    expect(await fixture.readweave.listReleases()).toEqual([]);
  });

  it("deduplicates the same automatic plan while keeping original-layout imports and page IDs separate", async () => {
    const fixture = await createFixture();
    const source = syntheticPdf("same-source-two-layouts");
    const autoLayout: PdfLayoutSelection = { mode: "auto" };

    const firstAuto = await postPdf(fixture.app, source, {
      idempotencyKey: "pdf-layout-auto-first",
      layout: autoLayout
    }).expect(201);
    const auto = await waitForImport(fixture.app, firstAuto.body.id);
    expect(auto.state).toBe("ready");

    const repeatedAuto = await postPdf(fixture.app, source, {
      idempotencyKey: "pdf-layout-auto-repeat",
      layout: autoLayout
    }).expect(200);
    expect(repeatedAuto.body.id).toBe(auto.id);

    const originalResponse = await postPdf(fixture.app, source, {
      idempotencyKey: "pdf-layout-original",
      layout: { mode: "original" }
    }).expect(201);
    const original = await waitForImport(fixture.app, originalResponse.body.id);
    expect(original.state).toBe("ready");

    expect(auto.id).not.toBe(original.id);
    expect(auto.layoutFingerprint).toBeTruthy();
    expect(original.layoutFingerprint).toBeUndefined();
    expect(auto.pageIds).toHaveLength(2);
    expect(original.pageIds).toHaveLength(1);
    expect(auto.pageIds).not.toEqual(original.pageIds);
    expect(auto.pageIds.every((pageId: string) => !original.pageIds.includes(pageId))).toBe(true);

    const state = await fixture.dependencies.operations.read();
    expect(state.imports).toHaveLength(2);
    expect(state.jobs).toEqual([]);
    expect(state.generationPlans).toEqual([]);
    const inspectionCalls = fixture.conversion.requests.filter((item) => item.purpose === "inspect");
    expect(inspectionCalls.length).toBeGreaterThan(0);
    expect(new Set(inspectionCalls.map((item) => item.id)).size).toBe(1);
    expect(fixture.conversion.executions.filter((item) => item.purpose === "inspect")).toHaveLength(1);
    expect(fixture.conversion.executions.filter((item) => item.purpose !== "inspect")).toHaveLength(2);
    expect([...fixture.conversion.executionCounts.values()].every((count) => count === 1)).toBe(true);
    expect(fixture.modelCall).not.toHaveBeenCalled();
    expect((await fixture.readweave.getRelease(auto.materialVersionId))?.costUsd).toBe(0);
    expect((await fixture.readweave.getRelease(original.materialVersionId))?.costUsd).toBe(0);
  }, 30_000);

  it("shares one unclassified course per workspace and preserves an explicitly selected course", async () => {
    const fixture = await createFixture();
    // Keep the migration fixture where FileReadWeave exposes trash records.
    const workspaceA = "personal";
    const workspaceB = "pdf-layout-workspace-b";
    const explicitCourse = await request(fixture.app).post("/api/v1/courses")
      .set("X-Workspace-Id", workspaceA)
      .set("Idempotency-Key", "pdf-layout-create-explicit-course")
      .send({ id: "pdf-layout-explicit-course", title: "指定课程" })
      .expect(201);

    const firstResponse = await postPdf(fixture.app, syntheticPdf("unclassified-first"), {
      idempotencyKey: "pdf-layout-unclassified-first", workspaceId: workspaceA
    }).expect(201);
    const first = await waitForImport(fixture.app, firstResponse.body.id, workspaceA);
    const secondResponse = await postPdf(fixture.app, syntheticPdf("unclassified-second"), {
      idempotencyKey: "pdf-layout-unclassified-second", workspaceId: workspaceA
    }).expect(201);
    const second = await waitForImport(fixture.app, secondResponse.body.id, workspaceA);

    const explicitResponse = await postPdf(fixture.app, syntheticPdf("explicit-course-file"), {
      idempotencyKey: "pdf-layout-explicit-course-import",
      workspaceId: workspaceA,
      courseId: explicitCourse.body.id
    }).expect(201);
    const explicitlyPlaced = await waitForImport(fixture.app, explicitResponse.body.id, workspaceA);

    const otherWorkspaceResponse = await postPdf(fixture.app, syntheticPdf("other-workspace"), {
      idempotencyKey: "pdf-layout-other-workspace-import", workspaceId: workspaceB
    }).expect(201);
    const otherWorkspace = await waitForImport(fixture.app, otherWorkspaceResponse.body.id, workspaceB);

    const courses = await fixture.readweave.listCourses();
    const defaultA = courses.filter((course) => course.workspaceId === workspaceA && course.title === "未分类");
    const defaultB = courses.filter((course) => course.workspaceId === workspaceB && course.title === "未分类");
    expect(first.courseId).toBe(second.courseId);
    expect(defaultA).toHaveLength(1);
    expect(first.courseId).toBe(defaultA[0]?.id);
    expect(defaultB).toHaveLength(1);
    expect(otherWorkspace.courseId).toBe(defaultB[0]?.id);
    expect(otherWorkspace.courseId).not.toBe(first.courseId);
    expect(explicitlyPlaced.courseId).toBe(explicitCourse.body.id);
    expect(courses.find((course) => course.id === explicitCourse.body.id)?.workspaceId).toBe(workspaceA);

    // Model a pre-migration auto-import wrapper: its material is moved into
    // the stable workspace course before the now-empty wrapper is archived.
    const legacyAutoCourse = await request(fixture.app).post("/api/v1/courses")
      .set("X-Workspace-Id", workspaceA)
      .set("Idempotency-Key", "pdf-layout-legacy-auto-course")
      .send({ id: "pdf-layout-import-wrapper-course", title: "旧导入包装课程" })
      .expect(201);
    const legacyImportResponse = await postPdf(fixture.app, syntheticPdf("legacy-auto-wrapper-material"), {
      idempotencyKey: "pdf-layout-legacy-auto-import",
      workspaceId: workspaceA,
      courseId: legacyAutoCourse.body.id
    }).expect(201);
    const legacyImport = await waitForImport(fixture.app, legacyImportResponse.body.id, workspaceA);
    expect(legacyImport.state).toBe("ready");
    const legacyRelease = await fixture.readweave.getRelease(legacyImport.materialVersionId);
    expect(legacyRelease).toBeDefined();
    if (!legacyRelease) throw new Error("MIGRATION_FIXTURE_RELEASE_MISSING");
    const migrationPage = legacyRelease.pages[0];
    if (!migrationPage) throw new Error("MIGRATION_FIXTURE_PAGE_MISSING");
    const draftNoteId = "readweave-note:pdf-layout-migrated-draft";
    const draftPage = structuredClone(migrationPage);
    const draftContentHash = createHash("sha256").update(JSON.stringify(draftPage)).digest("hex");
    const existingDraft = await fixture.readweave.getDraftByPage(migrationPage.id);
    const expectedDraftRevision = existingDraft?.revision ?? 0;
    const savedMigrationDraft = await fixture.readweave.saveDraft({
      id: existingDraft?.id ?? `draft:${migrationPage.id}`,
      workspaceId: workspaceA,
      courseId: legacyRelease.courseId,
      moduleId: legacyRelease.moduleId,
      sourceReleaseId: legacyRelease.id,
      pageId: migrationPage.id,
      revision: expectedDraftRevision,
      status: "ready",
      page: draftPage,
      changedBlockIds: draftPage.blocks.map((block) => block.id),
      readweaveNoteId: draftNoteId,
      contentHash: draftContentHash,
      updatedAt: new Date().toISOString()
    } satisfies LessonDraft, expectedDraftRevision, {
      idempotencyKey: "pdf-layout-save-migration-draft",
      actor: "test",
      workspaceId: workspaceA,
      schemaVersion: "2.4.0",
      requestId: "pdf-layout-save-migration-draft"
    });
    const mockedDeepLink = {
      noteId: draftNoteId,
      url: "https://readweave.example.com/#root/pdf-layout-migrated-draft",
      host: "readweave.example.com",
      verified: true,
      verifiedAt: new Date().toISOString()
    };
    const getDeepLink = vi.spyOn(fixture.readweave, "getDeepLink").mockResolvedValue(mockedDeepLink);

    const beforeMoveTree = await request(fixture.app).get(`/api/v1/workspaces/${workspaceA}/tree`)
      .set("X-Workspace-Id", workspaceA)
      .expect(200);
    const legacyMaterial = beforeMoveTree.body.courses
      .find((course: { id: string }) => course.id === legacyAutoCourse.body.id)
      ?.children.find((node: { currentReleaseId?: string }) => node.currentReleaseId === legacyRelease?.id)
      ?? beforeMoveTree.body.rootMaterials.find((node: { currentReleaseId?: string }) => node.currentReleaseId === legacyRelease?.id);
    expect(legacyMaterial).toMatchObject({ kind: "material", currentReleaseId: legacyRelease?.id });

    await request(fixture.app).post(`/api/v1/tree/nodes/${encodeURIComponent(legacyMaterial.id)}:move`)
      .set("X-Workspace-Id", workspaceA)
      .set("Idempotency-Key", "pdf-layout-move-legacy-material")
      .send({ expectedRevision: legacyMaterial.revision, parentId: defaultA[0]?.id })
      .expect(200)
      .expect((response) => expect(response.body).toMatchObject({ id: legacyMaterial.id, parentId: defaultA[0]?.id }));

    await request(fixture.app).patch(`/api/v1/tree/nodes/${encodeURIComponent(legacyAutoCourse.body.id)}`)
      .set("X-Workspace-Id", workspaceA)
      .set("Idempotency-Key", "pdf-layout-archive-legacy-auto-course")
      .send({ expectedRevision: legacyAutoCourse.body.revision ?? 0, archived: true })
      .expect(200)
      .expect((response) => expect(response.body).toMatchObject({ id: legacyAutoCourse.body.id, archived: true }));

    const migratedTree = await request(fixture.app).get(`/api/v1/workspaces/${workspaceA}/tree`)
      .set("X-Workspace-Id", workspaceA)
      .expect(200);
    expect(migratedTree.body.courses.find((course: { id: string }) => course.id === defaultA[0]?.id)?.children)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: legacyMaterial.id, currentReleaseId: legacyRelease?.id })]));
    const authorityIndexes = await request(fixture.app).get("/api/v1/releases?view=index")
      .set("X-Workspace-Id", workspaceA)
      .expect(200);
    expect(authorityIndexes.body.map((release: { id: string }) => release.id)).toContain(legacyRelease?.id);
    const authorityRelease = await request(fixture.app).get(`/api/v1/releases/${legacyRelease?.id}`)
      .set("X-Workspace-Id", workspaceA)
      .expect(200);
    expect(authorityRelease.body).toMatchObject({ id: legacyRelease?.id, pageIds: legacyImport.pageIds });
    await request(fixture.app).get(`/api/v1/pages/${legacyImport.pageIds[0]}/lesson`)
      .set("X-Workspace-Id", workspaceA)
      .expect(200)
      .expect((response) => expect(response.body).toMatchObject({ releaseId: legacyRelease?.id, page: { id: legacyImport.pageIds[0] } }));

    // Exercise the same materialized reading route used by production. The
    // release and page IDs stay immutable when only their navigation parent changes.
    const reading = new ReadingRuntime(
      join(fixture.dependencies.dataDir, "reading-migration-boundary"),
      fixture.readweave,
      workspaceA,
      "pdf-layout-migration-boundary",
      buildReadingTree
    );
    await reading.initialize();
    await reading.materialize();
    fixture.dependencies.reading = reading;
    const readingIndexes = await request(fixture.app).get("/api/v1/releases?view=index")
      .set("X-Workspace-Id", workspaceA)
      .expect(200);
    const readingRelease = await request(fixture.app).get(`/api/v1/releases/${legacyRelease?.id}`)
      .set("X-Workspace-Id", workspaceA);
    const readingTree = await request(fixture.app).get(`/api/v1/workspaces/${workspaceA}/tree`)
      .set("X-Workspace-Id", workspaceA);
    expect({
      indexIds: readingIndexes.body.map((release: { id: string }) => release.id),
      releaseStatus: readingRelease.status,
      releaseIds: readingRelease.body?.pageIds,
      movedMaterial: readingTree.body.courses.find((course: { id: string }) => course.id === defaultA[0]?.id)
        ?.children.find((node: { id: string }) => node.id === legacyMaterial.id)
    }).toEqual({
      indexIds: expect.arrayContaining([legacyRelease?.id]),
      releaseStatus: 200,
      releaseIds: legacyImport.pageIds,
      movedMaterial: expect.objectContaining({ id: legacyMaterial.id, currentReleaseId: legacyRelease?.id, parentId: defaultA[0]?.id })
    });

    const readingDraft = await request(fixture.app).get(`/api/v1/pages/${migrationPage.id}/draft?view=snapshot`)
      .set("X-Workspace-Id", workspaceA)
      .expect(200);
    expect(readingDraft.body).toMatchObject({
      id: savedMigrationDraft.id,
      sourceReleaseId: legacyRelease.id,
      pageId: migrationPage.id,
      readweaveNoteId: draftNoteId,
      contentHash: draftContentHash
    });
    const openedDraftNote = await request(fixture.app).get(`/api/v1/readweave/links/${encodeURIComponent(draftNoteId)}`)
      .set("X-Workspace-Id", workspaceA)
      .expect(200);
    expect(openedDraftNote.body).toMatchObject(mockedDeepLink);
    expect(getDeepLink).toHaveBeenCalledWith(draftNoteId);

    const attemptsBeforeSession = await fixture.readweave.listQuestionAttempts();
    const learningSession = await request(fixture.app).post("/api/v1/sessions")
      .set("X-Workspace-Id", workspaceA)
      .send({ courseReleaseId: legacyRelease.id })
      .expect(201);
    expect(learningSession.body).toMatchObject({
      workspaceId: workspaceA,
      courseReleaseId: legacyRelease.id,
      currentPageId: migrationPage.id
    });
    await expect(fixture.readweave.listQuestionAttempts()).resolves.toHaveLength(attemptsBeforeSession.length);

    const ownerTrash = await fixture.readweave.trashTreeNode(legacyAutoCourse.body.id, {
      idempotencyKey: "pdf-layout-trash-original-owner",
      actor: "test",
      workspaceId: workspaceA,
      schemaVersion: "2.4.0",
      requestId: "pdf-layout-trash-original-owner"
    });
    expect(ownerTrash).toMatchObject({ nodeId: legacyAutoCourse.body.id, nodeKind: "course", restoreAvailable: true });
    fixture.dependencies.reading = undefined;
    const authorityAfterOwnerTrashIndex = await request(fixture.app).get("/api/v1/releases?view=index")
      .set("X-Workspace-Id", workspaceA)
      .expect(200);
    const authorityAfterOwnerTrashRelease = await request(fixture.app).get(`/api/v1/releases/${legacyRelease?.id}`)
      .set("X-Workspace-Id", workspaceA);

    await reading.materialize();
    fixture.dependencies.reading = reading;
    const replicaAfterOwnerTrashIndex = await request(fixture.app).get("/api/v1/releases?view=index")
      .set("X-Workspace-Id", workspaceA)
      .expect(200);
    const replicaAfterOwnerTrashRelease = await request(fixture.app).get(`/api/v1/releases/${legacyRelease?.id}`)
      .set("X-Workspace-Id", workspaceA);
    const hiddenDraftNote = await request(fixture.app).get(`/api/v1/readweave/links/${encodeURIComponent(draftNoteId)}`)
      .set("X-Workspace-Id", workspaceA);
    reading.close();
    expect({
      authorityStillListsRelease: authorityAfterOwnerTrashIndex.body.some((release: { id: string }) => release.id === legacyRelease?.id),
      authorityReleaseStatus: authorityAfterOwnerTrashRelease.status,
      replicaStillListsRelease: replicaAfterOwnerTrashIndex.body.some((release: { id: string }) => release.id === legacyRelease?.id),
      replicaReleaseStatus: replicaAfterOwnerTrashRelease.status,
      trashedDraftNoteStatus: hiddenDraftNote.status,
      deepLinkLookups: getDeepLink.mock.calls.length
    }).toEqual({
      authorityStillListsRelease: false,
      authorityReleaseStatus: 404,
      replicaStillListsRelease: false,
      replicaReleaseStatus: 404,
      trashedDraftNoteStatus: 404,
      deepLinkLookups: 1
    });
    expect(fixture.modelCall).not.toHaveBeenCalled();
  }, 30_000);
});

function createConversionHarness() {
  const requests: ConversionRequest[] = [];
  const executions: ConversionRequest[] = [];
  const executionCounts = new Map<string, number>();
  const results = new Map<string, ConversionResult>();

  const client = {
    enqueueAndWait: async (input: ConversionRequest): Promise<ConversionResult> => {
      requests.push(structuredClone(input));
      const cached = results.get(input.id);
      if (cached) return structuredClone(cached);
      executions.push(structuredClone(input));
      executionCounts.set(input.id, (executionCounts.get(input.id) ?? 0) + 1);

      const startedAt = new Date().toISOString();
      if (input.purpose === "inspect") {
        const sourceSha256 = createHash("sha256").update(await readFile(input.sourcePath)).digest("hex");
        const choices = input.pdfLayout?.choices ?? {};
        const unsafeChoice = Object.keys(choices).some((physicalPage) => Number(physicalPage) > 1);
        const selection = input.pdfLayout ?? { mode: "auto" as const };
        const choiceForFirstPage = choices["1"];
        const split = choiceForFirstPage
          ? choiceForFirstPage !== "original"
          : selection.mode === "auto";
        const completedAt = new Date().toISOString();
        const result: ConversionResult = unsafeChoice
          ? { requestId: input.id, state: "failed", pages: [], issues: ["PDF_LAYOUT_UNSAFE_CHOICE"], startedAt, completedAt }
          : {
            requestId: input.id,
            state: "completed",
            pages: [],
            issues: [],
            startedAt,
            completedAt,
            inspection: syntheticInspection(sourceSha256, selection, split)
          };
        results.set(input.id, result);
        return structuredClone(result);
      }

      const split = input.pdfLayout?.mode === "auto" && input.pdfLayout.choices?.["1"] !== "original";
      const inspection = input.kind === "pdf" && input.pdfLayout
        ? syntheticInspection(
          createHash("sha256").update(await readFile(input.sourcePath)).digest("hex"),
          input.pdfLayout,
          split
        )
        : undefined;
      const pageCount = split ? 2 : 1;
      await mkdir(input.outputDir, { recursive: true });
      const pages = await Promise.all(Array.from({ length: pageCount }, async (_, index) => {
        const pageNumber = index + 1;
        const imagePath = join(input.outputDir, `page-${pageNumber}.svg`);
        await writeFile(imagePath, `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><text x="12" y="24">Synthetic page ${pageNumber}</text></svg>`);
        return {
          pageNumber,
          title: `Synthetic page ${pageNumber}`,
          text: `Synthetic source content for page ${pageNumber}`,
          imagePath,
          imageMediaType: "image/svg+xml" as const
        };
      }));
      const result: ConversionResult = {
        requestId: input.id,
        state: "completed",
        pages,
        issues: [],
        startedAt,
        completedAt: new Date().toISOString(),
        ...(inspection ? { inspection } : {})
      };
      results.set(input.id, result);
      return structuredClone(result);
    }
  };

  return { client, requests, executions, executionCounts };
}

function syntheticInspection(sourceSha256: string, selection: PdfLayoutSelection, split: boolean): PdfLayoutInspection {
  const fullPage = { x: 0, y: 0, width: 612, height: 792 };
  const regions = split
    ? [{ x: 0, y: 396, width: 612, height: 396 }, { x: 0, y: 0, width: 612, height: 396 }]
    : [fullPage];
  const fingerprint = createHash("sha256").update(`${sourceSha256}:${JSON.stringify(selection)}`).digest("hex");
  const preview = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"160\" height=\"200\"><rect width=\"160\" height=\"200\" fill=\"white\"/><text x=\"8\" y=\"24\">Synthetic preview</text></svg>").toString("base64");
  return {
    version: "synthetic-layout-v1",
    sourceSha256,
    physicalPageCount: 1,
    logicalPageCount: split ? 2 : 1,
    fingerprint,
    pages: [{ physicalPage: 1, width: 612, height: 792, rotation: 0, mode: split ? "top-bottom" : "original", regions }],
    previews: [{ physicalPage: 1, imageDataUrl: `data:image/svg+xml;base64,${preview}` }]
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "course-os-pdf-layout-test-"));
  temporaryRoots.push(root);
  const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
  const modelCall = vi.fn(async () => { throw new Error("MODEL_CALL_NOT_EXPECTED_IN_PDF_LAYOUT_TEST"); });
  const modelRouter = { generateTeachingPackage: modelCall } satisfies ModelRouterClient;
  const dependencies = createDefaultDependencies(root, readweave, modelRouter);
  const conversion = createConversionHarness();
  dependencies.conversion = conversion.client;
  return { app: createApp(dependencies), dependencies, readweave, conversion, modelCall };
}

function syntheticPdf(label: string): Buffer {
  return Buffer.from(`%PDF-1.7\n% Synthetic fixture ${label}\n%%EOF\n`, "ascii");
}

function postPdf(app: ReturnType<typeof createApp>, source: Buffer, options: {
  idempotencyKey: string;
  workspaceId?: string;
  courseId?: string;
  layout?: PdfLayoutSelection;
}) {
  const upload = request(app).post("/api/v1/imports")
    .set("Idempotency-Key", options.idempotencyKey)
    .set("X-Workspace-Id", options.workspaceId ?? "personal")
    .field("autoGenerate", "false");
  if (options.courseId) upload.field("courseId", options.courseId);
  if (options.layout) upload.field("pdfLayout", JSON.stringify(options.layout));
  return upload.attach("file", source, { filename: "course-layout-fixture.pdf", contentType: "application/pdf" });
}

async function waitForImport(app: ReturnType<typeof createApp>, importId: string, workspaceId = "personal") {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const current = await request(app).get(`/api/v1/imports/${importId}`)
      .set("X-Workspace-Id", workspaceId)
      .expect(200);
    if (["ready", "failed", "rejected"].includes(current.body.state)) return current.body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("PDF_LAYOUT_IMPORT_TEST_TIMEOUT");
}
