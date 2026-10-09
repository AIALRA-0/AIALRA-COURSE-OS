import { describe, expect, it } from "vitest";
import { normalizeSourceWidth, sidebarWidthLimit, sourceWidthLimit } from "./reading-layout.js";

describe("reading panel width preferences", () => {
  it("migrates the old auto-saved default while preserving custom source widths", () => {
    for (const value of [null, "NaN", "200", "272"]) expect(normalizeSourceWidth(value)).toBe(480);
    expect(normalizeSourceWidth("320")).toBe(320);
    expect(normalizeSourceWidth("980")).toBe(980);
    expect(normalizeSourceWidth("1400")).toBe(1040);
  });

  it("reserves readable content space when both sidebars are expanded", () => {
    expect(sidebarWidthLimit(1440)).toBe(640);
    expect(sidebarWidthLimit(1000)).toBe(292);
    expect(sourceWidthLimit(1440)).toBe(1040);
    expect(sourceWidthLimit(800)).toBe(424);
    expect(sourceWidthLimit(580)).toBe(220);
  });
});
