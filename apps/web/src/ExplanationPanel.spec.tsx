import { describe, expect, it } from "vitest";
import { summaryMarkdown } from "./ExplanationPanel.js";

describe("lesson summary", () => {
  it("removes a duplicate leading title while preserving the existing conclusions", () => {
    expect(summaryMarkdown("## 编码器与迁移学习\n\n- 先训练编码器\n- 再将它接入另一种网络"))
      .toBe("- 先训练编码器\n- 再将它接入另一种网络");
    expect(summaryMarkdown("## 只有标题的旧内容")).toBe("## 只有标题的旧内容");
  });
});
