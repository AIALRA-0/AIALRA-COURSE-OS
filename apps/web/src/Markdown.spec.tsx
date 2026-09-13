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

  it("keeps teaching subheadings below the page and section headings", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { nestedHeadings: true, children: "## 为什么先训练\n\n说明训练的作用\n\n### 何时使用\n\n说明适用条件" }));
    expect(html).toContain("<h4>为什么先训练</h4>");
    expect(html).toContain("<h5>何时使用</h5>");
    expect(html).not.toContain("<h2>");
  });
});
