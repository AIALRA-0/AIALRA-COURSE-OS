import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReviewWorkspace } from "./ReviewWorkspace.js";

describe("ReviewWorkspace without a review map", () => {
  it("keeps the self-retelling card entry available", () => {
    const markup = renderToStaticMarkup(createElement(ReviewWorkspace, {
      releases: [],
      onOpenPage: vi.fn()
    }));

    expect(markup).toContain("掌握地图暂时不可用");
    expect(markup).toMatch(/<button\b[^>]*data-action="review-open-self-retelling-cards"[^>]*>打开自我重述卡片<\/button>/);
  });
});
