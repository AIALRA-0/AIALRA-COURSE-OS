import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CourseProject, CourseRelease, CourseTreeNode, LessonDraft, PageLesson, TrashRecord, WorkspaceTree } from "@course-os/contracts";
import { toCourseReleaseIndex } from "@course-os/readweave-adapter";
import { ReadingReplica, type ReadingReplicaInput } from "./reading-replica.js";

const roots: string[] = [];
const stamp = "2026-09-30T12:00:00.000Z";
const questionAnswer = "confirmed question answer sentinel";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "course-os-reading-replica-"));
  roots.push(root);
  return root;
}

function course(id = "course-a", workspaceId = "workspace-a", status: CourseProject["status"] = "active"): CourseProject {
  return { id, workspaceId, title: `Course ${id}`, status, createdAt: stamp, updatedAt: stamp };
}

function page(id: string, title = `Page ${id}`): PageLesson {
  return {
    id,
    pageNumber: 1,
    title,
    imageUrl: `/api/v1/media/${id}-image-hash`,
    anchors: [{ id: `${id}:anchor`, pageId: id, kind: "text", label: "Source", text: `Full source text for ${title}` }],
    atoms: [],
    blocks: [{ id: `${id}:block`, title: "Explanation", kind: "core", markdown: `Saved lesson body for ${title}`, sourceAnchorIds: [`${id}:anchor`], atomIds: [] }],
    questionBank: [{
      id: `${id}:question`, pageId: id, objectiveId: `${id}:objective`, kind: "comprehension",
      prompt: `Question about ${title}`, expectedAnswer: questionAnswer, explanation: "Confirmed explanation",
      sourceAnchorIds: [`${id}:anchor`], status: "approved", version: 2, generatedBy: "test"
    }],
    coverageRequirements: [],
    coverageClaims: [],
    quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable: true, issues: [] }
  };
}

function release(
  id = "release-a",
  courseId = "course-a",
  pages: PageLesson[] = [page("page-a")],
  version = 1,
  workspaceModule = "module-a"
): CourseRelease {
  return {
    id, courseId, courseTitle: `Course ${courseId}`, moduleId: workspaceModule, moduleTitle: "Module A", version,
    publishedAt: `2026-09-${String(30 - version + 1).padStart(2, "0")}T00:00:00.000Z`,
    pageIds: pages.map((item) => item.id), pages, assessments: [], manifestHash: `manifest:${id}:v${version}`,
    writingPolicySnapshotId: "policy-a", modelRoute: "route-a", qualityHarnessVersion: "quality-a", costUsd: 17,
    lifecycle: "published"
  };
}

function draft(source: CourseRelease, sourcePage: PageLesson, revision = 1, contentHash = `draft-hash-${revision}`): LessonDraft {
  const savedPage = structuredClone(sourcePage);
  savedPage.blocks[0]!.markdown = `Saved draft revision ${revision}`;
  return {
    id: `draft:${sourcePage.id}`,
    workspaceId: source.courseId === "course-b" ? "workspace-b" : "workspace-a",
    courseId: source.courseId,
    moduleId: source.moduleId,
    sourceReleaseId: source.id,
    pageId: sourcePage.id,
    revision,
    status: "ready",
    page: savedPage,
    changedBlockIds: [savedPage.blocks[0]!.id],
    contentHash,
    updatedAt: new Date(Date.parse(stamp) + revision * 1_000).toISOString()
  };
}

function tree(workspaceId: string, courseId: string, releaseId: string, moduleId = "module-a"): WorkspaceTree {
  const materialId = `material:${courseId}:${moduleId}`;
  const material: CourseTreeNode = {
    id: materialId, materialId, kind: "material", title: "Material", parentId: courseId, releaseId,
    currentReleaseId: releaseId, children: []
  };
  return {
    workspaceId, title: `Tree ${workspaceId}`, treeVersion: "2.4.0",
    courses: [{ id: courseId, kind: "course", title: `Course ${courseId}`, children: [material] }],
    updatedAt: stamp
  };
}

function input(courses: CourseProject[], releases: CourseRelease[], workspaceId = "workspace-a", trash: TrashRecord[] = []): ReadingReplicaInput {
  const firstCourse = courses.find((item) => item.workspaceId === workspaceId) ?? courses[0]!;
  const firstRelease = releases.find((item) => item.courseId === firstCourse?.id) ?? releases[0];
  return { courses, releases, drafts: [], tree: tree(workspaceId, firstCourse?.id ?? "empty", firstRelease?.id ?? "empty"), trash };
}

describe("ReadingReplica", () => {
  it("keeps TestingSample visible while hiding regression courses and releases", async () => {
    const root = await temporaryRoot();
    const replica = new ReadingReplica(root, "authority:visibility-tests");
    await replica.initialize();

    const sampleCourse = course("TestingSample");
    const regressionCourse = course("course-regression-fixture");
    const sampleRelease = release("release-TestingSample", sampleCourse.id, [page("sample-page")]);
    const hiddenCourseRelease = release("release-private-course-fixture", regressionCourse.id, [page("regression-course-page")]);
    const regressionRelease = release("release-regression-fixture", sampleCourse.id, [page("regression-page")], 2, "regression-module");
    const workspaceTree = tree("workspace-a", sampleCourse.id, sampleRelease.id);
    const sampleCourseNode = workspaceTree.courses[0]!;
    sampleCourseNode.children!.push({
      id: `material:${sampleCourse.id}:${regressionRelease.moduleId}`,
      materialId: `material:${sampleCourse.id}:${regressionRelease.moduleId}`,
      kind: "material",
      title: regressionRelease.moduleTitle,
      parentId: sampleCourse.id,
      releaseId: regressionRelease.id,
      currentReleaseId: regressionRelease.id,
      children: []
    });
    const hiddenCourseMaterialId = `material:${regressionCourse.id}:${hiddenCourseRelease.moduleId}`;
    workspaceTree.courses.push({
      id: regressionCourse.id,
      kind: "course",
      title: regressionCourse.title,
      children: [{
        id: hiddenCourseMaterialId,
        materialId: hiddenCourseMaterialId,
        kind: "material",
        title: hiddenCourseRelease.moduleTitle,
        parentId: regressionCourse.id,
        releaseId: hiddenCourseRelease.id,
        currentReleaseId: hiddenCourseRelease.id,
        children: []
      }]
    });

    await replica.replace({
      courses: [sampleCourse, regressionCourse],
      releases: [sampleRelease, regressionRelease, hiddenCourseRelease],
      drafts: [],
      tree: workspaceTree,
      trash: []
    });

    expect((await replica.listCourses("workspace-a")).map((item) => item.id)).toEqual(["TestingSample"]);
    expect((await replica.listIndexes("workspace-a")).map((item) => item.id)).toEqual([sampleRelease.id]);
    await expect(replica.getReleaseIndex("workspace-a", regressionRelease.id)).resolves.toBeUndefined();
    await expect(replica.getReleaseIndex("workspace-a", hiddenCourseRelease.id)).resolves.toBeUndefined();
    const visibleTree = await replica.getTree("workspace-a");
    expect(visibleTree?.courses.map((item) => item.id)).toEqual(["TestingSample"]);
    expect(visibleTree?.courses[0]?.children?.map((item) => item.id)).toEqual([
      `material:${sampleCourse.id}:${sampleRelease.moduleId}`
    ]);
    expect(await replica.getPageSource("workspace-a", "sample-page", sampleRelease.id)).toBeDefined();
    await expect(replica.getPageSource("workspace-a", "regression-page", regressionRelease.id)).resolves.toBeUndefined();
    await expect(replica.getPageSource("workspace-a", "regression-course-page", hiddenCourseRelease.id)).resolves.toBeUndefined();
  });

  it("restarts offline, refreshes lightweight indexes without replacing bodies, and verifies page hashes", async () => {
    const root = await temporaryRoot();
    const replica = new ReadingReplica(root, "authority:readweave:account-a");
    expect(replica.status()).toMatchObject({ ready: false, revision: 0, courses: 0, pages: 0 });
    await replica.initialize();
    expect(replica.status().ready).toBe(false);
    await expect(replica.listCourses("workspace-a")).rejects.toThrow("READING_NOT_READY");

    const source = release();
    await replica.replace({
      courses: [course()], releases: [source], drafts: [], tree: tree("workspace-a", "course-a", source.id), trash: []
    });
    expect(replica.status()).toMatchObject({ ready: true, revision: 1, courses: 1, pages: 1, releases: 1, lastConfirmedAt: expect.any(String) });

    const metadataOnly = toCourseReleaseIndex(source);
    metadataOnly.costUsd = 9876;
    metadataOnly.pages[0]!.title = "Refreshed title";
    await replica.updateMetadata({ indexes: [metadataOnly] }, replica.revision);
    const persistedIndex = await replica.getReleaseIndex("workspace-a", source.id);
    expect(persistedIndex?.costUsd).toBe(0);
    expect(persistedIndex?.pages[0]?.title).toBe("Refreshed title");
    expect(persistedIndex?.pages[0]?.questionBank).toEqual([]);

    const catalogText = await readFile(join(root, "reading-replica", "catalog.json"), "utf8");
    expect(catalogText).not.toContain(questionAnswer);
    expect(catalogText).not.toContain("Saved lesson body");

    const restarted = new ReadingReplica(root, "authority:readweave:account-a");
    await restarted.initialize();
    await expect(restarted.listCourses("workspace-a")).resolves.toMatchObject([{ id: "course-a" }]);
    const saved = await restarted.getPageSource("workspace-a", "page-a", source.id);
    expect(saved?.page.blocks[0]?.markdown).toBe("Saved lesson body for Page page-a");
    expect(saved?.page.questionBank?.[0]?.expectedAnswer).toBe(questionAnswer);
    expect(saved?.release.pages[0]?.title).toBe("Refreshed title");
    await expect(restarted.getPageSource("workspace-a", "page-a", "different-release")).resolves.toBeUndefined();

    const placeholderIndex = toCourseReleaseIndex(source);
    const placeholder = { ...source, pages: placeholderIndex.pages as unknown as PageLesson[] };
    await restarted.replace({ courses: [course()], releases: [placeholder], drafts: [], tree: tree("workspace-a", "course-a", source.id), trash: [] }, restarted.revision);
    expect((await restarted.getPageSource("workspace-a", "page-a", source.id))?.page.blocks[0]?.markdown)
      .toBe("Saved lesson body for Page page-a");

    const otherAuthority = new ReadingReplica(root, "authority:readweave:account-b");
    await expect(otherAuthority.initialize()).rejects.toThrow("READING_AUTHORITY_MISMATCH");

    const catalog = JSON.parse(catalogText) as { payload: { releases: Array<{ pages: Array<{ snapshot: { snapshotHash: string } }> }> } };
    const hash = catalog.payload.releases[0]!.pages[0]!.snapshot.snapshotHash;
    await writeFile(join(root, "reading-replica", "snapshots", `${hash}.json`), "tampered\n", "utf8");
    await expect(restarted.getPageSource("workspace-a", "page-a", source.id)).rejects.toThrow("READING_CORRUPT");
  });

  it("keeps first import registration metadata-only until a confirmed draft arrives and rejects older page versions", async () => {
    const root = await temporaryRoot();
    const replica = new ReadingReplica(root, "authority:local-store");
    await replica.initialize();
    const source = { ...release(), lifecycle: "draft_source" as const };
    await replica.updateMetadata({ courses: [course()], tree: tree("workspace-a", "course-a", source.id) });

    expect(await replica.upsertRelease(source)).toBe(true);
    expect(replica.status().pages).toBe(0);
    await expect(replica.getPageSource("workspace-a", "page-a", source.id)).resolves.toBeUndefined();

    const previousRevision = replica.revision;
    const confirmed = draft(source, source.pages[0]!, 4, "hash-v4");
    expect(await replica.upsertDraft(confirmed)).toBe(true);
    expect(await replica.upsertDraft(draft(source, source.pages[0]!, 3, "hash-v3"))).toBe(false);
    expect(await replica.upsertDraft(draft(source, source.pages[0]!, 4, "different-same-revision"))).toBe(false);
    const saved = await replica.getPageSource("workspace-a", "page-a", source.id);
    expect(saved?.draft).toMatchObject({ revision: 4, contentHash: "hash-v4" });
    expect(saved?.page.questionBank?.[0]?.expectedAnswer).toBe(questionAnswer);
    expect((await replica.getDraft("workspace-a", "page-a", source.id))?.contentHash).toBe("hash-v4");
    expect(await replica.updateMetadata({ indexes: [toCourseReleaseIndex(source)] }, previousRevision)).toBe(false);

    const newest = draft(source, source.pages[0]!, 5, "hash-v5");
    newest.page.blocks[0]!.markdown = "Newest acknowledged draft lesson";
    expect(await replica.upsertDraft(newest)).toBe(true);
    const newestSource = await replica.getPageSource("workspace-a", "page-a", source.id);
    expect(newestSource?.page.blocks[0]?.markdown).toBe("Newest acknowledged draft lesson");
    expect(newestSource?.draft?.revision).toBe(5);

    const restarted = new ReadingReplica(root, "authority:local-store");
    await restarted.initialize();
    expect((await restarted.getDraft("workspace-a", "page-a"))?.revision).toBe(5);
  });

  it("uses the latest ready draft as draft-source lesson content and withholds unready placeholders", async () => {
    const root = await temporaryRoot();
    const replica = new ReadingReplica(root, "authority:draft-source-readiness");
    await replica.initialize();

    const raw = release("draft-source-ready-check", "course-a", [page("ready-page"), page("unready-page")]);
    const source = { ...raw, lifecycle: "draft_source" as const };
    const placeholders = structuredClone(source);
    placeholders.pages[0]!.blocks[0]!.markdown = "Nonempty source index placeholder";
    placeholders.pages[1]!.blocks[0]!.markdown = "Nonempty source index placeholder";

    const ready = draft(source, placeholders.pages[0]!, 4, "ready-source-hash");
    ready.page.blocks[0]!.markdown = "Latest confirmed READY lesson body";
    const unready = draft(source, placeholders.pages[1]!, 3, "unready-source-hash");
    unready.status = "editing";
    unready.page.blocks[0]!.markdown = "Unready placeholder draft body";

    await replica.replace({
      courses: [course()],
      releases: [placeholders],
      drafts: [ready, unready],
      tree: tree("workspace-a", "course-a", source.id),
      trash: []
    });

    const readySource = await replica.getPageSource("workspace-a", "ready-page", source.id);
    expect(readySource?.page.blocks[0]?.markdown).toBe("Latest confirmed READY lesson body");
    expect(readySource?.draft?.status).toBe("ready");
    await expect(replica.getPageSource("workspace-a", "unready-page", source.id)).resolves.toBeUndefined();
    expect((await replica.getDraft("workspace-a", "unready-page", source.id))?.page.blocks[0]?.markdown)
      .toBe("Unready placeholder draft body");

    const newerUnready = draft(source, placeholders.pages[0]!, 5, "newer-unready-source-hash");
    newerUnready.status = "editing";
    newerUnready.page.blocks[0]!.markdown = "Newer unready edit";
    expect(await replica.upsertDraft(newerUnready)).toBe(true);
    const preservedSource = await replica.getPageSource("workspace-a", "ready-page", source.id);
    expect(preservedSource?.page.blocks[0]?.markdown).toBe("Latest confirmed READY lesson body");
    expect(preservedSource?.draft?.status).toBe("editing");
    expect((await replica.getDraft("workspace-a", "ready-page", source.id))?.page.blocks[0]?.markdown)
      .toBe("Newer unready edit");
  });

  it("materializes the full confirmed body when a formal release is published", async () => {
    const root = await temporaryRoot();
    const replica = new ReadingReplica(root, "authority:published-release");
    await replica.initialize();
    const published = release("formal-release");
    await replica.updateMetadata({ courses: [course()], indexes: [toCourseReleaseIndex(published)] });
    expect(replica.status().pages).toBe(0);
    expect(await replica.upsertRelease(published)).toBe(true);
    expect(replica.status().pages).toBe(1);
    expect((await replica.getPageSource("workspace-a", "page-a", published.id))?.page.blocks[0]?.markdown)
      .toBe("Saved lesson body for Page page-a");
  });

  it("uses revision CAS for concurrent rebuilds and preserves the committed catalog on a failed rebuild", async () => {
    const root = await temporaryRoot();
    const replica = new ReadingReplica(root, "authority:cas");
    await replica.initialize();
    const original = release();
    await replica.replace({ courses: [course()], releases: [original], drafts: [], tree: tree("workspace-a", "course-a", original.id), trash: [] });

    const expected = replica.revision;
    const candidate2 = release("release-a", "course-a", [page("page-a", "v2")], 2);
    const candidate3 = release("release-a", "course-a", [page("page-a", "v3")], 3);
    const outcomes = await Promise.all([
      replica.replace({ courses: [course()], releases: [candidate2], drafts: [], tree: tree("workspace-a", "course-a", original.id), trash: [] }, expected),
      replica.replace({ courses: [course()], releases: [candidate3], drafts: [], tree: tree("workspace-a", "course-a", original.id), trash: [] }, expected)
    ]);
    expect(outcomes.filter((outcome) => outcome !== false)).toHaveLength(1);
    expect(replica.revision).toBe(expected + 1);
    expect(await replica.updateMetadata({ tree: tree("workspace-a", "course-a", original.id) }, expected)).toBe(false);

    const snapshotsDir = join(root, "reading-replica", "snapshots");
    const beforeFailure = await readdir(snapshotsDir);
    const cyclic = page("cycle-page") as PageLesson & { self?: unknown };
    cyclic.self = cyclic;
    const invalid = release("release-failed", "course-a", [page("staged-page"), cyclic]);
    const failedInput = { courses: [course()], releases: [invalid], drafts: [], tree: tree("workspace-a", "course-a", invalid.id), trash: [] };
    await expect(replica.replace(failedInput)).rejects.toThrow();
    expect(replica.revision).toBe(expected + 1);
    expect(await replica.listIndexes("workspace-a")).toHaveLength(1);
    expect(await readdir(snapshotsDir)).toEqual(beforeFailure);
  });

  it("isolates workspaces and denies archived or tombstoned course material immediately", async () => {
    const root = await temporaryRoot();
    const replica = new ReadingReplica(root, "authority:workspace-scoped");
    await replica.initialize();
    const sharedPageA = page("same-page", "Workspace A");
    const sharedPageB = page("same-page", "Workspace B");
    const releaseA = release("release-a", "course-a", [sharedPageA]);
    const releaseB = release("release-b", "course-b", [sharedPageB], 1, "module-b");
    await replica.replace({
      courses: [course("course-a", "workspace-a"), course("course-b", "workspace-b")],
      releases: [releaseA, releaseB], drafts: [], tree: tree("workspace-a", "course-a", releaseA.id), trash: []
    });

    expect((await replica.listCourses("workspace-b")).map((item) => item.id)).toEqual(["course-b"]);
    expect((await replica.getPageSource("workspace-b", "same-page", releaseB.id))?.page.title).toBe("Workspace B");
    await expect(replica.getPageSource("workspace-a", "same-page", releaseB.id)).resolves.toBeUndefined();
    expect(await replica.getTree("workspace-b")).toBeUndefined();

    const tombstone: TrashRecord = {
      id: "trash-material-a", workspaceId: "workspace-a", nodeId: "material:course-a:module-a", nodeKind: "material",
      title: "Deleted material", deletedAt: stamp, deletedBy: "test", restoreAvailable: true
    };
    await replica.updateMetadata({ trash: [tombstone] });
    await expect(replica.getPageSource("workspace-a", "same-page", releaseA.id)).resolves.toBeUndefined();
    expect(await replica.listIndexes("workspace-a")).toEqual([]);
    expect(await replica.listIndexes("workspace-b")).toHaveLength(1);
    expect((await replica.getTree("workspace-a"))?.courses[0]?.children).toEqual([]);

    await replica.updateMetadata({ courses: [course("course-a", "workspace-a", "archived"), course("course-b", "workspace-b")] });
    expect(await replica.listCourses("workspace-a")).toEqual([]);
    await expect(replica.getPageSource("workspace-a", "same-page", releaseA.id)).resolves.toBeUndefined();
  });

  it("deletes only unreferenced replica snapshots and leaves nearby source files intact", async () => {
    const root = await temporaryRoot();
    const externalSource = join(root, "source-image.pdf");
    await writeFile(externalSource, "source-owned", "utf8");
    const replica = new ReadingReplica(root, "authority:delete");
    await replica.initialize();
    const source = release();
    await replica.replace({ courses: [course()], releases: [source], drafts: [], tree: tree("workspace-a", "course-a", source.id), trash: [] });
    expect(await readdir(join(root, "reading-replica", "snapshots"))).toHaveLength(1);

    const withoutPage = toCourseReleaseIndex(source);
    withoutPage.pages = [];
    withoutPage.pageIds = [];
    await replica.updateMetadata({ indexes: [withoutPage] }, replica.revision);
    await expect(replica.getPageSource("workspace-a", "page-a", source.id)).resolves.toBeUndefined();
    expect(await readdir(join(root, "reading-replica", "snapshots"))).toEqual([]);

    await replica.updateMetadata({ indexes: [] }, replica.revision);
    await replica.replace({ courses: [], releases: [], drafts: [], tree: tree("workspace-a", "empty", "empty"), trash: [] }, replica.revision);
    expect(replica.status()).toMatchObject({ courses: 0, releases: 0, pages: 0 });
    expect(await readdir(join(root, "reading-replica", "snapshots"))).toEqual([]);
    await expect(readFile(externalSource, "utf8")).resolves.toBe("source-owned");
  });
});
