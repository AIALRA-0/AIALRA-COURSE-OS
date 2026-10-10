import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpProviderTeachingClient, type ModelRouterInput } from "./model-router.js";
import { currentGenerationHarness } from "./generation-harness.js";
import { plannedInstructions, writingFormatContract } from "./planned-teaching.js";
import { approvedWritingInstructions, compileWritingStandard, generatedHeadingInstructions, loadWritingStandards, withApprovedWritingInstructions, writingActivationInstructions, writingStandardsDirectory, writingStandardsMarker } from "./writing-standards.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

describe("APCF runtime writing contract", () => {
  const temporaryRoots: string[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.mocked(readFileSync).mockReset().mockImplementation(fs.readFileSync);
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("loads all normative rules from both pinned sources and preserves protected-content exceptions", () => {
    const bundle = loadWritingStandards();
    // Rule-like headings in preserved examples are not additional rule IDs.
    expect(compileWritingStandard(bundle.writing, Array.from({ length: 29 }, (_, i) => String(i + 1)))).toBe(bundle.writing);
    expect(compileWritingStandard(bundle.style, Array.from({ length: 15 }, (_, i) => `S${String(i).padStart(2, "0")}`))).toBe(bundle.style);
    expect(bundle.writing).toContain("受保护内容原样保持");
    expect(bundle.style).toContain("确定性强度与不确定性局部化");
    // The full source, including the preamble and every example, is unchanged.
    for (const file of bundle.files) {
      const original = readFileSync(join(writingStandardsDirectory, file.path), "utf8");
      const compiled = { "writing-standard-source.md": bundle.writing, "style-standard-source.md": bundle.style, "writing-activation-source.md": bundle.activation, "writing-minimal-examples.md": bundle.examples }[file.path];
      expect(compiled).toBe(original);
      if (file.path === "writing-standard-source.md" || file.path === "style-standard-source.md") {
        expect(compiled).toContain("**Bad**");
        expect(compiled).toContain("**Good**");
      }
      expect(createHash("sha256").update(compiled!).digest("hex")).toBe(file.sha256);
    }
  });

  it.each(["\n", "\r\n", "\r"])("preserves preamble, examples, whitespace and %j line endings", newline => {
    const source = ["  preamble  ", "", "## 1. First", "body", "**Bad**", "bad sample", "**Good**", "good sample", "", "## 2. Last", "tail  ", "", ""].join(newline);
    expect(compileWritingStandard(source, ["1", "2"])).toBe(source);
  });

  it.each([
    ["```text", "```"],
    ["   ```markdown", "   ```"],
    ["~~~~text", "~~~~~"],
    ["  ````markdown", "  `````"]
  ])("ignores pseudo headings inside %s fences without discarding their text", (opening, closing) => {
    const shorter = opening.includes("~") ? "~~~" : "``";
    const otherMarker = opening.includes("~") ? "````" : "~~~~";
    const source = ["preamble", "## 1. First", opening, "## 2. Fake", "## S00. Fake", shorter, otherMarker, "## 99. Still fenced", closing, "## 2. Actual last", "tail\n"].join("\n");
    expect(compileWritingStandard(source, ["1", "2"])).toBe(source);
  });

  it("does not close a fence on an apparent closing line that has trailing content", () => {
    const source = "## 1. First\n```text\n``` not a closing fence\n## 99. Example\n```\n## 2. Last\n";
    expect(compileWritingStandard(source, ["1", "2"])).toBe(source);
  });

  it.each([
    "## 1. One\n## 1. Duplicate\n## 2. Two",
    "## 2. Two\n## 1. One",
    "## 1. One\n## 2. Two\n## 3. Extra",
    "## 1. One\n```text\n## 2. Fenced rather than an actual rule",
    "## S01. Reordered\n## S00. Zero"
  ])("rejects duplicate, reordered, extra or fenced-only rule coverage: %s", source => {
    const expected = source.startsWith("## S") ? ["S00", "S01"] : ["1", "2"];
    expect(() => compileWritingStandard(source, expected)).toThrow("WRITING_STANDARD_RULE_COVERAGE_MISMATCH");
  });

  it("rejects missing rules rather than silently accepting an incomplete standard", () => {
    expect(() => compileWritingStandard("## 1. Only rule\n\n**必须**\n- preserve", ["1", "2"]))
      .toThrow("WRITING_STANDARD_RULE_COVERAGE_MISMATCH");
  });

  it("fails closed when a distributed source is missing or changed", () => {
    const root = mkdtempSync(join(tmpdir(), "course-writing-"));
    temporaryRoots.push(root);
    const directory = join(root, "generation-harness");
    mkdirSync(directory);
    writeFileSync(join(root, "writing-policy-manifest.json"), readFileSync(join(writingStandardsDirectory, "../writing-policy-manifest.json")));
    expect(() => loadWritingStandards(directory)).toThrow();
    const bundle = loadWritingStandards();
    for (const file of bundle.files) writeFileSync(join(directory, file.path), readFileSync(join(writingStandardsDirectory, file.path)));
    expect(loadWritingStandards(directory).policySnapshotId).toBe(bundle.policySnapshotId);
    writeFileSync(join(directory, bundle.files[0]!.path), "changed");
    expect(() => loadWritingStandards(directory)).toThrow("WRITING_STANDARD_HASH_MISMATCH");
  });

  it.each(["aggregateSha256", "policySnapshotId"])("fails closed when manifest %s is changed", field => {
    const root = mkdtempSync(join(tmpdir(), "course-writing-"));
    temporaryRoots.push(root);
    const directory = join(root, "generation-harness");
    mkdirSync(directory);
    const manifest = JSON.parse(readFileSync(join(writingStandardsDirectory, "../writing-policy-manifest.json"), "utf8"));
    manifest[field] = "changed";
    writeFileSync(join(root, "writing-policy-manifest.json"), JSON.stringify(manifest));
    for (const file of loadWritingStandards().files) writeFileSync(join(directory, file.path), readFileSync(join(writingStandardsDirectory, file.path)));
    expect(() => loadWritingStandards(directory)).toThrow("WRITING_STANDARD_MANIFEST_HASH_MISMATCH");
  });

  it("can still read a pinned legacy two-source bundle without inventing activation sources", () => {
    const root = mkdtempSync(join(tmpdir(), "course-writing-"));
    temporaryRoots.push(root);
    const directory = join(root, "generation-harness");
    mkdirSync(directory);
    const manifest = JSON.parse(readFileSync(join(writingStandardsDirectory, "../writing-policy-manifest.json"), "utf8"));
    manifest.files = manifest.files.slice(0, 2);
    manifest.aggregateSha256 = createHash("sha256").update(JSON.stringify(manifest.files.map(({ path, sha256 }: { path: string; sha256: string }) => ({ path, sha256 })))).digest("hex");
    manifest.policySnapshotId = `writing-policy:${manifest.aggregateSha256.slice(0, 16)}`;
    writeFileSync(join(root, "writing-policy-manifest.json"), JSON.stringify(manifest));
    for (const file of manifest.files) writeFileSync(join(directory, file.path), readFileSync(join(writingStandardsDirectory, file.path)));
    const legacy = loadWritingStandards(directory);
    expect(legacy.writing).toBe(loadWritingStandards().writing);
    expect(legacy.style).toBe(loadWritingStandards().style);
    expect(legacy.activation).toBe("");
    expect(writingActivationInstructions(legacy)).toBe("");
  });

  it("composes once, rejects marker-only shortcuts and leaves English protocol text intact", () => {
    const approved = approvedWritingInstructions("zh-CN");
    const once = withApprovedWritingInstructions("write the requested fields", "zh-CN");
    expect(withApprovedWritingInstructions(once, "zh-CN")).toBe(once);
    expect(withApprovedWritingInstructions(writingStandardsMarker, "zh-CN")).toContain(approved.slice(0, -generatedHeadingInstructions.length).trimEnd());
    expect(withApprovedWritingInstructions("Return only JSON", "en")).toContain("本次成文语言是英文");
    expect(withApprovedWritingInstructions("Return only JSON", "en")).toContain("Return only JSON");
    expect(withApprovedWritingInstructions("Return only JSON", "en").endsWith(generatedHeadingInstructions)).toBe(true);
  });

  it("reapplies release reminders after the phase without replacing full rules or multiplying calls", () => {
    const bundle = loadWritingStandards();
    expect(bundle.files).toHaveLength(4);
    const activation = writingActivationInstructions(bundle);
    expect(activation).toContain(bundle.activation);
    expect(activation).toContain(bundle.examples);
    expect(activation).toContain("案例用于说明写法，不是本页知识来源");
    expect(activation).toContain("正式报告的术语表例外仅适用于要求术语表的任务");
    const phase = "只填写本次教学字段";
    const composed = withApprovedWritingInstructions(phase, "zh-CN");
    expect(composed).toContain(bundle.writing);
    expect(composed).toContain(bundle.style);
    expect(composed.indexOf(activation)).toBeGreaterThan(composed.indexOf(phase));
    expect(composed.split(activation)).toHaveLength(2);
    expect(composed.indexOf(generatedHeadingInstructions)).toBeGreaterThan(composed.indexOf(activation));
    expect(withApprovedWritingInstructions(composed, "zh-CN")).toBe(composed);
  });

  it.each(["writing-activation-source.md", "writing-minimal-examples.md"])("rejects drift in %s before sending even a previously composed prompt", fileName => {
    const once = withApprovedWritingInstructions("只填写教学字段", "zh-CN");
    const originalRead = fs.readFileSync;
    vi.mocked(readFileSync).mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).endsWith(fileName)) return Buffer.from("changed synthetic reminder");
      return originalRead(...args);
    }) as typeof fs.readFileSync);
    expect(() => withApprovedWritingInstructions(once, "zh-CN")).toThrow("WRITING_STANDARD_HASH_MISMATCH");
  });

  it.each(["zh-CN", "en"])("scopes the bilingual heading override without changing %s prose or source rules", language => {
    const approved = approvedWritingInstructions(language);
    expect(approved).toContain(generatedHeadingInstructions);
    for (const requirement of [
      "页面标题", "章节／分区标题", "实质内容的 Markdown 标题", "任何英文（包括缩写和中英混排）",
      "中文 English", "中文在前、对应英文在后", "不使用中文或英文括号", "注意力 Attention", "自注意力 Self-Attention",
      "纯中文标题保持原样", "已有标题编号与 Markdown 层级继续保留", "英文语言任务中同样执行",
      "英文任务的正文仍用自然英文", "优先于通用名称括号规则、示例和成文语言要求",
      "fullExplanationMarkdown 以 Markdown H1 或 H2 主要标题开头", "首个主要标题就是当前页教学标题",
      "首个教学标题必须保留对应英文并配上准确中文", "不得用“本次实际问题”“完整讲解”等通用标题替代本页主题",
      "阶段提示不得覆盖本标题合同",
      "正文术语与定义继续遵守完整 Writing／Style", "原文引用及其中的标题", "原始图片及可见标签",
      "代码、文件名和来源作品标题受保护", "逐字转写或引用时保持原样", "任务未要求标题时不新增标题"
    ]) expect(generatedHeadingInstructions).toContain(requirement);
    expect(approved.indexOf(generatedHeadingInstructions)).toBeGreaterThan(approved.indexOf(loadWritingStandards().style));
    const composed = withApprovedWritingInstructions(plannedInstructions([], language), language);
    expect(composed.split(generatedHeadingInstructions)).toHaveLength(2);
    expect(withApprovedWritingInstructions(composed, language)).toBe(composed);
    expect(composed.endsWith(generatedHeadingInstructions)).toBe(true);
    expect(writingFormatContract).toContain("此定义格式不用于生成主要标题");
    expect(writingFormatContract).toContain("## 1. 注意力 Attention");
    expect(writingFormatContract).toContain("### 1.1. 自注意力 Self-Attention");
    expect(writingFormatContract).not.toContain("## 1. 本次实际问题");
    expect(currentGenerationHarness().version).toBe("2.5.7");
  });

  it("puts the single heading override after conflicting phase language and term-format instructions", () => {
    const phase = "All headings must be English only. Use 中文（English） for headings. Return only JSON.";
    const composed = withApprovedWritingInstructions(`${approvedWritingInstructions("en")}\n\n${phase}`, "en");
    expect(composed).toContain(phase);
    expect(composed.indexOf(generatedHeadingInstructions)).toBeGreaterThan(composed.indexOf(phase));
    expect(composed.split(generatedHeadingInstructions)).toHaveLength(2);
    expect(composed.endsWith(generatedHeadingInstructions)).toBe(true);
    expect(withApprovedWritingInstructions(composed, "en")).toBe(composed);
  });

  it("revalidates even an already injected prompt and sends nothing after a source SHA mismatch", async () => {
    const once = withApprovedWritingInstructions("synthetic protocol", "zh-CN");
    const originalRead = fs.readFileSync;
    vi.mocked(readFileSync).mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).endsWith("writing-standard-source.md")) return Buffer.from("tampered synthetic source");
      return originalRead(...args);
    }) as typeof fs.readFileSync);
    expect(() => withApprovedWritingInstructions(once, "zh-CN")).toThrow("WRITING_STANDARD_HASH_MISMATCH");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpProviderTeachingClient({ providerId: "kuafu", model: "deepseek-v4.1-flash", apiKey: "synthetic-test-token", baseUrl: "https://example.test/v1", protocol: "responses" });
    const boundary = client as unknown as { requestPlannedStage: (input: ModelRouterInput, request: { phase: string; instructions: string; prompt: string; maxOutputTokens: number }, budget: number) => Promise<unknown> };
    const input: ModelRouterInput = { pageTitle: "测试", pageNumber: 1, sourceText: "合成原文", writingPolicySnapshotId: "synthetic-mismatch-snapshot", language: "zh-CN", qualityMode: "balanced", idempotencyKey: "hash-mismatch-test", maxCostUsd: 0.2 };
    await expect(boundary.requestPlannedStage(input, { phase: "teaching", instructions: once, prompt: "合成原文", maxOutputTokens: 500 }, 0.2)).rejects.toThrow("WRITING_STANDARD_HASH_MISMATCH");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const transports = ["responses", "messages", "chat_completions"] as const;
  const cases = transports.flatMap(protocol => ["zh-CN", "en"].map(language => ({ protocol, language })));

  it.each(cases)("sends the actual rules through $protocol in $language for every writing phase", async ({ protocol, language }) => {
    const captured: string[] = [];
    const requestBodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requestBodies.push(body);
      captured.push(body.instructions ?? body.system ?? body.messages[0].content);
      return Response.json({ status: "completed", output_text: "请求完成", usage: { input_tokens: 10, output_tokens: 10, total_cost: 0.001 } });
    }));
    const client = new HttpProviderTeachingClient({ providerId: "kuafu", model: "deepseek-v4.1-flash", apiKey: "synthetic-test-token", baseUrl: "https://example.test/v1", protocol });
    const input: ModelRouterInput = { pageTitle: "测试", pageNumber: 1, sourceText: "原文", writingPolicySnapshotId: loadWritingStandards().policySnapshotId, language, qualityMode: "balanced", idempotencyKey: "isolated-writing-test", maxCostUsd: 0.2 };
    const boundary = client as unknown as { requestPlannedStage: (input: ModelRouterInput, request: { phase: string; instructions: string; prompt: string; maxOutputTokens: number }, budget: number) => Promise<unknown> };
    for (const phase of ["page_understanding", "plan", "teaching", "format_repair", "bridge"]) {
      await boundary.requestPlannedStage(input, { phase, instructions: "只填写本次请求", prompt: "原文", maxOutputTokens: 500 }, 0.2);
    }
    expect(captured).toHaveLength(5);
    const bundle = loadWritingStandards();
    for (const instructions of captured) {
      expect(instructions).toContain(approvedWritingInstructions(language).slice(0, -generatedHeadingInstructions.length).trimEnd());
      expect(instructions.split(generatedHeadingInstructions)).toHaveLength(2);
      expect(instructions.endsWith(generatedHeadingInstructions)).toBe(true);
      for (const file of bundle.files) {
        const original = readFileSync(join(writingStandardsDirectory, file.path), "utf8");
        expect(instructions).toContain(original);
        expect(instructions).toContain(original.slice(0, 140));
        expect(instructions).toContain(original.slice(-140));
        expect(instructions.split(original)).toHaveLength(2);
      }
      expect(instructions.split(writingStandardsMarker)).toHaveLength(2);
      expect(instructions).not.toContain("以下是当前批准写作技能的四份完整原文");
    }
    const evidenceDirectory = process.env.COURSE_OS_WRITING_TEST_EVIDENCE_DIRECTORY;
    if (evidenceDirectory) writeFileSync(join(evidenceDirectory, `request-${protocol}-${language}.json`), JSON.stringify({ protocol, language, phases: ["page_understanding", "plan", "teaching", "format_repair", "bridge"], firstRequest: requestBodies[0], checkedRequests: captured.length }, null, 2));
  });

  it.each(cases)("covers public generation and both repair prompts through $protocol in $language", async ({ protocol, language }) => {
    const source = '# Attention (Original)\n> Source heading (verbatim).\n\n![Attention (image label)](slide.png)\n\n```text\n# Attention (code)\nfile_name.py\n```\nSource title: Attention Is All You Need';
    const image = "data:image/png;base64,c3ludGhldGljLWltYWdl";
    const candidate = {
      chapterBridgeMarkdown: "", learningObjectives: [], priorKnowledge: [], misconceptions: [], coverageEvidence: [], questions: [],
      mainContentMarkdown: "- 根据来源说明信息的作用",
      fullExplanationMarkdown: "## 1. 注意力 Attention\n\n根据当前对象与其他对象的关系分配权重\n\n## 2. 计算过程\n\n将相关信息按权重汇总"
    };
    // Broken machine output exercises the existing full repair; a saved draft
    // exercises its field-only repair. Replies are fixtures, not model evidence.
    const replies = [
      `页面内容：${source}\n教学顺序：先读来源，再解释作用`, "先解释信息的作用", "not a teaching package",
      JSON.stringify(candidate), "本页解释信息如何根据关系汇总", JSON.stringify({ mainContentMarkdown: candidate.mainContentMarkdown })
    ];
    const requests: Array<{ phase: string; instructions: string; prompt: Record<string, unknown>; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const instructions = body.instructions ?? body.system ?? body.messages[0].content;
      const user = body.input ?? body.messages.at(-1).content;
      const prompt = typeof user === "string" ? user
        : body.input ? user[0].content[0].text : user[0].text;
      const phase = new Headers(init.headers).get("Idempotency-Key")!.split(":").at(-1)!;
      requests.push({ phase, instructions, prompt: JSON.parse(prompt), body });
      const reply = replies.shift();
      expect(reply).toBeDefined();
      return Response.json({ status: "completed", output_text: reply, usage: { input_tokens: 10, output_tokens: 10, total_cost: 0.001 } });
    }));
    const client = new HttpProviderTeachingClient({ providerId: "kuafu", model: "deepseek-v4.1-flash", apiKey: "synthetic-test-token", baseUrl: "https://example.test/v1", protocol, supportsVision: true });
    const input: ModelRouterInput = { pageTitle: "Attention (Original)", pageNumber: 1, sourceText: source,
      sourceImageDataUrl: image, writingPolicySnapshotId: loadWritingStandards().policySnapshotId,
      language, qualityMode: "balanced", idempotencyKey: "public-heading-test", maxCostUsd: 1 };
    expect((await client.understandPage(input))?.sourceDescription).toBe(source);
    const generated = await client.generateTeachingPackage(input);
    expect(generated.teachingTrace?.phases.map(phase => phase.phase)).toEqual(["plan", "teaching", "format_repair"]);
    expect(generated.schemaRetries).toBe(1);
    await client.generateBridge({ ...input, currentSummary: "已确认的本页摘要" });
    await client.generateTeachingPackage({ ...input, repairMissingMainContent: { ...candidate, mainContentMarkdown: "" } });
    expect(requests.map(request => request.phase)).toEqual(["page_understanding", "plan", "teaching", "format_repair", "bridge", "format_repair"]);
    expect(replies).toHaveLength(0);
    const bundle = loadWritingStandards();
    for (const request of requests) {
      expect(request.instructions.split(generatedHeadingInstructions)).toHaveLength(2);
      // Non-Responses transports append machine Schema instructions after the
      // composed prose policy; all upstream phase prose must precede it.
      const afterHeading = request.instructions.slice(request.instructions.indexOf(generatedHeadingInstructions) + generatedHeadingInstructions.length);
      expect(afterHeading === "" || afterHeading.startsWith("\n请输出符合下列 JSON Schema")).toBe(true);
      expect(request.instructions.split(writingStandardsMarker)).toHaveLength(2);
      expect(request.instructions.split(bundle.writing)).toHaveLength(2);
      expect(request.instructions.split(bundle.style)).toHaveLength(2);
      expect(request.prompt.pageTitle ?? request.prompt.title).toBe(input.pageTitle);
      if (request.phase !== "bridge") expect(request.prompt.source ?? request.prompt.extractedText).toBe(source);
    }
    expect(requests[2]!.prompt.language).toBe(language);
    expect(requests[3]!.prompt.targetFields).toContain("fullExplanationMarkdown");
    expect(requests[5]!.prompt.targetFields).toEqual(["mainContentMarkdown"]);
    for (const request of requests.slice(0, 3)) {
      const body = request.body as { input?: Array<{ content: Array<{ image_url?: string }> }>; messages?: Array<{ content: Array<{ source?: { data: string }; image_url?: { url: string } }> }> };
      if (protocol === "responses") expect(body.input?.[0]?.content[1]?.image_url).toBe(image);
      else if (protocol === "messages") expect(body.messages?.at(-1)?.content[1]?.source?.data).toBe(image.split(",")[1]);
      else expect(body.messages?.at(-1)?.content[1]?.image_url?.url).toBe(image);
    }
    const evidenceDirectory = process.env.COURSE_OS_WRITING_TEST_EVIDENCE_DIRECTORY;
    if (evidenceDirectory) writeFileSync(join(evidenceDirectory, `public-requests-${protocol}-${language}.json`), JSON.stringify({
      protocol, language, headingPolicy: generatedHeadingInstructions, policySnapshotId: bundle.policySnapshotId,
      requests: requests.map(({ phase, prompt, instructions }) => ({ phase, prompt,
        headingPolicyCopies: instructions.split(generatedHeadingInstructions).length - 1,
        writingSourceCopies: instructions.split(bundle.writing).length - 1,
        styleSourceCopies: instructions.split(bundle.style).length - 1 }))
    }, null, 2));
  });
});
