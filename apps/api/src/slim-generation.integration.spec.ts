import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COURSE_API_VERSION, type CourseRelease, type PageLesson, type ReleaseManifest, type TeachingAtom } from "@course-os/contracts";
import { FileReadWeaveCourseApi } from "@course-os/readweave-adapter";
import { createApp, createDefaultDependencies } from "./app.js";
import { HttpProviderTeachingClient, type ModelRouterClient, type TeachingPackage } from "./model-router.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const visualObservation = "页面将输入、处理规则与输出并列呈现，读者应逐项核对三者的关系。";
const historicalFooter = "USC Viterbi · EE 680 · 5/5";

describe("slim page generation integration", () => {
  it("saves legacy, OCR, formula, chart, code, and footer-5 lessons with bounded calls and concurrent page requests", async () => {
    const pageInputs = new Map<number, string>();
    const requestKeys = new Map<string, number>();
    const phaseCallsByPage = new Map<number, string[]>();
    const modelCallsByPage = new Map<number, number>();
    const activeModelPages = new Set<number>();
    let maxInFlightModelPages = 0;
    const activeProviderPages = new Set<number>();
    let maxInFlightProviderPages = 0;
    let providerPairReached = false;
    let releaseProviderPair!: () => void;
    const providerPairGate = new Promise<void>((resolve) => {
      releaseProviderPair = resolve;
    });

    const provider = new HttpProviderTeachingClient({
      providerId: "deepseek",
      baseUrl: "https://deepseek.test",
      apiKey: "synthetic-test-credential",
      model: "deepseek-flash",
      protocol: "responses",
      supportsVision: false,
      billingMode: "metered"
    });

    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async (input) => {
        requestKeys.set(input.idempotencyKey, input.pageNumber);
        pageInputs.set(input.pageNumber, input.sourceText);
        modelCallsByPage.set(input.pageNumber, (modelCallsByPage.get(input.pageNumber) ?? 0) + 1);
        activeModelPages.add(input.pageNumber);
        maxInFlightModelPages = Math.max(maxInFlightModelPages, activeModelPages.size);
        try {
          return await provider.generateTeachingPackage(input);
        } finally {
          activeModelPages.delete(input.pageNumber);
        }
      }
    };

    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const idempotencyKey = new Headers(init?.headers).get("Idempotency-Key") ?? "";
      const requestEntry = [...requestKeys].find(([key]) => idempotencyKey.startsWith(key + ":"));
      if (!requestEntry) throw new Error("SYNTHETIC_PROVIDER_REQUEST_WITHOUT_PAGE_KEY");
      const pageNumber = requestEntry[1];
      const phase = idempotencyKey.slice(requestEntry[0].length + 1);
      const pagePhases = phaseCallsByPage.get(pageNumber) ?? [];
      pagePhases.push(phase);
      phaseCallsByPage.set(pageNumber, pagePhases);

      activeProviderPages.add(pageNumber);
      maxInFlightProviderPages = Math.max(maxInFlightProviderPages, activeProviderPages.size);
      if (activeProviderPages.size >= 2 && !providerPairReached) {
        providerPairReached = true;
        releaseProviderPair();
      }

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!providerPairReached) {
          await Promise.race([
            providerPairGate,
            new Promise<void>((_resolve, reject) => {
              timeout = setTimeout(() => reject(new Error("SYNTHETIC_PROVIDER_REQUESTS_WERE_SERIAL")), 3_000);
            })
          ]);
        }
        const output = phase === "plan"
          ? "先明确页面对象，再解释处理关系，最后核对结论。"
          : JSON.stringify(teachingPackageFor(pageNumber));
        return Response.json({
          model: "deepseek-flash",
          output_text: output,
          usage: { input_tokens: 100, output_tokens: 200, total_cost: 0.001 }
        });
      } finally {
        if (timeout) clearTimeout(timeout);
        activeProviderPages.delete(pageNumber);
      }
    });
    vi.stubGlobal("fetch", fetchMock);

    const root = await mkdtemp(join(tmpdir(), "course-os-slim-generation-"));
    const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
    const dependencies = createDefaultDependencies(root, readweave, modelRouter);
    const app = createApp(dependencies);
    const writingPolicy = await request(app).get("/api/v1/writing-policy/current").expect(200);
    const course = await request(app).post("/api/v1/courses")
      .set("Idempotency-Key", "slim-generation-course")
      .send({ title: "Slim generation integration course" })
      .expect(201);
    const release = syntheticRelease(writingPolicy.body.policySnapshotId, course.body.id);

    await readweave.publishRelease(release, syntheticManifest(release), {
      idempotencyKey: "slim-generation-seed",
      actor: "test",
      workspaceId: "personal",
      schemaVersion: COURSE_API_VERSION,
      requestId: "slim-generation-seed"
    });

    const accepted = await request(app).post("/api/v1/generation-plans")
      .set("Idempotency-Key", "slim-generation-six-page-plan")
      .send({
        materialVersionId: release.id,
        pageIds: release.pageIds,
        budgetUsd: 8,
        qualityMode: "balanced",
        language: "zh-CN"
      });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    const completed = await waitForPlan(app, accepted.body.plan.id);

    expect(completed.state).toBe("completed");
    expect(completed.completedPageIds).toEqual(release.pageIds);
    expect(maxInFlightModelPages).toBeGreaterThanOrEqual(2);
    expect(maxInFlightProviderPages).toBeGreaterThanOrEqual(2);

    for (const page of release.pages) {
      const draft = await readweave.getDraftByPage(page.id);
      expect(draft?.status, page.id).toBe("ready");
      expect(draft?.page.lessonSections?.find((section) => section.kind === "main_content")?.markdown).toContain("先识别输入");
      expect(draft?.page.blocks.find((block) => block.kind === "core")?.markdown).toContain("先识别输入");
      expect(modelCallsByPage.get(page.pageNumber)).toBe(1);

      const textRegionIds = draft!.page.atoms.filter((atom) => atom.kind === "text_region").map((atom) => atom.id);
      const requiredAtomIds = draft!.page.coverageRequirements.map((requirement) => requirement.atomId);
      expect(requiredAtomIds.some((atomId) => textRegionIds.includes(atomId))).toBe(false);
      expect(draft!.page.quality.issues.filter((issue) => issue.includes(":MISSING:"))).toEqual([]);
      expect(draft!.page.quality.generalCoverage).toBe(1);

      const phases = phaseCallsByPage.get(page.pageNumber) ?? [];
      expect(phases).toContain("plan");
      expect(phases).toContain("teaching");
      expect(phases.length).toBeLessThanOrEqual(3);
      expect(phases.filter((phase) => phase === "format_repair").length).toBeLessThanOrEqual(1);
    }

    expect(pageInputs.get(1)).toContain("旧版讲解（供重写参考，不代表原图文字）");
    expect(pageInputs.get(5)).toContain(historicalFooter);
  }, 45_000);
});

function syntheticRelease(writingPolicySnapshotId: string, courseId: string): CourseRelease {
  const fixtures: Array<{
    title: string;
    sourceText?: string;
    atom?: TeachingAtom;
    oldHighQuality?: boolean;
  }> = [
    { title: "旧版高质量页面", oldHighQuality: true },
    { title: "文本页面", sourceText: "输入确定处理对象\n规则限定允许的步骤\n输出需要与目标核对" },
    {
      title: "公式页面",
      sourceText: "线性关系\ny = mx + b",
      atom: {
        kind: "math_expression",
        id: "fixture:page:3:formula",
        sourceTex: "y=mx+b",
        normalizedTex: "y = mx + b",
        symbols: [
          { symbol: "y", meaning: "输出" },
          { symbol: "m", meaning: "变化率" },
          { symbol: "x", meaning: "输入" },
          { symbol: "b", meaning: "初始偏移" }
        ],
        parseStatus: "valid"
      }
    },
    {
      title: "图表页面",
      sourceText: "图表展示输入经过规则后得到的输出",
      atom: {
        kind: "chart_series",
        id: "fixture:page:4:series",
        label: "输出",
        unit: "个",
        encoding: "y",
        observation: "输出随输入变化"
      }
    },
    { title: "带历史页脚的第五页", sourceText: "历史页面说明输入与输出的关系\n" + historicalFooter },
    {
      title: "代码页面",
      sourceText: "代码逐步检查输入并计算输出",
      atom: {
        kind: "code_block",
        id: "fixture:page:6:code",
        language: "pseudo",
        code: "if input > 0: output = input + 1",
        variables: [
          { name: "input", type: "number", role: "输入对象", lifetime: "当前步骤" },
          { name: "output", type: "number", role: "计算结果", lifetime: "当前步骤" }
        ],
        branches: ["input > 0"],
        executionTrace: ["读取 input", "计算 output"]
      }
    }
  ];
  const pages = fixtures.map((fixture, index) => syntheticPage(
    index + 1,
    fixture.title,
    fixture.sourceText,
    fixture.atom,
    fixture.oldHighQuality
  ));

  return {
    id: "slim-generation-fixture-release",
    courseId,
    courseTitle: "Slim generation integration course",
    moduleId: "slim-synthetic-module",
    moduleTitle: "Slim generation",
    version: 1,
    publishedAt: "2026-09-23T00:00:00.000Z",
    pageIds: pages.map((page) => page.id),
    pages,
    assessments: [],
    manifestHash: "slim-synthetic-manifest",
    writingPolicySnapshotId,
    modelRoute: "synthetic-provider",
    qualityHarnessVersion: "synthetic",
    costUsd: 0
  };
}
function syntheticPage(
  pageNumber: number,
  title: string,
  sourceText?: string,
  extraAtom?: TeachingAtom,
  oldHighQuality = false
): PageLesson {
  const pageId = "slim-fixture:page:" + pageNumber;
  const visualAtomId = pageId + ":visual";
  const textRegions: TeachingAtom[] = sourceText
    ? sourceText.split(/\r?\n/u).filter((line) => line.trim()).map((line, index) => ({
      kind: "text_region",
      id: pageId + ":ocr:" + (index + 1),
      label: "OCR line " + (index + 1),
      observation: line.trim()
    }))
    : [];
  return {
    id: pageId,
    pageNumber,
    title,
    imageUrl: "",
    anchors: sourceText ? [{
      id: pageId + ":source-text",
      pageId,
      kind: "text",
      label: "Offline extracted text",
      text: sourceText
    }] : [],
    atoms: [
      {
        kind: "image_region",
        id: visualAtomId,
        label: "Page relationship",
        observation: visualObservation
      },
      ...textRegions,
      ...(extraAtom ? [extraAtom] : [])
    ],
    blocks: [{
      id: pageId + ":core",
      title: "Core explanation",
      kind: "core",
      markdown: oldHighQuality ? "可复核的旧版讲解：输入经过规则得到输出。" : "现有讲解草稿需要按本页来源重新核对。",
      sourceAnchorIds: [],
      atomIds: [visualAtomId]
    }],
    coverageRequirements: [{
      id: pageId + ":visual-requirement",
      atomId: visualAtomId,
      requiredFields: ["observation"],
      risk: "general"
    }],
    coverageClaims: [],
    quality: {
      highRiskCoverage: 1,
      generalCoverage: oldHighQuality ? 1 : 0,
      mathValid: true,
      publishable: oldHighQuality,
      issues: oldHighQuality ? [] : ["TEACHING_GENERATION_REQUIRED"]
    }
  } as PageLesson;
}

function teachingPackageFor(pageNumber: number): TeachingPackage {
  const explanationLine = "页面将输入、处理规则与输出并列呈现，读者应逐项核对三者的关系。";
  return {
    learningObjectives: ["能够解释输入、规则和输出之间的关系"],
    mainContentMarkdown: "先识别输入，再按照规则处理对象，最后核对输出是否满足目标。",
    priorKnowledge: [
      "输入（Input）：输入是处理开始前已经掌握的信息；它指出规则要处理的对象，也限定后续步骤的起点；先分清输入与结果，才能判断规则是否正确作用于目标对象。"
    ],
    fullExplanationMarkdown: [
      "## 核对对象与处理关系",
      explanationLine,
      "输入指出规则要处理的对象，执行规则后把输出与目标逐项核对。",
      "遇到公式、图表或代码时，先辨认对象，再按页面给出的关系解释变化。",
      "只根据已经给出的条件判断结果，不把页脚或装饰文字当成教学结论。"
    ].join("\n\n").repeat(2),
    misconceptions: [
      "**错误理解：** 只看最后结果就能判断处理正确\n\n**错因：** 结果可能来自错误输入或跳过条件的步骤\n\n**正确判断：** 必须同时核对输入、规则和输出\n\n**核对方法：** 逐步检查每个条件是否满足，再确认结果符合目标"
    ],
    coverageEvidence: [{
      atomId: "slim-fixture:page:" + pageNumber + ":visual",
      coveredFields: ["observation"],
      explanation: explanationLine
    }],
    questions: [
      {
        kind: "comprehension",
        prompt: "输入在处理过程中起什么作用？",
        options: [],
        expectedAnswer: "输入指出规则要处理的对象，并提供执行步骤的起点。",
        explanation: "先确定对象和起点，才能按规则检查后续步骤。"
      },
      {
        kind: "comprehension",
        prompt: "为什么不能只看最后的输出？",
        options: [],
        expectedAnswer: "因为还要核对输入和规则是否正确，输出是否满足目标。",
        explanation: "相同结果可能由不同过程得到，检查过程才能发现条件遗漏。"
      },
      {
        kind: "multiple_choice",
        prompt: "应用规则前，首先要确认什么？",
        options: ["输入和适用条件", "最终答案的排版", "后续章节的结论", "与任务无关的背景"],
        expectedAnswer: "输入和适用条件",
        explanation: "规则只有作用于正确对象并满足条件时，结果才有意义。"
      },
      {
        kind: "multiple_choice",
        prompt: "执行规则后，下一步应做什么？",
        options: ["将输出与目标核对", "删除输入记录", "跳过适用条件", "直接更换问题"],
        expectedAnswer: "将输出与目标核对",
        explanation: "核对输出可以确认规则执行结果是否符合任务目标。"
      }
    ]
  };
}

function syntheticManifest(release: CourseRelease): ReleaseManifest {
  return {
    id: release.id + ":manifest",
    schemaVersion: COURSE_API_VERSION,
    courseReleaseId: release.id,
    sourceHashes: [],
    pageHashes: [],
    explanationHashes: [],
    assessmentHashes: [],
    writingPolicySnapshotId: release.writingPolicySnapshotId,
    modelRoutes: ["synthetic-provider"],
    qualityHarnessVersion: "synthetic",
    costInputs: [],
    createdAt: release.publishedAt
  };
}

async function waitForPlan(app: ReturnType<typeof createApp>, planId: string) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const current = await request(app).get("/api/v1/generation-plans/" + planId).expect(200);
    if (["awaiting_review", "completed", "failed", "cancelled"].includes(current.body.plan.state)) return current.body.plan;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("SLIM_GENERATION_PLAN_TEST_TIMEOUT");
}
