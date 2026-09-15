import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileReadWeaveCourseApi, type ReadWeaveCourseApi } from "@course-os/readweave-adapter";
import type { CourseRelease, IdempotentWriteContext, QuestionBankItem, ReleaseManifest } from "@course-os/contracts";
import { unpairedEnglishTeachingFields } from "@course-os/quality";
import { applyTeachingPackage, applySemanticAuditFindings, createApp, createDefaultDependencies, evaluateQuestionAnswer, executeGenerationJob, mergeFocusedTeachingRepair, normalizeGeneratedMathPunctuation, normalizeTeachingPackageMath, safeReadWeaveFailureKind, validateTeachingCoverageEvidence } from "./app.js";
import { ModelRouterGenerationError, type ModelRouterClient, type TeachingGenerationResult, type TeachingPackage } from "./model-router.js";

afterEach(() => vi.restoreAllMocks());

async function testApp() {
  const root = await mkdtemp(join(tmpdir(), "course-os-api-"));
  const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
  return createApp(createDefaultDependencies(root, readweave));
}

async function seededApp(modelRouter?: ModelRouterClient, seededRelease = testRelease()) {
  const root = await mkdtemp(join(tmpdir(), "course-os-api-seeded-"));
  const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
  const release = seededRelease;
  await readweave.publishRelease(release, testManifest(release.id), {
    idempotencyKey: "seed-release",
    actor: "test",
    workspaceId: "personal",
    schemaVersion: "2.1.0",
    requestId: "seed-release"
  });
  const dependencies = createDefaultDependencies(root, readweave, modelRouter);
  return { app: createApp(dependencies), dependencies, operations: dependencies.operations, readweave, release };
}

describe("Course OS API", () => {
  it("records a safe ReadWeave failure kind without exposing a private response", () => {
    expect(safeReadWeaveFailureKind(new Error("READWEAVE_ETAPI_503:private response"))).toBe("http_503");
    expect(safeReadWeaveFailureKind(new Error("READWEAVE_ETAPI_NETWORK:This operation was aborted"))).toBe("timeout");
    expect(safeReadWeaveFailureKind(new Error("READWEAVE_DRAFT_READBACK_MISMATCH"))).toBe("readback_mismatch");
    expect(safeReadWeaveFailureKind(new Error("READWEAVE_PAGE_OVERVIEW_CONFLICT:private detail"))).toBe("readweave_page_overview_conflict");
  });
  it("reads a structured page and its release without listing every release", async () => {
    const release = testRelease();
    release.id = "structured-release";
    release.pageIds = ["structured-release:page:1"];
    release.pages[0]!.id = release.pageIds[0]!;
    const { app, readweave } = await seededApp(undefined, release);
    const listReleases = vi.spyOn(readweave, "listReleases").mockRejectedValue(new Error("FULL_RELEASE_SCAN_FORBIDDEN"));
    expect((await request(app).get("/api/v1/pages/structured-release:page:1/lesson").expect(200)).body.page.id).toBe(release.pageIds[0]);
    expect((await request(app).get("/api/v1/releases/structured-release").expect(200)).body.id).toBe(release.id);
    expect(listReleases).not.toHaveBeenCalled();
  });

  it("returns a lightweight release index without sending lesson bodies", async () => {
    const { app, release } = await seededApp();
    const full = await request(app).get("/api/v1/releases").expect(200);
    const index = await request(app).get("/api/v1/releases?view=index").expect(200);
    const indexed = index.body.find((item: CourseRelease) => item.id === release.id) as CourseRelease;
    expect(indexed.pages).toHaveLength(release.pages.length);
    expect(indexed.pages[0]).toMatchObject({ id: release.pages[0]!.id, title: release.pages[0]!.title, blocks: [], atoms: [], anchors: [], questionBank: [] });
    expect(indexed.pages[0]!.quality).toEqual(release.pages[0]!.quality);
    expect(JSON.stringify(index.body).length).toBeLessThan(JSON.stringify(full.body).length);
  });

  it("serves the learner lesson from a saved draft snapshot without waiting for block reconciliation", async () => {
    const { app, readweave } = await seededApp();
    const snapshot = await readweave.getDraftByPage("page-1");
    const fastRead = vi.fn(async () => snapshot);
    (readweave as ReadWeaveCourseApi).getDraftSnapshotByPage = fastRead;
    const reconciledRead = vi.spyOn(readweave, "getDraftByPage").mockRejectedValue(new Error("SLOW_BLOCK_RECONCILIATION"));
    await request(app).get("/api/v1/pages/page-1/lesson").expect(200);
    expect(fastRead).toHaveBeenCalledWith("page-1");
    expect(reconciledRead).not.toHaveBeenCalled();
  });

  it("applies only exact, unambiguous semantic corrections and preserves unrelated fields", () => {
    const before = testTeachingResult(0).content;
    before.misconceptions[0] = "原始比值是 1.2，但裁剪后仍是 1.2";
    const applied = applySemanticAuditFindings(before, [{ field: "misconceptions:0", original: "原始比值是 1.2", replacement: "原始比值是 1.5", evidence: "来源页：0.30 / 0.20 = 1.5" }]);
    expect(applied.content.misconceptions[0]).toContain("原始比值是 1.5，但裁剪后仍是 1.2");
    expect(applied.content.fullExplanationMarkdown).toBe(before.fullExplanationMarkdown);
    expect(before.misconceptions[0]).toContain("原始比值是 1.2");
    const replayed = applySemanticAuditFindings(applied.content, [{ field: "misconceptions:0", original: "原始比值是 1.2", replacement: "原始比值是 1.5", evidence: "来源页：0.30 / 0.20 = 1.5" }]);
    expect(replayed.content).toEqual(applied.content);
    expect(replayed.fields).toEqual([]);
    expect(() => applySemanticAuditFindings(before, [{ field: "fullExplanationMarkdown", original: "不存在的句子", replacement: "改写", evidence: "来源" }])).toThrow();
    expect(() => applySemanticAuditFindings(before, [{ field: "questions:0:expectedAnswer", original: "答案", replacement: "改写", evidence: "来源" }])).toThrow();
  });

  it("updates only evidence excerpts containing an exact corrected fact", () => {
    const before = testTeachingResult(0).content;
    before.fullExplanationMarkdown = "这里的原始比值是 1.2，用于比较这两个输入\n另外一个对象的解释保持原样且不参与本次修正";
    before.coverageEvidence = [
      { atomId: "ratio", coveredFields: ["observation"], explanation: "这里的原始比值是 1.2，用于比较这两个输入" },
      { atomId: "other", coveredFields: ["observation"], explanation: "另外一个对象的解释保持原样且不参与本次修正" }
    ];
    const applied = applySemanticAuditFindings(before, [{ field: "fullExplanationMarkdown", original: "原始比值是 1.2", replacement: "原始比值是 1.5", evidence: "0.30 除以 0.20 得到 1.5" }]);
    expect(applied.content.coverageEvidence[0]!.explanation).toContain("原始比值是 1.5");
    expect(applied.content.fullExplanationMarkdown).toContain(applied.content.coverageEvidence[0]!.explanation);
    expect(applied.content.coverageEvidence[1]).toEqual(before.coverageEvidence[1]);
    expect(before.coverageEvidence[0]!.explanation).toContain("1.2");
    expect(applied.content.questions).toEqual(before.questions);
  });

  it("keeps verified teaching fields when repairing only coverage or a prior definition", () => {
    const previous: TeachingPackage = { chapterBridgeMarkdown: "", learningObjectives: ["解释作用"], mainContentMarkdown: "- 已知关系", priorKnowledge: ["原定义"], fullExplanationMarkdown: "这里已经解释了原图中两个对象的关系，以及它们怎样共同产生结果".repeat(3), misconceptions: ["原易错点"], coverageEvidence: [{ atomId: "a1", coveredFields: ["observation"], explanation: "旧引用" }], questions: [] };
    const repaired: TeachingPackage = { ...previous, priorKnowledge: ["新定义"], fullExplanationMarkdown: "模型意外重写了讲解".repeat(6), coverageEvidence: [{ atomId: "a1", coveredFields: ["observation"], explanation: "新的真实引用" }] };
    expect(mergeFocusedTeachingRepair(previous, repaired, ["TEACHING_COVERAGE_QUOTE_NOT_FOUND:a1"])).toEqual({ ...previous, coverageEvidence: repaired.coverageEvidence });
    expect(mergeFocusedTeachingRepair(previous, repaired, ["TEACHING_PRIOR_KNOWLEDGE_TOO_SHALLOW"])).toEqual({ ...previous, priorKnowledge: repaired.priorKnowledge });
    expect(mergeFocusedTeachingRepair(previous, repaired, ["TEACHING_UNPAIRED_ENGLISH", "TEACHING_PRIOR_UNPAIRED_ENGLISH"])).toBeUndefined();
    expect(mergeFocusedTeachingRepair(previous, repaired, ["TEACHING_MISCONCEPTIONS_PACKED", "TEACHING_COVERAGE_QUOTE_NOT_FOUND:a1"])).toEqual({ ...previous, misconceptions: repaired.misconceptions, coverageEvidence: repaired.coverageEvidence });
    expect(mergeFocusedTeachingRepair(previous, { ...repaired, learningObjectives: ["修好的公式"] }, ["TEACHING_MATH_INVALID:learningObjectives"]))
      .toEqual({ ...previous, learningObjectives: ["修好的公式"] });
    expect(mergeFocusedTeachingRepair(previous, repaired, ["TEACHING_UNPAIRED_ENGLISH"], ["fullExplanationMarkdown"])).toEqual({ ...previous, fullExplanationMarkdown: repaired.fullExplanationMarkdown, coverageEvidence: repaired.coverageEvidence });
    expect(mergeFocusedTeachingRepair(previous, repaired, ["TEACHING_WEIGHTED_TREND_CONDITION_MISSING:mainContentMarkdown"]))
      .toEqual({ ...previous, mainContentMarkdown: repaired.mainContentMarkdown });
    expect(mergeFocusedTeachingRepair(previous, repaired, ["TEACHING_SOFTMAX_NORMALIZATION_CONTRADICTION:misconceptions"]))
      .toEqual({ ...previous, misconceptions: repaired.misconceptions });
    expect(mergeFocusedTeachingRepair(previous, repaired, ["TEACHING_ABBREVIATION_PLACEMENT:chapterBridgeMarkdown"]))
      .toEqual({ ...previous, chapterBridgeMarkdown: repaired.chapterBridgeMarkdown });
    expect(mergeFocusedTeachingRepair(previous, repaired, ["TEACHING_CONCAT_DIMENSION_CONTRADICTION:mainContentMarkdown"]))
      .toEqual({ ...previous, mainContentMarkdown: repaired.mainContentMarkdown });
  });

  it("quotes exact source headings and translates a formula-heading reference without changing its symbol", () => {
    const content = testTeachingResult(0).content;
    content.chapterBridgeMarkdown = "上一页把 EDGE-GNN 接入了网络";
    content.fullExplanationMarkdown += "\n\n页面的 Formula 区块给出公式，Where 区块列出维度，Intuition 一句话解释用途\n\n图中 What is happening 一栏列出计算顺序\n\n```txt\nWhat is $W_e$ 一栏\n```";
    content.misconceptions = ["核对 What is $W_e$? 区块的原图说明，不能把矩阵当成每条边各有一份"];
    const normalized = normalizeTeachingPackageMath(content,
      "EDGE-GNN: EDGE EMBEDDING\nFormula\nWhere\nIntuition\nWhat is happening?\nWhat is W_e?", "EDGE-GNN: EDGE EMBEDDING");
    expect(normalized.chapterBridgeMarkdown).toContain("“EDGE-GNN”");
    expect(normalized.fullExplanationMarkdown).toContain("“Formula” 区块");
    expect(normalized.fullExplanationMarkdown).toContain("“Where” 区块");
    expect(normalized.fullExplanationMarkdown).toContain("“Intuition” 一句话");
    expect(normalized.fullExplanationMarkdown).toContain("“What is happening”");
    expect(normalized.fullExplanationMarkdown).toContain("```txt\nWhat is $W_e$ 一栏\n```");
    expect(normalized.misconceptions[0]).toContain("解释 $W_e$ 的区块");
    expect(normalized.misconceptions[0]).not.toContain("What is");
    expect(unpairedEnglishTeachingFields({ ...normalized, sourceTitle: "EDGE-GNN: EDGE EMBEDDING" })).toEqual([]);
  });

  it("keeps source labels quoted across the explanation and misconception fields", () => {
    const content = testTeachingResult(0).content;
    content.fullExplanationMarkdown += "\n\n左栏是 Setup 部分，右栏给出“Update Rule”并解释参数怎样变化";
    content.misconceptions = ["回到页面 Update Rule 一行，核对梯度是否已经展开"];
    const normalized = normalizeTeachingPackageMath(content, "Setup\nUpdate Rule", "TINY MDP EXAMPLE");
    expect(normalized.fullExplanationMarkdown).toContain("“Setup” 部分");
    expect(normalized.misconceptions[0]).toContain("“Update Rule” 一行");
    expect(unpairedEnglishTeachingFields({ ...normalized, sourceTitle: "TINY MDP EXAMPLE" })).toEqual([]);
  });

  it("delimits bare exponent and subscript notation before teaching validation", () => {
    const content = testTeachingResult(0).content;
    content.questions[0]!.explanation = "把 e^0 = 1 代入，再比较 x_1 与 x_2";
    const normalized = normalizeTeachingPackageMath(content);
    expect(normalized.questions[0]!.explanation).toBe("把 $e^0$ = 1 代入，再比较 $x_1$ 与 $x_2$");
  });

  it("caps an already structured teaching summary without rewriting its items", () => {
    const content = testTeachingResult(0).content;
    content.mainContentMarkdown = ["第一项", "第二项", "第三项", "第四项", "第五项", "第六项"].map((item) => `- ${item}`).join("\n");
    const normalized = normalizeTeachingPackageMath(content);
    expect(normalized.mainContentMarkdown.split("\n")).toEqual(["- 第一项", "- 第二项", "- 第三项", "- 第四项", "- 第五项", "- 第六项"]);
  });

  it("normalizes abbreviation placement and repeated teaching terms", () => {
    const content = testTeachingResult(0).content;
    content.priorKnowledge = ["马尔可夫决策过程（Markov Decision Process, MDP）：一种序贯决策框架；描述状态与动作；按转移产生结果；用于连续决策；不同于单步分类；补充说明适用边界"];
    content.fullExplanationMarkdown += "\n\n动作概率由软最大函数函数计算";
    const normalized = normalizeTeachingPackageMath(content);
    expect(normalized.priorKnowledge[0]).toMatch(/^MDP 马尔可夫决策过程（Markov Decision Process）：/u);
    expect(normalized.priorKnowledge[0]!.split("；")).toHaveLength(5);
    expect(normalized.priorKnowledge[0]).toContain("不同于单步分类，补充说明适用边界");
    expect(normalized.fullExplanationMarkdown).toContain("动作概率由软最大函数计算");
    expect(normalized.fullExplanationMarkdown).not.toContain("函数函数");
  });

  it("renders source diagram labels as quotations instead of code", () => {
    const content = testTeachingResult(0).content;
    content.fullExplanationMarkdown += "\n\n椭圆标记 `Agent`，方框写着 `Macro order: place larger ones first`";
    const normalized = normalizeTeachingPackageMath(content, "Agent\nMacro order: place larger ones first");
    expect(normalized.fullExplanationMarkdown).toContain("椭圆标记 “Agent”");
    expect(normalized.fullExplanationMarkdown).toContain("方框写着 “Macro order: place larger ones first”");
  });
  it("serves a workspace-scoped native QA note without scanning every release", async () => {
    const { app, readweave, release } = await seededApp();
    const pageId = release.pages[0]!.id;
    const nativeReader = vi.fn(async (requestedPageId: string, workspaceId: string) => workspaceId === "personal"
      ? { pageId: requestedPageId, noteUrl: "https://readweave.example.com/#root/known-page", questions: [] }
      : { pageId: requestedPageId, questions: [] });
    Object.assign(readweave, { listNativePageQuestions: nativeReader });
    const listReleases = vi.spyOn(readweave, "listReleases");
    const result = await request(app).get(`/api/v1/pages/${encodeURIComponent(pageId)}/readweave-questions`).set("X-Workspace-Id", "personal").expect(200);
    expect(result.body.noteUrl).toBe("https://readweave.example.com/#root/known-page");
    expect(nativeReader).toHaveBeenCalledWith(pageId, "personal");
    expect(listReleases).not.toHaveBeenCalled();
    await request(app).get(`/api/v1/pages/${encodeURIComponent(pageId)}/readweave-questions`).set("X-Workspace-Id", "other-workspace").expect(404);
  });

  it("keeps generated paragraph and list boundaries after page compilation", () => {
    const content = testTeachingResult(0).content;
    content.misconceptions = ["错误理解：差值就是平方；错因：两步运算被混为一谈；正确判断：先相减再平方；核对方法：分别计算两步"];
    content.learningObjectives = ["核对两个结果：\n\n- 先核对差值\n- 再核对平方"];
    const page = applyTeachingPackage(testRelease().pages[0]!, content, true);
    const restored = JSON.parse(JSON.stringify(page));
    expect(restored.lessonSections.find((s: {kind: string}) => s.kind === "learning_objectives").items[0].text).toBe(content.learningObjectives[0]);
    expect(restored.lessonSections.find((s: {kind: string}) => s.kind === "misconceptions").items[0].text.split("\n\n")).toHaveLength(4);
  });

  it("requires the actual coverage excerpt rather than an overlapping phrase", () => {
    const page = {
      ...testRelease().pages[0]!,
      atoms: [{ kind: "text_region" as const, id: "source-1", label: "原文片段", observation: "每条边先拼接两个端点再投影" }],
      coverageRequirements: [{ id: "requirement-1", atomId: "source-1", requiredFields: ["observation"], risk: "high" as const }]
    };
    const fullExplanationMarkdown = "先把两个端点和边本身的信息放在一起。接着用同一组权重计算边表示，维度必须与输入长度相容。";
    const content = {
      fullExplanationMarkdown,
      coverageEvidence: [{ atomId: "source-1", coveredFields: ["observation"], explanation: "接着用同一组权重计算边表示，维度必须与输入长度相容。" }]
    } as TeachingPackage;
    expect(validateTeachingCoverageEvidence(page, content)).toEqual([]);
    const paraphrasedPage = { ...page, atoms: [{ ...page.atoms[0]!, observation: "Remove the value prediction layer" }] };
    expect(validateTeachingCoverageEvidence(paraphrasedPage, { ...content, fullExplanationMarkdown: "先去掉价值预测层，再把编码器接入策略网络", coverageEvidence: [{ atomId: "source-1", coveredFields: ["observation"], explanation: "先移除价值预测层，然后连接策略网络" }] })).toContain("TEACHING_COVERAGE_QUOTE_NOT_FOUND:source-1");
    expect(validateTeachingCoverageEvidence(page, { ...content, coverageEvidence: [{ atomId: "source-1", coveredFields: ["observation"], explanation: "只声称已经覆盖这个片段，但正文没有对应的连续讲解。" }] })).toContain("TEACHING_COVERAGE_QUOTE_NOT_FOUND:source-1");
    expect(validateTeachingCoverageEvidence(page, { ...content, coverageEvidence: [content.coverageEvidence[0]!, content.coverageEvidence[0]!] }))
      .toContain("TEACHING_COVERAGE_DUPLICATE_ATOM");
  });
  it("moves Chinese list punctuation outside strict inline math without changing valid TeX", () => {
    expect(normalizeGeneratedMathPunctuation("权重 $\u0000lambda$ 与 $\\gamma$"))
      .toBe("权重 $\\lambda$ 与 $\\gamma$");
    expect(normalizeGeneratedMathPunctuation("普通文本中有 \u0000unknown 控制字符"))
      .toContain("\u0000unknown");
    expect(normalizeGeneratedMathPunctuation("权重 $0.5、3、0.2$ 用于示例")).toBe("权重 $0.5$、$3$、$0.2$ 用于示例");
    expect(normalizeGeneratedMathPunctuation("公式 $F(x)=0.5L(x)$ 保持原样")).toBe("公式 $F(x)=0.5L(x)$ 保持原样");
    expect(normalizeGeneratedMathPunctuation("文字 $\\text{甲、乙}$ 不做破坏性拆分")).toBe("文字 $\\text{甲、乙}$ 不做破坏性拆分");
    expect(normalizeGeneratedMathPunctuation("得到 $G_2=2+0=2。$")).toBe("得到 $G_2=2+0=2$。");
    expect(normalizeGeneratedMathPunctuation("比较 $gain_{后}(f)-gain_{前}(f)$")).toBe("比较 $gain_{\\text{后}}(f)-gain_{\\text{前}}(f)$");
    expect(normalizeGeneratedMathPunctuation("曲线 $对应线性端点，$ 再比较")).toBe("曲线 对应线性端点， 再比较");
    expect(normalizeGeneratedMathPunctuation("换算 $1000\\text{ μm}=1\\text{ mm}$")).toBe("换算 $1000\\,\\mu\\mathrm{m}=1\\text{ mm}$");
    expect(normalizeGeneratedMathPunctuation("$$\\frac12+\u000crac12=1。$$")).toBe("$$\\frac12+\\frac12=1$$。");
    expect(normalizeGeneratedMathPunctuation("系数 $\u0009ext{Wirelength}$ 与 $\\gamma$")).toBe("系数 $\\text{Wirelength}$ 与 $\\gamma$");
    expect(normalizeGeneratedMathPunctuation("参数 $\u0009heta_1=0.1$ 与 $\u0008eta_1=0.2$")).toBe("参数 $\\theta_1=0.1$ 与 $\\beta_1=0.2$");
  });
  it("corrects a near-miss technical term only when the page's own formula supplies one unambiguous spelling", () => {
    const content = {
      chapterBridgeMarkdown: "", learningObjectives: [], priorKnowledge: [], misconceptions: [], coverageEvidence: [], questions: [],
      mainContentMarkdown: "拥塞项是 congcyion，连接 connection 保持原样",
      fullExplanationMarkdown: "公式 $$r=-\\text{congestion}$$ 中的 congcyion 表示拥塞；`congcyion` 是代码示例"
    } as TeachingPackage;
    const normalized = normalizeTeachingPackageMath(content);
    expect(normalized.fullExplanationMarkdown).toContain("公式 $$r=-\\text{congestion}$$ 中的 congestion 表示拥塞");
    expect(normalized.fullExplanationMarkdown).toContain("`congcyion` 是代码示例");
    expect(normalized.mainContentMarkdown).toContain("congestion，连接 connection 保持原样");
  });
  it("uses the established Chinese term for bare softmax while preserving source quotations and code", () => {
    const content = {
      chapterBridgeMarkdown: "", learningObjectives: ["解释 softmax 的作用"],
      mainContentMarkdown: "- 用 softmax 得到概率", priorKnowledge: ["软最大函数（Softmax Function）：把向量转换成概率分布；用于选择动作；通过指数和归一化计算；在需要可微概率时使用；与直接取最大值不同"],
      fullExplanationMarkdown: "策略由 softmax 控制，原图标签“softmax”保持原样，代码 `softmax(x)` 保持原样",
      misconceptions: [], coverageEvidence: [], questions: []
    } as TeachingPackage;
    const normalized = normalizeTeachingPackageMath(content);
    expect(normalized.learningObjectives[0]).toBe("解释软最大函数的作用");
    expect(normalized.mainContentMarkdown).toContain("用软最大函数得到概率");
    expect(normalized.priorKnowledge[0]).toContain("软最大函数（Softmax Function）");
    expect(normalized.fullExplanationMarkdown).toContain("策略由软最大函数控制");
    expect(normalized.fullExplanationMarkdown).toContain("原图标签“softmax”保持原样");
    expect(normalized.fullExplanationMarkdown).toContain("代码 `softmax(x)` 保持原样");
  });

  it("reports liveness without waiting for ReadWeave", async () => {
    const { app, readweave } = await seededApp();
    const listReleases = vi.spyOn(readweave, "listReleases").mockRejectedValue(new Error("READWEAVE_OFFLINE"));
    const response = await request(app).get("/healthz").expect(200);
    expect(response.body).toEqual({ status: "ok", apiVersion: "2.4.0" });
    expect(listReleases).not.toHaveBeenCalled();
  });

  it("deduplicates an import by idempotency key", async () => {
    const app = await testApp();
    const source = Buffer.from("# Introduction\nAlgorithms and inputs");
    const first = await request(app).post("/api/v1/imports").set("Idempotency-Key", "import-1").field("autoGenerate", "false").attach("file", source, { filename: "lecture.md", contentType: "text/markdown" }).expect(201);
    await waitForImport(app, first.body.id);
    const second = await request(app).post("/api/v1/imports").set("Idempotency-Key", "import-1").field("autoGenerate", "false").attach("file", source, { filename: "lecture.md", contentType: "text/markdown" }).expect(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it("converts a syllabus into page images and ReadWeave drafts", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-api-import-"));
    const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
    const app = createApp(createDefaultDependencies(root, readweave));
    const course = await request(app).post("/api/v1/courses").set("Idempotency-Key", "import-course").send({ title: "通用算法课" }).expect(201);
    const accepted = await request(app).post("/api/v1/imports").set("Idempotency-Key", "syllabus-import").field("courseId", course.body.id).field("qualityMode", "quality").field("language", "zh-CN").field("autoGenerate", "false").attach("file", Buffer.from("# Week 1\nAlgorithms and complexity\n\n# Week 2\nGraphs and cuts"), { filename: "syllabus.md", contentType: "text/markdown" }).expect(201);
    const ready = await waitForImport(app, accepted.body.id);
    expect(ready).toMatchObject({ state: "ready", courseId: course.body.id, qualityMode: "quality", language: "zh-CN", autoGenerate: false, generationState: "not_requested" });
    expect(ready.pageIds).toHaveLength(1);
    expect(ready.draftIds).toHaveLength(1);
    const releases = await request(app).get("/api/v1/releases").expect(200);
    expect(releases.body.find((item: CourseRelease) => item.id === ready.materialVersionId)).toMatchObject({ lifecycle: "draft_source", pages: [{ pageNumber: 1 }] });
    const draft = await readweave.getDraftByPage(ready.pageIds[0]);
    expect(draft).toMatchObject({ status: "needs_review", revision: 1 });
    expect(draft?.page.imageUrl).toMatch(/^\/api\/v1\/media\/[a-f0-9]{64}$/);
    expect((await request(app).get("/healthz").expect(200)).body.status).toBe("ok");
  }, 45_000);

  it("creates one idempotent draft generation job after an import without publishing a release", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-api-auto-generate-"));
    const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
    const dependencies = createDefaultDependencies(root, readweave);
    const app = createApp(dependencies);
    const source = Buffer.from("# Partitioning\nSplit the system into smaller connected parts");
    const accepted = await request(app).post("/api/v1/imports").set("Idempotency-Key", "auto-generate-import").field("qualityMode", "economy").attach("file", source, { filename: "partitioning.md", contentType: "text/markdown" }).expect(201);
    const ready = await waitForImport(app, accepted.body.id);
    expect(ready).toMatchObject({ state: "ready", autoGenerate: true });
    expect(["queued", "running", "failed"]).toContain(ready.generationState);
    expect(ready.generationJobId).toBeTruthy();
    const job = await waitForJob(app, ready.generationJobId);
    expect(job).toMatchObject({ sourceImportId: ready.id, qualityMode: "economy", language: "zh-CN", writingPolicySnapshotId: "writing-policy:56493c1af3d98aa0", budgetUsd: 2 });
    const replay = await request(app).post("/api/v1/imports").set("Idempotency-Key", "auto-generate-import").attach("file", source, { filename: "partitioning.md", contentType: "text/markdown" }).expect(200);
    expect(replay.body.id).toBe(ready.id);
    expect((await dependencies.operations.read()).jobs).toHaveLength(1);
    expect((await readweave.listReleases()).filter((release) => release.lifecycle !== "draft_source")).toHaveLength(0);
  }, 45_000);

  it("fails generation when no configured model is available instead of saving a local substitute", async () => {
    const { app, readweave } = await seededApp();
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "missing-provider-job")
      .send({ materialVersionId: "test-release-v1", pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    const job = await waitForJob(app, created.body.id);
    expect(job.state).toBe("failed");
    expect(await readweave.getDraftByPage("page-1")).toBeUndefined();
  });

  it("returns a safe candidate writing policy without private paths", async () => {
    const policy = await request(await testApp()).get("/api/v1/writing-policy/current").expect(200);
    expect(policy.body).toMatchObject({ policySnapshotId: "writing-policy:56493c1af3d98aa0", sourceCommit: "installed-skill-sha256:66daa0de90d708c439cd3013ebf65aaa84786998e989d62d33f7b9a1e3a9b989", status: "approved", taskContract: "GENERATE + TEACHING", validator: { status: "passed" } });
    expect(policy.body.promptTemplate).toContain("SOURCE");
    expect(JSON.stringify(policy.body)).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\/|\/srv\//);
  });

  it("creates an idempotent isolated candidate without changing the formal release", async () => {
    const { app, readweave } = await seededApp();
    const created = await request(app).post("/api/v1/release-candidates")
      .set("Idempotency-Key", "candidate-release-1")
      .send({ baseReleaseId: "test-release-v1", releaseId: "test-release-v2-candidate", budgetUsd: 2, qualityMode: "economy" })
      .expect(202);
    expect(created.body.candidate).toMatchObject({ id: "test-release-v2-candidate", lifecycle: "draft_source", candidateBaseReleaseId: "test-release-v1", pageIds: ["test-release-v2-candidate:page:1"], writingPolicySnapshotId: "writing-policy:56493c1af3d98aa0" });
    expect(created.body.candidate.pages[0].id).not.toBe("page-1");
    expect(created.body.candidate.pages[0].blocks[0].id).toContain("test-release-v2-candidate:page:1");
    expect((await readweave.listReleases()).filter((item) => item.lifecycle !== "draft_source")).toHaveLength(1);
    const replay = await request(app).post("/api/v1/release-candidates")
      .set("Idempotency-Key", "candidate-release-1")
      .send({ baseReleaseId: "test-release-v1", releaseId: "test-release-v2-candidate" })
      .expect(200);
    expect(replay.body.candidate.id).toBe(created.body.candidate.id);
    expect((await readweave.listReleases()).filter((item) => item.id === "test-release-v2-candidate")).toHaveLength(1);
  }, 45_000);

  it("runs a generation plan one single-page batch at a time", async () => {
    const { app, operations, release } = await seededApp({ generateTeachingPackage: async () => testTeachingResult(0) }, testReleaseWithPages(3));
    const created = await request(app).post("/api/v1/release-candidates")
      .set("Idempotency-Key", "candidate-plan-serial")
      .send({ baseReleaseId: release.id, releaseId: "test-release-v2-serial-candidate", budgetUsd: 2, qualityMode: "economy" })
      .expect(202);
    const completed = await waitForPlan(app, created.body.generationPlan.id);
    expect(completed).toMatchObject({ state: "completed", pageIds: [
      "test-release-v2-serial-candidate:page:1",
      "test-release-v2-serial-candidate:page:2",
      "test-release-v2-serial-candidate:page:3"
    ], completedPageIds: [
      "test-release-v2-serial-candidate:page:1",
      "test-release-v2-serial-candidate:page:2",
      "test-release-v2-serial-candidate:page:3"
    ] });
    expect(completed.jobIds).toHaveLength(3);
    const jobs = (await operations.read()).jobs.filter((job) => job.planId === completed.id);
    expect(jobs).toHaveLength(3);
    expect(jobs.every((job) => job.pageIds.length === 1)).toBe(true);
    expect(jobs.map((job) => job.batchIndex)).toEqual([0, 1, 2]);
    expect(jobs.every((job) => job.batchCount === 3)).toBe(true);
  }, 45_000);

  it("holds a selected candidate anchor plan for review without generating other pages", async () => {
    const { app, readweave, release } = await seededApp({ generateTeachingPackage: async () => testTeachingResult(0) }, testReleaseWithPages(8));
    const created = await request(app).post("/api/v1/release-candidates")
      .set("Idempotency-Key", "candidate-plan-anchors")
      .send({ baseReleaseId: release.id, releaseId: "test-release-v2-anchor-candidate", pageNumbers: [1, 2, 3, 4, 5, 6], holdForReview: true, budgetUsd: 2, qualityMode: "economy" })
      .expect(202);
    expect(created.body.draftIds).toHaveLength(6);
    expect(await readweave.listDrafts()).toHaveLength(6);
    const completed = await waitForPlan(app, created.body.generationPlan.id);
    expect(completed).toMatchObject({ state: "completed", pageIds: [
      "test-release-v2-anchor-candidate:page:1",
      "test-release-v2-anchor-candidate:page:2",
      "test-release-v2-anchor-candidate:page:3",
      "test-release-v2-anchor-candidate:page:4",
      "test-release-v2-anchor-candidate:page:5",
      "test-release-v2-anchor-candidate:page:6"
    ] });
    expect(completed.completedPageIds).toHaveLength(6);
    expect(completed.jobIds).toHaveLength(6);
    const candidate = await readweave.getRelease("test-release-v2-anchor-candidate");
    expect(candidate?.lifecycle).toBe("draft_source");
    expect((await readweave.getRelease(release.id))?.lifecycle).not.toBe("draft_source");
  }, 45_000);

  it("continues after a failed page and retries only that page", async () => {
    const keys: string[] = [];
    let calls = 0;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async (input) => {
        keys.push(input.idempotencyKey);
        calls += 1;
        if (calls === 1) throw new ModelRouterGenerationError("MODEL_ROUTER_FAILED:TEMPORARY", "gpt-5.6-sol", { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, apiEquivalentUsd: 0, durationMs: 10 });
        return testTeachingResult(0.001);
      }
    };
    const { app, operations, release } = await seededApp(modelRouter, testReleaseWithPages(2));
    const created = await request(app).post("/api/v1/release-candidates")
      .set("Idempotency-Key", "candidate-plan-retry")
      .send({ baseReleaseId: release.id, releaseId: "test-release-v2-retry-candidate", budgetUsd: 2, qualityMode: "economy" })
      .expect(202);
    const failedPlan = await waitForPlan(app, created.body.generationPlan.id);
    expect(failedPlan).toMatchObject({ state: "failed", failedPageIds: ["test-release-v2-retry-candidate:page:1"], completedPageIds: ["test-release-v2-retry-candidate:page:2"] });
    const failedJob = (await operations.read()).jobs.find((job) => job.id === failedPlan.jobIds[0]);
    expect(failedJob?.failedPageIds).toEqual(["test-release-v2-retry-candidate:page:1"]);
    await request(app).post(`/api/v1/generation-jobs/${failedJob!.id}:retry`).set("Idempotency-Key", "candidate-plan-retry-page").expect(202);
    const recovered = await waitForPlan(app, failedPlan.id);
    expect(recovered).toMatchObject({ state: "completed", failedPageIds: [], completedPageIds: ["test-release-v2-retry-candidate:page:1", "test-release-v2-retry-candidate:page:2"] });
    expect(keys).toHaveLength(3);
    expect(keys[0]).toContain("test-release-v2-retry-candidate:page:1");
    expect(keys[1]).toContain("test-release-v2-retry-candidate:page:2");
    expect(keys[2]).toContain("test-release-v2-retry-candidate:page:1");
  }, 60_000);

  it("deduplicates the same uploaded source even when the idempotency key changes", async () => {
    const app = await testApp();
    const source = Buffer.from("# Same source\nThe source must be stored once");
    const first = await request(app).post("/api/v1/imports").set("Idempotency-Key", "import-source-1").field("autoGenerate", "false").attach("file", source, { filename: "same.md", contentType: "text/markdown" }).expect(201);
    await waitForImport(app, first.body.id);
    const second = await request(app).post("/api/v1/imports").set("Idempotency-Key", "import-source-2").field("autoGenerate", "false").attach("file", source, { filename: "same.md", contentType: "text/markdown" }).expect(200);
    expect(second.body.id).toBe(first.body.id);
  }, 45_000);

  it("rejects a generation plan when its release uses a different writing policy snapshot", async () => {
    const { app, release } = await seededApp();
    await request(app).post("/api/v1/generation-plans").set("Idempotency-Key", "policy-mismatch-plan").send({ materialVersionId: release.id, pageIds: release.pageIds, budgetUsd: 2 }).expect(409).expect((response) => {
      expect(response.body.error).toMatchObject({ code: "WRITING_POLICY_SNAPSHOT_CHANGED" });
    });
  });

  it("removes an exact rejected import without affecting other records", async () => {
    const app = await testApp();
    const rejected = await request(app)
      .post("/api/v1/imports")
      .set("Idempotency-Key", "rejected-import")
      .attach("file", Buffer.from("not a pdf"), { filename: "broken.pdf", contentType: "application/pdf" })
      .expect(422);
    await request(app).delete(`/api/v1/imports/${rejected.body.id}`).expect(204);
    await request(app).get(`/api/v1/imports/${rejected.body.id}`).expect(404);
    await request(app).delete(`/api/v1/imports/${rejected.body.id}`).expect(204);
  });

  it("rejects a job over the hard budget", async () => {
    await request(await testApp()).post("/api/v1/generation-jobs").set("Idempotency-Key", "job-1").send({ materialVersionId: "m1", pageIds: [], budgetUsd: 8.01 }).expect(422);
  });

  it("rejects generation jobs without a real material page", async () => {
    const { app, release } = await seededApp();
    await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "job-no-pages").send({ materialVersionId: release.id, pageIds: [], budgetUsd: 4 }).expect(422);
    await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "job-wrong-page").send({ materialVersionId: release.id, pageIds: ["missing-page"], budgetUsd: 4 }).expect(422);
  });

  it("does not mark a paraphrased free-text answer wrong or change mastery", async () => {
    const { app, readweave, release } = await seededApp();
    const session = await request(app).post("/api/v1/sessions").send({ courseReleaseId: release.id }).expect(201);
    const selected = await request(app).post("/api/v1/pages/page-1/questions:select").set("Idempotency-Key", "free-text-select").send({ sessionId: session.body.id, seed: "free-text-seed", count: 2 }).expect(201);
    const question = selected.body.questions.find((item: QuestionBankItem) => item.kind === "comprehension") as QuestionBankItem;
    const payload = { selectionId: selected.body.selection.id, sessionId: session.body.id, courseReleaseId: release.id, pageId: "page-1", questionId: question.id, answer: "先确认起点，按步骤处理，再看结果", usedHintLevel: 0 };
    const saved = await request(app).post("/api/v1/question-attempts").set("Idempotency-Key", "free-text-attempt").send(payload).expect(201);
    expect(saved.body).toMatchObject({ attempt: { correct: null }, mastery: null, evaluationState: "unverified" });
    expect(saved.headers["server-timing"]).toMatch(/release;dur=.+save;dur=/);
    await request(app).post("/api/v1/question-attempts").set("Idempotency-Key", "free-text-attempt").send(payload).expect(201);
    expect(await readweave.listQuestionAttempts()).toHaveLength(1);
    expect(await readweave.listAssessmentAttempts()).toHaveLength(0);
    expect(await readweave.listMastery()).toHaveLength(0);
  });

  it("accepts equivalent numeric answers while keeping choice grading exact", () => {
    const comprehension = { ...testRelease().pages[0]!.questionBank![0]!, expectedAnswer: "0.1225" };
    expect(evaluateQuestionAnswer(comprehension, "0.1225000")).toBe(true);
    expect(evaluateQuestionAnswer(comprehension, "0.35")).toBe(false);
    expect(evaluateQuestionAnswer(comprehension, "差值平方后是 0.1225")).toBe(null);
    const choice = testRelease().pages[0]!.questionBank![2]!;
    expect(evaluateQuestionAnswer(choice, "忽略条件")).toBe(false);
  });

  it("stores QA changes, reproducible mixed questions, attempts and generation costs in ReadWeave", async () => {
    const { app, operations, readweave, release } = await seededApp({ generateTeachingPackage: async () => testTeachingResult(0) });
    const session = await request(app).post("/api/v1/sessions").send({ courseReleaseId: release.id }).expect(201);
    const asked = await request(app).post(`/api/v1/sessions/${session.body.id}/questions`).set("Idempotency-Key", "qa-create").send({ pageId: "page-1", learnerAttempt: "先比较输入", question: "为什么要检查前提", hintLevel: 1, anchorIds: [] }).expect(201);
    expect(asked.body).toMatchObject({ reviewPolicy: "include", status: "active", revision: 1 });
    const excluded = await request(app).patch(`/api/v1/questions/${asked.body.id}/review-policy`).set("Idempotency-Key", "qa-exclude").send({ baseRevision: 1, reviewPolicy: "exclude" }).expect(200);
    expect(excluded.body).toMatchObject({ reviewPolicy: "exclude", revision: 2 });
    const retracted = await request(app).post(`/api/v1/questions/${asked.body.id}:retract`).set("Idempotency-Key", "qa-retract").send({ baseRevision: 2 }).expect(200);
    expect(retracted.body).toMatchObject({ status: "retracted", revision: 3 });

    const first = await request(app).post("/api/v1/pages/page-1/questions:select").set("Idempotency-Key", "select-1").send({ sessionId: session.body.id, seed: "fixed-seed", count: 2 }).expect(201);
    const second = await request(app).post("/api/v1/pages/page-1/questions:select").set("Idempotency-Key", "select-2").send({ sessionId: session.body.id, seed: "fixed-seed", count: 2 }).expect(201);
    expect(second.body.questions.map((item: { id: string }) => item.id)).toEqual(first.body.questions.map((item: { id: string }) => item.id));
    expect(first.body.questions.map((item: { kind: string }) => item.kind)).toEqual(["comprehension", "multiple_choice"]);
    const question = first.body.questions[0];
    const attemptPayload = { selectionId: first.body.selection.id, sessionId: session.body.id, courseReleaseId: release.id, pageId: "page-1", questionId: question.id, answer: question.expectedAnswer, usedHintLevel: 0 };
    const savedAttempt = await request(app).post("/api/v1/question-attempts").set("Idempotency-Key", "attempt-1").send(attemptPayload).expect(201);
    const replayedAttempt = await request(app).post("/api/v1/question-attempts").set("Idempotency-Key", "attempt-1").send({ ...attemptPayload, answer: "这次请求不应新增记录" }).expect(201);
    expect(replayedAttempt.body).toMatchObject({ attempt: { id: savedAttempt.body.attempt.id, answer: question.expectedAnswer }, mastery: savedAttempt.body.mastery });
    expect(await readweave.listQuestionAttempts()).toHaveLength(1);
    expect(await readweave.listAssessmentAttempts()).toHaveLength(1);

    const createdJob = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "generate-page-1").send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 4 }).expect(202);
    const completed = await waitForJob(app, createdJob.body.id);
    expect(completed).toMatchObject({ state: "completed", completedPageIds: ["page-1"], spentUsd: 0 });
    const costs = await request(app).get(`/api/v1/costs?jobId=${createdJob.body.id}`).expect(200);
    expect(costs.body.entries).toHaveLength(1);
    expect(costs.body.rollups.find((item: { scope: string }) => item.scope === "job").actualMicrousd).toBe(0);
    const events = (await operations.read()).events.filter((event) => event.streamId === createdJob.body.id);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "generation.stage.started",
      "generation.stage.completed",
      "generation.page.completed",
      "job.completed"
    ]));
    expect(events.some((event) => event.type === "generation.stage.completed" && (event.payload as { stage?: string }).stage === "atomize")).toBe(true);
  }, 15_000);

  it("records the persisted ReadWeave draft hash in the completed-page event", async () => {
    const { app, operations, readweave, release } = await seededApp({ generateTeachingPackage: async () => testTeachingResult(0) });
    const originalSave = readweave.saveDraft.bind(readweave);
    vi.spyOn(readweave, "saveDraft").mockImplementation((draft, revision, context, asset) =>
      originalSave({ ...draft, contentHash: `remote:${draft.contentHash}` }, revision, context, asset));
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "persisted-hash-job").send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 4 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed" });
    const saved = await readweave.getDraftByPage("page-1");
    const event = (await operations.read()).events.find((item) => item.streamId === created.body.id && item.type === "generation.page.completed");
    expect(saved?.contentHash).toMatch(/^remote:/);
    expect(event?.payload).toMatchObject({ contentHash: saved?.contentHash, draftRevision: saved?.revision });
  }, 15_000);

  it("adds refill questions as drafts and keeps the refill idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-api-refill-"));
    const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
    const release = testRelease();
    release.id = "refill-release-v1";
    release.pages[0]!.questionBank = release.pages[0]!.questionBank!.slice(0, 2);
    release.pageIds = [release.pages[0]!.id];
    const refillContext: IdempotentWriteContext = {
      idempotencyKey: "refill-release",
      actor: "test",
      workspaceId: "personal",
      requestId: "refill-release",
      schemaVersion: "2.1.0"
    };
    await readweave.publishRelease(release, { ...testManifest(release.id), courseReleaseId: release.id }, {
      ...refillContext,
      idempotencyKey: "refill-release",
    });
    const app = createApp(createDefaultDependencies(root, readweave));
    const session = await request(app).post("/api/v1/sessions").send({ courseReleaseId: release.id }).expect(201);
    const first = await request(app).post(`/api/v1/pages/page-1/questions:refill`).set("Idempotency-Key", "refill-1").send({ baseRevision: 0 }).expect(201);
    expect(first.body).toMatchObject({ pageId: "page-1", available: 2, draftCount: 2, revision: 1 });
    expect(first.body.added).toHaveLength(2);
    expect(first.body.added.every((item: QuestionBankItem) => item.status === "draft")).toBe(true);
    const second = await request(app).post(`/api/v1/pages/page-1/questions:refill`).set("Idempotency-Key", "refill-2").send({ baseRevision: 1 }).expect(200);
    expect(second.body).toMatchObject({ added: [], available: 2, draftCount: 2, revision: 1 });
    expect(session.body.courseReleaseId).toBe(release.id);
  });

  it("selects and grades only ready candidate draft questions, with idempotent replay", async () => {
    const { app, readweave } = await seededApp();
    const candidate = testRelease();
    candidate.id = "candidate-questions-v2";
    candidate.lifecycle = "draft_source";
    candidate.pageIds = ["candidate-page-1"];
    candidate.pages = replaceTestIds(candidate.pages, "page-1", "candidate-page-1");
    candidate.pages[0]!.questionBank = [];
    await readweave.registerDraftSource(candidate, {
      idempotencyKey: "candidate-questions-source", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "candidate-questions-source"
    });
    const session = await request(app).post("/api/v1/sessions").send({ courseReleaseId: candidate.id }).expect(201);
    const selectionUrl = "/api/v1/pages/candidate-page-1/questions:select";
    await request(app).post(selectionUrl).set("Idempotency-Key", "candidate-not-ready").send({ sessionId: session.body.id, count: 2 }).expect(409);

    const draftQuestions = testRelease().pages[0]!.questionBank!.map((question) => ({ ...question, id: `candidate-${question.id}`, pageId: "candidate-page-1" }));
    await readweave.saveDraft({
      id: "draft:candidate-page-1", workspaceId: "personal", courseId: candidate.courseId, moduleId: candidate.moduleId,
      sourceReleaseId: candidate.id, pageId: "candidate-page-1", revision: 0, status: "ready",
      page: { ...candidate.pages[0]!, questionBank: draftQuestions }, changedBlockIds: [], contentHash: "candidate-ready-hash",
      updatedAt: new Date().toISOString()
    }, 0, { idempotencyKey: "candidate-questions-ready", actor: "test", workspaceId: "personal", schemaVersion: "2.4.0", requestId: "candidate-questions-ready" });

    const selected = await request(app).post(selectionUrl).set("Idempotency-Key", "candidate-select")
      .send({ sessionId: session.body.id, seed: "candidate-seed", count: 2 }).expect(201);
    expect(selected.body.available).toBe(4);
    expect(selected.body.questions).toHaveLength(2);
    expect(selected.body.questions.every((question: QuestionBankItem) => question.id.startsWith("candidate-"))).toBe(true);
    const question = selected.body.questions[0] as QuestionBankItem;
    const payload = { selectionId: selected.body.selection.id, sessionId: session.body.id, courseReleaseId: candidate.id,
      pageId: "candidate-page-1", questionId: question.id, answer: question.expectedAnswer, usedHintLevel: 0 };
    const saved = await request(app).post("/api/v1/question-attempts").set("Idempotency-Key", "candidate-attempt").send(payload).expect(201);
    expect(saved.body.attempt.correct).toBe(true);
    const replayed = await request(app).post("/api/v1/question-attempts").set("Idempotency-Key", "candidate-attempt").send(payload).expect(201);
    expect(replayed.body.attempt.id).toBe(saved.body.attempt.id);
    expect(await readweave.listQuestionAttempts()).toHaveLength(1);
    expect(await readweave.listAssessmentAttempts()).toHaveLength(1);
  });

  it("lets only one concurrent dispatcher claim and execute a queued page job", async () => {
    const previousExternalWorker = process.env.COURSE_OS_EXTERNAL_WORKER;
    process.env.COURSE_OS_EXTERNAL_WORKER = "true";
    try {
      const modelRouter: ModelRouterClient = { generateTeachingPackage: async () => testTeachingResult(0.005) };
      const { app, dependencies, operations, release } = await seededApp(modelRouter);
      const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "concurrent-dispatch-job")
        .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
      await Promise.all([
        executeGenerationJob(created.body.id, dependencies),
        executeGenerationJob(created.body.id, dependencies)
      ]);
      const state = await operations.read();
      const events = state.events.filter((event) => event.streamId === created.body.id);
      expect(events.filter((event) => event.type === "job.running")).toHaveLength(1);
      expect(events.filter((event) => event.type === "generation.stage.started" && (event.payload as Record<string, unknown>).pageId === "page-1" && (event.payload as Record<string, unknown>).stage === "extract")).toHaveLength(1);
      expect(state.jobs.find((job) => job.id === created.body.id)?.attempt).toBe(1);
    } finally {
      if (previousExternalWorker === undefined) delete process.env.COURSE_OS_EXTERNAL_WORKER;
      else process.env.COURSE_OS_EXTERNAL_WORKER = previousExternalWorker;
    }
  });

  it("records failed provider usage in the authoritative cost ledger", async () => {
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async () => {
        throw new ModelRouterGenerationError("MODEL_ROUTER_FAILED:DEADLINE_EXCEEDED", "gpt-5.6-sol", {
          inputTokens: 120,
          cachedInputTokens: 40,
          outputTokens: 80,
          apiEquivalentUsd: 0.0123,
          durationMs: 180_000
        });
      }
    };
    const { app, release } = await seededApp(modelRouter);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "failed-cost-job").send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 7 }).expect(202);
    const failed = await waitForJob(app, created.body.id);
    expect(failed).toMatchObject({ state: "failed", failedPageIds: ["page-1"], spentUsd: 0.0123 });
    const costs = await request(app).get(`/api/v1/costs?jobId=${created.body.id}`).expect(200);
    expect(costs.body.entries).toEqual([expect.objectContaining({ status: "failed", model: "gpt-5.6-sol", actualMicrousd: 12_300, inputTokens: 120, outputTokens: 80 })]);
    expect(costs.body.rollups.find((item: { scope: string }) => item.scope === "job").actualMicrousd).toBe(12_300);
  }, 60_000);

  it("includes successful generation usage when a later field repair fails", async () => {
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async () => {
        const result = testTeachingResult(0.005);
        result.content.chapterBridgeMarkdown = "上一页使用 PDA 这个未解释的缩写讨论输入，本页继续沿用它来解释过程";
        return result;
      },
      repairTeachingFields: async () => { throw new ModelRouterGenerationError("MODEL_PROVIDER_FAILED:429", "gpt-5.6-sol", {inputTokens:50,cachedInputTokens:0,outputTokens:20,apiEquivalentUsd:0.003,durationMs:100}); }
    };
    const {app,release} = await seededApp(modelRouter);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key","paid-then-failed").send({materialVersionId:release.id,pageIds:["page-1"],budgetUsd:1}).expect(202);
    const job = await waitForJob(app,created.body.id);
    expect(job).toMatchObject({state:"failed",spentUsd:0.008});
    const costs = await request(app).get(`/api/v1/costs?jobId=${job.id}`).expect(200);
    expect(costs.body.entries.reduce((sum:number,item:{actualMicrousd:number})=>sum+item.actualMicrousd,0)).toBe(8000);
  });

  it("records already billed usage after cancellation without saving a stale draft", async () => {
    const beforeEnv = process.env.COURSE_OS_EXTERNAL_WORKER;
    process.env.COURSE_OS_EXTERNAL_WORKER = "true";
    let releaseModel!: (result: TeachingGenerationResult) => void;
    let enteredModel!: () => void;
    const entered = new Promise<void>(resolve => { enteredModel = resolve; });
    const pending = new Promise<TeachingGenerationResult>(resolve => { releaseModel = resolve; });
    try {
      const {app,release,dependencies,readweave} = await seededApp({generateTeachingPackage:async()=>{enteredModel();return pending;}});
      const save = vi.spyOn(readweave,"saveDraft");
      const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key","cancel-paid-job").send({materialVersionId:release.id,pageIds:["page-1"],budgetUsd:1}).expect(202);
      const execution = executeGenerationJob(created.body.id,dependencies);
      await entered;
      await request(app).post(`/api/v1/generation-jobs/${created.body.id}:cancel`).set("Idempotency-Key","cancel-paid-request").send({}).expect(200);
      releaseModel(testTeachingResult(0.005));
      await execution;
      const job = await request(app).get(`/api/v1/generation-jobs/${created.body.id}`).expect(200);
      expect(job.body).toMatchObject({state:"cancelled",spentUsd:0.005});
      expect(save).not.toHaveBeenCalled();
      const costs = await request(app).get(`/api/v1/costs?jobId=${created.body.id}`).expect(200);
      expect(costs.body.entries).toHaveLength(1);
      expect(costs.body.entries[0].actualMicrousd).toBe(5000);
    } finally {
      releaseModel?.(testTeachingResult(0.005));
      if(beforeEnv===undefined)delete process.env.COURSE_OS_EXTERNAL_WORKER;else process.env.COURSE_OS_EXTERNAL_WORKER=beforeEnv;
    }
  });

  it("does not hide a rejected bridge to manufacture a successful lesson", async () => {
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async () => {
        const result = testTeachingResult(0.001);
        result.content.chapterBridgeMarkdown = "上一页讨论了 PDA 的内部结构，但这里没有给出可靠的中文定义，因此不应让读者猜测这个缩写的含义";
        return result;
      }
    };
    const { app, operations, release } = await seededApp(modelRouter);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "unsupported-bridge-test").send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "failed", completedPageIds: [] });
    expect((await operations.read()).events.some(event => event.type === "generation.bridge.omitted")).toBe(false);
  }, 60_000);

  it("cross-checks technical teaching after structural repair and records the bounded model pass", async () => {
    const technicalRelease = testRelease();
    technicalRelease.pages[0]!.pageNumber = 2;
    technicalRelease.pages[0]!.title = "公式计算";
    technicalRelease.pages[0]!.anchors = [{ id: "source-formula", pageId: "page-1", kind: "text", label: "提取文字", text: "公式 $x=1+1=2$" }];
    const calls: Array<{ stage: string; issues?: string[] }> = [];
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async (input) => {
        calls.push({ stage: input.stage || "teach", issues: input.repair?.issues });
        const result = testTeachingResult(0.001);
        if (input.repair?.issues.includes("TEACHING_SEMANTIC_CROSSCHECK")) result.content.fullExplanationMarkdown += "\n\n核验结果说明输入的一加一等于二，原值与输出值没有混淆";
        return result;
      }
    };
    const { app, operations, readweave, release } = await seededApp(modelRouter, technicalRelease);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "semantic-audit-technical-page")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", spentUsd: 0.002 });
    expect(calls).toEqual([{ stage: "teach", issues: undefined }, { stage: "repair", issues: ["TEACHING_SEMANTIC_CROSSCHECK"] }]);
    const draft = await readweave.getDraftByPage("page-1");
    expect(draft?.page.lessonSections?.find((section) => section.kind === "full_explanation")?.markdown).toContain("核验结果说明输入");
    expect((await operations.read()).events.filter((event) => event.streamId === created.body.id && event.type === "generation.stage.completed")
      .some((event) => (event.payload as { stage?: string }).stage === "semantic_audit")).toBe(true);
  }, 60_000);

  it("uses a bounded semantic findings report without rewriting valid teaching fields", async () => {
    const technicalRelease = testRelease();
    technicalRelease.pages[0]!.pageNumber = 2;
    technicalRelease.pages[0]!.anchors = [{ id: "source-formula", pageId: "page-1", kind: "text", label: "提取文字", text: "新概率 0.3，旧概率 0.2，原始比值 1.5，裁剪值 1.2" }];
    let audits = 0;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async () => {
        const result = testTeachingResult(0.001);
        result.content.fullExplanationMarkdown += "\n\n原始比值是 1.2，裁剪值也是 1.2";
        return result;
      },
      auditTeachingPackage: async (input) => {
        audits += 1;
        if (audits === 2) expect(input.teachingPackage.fullExplanationMarkdown).toContain("原始比值是 1.5");
        return { provider: "deepseek", model: "synthetic-vision", usage: testTeachingResult(0.001).usage,
          sourceChecks: [{ claim: "原始比值为 1.5", evidence: "来源写明原始比值 1.5", verdict: "supported" as const }],
          findings: audits === 1 ? [{ field: "fullExplanationMarkdown", original: "原始比值是 1.2", replacement: "原始比值是 1.5", evidence: "原始比值 1.5，裁剪值 1.2" }] : [] };
      }
    };
    const { app, readweave, release, operations } = await seededApp(modelRouter, technicalRelease);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "semantic-findings-page")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", spentUsd: 0.003 });
    expect(audits).toBe(2);
    const draft = await readweave.getDraftByPage("page-1");
    expect(draft?.page.lessonSections?.find((section) => section.kind === "full_explanation")?.markdown).toContain("原始比值是 1.5，裁剪值也是 1.2");
    expect((await operations.read()).events.filter((event) => event.streamId === created.body.id && event.type === "generation.stage.completed")
      .some((event) => (event.payload as { findingCount?: number }).findingCount === 1)).toBe(true);
  }, 60_000);

  it("verifies sequential source corrections against the latest audit instead of reopening resolved findings", async () => {
    const technicalRelease = testRelease();
    technicalRelease.pages[0]!.pageNumber = 2;
    technicalRelease.pages[0]!.anchors = [{ id: "source-sequence", pageId: "page-1", kind: "text", label: "提取文字",
      text: "第一项不乘系数，第二项乘 $\\lambda$" }];
    let audits = 0;
    let sourceRepairs = 0;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async (input) => {
        const result = testTeachingResult(0.001);
        if (input.repair?.issues.includes("TEACHING_SOURCE_CLAIM_REPAIR")) sourceRepairs += 1;
        else result.content.fullExplanationMarkdown += "\n\n第一项乘 $\\lambda$，第二项不乘系数";
        return result;
      },
      auditTeachingPackage: async (input) => {
        audits += 1;
        if (audits === 2) expect(input.teachingPackage.fullExplanationMarkdown).toContain("第一项不乘系数");
        if (audits === 3) {
          expect(input.teachingPackage.fullExplanationMarkdown).toContain("第一项不乘系数，第二项乘 $\\lambda$");
          expect(input.repair?.issues).toContain("TEACHING_SOURCE_CLAIM_RECHECK");
        }
        return {
          provider: "deepseek", model: "synthetic-vision", usage: testTeachingResult(0.001).usage,
          sourceChecks: [{ claim: "系数位置", evidence: "来源写明第一项不乘，第二项乘", verdict: audits === 3 ? "supported" as const : "contradicted" as const }],
          findings: audits === 1
            ? [{ field: "fullExplanationMarkdown", original: "第一项乘 $\\lambda$", replacement: "第一项不乘系数", evidence: "来源页" }]
            : audits === 2
              ? [{ field: "fullExplanationMarkdown", original: "第二项不乘系数", replacement: "第二项乘 $\\lambda$", evidence: "来源页" }]
              : []
        };
      }
    };
    const { app, readweave, release, operations } = await seededApp(modelRouter, technicalRelease);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "semantic-sequential-source-corrections")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", failedPageIds: [], spentUsd: 0.004 });
    expect(audits).toBe(3);
    expect(sourceRepairs).toBe(0);
    expect((await readweave.getDraftByPage("page-1"))?.page.lessonSections?.find((section) => section.kind === "full_explanation")?.markdown)
      .toContain("第一项不乘系数，第二项乘 $\\lambda$");
    expect((await operations.read()).events.filter((event) => event.streamId === created.body.id && event.type === "generation.stage.completed")
      .some((event) => (event.payload as { sourceRepairAttempted?: boolean; recheckCount?: number }).sourceRepairAttempted === false
        && (event.payload as { recheckCount?: number }).recheckCount === 2)).toBe(true);
  }, 60_000);

  it("rechecks an inapplicable semantic patch without accepting an empty replacement report", async () => {
    const technicalRelease = testRelease();
    technicalRelease.pages[0]!.pageNumber = 2;
    technicalRelease.pages[0]!.anchors = [{ id: "source-input", pageId: "page-1", kind: "text", label: "提取文字", text: "先检查输入条件，再执行规则" }];
    let audits = 0;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async () => testTeachingResult(0.001),
      auditTeachingPackage: async (input) => {
        audits += 1;
        if (audits === 2) expect(input.repair?.issues).toContain("TEACHING_SEMANTIC_AUDIT_FINDING_INVALID");
        return { provider: "deepseek", model: "synthetic-vision", usage: testTeachingResult(0.001).usage,
          sourceChecks: [{ claim: "先检查输入条件", evidence: "来源明确写出先检查输入条件", verdict: "supported" as const }],
          findings: audits === 1
            ? [{ field: "mainContentMarkdown", original: "不存在的原句", replacement: "先检查输入", evidence: "来源页" }]
            : audits === 2 ? [{ field: "mainContentMarkdown", original: "先识别输入", replacement: "先检查输入", evidence: "来源页" }] : [] };
      }
    };
    const { app, readweave, release, operations } = await seededApp(modelRouter, technicalRelease);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "semantic-invalid-patch-recheck")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    const finished = await waitForJob(app, created.body.id);
    expect(finished).toMatchObject({ state: "completed", failedPageIds: [], spentUsd: 0.004 });
    expect(audits).toBe(3);
    expect((await readweave.getDraftByPage("page-1"))?.page.quality.publishable).toBe(true);
    expect((await operations.read()).events.filter((event) => event.streamId === created.body.id && event.type === "generation.stage.completed")
      .some((event) => (event.payload as { stage?: string; recheckCount?: number }).stage === "semantic_audit" && (event.payload as { recheckCount?: number }).recheckCount === 2)).toBe(true);
  }, 60_000);

  it("rechecks a counted-object contradiction introduced by an audit patch", async () => {
    const technicalRelease = testRelease();
    technicalRelease.pages[0]!.pageNumber = 2;
    technicalRelease.pages[0]!.anchors = [{ id: "source-count", pageId: "page-1", kind: "text", label: "提取文字", text: "五种硬件供比较" }];
    let audits = 0;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async () => {
        const result = testTeachingResult(0.001);
        result.content.mainContentMarkdown += "\n- 图中有四种硬件供比较";
        result.content.questions[0]!.prompt = "图中列出四种硬件分别是什么";
        return result;
      },
      auditTeachingPackage: async (input) => {
        audits += 1;
        if (audits === 2) expect(input.repair?.issues).toContain("TEACHING_COUNT_CONTRADICTION:硬件");
        return { provider: "deepseek", model: "synthetic-vision", usage: testTeachingResult(0.001).usage,
          findings: audits === 1
            ? [{ field: "mainContentMarkdown", original: "四种硬件供比较", replacement: "五种硬件供比较", evidence: "五种硬件供比较" }]
            : [{ field: "questions:0:prompt", original: "四种硬件", replacement: "五种硬件", evidence: "五种硬件供比较" }] };
      }
    };
    const { app, readweave, release, operations } = await seededApp(modelRouter, technicalRelease);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "semantic-count-recheck")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", spentUsd: 0.003 });
    expect(audits).toBe(2);
    expect((await readweave.getDraftByPage("page-1"))?.page.questionBank?.[0]?.prompt).toContain("五种硬件");
    expect((await operations.read()).events.filter((event) => event.streamId === created.body.id && event.type === "generation.stage.completed")
      .some((event) => (event.payload as { recheckCount?: number }).recheckCount === 1)).toBe(true);
  }, 60_000);

  it("repairs an unsupported visual claim and reaudits the corrected whole page", async () => {
    const technicalRelease = testRelease();
    technicalRelease.pages[0]!.pageNumber = 2;
    technicalRelease.pages[0]!.anchors = [{ id: "source-agents", pageId: "page-1", kind: "text",
      label: "提取文字", text: "图中两处写着 Agent，但材料没有说明它们是同一个对象" }];
    let audits = 0;
    let repairs = 0;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async (input) => {
        const result = testTeachingResult(0.001);
        if (input.repair?.issues.includes("TEACHING_SOURCE_CLAIM_REPAIR")) {
          repairs += 1;
          expect(input.repair.issues.join(" ")).toContain("原图证据");
        } else {
          result.content.fullExplanationMarkdown += "\n\n所有动作必然由同一个智能体执行";
        }
        return result;
      },
      auditTeachingPackage: async (input) => {
        audits += 1;
        if (audits === 3) expect(input.repair?.issues).toContain("TEACHING_SOURCE_CLAIM_VERIFICATION");
        const unsupported = input.teachingPackage.fullExplanationMarkdown.includes("所有动作必然由同一个智能体执行");
        return { provider: "deepseek", model: "synthetic-vision", usage: testTeachingResult(0.001).usage,
          sourceChecks: [{ claim: "所有动作必然由同一个智能体执行",
            evidence: "原图只出现两个 Agent 标签，没有说明是否同一对象",
            verdict: unsupported ? "unverified" as const : "supported" as const }], findings: [] };
      }
    };
    const { app, readweave, release, operations } = await seededApp(modelRouter, technicalRelease);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "semantic-source-repair")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", failedPageIds: [], spentUsd: 0.005 });
    expect(audits).toBe(3);
    expect(repairs).toBe(1);
    expect((await readweave.getDraftByPage("page-1"))?.page.lessonSections?.find((section) => section.kind === "full_explanation")?.markdown)
      .not.toContain("所有动作必然由同一个智能体执行");
    expect((await operations.read()).events.filter((event) => event.streamId === created.body.id && event.type === "generation.stage.completed")
      .some((event) => (event.payload as { sourceRepairAccepted?: boolean }).sourceRepairAccepted === true)).toBe(true);
  }, 60_000);

  it("repairs only malformed math introduced by a sourced correction before final verification", async () => {
    const technicalRelease = testRelease();
    technicalRelease.pages[0]!.pageNumber = 2;
    technicalRelease.pages[0]!.anchors = [{ id: "source-claim", pageId: "page-1", kind: "text",
      label: "提取文字", text: "页面没有说明两个对象一定相同" }];
    let mathRepairs = 0;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async (input) => {
        const result = testTeachingResult(0.001);
        if (input.repair?.issues.includes("TEACHING_SOURCE_CLAIM_REPAIR")) {
          result.content.mainContentMarkdown += "\n- 来源关系 $\\badmacro$";
        } else if (input.stage === "teach") {
          result.content.fullExplanationMarkdown += "\n\n两个对象一定相同";
        }
        return result;
      },
      repairTeachingFields: async (input, fields) => {
        mathRepairs += 1;
        expect(input.repair?.issues).toContain("TEACHING_MATH_INVALID:mainContentMarkdown");
        expect(fields).toEqual(["mainContentMarkdown"]);
        return testTeachingResult(0.001);
      },
      auditTeachingPackage: async (input) => ({ provider: "deepseek", model: "synthetic-vision",
        usage: testTeachingResult(0.001).usage, findings: [],
        sourceChecks: [{ claim: "两个对象一定相同", evidence: "来源未说明两者一定相同",
          verdict: input.teachingPackage.fullExplanationMarkdown.includes("两个对象一定相同") ? "unverified" : "supported" }] })
    };
    const { app, readweave, release, operations } = await seededApp(modelRouter, technicalRelease);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "sourced-math-repair")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", failedPageIds: [] });
    expect(mathRepairs).toBe(1);
    const draft = await readweave.getDraftByPage("page-1");
    expect(draft?.page.quality.publishable).toBe(true);
    expect(draft?.page.lessonSections?.find((section) => section.kind === "main_content")?.markdown).not.toContain("badmacro");
    expect((await operations.read()).events.filter((event) => event.streamId === created.body.id)
      .some((event) => (event.payload as { sourceRepairAccepted?: boolean; sourceRepairMathFixed?: boolean }).sourceRepairAccepted === true
        && (event.payload as { sourceRepairMathFixed?: boolean }).sourceRepairMathFixed === true)).toBe(true);
  }, 60_000);

  it("applies a sourced final audit correction and verifies it before saving", async () => {
    const technicalRelease = testRelease();
    technicalRelease.pages[0]!.pageNumber = 2;
    technicalRelease.pages[0]!.anchors = [{ id: "source-step", pageId: "page-1", kind: "text",
      label: "提取文字", text: "先检查输入；图中两个 Agent 标签不表示同一对象" }];
    let audits = 0;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async (input) => {
        const result = testTeachingResult(0.001);
        if (input.repair?.issues.includes("TEACHING_SOURCE_CLAIM_REPAIR")) {
          result.content.coverageEvidence = result.content.coverageEvidence.map((claim) => ({ ...claim, explanation: "这条新引用不在讲解中" }));
        } else {
          result.content.fullExplanationMarkdown += "\n\n两个 Agent 标签必然表示同一对象";
        }
        return result;
      },
      auditTeachingPackage: async (input) => {
        audits += 1;
        const falseAgentClaim = input.teachingPackage.fullExplanationMarkdown.includes("两个 Agent 标签必然表示同一对象");
        const falseStepClaim = input.teachingPackage.mainContentMarkdown.includes("先识别输入");
        return { provider: "deepseek", model: "synthetic-vision", usage: testTeachingResult(0.001).usage,
          findings: audits === 3 ? [{ field: "mainContentMarkdown", original: "先识别输入",
            replacement: "先检查输入", evidence: "课件写着先检查输入" }] : [],
          sourceChecks: [{ claim: falseAgentClaim ? "两个 Agent 标签必然表示同一对象" : "两个 Agent 标签分别出现",
            evidence: "课件没有说明两个标签是同一对象", verdict: falseAgentClaim ? "unverified" as const : "supported" as const },
          { claim: falseStepClaim ? "先识别输入" : "先检查输入", evidence: "课件写着先检查输入",
            verdict: falseStepClaim ? "contradicted" as const : "supported" as const }] };
      }
    };
    const { app, readweave, release, operations } = await seededApp(modelRouter, technicalRelease);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "semantic-final-patch")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", failedPageIds: [] });
    expect(audits).toBe(4);
    expect((await readweave.getDraftByPage("page-1"))?.page.lessonSections?.find((section) => section.kind === "main_content")?.markdown)
      .toContain("先检查输入");
    expect((await operations.read()).events.filter((event) => event.streamId === created.body.id && event.type === "generation.stage.completed")
      .some((event) => (event.payload as { finalAuditPatchApplied?: boolean; sourceRepairAccepted?: boolean }).finalAuditPatchApplied === true
        && (event.payload as { sourceRepairAccepted?: boolean }).sourceRepairAccepted === true)).toBe(true);
  }, 60_000);

  it("does not mark a page ready when a source claim remains unverified after correction", async () => {
    const technicalRelease = testRelease();
    technicalRelease.pages[0]!.pageNumber = 2;
    technicalRelease.pages[0]!.anchors = [{ id: "source-formula", pageId: "page-1", kind: "text", label: "提取文字", text: "公式第一项没有额外系数" }];
    let audits = 0;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async () => testTeachingResult(0.001),
      auditTeachingPackage: async () => {
        audits += 1;
        return { provider: "deepseek", model: "synthetic-vision", usage: testTeachingResult(0.001).usage,
          sourceChecks: [{ claim: "公式第一项的系数", evidence: "原图辨认不清", verdict: "unverified" as const }],
          findings: audits === 1 ? [{ field: "mainContentMarkdown", original: "先识别输入", replacement: "先检查输入", evidence: "来源说明先检查输入" }] : [] };
      }
    };
    const { app, readweave, release, operations } = await seededApp(modelRouter, technicalRelease);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "semantic-unverified-page")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "failed", failedPageIds: ["page-1"] });
    expect(audits).toBe(3);
    expect(await readweave.getDraftByPage("page-1")).toBeUndefined();
    expect((await operations.read()).events.filter((event) => event.streamId === created.body.id && event.type === "generation.stage.completed")
      .some((event) => (event.payload as { sourceRepairFailureKind?: string }).sourceRepairFailureKind === "final_audit_unsupported"
        && (event.payload as { finalAuditUnsupportedCount?: number }).finalAuditUnsupportedCount === 1)).toBe(true);
  }, 60_000);

  it("keeps a candidate unready when the semantic pass introduces a new quality error", async () => {
    const candidate = testRelease();
    candidate.lifecycle = "draft_source";
    candidate.pages[0]!.pageNumber = 2;
    candidate.pages[0]!.anchors = [{ id: "source-formula", pageId: "page-1", kind: "text", label: "提取文字", text: "公式 $x=1+1=2$" }];
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async (input) => {
        const result = testTeachingResult(0.001);
        if (input.repair?.issues.includes("TEACHING_SEMANTIC_CROSSCHECK")) result.content.fullExplanationMarkdown += "\n\nGraph Encoder 没有解释就直接出现";
        return result;
      }
    };
    const { app, readweave, release } = await seededApp(modelRouter, candidate);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "semantic-audit-invalid-page")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "failed", failedPageIds: ["page-1"], spentUsd: 0.002 });
    const draft = await readweave.getDraftByPage("page-1");
    expect(draft?.status).toBe("needs_review");
    expect(draft?.page.quality.issues).toContain("TEACHING_SEMANTIC_AUDIT_INVALID");
  }, 60_000);

  it("repairs a structurally valid but overlong model draft once before saving", async () => {
    const calls: Array<{ stage?: string; repair?: { issues: string[]; maximumExplanationCharacters: number } }> = [];
    const coveredRelease = testRelease();
    coveredRelease.pages[0]!.atoms = [{ kind: "image_region", id: "atom-1", label: "输入与输出关系", observation: "输入经过规则得到输出" }];
    coveredRelease.pages[0]!.coverageRequirements = [{ id: "requirement-1", atomId: "atom-1", requiredFields: ["observation"], risk: "high" }];
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async (input) => {
        calls.push({ stage: input.stage, repair: input.repair });
        const result = testTeachingResult(0.001);
        if (input.stage === "teach") {
          result.content.fullExplanationMarkdown = `${result.content.fullExplanationMarkdown}\n\n${"这段内容故意超过页面允许的长度，用来触发一次受约束的模型修复\n".repeat(160)}`;
          result.content.coverageEvidence = [{ atomId: "atom-1", coveredFields: ["observation"], explanation: "正文解释了输入经过规则得到输出的可见关系" }];
        }
        return result;
      }
    };
    const { app, operations, readweave, release } = await seededApp(modelRouter, coveredRelease);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "repair-overlong-draft").send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 7 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", completedPageIds: ["page-1"], failedPageIds: [], spentUsd: 0.002 });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ stage: "teach" });
    expect(calls[1]).toMatchObject({ stage: "repair", repair: { issues: expect.arrayContaining(["TEACHING_EXPLANATION_TOO_LONG"]), maximumExplanationCharacters: 900 } });
    const savedDraft = await readweave.getDraftByPage("page-1");
    expect(savedDraft?.status).toBe("ready");
    expect(savedDraft?.page.coverageClaims).toEqual([expect.objectContaining({ requirementId: "requirement-1", coveredFields: ["observation"], status: "covered" })]);
    const events = (await operations.read()).events.filter((event) => event.streamId === created.body.id);
    expect(events.some((event) => event.type === "generation.stage.started" && (event.payload as { stage?: string }).stage === "repair")).toBe(true);
    expect(events.some((event) => event.type === "generation.stage.completed" && (event.payload as { stage?: string; remainingIssueCount?: number }).stage === "repair" && (event.payload as { remainingIssueCount?: number }).remainingIssueCount === 0)).toBe(true);
  }, 60_000);

  it("repairs missing atom coverage and validates the repaired evidence", async () => {
    const calls: Array<{ stage?: string; issues?: string[] }> = [];
    const coveredRelease = testRelease();
    coveredRelease.pages[0]!.atoms = [{ kind: "image_region", id: "atom-coverage", label: "输入与输出关系", observation: "输入经过规则得到输出" }];
    coveredRelease.pages[0]!.coverageRequirements = [{ id: "requirement-coverage", atomId: "atom-coverage", requiredFields: ["observation"], risk: "high" }];
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async (input) => {
        calls.push({ stage: input.stage, issues: input.repair?.issues });
        const result = testTeachingResult(0.001);
        if (input.stage === "repair") result.content.coverageEvidence = [{ atomId: "atom-coverage", coveredFields: ["observation"], explanation: "正文解释了输入经过规则得到输出的可见关系" }];
        return result;
      }
    };
    const { app, readweave, release } = await seededApp(modelRouter, coveredRelease);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "repair-missing-coverage").send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 7 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", completedPageIds: ["page-1"], failedPageIds: [] });
    expect(calls).toEqual([
      { stage: "teach", issues: undefined },
      { stage: "repair", issues: ["TEACHING_COVERAGE_REQUIREMENT_MISSING"] }
    ]);
    expect((await readweave.getDraftByPage("page-1"))?.page.coverageClaims).toEqual([expect.objectContaining({ requirementId: "requirement-coverage", status: "covered" })]);
  }, 60_000);

  it("repairs only a misconception without invalidating already valid source coverage", async () => {
    const coveredRelease = testRelease();
    coveredRelease.pages[0]!.atoms = [{ kind: "text_region", id: "atom-text", label: "原文片段", observation: "输入经过规则得到输出" }];
    coveredRelease.pages[0]!.coverageRequirements = [{ id: "requirement-text", atomId: "atom-text", requiredFields: ["observation"], risk: "high" }];
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async (input) => {
        const result = testTeachingResult(0.001);
        if (input.stage === "teach") {
          result.content.misconceptions = ["不要跳过输入条件，应该先核对输出"];
          result.content.coverageEvidence = [{ atomId: "atom-text", coveredFields: ["observation"], explanation: "输入是处理开始前已经知道的信息，规则限定允许执行的步骤" }];
        } else {
          result.content.fullExplanationMarkdown = result.content.fullExplanationMarkdown.replace("输入是处理开始前已经知道的信息", "输入在开始前已经确定");
        }
        return result;
      }
    };
    const { app, readweave, release } = await seededApp(modelRouter, coveredRelease);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "repair-misconception-only").send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 7 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", completedPageIds: ["page-1"], failedPageIds: [], spentUsd: 0.002 });
    const saved = await readweave.getDraftByPage("page-1");
    expect(saved?.status).toBe("ready");
    expect(saved?.page.lessonSections?.find((section) => section.kind === "full_explanation")?.markdown).toContain("输入是处理开始前已经知道的信息");
    expect(saved?.page.lessonSections?.find((section) => section.kind === "misconceptions")?.items?.[0]?.text).toContain("因为规则只对满足前提的对象有效");
  }, 60_000);

  it("keeps a rejected candidate page readable while the generation job remains failed", async () => {
    const candidate = testRelease();
    candidate.lifecycle = "draft_source";
    candidate.pages[0]!.atoms = [{ kind: "text_region", id: "atom-source", label: "来源片段", observation: "输入经过规则得到输出" }];
    candidate.pages[0]!.coverageRequirements = [{ id: "requirement-source", atomId: "atom-source", requiredFields: ["observation"], risk: "high" }];
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async () => {
        const result = testTeachingResult(0.001);
        result.content.priorKnowledge = ["输入条件：先确认参与计算的对象和输入范围，只有满足规则前提时才能计算结果\n输出结果：计算结束后核对输出是否属于允许范围，避免把中间值误当成最终答案"];
        result.content.misconceptions = ["不要跳过输入条件"];
        result.content.coverageEvidence = [{ atomId: "atom-source", coveredFields: ["observation"], explanation: "这段解释并没有出现在完整讲解正文之中" }];
        return result;
      }
    };
    const { app, readweave, release } = await seededApp(modelRouter, candidate);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "candidate-rejected-draft").send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 2 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "failed", failedPageIds: ["page-1"], completedPageIds: [] });
    const draft = await readweave.getDraftByPage("page-1");
    expect(draft).toMatchObject({ status: "needs_review", page: { quality: { publishable: false, issues: expect.arrayContaining(["TEACHING_MISCONCEPTION_REASON_MISSING", "TEACHING_COVERAGE_QUOTE_NOT_FOUND:atom-source"]) } } });
    expect(draft?.page.lessonSections?.find((section) => section.kind === "prior_knowledge")?.items).toHaveLength(2);
    expect((await request(app).get("/api/v1/pages/page-1/lesson").expect(200)).body.page.id).toBe("page-1");
  }, 60_000);

  it("does not count a draft that failed publication checks as a completed page", async () => {
    const candidate = testRelease();
    candidate.lifecycle = "draft_source";
    const modelRouter: ModelRouterClient = { generateTeachingPackage: async () => {
      const result = testTeachingResult(0.005);
      result.content.misconceptions = ["不要跳过输入条件"];
      result.content.coverageEvidence = [{ atomId: "atom-source", coveredFields: ["observation"], explanation: "这段解释并没有出现在完整讲解正文之中" }];
      return result;
    } };
    const { app, readweave, release } = await seededApp(modelRouter, candidate);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "unpublishable-candidate")
      .send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 1 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "failed", completedPageIds: [], failedPageIds: ["page-1"] });
    expect(await readweave.getDraftByPage("page-1")).toMatchObject({ status: "needs_review", page: { quality: { publishable: false } } });
  }, 60_000);

  it("records the call and stops a job when actual cost crosses its hard budget", async () => {
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async () => testTeachingResult(0.02)
    };
    const { app, release } = await seededApp(modelRouter);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "hard-budget-job").send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 0.01 }).expect(202);
    const stopped = await waitForJob(app, created.body.id);
    expect(stopped).toMatchObject({ state: "failed", completedPageIds: ["page-1"], spentUsd: 0.02 });
    const costs = await request(app).get(`/api/v1/costs?jobId=${created.body.id}`).expect(200);
    expect(costs.body.entries).toEqual([expect.objectContaining({ status: "succeeded", actualMicrousd: 20_000 })]);
  }, 60_000);

  it("retries only failed pages with a new provider key for the next attempt", async () => {
    const keys: string[] = [];
    let calls = 0;
    const modelRouter: ModelRouterClient = {
      generateTeachingPackage: async (input) => {
        keys.push(input.idempotencyKey);
        calls += 1;
        if (calls === 1) throw new ModelRouterGenerationError("MODEL_ROUTER_FAILED:TEMPORARY", "gpt-5.6-sol", { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, apiEquivalentUsd: 0, durationMs: 100 });
        return testTeachingResult(0.015);
      }
    };
    const { app, release } = await seededApp(modelRouter);
    const created = await request(app).post("/api/v1/generation-jobs").set("Idempotency-Key", "retry-source-job").send({ materialVersionId: release.id, pageIds: ["page-1"], budgetUsd: 7 }).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "failed", failedPageIds: ["page-1"], attempt: 1 });
    await request(app).post(`/api/v1/generation-jobs/${created.body.id}:retry`).expect(202);
    expect(await waitForJob(app, created.body.id)).toMatchObject({ state: "completed", completedPageIds: ["page-1"], failedPageIds: [], attempt: 2, spentUsd: 0.015 });
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[0]).toContain(":attempt:1:");
    expect(keys[1]).toContain(":attempt:2:");
    const costs = await request(app).get(`/api/v1/costs?jobId=${created.body.id}`).expect(200);
    expect(costs.body.entries.map((item: { status: string; actualMicrousd: number }) => ({ status: item.status, actualMicrousd: item.actualMicrousd }))).toEqual([{ status: "failed", actualMicrousd: 0 }, { status: "succeeded", actualMicrousd: 15_000 }]);
  }, 60_000);

  it("creates an empty general-purpose course before any material is imported", async () => {
    const app = await testApp();
    const created = await request(app).post("/api/v1/courses").set("Idempotency-Key", "course-create-1").send({ title: "线性代数", description: "公式、推导和应用" }).expect(201);
    expect(created.body).toMatchObject({ title: "线性代数", status: "active" });
    const tree = await request(app).get("/api/v1/workspaces/personal/tree").expect(200);
    expect(tree.body).toMatchObject({ treeVersion: "2.4.0", trash: { kind: "trash", title: "回收站" } });
    expect(tree.body.courses[0]).toMatchObject({ title: "线性代数", status: "published", children: [] });
    expect(tree.body.courses[0].children.some((node: { title: string }) => node.title === "当前材料")).toBe(false);
  });

  it("builds the sidebar tree from lightweight projections without loading release pages or drafts", async () => {
    const { app, readweave, release } = await seededApp();
    const listReleases = vi.spyOn(readweave, "listReleases").mockRejectedValue(new Error("HEAVY_RELEASE_READ_MUST_NOT_RUN"));
    const listDrafts = vi.spyOn(readweave, "listDrafts").mockRejectedValue(new Error("HEAVY_DRAFT_READ_MUST_NOT_RUN"));
    const tree = await request(app).get("/api/v1/workspaces/personal/tree").expect(200);
    expect(tree.body.courses[0].children[0]).toMatchObject({
      kind: "material",
      currentReleaseId: release.id,
      pageCount: 1
    });
    const material = tree.body.courses[0].children[0];
    await request(app).patch(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}`)
      .set("Idempotency-Key", "lightweight-tree-write")
      .send({ expectedRevision: material.revision, title: "轻量写入" })
      .expect(200);
    expect(listReleases).not.toHaveBeenCalled();
    expect(listDrafts).not.toHaveBeenCalled();
  });

  it("keeps persisted material properties while advancing its pointer to the latest release", async () => {
    const { app, readweave, release } = await seededApp();
    const firstTree = await request(app).get("/api/v1/workspaces/personal/tree").expect(200);
    const material = firstTree.body.courses[0].children[0];
    await request(app).patch(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}`)
      .set("Idempotency-Key", "persist-material-title")
      .send({ expectedRevision: material.revision, title: "保留的材料名称" })
      .expect(200);
    const nextRelease = { ...structuredClone(release), id: "test-release-v2", version: release.version + 1, publishedAt: new Date(Date.now() + 1_000).toISOString() };
    await readweave.publishRelease(nextRelease, testManifest(nextRelease.id), {
      idempotencyKey: "publish-next-release",
      actor: "test",
      workspaceId: "personal",
      schemaVersion: "2.4.0",
      requestId: "publish-next-release"
    });
    const nextTree = await request(app).get("/api/v1/workspaces/personal/tree").expect(200);
    expect(nextTree.body.courses[0].children[0]).toMatchObject({
      title: "保留的材料名称",
      releaseId: nextRelease.id,
      currentReleaseId: nextRelease.id,
      pageCount: nextRelease.pages.length
    });
  });

  it("supports revision-checked course-tree CRUD, trash recovery and exact ReadWeave links", async () => {
    const { app, release, readweave } = await seededApp();
    const firstTree = await request(app).get("/api/v1/workspaces/personal/tree?view=library").expect(200);
    const course = firstTree.body.courses[0];
    const material = course.children[0];
    expect(course.children).toHaveLength(1);
    expect(material).toMatchObject({ kind: "material", materialId: `material:${release.courseId}:${release.moduleId}`, currentReleaseId: release.id });
    const renamed = await request(app).patch(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}`).set("Idempotency-Key", "tree-rename").send({ expectedRevision: material.revision, title: "第一章：数组" }).expect(200);
    expect(renamed.body).toMatchObject({ id: material.id, kind: "material", title: "第一章：数组", revision: material.revision + 1 });
    await request(app).patch(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}`).set("Idempotency-Key", "tree-stale").send({ expectedRevision: material.revision, title: "错误名称" }).expect(409);

    const secondCourse = await request(app).post("/api/v1/courses").set("Idempotency-Key", "tree-course-2").send({ title: "数据结构" }).expect(201);
    const moved = await request(app).post(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}:move`).set("Idempotency-Key", "tree-move").send({ expectedRevision: renamed.body.revision, parentId: secondCourse.body.id, sortOrder: 0 }).expect(200);
    expect(moved.body).toMatchObject({ id: material.id, parentId: secondCourse.body.id, sortOrder: 0 });
    const movedTree = await request(app).get("/api/v1/workspaces/personal/tree").expect(200);
    expect(movedTree.body.courses.find((node: { id: string }) => node.id === secondCourse.body.id).children).toEqual([expect.objectContaining({ id: material.id, parentId: secondCourse.body.id })]);

    const duplicate = await request(app).post(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}:duplicate`).set("Idempotency-Key", "tree-duplicate").expect(201);
    expect(duplicate.body).toMatchObject({ kind: "material", title: "第一章：数组 副本", revision: 0, parentId: secondCourse.body.id });
    const trashed = await request(app).post(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}:trash`).set("Idempotency-Key", "tree-trash").expect(201);
    expect(trashed.body).toMatchObject({ nodeId: material.id, nodeKind: "material", restoreAvailable: true, originalParentId: secondCourse.body.id });
    const trash = await request(app).get("/api/v1/trash").expect(200);
    expect(trash.body).toEqual([expect.objectContaining({ id: trashed.body.id, nodeId: material.id })]);
    const restored = await request(app).post(`/api/v1/trash/${encodeURIComponent(trashed.body.id)}:restore`).set("Idempotency-Key", "tree-restore").send({ restoreMode: "original" }).expect(200);
    expect(restored.body).toMatchObject({ id: material.id, kind: "material", archived: false, parentId: secondCourse.body.id });
    const link = await request(app).get(`/api/v1/readweave/links/${encodeURIComponent(material.readweaveNoteId)}`).expect(200);
    expect(link.body).toEqual(expect.objectContaining({ host: "readweave.example.com", verified: true, url: `https://readweave.example.com/#root/${encodeURIComponent(material.readweaveNoteId)}` }));
    await request(app).get("/api/v1/tree/nodes/module-tree-1/properties").expect(409).expect((response) => {
      expect(response.body.error).toMatchObject({ code: "TREE_NODE_STALE" });
      expect(response.body.error.message).not.toContain("READWEAVE_TREE_NODE_NOT_FOUND");
    });
  });

  it("builds a current-release mastery map and replays review attempts idempotently", async () => {
    const { app, readweave, release } = await seededApp();
    const tree = await request(app).get("/api/v1/workspaces/personal/tree").expect(200);
    const material = tree.body.courses[0].children[0];
    await request(app).get(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}/properties`).expect(200).expect((response) => {
      expect(response.body).toMatchObject({ nodeId: material.id, kind: "material", title: material.title, pageCount: 1, syncState: "connected" });
    });
    await request(app).get(`/api/v1/tree/nodes/${encodeURIComponent("page-1")}/properties`).expect(200).expect((response) => {
      expect(response.body).toMatchObject({ nodeId: "page-1", kind: "page", sourceReleaseId: release.id });
    });
    const map = await request(app).get("/api/v1/review-map").expect(200);
    expect(map.body).toMatchObject({ releaseCount: 1, pageCount: 1, summary: { total: 1, due: 0, unseen: 1 } });
    expect(map.body.objectives[0]).toMatchObject({ objectiveId: "section-objective", releaseId: release.id, pageId: "page-1", state: "unseen", due: false });

    const created = await request(app).post("/api/v1/review-sessions").set("Idempotency-Key", "review-session-manual").send({ source: "manual", objectiveIds: ["section-objective"], seed: "review-seed" }).expect(201);
    expect(created.body.session).toMatchObject({ source: "manual", status: "active", currentObjectiveId: "section-objective" });
    const first = await request(app).post(`/api/v1/review-sessions/${created.body.session.id}/attempts`).set("Idempotency-Key", "review-attempt-1").send({ answer: "输入经过规则得到输出", usedHintLevel: 0 }).expect(201);
    expect(first.body).toMatchObject({ attempt: { correct: true, objectiveId: "section-objective" }, mastery: { state: "practicing", unaidedCorrect: true }, session: { status: "completed" } });
    const replay = await request(app).post(`/api/v1/review-sessions/${created.body.session.id}/attempts`).set("Idempotency-Key", "review-attempt-1").send({ answer: "重复提交不应再次推进", usedHintLevel: 0 }).expect(200);
    expect(replay.body).toMatchObject({ attempt: { id: first.body.attempt.id, correct: true }, session: { status: "completed" } });
    expect(await readweave.listQuestionAttempts()).toHaveLength(1);
    expect(await readweave.listAssessmentAttempts()).toHaveLength(1);
  });

  it("requires review selection before preparation and starts only a ready plan", async () => {
    const { app, operations, readweave } = await seededApp();
    await request(app).get("/api/v1/review-map").expect(200);
    expect((await operations.read()).reviewPlans).toHaveLength(0);
    expect((await operations.read()).reviewSessions).toHaveLength(0);
    await request(app).post("/api/v1/review-plans").set("Idempotency-Key", "review-plan-empty").send({ source: "manual", objectiveIds: [] }).expect(422);

    const created = await request(app).post("/api/v1/review-plans").set("Idempotency-Key", "review-plan-1").send({ source: "manual", objectiveIds: ["section-objective"], seed: "fixed-plan", budgetUsd: 4 }).expect(201);
    expect(created.body.plan).toMatchObject({ status: "ready", objectiveIds: ["section-objective"], cost: { reusedQuestionCount: 1, generatedQuestionCount: 0 } });
    expect(created.body.plan.items[0]).toMatchObject({ status: "ready", questionIds: ["q-c-1"] });
    expect(await readweave.getReviewPlan(created.body.plan.id)).toMatchObject({ status: "ready", revision: 1 });
    const replay = await request(app).post("/api/v1/review-plans").set("Idempotency-Key", "review-plan-1").send({ source: "manual", objectiveIds: ["section-objective"], seed: "different" }).expect(200);
    expect(replay.body.plan.id).toBe(created.body.plan.id);

    const started = await request(app).post(`/api/v1/review-plans/${encodeURIComponent(created.body.plan.id)}:start`).set("Idempotency-Key", "review-start-1").expect(201);
    expect(started.body.session).toMatchObject({ status: "active", reviewPlanId: created.body.plan.id, questionIdsByObjective: { "section-objective": ["q-c-1"] } });
    const startReplay = await request(app).post(`/api/v1/review-plans/${encodeURIComponent(created.body.plan.id)}:start`).set("Idempotency-Key", "review-start-1").expect(200);
    expect(startReplay.body.session.id).toBe(started.body.session.id);
  });

  it("keeps provider credentials server-side and validates workspace settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-api-settings-"));
    const app = createApp(createDefaultDependencies(root, new FileReadWeaveCourseApi(join(root, "readweave.json"))));
    const settings = await request(app).get("/api/v1/settings").expect(200);
    expect(settings.body).toMatchObject({ workspaceId: "personal", baseFontScale: 1.1 });
    const saved = await request(app).patch("/api/v1/settings").set("Idempotency-Key", "settings-save").send({ theme: "dark", baseFontScale: 1.3 }).expect(200);
    expect(saved.body).toMatchObject({ theme: "dark", baseFontScale: 1.3 });
    const credential = await request(app).put("/api/v1/model-providers/deepseek/credential").set("Idempotency-Key", "provider-secret").send({ secret: "synthetic-example-deepseek-token" }).expect(200);
    expect(credential.body).toMatchObject({ id: "deepseek", credential: { configured: true, maskedValue: "••••oken" } });
    expect(JSON.stringify(credential.body)).not.toContain("synthetic-example-deepseek-token");
    await request(app).patch("/api/v1/model-providers/deepseek").set("Idempotency-Key", "provider-config").send({ baseUrl: "http://external.example.invalid" }).expect(422);
    const providerConfig = await request(app).patch("/api/v1/model-providers/deepseek").set("Idempotency-Key", "provider-config-local").send({ baseUrl: "http://localhost:8045", enabled: true }).expect(200);
    expect(providerConfig.body).toMatchObject({ id: "deepseek", baseUrl: "http://localhost:8045", enabled: true });
    const providers = await request(app).get("/api/v1/model-providers").expect(200);
    expect(JSON.stringify(providers.body)).not.toContain("synthetic-example-deepseek-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [{ id: "deepseek-v4-flash" }] }));
    expect((await request(app).post("/api/v1/model-providers/deepseek:test").expect(200)).body.health.state).toBe("connected");
  });

  it("supports tree, optimistic draft editing, validation, conflicts and immutable publishing", async () => {
    const { app, release } = await seededApp();
    const tree = await request(app).get("/api/v1/workspaces/personal/tree").expect(200);
    expect(tree.body.courses[0]).toMatchObject({ title: "测试课程" });
    expect(tree.body.courses[0].children).toEqual([expect.objectContaining({ kind: "material", pageCount: 1 })]);
    expect(tree.body.trash).toMatchObject({ kind: "trash", title: "回收站" });

    const virtual = await request(app).get("/api/v1/pages/page-1/draft").expect(200);
    expect(virtual.body).toMatchObject({ revision: 0, pageId: "page-1" });
    const page = { ...virtual.body.page, title: "人工修订后的页面" };
    const saved = await request(app).patch("/api/v1/pages/page-1/draft").set("Idempotency-Key", "save-draft-1").send({ baseRevision: 0, page }).expect(200);
    expect(saved.body).toMatchObject({ revision: 1, status: "needs_review" });

    const validation = await request(app).post("/api/v1/pages/page-1:validate").expect(200);
    expect(validation.body).toMatchObject({ publishable: true, revision: 1 });

    const stale = await request(app).patch("/api/v1/pages/page-1/draft").set("Idempotency-Key", "save-draft-stale").send({ baseRevision: 0, page }).expect(409);
    expect(stale.body.error.details.conflictId).toContain("conflict:page-1:");
    expect((await request(app).get("/api/v1/conflicts").expect(200)).body).toHaveLength(1);

    const published = await request(app).post("/api/v1/releases").set("Idempotency-Key", "publish-v2").send({ baseReleaseId: release.id, releaseId: "test-release-v2" }).expect(201);
    expect(published.body).toMatchObject({ id: "test-release-v2", version: 2, modelRoute: "quality-gated-draft-v2" });
    expect((await request(app).get("/api/v1/releases/test-release-v2/manifest").expect(200)).body.courseReleaseId).toBe("test-release-v2");
  });
});

async function waitForImport(app: ReturnType<typeof createApp>, importId: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const current = await request(app).get(`/api/v1/imports/${importId}`).expect(200);
    if (["ready", "failed", "rejected"].includes(current.body.state)) return current.body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("IMPORT_TEST_TIMEOUT");
}

async function waitForJob(app: ReturnType<typeof createApp>, jobId: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const current = await request(app).get(`/api/v1/generation-jobs/${jobId}`).expect(200);
    if (["completed", "failed", "cancelled"].includes(current.body.state)) return current.body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("GENERATION_TEST_TIMEOUT");
}

async function waitForPlan(app: ReturnType<typeof createApp>, planId: string) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const current = await request(app).get(`/api/v1/generation-plans/${planId}`).expect(200);
    if (["awaiting_review", "completed", "failed", "cancelled"].includes(current.body.plan.state)) return current.body.plan;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("GENERATION_PLAN_TEST_TIMEOUT");
}

function testReleaseWithPages(count: number): CourseRelease {
  const release = testRelease();
  const firstPage = release.pages[0]!;
  const sourceIds = collectTestObjectIds(firstPage);
  const pages = Array.from({ length: count }, (_, index) => {
    let page = replaceTestIds(structuredClone(firstPage), "page-1", `page-${index + 1}`);
    if (index > 0) for (const sourceId of sourceIds) if (sourceId !== "page-1") page = replaceTestIds(page, sourceId, `${sourceId}:page:${index + 1}`);
    return page;
  });
  pages.forEach((page, index) => {
    page.pageNumber = index + 1;
    page.title = `测试页面 ${index + 1}`;
  });
  release.pageIds = pages.map((page) => page.id);
  release.pages = pages;
  return release;
}

function collectTestObjectIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectTestObjectIds);
  if (!value || typeof value !== "object") return [];
  const result: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "id" && typeof child === "string" && child) result.push(child);
    result.push(...collectTestObjectIds(child));
  }
  return result;
}

function replaceTestIds<T>(value: T, from: string, to: string): T {
  if (typeof value === "string") return value.split(from).join(to) as T;
  if (Array.isArray(value)) return value.map((item) => replaceTestIds(item, from, to)) as T;
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) result[key] = replaceTestIds(child, from, to);
    return result as T;
  }
  return value;
}

function testRelease(): CourseRelease {
  return {
    id: "test-release-v1",
    courseId: "test-course",
    courseTitle: "测试课程",
    moduleId: "module-1",
    moduleTitle: "第一章",
    version: 1,
    publishedAt: "2026-08-29T00:00:00.000Z",
    pageIds: ["page-1"],
    pages: [{
      id: "page-1",
      pageNumber: 1,
      title: "原始页面",
      imageUrl: "/page.png",
      anchors: [],
      atoms: [],
      blocks: [{ id: "block-1", title: "核心解释", kind: "core", markdown: "原始讲解", sourceAnchorIds: [], atomIds: [] }],
      lessonSections: [
        { id: "section-objective", kind: "learning_objectives", title: "学习目标", items: [{ id: "objective-1", text: "能够解释测试页面的核心概念", sourceAnchorIds: [] }], sourceAnchorIds: [], atomIds: [] },
        { id: "section-main", kind: "main_content", title: "主要内容", markdown: "测试页面说明输入、规则和输出之间的关系", sourceAnchorIds: [], atomIds: [] },
        { id: "section-prior", kind: "prior_knowledge", title: "先验知识列表", items: [{ id: "prior-1", text: "先知道输入和输出分别代表什么", sourceAnchorIds: [] }], sourceAnchorIds: [], atomIds: [] },
        { id: "section-full", kind: "full_explanation", title: "完整讲解", markdown: "测试页面从输入开始，按照明确规则得到输出，并用一个例子检查结果", sourceAnchorIds: [], atomIds: [] },
        { id: "section-misconception", kind: "misconceptions", title: "易错点列表", items: [{ id: "misconception-1", text: "不要跳过输入条件直接套用结论", sourceAnchorIds: [] }], sourceAnchorIds: [], atomIds: [] }
      ],
      questionBank: [
        { id: "q-c-1", pageId: "page-1", objectiveId: "section-objective", kind: "comprehension", prompt: "核心关系是什么", expectedAnswer: "输入经过规则得到输出", explanation: "先识别输入，再执行规则，最后核对输出", sourceAnchorIds: [], status: "approved", version: 1, generatedBy: "test" },
        { id: "q-c-2", pageId: "page-1", objectiveId: "section-objective", kind: "comprehension", prompt: "为什么要检查前提", expectedAnswer: "前提决定规则是否适用", explanation: "缺少前提时不能直接使用结论", sourceAnchorIds: [], status: "approved", version: 1, generatedBy: "test" },
        { id: "q-m-1", pageId: "page-1", objectiveId: "section-objective", kind: "multiple_choice", prompt: "第一步应该做什么", options: ["识别输入", "忽略条件", "直接写结论", "只看标题"], expectedAnswer: "识别输入", explanation: "输入决定后续规则", sourceAnchorIds: [], status: "approved", version: 1, generatedBy: "test" },
        { id: "q-m-2", pageId: "page-1", objectiveId: "section-objective", kind: "multiple_choice", prompt: "最后一步应该做什么", options: ["核对输出", "删除规则", "忽略结果", "改变题意"], expectedAnswer: "核对输出", explanation: "输出需要回到目标检查", sourceAnchorIds: [], status: "approved", version: 1, generatedBy: "test" }
      ],
      coverageRequirements: [],
      coverageClaims: [],
      quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable: true, issues: [] }
    }],
    assessments: [],
    manifestHash: "manifest-hash-v1",
    writingPolicySnapshotId: "policy-v1",
    modelRoute: "deterministic-test",
    qualityHarnessVersion: "quality-v1",
    costUsd: 0
  };
}

function testManifest(releaseId: string): ReleaseManifest {
  return {
    id: `${releaseId}:manifest`,
    schemaVersion: "2.1.0",
    courseReleaseId: releaseId,
    sourceHashes: [],
    pageHashes: [],
    explanationHashes: [],
    assessmentHashes: [],
    writingPolicySnapshotId: "policy-v1",
    modelRoutes: ["deterministic-test"],
    qualityHarnessVersion: "quality-v1",
    costInputs: [],
    createdAt: "2026-08-29T00:00:00.000Z"
  };
}

function testTeachingResult(apiEquivalentUsd: number): TeachingGenerationResult {
  return {
    provider: "aialra-model-router" as const,
    model: "gpt-5.6-terra",
    usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 200, apiEquivalentUsd, durationMs: 500 },
    content: {
      learningObjectives: ["能够说明输入、处理规则和输出之间的关系"],
      mainContentMarkdown: "- 先识别输入并检查前提\n- 再按照规则处理对象\n- 最后检查输出是否满足目标",
      priorKnowledge: ["输入与输出：输入是规则处理之前已经确认的对象和条件，输出是执行规则后得到的结果；先把两者分开，才能判断处理过程有没有达到目标；规则按照已经确认的输入改变对象的状态，不能拿结果代替处理过程；当需要核对处理结果时，先明确输入条件，再比较输出与目标是否一致"],
      fullExplanationMarkdown: [
        "## 一次完整演算\n\n把输入设为 $2$，规则设为增加 $3$，这是用于说明步骤的教学示例\n\n1. 先确认输入是已经知道的 $2$\n2. 按规则计算 $2+3=5$，得到中间处理结果\n3. 检查输出 $5$ 与增加 $3$ 的目标是否一致\n\n如果输入没有给出，只能写出增加的规则，不能提前宣布输出已经确定",
        "## 输入、规则和输出\n这页要把输入、处理规则和输出连成一条可以检查的流程，读者最后要能说明每一步为什么发生\n输入是处理开始前已经知道的信息，规则限定允许执行的步骤，输出是处理结束后的结果",
        "## 状态怎样向前推进\n先确认输入，再按规则处理对象，处理过程会把状态推进到新的结果，最后必须把输出和目标重新比较\n假设输入已经满足前提，先记录初始状态，再执行规则并写出中间状态，最后检查结果是否满足目标",
        "## 不能跳过的检查\n如果输入条件缺失，规则就不能直接套用，输出看起来合理也不能替代前提检查；只看最后数字会漏掉过程中的错误\n下一步应回到具体输入，逐项核对对象、规则、状态变化和结果"
      ].join("\n\n"),
      misconceptions: ["错误地跳过输入条件直接套用结论，因为规则只对满足前提的对象有效；正确做法是先检查输入和条件，再核对输出是否达到目标"],
      coverageEvidence: [],
      questions: [
        { kind: "comprehension" as const, prompt: "输入决定了什么", options: [], expectedAnswer: "输入决定处理对象", explanation: "先确认输入对象及其满足的条件，再把规则作用于这个对象；如果输入没有确定，就无法判断规则是否适用，也无法核对处理后的输出是否对应目标" },
        { kind: "comprehension" as const, prompt: "为什么检查输出", options: [], expectedAnswer: "确认结果满足目标", explanation: "执行完规则只表示处理过程结束，不能保证结果符合目标；需要把得到的输出与预先确定的目标逐项比较，发现差异时回到输入和处理步骤查原因" },
        { kind: "multiple_choice" as const, prompt: "第一步应该做什么", options: ["识别输入", "忽略条件", "直接结论", "删除规则"], expectedAnswer: "识别输入", explanation: "正确选项是识别输入，因为规则必须有明确的处理对象；直接写结论会跳过输入条件，无法判断处理结果从哪里来，也不能检查规则是否适用" },
        { kind: "multiple_choice" as const, prompt: "最后一步应该做什么", options: ["核对输出", "忽略目标", "删除结果", "改变题意"], expectedAnswer: "核对输出", explanation: "正确选项是核对输出，因为结果还要与目标和条件比较；忽略目标只看输出数值，无法判断处理是否成功，改变题意更不能替代结果检验" }
      ]
    }
  };
}
