import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CourseRelease, LearningSession, LessonDraft, PageLesson, WorkspaceTree } from "@course-os/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "./api.js";
import type { ImportTaskSummary } from "./types.js";
import { beginCandidatePreviewLoad, beginFormalPageLoad, beginImportCostRead, buildGlobalSearchResults, candidatePreviewAfterReadFailure, currentMaterialReleases, defaultRelease, flushNextSessionPatch, formalPageAfterReadFailure, isGlobalSearchShortcut, isReadyCandidateSnapshot, isTerminalPageReadError, isUnresolvedTaskFailure, mergeReleaseIndex, normalizeSidebarWidth, openVerifiedReadWeaveDeepLink, rememberPageSnapshot, pageCacheAfterPrefetch, pageCacheAfterReadFailure, pageSnapshotCacheKey, isCurrentPageSnapshot, pageSnapshotResponseState, readOnce, resolveActiveImportId, SIDEBAR_DEFAULT_WIDTH, sourceReleasesForCourse, StartupReadNotices, type CandidatePreviewState, type SharedReadLease } from "./App.js";

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

describe("import activity cost reads", () => {
  it("does not block plan publication, deduplicates a slow cost read, and preserves confirmed costs on rejection", async () => {
    const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    const dock = source.slice(source.indexOf("function ImportActivityDock"), source.indexOf("function ImportProgress"));
    expect(dock).not.toContain("Promise.all");
    expect(dock.indexOf("readCosts(`material:")).toBeLessThan(dock.indexOf("const planResult = await api.generationPlan"));
    expect(dock).toContain("setPlan(planResult.plan)");
    expect(dock).toContain("setActiveJobs(planResult.activeJobs");
    expect(dock).toContain("timer = window.setTimeout(() => void refresh(), 2000)");

    const response = deferred<{ entries: string[] }>();
    const inFlight = new Map<string, Promise<unknown>>();
    const confirmedCosts = ["confirmed-cost"];
    let visibleCosts = confirmedCosts;
    let costUnavailable = false;
    const read = vi.fn(() => response.promise);
    const publishCosts = (result: { entries: string[] }) => { visibleCosts = result.entries; costUnavailable = false; };
    const markCostUnavailable = () => { costUnavailable = true; };
    beginImportCostRead(inFlight, "material:v1", read, () => true, publishCosts, markCostUnavailable);
    beginImportCostRead(inFlight, "material:v1", read, () => true, publishCosts, markCostUnavailable);
    let planPublished = false;
    await Promise.resolve().then(() => { planPublished = true; });
    expect(planPublished).toBe(true);
    expect(visibleCosts).toBe(confirmedCosts);
    await flushPromises();
    expect(read).toHaveBeenCalledOnce();

    response.reject(new Error("504 cost timeout"));
    await flushPromises();
    expect(costUnavailable).toBe(true);
    expect(visibleCosts).toBe(confirmedCosts);
    expect(source).toContain("成本暂不可读");
    expect(source).toContain("显示上次确认值");
  });

  it("ignores a late cost response after the activity view has left", async () => {
    const response = deferred<string>();
    const inFlight = new Map<string, Promise<unknown>>();
    let active = true;
    const publish = vi.fn();
    const fail = vi.fn();
    beginImportCostRead(inFlight, "job:j1", () => response.promise, () => active, publish, fail);
    active = false;
    response.resolve("late result");
    await flushPromises();
    expect(publish).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });
});

describe("global search and startup notices", () => {
  it("opens and focuses global search for Ctrl/Cmd+K, using the material's current release", async () => {
    expect(isGlobalSearchShortcut({ metaKey: true, ctrlKey: false, key: "k" })).toBe(true);
    expect(isGlobalSearchShortcut({ metaKey: false, ctrlKey: true, key: "K" })).toBe(true);
    expect(isGlobalSearchShortcut({ metaKey: false, ctrlKey: false, key: "k" })).toBe(false);

    const [appSource, treeSource] = await Promise.all([
      readFile(new URL("./App.tsx", import.meta.url), "utf8"),
      readFile(new URL("./CourseTree.tsx", import.meta.url), "utf8")
    ]);
    expect(appSource).toContain("setUtilityPanel(\"search\")");
    expect(appSource).toContain("setGlobalSearchFocusRequest((current) => current + 1)");
    expect(appSource).toContain('if (panel === "search") searchInput.current?.focus();');
    expect(treeSource).not.toContain('document.addEventListener("keydown"');

    const releases = [
      { id: "published-old", courseId: "course-a", moduleId: "module-a", courseTitle: "EE680", moduleTitle: "Lecture 1", lifecycle: "published", version: 1, pages: [{ id: "old-page", pageNumber: 4, title: "Eigenvalues" }] },
      { id: "ready-draft", courseId: "course-a", moduleId: "module-a", courseTitle: "EE680", moduleTitle: "Lecture 1", lifecycle: "draft_source", version: 2, pages: [{ id: "current-page", pageNumber: 4, title: "Eigenvalues" }] }
    ] as CourseRelease[];
    const tree = {
      courses: [{ id: "course-a", kind: "course", children: [{ id: "material-a", kind: "material", currentReleaseId: "ready-draft", children: [] }] }],
      rootMaterials: []
    } as unknown as WorkspaceTree;

    expect(buildGlobalSearchResults(releases, tree, "eigenvalues").map(({ release, page }) => [release.id, page.id])).toEqual([["ready-draft", "current-page"]]);
  });

  it("renders both startup notices without a duplicate React key warning", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const markup = renderToStaticMarkup(createElement(StartupReadNotices, {
        releaseIndexError: "索引暂不可用",
        releaseIndexLoading: false,
        onRetryReleaseIndex: vi.fn(),
        treeError: "目录暂不可用",
        treeLoading: false,
        onRetryTree: vi.fn()
      }));
      expect(markup).toContain("索引暂不可用");
      expect(markup).toContain("目录暂不可用");
      expect(error.mock.calls.flat().join(" ")).not.toMatch(/unique.*key/i);
    } finally {
      error.mockRestore();
    }
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
    expect(appSource).toMatch(/<div className="visual-column">\{contentTerminalError\s*\? <div className="empty-inline" role="alert">/);
    expect(appSource).toContain(": <SlideViewer imageUrl={page.imageUrl}");
    expect(appSource).toContain("const canShowContent = contentReady && !contentTerminalError;");
    expect(appSource).toContain("{canShowContent ? <Suspense");
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
    expect(source).toContain("defaultRelease(items, initialTree)?.id");
    expect(source).toContain("const treeRead = initialNavigation.current.releaseId");
    expect(source).toContain("snapshotRead = readCandidateSnapshotOnce(candidateSnapshotRequests.current, release.id, page.id)");
    expect(source).toContain("readCurrentDraft: (signal, confirm) => api.draftSnapshot(page.id, { signal, releaseId: release.id, confirm })");
    expect(source).toContain("release-index-retry");
    expect(source).toContain("workspace-tree-retry");
    expect(source).toContain("api.releases({ signal })");
    expect(source).toContain("api.workspaceTree(undefined, { signal })");
    expect(source).toContain("setReleaseIndexError(reason instanceof Error ? reason.message : \"无法读取课程列表\")");
    expect(source).toContain("setTreeError(reason instanceof Error ? reason.message : \"无法读取课程目录\")");
    expect(source).toContain("formalPageAfterReadFailure(pageCacheRef.current.get(cacheKey)?.page, reason)");
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

  it("uses each material's exact current release pointer and does not filter readable drafts by lifecycle", () => {
    const releases = [
      { id: "old", courseId: "course-a", moduleId: "module-a", lifecycle: "published", version: 1, publishedAt: "2026-01-01T00:00:00.000Z" },
      { id: "latest", courseId: "course-a", moduleId: "module-a", lifecycle: "published", version: 2, publishedAt: "2026-02-01T00:00:00.000Z" },
      { id: "draft", courseId: "course-a", moduleId: "module-a", lifecycle: "draft_source", version: 99, publishedAt: "2026-03-01T00:00:00.000Z" },
      { id: "other-course", courseId: "course-b", moduleId: "module-a", lifecycle: "published", version: 1, publishedAt: "2026-01-15T00:00:00.000Z" }
    ] as CourseRelease[];
    const tree = {
      courses: [{ id: "course-a", kind: "course", children: [{ id: "material-a", kind: "material", currentReleaseId: "draft", releaseId: "latest", children: [] }] }],
      rootMaterials: []
    } as unknown as WorkspaceTree;

    expect(defaultRelease(releases)?.id).toBe("draft");
    expect(defaultRelease(releases, tree)?.id).toBe("draft");
    expect(currentMaterialReleases(releases, tree).map((release) => release.id)).toEqual(["draft"]);

    const oldReadablePointer = { ...tree, courses: [{ ...tree.courses[0]!, children: [{ ...tree.courses[0]!.children[0]!, currentReleaseId: "old", releaseId: "draft" }] }] };
    expect(defaultRelease(releases, oldReadablePointer)?.id).toBe("old");
    expect(currentMaterialReleases(releases).map((release) => release.id).sort()).toEqual(["draft", "other-course"]);

    const confirmedEmptyTree = { courses: [], rootMaterials: [] } as unknown as WorkspaceTree;
    expect(currentMaterialReleases(releases, confirmedEmptyTree)).toEqual([]);
    expect(defaultRelease(releases, confirmedEmptyTree)).toBeUndefined();

    const archivedTree = {
      courses: [{ id: "course-a", kind: "course", children: [{ id: "material-a", kind: "material", currentReleaseId: "latest", releaseId: "latest", archived: true, children: [] }] }],
      rootMaterials: []
    } as unknown as WorkspaceTree;
    expect(currentMaterialReleases(releases, archivedTree)).toEqual([]);
  });

  it("turns PAGE_NOT_GENERATED and PAGE_NOT_READY into Studio guidance without retry errors", () => {
    const cases = [
      ["PAGE_NOT_GENERATED", "这页尚未生成", false],
      ["PAGE_NOT_READY", "副本尚未就绪", true]
    ] as const;
    for (const [code, message, retryable] of cases) {
      const preview = candidatePreviewAfterReadFailure(undefined, "page-a", new ApiRequestError(message, code, 409, retryable));
      expect(preview).toMatchObject({ pageId: "page-a", unavailable: code === "PAGE_NOT_GENERATED" ? "not_generated" : "not_ready" });
      expect(preview.error).toBeUndefined();
      expect(preview.notice).toContain(message);
      expect(preview.notice).toContain("制作模式");
    }

    const cachedPage = candidateDraft("release-a", "page-a", "上次可读正文").page;
    const preserved = candidatePreviewAfterReadFailure(
      { pageId: "page-a", page: cachedPage, generatedReady: true },
      "page-a",
      new ApiRequestError("副本尚未就绪", "PAGE_NOT_READY", 409, true)
    );
    expect(preserved.page).toBe(cachedPage);
    expect(preserved.notice).toContain("副本尚未就绪");
    expect(preserved.unavailable).toBe("not_ready");
    expect(preserved.error).toBeUndefined();
    const laterTransientFailure = candidatePreviewAfterReadFailure(preserved, "page-a", new ApiRequestError("当前 ReadWeave 暂时超时", "READ_DEADLINE_EXCEEDED", 504, true));
    expect(laterTransientFailure.page).toBe(cachedPage);
    expect(laterTransientFailure.unavailable).toBeUndefined();
    expect(laterTransientFailure.notice).toContain("当前 ReadWeave 暂时超时");
  });

  it("keeps a needs_review candidate out of learning until it is confirmed", async () => {
    const partial = candidateDraft("release-a", "page-a", "partial summary");
    partial.status = "needs_review";
    let preview: CandidatePreviewState | undefined;
    const setPreview = (next: CandidatePreviewState | undefined | ((current: CandidatePreviewState | undefined) => CandidatePreviewState | undefined)) => {
      preview = typeof next === "function" ? next(preview) : next;
    };
    const readCurrentDraft = vi.fn(() => Promise.resolve(candidateDraft("release-a", "page-a", "must not replace")));

    beginCandidatePreviewLoad({ releaseId: "release-a", pageId: "page-a", readSnapshot: () => Promise.resolve(partial), readCurrentDraft, isActive: () => true, setPreview });
    await flushPromises();

    expect(preview?.unavailable).toBe("not_ready");
    expect(preview?.notice).toContain("needs_review");
    expect(readCurrentDraft).not.toHaveBeenCalled();
  });

  it("shows a confirmed summary-only needs_review page with missing-full and actual-question guidance", async () => {
    const partial = needsReviewDraft("release-a", "page-a", "", "已保存的摘要正文", 2);
    let preview: CandidatePreviewState | undefined;
    const setPreview = (next: CandidatePreviewState | undefined | ((current: CandidatePreviewState | undefined) => CandidatePreviewState | undefined)) => {
      preview = typeof next === "function" ? next(preview) : next;
    };
    const readCurrentDraft = vi.fn(() => Promise.resolve(partial));

    beginCandidatePreviewLoad({ releaseId: "release-a", pageId: "page-a", readSnapshot: () => Promise.resolve(partial), readCurrentDraft, isActive: () => true, setPreview });
    await flushPromises();
    const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

    expect(preview?.page).toBe(partial.page);
    expect(preview?.generatedReady).toBe(false);
    expect(preview?.unavailable).toBeUndefined();
    expect(preview?.notice).toContain("完整讲解尚未生成；已有摘要保留");
    expect(preview?.notice).toContain("题库当前有 2 道可用题");
    expect(preview?.notice).not.toContain("待补齐");
    expect(preview?.notice).toContain("无需重试读取，请进入制作模式");
    expect(source).toContain("canShowContent && contentReviewRequired && contentNotice");
    expect(readCurrentDraft).not.toHaveBeenCalled();
  });

  it("shows a confirmed full-only needs_review page while marking the summary missing", async () => {
    const partial = needsReviewDraft("release-a", "page-a", "已保存的完整讲解正文", "", 4);
    let preview: CandidatePreviewState | undefined;
    const setPreview = (next: CandidatePreviewState | undefined | ((current: CandidatePreviewState | undefined) => CandidatePreviewState | undefined)) => {
      preview = typeof next === "function" ? next(preview) : next;
    };
    const readCurrentDraft = vi.fn(() => Promise.resolve(partial));

    beginCandidatePreviewLoad({ releaseId: "release-a", pageId: "page-a", readSnapshot: () => Promise.resolve(partial), readCurrentDraft, isActive: () => true, setPreview });
    await flushPromises();

    expect(preview?.page).toBe(partial.page);
    expect(preview?.generatedReady).toBe(false);
    expect(preview?.notice).toContain("已有完整讲解正文可读；主要内容摘要尚未补齐");
    expect(preview?.notice).not.toContain("完整讲解已保存并可读");
    expect(readCurrentDraft).not.toHaveBeenCalled();
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
      readCurrentDraft: () => Promise.reject(new ApiRequestError("Network temporarily unavailable (request id req-candidate-read)", "NETWORK_ERROR", 0, true)),
      isActive: () => true,
      setPreview
    });
    snapshot.resolve(candidateDraft("release-a", "page-a", "Still visible"));
    await flushPromises();

    expect(preview?.page?.lessonSections?.[0]?.markdown).toBe("Still visible");
    expect(preview?.notice).toContain("Network temporarily unavailable (request id req-candidate-read)");
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

  it("keeps cached candidate text only for transient read failures and clears it for terminal API errors", () => {
    const page = candidateDraft("release-a", "page-a", "Confirmed readable text").page;
    const cached = { pageId: "page-a", page, generatedReady: true } satisfies CandidatePreviewState;
    const temporary = candidatePreviewAfterReadFailure(cached, "page-a", new ApiRequestError("network unavailable", "NETWORK_ERROR", 0, true));
    expect(temporary.page).toBe(page);
    expect(temporary.notice).toContain("network unavailable");
    expect(temporary.error).toBeUndefined();

    for (const error of [
      new ApiRequestError("permission revoked", "ACCESS_DENIED", 403, false),
      new ApiRequestError("authentication required", "AUTHENTICATION_REQUIRED", 401, false),
      new ApiRequestError("release deleted", "RELEASE_NOT_FOUND", 404, false),
      new ApiRequestError("page deleted", "PAGE_NOT_FOUND", 404, false),
      new ApiRequestError("not found", "HTTP_ERROR", 404, false)
    ]) {
      expect(isTerminalPageReadError(error)).toBe(true);
      expect(candidatePreviewAfterReadFailure(cached, "page-a", error)).toMatchObject({ pageId: "page-a", error: expect.any(String) });
      expect(candidatePreviewAfterReadFailure(cached, "page-a", error).page).toBeUndefined();
    }
  });

  it("clears every cached page on authorization denial and only the missing page on confirmed deletion", () => {
    const pageA = candidateDraft("release-a", "page-a", "Restricted A").page;
    const pageB = candidateDraft("release-a", "page-b", "Restricted B").page;
    let cache = rememberPageSnapshot(new Map(), "release-a", pageA);
    cache = rememberPageSnapshot(cache, "release-a", pageB);

    const denied = pageCacheAfterReadFailure(cache, "release-a", "page-a", new ApiRequestError("revoked", "ACCESS_DENIED", 403, false));
    expect(denied.size).toBe(0);

    const deleted = pageCacheAfterReadFailure(cache, "release-a", "page-a", new ApiRequestError("deleted", "PAGE_NOT_FOUND", 404, false));
    expect(deleted.has(pageSnapshotCacheKey("release-a", "page-a"))).toBe(false);
    expect(deleted.has(pageSnapshotCacheKey("release-a", "page-b"))).toBe(true);

    const temporary = pageCacheAfterReadFailure(cache, "release-a", "page-a", new ApiRequestError("timeout", "REQUEST_TIMEOUT", 408, true));
    expect(temporary).toBe(cache);
  });

  it("rejects a queued prefetch commit after terminal cache invalidation", () => {
    const pageA = candidateDraft("release-a", "page-a", "Restricted A").page;
    const pageB = candidateDraft("release-a", "page-b", "Restricted B").page;
    const cache = rememberPageSnapshot(rememberPageSnapshot(new Map(), "release-a", pageA), "release-a", pageB);
    const invalidated = pageCacheAfterReadFailure(cache, "release-a", "page-a", new ApiRequestError("revoked", "ACCESS_DENIED", 403, false));
    const staleCommit = pageCacheAfterPrefetch(invalidated, "release-a", pageB, 7, 8);
    const validCommit = pageCacheAfterPrefetch(invalidated, "release-a", pageB, 8, 8);

    expect(invalidated.size).toBe(0);
    expect(staleCommit.size).toBe(0);
    expect(validCommit.get(pageSnapshotCacheKey("release-a", "page-b"))?.page.id).toBe("page-b");
  });

  it("does not let a late candidate read restore text after a newer terminal denial", async () => {
    const snapshot = deferred<LessonDraft>();
    const lateRead = deferred<LessonDraft>();
    const denial = deferred<LessonDraft>();
    let preview: CandidatePreviewState | undefined;
    let cache = rememberPageSnapshot(new Map(), "release-a", candidateDraft("release-a", "page-a", "Cached text").page);
    cache = rememberPageSnapshot(cache, "release-a", candidateDraft("release-a", "page-b", "Other cached text").page);
    const setPreview = (next: CandidatePreviewState | undefined | ((current: CandidatePreviewState | undefined) => CandidatePreviewState | undefined)) => {
      preview = typeof next === "function" ? next(preview) : next;
    };
    const reconcile = beginCandidatePreviewLoad({
      releaseId: "release-a",
      pageId: "page-a",
      readSnapshot: () => snapshot.promise,
      readCurrentDraft: vi.fn<(signal: AbortSignal, confirm: boolean) => Promise<LessonDraft>>()
        .mockReturnValueOnce(lateRead.promise)
        .mockReturnValueOnce(denial.promise),
      isActive: () => true,
      setPreview,
      onTerminalError: (error) => { cache = pageCacheAfterReadFailure(cache, "release-a", "page-a", error); }
    });
    snapshot.resolve(candidateDraft("release-a", "page-a", "Cached text"));
    await flushPromises();
    reconcile(new Event("focus"));
    denial.reject(new ApiRequestError("permission revoked", "ACCESS_DENIED", 403, false));
    await flushPromises();
    expect(preview?.page).toBeUndefined();
    expect(preview?.error).toContain("permission revoked");
    expect(cache.size).toBe(0);

    lateRead.resolve(candidateDraft("release-a", "page-a", "Late stale text"));
    await flushPromises();
    expect(preview?.page).toBeUndefined();
    expect(preview?.error).toContain("permission revoked");
  });

  it("clears terminal state when a later candidate reconciliation succeeds", async () => {
    let preview: CandidatePreviewState | undefined;
    const setPreview = (next: CandidatePreviewState | undefined | ((current: CandidatePreviewState | undefined) => CandidatePreviewState | undefined)) => {
      preview = typeof next === "function" ? next(preview) : next;
    };
    const readCurrentDraft = vi.fn<(signal: AbortSignal, confirm: boolean) => Promise<LessonDraft>>()
      .mockRejectedValueOnce(new ApiRequestError("permission revoked", "ACCESS_DENIED", 403, false))
      .mockRejectedValueOnce(new ApiRequestError("temporary timeout", "READ_TIMEOUT", 504, true))
      .mockResolvedValueOnce(candidateDraft("release-a", "page-a", "Restored lesson"));
    const reconcile = beginCandidatePreviewLoad({
      releaseId: "release-a",
      pageId: "page-a",
      readSnapshot: () => Promise.resolve(candidateDraft("release-a", "page-a", "Initial snapshot")),
      readCurrentDraft,
      isActive: () => true,
      setPreview
    });
    await flushPromises();
    expect(preview).toMatchObject({ terminal: true, error: expect.any(String) });
    expect(preview?.page).toBeUndefined();

    reconcile(new Event("focus"));
    await flushPromises();
    expect(preview).toMatchObject({ terminal: true, error: expect.stringContaining("permission revoked") });
    expect(preview?.page).toBeUndefined();
    reconcile(new Event("focus"));
    await flushPromises();
    expect(preview).toMatchObject({ terminal: false, generatedReady: true, notice: undefined, error: undefined });
    expect(preview?.page?.lessonSections?.[0]?.markdown).toBe("Restored lesson");
    reconcile.cancel();
  });

  it("keeps a confirmed terminal denial while a manual snapshot retry fails temporarily", async () => {
    let preview: CandidatePreviewState | undefined = { pageId: "page-a", terminal: true, error: "permission revoked" };
    const reconcile = beginCandidatePreviewLoad({
      releaseId: "release-a", pageId: "page-a",
      readSnapshot: () => Promise.reject(new ApiRequestError("temporary timeout", "READ_TIMEOUT", 504, true)),
      readCurrentDraft: vi.fn(), isActive: () => true,
      setPreview: (next) => { preview = typeof next === "function" ? next(preview) : next; }
    });
    expect(preview).toMatchObject({ terminal: true, error: "permission revoked" });
    await flushPromises();
    expect(preview).toMatchObject({ terminal: true, error: "permission revoked" });
    expect(preview?.page).toBeUndefined();
    reconcile.cancel();
  });
});

describe("formal page focus reconciliation", () => {
  it("does not reread a cached page initially, then reads its confirmed leaf on focus and classifies the result", async () => {
    const currentPage = candidateDraft("release-a", "page-a", "Cached formal page").page;
    const denied = deferred<{ releaseId: string; page: PageLesson; qaRecords: [] }>();
    const readPage = vi.fn<() => SharedReadLease<{ releaseId: string; page: PageLesson; qaRecords: [] }>>(() => ({
      promise: denied.promise,
      release: vi.fn()
    }));
    let failure: ReturnType<typeof formalPageAfterReadFailure> | undefined;
    const formal = beginFormalPageLoad({
      releaseId: "release-a",
      pageId: "page-a",
      hasCachedPage: () => true,
      readPage,
      isActive: () => true,
      onPage: vi.fn(),
      onError: (error) => { failure = formalPageAfterReadFailure(currentPage, error); }
    });

    formal.loadInitial();
    expect(readPage).not.toHaveBeenCalled();
    formal.onFocus();
    expect(readPage).toHaveBeenCalledOnce();
    denied.reject(new ApiRequestError("page access revoked", "ACCESS_DENIED", 403, false));
    await flushPromises();
    expect(failure).toMatchObject({ terminal: true, error: "page access revoked" });
    expect(failure?.page).toBeUndefined();
    formal.cancel();

    const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    expect(source).toContain("formalRead.loadInitial();");
    expect(source).toContain('window.addEventListener("focus", formalRead.onFocus)');
    expect(source).toMatch(/if \(failure\.terminal\) \{\s*pageCacheInvalidationEpoch\.current \+= 1;/);
    expect(source).toContain("readPage: () => readLessonOnce(lessonRequests.current, release.id, indexedPage.id)");
  });

  it("does not let a late formal page response restore content after a terminal focus result", async () => {
    const older = deferred<{ releaseId: string; page: PageLesson; qaRecords: [] }>();
    const latest = deferred<{ releaseId: string; page: PageLesson; qaRecords: [] }>();
    const leases = [older, latest];
    let visiblePage: PageLesson | undefined = candidateDraft("release-a", "page-a", "Cached page").page;
    let visibleError = "";
    const formal = beginFormalPageLoad({
      releaseId: "release-a",
      pageId: "page-a",
      hasCachedPage: () => true,
      readPage: () => ({ promise: leases.shift()!.promise, release: vi.fn() }),
      isActive: () => true,
      onPage: (lesson) => { visiblePage = lesson.page; visibleError = ""; },
      onError: (error) => {
        const failure = formalPageAfterReadFailure(visiblePage, error);
        visiblePage = failure.page;
        visibleError = failure.error;
      }
    });

    formal.onFocus();
    formal.onFocus();
    latest.reject(new ApiRequestError("page deleted", "PAGE_NOT_FOUND", 404, false));
    await flushPromises();
    expect(visiblePage).toBeUndefined();
    expect(visibleError).toContain("page deleted");
    older.resolve({ releaseId: "release-a", page: candidateDraft("release-a", "page-a", "Late stale page").page, qaRecords: [] });
    await flushPromises();
    expect(visiblePage).toBeUndefined();
    expect(visibleError).toContain("page deleted");
    formal.cancel();
  });

  it("keeps a cached formal page on a temporary focus read failure", () => {
    const page = candidateDraft("release-a", "page-a", "Cached formal page").page;
    expect(formalPageAfterReadFailure(page, new ApiRequestError("read timed out", "REQUEST_TIMEOUT", 408, true)))
      .toMatchObject({ page, error: "read timed out", terminal: false });
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

function needsReviewDraft(releaseId: string, pageId: string, fullExplanation: string, mainContent: string, approvedQuestionCount: number): LessonDraft {
  const draft = candidateDraft(releaseId, pageId, mainContent || fullExplanation);
  draft.status = "needs_review";
  draft.page = {
    ...draft.page,
    teachingCompositionVersion: 1,
    lessonSections: [
      { id: `${pageId}:full`, kind: "full_explanation", title: "完整讲解", markdown: fullExplanation, sourceAnchorIds: [], atomIds: [] },
      { id: `${pageId}:main`, kind: "main_content", title: "主要内容", markdown: mainContent, sourceAnchorIds: [], atomIds: [] }
    ],
    questionBank: Array.from({ length: approvedQuestionCount }, (_, index) => ({ status: "approved", id: `question-${index + 1}` })) as unknown as NonNullable<PageLesson["questionBank"]>
  };
  return draft;
}
