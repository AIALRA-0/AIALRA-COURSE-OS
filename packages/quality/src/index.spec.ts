import { describe, expect, it } from "vitest";
import { calculateCoverage, normalizeLegacyMathDelimiters, validateMarkdownMath, validatePseudoCodeLines, validateTex } from "./index.js";

describe("strict math", () => {
  it("accepts valid fractions and rejects broken TeX", () => {
    expect(validateTex("\\frac{4}{2}=2").valid).toBe(true);
    expect(validateTex("\\frac{4{2}").valid).toBe(false);
  });

  it("checks every math fragment inside teaching Markdown", () => {
    expect(validateMarkdownMath("有效公式 $\\frac{4}{2}=2$")).toEqual([]);
    expect(validateMarkdownMath("损坏公式 $\\frac{4{2}$")).not.toEqual([]);
  });

  it("converts an unescaped TeX bracket only when its contents are clearly mathematical", () => {
    expect(normalizeLegacyMathDelimiters("[V=V_1\\cup V_2,\\qquad V_1\\cap V_2=\\varnothing]")).toBe("$$\nV=V_1\\cup V_2,\\qquad V_1\\cap V_2=\\varnothing\n$$");
    expect(normalizeLegacyMathDelimiters("普通文字 [第 1 页] 和链接 [文档](https://example.com)")).toBe("普通文字 [第 1 页] 和链接 [文档](https://example.com)");
  });

  it("normalizes every supported delimiter while protecting code and ordinary brackets", () => {
    expect(normalizeLegacyMathDelimiters("行内 \\(x^2\\) 和显示 \\[\\frac{a}{b}\\]"))
      .toBe("行内 $x^2$ 和显示 $$\\frac{a}{b}$$");
    expect(normalizeLegacyMathDelimiters("```ts\nconst value = [x$y];\n```\n`$not math$` [普通文字]"))
      .toBe("```ts\nconst value = [x$y];\n```\n`$not math$` [普通文字]");
    expect(validateMarkdownMath("矩阵 $$\\begin{bmatrix}1 & 0\\\\0 & 1\\end{bmatrix}$$")).toEqual([]);
  });

  it("reports an unclosed explicit delimiter instead of returning a misleading plain-text formula", () => {
    expect(validateMarkdownMath("损坏公式 \\[x^2")).toContain("MATH_UNCLOSED_DISPLAY_DELIMITER");
  });

  it("does not treat a currency amount as an unfinished inline formula", () => {
    expect(validateMarkdownMath("价格是 $5 美元")).toEqual([]);
    expect(normalizeLegacyMathDelimiters("价格是 $5 美元")).toBe("价格是 $5 美元");
  });
});

describe("coverage", () => {
  it("requires every high-risk field", () => {
    const result = calculateCoverage(
      [{ id: "r1", atomId: "a1", requiredFields: ["preState", "postState"], risk: "high" }],
      [{ requirementId: "r1", explanationBlockId: "b1", coveredFields: ["preState"], status: "partial" }]
    );
    expect(result.highRiskCoverage).toBe(0.5);
    expect(result.publishable).toBe(false);
  });
});

describe("pseudocode", () => {
  it("fails a line without before and after state", () => {
    expect(validatePseudoCodeLines([{
      kind: "pseudocode_line",
      id: "line-1",
      lineNumber: 1,
      code: "x = 1",
      semantic: "赋值",
      reads: [],
      writes: ["x"],
      preState: "",
      postState: "x 等于 1",
      sideEffects: [],
      complexityRelation: "常数时间"
    }])).toContain("line-1:preState_MISSING");
  });
});
