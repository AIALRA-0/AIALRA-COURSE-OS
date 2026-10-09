import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReviewWorkspace } from "./ReviewWorkspace.js";

describe("ReviewWorkspace without a review map", () => {
  it("opens self-retelling cards immediately while the map loads", () => {
    const markup = renderToStaticMarkup(createElement(ReviewWorkspace, {
      releases: [],
      onOpenPage: vi.fn()
    }));

    expect(markup).toContain("自我重述卡片");
    expect(markup).toContain("返回复习中心");
    expect(markup).toContain('class="self-retelling-review workbench-page study-self-retelling-review" aria-busy="true"');
    expect(markup).toContain('class="self-retelling-review-toolbar workbench-toolbar study-self-retelling-toolbar"');
    expect(markup).toContain('data-action="toggle-all-self-retelling-cards"');
    expect(markup).not.toContain("FLASHCARDS");
    expect(markup).toContain('role="status" aria-live="polite"');
    expect(markup).not.toContain("掌握地图暂时不可用");
  });
});
