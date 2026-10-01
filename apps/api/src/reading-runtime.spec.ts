import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COURSE_API_VERSION, type CourseProject, type CourseRelease, type IdempotentWriteContext, type LessonDraft, type PageLesson, type ReleaseManifest } from "@course-os/contracts";
import { sha256Text, stableStringify } from "@course-os/domain";
import { FileReadWeaveCourseApi, type ReadWeaveCourseApi } from "@course-os/readweave-adapter";
import { ReadingRuntime, observeReadingWrites } from "./reading-runtime.js";
import { buildReadingTree } from "./app.js";

const roots: string[] = [];
const workspaceId = "reading-runtime-spec";
const authorityIdentity = "authority:reading-runtime-spec";
const stamp = "2026-09-30T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ReadingRuntime", () => {
  it("serves confirmed catalog and page copies through an authority outage and records degraded sync", async () => {
    const root = await temporaryRoot();
    const authority = new FileReadWeaveCourseApi(join(root, "readweave-course-store.json"));
    const release = await publishFixture(authority);
    const confirmed = new ReadingRuntime(root, authority, workspaceId, authorityIdentity, buildReadingTree);
    await confirmed.initialize();
    await confirmed.materialize();
    const before = await confirmed.replica.getPageSource(workspaceId, release.pages[0]!.id, release.id);
    expect(before?.page.blocks[0]?.markdown).toBe("Confirmed fixture explanation");
    confirmed.close();

    const offline = new ReadingRuntime(root, failingAuthority(authority, "ECONNREFUSED: fixture authority offline"), workspaceId, authorityIdentity, buildReadingTree);
    await offline.initialize();
    expect(offline.status().ready).toBe(true);
    await expect(offline.refresh()).rejects.toThrow("ECONNREFUSED");
    expect(offline.status()).toMatchObject({ ready: true, synchronization: "degraded", accessDenied: false });
    await expect(offline.replica.listCourses(workspaceId)).resolves.toMatchObject([{ id: "fixture-course" }]);
    await expect(offline.replica.getPageSource(workspaceId, release.pages[0]!.id, release.id))
      .resolves.toMatchObject({ page: { blocks: [{ markdown: "Confirmed fixture explanation" }] } });
    offline.close();
  });

  it("keeps a fresh empty authority unready", async () => {
    const root = await temporaryRoot();
    const authority = new FileReadWeaveCourseApi(join(root, "readweave-course-store.json"));
    const runtime = new ReadingRuntime(root, authority, workspaceId, authorityIdentity, buildReadingTree);
    await runtime.initialize();
    expect(runtime.status().ready).toBe(false);
    await runtime.materialize();
    expect(runtime.status()).toMatchObject({ ready: false, courses: 0, releases: 0, pages: 0 });
    runtime.close();
  });

  it("persists a confirmed authority draft write across a runtime restart", async () => {
    const root = await temporaryRoot();
    const authority = new FileReadWeaveCourseApi(join(root, "readweave-course-store.json"));
    const release = await publishFixture(authority);
    const runtime = new ReadingRuntime(root, authority, workspaceId, authorityIdentity, buildReadingTree);
    await runtime.initialize();
    await runtime.materialize();

    const draft = makeDraft(release, 1, "Confirmed draft after authority write");
    const context = writeContext("draft-write-once");
    const observedAuthority = observeReadingWrites(authority, runtime);
    await observedAuthority.saveDraft(draft, 0, context);
    expect(await runtime.replica.getDraft(workspaceId, draft.pageId, release.id)).toMatchObject({ revision: 1, contentHash: draft.contentHash });
    runtime.close();

    const restarted = new ReadingRuntime(root, failingAuthority(authority, "ECONNREFUSED: no remote reads expected"), workspaceId, authorityIdentity, buildReadingTree);
    await restarted.initialize();
    expect(restarted.status().ready).toBe(true);
    expect(await restarted.replica.getDraft(workspaceId, draft.pageId, release.id)).toMatchObject({
      revision: 1,
      contentHash: draft.contentHash,
      page: { blocks: [{ markdown: "Confirmed draft after authority write" }] }
    });
    restarted.close();
  });

  it("upserts a resolved lesson draft from its targeted authority snapshot", async () => {
    const root = await temporaryRoot();
    const store = new FileReadWeaveCourseApi(join(root, "readweave-course-store.json"));
    const release = await publishFixture(store);
    let snapshotReads = 0;
    let broadDraftReads = 0;
    const authority = new Proxy(store, {
      get(target, property) {
        if (property === "getDraftSnapshotByPage") return async (pageId: string) => {
          snapshotReads += 1;
          return target.getDraftByPage(pageId);
        };
        if (property === "getDraftByPage") return async (pageId: string) => {
          broadDraftReads += 1;
          return target.getDraftByPage(pageId);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as ReadWeaveCourseApi;
    const runtime = new ReadingRuntime(root, authority, workspaceId, authorityIdentity, buildReadingTree);
    await runtime.initialize();
    await runtime.materialize();

    const observedAuthority = observeReadingWrites(authority, runtime);
    let confirmed = await observedAuthority.saveDraft(makeDraft(release, 1, "confirmed revision 1"), 0,
      writeContext("resolved-draft-r1"));
    for (let revision = 2; revision <= 4; revision += 1) {
      confirmed = await observedAuthority.saveDraft(makeDraft(release, revision, `confirmed revision ${revision}`), confirmed.revision,
        writeContext(`resolved-draft-r${revision}`));
    }
    expect(await runtime.replica.getDraft(workspaceId, confirmed.pageId, release.id)).toMatchObject({ revision: 4 });

    await expect(observedAuthority.saveDraft(makeDraft(release, 3, "stale conflict proposal"), 3,
      writeContext("resolved-draft-conflict"))).rejects.toThrow("READWEAVE_REVISION_CONFLICT:");
    const conflict = (await store.listConflicts()).find(item => item.status === "open");
    expect(conflict).toMatchObject({ objectType: "lesson_draft", objectId: confirmed.pageId, remoteRevision: 4 });
    const mergedPage = structuredClone(confirmed.page);
    mergedPage.blocks[0]!.markdown = "caller-confirmed merged full page";

    await observedAuthority.resolveConflict(conflict!.id, "merged", stableStringify(mergedPage),
      writeContext("resolved-draft-merge"));

    await expect(runtime.replica.getDraft(workspaceId, confirmed.pageId, release.id)).resolves.toMatchObject({
      revision: 5,
      status: "editing",
      contentHash: sha256Text(stableStringify(mergedPage)),
      page: { blocks: [{ markdown: "caller-confirmed merged full page" }] }
    });
    expect(snapshotReads).toBe(1);
    expect(broadDraftReads).toBe(0);
    runtime.close();
  });

  it("falls back to the local file adapter draft read when no snapshot method exists", async () => {
    const root = await temporaryRoot();
    const authority = new FileReadWeaveCourseApi(join(root, "readweave-course-store.json"));
    expect((authority as ReadWeaveCourseApi).getDraftSnapshotByPage).toBeUndefined();
    const release = await publishFixture(authority);
    const runtime = new ReadingRuntime(root, authority, workspaceId, authorityIdentity, buildReadingTree);
    await runtime.initialize();
    await runtime.materialize();

    const observedAuthority = observeReadingWrites(authority, runtime);
    const confirmed = await observedAuthority.saveDraft(makeDraft(release, 1, "confirmed revision 1"), 0,
      writeContext("file-resolved-draft-r1"));
    await expect(observedAuthority.saveDraft(makeDraft(release, 0, "stale conflict proposal"), 0,
      writeContext("file-resolved-draft-conflict"))).rejects.toThrow("READWEAVE_REVISION_CONFLICT:");
    const conflict = (await authority.listConflicts()).find(item => item.status === "open");
    expect(conflict).toMatchObject({ objectType: "lesson_draft", objectId: confirmed.pageId, remoteRevision: 1 });
    const mergedPage = structuredClone(confirmed.page);
    mergedPage.blocks[0]!.markdown = "file adapter merged page";

    await observedAuthority.resolveConflict(conflict!.id, "merged", stableStringify(mergedPage),
      writeContext("file-resolved-draft-merge"));

    await expect(runtime.replica.getDraft(workspaceId, confirmed.pageId, release.id)).resolves.toMatchObject({
      revision: 2,
      contentHash: sha256Text(stableStringify(mergedPage)),
      page: { blocks: [{ markdown: "file adapter merged page" }] }
    });
    runtime.close();
  });

  it("does not let a stale in-flight refresh replace a newer saved draft", async () => {
    const root = await temporaryRoot();
    const authority = new FileReadWeaveCourseApi(join(root, "readweave-course-store.json"));
    const release = await publishFixture(authority);
    const runtime = new ReadingRuntime(root, authority, workspaceId, authorityIdentity, buildReadingTree);
    await runtime.initialize();
    await runtime.materialize();

    const staleDraft = makeDraft(release, 1, "Older refresh copy");
    const newerDraft = makeDraft(release, 2, "Concurrent saved copy");
    const staleRead = deferred<LessonDraft | undefined>();
    const refreshReachedDraft = deferred<void>();
    const delayedAuthority = new Proxy(authority, {
      get(target, property) {
        if (property === "getDraftByPage") return async () => {
          refreshReachedDraft.resolve();
          return staleRead.promise;
        };
        if (property === "saveDraft") return async () => newerDraft;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as ReadWeaveCourseApi;
    const liveRuntime = new ReadingRuntime(root, delayedAuthority, workspaceId, authorityIdentity, buildReadingTree);
    await liveRuntime.initialize();

    const refresh = liveRuntime.refresh();
    await refreshReachedDraft.promise;
    await observeReadingWrites(delayedAuthority, liveRuntime).saveDraft(newerDraft, 1, writeContext("newer-draft-write"));
    staleRead.resolve(staleDraft);
    await refresh;

    expect(await liveRuntime.replica.getDraft(workspaceId, newerDraft.pageId, release.id)).toMatchObject({
      revision: 2,
      contentHash: newerDraft.contentHash,
      page: { blocks: [{ markdown: "Concurrent saved copy" }] }
    });
    liveRuntime.close();
  });

  it("fails closed on authority access denial and retains denial across restart", async () => {
    const root = await temporaryRoot();
    const authority = new FileReadWeaveCourseApi(join(root, "readweave-course-store.json"));
    await publishFixture(authority);
    const confirmed = new ReadingRuntime(root, authority, workspaceId, authorityIdentity, buildReadingTree);
    await confirmed.initialize();
    await confirmed.materialize();
    confirmed.close();

    const denied = new ReadingRuntime(root, failingAuthority(authority, "READWEAVE_HTTP_403:FORBIDDEN"), workspaceId, authorityIdentity, buildReadingTree);
    await denied.initialize();
    await expect(denied.refresh()).rejects.toThrow("READWEAVE_HTTP_403");
    expect(denied.status()).toMatchObject({ ready: false, accessDenied: true, synchronization: "degraded" });
    expect(() => denied.assertAccess()).toThrow("READING_ACCESS_DENIED");
    denied.close();

    const restarted = new ReadingRuntime(root, authority, workspaceId, authorityIdentity, buildReadingTree);
    await restarted.initialize();
    expect(restarted.status()).toMatchObject({ ready: false, accessDenied: true });
    expect(() => restarted.assertAccess()).toThrow("READING_ACCESS_DENIED");
    restarted.close();
  });

  it("returns an acknowledged authority write when projection fails and requires controlled confirmation", async () => {
    const root = await temporaryRoot();
    const authority = new FileReadWeaveCourseApi(join(root, "readweave-course-store.json"));
    const release = await publishFixture(authority);
    const runtime = new ReadingRuntime(root, authority, workspaceId, authorityIdentity, buildReadingTree);
    await runtime.initialize();
    await runtime.materialize();

    let authorityWrites = 0;
    const badProjection = new Proxy(authority, {
      get(target, property) {
        if (property === "saveDraft") return async (...args: Parameters<ReadWeaveCourseApi["saveDraft"]>) => {
          authorityWrites += 1;
          const saved = await target.saveDraft(...args);
          return { ...saved, workspaceId: "different-workspace" };
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as ReadWeaveCourseApi;
    const attemptedDraft = makeDraft(release, 1, "Authority acknowledged this draft");
    const acknowledged = await observeReadingWrites(badProjection, runtime)
      .saveDraft(attemptedDraft, 0, writeContext("projection-failure-write"));

    expect(acknowledged.workspaceId).toBe("different-workspace");
    expect(authorityWrites).toBe(1);
    expect(runtime.status().ready).toBe(false);
    runtime.close();

    const restarted = new ReadingRuntime(root, authority, workspaceId, authorityIdentity, buildReadingTree);
    await restarted.initialize();
    expect(restarted.status().ready).toBe(false);
    await restarted.materialize();
    expect(restarted.status().ready).toBe(true);
    expect(await restarted.replica.getDraft(workspaceId, attemptedDraft.pageId, release.id))
      .toMatchObject({ revision: 1, page: { blocks: [{ markdown: "Authority acknowledged this draft" }] } });
    expect(authorityWrites).toBe(1);
    restarted.close();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "course-os-reading-runtime-"));
  roots.push(root);
  return root;
}

async function publishFixture(authority: FileReadWeaveCourseApi): Promise<CourseRelease> {
  const course: CourseProject = {
    id: "fixture-course",
    workspaceId,
    title: "Reading Runtime Fixture",
    status: "active",
    createdAt: stamp,
    updatedAt: stamp
  };
  await authority.createCourse(course, writeContext("create-fixture-course"));

  const lesson = page("fixture-page");
  const release: CourseRelease = {
    id: "fixture-release",
    courseId: course.id,
    courseTitle: course.title,
    moduleId: "fixture-module",
    moduleTitle: "Fixture Module",
    version: 1,
    publishedAt: stamp,
    pageIds: [lesson.id],
    pages: [lesson],
    assessments: [],
    manifestHash: "fixture-manifest-hash-v1",
    writingPolicySnapshotId: "fixture-policy-v1",
    modelRoute: "fixture-no-model",
    qualityHarnessVersion: "fixture-v1",
    costUsd: 0,
    lifecycle: "published"
  };
  const manifest: ReleaseManifest = {
    id: "fixture-release-manifest",
    schemaVersion: COURSE_API_VERSION,
    courseReleaseId: release.id,
    sourceHashes: [],
    pageHashes: [sha256Text(stableStringify(lesson))],
    explanationHashes: [],
    assessmentHashes: [],
    writingPolicySnapshotId: release.writingPolicySnapshotId,
    modelRoutes: [release.modelRoute],
    qualityHarnessVersion: release.qualityHarnessVersion,
    costInputs: [],
    createdAt: stamp
  };
  await authority.publishRelease(release, manifest, writeContext("publish-fixture-release"));
  return release;
}

function page(id: string): PageLesson {
  return {
    id,
    pageNumber: 1,
    title: "Confirmed fixture page",
    imageUrl: "/api/v1/media/fixture-image",
    anchors: [{ id: `${id}:anchor`, pageId: id, kind: "text", label: "Fixture source", text: "Synthetic fixture source text" }],
    atoms: [],
    blocks: [{ id: `${id}:core`, title: "Explanation", kind: "core", markdown: "Confirmed fixture explanation", sourceAnchorIds: [`${id}:anchor`], atomIds: [] }],
    questionBank: Array.from({ length: 4 }, (_, index) => ({
      id: `${id}:question:${index + 1}`,
      pageId: id,
      objectiveId: `${id}:objective`,
      kind: "comprehension" as const,
      prompt: `What is fixture answer ${index + 1}?`,
      expectedAnswer: `fixture answer ${index + 1}`,
      explanation: `Confirmed fixture feedback ${index + 1}`,
      sourceAnchorIds: [`${id}:anchor`],
      status: "approved" as const,
      version: 1,
      generatedBy: "local-fixture"
    })),
    coverageRequirements: [],
    coverageClaims: [],
    quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable: true, issues: [] }
  };
}

function makeDraft(release: CourseRelease, revision: number, markdown: string): LessonDraft {
  const savedPage = structuredClone(release.pages[0]!);
  savedPage.blocks[0]!.markdown = markdown;
  const content = stableStringify(savedPage);
  return {
    id: `draft:${savedPage.id}`,
    workspaceId,
    courseId: release.courseId,
    moduleId: release.moduleId,
    sourceReleaseId: release.id,
    pageId: savedPage.id,
    revision,
    status: "ready",
    page: savedPage,
    changedBlockIds: [savedPage.blocks[0]!.id],
    contentHash: sha256Text(content),
    updatedAt: new Date(Date.parse(stamp) + revision * 1_000).toISOString()
  };
}

function failingAuthority(authority: FileReadWeaveCourseApi, message: string): ReadWeaveCourseApi {
  const remoteReads = new Set(["listCourses", "listReleaseIndexes", "listTreeNodes", "listTrash", "getDraftByPage", "getSyncStatus"]);
  return new Proxy(authority, {
    get(target, property) {
      if (typeof property === "string" && remoteReads.has(property)) return async () => { throw new Error(message); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as ReadWeaveCourseApi;
}

function writeContext(idempotencyKey: string): IdempotentWriteContext {
  return { idempotencyKey, actor: "reading-runtime-spec", workspaceId, schemaVersion: COURSE_API_VERSION, requestId: idempotencyKey };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
