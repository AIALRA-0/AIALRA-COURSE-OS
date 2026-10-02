import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  historyScanFailure,
  inspectPublicFile,
  scanPublicFiles,
  type PublicIssue
} from "./lib/verify-public.js";

type ReachableObject = { id: string; path?: string };
type ObjectMetric = { count: number; bytes: number };
type HistoryCoverage = {
  complete: boolean;
  objects: ObjectMetric;
  blobs: ObjectMetric;
  commits: ObjectMetric;
  trees: ObjectMetric;
  tags: ObjectMetric;
};
type HistoryScanResult = { issues: PublicIssue[]; coverage: HistoryCoverage };

function emptyHistoryCoverage(): HistoryCoverage {
  const empty = () => ({ count: 0, bytes: 0 });
  return { complete: false, objects: empty(), blobs: empty(), commits: empty(), trees: empty(), tags: empty() };
}

function listReachableHistoryObjects(): ReachableObject[] {
  for (const ref of ["HEAD", "refs/heads/main"]) {
    execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { stdio: "ignore" });
  }

  const listing = execFileSync("git", ["rev-list", "--objects", "HEAD", "refs/heads/main"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  const objects: ReachableObject[] = [];
  const seen = new Set<string>();

  for (const line of listing.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf(" ");
    const id = separator < 0 ? line : line.slice(0, separator);
    if (!/^[a-f0-9]{40,64}$/i.test(id) || seen.has(id)) continue;
    seen.add(id);
    objects.push({ id, ...(separator < 0 ? {} : { path: line.slice(separator + 1) }) });
  }
  return objects;
}

async function scanReachableHistory(): Promise<HistoryScanResult> {
  let objects: ReachableObject[];
  try {
    objects = listReachableHistoryObjects();
  } catch {
    return { issues: [historyScanFailure()], coverage: emptyHistoryCoverage() };
  }
  if (!objects.length) return { issues: [{ path: "<history>", code: "HISTORY_SCAN_UNCOVERED" }], coverage: emptyHistoryCoverage() };

  const child = spawn("git", ["cat-file", "--batch"], { stdio: ["pipe", "pipe", "ignore"] });
  const issues: PublicIssue[] = [];
  const pathById = new Map(objects.map(({ id, path }) => [id, path ?? "<history>"]));
  let parseFailed = false;
  let inputFailed = false;
  const coverage = emptyHistoryCoverage();
  let pending: Buffer = Buffer.alloc(0);
  let partialHeader: Buffer = Buffer.alloc(0);
  let state: "header" | "body" | "separator" = "header";
  let active: { id: string; path: string; type: string; size: number; remaining: number; chunks: Buffer[] } | undefined;

  const consume = (chunk: Buffer): void => {
    if (parseFailed) return;
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;

    while (!parseFailed) {
      if (state === "header") {
        const newline = pending.indexOf(0x0a);
        if (newline < 0) {
          if (pending.length) partialHeader = Buffer.concat([partialHeader, pending]);
          pending = Buffer.alloc(0);
          return;
        }
        const line = Buffer.concat([partialHeader, pending.subarray(0, newline)]).toString("utf8");
        pending = pending.subarray(newline + 1);
        partialHeader = Buffer.alloc(0);
        const match = /^([a-f0-9]{40,64}) (blob|tree|commit|tag) (\d+)$/i.exec(line);
        if (!match) {
          parseFailed = true;
          return;
        }
        const id = match[1]!;
        const type = match[2]!;
        const size = Number(match[3]);
        if (!Number.isSafeInteger(size)) {
          parseFailed = true;
          return;
        }
        active = {
          id,
          path: pathById.get(id) ?? "<history>",
          type,
          size,
          remaining: size,
          chunks: []
        };
        state = size === 0 ? "separator" : "body";
        if (size === 0 && type === "blob") {
          issues.push(...inspectHistoryBlob(active.path, active.size, active.chunks));
        }
        continue;
      }

      if (state === "body") {
        if (!pending.length) return;
        const take = Math.min(active!.remaining, pending.length);
        if (active!.type === "blob") active!.chunks.push(pending.subarray(0, take));
        pending = pending.subarray(take);
        active!.remaining -= take;
        if (active!.remaining > 0) return;
        if (active!.type === "blob") {
          issues.push(...inspectHistoryBlob(active!.path, active!.size, active!.chunks));
        }
        state = "separator";
        continue;
      }

      if (!pending.length) return;
      if (pending[0] !== 0x0a) {
        parseFailed = true;
        return;
      }
      pending = pending.subarray(1);
      coverage.objects.count += 1;
      coverage.objects.bytes += active!.size;
      const metric = active!.type === "blob"
        ? coverage.blobs
        : active!.type === "commit"
          ? coverage.commits
          : active!.type === "tree"
            ? coverage.trees
            : coverage.tags;
      metric.count += 1;
      metric.bytes += active!.size;
      active = undefined;
      state = "header";
    }
  };

  const exitPromise = new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code) => resolveExit(code ?? -1));
  });
  const outputPromise = (async () => {
    for await (const chunk of child.stdout) consume(Buffer.from(chunk));
  })().catch(() => {
    parseFailed = true;
  });
  const inputPromise = (async () => {
    for (const { id } of objects) {
      if (!child.stdin.write(`${id}\n`)) await once(child.stdin, "drain");
    }
    child.stdin.end();
  })().catch(() => {
    inputFailed = true;
    child.stdin.destroy();
  });

  await Promise.all([outputPromise, inputPromise]);
  let exitCode = -1;
  try {
    exitCode = await exitPromise;
  } catch {
    inputFailed = true;
  }

  if (parseFailed || inputFailed || exitCode !== 0 || coverage.objects.count !== objects.length || state !== "header" || partialHeader.length || pending.length) {
    issues.push(historyScanFailure());
  }
  if (coverage.blobs.count === 0) issues.push({ path: "<history>", code: "HISTORY_SCAN_UNCOVERED" });
  coverage.complete = !parseFailed && !inputFailed && exitCode === 0 && coverage.objects.count === objects.length && coverage.blobs.count > 0 && state === "header" && !partialHeader.length && !pending.length;
  return { issues: deduplicateIssues(issues), coverage };
}

function inspectHistoryBlob(path: string, size: number, chunks: Buffer[]): PublicIssue[] {
  const bytes = Buffer.concat(chunks, size);
  return inspectPublicFile(path, bytes).map(({ path: issuePath, code }) => ({ path: issuePath, code: `HISTORY_${code}` }));
}

function deduplicateIssues(issues: PublicIssue[]): PublicIssue[] {
  const seen = new Set<string>();
  return issues.filter(({ path, code }) => {
    const key = `${path}\0${code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const historyRequested = args.includes("--history");
  let historyCoverage: HistoryCoverage | undefined;
  const issues: PublicIssue[] = args.some((arg) => arg !== "--history")
    ? [{ path: "<arguments>", code: "INVALID_ARGUMENT" }]
    : [];

  try {
    const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    process.chdir(repositoryRoot);
    const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    issues.push(...await scanPublicFiles(files, (path) => readFile(resolve(path))));
    if (historyRequested) {
      const history = await scanReachableHistory();
      issues.push(...history.issues);
      historyCoverage = history.coverage;
    }
  } catch {
    issues.push({ path: "<repository>", code: "PUBLIC_SCAN_UNAVAILABLE" });
  }

  const result = deduplicateIssues(issues);
  const report = {
    status: result.length ? "failed" : "passed",
    issues: result,
    ...(historyRequested ? { historyCoverage: historyCoverage ?? emptyHistoryCoverage() } : {})
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (result.length) process.exitCode = 1;
}

void main();
