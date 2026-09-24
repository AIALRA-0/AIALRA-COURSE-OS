import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRouterInput, TeachingPackage } from "./model-router.js";
import { policyExplanationFramework, policyFormatRules, policyFormulaExplanation, policySkill, teachingPackageSchema } from "./generation-harness.js";
import {
  normalizePlannedOpening,
  normalizePlannedQuestionPunctuation,
  normalizePlannedSourceIntroductions,
  plannedContentIssues,
  plannedFormatIssues,
  plannedInstructions,
  planningPrompt,
  projectPlannedOutputToSchema,
  writePlannedLesson
} from "./planned-teaching.js";

const explanation = [
  "## 从输入开始",
  "",
  "输入是处理开始时已经具备的信息，它决定规则作用于什么对象。先保持输入中的数值、变量和条件，再按照本页说明执行相应操作，得到的结果才可以与预期目标比较。",
  "",
  "## 检查处理结果",
  "",
  "若任一输入条件改变，就要重新执行相应步骤。只有在输入、规则和比较条件保持一致时，前后结果才具有可比性。核对时逐项检查条件与操作，发现差异后再定位输出变化的来源。"
].join("\n");

function teachingPackage(): TeachingPackage {
  return {
    chapterBridgeMarkdown: "",
    learningObjectives: ["给定输入以后，能够按顺序说明它怎样变成结果"],
    mainContentMarkdown: "- 输入确定处理对象与初始条件\n- 输出记录规则执行后的结果",
    priorKnowledge: ["输入（Input）：处理开始时已经具备的信息，它决定规则作用于什么对象"],
    fullExplanationMarkdown: explanation,
    misconceptions: ["**错误理解：** 输入变化后可以保留原结果\n\n**错因：** 忽略了结果依赖输入\n\n**正确判断：** 应当重新计算\n\n**核对方法：** 逐项检查输入条件"],
    coverageEvidence: [],
    questions: [
      { kind: "comprehension", prompt: "输入条件改变时，为什么要重新核对输出？", options: [], expectedAnswer: "因为输出取决于输入条件，条件改变后需要重新计算", explanation: "重新核对可以确认变化是否影响处理结果" },
      { kind: "comprehension", prompt: "怎样确认两个结果可以比较？", options: [], expectedAnswer: "保持输入、规则和比较条件一致", explanation: "相同条件下的结果才可以直接比较" },
      { kind: "multiple_choice", prompt: "发现输入条件改变后应当怎样做？", options: ["重新计算结果", "沿用旧结果", "删除输入条件", "忽略处理规则"], expectedAnswer: "重新计算结果", explanation: "结果依赖输入条件，因此改变输入后应重新执行规则" },
      { kind: "multiple_choice", prompt: "比较处理前后的结果时应先确认什么？", options: ["输入条件相同", "页面颜色相同", "标题长度相同", "文字位置相同"], expectedAnswer: "输入条件相同", explanation: "先确认条件一致，才能判断结果变化来自哪里" }
    ]
  };
}

function input(): ModelRouterInput {
  return {
    pageTitle: "输入与输出",
    pageNumber: 2,
    sourceText: "输入经过规则处理后得到输出",
    writingPolicySnapshotId: "writing-policy:test",
    language: "zh-CN",
    qualityMode: "balanced",
    idempotencyKey: "planned-teaching-test"
  };
}

describe("planned teaching core writer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("makes exactly one freeform plan call and one full TeachingPackage call", async () => {
    const calls: Array<Parameters<Parameters<typeof writePlannedLesson>[1]>[0]> = [];
    const content = teachingPackage();
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request);
      if (request.phase === "plan") return "先解释输入，再说明规则和结果";
      return { content, provider: "test-provider", model: "test-model" };
    });

    expect(calls.map(request => request.phase)).toEqual(["plan", "teaching"]);
    expect(calls[0]?.schema).toBeUndefined();
    expect(calls[0]?.instructions).toContain("不输出 JSON");
    expect(calls[1]?.schema).toBe(teachingPackageSchema);
    expect(calls[1]?.instructions).toContain("chapterBridgeMarkdown 必须是空字符串");
    expect(calls[1]?.prompt).toContain("仅用于安排讲解顺序，不是事实来源");
    expect(result.trace).toMatchObject({
      plan: "先解释输入，再说明规则和结果",
      phases: [{ phase: "plan" }, { phase: "teaching", provider: "test-provider", model: "test-model" }]
    });
    expect(result.trace.coreFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.content.coverageEvidence).toEqual([]);
    expect(result.content.chapterBridgeMarkdown).toBe("");
    expect(result.trace.formatWarnings).toBeUndefined();
  });

  it("uses a supplied freeform plan without calling the plan model", async () => {
    const supplied = "先说明对象，再讲解操作顺序";
    const calls: string[] = [];
    const result = await writePlannedLesson({ ...input(), teachingPlan: supplied } as ModelRouterInput, async request => {
      calls.push(request.phase);
      return teachingPackage();
    });

    expect(calls).toEqual(["teaching"]);
    expect(result.trace.plan).toBe(supplied);
    expect(result.content.chapterBridgeMarkdown).toBe("");
  });

  it("keeps provider and field diagnostics without saving the private response", async () => {
    const raw = JSON.stringify(teachingPackage());
    const result = await writePlannedLesson(input(), async request => request.phase === "plan"
      ? "先讲输入，再讲输出"
      : {
        content: raw,
        provider: "test-provider",
        model: "test-model",
        providerDiagnostic: {
          responseId: "resp-test",
          finishReason: "stop",
          status: "completed",
          rawOutputType: "string",
          rawOutputChars: raw.length,
          rawFields: { questions: { type: "array", length: 4 } }
        }
      });
    expect(result.trace.initialOutputDiagnostic?.provider).toMatchObject({
      responseId: "resp-test", finishReason: "stop", rawFields: { questions: { length: 4 } }
    });
    expect(result.trace.initialOutputDiagnostic?.parsedFields?.questions).toEqual({ type: "array", length: 4 });
    expect(result.trace.initialOutputDiagnostic?.normalizedFields?.questions).toEqual({ type: "array", length: 4 });
    expect(JSON.stringify(result.trace)).not.toContain("输入确定处理对象");
  });

  it("formats a summary returned as a list without another model call", async () => {
    const calls: string[] = [];
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      if (request.phase === "plan") return "先说明输入和输出";
      return { ...teachingPackage(), mainContentMarkdown: ["输入确定处理对象", "输出记录处理结果"] };
    });

    expect(calls).toEqual(["plan", "teaching"]);
    expect(result.content.mainContentMarkdown).toBe("- 输入确定处理对象\n- 输出记录处理结果");
  });

  it("keeps four provider quizQuestions instead of spending a model repair on an alias", async () => {
    const calls: string[] = [];
    const { questions, ...body } = teachingPackage();
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      return request.phase === "plan" ? "先讲输入，再讲输出"
        : { ...body, quizQuestions: questions };
    });
    expect(calls).toEqual(["plan", "teaching"]);
    expect(result.content.questions).toHaveLength(4);
    expect(result.trace.repairDiagnostic).toBeUndefined();
  });

  it("maps four root exercises to questions without a model repair", async () => {
    const calls: string[] = [];
    const { questions, ...body } = teachingPackage();
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      return request.phase === "plan" ? "先讲输入，再讲输出"
        : { ...body, exercises: questions };
    });

    expect(calls).toEqual(["plan", "teaching"]);
    expect(result.content.questions).toEqual(questions);
    expect(result.trace.repairDiagnostic).toBeUndefined();
  });

  it("preserves canonical questions when root exercises are also present", async () => {
    const canonical = teachingPackage().questions;
    const exercises = canonical.map(question => ({ ...question, prompt: `别名：${question.prompt}` }));
    const result = await writePlannedLesson(input(), async request => request.phase === "plan"
      ? "先讲输入，再讲输出"
      : { ...teachingPackage(), exercises });

    expect(result.content.questions.map(question => question.prompt)).toEqual(canonical.map(question => question.prompt));
    expect(result.trace.repairDiagnostic).toBeUndefined();
  });

  it("accepts a complete package with mainContentSummary without a format repair", async () => {
    const calls: string[] = [];
    const { mainContentMarkdown, ...body } = teachingPackage();
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      return request.phase === "plan" ? "先讲输入，再讲输出"
        : { ...body, mainContentSummary: mainContentMarkdown };
    });

    expect(calls).toEqual(["plan", "teaching"]);
    expect(result.content.mainContentMarkdown).toBe(mainContentMarkdown);
    expect(result.content.questions).toHaveLength(4);
    expect(result.trace.repairDiagnostic).toBeUndefined();
  });

  it("maps mainContentSummaryMarkdown without a model repair", async () => {
    const calls: string[] = [];
    const { mainContentMarkdown, ...body } = teachingPackage();
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      return request.phase === "plan" ? "先讲输入，再讲输出"
        : { ...body, mainContentSummaryMarkdown: mainContentMarkdown };
    });

    expect(calls).toEqual(["plan", "teaching"]);
    expect(result.content.mainContentMarkdown).toBe(mainContentMarkdown);
    expect(result.content.questions).toHaveLength(4);
    expect(result.trace.repairDiagnostic).toBeUndefined();
  });

  it("preserves canonical main content when mainContentSummaryMarkdown is also present", async () => {
    const canonical = "- Canonical main content";
    const result = await writePlannedLesson(input(), async request => request.phase === "plan"
      ? "先讲输入，再讲输出"
      : {
        ...teachingPackage(),
        mainContentMarkdown: canonical,
        mainContentSummaryMarkdown: "- Alias main content"
      });

    expect(result.content.mainContentMarkdown).toBe(canonical);
    expect(result.trace.repairDiagnostic).toBeUndefined();
  });

  it("maps assessmentQuestions to the four final questions without repair", async () => {
    const calls: string[] = [];
    const { questions, ...body } = teachingPackage();
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      return request.phase === "plan" ? "先讲输入，再讲输出"
        : { ...body, assessmentQuestions: questions };
    });

    expect(calls).toEqual(["plan", "teaching"]);
    expect(result.content.questions).toHaveLength(4);
    expect(result.content.questions.map(question => question.prompt)).toEqual(questions.map(question => question.prompt));
    expect(result.trace.repairDiagnostic).toBeUndefined();
  });

  it("maps mainPoints to main content while keeping four questions without repair", async () => {
    const calls: string[] = [];
    const { mainContentMarkdown: _main, ...body } = teachingPackage();
    const mainPoints = ["识别输入条件", "按给定规则处理", "记录中间结果", "检查输出", "比较预期", "定位差异"];
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      return request.phase === "plan" ? "先讲输入，再讲输出"
        : { ...body, mainPoints };
    });

    expect(calls).toEqual(["plan", "teaching"]);
    expect(result.content.mainContentMarkdown).toBe(mainPoints.map(point => `- ${point}`).join("\n"));
    expect(result.content.questions).toHaveLength(4);
    expect(result.trace.repairDiagnostic).toBeUndefined();
  });

  it("maps keyPointsMarkdown to main content while keeping four questions without repair", async () => {
    const calls: string[] = [];
    const { mainContentMarkdown: _main, ...body } = teachingPackage();
    const keyPointsMarkdown = "- 输入决定处理对象\n- 输出记录处理结果";
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      return request.phase === "plan" ? "先讲输入，再讲输出"
        : { ...body, keyPointsMarkdown };
    });

    expect(calls).toEqual(["plan", "teaching"]);
    expect(result.content.mainContentMarkdown).toBe(keyPointsMarkdown);
    expect(result.content.questions).toHaveLength(4);
    expect(result.trace.repairDiagnostic).toBeUndefined();
  });

  it("maps explanationMarkdown to the complete explanation without repairing four questions", async () => {
    const calls: string[] = [];
    const { fullExplanationMarkdown: _explanation, ...body } = teachingPackage();
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      return request.phase === "plan" ? "先讲输入，再讲输出"
        : { ...body, explanationMarkdown: explanation };
    });

    expect(calls).toEqual(["plan", "teaching"]);
    expect(result.content.fullExplanationMarkdown).toContain("## 从输入开始");
    expect(result.content.fullExplanationMarkdown).toContain("## 检查处理结果");
    expect(result.content.questions).toHaveLength(4);
    expect(result.trace.repairDiagnostic).toBeUndefined();
  });

  it.each(["quiz", "quizObject", "split", "comprehensionSplit"]) ("preserves provider %s questions without a repair", async variant => {
    const calls: string[] = [];
    const { questions, ...body } = teachingPackage();
    const providerContent = variant === "quiz" ? { ...body, quiz: questions }
      : variant === "quizObject" ? { ...body, quiz: {
        comprehensionQuestions: questions.slice(0, 2), multipleChoiceQuestions: questions.slice(2)
      } } : {
      ...body,
      [variant === "comprehensionSplit" ? "comprehensionQuestions" : "understandingQuestions"]:
        questions.slice(0, 2).map(({ kind: _kind, ...question }) => question),
      multipleChoiceQuestions: questions.slice(2).map(({ kind: _kind, ...question }) => question)
    };
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      return request.phase === "plan" ? "先讲输入，再讲输出" : providerContent;
    });
    expect(calls).toEqual(["plan", "teaching"]);
    expect(result.content.questions.map(question => question.kind)).toEqual([
      "comprehension", "comprehension", "multiple_choice", "multiple_choice"
    ]);
  });

  it("infers an unknown short-answer kind from the absence of options", async () => {
    const calls: string[] = [];
    const content = teachingPackage();
    const questions = content.questions.map((question, index) => index < 2
      ? { ...question, kind: "text_response", options: undefined } : question);
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      return request.phase === "plan" ? "先讲输入，再讲输出" : { ...content, questions };
    });
    expect(calls).toEqual(["plan", "teaching"]);
    expect(result.content.questions.filter(question => question.kind === "comprehension")).toHaveLength(2);
  });

  it.each(["lessonContentMarkdown", "lectureMarkdown", "lessonMarkdown", "teachingContentMarkdown"]) (
    "uses %s as the provider's existing complete explanation", async field => {
    const calls: string[] = [];
    const { fullExplanationMarkdown, ...body } = teachingPackage();
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      return request.phase === "plan" ? "先讲输入，再讲输出"
        : { ...body, [field]: fullExplanationMarkdown };
    });
    expect(calls).toEqual(["plan", "teaching"]);
    expect(result.content.fullExplanationMarkdown).toContain("## 从输入开始");
    }
  );

  it("uses keyPoints list as the provider's existing main content", async () => {
    const calls: string[] = [];
    const { mainContentMarkdown: _mainContentMarkdown, ...body } = teachingPackage();
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      return request.phase === "plan" ? "先讲输入，再讲输出"
        : { ...body, keyPoints: ["输入确定处理对象", "输出记录处理结果"] };
    });
    expect(calls).toEqual(["plan", "teaching"]);
    expect(result.content.mainContentMarkdown).toContain("- 输入确定处理对象");
  });

  it.each(["keyContent", "keyTakeawaysMarkdown", "keyTakeaways", "mainSummaryMarkdown"]) ("uses provider %s as existing main content", async field => {
    const calls: string[] = [];
    const { mainContentMarkdown: _mainContentMarkdown, ...body } = teachingPackage();
    const value = field === "keyContent" || field === "keyTakeaways" ? ["输入确定处理对象", "输出记录处理结果"]
      : "- 输入确定处理对象\n- 输出记录处理结果";
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      return request.phase === "plan" ? "先讲输入，再讲输出" : { ...body, [field]: value };
    });
    expect(calls).toEqual(["plan", "teaching"]);
    expect(result.content.mainContentMarkdown).toContain("- 输入确定处理对象");
  });

  it("keeps model questions when an explanation is returned as paragraphs", async () => {
    const calls: string[] = [];
    const content = teachingPackage();
    const questions = content.questions.map((question, index) => index < 2
      ? { ...question, explanation: [question.explanation, "因此需要核对本页的条件"] }
      : question);
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      if (request.phase === "plan") return "先解释条件再出题";
      return { ...content, questions };
    });

    expect(calls).toEqual(["plan", "teaching"]);
    expect(result.content.questions).toHaveLength(4);
    expect(result.content.questions[0]?.explanation).toContain("\n\n因此需要核对本页的条件");
  });

  it("keeps four model questions when explanations are structured or absent", async () => {
    const calls: string[] = [];
    const content = teachingPackage();
    const questions = content.questions.map((question, index) => ({
      ...question,
      explanation: index === 0 ? { reason: question.explanation, steps: ["核对输入", "重新计算"] }
        : index === 1 ? null : question.explanation
    }));
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      if (request.phase === "plan") return "先解释条件再出题";
      return { ...content, questions };
    });

    expect(calls).toEqual(["plan", "teaching"]);
    expect(result.content.questions).toHaveLength(4);
    expect(result.content.questions[0]?.explanation).toContain("核对输入");
    expect(result.content.questions[1]?.explanation).toBe(content.questions[1]?.expectedAnswer);
    expect(result.trace.qualityWarnings?.[0]?.issues).toContain("TEACHING_QUALITY:QUESTION_EXPLANATION_EQUALS_ANSWER");
  });

  it("uses one focused repair for a machine-shape error", async () => {
    const calls: string[] = [];
    const incomplete: Record<string, unknown> = { ...teachingPackage() };
    delete incomplete.mainContentMarkdown;
    const complete = teachingPackage();
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      if (request.phase === "plan") return "讲解顺序";
      if (request.phase === "teaching") return incomplete;
      expect(Object.keys(request.schema?.properties ?? {})).toContain("mainContentMarkdown");
      expect(request.prompt).toContain("result.mainContentMarkdown:required");
      return complete;
    });

    expect(calls).toEqual(["plan", "teaching", "format_repair"]);
    expect(result.content.mainContentMarkdown).toBe(complete.mainContentMarkdown);
    expect(result.trace.formatWarnings).toBeUndefined();
  });

  it("records nonblocking style warnings without spending a model repair call", async () => {
    const calls: string[] = [];
    const formatted = teachingPackage();
    formatted.priorKnowledge = ["输入：处理开始时已经具备的信息"];
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      if (request.phase === "plan") return "先解释输入";
      return formatted;
    });

    expect(calls).toEqual(["plan", "teaching"]);
    expect(result.content.priorKnowledge).toEqual(formatted.priorKnowledge);
    expect(result.trace.formatWarnings?.[0]?.phase).toBe("teaching");
    expect(result.trace.formatWarnings?.[0]?.issues).toContain("TEACHING_PRESENTATION:priorKnowledge:TERM_PAIR_MISSING");
  });

  it("keeps plannedContentIssues limited to machine shape and accepts empty bridge and coverage", () => {
    const content = teachingPackage();
    expect(plannedContentIssues(content, input())).toEqual([]);

    const missingField: Record<string, unknown> = { ...content };
    delete missingField.questions;
    expect(plannedContentIssues(missingField, input())).toContain("result.questions:required");

    expect(plannedContentIssues({
      ...content,
      chapterBridgeMarkdown: "",
      coverageEvidence: [],
      fullExplanationMarkdown: "简短讲解"
    }, input())).toEqual([]);
  });

  it("returns a usable page with a short explanation and no generated questions", async () => {
    const calls: string[] = [];
    const partial: Record<string, unknown> = {
      ...teachingPackage(),
      fullExplanationMarkdown: "简短讲解"
    };
    delete partial.questions;
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      if (request.phase === "plan") return "先解释对象";
      return partial;
    });

    expect(calls).toEqual(["plan", "teaching", "format_repair"]);
    expect(result.content.questions).toEqual([]);
    expect(result.content.fullExplanationMarkdown).toBe("简短讲解");
    expect(result.trace.qualityWarnings?.[0]?.issues).toEqual([
      "TEACHING_QUALITY:EXPLANATION_SHORT",
      "TEACHING_QUALITY:QUESTION_COUNT:0"
    ]);
  });

  it("keeps a complete lesson when the only format repair still returns malformed questions", async () => {
    const calls: string[] = [];
    const malformed = {
      ...teachingPackage(),
      questions: [{ kind: "comprehension", prompt: 42, options: null, expectedAnswer: null, explanation: "说明" }]
    };
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      return request.phase === "plan" ? "先解释输入" : malformed;
    });
    expect(calls).toEqual(["plan", "teaching", "format_repair"]);
    expect(result.content.fullExplanationMarkdown).toContain("输入是处理开始时已经具备的信息");
    expect(result.content.fullExplanationMarkdown).toContain("## 检查处理结果");
    expect(result.content.questions).toEqual([]);
    expect(result.trace.qualityWarnings?.[0]?.issues).toContain("TEACHING_QUALITY:QUESTION_COUNT:0");
  });

  it("accepts common provider question aliases without changing lesson content", async () => {
    const aliased = {
      ...teachingPackage(),
      questions: [{ type: "comprehension", question: "输入改变后怎么办？", choices: [], answer: "重新计算", rationale: "输出依赖输入" }]
    };
    const result = await writePlannedLesson(input(), async request =>
      request.phase === "plan" ? "先解释输入" : aliased);
    expect(result.content.questions[0]).toEqual({
      kind: "comprehension", prompt: "输入改变后怎么办？", options: [], expectedAnswer: "重新计算", explanation: "输出依赖输入"
    });
  });

  it("projects the provider's complete explanation and split question aliases without a repair request", () => {
    const source = teachingPackage();
    const { fullExplanationMarkdown: _full, questions: _questions, ...body } = source;
    const projected = projectPlannedOutputToSchema({
      ...body,
      completeExplanationMarkdown: source.fullExplanationMarkdown,
      understandingQuestions: source.questions.slice(0, 2),
      choiceQuestions: source.questions.slice(2),
    }, teachingPackageSchema) as typeof source;
    expect(projected.fullExplanationMarkdown).toBe(source.fullExplanationMarkdown);
    expect(projected.questions).toHaveLength(4);
    expect(projected.questions.map(question => question.kind)).toEqual([
      "comprehension", "comprehension", "multiple_choice", "multiple_choice"
    ]);

    const practice = projectPlannedOutputToSchema({
      ...body,
      fullExplanationMarkdown: source.fullExplanationMarkdown,
      practiceQuestions: source.questions,
    }, teachingPackageSchema) as typeof source;
    expect(practice.questions).toHaveLength(4);
  });

  it("projects mainContentSummary to the final main content field", () => {
    const source = teachingPackage();
    const { mainContentMarkdown: _main, ...body } = source;
    const projected = projectPlannedOutputToSchema({
      ...body,
      mainContentSummary: source.mainContentMarkdown
    }, teachingPackageSchema) as typeof source;

    expect(projected.mainContentMarkdown).toBe(source.mainContentMarkdown);
  });

  it("fills the empty options shape for a comprehension answer", () => {
    const projected = projectPlannedOutputToSchema({
      type: "short_answer", question: "这一步解决什么问题？", answer: "连接输入与输出", rationale: "从输入追踪到输出"
    }, (teachingPackageSchema as any).properties.questions.items);
    expect(projected).toEqual({
      kind: "comprehension", prompt: "这一步解决什么问题？", options: [],
      expectedAnswer: "连接输入与输出", explanation: "从输入追踪到输出"
    });
  });

  it("repairs only the question field while preserving the initial explanation", async () => {
    const initial = { ...teachingPackage(), questions: [] };
    const completed = teachingPackage();
    const calls: string[] = [];
    const result = await writePlannedLesson(input(), async request => {
      calls.push(request.phase);
      if (request.phase === "plan") return "先解释输入";
      if (request.phase === "teaching") return initial;
      expect(Object.keys(request.schema?.properties ?? {})).toEqual(["questions"]);
      expect(request.instructions).not.toContain("一次写出所有主体栏目");
      expect(request.instructions).toContain("先完整阅读以下格式规则与写作策略");
      return { questions: completed.questions };
    });
    expect(calls).toEqual(["plan", "teaching", "format_repair"]);
    expect(result.content.questions).toHaveLength(4);
    expect(result.content.fullExplanationMarkdown).toContain("## 检查处理结果");
  });

  it("merges complementary core fields from the first answer and its only repair", async () => {
    const original = { ...teachingPackage(), mainContentMarkdown: undefined };
    const repaired = { ...teachingPackage(), fullExplanationMarkdown: undefined };
    const result = await writePlannedLesson(input(), async request => {
      if (request.phase === "plan") return "先解释输入";
      return request.phase === "teaching" ? original : repaired;
    });
    expect(result.trace.phases.map(phase => phase.phase)).toEqual(["plan", "teaching", "format_repair"]);
    expect(result.content.mainContentMarkdown).toContain("输入确定处理对象");
    expect(result.content.fullExplanationMarkdown).toContain("## 检查处理结果");
    expect(plannedContentIssues(result.content)).toEqual([]);
  });

  it("recovers the final required summary from existing explanation text", async () => {
    const answer = { ...teachingPackage(), mainContentMarkdown: undefined };
    const result = await writePlannedLesson(input(), async request =>
      request.phase === "plan" ? "先解释输入" : answer);
    expect(result.content.mainContentMarkdown).toContain("输入是处理开始时已经具备的信息");
    expect(plannedContentIssues(result.content)).toEqual([]);
  });

  it("keeps deterministic typography and provider-shape normalizers", () => {
    const opening = normalizePlannedOpening({
      chapterBridgeMarkdown: "",
      priorKnowledge: ["输入（input）：已经知道的信息。"],
      learningObjectives: ["理解输入（input）如何得到结果。"]
    });
    expect(opening.chapterBridgeMarkdown).toBe("");
    expect(opening.priorKnowledge?.[0]).toContain("输入（Input）：");
    expect(opening.learningObjectives?.[0]).toContain("输入（Input）");

    const source = normalizePlannedSourceIntroductions({
      fullExplanationMarkdown: "原文：\n> A quoted source\n\n工艺节点（tech node）决定输出。"
    });
    expect(source.fullExplanationMarkdown).toContain("课件原文如下：");
    expect(source.fullExplanationMarkdown).toContain("工艺节点（Tech Node）");
    const question = normalizePlannedQuestionPunctuation({
      questions: [{ kind: "comprehension", prompt: "应该怎样做。", options: [], expectedAnswer: "重新计算。", explanation: "结果取决于输入。" }]
    });
    expect(question.questions?.[0]?.expectedAnswer).toBe("重新计算");

    const schema = { type: "object", properties: {
      questions: { type: "array", items: { type: "object", properties: {
        kind: { type: "string", enum: ["comprehension", "multiple_choice"] }, prompt: { type: "string" }
      }, required: ["kind", "prompt"], additionalProperties: false } }
    }, required: ["questions"], additionalProperties: false };
    expect(projectPlannedOutputToSchema({ questions: [
      { kind: "understanding", prompt: "先说明原因" },
      { type: "choice", prompt: "选择正确说法" }
    ] }, schema)).toEqual({ questions: [
      { kind: "comprehension", prompt: "先说明原因" },
      { kind: "multiple_choice", prompt: "选择正确说法" }
    ] });
  });

  it("retains formatting findings as warnings instead of content gates", () => {
    const malformed = { priorKnowledge: ["输入：缺少可核验的英文名称"] } as Partial<TeachingPackage>;
    expect(plannedFormatIssues(malformed)).toContain("TEACHING_PRESENTATION:priorKnowledge:TERM_PAIR_MISSING");
    const instructions = plannedInstructions(["fullExplanationMarkdown", "coverageEvidence"]);
    expect(instructions).toContain("一次写出所有主体栏目");
    expect(instructions).toContain("FMT-001");
    for (const policy of [policySkill, policyFormatRules, policyExplanationFramework, policyFormulaExplanation]) {
      expect(instructions).toContain(policy.trim());
    }
    expect(planningPrompt).toContain("不输出 JSON");
  });
});
