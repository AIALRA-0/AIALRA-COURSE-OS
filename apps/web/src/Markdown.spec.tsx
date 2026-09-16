import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown.js";

describe("lesson math rendering", () => {
  it("renders a mixed Edge-GNN objective as math inside a list item", () => {
    const html = renderToStaticMarkup(createElement("li", null, createElement(Markdown, { children: "令 W_e$v_i;v_j$ 表示边的嵌入" })));
    expect(html.match(/class="katex"/g)).toHaveLength(2);
    expect(html).toContain("表示边的嵌入");
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
