import { describe, expect, it } from "vitest";
import { workerDispatchHeaders } from "./dispatch.js";

describe("worker dispatch", () => {
  it("preserves the job workspace when dispatching a queued task", () => {
    expect(workerDispatchHeaders("worker-token", "regression-workspace")).toEqual({
      "X-Course-Worker-Token": "worker-token",
      "X-Workspace-Id": "regression-workspace"
    });
  });

  it("keeps compatibility with older jobs without a workspace id", () => {
    expect(workerDispatchHeaders("worker-token", "")["X-Workspace-Id"]).toBe("personal");
  });
});
