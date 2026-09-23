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
    expect(markup).not.toContain("掌握地图暂时不可用");
  });
});
