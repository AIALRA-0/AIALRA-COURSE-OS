import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CourseProject, CourseRelease, CourseTreeNode, GenerationCostEntry, IdempotentWriteContext, LessonDraft, ReleaseManifest } from "@course-os/contracts";
import { EtapiReadWeaveCourseApi, FileReadWeaveCourseApi, HttpReadWeaveCourseApi, defaultModelProviders, defaultModelRoutePolicy } from "./index.js";
import { decodeReadWeaveStateContent, encodeReadWeaveStateContent } from "./etapi.js";

it("reads legacy state and round-trips a large compressed ReadWeave index", () => {
  const small = { releases: [{ id: "release-1" }] };
  expect(decodeReadWeaveStateContent(JSON.stringify(small))).toEqual(small);
  const large = { releases: [{ id: "release-1", content: "可核对的来源与讲解".repeat(160_000) }] };
  const encoded = encodeReadWeaveStateContent(large);
  expect(encoded.startsWith("COURSE_OS_BR_STATE_V1:")).toBe(true);
  expect(Buffer.byteLength(encoded)).toBeLessThan(Buffer.byteLength(JSON.stringify(large)) / 2);
  expect(decodeReadWeaveStateContent(encoded)).toEqual(large);
  const tampered = encoded.replace(/^(COURSE_OS_BR_STATE_V1:)([a-f0-9])/u, (_match, prefix: string, digit: string) => `${prefix}${digit === "0" ? "1" : "0"}`);
  expect(() => decodeReadWeaveStateContent(tampered)).toThrow("READWEAVE_STATE_CODEC_HASH_MISMATCH");
});

it("reopens a large published release through the compressed ETAPI index", async () => {
  const remote = new FakeEtapi();
  const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
  const largeRelease = releaseWithPage();
  largeRelease.pages[0]!.blocks[0]!.markdown = "逐步核对输入和输出".repeat(160_000);
  await api.publishRelease(largeRelease, { ...manifest, courseReleaseId: largeRelease.id }, { ...context, idempotencyKey: "large-release-publish" });
  const reopened = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
  expect((await reopened.getRelease(largeRelease.id))?.pages[0]?.blocks[0]?.markdown).toBe(largeRelease.pages[0]!.blocks[0]!.markdown);
});

it("uses the bootstrap index download for the first cold state read", async () => {
  const remote = new FakeEtapi();
  const original = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
  await original.listCourses();
  const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
  const before = remote.requests.length;
  const reopened = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
  await reopened.listCourses();
  expect(remote.requests.slice(before).filter((item) => item.method === "GET" && item.path.endsWith(`/notes/${stateNoteId}/content`))).toHaveLength(1);
});

it("defaults to the current DeepSeek visual route without hidden fallbacks", () => {
  const openCode = defaultModelProviders().find((item) => item.id === "opencode-go");
  expect(openCode?.models.find((model) => model.id === "gpt-5.6-luna")).toMatchObject({ protocol: "responses", supportsVision: true, supportsJsonSchema: true, billingMode: "subscription_quota" });
  const provider = defaultModelProviders().find((item) => item.id === "deepseek");
  expect(provider?.models.find((model) => model.id === "deepseek-flash")).toMatchObject({ protocol: "responses", supportsVision: true, supportsJsonSchema: true });
  const policy = defaultModelRoutePolicy("personal");
  expect(policy.allowProviderFallback).toBe(false);
  expect(policy.rules.every((rule) => rule.providerId === "deepseek" && rule.modelId === "deepseek-flash" && !rule.fallbackProviderId)).toBe(true);
});

it("shares a brief ReadWeave read snapshot and invalidates it before a write", async () => {
  const remote = new FakeEtapi();
  const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
  const clock = vi.spyOn(Date, "now");
  const base = Date.now();
  clock.mockReturnValue(base);
  try {
    await api.listCourses();
    const contentReads = () => remote.requests.filter((item) => item.method === "GET" && item.path.endsWith("/content")).length;
    const firstReads = contentReads();
    clock.mockReturnValue(base + 1_000);
    await api.getRelease("missing-release");
    expect(contentReads()).toBe(firstReads);
    const course = { id: "snapshot-course", workspaceId: "personal", title: "快照课程", status: "active" as const,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await api.createCourse(course, { ...context, idempotencyKey: "snapshot-course-create" });
    expect((await api.listCourses()).some((item) => item.id === course.id)).toBe(true);
  } finally {
    clock.mockRestore();
  }
});

it("serves a recent snapshot while a slow ReadWeave refresh is in flight", async () => {
  const remote = new FakeEtapi();
  let delayContent = false;
  let releaseRefresh: (() => void) | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (delayContent && (init?.method ?? "GET") === "GET" && new URL(String(input)).pathname.endsWith("/content")) {
      delayContent = false;
      await new Promise<void>((resolve) => { releaseRefresh = resolve; });
    }
    return remote.fetch(input, init);
  };
  const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
  const clock = vi.spyOn(Date, "now");
  const base = Date.now();
  clock.mockReturnValue(base);
  try {
    await api.listCourses();
    delayContent = true;
    clock.mockReturnValue(base + 61_000);
    const result = await Promise.race([api.listCourses().then(() => "cached"), new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100))]);
    expect(result).toBe("cached");
    expect(releaseRefresh).toBeTypeOf("function");
    releaseRefresh?.();
    expect((await api.getSyncStatus()).state).toBe("connected");
  } finally {
    releaseRefresh?.();
    clock.mockRestore();
  }
});

const context: IdempotentWriteContext = {
  idempotencyKey: "publish-1",
  actor: "test",
  workspaceId: "personal",
  schemaVersion: "2.1.0",
  requestId: "request-1"
};

const release: CourseRelease = {
  id: "release-1",
  courseId: "course-1",
  courseTitle: "Course",
  moduleId: "module-1",
  moduleTitle: "Module",
  version: 1,
  publishedAt: "2026-08-28T00:00:00.000Z",
  pageIds: [],
  pages: [],
  assessments: [],
  manifestHash: "hash",
  writingPolicySnapshotId: "policy-1",
  modelRoute: "deterministic-seed",
  qualityHarnessVersion: "quality-v1",
  costUsd: 0
};

const manifest: ReleaseManifest = {
  id: "manifest-1",
  schemaVersion: "2.1.0",
  courseReleaseId: "release-1",
  sourceHashes: [],
  pageHashes: [],
  explanationHashes: [],
  assessmentHashes: [],
  writingPolicySnapshotId: "policy-1",
  modelRoutes: ["deterministic-seed"],
  qualityHarnessVersion: "quality-v1",
  costInputs: [],
  createdAt: "2026-08-28T00:00:00.000Z"
};

describe("file ReadWeave adapter", () => {
  it("round-trips the optional generation job owner for recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-readweave-generation-owner-"));
    const path = join(root, "state.json");
    const api = new FileReadWeaveCourseApi(path);
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const draft = { ...draftFor(pageRelease), generationJobId: "job-file-owner" };

    const saved = await api.saveDraft(draft, 0, { ...context, idempotencyKey: "draft-generation-owner" });
    const reopened = new FileReadWeaveCourseApi(path);

    expect(saved.generationJobId).toBe("job-file-owner");
    await expect(reopened.getDraftByPage("page-1")).resolves.toMatchObject({ generationJobId: "job-file-owner" });
  });

  it("replays the same idempotency key and rejects an in-place release replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-readweave-"));
    const api = new FileReadWeaveCourseApi(join(root, "state.json"));
    expect((await api.publishRelease(release, manifest, context)).id).toBe("release-1");
    expect((await api.publishRelease(release, manifest, context)).id).toBe("release-1");
    await expect(api.publishRelease({ ...release, courseTitle: "Changed" }, manifest, { ...context, idempotencyKey: "publish-2" })).rejects.toThrow("READWEAVE_RELEASE_IMMUTABLE");
  });

  it("persists a revision conflict without poisoning later writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-readweave-"));
    const api = new FileReadWeaveCourseApi(join(root, "state.json"));
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const first = await api.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "draft-1" });
    await expect(api.saveDraft({ ...first, revision: 2 }, 0, { ...context, idempotencyKey: "draft-stale" })).rejects.toThrow("READWEAVE_REVISION_CONFLICT");
    expect((await api.listConflicts()).filter((item) => item.status === "open")).toHaveLength(1);
    await expect(api.saveQuestion({
      id: "question-after-conflict",
      sessionId: "session-1",
      courseReleaseId: pageRelease.id,
      pageId: "page-1",
      anchorIds: [],
      question: "为什么",
      learnerAttempt: "我的尝试",
      hintLevel: 1,
      response: "提示",
      reviewPolicy: "include",
      status: "active",
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, { ...context, idempotencyKey: "question-after-conflict" })).resolves.toMatchObject({ id: "question-after-conflict" });
  });

  it("removes only the selected draft source and its page drafts", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-readweave-"));
    const api = new FileReadWeaveCourseApi(join(root, "state.json"));
    const source = { ...releaseWithPage(), id: "draft-source-1", lifecycle: "draft_source" as const };
    await api.registerDraftSource(source, { ...context, idempotencyKey: "source-1" });
    await api.saveDraft(draftFor(source), 0, { ...context, idempotencyKey: "source-draft-1" });
    await api.removeDraftSource(source.id, { ...context, idempotencyKey: "remove-source-1" });
    expect(await api.getRelease(source.id)).toBeUndefined();
    expect(await api.getDraftByPage("page-1")).toBeUndefined();
  });
});

describe("ReadWeave ETAPI adapter", () => {
  it("round-trips the optional generation job owner in its draft record", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);

    const saved = await api.saveDraft({ ...draftFor(pageRelease), generationJobId: "job-etapi-owner" }, 0,
      { ...context, idempotencyKey: "etapi-draft-generation-owner" });
    const reopened = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });

    expect(saved.generationJobId).toBe("job-etapi-owner");
    await expect(reopened.getDraftByPage("page-1")).resolves.toMatchObject({ generationJobId: "job-etapi-owner" });
  });

  it("keeps a committed candidate when an older state read finishes after its write", async () => {
    const remote = new FakeEtapi();
    let stateNoteId = "";
    let oldContent = "";
    let holdStatePut = false;
    let holdStaleGet = false;
    let releasePut!: () => void;
    let releaseGet!: () => void;
    let putStarted!: () => void;
    let getStarted!: () => void;
    const putGate = new Promise<void>(resolve => { releasePut = resolve; });
    const getGate = new Promise<void>(resolve => { releaseGet = resolve; });
    const putStartedPromise = new Promise<void>(resolve => { putStarted = resolve; });
    const getStartedPromise = new Promise<void>(resolve => { getStarted = resolve; });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const stateContent = stateNoteId && url.pathname.endsWith(`/notes/${stateNoteId}/content`);
      if (stateContent && holdStatePut && init?.method === "PUT") {
        holdStatePut = false;
        const response = await remote.fetch(input, init);
        putStarted();
        await putGate;
        return response;
      }
      if (stateContent && holdStaleGet && (init?.method ?? "GET") === "GET") {
        holdStaleGet = false;
        getStarted();
        await getGate;
        return new Response(oldContent, { status: 200 });
      }
      return remote.fetch(input, init);
    };
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    const base = releaseWithPage();
    await api.publishRelease(base, { ...manifest, courseReleaseId: base.id }, context);
    stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
    oldContent = remote.contentByTitle("00 Course OS 结构化索引");
    await api.getRelease(base.id);
    const first = { ...base, id: "candidate-race-first", lifecycle: "draft_source" as const };
    const second = { ...base, id: "candidate-race-second", lifecycle: "draft_source" as const };
    holdStatePut = true;
    const firstWrite = api.registerDraftSource(first, { ...context, idempotencyKey: "candidate-race-first" });
    await putStartedPromise;
    Reflect.set(api, "stateCache", undefined);
    holdStaleGet = true;
    const staleRead = api.getRelease(first.id);
    await getStartedPromise;
    releasePut();
    await firstWrite;
    releaseGet();
    await expect(staleRead).resolves.toMatchObject({ id: first.id });
    await api.registerDraftSource(second, { ...context, idempotencyKey: "candidate-race-second" });
    await expect(api.getRelease(first.id)).resolves.toMatchObject({ id: first.id });
    await expect(api.getRelease(second.id)).resolves.toMatchObject({ id: second.id });
  });

  it("returns an unrecorded page miss without cloning the global state", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);

    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      await expect(api.getDraftByPage("missing-page")).resolves.toBeUndefined();
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
  });

  it("still reconciles a stored page draft when opening it through a fresh adapter", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    await api.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "fast-miss-existing-draft" });
    remote.editByTitle("核心解释", "从权威页面记录重建并协调后的内容");

    const reopenedApi = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    await expect(reopenedApi.getDraftByPage("page-1")).resolves.toMatchObject({
      revision: 2,
      page: { blocks: [expect.objectContaining({ id: "block-1", markdown: "从权威页面记录重建并协调后的内容" })] }
    });
  });

  it("retries workspace bootstrap after a transient ETAPI failure", async () => {
    const remote = new FakeEtapi();
    let failuresRemaining = 3;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (failuresRemaining > 0 && (init?.method ?? "GET") === "GET" && url.pathname.endsWith("/notes")
        && url.searchParams.get("search") === "#courseOsIndex=personal") {
        failuresRemaining -= 1;
        return new Response("temporary ETAPI failure", { status: 503 });
      }
      return remote.fetch(input, init);
    };
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });

    await expect(api.getSyncStatus()).resolves.toMatchObject({ state: "offline" });
    await expect(api.getSyncStatus()).resolves.toMatchObject({ state: "connected" });
  });

  it("stores page costs in the durable page record and replays without an index write", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const indexWritesBeforeAppend = remote.contentWriteCount(stateNoteId);
    const first = costEntryFor(pageRelease, "cost-standalone-1");
    const writeContext = { ...context, idempotencyKey: "append-cost-standalone-1" };
    await api.appendCostEntry(first, writeContext);

    const firstWriteCount = remote.contentWriteCount(stateNoteId);
    const firstRecord = decodeReadWeaveStateContent(remote.contentByTitle("Course OS draft record · page-1")) as { costEntries: GenerationCostEntry[]; idempotency: Record<string, { objectId: string }> };
    expect(firstRecord.costEntries).toEqual([first]);
    expect(firstRecord.idempotency[writeContext.idempotencyKey]?.objectId).toBe(first.id);
    expect(remote.contentWriteCount(stateNoteId)).toBe(indexWritesBeforeAppend);
    expect((decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as { costEntries: GenerationCostEntry[] }).costEntries).toEqual([]);
    expect(remote.countNotesByLabel("courseOsCostIndex", "personal")).toBe(0);

    const recordWritesAfterFirstAppend = remote.contentWriteCount(remote.noteIdByTitle("Course OS draft record · page-1"));
    await expect(api.appendCostEntry(first, writeContext)).resolves.toEqual(first);
    expect(remote.contentWriteCount(stateNoteId)).toBe(firstWriteCount);
    expect(remote.contentWriteCount(remote.noteIdByTitle("Course OS draft record · page-1"))).toBe(recordWritesAfterFirstAppend);

    const second = costEntryFor(pageRelease, "cost-standalone-2");
    await api.appendCostEntry(second, { ...context, idempotencyKey: "append-cost-standalone-2" });
    expect(await api.listCostEntries({ pageId: "page-1" })).toHaveLength(2);
    expect((decodeReadWeaveStateContent(remote.contentByTitle("Course OS draft record · page-1")) as { costEntries: GenerationCostEntry[] }).costEntries).toHaveLength(2);
  });

  it("attributes an early page cost to its material version when older releases share the course", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const formal = releaseWithPage();
    await api.publishRelease(formal, { ...manifest, courseReleaseId: formal.id }, context);
    const candidate = structuredClone(formal);
    candidate.id = "candidate-release";
    candidate.lifecycle = "draft_source";
    candidate.pages[0]!.id = "candidate-page";
    candidate.pageIds = ["candidate-page"];
    await api.registerDraftSource(candidate, { ...context, idempotencyKey: "candidate-source" });
    const cost = { ...costEntryFor(candidate, "early-cost"), pageId: "candidate-page" };
    const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const indexWritesBeforeCost = remote.contentWriteCount(stateNoteId);

    await expect(api.appendCostEntry(cost, { ...context, idempotencyKey: "early-cost" })).resolves.toEqual(cost);

    const record = decodeReadWeaveStateContent(remote.contentByTitle("Course OS draft record · candidate-page")) as {
      draft: LessonDraft;
      costEntries: GenerationCostEntry[];
    };
    expect(record.draft.sourceReleaseId).toBe(candidate.id);
    expect(record.costEntries).toEqual([cost]);
    expect(remote.contentWriteCount(stateNoteId)).toBe(indexWritesBeforeCost);

    const generated = draftFor(candidate);
    generated.page.blocks[0]!.markdown = "生成后的完整讲解";
    generated.page.lessonSections = [{ id: "generated-main", kind: "main_content", title: "主要内容", markdown: "先解释概念，再解释例子。", sourceAnchorIds: [], atomIds: [] }];
    const saved = await api.saveDraftWithCost(generated, 0, { ...context, idempotencyKey: "candidate-generated-draft" }, { ...cost, id: "generated-cost" });
    expect(saved.revision).toBe(1);
    expect((await api.getDraftByPage("candidate-page"))?.page.lessonSections?.[0]?.markdown).toBe("先解释概念，再解释例子。");
  });

  it("reads historical compact costs after restart and appends new costs to the page record", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const historical = costEntryFor(pageRelease, "cost-historical-compact");
    const costIndexId = remote.seedCostIndex([historical]);
    const mainIndex = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as { projections: { costIndexNoteId?: string } };
    mainIndex.projections.costIndexNoteId = costIndexId;
    remote.editByTitle("00 Course OS 结构化索引", encodeReadWeaveStateContent(mainIndex));

    const reopened = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    await expect(reopened.listCostEntries({ pageId: "page-1" })).resolves.toEqual([historical]);
    const appended = costEntryFor(pageRelease, "cost-after-rollback");
    const writeContext = { ...context, idempotencyKey: "append-cost-after-rollback" };
    await expect(reopened.appendCostEntry(appended, writeContext)).resolves.toEqual(appended);
    await expect(reopened.appendCostEntry(appended, writeContext)).resolves.toEqual(appended);
    const savedMainIndex = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as { costEntries: GenerationCostEntry[]; projections: { costIndexNoteId?: string } };
    expect(savedMainIndex.costEntries).toEqual([]);
    expect(savedMainIndex.projections.costIndexNoteId).toBe(costIndexId);
    expect((decodeReadWeaveStateContent(remote.contentByTitle("Course OS draft record · page-1")) as { costEntries: GenerationCostEntry[] }).costEntries).toEqual([appended]);
    expect(decodeReadWeaveStateContent(remote.contentByTitle("02 Course OS 成本索引"))).toMatchObject({ costEntries: [historical] });
    await expect(reopened.listCostEntries({ pageId: "page-1" }).then((entries) => entries.map((item) => item.id).sort()))
      .resolves.toEqual([historical.id, appended.id].sort());
    expect(remote.countNotesByLabel("courseOsCostIndex", "personal")).toBe(1);
  });

  it("repairs a failed quality projection on replay without duplicating the cost", async () => {
    const remote = new FakeEtapi();
    let failProjectionLookup = true;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (failProjectionLookup && (init?.method ?? "GET") === "GET" && url.pathname.endsWith("/notes")
        && url.searchParams.get("search") === '#courseOsObjectId="cost-projection-retry"') {
        failProjectionLookup = false;
        return new Response("injected quality projection failure", { status: 400 });
      }
      return remote.fetch(input, init);
    };
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const cost = costEntryFor(pageRelease, "cost-projection-retry");
    const writeContext = { ...context, idempotencyKey: "append-cost-projection-retry" };

    await expect(api.appendCostEntry(cost, writeContext)).rejects.toThrow("READWEAVE_ETAPI_400");
    await expect(api.listCostEntries({ pageId: "page-1" })).resolves.toEqual([cost]);
    await expect(api.appendCostEntry(cost, writeContext)).resolves.toEqual(cost);
    await expect(api.listCostEntries({ pageId: "page-1" })).resolves.toEqual([cost]);
    expect(remote.countNotesByLabel("courseOsObjectId", cost.id)).toBe(1);
  });

  it("returns a minimal release index without cloning away the full release path", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const fullRelease = releaseWithPage();
    const fullPage = fullRelease.pages[0]!;
    fullRelease.assessments = [{ id: "assessment-index", objectiveId: "objective-1", pageId: "page-1", prompt: "assessment body", expectedAnswer: "answer body", transfer: false }];
    fullPage.atoms = [{ kind: "text_region", id: "atom-index", label: "index atom", observation: "atom body" }];
    fullPage.blocks[0]!.markdown = "large teaching body ".repeat(20_000);
    fullPage.lessonSections = [{ id: "section-index", kind: "main_content", title: "section body", markdown: "section body", sourceAnchorIds: [], atomIds: [] }];
    fullPage.questionBank = [{ id: "question-index", pageId: "page-1", objectiveId: "objective-1", kind: "comprehension", prompt: "question body", expectedAnswer: "answer body", explanation: "explanation body", sourceAnchorIds: [], status: "approved", version: 1, generatedBy: "test" }];
    await api.publishRelease(fullRelease, { ...manifest, courseReleaseId: fullRelease.id }, { ...context, idempotencyKey: "release-index-publish" });

    const clone = vi.spyOn(globalThis, "structuredClone");
    let index;
    try {
      index = await api.listReleaseIndexes();
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }

    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({
      id: fullRelease.id,
      pageIds: fullRelease.pageIds,
      assessments: [],
      pages: [{
        id: "page-1",
        pageNumber: 1,
        title: "测试页面",
        imageUrl: "/page.png",
        anchors: [],
        atoms: [],
        blocks: [],
        lessonSections: [],
        questionBank: [],
        coverageRequirements: [],
        coverageClaims: [],
        quality: fullPage.quality
      }]
    });
    expect(JSON.stringify(index)).not.toContain("large teaching body");
    expect(JSON.stringify(index)).not.toContain("question body");

    const full = await api.listReleases();
    expect(full).toHaveLength(1);
    expect(full[0]!.assessments).toEqual(fullRelease.assessments);
    expect(full[0]!.pages[0]!.atoms).toEqual(fullPage.atoms);
    expect(full[0]!.pages[0]!.blocks[0]!.markdown).toBe(fullPage.blocks[0]!.markdown);
    expect(full[0]!.pages[0]!.lessonSections).toEqual(fullPage.lessonSections);
    expect(full[0]!.pages[0]!.questionBank).toEqual(fullPage.questionBank);
  });

  it("partitions high-frequency learning activity and preserves it across restart", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, { ...context, idempotencyKey: "activity-release" });

    const firstSelection = {
      id: "selection-1", sessionId: "session-1", courseReleaseId: pageRelease.id, pageId: "page-1",
      seed: "seed-1", questionIds: ["question-1"], createdAt: "2026-09-15T00:00:00.000Z"
    };
    await api.saveQuestionSelection(firstSelection, { ...context, idempotencyKey: "activity-selection-1" });
    const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const activityNoteId = remote.noteIdByTitle("01 Course OS 学习活动索引");
    const stateWritesAfterInitialization = remote.contentWriteCount(stateNoteId);
    const activityWritesAfterInitialization = remote.contentWriteCount(activityNoteId);

    await api.saveQuestionSelection({ ...firstSelection, id: "selection-2", seed: "seed-2" }, { ...context, idempotencyKey: "activity-selection-2" });
    expect(remote.contentWriteCount(stateNoteId)).toBe(stateWritesAfterInitialization);
    expect(remote.contentWriteCount(activityNoteId)).toBe(activityWritesAfterInitialization + 1);

    const questionAttempt = {
      id: "question-attempt-1", selectionId: firstSelection.id, sessionId: firstSelection.sessionId,
      courseReleaseId: pageRelease.id, pageId: "page-1", questionId: "question-1", objectiveId: "objective-1",
      answer: "正确答案", correct: true, usedHintLevel: 0, attemptedAt: "2026-09-15T00:01:00.000Z"
    };
    const assessmentAttempt = {
      id: questionAttempt.id, itemId: questionAttempt.questionId, objectiveId: questionAttempt.objectiveId,
      answer: questionAttempt.answer, correct: true, usedHintLevel: 0, attemptedAt: questionAttempt.attemptedAt
    };
    const mastery = {
      objectiveId: questionAttempt.objectiveId, state: "practicing" as const, unaidedCorrect: true,
      delayedOrTransferCorrect: false, intervalStep: 1, algorithmVersion: "review-ladder-v1" as const,
      updatedAt: questionAttempt.attemptedAt
    };
    const attemptContext = { ...context, idempotencyKey: "activity-attempt-1" };
    await api.saveQuestionAttemptTransaction(questionAttempt, assessmentAttempt, () => mastery, attemptContext);
    expect(remote.contentWriteCount(stateNoteId)).toBe(stateWritesAfterInitialization);

    const reopened = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    expect(await reopened.listQuestionAttempts("page-1")).toEqual([questionAttempt]);
    expect(await reopened.listAssessmentAttempts("objective-1")).toEqual([assessmentAttempt]);
    expect(await reopened.listMastery()).toEqual([mastery]);
    const writesBeforeReplay = remote.requests.filter((item) => item.method !== "GET").length;
    const replay = await reopened.saveQuestionAttemptTransaction({ ...questionAttempt, answer: "不应覆盖" }, assessmentAttempt, () => mastery, attemptContext);
    expect(replay.attempt).toEqual(questionAttempt);
    expect(remote.requests.filter((item) => item.method !== "GET")).toHaveLength(writesBeforeReplay);
  });

  it("returns an idempotent replay without creating another remote revision or state write", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const course = { id: "replay-course", workspaceId: "personal", title: "原始标题", status: "active" as const,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await api.createCourse(course, { ...context, idempotencyKey: "replay-course-create" });
    const listTreeNodes = vi.spyOn(api, "listTreeNodes").mockRejectedValue(new Error("full tree projection must not run during write readback"));
    const first = await api.updateTreeNode(course.id, { title: "新标题" }, 0, { ...context, idempotencyKey: "replay-tree-update" });
    const requestsBeforeReplay = remote.requests.length;

    const replay = await api.updateTreeNode(course.id, { title: "不应生效" }, 0, { ...context, idempotencyKey: "replay-tree-update" });

    expect(replay).toMatchObject({ title: "新标题", revision: first.revision });
    const replayRequests = remote.requests.slice(requestsBeforeReplay);
    expect(replayRequests).toHaveLength(1);
    expect(replayRequests.every((item) => item.method === "GET" && !item.path.endsWith("/content"))).toBe(true);
    expect(listTreeNodes).not.toHaveBeenCalled();
  });

  it("reads native page questions without writing or importing another page's links", async () => {
    const remote = new FakeEtapi();
    let pageNoteId = "";
    const nativeRequests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname.replace(/^\/etapi/, "");
      if (path.startsWith("/notes/_readweaveLinks") || path.startsWith("/notes/link-") || path.startsWith("/notes/object-")) {
        nativeRequests.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/notes/_readweaveLinks") return Response.json({ noteId: "_readweaveLinks", childNoteIds: ["link-1", "link-duplicate", "link-other"] });
        if (path === "/notes/link-1/content" || path === "/notes/link-duplicate/content") return Response.json({ linkId: path.includes("duplicate") ? "link-duplicate" : "link-1", articleId: pageNoteId, objectId: "object-1", contentType: "problem" });
        if (path === "/notes/link-other/content") return Response.json({ linkId: "link-other", articleId: "another-page", objectId: "object-other", contentType: "problem" });
        if (path === "/notes/object-1/content") return Response.json({ objectId: "object-1", kind: "question", contentType: "problem", title: "为什么要保留状态？", body: "<p>因为下一步需要它</p>" });
        return new Response("not found", { status: 404 });
      }
      return remote.fetch(input, init);
    };
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", publicUrl: "https://readweave.example.com", fetchImpl });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    pageNoteId = (await api.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "native-qa-draft" })).readweaveNoteId!;
    const writesBefore = remote.requests.filter((item) => item.method !== "GET").length;
    const requestsBefore = remote.requests.length;
    const result = await api.listNativePageQuestions("page-1");
    expect(result.questions).toEqual([{ objectId: "object-1", title: "为什么要保留状态？", excerpt: "因为下一步需要它", updatedAt: undefined }]);
    expect(result.noteUrl).toContain(pageNoteId);
    expect(await api.listNativePageQuestions("page-1", "another-workspace")).toEqual({ pageId: "page-1", questions: [] });
    expect(remote.requests.filter((item) => item.method !== "GET")).toHaveLength(writesBefore);
    const readRequests = remote.requests.slice(requestsBefore);
    expect(readRequests.filter((item) => item.path === "/notes")).toHaveLength(2);
    expect(readRequests.some((item) => item.path.startsWith("/notes/") && item.path.endsWith("/content") && !item.path.includes("link-") && !item.path.includes("object-"))).toBe(false);
    expect(nativeRequests.every((item) => item.startsWith("GET "))).toBe(true);
  });
  it("creates the course tree and imports direct block edits as a new revision", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({
      baseUrl: "http://readweave",
      token: "secret",
      parentNoteId: "root",
      publicUrl: "https://readweave.example.com",
      fetchImpl: remote.fetch
    });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const saved = await api.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "etapi-draft-1" });
    expect(saved.readweaveNoteId).toBeTruthy();
    expect(remote.titles()).toEqual(expect.arrayContaining(["Course OS", "02 课程材料", "03 完整讲解", "核心解释"]));
    remote.editByTitle("核心解释", "ReadWeave 中直接完成的逐块修改");
    const requestsBeforeSnapshot = remote.requests.length;
    const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const stateWritesBeforeRead = remote.contentWriteCount(stateNoteId);
    const snapshot = await api.getDraftSnapshotByPage("page-1");
    expect(snapshot?.revision).toBe(1);
    expect(remote.requests).toHaveLength(requestsBeforeSnapshot);
    const writesBeforeRead = remote.requests.filter((item) => item.method !== "GET").length;
    const reconciled = await api.getDraftByPage("page-1");
    expect(reconciled?.revision).toBe(2);
    expect(reconciled?.page.blocks[0]?.markdown).toBe("ReadWeave 中直接完成的逐块修改");
    expect(remote.contentWriteCount(stateNoteId)).toBe(stateWritesBeforeRead);
    expect(remote.requests.filter((item) => item.method !== "GET").length - writesBeforeRead).toBeLessThanOrEqual(2);
    const readsAfterFirstOpen = remote.requests.length;
    expect((await api.getDraftByPage("page-1"))?.revision).toBe(2);
    expect(remote.requests).toHaveLength(readsAfterFirstOpen);
    expect((await api.getSyncStatus()).mode).toBe("etapi");
  });

  it("starts the draft record lookup while the state snapshot is loading", async () => {
    const remote = new FakeEtapi();
    const setup = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const release = releaseWithPage();
    await setup.publishRelease(release, { ...manifest, courseReleaseId: release.id }, context);
    await setup.saveDraft(draftFor(release), 0, { ...context, idempotencyKey: "snapshot-overlap" });

    let startRecordLookup!: () => void;
    let startStateRead!: () => void;
    let releaseStateRead!: () => void;
    const recordLookupStarted = new Promise<void>((resolve) => { startRecordLookup = resolve; });
    const stateReadStarted = new Promise<void>((resolve) => { startStateRead = resolve; });
    const stateReadGate = new Promise<void>((resolve) => { releaseStateRead = resolve; });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const path = url.pathname.replace(/^\/etapi/, "");
      if ((init?.method ?? "GET") === "GET" && path === "/notes"
        && url.searchParams.get("search") === '#courseOsDraftRecordPageId="page-1"') {
        startRecordLookup();
      }
      if ((init?.method ?? "GET") === "GET" && /\/notes\/[^/]+\/content$/.test(path)) {
        startStateRead();
        await stateReadGate;
      }
      return remote.fetch(input, init);
    };
    const reopened = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    const snapshotPromise = reopened.getDraftSnapshotByPage("page-1");
    try {
      await stateReadStarted;
      const overlapped = await Promise.race([
        recordLookupStarted.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))
      ]);
      expect(overlapped).toBe(true);
    } finally {
      releaseStateRead();
    }
    await expect(snapshotPromise).resolves.toMatchObject({ pageId: "page-1", revision: 1 });
  });

  it("stores a generated draft and its cost in one idempotent ReadWeave mutation", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const release = releaseWithPage();
    await api.publishRelease(release, { ...manifest, courseReleaseId: release.id }, context);
    const cost: GenerationCostEntry = {
      id: "cost-page-1", workspaceId: "personal", courseId: release.courseId,
      materialVersionId: release.id, pageId: "page-1", jobId: "job-1", stage: "teach",
      provider: "test", model: "test-model", inputTokens: 10, outputTokens: 20,
      cachedInputTokens: 0, unitPriceSnapshot: {
        id: "price-1", provider: "test", model: "test-model", currency: "USD",
        capturedAt: new Date().toISOString(), source: "test",
        inputMicrousdPerMillion: 1, outputMicrousdPerMillion: 1,
        cachedInputMicrousdPerMillion: 0
      }, estimatedMicrousd: 1, actualMicrousd: 1, durationMs: 25,
      retries: 0, status: "succeeded", qualityPassed: true, createdAt: new Date().toISOString()
    };
    const writeContext = { ...context, idempotencyKey: "draft-with-cost-1" };
    await api.saveQuestionSelection({
      id: "selection-before-draft", sessionId: "session-before-draft", courseReleaseId: release.id,
      pageId: "page-1", seed: "seed-before-draft", questionIds: ["question-1"],
      createdAt: "2026-09-15T00:00:00.000Z"
    }, { ...context, idempotencyKey: "selection-before-draft" });
    const standaloneCost = costEntryFor(release, "cost-standalone-before-draft");
    await api.appendCostEntry(standaloneCost, { ...context, idempotencyKey: "append-standalone-before-draft" });
    const activityNoteId = remote.noteIdByTitle("01 Course OS 学习活动索引");
    const activityWritesBeforeDraft = remote.contentWriteCount(activityNoteId);
    const sourceImage = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const sourceAsset = { sha256: "generated-page-image-hash", fileName: "page-001.png", mediaType: "image/png" as const, bytes: sourceImage };
    const first = await api.saveDraftWithCost(draftFor(release), 0, writeContext, cost, sourceAsset);
    expect(remote.contentWriteCount(activityNoteId)).toBe(activityWritesBeforeDraft);
    const writesBeforeReplay = remote.requests.filter((item) => item.method !== "GET").length;
    const replay = await api.saveDraftWithCost(draftFor(release), 0, writeContext, cost, sourceAsset);
    expect(replay.revision).toBe(first.revision);
    expect(remote.requests.filter((item) => item.method !== "GET")).toHaveLength(writesBeforeReplay);
    expect((await api.listCostEntries({ pageId: "page-1" })).map((item) => item.id).sort()).toEqual([standaloneCost.id, cost.id].sort());
    const mainIndex = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as { costEntries: GenerationCostEntry[] };
    expect(mainIndex.costEntries).toEqual([]);
    expect((decodeReadWeaveStateContent(remote.contentByTitle("Course OS draft record · page-1")) as { costEntries: GenerationCostEntry[] }).costEntries).toEqual([standaloneCost, cost]);
    expect(remote.titles()).not.toContain("02 Course OS 成本索引");
    expect(remote.titles()).toEqual(expect.arrayContaining(["成本 · teach · test-model"]));
    expect(remote.titles().filter((title) => title === sourceAsset.fileName)).toHaveLength(1);
    expect(remote.contentByTitle("第 001 页 · 测试页面")).toContain("<img src=\"api/images/");
    expect(await api.getDraftByPage("page-1")).toEqual(first);
  });

  it("shows the original image and teaching on the ReadWeave page while preserving remote overview edits", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const draft = draftFor(pageRelease);
    draft.page.lessonFlowVersion = 2;
    draft.page.lessonSections = [{ id: "lesson-full", kind: "full_explanation", title: "完整讲解", markdown: "## 为什么需要它\n先看原图，再理解输入和输出", sourceAnchorIds: [], atomIds: [] }];
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const saved = await api.saveDraft(draft, 0, { ...context, idempotencyKey: "native-image-draft" }, { sha256: "image-hash", fileName: "page-001.png", mediaType: "image/png", bytes: image });
    const title = "第 001 页 · 测试页面";
    expect(remote.contentByTitle(title)).toContain("<img src=\"api/images/");
    expect(remote.contentByTitle(title)).toContain("<h3>完整讲解</h3>");
    expect(remote.contentByTitle(title)).not.toContain("<pre>");
    remote.editByTitle(title, "<p>ReadWeave 中直接修改的页面</p>");
    const projectionWritesBeforeConflict = remote.requests.filter((item) => item.method !== "GET").length;
    await expect(api.saveDraft({ ...saved, revision: 1 }, 1, { ...context, idempotencyKey: "native-image-conflict" })).rejects.toThrow("READWEAVE_PAGE_OVERVIEW_CONFLICT");
    expect(remote.contentByTitle(title)).toBe("<p>ReadWeave 中直接修改的页面</p>");
    expect(remote.requests.filter((item) => item.method !== "GET")).toHaveLength(projectionWritesBeforeConflict);
  });

  it("resumes a draft after its overview write committed but the state transaction did not", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const saved = await api.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "overview-before-failure" });
    const next = structuredClone(saved);
    next.page.lessonFlowVersion = 2;
    next.page.lessonSections = [{ id: "lesson-full", kind: "full_explanation", title: "完整讲解", markdown: "恢复后的新讲解", sourceAnchorIds: [], atomIds: [] }];
    const renderOverview = (api as unknown as { renderPageOverview(draft: typeof next): string }).renderPageOverview.bind(api);
    const overview = renderOverview(next);
    remote.editByTitle("第 001 页 · 测试页面", overview);
    const recovered = await api.saveDraft(next, 1, { ...context, idempotencyKey: "overview-after-failure" });
    expect(recovered.revision).toBe(2);
    expect(remote.contentByTitle("第 001 页 · 测试页面")).toBe(overview);
  });

  it("reconciles an interrupted generated overview from matching section notes, but rejects an edited section", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const saved = await api.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "section-interruption-base" });
    const kinds = [
      ["chapter_bridge", "承上启下"], ["prior_knowledge", "先验知识"], ["learning_objectives", "学习目标"],
      ["full_explanation", "完整讲解"], ["main_content", "主要内容"], ["misconceptions", "易错点"]
    ] as const;
    const interrupted = structuredClone(saved);
    interrupted.page.lessonFlowVersion = 2;
    interrupted.page.lessonSections = kinds.map(([kind, title], index) => ({
      id: `section-${index}`, kind, title, markdown: `系统上次写入的${title}`, sourceAnchorIds: [], atomIds: []
    }));
    const render = api as unknown as {
      renderPageOverview(draft: typeof interrupted): string;
      renderSectionOverview(draft: typeof interrupted, key: "prerequisites" | "objectives" | "explanation" | "main" | "misconceptions"): string;
    };
    const overview = render.renderPageOverview(interrupted);
    remote.editByTitle("第 001 页 · 测试页面", overview);
    const sections = [
      ["01 先验知识", "prerequisites"], ["02 学习目标", "objectives"], ["03 完整讲解", "explanation"],
      ["04 主要内容", "main"], ["05 易错点", "misconceptions"]
    ] as const;
    for (const [title, key] of sections) remote.editByTitle(title, render.renderSectionOverview(interrupted, key));
    const retry = structuredClone(interrupted);
    retry.page.lessonSections = retry.page.lessonSections!.map((section) => ({ ...section, markdown: `本次重新生成的${section.title}` }));
    remote.editByTitle("03 完整讲解", "<p>人工修改的子笔记</p>");
    await expect(api.saveDraft(retry, 1, { ...context, idempotencyKey: "section-interruption-conflict" })).rejects.toThrow("READWEAVE_PAGE_OVERVIEW_CONFLICT");
    expect(remote.contentByTitle("第 001 页 · 测试页面")).toBe(overview);
    remote.editByTitle("03 完整讲解", render.renderSectionOverview(interrupted, "explanation"));
    const recovered = await api.saveDraft(retry, 1, { ...context, idempotencyKey: "section-interruption-retry" });
    expect(recovered.revision).toBe(2);
    expect(remote.contentByTitle("第 001 页 · 测试页面")).toBe(render.renderPageOverview(retry));
  });

  it("recovers an ambiguous page-record PUT without duplicating its cost note", async () => {
    const remote = new FakeEtapi();
    let pageRecordNoteId = "";
    let ambiguousRecordPuts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/etapi/, "");
      if (ambiguousRecordPuts > 0 && init?.method === "PUT" && path === `/notes/${pageRecordNoteId}/content`) {
        ambiguousRecordPuts -= 1;
        await remote.fetch(input, init);
        return new Response("write committed but response was lost", { status: 503 });
      }
      return remote.fetch(input, init);
    };
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const initial = await api.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "cost-retry-base" });
    pageRecordNoteId = remote.noteIdByTitle("Course OS draft record · page-1");
    const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const stateWritesBefore = remote.contentWriteCount(stateNoteId);
    const next = structuredClone(initial);
    next.page.blocks[0]!.markdown = "内容在记录响应丢失时已提交";
    const cost = costEntryFor(pageRelease, "cost-ambiguous-record-put");
    const writeContext = { ...context, idempotencyKey: "ambiguous-record-put" };
    ambiguousRecordPuts = 3;

    await expect(api.saveDraftWithCost(next, 1, writeContext, cost)).rejects.toThrow("READWEAVE_ETAPI_503");
    const committed = decodeReadWeaveStateContent(remote.contentByTitle("Course OS draft record · page-1")) as { draft: LessonDraft; costEntries: GenerationCostEntry[]; idempotency: Record<string, { objectId: string }> };
    expect(committed.draft.revision).toBe(2);
    expect(committed.draft.page.blocks[0]?.markdown).toBe("内容在记录响应丢失时已提交");
    expect(committed.idempotency[writeContext.idempotencyKey]?.objectId).toBe(initial.id);
    await expect(api.saveDraftWithCost(next, 1, writeContext, cost)).resolves.toMatchObject({ revision: 2, contentHash: expect.any(String) });
    expect(remote.countNotesByLabel("courseOsObjectId", cost.id)).toBe(1);
    expect((await api.listCostEntries({ pageId: "page-1" })).map((item) => item.id)).toEqual([cost.id]);
    expect(remote.contentWriteCount(stateNoteId)).toBe(stateWritesBefore);
  });

  it.each(["ambiguous create response", "partial label failure", "first label failure"] as const)("recovers a page record after %s without leaving duplicates", async (failureMode) => {
    const remote = new FakeEtapi();
    let createAttempts = 0;
    let failPageIdLabel = true;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const path = url.pathname.replace(/^\/etapi/, "");
      if (path === "/create-note" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { title: string };
        if (failureMode === "ambiguous create response" && body.title === "Course OS draft record · page-1") {
          createAttempts += 1;
          await remote.fetch(input, init);
          return new Response("created but response was lost", { status: 503 });
        }
      }
      if ((failureMode === "partial label failure" || failureMode === "first label failure")
        && failPageIdLabel && path === "/attributes" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { name: string; value: string };
        if (body.name === (failureMode === "first label failure" ? "courseOsType" : "courseOsDraftRecordPageId")
          && (failureMode !== "first label failure" || body.value === "draft_record")) {
          failPageIdLabel = false;
          return new Response("page label response failed", { status: 400 });
        }
      }
      return remote.fetch(input, init);
    };
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const indexWritesBeforeSave = remote.contentWriteCount(stateNoteId);
    const draft = draftFor(pageRelease);
    const writeContext = { ...context, idempotencyKey: `record-create-recovery-${failureMode}` };

    await expect(api.saveDraft(draft, 0, writeContext)).rejects.toThrow(
      failureMode === "ambiguous create response" ? "READWEAVE_ETAPI_503" : "READWEAVE_ETAPI_400"
    );
    const title = "Course OS draft record · page-1";
    expect(remote.countActiveNotesByTitle(title)).toBe(failureMode === "ambiguous create response" ? 3 : 1);
    if (failureMode === "first label failure") {
      const reopenedBeforeRetry = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
      await expect(reopenedBeforeRetry.listDrafts()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ pageId: "page-1", revision: 1 })
      ]));
    }
    await expect(api.saveDraft(draft, 0, writeContext)).resolves.toMatchObject({ revision: 1, contentHash: expect.any(String) });

    expect(remote.countActiveNotesByTitle(title)).toBe(1);
    expect(remote.countNotesByLabel("courseOsType", "draft_record")).toBe(1);
    expect(remote.countNotesByLabel("courseOsDraftRecordPageId", "page-1")).toBe(1);
    expect(createAttempts).toBe(failureMode === "ambiguous create response" ? 3 : 0);
    expect(remote.contentWriteCount(stateNoteId)).toBe(indexWritesBeforeSave);
    const recovered = decodeReadWeaveStateContent(remote.contentByTitle(title)) as { idempotency: Record<string, { objectId: string }> };
    expect(recovered.idempotency[writeContext.idempotencyKey]?.objectId).toBe(draft.id);
  });

  it("updates independent draft notes with a limit of four while keeping each revision before its content", async () => {
    const remote = new FakeEtapi();
    let trackWrites = false;
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const writeEvents: Array<{ noteId: string; method: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/etapi/, "");
      const method = init?.method ?? "GET";
      const isProjectionWrite = trackWrites && ((method === "POST" && path.endsWith("/revision")) || (method === "PUT" && path.endsWith("/content")));
      const noteId = path.split("/")[2]!;
      if (isProjectionWrite) {
        writeEvents.push({ noteId, method });
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      try {
        return await remote.fetch(input, init);
      } finally {
        if (isProjectionWrite) activeWrites -= 1;
      }
    };
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    const pageRelease = releaseWithPage();
    const firstBlock = pageRelease.pages[0]!.blocks[0]!;
    pageRelease.pages[0]!.blocks = Array.from({ length: 9 }, (_, index) => ({
      ...firstBlock,
      id: `block-${index + 1}`,
      title: `讲解块 ${index + 1}`,
      markdown: `初始内容 ${index + 1}`
    }));
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const initialDraft = await api.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "bounded-draft-initial" });
    const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const stateWritesBeforeSave = remote.contentWriteCount(stateNoteId);
    const changedDraft = structuredClone(initialDraft);
    changedDraft.page.blocks.forEach((block, index) => { block.markdown = `并发保存后的内容 ${index + 1}`; });

    trackWrites = true;
    const saved = await api.saveDraft(changedDraft, 1, { ...context, idempotencyKey: "bounded-draft-update" });
    trackWrites = false;

    expect(saved.revision).toBe(2);
    expect(remote.contentWriteCount(stateNoteId)).toBe(stateWritesBeforeSave);
    expect(maxActiveWrites).toBeGreaterThan(1);
    expect(maxActiveWrites).toBeLessThanOrEqual(4);
    const eventsByNote = new Map<string, string[]>();
    for (const event of writeEvents) eventsByNote.set(event.noteId, [...(eventsByNote.get(event.noteId) ?? []), event.method]);
    expect(eventsByNote.size).toBeGreaterThanOrEqual(9);
    for (const methods of eventsByNote.values()) expect(methods).toEqual(["POST", "PUT"]);

    const writesAfterSave = remote.requests.filter((item) => item.method !== "GET").length;
    await expect(api.saveDraft(changedDraft, 1, { ...context, idempotencyKey: "bounded-draft-update" })).resolves.toMatchObject({ revision: 2 });
    expect(remote.requests.filter((item) => item.method !== "GET")).toHaveLength(writesAfterSave);
    expect(remote.contentWriteCount(stateNoteId)).toBe(stateWritesBeforeSave);
    await expect(api.getDraftByPage("page-1")).resolves.toMatchObject({ revision: 2 });

    remote.editByTitle("讲解块 1", "ReadWeave 的新内容");
    const reopenedApi = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    await expect(reopenedApi.getDraftByPage("page-1")).resolves.toMatchObject({ revision: 3, page: { blocks: expect.arrayContaining([expect.objectContaining({ id: "block-1", markdown: "ReadWeave 的新内容" })]) } });
  });

  it("overlaps two page saves, skips the shared index, and hydrates page snapshots once after restart", async () => {
    const remote = new FakeEtapi();
    const pageRecordNoteIds = new Set<string>();
    let trackingSaves = false;
    let activeRecordWrites = 0;
    let maxActiveRecordWrites = 0;
    let fullRecordSearches = 0;
    let recordReadbacks = 0;
    const pendingRecordReadbacks = new Set<string>();
    const recordWriteContexts = new Map<string, string | null>();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const path = url.pathname.replace(/^\/etapi/, "");
      if (path === "/notes" && (init?.method ?? "GET") === "GET" && url.searchParams.get("search") === '#courseOsType="draft_record"') {
        fullRecordSearches += 1;
      }
      const noteId = /^\/notes\/([^/]+)\/content$/.exec(path)?.[1];
      const isRecordPut = trackingSaves && init?.method === "PUT" && noteId && pageRecordNoteIds.has(noteId);
      if (isRecordPut) {
        recordWriteContexts.set(noteId, new Headers(init?.headers).get("idempotency-key"));
        activeRecordWrites += 1;
        maxActiveRecordWrites = Math.max(maxActiveRecordWrites, activeRecordWrites);
        await new Promise((resolve) => setTimeout(resolve, 20));
        try {
          const response = await remote.fetch(input, init);
          pendingRecordReadbacks.add(noteId);
          return response;
        } finally {
          activeRecordWrites -= 1;
        }
      }
      if (trackingSaves && (init?.method ?? "GET") === "GET" && noteId && pendingRecordReadbacks.delete(noteId)) recordReadbacks += 1;
      return remote.fetch(input, init);
    };
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    const pageRelease = releaseWithPage();
    const secondPage = structuredClone(pageRelease.pages[0]!);
    secondPage.id = "page-2";
    secondPage.pageNumber = 2;
    secondPage.title = "第二测试页面";
    secondPage.blocks[0]!.id = "block-2";
    secondPage.blocks[0]!.title = "第二核心解释";
    pageRelease.pages.push(secondPage);
    pageRelease.pageIds.push(secondPage.id);
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const savedPages = new Map<string, LessonDraft>();
    for (const pageId of ["page-1", "page-2"]) {
      savedPages.set(pageId, await api.saveDraft(draftFor(pageRelease, pageId), 0, { ...context, idempotencyKey: `initial-${pageId}` }));
      pageRecordNoteIds.add(remote.noteIdByTitle(`Course OS draft record · ${pageId}`));
    }
    const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const stateWritesBefore = remote.contentWriteCount(stateNoteId);
    const fullScansBeforeSaves = fullRecordSearches;
    const updates = ["page-1", "page-2"].map((pageId) => {
      const update = structuredClone(savedPages.get(pageId)!);
      update.page.blocks[0]!.markdown = `并发修改 ${pageId}`;
      return api.saveDraft(update, 1, { ...context, idempotencyKey: `update-${pageId}` });
    });
    trackingSaves = true;
    const results = await Promise.all(updates);
    trackingSaves = false;

    expect(results.map((draft) => draft.revision)).toEqual([2, 2]);
    expect(maxActiveRecordWrites).toBe(2);
    expect(recordReadbacks).toBe(2);
    expect(recordWriteContexts.get(remote.noteIdByTitle("Course OS draft record · page-1"))).toBe("update-page-1");
    expect(recordWriteContexts.get(remote.noteIdByTitle("Course OS draft record · page-2"))).toBe("update-page-2");
    expect(remote.contentWriteCount(stateNoteId)).toBe(stateWritesBefore);
    expect(fullRecordSearches).toBe(fullScansBeforeSaves);
    await expect(api.listDrafts()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ pageId: "page-1", revision: 2 }),
      expect.objectContaining({ pageId: "page-2", revision: 2 })
    ]));

    const restartScanBaseline = fullRecordSearches;
    const reopened = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    const snapshots = await Promise.all([reopened.getDraftSnapshotByPage("page-1"), reopened.getDraftSnapshotByPage("page-2")]);
    expect(snapshots.map((draft) => draft?.page.blocks[0]?.markdown)).toEqual(["并发修改 page-1", "并发修改 page-2"]);
    expect(fullRecordSearches).toBe(restartScanBaseline);
    const hydrated = await reopened.listDrafts();
    expect(hydrated.filter((draft) => ["page-1", "page-2"].includes(draft.pageId)).map((draft) => draft.revision)).toEqual([2, 2]);
    expect(fullRecordSearches).toBe(restartScanBaseline + 1);
    await reopened.listDrafts();
    expect(fullRecordSearches).toBe(restartScanBaseline + 1);
  });

  it("preserves an external block edit made during a save and records both versions", async () => {
    const remote = new FakeEtapi();
    let blockNoteId = "";
    let injectExternalEdit = false;
    let injected = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const path = url.pathname.replace(/^\/etapi/, "");
      const response = await remote.fetch(input, init);
      if (injectExternalEdit && !injected && (init?.method ?? "GET") === "GET" && path === `/notes/${blockNoteId}/content`) {
        injected = true;
        remote.editByTitle("核心解释", "外部编辑 during save");
      }
      return response;
    };
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const initial = await api.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "external-edit-base" });
    blockNoteId = remote.noteIdByTitle("核心解释");
    const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const stateWritesBefore = remote.contentWriteCount(stateNoteId);
    const local = structuredClone(initial);
    local.page.blocks[0]!.markdown = "用户提交的新内容";
    injectExternalEdit = true;

    let saveError: unknown;
    try {
      await api.saveDraft(local, 1, { ...context, idempotencyKey: "external-edit-race" });
    } catch (error) {
      saveError = error;
    }
    expect(saveError).toBeInstanceOf(Error);
    expect(String(saveError)).toContain("READWEAVE_REVISION_CONFLICT:");

    expect(injected).toBe(true);
    expect(remote.contentByTitle("核心解释")).toBe("外部编辑 during save");
    expect(remote.contentWriteCount(stateNoteId)).toBe(stateWritesBefore);
    const conflict = (await api.listConflicts()).find((item) => item.status === "open");
    expect(conflict).toBeDefined();
    expect(JSON.parse(conflict!.localContent).blocks[0].markdown).toBe("用户提交的新内容");
    expect(JSON.parse(conflict!.remoteContent).blocks[0].markdown).toBe("外部编辑 during save");
  });

  it("migrates legacy index drafts, costs, and idempotency into a page record after restart", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const legacyDraft = draftFor(pageRelease);
    legacyDraft.revision = 4;
    legacyDraft.page.blocks[0]!.markdown = "旧共享索引中的草稿";
    legacyDraft.contentHash = createHash("sha256").update(JSON.stringify(legacyDraft.page)).digest("hex");
    const legacyCost = costEntryFor(pageRelease, "legacy-cost");
    const legacyKey = "legacy-draft-idempotency";
    const state = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
      drafts: LessonDraft[];
      costEntries: GenerationCostEntry[];
      idempotency: Record<string, { kind: string; objectId: string }>;
    };
    state.drafts = state.drafts.map((draft) => draft.pageId === "page-1" ? legacyDraft : draft);
    state.costEntries = [...state.costEntries, legacyCost];
    state.idempotency[legacyKey] = { kind: "draft", objectId: legacyDraft.id };
    state.idempotency[legacyCost.id] = { kind: "cost_entry", objectId: legacyCost.id };
    remote.editByTitle("00 Course OS 结构化索引", encodeReadWeaveStateContent(state));

    const reopened = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    await expect(reopened.listDrafts()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ pageId: "page-1", revision: 4 })]));
    await expect(reopened.listCostEntries({ pageId: "page-1" })).resolves.toEqual([legacyCost]);
    const indexWritesBeforeMigration = remote.contentWriteCount(remote.noteIdByTitle("00 Course OS 结构化索引"));
    await expect(reopened.saveDraft(legacyDraft, 4, { ...context, idempotencyKey: legacyKey })).resolves.toMatchObject({ revision: 4 });
    const migrated = decodeReadWeaveStateContent(remote.contentByTitle("Course OS draft record · page-1")) as {
      draft: LessonDraft;
      costEntries: GenerationCostEntry[];
      idempotency: Record<string, { objectId: string }>;
    };
    expect(migrated.draft.contentHash).toBe(legacyDraft.contentHash);
    expect(migrated.costEntries).toEqual([legacyCost]);
    expect(migrated.idempotency[legacyKey]?.objectId).toBe(legacyDraft.id);
    expect(remote.contentWriteCount(remote.noteIdByTitle("00 Course OS 结构化索引"))).toBe(indexWritesBeforeMigration);
  });

  it("rehydrates durable page records after an old shared index is restored", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const oldIndex = remote.contentByTitle("00 Course OS 结构化索引");
    const cost = costEntryFor(pageRelease, "rollback-cost");
    await api.saveDraftWithCost(draftFor(pageRelease), 0, { ...context, idempotencyKey: "rollback-draft" }, cost);
    remote.editByTitle("00 Course OS 结构化索引", oldIndex);

    const reopened = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    await expect(reopened.listDrafts()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ pageId: "page-1", revision: 1 })]));
    await expect(reopened.getDraftSnapshotByPage("page-1")).resolves.toMatchObject({ revision: 1 });
    await expect(reopened.listCostEntries({ pageId: "page-1" })).resolves.toEqual([cost]);

    const settings = await reopened.getWorkspaceSettings();
    await reopened.saveWorkspaceSettings(settings, { ...context, idempotencyKey: "rollback-rehydrate-index" });
    const restoredIndex = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
      drafts: LessonDraft[];
      costEntries: GenerationCostEntry[];
      idempotency: Record<string, { objectId: string }>;
    };
    expect(restoredIndex.drafts).toEqual(expect.arrayContaining([expect.objectContaining({ pageId: "page-1", revision: 1 })]));
    expect(restoredIndex.costEntries).toEqual([cost]);
    expect(restoredIndex.idempotency["rollback-draft"]?.objectId).toBe("draft:page-1");
  });

  it("selects the highest revision when duplicate page records exist", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const api = new EtapiReadWeaveCourseApi(config);
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    await api.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "canonical-draft" });
    const canonical = decodeReadWeaveStateContent(remote.contentByTitle("Course OS draft record · page-1")) as {
      draft: LessonDraft;
    };
    const older = structuredClone(canonical);
    older.draft.revision = 0;
    const created = await remote.fetch("http://readweave/create-note", {
      method: "POST",
      body: JSON.stringify({
        parentNoteId: remote.noteIdByTitle("00 Course OS 结构化索引"),
        title: "Course OS draft record · page-1",
        type: "code",
        mime: "application/json",
        content: encodeReadWeaveStateContent(older)
      })
    });
    const duplicateId = ((await created.json()) as { note: { noteId: string } }).note.noteId;
    for (const [name, value] of [["courseOsType", "draft_record"], ["courseOsDraftRecordPageId", "page-1"]]) {
      await remote.fetch("http://readweave/attributes", {
        method: "POST",
        body: JSON.stringify({ noteId: duplicateId, type: "label", name, value, position: 10, isInheritable: false })
      });
    }

    const reopened = new EtapiReadWeaveCourseApi(config);
    await expect(reopened.listDrafts()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ pageId: "page-1", revision: 1 })
    ]));
  });

  it("serializes same-page saves and records a stale revision conflict", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const stateWritesBeforeSaves = remote.contentWriteCount(stateNoteId);
    const winner = draftFor(pageRelease);
    winner.page.blocks[0]!.markdown = "first same-page write";
    const stale = draftFor(pageRelease);
    stale.page.blocks[0]!.markdown = "stale same-page write";

    const firstSave = api.saveDraft(winner, 0, { ...context, idempotencyKey: "same-page-first" });
    const staleSave = api.saveDraft(stale, 0, { ...context, idempotencyKey: "same-page-stale" });
    await expect(firstSave).resolves.toMatchObject({ revision: 1 });
    await expect(staleSave).rejects.toThrow("READWEAVE_REVISION_CONFLICT");
    const writesBeforeReplay = remote.requests.filter((item) => item.method !== "GET").length;
    await expect(api.saveDraft(winner, 0, { ...context, idempotencyKey: "same-page-first" })).resolves.toMatchObject({ revision: 1 });
    expect(remote.requests.filter((item) => item.method !== "GET")).toHaveLength(writesBeforeReplay);

    expect((await api.listConflicts()).filter((item) => item.status === "open")).toHaveLength(1);
    expect((await api.getDraftSnapshotByPage("page-1"))?.page.blocks[0]?.markdown).toBe("first same-page write");
    expect(remote.contentByTitle("核心解释")).toBe("first same-page write");
    expect(remote.contentWriteCount(stateNoteId)).toBe(stateWritesBeforeSaves);
  });

  it("serializes the same page across adapter instances in one API process", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const first = new EtapiReadWeaveCourseApi(config);
    const second = new EtapiReadWeaveCourseApi(config);
    const pageRelease = releaseWithPage();
    await first.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const results = await Promise.allSettled([
      first.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "instance-first" }),
      second.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "instance-second" })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const reopened = new EtapiReadWeaveCourseApi(config);
    await expect(reopened.getDraftSnapshotByPage("page-1")).resolves.toMatchObject({ revision: 1 });
    expect(remote.countActiveNotesByTitle("Course OS draft record · page-1")).toBe(1);
  });

  it("creates newly added block notes in order and stops creating after a partial failure", async () => {
    const remote = new FakeEtapi();
    let trackBlockCreates = false;
    let activeBlockCreates = 0;
    let maxActiveBlockCreates = 0;
    const attemptedBlockTitles: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (trackBlockCreates && url.pathname.endsWith("/create-note") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { title: string };
        if (body.title.startsWith("new block ")) {
          attemptedBlockTitles.push(body.title);
          activeBlockCreates += 1;
          maxActiveBlockCreates = Math.max(maxActiveBlockCreates, activeBlockCreates);
          try {
            if (body.title === "new block 2") return new Response("injected failure", { status: 400 });
            return await remote.fetch(input, init);
          } finally {
            activeBlockCreates -= 1;
          }
        }
      }
      return remote.fetch(input, init);
    };
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    const source = { ...releaseWithPage(), id: "partial-block-source", lifecycle: "draft_source" as const };
    await api.registerDraftSource(source, { ...context, idempotencyKey: "partial-block-source" });
    const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const stateWritesBeforeDraft = remote.contentWriteCount(stateNoteId);
    const timingLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubEnv("COURSE_OS_READWEAVE_TIMING", "1");
    let saved: LessonDraft;
    let timingCalls: unknown[][] = [];
    try {
      saved = await api.saveDraft(draftFor(source), 0, { ...context, idempotencyKey: "partial-block-initial" });
      timingCalls = timingLog.mock.calls.map(([event, payload]) => [event, payload]);
    } finally {
      vi.unstubAllEnvs();
      timingLog.mockRestore();
    }
    const projectionTimingCall = timingCalls.find(([event]) => event === "course_os.readweave_draft_projection_timing");
    expect(projectionTimingCall).toBeDefined();
    const timing = JSON.parse(String(projectionTimingCall?.[1])) as Record<string, unknown>;
    expect(timing).toEqual({ projectionCreated: true, ensureDraftProjectionMs: expect.any(Number), refreshDraftProjectionMs: expect.any(Number) });
    expect(Object.keys(timing).sort()).toEqual(["ensureDraftProjectionMs", "projectionCreated", "refreshDraftProjectionMs"]);
    expect(timingCalls.some(([event]) => event === "course_os.readweave_write_queue_timing")).toBe(false);
    expect(timingCalls.some(([event]) => event === "course_os.readweave_state_write_timing")).toBe(false);
    expect(remote.contentWriteCount(stateNoteId)).toBe(stateWritesBeforeDraft);
    const changed = structuredClone(saved);
    changed.page.blocks.push(
      { ...changed.page.blocks[0]!, id: "new-block-1", title: "new block 1", markdown: "first" },
      { ...changed.page.blocks[0]!, id: "new-block-2", title: "new block 2", markdown: "second" },
      { ...changed.page.blocks[0]!, id: "new-block-3", title: "new block 3", markdown: "third" }
    );

    trackBlockCreates = true;
    await expect(api.saveDraft(changed, 1, { ...context, idempotencyKey: "partial-block-update" })).rejects.toThrow("READWEAVE_ETAPI_400");
    trackBlockCreates = false;
    expect(remote.contentWriteCount(stateNoteId)).toBe(stateWritesBeforeDraft);

    expect(attemptedBlockTitles).toEqual(["new block 1", "new block 2"]);
    expect(maxActiveBlockCreates).toBe(1);
    expect(remote.titles()).toContain("new block 1");
    expect(remote.titles()).not.toContain("new block 3");
  });

  it("projects tree changes to ReadWeave branches and validates exact links", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({
      baseUrl: "http://readweave",
      token: "secret",
      parentNoteId: "root",
      publicUrl: "https://readweave.example.com",
      fetchImpl: remote.fetch
    });
    const course = {
      id: "tree-course",
      workspaceId: "personal",
      title: "树测试课程",
      status: "active" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await api.createCourse(course, { ...context, idempotencyKey: "tree-course" });
    expect(remote.requests.some((request) => request.method === "POST" && request.headers["idempotency-key"] === "tree-course")).toBe(true);
    expect(remote.requests.some((request) => request.method === "GET" && request.path.startsWith("/notes/"))).toBe(true);
    const node: CourseTreeNode = { id: "tree-module", kind: "module", title: "第一章", parentId: course.id, revision: 0, status: "draft", archived: false, children: [] };
    const created = await api.createTreeNode(node, { ...context, idempotencyKey: "tree-module" });
    expect(created.readweaveNoteId).toMatch(/^note/);
    const renamed = await api.updateTreeNode(created.id, { title: "第一章：基础" }, 0, { ...context, idempotencyKey: "tree-rename" });
    expect(renamed).toMatchObject({ title: "第一章：基础", revision: 1 });
    expect(remote.requests.find((request) => request.method === "PATCH" && request.path.startsWith("/notes/"))?.headers["content-type"]).toBe("application/json");
    const moved = await api.updateTreeNode(created.id, { parentId: `material:${course.id}:current` }, 1, { ...context, idempotencyKey: "tree-move" });
    expect(moved.parentId).toBe(`material:${course.id}:current`);
    const trashed = await api.trashTreeNode(created.id, { ...context, idempotencyKey: "tree-trash" });
    expect(trashed.readweaveNoteId).toBe(created.readweaveNoteId);
    const restored = await api.restoreTrash(trashed.id, { ...context, idempotencyKey: "tree-restore" });
    expect(restored).toMatchObject({ id: created.id, archived: false });
    const link = await api.getDeepLink(created.readweaveNoteId!);
    expect(link).toEqual(expect.objectContaining({ host: "readweave.example.com", verified: true, url: `https://readweave.example.com/#root/${created.readweaveNoteId}` }));
    await expect(api.permanentlyDeleteTrash(trashed.id, { ...context, idempotencyKey: "tree-permanent-delete" })).rejects.toThrow("READWEAVE_PERMANENT_DELETE_UNSUPPORTED");
  });

  it("keeps release-only materials stable across cross-course moves, root restore and trash", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({
      baseUrl: "http://readweave",
      token: "secret",
      parentNoteId: "root",
      publicUrl: "https://readweave.example.com",
      fetchImpl: remote.fetch
    });
    const releaseOnly = {
      ...releaseWithPage(),
      id: "release-only-1",
      courseId: "release-course",
      courseTitle: "发布记录生成的课程",
      moduleId: "slides-a",
      moduleTitle: "算法课件"
    } satisfies CourseRelease;
    await api.publishRelease(releaseOnly, { ...manifest, id: "manifest-release-only", courseReleaseId: releaseOnly.id }, { ...context, idempotencyKey: "release-only-publish" });

    const initial = (await api.listTreeNodes()).find((node) => node.kind === "material");
    expect(initial).toMatchObject({ id: "material:release-course:slides-a", materialId: "material:release-course:slides-a", parentId: "release-course" });
    expect(initial?.readweaveNoteId).toBeTruthy();

    const secondCourse: CourseProject = {
      id: "second-course",
      workspaceId: "personal",
      title: "第二门课程",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await api.createCourse(secondCourse, { ...context, idempotencyKey: "second-course" });
    const moved = await api.updateTreeNode(initial!.id, { parentId: secondCourse.id }, initial!.revision ?? 0, { ...context, idempotencyKey: "move-to-second-course" });
    expect(moved.parentId).toBe(secondCourse.id);
    expect(remote.parentTitleOf(moved.readweaveNoteId!)).toBe("02 课程材料");

    const rootMaterial = await api.updateTreeNode(moved.id, { parentId: null }, moved.revision ?? 0, { ...context, idempotencyKey: "move-to-workspace-root" });
    expect(rootMaterial.parentId).toBeUndefined();
    expect(remote.parentTitleOf(rootMaterial.readweaveNoteId!)).toBe("00 工作区根材料");

    const trashed = await api.trashTreeNode(rootMaterial.id, { ...context, idempotencyKey: "trash-root-material" });
    expect(remote.parentTitleOf(trashed.readweaveNoteId!)).toBe("回收站");
    expect((await api.listTreeNodes()).some((node) => node.id === rootMaterial.id)).toBe(false);

    const restored = await api.restoreTrash(trashed.id, { ...context, idempotencyKey: "restore-root-material" }, { restoreMode: "root" });
    expect(restored).toMatchObject({ id: rootMaterial.id, kind: "material", archived: false });
    expect(restored.parentId).toBeUndefined();
    expect(remote.parentTitleOf(restored.readweaveNoteId!)).toBe("00 工作区根材料");
    await expect(api.restoreTrash(trashed.id, { ...context, idempotencyKey: "restore-root-material" }, { restoreMode: "root" })).resolves.toMatchObject({ id: rootMaterial.id });
  });

  it("falls back from a stale cached branch to the remote branch before moving", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({
      baseUrl: "http://readweave",
      token: "secret",
      parentNoteId: "root",
      publicUrl: "https://readweave.example.com",
      fetchImpl: remote.fetch
    });
    const course = {
      id: "stale-branch-course",
      workspaceId: "personal",
      title: "分支恢复测试",
      status: "active" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await api.createCourse(course, { ...context, idempotencyKey: "stale-branch-course" });
    const node: CourseTreeNode = { id: "stable-material-for-branch", kind: "material", materialId: "stable-material-for-branch", title: "分支材料", parentId: course.id, revision: 0, status: "draft", archived: false, children: [] };
    const created = await api.createTreeNode(node, { ...context, idempotencyKey: "stale-branch-material" });
    remote.removeBranch(remote.branchIdForNote(created.readweaveNoteId!));
    const moved = await api.updateTreeNode(created.id, { parentId: null }, 0, { ...context, idempotencyKey: "stale-branch-move" });
    expect(moved.parentId).toBeUndefined();
    expect(remote.parentTitleOf(moved.readweaveNoteId!)).toBe("00 工作区根材料");
  });
});

describe("ReadWeave HTTP deep links", () => {
  it("detects an HTTP server that drops generationJobId on save and readback", async () => {
    let storedDraft: Record<string, unknown> | undefined;
    let submittedDraft: Record<string, unknown> | undefined;
    const api = new HttpReadWeaveCourseApi("https://readweave.example/api/course/v1", "secret", async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/drafts") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { draft: Record<string, unknown>; expectedRevision: number };
        submittedDraft = body.draft;
        const { generationJobId: _dropped, ...persistedDraft } = body.draft;
        storedDraft = { ...persistedDraft, revision: body.expectedRevision + 1 };
        return Response.json(storedDraft);
      }
      if (url.pathname.endsWith("/drafts/by-page/page-1")) {
        return storedDraft ? Response.json(storedDraft) : new Response(null, { status: 404 });
      }
      return new Response("not found", { status: 404 });
    });
    const pageRelease = releaseWithPage();
    const submitted = { ...draftFor(pageRelease), generationJobId: "job-http-owner" };

    const saved = await api.saveDraft(submitted, 0, { ...context, idempotencyKey: "http-generation-owner" });
    const readBack = await api.getDraftByPage("page-1");

    expect(submittedDraft?.generationJobId).toBe("job-http-owner");
    expect(saved.generationJobId).toBeUndefined();
    expect(readBack?.generationJobId).toBeUndefined();
  });

  it("projects only masked credential status and never sends the provider secret to ReadWeave", async () => {
    let requestBody = "";
    let requestHeaders: Record<string, string> = {};
    const api = new HttpReadWeaveCourseApi("https://readweave.example/api/course/v1", "secret", async (_input, init) => {
      requestBody = String(init?.body || "");
      requestHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return Response.json({ id: "deepseek", credential: { configured: true, maskedValue: "••••alue", updatedAt: "2026-08-30T00:00:00.000Z" } });
    });
    const result = await api.saveModelProviderCredential("deepseek", { configured: true, maskedValue: "••••alue", updatedAt: "2026-08-30T00:00:00.000Z" }, { ...context, idempotencyKey: "credential-status" });
    expect(result.credential.maskedValue).toBe("••••alue");
    expect(requestBody).toContain('"credential"');
    expect(requestBody).not.toContain("deepseek-secret-value");
    expect(requestBody).not.toContain("secret");
    expect(requestHeaders["idempotency-key"]).toBe("credential-status");
    expect(requestHeaders["x-workspace-id"]).toBe("personal");
  });

  it("rejects a remote link that is not verified for the live host", async () => {
    const api = new HttpReadWeaveCourseApi("https://readweave.example/api/course/v1", "secret", async () => Response.json({
      noteId: "note-1",
      url: "https://evil.example/#root/note-1",
      host: "evil.example",
      verified: true,
      verifiedAt: new Date().toISOString()
    }));
    await expect(api.getDeepLink("note-1")).resolves.toBeUndefined();
  });

  it("normalizes a verified link to the only public ReadWeave host", async () => {
    const api = new HttpReadWeaveCourseApi("https://readweave.example/api/course/v1", "secret", async () => Response.json({
      noteId: "note-1",
      url: "https://readweave.example.com/legacy/path",
      host: "readweave.example.com",
      verified: true,
      verifiedAt: "2026-08-30T00:00:00.000Z"
    }));
    await expect(api.getDeepLink("note-1")).resolves.toMatchObject({
      url: "https://readweave.example.com/#root/note-1",
      host: "readweave.example.com",
      verified: true
    });
  });

  it("retries transient ReadWeave failures but does not retry a revision or permission conflict", async () => {
    let transientCalls = 0;
    const transient = new HttpReadWeaveCourseApi("https://readweave.example/api/course/v1", "secret", async () => {
      transientCalls += 1;
      if (transientCalls < 3) return new Response("temporarily unavailable", { status: 503 });
      return Response.json({ noteId: "note-1", url: "https://readweave.example.com/#root/note-1", host: "readweave.example.com", verified: true });
    });
    await expect(transient.getDeepLink("note-1")).resolves.toMatchObject({ noteId: "note-1", verified: true });
    expect(transientCalls).toBe(3);

    let conflictCalls = 0;
    const conflict = new HttpReadWeaveCourseApi("https://readweave.example/api/course/v1", "secret", async () => {
      conflictCalls += 1;
      return new Response("conflict", { status: 409 });
    });
    await expect(conflict.getDeepLink("note-1")).rejects.toThrow("READWEAVE_HTTP_409");
    expect(conflictCalls).toBe(1);
  });
});

function releaseWithPage(): CourseRelease {
  return {
    ...release,
    id: "release-with-page",
    pageIds: ["page-1"],
    pages: [{
      id: "page-1",
      pageNumber: 1,
      title: "测试页面",
      imageUrl: "/page.png",
      anchors: [],
      atoms: [],
      blocks: [{ id: "block-1", title: "核心解释", kind: "core", markdown: "原始讲解", sourceAnchorIds: [], atomIds: [] }],
      coverageRequirements: [],
      coverageClaims: [],
      quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable: true, issues: [] }
    }]
  };
}

function costEntryFor(pageRelease: CourseRelease, id: string): GenerationCostEntry {
  return {
    id, workspaceId: "personal", courseId: pageRelease.courseId, materialVersionId: pageRelease.id,
    pageId: "page-1", jobId: `job-${id}`, stage: "teach", provider: "test", model: "test-model",
    inputTokens: 10, outputTokens: 20, cachedInputTokens: 0,
    unitPriceSnapshot: {
      id: "price-1", provider: "test", model: "test-model", currency: "USD",
      capturedAt: new Date().toISOString(), source: "test",
      inputMicrousdPerMillion: 1, outputMicrousdPerMillion: 1, cachedInputMicrousdPerMillion: 0
    },
    estimatedMicrousd: 1, actualMicrousd: 1, durationMs: 25, retries: 0,
    status: "succeeded", qualityPassed: true, createdAt: new Date().toISOString()
  };
}

function draftFor(pageRelease: CourseRelease, pageId = pageRelease.pages[0]!.id): LessonDraft {
  const page = pageRelease.pages.find((item) => item.id === pageId);
  if (!page) throw new Error(`missing page ${pageId}`);
  return {
    id: `draft:${pageId}`,
    workspaceId: "personal",
    courseId: pageRelease.courseId,
    moduleId: pageRelease.moduleId,
    sourceReleaseId: pageRelease.id,
    pageId,
    revision: 0,
    status: "editing",
    page: structuredClone(page),
    changedBlockIds: ["block-1"],
    contentHash: "draft-hash",
    updatedAt: new Date().toISOString()
  };
}

class FakeEtapi {
  private sequence = 0;
  readonly requests: Array<{ path: string; method: string; headers: Record<string, string> }> = [];
  private readonly notes = new Map<string, { title: string; content: string; labels: Record<string, string>; type: string; mime: string; parentBranchIds: string[]; deleted: boolean }>([["root", { title: "root", content: "", labels: {}, type: "text", mime: "text/html", parentBranchIds: [], deleted: false }]]);
  private readonly branches = new Map<string, { branchId: string; noteId: string; parentNoteId: string; notePosition: number }>();

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const path = url.pathname.replace(/^\/etapi/, "");
    this.requests.push({ path, method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (path === "/notes" && (init?.method ?? "GET") === "GET") {
      const query = url.searchParams.get("search") ?? "";
      const match = /^#([^=]+)=(.*)$/.exec(query);
      const value = match?.[2]?.replace(/^"|"$/g, "");
        const exactTitle = /^"([^"]+)"$/.exec(query)?.[1];
      const ancestor = url.searchParams.get("ancestorNoteId");
      const isDescendant = (noteId: string): boolean => {
        if (!ancestor) return true;
        const pending = [noteId];
        const seen = new Set<string>();
        while (pending.length > 0) {
          const current = pending.pop()!;
          if (current === ancestor) return true;
          if (seen.has(current)) continue;
          seen.add(current);
          for (const branchId of this.notes.get(current)?.parentBranchIds ?? []) {
            const parent = this.branches.get(branchId)?.parentNoteId;
            if (parent) pending.push(parent);
          }
        }
        return false;
      };
        const results = [...this.notes.entries()].filter(([noteId, note]) => !note.deleted
          && (match ? note.labels[match[1]!] === value : exactTitle ? note.title.includes(exactTitle) : false)
          && isDescendant(noteId)).map(([noteId, note]) => ({ noteId, title: note.title, type: note.type, mime: note.mime, parentBranchIds: note.parentBranchIds }));
      return Response.json({ results });
    }
    if (path === "/create-note" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { parentNoteId: string; title: string; content: string; type?: string; mime?: string };
      const noteId = `note${++this.sequence}`;
      const branchId = `branch${this.sequence}`;
      this.notes.set(noteId, { title: body.title, content: body.content, labels: {}, type: body.type || "text", mime: body.mime || "text/html", parentBranchIds: [branchId], deleted: false });
      this.branches.set(branchId, { branchId, noteId, parentNoteId: body.parentNoteId, notePosition: 10 });
      return Response.json({ note: { noteId, title: body.title, type: body.type || "text", mime: body.mime || "text/html", parentBranchIds: [branchId] }, branch: { branchId, noteId, parentNoteId: body.parentNoteId, notePosition: 10 } }, { status: 201 });
    }
    if (path === "/attributes" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { noteId: string; name: string; value: string };
      this.notes.get(body.noteId)!.labels[body.name] = body.value;
      return Response.json({ attributeId: `attr${++this.sequence}`, ...body }, { status: 201 });
    }
    const noteMatch = /^\/notes\/([^/]+)$/.exec(path);
    if (noteMatch && (init?.method ?? "GET") === "GET") {
      const note = this.notes.get(noteMatch[1]!);
      if (!note || note.deleted) return new Response("not found", { status: 404 });
      return Response.json({ noteId: noteMatch[1], title: note.title, type: note.type, mime: note.mime, parentBranchIds: note.parentBranchIds });
    }
    if (noteMatch && init?.method === "PATCH") {
      const note = this.notes.get(noteMatch[1]!);
      if (!note || note.deleted) return new Response("not found", { status: 404 });
      const body = JSON.parse(String(init.body)) as { title?: string };
      if (body.title) note.title = body.title;
      return Response.json({ noteId: noteMatch[1], title: note.title, type: note.type, mime: note.mime, parentBranchIds: note.parentBranchIds });
    }
    if (noteMatch && init?.method === "DELETE") {
      const note = this.notes.get(noteMatch[1]!);
      if (!note) return new Response("not found", { status: 404 });
      note.deleted = true;
      return new Response(null, { status: 204 });
    }
    const undeleteMatch = /^\/notes\/([^/]+)\/undelete$/.exec(path);
    if (undeleteMatch && init?.method === "PUT") {
      const note = this.notes.get(undeleteMatch[1]!);
      if (!note) return new Response("not found", { status: 404 });
      note.deleted = false;
      return new Response(null, { status: 204 });
    }
    const branchMatch = /^\/branches\/([^/]+)$/.exec(path);
    if (branchMatch && (init?.method ?? "GET") === "GET") {
      const branch = this.branches.get(branchMatch[1]!);
      return branch ? Response.json(branch) : new Response("not found", { status: 404 });
    }
    if (path === "/branches" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { noteId: string; parentNoteId: string; notePosition?: number };
      const branchId = `branch${++this.sequence}`;
      const branch = { branchId, noteId: body.noteId, parentNoteId: body.parentNoteId, notePosition: body.notePosition ?? 10 };
      this.branches.set(branchId, branch);
      const note = this.notes.get(body.noteId);
      if (note && !note.parentBranchIds.includes(branchId)) note.parentBranchIds.push(branchId);
      return Response.json(branch, { status: 201 });
    }
    const moveMatch = /^\/branches\/([^/]+)\/move-to\/([^/]+)$/.exec(path);
    if (moveMatch && init?.method === "PUT") {
      const branch = this.branches.get(moveMatch[1]!);
      const parent = this.branches.get(moveMatch[2]!);
      if (!branch || !parent) return new Response("not found", { status: 404 });
      branch.parentNoteId = parent.noteId;
      return Response.json({ success: true });
    }
    const contentMatch = /^\/notes\/([^/]+)\/content$/.exec(path);
    if (contentMatch && (init?.method ?? "GET") === "GET") {
      const note = this.notes.get(contentMatch[1]!);
      return note && !note.deleted ? new Response(note.content, { status: 200 }) : new Response("not found", { status: 404 });
    }
    if (contentMatch && init?.method === "PUT") {
      const note = this.notes.get(contentMatch[1]!);
      if (!note || note.deleted) return new Response("not found", { status: 404 });
      note.content = String(init.body ?? "");
      return new Response(null, { status: 204 });
    }
    if (/^\/notes\/[^/]+\/revision$/.test(path) && init?.method === "POST") return new Response(null, { status: 204 });
    return new Response("not found", { status: 404 });
  };

  titles(): string[] {
    return [...this.notes.values()].map((note) => note.title);
  }

  branchIdForNote(noteId: string): string {
    const note = this.notes.get(noteId);
    const branchId = note?.parentBranchIds.find((candidate) => this.branches.has(candidate));
    if (!branchId) throw new Error(`missing branch for ${noteId}`);
    return branchId;
  }

  removeBranch(branchId: string | undefined): void {
    if (!branchId) return;
    this.branches.delete(branchId);
  }

  parentTitleOf(noteId: string): string | undefined {
    const branch = this.notes.get(noteId)?.parentBranchIds
      .map((branchId) => this.branches.get(branchId))
      .find((candidate) => candidate !== undefined);
    return branch ? this.notes.get(branch.parentNoteId)?.title : undefined;
  }

  editByTitle(title: string, content: string): void {
    const note = [...this.notes.values()].find((item) => item.title === title);
    if (!note) throw new Error(`missing note ${title}`);
    note.content = content;
  }

  seedCostIndex(costEntries: GenerationCostEntry[]): string {
    const noteId = `note${++this.sequence}`;
    const branchId = `branch${this.sequence}`;
    this.notes.set(noteId, {
      title: "02 Course OS 成本索引",
      content: encodeReadWeaveStateContent({ schemaVersion: "1.0.0", costEntries, idempotency: {} }),
      labels: { courseOsCostIndex: "personal", courseOsType: "cost_index" },
      type: "code",
      mime: "application/json",
      parentBranchIds: [branchId],
      deleted: false
    });
    this.branches.set(branchId, { branchId, noteId, parentNoteId: "root", notePosition: 10 });
    return noteId;
  }

  contentByTitle(title: string): string {
    const note = [...this.notes.values()].find((item) => item.title === title);
    if (!note) throw new Error(`missing note ${title}`);
    return note.content;
  }

  noteIdByTitle(title: string): string {
    const entry = [...this.notes.entries()].find(([, note]) => note.title === title);
    if (!entry) throw new Error(`missing note ${title}`);
    return entry[0];
  }

  countNotesByLabel(name: string, value: string): number {
    return [...this.notes.values()].filter((note) => !note.deleted && note.labels[name] === value).length;
  }

  countActiveNotesByTitle(title: string): number {
    return [...this.notes.values()].filter((note) => !note.deleted && note.title === title).length;
  }

  contentWriteCount(noteId: string): number {
    return this.requests.filter((request) => request.method === "PUT" && request.path === `/notes/${noteId}/content`).length;
  }
}
