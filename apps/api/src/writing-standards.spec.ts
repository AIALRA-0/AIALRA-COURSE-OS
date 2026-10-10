import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpProviderTeachingClient, type ModelRouterInput } from "./model-router.js";
import { approvedWritingInstructions, compileWritingStandard, loadWritingStandards, withApprovedWritingInstructions, writingStandardsDirectory, writingStandardsMarker } from "./writing-standards.js";

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
      const compiled = file.path.startsWith("writing") ? bundle.writing : bundle.style;
      expect(compiled).toBe(original);
      expect(compiled).toContain("**Bad**");
      expect(compiled).toContain("**Good**");
      expect(createHash("sha256").update(compiled).digest("hex")).toBe(file.sha256);
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

  it("composes once, rejects marker-only shortcuts and leaves English protocol text intact", () => {
    const approved = approvedWritingInstructions("zh-CN");
    const once = withApprovedWritingInstructions("write the requested fields", "zh-CN");
    expect(withApprovedWritingInstructions(once, "zh-CN")).toBe(once);
    expect(withApprovedWritingInstructions(writingStandardsMarker, "zh-CN")).toContain(approved);
    expect(withApprovedWritingInstructions("Return only JSON", "en")).toContain("本次成文语言是英文");
    expect(withApprovedWritingInstructions("Return only JSON", "en")).toMatch(/Return only JSON$/u);
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

  it.each(["responses", "messages", "chat_completions"] as const)("sends the actual rules through %s for every writing phase", async protocol => {
    const captured: string[] = [];
    const requestBodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requestBodies.push(body);
      captured.push(body.instructions ?? body.system ?? body.messages[0].content);
      return Response.json({ status: "completed", output_text: "请求完成", usage: { input_tokens: 10, output_tokens: 10, total_cost: 0.001 } });
    }));
    const client = new HttpProviderTeachingClient({ providerId: "kuafu", model: "deepseek-v4.1-flash", apiKey: "synthetic-test-token", baseUrl: "https://example.test/v1", protocol });
    const input: ModelRouterInput = { pageTitle: "测试", pageNumber: 1, sourceText: "原文", writingPolicySnapshotId: loadWritingStandards().policySnapshotId, language: "zh-CN", qualityMode: "balanced", idempotencyKey: "isolated-writing-test", maxCostUsd: 0.2 };
    const boundary = client as unknown as { requestPlannedStage: (input: ModelRouterInput, request: { phase: string; instructions: string; prompt: string; maxOutputTokens: number }, budget: number) => Promise<unknown> };
    for (const phase of ["page_understanding", "plan", "teaching", "format_repair", "chapter_bridge"]) {
      await boundary.requestPlannedStage(input, { phase, instructions: "只填写本次请求", prompt: "原文", maxOutputTokens: 500 }, 0.2);
    }
    expect(captured).toHaveLength(5);
    const bundle = loadWritingStandards();
    for (const instructions of captured) {
      expect(instructions).toContain(approvedWritingInstructions("zh-CN"));
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
    if (evidenceDirectory) writeFileSync(join(evidenceDirectory, `request-${protocol}.json`), JSON.stringify({ protocol, phases: ["page_understanding", "plan", "teaching", "format_repair", "chapter_bridge"], firstRequest: requestBodies[0], checkedRequests: captured.length }, null, 2));
  });
});
