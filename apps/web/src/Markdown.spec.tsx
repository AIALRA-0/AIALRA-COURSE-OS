import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, normalizeStandaloneMathBlocks } from "./Markdown.js";
import { displayMisconception } from "./ExplanationPanel.js";

describe("lesson math rendering", () => {
  it("centers standalone equations without changing inline formulas or fenced code", () => {
    const source = "先看 $K$ 的含义\n\n$J(\\theta,G)=\\frac{1}{K}\\sum_{g\\in G}E_g$\n\n```text\n$x=1$\n```";
    const normalized = normalizeStandaloneMathBlocks(source);
    expect(normalized).toContain("$$\nJ(\\theta,G)=\\frac{1}{K}\\sum_{g\\in G}E_g\n$$");
    expect(normalized).toContain("先看 $K$ 的含义");
    expect(normalized).toContain("```text\n$x=1$\n```");
    const html = renderToStaticMarkup(createElement(Markdown, { children: source }));
    expect(html).toContain("katex-display");
    expect(html).not.toContain("katex-error");
  });
  it("renders a mixed Edge-GNN objective as math inside a list item", () => {
    const html = renderToStaticMarkup(createElement("li", null, createElement(Markdown, { children: "令 W_e$v_i;v_j$ 表示边的嵌入" })));
    expect(html.match(/class="katex"/g)).toHaveLength(2);
    expect(html).toContain("表示边的嵌入");
  });
  it("renders old misconception prose as four consistently labelled paragraphs", () => {
    const old = "误以为 Ours 每列都最小\n\n错因是跳过反例\n\n正确判断：逐列比较\n\n核对方法：检查每列";
    const html = renderToStaticMarkup(createElement(Markdown, { children: displayMisconception(old) }));
    for (const role of ["错误理解：", "错因：", "正确判断：", "核对方法："]) {
      expect(html).toContain(`<strong>${role}</strong>`);
    }
    expect(html.match(/<p>/g)).toHaveLength(4);
  });
  it.each([
    ["仅有公式", "$x$", true],
    ["公式前有文字", "目标是 $J(\\theta,G)$", false],
    ["公式后有文字", "$K$ 是芯片数", false],
    ["两侧都有文字", "将 $K=4$ 代入目标", false],
    ["列项内有公式和文字", "- 能区分 $1/K$ 与求和", false]
  ])("centers only a pure formula paragraph: %s", (_name, source, centered) => {
    const html = renderToStaticMarkup(createElement(Markdown, { children: source }));
    expect(html.includes('class="math-only-paragraph"')).toBe(centered);
  });

  it("renders mathematical answer options as inline content", () => {
    const html = renderToStaticMarkup(createElement("label", null, createElement(Markdown, { inline: true, children: "结果是 $\\frac{1}{2}$" })));
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("<p>");
    expect(html).not.toContain("katex-error");
  });

  it("renders a table as original rows and cells in a local scroll container", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { children: "| Method | Value |\n| --- | --- |\n| A | $x_1$ |\n| B | 2 |" }));
    expect(html).toContain('class="lesson-table-scroll"');
    expect(html).toContain("<th>Method</th>");
    expect(html.match(/<td>/g)).toHaveLength(4);
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("katex-error");
  });

  it("keeps teaching subheadings below the page and section headings", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { nestedHeadings: true, children: "## 为什么先训练\n\n说明训练的作用\n\n### 何时使用\n\n说明适用条件\n\n#### 变量含义\n\n说明变量\n\n##### 更细的说明" }));
    expect(html).toContain("<h4>为什么先训练</h4>");
    expect(html).toContain("<h5>何时使用</h5>");
    expect(html).toContain("<h6>变量含义</h6>");
    expect(html).toContain("<h6>更细的说明</h6>");
    expect(html).not.toContain("<h2>");
  });
});
