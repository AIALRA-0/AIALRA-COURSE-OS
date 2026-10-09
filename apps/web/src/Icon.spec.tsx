import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Icon, type IconName } from "./Icon.js";

describe("directional icons", () => {
  it.each([
    ["chevronRight", "m8.5 5 7 7-7 7"],
    ["chevronLeft", "m15.5 5-7 7 7 7"],
    ["chevronDown", "m5 8.5 7 7 7-7"],
    ["chevronUp", "m5 15.5 7-7 7 7"]
  ] as const)("renders %s in its named direction without external rotation", (name, path) => {
    const markup = renderToStaticMarkup(createElement(Icon, { name }));
    expect(markup).toContain(`d="${path}"`);
    expect(markup).not.toContain("transform=");
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).toContain('stroke-width="1.6"');
    expect(markup).toContain('aria-hidden="true"');
  });

  it("keeps caller size and classes while preserving the diagnostic name", () => {
    const markup = renderToStaticMarkup(createElement(Icon, { name: "chevronDown" as IconName, width: 24, height: 24, className: "select-arrow" }));
    expect(markup).toContain('width="24" height="24"');
    expect(markup).toContain('class="select-arrow"');
    expect(markup).toContain('data-icon-name="chevronDown"');
  });
});
