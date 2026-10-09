import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CourseProject, CourseRelease, LessonDraft, PageLesson } from "@course-os/contracts";
import { currentReadBudget, FileReadWeaveCourseApi } from "@course-os/readweave-adapter";
import { buildReadingTree, createApp, createDefaultDependencies } from "./app.js";
import { ReadingRuntime } from "./reading-runtime.js";
import { readingProjectionInvalidationId } from "./reading-replica.js";
import { registerSelfRetellingRoutes } from "./self-retelling-routes.js";

const roots: string[] = [];
const stamp = "2026-09-30T12:00:00.000Z";

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function testPage(): PageLesson {
  return {
    id: "page-a",
    pageNumber: 1,
    title: "Page A",
    imageUrl: "/page-a.png",
    anchors: [{ id: "anchor-a", pageId: "page-a", kind: "text", label: "Source", text: "Source text" }],
    atoms: [],
    blocks: [{ id: "block-a", title: "Check", kind: "check", markdown: "What is the answer?", sourceAnchorIds: [], atomIds: [] }],
    questionBank: [{
      id: "question-a", pageId: "page-a", objectiveId: "objective-a", kind: "comprehension",
      prompt: "Answer yes?", expectedAnswer: "yes", explanation: "The confirmed answer is yes.",
      sourceAnchorIds: ["anchor-a"], status: "approved", version: 1, generatedBy: "test"
    }],
    coverageRequirements: [],
    coverageClaims: [],
    quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable: true, issues: [] }
  };
}

function testRelease(page = testPage()): CourseRelease {
  return {
    id: "release-a", courseId: "course-a", courseTitle: "Course A", moduleId: "module-a", moduleTitle: "Module A",
    version: 1, publishedAt: stamp, pageIds: [page.id], pages: [page], assessments: [], manifestHash: "manifest-a",
    writingPolicySnapshotId: "policy-a", modelRoute: "test", qualityHarnessVersion: "test", costUsd: 0, lifecycle: "published"
  };
}

function testDraft(release = testRelease(), page = release.pages[0]!): LessonDraft {
  return {
    id: "draft:page-a", workspaceId: "personal", courseId: release.courseId, moduleId: release.moduleId,
    sourceReleaseId: release.id, pageId: page.id, revision: 1, status: "ready", page: structuredClone(page),
    changedBlockIds: [], contentHash: "draft-hash-a", updatedAt: stamp
  };
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "course-os-reading-routes-"));
  roots.push(root);
  const authority = new FileReadWeaveCourseApi(join(root, "authority.json"));
  const dependencies = createDefaultDependencies(root, authority);
  const course: CourseProject = { id: "course-a", workspaceId: "personal", title: "Course A", status: "active", createdAt: stamp, updatedAt: stamp };
  const release = testRelease();
  const draft = testDraft(release);
  const reading = new ReadingRuntime(join(root, "reading"), authority, "personal", "authority:reading-routes", () => buildReadingTree([course], [], [], "personal"));
  await reading.initialize();
  await reading.replica.replace({ courses: [course], releases: [release], drafts: [draft], tree: buildReadingTree([course], [], [], "personal"), trash: [] });
  dependencies.reading = reading;
  const app = createApp(dependencies);
  registerSelfRetellingRoutes(app, dependencies);
  return { app, authority, dependencies, reading, release, draft };
}

describe("replica-backed reading routes", () => {
  it("serves all 56 catalog pages and original images during draft fences but denies deleted images", async () => {
    const { app, dependencies, reading, release } = await harness();
    const courses = await reading.replica.listCourses("personal");
    const pages: PageLesson[] = [];
    for (let index = 0; index < 56; index += 1) {
      const image = await dependencies.cas.put(Buffer.from(`original-image-${index + 1}`));
      pages.push({ ...testPage(), id: `source-page-${index + 1}`, pageNumber: index + 1, imageUrl: `/api/v1/media/${image.sha256}` });
    }
    const source = { ...release, lifecycle: "draft_source" as const, pages, pageIds: pages.map(item => item.id) };
    await reading.replica.replace({ courses, releases: [source], drafts: [], tree: buildReadingTree(courses, [], [], "personal"), trash: [] });
    for (const item of pages.slice(24, 32)) await reading.replica.invalidateProjection({
      id: readingProjectionInvalidationId("personal", "page", item.id),
      workspaceId: "personal", targetKind: "page", targetId: item.id, reason: "draft", revision: 2
    });
    const index = await request(app).get(`/api/v1/releases/${source.id}`).expect(200);
    expect(index.body.pages).toHaveLength(56);
    expect(index.body.pageIds).toEqual(source.pageIds);
    for (const item of pages) await request(app).get(item.imageUrl).expect(200);
    await request(app).get(`/api/v1/pages/${pages[27]!.id}/draft?view=snapshot&releaseId=${source.id}`).expect(409);

    const deleted = pages[27]!;
    await reading.replica.invalidateProjection({
      id: readingProjectionInvalidationId("personal", "page", deleted.id),
      workspaceId: "personal", targetKind: "page", targetId: deleted.id, reason: "permanent-delete"
    });
    const unavailable = await request(app).get(deleted.imageUrl).expect(404);
    expect(unavailable.body.error.code).toBe("MEDIA_NOT_AVAILABLE");
    const afterDelete = await request(app).get(`/api/v1/releases/${source.id}`).expect(200);
    expect(afterDelete.body.pages).toHaveLength(55);
    expect(afterDelete.body.pageIds).not.toContain(deleted.id);
    await request(app).get(pages[29]!.imageUrl).expect(200);
    reading.close();
  });

  it("keeps the review map identical while reading only current confirmed published pages", async () => {
    const { app, authority, dependencies, reading, release, draft } = await harness();
    const courses = await reading.replica.listCourses("personal");
    const page = { ...testPage(), blocks: [{ ...testPage().blocks[0]!, kind: "objective" as const, markdown: "Published objective text" }] };
    const latest = { ...release, id: "release-latest", version: 2, publishedAt: "2026-10-01T12:00:00.000Z", pages: [page] };
    const releases = [release, { ...latest, id: "release-earlier", publishedAt: stamp }, latest,
      { ...release, id: "release-draft", version: 9, lifecycle: "draft_source" as const },
      { ...release, id: "regression-release", moduleId: "other-module" }];
    await reading.replica.replace({ courses, releases, drafts: [{ ...draft, sourceReleaseId: latest.id,
      page: { ...page, questionBank: [{ ...page.questionBank![0]!, objectiveId: "unpublished-objective" }] } }],
      tree: buildReadingTree(courses, [], [], "personal"), trash: [] });
    vi.spyOn(authority, "listCourses").mockResolvedValue(courses);
    vi.spyOn(authority, "listReleases").mockResolvedValue(releases);
    vi.spyOn(authority, "listTrash").mockResolvedValue([]);
    vi.spyOn(authority, "listMastery").mockResolvedValue([{ objectiveId: "objective-a", state: "needs_review",
      unaidedCorrect: true, delayedOrTransferCorrect: false, nextReviewAt: stamp, intervalStep: 2,
      algorithmVersion: "review-ladder-v1", updatedAt: stamp }]);
    vi.spyOn(authority, "listAssessmentAttempts").mockResolvedValue([{ id: "attempt-a", itemId: "question-a", objectiveId: "objective-a",
      answer: "yes", correct: true, usedHintLevel: 1, misconception: "Earlier misconception", attemptedAt: stamp }]);
    const baseline = await request(createApp({ ...dependencies, reading: undefined })).get("/api/v1/review-map").expect(200);
    const forbidden = ["listCourses", "listReleases", "listReleaseIndexes", "listTreeNodes", "listTrash", "getRelease", "getDraftByPage"] as const;
    for (const method of forbidden) vi.spyOn(authority, method).mockClear().mockRejectedValue(new Error("FULL_AUTHORITY_READ_MUST_NOT_RUN"));
    const sourceRead = vi.spyOn(reading.replica, "getPageSource");
    const confirmed = await request(app).get("/api/v1/review-map").expect(200);
    expect({ ...confirmed.body, generatedAt: null }).toEqual({ ...baseline.body, generatedAt: null });
    expect(confirmed.body.objectives[0]).toMatchObject({ objectiveId: "objective-a", objectiveText: "Published objective text",
      releaseId: latest.id, due: true, attemptCount: 1, hintDependencyCount: 1, lastMisconception: "Earlier misconception" });
    expect(sourceRead).toHaveBeenCalledExactlyOnceWith("personal", "page-a", latest.id);
    await request(app).get("/api/v1/review-queue").expect(200).expect(response => expect(response.body).toHaveLength(1));
    for (const method of forbidden) expect(authority[method]).not.toHaveBeenCalled();
  });

  it("preserves legacy review objective identity using only its authorized selected release", async () => {
    const { app, authority, reading, release } = await harness();
    const legacy = { ...release, id: "release-old-format", version: 2, pages: [{ ...release.pages[0]!, questionBank: [] }], assessments: [{ id: "assessment-a",
      objectiveId: "legacy-objective", pageId: "page-a", prompt: "Legacy prompt", expectedAnswer: "yes", transfer: false }] };
    await reading.replica.upsertRelease(legacy);
    const selected = vi.spyOn(authority, "getRelease").mockResolvedValue(legacy);
    const all = vi.spyOn(authority, "listReleases").mockRejectedValue(new Error("FULL_AUTHORITY_READ_MUST_NOT_RUN"));
    const map = await request(app).get("/api/v1/review-map").expect(200);
    expect(map.body.objectives[0].objectiveId).toBe("legacy-objective");
    expect(selected).toHaveBeenCalledExactlyOnceWith(legacy.id);
    expect(all).not.toHaveBeenCalled();
  });

  it("restores a review session from its confirmed page without loading full versions", async () => {
    const { app, authority, dependencies, draft } = await harness();
    await dependencies.operations.mutate(state => { state.reviewSessions.push({ id: "review-a", workspaceId: "personal",
      source: "manual", seed: "seed-a", objectiveIds: ["objective-a"], currentIndex: 0, status: "active",
      currentObjectiveId: "objective-a", questionIdsByObjective: { "objective-a": ["question-a"] }, createdAt: stamp, updatedAt: stamp }); });
    const forbidden = ["getRelease", "listReleases", "listReleaseIndexes", "listCourses", "listTreeNodes", "listTrash"] as const;
    for (const method of forbidden) vi.spyOn(authority, method).mockRejectedValue(new Error("FULL_AUTHORITY_READ_MUST_NOT_RUN"));
    const native = vi.spyOn(authority, "getDraftByPage").mockResolvedValue(draft);
    for (const path of ["/api/v1/review-sessions/current", "/api/v1/review-sessions/review-a"]) {
      const restored = await request(app).get(path).expect(200);
      expect(restored.body).toMatchObject({ session: { id: "review-a" }, objective: { objectiveId: "objective-a" }, question: { id: "question-a" } });
    }
    expect(native).toHaveBeenCalledTimes(2);
    for (const method of forbidden) expect(authority[method]).not.toHaveBeenCalled();
    await request(app).get("/api/v1/review-sessions/review-a").set("X-Workspace-Id", "other").expect(404);
    await request(app).get("/api/v1/review-map").set("X-Workspace-Id", "other").expect(200)
      .expect(response => expect(response.body).toMatchObject({ pageCount: 0, releaseCount: 0, objectives: [] }));
  });

  it("blocks the review map after source access denial and never falls back for a missing confirmed page", async () => {
    const { app, authority, reading } = await harness();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const full = vi.spyOn(authority, "listReleases").mockRejectedValue(new Error("FULL_AUTHORITY_READ_MUST_NOT_RUN"));
    vi.spyOn(reading.replica, "getPageSource").mockResolvedValue(undefined);
    const missing = await request(app).get("/api/v1/review-map").expect(503);
    expect(missing.body.error.code).toBe("READING_NOT_READY");
    vi.spyOn(reading, "assertAccess").mockImplementation(() => { throw new Error("READING_ACCESS_DENIED"); });
    const activities = vi.spyOn(authority, "listMastery").mockClear();
    for (const path of ["/api/v1/review-map", "/api/v1/review-queue"]) {
      await request(app).get(path).expect(403);
    }
    expect(activities).not.toHaveBeenCalled();
    expect(full).not.toHaveBeenCalled();
  });

  it("cancels a hung native draft at the existing eight-second deadline and permits a fresh read", async () => {
    const { app, authority, draft } = await harness();
    let signal: AbortSignal | undefined;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reconcile = vi.spyOn(authority, "getDraftByPage").mockImplementationOnce(async () => {
      signal = currentReadBudget()?.signal;
      if (!signal) throw new Error("READ_BUDGET_REQUIRED");
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    }).mockResolvedValue(draft);
    const timedOut = await request(app).get("/api/v1/pages/page-a/draft").expect(504);
    expect(timedOut.body.error.code).toBe("READ_DEADLINE_EXCEEDED");
    expect(signal?.aborted).toBe(true);
    await request(app).get("/api/v1/pages/page-a/draft").expect(200);
    expect(reconcile).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("forwards a disconnected editing request to the native draft read and permits recovery", async () => {
    const { app, authority, draft } = await harness();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let signal: AbortSignal | undefined;
    let entered!: () => void;
    let cancelled!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const aborted = new Promise<void>(resolve => { cancelled = resolve; });
    vi.spyOn(authority, "getDraftByPage").mockImplementationOnce(async () => {
      signal = currentReadBudget()?.signal;
      if (!signal) throw new Error("READ_BUDGET_REQUIRED");
      entered();
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => {
        cancelled();
        reject(signal!.reason);
      }, { once: true }));
    }).mockResolvedValue(draft);
    const server = app.listen(0);
    try {
      await new Promise<void>(resolve => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_UNAVAILABLE");
      const client = httpRequest({ host: "127.0.0.1", port: address.port, path: "/api/v1/pages/page-a/draft" });
      client.on("error", () => undefined);
      client.end();
      await started;
      client.destroy();
      await aborted;
      expect(signal?.aborted).toBe(true);
      await request(app).get("/api/v1/pages/page-a/draft").expect(200);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it("reuses the confirmed source for editing while reconciling only the selected native draft", async () => {
    const { app, authority, draft, reading } = await harness();
    const reads = ["getRelease", "listReleases", "listReleaseIndexes", "listCourses", "listTreeNodes", "listTrash"] as const;
    for (const method of reads) vi.spyOn(authority, method).mockRejectedValue(new Error("UNRELATED_AUTHORITY_READ_MUST_NOT_RUN"));
    const updated = { ...draft, revision: draft.revision + 1, contentHash: "native-edit-hash", page: { ...draft.page, title: "Native edit" } };
    const reconcile = vi.spyOn(authority, "getDraftByPage").mockResolvedValue(updated);
    const result = await request(app).get("/api/v1/pages/page-a/draft").set("X-Workspace-Id", "personal").expect(200);
    expect(result.body).toMatchObject({ revision: updated.revision, contentHash: updated.contentHash, page: { title: "Native edit" } });
    expect(result.headers["server-timing"]).toMatch(/source;dur=.*draft;dur=.*projection;dur=/u);
    expect(reconcile).toHaveBeenCalledExactlyOnceWith("page-a");
    for (const method of reads) expect(authority[method]).not.toHaveBeenCalled();
    expect(await reading.replica.getDraft("personal", "page-a", "release-a")).toMatchObject({ contentHash: updated.contentHash });
  });

  it("reads container properties from the confirmed directory without rebuilding authority indexes", async () => {
    const { app, authority } = await harness();
    for (const method of ["listCourses", "listReleases", "listDrafts", "listTreeNodes", "listTrash", "getTreeNodeProperties"] as const) {
      vi.spyOn(authority, method).mockRejectedValue(new Error("unrelated authority index must not be read"));
    }
    const result = await request(app).get("/api/v1/tree/nodes/course-a/properties")
      .set("X-Workspace-Id", "personal").expect(200);
    expect(result.body).toMatchObject({ nodeId: "course-a", kind: "course", title: "Course A" });
    await request(app).get("/api/v1/tree/nodes/course-a/properties")
      .set("X-Workspace-Id", "another-workspace").expect(404);
    expect(authority.listDrafts).not.toHaveBeenCalled();
    expect(authority.getTreeNodeProperties).not.toHaveBeenCalled();
  });
  it.each(["READWEAVE_ETAPI_401", "READWEAVE_ETAPI_403", "READWEAVE_HTTP_401", "READWEAVE_HTTP_403"])(
    "reports %s as terminal access denial on the first confirmation and blocks previously readable copies",
    async (upstreamCode) => {
      const { app, authority, reading } = await harness();
      await request(app).get("/api/v1/pages/page-a/draft?view=snapshot&releaseId=release-a")
        .set("X-Workspace-Id", "personal").expect(200);
      vi.spyOn(authority, "getDraftByPage").mockRejectedValue(new Error(`${upstreamCode}: source access denied`));

      const denied = await request(app).get("/api/v1/pages/page-a/draft?view=snapshot&releaseId=release-a&confirm=1")
        .set("X-Workspace-Id", "personal").expect(403);
      expect(denied.body.error).toMatchObject({ code: "ACCESS_DENIED", retryable: false });
      expect(reading.status()).toMatchObject({ accessDenied: true, ready: false });
      for (const path of [
        "/api/v1/pages/page-a/draft?view=snapshot&releaseId=release-a",
        "/api/v1/pages/page-a/lesson?releaseId=release-a",
        "/api/v1/releases?view=index"
      ]) {
        const blocked = await request(app).get(path).set("X-Workspace-Id", "personal").expect(403);
        expect(blocked.body.error).toMatchObject({ code: "ACCESS_DENIED", retryable: false });
      }
    }
  );

  it("keeps confirmed copies readable after a temporary source failure", async () => {
    const { app, authority, reading, draft } = await harness();
    vi.spyOn(authority, "getDraftByPage").mockRejectedValue(new Error("READWEAVE_ETAPI_503: temporary outage"));
    const failed = await request(app).get("/api/v1/pages/page-a/draft?view=snapshot&releaseId=release-a&confirm=1")
      .set("X-Workspace-Id", "personal").expect(503);
    expect(failed.body.error).toMatchObject({ code: "READWEAVE_UNAVAILABLE", retryable: true });
    expect(failed.body.error.message).toContain("无法确认操作结果");
    expect(failed.body.error.message).not.toContain("尚未保存");
    expect(reading.status()).toMatchObject({ accessDenied: false, ready: true, synchronization: "degraded" });
    const local = await request(app).get("/api/v1/pages/page-a/draft?view=snapshot&releaseId=release-a")
      .set("X-Workspace-Id", "personal").expect(200);
    expect(local.body).toMatchObject({ contentHash: draft.contentHash, sourceReleaseId: draft.sourceReleaseId });
  });

  it("serves replica release indexes as equivalent gzip and identity JSON without authority reads", async () => {
    const { app, authority } = await harness();
    const listReleaseIndexes = vi.spyOn(authority, "listReleaseIndexes").mockRejectedValue(new Error("REMOTE_INDEX_READ_MUST_NOT_RUN"));
    const listReleases = vi.spyOn(authority, "listReleases").mockRejectedValue(new Error("REMOTE_RELEASE_READ_MUST_NOT_RUN"));
    const listCourses = vi.spyOn(authority, "listCourses").mockRejectedValue(new Error("REMOTE_COURSE_READ_MUST_NOT_RUN"));
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_UNAVAILABLE");
      const getIndexes = (acceptEncoding: string) => new Promise<{
        headers: import("node:http").IncomingHttpHeaders;
        body: Buffer;
      }>((resolve, reject) => {
        const req = httpRequest({
          host: "127.0.0.1",
          port: address.port,
          path: "/api/v1/releases?view=index",
          headers: { "Accept-Encoding": acceptEncoding, "X-Workspace-Id": "personal" }
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.end();
      });

      const plain = await getIndexes("identity");
      const compressed = await getIndexes("gzip");
      const plainJson = JSON.parse(plain.body.toString("utf8"));
      const compressedJson = JSON.parse(gunzipSync(compressed.body).toString("utf8"));
      expect(compressedJson).toEqual(plainJson);
      expect(plain.headers["content-encoding"]).toBeUndefined();
      expect(compressed.headers["content-encoding"]).toBe("gzip");
      for (const headers of [plain.headers, compressed.headers]) {
        const vary = (headers.vary ?? "").split(",").map((value) => value.trim().toLowerCase());
        expect(vary).toContain("accept-encoding");
        expect(vary).toContain("x-workspace-id");
        expect(headers["cache-control"]).toBe("private, no-store");
      }
      expect(listReleaseIndexes).not.toHaveBeenCalled();
      expect(listReleases).not.toHaveBeenCalled();
      expect(listCourses).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("serves an exact local snapshot and reconciles only after local workspace/release/page authorization", async () => {
    const { app, authority, reading, draft } = await harness();
    const getDraftByPage = vi.spyOn(authority, "getDraftByPage").mockRejectedValue(new Error("REMOTE_READ_MUST_NOT_RUN"));
    const confirm = vi.spyOn(reading, "confirmPage").mockResolvedValue();

    const local = await request(app).get("/api/v1/pages/page-a/draft?view=snapshot&releaseId=release-a")
      .set("X-Workspace-Id", "personal").expect(200);
    expect(local.body).toMatchObject({ id: draft.id, sourceReleaseId: "release-a", pageId: "page-a" });
    expect(local.headers["cache-control"]).toBe("private, no-store");
    expect(local.headers.vary).toContain("X-Workspace-Id");
    expect(confirm).not.toHaveBeenCalled();

    await request(app).get("/api/v1/pages/page-a/draft?view=snapshot&releaseId=release-a&confirm=1")
      .set("X-Workspace-Id", "personal").expect(200);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith("page-a", "release-a");

    await request(app).get("/api/v1/pages/page-a/draft?view=snapshot&releaseId=release-a&confirm=1")
      .set("X-Workspace-Id", "other").expect(404);
    await request(app).get("/api/v1/pages/other-page/draft?view=snapshot&releaseId=release-a&confirm=1")
      .set("X-Workspace-Id", "personal").expect(404);
    expect(confirm).toHaveBeenCalledOnce();
    expect(getDraftByPage).not.toHaveBeenCalled();
  });

  it("uses local release/page snapshots for sessions, question selection, and answer validation while keeping writes authoritative", async () => {
    const { app, authority, dependencies, release } = await harness();
    const getRelease = vi.spyOn(authority, "getRelease").mockRejectedValue(new Error("FULL_RELEASE_READ_MUST_NOT_RUN"));
    const getDraftByPage = vi.spyOn(authority, "getDraftByPage").mockRejectedValue(new Error("DRAFT_READ_MUST_NOT_RUN"));
    const saveSelection = vi.spyOn(authority, "saveQuestionSelection").mockImplementation(async (selection) => selection);
    vi.spyOn(authority, "saveQuestion").mockImplementation(async (question) => question);
    vi.spyOn(authority, "saveQuestionAttemptTransaction").mockImplementation(async (attempt, assessmentAttempt, reduceMastery) => ({
      attempt, assessmentAttempt, mastery: reduceMastery(undefined)
    }));

    const index = await request(app).get("/api/v1/releases/release-a").set("X-Workspace-Id", "personal").expect(200);
    expect(index.body).toMatchObject({ id: release.id, pageIds: ["page-a"], pages: [{ id: "page-a", questionBank: [] }] });
    const sessionResponse = await request(app).post("/api/v1/sessions").set("X-Workspace-Id", "personal")
      .send({ courseReleaseId: release.id }).expect(201);
    expect(sessionResponse.body.courseReleaseId).toBe(release.id);

    const selected = await request(app).post(`/api/v1/pages/page-a/questions:select`).set("X-Workspace-Id", "personal")
      .set("Idempotency-Key", "selection-a").send({ sessionId: sessionResponse.body.id, seed: "seed-a" }).expect(201);
    expect(saveSelection).toHaveBeenCalledOnce();
    const selectedQuestion = selected.body.questions.find((question: { id: string }) => question.id === "question-a");
    expect(selectedQuestion).toMatchObject({ id: "question-a", version: 1 });
    expect(selected.body.selection.id).not.toBe("selection-a");

    await request(app).post("/api/v1/question-attempts").set("X-Workspace-Id", "personal")
      .set("Idempotency-Key", "attempt-a")
      .send({ courseReleaseId: release.id, pageId: "page-a", questionId: selectedQuestion.id, questionVersion: selectedQuestion.version,
        answer: "yes", sessionId: sessionResponse.body.id, selectionId: selected.body.selection.id })
      .expect(201);
    expect(getRelease).not.toHaveBeenCalled();
    expect(getDraftByPage).not.toHaveBeenCalled();
    expect(dependencies.reading?.status().ready).toBe(true);
  });

  it("validates self-retelling ownership locally before preserving the existing idempotent write", async () => {
    const { app, authority, dependencies } = await harness();
    const getRelease = vi.spyOn(authority, "getRelease").mockRejectedValue(new Error("FULL_RELEASE_READ_MUST_NOT_RUN"));
    const listCourses = vi.spyOn(authority, "listCourses").mockRejectedValue(new Error("COURSE_READ_MUST_NOT_RUN"));
    const mutate = vi.spyOn(dependencies.operations, "urgentMutate");
    const headers = {
      "X-Workspace-Id": "personal", "X-Actor": "test", "X-Request-Id": "retelling-request",
      "X-Schema-Version": "2.4.0", "Idempotency-Key": "retelling-a"
    };

    await request(app).put("/api/v1/self-retellings/release-a/page-a")
      .set({ ...headers, "X-Workspace-Id": "other" }).send({ answer: "My own explanation" }).expect(404);
    expect(mutate).not.toHaveBeenCalled();

    const saved = await request(app).put("/api/v1/self-retellings/release-a/page-a")
      .set(headers).send({ answer: "My own explanation" }).expect(200);
    expect(saved.body).toMatchObject({ workspaceId: "personal", releaseId: "release-a", pageId: "page-a", answer: "My own explanation" });
    expect(getRelease).not.toHaveBeenCalled();
    expect(listCourses).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledOnce();
  });
});
