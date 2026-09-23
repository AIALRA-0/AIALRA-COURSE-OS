import { describe, expect, it } from "vitest";
import type { ModelProviderConfig, ModelRoutePolicy } from "@course-os/contracts";
import { addModelProvider, addModelRoute, moveModelRoute, removeModelProvider, removeModelRoute, updateModelProvider, updateModelRoute } from "./settings-routes.js";

const providers: ModelProviderConfig[] = ["first", "second", "third"].map((id) => ({
  id, displayName: id, baseUrl: "https://example.test", enabled: true,
  credential: { configured: false }, models: [{ id: `${id}-model`, displayName: id, protocol: "responses", supportsVision: true, supportsJsonSchema: true, supportsReasoning: false, billingMode: "metered" }]
}));
const policy: ModelRoutePolicy = {
  workspaceId: "personal", updatedAt: "2026-01-01T00:00:00.000Z", allowAialraEmergencyFallback: false,
  allowProviderFallback: true, rules: [{ stage: "teach", providerId: "first", modelId: "first-model", enabled: true }],
  routes: [{ providerId: "first", modelId: "first-model", enabled: true }]
};

describe("settings route editor", () => {
  it("adds an unused provider without changing stage rules or existing routes", () => {
    const added = addModelRoute(policy, providers);
    expect(added.routes).toEqual([
      { providerId: "first", modelId: "first-model", enabled: true },
      { providerId: "second", modelId: "second-model", enabled: false }
    ]);
    expect(added.rules).toEqual(policy.rules);
    expect(addModelRoute(addModelRoute(added, providers), providers).routes).toHaveLength(3);
  });

  it("removes the selected route and restores per-stage routing when the ordered chain is empty", () => {
    const added = addModelRoute(policy, providers);
    expect(removeModelRoute(added, 0).routes).toEqual([{ providerId: "second", modelId: "second-model", enabled: false }]);
    const withoutLast = removeModelRoute(policy, 0);
    expect(withoutLast.routes).toBeUndefined();
    expect(withoutLast.rules).toEqual(policy.rules);
    expect(removeModelRoute(added, -1)).toBe(added);
  });

  it("keeps the remaining Kuafu route when its peer is deleted", () => {
    const kuafuPolicy: ModelRoutePolicy = {
      ...policy,
      routes: [
        { providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true },
        { providerId: "kuafu-backup", modelId: "deepseek-v4.1-flash-expires-on-0910", enabled: true }
      ]
    };
    expect(removeModelRoute(kuafuPolicy, 1).routes).toEqual([kuafuPolicy.routes![0]]);
  });

  it("edits a valid route, rejects unavailable models and duplicate providers", () => {
    const withSecond = addModelRoute(policy, providers);
    expect(updateModelRoute(withSecond, 1, { modelId: "second-model", enabled: true }, providers).routes?.[1]).toEqual({
      providerId: "second", modelId: "second-model", enabled: true
    });
    expect(updateModelRoute(withSecond, 1, { modelId: "missing" }, providers)).toBe(withSecond);
    expect(updateModelRoute(withSecond, 1, { providerId: "first", modelId: "first-model" }, providers)).toBe(withSecond);
    expect(updateModelRoute(withSecond, 8, { enabled: true }, providers)).toBe(withSecond);
  });

  it("reorders routes without mutating the original policy", () => {
    const withThird = addModelRoute(addModelRoute(policy, providers), providers);
    const moved = moveModelRoute(withThird, 2, -1);
    expect(moved.routes?.map((route) => route.providerId)).toEqual(["first", "third", "second"]);
    expect(withThird.routes?.map((route) => route.providerId)).toEqual(["first", "second", "third"]);
    expect(moveModelRoute(withThird, 0, -1)).toBe(withThird);
    expect(moveModelRoute(withThird, 5, 1)).toBe(withThird);
  });

  it("supports provider list create, update and delete without changing credential status", () => {
    const added = addModelProvider(providers, providers[0]!);
    expect(added).toBe(providers);
    const fourth = { ...providers[0]!, id: "fourth", displayName: "fourth" };
    const created = addModelProvider(providers, fourth);
    expect(created).toHaveLength(4);
    expect(updateModelProvider(created, "fourth", { displayName: "renamed", enabled: false })[3]).toMatchObject({ id: "fourth", displayName: "renamed", enabled: false, credential: fourth.credential });
    expect(removeModelProvider(created, "fourth")).toEqual(providers);
    expect(removeModelProvider(providers, "missing")).toBe(providers);
  });
});
