import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { COURSE_API_VERSION, type CourseProject, type CourseRelease, type IdempotentWriteContext, type PageLesson, type ReleaseManifest, type TrashRecord } from "@course-os/contracts";
import { sha256Text, stableStringify } from "@course-os/domain";
import { FileReadWeaveCourseApi } from "@course-os/readweave-adapter";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The local File authority scopes trash reads to this default workspace.
// It is isolated beneath the temporary data directory for this verifier.
const workspaceId = "personal";
const courseId = "reading-stability-course";
const releaseId = "reading-stability-release-v1";
const pageId = "reading-stability-page-v1";
const removedCourseId = "reading-stability-removed-course";
const removedReleaseId = "reading-stability-removed-release";
const removedPageId = "reading-stability-removed-page";
const recycledCourseId = "reading-stability-recycled-course";
const recycledReleaseId = "reading-stability-recycled-release";
const stamp = "2026-09-30T12:00:00.000Z";
const selectionSeed = "reading-stability-selection-seed-v1";
const selectionRequestKey = "reading-stability-selection-request-v1";
const answerRequestKey = "reading-stability-answer-request-v1";

interface TimedJson {
  status: number;
  body: any;
  elapsedMs: number;
  headers: { readingSource?: string };
}

interface CliResult {
  label: string;
  elapsedMs: number;
  stdout: string;
  stderr: string;
}

interface ChildClose {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ChildOutput {
  text(): string;
  stdout(): string;
  stderr(): string;
  closed: Promise<ChildClose>;
}

interface CycleResult {
  process: number;
  startupMs?: number;
  firstRequest: "GET /api/v1/courses";
  firstRequestStatus?: number;
  firstRequestMs?: number;
  firstRequestError?: string;
  pageStatus?: number;
  pageMs?: number;
  sourceHash?: string;
  sessionStatus?: number;
  sessionMs?: number;
  selectionStatus?: number;
  selectionMs?: number;
  selectionId?: string;
  answerStatuses?: number[];
  answerMs?: number;
  attemptIds?: string[];
  wrongWorkspaceStatus?: number;
  wrongWorkspaceMs?: number;
  wrongReleaseStatus?: number;
  wrongReleaseMs?: number;
  deletedReleaseVisible?: boolean;
  deletedPageStatus?: number;
  deletedPageMs?: number;
  recycledPageIndexed?: boolean;
  recycledPageStatus?: number;
  recycledPageMs?: number;
  attemptsMs?: number;
  shutdown?: "graceful" | "signal-terminated" | "forced";
  socketClosed?: boolean;
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "course-os-reading-stability-"));
  const results: CycleResult[] = [];
  const port = await availablePort();
  const env = fixtureEnvironment(dataDir, port);
  let activeServer: ChildProcess | undefined;
  let activeOutput: ChildOutput | undefined;

  try {
    const authority = new FileReadWeaveCourseApi(join(dataDir, "readweave-course-store.json"));
    await installFixtures(authority, dataDir);

    const materialization = await runCli("controlled reading materialization", "scripts/materialize-reading.ts", env);

    let confirmedHash: string | undefined;
    let confirmedSelectionId: string | undefined;
    let confirmedAttemptIds: string[] | undefined;
    let confirmedSessionId: string | undefined;

    for (let processNumber = 1; processNumber <= 5; processNumber += 1) {
      const cycle: CycleResult = { process: processNumber, firstRequest: "GET /api/v1/courses" };
      results.push(cycle);
      const startedAt = performance.now();
      const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
        cwd: repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      activeServer = child;
      const processOutput = capture(child);
      activeOutput = processOutput;
      await waitForReady(child, processOutput);
      cycle.startupMs = rounded(performance.now() - startedAt);

      const baseUrl = `http://127.0.0.1:${port}`;
      let catalog: TimedJson;
      const firstStartedAt = performance.now();
      try {
        catalog = await requestJson(baseUrl, "/api/v1/courses", { headers: workspaceHeaders() });
        cycle.firstRequestStatus = catalog.status;
        cycle.firstRequestMs = catalog.elapsedMs;
      } catch (error) {
        cycle.firstRequestMs = rounded(performance.now() - firstStartedAt);
        cycle.firstRequestError = messageOf(error);
        throw new Error(`process ${processNumber} cold catalog request failed: ${cycle.firstRequestError}\n${processOutput.text()}`);
      }
      assertStatus(catalog, 200, `process ${processNumber} first catalog request`);
      assert(Array.isArray(catalog.body), "catalog response must be an array");
      assert(catalog.body.some((course: CourseProject) => course.id === courseId), "confirmed course missing from cold catalog response");

      const pageResult = await requestJson(baseUrl, `/api/v1/pages/${encodeURIComponent(pageId)}/lesson?releaseId=${encodeURIComponent(releaseId)}`, {
        headers: workspaceHeaders()
      });
      cycle.pageStatus = pageResult.status;
      cycle.pageMs = pageResult.elapsedMs;
      assertStatus(pageResult, 200, `process ${processNumber} confirmed page`);
      assert(pageResult.body.releaseId === releaseId, "page response returned a different release");
      assert(pageResult.body.page?.blocks?.[0]?.markdown === "Stable confirmed lesson body", "confirmed lesson body changed");
      assert(pageResult.body.page?.questionBank?.length === 4, "confirmed fixture must contain four approved questions");
      assert(pageResult.body.page.questionBank.every((question: { status: string }) => question.status === "approved"),
        "fixture question bank contains a non-approved question");
      assert(pageResult.headers?.readingSource === "confirmed-replica", "lesson did not come from the confirmed replica");
      const sourceHash = sha256Text(stableStringify(pageResult.body.page));
      cycle.sourceHash = sourceHash;
      if (confirmedHash && confirmedHash !== sourceHash) throw new Error(`confirmed page source hash changed after process restart ${processNumber}`);
      confirmedHash ??= sourceHash;

      const wrongWorkspace = await requestJson(baseUrl, "/api/v1/courses", { headers: workspaceHeaders("wrong-workspace") });
      cycle.wrongWorkspaceStatus = wrongWorkspace.status;
      cycle.wrongWorkspaceMs = wrongWorkspace.elapsedMs;
      assertStatus(wrongWorkspace, 200, "wrong-workspace catalog scope");
      assert(Array.isArray(wrongWorkspace.body) && wrongWorkspace.body.length === 0, "wrong-workspace catalog exposed course data");

      const wrongRelease = await requestJson(baseUrl, `/api/v1/pages/${encodeURIComponent(pageId)}/lesson?releaseId=wrong-release-version`, {
        headers: workspaceHeaders()
      });
      cycle.wrongReleaseStatus = wrongRelease.status;
      cycle.wrongReleaseMs = wrongRelease.elapsedMs;
      assertStatus(wrongRelease, 409, "wrong release version page");

      const removedIndexes = await requestJson(baseUrl, `/api/v1/releases?course_id=${encodeURIComponent(removedCourseId)}`, {
        headers: workspaceHeaders()
      });
      assertStatus(removedIndexes, 200, "deleted fixture release indexes");
      cycle.deletedReleaseVisible = Array.isArray(removedIndexes.body)
        && removedIndexes.body.some((release: CourseRelease) => release.id === removedReleaseId);
      assert(cycle.deletedReleaseVisible === false, "tombstoned material release remained visible");
      const removedPage = await requestJson(baseUrl, `/api/v1/pages/${encodeURIComponent(removedPageId)}/lesson?releaseId=${encodeURIComponent(removedReleaseId)}`, {
        headers: workspaceHeaders()
      });
      cycle.deletedPageStatus = removedPage.status;
      cycle.deletedPageMs = removedPage.elapsedMs;
      assertStatus(removedPage, 409, "tombstoned page");

      const recycledIndexes = await requestJson(baseUrl, `/api/v1/releases?course_id=${encodeURIComponent(recycledCourseId)}`, {
        headers: workspaceHeaders()
      });
      assertStatus(recycledIndexes, 200, "recycled fixture release indexes");
      cycle.recycledPageIndexed = recycledIndexes.body.some((release: CourseRelease) => release.pageIds.includes(removedPageId));
      assert(cycle.recycledPageIndexed === false, "a recycled page ID bypassed its deletion record");
      const recycledPage = await requestJson(baseUrl, `/api/v1/pages/${encodeURIComponent(removedPageId)}/lesson?releaseId=${encodeURIComponent(recycledReleaseId)}`, {
        headers: workspaceHeaders()
      });
      cycle.recycledPageStatus = recycledPage.status;
      cycle.recycledPageMs = recycledPage.elapsedMs;
      assertStatus(recycledPage, 409, "recycled tombstoned page");

      const session = await requestJson(baseUrl, "/api/v1/sessions", {
        method: "POST",
        headers: { ...workspaceHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ courseReleaseId: releaseId, ...(confirmedSessionId ? { sessionId: confirmedSessionId } : {}) })
      });
      cycle.sessionStatus = session.status;
      cycle.sessionMs = session.elapsedMs;
      assertStatus(session, confirmedSessionId ? 200 : 201, `process ${processNumber} learning session`);
      assert(session.body.courseReleaseId === releaseId, "session bound to a different release");
      if (confirmedSessionId && session.body.id !== confirmedSessionId) throw new Error("learning session ID changed after restart");
      confirmedSessionId ??= session.body.id;

      const selection = await requestJson(baseUrl, `/api/v1/pages/${encodeURIComponent(pageId)}/questions:select`, {
        method: "POST",
        headers: { ...workspaceHeaders(), "content-type": "application/json", "Idempotency-Key": selectionRequestKey },
        body: JSON.stringify({ sessionId: confirmedSessionId, seed: selectionSeed, count: 2 })
      });
      cycle.selectionStatus = selection.status;
      cycle.selectionMs = selection.elapsedMs;
      assertStatus(selection, 201, `process ${processNumber} question selection`);
      const questions = selection.body.questions;
      const selectionIdValue = selection.body.selection?.id;
      assert(typeof selectionIdValue === "string" && Array.isArray(questions) && questions.length === 2,
        "selection did not return the requested pair of questions");
      if (confirmedSelectionId && confirmedSelectionId !== selectionIdValue) throw new Error("selection idempotency changed the selection ID after restart");
      confirmedSelectionId ??= selectionIdValue;
      cycle.selectionId = selectionIdValue;

      cycle.answerStatuses = [];
      cycle.attemptIds = [];
      cycle.answerMs = 0;
      for (const question of questions) {
        const answer = await requestJson(baseUrl, "/api/v1/question-attempts", {
          method: "POST",
          headers: {
            ...workspaceHeaders(),
            "content-type": "application/json",
            "Idempotency-Key": `${answerRequestKey}:${question.id}`
          },
          body: JSON.stringify({
            courseReleaseId: releaseId,
            pageId,
            questionId: question.id,
            selectionId: selectionIdValue,
            sessionId: confirmedSessionId,
            answer: question.expectedAnswer
          })
        });
        cycle.answerStatuses.push(answer.status);
        cycle.answerMs = rounded(cycle.answerMs + answer.elapsedMs);
        assertStatus(answer, 201, `process ${processNumber} answer submission`);
        const attemptId = answer.body.attempt?.id;
        assert(typeof attemptId === "string" && answer.body.attempt?.correct === true, "answer was not persisted as correct");
        cycle.attemptIds.push(attemptId);
      }
      if (confirmedAttemptIds && JSON.stringify(confirmedAttemptIds) !== JSON.stringify(cycle.attemptIds)) {
        throw new Error("answer idempotency changed the attempt IDs after restart");
      }
      confirmedAttemptIds ??= cycle.attemptIds;

      const attempts = await requestJson(baseUrl,
        `/api/v1/pages/${encodeURIComponent(pageId)}/question-attempts?sessionId=${encodeURIComponent(String(confirmedSessionId))}&selectionId=${encodeURIComponent(String(selectionIdValue))}`,
        { headers: workspaceHeaders() });
      cycle.attemptsMs = attempts.elapsedMs;
      assertStatus(attempts, 200, "persisted question attempts");
      assert(Array.isArray(attempts.body) && attempts.body.length === 2
        && confirmedAttemptIds!.every((id) => attempts.body.some((attempt: { id: string }) => attempt.id === id)),
      "restarted process did not read the two idempotently persisted attempts");

      await assertPersistedCounts(dataDir);
      cycle.shutdown = await stopApi(child, processOutput);
      await assertSocketClosed(port);
      cycle.socketClosed = true;
      activeServer = undefined;
      activeOutput = undefined;
    }

    process.stdout.write(JSON.stringify({
      result: "passed",
      fixture: "temporary local FileReadWeave authority; no remote service or model provider",
      materialization,
      apiProcesses: results.length,
      sessionId: confirmedSessionId,
      selectionId: confirmedSelectionId,
      attemptIds: confirmedAttemptIds,
      stableSourceHash: confirmedHash,
      cycles: results
    }, null, 2) + "\n");
  } catch (error) {
    if (activeServer) await stopApi(activeServer, activeOutput ?? capture(activeServer), true).catch(() => undefined);
    process.stderr.write(JSON.stringify({ result: "failed", error: messageOf(error), completedCycles: results }, null, 2) + "\n");
    process.exitCode = 1;
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function installFixtures(authority: FileReadWeaveCourseApi, dataDir: string): Promise<void> {
  const mainCourse: CourseProject = {
    id: courseId,
    workspaceId,
    title: "Private Stability Fixture Course",
    status: "active",
    createdAt: stamp,
    updatedAt: stamp
  };
  await authority.createCourse(mainCourse, context("fixture:create-course"));
  const mainRelease = makeRelease(mainCourse, releaseId, pageId, "Stable confirmed lesson body");
  await authority.publishRelease(mainRelease, makeManifest(mainRelease), context("fixture:publish-release"));

  const removedCourse: CourseProject = {
    id: removedCourseId,
    workspaceId,
    title: "Private Stability Removed Fixture",
    status: "active",
    createdAt: stamp,
    updatedAt: stamp
  };
  await authority.createCourse(removedCourse, context("fixture:create-removed-course"));
  const removedRelease = makeRelease(removedCourse, removedReleaseId, removedPageId, "Removed lesson body must stay hidden");
  await authority.publishRelease(removedRelease, makeManifest(removedRelease), context("fixture:publish-removed-release"));
  await authority.trashTreeNode(`material:${removedCourseId}:stability-module`, context("fixture:trash-removed-material"));

  const recycledCourse: CourseProject = {
    id: recycledCourseId,
    workspaceId,
    title: "Private Stability Recycled Fixture",
    status: "active",
    createdAt: stamp,
    updatedAt: stamp
  };
  await authority.createCourse(recycledCourse, context("fixture:create-recycled-course"));
  const recycledRelease = makeRelease(recycledCourse, recycledReleaseId, removedPageId, "Recycled page ID must stay hidden");
  await authority.publishRelease(recycledRelease, makeManifest(recycledRelease), context("fixture:publish-recycled-release"));

  const authorityPath = join(dataDir, "readweave-course-store.json");
  const state = JSON.parse(await readFile(authorityPath, "utf8")) as { trash?: TrashRecord[] };
  const deletedPage: TrashRecord = {
    id: "fixture:deleted-page-id",
    workspaceId,
    nodeId: removedPageId,
    nodeKind: "page",
    title: "Deleted fixture page",
    deletedAt: stamp,
    deletedBy: "reading-stability-verifier",
    restoreAvailable: true
  };
  state.trash = [...(state.trash ?? []), deletedPage];
  await writeFile(authorityPath, JSON.stringify(state, null, 2), "utf8");
}

function makeRelease(course: CourseProject, id: string, pageIdentifier: string, body: string): CourseRelease {
  const lesson: PageLesson = {
    id: pageIdentifier,
    pageNumber: 1,
    title: "Private stability fixture lesson",
    imageUrl: "/api/v1/media/stability-fixture",
    anchors: [{ id: `${pageIdentifier}:anchor`, pageId: pageIdentifier, kind: "text", label: "Synthetic source", text: "Private test-only source material" }],
    atoms: [],
    blocks: [{ id: `${pageIdentifier}:core`, title: "Confirmed explanation", kind: "core", markdown: body, sourceAnchorIds: [`${pageIdentifier}:anchor`], atomIds: [] }],
    questionBank: Array.from({ length: 4 }, (_, index) => ({
      id: `${pageIdentifier}:question:${index + 1}`,
      pageId: pageIdentifier,
      objectiveId: `${pageIdentifier}:objective`,
      kind: "comprehension" as const,
      prompt: `Provide fixture answer ${index + 1}.`,
      expectedAnswer: `fixture answer ${index + 1}`,
      explanation: `Synthetic fixture feedback ${index + 1}`,
      sourceAnchorIds: [`${pageIdentifier}:anchor`],
      status: "approved" as const,
      version: 1,
      generatedBy: "stability-verifier-fixture"
    })),
    coverageRequirements: [],
    coverageClaims: [],
    quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable: true, issues: [] }
  };
  return {
    id,
    courseId: course.id,
    courseTitle: course.title,
    moduleId: "stability-module",
    moduleTitle: "Stability Fixture Module",
    version: 1,
    publishedAt: stamp,
    pageIds: [lesson.id],
    pages: [lesson],
    assessments: [],
    manifestHash: sha256Text(stableStringify({ id, page: lesson })),
    writingPolicySnapshotId: "stability-fixture-policy-v1",
    modelRoute: "fixture-no-model",
    qualityHarnessVersion: "stability-fixture-v1",
    costUsd: 0,
    lifecycle: "published"
  };
}

function makeManifest(release: CourseRelease): ReleaseManifest {
  return {
    id: `${release.id}:manifest`,
    schemaVersion: COURSE_API_VERSION,
    courseReleaseId: release.id,
    sourceHashes: [],
    pageHashes: release.pages.map((page) => sha256Text(stableStringify(page))),
    explanationHashes: [],
    assessmentHashes: [],
    writingPolicySnapshotId: release.writingPolicySnapshotId,
    modelRoutes: [release.modelRoute],
    qualityHarnessVersion: release.qualityHarnessVersion,
    costInputs: [],
    createdAt: stamp
  };
}

function fixtureEnvironment(dataDir: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COURSE_OS_DATA_DIR: dataDir,
    COURSE_OS_WORKSPACE_ID: workspaceId,
    COURSE_OS_HOST: "127.0.0.1",
    COURSE_OS_PORT: String(port),
    NODE_ENV: "test",
    READWEAVE_MODE: "file"
  };
  for (const name of [
    "DATABASE_URL", "READWEAVE_BASE_URL", "READWEAVE_API_TOKEN", "READWEAVE_API_TOKEN_FILE", "READWEAVE_ROOT_NOTE_ID",
    "COURSE_OS_WORKER_TOKEN", "COURSE_OS_WORKER_TOKEN_FILE", "COURSE_OS_SETTINGS_KEY", "COURSE_OS_SETTINGS_KEY_FILE",
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "AIALRA_API_KEY"
  ]) delete env[name];
  return env;
}

async function runCli(label: string, relativeScript: string, env: NodeJS.ProcessEnv): Promise<CliResult> {
  const child = spawn(process.execPath, ["--import", "tsx", relativeScript], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  const output = capture(child);
  const startedAt = performance.now();
  const exit = output.closed.then(({ code, signal }) => {
    if (code !== 0) throw new Error(`${label} exited with code=${code} signal=${signal}\n${output.text()}`);
  });
  const childError = new Promise<never>((_, reject) => child.once("error", reject));
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      child.kill();
      reject(new Error(`${label} exceeded 60 seconds\n${output.text()}`));
    }, 60_000);
  });
  try {
    await Promise.race([exit, childError, timeout]);
    return { label, elapsedMs: rounded(performance.now() - startedAt), stdout: output.stdout(), stderr: output.stderr() };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function capture(child: ChildProcess): ChildOutput {
  let stdout = "";
  let stderr = "";
  let resolveClose!: (close: ChildClose) => void;
  const closed = new Promise<ChildClose>((resolvePromise) => { resolveClose = resolvePromise; });
  child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
  child.once("close", (code, signal) => resolveClose({ code, signal }));
  return { text: () => `stdout:\n${stdout}\nstderr:\n${stderr}`, stdout: () => stdout, stderr: () => stderr, closed };
}

async function waitForReady(child: ChildProcess, output: { text(): string }): Promise<void> {
  await new Promise<void>((resolveReady, rejectReady) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`API startup timed out after 20 seconds\n${output.text()}`)), 20_000);
    const onData = (chunk: Buffer | string) => {
      void chunk;
      if (/Course OS API listening at http:\/\/127\.0\.0\.1:\d+; reading ready\s/u.test(output.text())) finish();
      else if (/Course OS API listening at http:\/\/127\.0\.0\.1:\d+; reading not ready/u.test(output.text())) {
        finish(new Error(`API started with an unready reading replica\n${output.text()}`));
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`API exited before readiness: code=${code} signal=${signal}\n${output.text()}`));
    const onError = (error: Error) => finish(error);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.removeListener("data", onData);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      if (error) rejectReady(error);
      else resolveReady();
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
    onData("");
  });
}

async function stopApi(child: ChildProcess, output: ChildOutput, force = false): Promise<"graceful" | "signal-terminated" | "forced"> {
  child.kill(force ? "SIGKILL" : "SIGTERM");
  const closed = await waitForClose(output, force ? 2_000 : 8_000);
  if (closed) return shutdownKind(closed, force, output);
  if (force) throw new Error(`API process did not terminate after forced shutdown\n${output.text()}`);
  child.kill("SIGKILL");
  const forcedClose = await waitForClose(output, 2_000);
  if (!forcedClose) throw new Error(`API process did not terminate\n${output.text()}`);
  if (forcedClose.signal !== "SIGKILL" && forcedClose.signal !== "SIGTERM" && forcedClose.code !== 0) {
    throw new Error(`API forced shutdown returned code=${forcedClose.code} signal=${forcedClose.signal}\n${output.text()}`);
  }
  return "forced";
}

function shutdownKind(close: ChildClose, forced: boolean, output: ChildOutput): "graceful" | "signal-terminated" | "forced" {
  if (forced) return "forced";
  if (close.code === 0 && close.signal === null) return "graceful";
  if (close.code === null && close.signal === "SIGTERM") return "signal-terminated";
  throw new Error(`API shutdown returned code=${close.code} signal=${close.signal}\n${output.text()}`);
}

async function waitForClose(output: ChildOutput, timeoutMs: number): Promise<ChildClose | undefined> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolveTimeout) => { timeoutHandle = setTimeout(() => resolveTimeout(undefined), timeoutMs); });
  try { return await Promise.race([output.closed, timeout]); }
  finally { if (timeoutHandle) clearTimeout(timeoutHandle); }
}

async function requestJson(baseUrl: string, path: string, init: RequestInit = {}): Promise<TimedJson> {
  const startedAt = performance.now();
  const responsePromise = fetch(`${baseUrl}${path}`, init).then(async (response) => {
    const text = await response.text();
    let body: any;
    try { body = text ? JSON.parse(text) : undefined; }
    catch { body = text; }
    return {
      status: response.status,
      body,
      elapsedMs: rounded(performance.now() - startedAt),
      headers: { readingSource: response.headers.get("x-reading-source") ?? undefined }
    };
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`HTTP request timed out after 8 seconds: ${init.method ?? "GET"} ${path}`)), 8_000);
  });
  try { return await Promise.race([responsePromise, timeoutPromise]); }
  finally { if (timeoutHandle) clearTimeout(timeoutHandle); }
}

function workspaceHeaders(workspace = workspaceId): Record<string, string> {
  return { "X-Workspace-Id": workspace, Connection: "close" };
}

function assertStatus(result: TimedJson, expected: number, label: string): void {
  assert(result.status === expected, `${label} expected HTTP ${expected}, got ${result.status}: ${JSON.stringify(result.body)}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return port;
}

async function assertSocketClosed(port: number): Promise<void> {
  const socket = createConnection({ host: "127.0.0.1", port });
  await new Promise<void>((resolveClosed, rejectClosed) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectClosed(new Error(`API TCP listener remained open on port ${port}`));
    }, 1_500);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      rejectClosed(new Error(`API accepted a connection after child shutdown on port ${port}`));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (error.code === "ECONNREFUSED") resolveClosed();
      else rejectClosed(error);
    });
  });
}

async function assertPersistedCounts(dataDir: string): Promise<void> {
  const authority = JSON.parse(await readFile(join(dataDir, "readweave-course-store.json"), "utf8")) as {
    questionSelections?: unknown[];
    questionAttempts?: unknown[];
  };
  assert(authority.questionSelections?.length === 1, "question selection duplicated or was not persisted");
  assert(authority.questionAttempts?.length === 2, "answer attempts duplicated or were not persisted");
  const operations = JSON.parse(await readFile(join(dataDir, "operations.json"), "utf8")) as { sessions?: unknown[] };
  assert(operations.sessions?.length === 1, "learning session duplicated or was not persisted");
}

function context(idempotencyKey: string): IdempotentWriteContext {
  return { idempotencyKey, actor: "reading-stability-verifier", workspaceId, schemaVersion: COURSE_API_VERSION, requestId: idempotencyKey };
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main();
