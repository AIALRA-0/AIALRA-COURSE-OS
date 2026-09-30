import { readFile } from "node:fs/promises";
import type { CourseRelease, LearningSession, LessonDraft, PageLesson } from "@course-os/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ImportTaskSummary } from "./types.js";
import { beginCandidatePreviewLoad, defaultRelease, flushNextSessionPatch, isReadyCandidateSnapshot, isUnresolvedTaskFailure, mergeReleaseIndex, normalizeSidebarWidth, openVerifiedReadWeaveDeepLink, rememberPageSnapshot, pageSnapshotCacheKey, isCurrentPageSnapshot, pageSnapshotResponseState, readOnce, resolveActiveImportId, SIDEBAR_DEFAULT_WIDTH, sourceReleasesForCourse, type CandidatePreviewState } from "./App.js";

describe("workspace tree and incremental import UI inputs", () => {
  it("restores a readable default sidebar width for missing or invalid saved values", () => {
    expect(normalizeSidebarWidth(null)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(normalizeSidebarWidth("80")).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(normalizeSidebarWidth("not-a-width")).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(normalizeSidebarWidth("220")).toBe(220);
    expect(normalizeSidebarWidth("999")).toBe(420);
  });

  it("offers only draft source releases from the selected course for incremental upload", () => {
    const releases = [
      { id: "source-a", courseId: "course-a", lifecycle: "draft_source" },
      { id: "published-a", courseId: "course-a", lifecycle: "published" },
      { id: "source-b", courseId: "course-b", lifecycle: "draft_source" }
    ] as CourseRelease[];
    expect(sourceReleasesForCourse(releases, "course-a").map((release) => release.id)).toEqual(["source-a"]);
    expect(sourceReleasesForCourse(releases, "")).toEqual([]);
  });

  it("navigates to the submitted import from either workspace shell", async () => {
    const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    const handlers = [...source.matchAll(/onSubmitted=\{\(record\) => \{([^}]*)\}\}/g)].map((match) => match[1] ?? "");

    expect(handlers).toHaveLength(2);
    expect(handlers.every((handler) => handler.includes("rememberImport(record)") && handler.includes("trackImport(record.id)"))).toBe(true);
  });
});

describe("saved lesson navigation", () => {
  it("starts the same lazy reading-module import on learn entry and shares it with Suspense rendering", async () => {
    const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    expect(source).toContain("let explanationPanelLoad: Promise<ExplanationPanelModule> | undefined");
    expect(source).toContain("return explanationPanelLoad ??= import(\"./ExplanationPanel.js\")");
    expect(source).toContain("const ExplanationPanel = lazy(() => preloadExplanationPanel()");
    expect(source).toContain('if (mode === "learn") void preloadExplanationPanel().catch(() => undefined)');
    expect(source).toContain('const ReviewWorkspace = lazy(() => import("./ReviewWorkspace.js")');
    expect(source).toContain('const StudioWorkspace = lazy(() => import("./StudioWorkspace.js")');
  });

  it("starts current image loading without waiting for the page lesson and schedules next before previous", async () => {
    const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    expect(source).toContain('imageResources.load(indexedPage.imageUrl, "high")');
    const prefetchStart = source.indexOf("const prefetchPage = useCallback");
    const prefetchEnd = source.indexOf("useEffect(() => {\n    if (!release || !indexedPage || release.lifecycle", prefetchStart);
    const prefetch = source.slice(prefetchStart, prefetchEnd);
    expect(prefetch).toContain("settlePagePrefetch(snapshotRead.promise, image");
    expect(prefetch).toContain("finally {");
    expect(prefetch).toContain("snapshotRead.release()");
    expect(source).toContain("new BoundedPagePrefetchQueue(2)");
    expect(source).toContain("prefetchPage(pageIndex + 1)");
    expect(source).toContain("prefetchPage(pageIndex - 1)");
    expect(source).toContain("onMouseEnter={() => onPrefetchPage(index)} onFocus={() => onPrefetchPage(index)}");
  });

  it("keeps the rendered image tied to its URL while using the learn-only decoded image cache", async () => {
    const source = await readFile(new URL("./SlideViewer.tsx", import.meta.url), "utf8");
    expect(source).toContain("imageResources?: ImageResourceCache");
    expect(source).toContain("key={`${imageUrl}:${imageAttempt}`}");
    expect(source).toContain("currentImageStatus?.state === \"ready\" ? imageUrl : undefined");
    expect(source).toContain("src={imageSource}");
    expect(source).toContain("if (!imageResources || !imageUrl) return");
    expect(source).toContain('data-action="slide-image-retry"');
    expect(source).toContain('style={{ pointerEvents: "auto" }}');
    expect(source).not.toContain("原图载入失败。");
  });

  it("shows formal page read failures with same-page retry and shares the image cache with Studio", async () => {
    const appSource = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    const studioSource = await readFile(new URL("./StudioWorkspace.tsx", import.meta.url), "utf8");

    expect(appSource).toContain("currentFormalPageError ? <><span>{currentFormalPageError.message}</span><button type=\"button\" onClick={() => setFormalPageReload((value) => value + 1)}>重试</button></>");
    expect(appSource).toContain("imageResources={imageResources} rightCollapsed={rightCollapsed}");
    expect(studioSource).toContain("imageResources: ImageResourceCache;");
    expect(studioSource).toContain("<SlideViewer imageUrl={workingPage.imageUrl} title={workingPage.title} value={view} onChange={setView} imageResources={imageResources} />");
  });

  it("keeps a bounded page snapshot cache scoped by release and rejects stale response identities", () => {
    const cache = new Map();
    const first = candidateDraft("release-a", "page-a", "First").page;
    const refreshed = candidateDraft("release-a", "page-a", "Updated").page;
    const next = rememberPageSnapshot(cache, "release-a", first, 2);
    const refreshedCache = rememberPageSnapshot(next, "release-a", refreshed, 2);
    const boundedCache = rememberPageSnapshot(refreshedCache, "release-a", candidateDraft("release-a", "page-b", "B").page, 2);
    const evictedCache = rememberPageSnapshot(boundedCache, "release-a", candidateDraft("release-a", "page-c", "C").page, 2);

    expect(cache.size).toBe(0);
    expect(refreshedCache.get(pageSnapshotCacheKey("release-a", "page-a"))?.contentHash).not.toBe(next.get(pageSnapshotCacheKey("release-a", "page-a"))?.contentHash);
    expect(evictedCache.size).toBe(2);
    expect(evictedCache.has(pageSnapshotCacheKey("release-a", "page-a"))).toBe(false);
    expect(evictedCache.has(pageSnapshotCacheKey("release-b", "page-a"))).toBe(false);
    expect(isCurrentPageSnapshot({ releaseId: "release-a", pageId: "page-old" }, { releaseId: "release-a", pageId: "page-new" }, { releaseId: "release-a", pageId: "page-old" })).toBe(false);
    expect(isCurrentPageSnapshot({ releaseId: "release-a", pageId: "page-new" }, { releaseId: "release-a", pageId: "page-new" }, { releaseId: "release-a", pageId: "page-new" })).toBe(true);
    expect(pageSnapshotResponseState({ releaseId: "release-a", pageId: "page-old" }, { releaseId: "release-a", pageId: "page-new" }, { releaseId: "release-a", pageId: "page-old" })).toBe("stale");
    expect(pageSnapshotResponseState({ releaseId: "release-a", pageId: "page-new" }, { releaseId: "release-a", pageId: "page-new" }, { releaseId: "release-b", pageId: "page-new" })).toBe("mismatch");
    expect(pageSnapshotResponseState({ releaseId: "release-a", pageId: "page-new" }, { releaseId: "release-a", pageId: "page-new" }, { releaseId: "release-a", pageId: "page-new" })).toBe("match");
  });

  it("cleans up only its own pending read and permits a retry after failure", async () => {
    const requests = new Map();
    const older = deferred<string>();
    const replacement = deferred<string>();
    const key = pageSnapshotCacheKey("release-a", "page-a");
    let oldSignal: AbortSignal | undefined;
    let readCount = 0;
    const oldRequest = readOnce(requests, key, (signal) => { readCount += 1; oldSignal = signal; return older.promise; });
    const foregroundReader = readOnce(requests, key, () => { readCount += 1; return older.promise; });
    expect(foregroundReader.promise).toBe(oldRequest.promise);
    await Promise.resolve();
    expect(readCount).toBe(1);

    oldRequest.release();
    expect(oldSignal?.aborted).toBe(false);
    foregroundReader.release();
    expect(oldSignal?.aborted).toBe(true);

    const currentRequest = readOnce(requests, key, () => replacement.promise);
    older.resolve("old result");
    await expect(oldRequest.promise).resolves.toBe("old result");
    expect(requests.get(key)?.promise).toBe(currentRequest.promise);

    replacement.resolve("current result");
    await expect(currentRequest.promise).resolves.toBe("current result");
    expect(requests.has(key)).toBe(false);

    const failedRequest = readOnce(requests, key, () => Promise.reject(new Error("temporary read failure")));
    await expect(failedRequest.promise).rejects.toThrow("temporary read failure");
    failedRequest.release();
    const retriedRequest = readOnce(requests, key, () => Promise.resolve("retried result"));
    await expect(retriedRequest.promise).resolves.toBe("retried result");
    retriedRequest.release();
  });

  it("marks failed update pages until a later same-version task completes them, even when old pages remain readable", () => {
    const makePage = (id: string, readable: boolean) => ({
      id, pageNumber: 1, title: id, imageUrl: "/page.png", anchors: [], atoms: [],
      blocks: readable ? [{ id: `${id}:core`, kind: "core", markdown: "Readable text", sourceAnchorIds: [], atomIds: [] }] : [],
      coverageRequirements: [], coverageClaims: [], quality: { highRiskCoverage: 0, generalCoverage: 0, mathValid: true, publishable: readable, issues: [] }
    }) as unknown as PageLesson;
    const material = { id: "material-a", pageIds: ["material-a:page:1"], pages: [makePage("material-a:page:1", false)], lifecycle: "draft_source" } as unknown as CourseRelease;
    const failed = { id: "failed-task", workspaceId: "personal", originalName: "source.pdf", state: "ready", generationState: "failed", createdAt: "2026-01-01T00:00:00Z", materialVersionId: material.id, pageIds: material.pageIds, generationFailedPageIds: [material.pageIds[0]!] } as ImportTaskSummary;
    const recovered = { id: "recovery-task", workspaceId: "personal", originalName: "source.pdf", state: "ready", generationState: "completed", createdAt: "2026-01-02T00:00:00Z", materialVersionId: material.id, pageIds: material.pageIds, generationCompletedPageIds: [material.pageIds[0]!] } as ImportTaskSummary;

    expect(isUnresolvedTaskFailure(failed, [failed], [material])).toBe(true);
    expect(isUnresolvedTaskFailure(failed, [failed, recovered], [material])).toBe(false);
    const readableBase = { ...material, id: "readable-base", lifecycle: "published", pages: [makePage(material.pageIds[0]!, true)] } as unknown as CourseRelease;
    const candidateWithReadableBase = { ...material, candidateBaseReleaseId: readableBase.id } as CourseRelease;
    expect(isUnresolvedTaskFailure(failed, [failed], [candidateWithReadableBase, readableBase])).toBe(true);
    expect(isUnresolvedTaskFailure({ ...failed, materialVersionId: undefined, pageIds: ["unknown-page"] }, [failed], [material])).toBe(false);
  });

  it("lets an explicit lesson link take precedence over a task left in local storage", () => {
    expect(resolveActiveImportId("#mode=learn&release=release-1&page=4", "old-import")).toBeUndefined();
  });

  it("keeps an explicit task link and restores a saved task when there is no lesson route", () => {
    expect(resolveActiveImportId("#release=release-1&page=4&import=linked-import", "old-import")).toBe("linked-import");
    expect(resolveActiveImportId("#mode=learn", "saved-import")).toBe("saved-import");
  });

  it("starts an explicit release read independently of the index and leaves unknown links on their requested ID", async () => {
    const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    const directReadStart = source.indexOf("readOnce(releaseRequests.current, releaseId");
    const directReadEnd = source.indexOf("}, [releaseId, explicitReleaseReload]);", directReadStart);
    const directReadEffect = source.slice(directReadStart, directReadEnd);

    expect(source).toContain("useState(!initialNavigation.current.releaseId)");
    expect(directReadStart).toBeGreaterThanOrEqual(0);
    expect(directReadEffect).not.toContain("loading");
    expect(directReadEffect).toContain("loaded.id !== releaseId");
    expect(directReadEffect).not.toContain("defaultRelease");
    expect(directReadEffect).toContain("api.release(releaseId, { signal })");
    expect(source).toContain("if (!initialNavigation.current.releaseId) setReleaseId((current) => current || defaultRelease(items)?.id || \"\")");
    expect(source).toContain("snapshotRead = readCandidateSnapshotOnce(candidateSnapshotRequests.current, release.id, page.id)");
    expect(source).toContain("readCurrentDraft: (signal, confirm) => api.draftSnapshot(page.id, { signal, releaseId: release.id, confirm })");
    expect(source).toContain("release-index-retry");
    expect(source).toContain("workspace-tree-retry");
    expect(source).toContain("api.releases({ signal })");
    expect(source).toContain("api.workspaceTree(undefined, { signal })");
    expect(source).toContain("setReleaseIndexError(reason instanceof Error ? reason.message : \"无法读取课程列表\")");
    expect(source).toContain("setTreeError(reason instanceof Error ? reason.message : \"无法读取课程目录\")");
    expect(source).toContain("setFormalPageError({ key: cacheKey, message: reason instanceof Error ? reason.message : \"无法载入当前课程页面\" })");
  });

  it("preserves a detailed requested release when the late index contains a summary or omits it", () => {
    const detailed = { id: "requested", pages: [{ id: "requested:1" }, { id: "requested:2" }, { id: "requested:3" }, { id: "requested:4" }] } as unknown as CourseRelease;
    const indexSummary = { id: "requested", pages: [{ id: "requested:1" }] } as unknown as CourseRelease;
    const other = { id: "other", pages: [] } as unknown as CourseRelease;
    const loaded = mergeReleaseIndex([], [detailed], new Set(["requested"]));
    const lateIndex = mergeReleaseIndex(loaded, [indexSummary, other], new Set(["requested"]));

    expect(lateIndex.find((item) => item.id === "requested")).toBe(detailed);
    expect(lateIndex.find((item) => item.id === "requested")?.pages[3]?.id).toBe("requested:4");
    expect(lateIndex.map((item) => item.id)).toEqual(["requested", "other"]);

    const omittedIndex = mergeReleaseIndex(loaded, [other], new Set(["requested"]));
    expect(omittedIndex.find((item) => item.id === "requested")).toBe(detailed);
  });

  it("keeps the existing published default when navigation has no requested release", () => {
    const releases = [
      { id: "old", lifecycle: "published", version: 1, publishedAt: "2026-01-01T00:00:00.000Z" },
      { id: "latest", lifecycle: "published", version: 2, publishedAt: "2026-02-01T00:00:00.000Z" },
      { id: "draft", lifecycle: "draft_source", version: 99, publishedAt: "2026-03-01T00:00:00.000Z" }
    ] as CourseRelease[];
    expect(defaultRelease(releases)?.id).toBe("latest");
    expect(defaultRelease([{ ...releases[2]! }])?.id).toBe("draft");
  });

  it("treats only the matching ready candidate snapshot as generated", () => {
    const draft = { sourceReleaseId: "source", pageId: "page", page: { id: "page" }, status: "ready" } as unknown as LessonDraft;
    expect(isReadyCandidateSnapshot(draft, "source", "page")).toBe(true);
    expect(isReadyCandidateSnapshot({ ...draft, status: "needs_review" }, "source", "page")).toBe(false);
    expect(isReadyCandidateSnapshot(draft, "other-source", "page")).toBe(false);
    expect(isReadyCandidateSnapshot(draft, "source", "other-page")).toBe(false);
    expect(isReadyCandidateSnapshot({ ...draft, pageId: "other-page" }, "source", "page")).toBe(false);
  });

  it("surfaces candidate snapshot identity mismatches as errors", async () => {
    const valid = candidateDraft("release-a", "page-a", "Cached lesson");
    const mismatches = [
      { ...valid, sourceReleaseId: "release-b" },
      { ...valid, pageId: "page-b" },
      { ...valid, page: { ...valid.page, id: "page-b" } }
    ];

    for (const draft of mismatches) {
      let preview: CandidatePreviewState | undefined;
      const setPreview = (next: CandidatePreviewState | undefined | ((current: CandidatePreviewState | undefined) => CandidatePreviewState | undefined)) => {
        preview = typeof next === "function" ? next(preview) : next;
      };
      beginCandidatePreviewLoad({
        releaseId: "release-a",
        pageId: "page-a",
        readSnapshot: () => Promise.resolve(draft),
        readCurrentDraft: vi.fn(() => Promise.resolve(valid)),
        isActive: () => true,
        setPreview
      });
      await flushPromises();
      expect(preview?.error).toContain("身份错配");
      expect(preview?.error).not.toContain("尚未生成");
    }
  });
});

describe("candidate preview reconciliation", () => {
  it("shows the ready snapshot before a deferred one-page reconcile completes", async () => {
    const snapshot = deferred<LessonDraft>();
    const reconciliation = deferred<LessonDraft>();
    let preview: CandidatePreviewState | undefined;
    const setPreview = (next: CandidatePreviewState | undefined | ((current: CandidatePreviewState | undefined) => CandidatePreviewState | undefined)) => {
      preview = typeof next === "function" ? next(preview) : next;
    };
    const readCurrentDraft = vi.fn(() => reconciliation.promise);

    beginCandidatePreviewLoad({
      releaseId: "release-a",
      pageId: "page-a",
      readSnapshot: () => snapshot.promise,
      readCurrentDraft,
      isActive: () => true,
      setPreview
    });
    expect(preview).toEqual({ pageId: "page-a" });

    snapshot.resolve(candidateDraft("release-a", "page-a", "Snapshot text"));
    await flushPromises();

    expect(preview?.page?.lessonSections?.[0]?.markdown).toBe("Snapshot text");
    expect(preview?.generatedReady).toBe(true);
    expect(readCurrentDraft).toHaveBeenCalledOnce();

    reconciliation.resolve(candidateDraft("release-a", "page-a", "ReadWeave text"));
    await flushPromises();
    expect(preview?.page?.lessonSections?.[0]?.markdown).toBe("ReadWeave text");
  });

  it("reconciles the active page again on focus and uses the returned ready page", async () => {
    const snapshot = deferred<LessonDraft>();
    let preview: CandidatePreviewState | undefined;
    const setPreview = (next: CandidatePreviewState | undefined | ((current: CandidatePreviewState | undefined) => CandidatePreviewState | undefined)) => {
      preview = typeof next === "function" ? next(preview) : next;
    };
    const readCurrentDraft = vi.fn<(signal: AbortSignal, confirm: boolean) => Promise<LessonDraft>>()
      .mockResolvedValueOnce(candidateDraft("release-a", "page-a", "Initial reconcile"))
      .mockResolvedValueOnce(candidateDraft("release-a", "page-a", "Edited in ReadWeave"));
    const reconcileOnFocus = beginCandidatePreviewLoad({
      releaseId: "release-a",
      pageId: "page-a",
      readSnapshot: () => snapshot.promise,
      readCurrentDraft,
      isActive: () => true,
      setPreview
    });

    snapshot.resolve(candidateDraft("release-a", "page-a", "Saved snapshot"));
    await flushPromises();
    expect(preview?.page?.lessonSections?.[0]?.markdown).toBe("Initial reconcile");
    expect(readCurrentDraft.mock.calls[0]?.[1]).toBe(false);

    reconcileOnFocus(new Event("focus"));
    await flushPromises();
    expect(readCurrentDraft).toHaveBeenCalledTimes(2);
    expect(readCurrentDraft.mock.calls[1]?.[1]).toBe(true);
    expect(preview?.page?.lessonSections?.[0]?.markdown).toBe("Edited in ReadWeave");
    expect(preview?.page?.quality.publishable).toBe(false);

    const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    expect(source).toContain('window.addEventListener("focus", reconcileCandidatePreview)');
    expect(source).toContain('window.removeEventListener("focus", reconcileCandidatePreview)');
  });

  it("ignores a late reconcile result after navigation moves to another page", async () => {
    const oldSnapshot = deferred<LessonDraft>();
    const oldReconciliation = deferred<LessonDraft>();
    const newReconciliation = deferred<LessonDraft>();
    let currentPageId = "page-old";
    let preview: CandidatePreviewState | undefined;
    const setPreview = (next: CandidatePreviewState | undefined | ((current: CandidatePreviewState | undefined) => CandidatePreviewState | undefined)) => {
      preview = typeof next === "function" ? next(preview) : next;
    };

    beginCandidatePreviewLoad({
      releaseId: "release-a",
      pageId: "page-old",
      readSnapshot: () => oldSnapshot.promise,
      readCurrentDraft: () => oldReconciliation.promise,
      isActive: () => currentPageId === "page-old",
      setPreview
    });
    oldSnapshot.resolve(candidateDraft("release-a", "page-old", "Old snapshot"));
    await flushPromises();

    currentPageId = "page-new";
    beginCandidatePreviewLoad({
      releaseId: "release-a",
      pageId: "page-new",
      readSnapshot: () => Promise.resolve(candidateDraft("release-a", "page-new", "New snapshot")),
      readCurrentDraft: () => newReconciliation.promise,
      isActive: () => currentPageId === "page-new",
      setPreview
    });
    await flushPromises();
    newReconciliation.resolve(candidateDraft("release-a", "page-new", "New current text"));
    await flushPromises();
    expect(preview?.pageId).toBe("page-new");

    oldReconciliation.resolve(candidateDraft("release-a", "page-old", "Late old text"));
    await flushPromises();
    expect(preview?.pageId).toBe("page-new");
    expect(preview?.page?.lessonSections?.[0]?.markdown).toBe("New current text");
  });

  it("keeps the readable snapshot and preserves the API reason when reconcile fails", async () => {
    const snapshot = deferred<LessonDraft>();
    let preview: CandidatePreviewState | undefined;
    const setPreview = (next: CandidatePreviewState | undefined | ((current: CandidatePreviewState | undefined) => CandidatePreviewState | undefined)) => {
      preview = typeof next === "function" ? next(preview) : next;
    };

    beginCandidatePreviewLoad({
      releaseId: "release-a",
      pageId: "page-a",
      readSnapshot: () => snapshot.promise,
      readCurrentDraft: () => Promise.reject(new Error("GET /drafts/page-a: 401 Unauthorized (request id req-candidate-401)")),
      isActive: () => true,
      setPreview
    });
    snapshot.resolve(candidateDraft("release-a", "page-a", "Still visible"));
    await flushPromises();

    expect(preview?.page?.lessonSections?.[0]?.markdown).toBe("Still visible");
    expect(preview?.notice).toContain("401 Unauthorized (request id req-candidate-401)");
    expect(preview?.notice).toContain("上次可读讲解");
  });

  it("keeps a cached candidate page when the current draft has a mismatched identity", async () => {
    const snapshot = candidateDraft("release-a", "page-a", "Last readable lesson");
    const mismatchedCurrent = { ...candidateDraft("release-a", "page-b", "Wrong page"), pageId: "page-b" };
    let preview: CandidatePreviewState | undefined;
    const setPreview = (next: CandidatePreviewState | undefined | ((current: CandidatePreviewState | undefined) => CandidatePreviewState | undefined)) => {
      preview = typeof next === "function" ? next(preview) : next;
    };

    beginCandidatePreviewLoad({
      releaseId: "release-a",
      pageId: "page-a",
      readSnapshot: () => Promise.resolve(snapshot),
      readCurrentDraft: () => Promise.resolve(mismatchedCurrent),
      isActive: () => true,
      setPreview
    });
    await flushPromises();

    expect(preview?.page?.lessonSections?.[0]?.markdown).toBe("Last readable lesson");
    expect(preview?.notice).toContain("身份错配");
    expect(preview?.notice).toContain("上次可读讲解");
  });
});

describe("pending learning session writes", () => {
  it("writes queued patches to their own sessions and restores A's latest page and zoom", async () => {
    const sessionA: LearningSession = {
      id: "session-a", courseReleaseId: "release-a", currentPageId: "release-a:page:1",
      explanationScroll: 0, zoom: 1.5, panX: 0, panY: 0, updatedAt: "2026-09-29T00:00:00.000Z"
    };
    const sessionB: LearningSession = {
      id: "session-b", courseReleaseId: "release-b", currentPageId: "release-b:page:1",
      explanationScroll: 0, zoom: 2.25, panX: 0, panY: 0, updatedAt: "2026-09-29T00:00:00.000Z"
    };
    const persisted = new Map([[sessionA.id, sessionA], [sessionB.id, sessionB]]);
    const patchA = { currentPageId: "release-a:page:2", zoom: 1.75 };
    const patchB = { currentPageId: "release-b:page:3", zoom: 2.25 };
    const pending = new Map<string, Partial<LearningSession>>([[sessionA.id, patchA], [sessionB.id, patchB]]);
    let finishA!: () => void;
    const updateSession = vi.fn((sessionId: string, patch: Partial<LearningSession>): Promise<LearningSession> => {
      const updated = { ...persisted.get(sessionId)!, ...patch, updatedAt: "2026-09-29T00:01:00.000Z" };
      if (sessionId === sessionA.id) {
        return new Promise((resolve) => {
          finishA = () => { persisted.set(sessionId, updated); resolve(updated); };
        });
      }
      persisted.set(sessionId, updated);
      return Promise.resolve(updated);
    });
    let currentSessionId = sessionB.id;
    let displayedSession = sessionB;
    const onCurrentSessionUpdated = vi.fn((updated: LearningSession) => { displayedSession = updated; });

    const writingA = flushNextSessionPatch(pending, updateSession, () => currentSessionId, onCurrentSessionUpdated);
    expect(updateSession).toHaveBeenNthCalledWith(1, sessionA.id, patchA);
    expect(pending.has(sessionA.id)).toBe(false);
    finishA();
    await writingA;
    expect(persisted.get(sessionA.id)).toMatchObject(patchA);
    expect(displayedSession).toBe(sessionB);
    expect(onCurrentSessionUpdated).not.toHaveBeenCalled();

    await flushNextSessionPatch(pending, updateSession, () => currentSessionId, onCurrentSessionUpdated);
    expect(updateSession).toHaveBeenNthCalledWith(2, sessionB.id, patchB);
    expect(persisted.get(sessionB.id)).toMatchObject(patchB);
    expect(displayedSession).toMatchObject({ id: sessionB.id, ...patchB });
    expect(pending.size).toBe(0);

    currentSessionId = sessionA.id;
    displayedSession = { ...persisted.get(sessionA.id)! };
    expect(displayedSession).toMatchObject({ id: sessionA.id, currentPageId: patchA.currentPageId, zoom: 1.75 });
  });
});

describe("ReadWeave deep-link click flow", () => {
  it("opens the user-initiated tab before verification resolves, then navigates only to a verified link", async () => {
    const order: string[] = [];
    const replace = vi.fn();
    const close = vi.fn();
    const popup = { opener: {} as Window | null, location: { replace }, close } as unknown as Window;
    const openWindow = vi.fn(() => { order.push("open"); return popup; });
    let finishVerification!: (link: { url: string; verified: boolean }) => void;
    const loadLink = vi.fn((noteId: string) => {
      order.push(`verify:${noteId}`);
      return new Promise<{ url: string; verified: boolean }>((resolve) => { finishVerification = resolve; });
    });

    const pending = openVerifiedReadWeaveDeepLink("note/1", openWindow, loadLink);

    expect(order).toEqual(["open", "verify:note/1"]);
    expect(popup.opener).toBeNull();
    finishVerification({ url: "https://readweave.example/#root/note/1", verified: true });
    await expect(pending).resolves.toBeUndefined();
    expect(replace).toHaveBeenCalledWith("https://readweave.example/#root/note/1");
    expect(close).not.toHaveBeenCalled();
  });

  it("closes the reserved tab when verification rejects the target or the browser blocks popups", async () => {
    const replace = vi.fn();
    const close = vi.fn();
    const popup = { opener: null, location: { replace }, close } as unknown as Window;
    await expect(openVerifiedReadWeaveDeepLink("note-1", () => popup, async () => ({ url: "https://readweave.example/", verified: false })))
      .rejects.toThrow("尚未验证");
    expect(close).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();

    const loadLink = vi.fn();
    await expect(openVerifiedReadWeaveDeepLink("note-1", () => null, loadLink)).rejects.toThrow("阻止打开");
    expect(loadLink).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function candidateDraft(releaseId: string, pageId: string, markdown: string): LessonDraft {
  const page = {
    id: pageId,
    pageNumber: 9,
    title: "Partitioning",
    lessonSections: [{ id: `${pageId}:main`, kind: "main_content", title: "正文", markdown, items: [] }],
    quality: { publishable: false, issues: ["OFFLINE_AUDIT"] }
  } as unknown as PageLesson;
  return { sourceReleaseId: releaseId, pageId, status: "ready", page } as LessonDraft;
}
