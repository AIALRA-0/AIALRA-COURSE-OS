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

  it("projects each acknowledged source registration and publication into the course tree immediately", async () => {
    const root = await temporaryRoot();
    const store = new FileReadWeaveCourseApi(join(root, "readweave-course-store.json"));
    const initialRelease = await publishFixture(store);
    const readCounts = { courses: 0, indexes: 0, nodes: 0, trash: 0 };
    const countedAuthority = new Proxy(store, {
      get(target, property) {
        const readName = property === "listCourses" ? "courses"
          : property === "listReleaseIndexes" ? "indexes"
            : property === "listTreeNodes" ? "nodes"
              : property === "listTrash" ? "trash" : undefined;
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (readName) readCounts[readName] += 1;
          return value.apply(target, args);
        };
      }
    }) as ReadWeaveCourseApi;
    const runtime = new ReadingRuntime(root, countedAuthority, workspaceId, authorityIdentity, buildReadingTree);
    await runtime.initialize();
    await runtime.materialize();
    const countsAfterMaterialize = { ...readCounts };
    const observedAuthority = observeReadingWrites(countedAuthority, runtime);
    const treeMaterialIds = async () => (await runtime.replica.getTree(workspaceId))?.courses
      .find((item) => item.id === initialRelease.courseId)?.children
      .filter((item) => item.kind === "material").map((item) => item.materialId ?? item.id) ?? [];
    const addedRelease = (id: string, moduleId: string, lifecycle: CourseRelease["lifecycle"]): CourseRelease => {
      const lesson = page(`${id}-page`);
      return {
        ...initialRelease,
        id,
        moduleId,
        moduleTitle: `Module ${moduleId}`,
        manifestHash: `manifest:${id}`,
        lifecycle,
        pageIds: [lesson.id],
        pages: [lesson]
      };
    };

    expect(await treeMaterialIds()).toHaveLength(1);
    const draftSource = addedRelease("fixture-draft-source-2", "fixture-module-2", "draft_source");
    await observedAuthority.registerDraftSource(draftSource, writeContext("register-second-source"));
    expect(await treeMaterialIds()).toHaveLength(2);

    const published = addedRelease("fixture-published-3", "fixture-module-3", "published");
    const manifest: ReleaseManifest = {
      id: "fixture-published-3-manifest",
      schemaVersion: COURSE_API_VERSION,
      courseReleaseId: published.id,
      sourceHashes: [],
      pageHashes: [sha256Text(stableStringify(published.pages[0]!))],
      explanationHashes: [],
      assessmentHashes: [],
      writingPolicySnapshotId: published.writingPolicySnapshotId,
      modelRoutes: [published.modelRoute],
      qualityHarnessVersion: published.qualityHarnessVersion,
      costInputs: [],
      createdAt: stamp
    };
    await observedAuthority.publishRelease(published, manifest, writeContext("publish-third-source"));
    expect(await treeMaterialIds()).toHaveLength(3);
    expect(readCounts).toEqual(countsAfterMaterialize);
    await expect(runtime.replica.getPageSource(workspaceId, published.pages[0]!.id, published.id))
      .resolves.toMatchObject({ page: { blocks: [{ markdown: "Confirmed fixture explanation" }] } });
    runtime.close();

    const restarted = new ReadingRuntime(root, failingAuthority(store, "ECONNREFUSED: no remote reads expected"),
      workspaceId, authorityIdentity, buildReadingTree);
    await restarted.initialize();
    expect((await restarted.replica.getTree(workspaceId))?.courses
      .find((item) => item.id === initialRelease.courseId)?.children.filter((item) => item.kind === "material"))
      .toHaveLength(3);
    await expect(restarted.replica.getPageSource(workspaceId, published.pages[0]!.id, published.id))
      .resolves.toMatchObject({ page: { blocks: [{ markdown: "Confirmed fixture explanation" }] } });
    restarted.close();
  });

  it("moves the incremental material default to a newly readable draft source", async () => {
    const root = await temporaryRoot();
    const store = new FileReadWeaveCourseApi(join(root, "readweave-course-store.json"));
    const published = await publishFixture(store);
    const readCounts = { courses: 0, indexes: 0, nodes: 0, trash: 0 };
    const countedAuthority = new Proxy(store, {
      get(target, property) {
        const readName = property === "listCourses" ? "courses"
          : property === "listReleaseIndexes" ? "indexes"
            : property === "listTreeNodes" ? "nodes"
              : property === "listTrash" ? "trash" : undefined;
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (readName) readCounts[readName] += 1;
          return value.apply(target, args);
        };
      }
    }) as ReadWeaveCourseApi;
    const runtime = new ReadingRuntime(root, countedAuthority, workspaceId, authorityIdentity, buildReadingTree);
    await runtime.initialize();
    await runtime.materialize();
    const readsAfterMaterialize = { ...readCounts };
    const observedAuthority = observeReadingWrites(countedAuthority, runtime);
    const candidatePage = page("fixture-candidate-page");
    const candidate: CourseRelease = {
      ...published,
      id: "fixture-candidate-release",
      version: 2,
      pageIds: [candidatePage.id],
      pages: [candidatePage],
      lifecycle: "draft_source",
      manifestHash: "fixture-candidate-manifest-hash"
    };
    const materialId = `material:${published.courseId}:${published.moduleId}`;

    await observedAuthority.registerDraftSource(candidate, writeContext("register-readable-candidate"));
    expect(runtime.replica.getTreeNode(workspaceId, materialId)).toMatchObject({
      currentReleaseId: published.id,
      pageCount: published.pages.length
    });
    await observedAuthority.saveDraft(makeDraft(candidate, 1, "Readable candidate explanation"), 0,
      writeContext("save-readable-candidate"));

    expect(runtime.replica.getTreeNode(workspaceId, materialId)).toMatchObject({
      currentReleaseId: candidate.id,
      releaseId: candidate.id,
      pageCount: candidate.pages.length
    });
    expect(runtime.replica.getMaterialReleaseSelection(workspaceId, materialId)).toEqual({
      releaseId: candidate.id,
      source: "derived"
    });
    expect(readCounts).toEqual(readsAfterMaterialize);
    runtime.close();
  });

  it("preserves a persisted explicit material release pin when a newer draft becomes readable", async () => {
    const root = await temporaryRoot();
    const store = new FileReadWeaveCourseApi(join(root, "readweave-course-store.json"));
    const published = await publishFixture(store);
    const readCounts = { courses: 0, indexes: 0, nodes: 0, trash: 0 };
    const countedAuthority = new Proxy(store, {
      get(target, property) {
        const readName = property === "listCourses" ? "courses"
          : property === "listReleaseIndexes" ? "indexes"
            : property === "listTreeNodes" ? "nodes"
              : property === "listTrash" ? "trash" : undefined;
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (readName) readCounts[readName] += 1;
          return value.apply(target, args);
        };
      }
    }) as ReadWeaveCourseApi;
    const runtime = new ReadingRuntime(root, countedAuthority, workspaceId, authorityIdentity, buildReadingTree);
    await runtime.initialize();
    await runtime.materialize();
    const readsAfterMaterialize = { ...readCounts };
    const observedAuthority = observeReadingWrites(countedAuthority, runtime);
    const materialId = `material:${published.courseId}:${published.moduleId}`;
    const materialNode = runtime.replica.getTreeNode(workspaceId, materialId)!;

    await observedAuthority.updateTreeNode(materialId, { currentReleaseId: published.id }, materialNode.revision ?? 0,
      writeContext("explicitly-pin-published-release"));
    expect(runtime.replica.getMaterialReleaseSelection(workspaceId, materialId)).toEqual({
      releaseId: published.id,
      source: "explicit"
    });
    runtime.close();

    const restarted = new ReadingRuntime(root, countedAuthority, workspaceId, authorityIdentity, buildReadingTree);
    await restarted.initialize();
    expect(restarted.replica.getMaterialReleaseSelection(workspaceId, materialId)).toEqual({
      releaseId: published.id,
      source: "explicit"
    });
    const restartedAuthority = observeReadingWrites(countedAuthority, restarted);
    const candidatePage = page("fixture-explicit-pin-candidate-page");
    const candidate: CourseRelease = {
      ...published,
      id: "fixture-explicit-pin-candidate",
      version: 2,
      pageIds: [candidatePage.id],
      pages: [candidatePage],
      lifecycle: "draft_source",
      manifestHash: "fixture-explicit-pin-candidate-manifest"
    };
    await restartedAuthority.registerDraftSource(candidate, writeContext("register-explicit-pin-candidate"));
    await restartedAuthority.saveDraft(makeDraft(candidate, 1, "Readable newer candidate"), 0,
      writeContext("save-explicit-pin-candidate"));

    expect(restarted.replica.getTreeNode(workspaceId, materialId)).toMatchObject({
      currentReleaseId: published.id,
      releaseId: published.id,
      pageCount: published.pages.length
    });
    expect(restarted.replica.getMaterialReleaseSelection(workspaceId, materialId)).toEqual({
      releaseId: published.id,
      source: "explicit"
    });
    expect(readCounts).toEqual(readsAfterMaterialize);
    restarted.close();
  });

  it.each(["materialize", "refresh"] as const)("seeds a preexisting authority pin hint through %s", async (projection) => {
    const root = await temporaryRoot();
    const store = new FileReadWeaveCourseApi(join(root, "readweave-course-store.json"));
    const published = await publishFixture(store);
    const materialId = `material:${published.courseId}:${published.moduleId}`;
    const materialNode = (await store.listTreeNodes()).find((node) => node.id === materialId)!;
    await store.updateTreeNode(materialId, { currentReleaseId: published.id }, materialNode.revision ?? 0,
      writeContext("preexisting-explicit-pin"));

    const runtime = new ReadingRuntime(root, store, workspaceId, authorityIdentity, buildReadingTree);
    await runtime.initialize();
    if (projection === "materialize") await runtime.materialize();
    else await runtime.refresh();
    expect(runtime.replica.getMaterialReleaseSelection(workspaceId, materialId)).toEqual({
      releaseId: published.id,
      source: "explicit"
    });

    const candidatePage = page("fixture-preexisting-pin-candidate-page");
    const candidate: CourseRelease = {
      ...published,
      id: "fixture-preexisting-pin-candidate",
      version: 2,
      pageIds: [candidatePage.id],
      pages: [candidatePage],
      lifecycle: "draft_source",
      manifestHash: "fixture-preexisting-pin-candidate-manifest"
    };
    const observedAuthority = observeReadingWrites(store, runtime);
    await observedAuthority.registerDraftSource(candidate, writeContext("register-preexisting-pin-candidate"));
    await observedAuthority.saveDraft(makeDraft(candidate, 1, "Readable preexisting-pin candidate"), 0,
      writeContext("save-preexisting-pin-candidate"));

    expect(runtime.replica.getTreeNode(workspaceId, materialId)).toMatchObject({
      currentReleaseId: published.id,
      releaseId: published.id
    });
    expect(runtime.replica.getMaterialReleaseSelection(workspaceId, materialId)).toEqual({
      releaseId: published.id,
      source: "explicit"
    });
    runtime.close();
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
    // One targeted read reconciles the rejected stale save; one projects the
    // later conflict resolution.
    expect(snapshotReads).toBe(2);
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

  it("keeps the last confirmed tree when an ordinary move projection fails", async () => {
    const root = await temporaryRoot();
    const authority = new FileReadWeaveCourseApi(join(root, "readweave-course-store.json"));
    const release = await publishFixture(authority);
    const node = (await authority.listTreeNodes()).find((item) => item.kind === "material");
    expect(node).toBeDefined();

    const malformedMoveResult = new Proxy(authority, {
      get(target, property) {
        if (property === "updateTreeNode") return async (...args: Parameters<ReadWeaveCourseApi["updateTreeNode"]>) => {
          const saved = await target.updateTreeNode(...args);
          return { ...saved, parentId: "missing-parent" };
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as ReadWeaveCourseApi;
    const runtime = new ReadingRuntime(root, authority, workspaceId, authorityIdentity, buildReadingTree);
    await runtime.initialize();
    await runtime.materialize();

    await observeReadingWrites(malformedMoveResult, runtime).updateTreeNode(node!.id, { parentId: null }, node!.revision ?? 0,
      writeContext("ordinary-move-projection-failure"));

    expect(runtime.status()).toMatchObject({ ready: true, blockedObjects: 0 });
    await expect(runtime.replica.getPageSource(workspaceId, release.pages[0]!.id, release.id))
      .resolves.toMatchObject({ page: { id: release.pages[0]!.id } });
    const tree = await runtime.replica.getTree(workspaceId);
    expect(tree?.courses[0]?.children.some((child) => child.id === node!.id)).toBe(true);
    runtime.close();
  });

  it("keeps a version-sensitive material blocked across stale refreshes and repairs its confirmed revision", async () => {
    const root = await temporaryRoot();
    const authority = new FileReadWeaveCourseApi(join(root, "readweave-course-store.json"));
    const release = await publishFixture(authority);
    const siblingPage = page("unrelated-material-page");
    const siblingRelease: CourseRelease = {
      ...release,
      id: "unrelated-release",
      moduleId: "unrelated-module",
      moduleTitle: "Unrelated Module",
      pageIds: [siblingPage.id],
      pages: [siblingPage],
      manifestHash: "unrelated-release-manifest"
    };
    const manifest: ReleaseManifest = {
      id: "unrelated-release-manifest",
      schemaVersion: COURSE_API_VERSION,
      courseReleaseId: siblingRelease.id,
      sourceHashes: [],
      pageHashes: [sha256Text(stableStringify(siblingPage))],
      explanationHashes: [],
      assessmentHashes: [],
      writingPolicySnapshotId: siblingRelease.writingPolicySnapshotId,
      modelRoutes: [siblingRelease.modelRoute],
      qualityHarnessVersion: siblingRelease.qualityHarnessVersion,
      costInputs: [],
      createdAt: stamp
    };
    await authority.publishRelease(siblingRelease, manifest, writeContext("publish-unrelated-material"));
    const targetId = `material:${release.courseId}:${release.moduleId}`;
    const targetNode = (await authority.listTreeNodes()).find((item) => item.id === targetId)!;
    const runtime = new ReadingRuntime(root, authority, workspaceId, authorityIdentity, buildReadingTree);
    await runtime.initialize();
    await runtime.materialize();

    const malformedSensitiveResult = new Proxy(authority, {
      get(target, property) {
        if (property === "updateTreeNode") return async (...args: Parameters<ReadWeaveCourseApi["updateTreeNode"]>) => {
          const saved = await target.updateTreeNode(...args);
          return { ...saved, parentId: "missing-parent" };
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as ReadWeaveCourseApi;
    await observeReadingWrites(malformedSensitiveResult, runtime).updateTreeNode(targetId,
      { currentReleaseId: release.id }, targetNode.revision ?? 0, writeContext("sensitive-version-projection-failure"));

    expect(runtime.status()).toMatchObject({ ready: true, blockedObjects: 1 });
    await expect(runtime.replica.getPageSource(workspaceId, release.pages[0]!.id, release.id)).resolves.toBeUndefined();
    await expect(runtime.replica.getPageSource(workspaceId, siblingPage.id, siblingRelease.id))
      .resolves.toMatchObject({ page: { id: siblingPage.id } });
    runtime.close();

    let staleTree = true;
    const staleAuthority = new Proxy(authority, {
      get(target, property) {
        if (property === "listTreeNodes") return async () => {
          const nodes = await target.listTreeNodes();
          if (!staleTree) return nodes;
          return nodes.map((item) => item.id === targetId
            ? { ...item, revision: Math.max(0, (item.revision ?? 0) - 1) } : item);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as ReadWeaveCourseApi;
    const restarted = new ReadingRuntime(root, staleAuthority, workspaceId, authorityIdentity, buildReadingTree);
    await restarted.initialize();
    expect(restarted.status()).toMatchObject({ ready: true, blockedObjects: 1 });
    await restarted.refresh();
    expect(restarted.status()).toMatchObject({ ready: true, blockedObjects: 1 });
    await expect(restarted.replica.getPageSource(workspaceId, release.pages[0]!.id, release.id)).resolves.toBeUndefined();
    await expect(restarted.replica.getPageSource(workspaceId, siblingPage.id, siblingRelease.id))
      .resolves.toMatchObject({ page: { id: siblingPage.id } });

    staleTree = false;
    await restarted.refresh();
    expect(restarted.status()).toMatchObject({ ready: true, blockedObjects: 0 });
    await expect(restarted.replica.getPageSource(workspaceId, release.pages[0]!.id, release.id))
      .resolves.toMatchObject({ page: { id: release.pages[0]!.id } });
    restarted.close();
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

  it("keeps a failed draft projection scoped until a matching revision is confirmed", async () => {
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
    // The request body carries the current revision; the authority commits the
    // next revision, so protection must target expectedRevision + 1.
    const attemptedDraft = makeDraft(release, 0, "Authority acknowledged this draft");
    const acknowledged = await observeReadingWrites(badProjection, runtime)
      .saveDraft(attemptedDraft, 0, writeContext("projection-failure-write"));

    expect(acknowledged.workspaceId).toBe("different-workspace");
    expect(authorityWrites).toBe(1);
    expect(runtime.status()).toMatchObject({ ready: true, blockedObjects: 1 });
    await expect(runtime.replica.getPageSource(workspaceId, release.pages[0]!.id, release.id)).resolves.toBeUndefined();
    await expect(runtime.replica.getPageSource(workspaceId, release.pages[1]!.id, release.id))
      .resolves.toMatchObject({ page: { id: release.pages[1]!.id } });
    expect(await runtime.replica.listCourses(workspaceId)).toHaveLength(1);
    runtime.close();

    const staleAuthority = new Proxy(authority, {
      get(target, property) {
        if (property === "getDraftByPage") return async (pageId: string) => {
          const draft = await target.getDraftByPage(pageId);
          return draft ? { ...draft, revision: 0 } : undefined;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as ReadWeaveCourseApi;
    const stale = new ReadingRuntime(root, staleAuthority, workspaceId, authorityIdentity, buildReadingTree);
    await stale.initialize();
    expect(stale.status()).toMatchObject({ ready: true, blockedObjects: 1 });
    await stale.refresh();
    expect(stale.status()).toMatchObject({ ready: true, blockedObjects: 1 });
    await expect(stale.replica.getPageSource(workspaceId, release.pages[0]!.id, release.id)).resolves.toBeUndefined();
    await expect(stale.replica.getPageSource(workspaceId, release.pages[1]!.id, release.id))
      .resolves.toMatchObject({ page: { id: release.pages[1]!.id } });
    stale.close();

    const restarted = new ReadingRuntime(root, authority, workspaceId, authorityIdentity, buildReadingTree);
    await restarted.initialize();
    expect(restarted.status()).toMatchObject({ ready: true, blockedObjects: 1 });
    await restarted.refresh();
    expect(restarted.status()).toMatchObject({ ready: true, blockedObjects: 0 });
    expect(await restarted.replica.getDraft(workspaceId, attemptedDraft.pageId, release.id))
      .toMatchObject({ revision: 1, page: { blocks: [{ markdown: "Authority acknowledged this draft" }] } });
    expect(authorityWrites).toBe(1);
    restarted.close();
  });

  it("recovers a definitively rejected metadata write from authority but keeps uncertain writes blocked", async () => {
    const conflictRoot = await temporaryRoot();
    const conflictAuthority = new FileReadWeaveCourseApi(join(conflictRoot, "readweave-course-store.json"));
    await publishFixture(conflictAuthority);
    const conflictRuntime = new ReadingRuntime(conflictRoot, conflictAuthority, workspaceId, authorityIdentity, buildReadingTree);
    await conflictRuntime.initialize();
    await conflictRuntime.materialize();
    const material = conflictRuntime.replica.getTreeNode(workspaceId, "material:fixture-course:fixture-module")!;
    const etapiConflict = new Proxy(conflictAuthority, {
      get(target, property) {
        if (property === "updateTreeNode") return async () => { throw new Error("READWEAVE_ETAPI_409:revision conflict"); };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as ReadWeaveCourseApi;
    const rejected = observeReadingWrites(etapiConflict, conflictRuntime);

    await expect(rejected.updateTreeNode(material.id, { archived: true }, material.revision! - 1,
      writeContext("definitive-etapi-tree-conflict"))).rejects.toThrow("READWEAVE_ETAPI_409");
    expect(conflictRuntime.status()).toMatchObject({ ready: true, blockedObjects: 0 });
    await expect(conflictRuntime.replica.getPageSource(workspaceId, "fixture-page", "fixture-release"))
      .resolves.toMatchObject({ page: { id: "fixture-page" } });
    conflictRuntime.close();

    const uncertainRoot = await temporaryRoot();
    const uncertainAuthority = new FileReadWeaveCourseApi(join(uncertainRoot, "readweave-course-store.json"));
    await publishFixture(uncertainAuthority);
    const uncertainRuntime = new ReadingRuntime(uncertainRoot, uncertainAuthority, workspaceId, authorityIdentity, buildReadingTree);
    await uncertainRuntime.initialize();
    await uncertainRuntime.materialize();
    const uncertainMaterial = uncertainRuntime.replica.getTreeNode(workspaceId, "material:fixture-course:fixture-module")!;
    const interruptedAuthority = new Proxy(uncertainAuthority, {
      get(target, property) {
        if (property === "updateTreeNode") return async () => { throw new Error("ECONNRESET: outcome uncertain"); };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as ReadWeaveCourseApi;
    const interrupted = observeReadingWrites(interruptedAuthority, uncertainRuntime);

    await expect(interrupted.updateTreeNode(uncertainMaterial.id, { archived: true }, uncertainMaterial.revision!,
      writeContext("uncertain-tree-write"))).rejects.toThrow("ECONNRESET");
    expect(uncertainRuntime.status()).toMatchObject({ ready: true, blockedObjects: 1 });
    await uncertainRuntime.refresh();
    expect(uncertainRuntime.status()).toMatchObject({ ready: true, blockedObjects: 1 });
    await expect(uncertainRuntime.replica.getPageSource(workspaceId, "fixture-page", "fixture-release")).resolves.toBeUndefined();
    uncertainRuntime.close();
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
  const secondLesson = page("fixture-page-2");
  secondLesson.pageNumber = 2;
  secondLesson.title = "Confirmed fixture page two";
  const release: CourseRelease = {
    id: "fixture-release",
    courseId: course.id,
    courseTitle: course.title,
    moduleId: "fixture-module",
    moduleTitle: "Fixture Module",
    version: 1,
    publishedAt: stamp,
    pageIds: [lesson.id, secondLesson.id],
    pages: [lesson, secondLesson],
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
    pageHashes: [sha256Text(stableStringify(lesson)), sha256Text(stableStringify(secondLesson))],
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

describe("out-of-order acknowledged directory writes", () => {
  it("does not replace a newer archived node or clear its newer protection with an older callback", async () => {
    const root = await temporaryRoot();
    const authority = new FileReadWeaveCourseApi(join(root, "readweave-course-store.json"));
    const release = await publishFixture(authority);
    const runtime = new ReadingRuntime(root, authority, workspaceId, authorityIdentity, buildReadingTree);
    await runtime.initialize();
    await runtime.materialize();
    const id = `material:${release.courseId}:${release.moduleId}`;
    const initial = (await authority.listTreeNodes()).find(node => node.id === id)!;
    const older = await authority.updateTreeNode(id, { archived: false }, initial.revision ?? 0, writeContext("older-directory-result"));
    await runtime.saved("updateTreeNode", older, [id, { archived: false }, initial.revision ?? 0]);
    await runtime.beforeWrite("updateTreeNode", [id, { archived: true }, older.revision]);
    await runtime.saved("updateTreeNode", older, [id, { archived: false }, initial.revision ?? 0]);
    expect(runtime.status().blockedObjects).toBe(1);
    const newer = await authority.updateTreeNode(id, { archived: true }, older.revision ?? 0, writeContext("newer-directory-result"));
    await runtime.saved("updateTreeNode", newer, [id, { archived: true }, older.revision]);
    await runtime.saved("updateTreeNode", older, [id, { archived: false }, initial.revision ?? 0]);
    expect(runtime.replica.getTreeNode(workspaceId, id)).toMatchObject({ archived: true, revision: newer.revision });
    await expect(runtime.replica.getPageSource(workspaceId, release.pages[0]!.id, release.id)).resolves.toBeUndefined();
    runtime.close();
  });

  it("does not mark a newer write rejected when an older conflicting write returns late", async () => {
    const root = await temporaryRoot();
    const authority = new FileReadWeaveCourseApi(join(root, "readweave-course-store.json"));
    const release = await publishFixture(authority);
    const runtime = new ReadingRuntime(root, authority, workspaceId, authorityIdentity, buildReadingTree);
    await runtime.initialize();
    await runtime.materialize();
    const id = `material:${release.courseId}:${release.moduleId}`;
    const old = await runtime.beforeWrite("updateTreeNode", [id, { archived: false }, 1]);
    const latest = await runtime.beforeWrite("updateTreeNode", [id, { archived: true }, 2]);
    await runtime.writeFailed(old, new Error("READWEAVE_ETAPI_409"));
    expect(runtime.replica.projectionInvalidations(workspaceId)).toEqual([latest]);
    runtime.close();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
