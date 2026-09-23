import { readFile } from "node:fs/promises";
import type { CourseRelease } from "@course-os/contracts";
import { describe, expect, it } from "vitest";
import { normalizeSidebarWidth, SIDEBAR_DEFAULT_WIDTH, sourceReleasesForCourse } from "./App.js";

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
