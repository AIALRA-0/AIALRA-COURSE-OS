import { readFile } from "node:fs/promises";
import type { CourseRelease, LearningSession } from "@course-os/contracts";
import { describe, expect, it, vi } from "vitest";
import { flushNextSessionPatch, normalizeSidebarWidth, openVerifiedReadWeaveDeepLink, resolveActiveImportId, SIDEBAR_DEFAULT_WIDTH, sourceReleasesForCourse } from "./App.js";

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
  it("lets an explicit lesson link take precedence over a task left in local storage", () => {
    expect(resolveActiveImportId("#mode=learn&release=release-1&page=4", "old-import")).toBeUndefined();
  });

  it("keeps an explicit task link and restores a saved task when there is no lesson route", () => {
    expect(resolveActiveImportId("#release=release-1&page=4&import=linked-import", "old-import")).toBe("linked-import");
    expect(resolveActiveImportId("#mode=learn", "saved-import")).toBe("saved-import");
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
