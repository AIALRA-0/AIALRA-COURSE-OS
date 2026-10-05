import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CourseConflict, CourseProject, CourseRelease, CourseTreeNode, GenerationCostEntry, IdempotentWriteContext, LessonDraft, PageLesson, ReleaseManifest } from "@course-os/contracts";
import { EtapiReadWeaveCourseApi, FileReadWeaveCourseApi, HttpReadWeaveCourseApi, defaultModelProviders, defaultModelRoutePolicy, selectMaterialRelease, withReadBudget } from "./index.js";
import { decodeReadWeaveStateContent, encodeReadWeaveStateContent } from "./etapi.js";
import { EMPTY_STATE } from "./index.js";
import { sha256Text, stableStringify } from "@course-os/domain";

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
  const sentinel = "bootstrap parsed snapshot reuse marker";
  const state = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
    researchArchives?: unknown[];
    [key: string]: unknown;
  };
  state.researchArchives = [{ id: "large-bootstrap-snapshot", title: sentinel, content: "archive detail ".repeat(100_000) }];
  const encoded = encodeReadWeaveStateContent(state);
  expect(encoded.startsWith("COURSE_OS_BR_STATE_V1:")).toBe(true);
  remote.editByTitle("00 Course OS 结构化索引", encoded);

  const nativeParse = JSON.parse;
  let snapshotParses = 0;
  const parseSpy = vi.spyOn(JSON, "parse").mockImplementation(((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
    if (text.includes(sentinel)) snapshotParses += 1;
    return nativeParse(text, reviver);
  }) as typeof JSON.parse);
  const before = remote.requests.length;
  const reopened = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
  try {
    await reopened.listCourses();
    expect(remote.requests.slice(before).filter((item) => item.method === "GET" && item.path.endsWith(`/notes/${stateNoteId}/content`))).toHaveLength(1);
    expect(snapshotParses).toBe(1);
  } finally {
    parseSpy.mockRestore();
  }
});

it("aborts a stalled GET body and allows a later cold state read", async () => {
  const remote = new FakeEtapi();
  const original = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
  await original.listCourses();
  const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
  let bodyRequests = 0;
  let abortEvents = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname === `/etapi/notes/${stateNoteId}/content` && (init?.method ?? "GET") === "GET") {
      bodyRequests += 1;
      if (bodyRequests <= 3) {
        let bodyController: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
            controller.enqueue(new TextEncoder().encode("{"));
          }
        });
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          abortEvents += 1;
          bodyController.error(signal.reason ?? new DOMException("aborted", "AbortError"));
        }, { once: true });
        return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
      }
    }
    return remote.fetch(input, init);
  };
  const reader = new EtapiReadWeaveCourseApi({
    baseUrl: "http://readweave", token: "secret", parentNoteId: "root", requestTimeoutMs: 1_000, fetchImpl
  });

  await expect(reader.listCourses()).rejects.toThrow("READWEAVE_ETAPI_NETWORK:");
  expect(bodyRequests).toBe(3);
  expect(abortEvents).toBe(3);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await expect(reader.listCourses()).resolves.toEqual([]);
  expect(bodyRequests).toBe(4);
}, 10_000);

it("spends one read deadline across retries, backoff, and a stalled body", async () => {
  const remote = new FakeEtapi();
  let attempts = 0;
  let bodyAbortEvents = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname === "/etapi/notes/root" && (init?.method ?? "GET") === "GET") {
      attempts += 1;
      if (attempts === 1) return new Response("temporarily unavailable", { status: 503 });
      let bodyController: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          controller.enqueue(new TextEncoder().encode("pending body"));
        }
      });
      const signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => {
        bodyAbortEvents += 1;
        bodyController.error(signal.reason ?? new DOMException("aborted", "AbortError"));
      }, { once: true });
      return new Response(body, { status: 200 });
    }
    return remote.fetch(input, init);
  };
  const api = new EtapiReadWeaveCourseApi({
    baseUrl: "http://readweave", token: "secret", parentNoteId: "root", requestTimeoutMs: 1_000, fetchImpl
  });
  const startedAt = performance.now();

  await expect(withReadBudget({ timeoutMs: 80 }, () => api.verifyConnection())).rejects.toThrow("READ_DEADLINE_EXCEEDED");

  expect(attempts).toBe(2);
  expect(bodyAbortEvents).toBe(1);
  expect(performance.now() - startedAt).toBeLessThan(500);
});

it("lets another state-read consumer finish after the first consumer deadline expires", async () => {
  const remote = new FakeEtapi();
  const original = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
  await original.listCourses();
  const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
  let contentRequests = 0;
  let abortEvents = 0;
  let releaseResponse: (() => void) | undefined;
  let announceFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => { announceFetchStarted = resolve; });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname === `/etapi/notes/${stateNoteId}/content` && (init?.method ?? "GET") === "GET") {
      contentRequests += 1;
      const signal = init?.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        const onAbort = () => {
          abortEvents += 1;
          reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        releaseResponse = () => {
          signal?.removeEventListener("abort", onAbort);
          void remote.fetch(input, init).then(resolve, reject);
        };
        announceFetchStarted();
      });
    }
    return remote.fetch(input, init);
  };
  const reader = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
  const first = withReadBudget({ timeoutMs: 100 }, () => reader.listCourses());
  await fetchStarted;
  const second = withReadBudget({ timeoutMs: 1_500 }, () => reader.listCourses());
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  await expect(first).rejects.toThrow("READ_DEADLINE_EXCEEDED");
  expect(abortEvents).toBe(0);
  releaseResponse?.();
  await expect(second).resolves.toEqual([]);
  expect(contentRequests).toBe(1);
});

it("keeps a background state read alive after a foreground consumer expires", async () => {
  const remote = new FakeEtapi();
  const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
  await new EtapiReadWeaveCourseApi(config).listCourses();
  const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
  let started!: () => void;
  const fetched = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  let aborts = 0;
  let reads = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname === `/etapi/notes/${stateNoteId}/content` && (init?.method ?? "GET") === "GET") {
      reads++;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { aborts++; reject(init?.signal?.reason); };
        init?.signal?.addEventListener("abort", abort, { once: true });
        release = () => { init?.signal?.removeEventListener("abort", abort); resolve(); };
        started();
      });
    }
    return remote.fetch(input, init);
  };
  const reader = new EtapiReadWeaveCourseApi({ ...config, fetchImpl });
  const foreground = withReadBudget({ timeoutMs: 100 }, () => reader.listCourses());
  const expired = expect(foreground).rejects.toThrow("READ_DEADLINE_EXCEEDED");
  await fetched;
  const background = reader.listCourses();
  await expired;
  expect(aborts).toBe(0);
  release();
  await expect(background).resolves.toEqual([]);
  expect(reads).toBe(1);
});

it("expires a background shared read within one thirty-second budget", async () => {
  const remote = new FakeEtapi();
  const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
  await new EtapiReadWeaveCourseApi(config).listCourses();
  const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
  let started!: () => void;
  const fetched = new Promise<void>(resolve => { started = resolve; });
  let aborts = 0;
  let reads = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname === `/etapi/notes/${stateNoteId}/content` && (init?.method ?? "GET") === "GET") {
      reads++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { aborts++; reject(init.signal!.reason); }, { once: true });
        started();
      });
    }
    return remote.fetch(input, init);
  };
  vi.useFakeTimers();
  try {
    const reader = new EtapiReadWeaveCourseApi({ ...config, fetchImpl });
    const background = reader.listCourses();
    const expired = expect(background).rejects.toThrow("READ_DEADLINE_EXCEEDED");
    await fetched;
    await vi.advanceTimersByTimeAsync(8_001);
    expect(aborts).toBe(0);
    await vi.advanceTimersByTimeAsync(22_000);
    await expired;
    expect(aborts).toBe(1);
    expect(reads).toBe(1);
  } finally { vi.useRealTimers(); }
});

it("keeps a cold bootstrap shared while one state-read consumer cancels", async () => {
  const remote = new FakeEtapi();
  let bootstrapSearches = 0;
  let abortEvents = 0;
  let releaseSearch: (() => void) | undefined;
  let announceSearchStarted!: () => void;
  const searchStarted = new Promise<void>((resolve) => { announceSearchStarted = resolve; });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname === "/etapi/notes" && url.searchParams.get("search") === "#courseOsIndex=personal") {
      bootstrapSearches += 1;
      const signal = init?.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        const onAbort = () => {
          abortEvents += 1;
          reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        releaseSearch = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(Response.json({ results: [] }));
        };
        announceSearchStarted();
      });
    }
    return remote.fetch(input, init);
  };
  const reader = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
  const firstController = new AbortController();
  const first = withReadBudget({ signal: firstController.signal }, () => reader.listCourses());
  await searchStarted;
  const second = withReadBudget({ timeoutMs: 1_500 }, () => reader.listCourses());
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  firstController.abort();
  await expect(first).rejects.toThrow("READ_CANCELLED");
  expect(abortEvents).toBe(0);
  releaseSearch?.();
  await expect(second).resolves.toEqual([]);
  expect(bootstrapSearches).toBe(1);
  expect(remote.titles()).toContain("Course OS");
});

it("lets a write finish when it joins a bootstrap started by a short read scope", async () => {
  const remote = new FakeEtapi();
  await new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch }).listCourses();
  let bootstrapSearches = 0;
  let abortEvents = 0;
  let releaseSearch: (() => void) | undefined;
  let announceSearchStarted!: () => void;
  const searchStarted = new Promise<void>((resolve) => { announceSearchStarted = resolve; });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname === "/etapi/notes" && url.searchParams.get("search") === "#courseOsIndex=personal") {
      bootstrapSearches += 1;
      const signal = init?.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        const onAbort = () => {
          abortEvents += 1;
          reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        releaseSearch = () => {
          signal?.removeEventListener("abort", onAbort);
          void remote.fetch(input, init).then(resolve, reject);
        };
        announceSearchStarted();
      });
    }
    return remote.fetch(input, init);
  };
  const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
  const read = withReadBudget({ timeoutMs: 500 }, () => api.getDraftSnapshotByPage("missing-page"));
  await searchStarted;
  const course: CourseProject = {
    id: "write-joins-short-bootstrap",
    workspaceId: "personal",
    title: "写入加入短读范围",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const write = api.createCourse(course, { ...context, idempotencyKey: "write-joins-short-bootstrap" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  await expect(read).rejects.toThrow("READ_DEADLINE_EXCEEDED");
  expect(abortEvents).toBe(0);
  releaseSearch?.();
  await expect(write).resolves.toMatchObject({ id: course.id });
  expect(bootstrapSearches).toBe(1);
  expect(remote.countActiveNotesByTitle(course.title)).toBe(1);
});

it("clears an expired shared state read so a later request can recover", async () => {
  const remote = new FakeEtapi();
  const original = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
  await original.listCourses();
  const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
  let bodyRequests = 0;
  let bodyAbortEvents = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname === `/etapi/notes/${stateNoteId}/content` && (init?.method ?? "GET") === "GET") {
      bodyRequests += 1;
      if (bodyRequests === 1) {
        let bodyController: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
            controller.enqueue(new TextEncoder().encode("{"));
          }
        });
        const signal = init?.signal ?? undefined;
        signal?.addEventListener("abort", () => {
          bodyAbortEvents += 1;
          bodyController.error(signal.reason ?? new DOMException("aborted", "AbortError"));
        }, { once: true });
        return new Response(body, { status: 200 });
      }
    }
    return remote.fetch(input, init);
  };
  const reader = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });

  await expect(withReadBudget({ timeoutMs: 60 }, () => reader.listCourses())).rejects.toThrow("READ_DEADLINE_EXCEEDED");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await expect(withReadBudget({ timeoutMs: 1_000 }, () => reader.listCourses())).resolves.toEqual([]);

  expect(bodyRequests).toBe(2);
  expect(bodyAbortEvents).toBe(1);
});

it("does not let a late state-read completion overwrite the newer cache", async () => {
  const remote = new FakeEtapi();
  const original = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
  await original.listCourses();
  const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
  const staleContent = remote.contentByTitle("00 Course OS 结构化索引");
  const freshCourse: CourseProject = {
    id: "fresh-after-timeout",
    workspaceId: "personal",
    title: "超时后读取的新状态",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const freshState = decodeReadWeaveStateContent(staleContent) as { courses: CourseProject[]; [key: string]: unknown };
  freshState.courses = [freshCourse];
  const freshContent = encodeReadWeaveStateContent(freshState);
  let contentRequests = 0;
  let abortEvents = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname === `/etapi/notes/${stateNoteId}/content` && (init?.method ?? "GET") === "GET") {
      contentRequests += 1;
      if (contentRequests === 1) {
        const signal = init?.signal ?? undefined;
        signal?.addEventListener("abort", () => { abortEvents += 1; }, { once: true });
        await new Promise<void>((resolve) => setTimeout(resolve, 180));
        return new Response(staleContent, { status: 200 });
      }
    }
    return remote.fetch(input, init);
  };
  const reader = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });

  await expect(withReadBudget({ timeoutMs: 60 }, () => reader.listCourses())).rejects.toThrow("READ_DEADLINE_EXCEEDED");
  expect(abortEvents).toBe(1);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  remote.editByTitle("00 Course OS 结构化索引", freshContent);
  await expect(withReadBudget({ timeoutMs: 1_000 }, () => reader.listCourses())).resolves.toEqual([freshCourse]);
  await new Promise<void>((resolve) => setTimeout(resolve, 180));
  await expect(reader.listCourses()).resolves.toEqual([freshCourse]);
  expect(contentRequests).toBe(2);
});

it("keeps write-side GET retry and idempotency behavior outside read budgets", async () => {
  const remote = new FakeEtapi();
  const original = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
  await original.listCourses();
  const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
  let stateReads = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname === `/etapi/notes/${stateNoteId}/content` && (init?.method ?? "GET") === "GET") {
      stateReads += 1;
      if (stateReads < 3) return new Response("temporarily unavailable", { status: 503 });
    }
    return remote.fetch(input, init);
  };
  const writer = new EtapiReadWeaveCourseApi({
    baseUrl: "http://readweave", token: "secret", parentNoteId: "root", requestTimeoutMs: 1_000, fetchImpl
  });
  const course: CourseProject = {
    id: "write-read-retry-course",
    workspaceId: "personal",
    title: "写入重试验证",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await expect(writer.createCourse(course, { ...context, idempotencyKey: "write-read-retry" })).resolves.toMatchObject({ id: course.id });
  // Three attempts resolve the transient cold read; controlled metadata
  // activation then rechecks the latest root and verifies the committed split.
  expect(stateReads).toBe(5);
  expect(remote.requests.some((request) => request.method === "POST" && request.headers["idempotency-key"] === "write-read-retry")).toBe(true);
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

  it("resolves a stale lesson conflict above the current draft revision using the supplied merged page", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-readweave-stale-conflict-"));
    const api = new FileReadWeaveCourseApi(join(root, "state.json"));
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const initial = await api.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "stale-conflict-initial" });

    const stalePage = structuredClone(initial.page);
    stalePage.blocks[0]!.markdown = "旧冲突中的提交";
    await expect(api.saveDraft({ ...initial, page: stalePage }, 0, { ...context, idempotencyKey: "stale-conflict-create" }))
      .rejects.toThrow("READWEAVE_REVISION_CONFLICT");
    const conflict = (await api.listConflicts()).find((item) => item.status === "open");
    expect(conflict).toMatchObject({ localRevision: initial.revision, remoteRevision: initial.revision });

    const latestPage = structuredClone(initial.page);
    latestPage.blocks[0]!.markdown = "当前已确认的新全页稿";
    const latest = await api.saveDraft({ ...initial, page: latestPage }, initial.revision,
      { ...context, idempotencyKey: "stale-conflict-latest" });
    expect(latest.revision).toBe(initial.revision + 1);

    const mergedPage = structuredClone(latest.page);
    mergedPage.title = "调用方确认的新稿标题";
    mergedPage.blocks[0]!.markdown = "调用方确认的新全页合并稿";
    const resolved = await api.resolveConflict(conflict!.id, "merged", JSON.stringify(mergedPage),
      { ...context, idempotencyKey: "stale-conflict-resolve" });
    const saved = await api.getDraftByPage(initial.pageId);

    expect(resolved.status).toBe("resolved");
    expect(saved).toMatchObject({ revision: latest.revision + 1, page: mergedPage });
    expect(saved?.page.blocks[0]?.markdown).toBe("调用方确认的新全页合并稿");
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
  it("updates and reads back a material pointer only after the owned source is fully readable", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const formal = releaseWithPage();
    const secondPage = structuredClone(formal.pages[0]!);
    secondPage.id = "page-2";
    secondPage.pageNumber = 2;
    secondPage.anchors.forEach((anchor) => { anchor.pageId = secondPage.id; });
    secondPage.questionBank?.forEach((question) => { question.pageId = secondPage.id; });
    formal.pages.push(secondPage);
    formal.pageIds.push(secondPage.id);
    await api.publishRelease(formal, { ...manifest, courseReleaseId: formal.id }, context);
    const material = (await api.listTreeNodes()).find((node) => node.kind === "material");
    expect(material).toBeDefined();
    const origin = { ...structuredClone(formal), id: "etapi-origin-draft-source", lifecycle: "draft_source" as const };
    await api.registerDraftSource(origin, { ...context, idempotencyKey: "etapi-tree-pointer-origin" });

    await expect(api.updateTreeNode(material!.id, { currentReleaseId: origin.id }, material!.revision ?? 0,
      { ...context, idempotencyKey: "etapi-tree-pointer-unready" })).rejects.toThrow("READWEAVE_TREE_CURRENT_RELEASE_NOT_READY");

    const ready = { ...draftFor(origin), status: "ready" as const };
    await api.saveDraft(ready, 0, { ...context, idempotencyKey: "etapi-tree-pointer-ready-draft" });
    await expect(api.updateTreeNode(material!.id, { currentReleaseId: origin.id }, material!.revision ?? 0,
      { ...context, idempotencyKey: "etapi-tree-pointer-partial" })).rejects.toThrow("READWEAVE_TREE_CURRENT_RELEASE_NOT_READY");
    const secondReady = { ...draftFor(origin, secondPage.id), status: "ready" as const };
    await api.saveDraft(secondReady, 0, { ...context, idempotencyKey: "etapi-tree-pointer-second-ready-draft" });
    const switched = await api.updateTreeNode(material!.id, { currentReleaseId: origin.id }, material!.revision ?? 0,
      { ...context, idempotencyKey: "etapi-tree-pointer-switch" });

    expect(switched).toMatchObject({ id: material!.id, kind: "material", currentReleaseId: origin.id, releaseId: origin.id });
    await expect(api.getRelease(formal.id)).resolves.toMatchObject({ id: formal.id, version: formal.version, pages: formal.pages });
  });

  it("resolves a stale lesson conflict above the latest page-record revision", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const initial = await api.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "etapi-stale-conflict-initial" });

    const stalePage = structuredClone(initial.page);
    stalePage.blocks[0]!.markdown = "旧冲突中的提交";
    let conflictId = "";
    try {
      await api.saveDraft({ ...initial, page: stalePage }, 0, { ...context, idempotencyKey: "etapi-stale-conflict-create" });
    } catch (error) {
      const message = String(error);
      expect(message).toContain("READWEAVE_REVISION_CONFLICT:");
      conflictId = message.slice(message.indexOf("conflict:"));
    }
    expect(conflictId).toMatch(/^conflict:/u);

    const latestPage = structuredClone(initial.page);
    latestPage.blocks[0]!.markdown = "当前页记录中的最新稿";
    const latest = await api.saveDraft({ ...initial, page: latestPage }, initial.revision,
      { ...context, idempotencyKey: "etapi-stale-conflict-latest" });
    const mergedPage = structuredClone(latest.page);
    mergedPage.blocks[0]!.markdown = "调用方确认的新全页合并稿";

    const recordSearches: string[] = [];
    const resolver = new EtapiReadWeaveCourseApi({
      baseUrl: "http://readweave", token: "secret", parentNoteId: "root",
      fetchImpl: async (input, init) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.pathname === "/etapi/notes" && (init?.method ?? "GET") === "GET") {
          recordSearches.push(url.searchParams.get("search") ?? "");
        }
        return remote.fetch(input, init);
      }
    });
    await expect(resolver.resolveConflict(conflictId, "merged", JSON.stringify(mergedPage),
      { ...context, idempotencyKey: "etapi-stale-conflict-resolve" })).resolves.toMatchObject({ status: "resolved" });
    expect(recordSearches).toContain(`#courseOsDraftRecordPageId="${initial.pageId}"`);
    expect(recordSearches).not.toContain('#courseOsType="draft_record"');
    expect(recordSearches).not.toContain('"Course OS draft record"');
    await expect(resolver.getDraftByPage(initial.pageId)).resolves.toMatchObject({
      revision: latest.revision + 1,
      page: expect.objectContaining({ blocks: [expect.objectContaining({ markdown: "调用方确认的新全页合并稿" })] })
    });
  });

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

  it("reads scoped costs after cold reopen without unrelated page or activity bodies and retains ledger history", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const api = new EtapiReadWeaveCourseApi(config);
    const target = releaseWithPage();
    target.pages.push({ ...structuredClone(target.pages[0]!), id: "page-2", pageNumber: 2, title: "second target page" });
    target.pageIds.push("page-2");
    await api.publishRelease(target, { ...manifest, courseReleaseId: target.id }, context);
    const unrelated = releaseWithPage();
    unrelated.id = "unrelated-cost-release";
    unrelated.pages[0]!.id = "unrelated-cost-page";
    unrelated.pages[0]!.title = "unrelated cost page";
    unrelated.pageIds = ["unrelated-cost-page"];
    await api.registerDraftSource(unrelated, { ...context, idempotencyKey: "unrelated-cost-source" });
    const first = costEntryFor(target, "scoped-first");
    const second = { ...costEntryFor(target, "scoped-second"), pageId: "page-2" };
    const other = { ...costEntryFor(unrelated, "scoped-other"), pageId: "unrelated-cost-page" };
    const firstContext = { ...context, idempotencyKey: "scoped-first-cost" };
    await api.appendCostEntry(first, firstContext);
    await api.appendCostEntry(second, { ...context, idempotencyKey: "scoped-second-cost" });
    await api.appendCostEntry(other, { ...context, idempotencyKey: "scoped-other-cost" });
    const firstRecordId = remote.noteIdByTitle("Course OS draft record · page-1");
    const beforeReplay = remote.contentWriteCount(firstRecordId);
    await expect(api.appendCostEntry(first, firstContext)).resolves.toEqual(first);
    expect(remote.contentWriteCount(firstRecordId)).toBe(beforeReplay);
    await api.saveQuestionSelection({ id: "scoped-cost-selection", sessionId: "synthetic-cost-session",
      courseReleaseId: target.id, pageId: "page-1", seed: "synthetic", questionIds: [], createdAt: new Date().toISOString() },
      { ...context, idempotencyKey: "scoped-cost-selection" });
    const legacy = { ...costEntryFor(target, "scoped-legacy"), pageId: "retired-cost-page" };
    const compact = costEntryFor(target, "scoped-compact");
    const orphan = { ...costEntryFor(target, "scoped-orphan"), materialVersionId: "unknown-cost-material" };
    const indexId = remote.seedCostIndex([compact, { ...first, actualMicrousd: 5 }, orphan]);
    const main = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
      costEntries: GenerationCostEntry[]; projections: { costIndexNoteId?: string };
    };
    main.costEntries = [legacy, { ...first, actualMicrousd: 3 }];
    main.projections.costIndexNoteId = indexId;
    remote.editByTitle("00 Course OS 结构化索引", encodeReadWeaveStateContent(main));
    const unrelatedRecordId = remote.noteIdByTitle("Course OS draft record · unrelated-cost-page");
    const activityId = remote.noteIdByTitle("01 Course OS 学习活动索引");
    const sorted = (entries: GenerationCostEntry[]) => entries.sort((left, right) => left.id.localeCompare(right.id));
    for (const filters of [
      { pageId: "page-1", jobId: first.jobId, materialVersionId: target.id, courseId: target.courseId },
      { materialVersionId: target.id }
    ]) {
      remote.requests.length = 0;
      const reopened = new EtapiReadWeaveCourseApi(config);
      const expected = filters.pageId ? [first] : [first, second, legacy, compact];
      expect(sorted(await reopened.listCostEntries(filters))).toEqual(sorted(expected));
      const contentReads = remote.requests.filter(item => item.method === "GET" && item.path.endsWith("/content")).map(item => item.path);
      expect(contentReads).toContain(`/notes/${firstRecordId}/content`);
      expect(contentReads).not.toContain(`/notes/${unrelatedRecordId}/content`);
      expect(contentReads).not.toContain(`/notes/${activityId}/content`);
      await expect(reopened.listCostEntries({ ...filters, courseId: "other-course" })).resolves.toEqual([]);
    }
    remote.requests.length = 0;
    expect(await new EtapiReadWeaveCourseApi(config).listCostEntries({ materialVersionId: orphan.materialVersionId })).toEqual([orphan]);
    expect(remote.requests.some(item => item.method === "GET" && item.path === `/notes/${unrelatedRecordId}/content`)).toBe(true);
    remote.requests.length = 0;
    expect(await new EtapiReadWeaveCourseApi(config).listCostEntries({ jobId: other.jobId })).toEqual([other]);
    expect(remote.requests.some(item => item.method === "GET" && item.path === `/notes/${firstRecordId}/content`)).toBe(true);
    expect(sorted(await new EtapiReadWeaveCourseApi(config).listCostEntries())).toEqual(sorted([first, second, other, legacy, compact, orphan]));
  });

  it("discovers scoped cost records once and bounds duplicate body reads to four while merging in page order", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const api = new EtapiReadWeaveCourseApi(config);
    const target = releaseWithPage();
    const template = target.pages[0]!;
    target.pages = Array.from({ length: 9 }, (_, index) => ({ ...structuredClone(template),
      id: `page-${index+1}`, pageNumber: index+1, title: `bounded cost page ${index+1}` }));
    target.pageIds = target.pages.map(page => page.id);
    await api.publishRelease(target, { ...manifest, courseReleaseId: target.id }, context);
    const recordPages = new Map<string, number>();
    for (let number = 1; number <= 9; number++) {
      const cost = { ...costEntryFor(target, `batch-cost-${number}`), pageId: `page-${number}`, actualMicrousd: number };
      await api.appendCostEntry(cost, { ...context, idempotencyKey: cost.id });
      const title = `Course OS draft record · page-${number}`;
      const record = decodeReadWeaveStateContent(remote.contentByTitle(title)) as { draft: LessonDraft; costEntries: GenerationCostEntry[] };
      record.draft.revision = 2;
      if (number <= 8) record.costEntries.push({ ...costEntryFor(target, `batch-shared-${number <= 4 ? 1 : 2}`),
        pageId: number <= 4 ? "page-1" : "page-5", actualMicrousd: number*10 });
      remote.editByTitle(title, encodeReadWeaveStateContent(record));
      recordPages.set(remote.noteIdByTitle(title), number);
    }
    const older = decodeReadWeaveStateContent(remote.contentByTitle("Course OS draft record · page-1")) as {
      draft: LessonDraft; costEntries: GenerationCostEntry[];
    };
    older.draft.revision = 1;
    older.costEntries = [costEntryFor(target, "obsolete-duplicate-cost")];
    for (let index = 0; index < 5; index++) {
      const response = await remote.fetch("http://readweave/create-note", { method: "POST", body: JSON.stringify({
        parentNoteId: remote.noteIdByTitle("00 Course OS 结构化索引"), title: "Course OS draft record · page-1",
        type: "code", mime: "application/json", content: encodeReadWeaveStateContent(older)
      }) });
      const noteId = ((await response.json()) as { note: { noteId: string } }).note.noteId;
      await remote.fetch("http://readweave/attributes", { method: "POST", body: JSON.stringify({
        noteId, name: "courseOsDraftRecordPageId", value: "page-1"
      }) });
      recordPages.set(noteId, 1);
    }
    let active = 0;
    let peak = 0;
    const completed: number[] = [];
    const searches: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === "/etapi/notes" && url.searchParams.get("search")?.startsWith("#courseOsDraftRecordPageId=")) {
        searches.push(url.searchParams.get("search")!);
        expect(url.searchParams.get("fastSearch")).toBe("true");
        expect(url.searchParams.get("ancestorNoteId")).toBe("root");
        expect(url.searchParams.get("ancestorDepth")).toBe("lt5");
        expect(url.searchParams.has("limit")).toBe(false);
      }
      const noteId = /\/notes\/([^/]+)\/content$/.exec(url.pathname)?.[1];
      const number = noteId ? recordPages.get(noteId) : undefined;
      if ((init?.method ?? "GET") !== "GET" || number === undefined) return remote.fetch(input, init);
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise(resolve => setTimeout(resolve, (3-(number-1)%4)*20));
        const response = await remote.fetch(input, init);
        completed.push(number);
        return response;
      } finally { active -= 1; }
    };
    const entries = await new EtapiReadWeaveCourseApi({ ...config, fetchImpl }).listCostEntries({ materialVersionId: target.id });
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(completed).toHaveLength(14);
    expect(searches).toEqual([target.pageIds.map(id => `#courseOsDraftRecordPageId="${id}"`).join(" OR ")]);
    expect(completed.indexOf(4)).toBeLessThan(completed.indexOf(1));
    expect(entries.filter(entry => entry.id.startsWith("batch-cost-")).map(entry => entry.actualMicrousd))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(entries.find(entry => entry.id === "batch-shared-1")?.actualMicrousd).toBe(40);
    expect(entries.find(entry => entry.id === "batch-shared-2")?.actualMicrousd).toBe(80);
    expect(entries.some(entry => entry.id === "obsolete-duplicate-cost")).toBe(false);
  });

  it("keeps escaped page IDs literal in scoped OR searches and never reads unrelated bodies", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const api = new EtapiReadWeaveCourseApi(config);
    const target = releaseWithPage();
    const escapedId = String.raw`page-"\ OR #courseOsDraftRecordPageId="unrelated-cost-page`;
    target.pages = [escapedId, "plain-page"].map((id, index) => ({ ...structuredClone(target.pages[0]!), id, pageNumber: index + 1 }));
    target.pageIds = target.pages.map(page => page.id);
    await api.publishRelease(target, { ...manifest, courseReleaseId: target.id }, context);
    for (const pageId of target.pageIds) await api.appendCostEntry({ ...costEntryFor(target, `literal-${pageId}`), pageId },
      { ...context, idempotencyKey: `literal-${pageId}` });
    const unrelated = releaseWithPage();
    unrelated.id = "unrelated-cost-material";
    unrelated.pages[0]!.id = "unrelated-cost-page";
    unrelated.pageIds = ["unrelated-cost-page"];
    await api.publishRelease(unrelated, { ...manifest, courseReleaseId: unrelated.id }, { ...context, idempotencyKey: unrelated.id });
    await api.appendCostEntry({ ...costEntryFor(unrelated, "unrelated-literal-cost"), pageId: "unrelated-cost-page" },
      { ...context, idempotencyKey: "unrelated-literal-cost" });
    const unrelatedId = remote.noteIdByTitle("Course OS draft record · unrelated-cost-page");
    const searches: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/etapi/notes" && url.searchParams.get("search")?.startsWith("#courseOsDraftRecordPageId=")) searches.push(url.searchParams.get("search")!);
      return remote.fetch(input, init);
    };
    remote.requests.length = 0;
    const entries = await new EtapiReadWeaveCourseApi({ ...config, fetchImpl }).listCostEntries({ materialVersionId: target.id });
    expect(entries.map(entry => entry.pageId)).toEqual(target.pageIds);
    expect(searches).toHaveLength(1);
    expect(searches[0]).toContain('\\"');
    expect(searches[0]).toContain('\\\\');
    expect(remote.requests.some(request => request.path === `/notes/${unrelatedId}/content`)).toBe(false);
  });

  it("selects scoped duplicate costs by newest revision and note-ID tie break even with a warm cache", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const api = new EtapiReadWeaveCourseApi(config);
    const target = releaseWithPage();
    await api.publishRelease(target, { ...manifest, courseReleaseId: target.id }, context);
    const historical = costEntryFor(target, "duplicate-history");
    await api.appendCostEntry(historical, { ...context, idempotencyKey: historical.id });
    const reader = new EtapiReadWeaveCourseApi(config);
    await expect(reader.listCostEntries({ pageId: "page-1" })).resolves.toEqual([historical]);
    const record = decodeReadWeaveStateContent(remote.contentByTitle("Course OS draft record · page-1")) as {
      draft: LessonDraft; costEntries: GenerationCostEntry[];
    };
    record.draft.revision = 3;
    const winner = costEntryFor(target, "duplicate-winner");
    for (const [noteId, cost] of [["zz-duplicate", costEntryFor(target, "duplicate-loser")], ["aa-duplicate", winner]] as const) {
      await remote.fetch("http://readweave/create-note", { method: "POST", body: JSON.stringify({
        noteId, parentNoteId: remote.noteIdByTitle("00 Course OS 结构化索引"), title: "Course OS draft record · page-1",
        type: "code", mime: "application/json", content: encodeReadWeaveStateContent({ ...record, costEntries: [historical, cost] })
      }) });
      await remote.fetch("http://readweave/attributes", { method: "POST", body: JSON.stringify({ noteId, name: "courseOsDraftRecordPageId", value: "page-1" }) });
    }
    await expect(reader.listCostEntries({ pageId: "page-1" })).resolves.toEqual([historical, winner]);
  });

  it("bounds unmatched-page recovery bodies to four and recovers only the missing page", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const api = new EtapiReadWeaveCourseApi(config);
    const target = releaseWithPage();
    target.pages.push({ ...structuredClone(target.pages[0]!), id: "page-2", pageNumber: 2 });
    target.pageIds.push("page-2");
    await api.publishRelease(target, { ...manifest, courseReleaseId: target.id }, context);
    const costs = target.pageIds.map(pageId => ({ ...costEntryFor(target, `recovered-${pageId}`), pageId }));
    for (const cost of costs) await api.appendCostEntry(cost, { ...context, idempotencyKey: cost.id });
    const recordId = remote.noteIdByTitle("Course OS draft record · page-1");
    await remote.fetch("http://readweave/attributes", { method: "POST", body: JSON.stringify({ noteId: recordId, name: "courseOsDraftRecordPageId", value: "wrong-page" }) });
    const record = decodeReadWeaveStateContent(remote.contentByTitle("Course OS draft record · page-1"));
    const recordIds = new Set([recordId, remote.noteIdByTitle("Course OS draft record · page-2")]);
    for (let index = 0; index < 6; index++) {
      const response = await remote.fetch("http://readweave/create-note", { method: "POST", body: JSON.stringify({
        parentNoteId: remote.noteIdByTitle("00 Course OS 结构化索引"), title: "Course OS draft record · page-1",
        type: "code", mime: "application/json", content: encodeReadWeaveStateContent(record)
      }) });
      recordIds.add(((await response.json()) as { note: { noteId: string } }).note.noteId);
    }
    let active = 0;
    let peak = 0;
    const recoveries: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const search = url.searchParams.get("search");
      if (search?.startsWith('"Course OS draft record · ')) recoveries.push(search);
      const noteId = /\/notes\/([^/]+)\/content$/.exec(url.pathname)?.[1];
      if (!noteId || !recordIds.has(noteId) || (init?.method ?? "GET") !== "GET") return remote.fetch(input, init);
      peak = Math.max(peak, ++active);
      try { await new Promise(resolve => setTimeout(resolve, 10)); return await remote.fetch(input, init); }
      finally { active--; }
    };
    const entries = await new EtapiReadWeaveCourseApi({ ...config, fetchImpl }).listCostEntries({ materialVersionId: target.id });
    expect(entries).toEqual(costs);
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(recoveries).toEqual(['"Course OS draft record · page-1"']);
    expect(remote.countNotesByLabel("courseOsDraftRecordPageId", "page-1")).toBe(1);
  });

  it("propagates a scoped body deadline instead of substituting warmed cached costs", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const writer = new EtapiReadWeaveCourseApi(config);
    const target = releaseWithPage();
    await writer.publishRelease(target, { ...manifest, courseReleaseId: target.id }, context);
    const historical = costEntryFor(target, "deadline-history");
    await writer.appendCostEntry(historical, { ...context, idempotencyKey: historical.id });
    const recordId = remote.noteIdByTitle("Course OS draft record · page-1");
    let stall = false;
    let stalledReads = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (stall && url.pathname === `/etapi/notes/${recordId}/content` && (init?.method ?? "GET") === "GET") {
        stalledReads++;
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(init?.signal?.reason);
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return remote.fetch(input, init);
    };
    const reader = new EtapiReadWeaveCourseApi({ ...config, fetchImpl });
    await expect(reader.listCostEntries({ pageId: "page-1" })).resolves.toEqual([historical]);
    stall = true;
    await expect(withReadBudget({ timeoutMs: 80 }, () => reader.listCostEntries({ materialVersionId: target.id })))
      .rejects.toThrow("READ_DEADLINE_EXCEEDED");
    expect(stalledReads).toBe(1);
    stall = false;
    const fresh = costEntryFor(target, "deadline-fresh");
    const record = decodeReadWeaveStateContent(remote.contentByTitle("Course OS draft record · page-1")) as { costEntries: GenerationCostEntry[] };
    record.costEntries.push(fresh);
    remote.editByTitle("Course OS draft record · page-1", encodeReadWeaveStateContent(record));
    await expect(reader.listCostEntries({ pageId: "page-1" })).resolves.toEqual([historical, fresh]);
  });

  it("rejects scoped cost reads when the target durable record fails instead of returning an empty ledger", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const api = new EtapiReadWeaveCourseApi(config);
    const target = releaseWithPage();
    await api.publishRelease(target, { ...manifest, courseReleaseId: target.id }, context);
    await api.appendCostEntry(costEntryFor(target, "failed-target-cost"), { ...context, idempotencyKey: "failed-target-cost" });
    const recordId = remote.noteIdByTitle("Course OS draft record · page-1");
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith(`/notes/${recordId}/content`)) {
        return new Response("injected target record failure", { status: 400 });
      }
      return remote.fetch(input, init);
    };
    await expect(new EtapiReadWeaveCourseApi({ ...config, fetchImpl }).listCostEntries({ pageId: "page-1" }))
      .rejects.toThrow("READWEAVE_ETAPI_400");
    await expect(new EtapiReadWeaveCourseApi({ ...config, fetchImpl }).listCostEntries({ materialVersionId: target.id }))
      .rejects.toThrow("READWEAVE_ETAPI_400");
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

  it("merges owned draft records with the same full result and safe own idempotency keys", () => {
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root" });
    const first = draftFor(releaseWithPage());
    const other = { ...structuredClone(first), id: "draft:other", pageId: "other" };
    const oldCost = costEntryFor(releaseWithPage(), "same-cost");
    const otherCost = { ...oldCost, id: "other-cost", pageId: "other" };
    const conflict = { id: "same-conflict", objectId: first.pageId, localContent: "old" };
    const otherConflict = { ...conflict, id: "other-conflict", objectId: "other" };
    const projection = { pageNoteId: "page-note", blockHashes: { "block-1": "old" } };
    const state = { ...structuredClone(EMPTY_STATE), drafts: [first, other], costEntries: [oldCost, otherCost],
      conflicts: [conflict, otherConflict], projections: { drafts: { [first.id]: projection } },
      idempotency: { untouched: { kind: "attempt", objectId: "attempt-1" }, shared: { kind: "draft", objectId: "old" } } };
    const record = { pageId: first.pageId, draft: { ...structuredClone(first), revision: 2 },
      projection: { ...projection, blockHashes: { "block-1": "new" } },
      costEntries: [{ ...oldCost, actualMicrousd: 99 }, { ...oldCost, id: "new-cost" }],
      conflicts: [{ ...conflict, localContent: "new" }],
      idempotency: Object.fromEntries([
        ["shared", { kind: "draft", objectId: "new" }],
        ["__proto__", { kind: "draft", objectId: first.id }],
        ["constructor", { kind: "cost_entry", objectId: "new-cost" }]
      ]) };
    const ownSymbol = Symbol("own-key");
    Object.defineProperty(record.idempotency, ownSymbol, { value: { kind: "draft", objectId: first.id }, enumerable: true });
    Object.defineProperty(record.idempotency, "hidden", { value: { kind: "draft", objectId: "ignored" }, enumerable: false });
    Object.setPrototypeOf(record.idempotency, { inherited: { kind: "draft", objectId: "ignored" } });
    const setter = vi.fn();
    Object.defineProperty(state.idempotency, "shared", { get: () => ({ kind: "draft", objectId: "old" }), set: setter, enumerable: true, configurable: true });
    const expected = { ...structuredClone(state), drafts: [structuredClone(record.draft), other],
      costEntries: [otherCost, ...record.costEntries], conflicts: [otherConflict, ...record.conflicts],
      projections: { drafts: { [first.id]: structuredClone(record.projection) } },
      idempotency: { ...state.idempotency, ...record.idempotency } };
    const borrowedSnapshot = structuredClone(state);
    const borrowedHash = sha256Text(stableStringify(borrowedSnapshot));
    const dictionary = state.idempotency;
    const merge = api as unknown as { mergeDraftPageRecord(snapshot: typeof state, value: typeof record): void };
    merge.mergeDraftPageRecord(state, record);
    expect(sha256Text(stableStringify(state))).toBe(sha256Text(stableStringify(expected)));
    expect(state.idempotency).toBe(dictionary);
    expect(setter).not.toHaveBeenCalled();
    expect(Object.getPrototypeOf(state.idempotency)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(state.idempotency, "__proto__")).toEqual({ value: record.idempotency.__proto__, writable: true, enumerable: true, configurable: true });
    expect(Reflect.get(state.idempotency, ownSymbol)).toEqual(Reflect.get(expected.idempotency, ownSymbol));
    expect(Object.hasOwn(state.idempotency, "hidden")).toBe(false);
    expect(Object.hasOwn(state.idempotency, "inherited")).toBe(false);
    expect(sha256Text(stableStringify(borrowedSnapshot))).toBe(borrowedHash);
    state.drafts[0]!.page.blocks[0]!.markdown = "owned change";
    state.projections.drafts[first.id]!.blockHashes["block-1"] = "owned change";
    expect(record.draft.page.blocks[0]!.markdown).toBe("原始讲解");
    expect(record.projection.blockHashes["block-1"]).toBe("new");
  });

  it("partitions high-frequency learning activity and preserves it across restart and failed writes", async () => {
    const remote = new FakeEtapi();
    let failingActivityNoteId = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      if (failingActivityNoteId && init?.method === "PUT" && new URL(String(input)).pathname.endsWith(`/notes/${failingActivityNoteId}/content`)) return new Response("temporary failure", { status: 503 });
      return remote.fetch(input, init);
    };
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, { ...context, idempotencyKey: "activity-release" });
    await api.saveDraftWithCost(draftFor(pageRelease), 0, { ...context, idempotencyKey: "activity-cached-draft" }, costEntryFor(pageRelease, "activity-cost"));
    await api.listDrafts();

    const firstSelection = {
      id: "selection-1", sessionId: "session-1", courseReleaseId: pageRelease.id, pageId: "page-1",
      seed: "seed-1", questionIds: ["question-1"], createdAt: "2026-09-15T00:00:00.000Z"
    };
    await api.saveQuestionSelection(firstSelection, { ...context, idempotencyKey: "activity-selection-1" });
    const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const activityNoteId = remote.noteIdByTitle("01 Course OS 学习活动索引");
    const stateWritesAfterInitialization = remote.contentWriteCount(stateNoteId);
    const activityWritesAfterInitialization = remote.contentWriteCount(activityNoteId);

    const selectionRequests = remote.requests.length;
    await api.saveQuestionSelection({ ...firstSelection, id: "selection-2", seed: "seed-2" }, { ...context, idempotencyKey: "activity-selection-2" });
    expect(remote.requests.slice(selectionRequests).map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: `/notes/${activityNoteId}/content` },
      { method: "POST", path: `/notes/${activityNoteId}/revision` }, { method: "PUT", path: `/notes/${activityNoteId}/content` }
    ]);
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
    const legacyAttempt = { ...assessmentAttempt, id: "legacy-attempt", objectiveId: "legacy-objective" };
    const legacyMastery = { ...mastery, objectiveId: legacyAttempt.objectiveId };
    await api.saveAttempt(legacyAttempt, legacyMastery, { ...context, idempotencyKey: "activity-legacy-attempt" });
    expect(remote.contentWriteCount(stateNoteId)).toBe(stateWritesAfterInitialization);

    const beforeFailure = decodeReadWeaveStateContent(remote.contentByTitle("01 Course OS 学习活动索引"));
    const cachedState = Reflect.get(api, "stateCache").state;
    const cacheHash = sha256Text(stableStringify(cachedState));
    const records = Reflect.get(api, "draftPageRecordCache");
    const recordHash = sha256Text(stableStringify([...records.values()]));
    const failedSelection = { ...firstSelection, id: "selection-after-failure" };
    const failedContext = { ...context, idempotencyKey: "activity-failed-selection" };
    failingActivityNoteId = activityNoteId;
    await expect(api.saveQuestionSelection(failedSelection, failedContext)).rejects.toThrow("READWEAVE_ETAPI_503");
    expect(decodeReadWeaveStateContent(remote.contentByTitle("01 Course OS 学习活动索引"))).toEqual(beforeFailure);
    expect(sha256Text(stableStringify(cachedState))).toBe(cacheHash);
    expect(sha256Text(stableStringify([...records.values()]))).toBe(recordHash);
    failingActivityNoteId = "";
    await expect(api.saveQuestionSelection(failedSelection, failedContext)).resolves.toEqual(failedSelection);

    const reopened = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    expect(await reopened.listQuestionAttempts("page-1")).toEqual([questionAttempt]);
    expect(Reflect.get(reopened, "draftPageRecordsHydrated")).toBe(false);
    expect(await reopened.listAssessmentAttempts()).toEqual([assessmentAttempt, legacyAttempt]);
    expect(await reopened.listMastery()).toEqual([mastery, legacyMastery]);
    expect(await reopened.getDraftSnapshotByPage("page-1")).toMatchObject({ revision: 1 });
    expect((await reopened.listCostEntries()).map((entry) => entry.id)).toContain("activity-cost");
    const writesBeforeReplay = remote.requests.filter((item) => item.method !== "GET").length;
    const replay = await reopened.saveQuestionAttemptTransaction({ ...questionAttempt, answer: "不应覆盖" }, assessmentAttempt, () => mastery, attemptContext);
    expect(replay.attempt).toEqual(questionAttempt);
    expect(await reopened.saveQuestionSelection(failedSelection, failedContext)).toEqual(failedSelection);
    expect(remote.requests.filter((item) => item.method !== "GET")).toHaveLength(writesBeforeReplay);
  });

  it("logs only numeric activity timing when enabled without changing data or replay writes", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    await api.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "timing-draft" });
    const selection = { id: "timing-selection", sessionId: "session-1", courseReleaseId: pageRelease.id,
      pageId: "page-1", seed: "seed", questionIds: ["question-1"], createdAt: "2026-09-15T00:00:00.000Z" };
    const previousFlag = process.env.COURSE_OS_READWEAVE_TIMING;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      process.env.COURSE_OS_READWEAVE_TIMING = "0";
      await api.saveQuestionSelection(selection, { ...context, idempotencyKey: "timing-initialize" });
      expect(info).not.toHaveBeenCalled();
      clone.mockClear();
      process.env.COURSE_OS_READWEAVE_TIMING = "1";
      const next = { ...selection, id: "timing-selection-2" };
      const writeContext = { ...context, idempotencyKey: "timing-write" };
      await api.saveQuestionSelection(next, writeContext);
      const mutation = JSON.parse(info.mock.calls.find(([event]) => event === "course_os.readweave_activity_mutation_timing")![1]);
      const write = JSON.parse(info.mock.calls.find(([event]) => event === "course_os.readweave_activity_state_write_timing")![1]);
      expect(Object.keys(mutation).sort()).toEqual(["activityCloneMs", "activityReadMs", "activityWriteMs", "changeMs", "replay", "totalMs"]);
      expect(Object.keys(write).sort()).toEqual(["encodeMs", "idempotencyKeyCount", "revisionAndPutMs"]);
      for (const value of [...Object.entries(mutation).filter(([key]) => key !== "replay").map(([, value]) => value), ...Object.values(write)]) {
        expect(typeof value).toBe("number");
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
      const clonedActivity = clone.mock.calls.map(([value]) => value as Record<string, unknown>)
        .find((value) => Array.isArray(value.questionSelections) && Array.isArray(value.questionAttempts)
          && Array.isArray(value.mastery) && value.schemaVersion === "1.0.0");
      expect(Object.keys(clonedActivity ?? {}).sort()).toEqual([
        "attempts", "idempotency", "mastery", "questionAttempts", "questionSelections", "schemaVersion"
      ]);
      expect(write.idempotencyKeyCount).toBe(2);
      const persisted = remote.contentByTitle("01 Course OS 学习活动索引");
      expect(decodeReadWeaveStateContent(persisted)).toMatchObject({ questionSelections: [selection, next], questionAttempts: [], attempts: [], mastery: [] });
      const writes = remote.requests.filter(({ method }) => method !== "GET").length;
      info.mockImplementation(() => { throw new Error("DIAGNOSTIC_SINK_FAILURE"); });
      await expect(api.saveQuestionSelection(next, writeContext)).resolves.toEqual(next);
      expect(remote.contentByTitle("01 Course OS 学习活动索引")).toBe(persisted);
      expect(remote.requests.filter(({ method }) => method !== "GET")).toHaveLength(writes);
    } finally {
      if (previousFlag === undefined) delete process.env.COURSE_OS_READWEAVE_TIMING;
      else process.env.COURSE_OS_READWEAVE_TIMING = previousFlag;
      clone.mockRestore();
      info.mockRestore();
    }
  });

  it("does not let an in-flight course read delay or overwrite a committed activity write", async () => {
    const remote = new FakeEtapi();
    let holdCourseRead = false;
    let releaseCourseRead: (() => void) | undefined;
    let courseReadStarted: (() => void) | undefined;
    const courseReadGate = new Promise<void>((resolve) => { releaseCourseRead = resolve; });
    const started = new Promise<void>((resolve) => { courseReadStarted = resolve; });
    const api = new EtapiReadWeaveCourseApi({
      baseUrl: "http://readweave", token: "secret", parentNoteId: "root",
      fetchImpl: async (input, init) => {
        const path = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname.replace(/^\/etapi/u, "");
        if (holdCourseRead && (init?.method ?? "GET") === "GET" && path === `/notes/${remote.noteIdByTitle("00 Course OS 结构化索引")}/content`) {
          holdCourseRead = false;
          courseReadStarted?.();
          await courseReadGate;
        }
        return remote.fetch(input, init);
      }
    });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    await api.saveQuestionSelection({ id: "late-read-selection", sessionId: "session-1", courseReleaseId: pageRelease.id,
      pageId: "page-1", seed: "seed", questionIds: ["question-1"], createdAt: "2026-09-15T00:00:00.000Z" },
    { ...context, idempotencyKey: "late-read-selection" });
    Reflect.set(api, "stateCache", undefined);
    holdCourseRead = true;
    const fullRead = api.listCourses();
    await started;

    const attempt = { id: "late-read-attempt", selectionId: "late-read-selection", sessionId: "session-1",
      courseReleaseId: pageRelease.id, pageId: "page-1", questionId: "question-1", objectiveId: "objective-1",
      answer: "saved", correct: true, usedHintLevel: 0, attemptedAt: "2026-09-15T00:01:00.000Z" };
    const assessment = { id: attempt.id, itemId: attempt.questionId, objectiveId: attempt.objectiveId,
      answer: attempt.answer, correct: true, usedHintLevel: 0, attemptedAt: attempt.attemptedAt };
    const mastery = { objectiveId: attempt.objectiveId, state: "practicing" as const, unaidedCorrect: true,
      delayedOrTransferCorrect: false, intervalStep: 1, algorithmVersion: "review-ladder-v1" as const, updatedAt: attempt.attemptedAt };
    const mutation = api.saveQuestionAttemptTransaction(attempt, assessment, () => mastery,
      { ...context, idempotencyKey: "late-read-attempt" });
    const completedWithoutCourseRead = await Promise.race([
      mutation.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))
    ]);
    expect(completedWithoutCourseRead).toBe(true);
    releaseCourseRead?.();
    await fullRead;
    expect((await api.listQuestionAttempts("page-1")).map((item) => item.id)).toEqual([attempt.id]);
    expect(Reflect.get(api, "stateCache")).toBeUndefined();
  });

  it("serializes activity independently and reconciles it after an older core PUT", async () => {
    const remote = new FakeEtapi();
    let holdCorePut = false;
    let releaseCorePut: (() => void) | undefined;
    let announceCorePut!: () => void;
    const corePutGate = new Promise<void>((resolve) => { releaseCorePut = resolve; });
    const corePutStarted = new Promise<void>((resolve) => { announceCorePut = resolve; });
    const api = new EtapiReadWeaveCourseApi({
      baseUrl: "http://readweave", token: "secret", parentNoteId: "root",
      fetchImpl: async (input, init) => {
        const path = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname.replace(/^\/etapi/u, "");
        if (holdCorePut && init?.method === "PUT") {
          const coreNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
          if (path === `/notes/${coreNoteId}/content`) {
            holdCorePut = false;
            announceCorePut();
            await corePutGate;
          }
        }
        return remote.fetch(input, init);
      }
    });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const initialSelection = { id: "core-race-initial", sessionId: "session-1", courseReleaseId: pageRelease.id,
      pageId: "page-1", seed: "initial", questionIds: ["question-1"], createdAt: "2026-09-15T00:00:00.000Z" };
    await api.saveQuestionSelection(initialSelection, { ...context, idempotencyKey: "core-race-initial" });
    const activityNoteId = remote.noteIdByTitle("01 Course OS 学习活动索引");
    const coreNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");

    holdCorePut = true;
    const coreMutation = api.registerDraftSource({ ...releaseWithPage(), id: "core-race-source" },
      { ...context, idempotencyKey: "core-race-source" });
    await corePutStarted;
    const requestsAtCorePut = remote.requests.length;

    const selection = { ...initialSelection, id: "core-race-selection", seed: "saved selection" };
    const replayedSelection = { ...selection, seed: "must not replace first request" };
    const attempt = { id: "core-race-attempt", selectionId: selection.id, sessionId: selection.sessionId,
      courseReleaseId: pageRelease.id, pageId: selection.pageId, questionId: "question-1", objectiveId: "objective-1",
      answer: "saved answer", correct: true, usedHintLevel: 0, attemptedAt: "2026-09-15T00:01:00.000Z" };
    const activityPromise = Promise.all([
      api.saveQuestionSelection(selection, { ...context, idempotencyKey: "core-race-selection" }),
      api.saveQuestionSelection(replayedSelection, { ...context, idempotencyKey: "core-race-selection" })
    ]).then(async (savedSelections) => {
      const savedAttempt = await api.saveQuestionAttempt(attempt, { ...context, idempotencyKey: "core-race-attempt" });
      Reflect.set(api, "activityCache", undefined);
      const [selected, attempts] = await Promise.all([
        api.getQuestionSelection(selection.id), api.listQuestionAttempts("page-1")
      ]);
      return { savedSelections, savedAttempt, selected, attempts };
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const activityOutcome = await Promise.race([
      activityPromise.then((value) => ({ value }), (error: unknown) => ({ error })),
      new Promise<{ timeout: true }>((resolve) => { timeout = setTimeout(() => resolve({ timeout: true }), 1_000); })
    ]);
    if (timeout) clearTimeout(timeout);
    try {
      expect(activityOutcome).toEqual({ value: {
        savedSelections: [selection, selection], savedAttempt: attempt, selected: selection, attempts: [attempt]
      } });
      expect(remote.requests.slice(requestsAtCorePut)
        .filter((request) => request.method === "GET" && request.path === `/notes/${coreNoteId}/content`)).toHaveLength(0);
      expect(remote.requests.some((request) => request.method === "GET" && request.path === `/notes/${activityNoteId}/content`)).toBe(true);
    } finally {
      releaseCorePut?.();
    }

    const activityWritesBeforeCoreCommit = remote.contentWriteCount(activityNoteId);
    await coreMutation;
    expect(remote.contentWriteCount(activityNoteId)).toBe(activityWritesBeforeCoreCommit);

    const reopened = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const fullState = await (reopened as unknown as { readStateReference(requireFresh?: boolean): Promise<{
      questionSelections: typeof selection[];
      questionAttempts: typeof attempt[];
    }> }).readStateReference(true);
    expect(fullState.questionSelections).toEqual([initialSelection, selection]);
    expect(fullState.questionAttempts).toEqual([attempt]);
  });

  it("serializes the cold recheck-existing path against indexed activity writes", async () => {
    const remote = new FakeEtapi();
    let watchedActivityNoteId = "";
    let watchThirdActivityRead = false;
    let announceThirdActivityRead!: () => void;
    const thirdActivityReadStarted = new Promise<void>((resolve) => { announceThirdActivityRead = resolve; });
    const api = new EtapiReadWeaveCourseApi({
      baseUrl: "http://readweave", token: "secret", parentNoteId: "root",
      fetchImpl: async (input, init) => {
        const path = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname.replace(/^\/etapi/u, "");
        if (watchThirdActivityRead && init?.method === "GET" && path === `/notes/${watchedActivityNoteId}/content`) {
          announceThirdActivityRead();
        }
        return remote.fetch(input, init);
      }
    });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);

    const internals = api as unknown as {
      findActivityStateNoteId(): Promise<string | undefined>;
      readActivityReference(noteId?: string, requireFresh?: boolean): Promise<unknown>;
      writeContext: { getStore(): { idempotencyKey: string } | undefined };
    };
    const originalFind = internals.findActivityStateNoteId.bind(api);
    const originalRead = internals.readActivityReference.bind(api);
    let coldFinds = 0;
    let releaseColdFinds!: () => void;
    const bothColdFinds = new Promise<void>((resolve) => { releaseColdFinds = resolve; });
    let secondIndexedReadCount = 0;
    let releaseSecondRead!: () => void;
    let announceSecondRead!: () => void;
    const secondReadGate = new Promise<void>((resolve) => { releaseSecondRead = resolve; });
    const secondReadStarted = new Promise<void>((resolve) => { announceSecondRead = resolve; });
    let watchNextFind = false;
    let announceThirdFind!: () => void;
    const thirdFindDone = new Promise<void>((resolve) => { announceThirdFind = resolve; });
    const activityNoteIdAtStart: string | undefined = undefined;

    vi.spyOn(internals, "findActivityStateNoteId").mockImplementation(async () => {
      const found = await originalFind();
      if (!found && coldFinds < 2) {
        coldFinds += 1;
        if (coldFinds === 2) releaseColdFinds();
        await bothColdFinds;
        return undefined;
      }
      if (watchNextFind) {
        watchNextFind = false;
        announceThirdFind();
      }
      return found;
    });
    vi.spyOn(internals, "readActivityReference").mockImplementation(async (noteId, requireFresh) => {
      const activity = await originalRead(noteId, requireFresh);
      let currentActivityNoteId: string | undefined;
      try { currentActivityNoteId = remote.noteIdByTitle("01 Course OS 学习活动索引"); } catch { /* cold index not created yet */ }
      if (requireFresh && currentActivityNoteId !== activityNoteIdAtStart && currentActivityNoteId !== undefined) {
        secondIndexedReadCount += 1;
        if (secondIndexedReadCount === 2) {
          announceSecondRead();
          await secondReadGate;
        }
      }
      return activity;
    });
    const first = { id: "cold-first", sessionId: "session-1", courseReleaseId: pageRelease.id, pageId: "page-1",
      seed: "first", questionIds: ["question-1"], createdAt: "2026-09-15T00:00:00.000Z" };
    const second = { ...first, id: "cold-second", seed: "second" };
    const third = { ...first, id: "cold-third", seed: "third" };
    const firstTask = api.saveQuestionSelection(first, { ...context, idempotencyKey: "cold-first" });
    const secondTask = api.saveQuestionSelection(second, { ...context, idempotencyKey: "cold-second" });

    try {
      await secondReadStarted;
      const activityNoteId = remote.noteIdByTitle("01 Course OS 学习活动索引");
      watchedActivityNoteId = activityNoteId;
      watchThirdActivityRead = true;
      watchNextFind = true;
      const thirdTask = api.saveQuestionSelection(third, { ...context, idempotencyKey: "cold-third" });
      await thirdFindDone;
      const thirdReadWonRace = await Promise.race([
        thirdActivityReadStarted.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 75))
      ]);
      if (thirdReadWonRace) await thirdTask;
      expect(thirdReadWonRace).toBe(false);
      releaseSecondRead();
      await Promise.all([firstTask, secondTask, thirdTask]);
      expect(remote.noteIdByTitle("01 Course OS 学习活动索引")).toBe(activityNoteId);
      const persisted = decodeReadWeaveStateContent(remote.contentByTitle("01 Course OS 学习活动索引")) as {
        questionSelections: typeof first[];
      };
      expect(persisted.questionSelections).toEqual([first, second, third]);
    } finally {
      releaseSecondRead();
      watchThirdActivityRead = false;
    }
  });

  it("returns a cached draft snapshot without cloning or merging the full course state", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const expected = await api.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "snapshot-small-copy" });
    const merge = vi.spyOn(api as unknown as { mergeDraftPageRecord: (state: unknown, record: unknown) => void }, "mergeDraftPageRecord")
      .mockImplementation(() => { throw new Error("snapshot should not merge a whole draft record into course state"); });
    const readsBefore = remote.requests.length;

    await expect(api.getDraftSnapshotByPage("page-1")).resolves.toEqual(expected);

    expect(merge).not.toHaveBeenCalled();
    expect(remote.requests).toHaveLength(readsBefore);
  });

  it("reads question attempts from the activity note without reading the course index", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    await api.saveQuestionSelection({ id: "activity-read-selection", sessionId: "session-1", courseReleaseId: pageRelease.id,
      pageId: "page-1", seed: "seed", questionIds: ["question-1"], createdAt: "2026-09-15T00:00:00.000Z" },
    { ...context, idempotencyKey: "activity-read-selection" });
    Reflect.set(api, "activityCache", undefined);
    Reflect.set(api, "stateCache", undefined);
    const activityNoteId = remote.noteIdByTitle("01 Course OS 学习活动索引");
    const before = remote.requests.length;

    await expect(api.listQuestionAttempts("page-1")).resolves.toEqual([]);

    expect(remote.requests.slice(before).map(({ method, path }) => [method, path])).toEqual([
      ["GET", `/notes/${activityNoteId}/content`]
    ]);
  });

  it("re-reads an activity snapshot invalidated by a successful or ambiguous write", async () => {
    for (const ambiguous of [false, true]) {
      const remote = new FakeEtapi();
      let activityNoteId = "";
      let holdStaleRead = false;
      let releaseStaleRead!: () => void;
      let announceStaleRead!: () => void;
      const staleReadGate = new Promise<void>((resolve) => { releaseStaleRead = resolve; });
      const staleReadStarted = new Promise<void>((resolve) => { announceStaleRead = resolve; });
      let loseActivityPutResponse = false;
      let lostPutResponses = 0;
      const api = new EtapiReadWeaveCourseApi({
        baseUrl: "http://readweave", token: "secret", parentNoteId: "root",
        fetchImpl: async (input, init) => {
          const path = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname.replace(/^\/etapi/u, "");
          if (holdStaleRead && (init?.method ?? "GET") === "GET" && path === `/notes/${activityNoteId}/content`) {
            holdStaleRead = false;
            const response = await remote.fetch(input, init);
            announceStaleRead();
            await staleReadGate;
            return response;
          }
          const response = await remote.fetch(input, init);
          if (ambiguous && loseActivityPutResponse && init?.method === "PUT"
            && path === `/notes/${activityNoteId}/content` && lostPutResponses < 3) {
            lostPutResponses += 1;
            return new Response("response lost after activity commit", { status: 503 });
          }
          return response;
        }
      });
      const pageRelease = releaseWithPage();
      await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
      const initial = { id: "stale-read-initial", sessionId: "session-1", courseReleaseId: pageRelease.id,
        pageId: "page-1", seed: "initial", questionIds: ["question-1"], createdAt: "2026-09-15T00:00:00.000Z" };
      await api.saveQuestionSelection(initial, { ...context, idempotencyKey: "stale-read-initial" });
      activityNoteId = remote.noteIdByTitle("01 Course OS 学习活动索引");
      Reflect.set(api, "activityCache", undefined);
      holdStaleRead = true;
      const pendingRead = api.getQuestionSelection("stale-read-after-write");
      await staleReadStarted;

      const next = { ...initial, id: "stale-read-after-write", seed: "committed while read is paused" };
      loseActivityPutResponse = ambiguous;
      const write = api.saveQuestionSelection(next, { ...context, idempotencyKey: "stale-read-after-write" });
      if (ambiguous) await expect(write).rejects.toThrow("READWEAVE_ETAPI_503");
      else await expect(write).resolves.toEqual(next);

      releaseStaleRead();
      await expect(pendingRead).resolves.toEqual(next);
      const persisted = decodeReadWeaveStateContent(remote.contentByTitle("01 Course OS 学习活动索引")) as {
        questionSelections: typeof initial[];
      };
      expect(persisted.questionSelections).toEqual([initial, next]);
    }
  });

  it("scopes cold activity and bootstrap reads to the renamed direct workspace ahead of nested clones", async () => {
    const remote = new FakeEtapi();
    const writer = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await writer.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const attempt = {
      id: "active-workspace-attempt", selectionId: "selection-1", sessionId: "session-1", courseReleaseId: pageRelease.id,
      pageId: "page-1", questionId: "question-1", objectiveId: "objective-1", answer: "active", correct: true,
      usedHintLevel: 0, attemptedAt: "2026-09-15T00:01:00.000Z"
    };
    await writer.saveQuestionAttempt(attempt, { ...context, idempotencyKey: "active-workspace-attempt" });

    const activeCoreId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const activeActivityId = remote.noteIdByTitle("01 Course OS 学习活动索引");
    const activeRootId = (decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
      projections: { courseRootNoteId: string };
    }).projections.courseRootNoteId;
    const archiveContainerId = remote.addChildNote("root", "Archived workspace copies");
    const archivedRootId = remote.addNoteCopy(activeRootId, archiveContainerId);
    const archivedCoreId = remote.addNoteCopy(activeCoreId, archivedRootId);
    const archivedActivityId = remote.addNoteCopy(activeActivityId, archivedRootId);
    remote.renameNote(activeRootId, "Renamed Course OS workspace");
    remote.renameNote(activeCoreId, "Renamed structured index");
    remote.removeNoteLabel(activeActivityId, "courseOsType");
    const nestedIndexArchiveId = remote.addChildNote(activeRootId, "Archived index copies");
    const nestedCoreId = remote.addNoteCopy(activeCoreId, nestedIndexArchiveId);
    const nestedActivityId = remote.addNoteCopy(activeActivityId, nestedIndexArchiveId);
    remote.replaceNoteContent(archivedActivityId, encodeReadWeaveStateContent({
      questionAttempts: [{ ...attempt, id: "archived-workspace-attempt", pageId: "archived-page", answer: "stale" }]
    }));

    const workspaceResultOrders: string[][] = [];
    const contentReads: string[] = [];
    const coreIndexAncestors: Array<string | null> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const path = url.pathname.replace(/^\/etapi/u, "");
      const response = await remote.fetch(input, init);
      if (path === "/notes" && (init?.method ?? "GET") === "GET") {
        const data = await response.json() as { results: Array<{ noteId: string }> };
        if (url.searchParams.get("search")?.includes("courseOsIndex")) coreIndexAncestors.push(url.searchParams.get("ancestorNoteId"));
        data.results.reverse();
        if (url.searchParams.get("search")?.includes("courseOsWorkspaceId")) {
          workspaceResultOrders.push(data.results.map((item) => item.noteId));
        }
        return Response.json(data);
      }
      const contentMatch = /^\/notes\/([^/]+)\/content$/u.exec(path);
      if (contentMatch && (init?.method ?? "GET") === "GET") contentReads.push(contentMatch[1]!);
      return response;
    };

    const coldActivityReader = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    await expect(coldActivityReader.listQuestionAttempts("page-1")).resolves.toEqual([attempt]);
    expect(workspaceResultOrders[0]!.indexOf(archivedRootId)).toBeLessThan(workspaceResultOrders[0]!.indexOf(activeRootId));
    expect(contentReads).toContain(activeActivityId);
    expect(contentReads).not.toContain(archivedActivityId);
    expect(contentReads).not.toContain(nestedActivityId);
    expect(contentReads).not.toContain(activeCoreId);

    contentReads.length = 0;
    const coldBootstrapReader = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    await expect(coldBootstrapReader.listReleaseIndexes()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: pageRelease.id })]));
    expect(contentReads).toContain(activeCoreId);
    expect(contentReads).not.toContain(archivedCoreId);
    expect(contentReads).not.toContain(nestedCoreId);
    expect(coreIndexAncestors).toEqual([activeRootId]);
  });

  it("rejects multiple direct workspace roots before any bootstrap writes", async () => {
    const remote = new FakeEtapi();
    const writer = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await writer.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const activeRootId = (decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
      projections: { courseRootNoteId: string };
    }).projections.courseRootNoteId;
    remote.addNoteCopy(activeRootId, "root");

    const before = remote.requests.length;
    const coldReader = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    await expect(coldReader.listReleaseIndexes()).rejects.toThrow("READWEAVE_WORKSPACE_ROOT_AMBIGUOUS");
    expect(remote.requests.slice(before).filter((item) => item.method !== "GET")).toEqual([]);
  });

  it("preserves a single legacy core index after validating its unlabeled direct workspace", async () => {
    const remote = new FakeEtapi();
    const writer = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await writer.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const activeCoreId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const activeRootId = (decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
      projections: { courseRootNoteId: string };
    }).projections.courseRootNoteId;
    remote.removeNoteLabel(activeRootId, "courseOsType");
    remote.removeNoteLabel(activeRootId, "courseOsWorkspaceId");

    const before = remote.requests.length;
    const coldReader = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    await expect(coldReader.listReleaseIndexes()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: pageRelease.id })]));
    const reads = remote.requests.slice(before);
    expect(reads.some((item) => item.method === "GET" && item.path === `/notes/${activeCoreId}/content`)).toBe(true);
    expect(reads.filter((item) => item.method !== "GET")).toEqual([]);
  });

  it("rejects multiple legacy core indexes below the configured parent without provisioning", async () => {
    const remote = new FakeEtapi();
    const writer = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await writer.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const activeCoreId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const activeRootId = (decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
      projections: { courseRootNoteId: string };
    }).projections.courseRootNoteId;
    remote.removeNoteLabel(activeRootId, "courseOsType");
    remote.removeNoteLabel(activeRootId, "courseOsWorkspaceId");
    remote.addNoteCopy(activeCoreId, activeRootId);

    const before = remote.requests.length;
    const coldReader = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    await expect(coldReader.listReleaseIndexes()).rejects.toThrow("READWEAVE_COURSE_INDEX_DUPLICATE");
    const requests = remote.requests.slice(before);
    expect(requests.filter((item) => item.method !== "GET")).toEqual([]);
    expect(requests.some((item) => item.path.endsWith("/content"))).toBe(false);
  });

  it("rejects duplicate direct core and activity indexes without reading either snapshot", async () => {
    const setup = async () => {
      const remote = new FakeEtapi();
      const writer = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
      const pageRelease = releaseWithPage();
      await writer.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
      await writer.saveQuestionSelection({ id: "duplicate-index-selection", sessionId: "session-1", courseReleaseId: pageRelease.id,
        pageId: "page-1", seed: "seed", questionIds: ["question-1"], createdAt: "2026-09-15T00:00:00.000Z" },
      { ...context, idempotencyKey: "duplicate-index-selection" });
      const state = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
        projections: { courseRootNoteId: string };
      };
      return {
        remote,
        activeRootId: state.projections.courseRootNoteId,
        coreId: remote.noteIdByTitle("00 Course OS 结构化索引"),
        activityId: remote.noteIdByTitle("01 Course OS 学习活动索引")
      };
    };

    const coreFixture = await setup();
    coreFixture.remote.addNoteCopy(coreFixture.coreId, coreFixture.activeRootId);
    const coreReader = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: coreFixture.remote.fetch });
    const coreBefore = coreFixture.remote.requests.length;
    await expect(coreReader.listReleaseIndexes()).rejects.toThrow("READWEAVE_COURSE_INDEX_DUPLICATE");
    expect(coreFixture.remote.requests.slice(coreBefore).filter((item) => item.method !== "GET")).toEqual([]);
    expect(coreFixture.remote.requests.slice(coreBefore).some((item) => item.path.endsWith("/content"))).toBe(false);

    const activityFixture = await setup();
    activityFixture.remote.addNoteCopy(activityFixture.activityId, activityFixture.activeRootId);
    const activityReader = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: activityFixture.remote.fetch });
    const activityBefore = activityFixture.remote.requests.length;
    await expect(activityReader.listQuestionAttempts("page-1")).rejects.toThrow("READWEAVE_ACTIVITY_INDEX_DUPLICATE");
    expect(activityFixture.remote.requests.slice(activityBefore).filter((item) => item.method !== "GET")).toEqual([]);
    expect(activityFixture.remote.requests.slice(activityBefore).some((item) => item.path.endsWith("/content"))).toBe(false);
  });

  it("lists course, tree, and trash data without waiting for the activity index", async () => {
    const remote = new FakeEtapi();
    const writer = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await writer.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    await writer.saveQuestionSelection({ id: "fast-course-selection", sessionId: "session-1", courseReleaseId: pageRelease.id,
      pageId: "page-1", seed: "seed", questionIds: ["question-1"], createdAt: "2026-09-15T00:00:00.000Z" },
    { ...context, idempotencyKey: "fast-course-selection" });
    const activityNoteId = remote.noteIdByTitle("01 Course OS 学习活动索引");
    let releaseActivityRead!: () => void;
    let activityReadStarted!: () => void;
    const activityGate = new Promise<void>((resolve) => { releaseActivityRead = resolve; });
    const activityStarted = new Promise<void>((resolve) => { activityReadStarted = resolve; });
    const reader = new EtapiReadWeaveCourseApi({
      baseUrl: "http://readweave", token: "secret", parentNoteId: "root",
      fetchImpl: async (input, init) => {
        const path = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname.replace(/^\/etapi/u, "");
        if ((init?.method ?? "GET") === "GET" && path === `/notes/${activityNoteId}/content`) {
          activityReadStarted();
          await activityGate;
        }
        return remote.fetch(input, init);
      }
    });
    try {
      const [indexes, release, trash, treeNodes] = await Promise.race([
        Promise.all([reader.listReleaseIndexes(), reader.getRelease(pageRelease.id), reader.listTrash(), reader.listTreeNodes()]),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("non-activity read waited for activity")), 1000))
      ]);
      expect(indexes.map((item) => item.id)).toContain(pageRelease.id);
      expect(release?.id).toBe(pageRelease.id);
      expect(trash).toEqual([]);
      expect(treeNodes.length).toBeGreaterThan(0);
      const attempts = reader.listQuestionAttempts("page-1");
      await activityStarted;
      releaseActivityRead();
      await expect(attempts).resolves.toEqual([]);
    } finally {
      releaseActivityRead();
    }
  });

  it("reloads after an ambiguous activity PUT and does not duplicate the attempt note on replay", async () => {
    const remote = new FakeEtapi();
    let activityNoteId = "";
    let losePutResponses = false;
    let lostResponses = 0;
    const api = new EtapiReadWeaveCourseApi({
      baseUrl: "http://readweave", token: "secret", parentNoteId: "root",
      fetchImpl: async (input, init) => {
        const response = await remote.fetch(input, init);
        const path = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname;
        if (losePutResponses && init?.method === "PUT" && path.endsWith(`/notes/${activityNoteId}/content`) && lostResponses < 3) {
          lostResponses += 1;
          return new Response("response lost after commit", { status: 503 });
        }
        return response;
      }
    });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    await api.saveQuestionSelection({ id: "ambiguous-selection", sessionId: "session-1", courseReleaseId: pageRelease.id,
      pageId: "page-1", seed: "seed", questionIds: ["question-1"], createdAt: "2026-09-15T00:00:00.000Z" },
    { ...context, idempotencyKey: "ambiguous-selection" });
    activityNoteId = remote.noteIdByTitle("01 Course OS 学习活动索引");
    const attempt = { id: "ambiguous-attempt", selectionId: "ambiguous-selection", sessionId: "session-1",
      courseReleaseId: pageRelease.id, pageId: "page-1", questionId: "question-1", objectiveId: "objective-1",
      answer: "saved", correct: true, usedHintLevel: 0, attemptedAt: "2026-09-15T00:01:00.000Z" };
    const assessment = { id: attempt.id, itemId: attempt.questionId, objectiveId: attempt.objectiveId,
      answer: attempt.answer, correct: true, usedHintLevel: 0, attemptedAt: attempt.attemptedAt };
    const mastery = { objectiveId: attempt.objectiveId, state: "practicing" as const, unaidedCorrect: true,
      delayedOrTransferCorrect: false, intervalStep: 1, algorithmVersion: "review-ladder-v1" as const, updatedAt: attempt.attemptedAt };
    const writeContext = { ...context, idempotencyKey: "ambiguous-attempt" };
    losePutResponses = true;
    await expect(api.saveQuestionAttemptTransaction(attempt, assessment, () => mastery, writeContext)).rejects.toThrow("READWEAVE_ETAPI_503");
    expect(decodeReadWeaveStateContent(remote.contentByTitle("01 Course OS 学习活动索引"))).toMatchObject({ questionAttempts: [attempt] });
    losePutResponses = false;

    await expect(api.saveQuestionAttemptTransaction(attempt, assessment, () => mastery, writeContext)).resolves.toMatchObject({ attempt });

    expect((decodeReadWeaveStateContent(remote.contentByTitle("01 Course OS 学习活动索引")) as { questionAttempts: unknown[] }).questionAttempts).toHaveLength(1);
    expect(remote.countActiveNotesByTitle("作答 · page-1")).toBe(1);
    const noteCreate = remote.requests.find((request) => request.method === "POST" && request.path.endsWith("/create-note")
      && request.headers["idempotency-key"] === writeContext.idempotencyKey);
    expect(noteCreate?.headers).toMatchObject({
      "idempotency-key": writeContext.idempotencyKey,
      "x-actor": context.actor,
      "x-workspace-id": context.workspaceId
    });
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
    const workspaceResultOrders: string[][] = [];
    let linkReads = 0;
    let peakLinkReads = 0;
    let failLinkReads = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const path = url.pathname.replace(/^\/etapi/, "");
      if (path === "/notes" && url.searchParams.get("search")?.includes("courseOsWorkspaceId") && pageNoteId) {
        const result = await remote.fetch(input, init);
        const data = await result.json() as { results: unknown[] };
        data.results.reverse();
        workspaceResultOrders.push(data.results.map((item) => (item as { noteId: string }).noteId));
        // Saved learner notes carry the workspace label too, but are not containers.
        if (!url.searchParams.get("search")?.includes('#courseOsType="workspace"')) data.results.push({ noteId: "learner-attempt", type: "text" });
        return Response.json(data);
      }
      if (path === "/notes/_readweaveLinks") {
        nativeRequests.push("GET /notes/_readweaveLinks");
        return Response.json({ noteId: "_readweaveLinks", childNoteIds: ["link-1", "link-duplicate", "link-other", "link-unused-1", "link-unused-2", "link-unused-3", "link-unused-4"] });
      }
      if (path.startsWith("/notes/link-") || path.startsWith("/notes/object-")) {
        nativeRequests.push(`${init?.method ?? "GET"} ${path}`);
        if (path.startsWith("/notes/link-") && path.endsWith("/content")) {
          linkReads += 1;
          peakLinkReads = Math.max(peakLinkReads, linkReads);
          await new Promise((resolve) => setTimeout(resolve, 5));
          linkReads -= 1;
          if (failLinkReads) return new Response("unavailable", { status: 503 });
        }
        if (path.startsWith("/notes/link-unused-")) return Response.json({ articleId: "another-page", objectId: "object-other" });
        if (path === "/notes/link-1/content" || path === "/notes/link-duplicate/content") return Response.json({ linkId: path.includes("duplicate") ? "link-duplicate" : "link-1", articleId: pageNoteId, objectId: "object-1", contentType: "problem" });
        if (path === "/notes/link-other/content") return Response.json({ linkId: "link-other", articleId: "another-page", objectId: "object-other", contentType: "problem", displayBody: pageNoteId });
        if (path === "/notes/object-1/content") return Response.json({ objectId: "object-1", kind: "question", contentType: "problem", title: "为什么要保留状态？", body: "<p>因为下一步需要它</p>" });
        return new Response("not found", { status: 404 });
      }
      return remote.fetch(input, init);
    };
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", publicUrl: "https://readweave.example.com", fetchImpl });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    pageNoteId = (await api.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "native-qa-draft" })).readweaveNoteId!;
    const activeRootId = (decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
      projections: { courseRootNoteId: string };
    }).projections.courseRootNoteId;
    const archiveContainerId = remote.addChildNote("root", "Archived workspace copies");
    const archivedRootId = remote.addNoteCopy(activeRootId, archiveContainerId);
    remote.addLabeledChildNote(archivedRootId, "archived-page-clone", "Archived page clone", {
      courseOsObjectId: "page-1", courseOsType: "page"
    });
    const reader = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", publicUrl: "https://readweave.example.com", fetchImpl });
    const writesBefore = remote.requests.filter((item) => item.method !== "GET").length;
    const requestsBefore = remote.requests.length;
    const result = await reader.listNativePageQuestions("page-1");
    expect(result.questions).toEqual([{ objectId: "object-1", title: "为什么要保留状态？", excerpt: "因为下一步需要它", updatedAt: undefined }]);
    expect(result.noteUrl).toContain(pageNoteId);
    expect(await reader.listNativePageQuestions("page-1", "another-workspace")).toEqual({ pageId: "page-1", questions: [] });
    expect(remote.requests.filter((item) => item.method !== "GET")).toHaveLength(writesBefore);
    const readRequests = remote.requests.slice(requestsBefore);
    expect(readRequests.filter((item) => item.path === "/notes")).toHaveLength(2);
    expect(workspaceResultOrders[0]!.indexOf(archivedRootId)).toBeLessThan(workspaceResultOrders[0]!.indexOf(activeRootId));
    expect(nativeRequests.filter((item) => item === "GET /notes/_readweaveLinks")).toHaveLength(1);
    expect(peakLinkReads).toBe(4);
    expect(nativeRequests).not.toContain("GET /notes/object-other/content");
    expect(readRequests.some((item) => item.path.startsWith("/notes/") && item.path.endsWith("/content") && !item.path.includes("link-") && !item.path.includes("object-"))).toBe(false);
    expect(nativeRequests.every((item) => item.startsWith("GET "))).toBe(true);
    failLinkReads = true;
    await expect(withReadBudget({ timeoutMs: 80 }, () => api.listNativePageQuestions("page-1"))).rejects.toThrow();
  });
  it("keeps snapshots cached while live reads reconcile same-instance v2 edits before cache expiry", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({
      baseUrl: "http://readweave",
      token: "secret",
      parentNoteId: "root",
      publicUrl: "https://readweave.example.com",
      fetchImpl: remote.fetch
    });
    const clock = vi.spyOn(Date, "now");
    const base = Date.now();
    clock.mockReturnValue(base);
    try {
      const pageRelease = releaseWithPage();
      const page = pageRelease.pages[0]!;
      page.lessonFlowVersion = 2;
      page.lessonSections = [
        { id: "section-main", kind: "main_content", title: "主要内容", markdown: "原始讲解", items: [{ id: "old-item", text: "旧结构条目", sourceAnchorIds: [] }], sourceAnchorIds: [], atomIds: [] },
        { id: "section-full", kind: "full_explanation", title: "完整讲解", markdown: "未编辑的完整讲解", sourceAnchorIds: [], atomIds: [] },
        { id: "section-objectives", kind: "learning_objectives", title: "学习目标", markdown: "未编辑的学习目标", sourceAnchorIds: [], atomIds: [] },
        { id: "section-bridge", kind: "chapter_bridge", title: "承上启下", markdown: "未编辑的页面桥接", sourceAnchorIds: [], atomIds: [] }
      ];
      page.blocks.push({ id: "qa-block", title: "已有 QA", kind: "qa", markdown: "保留的 QA 内容", sourceAnchorIds: [], atomIds: [] });
      page.questionBank = [{
        id: "question-1", pageId: "page-1", objectiveId: "objective-1", kind: "comprehension",
        prompt: "原题目", expectedAnswer: "原答案", explanation: "原解析", sourceAnchorIds: [],
        status: "approved", version: 1, generatedBy: "test"
      }];
      await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
      const draft = draftFor(pageRelease);
      draft.status = "ready";
      const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      const saved = await api.saveDraft(draft, 0, { ...context, idempotencyKey: "etapi-draft-1" }, {
        sha256: "etapi-draft-image", fileName: "page-001.png", mediaType: "image/png", bytes: image
      });
      expect(saved.readweaveNoteId).toBeTruthy();
      expect(remote.titles()).toEqual(expect.arrayContaining(["Course OS", "02 课程材料", "03 完整讲解", "核心解释"]));
      const primed = await api.getDraftByPage("page-1");
      expect(primed).toMatchObject({ revision: 1, status: "ready" });
      const originalSections = structuredClone(primed!.page.lessonSections!);
      const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
      const stateWritesBeforeRead = remote.contentWriteCount(stateNoteId);
      const imageNoteId = remote.noteIdByTitle("page-001.png");
      const imageWritesBeforeRead = remote.contentWriteCount(imageNoteId);

      remote.editByTitle("核心解释", "ReadWeave 中直接完成的逐块修改");
      const requestsBeforeSnapshot = remote.requests.length;
      const snapshot = await api.getDraftSnapshotByPage("page-1");
      expect(snapshot).toMatchObject({ revision: 1, status: "ready" });
      expect(snapshot?.page.blocks[0]?.markdown).toBe("原始讲解");
      expect(remote.requests).toHaveLength(requestsBeforeSnapshot);

      const writesBeforeLiveRead = remote.requests.filter((item) => item.method !== "GET").length;
      const reconciled = await api.getDraftByPage("page-1");
      expect(reconciled).toMatchObject({
        revision: 2,
        status: "ready",
        page: { blocks: expect.arrayContaining([expect.objectContaining({ id: "block-1", markdown: "ReadWeave 中直接完成的逐块修改" })]) }
      });
      const sections = reconciled!.page.lessonSections!;
      expect(sections.find((section) => section.id === "section-main")).toMatchObject({ markdown: "ReadWeave 中直接完成的逐块修改", items: [] });
      for (const sectionId of ["section-full", "section-objectives", "section-bridge"]) {
        expect(sections.find((section) => section.id === sectionId)).toEqual(originalSections.find((section) => section.id === sectionId));
      }
      expect(reconciled!.page.blocks.find((block) => block.id === "qa-block")?.markdown).toBe("保留的 QA 内容");
      expect(remote.contentByTitle("已有 QA")).toBe("保留的 QA 内容");
      expect(reconciled!.page.imageUrl).toBe(primed!.page.imageUrl);
      expect(reconciled!.page.questionBank).toEqual(primed!.page.questionBank);
      expect(remote.contentWriteCount(stateNoteId)).toBe(stateWritesBeforeRead);
      expect(remote.contentWriteCount(imageNoteId)).toBe(imageWritesBeforeRead);
      expect(remote.requests.filter((item) => item.method !== "GET").length - writesBeforeLiveRead).toBeLessThanOrEqual(2);

      const writesAfterFirstLiveRead = remote.requests.filter((item) => item.method !== "GET").length;
      const requestsAfterFirstLiveRead = remote.requests.length;
      const reread = await api.getDraftByPage("page-1");
      expect(reread).toMatchObject({ revision: 2, status: "ready" });
      expect(reread!.page.lessonSections).toEqual(reconciled!.page.lessonSections);
      expect(remote.requests.length).toBeGreaterThan(requestsAfterFirstLiveRead);
      expect(remote.requests.filter((item) => item.method !== "GET")).toHaveLength(writesAfterFirstLiveRead);
      expect(remote.contentWriteCount(stateNoteId)).toBe(stateWritesBeforeRead);
      expect(remote.contentWriteCount(imageNoteId)).toBe(imageWritesBeforeRead);
      expect((await api.getSyncStatus()).mode).toBe("etapi");
    } finally {
      clock.mockRestore();
    }
  });

  it("reads an existing draft record without downloading the course index", async () => {
    const remote = new FakeEtapi();
    const setup = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const release = releaseWithPage();
    await setup.publishRelease(release, { ...manifest, courseReleaseId: release.id }, context);
    await setup.saveDraft(draftFor(release), 0, { ...context, idempotencyKey: "snapshot-overlap" });

    const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
    let recordLookups = 0;
    let stateReads = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const path = url.pathname.replace(/^\/etapi/, "");
      if ((init?.method ?? "GET") === "GET" && path === "/notes"
        && url.searchParams.get("search") === '#courseOsDraftRecordPageId="page-1"') {
        recordLookups += 1;
      }
      if ((init?.method ?? "GET") === "GET" && path === `/notes/${stateNoteId}/content`) stateReads += 1;
      return remote.fetch(input, init);
    };
    const reopened = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    await expect(reopened.getDraftSnapshotByPage("page-1")).resolves.toMatchObject({ pageId: "page-1", revision: 1 });
    expect(recordLookups).toBe(1);
    expect(stateReads).toBe(0);
  });

  it("reconciles a native block edit from a cold page record, writes its revision, and preserves the full-state cache", async () => {
    const remote = new FakeEtapi();
    const setup = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const release = releaseWithPage();
    await setup.publishRelease(release, { ...manifest, courseReleaseId: release.id }, context);
    const initial = await setup.saveDraft(draftFor(release), 0, { ...context, idempotencyKey: "native-edit-return-initial" });
    const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const pageRecordNoteId = remote.noteIdByTitle("Course OS draft record · page-1");
    let stateReads = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if ((init?.method ?? "GET") === "GET" && url.pathname === `/etapi/notes/${stateNoteId}/content`) stateReads += 1;
      return remote.fetch(input, init);
    };
    const cold = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    remote.editByTitle("核心解释", "Native editor edit survives return");
    const reconciled = await withReadBudget({ timeoutMs: 8_000 }, () => cold.getDraftByPage("page-1"));
    expect(reconciled).toMatchObject({
      revision: initial.revision + 1,
      page: { blocks: expect.arrayContaining([expect.objectContaining({ id: "block-1", markdown: "Native editor edit survives return" })]) }
    });
    expect(stateReads).toBe(0);
    expect(remote.requests.some(request => request.method === "PUT" && request.path === `/notes/${pageRecordNoteId}/content`)).toBe(true);

    const restarted = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    await expect(restarted.getDraftSnapshotByPage("page-1")).resolves.toMatchObject({
      revision: initial.revision + 1,
      page: { blocks: expect.arrayContaining([expect.objectContaining({ id: "block-1", markdown: "Native editor edit survives return" })]) }
    });
    expect(stateReads).toBe(0);

    const cacheGuard = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    await expect(cacheGuard.listCourses()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: release.courseId })]));
    remote.editByTitle("核心解释", "Second native edit with full state cached");
    await expect(cacheGuard.getDraftByPage("page-1")).resolves.toMatchObject({ revision: initial.revision + 2 });
    await expect(cacheGuard.listCourses()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: release.courseId })]));
  });

  it("reconciles one external page edit without a redundant full-state clone and keeps page metadata", async () => {
    const remote = new FakeEtapi();
    const writer = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const pageRelease = releaseWithPage();
    await writer.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const cost = costEntryFor(pageRelease, "page-1-reconcile-cost");
    const saved = await writer.saveDraftWithCost(draftFor(pageRelease), 0, { ...context, idempotencyKey: "page-1-reconcile-save" }, cost);
    const stale = structuredClone(saved);
    stale.page.blocks[0]!.markdown = "stale local change";
    await expect(writer.saveDraft(stale, 0, { ...context, idempotencyKey: "page-1-reconcile-conflict" }))
      .rejects.toThrow("READWEAVE_REVISION_CONFLICT:");

    const index = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
      drafts: LessonDraft[];
      costEntries: GenerationCostEntry[];
      conflicts: Array<{ id: string; objectId: string; status: string }>;
      idempotency: Record<string, { kind: string; objectId: string }>;
      researchArchives: unknown[];
      [key: string]: unknown;
    };
    index.drafts.push(...Array.from({ length: 24 }, (_, i) => ({
      ...structuredClone(saved), id: `unrelated-draft-${i}`, pageId: `unrelated-page-${i}`
    })));
    index.costEntries.push(...Array.from({ length: 96 }, (_, i) => ({
      ...cost, id: `unrelated-cost-${i}`, pageId: `unrelated-page-${i}`
    })));
    index.conflicts.push(...Array.from({ length: 48 }, (_, i) => ({ id: `unrelated-conflict-${i}`, objectId: `unrelated-page-${i}`, status: "open" })));
    for (let i = 0; i < 512; i += 1) index.idempotency[`unrelated-key-${i}`] = { kind: "attempt", objectId: `unrelated-attempt-${i}` };
    index.researchArchives = [{ id: "large-unrelated-archive", title: "unrelated", content: "unrelated archived content ".repeat(80_000) }];
    remote.editByTitle("00 Course OS 结构化索引", encodeReadWeaveStateContent(index));
    remote.editByTitle("核心解释", "ReadWeave 外部编辑后的内容");

    const reader = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const nativeClone = globalThis.structuredClone;
    let wholeStateClones = 0;
    const cloneSpy = vi.spyOn(globalThis, "structuredClone").mockImplementation(((value: unknown, options?: StructuredSerializeOptions) => {
      if (value && typeof value === "object" && "projections" in value && "drafts" in value && "courses" in value) wholeStateClones += 1;
      return nativeClone(value, options);
    }) as typeof structuredClone);
    try {
      await expect(reader.getDraftByPage("page-1")).resolves.toMatchObject({
        revision: saved.revision + 1,
        page: { blocks: [expect.objectContaining({ id: "block-1", markdown: "ReadWeave 外部编辑后的内容" })] }
      });
      // Both reconciliation and its cache commit must avoid whole-state clones.
      expect(wholeStateClones).toBe(0);
    } finally {
      cloneSpy.mockRestore();
    }

    const pageRecord = decodeReadWeaveStateContent(remote.contentByTitle("Course OS draft record · page-1")) as {
      costEntries: GenerationCostEntry[];
      conflicts: Array<{ id: string; objectId: string; status: string }>;
      idempotency: Record<string, { kind: string; objectId: string }>;
    };
    expect(pageRecord.costEntries).toEqual([cost]);
    expect(pageRecord.conflicts).toHaveLength(1);
    expect(pageRecord.conflicts[0]).toMatchObject({ objectId: "page-1", status: "open" });
    expect(Object.values(pageRecord.idempotency)).toContainEqual({ kind: "draft", objectId: saved.id });
    expect(Object.values(pageRecord.idempotency)).toContainEqual({ kind: "cost_entry", objectId: cost.id });
    const cachedDrafts = await reader.listDrafts();
    expect(cachedDrafts).toHaveLength(25);
    expect(cachedDrafts.find((item) => item.pageId === "page-1")).toMatchObject({ revision: saved.revision + 1 });
    expect(await reader.listCostEntries()).toHaveLength(97);
    expect(await reader.listConflicts()).toHaveLength(49);
  });

  it("lists conflicts from the reference and hydrated page records without copying full state or reading activity", async () => {
    const remote = new FakeEtapi();
    const writer = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const release = releaseWithPage();
    await writer.publishRelease(release, { ...manifest, courseReleaseId: release.id }, context);
    const saved = await writer.saveDraft(draftFor(release), 0, { ...context, idempotencyKey: "list-conflicts-initial" });
    const stalePage = structuredClone(saved.page);
    stalePage.blocks[0]!.markdown = "stale conflict content";
    await expect(writer.saveDraft({ ...saved, page: stalePage }, 0, { ...context, idempotencyKey: "list-conflicts-stale" }))
      .rejects.toThrow("READWEAVE_REVISION_CONFLICT:");

    const pageRecord = decodeReadWeaveStateContent(remote.contentByTitle("Course OS draft record · page-1")) as {
      conflicts: CourseConflict[];
      [key: string]: unknown;
    };
    const pageConflict = pageRecord.conflicts[0]!;
    const resolvedPageConflict: CourseConflict = {
      ...pageConflict,
      status: "resolved",
      resolution: "merged",
      resolvedAt: "2026-10-05T19:00:00.000Z"
    };
    pageRecord.conflicts = [resolvedPageConflict];
    remote.editByTitle("Course OS draft record · page-1", encodeReadWeaveStateContent(pageRecord));

    const legacyOpenConflict: CourseConflict = {
      ...pageConflict,
      status: "open",
      resolution: undefined,
      resolvedAt: undefined,
      localContent: "older legacy conflict content"
    };
    const legacyOnlyConflict: CourseConflict = {
      ...pageConflict,
      id: "legacy-only-conflict",
      objectId: release.id,
      objectType: "release",
      status: "open",
      resolution: undefined,
      resolvedAt: undefined
    };
    const index = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
      conflicts: CourseConflict[];
      [key: string]: unknown;
    };
    index.conflicts = [...index.conflicts.filter((conflict) => conflict.id !== pageConflict.id), legacyOpenConflict, legacyOnlyConflict];
    remote.editByTitle("00 Course OS 结构化索引", encodeReadWeaveStateContent(index));

    const reader = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const internals = reader as unknown as {
      readActivityReference: (noteId?: string, requireFresh?: boolean) => Promise<unknown>;
      findActivityStateNoteId: () => Promise<string | undefined>;
      mergeDraftPageRecord: (state: unknown, record: unknown) => void;
      draftPageRecordCache: Map<string, { record: { conflicts: CourseConflict[] } }>;
    };
    const activityRead = vi.spyOn(internals, "readActivityReference");
    const activityLookup = vi.spyOn(internals, "findActivityStateNoteId");
    const fullMerge = vi.spyOn(internals, "mergeDraftPageRecord");
    const nativeClone = globalThis.structuredClone;
    const cloneInputs: unknown[] = [];
    const cloneSpy = vi.spyOn(globalThis, "structuredClone").mockImplementation(((value: unknown, options?: StructuredSerializeOptions) => {
      cloneInputs.push(value);
      return nativeClone(value, options);
    }) as typeof structuredClone);
    try {
      const conflicts = await reader.listConflicts();
      expect(conflicts).toEqual([resolvedPageConflict, legacyOnlyConflict]);
      expect(conflicts[0]).toMatchObject({
        status: "resolved",
        resolution: "merged",
        resolvedAt: resolvedPageConflict.resolvedAt,
        baseContent: pageConflict.baseContent,
        localContent: pageConflict.localContent,
        remoteContent: pageConflict.remoteContent
      });
      expect(internals.draftPageRecordCache.has("page-1")).toBe(true);
      expect(activityRead).not.toHaveBeenCalled();
      expect(activityLookup).not.toHaveBeenCalled();
      expect(fullMerge).not.toHaveBeenCalled();
      const nonTemplateClones = cloneInputs.filter((value) => value !== EMPTY_STATE);
      expect(nonTemplateClones).toHaveLength(1);
      expect(nonTemplateClones[0]).toEqual(conflicts);
      expect(conflicts[0]).not.toBe(internals.draftPageRecordCache.get("page-1")!.record.conflicts[0]);

      conflicts[0]!.localContent = "caller mutation";
      expect(internals.draftPageRecordCache.get("page-1")!.record.conflicts[0]!.localContent).toBe(pageConflict.localContent);
    } finally {
      cloneSpy.mockRestore();
    }
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

  it("resumes exact legacy section serialization after a partial write and still rejects a real section edit", async () => {
    const remote = new FakeEtapi();
    let blockLegacyRewrite = false;
    const blockedNoteIds = new Set<string>();
    const blockedWrites = new Set<string>();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/etapi/, "");
      const contentMatch = /^\/notes\/([^/]+)\/content$/.exec(path);
      const noteId = contentMatch ? decodeURIComponent(contentMatch[1]!) : undefined;
      if (blockLegacyRewrite && init?.method === "PUT" && noteId && blockedNoteIds.has(noteId)) {
        blockedWrites.add(noteId);
        return new Response("simulated interruption during section projection", { status: 409 });
      }
      return remote.fetch(input, init);
    };
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const original = draftFor(pageRelease);
    original.page.lessonFlowVersion = 2;
    original.page.lessonSections = [
      ["prior_knowledge", "先验知识"], ["learning_objectives", "学习目标"], ["full_explanation", "完整讲解"],
      ["main_content", "主要内容"], ["misconceptions", "易错点"]
    ].map(([kind, title]) => ({
      id: `section-${kind}`,
      kind: kind as "prior_knowledge" | "learning_objectives" | "full_explanation" | "main_content" | "misconceptions",
      title: title!,
      markdown: `## ${title}\n旧正文中的 A < B 条件`,
      sourceAnchorIds: [],
      atomIds: []
    }));
    original.page.questionBank = [
      { id: "q1", pageId: "page-1", objectiveId: "objective-1", kind: "comprehension", prompt: "问题一？", expectedAnswer: "答案一", explanation: "解释一", sourceAnchorIds: [], status: "approved", version: 1, generatedBy: "test" },
      { id: "q2", pageId: "page-1", objectiveId: "objective-1", kind: "comprehension", prompt: "问题二？", expectedAnswer: "答案二", explanation: "解释二", sourceAnchorIds: [], status: "approved", version: 1, generatedBy: "test" }
    ];
    const saved = await api.saveDraft(original, 0, { ...context, idempotencyKey: "legacy-section-base" });
    const next = structuredClone(saved);
    next.page.questionBank![1]!.status = "retired";
    next.page.lessonSections = next.page.lessonSections!.map((section) => ({ ...section, markdown: section.markdown!.replace("旧正文", "本次新正文") }));
    const render = api as unknown as {
      renderPageOverview(draft: typeof next): string;
      renderSectionOverview(draft: typeof next, key: "prerequisites" | "objectives" | "explanation" | "main" | "misconceptions" | "assessment"): string;
    };
    const previousMarkdown = (kind: string) => saved.page.lessonSections!.find((section) => section.kind === kind)!.markdown!;
    const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    const legacyPre = (markdown: string) => `<pre>${escapeHtml(markdown)}</pre>`;

    // These two sections were already PUT with the proposal target; the others still have the exact old serializer.
    remote.editByTitle("01 先验知识", render.renderSectionOverview(next, "prerequisites"));
    remote.editByTitle("02 学习目标", render.renderSectionOverview(next, "objectives"));
    remote.editByTitle("03 完整讲解", legacyPre(previousMarkdown("full_explanation")));
    remote.editByTitle("04 主要内容", legacyPre(previousMarkdown("main_content")));
    remote.editByTitle("05 易错点", legacyPre(previousMarkdown("misconceptions")));
    remote.editByTitle("06 随机问题", "<p>正式题库共 2 题，每次学习抽取两题并保存种子、顺序和作答记录</p><ol><li><strong>理解题</strong> 问题一？<details><summary>审核答案</summary><p>答案一</p><p>解释一</p></details></li><li><strong>理解题</strong> 问题二？<details><summary>审核答案</summary><p>答案二</p><p>解释二</p></details></li></ol>");
    for (const title of ["03 完整讲解", "04 主要内容", "05 易错点", "06 随机问题"]) blockedNoteIds.add(remote.noteIdByTitle(title));

    blockLegacyRewrite = true;
    await expect(api.saveDraft(next, 1, { ...context, idempotencyKey: "legacy-section-interrupted" })).rejects.toThrow("READWEAVE_ETAPI_409");
    expect(blockedWrites.size).toBeGreaterThan(0);
    expect(remote.contentByTitle("第 001 页 · 测试页面")).toBe(render.renderPageOverview(next));
    expect(remote.contentByTitle("01 先验知识")).toBe(render.renderSectionOverview(next, "prerequisites"));
    expect(remote.contentByTitle("03 完整讲解")).toBe(legacyPre(previousMarkdown("full_explanation")));

    blockLegacyRewrite = false;
    const recovered = await api.saveDraft(next, 1, { ...context, idempotencyKey: "legacy-section-resumed" });
    expect(recovered.revision).toBe(2);
    for (const [title, key] of [
      ["03 完整讲解", "explanation"], ["04 主要内容", "main"], ["05 易错点", "misconceptions"], ["06 随机问题", "assessment"]
    ] as const) expect(remote.contentByTitle(title)).toBe(render.renderSectionOverview(next, key));
    expect(remote.contentByTitle("06 随机问题")).toContain("默认每次学习抽取 3 题，可选 2、3 或 5 题");
    expect(remote.contentByTitle("06 随机问题")).not.toContain("每次学习抽取两题");
    expect(remote.contentByTitle("06 随机问题")).toContain("正式题库共 1 题");
    expect(remote.contentByTitle("06 随机问题")).not.toContain("问题二？");
    expect(recovered.page.questionBank).toHaveLength(2);
    expect(recovered.page.questionBank![1]!.status).toBe("retired");

    const externallyEdited = structuredClone(recovered);
    externallyEdited.page.lessonSections = externallyEdited.page.lessonSections!.map((section) => section.kind === "main_content"
      ? { ...section, markdown: `${section.markdown}\n再次修订` }
      : section);
    const externalEdit = legacyPre(recovered.page.lessonSections!.find((section) => section.kind === "main_content")!.markdown!)
      .replace("</pre>", "\n课程教师追加的真实编辑</pre>");
    const mainNoteId = remote.noteIdByTitle("04 主要内容");
    remote.editByTitle("04 主要内容", externalEdit);
    const writesBeforeExternalEdit = remote.contentWriteCount(mainNoteId);
    await expect(api.saveDraft(externallyEdited, 2, { ...context, idempotencyKey: "legacy-section-real-edit" })).rejects.toThrow("READWEAVE_DRAFT_SECTION_CONFLICT");
    expect(remote.contentByTitle("04 主要内容")).toBe(externalEdit);
    expect(remote.contentWriteCount(mainNoteId)).toBe(writesBeforeExternalEdit);
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

  it("does not preserve ready or replace a section when the legacy or multi-block mapping is ambiguous", async () => {
    for (const scenario of ["legacy", "ambiguous"] as const) {
      const remote = new FakeEtapi();
      const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
      const pageRelease = releaseWithPage();
      const page = pageRelease.pages[0]!;
      if (scenario === "ambiguous") {
        page.lessonFlowVersion = 2;
        page.lessonSections = [{ id: "section-main", kind: "main_content", title: "主要内容", markdown: "多个 block 的合并内容", items: [{ id: "retained-item", text: "保留条目", sourceAnchorIds: [] }], sourceAnchorIds: [], atomIds: [] }];
        page.blocks.push({ id: "block-2", title: "第二个核心解释", kind: "core", markdown: "第二个原始块", sourceAnchorIds: [], atomIds: [] });
      }
      const draft = draftFor(pageRelease);
      draft.status = "ready";
      await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
      const saved = await api.saveDraft(draft, 0, { ...context, idempotencyKey: `external-block-${scenario}-base` });
      await api.getDraftByPage("page-1");
      const originalSection = structuredClone(page.lessonSections?.[0]);
      remote.editByTitle("核心解释", "外部修改但映射不唯一的块");

      const reconciled = await api.getDraftByPage("page-1");
      expect(reconciled).toMatchObject({ revision: saved.revision + 1, status: "editing" });
      if (scenario === "legacy") {
        expect(reconciled!.page.lessonSections).toBeUndefined();
      } else {
        expect(reconciled!.page.lessonSections?.[0]).toEqual(originalSection);
      }
    }
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

  it("saves pages without cloning whole state and preserves old snapshots across interleaved commits", async () => {
    const remote = new FakeEtapi();
    let blocked!: () => void;
    const firstBlocked = new Promise<void>(resolve => { blocked = resolve; });
    let release!: () => void;
    const firstGate = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await remote.fetch(input, init);
      if (init?.method === "POST" && new URL(String(input)).pathname.endsWith("/create-note")
        && JSON.parse(String(init.body)).title === "Course OS draft record · page-1") {
        blocked();
        await firstGate;
      }
      return response;
    };
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl };
    const api = new EtapiReadWeaveCourseApi(config);
    const source = releaseWithPage();
    source.pages.push({ ...structuredClone(source.pages[0]!), id: "page-2", pageNumber: 2, title: "second copy-on-write page" });
    source.pageIds.push("page-2");
    await api.registerDraftSource(source, context);
    const before = Reflect.get(api, "stateCache").state;
    const unrelated = draftFor(source);
    unrelated.id = "draft:unrelated-heavy";
    unrelated.pageId = "unrelated-heavy";
    unrelated.page = { ...unrelated.page, id: unrelated.pageId, blocks: [{ ...unrelated.page.blocks[0]!, markdown: "synthetic unrelated body ".repeat(100000) }] };
    before.drafts.push(unrelated);
    before.idempotency["unrelated-receipt"] = { kind: "attempt", objectId: "unrelated-attempt" };
    const beforeText = JSON.stringify(before);
    Object.freeze(before.drafts);
    Object.freeze(before.idempotency);
    Object.freeze(before.projections.drafts);
    const nativeClone = globalThis.structuredClone;
    const clone = vi.spyOn(globalThis, "structuredClone").mockImplementation((value, options) => {
      if (value === before || (Array.isArray(value) && value.includes(unrelated))
        || (value !== null && typeof value === "object" && "drafts" in value
          && Array.isArray(value.drafts) && value.drafts.includes(unrelated))) throw new Error("WHOLE_STATE_CLONE_FORBIDDEN");
      return nativeClone(value, options);
    });
    const first = draftFor(source);
    first.page.blocks[0]!.markdown = "synthetic first saved page";
    const second = draftFor(source, "page-2");
    second.page.blocks[0]!.markdown = "synthetic second saved page";
    const firstCost = costEntryFor(source, "copy-first-cost");
    const secondCost = { ...costEntryFor(source, "copy-second-cost"), pageId: "page-2" };
    const firstContext = { ...context, idempotencyKey: "copy-first-save" };
    let firstSave: Promise<LessonDraft> | undefined;
    try {
      firstSave = api.saveDraftWithCost(first, 0, firstContext, firstCost);
      await firstBlocked;
      await expect(api.saveDraftWithCost(second, 0, { ...context, idempotencyKey: "copy-second-save" }, secondCost))
        .resolves.toMatchObject({ pageId: "page-2", revision: 1 });
      const intermediate = Reflect.get(api, "stateCache").state;
      const intermediateText = JSON.stringify(intermediate);
      release();
      const saved = await firstSave;
      expect(saved).toMatchObject({ pageId: "page-1", revision: 1 });
      const after = Reflect.get(api, "stateCache").state;
      expect(JSON.stringify(before)).toBe(beforeText);
      expect(JSON.stringify(intermediate)).toBe(intermediateText);
      expect(after.drafts.find((item: LessonDraft) => item.pageId === unrelated.pageId)).toBe(unrelated);
      expect(after.releases).toBe(before.releases);
      expect(after.questionAttempts).toBe(before.questionAttempts);
      expect(after.idempotency["unrelated-receipt"]).toEqual(before.idempotency["unrelated-receipt"]);
      expect(after.drafts.filter((item: LessonDraft) => source.pageIds.includes(item.pageId)).map((item: LessonDraft) => item.revision)).toEqual([1, 1]);
      const writes = remote.requests.filter(item => item.method !== "GET").length;
      await expect(api.saveDraftWithCost(first, 0, firstContext, firstCost)).resolves.toEqual(saved);
      expect(remote.requests.filter(item => item.method !== "GET")).toHaveLength(writes);
    } finally {
      release();
      await firstSave?.catch(() => undefined);
      clone.mockRestore();
    }
    const reopened = new EtapiReadWeaveCourseApi({ ...config, fetchImpl: remote.fetch });
    await expect(reopened.getDraftSnapshotByPage("page-1")).resolves.toMatchObject({ revision: 1, page: { blocks: [{ markdown: first.page.blocks[0]!.markdown }] } });
    await expect(reopened.getDraftSnapshotByPage("page-2")).resolves.toMatchObject({ revision: 1, page: { blocks: [{ markdown: second.page.blocks[0]!.markdown }] } });
    expect((await reopened.listCostEntries({ materialVersionId: source.id })).map(item => item.id).sort()).toEqual([firstCost.id, secondCost.id].sort());
  });

  it("preserves a newer same-page record observed while an older write readback is in flight", async () => {
    const remote = new FakeEtapi();
    let recordId = "";
    let armed = false;
    let written = false;
    let blocked!: () => void;
    const readbackBlocked = new Promise<void>(resolve => { blocked = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const response = await remote.fetch(input, init);
      if (armed && url.pathname.endsWith(`/notes/${recordId}/content`)) {
        if (init?.method === "PUT") written = true;
        else if (written && (init?.method ?? "GET") === "GET") {
          armed = false;
          blocked();
          await gate;
        }
      }
      return response;
    };
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl };
    const api = new EtapiReadWeaveCourseApi(config);
    const source = releaseWithPage();
    await api.registerDraftSource(source, context);
    await api.saveDraft(draftFor(source), 0, { ...context, idempotencyKey: "newer-record-initial" });
    recordId = remote.noteIdByTitle("Course OS draft record · page-1");
    armed = true;
    const olderSave = api.saveDraft(draftFor(source), 1, { ...context, idempotencyKey: "newer-record-older-write" });
    try {
      await readbackBlocked;
      const newer = decodeReadWeaveStateContent(remote.contentByTitle("Course OS draft record · page-1")) as {
        draft: LessonDraft; idempotency: Record<string, { kind: string; objectId: string }>;
      };
      newer.draft.revision = 3;
      newer.draft.page.blocks[0]!.markdown = "synthetic newer authoritative record";
      newer.draft.contentHash = createHash("sha256").update(JSON.stringify(newer.draft.page)).digest("hex");
      newer.idempotency["newer-authority-receipt"] = { kind: "draft", objectId: newer.draft.id };
      remote.editByTitle("Course OS draft record · page-1", encodeReadWeaveStateContent(newer));
      await (api as unknown as { findDraftPageRecord(pageId: string): Promise<unknown> }).findDraftPageRecord("page-1");
      const beforeCommit = Reflect.get(api, "stateCache").state;
      const beforeCommitText = JSON.stringify(beforeCommit);
      release();
      await expect(olderSave).resolves.toMatchObject({ revision: 2 });
      expect(JSON.stringify(beforeCommit)).toBe(beforeCommitText);
      const after = Reflect.get(api, "stateCache").state;
      expect(after.drafts.find((item: LessonDraft) => item.pageId === "page-1")).toMatchObject({ revision: 3, contentHash: newer.draft.contentHash });
      expect(after.idempotency["newer-authority-receipt"]).toEqual(newer.idempotency["newer-authority-receipt"]);
      await expect(api.getDraftSnapshotByPage("page-1")).resolves.toMatchObject({ revision: 3 });
      await expect(new EtapiReadWeaveCourseApi({ ...config, fetchImpl: remote.fetch }).getDraftSnapshotByPage("page-1"))
        .resolves.toMatchObject({ revision: 3 });
    } finally { release(); await olderSave.catch(() => undefined); }
  });

  it.each(["pageId", "revision", "contentHash", "pageHash"] as const)("rejects page-record readback with mismatched %s and preserves the durable receipt", async (field) => {
    const remote = new FakeEtapi();
    let recordId = "";
    let corruptReadback = true;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const response = await remote.fetch(input, init);
      if (init?.method === "POST" && url.pathname.endsWith("/create-note")
        && JSON.parse(String(init.body)).title === "Course OS draft record · page-1") {
        recordId = ((await response.clone().json()) as { note: { noteId: string } }).note.noteId;
      } else if (recordId && corruptReadback && (init?.method ?? "GET") === "GET" && url.pathname.endsWith(`/notes/${recordId}/content`)) {
        const record = decodeReadWeaveStateContent(await response.text()) as { pageId: string; draft: LessonDraft };
        if (field === "pageId") record.pageId = "wrong-page";
        else if (field === "revision") record.draft.revision += 1;
        else if (field === "contentHash") record.draft.contentHash = "wrong-hash";
        else record.draft.page.title = "wrong-page-content";
        return new Response(encodeReadWeaveStateContent(record), { status: 200 });
      }
      return response;
    };
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl };
    const api = new EtapiReadWeaveCourseApi(config);
    const source = releaseWithPage();
    await api.registerDraftSource(source, context);
    await expect(api.saveDraft(draftFor(source), 0, { ...context, idempotencyKey: `strict-readback-${field}` }))
      .rejects.toThrow("READWEAVE_DRAFT_RECORD_READBACK_FAILED");
    corruptReadback = false;
    await expect(new EtapiReadWeaveCourseApi(config).getDraftSnapshotByPage("page-1")).resolves.toMatchObject({ revision: 1 });
    expect(remote.countActiveNotesByTitle("Course OS draft record · page-1")).toBe(1);
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

  it("stores course metadata in one small authority while preserving page records and rejecting stale root writes", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const bootstrap = new EtapiReadWeaveCourseApi(config);
    await bootstrap.listCourses();

    const published = releaseWithPage();
    await bootstrap.publishRelease(published, { ...manifest, courseReleaseId: published.id }, context);
    const savedDraft = await bootstrap.saveDraft(draftFor(published), 0, { ...context, idempotencyKey: "metadata-page-record" });
    const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const legacyCourse: CourseProject = {
      id: "legacy-metadata-course", workspaceId: "personal", title: "迁移前课程", status: "active",
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z"
    };
    const legacyNode: CourseTreeNode = {
      id: "legacy-metadata-node", kind: "module", title: "旧目录", parentId: legacyCourse.id,
      revision: 4, status: "draft", archived: false, children: []
    };
    const legacy = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
      courses: CourseProject[];
      treeNodes: CourseTreeNode[];
      idempotency: Record<string, { kind: string; objectId: string }>;
      projections: { drafts: Record<string, unknown> };
    };
    legacy.courses.push(legacyCourse);
    legacy.treeNodes.push(legacyNode);
    legacy.idempotency["legacy-metadata-idempotency"] = { kind: "course", objectId: legacyCourse.id };
    remote.editByTitle("00 Course OS 结构化索引", encodeReadWeaveStateContent(legacy));

    const staleWriter = new EtapiReadWeaveCourseApi(config);
    const staleState = await (staleWriter as unknown as { readStateReference(fresh: boolean, activity: boolean): Promise<unknown> }).readStateReference(true, false);
    const api = new EtapiReadWeaveCourseApi(config);
    const migration = await api.ensureMetadataIndex();
    expect(migration).toMatchObject({ status: "active", noteId: remote.noteIdByTitle("Course OS Metadata Index · personal") });

    const splitRoot = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
      courses: CourseProject[];
      treeNodes: CourseTreeNode[];
      projections: { metadataIndexNoteId?: string; metadataIndexRevision?: number; drafts: Record<string, unknown> };
      idempotency: Record<string, { kind: string }>;
    };
    expect(splitRoot.courses).toEqual([]);
    expect(splitRoot.treeNodes).toEqual([]);
    expect(splitRoot.projections.metadataIndexNoteId).toBe(migration.noteId);
    expect(splitRoot.projections.drafts).toEqual(legacy.projections.drafts);
    expect(splitRoot.idempotency["legacy-metadata-idempotency"]).toBeUndefined();
    expect(remote.countNotesByLabel("courseOsType", "metadata_index")).toBe(1);

    const stateWritesAfterMigration = remote.contentWriteCount(stateNoteId);
    const rootReadsAfterMigration = remote.requests.filter((request) => request.method === "GET" && request.path === `/notes/${stateNoteId}/content`).length;
    const addedCourse: CourseProject = {
      id: "small-metadata-course", workspaceId: "personal", title: "小索引课程", status: "active",
      createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z"
    };
    await api.createCourse(addedCourse, { ...context, idempotencyKey: "small-metadata-course-create" });
    expect(remote.contentWriteCount(stateNoteId)).toBe(stateWritesAfterMigration);
    expect(remote.requests.filter((request) => request.method === "GET" && request.path === `/notes/${stateNoteId}/content`)).toHaveLength(rootReadsAfterMigration);
    await expect((staleWriter as unknown as { writeState(state: unknown): Promise<void> }).writeState(staleState))
      .rejects.toThrow("READWEAVE_METADATA_MIGRATION_IN_PROGRESS");
    expect(remote.contentWriteCount(stateNoteId)).toBe(stateWritesAfterMigration);

    const reopened = new EtapiReadWeaveCourseApi(config);
    await expect(reopened.listCourses()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: legacyCourse.id }), expect.objectContaining({ id: addedCourse.id })
    ]));
    await expect(reopened.getDraftSnapshotByPage(savedDraft.pageId)).resolves.toMatchObject({ revision: savedDraft.revision });
    await expect(reopened.getTrashCapabilities()).resolves.toEqual({
      directPermanentDelete: false, requiresNativeUi: true, canConfirmNativeErase: false, reason: "READWEAVE_NATIVE_ERASE_REQUIRED"
    });
  });

  it("creates a course after restart from active metadata without loading the large core", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const setup = new EtapiReadWeaveCourseApi(config);
    const release = releaseWithPage();
    await setup.publishRelease(release, { ...manifest, courseReleaseId: release.id }, context);
    await setup.ensureMetadataIndex();
    const coreId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const before = remote.requests.length;
    const cold = new EtapiReadWeaveCourseApi(config);
    const course: CourseProject = { id: "cold-metadata-course", workspaceId: "personal", title: "Cold metadata course", status: "active",
      createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" };
    const write = { ...context, idempotencyKey: "cold-metadata-create" };
    const saved = await cold.createCourse(course, write);
    expect(saved.id).toBe(course.id);
    expect(saved.readweaveNoteId).toBeTruthy();
    await expect(cold.createCourse(course, write)).resolves.toEqual(saved);
    expect(remote.requests.slice(before).filter(request => request.path === `/notes/${coreId}/content`)).toEqual([]);
    expect((await cold.listCourses()).filter(item => item.id === course.id)).toHaveLength(1);
    const restarted = new EtapiReadWeaveCourseApi(config);
    await expect(restarted.createCourse(course, write)).resolves.toEqual(saved);
    await expect(restarted.getRelease(release.id)).resolves.toMatchObject({ id: release.id });
  });

  it("fresh-reads changed metadata after TTL expiry and renews the cache before the next metadata write", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const setup = new EtapiReadWeaveCourseApi(config);
    const release = releaseWithPage();
    await setup.publishRelease(release, { ...manifest, courseReleaseId: release.id }, context);
    await setup.ensureMetadataIndex();

    const reader = new EtapiReadWeaveCourseApi(config);
    await expect(reader.listTrash()).resolves.toEqual([]);
    (reader as any).metadataIndexCache.expiresAt = Date.now() - 1;
    const trashed = await setup.trashTreeNode(release.courseId, { ...context, idempotencyKey: "expired-metadata-trash" });
    const coreId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const before = remote.requests.length;

    await expect(reader.listTrash()).resolves.toEqual([expect.objectContaining({ id: trashed.id, nodeId: release.courseId })]);
    expect(remote.requests.slice(before).filter(request => request.path === "/notes")).toEqual([]);
    expect((reader as any).metadataIndexCache.expiresAt).toBeGreaterThan(Date.now());
    const course: CourseProject = { id: "post-expiry-metadata-write", workspaceId: "personal", title: "Post-expiry metadata write", status: "active",
      createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" };
    await expect(reader.createCourse(course, { ...context, idempotencyKey: "post-expiry-metadata-write" })).resolves.toMatchObject({ id: course.id });
    expect(remote.requests.slice(before).filter(request => request.path === `/notes/${coreId}/content`)).toEqual([]);
  });

  it.each(["workspaceId", "stateNoteId", "courseRootNoteId", "migrationId"] as const)(
    "rejects and clears a cached locator when its %s binding changes",
    async (binding) => {
      const remote = new FakeEtapi();
      const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
      const setup = new EtapiReadWeaveCourseApi(config);
      await setup.ensureMetadataIndex();
      const reader = new EtapiReadWeaveCourseApi(config);
      await reader.listTrash();
      const metadataId = remote.noteIdByTitle("Course OS Metadata Index · personal");
      const index = decodeReadWeaveStateContent(remote.contentByTitle("Course OS Metadata Index · personal")) as any;
      if (binding === "workspaceId") index.workspaceId = "other-workspace";
      else if (binding === "stateNoteId") index.stateNoteId = "different-state";
      else if (binding === "courseRootNoteId") index.projections.courseRootNoteId = "different-course-root";
      else index.migration.id = "different-migration";
      remote.replaceNoteContent(metadataId, encodeReadWeaveStateContent(index));
      const before = remote.requests.length;

      const expected = binding === "workspaceId" ? "READWEAVE_METADATA_INDEX_WORKSPACE_MISMATCH" : "READWEAVE_METADATA_INDEX_SOURCE_MISMATCH";
      await expect(reader.listTrash()).rejects.toThrow(expected);
      expect((reader as any).metadataIndexCache).toBeUndefined();
      expect(remote.requests.slice(before).filter(request => request.path === "/notes")).toEqual([]);
    }
  );

  it.each([false, true])("rediscovers a 404 metadata locator and checks the replacement binding (changed: %s)", async (changeBinding) => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const setup = new EtapiReadWeaveCourseApi(config);
    await setup.ensureMetadataIndex();
    const reader = new EtapiReadWeaveCourseApi(config);
    await reader.listTrash();
    const originalId = remote.noteIdByTitle("Course OS Metadata Index · personal");
    const replacementId = remote.addNoteCopy(originalId, "root");
    if (changeBinding) {
      const replacement = decodeReadWeaveStateContent(remote.contentByTitle("Course OS Metadata Index · personal")) as any;
      replacement.migration.id = "replacement-migration";
      remote.replaceNoteContent(replacementId, encodeReadWeaveStateContent(replacement));
    }
    remote.eraseNativeNotes([originalId]);
    const before = remote.requests.length;

    if (changeBinding) {
      await expect(reader.listTrash()).rejects.toThrow("READWEAVE_METADATA_INDEX_SOURCE_MISMATCH");
      expect((reader as any).metadataIndexCache).toBeUndefined();
    } else {
      await expect(reader.listTrash()).resolves.toEqual([]);
      expect((reader as any).metadataIndexCache.noteId).toBe(replacementId);
    }
    expect(remote.requests.slice(before).filter(request => request.path === "/notes")).toHaveLength(1);
  });

  it("rejects cold duplicate metadata indexes without writing", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const setup = new EtapiReadWeaveCourseApi(config);
    await setup.ensureMetadataIndex();
    const activeId = remote.noteIdByTitle("Course OS Metadata Index · personal");
    remote.addNoteCopy(activeId, "root");
    const cold = new EtapiReadWeaveCourseApi(config);
    const before = remote.requests.length;

    await expect(cold.listTrash()).rejects.toThrow("READWEAVE_METADATA_INDEX_DUPLICATE");
    expect(remote.requests.slice(before).filter(request => request.method !== "GET")).toEqual([]);
  });

  it("does not rediscover a malformed known metadata note and recovers on the next fresh GET", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const setup = new EtapiReadWeaveCourseApi(config);
    await setup.ensureMetadataIndex();
    const metadataId = remote.noteIdByTitle("Course OS Metadata Index · personal");
    let corruptNextRead = false;
    let contentGets = 0;
    let searches = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if ((init?.method ?? "GET") === "GET" && url.pathname === "/etapi/notes") searches += 1;
      if ((init?.method ?? "GET") === "GET" && url.pathname === `/etapi/notes/${metadataId}/content`) {
        contentGets += 1;
        if (corruptNextRead) {
          corruptNextRead = false;
          return new Response("{ malformed", { status: 200 });
        }
      }
      return remote.fetch(input, init);
    };
    const reader = new EtapiReadWeaveCourseApi({ ...config, fetchImpl });
    await reader.listTrash();
    searches = 0;
    contentGets = 0;
    corruptNextRead = true;

    await expect(reader.listTrash()).rejects.toThrow();
    expect(contentGets).toBe(1);
    expect(searches).toBe(0);
    expect((reader as any).metadataIndexCache.noteId).toBe(metadataId);
    await expect(reader.listTrash()).resolves.toEqual([]);
    expect(contentGets).toBe(2);
    expect(searches).toBe(0);
  });

  it("does not rediscover after a metadata read deadline and retries the known note on the next call", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const setup = new EtapiReadWeaveCourseApi(config);
    await setup.ensureMetadataIndex();
    const metadataId = remote.noteIdByTitle("Course OS Metadata Index · personal");
    let stallNextRead = false;
    let contentGets = 0;
    let searches = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if ((init?.method ?? "GET") === "GET" && url.pathname === "/etapi/notes") searches += 1;
      if ((init?.method ?? "GET") === "GET" && url.pathname === `/etapi/notes/${metadataId}/content`) {
        contentGets += 1;
        if (stallNextRead) {
          stallNextRead = false;
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) { reject(new Error("missing abort signal")); return; }
            const onAbort = () => reject(signal.reason ?? new Error("aborted"));
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
          });
        }
      }
      return remote.fetch(input, init);
    };
    const reader = new EtapiReadWeaveCourseApi({ ...config, fetchImpl });
    await reader.listTrash();
    searches = 0;
    contentGets = 0;
    stallNextRead = true;

    await expect(withReadBudget({ timeoutMs: 100 }, () => reader.listTrash())).rejects.toThrow("READ_DEADLINE_EXCEEDED");
    expect(contentGets).toBe(1);
    expect(searches).toBe(0);
    expect((reader as any).metadataIndexCache.noteId).toBe(metadataId);
    await expect(reader.listTrash()).resolves.toEqual([]);
    expect(contentGets).toBe(2);
    expect(searches).toBe(0);
  });

  it("returns freshly read rolling-back metadata without searching for another locator", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const setup = new EtapiReadWeaveCourseApi(config);
    await setup.ensureMetadataIndex();
    const reader = new EtapiReadWeaveCourseApi(config);
    await reader.listTrash();
    const metadataId = remote.noteIdByTitle("Course OS Metadata Index · personal");
    const index = decodeReadWeaveStateContent(remote.contentByTitle("Course OS Metadata Index · personal")) as any;
    index.status = "rolling_back";
    index.migration.phase = "rolling_back";
    remote.replaceNoteContent(metadataId, encodeReadWeaveStateContent(index));
    const before = remote.requests.length;

    await expect(reader.listTrash()).resolves.toEqual([]);
    expect((reader as any).metadataIndexCache.index.status).toBe("rolling_back");
    expect(remote.requests.slice(before).filter(request => request.path === "/notes")).toEqual([]);
  });

  it.each(["course", "module"])("trashes a mapped %s through metadata without reading, writing, or cloning the large core", async (kind) => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const setup = new EtapiReadWeaveCourseApi(config);
    const release = releaseWithPage();
    await setup.publishRelease(release, { ...manifest, courseReleaseId: release.id }, context);
    const saved = await setup.saveDraft(draftFor(release), 0, { ...context, idempotencyKey: "reading-draft" });
    await setup.ensureMetadataIndex();
    const course: CourseProject = { id: "small-trash-course", workspaceId: "personal", title: "Empty course", status: "active",
      createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z" };
    await setup.createCourse(course, { ...context, idempotencyKey: "small-trash-create" });
    const node = kind === "course" ? course : await setup.createTreeNode({ id: "small-trash-module", kind: "module",
      title: "Empty module", parentId: course.id, revision: 0, children: [] }, { ...context, idempotencyKey: "small-trash-module" });
    const rootId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const core = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as Record<string, unknown>;
    core.researchArchives = [{ id: "large-unrelated-core", content: "preserve reading authorities ".repeat(60_000) }];
    remote.editByTitle("00 Course OS 结构化索引", encodeReadWeaveStateContent(core));
    const reader = new EtapiReadWeaveCourseApi(config);
    await reader.getRelease(release.id);
    await reader.getDraftByPage(saved.pageId);
    const cached = (reader as any).stateCache.state;
    const releases = cached.releases;
    const drafts = cached.drafts;
    const nativeClone = globalThis.structuredClone;
    const cloneSpy = vi.spyOn(globalThis, "structuredClone").mockImplementation((value, options) => {
      if (value === cached || value === drafts || (value as any)?.drafts === drafts) throw new Error("FULL_CORE_CLONE_FOR_TRASH");
      return nativeClone(value, options);
    });
    const before = remote.requests.length;
    try {
      const trashed = await reader.trashTreeNode(node.id, { ...context, idempotencyKey: "small-trash" });
      expect(trashed).toMatchObject({ nodeId: node.id, restoreAvailable: true });
      await expect(reader.listTrash()).resolves.toEqual([expect.objectContaining({ id: trashed.id })]);
      await expect(reader.getRelease(release.id)).resolves.toMatchObject({ id: release.id });
      await expect(reader.getDraftByPage(saved.pageId)).resolves.toMatchObject({ revision: saved.revision });
      expect((reader as any).stateCache.state.releases).toBe(releases);
      expect((reader as any).stateCache.state.drafts).toBe(drafts);
      expect(remote.requests.slice(before).filter(request => request.path === `/notes/${rootId}/content`)).toEqual([]);
      const metadata = decodeReadWeaveStateContent(remote.contentByTitle("Course OS Metadata Index · personal")) as any;
      expect(metadata.trash).toHaveLength(1);
      expect((kind === "course" ? metadata.courses : metadata.treeNodes).find((item: any) => item.id === node.id).revision).toBe(1);
      expect(metadata.idempotency["small-trash"]).toMatchObject({ kind: "trash", objectId: trashed.id });
    } finally { cloneSpy.mockRestore(); }
  });

  it.each(["trash", "preview", "confirm"])("replays a %s metadata commit after a lost response without duplicate writes or core access", async (operation) => {
    const remote = new FakeEtapi();
    let loseReply = false;
    let lostPuts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const response = await remote.fetch(input, init);
      if (loseReply && init?.method === "PUT" && url.pathname === `/etapi/notes/${remote.noteIdByTitle("Course OS Metadata Index · personal")}/content`) {
        lostPuts += 1;
        throw new TypeError("simulated committed response loss");
      }
      return response;
    };
    const verifyNativeErase = vi.fn(async () => true);
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl, verifyNativeErase };
    const api = new EtapiReadWeaveCourseApi(config);
    await api.ensureMetadataIndex();
    const course: CourseProject = { id: "lost-trash-course", workspaceId: "personal", title: "Lost reply", status: "active",
      createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z" };
    await api.createCourse(course, { ...context, idempotencyKey: "lost-trash-create" });
    const writeContext = { ...context, idempotencyKey: `lost-${operation}` };
    let trashed = operation === "trash" ? undefined : await api.trashTreeNode(course.id, { ...context, idempotencyKey: "lost-trash-prepare" });
    const checkExternalReferences = vi.fn(async () => ({ active: false, answers: false }));
    const selector = () => ({ expectedSnapshotHash: trashed!.snapshotHash, expectedRevision: 1, checkExternalReferences });
    if (operation === "confirm") {
      const plan = await api.previewTrashNativeErase(trashed!.id, context, trashed!.deletedAt, selector(), { checkExternalReferences });
      remote.eraseNativeNotes(plan.noteIds);
    }
    const execute = (adapter: EtapiReadWeaveCourseApi) => operation === "trash"
      ? adapter.trashTreeNode(course.id, writeContext)
      : operation === "preview" ? adapter.previewTrashNativeErase(trashed!.id, writeContext, trashed!.deletedAt, selector(), { checkExternalReferences })
        : adapter.permanentlyDeleteTrash(trashed!.id, writeContext, trashed!.deletedAt, selector());
    const rootId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const rootWritesBefore = remote.contentWriteCount(rootId);
    loseReply = true;
    await expect(execute(api)).rejects.toThrow("READWEAVE_ETAPI_NETWORK:");
    loseReply = false;
    expect(lostPuts).toBe(3); // Existing transport retry only.
    const committed = decodeReadWeaveStateContent(remote.contentByTitle("Course OS Metadata Index · personal")) as any;
    trashed ??= committed.trash[0];
    const before = remote.requests.length;
    const reopened = new EtapiReadWeaveCourseApi(config);
    const replay = await execute(reopened);
    if (operation === "trash") expect(replay).toEqual(trashed);
    if (operation === "preview") expect(replay).toMatchObject({ trashId: trashed!.id });
    const after = decodeReadWeaveStateContent(remote.contentByTitle("Course OS Metadata Index · personal")) as any;
    expect(after).toEqual(committed);
    expect(remote.requests.slice(before).filter(request => request.method !== "GET")).toEqual([]);
    expect(remote.contentWriteCount(rootId)).toBe(rootWritesBefore);
    if (operation !== "preview") expect(remote.requests.slice(before).filter(request => request.path === `/notes/${rootId}/content`)).toEqual([]);
    if (operation === "confirm") expect(verifyNativeErase).toHaveBeenCalledTimes(1);
    expect(remote.countNotesByLabel("courseOsType", "trash_root")).toBe(1);
  });

  it("prepares, reopens, and confirms an empty course with metadata writes while preserving unrelated reading authorities", async () => {
    const remote = new FakeEtapi();
    const verifyNativeErase = vi.fn(async () => true);
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch, verifyNativeErase };
    const api = new EtapiReadWeaveCourseApi(config);
    const release = releaseWithPage();
    await api.publishRelease(release, { ...manifest, courseReleaseId: release.id }, context);
    const draft = await api.saveDraft(draftFor(release), 0, { ...context, idempotencyKey: "preserved-draft" });
    await api.ensureMetadataIndex();
    const course: CourseProject = { id: "empty-confirm-course", workspaceId: "personal", title: "Empty confirm", status: "active",
      createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z" };
    await api.createCourse(course, { ...context, idempotencyKey: "empty-confirm-create" });
    const trash = await api.trashTreeNode(course.id, { ...context, idempotencyKey: "empty-confirm-trash" });
    await api.getDraftByPage(draft.pageId);
    const cachedReleases = (api as any).stateCache.state.releases;
    const cachedDrafts = (api as any).stateCache.state.drafts;
    const options = { expectedSnapshotHash: trash.snapshotHash, expectedRevision: 1,
      checkExternalReferences: vi.fn(async () => ({ active: false, answers: false })) };
    const rootId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const metadataId = remote.noteIdByTitle("Course OS Metadata Index · personal");
    const before = remote.requests.length;
    const plan = await api.previewTrashNativeErase(trash.id, context, trash.deletedAt, options, options);
    expect(plan.noteIds).toHaveLength(9);
    const metadataWrites = remote.contentWriteCount(metadataId);
    await expect(api.previewTrashNativeErase(trash.id, context, trash.deletedAt, options, options)).resolves.toEqual(plan);
    expect(remote.contentWriteCount(metadataId)).toBe(metadataWrites);
    expect(options.checkExternalReferences).toHaveBeenCalledTimes(6);
    remote.eraseNativeNotes(plan.noteIds);
    const confirmContext = { ...context, idempotencyKey: "empty-confirm" };
    await api.permanentlyDeleteTrash(trash.id, confirmContext, trash.deletedAt, options);
    expect(remote.requests.slice(before).filter(request => request.path === `/notes/${rootId}/content`)).toEqual([]);
    expect((api as any).stateCache.state.releases).toBe(cachedReleases);
    expect((api as any).stateCache.state.drafts).toBe(cachedDrafts);
    await expect(api.getDraftByPage(draft.pageId)).resolves.toMatchObject({ revision: draft.revision });
    const reopened = new EtapiReadWeaveCourseApi(config);
    const beforeReplay = remote.requests.length;
    await reopened.permanentlyDeleteTrash(trash.id, confirmContext, trash.deletedAt, options);
    await expect(reopened.listTrash()).resolves.toEqual([]);
    await expect(reopened.listCourses()).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: course.id })]));
    expect(remote.requests.slice(beforeReplay).filter(request => request.path === `/notes/${rootId}/content` || request.method !== "GET")).toEqual([]);
    expect(verifyNativeErase).toHaveBeenCalledTimes(1);
    await expect(reopened.getRelease(release.id)).resolves.toMatchObject({ id: release.id });
    await expect(reopened.getDraftByPage(draft.pageId)).resolves.toMatchObject({ revision: draft.revision });
    expect((await (reopened as any).readStateReference(true, false)).courses.some((item: CourseProject) => item.id === course.id)).toBe(false);
  });

  it.each([
    { operation: "preview", protection: "job" }, { operation: "preview", protection: "answers" },
    { operation: "confirm", protection: "job" }, { operation: "confirm", protection: "answers" }
  ])("rejects native erase $operation with known $protection protection before any draft record content GET", async ({ operation, protection }) => {
    const remote = new FakeEtapi();
    const verifyNativeErase = vi.fn(async () => true);
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch, verifyNativeErase };
    const setup = new EtapiReadWeaveCourseApi(config);
    const release = releaseWithPage();
    await setup.publishRelease(release, { ...manifest, courseReleaseId: release.id }, context);
    await setup.saveDraft(draftFor(release), 0, { ...context, idempotencyKey: "early-protection-draft" });
    const trash = await setup.trashTreeNode(release.courseId, { ...context, idempotencyKey: "early-protection-trash" });
    const selector = { expectedSnapshotHash: trash.snapshotHash };
    const plan = await setup.previewTrashNativeErase(trash.id, context, trash.deletedAt, selector,
      { checkExternalReferences: async () => ({ active: false, answers: false }) });
    if (protection === "answers") {
      await new EtapiReadWeaveCourseApi(config).saveQuestionAttempt({ id: "early-protected-answer", sessionId: "session",
        selectionId: "selection", courseReleaseId: release.id, pageId: "page-1", questionId: "question", objectiveId: "objective",
        answer: "saved answer", correct: true, usedHintLevel: 0, attemptedAt: "2026-10-05T00:00:00Z"
      }, { ...context, idempotencyKey: "early-protected-answer-save" });
    }
    const recordId = remote.noteIdByTitle("Course OS draft record · page-1");
    if (operation === "confirm") remote.eraseNativeNotes(plan.noteIds);
    let recordGets = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if ((init?.method ?? "GET") === "GET" && url.pathname === `/etapi/notes/${recordId}/content`) {
        recordGets += 1;
        return new Response("draft content should not be requested for an already protected scope", { status: 400 });
      }
      return remote.fetch(input, init);
    };
    const reader = new EtapiReadWeaveCourseApi({ ...config, fetchImpl });
    const checkExternalReferences = vi.fn(async (_scope: unknown) => ({ active: protection === "job", answers: false }));
    const before = remote.requests.length;
    const request = operation === "preview"
      ? reader.previewTrashNativeErase(trash.id, context, trash.deletedAt, selector, { checkExternalReferences })
      : reader.permanentlyDeleteTrash(trash.id, { ...context, idempotencyKey: "early-protected-confirm" }, trash.deletedAt,
        { ...selector, checkExternalReferences });
    await expect(request).rejects.toThrow(protection === "job" ? "READWEAVE_TRASH_ACTIVITY_PROTECTED" : "READWEAVE_TRASH_ANSWERS_PROTECTED");
    expect(recordGets).toBe(0);
    expect(remote.requests.slice(before).filter(item => item.method !== "GET")).toEqual([]);
    expect(verifyNativeErase).not.toHaveBeenCalled();
    if (protection === "job") expect(checkExternalReferences).toHaveBeenCalledWith(expect.objectContaining({ releaseIds: [release.id], pageIds: ["page-1"] }));
    await expect(reader.listTrash()).resolves.toEqual([expect.objectContaining({ id: trash.id, restoreAvailable: true })]);
  });

  it("scans all independent draft records once on the first native erase preview and stays fresh on reopen", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const setup = new EtapiReadWeaveCourseApi(config);
    const release = releaseWithPage();
    await setup.publishRelease(release, { ...manifest, courseReleaseId: release.id }, context);
    await setup.saveDraft(draftFor(release), 0, { ...context, idempotencyKey: "single-scan-draft" });
    const trash = await setup.trashTreeNode(release.courseId, { ...context, idempotencyKey: "single-scan-trash" });
    const searches: Array<string | null> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === "/etapi/notes" && (init?.method ?? "GET") === "GET") searches.push(url.searchParams.get("search"));
      return remote.fetch(input, init);
    };
    const reader = new EtapiReadWeaveCourseApi({ ...config, fetchImpl });
    const options = { expectedSnapshotHash: trash.snapshotHash,
      checkExternalReferences: async () => ({ active: false, answers: false }) };
    const recordId = remote.noteIdByTitle("Course OS draft record · page-1");
    const checkOneScan = (before: number) => {
      const requests = remote.requests.slice(before);
      expect(searches.filter(search => search === '#courseOsType="draft_record"')).toHaveLength(1);
      expect(searches.filter(search => search === '"Course OS draft record"')).toHaveLength(1);
      expect(requests.filter(request => request.method === "GET" && request.path === `/notes/${recordId}/content`)).toHaveLength(1);
      expect((reader as any).draftPageRecordsHydrated).toBe(false);
    };
    const before = remote.requests.length;
    const plan = await reader.previewTrashNativeErase(trash.id, context, trash.deletedAt, options, options);
    checkOneScan(before);
    expect(plan.noteIds).toContain(recordId);
    const beforeReopen = remote.requests.length;
    searches.length = 0;
    await expect(reader.previewTrashNativeErase(trash.id, context, trash.deletedAt, options, options)).resolves.toEqual(plan);
    checkOneScan(beforeReopen);
  });

  it.each(["new-draft", "answers", "job", "native-clone", "native-child", "revision", "restore"])("rejects reopened native erase links after new %s protection or scope changes", async (change) => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const api = new EtapiReadWeaveCourseApi(config);
    const course: CourseProject = { id: "reopen-protected-course", workspaceId: "personal", title: "Reopen safety", status: "active",
      createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z" };
    await api.createCourse(course, { ...context, idempotencyKey: "reopen-create" });
    const release = { ...releaseWithPage(), courseId: course.id };
    await api.publishRelease(release, { ...manifest, courseReleaseId: release.id }, { ...context, idempotencyKey: "reopen-publish" });
    await api.saveDraft(draftFor(release), 0, { ...context, idempotencyKey: "reopen-draft" });
    const trash = await api.trashTreeNode(course.id, { ...context, idempotencyKey: "reopen-trash" });
    let active = false;
    const checkExternalReferences = vi.fn(async (_scope: unknown) => ({ active, answers: false }));
    const options = { expectedSnapshotHash: trash.snapshotHash, expectedRevision: 1, checkExternalReferences };
    const plan = await api.previewTrashNativeErase(trash.id, context, trash.deletedAt, options, options);
    const metadataId = remote.noteIdByTitle("Course OS Metadata Index · personal");
    if (change === "new-draft") {
      const writer = new EtapiReadWeaveCourseApi(config);
      const draft = draftFor(release);
      draft.id = "draft:independent-after-preflight";
      draft.pageId = "independent-after-preflight";
      draft.page.id = draft.pageId;
      const rootContentBefore = remote.contentByTitle("00 Course OS 结构化索引");
      await writer.saveDraft(draft, 0, { ...context, idempotencyKey: "reopen-new-draft" });
      expect(remote.contentByTitle("00 Course OS 结构化索引")).toBe(rootContentBefore);
      expect((api as any).draftPageRecordCache.has(draft.pageId)).toBe(false);
    } else if (change === "answers") {
      const writer = new EtapiReadWeaveCourseApi(config);
      await writer.saveQuestionAttempt({ id: "new-protected-answer", sessionId: "new-session", selectionId: "new-selection", courseReleaseId: release.id,
        pageId: "page-1", questionId: "question", objectiveId: "objective", answer: "saved response", correct: true,
        usedHintLevel: 0, attemptedAt: "2026-10-04T00:01:00Z" }, { ...context, idempotencyKey: "reopen-new-answer" });
    } else if (change === "job") active = true;
    else if (change === "native-clone") remote.addClone(plan.noteIds[0]!, "root");
    else if (change === "native-child") remote.addChildNote(trash.readweaveNoteId!, "new child after preflight");
    else {
      const metadata = decodeReadWeaveStateContent(remote.contentByTitle("Course OS Metadata Index · personal")) as any;
      metadata.revision += 1;
      const storedCourse = metadata.courses.find((item: CourseProject) => item.id === course.id);
      if (change === "revision") storedCourse.revision += 1;
      else { storedCourse.status = "active"; metadata.trash[0].restoreAvailable = false; }
      remote.editByTitle("Course OS Metadata Index · personal", encodeReadWeaveStateContent(metadata));
    }
    const writes = remote.contentWriteCount(metadataId);
    const expected = { "new-draft": "MAPPING_CHANGED", answers: "ANSWERS_PROTECTED", job: "ACTIVITY_PROTECTED", "native-clone": "SHARED_REFERENCE",
      "native-child": "MAPPING_CHANGED", revision: "TRASH_CHANGED", restore: "NOT_DELETED" }[change]!;
    await expect(api.previewTrashNativeErase(trash.id, context, trash.deletedAt, options, options)).rejects.toThrow(expected);
    expect(remote.contentWriteCount(metadataId)).toBe(writes);
    if (change === "new-draft") expect((api as any).draftPageRecordCache.has("independent-after-preflight")).toBe(true);
    if (change === "job") expect(checkExternalReferences.mock.calls.at(-1)?.[0]).toMatchObject({ releaseIds: [release.id], pageIds: ["page-1"] });
  });

  it("resumes a split after interruption and rolls back by merging current metadata into the live root", async () => {
    const remote = new FakeEtapi();
    let blockActivation = true;
    let metadataNoteId: string | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/create-note") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { title: string };
        if (body.title === "Course OS Metadata Index · personal") {
          const created = await remote.fetch(input, init);
          const result = await created.clone().json() as { note: { noteId: string } };
          metadataNoteId = result.note.noteId;
          return created;
        }
      }
      if (metadataNoteId && url.pathname === `/etapi/notes/${metadataNoteId}/content` && init?.method === "PUT" && blockActivation) {
        const body = Buffer.isBuffer(init.body) ? init.body.toString("utf8") : String(init.body ?? "");
        const candidate = decodeReadWeaveStateContent(body) as { status?: string };
        if (candidate.status === "active") return new Response("simulated activation interruption", { status: 503 });
      }
      return remote.fetch(input, init);
    };
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl };
    const initial = new EtapiReadWeaveCourseApi(config);
    await initial.listCourses();
    const oldCourse: CourseProject = {
      id: "rollback-old-course", workspaceId: "personal", title: "旧课程", status: "active",
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z"
    };
    const state = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
      courses: CourseProject[];
    };
    state.courses.push(oldCourse);
    remote.editByTitle("00 Course OS 结构化索引", encodeReadWeaveStateContent(state));

    await expect(initial.ensureMetadataIndex()).rejects.toThrow();
    const interruptedRoot = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
      courses: CourseProject[];
      projections: { metadataIndexNoteId?: string };
    };
    expect(interruptedRoot.courses).toEqual([]);
    expect(interruptedRoot.projections.metadataIndexNoteId).toBe(metadataNoteId);
    expect((decodeReadWeaveStateContent(remote.contentByTitle("Course OS Metadata Index · personal")) as { status: string }).status).toBe("staged");
    const stagedReader = new EtapiReadWeaveCourseApi(config);
    const stagedMetadataWrites = remote.contentWriteCount(metadataNoteId!);
    await expect(stagedReader.listCourses()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: oldCourse.id })]));
    expect(remote.contentWriteCount(metadataNoteId!)).toBe(stagedMetadataWrites);

    blockActivation = false;
    const restarted = new EtapiReadWeaveCourseApi({ ...config, fetchImpl: remote.fetch });
    await expect(restarted.listCourses()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: oldCourse.id })]));
    await expect(restarted.ensureMetadataIndex()).resolves.toMatchObject({ noteId: metadataNoteId, status: "active" });
    const researchContent = "必须在回滚后保留";
    await restarted.archiveResearch({
      id: "post-split-research", version: 1, title: "分裂后新研究", content: researchContent,
      sha256: createHash("sha256").update(researchContent).digest("hex"),
      byteCount: Buffer.byteLength(researchContent), characterCount: [...researchContent].length, lineCount: 1,
      sourceDate: "2026-09-03", gitPath: "research/post-split.md", immutable: true,
      createdAt: "2026-09-03T00:00:00.000Z"
    }, { ...context, idempotencyKey: "post-split-research" });
    const newCourse: CourseProject = {
      id: "rollback-new-course", workspaceId: "personal", title: "分裂后课程", status: "active",
      createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z"
    };
    await restarted.createCourse(newCourse, { ...context, idempotencyKey: "rollback-new-course" });

    await restarted.prepareMetadataRollback();
    const rolledBackRoot = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
      courses: CourseProject[];
      researchArchives: Array<{ id: string; content: string }>;
      projections: { metadataIndexNoteId?: string; metadataIndexRevision?: number };
    };
    expect(rolledBackRoot.projections.metadataIndexNoteId).toBeUndefined();
    expect(rolledBackRoot.projections.metadataIndexRevision).toBeUndefined();
    expect(rolledBackRoot.courses.map((course) => course.id)).toEqual(expect.arrayContaining([oldCourse.id, newCourse.id]));
    expect(rolledBackRoot.researchArchives).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "post-split-research", content: "必须在回滚后保留" })
    ]));
    expect((decodeReadWeaveStateContent(remote.contentByTitle("Course OS Metadata Index · personal")) as { status: string }).status).toBe("rolled_back");
    const oldImage = new EtapiReadWeaveCourseApi({ ...config, fetchImpl: remote.fetch });
    await expect(oldImage.listCourses()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: oldCourse.id }), expect.objectContaining({ id: newCourse.id })
    ]));
    await expect(oldImage.searchResearch("必须在回滚后保留")).resolves.toEqual([
      expect.objectContaining({ archiveId: "post-split-research" })
    ]);
  });

  it("migrates a missing legacy material row and keeps its first rename, move, and archive on the metadata authority", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const setup = new EtapiReadWeaveCourseApi(config);
    const release: CourseRelease = {
      ...releaseWithPage(), id: "legacy-derived-release", courseId: "legacy-derived-course",
      moduleId: "legacy-derived-module", moduleTitle: "迁移前材料"
    };
    await setup.publishRelease(release, { ...manifest, courseReleaseId: release.id }, context);

    const stateNoteId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const materialId = `material:${release.courseId}:${release.moduleId}`;
    const legacy = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
      treeNodes: CourseTreeNode[];
      projections: {
        courses: Record<string, { modules: Record<string, string> }>;
        materialReleaseSelections?: Record<string, { releaseId: string; source: "derived" | "explicit" }>;
      };
    };
    const projectedNoteId = legacy.projections.courses[release.courseId]?.modules[release.moduleId];
    expect(projectedNoteId).toBeTruthy();
    legacy.treeNodes = legacy.treeNodes.filter((node) => node.kind !== "material" || (node.materialId || node.id) !== materialId);
    delete legacy.projections.materialReleaseSelections?.[materialId];
    remote.editByTitle("00 Course OS 结构化索引", encodeReadWeaveStateContent(legacy));

    const api = new EtapiReadWeaveCourseApi(config);
    const migrated = await api.ensureMetadataIndex();
    const migratedIndex = decodeReadWeaveStateContent(remote.contentByTitle("Course OS Metadata Index · personal")) as {
      treeNodes: CourseTreeNode[];
    };
    expect(migratedIndex.treeNodes.find((node) => node.id === materialId)).toMatchObject({
      id: materialId,
      kind: "material",
      currentReleaseId: release.id,
      currentReleaseSelection: "derived",
      readweaveNoteId: projectedNoteId
    });

    const target: CourseProject = {
      id: "legacy-derived-target", workspaceId: "personal", title: "目标课程", status: "active",
      createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z"
    };
    await api.createCourse(target, { ...context, idempotencyKey: "legacy-derived-target" });
    const rootContentPath = `/notes/${stateNoteId}/content`;
    const rootReads = () => remote.requests.filter((request) => request.method === "GET" && request.path === rootContentPath).length;
    const rootReadsBefore = rootReads();
    const rootWrites = remote.contentWriteCount(stateNoteId);
    const metadataWrites = remote.contentWriteCount(migrated.noteId);
    const listed = (await api.listTreeNodes()).find((node) => node.id === materialId)!;
    expect(listed.currentReleaseSelection).toBe("derived");
    await api.listCourses();
    await api.listTrash();
    const renamed = await api.updateTreeNode(materialId, { title: "材料改名" }, listed.revision ?? 0,
      { ...context, idempotencyKey: "legacy-derived-rename" });
    const moved = await api.updateTreeNode(materialId, { parentId: target.id }, renamed.revision ?? 0,
      { ...context, idempotencyKey: "legacy-derived-move" });
    await api.updateTreeNode(materialId, { archived: true }, moved.revision ?? 0,
      { ...context, idempotencyKey: "legacy-derived-archive" });

    expect(rootReads()).toBe(rootReadsBefore);
    expect(remote.contentWriteCount(stateNoteId)).toBe(rootWrites);
    expect(remote.contentWriteCount(migrated.noteId)).toBeGreaterThan(metadataWrites);
    await expect(api.getTreeNodeMetadata(materialId)).resolves.toMatchObject({
      workspaceId: "personal",
      node: { id: materialId, archived: true, currentReleaseSelection: "derived", readweaveNoteId: projectedNoteId }
    });
  });

  it("keeps a migrated explicit material pin while a derived material advances to its newly readable draft", async () => {
    const remote = new FakeEtapi();
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const setup = new EtapiReadWeaveCourseApi(config);
    const explicitBase: CourseRelease = {
      ...releaseWithPage(), id: "selection-explicit-base", courseId: "selection-explicit-course",
      moduleId: "pinned-module", moduleTitle: "固定材料", pageIds: ["selection-explicit-base-page"],
      pages: [{ ...releaseWithPage().pages[0]!, id: "selection-explicit-base-page" }]
    };
    const derivedBase: CourseRelease = {
      ...releaseWithPage(), id: "selection-derived-base", courseId: "selection-derived-course",
      moduleId: "derived-module", moduleTitle: "默认材料", pageIds: ["selection-derived-base-page"],
      pages: [{ ...releaseWithPage().pages[0]!, id: "selection-derived-base-page" }]
    };
    await setup.publishRelease(explicitBase, { ...manifest, courseReleaseId: explicitBase.id }, { ...context, idempotencyKey: "publish-explicit-base" });
    await setup.publishRelease(derivedBase, { ...manifest, courseReleaseId: derivedBase.id }, { ...context, idempotencyKey: "publish-derived-base" });

    const explicitMaterialId = `material:${explicitBase.courseId}:${explicitBase.moduleId}`;
    const derivedMaterialId = `material:${derivedBase.courseId}:${derivedBase.moduleId}`;
    const legacy = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as {
      treeNodes: CourseTreeNode[];
      projections: { materialReleaseSelections?: Record<string, { releaseId: string; source: "derived" | "explicit" }> };
    };
    const pinned = legacy.treeNodes.find((node) => node.kind === "material" && node.id === explicitMaterialId)!;
    pinned.currentReleaseId = explicitBase.id;
    pinned.releaseId = explicitBase.id;
    legacy.projections.materialReleaseSelections = {
      [explicitMaterialId]: { releaseId: explicitBase.id, source: "explicit" }
    };
    legacy.treeNodes = legacy.treeNodes.filter((node) => node.kind !== "material" || node.id !== derivedMaterialId);
    remote.editByTitle("00 Course OS 结构化索引", encodeReadWeaveStateContent(legacy));

    const api = new EtapiReadWeaveCourseApi(config);
    await api.ensureMetadataIndex();
    const migrated = await api.listTreeNodes();
    expect(migrated.find((node) => node.id === explicitMaterialId)).toMatchObject({
      currentReleaseId: explicitBase.id,
      currentReleaseSelection: "explicit"
    });
    expect(migrated.find((node) => node.id === derivedMaterialId)).toMatchObject({
      currentReleaseId: derivedBase.id,
      currentReleaseSelection: "derived"
    });

    const candidateFor = (base: CourseRelease, id: string, pageId: string): CourseRelease => ({
      ...base,
      id,
      version: base.version + 1,
      lifecycle: "draft_source",
      pageIds: [pageId],
      pages: [{ ...base.pages[0]!, id: pageId }]
    });
    const explicitCandidate = candidateFor(explicitBase, "selection-explicit-candidate", "selection-explicit-candidate-page");
    const derivedCandidate = candidateFor(derivedBase, "selection-derived-candidate", "selection-derived-candidate-page");
    await api.registerDraftSource(explicitCandidate, { ...context, idempotencyKey: "register-explicit-candidate" });
    await api.saveDraft({ ...draftFor(explicitCandidate), status: "ready" }, 0, { ...context, idempotencyKey: "save-explicit-candidate" });
    await api.registerDraftSource(derivedCandidate, { ...context, idempotencyKey: "register-derived-candidate" });
    await api.saveDraft({ ...draftFor(derivedCandidate), status: "ready" }, 0, { ...context, idempotencyKey: "save-derived-candidate" });

    const projected = await api.listTreeNodes();
    expect(projected.find((node) => node.id === explicitMaterialId)).toMatchObject({
      currentReleaseId: explicitBase.id,
      currentReleaseSelection: "explicit"
    });
    expect(projected.find((node) => node.id === derivedMaterialId)).toMatchObject({
      currentReleaseId: derivedCandidate.id,
      currentReleaseSelection: "derived"
    });
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
    const hydrateAllDrafts = vi.spyOn(api as any, "hydrateDraftPageRecords");
    const link = await api.getDeepLink(created.readweaveNoteId!);
    expect(link).toEqual(expect.objectContaining({ host: "readweave.example.com", verified: true, url: `https://readweave.example.com/#root/${created.readweaveNoteId}` }));
    expect(hydrateAllDrafts).not.toHaveBeenCalled();
    await expect(api.permanentlyDeleteTrash(trashed.id, { ...context, idempotencyKey: "tree-permanent-delete" })).rejects.toThrow("READWEAVE_PERMANENT_DELETE_UNSUPPORTED");
  });

  it("freezes native erase mappings before UI action and confirms from the saved plan after every note is gone", async () => {
    const remote = new FakeEtapi();
    const verifyNativeErase = vi.fn(async () => true);
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", publicUrl: "https://notes.example.test", fetchImpl: remote.fetch, verifyNativeErase };
    const api = new EtapiReadWeaveCourseApi(config);
    const course: CourseProject = {
      id: "native-erase-course", workspaceId: "personal", title: "Native erase test", status: "active",
      createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z"
    };
    await api.createCourse(course, { ...context, idempotencyKey: "native-erase-course-create" });
    const pageRelease = { ...releaseWithPage(), id: "native-erase-release", courseId: course.id, courseTitle: course.title };
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, { ...context, idempotencyKey: "native-erase-release-publish" });
    await api.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "native-erase-draft-save" });
    const trashed = await api.trashTreeNode(course.id, { ...context, idempotencyKey: "native-erase-trash" });
    const legacyChildId = remote.addChildNote(trashed.readweaveNoteId!, "历史非当前 block placeholder");
    const selector = { expectedSnapshotHash: trashed.snapshotHash, expectedRevision: 1 };
    const plan = await api.previewTrashNativeErase!(trashed.id, context, trashed.deletedAt, selector, {
      checkExternalReferences: async () => ({ active: false, answers: false })
    });
    const draftRecordId = remote.noteIdForTitle("Course OS draft record · page-1");
    const releaseNoteId = (await (api as any).readStateReference(true, false)).projections.releases[pageRelease.id] as string;
    expect(plan.rootNoteIds).toEqual([trashed.readweaveNoteId, draftRecordId].sort());
    expect(plan.rootNoteIds).not.toContain(releaseNoteId);
    expect(plan.noteIds).toContain(legacyChildId);
    expect(plan.rootNoteIds).not.toContain(legacyChildId);
    expect(plan.branches).toContainEqual(expect.objectContaining({ noteId: legacyChildId, parentNoteId: trashed.readweaveNoteId }));
    let ancestor = releaseNoteId;
    const branchParents = new Map(plan.branches?.map(branch => [branch.noteId, branch.parentNoteId]));
    const seenAncestors = new Set<string>();
    while (ancestor !== trashed.readweaveNoteId && !seenAncestors.has(ancestor)) {
      seenAncestors.add(ancestor);
      ancestor = branchParents.get(ancestor)!;
      if (!ancestor) break;
    }
    expect(ancestor).toBe(trashed.readweaveNoteId);
    expect(plan.rootNoteIds).toContain(draftRecordId);
    expect(plan.nativeLinks.find(link => link.noteId === draftRecordId)).toMatchObject({
      url: `https://notes.example.test/#root/${draftRecordId}`,
      title: "Course OS draft record · page-1"
    });
    expect(Object.keys(plan.rootBranchIds ?? {})).toEqual(plan.rootNoteIds);

    remote.eraseNativeNotes(plan.noteIds);
    const confirmContext = { ...context, idempotencyKey: "native-erase-confirm" };
    await api.permanentlyDeleteTrash(trashed.id, confirmContext, trashed.deletedAt, {
      ...selector, checkExternalReferences: async () => ({ active: false, answers: false })
    });
    expect(verifyNativeErase).toHaveBeenCalledTimes(1);
    expect(verifyNativeErase).toHaveBeenCalledWith(expect.objectContaining({
      trashId: trashed.id, snapshotHash: trashed.snapshotHash, noteIds: plan.noteIds, rootBranchIds: plan.rootBranchIds
    }));
    await expect(api.listTrash()).resolves.toEqual([]);
    await expect(api.getDraftSnapshotByPage("page-1")).resolves.toBeUndefined();

    const reopened = new EtapiReadWeaveCourseApi(config);
    await expect(reopened.listTrash()).resolves.toEqual([]);
    await expect(reopened.getDraftSnapshotByPage("page-1")).resolves.toBeUndefined();
    await reopened.permanentlyDeleteTrash(trashed.id, confirmContext, trashed.deletedAt, {
      ...selector, checkExternalReferences: async () => ({ active: false, answers: false })
    });
    expect(verifyNativeErase).toHaveBeenCalledTimes(1);
    expect(await reopened.listCourses()).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: course.id })]));
  });

  it("starts queued draft record reads as workers free while preserving search order and newest revisions", async () => {
    const remote = new FakeEtapi();
    const pages = [
      { pageId: "page-0", revision: 1 },
      ...Array.from({ length: 7 }, (_, index) => ({ pageId: `page-${index + 1}`, revision: 1 })),
      { pageId: "page-0", revision: 2 },
      { pageId: "page-8", revision: 1 }
    ];
    const noteIds = pages.map(({ pageId, revision }, index) => {
      const title = `Course OS draft record · ${pageId} candidate ${index}`;
      const noteId = remote.addChildNote("root", title);
      remote.editByTitle(title, encodeReadWeaveStateContent({
        pageId,
        draft: { pageId, revision },
        projection: { sectionNoteIds: { assessment: "" } }
      }));
      return noteId;
    });
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>(resolve => { releaseSlow = resolve; });
    let markSlowStarted!: () => void;
    const slowStarted = new Promise<void>(resolve => { markSlowStarted = resolve; });
    let active = 0;
    let maximumActive = 0;
    let slowCompleted = false;
    let queuedHasStarted = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const contentMatch = /^\/etapi\/notes\/([^/]+)\/content$/.exec(url.pathname);
      if ((init?.method ?? "GET") === "GET" && contentMatch) {
        const noteId = contentMatch[1]!;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (noteId === noteIds[0]) {
            markSlowStarted();
            await slowGate;
            slowCompleted = true;
          }
          if (noteId === noteIds[8]) {
            queuedHasStarted = true;
          }
          return await remote.fetch(input, init);
        } finally {
          active -= 1;
        }
      }
      return remote.fetch(input, init);
    };
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl });
    const scan = (api as any).readDraftPageRecords() as Promise<Array<{ record: { pageId: string; draft: { revision: number } } }>>;
    try {
      await slowStarted;
      await vi.waitFor(() => {
        expect(queuedHasStarted).toBe(true);
        expect(slowCompleted).toBe(false);
      }, { timeout: 1_000 });
    } finally {
      releaseSlow();
    }
    const records = await scan;
    expect(maximumActive).toBe(8);
    expect(records.map(({ record }) => [record.pageId, record.draft.revision])).toEqual([
      ["page-0", 2], ["page-1", 1], ["page-2", 1], ["page-3", 1], ["page-4", 1],
      ["page-5", 1], ["page-6", 1], ["page-7", 1], ["page-8", 1]
    ]);
  });

  it("prepares and confirms native erase for a draft-only source without a published release note", async () => {
    const remote = new FakeEtapi();
    const verifyNativeErase = vi.fn(async () => true);
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch, verifyNativeErase };
    const api = new EtapiReadWeaveCourseApi(config);
    const source = { ...releaseWithPage(), id: "native-erase-draft-only", lifecycle: "draft_source" as const };
    await api.registerDraftSource(source, { ...context, idempotencyKey: "draft-only-register" });
    const saved = await api.saveDraft(draftFor(source), 0, { ...context, idempotencyKey: "draft-only-save" });
    await api.ensureMetadataIndex();
    const materialId = `material:${source.courseId}:${source.moduleId}`;
    const trashed = await api.trashTreeNode(materialId, { ...context, idempotencyKey: "draft-only-trash" });
    const options = { expectedSnapshotHash: trashed.snapshotHash,
      checkExternalReferences: vi.fn(async () => ({ active: false, answers: false })) };
    const state = await (api as any).readStateReference(true, false);
    expect(state.projections.releases[source.id]).toBeUndefined();
    expect(state.manifests.some((item: ReleaseManifest) => item.courseReleaseId === source.id)).toBe(false);
    const plan = await api.previewTrashNativeErase(trashed.id, context, trashed.deletedAt, options, options);
    const recordId = remote.noteIdForTitle(`Course OS draft record · ${saved.pageId}`);
    expect(plan.rootNoteIds).toEqual([trashed.readweaveNoteId, recordId].sort());
    expect(plan.noteIds).toContain(saved.readweaveNoteId);
    expect(plan.noteIds).toContain(recordId);
    expect(options.checkExternalReferences).toHaveBeenCalledWith(expect.objectContaining({ releaseIds: [source.id], pageIds: [saved.pageId] }));
    const reopenedPreview = new EtapiReadWeaveCourseApi(config);
    await expect(reopenedPreview.previewTrashNativeErase(trashed.id, context, trashed.deletedAt, options, options)).resolves.toEqual(plan);
    remote.eraseNativeNotes(plan.noteIds);
    const confirmContext = { ...context, idempotencyKey: "draft-only-confirm" };
    await new EtapiReadWeaveCourseApi(config).permanentlyDeleteTrash(trashed.id, confirmContext, trashed.deletedAt, options);
    const reopened = new EtapiReadWeaveCourseApi(config);
    await expect(reopened.listTrash()).resolves.toEqual([]);
    await expect(reopened.getRelease(source.id)).resolves.toBeUndefined();
    await expect(reopened.getDraftSnapshotByPage(saved.pageId)).resolves.toBeUndefined();
    expect((await reopened.listCourses()).some(course => course.id === source.courseId)).toBe(true);
    await reopened.permanentlyDeleteTrash(trashed.id, confirmContext, trashed.deletedAt, options);
    expect(verifyNativeErase).toHaveBeenCalledTimes(1);
  });

  it("prepares and confirms native erase for a mapped legacy core draft with no independent record", async () => {
    const remote = new FakeEtapi();
    const verifyNativeErase = vi.fn(async () => true);
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch, verifyNativeErase };
    const api = new EtapiReadWeaveCourseApi(config);
    const source = { ...releaseWithPage(), lifecycle: "draft_source" as const };
    await api.registerDraftSource(source, { ...context, idempotencyKey: "legacy-native-source" });
    const saved = await api.saveDraft(draftFor(source), 0, { ...context, idempotencyKey: "legacy-native-draft" });
    await api.ensureMetadataIndex();
    const recordTitle = `Course OS draft record · ${saved.pageId}`;
    const recordId = remote.noteIdByTitle(recordTitle);
    const record = decodeReadWeaveStateContent(remote.contentByTitle(recordTitle)) as any;
    const core = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as any;
    core.drafts = [saved];
    core.projections.drafts[saved.id] = record.projection;
    remote.editByTitle("00 Course OS 结构化索引", encodeReadWeaveStateContent(core));
    remote.eraseNativeNotes([recordId]);
    const trashed = await api.trashTreeNode(`material:${source.courseId}:${source.moduleId}`, { ...context, idempotencyKey: "legacy-native-trash" });
    const options = { expectedSnapshotHash: trashed.snapshotHash, checkExternalReferences: async () => ({ active: false, answers: false }) };
    const scan = vi.spyOn(api as any, "readDraftPageRecords");
    const headers = vi.spyOn(api as any, "searchDraftRecordLabel");
    const plan = await api.previewTrashNativeErase(trashed.id, context, trashed.deletedAt, options, options);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith();
    expect(headers).toHaveBeenCalledWith("root", "courseOsDraftRecordPageId", saved.pageId);
    expect((api as any).draftPageRecordCache.has(saved.pageId)).toBe(false);
    expect(plan.noteIds).toContain(saved.readweaveNoteId);
    expect(plan.noteIds).not.toContain(recordId);
    expect(plan.rootNoteIds).toEqual([trashed.readweaveNoteId]);
    await expect(new EtapiReadWeaveCourseApi(config).previewTrashNativeErase(trashed.id, context, trashed.deletedAt, options, options)).resolves.toEqual(plan);
    remote.eraseNativeNotes(plan.noteIds);
    const confirmContext = { ...context, idempotencyKey: "legacy-native-confirm" };
    await new EtapiReadWeaveCourseApi(config).permanentlyDeleteTrash(trashed.id, confirmContext, trashed.deletedAt, options);
    const reopened = new EtapiReadWeaveCourseApi(config);
    await expect(reopened.listTrash()).resolves.toEqual([]);
    await expect(reopened.getRelease(source.id)).resolves.toBeUndefined();
    await expect(reopened.getDraftSnapshotByPage(saved.pageId)).resolves.toBeUndefined();
    await reopened.permanentlyDeleteTrash(trashed.id, confirmContext, trashed.deletedAt, options);
    expect(verifyNativeErase).toHaveBeenCalledTimes(1);
  });

  it.each(["malformed-record", "label-only-record", "missing-projection", "foreign-clone", "search-error"])("rejects native erase legacy absence with %s", async (failure) => {
    const remote = new FakeEtapi();
    const verifyNativeErase = vi.fn(async () => true);
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch, verifyNativeErase };
    const api = new EtapiReadWeaveCourseApi(config);
    const source = { ...releaseWithPage(), lifecycle: "draft_source" as const };
    await api.registerDraftSource(source, { ...context, idempotencyKey: "legacy-unsafe-source" });
    const saved = await api.saveDraft(draftFor(source), 0, { ...context, idempotencyKey: "legacy-unsafe-draft" });
    await api.ensureMetadataIndex();
    const recordTitle = `Course OS draft record · ${saved.pageId}`;
    const recordId = remote.noteIdByTitle(recordTitle);
    const record = decodeReadWeaveStateContent(remote.contentByTitle(recordTitle)) as any;
    const core = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as any;
    core.drafts = [saved];
    core.projections.drafts[saved.id] = record.projection;
    if (failure === "missing-projection") delete core.projections.drafts[saved.id];
    remote.editByTitle("00 Course OS 结构化索引", encodeReadWeaveStateContent(core));
    if (failure === "malformed-record" || failure === "label-only-record") {
      delete record.projection;
      remote.editByTitle(recordTitle, encodeReadWeaveStateContent(record));
      if (failure === "label-only-record") await remote.fetch(`http://readweave/notes/${recordId}`, {
        method: "PATCH", body: JSON.stringify({ title: "Renamed malformed record" })
      });
    } else remote.eraseNativeNotes([recordId]);
    if (failure === "foreign-clone") remote.addClone(saved.readweaveNoteId!, "root");
    const trashed = await api.trashTreeNode(`material:${source.courseId}:${source.moduleId}`, { ...context, idempotencyKey: "legacy-unsafe-trash" });
    // Warm old cache must not turn a skipped malformed record into absence.
    const previewApi = failure === "malformed-record" || failure === "label-only-record" ? api : new EtapiReadWeaveCourseApi({ ...config,
      fetchImpl: async (input, init) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (failure === "search-error" && url.pathname === "/etapi/notes"
          && url.searchParams.get("search") === `"${recordTitle}"`) return new Response("search unavailable", { status: 400 });
        return remote.fetch(input, init);
      }
    });
    const metadataBefore = remote.contentByTitle("Course OS Metadata Index · personal");
    const preview = previewApi.previewTrashNativeErase(trashed.id, context, trashed.deletedAt, { expectedSnapshotHash: trashed.snapshotHash }, {
      checkExternalReferences: async () => ({ active: false, answers: false })
    });
    if (failure === "search-error") await expect(preview).rejects.toThrow();
    else await expect(preview).rejects.toThrow(failure === "foreign-clone" ? "READWEAVE_TRASH_SHARED_REFERENCE" : "READWEAVE_NATIVE_ERASE_MAPPING_INCOMPLETE");
    expect(verifyNativeErase).not.toHaveBeenCalled();
    expect(remote.contentByTitle("Course OS Metadata Index · personal")).toBe(metadataBefore);
    await expect(previewApi.listTrash()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: trashed.id })]));
  });

  it.each(["published", "draft_source"] as const)("rejects native erase when a %s release with a manifest has lost its note mapping", async (lifecycle) => {
    const remote = new FakeEtapi();
    const verifyNativeErase = vi.fn(async () => true);
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch, verifyNativeErase };
    const api = new EtapiReadWeaveCourseApi(config);
    const source = releaseWithPage();
    await api.publishRelease(source, { ...manifest, courseReleaseId: source.id }, context);
    await api.saveDraft(draftFor(source), 0, { ...context, idempotencyKey: "missing-release-draft" });
    await api.ensureMetadataIndex();
    const trashed = await api.trashTreeNode(`material:${source.courseId}:${source.moduleId}`, { ...context, idempotencyKey: "missing-release-trash" });
    const state = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as any;
    delete state.projections.releases[source.id];
    state.releases.find((release: CourseRelease) => release.id === source.id).lifecycle = lifecycle;
    expect(state.manifests.some((item: ReleaseManifest) => item.courseReleaseId === source.id)).toBe(true);
    remote.editByTitle("00 Course OS 结构化索引", encodeReadWeaveStateContent(state));
    const reopened = new EtapiReadWeaveCourseApi(config);
    const before = remote.requests.length;
    await expect(reopened.previewTrashNativeErase(trashed.id, context, trashed.deletedAt, { expectedSnapshotHash: trashed.snapshotHash }, {
      checkExternalReferences: async () => ({ active: false, answers: false })
    })).rejects.toThrow("READWEAVE_NATIVE_ERASE_MAPPING_INCOMPLETE");
    expect(verifyNativeErase).not.toHaveBeenCalled();
    expect(remote.requests.slice(before).every(request => request.method === "GET")).toBe(true);
    await expect(reopened.listTrash()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: trashed.id })]));
  });

  it("rejects 404-only and negative native erase evidence without pruning Course OS state", async () => {
    const remote = new FakeEtapi();
    const verifyNativeErase = vi.fn(async () => false);
    const config = { baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch, verifyNativeErase };
    const api = new EtapiReadWeaveCourseApi(config);
    const course: CourseProject = {
      id: "native-erase-negative", workspaceId: "personal", title: "Negative evidence", status: "active",
      createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z"
    };
    await api.createCourse(course, { ...context, idempotencyKey: "native-erase-negative-create" });
    const trashed = await api.trashTreeNode(course.id, { ...context, idempotencyKey: "native-erase-negative-trash" });
    const selector = { expectedSnapshotHash: trashed.snapshotHash, expectedRevision: 1 };
    const plan = await api.previewTrashNativeErase!(trashed.id, context, trashed.deletedAt, selector,
      { checkExternalReferences: async () => ({ active: false, answers: false }) });
    remote.eraseNativeNotes(plan.noteIds);
    await expect(api.permanentlyDeleteTrash(trashed.id, { ...context, idempotencyKey: "native-erase-negative-confirm" }, trashed.deletedAt, {
      ...selector, checkExternalReferences: async () => ({ active: false, answers: false })
    }))
      .rejects.toThrow("READWEAVE_NATIVE_ERASE_UNVERIFIED");
    expect(verifyNativeErase).toHaveBeenCalledTimes(1);
    await expect(api.listTrash()).resolves.toEqual([expect.objectContaining({ id: trashed.id, restoreAvailable: true })]);
  });

  it("requires ETAPI 404 corroboration for every frozen note after affirmative log evidence", async () => {
    const remote = new FakeEtapi();
    const verifyNativeErase = vi.fn(async () => true);
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch, verifyNativeErase });
    const course: CourseProject = {
      id: "native-erase-live-note", workspaceId: "personal", title: "Live note check", status: "active",
      createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z"
    };
    await api.createCourse(course, { ...context, idempotencyKey: "native-erase-live-create" });
    const trashed = await api.trashTreeNode(course.id, { ...context, idempotencyKey: "native-erase-live-trash" });
    const selector = { expectedSnapshotHash: trashed.snapshotHash, expectedRevision: 1 };
    const plan = await api.previewTrashNativeErase!(trashed.id, context, trashed.deletedAt, selector,
      { checkExternalReferences: async () => ({ active: false, answers: false }) });
    remote.eraseNativeNotes(plan.noteIds);
    remote.restoreNativeNote(plan.noteIds[0]!);
    await expect(api.permanentlyDeleteTrash(trashed.id, { ...context, idempotencyKey: "native-erase-live-confirm" }, trashed.deletedAt, {
      ...selector, checkExternalReferences: async () => ({ active: false, answers: false })
    })).rejects.toThrow("READWEAVE_NATIVE_ERASE_READBACK_FAILED");
    await expect(api.listTrash()).resolves.toEqual([expect.objectContaining({ id: trashed.id, restoreAvailable: true })]);
  });

  it("fails native erase preflight when a mapped note has a clone outside the trash scope", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const course: CourseProject = {
      id: "native-erase-clone", workspaceId: "personal", title: "Clone protection", status: "active",
      createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z"
    };
    await api.createCourse(course, { ...context, idempotencyKey: "native-erase-clone-create" });
    const trashed = await api.trashTreeNode(course.id, { ...context, idempotencyKey: "native-erase-clone-trash" });
    remote.addClone(trashed.readweaveNoteId!, "root");
    await expect(api.previewTrashNativeErase!(trashed.id, context, trashed.deletedAt, { expectedSnapshotHash: trashed.snapshotHash }, {
      checkExternalReferences: async () => ({ active: false, answers: false })
    })).rejects.toThrow("READWEAVE_TRASH_SHARED_REFERENCE");
  });

  it("finds a clone attached to a historical child note and refuses to omit it", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch });
    const course: CourseProject = {
      id: "native-erase-child-clone", workspaceId: "personal", title: "Historical child clone", status: "active",
      createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z"
    };
    await api.createCourse(course, { ...context, idempotencyKey: "native-erase-child-clone-create" });
    const trashed = await api.trashTreeNode(course.id, { ...context, idempotencyKey: "native-erase-child-clone-trash" });
    const oldChild = remote.addChildNote(trashed.readweaveNoteId!, "Historical section placeholder");
    remote.addClone(oldChild, "root");
    await expect(api.previewTrashNativeErase!(trashed.id, context, trashed.deletedAt, { expectedSnapshotHash: trashed.snapshotHash }, {
      checkExternalReferences: async () => ({ active: false, answers: false })
    })).rejects.toThrow("READWEAVE_TRASH_SHARED_REFERENCE");
  });

  it("allows a scoped release root to remain attached to its live course release container", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch,
      verifyNativeErase: async () => true });
    const course: CourseProject = {
      id: "native-erase-release-parent", workspaceId: "personal", title: "Release parent scope", status: "active",
      createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z"
    };
    await api.createCourse(course, { ...context, idempotencyKey: "native-erase-release-parent-course" });
    const release = { ...releaseWithPage(), id: "native-erase-release-child", courseId: course.id, courseTitle: course.title,
      moduleId: "native-erase-release-module", moduleTitle: "Module" };
    await api.publishRelease(release, { ...manifest, id: "native-erase-release-child-manifest", courseReleaseId: release.id },
      { ...context, idempotencyKey: "native-erase-release-child-publish" });
    await api.saveDraft(draftFor(release), 0, { ...context, idempotencyKey: "native-erase-release-child-draft" });
    const material = (await api.listTreeNodes()).find(node => node.kind === "material");
    expect(material).toBeDefined();
    const trashed = await api.trashTreeNode(material!.id, { ...context, idempotencyKey: "native-erase-release-module-trash" });
    const plan = await api.previewTrashNativeErase!(trashed.id, context, trashed.deletedAt, { expectedSnapshotHash: trashed.snapshotHash }, {
      checkExternalReferences: async () => ({ active: false, answers: false })
    });
    const state = await (api as any).readStateReference(true, false);
    const releaseNoteId = state.projections.releases[release.id] as string;
    const releaseRootBranch = plan.branches?.find(branch => branch.noteId === releaseNoteId);
    expect(plan.rootNoteIds).toContain(releaseNoteId);
    expect(releaseRootBranch?.parentNoteId).toBeTruthy();
    expect(plan.noteIds).not.toContain(releaseRootBranch?.parentNoteId);
    remote.eraseNativeNotes(plan.noteIds);
    await api.permanentlyDeleteTrash(trashed.id, { ...context, idempotencyKey: "native-erase-release-parent-confirm" }, trashed.deletedAt, {
      expectedSnapshotHash: trashed.snapshotHash,
      checkExternalReferences: async () => ({ active: false, answers: false })
    });
  });

  it("keeps saved-answer scopes in trash when native erase preflight is requested", async () => {
    const remote = new FakeEtapi();
    const verifyNativeErase = vi.fn(async () => true);
    const api = new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch, verifyNativeErase });
    const course: CourseProject = {
      id: "native-erase-answers", workspaceId: "personal", title: "Answer protection", status: "active",
      createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z"
    };
    await api.createCourse(course, { ...context, idempotencyKey: "native-erase-answers-create" });
    const pageRelease = { ...releaseWithPage(), id: "native-erase-answers-release", courseId: course.id, courseTitle: course.title };
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, { ...context, idempotencyKey: "native-erase-answers-release-publish" });
    await api.saveQuestionAttempt({
      id: "native-erase-answer", selectionId: "selection", sessionId: "session", courseReleaseId: pageRelease.id,
      pageId: "page-1", questionId: "question", objectiveId: "objective", answer: "saved response", correct: true,
      usedHintLevel: 0, attemptedAt: "2026-10-03T00:01:00.000Z"
    }, { ...context, idempotencyKey: "native-erase-answer-save" });
    const trashed = await api.trashTreeNode(course.id, { ...context, idempotencyKey: "native-erase-answers-trash" });
    await expect(api.previewTrashNativeErase!(trashed.id, context, trashed.deletedAt, { expectedSnapshotHash: trashed.snapshotHash }, {
      checkExternalReferences: async () => ({ active: false, answers: false })
    })).rejects.toThrow("READWEAVE_TRASH_ANSWERS_PROTECTED");
    expect(verifyNativeErase).not.toHaveBeenCalled();
    await expect(api.listTrash()).resolves.toEqual([expect.objectContaining({ id: trashed.id, restoreAvailable: true })]);
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
    const moveSourceBranchId = remote.branchIdForNote(initial!.readweaveNoteId!);
    const moveContext = { ...context, idempotencyKey: "move-to-second-course" };
    remote.failBranchDeleteCount = 1;
    const firstMoveRequestsStart = remote.requests.length;
    await expect(api.updateTreeNode(initial!.id, { parentId: secondCourse.id }, initial!.revision ?? 0, moveContext)).rejects.toThrow("READWEAVE_ETAPI_400");
    const firstMoveRequests = remote.requests.slice(firstMoveRequestsStart);
    const firstMovePost = firstMoveRequests.find((request) => request.method === "POST" && request.path === "/branches"
      && JSON.parse(request.body ?? "{}").noteId === initial!.readweaveNoteId);
    expect(firstMovePost).toBeDefined();
    const targetParentNoteId = JSON.parse(firstMovePost!.body ?? "{}").parentNoteId as string;
    const targetBranchId = remote.branchIdForParent(initial!.readweaveNoteId!, targetParentNoteId);
    expect(targetBranchId).toBeDefined();
    expect(remote.branchIdsForNote(initial!.readweaveNoteId!)).toHaveLength(2);
    expect(remote.branchIdsForNote(initial!.readweaveNoteId!)).toEqual(expect.arrayContaining([moveSourceBranchId, targetBranchId]));

    const replayRequestsStart = remote.requests.length;
    const moved = await api.updateTreeNode(initial!.id, { parentId: secondCourse.id }, initial!.revision ?? 0, moveContext);
    const replayRequests = remote.requests.slice(replayRequestsStart);
    const retryMovePostIndex = replayRequests.findIndex((request) => request.method === "POST" && request.path === "/branches"
      && JSON.parse(request.body ?? "{}").noteId === initial!.readweaveNoteId
      && JSON.parse(request.body ?? "{}").parentNoteId === targetParentNoteId);
    const retryMoveDeleteIndex = replayRequests.findIndex((request) => request.method === "DELETE" && request.path === `/branches/${moveSourceBranchId}`);
    expect(retryMovePostIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(replayRequests[retryMovePostIndex]!.body ?? "{}")).not.toHaveProperty("notePosition");
    expect(retryMoveDeleteIndex).toBeGreaterThan(retryMovePostIndex);
    expect(remote.branchIdForParent(initial!.readweaveNoteId!, targetParentNoteId)).toBe(targetBranchId);
    expect(remote.branchIdsForNote(initial!.readweaveNoteId!)).toEqual([targetBranchId]);
    expect(moved.parentId).toBe(secondCourse.id);
    expect(remote.parentTitleOf(moved.readweaveNoteId!)).toBe("02 课程材料");

    const rootMaterial = await api.updateTreeNode(moved.id, { parentId: null }, moved.revision ?? 0, { ...context, idempotencyKey: "move-to-workspace-root" });
    expect(rootMaterial.parentId).toBeUndefined();
    expect(remote.parentTitleOf(rootMaterial.readweaveNoteId!)).toBe("00 工作区根材料");

    const sourceBranchId = remote.branchIdForNote(rootMaterial.readweaveNoteId!);
    const trashRequestsStart = remote.requests.length;
    const trashed = await api.trashTreeNode(rootMaterial.id, { ...context, idempotencyKey: "trash-root-material" });
    const trashRequests = remote.requests.slice(trashRequestsStart);
    const createTrashBranchIndex = trashRequests.findIndex((request) => request.method === "POST" && request.path === "/branches"
      && JSON.parse(request.body ?? "{}").noteId === rootMaterial.readweaveNoteId);
    const deleteSourceBranchIndex = trashRequests.findIndex((request) => request.method === "DELETE" && request.path === `/branches/${sourceBranchId}`);
    expect(createTrashBranchIndex).toBeGreaterThanOrEqual(0);
    expect(deleteSourceBranchIndex).toBeGreaterThan(createTrashBranchIndex);
    expect(JSON.parse(trashRequests[createTrashBranchIndex]!.body ?? "{}")).toMatchObject({
      noteId: rootMaterial.readweaveNoteId,
      parentNoteId: remote.noteIdForTitle("回收站")
    });
    expect(trashRequests.some((request) => request.method === "PUT" && request.path.includes("/move-to/"))).toBe(false);
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

describe("confirmed conflict metadata regression", () => {
  let fixtureNumber = 0;
  const metadataTitle = "Course OS Metadata Index · personal";

  async function fixture(resolved = false) {
    const remote = new FakeEtapi();
    const config = { baseUrl: `http://confirmed-conflicts-${++fixtureNumber}.test`, token: "secret", parentNoteId: "root", fetchImpl: remote.fetch };
    const setup = new EtapiReadWeaveCourseApi(config);
    const source = releaseWithPage();
    await setup.publishRelease(source, { ...manifest, courseReleaseId: source.id }, context);
    const saved = await setup.saveDraft(draftFor(source), 0, { ...context, idempotencyKey: "confirmed-fixture-draft" });
    const pageConflict: CourseConflict = {
      id: "conflict:page-1:1000", workspaceId: "personal", objectId: saved.pageId, objectType: "lesson_draft",
      baseRevision: 0, localRevision: 1, remoteRevision: 1,
      baseContent: "legacy base content", localContent: JSON.stringify(saved.page), remoteContent: JSON.stringify(saved.page),
      status: resolved ? "resolved" : "open", createdAt: "2026-10-05T00:00:00.000Z",
      ...(resolved ? { resolution: "remote" as const, resolvedAt: "2026-10-05T00:01:00.000Z" } : {})
    };
    const legacyConflict: CourseConflict = { ...pageConflict, id: "legacy-only-conflict", objectId: source.id, objectType: "release", status: "open", resolution: undefined, resolvedAt: undefined };
    const record = decodeReadWeaveStateContent(remote.contentByTitle("Course OS draft record · page-1")) as { conflicts: CourseConflict[] };
    record.conflicts = [pageConflict];
    remote.editByTitle("Course OS draft record · page-1", encodeReadWeaveStateContent(record));
    const root = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as { conflicts: CourseConflict[] };
    root.conflicts = [legacyConflict, { ...pageConflict, status: "open", resolution: undefined, resolvedAt: undefined }];
    remote.editByTitle("00 Course OS 结构化索引", encodeReadWeaveStateContent(root));
    const api = new EtapiReadWeaveCourseApi(config);
    await api.ensureMetadataIndex();
    return { remote, config, api, source, saved, pageConflict, legacyConflict };
  }

  it("backfills legacy-only and durable page conflicts once with resolved authority taking precedence", async () => {
    const { remote, api, pageConflict, legacyConflict } = await fixture(true);
    const indexed = decodeReadWeaveStateContent(remote.contentByTitle(metadataTitle)) as { confirmedConflicts: CourseConflict[] };
    expect(indexed.confirmedConflicts).toEqual([legacyConflict, pageConflict]);
    const before = remote.requests.length;
    await api.ensureMetadataIndex();
    expect(remote.requests.slice(before).every(request => request.method === "GET" && request.path === `/notes/${remote.noteIdByTitle(metadataTitle)}/content`)).toBe(true);
    await expect(api.listConflicts()).resolves.toEqual([legacyConflict, pageConflict]);
  });

  it.each(["unavailable", "stalled"])("reads fresh confirmed conflicts after cold reopen with the root %s and no draft scan", async (mode) => {
    const { remote, config, pageConflict, legacyConflict } = await fixture();
    const rootId = remote.noteIdByTitle("00 Course OS 结构化索引");
    let forbiddenRootReads = 0;
    const cold = new EtapiReadWeaveCourseApi({ ...config, fetchImpl: async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === `/etapi/notes/${rootId}/content`) {
        forbiddenRootReads += 1;
        if (mode === "unavailable") return new Response("root unavailable", { status: 503 });
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(init?.signal?.reason ?? new Error("root stalled"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return remote.fetch(input, init);
    } });
    const internals = cold as unknown as {
      readStateReference: () => Promise<unknown>;
      hydrateDraftPageRecords: () => Promise<void>;
      readDraftPageRecords: () => Promise<unknown>;
    };
    const rootRead = vi.spyOn(internals, "readStateReference");
    const hydration = vi.spyOn(internals, "hydrateDraftPageRecords");
    const records = vi.spyOn(internals, "readDraftPageRecords");
    const before = remote.requests.length;
    const conflicts = await withReadBudget({ timeoutMs: 300 }, () => cold.listConflicts());
    expect(conflicts).toEqual([legacyConflict, pageConflict]);
    expect(forbiddenRootReads).toBe(0);
    expect(rootRead).not.toHaveBeenCalled();
    expect(hydration).not.toHaveBeenCalled();
    expect(records).not.toHaveBeenCalled();
    const reads = remote.requests.slice(before);
    expect(reads.every(request => request.method === "GET")).toBe(true);
    expect(reads.filter(request => request.path.endsWith("/content")).map(request => request.path)).toEqual([`/notes/${remote.noteIdByTitle(metadataTitle)}/content`]);
    conflicts[0]!.localContent = "caller-only mutation";
    conflicts.pop();
    await expect(cold.listConflicts()).resolves.toEqual([legacyConflict, pageConflict]);
  });

  it("registers a subsequent revision conflict, indexes its resolution and replays without writing", async () => {
    const { remote, config, api, saved, pageConflict, legacyConflict } = await fixture();
    const stalePage = structuredClone(saved.page);
    stalePage.blocks[0]!.markdown = "new stale attempt";
    await expect(api.saveDraft({ ...saved, page: stalePage }, 0, { ...context, idempotencyKey: "confirmed-new-conflict" })).rejects.toThrow("READWEAVE_REVISION_CONFLICT:");
    const cold = new EtapiReadWeaveCourseApi(config);
    const conflicts = await cold.listConflicts();
    const created = conflicts.find(conflict => conflict.id !== pageConflict.id && conflict.id !== legacyConflict.id);
    expect(created).toMatchObject({ status: "open", objectId: saved.pageId, localContent: JSON.stringify(stalePage) });
    const write = { ...context, idempotencyKey: "confirmed-resolve" };
    const resolved = await api.resolveConflict(created!.id, "remote", undefined, write);
    expect(resolved).toMatchObject({ status: "resolved", resolution: "remote" });
    await expect(cold.listConflicts()).resolves.toEqual(expect.arrayContaining([resolved, pageConflict, legacyConflict]));
    const beforeReplay = remote.requests.length;
    await expect(api.resolveConflict(created!.id, "local", undefined, write)).resolves.toEqual(resolved);
    expect(remote.requests.slice(beforeReplay).filter(request => request.method !== "GET")).toEqual([]);
  });

  it("rejects a fresh metadata GET failure instead of returning cached or empty conflicts", async () => {
    const { remote, config, pageConflict, legacyConflict } = await fixture();
    const metadataId = remote.noteIdByTitle(metadataTitle);
    let fail = false;
    const reader = new EtapiReadWeaveCourseApi({ ...config, fetchImpl: async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (fail && url.pathname === `/etapi/notes/${metadataId}/content`) return new Response("denied", { status: 403 });
      return remote.fetch(input, init);
    } });
    await expect(reader.listConflicts()).resolves.toEqual([legacyConflict, pageConflict]);
    fail = true;
    await expect(reader.listConflicts()).rejects.toThrow("READWEAVE_ETAPI_403:");
    fail = false;
    await expect(reader.listConflicts()).resolves.toEqual([legacyConflict, pageConflict]);
  });

  it("reports failed conflict index readback and subsequently reads the actual persisted conflict", async () => {
    const { remote, config, saved, pageConflict, legacyConflict } = await fixture();
    const metadataId = remote.noteIdByTitle(metadataTitle);
    const oldMetadata = remote.contentByTitle(metadataTitle);
    let corruptReadback = false;
    const writer = new EtapiReadWeaveCourseApi({ ...config, fetchImpl: async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === `/etapi/notes/${metadataId}/content`) {
        if (init?.method === "PUT") {
          const response = await remote.fetch(input, init);
          corruptReadback = true;
          return response;
        }
        if (corruptReadback && (init?.method ?? "GET") === "GET") {
          corruptReadback = false;
          return new Response(oldMetadata, { status: 200 });
        }
      }
      return remote.fetch(input, init);
    } });
    await expect(writer.saveDraft(saved, 0, { ...context, idempotencyKey: "confirmed-failed-readback" })).rejects.toThrow("READWEAVE_METADATA_INDEX_READBACK_FAILED");
    const current = await new EtapiReadWeaveCourseApi(config).listConflicts();
    expect(current).toEqual(expect.arrayContaining([pageConflict, legacyConflict]));
    expect(current.filter(conflict => conflict.id !== pageConflict.id && conflict.id !== legacyConflict.id)).toHaveLength(1);
  });

  it("keeps a resolved conflict when a second adapter submits a delayed old open snapshot", async () => {
    const { config, api, pageConflict } = await fixture();
    const late = new EtapiReadWeaveCourseApi(config) as unknown as { updateConfirmedConflicts(conflicts: CourseConflict[]): Promise<void> };
    let releaseOld!: () => void;
    const gate = new Promise<void>(resolve => { releaseOld = resolve; });
    const oldUpdate = gate.then(() => late.updateConfirmedConflicts([structuredClone(pageConflict)]));
    try {
      const resolved = await api.resolveConflict(pageConflict.id, "remote", undefined, { ...context, idempotencyKey: "confirmed-before-late-open" });
      releaseOld();
      await oldUpdate;
      expect((await new EtapiReadWeaveCourseApi(config).listConflicts()).find(conflict => conflict.id === pageConflict.id)).toEqual(resolved);
    } finally {
      releaseOld();
      await oldUpdate;
    }
  });

  it("retains an observed open conflict across a failed page PUT and adapter restart", async () => {
    const { remote, config, saved, pageConflict, legacyConflict } = await fixture();
    const recordId = remote.noteIdByTitle("Course OS draft record · page-1");
    const writer = new EtapiReadWeaveCourseApi({ ...config, fetchImpl: async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === `/etapi/notes/${recordId}/content` && init?.method === "PUT") return new Response("page PUT denied", { status: 403 });
      return remote.fetch(input, init);
    } });
    const stalePage = structuredClone(saved.page);
    stalePage.blocks[0]!.markdown = "observed despite failed page PUT";
    await expect(writer.saveDraft({ ...saved, page: stalePage }, 0, { ...context, idempotencyKey: "confirmed-page-put-failure" })).rejects.toThrow("READWEAVE_ETAPI_403:");
    const record = decodeReadWeaveStateContent(remote.contentByTitle("Course OS draft record · page-1")) as { conflicts: CourseConflict[] };
    expect(record.conflicts).toEqual([pageConflict]);
    const observed = await new EtapiReadWeaveCourseApi(config).listConflicts();
    expect(observed).toEqual(expect.arrayContaining([pageConflict, legacyConflict]));
    expect(observed.filter(conflict => conflict.id !== pageConflict.id && conflict.id !== legacyConflict.id)).toEqual([
      expect.objectContaining({ status: "open", objectId: saved.pageId, localContent: JSON.stringify(stalePage) })
    ]);
  });

  it.each(["replay", "already-resolved"])("repairs a failed resolution projection through the %s path after verifying the page authority", async (repair) => {
    const { remote, config, pageConflict } = await fixture();
    const metadataId = remote.noteIdByTitle(metadataTitle);
    const recordId = remote.noteIdByTitle("Course OS draft record · page-1");
    let failIndexPut = true;
    const writer = new EtapiReadWeaveCourseApi({ ...config, fetchImpl: async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (failIndexPut && url.pathname === `/etapi/notes/${metadataId}/content` && init?.method === "PUT") return new Response("index PUT denied", { status: 403 });
      return remote.fetch(input, init);
    } });
    const write = { ...context, idempotencyKey: "confirmed-resolution-lost-index" };
    await expect(writer.resolveConflict(pageConflict.id, "remote", undefined, write)).rejects.toThrow("READWEAVE_ETAPI_403:");
    const record = decodeReadWeaveStateContent(remote.contentByTitle("Course OS draft record · page-1")) as { conflicts: CourseConflict[] };
    const resolved = record.conflicts.find(conflict => conflict.id === pageConflict.id)!;
    expect(resolved).toMatchObject({ status: "resolved", resolution: "remote" });
    expect((await new EtapiReadWeaveCourseApi(config).listConflicts()).find(conflict => conflict.id === pageConflict.id)).toEqual(pageConflict);
    failIndexPut = false;
    const pageWrites = remote.contentWriteCount(recordId);
    const retry = repair === "replay" ? write : { ...context, idempotencyKey: "confirmed-already-resolved-repair" };
    await expect(writer.resolveConflict(pageConflict.id, "local", undefined, retry)).resolves.toEqual(resolved);
    expect(remote.contentWriteCount(recordId)).toBe(pageWrites);
    expect((await new EtapiReadWeaveCourseApi(config).listConflicts()).find(conflict => conflict.id === pageConflict.id)).toEqual(resolved);
  });

  it("does not project a resolution when the page record confirmation returns stale content", async () => {
    const { remote, config, pageConflict } = await fixture();
    const recordId = remote.noteIdByTitle("Course OS draft record · page-1");
    const oldRecord = remote.contentByTitle("Course OS draft record · page-1");
    let staleReadback = false;
    const writer = new EtapiReadWeaveCourseApi({ ...config, fetchImpl: async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === `/etapi/notes/${recordId}/content`) {
        if (init?.method === "PUT") {
          const response = await remote.fetch(input, init);
          staleReadback = true;
          return response;
        }
        if (staleReadback && (init?.method ?? "GET") === "GET") {
          staleReadback = false;
          return new Response(oldRecord, { status: 200 });
        }
      }
      return remote.fetch(input, init);
    } });
    await expect(writer.resolveConflict(pageConflict.id, "remote", undefined, { ...context, idempotencyKey: "confirmed-stale-page-readback" })).rejects.toThrow("READWEAVE_DRAFT_RECORD_READBACK_FAILED");
    expect((await new EtapiReadWeaveCourseApi(config).listConflicts()).find(conflict => conflict.id === pageConflict.id)).toEqual(pageConflict);
  });

  it("repairs a lost resolved projection through saveDraft replay without re-saving the page", async () => {
    const { remote, config, saved, pageConflict } = await fixture(true);
    const metadataId = remote.noteIdByTitle(metadataTitle);
    const index = decodeReadWeaveStateContent(remote.contentByTitle(metadataTitle)) as { confirmedConflicts: CourseConflict[] };
    index.confirmedConflicts = index.confirmedConflicts.filter(conflict => conflict.id !== pageConflict.id);
    remote.editByTitle(metadataTitle, encodeReadWeaveStateContent(index));
    let failIndexPut = true;
    const writer = new EtapiReadWeaveCourseApi({ ...config, fetchImpl: async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (failIndexPut && url.pathname === `/etapi/notes/${metadataId}/content` && init?.method === "PUT") return new Response("index PUT denied", { status: 403 });
      return remote.fetch(input, init);
    } });
    const write = { ...context, idempotencyKey: "confirmed-draft-lost-index" };
    await expect(writer.saveDraft(saved, saved.revision, write)).rejects.toThrow("READWEAVE_ETAPI_403:");
    const recordId = remote.noteIdByTitle("Course OS draft record · page-1");
    const pageWrites = remote.contentWriteCount(recordId);
    failIndexPut = false;
    await expect(writer.saveDraft(saved, saved.revision, write)).resolves.toMatchObject({ revision: saved.revision + 1 });
    expect(remote.contentWriteCount(recordId)).toBe(pageWrites);
    expect((await new EtapiReadWeaveCourseApi(config).listConflicts()).find(conflict => conflict.id === pageConflict.id)).toEqual(pageConflict);
  });

  it("repairs the confirmed projection on a core publish replay without rewriting the root", async () => {
    const { remote, config, api, source, pageConflict } = await fixture(true);
    const next = { ...structuredClone(source), id: "confirmed-core-replay-release", version: source.version + 1 };
    const write = { ...context, idempotencyKey: "confirmed-core-replay" };
    await api.publishRelease(next, { ...manifest, courseReleaseId: next.id }, write);
    const index = decodeReadWeaveStateContent(remote.contentByTitle(metadataTitle)) as { confirmedConflicts: CourseConflict[] };
    index.confirmedConflicts = index.confirmedConflicts.filter(conflict => conflict.id !== pageConflict.id);
    remote.editByTitle(metadataTitle, encodeReadWeaveStateContent(index));
    const rootWrites = remote.contentWriteCount(remote.noteIdByTitle("00 Course OS 结构化索引"));
    await expect(api.publishRelease(next, { ...manifest, courseReleaseId: next.id }, write)).resolves.toMatchObject({ id: next.id });
    expect(remote.contentWriteCount(remote.noteIdByTitle("00 Course OS 结构化索引"))).toBe(rootWrites);
    expect((await new EtapiReadWeaveCourseApi(config).listConflicts()).find(conflict => conflict.id === pageConflict.id)).toEqual(pageConflict);
  }, 2_000);

  it("retains both different-page conflicts from concurrent independent adapter writes", async () => {
    const { config, api, source, pageConflict, legacyConflict } = await fixture();
    const secondPage = { ...structuredClone(source.pages[0]!), id: "confirmed-concurrent-page-2", pageNumber: 2 };
    const next = { ...structuredClone(source), id: "confirmed-concurrent-release", version: source.version + 1,
      pageIds: [...source.pageIds, secondPage.id], pages: [...source.pages, secondPage] };
    await api.publishRelease(next, { ...manifest, courseReleaseId: next.id }, { ...context, idempotencyKey: "confirmed-concurrent-publish" });
    const drafts = await Promise.all(next.pageIds.map(async (pageId) => {
      const writer = new EtapiReadWeaveCourseApi(config);
      const current = await writer.getDraftByPage(pageId);
      return writer.saveDraft(current ?? draftFor(next, pageId), current?.revision ?? 0, { ...context, idempotencyKey: `confirmed-concurrent-initial-${pageId}` });
    }));
    const stale = drafts.map(draft => {
      const page = structuredClone(draft.page);
      page.blocks[0]!.markdown = `concurrent stale content for ${draft.pageId}`;
      return { ...draft, page };
    });
    const attempts = await Promise.allSettled(stale.map(draft => new EtapiReadWeaveCourseApi(config).saveDraft(
      draft, 0, { ...context, idempotencyKey: `confirmed-concurrent-conflict-${draft.pageId}` }
    )));
    for (const attempt of attempts) {
      expect(attempt.status).toBe("rejected");
      if (attempt.status === "rejected") expect(String(attempt.reason)).toContain("READWEAVE_REVISION_CONFLICT:");
    }
    const rows = await new EtapiReadWeaveCourseApi(config).listConflicts();
    expect(rows).toEqual(expect.arrayContaining([legacyConflict, pageConflict]));
    const created = rows.filter(row => row.id !== legacyConflict.id && row.id !== pageConflict.id);
    expect(created).toHaveLength(2);
    for (const draft of stale) {
      expect(created).toEqual(expect.arrayContaining([
        expect.objectContaining({ objectId: draft.pageId, status: "open", localContent: JSON.stringify(draft.page) })
      ]));
    }
  }, 2_000);

  it("preserves confirmed conflicts across metadata rename and restores them through rollback", async () => {
    const { remote, config, api, source, pageConflict, legacyConflict } = await fixture(true);
    const course = (await api.listTreeNodes()).find(node => node.id === source.courseId)!;
    const rootId = remote.noteIdByTitle("00 Course OS 结构化索引");
    const rootWrites = remote.contentWriteCount(rootId);
    await api.updateTreeNode(course.id, { title: "renamed with confirmed conflicts" }, course.revision ?? 0, { ...context, idempotencyKey: "confirmed-rename" });
    expect(remote.contentWriteCount(rootId)).toBe(rootWrites);
    await expect(new EtapiReadWeaveCourseApi(config).listConflicts()).resolves.toEqual([legacyConflict, pageConflict]);
    await api.prepareMetadataRollback();
    const root = decodeReadWeaveStateContent(remote.contentByTitle("00 Course OS 结构化索引")) as { conflicts: CourseConflict[]; projections: { metadataIndexNoteId?: string } };
    expect(root.projections.metadataIndexNoteId).toBeUndefined();
    expect(root.conflicts.find(conflict => conflict.id === pageConflict.id)).toEqual(pageConflict);
    await expect(new EtapiReadWeaveCourseApi(config).listConflicts()).resolves.toEqual([legacyConflict, pageConflict]);
  });

  it("publishes a core release with a nonempty conflict page record without re-entering its own queue", async () => {
    const { config, api, source, pageConflict, legacyConflict } = await fixture();
    const next = { ...structuredClone(source), id: "confirmed-core-next-release", version: source.version + 1 };
    await expect(api.publishRelease(next, { ...manifest, courseReleaseId: next.id }, { ...context, idempotencyKey: "confirmed-core-publish" })).resolves.toMatchObject({ id: next.id });
    await expect(new EtapiReadWeaveCourseApi(config).listConflicts()).resolves.toEqual([legacyConflict, pageConflict]);
  }, 2_000);
});

describe("material release identity", () => {
  const published = { ...releaseWithPage(), id: "material-published-v1", version: 1, lifecycle: "published" as const };
  const readyCandidate: CourseRelease = {
    ...published,
    id: "material-candidate-v2",
    version: 2,
    lifecycle: "draft_source",
    pageIds: ["candidate-page-1"],
    pages: [{ ...published.pages[0]!, id: "candidate-page-1" }]
  };
  const readyDraft: LessonDraft = {
    ...draftFor(readyCandidate, "candidate-page-1"),
    status: "ready"
  };

  it("selects complete readable drafts, preserves valid pointers and ignores cross-material pointers", () => {
    expect(selectMaterialRelease([published], [], published.courseId, published.moduleId)?.id).toBe(published.id);
    expect(selectMaterialRelease([published, readyCandidate], [readyDraft], published.courseId, published.moduleId)?.id).toBe(readyCandidate.id);

    const emptyBodyCandidate: CourseRelease = {
      ...readyCandidate,
      id: "material-empty-body-v2",
      pageIds: ["candidate-page-1", "candidate-page-2"],
      pages: [
        { ...readyCandidate.pages[0]!, blocks: [] },
        { ...readyCandidate.pages[0]!, id: "candidate-page-2", pageNumber: 2 }
      ]
    };
    const emptyBodyDraft: LessonDraft = {
      ...readyDraft,
      sourceReleaseId: emptyBodyCandidate.id,
      page: { ...emptyBodyCandidate.pages[0]! }
    };
    expect(selectMaterialRelease([published, emptyBodyCandidate], [emptyBodyDraft], published.courseId, published.moduleId)?.id).toBe(published.id);

    const blankFullPage: PageLesson = {
      ...readyCandidate.pages[0]!,
      id: "blank-full-page",
      lessonSections: [{
        id: "blank-full-section",
        kind: "full_explanation",
        title: "完整讲解",
        markdown: "  ",
        items: [{ id: "summary-item", text: "简短摘要不能替代完整讲解", sourceAnchorIds: [] }],
        sourceAnchorIds: [],
        atomIds: []
      }],
      blocks: [{ id: "summary-core", kind: "core", title: "核心解释", markdown: "简短摘要", sourceAnchorIds: [], atomIds: [] }]
    };
    const blankFullCandidate: CourseRelease = {
      ...readyCandidate,
      id: "material-blank-full-v2",
      pageIds: [blankFullPage.id],
      pages: [blankFullPage]
    };
    const blankFullDraft: LessonDraft = {
      ...readyDraft,
      sourceReleaseId: blankFullCandidate.id,
      pageId: blankFullPage.id,
      page: blankFullPage
    };
    expect(selectMaterialRelease([published, blankFullCandidate], [blankFullDraft], published.courseId, published.moduleId)?.id).toBe(published.id);

    const legacyCorePage: PageLesson = {
      ...readyCandidate.pages[0]!,
      id: "legacy-core-page",
      blocks: [{ id: "legacy-core", kind: "core", title: "核心解释", markdown: "旧版核心讲解仍可阅读", sourceAnchorIds: [], atomIds: [] }]
    };
    delete legacyCorePage.lessonSections;
    const legacyCoreCandidate: CourseRelease = {
      ...readyCandidate,
      id: "material-legacy-core-v2",
      pageIds: [legacyCorePage.id],
      pages: [legacyCorePage]
    };
    const legacyCoreDraft: LessonDraft = {
      ...readyDraft,
      sourceReleaseId: legacyCoreCandidate.id,
      pageId: legacyCorePage.id,
      page: legacyCorePage
    };
    expect(selectMaterialRelease([published, legacyCoreCandidate], [legacyCoreDraft], published.courseId, published.moduleId)?.id).toBe(legacyCoreCandidate.id);

    const completeV3: CourseRelease = {
      ...readyCandidate,
      id: "material-candidate-v3",
      version: 3,
      pageIds: ["candidate-page-3"],
      pages: [{ ...readyCandidate.pages[0]!, id: "candidate-page-3" }]
    };
    const readyDraftV3: LessonDraft = {
      ...readyDraft,
      id: "draft:candidate-page-3",
      sourceReleaseId: completeV3.id,
      pageId: "candidate-page-3",
      page: completeV3.pages[0]!
    };
    expect(selectMaterialRelease([published, readyCandidate, completeV3], [readyDraft, readyDraftV3], published.courseId, published.moduleId, readyCandidate.id)?.id).toBe(readyCandidate.id);
    expect(selectMaterialRelease([published, readyCandidate], [readyDraft], published.courseId, published.moduleId, published.id)?.id).toBe(published.id);

    const otherMaterial = { ...completeV3, id: "other-material-v9", moduleId: "other-module", version: 9 };
    expect(selectMaterialRelease([published, readyCandidate, otherMaterial], [readyDraft], published.courseId, published.moduleId, otherMaterial.id)?.id).toBe(readyCandidate.id);
  });

  it("accepts local uncertainty in a complete explanation but rejects whole-body placeholders", () => {
    const syntheticTeaching = [
      "本节讨论虚构的澄流器如何将输入信号映射到目标输出。先把输入、内部状态和输出分开记录：输入是当前步骤收到的信息，状态保存此前步骤需要继续使用的信息，输出则是本步骤能够观察到的结果。",
      "分析时从定义入手。给定相同输入和状态，规则应产生相同输出；状态变化时，必须重新应用规则，不能把上一轮结果直接当成新输入。逐项说明条件满足时更新哪个状态、产生什么输出，便于核对每一步使用的前提。",
      "虚构示例中的一条观察尚未被完整解释，暂时只能记作待确认信息；这只影响该观察本身，不替代已经说明的系统定义和推理过程。随后复核输入、状态更新与输出之间的对应关系，并区分规则推出的结论和仍依赖观察的判断。",
      "练习时可以改变输入，按同一规则重新推演，再比较各步状态和输出。若结果不同，应指出差异出现在哪个条件或状态更新处，而不是跳过中间步骤；这样可以检查规则是否前后一致，也能看出当前结论适用的范围。"
    ].join("\n\n");
    const fill = "复核时继续沿输入、条件、状态与输出的顺序解释每一步，不把观察误当成规则。";
    const completeBody = `${syntheticTeaching}\n\n${fill.repeat(40)}`.slice(0, 1648);
    expect(completeBody).toHaveLength(1648);
    expect(completeBody).toContain("待确认信息");

    const candidateFor = (id: string, page: PageLesson): CourseRelease => ({
      ...readyCandidate,
      id,
      pageIds: [page.id],
      pages: [page]
    });
    const draftForPage = (candidate: CourseRelease): LessonDraft => ({
      ...readyDraft,
      sourceReleaseId: candidate.id,
      pageId: candidate.pages[0]!.id,
      page: candidate.pages[0]!
    });
    const pageFor = (id: string, markdown: string, issues: string[] = []): PageLesson => ({
      ...readyCandidate.pages[0]!,
      id,
      lessonSections: [{
        id: `${id}-full-explanation`,
        kind: "full_explanation",
        title: "完整讲解",
        markdown,
        sourceAnchorIds: [],
        atomIds: []
      }],
      quality: { ...readyCandidate.pages[0]!.quality, issues }
    });

    const localUncertaintyPage = pageFor("local-uncertainty-page", completeBody);
    const localUncertaintyCandidate = candidateFor("material-local-uncertainty-v2", localUncertaintyPage);
    expect(selectMaterialRelease(
      [published, localUncertaintyCandidate], [draftForPage(localUncertaintyCandidate)], published.courseId, published.moduleId
    )?.id).toBe(localUncertaintyCandidate.id);

    for (const [id, placeholder] of [["generation-placeholder", "待生成"], ["confirmation-placeholder", "待确认"]] as const) {
      const placeholderCandidate = candidateFor(`material-${id}-v2`, pageFor(`${id}-page`, placeholder));
      expect(selectMaterialRelease(
        [published, placeholderCandidate], [draftForPage(placeholderCandidate)], published.courseId, published.moduleId
      )?.id).toBe(published.id);
    }

    const requiredCandidate = candidateFor("material-required-v2", pageFor(
      "required-page", "完整的合成教学正文，包含定义、条件和推理。", ["TEACHING_GENERATION_REQUIRED"]
    ));
    expect(selectMaterialRelease(
      [published, requiredCandidate], [draftForPage(requiredCandidate)], published.courseId, published.moduleId
    )?.id).toBe(published.id);
  });

  it("keeps a partially drafted upload selectable when no readable published release exists", () => {
    const pages = Array.from({ length: 112 }, (_, index) => ({
      ...published.pages[0]!,
      id: `lecture-page-${index + 1}`,
      pageNumber: index + 1
    }));
    const upload: CourseRelease = {
      ...readyCandidate,
      id: "lecture-upload-112",
      pageIds: pages.map((page) => page.id),
      pages
    };
    const availableDrafts = pages.slice(0, 46).map((page, index) => ({
      ...draftFor(upload, page.id),
      id: `draft:lecture-page-${index + 1}`,
      status: "ready" as const,
      page
    }));

    expect(selectMaterialRelease([upload], availableDrafts, upload.courseId, upload.moduleId)?.id).toBe(upload.id);
  });

  it("passes the loaded draft state through both File and ETAPI material projections", async () => {
    const fileRoot = await mkdtemp(join(tmpdir(), "course-os-material-identity-"));
    const remote = new FakeEtapi();
    const adapters = [
      new FileReadWeaveCourseApi(join(fileRoot, "state.json")),
      new EtapiReadWeaveCourseApi({ baseUrl: "http://readweave", token: "secret", parentNoteId: "root", fetchImpl: remote.fetch })
    ];
    for (const [index, api] of adapters.entries()) {
      const suffix = String(index);
      const base = { ...published, id: `material-published-${suffix}` };
      const candidate: CourseRelease = {
        ...readyCandidate,
        id: `material-candidate-${suffix}`,
        pageIds: [`candidate-page-${suffix}`],
        pages: [{ ...readyCandidate.pages[0]!, id: `candidate-page-${suffix}` }]
      };
      await api.publishRelease(base, { ...manifest, courseReleaseId: base.id }, { ...context, idempotencyKey: `publish-material-${suffix}` });
      await api.registerDraftSource(candidate, { ...context, idempotencyKey: `register-candidate-${suffix}` });
      await api.saveDraft({ ...draftFor(candidate), status: "ready" }, 0, { ...context, idempotencyKey: `save-ready-${suffix}` });

      const material = (await api.listTreeNodes()).find((node) => node.kind === "material");
      expect(material).toMatchObject({
        id: `material:${candidate.courseId}:${candidate.moduleId}`,
        materialId: `material:${candidate.courseId}:${candidate.moduleId}`,
        releaseId: candidate.id,
        currentReleaseId: candidate.id
      });
    }
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

function parseFakeLabelSearch(query: string): { labels: Array<{ name: string; value: string }>; operator: "AND" | "OR" } | undefined {
  const clause = /#([^\s=]+)\s*=\s*(?:"((?:\\[\s\S]|[^"\\])*)"|([^\s]+))/y;
  const separator = /\s+(AND|OR)\s+/iy;
  const labels: Array<{ name: string; value: string }> = [];
  let offset = 0;
  let operator: "AND" | "OR" | undefined;
  while (offset < query.length) {
    clause.lastIndex = offset;
    const match = clause.exec(query);
    if (!match) return undefined;
    labels.push({ name: match[1]!.toLowerCase(), value: (match[2] ?? match[3]!).replace(/\\([\s\S])/g, "$1").toLowerCase() });
    offset = clause.lastIndex;
    if (offset === query.length) return { labels, operator: operator ?? "AND" };
    separator.lastIndex = offset;
    const join = separator.exec(query);
    if (!join) return undefined;
    const nextOperator = join[1]!.toUpperCase() as "AND" | "OR";
    if (operator && operator !== nextOperator) return undefined;
    operator = nextOperator;
    offset = separator.lastIndex;
  }
  return undefined;
}

class FakeEtapi {
  private sequence = 0;
  failBranchDeleteCount = 0;
  readonly requests: Array<{ path: string; method: string; headers: Record<string, string>; body?: string }> = [];
  private readonly notes = new Map<string, { title: string; content: string; labels: Record<string, string>; type: string; mime: string; parentBranchIds: string[]; deleted: boolean }>([["root", { title: "root", content: "", labels: {}, type: "text", mime: "text/html", parentBranchIds: [], deleted: false }]]);
  private readonly branches = new Map<string, { branchId: string; noteId: string; parentNoteId: string; notePosition: number; prefix?: string; isExpanded?: boolean }>();

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const path = url.pathname.replace(/^\/etapi/, "");
    this.requests.push({ path, method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === "string" ? init.body : undefined });
    if (path === "/notes" && (init?.method ?? "GET") === "GET") {
      const query = url.searchParams.get("search") ?? "";
      const labels = parseFakeLabelSearch(query);
      const exactTitle = /^"((?:\\[\s\S]|[^"\\])*)"$/.exec(query)?.[1]?.replace(/\\([\s\S])/g, "$1");
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
          && (labels ? labels.labels[labels.operator === "OR" ? "some" : "every"](({ name, value }) =>
            Object.entries(note.labels).some(([key, actual]) => key.toLowerCase() === name && actual.toLowerCase() === value))
            : exactTitle ? note.title.includes(exactTitle) : false)
          && isDescendant(noteId)).map(([noteId, note]) => ({ noteId, title: note.title, type: note.type, mime: note.mime, parentBranchIds: note.parentBranchIds }));
      return Response.json({ results });
    }
    if (path === "/create-note" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { parentNoteId: string; title: string; content: string; type?: string; mime?: string; noteId?: string };
      const noteId = body.noteId ?? `note${this.sequence + 1}`;
      this.sequence++;
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
      return Response.json({ noteId: noteMatch[1], title: note.title, type: note.type, mime: note.mime, parentBranchIds: note.parentBranchIds,
        childNoteIds: [...this.branches.values()].filter(branch => branch.parentNoteId === noteMatch[1]).map(branch => branch.noteId) });
    }
    if (noteMatch && init?.method === "PATCH") {
      const note = this.notes.get(noteMatch[1]!);
      if (!note || note.deleted) return new Response("not found", { status: 404 });
      const body = JSON.parse(String(init.body)) as { title?: string };
      if (body.title) note.title = body.title;
      return Response.json({ noteId: noteMatch[1], title: note.title, type: note.type, mime: note.mime, parentBranchIds: note.parentBranchIds,
        childNoteIds: [...this.branches.values()].filter(branch => branch.parentNoteId === noteMatch[1]).map(branch => branch.noteId) });
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
      const body = JSON.parse(String(init.body)) as { noteId: string; parentNoteId: string; notePosition?: number; prefix?: string; isExpanded?: boolean };
      const existing = [...this.branches.values()].find((branch) => branch.noteId === body.noteId && branch.parentNoteId === body.parentNoteId);
      const branchId = existing?.branchId ?? `branch${++this.sequence}`;
      const siblingPositions = [...this.branches.values()].filter((branch) => branch.parentNoteId === body.parentNoteId && branch.branchId !== branchId).map((branch) => branch.notePosition);
      const branch = {
        branchId,
        noteId: body.noteId,
        parentNoteId: body.parentNoteId,
        notePosition: body.notePosition ?? (siblingPositions.length ? Math.max(...siblingPositions) + 10 : 10),
        prefix: body.prefix ?? "",
        isExpanded: body.isExpanded ?? false
      };
      this.branches.set(branchId, branch);
      const note = this.notes.get(body.noteId);
      if (note && !note.parentBranchIds.includes(branchId)) note.parentBranchIds.push(branchId);
      return Response.json(branch, { status: existing ? 200 : 201 });
    }
    const deleteBranchMatch = /^\/branches\/([^/]+)$/.exec(path);
    if (deleteBranchMatch && init?.method === "DELETE") {
      if (this.failBranchDeleteCount > 0) {
        this.failBranchDeleteCount -= 1;
        return new Response("simulated branch delete failure", { status: 400 });
      }
      const branch = this.branches.get(deleteBranchMatch[1]!);
      if (!branch) return new Response(null, { status: 204 });
      this.branches.delete(branch.branchId);
      const note = this.notes.get(branch.noteId);
      if (note) {
        note.parentBranchIds = note.parentBranchIds.filter((branchId) => branchId !== branch.branchId);
        if (note.parentBranchIds.length === 0) note.deleted = true;
      }
      return new Response(null, { status: 204 });
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

  branchIdForParent(noteId: string, parentNoteId: string): string | undefined {
    return [...this.branches.values()].find((branch) => branch.noteId === noteId && branch.parentNoteId === parentNoteId)?.branchId;
  }

  branchIdsForNote(noteId: string): string[] {
    return [...this.branches.values()].filter((branch) => branch.noteId === noteId).map((branch) => branch.branchId);
  }

  eraseNativeNotes(noteIds: string[]): void {
    for (const noteId of noteIds) {
      const note = this.notes.get(noteId);
      if (note) note.deleted = true;
    }
  }

  restoreNativeNote(noteId: string): void {
    const note = this.notes.get(noteId);
    if (!note) throw new Error(`missing note ${noteId}`);
    note.deleted = false;
  }

  addClone(noteId: string, parentNoteId: string): string {
    const branchId = `branch${++this.sequence}`;
    const note = this.notes.get(noteId);
    if (!note) throw new Error(`missing note ${noteId}`);
    note.parentBranchIds.push(branchId);
    this.branches.set(branchId, { branchId, noteId, parentNoteId, notePosition: 10 });
    return branchId;
  }

  addChildNote(parentNoteId: string, title: string): string {
    const noteId = `note${++this.sequence}`;
    const branchId = `branch${this.sequence}`;
    this.notes.set(noteId, { title, content: "", labels: {}, type: "text", mime: "text/html", parentBranchIds: [branchId], deleted: false });
    this.branches.set(branchId, { branchId, noteId, parentNoteId, notePosition: 10 });
    return noteId;
  }

  addLabeledChildNote(parentNoteId: string, noteId: string, title: string, labels: Record<string, string>, type = "text", content = ""): string {
    const branchId = `branch${++this.sequence}`;
    this.notes.set(noteId, { title, content, labels: { ...labels }, type, mime: type === "code" ? "application/json" : "text/html", parentBranchIds: [branchId], deleted: false });
    this.branches.set(branchId, { branchId, noteId, parentNoteId, notePosition: 10 });
    return noteId;
  }

  addNoteCopy(noteId: string, parentNoteId: string): string {
    const source = this.notes.get(noteId);
    if (!source) throw new Error(`missing note ${noteId}`);
    const copyId = `note${++this.sequence}`;
    const branchId = `branch${this.sequence}`;
    this.notes.set(copyId, { ...source, labels: { ...source.labels }, parentBranchIds: [branchId], deleted: false });
    this.branches.set(branchId, { branchId, noteId: copyId, parentNoteId, notePosition: 10 });
    return copyId;
  }

  renameNote(noteId: string, title: string): void {
    const note = this.notes.get(noteId);
    if (!note) throw new Error(`missing note ${noteId}`);
    note.title = title;
  }

  removeNoteLabel(noteId: string, label: string): void {
    const note = this.notes.get(noteId);
    if (!note) throw new Error(`missing note ${noteId}`);
    delete note.labels[label];
  }

  replaceNoteContent(noteId: string, content: string): void {
    const note = this.notes.get(noteId);
    if (!note) throw new Error(`missing note ${noteId}`);
    note.content = content;
  }

  noteIdForTitle(title: string): string | undefined {
    return [...this.notes.entries()].find(([, note]) => note.title === title)?.[0];
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
