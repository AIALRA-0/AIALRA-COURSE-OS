import { describe, expect, it } from "vitest";
import { defaultCourseModelProviders, defaultCourseModelRoutePolicy, mergeCourseModelProviderDefaults, mergeCourseModelRoutePolicyDefaults } from "./provider-settings.js";

describe("Course OS native model provider defaults", () => {
  it("registers Kimi Coding as a disabled vault-managed Chat Completions provider", () => {
    const provider = defaultCourseModelProviders().find((item) => item.id === "kimi-coding");

    expect(provider).toMatchObject({
      id: "kimi-coding",
      displayName: "Kimi Coding",
      baseUrl: "https://api.kimi.com/coding/v1",
      enabled: false,
      credential: { configured: false },
      vault: { backend: "course_os_vault", state: "missing" }
    });
    expect(provider?.models).toEqual([
      {
        id: "kimi-for-coding-highspeed",
        displayName: "Kimi For Coding Highspeed",
        protocol: "chat_completions",
        supportsVision: false,
        supportsJsonSchema: false,
        supportsReasoning: true,
        billingMode: "metered"
      }
    ]);
  });

  it("adds Kimi Coding to saved provider settings without changing existing providers", () => {
    const saved = defaultCourseModelProviders().filter((item) => item.id !== "kimi-coding");
    const merged = mergeCourseModelProviderDefaults(saved);

    expect(merged.map((item) => item.id)).toContain("kimi-coding");
    expect(merged.find((item) => item.id === "kimi-coding")).toMatchObject({ enabled: false, baseUrl: "https://api.kimi.com/coding/v1" });
    expect(merged.find((item) => item.id === "deepseek")?.baseUrl).toBe("https://api.deepseek.com");
  });

  it("registers only the five supported model suppliers in the default priority order", () => {
    expect(defaultCourseModelProviders().map((provider) => provider.id)).toEqual([
      "opencode-go", "deepseek", "kuafu", "codex", "kimi-coding"
    ]);
    expect(defaultCourseModelRoutePolicy().routes?.map((route) => route.providerId)).toEqual([
      "kuafu", "opencode-go", "deepseek", "codex", "kimi-coding"
    ]);
  });

  it("upgrades an older per-stage policy with the ordered provider chain", () => {
    const legacy = { ...defaultCourseModelRoutePolicy(), routes: undefined, allowProviderFallback: false };
    const merged = mergeCourseModelRoutePolicyDefaults(legacy);
    expect(merged.routes?.map((route) => route.providerId)).toEqual(["kuafu", "opencode-go", "deepseek", "codex", "kimi-coding"]);
    expect(merged.allowProviderFallback).toBe(true);
  });

  it("migrates the retired official DeepSeek vision experiment route to the live flash model", () => {
    const saved = defaultCourseModelRoutePolicy();
    saved.routes = saved.routes?.map((route) => route.providerId === "deepseek"
      ? { ...route, modelId: "deepseek-v4-flash-vision-exp" }
      : route);
    expect(mergeCourseModelRoutePolicyDefaults(saved).routes?.find((route) => route.providerId === "deepseek")?.modelId).toBe("deepseek-flash");
  });

  it("removes the retired ambiguous emergency provider from persisted settings", () => {
    const saved = [...defaultCourseModelProviders(), { id: "aialra-router", displayName: "legacy", baseUrl: "", enabled: false, credential: { configured: false }, models: [] }];
    expect(mergeCourseModelProviderDefaults(saved).some((provider) => provider.id === "aialra-router")).toBe(false);
  });
});
