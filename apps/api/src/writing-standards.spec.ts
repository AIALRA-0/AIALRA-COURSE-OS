import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpProviderTeachingClient, type ModelRouterInput } from "./model-router.js";
import { approvedWritingInstructions, compileWritingStandard, loadWritingStandards, withApprovedWritingInstructions, writingStandardsDirectory, writingStandardsMarker } from "./writing-standards.js";

describe("APCF runtime writing contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads all normative rules from both pinned sources and preserves protected-content exceptions", () => {
    const bundle = loadWritingStandards();
    expect(bundle.writing.match(/^## \d+\. /gmu)).toHaveLength(29);
    expect(bundle.style.match(/^## S\d+\. /gmu)).toHaveLength(15);
    expect(bundle.writing).toContain("受保护内容原样保持");
    expect(bundle.style).toContain("确定性强度与不确定性局部化");
    expect(bundle.writing).not.toContain("**Bad**");
    // No normative text is abbreviated or replaced with a hand-written summary.
    for (const file of bundle.files) {
      const original = readFileSync(join(writingStandardsDirectory, file.path), "utf8").replace(/\r\n?/gu, "\n");
      const compiled = file.path.startsWith("writing") ? bundle.writing : bundle.style;
      for (const section of compiled.split(/\n\n(?=## )/u)) expect(original).toContain(section);
    }
  });

  it("rejects missing rules rather than silently accepting an incomplete standard", () => {
    expect(() => compileWritingStandard("## 1. Only rule\n\n**必须**\n- preserve", ["1", "2"]))
      .toThrow("WRITING_STANDARD_RULE_COVERAGE_MISMATCH");
  });

  it("fails closed when a distributed source is missing or changed", () => {
    const root = mkdtempSync(join(tmpdir(), "course-writing-"));
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

  it("composes once, rejects marker-only shortcuts and leaves English protocol text intact", () => {
    const approved = approvedWritingInstructions("zh-CN");
    const once = withApprovedWritingInstructions("write the requested fields", "zh-CN");
    expect(withApprovedWritingInstructions(once, "zh-CN")).toBe(once);
    expect(withApprovedWritingInstructions(writingStandardsMarker, "zh-CN")).toContain(approved);
    expect(withApprovedWritingInstructions("Return only JSON", "en")).toContain("本次成文语言是英文");
    expect(withApprovedWritingInstructions("Return only JSON", "en")).toMatch(/Return only JSON$/u);
  });

  it.each(["responses", "messages", "chat_completions"] as const)("sends the actual rules through %s for every writing phase", async protocol => {
    const captured: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
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
    for (const instructions of captured) {
      expect(instructions).toContain(approvedWritingInstructions("zh-CN"));
      expect(instructions.split(writingStandardsMarker)).toHaveLength(2);
      expect(instructions).not.toContain("以下是当前批准写作技能的四份完整原文");
    }
  });
});
