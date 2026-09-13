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
});
