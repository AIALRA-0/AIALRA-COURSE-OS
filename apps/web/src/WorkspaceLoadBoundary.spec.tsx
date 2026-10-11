import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceLoadBoundary } from "./WorkspaceLoadBoundary.js";

describe("workspace load recovery", () => {
  it("leaves successful workspace content intact", () => {
    expect(renderToStaticMarkup(createElement(WorkspaceLoadBoundary, { children: createElement("p", null, "当前页面") }))).toContain("当前页面");
  });

  it("offers explicit recovery without leaking exception details or claiming saved content", () => {
    const boundary = new WorkspaceLoadBoundary({ children: null });
    boundary.state = WorkspaceLoadBoundary.getDerivedStateFromError();
    const html = renderToStaticMarkup(boundary.render());
    expect(html).toContain('role="alert"');
    expect(html).toContain("刷新本页");
    expect(html).toContain("登录过期");
    expect(html).not.toContain("已保存");
    expect(html).not.toContain("返回学习");
  });

  it("offers a learning navigation action only when the parent supplies it", () => {
    const boundary = new WorkspaceLoadBoundary({ children: null, onReturnToLearning: () => undefined });
    boundary.state = WorkspaceLoadBoundary.getDerivedStateFromError();
    expect(renderToStaticMarkup(boundary.render())).toContain("返回学习");
  });
});
