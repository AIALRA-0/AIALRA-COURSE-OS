import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COURSE_API_VERSION, type CourseRelease, type GenerationCostEntry, type ReleaseManifest } from "@course-os/contracts";
import { FileReadWeaveCourseApi } from "@course-os/readweave-adapter";
import { applyTeachingPackage, createApp, createDefaultDependencies, executeGenerationJob, resumeIncompleteJobs } from "./app.js";
import { HttpProviderTeachingClient, ModelRouterGenerationError, type ModelRouterClient, type ModelRouterInput, type TeachingGenerationResult } from "./model-router.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("generation recovery campaign", () => {
  it("retries a failed model request independently and preserves the completed page", async () => {
    vi.stubEnv("COURSE_OS_EXTERNAL_WORKER", "true");
    const pageCalls: number[] = [];
    let failedPageTwo = false;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async (input) => {
        pageCalls.push(input.pageNumber);
        if (input.pageNumber === 2 && !failedPageTwo) {
          failedPageTwo = true;
          throw new ModelRouterGenerationError("MODEL_PROVIDER_FAILED:503", "synthetic-model", emptyUsage(), "synthetic-provider");
        }
        return teachingResult(`result-for-page-${input.pageNumber}`);
      }
    };
    const fixture = await seededApp(modelRouter, 2);
    const jobId = await createJob(fixture.app, fixture.release.id, fixture.release.pageIds);

    await executeGenerationJob(jobId, fixture.dependencies);
    const firstRun = await getJob(fixture.dependencies, jobId);
    expect(firstRun).toMatchObject({ state: "completed", completedPageIds: ["page-1"], failedPageIds: ["page-2"] });
    const completedPage = await fixture.readweave.getDraftByPage("page-1");
    expect(completedPage?.page.lessonSections?.find((section) => section.kind === "main_content")?.markdown)
      .toContain("result-for-page-1");
    expect(await fixture.readweave.getDraftByPage("page-2")).toBeUndefined();

    await request(fixture.app).post(`/api/v1/generation-jobs/${jobId}:retry`)
      .set("Idempotency-Key", "campaign-model-request-retry").expect(202);
    await executeGenerationJob(jobId, fixture.dependencies);

    expect(await getJob(fixture.dependencies, jobId)).toMatchObject({ state: "completed", completedPageIds: ["page-2"], failedPageIds: [] });
    expect(pageCalls).toEqual([1, 2, 2]);
    expect(await fixture.readweave.getDraftByPage("page-1")).toEqual(completedPage);
    expect((await fixture.readweave.getDraftByPage("page-2"))?.page.lessonSections?.find((section) => section.kind === "main_content")?.markdown)
      .toContain("result-for-page-2");
    expect(await fixture.readweave.listDrafts()).toHaveLength(2);
  }, 20_000);

  it("records a final-format repair request failure without replaying the page", async () => {
    vi.stubEnv("COURSE_OS_EXTERNAL_WORKER", "true");
    const providerPhases: string[] = [];
    const providerFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
      const phase = key.split(":").at(-1) ?? "unknown";
      providerPhases.push(phase);
      if (phase === "plan") return Response.json({
        model: "deepseek-flash", output_text: "先确认输入，再说明规则，最后核对输出。",
        usage: { input_tokens: 30, output_tokens: 20, total_cost: 0.001 }
      });
      if (phase === "teaching") return Response.json({
        model: "deepseek-flash", output_text: "{broken json",
        usage: { input_tokens: 30, output_tokens: 20, total_cost: 0.001 }
      });
      return Response.json({ error: { code: "upstream_error" } }, { status: 503 });
    });
    vi.stubGlobal("fetch", providerFetch);
    const modelRouter = new HttpProviderTeachingClient({
      providerId: "deepseek", baseUrl: "https://deepseek.test", apiKey: "synthetic-test-token",
      model: "deepseek-flash", protocol: "responses"
    });
    const fixture = await seededApp(modelRouter);
    const jobId = await createJob(fixture.app, fixture.release.id, ["page-1"]);

    await executeGenerationJob(jobId, fixture.dependencies);

    expect(await getJob(fixture.dependencies, jobId)).toMatchObject({ state: "failed", failedPageIds: ["page-1"] });
    expect(providerPhases).toEqual(["plan", "teaching", "format_repair", "format_repair"]);
    const repairKeys = providerFetch.mock.calls.slice(2).map(([, init]) =>
      new Headers(init?.headers).get("Idempotency-Key"));
    expect(repairKeys).toHaveLength(2);
    expect(repairKeys[0]).toBe(repairKeys[1]);
    expect(await fixture.readweave.getDraftByPage("page-1")).toBeUndefined();
    const events = (await fixture.dependencies.operations.read()).events.filter((event) => event.streamId === jobId);
    expect(events.some((event) => event.type === "generation.stage.started"
      && (event.payload as { stage?: string; phase?: string }).stage === "repair"
      && (event.payload as { phase?: string }).phase === "format_repair")).toBe(true);
    expect(events.some((event) => event.type === "generation.stage.completed"
      && (event.payload as { stage?: string; phase?: string }).stage === "repair"
      && (event.payload as { phase?: string }).phase === "format_repair")).toBe(false);
  }, 20_000);

  it("recovers a lost ReadWeave save acknowledgment with the same idempotency key", async () => {
    vi.stubEnv("COURSE_OS_EXTERNAL_WORKER", "true");
    let providerCalls = 0;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async () => teachingResult(`provider-result-${++providerCalls}`)
    };
    const fixture = await seededApp(modelRouter);
    const saveDraftWithCost = fixture.readweave.saveDraftWithCost!.bind(fixture.readweave);
    const durableSaveResponses: Array<Awaited<ReturnType<typeof saveDraftWithCost>>> = [];
    let saveCalls = 0;
    vi.spyOn(fixture.readweave, "saveDraftWithCost").mockImplementation(async (draft, revision, context, cost, asset) => {
      const saved = await saveDraftWithCost(draft, revision, context, cost, asset);
      durableSaveResponses.push(saved);
      if (++saveCalls === 1) throw new Error("READWEAVE_ETAPI_NETWORK:connection_lost");
      return saved;
    });
    const jobId = await createJob(fixture.app, fixture.release.id, ["page-1"]);

    await executeGenerationJob(jobId, fixture.dependencies);
    expect(await getJob(fixture.dependencies, jobId)).toMatchObject({ state: "completed", completedPageIds: ["page-1"], failedPageIds: [] });
    expect(providerCalls).toBe(1);
    expect(saveCalls).toBe(2);
    expect(durableSaveResponses).toHaveLength(2);
    expect(durableSaveResponses[1]).toEqual(durableSaveResponses[0]);
    expect(durableSaveResponses[1]).toMatchObject({ revision: 1, contentHash: durableSaveResponses[0]?.contentHash });
    expect(await fixture.readweave.listDrafts()).toHaveLength(1);
    expect((await fixture.readweave.getDraftByPage("page-1"))?.page.lessonSections?.find((section) => section.kind === "main_content")?.markdown)
      .toContain("provider-result-1");
    const saveCallsWithArgs = vi.mocked(fixture.readweave.saveDraftWithCost).mock.calls;
    expect(saveCallsWithArgs[1]?.[0]).toEqual(saveCallsWithArgs[0]?.[0]);
    expect(saveCallsWithArgs[1]?.[1]).toBe(saveCallsWithArgs[0]?.[1]);
    expect(saveCallsWithArgs[1]?.[2].idempotencyKey).toBe(saveCallsWithArgs[0]?.[2].idempotencyKey);
    expect(saveCallsWithArgs[1]?.[3]).toEqual(saveCallsWithArgs[0]?.[3]);
    expect(await fixture.readweave.listCostEntries({ jobId, pageId: "page-1" })).toHaveLength(1);
  }, 20_000);

  it("retries a transient draft readback failure without calling the provider again", async () => {
    vi.stubEnv("COURSE_OS_EXTERNAL_WORKER", "true");
    const provider = vi.fn(async () => teachingResult("readback-result"));
    const fixture = await seededApp({ generateTeachingPackage: provider });
    const getDraftByPage = fixture.readweave.getDraftByPage.bind(fixture.readweave);
    let reads = 0;
    vi.spyOn(fixture.readweave, "getDraftByPage").mockImplementation(async (pageId) => {
      if (++reads === 2) throw new Error("READWEAVE_ETAPI_NETWORK:connection reset");
      return getDraftByPage(pageId);
    });
    const jobId = await createJob(fixture.app, fixture.release.id, ["page-1"]);

    await executeGenerationJob(jobId, fixture.dependencies);

    expect(await getJob(fixture.dependencies, jobId)).toMatchObject({ state: "completed", completedPageIds: ["page-1"] });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(reads).toBe(3);
    expect(await fixture.readweave.listDrafts()).toHaveLength(1);
    expect(await fixture.readweave.listCostEntries({ jobId, pageId: "page-1" })).toHaveLength(1);
  }, 20_000);

  it("does not retry a permanent ReadWeave revision conflict", async () => {
    vi.stubEnv("COURSE_OS_EXTERNAL_WORKER", "true");
    const provider = vi.fn(async () => teachingResult("conflict-result"));
    const fixture = await seededApp({ generateTeachingPackage: provider });
    const saveDraftWithCost = vi.spyOn(fixture.readweave, "saveDraftWithCost").mockRejectedValue(
      new Error("READWEAVE_REVISION_CONFLICT:campaign-conflict")
    );
    const jobId = await createJob(fixture.app, fixture.release.id, ["page-1"]);

    await executeGenerationJob(jobId, fixture.dependencies);

    expect(await getJob(fixture.dependencies, jobId)).toMatchObject({ state: "failed", failedPageIds: ["page-1"] });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(saveDraftWithCost).toHaveBeenCalledTimes(1);
    expect(await fixture.readweave.listDrafts()).toHaveLength(0);
  }, 20_000);

  it("checks the generation fence before retrying a transient save after cancellation", async () => {
    vi.stubEnv("COURSE_OS_EXTERNAL_WORKER", "true");
    const provider = vi.fn(async () => teachingResult("cancelled-result"));
    const fixture = await seededApp({ generateTeachingPackage: provider });
    const jobId = await createJob(fixture.app, fixture.release.id, ["page-1"]);
    const saveDraftWithCost = fixture.readweave.saveDraftWithCost!.bind(fixture.readweave);
    let saveCalls = 0;
    vi.spyOn(fixture.readweave, "saveDraftWithCost").mockImplementation(async (draft, revision, context, cost, asset) => {
      saveCalls += 1;
      if (saveCalls === 1) {
        await request(fixture.app).post(`/api/v1/generation-jobs/${jobId}:cancel`).expect(200);
        throw new Error("READWEAVE_ETAPI_503:temporary");
      }
      return saveDraftWithCost(draft, revision, context, cost, asset);
    });

    await executeGenerationJob(jobId, fixture.dependencies);

    expect(await getJob(fixture.dependencies, jobId)).toMatchObject({ state: "cancelled" });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(saveCalls).toBe(1);
    expect(await fixture.readweave.listDrafts()).toHaveLength(0);
  }, 20_000);

  it("resumes a durable provider result from persisted task state without duplicating its draft or ledger entry", async () => {
    vi.stubEnv("COURSE_OS_EXTERNAL_WORKER", "true");
    vi.stubEnv("COURSE_OS_WORKER_TOKEN", "campaign-worker-token");
    const provider = vi.fn(async () => teachingResult("durable-provider-result"));
    const modelRouter: ModelRouterClient = { generateTeachingPackage: provider };
    const fixture = await seededApp(modelRouter);
    const jobId = await createJob(fixture.app, fixture.release.id, ["page-1"]);

    // Model response, draft, and cost receipt are durable before the simulated worker interruption.
    const sourcePage = fixture.release.pages[0]!;
    const generation = await modelRouter.generateTeachingPackage(inputFor(sourcePage, fixture.release));
    const generatedPage = applyTeachingPackage(sourcePage, generation.content, true, "text_only");
    const cost = durableCost(jobId, fixture.release, generation);
    const draft = await fixture.readweave.saveDraftWithCost!({
      id: `draft:${sourcePage.id}`, generationJobId: jobId, workspaceId: "personal",
      courseId: fixture.release.courseId, moduleId: fixture.release.moduleId,
      sourceReleaseId: fixture.release.id, pageId: sourcePage.id, revision: 0, status: "ready",
      page: generatedPage, changedBlockIds: generatedPage.blocks.map((block) => block.id),
      contentHash: "durable-provider-result-hash", updatedAt: new Date().toISOString()
    }, 0, writeContext("campaign-durable-result"), cost);
    await fixture.dependencies.operations.mutateGenerationJob(jobId, (job) => {
      job.state = "running";
      job.attempt = 1;
    });

    const restartedReadweave = new FileReadWeaveCourseApi(join(fixture.root, "readweave.json"));
    const restartedDependencies = createDefaultDependencies(fixture.root, restartedReadweave, modelRouter);
    const restartedApp = createApp(restartedDependencies);
    await resumeIncompleteJobs(restartedDependencies);
    expect(await getJob(restartedDependencies, jobId)).toMatchObject({ state: "queued", attempt: 1 });
    await request(restartedApp).post(`/api/internal/worker/jobs/${jobId}/run`)
      .set("X-Course-Worker-Token", "campaign-worker-token")
      .set("X-Workspace-Id", "personal").expect(202);

    expect(await waitForJob(restartedDependencies, jobId)).toMatchObject({
      state: "completed", completedPageIds: ["page-1"], failedPageIds: [], attempt: 2
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await restartedReadweave.getDraftByPage("page-1")).toEqual(draft);
    expect(await restartedReadweave.listDrafts()).toHaveLength(1);
    const costs = await restartedReadweave.listCostEntries({ jobId, pageId: "page-1" });
    expect(costs).toEqual([cost]);
    expect((await restartedDependencies.operations.read()).events.filter((event) =>
      event.streamId === jobId && event.type === "generation.cost.recorded")).toHaveLength(1);
  }, 20_000);
});

async function seededApp(modelRouter: ModelRouterClient, pageCount = 1) {
  const root = await mkdtemp(join(tmpdir(), "course-os-generation-recovery-campaign-"));
  const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
  const release = testRelease(pageCount);
  await readweave.publishRelease(release, testManifest(release.id), writeContext("campaign-seed-release"));
  const dependencies = createDefaultDependencies(root, readweave, modelRouter);
  return { root, app: createApp(dependencies), dependencies, readweave, release };
}

function testRelease(pageCount: number): CourseRelease {
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const pageNumber = index + 1;
    const id = `page-${pageNumber}`;
    return {
      id,
      pageNumber,
      title: `Recovery page ${pageNumber}`,
      imageUrl: "",
      anchors: [{ id: `${id}:source`, pageId: id, kind: "text" as const, label: "Source", text: `Source for page ${pageNumber}` }],
      atoms: [],
      blocks: [{ id: `${id}:core`, title: "Core explanation", kind: "core" as const, markdown: "Source draft", sourceAnchorIds: [], atomIds: [] }],
      coverageRequirements: [],
      coverageClaims: [],
      quality: { highRiskCoverage: 1, generalCoverage: 0, mathValid: true, publishable: false, issues: ["TEACHING_GENERATION_REQUIRED"] }
    };
  });
  return {
    id: "campaign-release-v1",
    courseId: "campaign-course",
    courseTitle: "Recovery campaign",
    moduleId: "campaign-module",
    moduleTitle: "Recovery",
    version: 1,
    publishedAt: "2026-09-29T00:00:00.000Z",
    pageIds: pages.map((page) => page.id),
    pages,
    assessments: [],
    manifestHash: "campaign-manifest-hash",
    writingPolicySnapshotId: "policy-v1",
    modelRoute: "synthetic-provider",
    qualityHarnessVersion: "campaign",
    costUsd: 0
  } as CourseRelease;
}

function testManifest(releaseId: string): ReleaseManifest {
  return {
    id: `${releaseId}:manifest`, schemaVersion: COURSE_API_VERSION, courseReleaseId: releaseId,
    sourceHashes: [], pageHashes: [], explanationHashes: [], assessmentHashes: [],
    writingPolicySnapshotId: "policy-v1", modelRoutes: ["synthetic-provider"],
    qualityHarnessVersion: "campaign", costInputs: [], createdAt: "2026-09-29T00:00:00.000Z"
  };
}

function teachingResult(marker: string): TeachingGenerationResult {
  return {
    provider: "synthetic-provider",
    model: "synthetic-model",
    usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 200, apiEquivalentUsd: 0.001, durationMs: 5 },
    content: {
      learningObjectives: ["能够解释输入、处理规则和输出之间的关系"],
      mainContentMarkdown: `- 先确认输入和适用条件\n- 再按规则处理对象\n- 最后核对输出与目标 ${marker}`,
      priorKnowledge: ["输入（Input）：输入明确规则要处理的对象和起点，先确认输入才能检查后续步骤。"],
      fullExplanationMarkdown: [
        "## 核对输入与规则",
        "输入指出规则要处理的对象，规则限定可以执行的步骤。",
        "先确认输入满足条件，再逐步说明规则怎样改变对象。",
        "最后把输出与目标比较，检查处理过程是否完整。"
      ].join("\n\n"),
      misconceptions: ["**错误理解：** 只看最后结果就能确认过程正确\n\n**错因：** 结果可能来自错误输入或遗漏步骤\n\n**正确判断：** 输入、规则和输出都需要核对\n\n**核对方法：** 先检查条件，再逐步比较处理过程和目标"],
      coverageEvidence: [],
      questions: [
        { kind: "comprehension", prompt: "输入指出什么？", options: [], expectedAnswer: "输入指出规则要处理的对象。", explanation: "先确定对象，才能判断规则是否适用。" },
        { kind: "comprehension", prompt: "为什么要核对输出？", options: [], expectedAnswer: "核对输出可以确认结果满足目标。", explanation: "执行完规则后还要比较结果和目标。" },
        { kind: "multiple_choice", prompt: "处理后要做什么？", options: ["核对输出", "忽略目标", "删除输入", "跳过规则"], expectedAnswer: "核对输出", explanation: "比较输出与目标可以检查处理结果。" },
        { kind: "multiple_choice", prompt: "开始处理前先确认什么？", options: ["输入和条件", "最终排版", "无关背景", "后续结论"], expectedAnswer: "输入和条件", explanation: "输入和条件确定规则是否适用。" }
      ]
    }
  };
}

function emptyUsage() {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, apiEquivalentUsd: null, durationMs: 0 };
}

function inputFor(page: CourseRelease["pages"][number], release: CourseRelease): ModelRouterInput {
  return {
    pageTitle: page.title,
    pageNumber: page.pageNumber,
    sourceText: `Source for page ${page.pageNumber}`,
    writingPolicySnapshotId: release.writingPolicySnapshotId,
    language: "zh-CN",
    qualityMode: "balanced",
    idempotencyKey: `campaign-pre-interruption:${page.id}`,
    maxCostUsd: 4,
    stage: "teach"
  };
}

function durableCost(jobId: string, release: CourseRelease, generation: TeachingGenerationResult): GenerationCostEntry {
  return {
    id: `campaign-durable-cost:${jobId}:page-1`,
    workspaceId: "personal",
    courseId: release.courseId,
    materialVersionId: release.id,
    pageId: "page-1",
    objectId: "draft:page-1",
    jobId,
    stage: "teach",
    provider: generation.provider,
    model: generation.model,
    inputTokens: generation.usage.inputTokens,
    outputTokens: generation.usage.outputTokens,
    cachedInputTokens: generation.usage.cachedInputTokens,
    unitPriceSnapshot: {
      id: "campaign-price",
      provider: generation.provider,
      model: generation.model,
      currency: "USD",
      capturedAt: "2026-09-29T00:00:00.000Z",
      source: "campaign fixture",
      inputMicrousdPerMillion: 0,
      outputMicrousdPerMillion: 0,
      cachedInputMicrousdPerMillion: 0
    },
    estimatedMicrousd: 1_000,
    actualMicrousd: 1_000,
    durationMs: generation.usage.durationMs,
    retries: 0,
    status: "succeeded",
    qualityPassed: true,
    billingMode: "metered",
    cashCostMicrousd: 1_000,
    quotaConsumedMicrousd: 0,
    estimatedCashCostMicrousd: 1_000,
    estimatedQuotaConsumedMicrousd: 0,
    costBasis: "provider_reported",
    createdAt: "2026-09-29T00:00:00.000Z"
  };
}

function writeContext(idempotencyKey: string) {
  return {
    idempotencyKey,
    actor: "test",
    workspaceId: "personal",
    requestId: idempotencyKey,
    schemaVersion: COURSE_API_VERSION
  };
}

async function createJob(app: ReturnType<typeof createApp>, releaseId: string, pageIds: string[]): Promise<string> {
  const response = await request(app).post("/api/v1/generation-jobs")
    .set("Idempotency-Key", `campaign-job-${releaseId}-${pageIds.join("-")}`)
    .send({ materialVersionId: releaseId, pageIds, budgetUsd: 4 }).expect(202);
  return response.body.id as string;
}

async function getJob(dependencies: ReturnType<typeof createDefaultDependencies>, jobId: string) {
  return (await dependencies.operations.readTaskIndex()).jobs.find((job) => job.id === jobId);
}

async function waitForJob(dependencies: ReturnType<typeof createDefaultDependencies>, jobId: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const job = await getJob(dependencies, jobId);
    if (job && ["completed", "failed", "cancelled"].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("GENERATION_RECOVERY_CAMPAIGN_TIMEOUT");
}
