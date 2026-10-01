import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, normalizeLegacyMathDelimiters, normalizeStandaloneMathBlocks } from "./Markdown.js";
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
    "错误理解：只看平均值\n\n错因：漏掉边界\n\n正确判断：先检查 $K=4$\n\n核对方法：回到原图“Reward”一行",
    "错误理解：只看平均值；错因：漏掉边界；正确判断：先检查 $K=4$；核对方法：回到原图“Reward”一行",
    "**错误理解：** 只看平均值\n\n**错因：** 漏掉边界\n\n**正确判断：** 先检查 $K=4$\n\n**核对方法：** 回到原图“Reward”一行"
  ])("always renders each misconception label once in bold", source => {
    const visible = displayMisconception(source);
    expect(displayMisconception(visible)).toBe(visible);
    const html = renderToStaticMarkup(createElement(Markdown, { children: visible }));
    for (const role of ["错误理解：", "错因：", "正确判断：", "核对方法："]) {
      expect(html.match(new RegExp(`<strong>${role}</strong>`, "g"))).toHaveLength(1);
    }
    expect(html).toContain("katex");
    expect(html).toContain("Reward");
  });
  it.each([
    "**易错边界：** 检查 $x^2$，并保留 **正文重点** 和代码 `a**b`。",
    "**易错边界： ** 检查 $x^2$，并保留 **正文重点** 和代码 `a**b`。"
  ])("renders a misconception subheading and preserves its following Markdown", source => {
    const html = renderToStaticMarkup(createElement(Markdown, { children: displayMisconception(source) }));

    expect(html).toContain("<strong>易错边界：</strong> 检查 ");
    expect(html).toContain("<strong>正文重点</strong>");
    expect(html).toContain("<code>a**b</code>");
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("**易错边界");
  });

  it("repairs legacy spaces before misconception label closers", () => {
    const source = [
      "**错误理解： **把最大值当成平均值",
      "**错因： **忽略了其他列",
      "**正确判断： **应逐列比较",
      "**核对方法： **回到表格逐列检查"
    ].join("\n\n");
    const visible = displayMisconception(source);
    const html = renderToStaticMarkup(createElement(Markdown, { children: visible }));

    for (const role of ["错误理解：", "错因：", "正确判断：", "核对方法："]) {
      expect(html.match(new RegExp(`<strong>${role}</strong>`, "g"))).toHaveLength(1);
    }
    expect(visible).not.toContain("： **");
    expect(html).toContain("把最大值当成平均值");
    expect(html).toContain("回到表格逐列检查");
  });

  it("normalizes malformed labels following an inline semicolon", () => {
    const source = "**错误理解： **把总和当成平均值；**错因： **忽略项数；**正确判断： **按项数求平均；**核对方法： **检查分母";
    const html = renderToStaticMarkup(createElement(Markdown, { children: displayMisconception(source) }));

    for (const role of ["错误理解：", "错因：", "正确判断：", "核对方法："]) {
      expect(html.match(new RegExp(`<strong>${role}</strong>`, "g"))).toHaveLength(1);
    }
    expect(html).toContain("把总和当成平均值");
    expect(html).toContain("检查分母");
  });

  it("renders a bold colon label when legacy prose immediately follows its closer", () => {
    const source = "**混淆位置：**以为选好单元位置就完成了连接。";
    const html = renderToStaticMarkup(createElement(Markdown, { children: displayMisconception(source) }));

    expect(html).toContain("<strong>混淆位置：</strong> 以为选好单元位置就完成了连接。");
    expect(html).not.toContain("**混淆位置：**");
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

  it("keeps vertical bars inside inline math from splitting table cells", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { children: "正文复杂度为 $O(|V|+|E|)$。\n\n| Method | Complexity |\n| --- | --- |\n| Scan | $O(|V|+|E|)$ |\n| Pair search | $O(|A||B|)$ |\n| Matrix | $\\begin{pmatrix}1&0\\\\0&1\\end{pmatrix}$ |" }));
    expect(html.match(/<tr>/g)).toHaveLength(4);
    expect(html.match(/<td>/g)).toHaveLength(6);
    expect(html.match(/class="katex"/g)).toHaveLength(4);
    expect(html).toContain("katex-html");
    expect(html).not.toContain("katex-error");
  });

  it("distinguishes stored Chapter 2 math delimiters from exact corrected candidates", () => {
    const pairHeader = String.raw`| pair | $$E_x$-$I_x$$ | $$E_y$-$I_y$$ | $c(x,y)$ | gain |
| --- | --- | --- | --- | --- |
| (x,y) | 1 | 2 | 3 | 4 |`;
    const correctedPairHeader = String.raw`| pair | $E_x-I_x$ | $E_y-I_y$ | $c(x,y)$ | gain |
| --- | --- | --- | --- | --- |
| (x,y) | 1 | 2 | 3 | 4 |`;
    const partitionHeader = String.raw`| $$P_A$$ | $$P_B$$ | cutsize | ratio cut |
| --- | --- | --- | --- |
| A | B | 3 | 0.5 |`;
    const correctedPartitionHeader = String.raw`| $P_A$ | $P_B$ | cutsize | ratio cut |
| --- | --- | --- | --- |
| A | B | 3 | 0.5 |`;
    const renderStats = (source: string) => {
      const html = renderToStaticMarkup(createElement(Markdown, { children: source }));
      return {
        rows: html.match(/<tr>/g)?.length ?? 0,
        headers: html.match(/<th>/g)?.length ?? 0,
        cells: html.match(/<td>/g)?.length ?? 0,
        katex: html.match(/class="katex"/g)?.length ?? 0,
        katexErrors: html.match(/katex-error/g)?.length ?? 0
      };
    };

    expect(normalizeLegacyMathDelimiters(pairHeader)).toBe(pairHeader);
    expect(normalizeLegacyMathDelimiters(partitionHeader)).toBe(partitionHeader);
    expect(renderStats(pairHeader)).toEqual({ rows: 2, headers: 5, cells: 5, katex: 1, katexErrors: 2 });
    expect(renderStats(correctedPairHeader)).toEqual({ rows: 2, headers: 5, cells: 5, katex: 3, katexErrors: 0 });
    expect(renderStats(partitionHeader)).toEqual({ rows: 2, headers: 4, cells: 4, katex: 2, katexErrors: 0 });
    expect(renderStats(correctedPartitionHeader)).toEqual({ rows: 2, headers: 4, cells: 4, katex: 2, katexErrors: 0 });
  });

  it("distinguishes literal doubled backslashes from a single TeX inline delimiter in a table cell", () => {
    const doubledSlash = String.raw`| item | value |
| --- | --- |
| sample | \\(g\\) |`;
    const singleSlash = String.raw`| item | value |
| --- | --- |
| sample | \(g\) |`;
    const renderStats = (source: string) => {
      const html = renderToStaticMarkup(createElement(Markdown, { children: source }));
      return {
        cells: html.match(/<td>/g)?.length ?? 0,
        katex: html.match(/class="katex"/g)?.length ?? 0,
        visible: [...html.matchAll(/<td>(.*?)<\/td>/gu)].map((match) => match[1])
      };
    };

    expect(renderStats(doubledSlash)).toEqual({ cells: 2, katex: 0, visible: ["sample", "$g$"] });
    const singleSlashResult = renderStats(singleSlash);
    expect(singleSlashResult.cells).toBe(2);
    expect(singleSlashResult.katex).toBe(1);
    expect(singleSlashResult.visible[1]).toContain("katex");
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
