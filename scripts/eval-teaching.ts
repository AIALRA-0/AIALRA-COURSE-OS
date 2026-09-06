import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CourseRelease } from "@course-os/contracts";
import { evaluateReleaseClosure, evaluateTeachingPage } from "@course-os/quality";

type Snapshot = { releases?: CourseRelease[] };
const state = JSON.parse(await readFile(resolve("var/readweave-course-store.json"), "utf8")) as Snapshot;
const releases = [...(state.releases ?? [])]
  .filter((release) => release.lifecycle !== "draft_source")
  .sort((left, right) => right.version - left.version)
  .filter((release, _, all) => !all.some((other) => other.moduleId === release.moduleId && other.version > release.version));
const rows = releases.flatMap((release) => release.pages.map((page) => {
  const evaluation = evaluateTeachingPage(page);
  return { releaseId: release.id, pageId: page.id, publishable: page.quality.publishable, ...evaluation };
}));
const closures = releases.map((release) => ({ releaseId: release.id, ...evaluateReleaseClosure(release) }));
const issues = rows.flatMap((row) => row.issues.map((issue) => `${row.pageId}:${issue}`));
const result = { status: issues.length === 0 && closures.every((closure) => closure.ready) ? "passed" : "failed", releaseCount: releases.length, pageCount: rows.length, narrativeIssueCount: issues.length, averageScore: rows.length ? Math.round(rows.reduce((sum, row) => sum + row.score, 0) / rows.length) : 0, closure: closures, issues };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status === "failed") process.exitCode = 1;
