import { afterEach, describe, expect, it, vi } from "vitest";
import { readViewPreference, saveViewPreference } from "./view-preferences.js";

afterEach(() => vi.unstubAllGlobals());
describe("optional workspace preferences", () => {
  it("retains saved layout values on reread", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    expect(saveViewPreference("reading-width", "42")).toBe(true);
    expect(readViewPreference("reading-width")).toBe("42");
  });
  it("allows a blocked read or quota failure without interrupting reading", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); } });
    expect(readViewPreference("reading-width")).toBeNull();
    expect(saveViewPreference("reading-width", "42")).toBe(false);
  });
});
