import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CourseRelease, GenerationJob, ModelProviderConfig, ModelRoutePolicy, ReleaseManifest } from "@course-os/contracts";
import { FileReadWeaveCourseApi } from "@course-os/readweave-adapter";
import { createApp, createDefaultDependencies, executeGenerationJob, type AppDependencies } from "./app.js";
import { providerRouterFromSettings, type ModelRouterClient, type ModelRouterInput, type TeachingGenerationResult } from "./model-router.js";

const envKeys = ["COURSE_OS_EXTERNAL_WORKER", "COURSE_OS_GENERATION_CONCURRENCY", "COURSE_OS_KUAFU_MAX_IN_FLIGHT"] as const;
let priorEnv: Partial<Record<(typeof envKeys)[number], string>> = {};
const fixtureRoots: string[] = [];

beforeEach(() => {
  priorEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.COURSE_OS_EXTERNAL_WORKER = "true";
  process.env.COURSE_OS_GENERATION_CONCURRENCY = "1";
  process.env.COURSE_OS_KUAFU_MAX_IN_FLIGHT = "1";
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of envKeys) {
    const value = priorEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(fixtureRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("single-page bridge dependencies", () => {
  it("releases the core slot, waits for the queued predecessor body, and serializes actual Kuafu bridge calls", async () => {
    const release = makeRelease(3);
    const bridgeCalls: Array<{ pageTitle: string; previousTeaching?: string; currentSummary: string }> = [];
    let settingsLoads = 0;
    const provider = providerConfig();
    const policy = providerPolicy();
    const providerRouter = providerRouterFromSettings({ load: async () => {
      settingsLoads += 1;
      return { providers: [provider], policy, credential: async () => "fixture-kuafu-token" };
    } });
    const coreCalls: number[] = [];
    const router: ModelRouterClient = {
      generateTeachingPackage: async input => {
        coreCalls.push(input.pageNumber);
        return teachingResult(input.pageNumber);
      },
      generateBridge: input => providerRouter.generateBridge!(input)
    };
    const fixture = await makeFixture(release, router);
    const later = await createJob(fixture.app, release.id, "page-2", "later-body-first");
    const earlier = await createJob(fixture.app, release.id, "page-1", "earlier-predecessor");
    await attachPlan(fixture.dependencies, [later.id, earlier.id], "ordered-plan");

    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const firstBridgeGate = deferred<void>();
    const firstBridgeEntered = deferred<void>();
    let activeBridgeCalls = 0;
    let peakBridgeCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string };
      const prompt = JSON.parse(body.input) as { pageTitle: string; previousTeaching?: string; currentSummary: string };
      bridgeCalls.push(prompt);
      activeBridgeCalls += 1;
      peakBridgeCalls = Math.max(peakBridgeCalls, activeBridgeCalls);
      try {
        if (bridgeCalls.length === 1) {
          firstBridgeEntered.resolve();
          await firstBridgeGate.promise;
        }
        return Response.json({ model: "deepseek-v4.1-flash", output_text: `BRIDGE_${prompt.pageTitle}`,
          usage: { input_tokens: 50, output_tokens: 30, total_cost: 0.001 } });
      } finally {
        activeBridgeCalls -= 1;
      }
    });

    let laterRun: Promise<void> | undefined;
    let earlierRun: Promise<void> | undefined;
    try {
      laterRun = executeGenerationJob(later.id, fixture.dependencies);
      await waitForCoreSaved(fixture.dependencies, later.id, "page-2");
      expect(await fixture.readweave.getDraftByPage("page-2")).toMatchObject({ status: "ready", page: { pageNumber: 2 } });
      expect(await jobState(fixture.dependencies, earlier.id)).toBe("queued");
      expect(coreCalls).toEqual([2]);

      await waitForBridgeWait(fixture.dependencies, later.id);
      await waitFor(() => timeoutSpy.mock.calls.some(([, delay]) => delay === 1_000), "the predecessor poll");
      expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 120_000)).toBe(false);
      expect(await jobState(fixture.dependencies, later.id)).toBe("running");
      expect(fetchSpy).not.toHaveBeenCalled();

      earlierRun = executeGenerationJob(earlier.id, fixture.dependencies);
      await firstBridgeEntered.promise;
      await waitFor(() => settingsLoads >= 2, "later page entering the provider semaphore");
      await waitForBridgeWait(fixture.dependencies, earlier.id);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(activeBridgeCalls).toBe(1);
      expect(peakBridgeCalls).toBe(1);

      firstBridgeGate.resolve();
      await Promise.all([earlierRun, laterRun]);
      expect(await jobState(fixture.dependencies, earlier.id)).toBe("completed");
      expect(await jobState(fixture.dependencies, later.id)).toBe("completed");
      expect(coreCalls).toEqual([2, 1]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(peakBridgeCalls).toBe(1);
      const laterBridge = bridgeCalls.find(call => call.pageTitle === "测试页面 2");
      expect(laterBridge?.previousTeaching).toContain("CORE_BODY_PAGE_1");
      expect(laterBridge?.previousTeaching).not.toContain("BRIDGE_测试页面 1");
      expect(laterBridge?.currentSummary).toContain("MAIN_CONTENT_PAGE_2");
    } finally {
      firstBridgeGate.resolve();
      await Promise.allSettled([laterRun, earlierRun].filter((run): run is Promise<void> => Boolean(run)));
    }
  }, 15_000);

  it("cancels a predecessor waiter and proves its released slot cannot be released twice", async () => {
    const release = makeRelease(3);
    const coreCalls: number[] = [];
    let activeBodies = 0;
    let peakBodies = 0;
    const bodyGate = deferred<void>();
    const bridgeCalls: number[] = [];
    const router: ModelRouterClient = {
      generateTeachingPackage: async input => {
        coreCalls.push(input.pageNumber);
        if (input.pageNumber !== 2) {
          activeBodies += 1;
          peakBodies = Math.max(peakBodies, activeBodies);
          try { await bodyGate.promise; }
          finally { activeBodies -= 1; }
        }
        return teachingResult(input.pageNumber);
      },
      generateBridge: async input => {
        bridgeCalls.push(input.pageNumber);
        return bridgeResult(`BRIDGE_${input.pageNumber}`);
      }
    };
    const fixture = await makeFixture(release, router);
    const waiter = await createJob(fixture.app, release.id, "page-2", "cancelled-waiter");
    const predecessor = await createJob(fixture.app, release.id, "page-1", "queued-predecessor");
    await attachPlan(fixture.dependencies, [waiter.id, predecessor.id], "cancel-plan");
    let waiterRun: Promise<void> | undefined;
    let pageOneRun: Promise<void> | undefined;
    let pageThreeRun: Promise<void> | undefined;
    try {
      waiterRun = executeGenerationJob(waiter.id, fixture.dependencies);
      await waitForCoreSaved(fixture.dependencies, waiter.id, "page-2");
      await waitForBridgeWait(fixture.dependencies, waiter.id);
      await request(fixture.app).post(`/api/v1/generation-jobs/${waiter.id}:cancel`)
        .set("Idempotency-Key", "cancel-bridge-waiter").send({}).expect(200);
      await waiterRun;
      expect(await jobState(fixture.dependencies, waiter.id)).toBe("cancelled");
      expect(coreCalls).toEqual([2]);
      expect(bridgeCalls).toEqual([]);
      expect(await fixture.readweave.getDraftByPage("page-2")).toMatchObject({ status: "ready" });

      const pageThree = await createJob(fixture.app, release.id, "page-3", "slot-after-cancel");
      await attachPlan(fixture.dependencies, [pageThree.id], "cancel-plan");
      pageOneRun = executeGenerationJob(predecessor.id, fixture.dependencies);
      pageThreeRun = executeGenerationJob(pageThree.id, fixture.dependencies);
      await waitFor(() => activeBodies > 0, "a body after cancellation");
      await pause(100);
      expect(activeBodies).toBe(1);
      expect(peakBodies).toBe(1);
      bodyGate.resolve();
      await Promise.all([pageOneRun, pageThreeRun]);
      expect(peakBodies).toBe(1);
      expect(coreCalls.filter(pageNumber => pageNumber === 2)).toHaveLength(1);
      expect(new Set(coreCalls)).toEqual(new Set([1, 2, 3]));
    } finally {
      bodyGate.resolve();
      await Promise.allSettled([waiterRun, pageOneRun, pageThreeRun].filter((run): run is Promise<void> => Boolean(run)));
    }
  }, 15_000);

  it("keeps the core draft unchanged and records each paid receipt once when cancellation wins an in-flight bridge", async () => {
    const release = makeRelease(2);
    const bridgeEntered = deferred<void>();
    const bridgeGate = deferred<void>();
    let bridgeCalls = 0;
    const router: ModelRouterClient = {
      generateTeachingPackage: async input => teachingResult(input.pageNumber),
      generateBridge: async () => {
        bridgeCalls += 1;
        bridgeEntered.resolve();
        await bridgeGate.promise;
        return bridgeResult("LATE_BRIDGE_AFTER_CANCEL");
      }
    };
    const fixture = await makeFixture(release, router);
    const job = await createJob(fixture.app, release.id, "page-2", "cancel-inflight-bridge");
    let run: Promise<void> | undefined;
    try {
      run = executeGenerationJob(job.id, fixture.dependencies);
      await bridgeEntered.promise;

      const coreDraft = await fixture.readweave.getDraftByPage("page-2");
      expect(coreDraft).toMatchObject({ status: "ready" });
      expect(coreDraft?.page.lessonSections?.some(section => section.kind === "chapter_bridge")).toBe(false);
      const coreReceipts = await fixture.readweave.listCostEntries({ jobId: job.id, pageId: "page-2" });
      expect(coreReceipts).toHaveLength(1);
      expect(coreReceipts[0]).toMatchObject({ status: "succeeded", actualMicrousd: 25_000 });

      await request(fixture.app).post(`/api/v1/generation-jobs/${job.id}:cancel`)
        .set("Idempotency-Key", "cancel-inflight-bridge-api").send({}).expect(200)
        .expect(({ body }) => expect(body.state).toBe("cancelled"));
      expect(await jobState(fixture.dependencies, job.id)).toBe("cancelled");

      bridgeGate.resolve();
      await run;

      const after = await fixture.readweave.getDraftByPage("page-2");
      expect(after).toMatchObject({ revision: coreDraft!.revision, contentHash: coreDraft!.contentHash });
      expect(after?.page.lessonSections?.some(section => section.kind === "chapter_bridge")).toBe(false);
      expect(bridgeCalls).toBe(1);
      expect(await jobState(fixture.dependencies, job.id)).toBe("cancelled");

      const receipts = await fixture.readweave.listCostEntries({ jobId: job.id, pageId: "page-2" });
      expect(receipts).toHaveLength(2);
      expect(new Set(receipts.map(entry => entry.id)).size).toBe(2);
      expect(receipts.filter(entry => entry.id === coreReceipts[0]!.id)).toHaveLength(1);
      expect(receipts.find(entry => entry.id.endsWith(":bridge"))).toMatchObject({
        status: "failed", actualMicrousd: 1_000
      });
      const events = await fixture.dependencies.operations.readGenerationJobEvents(job.id);
      expect(events.filter(event => event.type === "generation.page.core_saved")).toHaveLength(1);
      expect(events.some(event => event.type === "generation.page.completed")).toBe(false);
    } finally {
      bridgeGate.resolve();
      await Promise.allSettled([run].filter((pending): pending is Promise<void> => Boolean(pending)));
    }
  }, 15_000);

  it.each([
    { name: "no matching predecessor job", predecessorState: "queued", matchingPlan: false, expired: false, expected: "PREVIOUS_CORE_UNAVAILABLE" },
    { name: "failed predecessor", predecessorState: "failed", matchingPlan: true, expired: false, expected: "PREVIOUS_CORE_UNAVAILABLE" },
    { name: "cancelled predecessor", predecessorState: "cancelled", matchingPlan: true, expired: false, expected: "PREVIOUS_CORE_UNAVAILABLE" },
    { name: "completed predecessor without a ready core", predecessorState: "completed", matchingPlan: true, expired: false, expected: "PREVIOUS_CORE_UNAVAILABLE" },
    { name: "expired predecessor lease", predecessorState: "running", matchingPlan: true, expired: true, expected: "PREVIOUS_CORE_LEASE_EXPIRED" }
  ])("fails closed for $name instead of using raw source as previous teaching", async scenario => {
    const release = makeRelease(2);
    const coreCalls: number[] = [];
    const bridgeCalls: number[] = [];
    const router: ModelRouterClient = {
      generateTeachingPackage: async input => {
        coreCalls.push(input.pageNumber);
        return teachingResult(input.pageNumber);
      },
      generateBridge: async input => {
        bridgeCalls.push(input.pageNumber);
        return bridgeResult("should-not-run");
      }
    };
    const fixture = await makeFixture(release, router);
    const current = await createJob(fixture.app, release.id, "page-2", `current-${scenario.name}`);
    const predecessor = await createJob(fixture.app, release.id, "page-1", `predecessor-${scenario.name}`);
    await attachPlan(fixture.dependencies, [current.id], "current-plan");
    await fixture.dependencies.operations.mutate(state => {
      const job = state.jobs.find(candidate => candidate.id === predecessor.id)!;
      job.planId = scenario.matchingPlan ? "current-plan" : "other-plan";
      job.state = scenario.predecessorState as GenerationJob["state"];
      if (scenario.expired) job.lease = { owner: "orphan-worker", fenceToken: 1, expiresAt: new Date(Date.now() - 5_000).toISOString() };
    });

    await executeGenerationJob(current.id, fixture.dependencies);
    expect(await jobState(fixture.dependencies, current.id)).toBe("failed");
    const saved = (await fixture.dependencies.operations.readTaskIndex()).jobs.find(job => job.id === current.id);
    expect(saved).toMatchObject({ lastErrorCode: scenario.expected, failedPageIds: ["page-2"] });
    expect(coreCalls).toEqual([2]);
    expect(bridgeCalls).toEqual([]);
    expect(await fixture.readweave.getDraftByPage("page-2")).toMatchObject({ status: "ready" });
  }, 12_000);
});

async function makeFixture(release: CourseRelease, router: ModelRouterClient) {
  const root = await mkdtemp(join(tmpdir(), "course-os-bridge-dependency-"));
  fixtureRoots.push(root);
  const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
  await readweave.publishRelease(release, manifest(release.id), {
    idempotencyKey: `seed-${release.id}`, actor: "bridge-dependency-spec", workspaceId: "personal",
    schemaVersion: "2.1.0", requestId: `seed-${release.id}`
  });
  const dependencies = createDefaultDependencies(root, readweave, router);
  return { app: createApp(dependencies), dependencies, readweave };
}

async function createJob(app: ReturnType<typeof createApp>, releaseId: string, pageId: string, key: string): Promise<GenerationJob> {
  const response = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", key)
    .send({ materialVersionId: releaseId, pageIds: [pageId], budgetUsd: 4 }).expect(202);
  return response.body as GenerationJob;
}

async function attachPlan(dependencies: AppDependencies, jobIds: string[], planId: string): Promise<void> {
  await dependencies.operations.mutate(state => {
    for (const job of state.jobs) if (jobIds.includes(job.id)) job.planId = planId;
  });
}

async function waitForCoreSaved(dependencies: AppDependencies, jobId: string, pageId: string): Promise<void> {
  await waitFor(async () => (await dependencies.operations.readGenerationJobEvents(jobId)).some(event =>
    event.type === "generation.page.core_saved" && (event.payload as { pageId?: string }).pageId === pageId), `core_saved ${pageId}`);
}

async function waitForBridgeWait(dependencies: AppDependencies, jobId: string): Promise<void> {
  await waitFor(async () => (await dependencies.operations.readGenerationJobEvents(jobId)).some(event =>
    event.type === "generation.stage.started" && (event.payload as { phase?: string; activity?: string }).phase === "bridge"
      && (event.payload as { activity?: string }).activity === "await_previous_core"), `bridge wait ${jobId}`);
}

async function jobState(dependencies: AppDependencies, jobId: string): Promise<GenerationJob["state"] | undefined> {
  return (await dependencies.operations.readTaskIndex()).jobs.find(job => job.id === jobId)?.state;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function providerConfig(): ModelProviderConfig {
  return {
    id: "kuafu", displayName: "Kuafu fixture", baseUrl: "https://kuafu.fixture.test/v1", enabled: true,
    credential: { configured: true },
    models: [{ id: "deepseek-v4.1-flash", displayName: "DeepSeek fixture", protocol: "responses",
      supportsVision: false, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" }]
  };
}

function providerPolicy(): ModelRoutePolicy {
  return {
    workspaceId: "personal", allowProviderFallback: false, allowAialraEmergencyFallback: false,
    updatedAt: new Date(0).toISOString(),
    routes: [{ providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true }],
    rules: [{ stage: "teach", providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true }]
  };
}

function makeRelease(count: number): CourseRelease {
  const pages = Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const pageId = `page-${n}`;
    const anchorId = `source-anchor-${n}`;
    return {
      id: pageId, pageNumber: n, title: `测试页面 ${n}`, imageUrl: `/page-${n}.png`,
      anchors: [{ id: anchorId, pageId, kind: "text" as const, label: `页面 ${n} 来源文字`, text: `PAGE_SOURCE_${n} 描述待解释的问题与条件。` }],
      atoms: [],
      blocks: [{ id: `block-${n}`, title: "核心说明", kind: "core" as const, markdown: `SOURCE_BLOCK_${n}`, sourceAnchorIds: [anchorId], atomIds: [] }],
      lessonSections: [
        { id: `objective-section-${n}`, kind: "learning_objectives" as const, title: "学习目标", items: [{ id: `objective-${n}`, text: `解释页面 ${n} 的核心关系`, sourceAnchorIds: [anchorId] }], sourceAnchorIds: [anchorId], atomIds: [] },
        { id: `main-section-${n}`, kind: "main_content" as const, title: "主要内容", markdown: `SOURCE_MAIN_${n}`, sourceAnchorIds: [anchorId], atomIds: [] },
        { id: `prior-section-${n}`, kind: "prior_knowledge" as const, title: "先验知识", items: [{ id: `prior-${n}`, text: "先识别对象和适用条件，再解释规则如何作用于对象并产生可检查的结果；输入、处理过程和输出各有职责，不能用结论代替推理过程。", sourceAnchorIds: [anchorId] }], sourceAnchorIds: [anchorId], atomIds: [] },
        { id: `full-section-${n}`, kind: "full_explanation" as const, title: "完整讲解", markdown: `SOURCE_EXPLANATION_${n}`, sourceAnchorIds: [anchorId], atomIds: [] },
        { id: `misconceptions-section-${n}`, kind: "misconceptions" as const, title: "易错点", items: [{ id: `misconception-${n}`, text: "跳过适用条件会让后续规则失去依据；应先核验对象和前提，再逐步检查处理过程及输出。", sourceAnchorIds: [anchorId] }], sourceAnchorIds: [anchorId], atomIds: [] }
      ],
      questionBank: [
        { id: `question-c1-${n}`, pageId, objectiveId: `objective-${n}`, kind: "comprehension" as const, prompt: "规则处理的对象是什么？", expectedAnswer: "由输入和条件确定的对象", explanation: "先读清对象和条件，再判断规则能否适用；否则无法说明处理过程及结果为何成立。", sourceAnchorIds: [anchorId], status: "approved" as const, version: 1, generatedBy: "fixture" },
        { id: `question-c2-${n}`, pageId, objectiveId: `objective-${n}`, kind: "comprehension" as const, prompt: "如何检查处理结果？", expectedAnswer: "将输出与目标和前提比较", explanation: "过程结束并不自动证明结果正确，还要回到目标核对输出是否满足题设条件。", sourceAnchorIds: [anchorId], status: "approved" as const, version: 1, generatedBy: "fixture" },
        { id: `question-m1-${n}`, pageId, objectiveId: `objective-${n}`, kind: "multiple_choice" as const, prompt: "开始分析时先做什么？", options: ["确认输入", "跳过前提", "先写结论", "忽略目标"], expectedAnswer: "确认输入", explanation: "明确输入才能判断规则的作用对象和适用范围。", sourceAnchorIds: [anchorId], status: "approved" as const, version: 1, generatedBy: "fixture" },
        { id: `question-m2-${n}`, pageId, objectiveId: `objective-${n}`, kind: "multiple_choice" as const, prompt: "完成处理后要做什么？", options: ["核对输出", "删除条件", "忽略结果", "改写问题"], expectedAnswer: "核对输出", explanation: "把输出与目标比较，才知道处理是否完成预期任务。", sourceAnchorIds: [anchorId], status: "approved" as const, version: 1, generatedBy: "fixture" }
      ],
      coverageRequirements: [], coverageClaims: [],
      quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable: true, issues: [] }
    };
  });
  return {
    id: "bridge-dependency-release", courseId: "bridge-dependency-course", courseTitle: "桥接依赖回归夹具",
    moduleId: "bridge-dependency-module", moduleTitle: "测试模块", version: 1,
    publishedAt: "2026-10-01T00:00:00.000Z", pageIds: pages.map(page => page.id), pages, assessments: [],
    manifestHash: "fixture-manifest-hash", writingPolicySnapshotId: "policy-v1", modelRoute: "fixture-router",
    qualityHarnessVersion: "fixture-quality-v1", costUsd: 0
  };
}

function manifest(releaseId: string): ReleaseManifest {
  return {
    id: `${releaseId}:manifest`, schemaVersion: "2.1.0", courseReleaseId: releaseId, sourceHashes: [], pageHashes: [],
    explanationHashes: [], assessmentHashes: [], writingPolicySnapshotId: "policy-v1", modelRoutes: ["fixture-router"],
    qualityHarnessVersion: "fixture-quality-v1", costInputs: [], createdAt: "2026-10-01T00:00:00.000Z"
  };
}

function teachingResult(pageNumber: number): TeachingGenerationResult {
  return {
    provider: "aialra-model-router", model: "fixture-teacher",
    usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 200, apiEquivalentUsd: 0.025, durationMs: 10 },
    content: {
      learningObjectives: [`说明页面 ${pageNumber} 的对象、条件和处理结果`],
      mainContentMarkdown: `MAIN_CONTENT_PAGE_${pageNumber}\n- 识别对象与适用条件\n- 说明规则如何改变对象状态\n- 对照目标检查输出`,
      priorKnowledge: ["输入是规则处理前已经确认的对象及其条件；处理规则限定可以执行的步骤，输出是步骤完成后的状态。分析时要保持三者的区别，先检查条件，再解释规则如何作用于对象，最后将输出与目标比较。"],
      fullExplanationMarkdown: `## 对象与处理过程\n\nCORE_BODY_PAGE_${pageNumber}：先确认输入对象及其适用条件，再逐步说明规则如何作用于对象。\n\n## 检查结果\n\n处理后把输出与目标逐项比较；如果条件缺失，就不能直接套用规则或宣布结果成立。`,
      misconceptions: ["把最终结论当作推理过程会跳过输入条件；先核对条件，再解释规则和对象之间的关系，最后检查输出是否达到目标。"],
      coverageEvidence: [],
      questions: [
        { kind: "comprehension", prompt: "规则作用于什么？", options: [], expectedAnswer: "由输入条件确定的对象", explanation: "明确输入对象及其条件，才能判断规则是否适用并说明输出从何而来。" },
        { kind: "comprehension", prompt: "如何判断结果有效？", options: [], expectedAnswer: "把输出与目标及条件核对", explanation: "处理步骤结束不等于目标达成，还要回到条件检查输出。" },
        { kind: "multiple_choice", prompt: "分析的起点是什么？", options: ["确认输入", "跳过条件", "先写结论", "忽略目标"], expectedAnswer: "确认输入", explanation: "输入决定规则的对象和适用条件，不能省略。" },
        { kind: "multiple_choice", prompt: "分析的最后一步是什么？", options: ["核对输出", "删除规则", "忽略结果", "改写题意"], expectedAnswer: "核对输出", explanation: "将输出和目标比较才能检查过程是否完成要求。" }
      ]
    }
  };
}

function bridgeResult(markdown: string) {
  return { markdown, provider: "fixture-bridge", model: "fixture-bridge-model",
    usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 8, apiEquivalentUsd: 0.001, durationMs: 1 } };
}
