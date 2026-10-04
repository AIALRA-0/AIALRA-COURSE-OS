import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { protectReadResponse } from "./read-response.js";

describe("read response terminal ownership", () => {
  it("blocks late serialization, headers and socket writes after end or disconnect", () => {
    for (const terminal of ["writableEnded", "destroyed"] as const) {
      const calls = vi.fn();
      const raw = { writableEnded: false, destroyed: false } as unknown as Response;
      for (const method of ["json", "send", "status", "setHeader", "removeHeader", "end", "write"] as const) {
        Object.defineProperty(raw, method, { configurable: true, writable: true, value: calls });
      }
      const late = vi.fn();
      protectReadResponse(raw, late);
      Object.defineProperty(raw, terminal, { value: true });
      raw.setHeader("Content-Type", "application/json");
      raw.status(200).json({ late: true });
      raw.send("late");
      raw.end();
      expect(raw.write("late")).toBe(false);
      expect(calls).not.toHaveBeenCalled();
      expect(late).toHaveBeenCalledExactlyOnceWith("setHeader");
    }
  });

  it("preserves the real response's normal chained methods and arguments", () => {
    const raw = { writableEnded: false, destroyed: false } as unknown as Response;
    const methods = ["json", "send", "status", "setHeader", "removeHeader", "end", "write"] as const;
    const calls = new Map(methods.map(method => [method, vi.fn(function (this: Response) { return this; })]));
    for (const method of methods) Object.defineProperty(raw, method, { configurable: true, writable: true, value: calls.get(method) });
    const late = vi.fn();
    protectReadResponse(raw, late);
    raw.status(200).json({ good: true });
    raw.setHeader("Cache-Control", "private");
    expect(calls.get("json")).toHaveBeenCalledExactlyOnceWith({ good: true });
    expect(calls.get("status")).toHaveBeenCalledExactlyOnceWith(200);
    expect(calls.get("setHeader")).toHaveBeenCalledExactlyOnceWith("Cache-Control", "private");
    expect(late).not.toHaveBeenCalled();
  });
});
