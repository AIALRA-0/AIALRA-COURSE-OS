import type { ModelProviderConfig, ModelRoutePolicy } from "@course-os/contracts";

export function defaultCourseModelProviders(): ModelProviderConfig[] {
  return [
    { id: "opencode-go", displayName: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go/v1", enabled: true, credential: { configured: false }, models: [
      { id: "gpt-5.6-luna", displayName: "GPT 5.6 Luna", protocol: "responses", supportsVision: true, supportsJsonSchema: true, supportsReasoning: true, billingMode: "subscription_quota" },
      { id: "qwen3.8-flash", displayName: "Qwen 3.8 Flash", protocol: "messages", supportsVision: false, supportsJsonSchema: false, supportsReasoning: true, billingMode: "subscription_quota" },
      { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", protocol: "chat_completions", supportsVision: false, supportsJsonSchema: false, supportsReasoning: true, billingMode: "subscription_quota" },
      { id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", protocol: "chat_completions", supportsVision: false, supportsJsonSchema: false, supportsReasoning: true, billingMode: "subscription_quota" },
      { id: "deepseek-v4-flash-vision-exp", displayName: "DeepSeek V4 Flash Vision Exp", protocol: "chat_completions", supportsVision: true, supportsJsonSchema: false, supportsReasoning: true, billingMode: "subscription_quota" }
    ] },
    { id: "deepseek", displayName: "DeepSeek API", baseUrl: "https://api.deepseek.com", enabled: true, credential: { configured: false }, models: [
      { id: "deepseek-flash", displayName: "DeepSeek Flash", protocol: "responses", supportsVision: true, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" },
      { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", protocol: "responses", supportsVision: false, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" },
      { id: "deepseek-v4-flash-vision-exp", displayName: "DeepSeek V4 Flash Vision Exp", protocol: "responses", supportsVision: true, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" },
      { id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", protocol: "responses", supportsVision: false, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" }
    ] },
    { id: "kuafu", displayName: "夸父社 V4.1 专线", baseUrl: "https://api.kuafushe.cc/v1", enabled: false, credential: { configured: false },
      vault: { backend: "course_os_vault", state: "missing" }, models: [
        { id: "deepseek-v4.1-flash", displayName: "DeepSeek V4.1 Flash", protocol: "responses", supportsVision: false, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" }
      ] },
    { id: "codex", displayName: "Codex", baseUrl: "", enabled: false, credential: { configured: false },
      vault: { backend: "course_os_vault", state: "missing" }, models: [
        { id: "gpt-5.6-luna", displayName: "GPT 5.6 Luna", protocol: "responses", supportsVision: true, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" },
        { id: "gpt-5.6-terra", displayName: "GPT 5.6 Terra", protocol: "responses", supportsVision: true, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" },
        { id: "gpt-5.6-sol", displayName: "GPT 5.6 Sol", protocol: "responses", supportsVision: true, supportsJsonSchema: true, supportsReasoning: true, billingMode: "metered" }
      ] },
    { id: "kimi-coding", displayName: "Kimi Coding", baseUrl: "https://api.kimi.com/coding/v1", enabled: false, credential: { configured: false },
      vault: { backend: "course_os_vault", state: "missing" }, models: [
        { id: "kimi-for-coding-highspeed", displayName: "Kimi For Coding Highspeed", protocol: "chat_completions", supportsVision: false, supportsJsonSchema: false, supportsReasoning: true, billingMode: "metered" }
      ] },
  ];
}

export function mergeCourseModelProviderDefaults(saved: ModelProviderConfig[]): ModelProviderConfig[] {
  const providers = saved.filter(item => item.id !== "aialra-router").map(item => structuredClone(item));
  const ids = new Set(providers.map(item => item.id));
  for (const item of defaultCourseModelProviders()) if (!ids.has(item.id)) providers.push(structuredClone(item));
  return providers;
}

export function mergeCourseModelRoutePolicyDefaults(saved?: ModelRoutePolicy): ModelRoutePolicy {
  const defaults = defaultCourseModelRoutePolicy(saved?.workspaceId || "personal");
  if (!saved || !Array.isArray(saved.rules)) return defaults;
  return {
    ...structuredClone(saved),
    routes: Array.isArray(saved.routes) && saved.routes.length > 0
      ? structuredClone(saved.routes)
      : structuredClone(defaults.routes),
    allowProviderFallback: Array.isArray(saved.routes) && saved.routes.length > 0
      ? saved.allowProviderFallback ?? defaults.allowProviderFallback
      : defaults.allowProviderFallback
  };
}

export function defaultCourseModelRoutePolicy(workspaceId = "personal"): ModelRoutePolicy {
  return {
    workspaceId,
    routes: [
      { providerId: "kuafu", modelId: "deepseek-v4.1-flash", enabled: true },
      { providerId: "opencode-go", modelId: "deepseek-v4-flash-vision-exp", enabled: true },
      { providerId: "deepseek", modelId: "deepseek-v4-flash-vision-exp", enabled: true },
      { providerId: "codex", modelId: "gpt-5.6-luna", enabled: true },
      { providerId: "kimi-coding", modelId: "kimi-for-coding-highspeed", enabled: true }
    ],
    allowProviderFallback: true,
    allowAialraEmergencyFallback: false,
    updatedAt: new Date(0).toISOString(),
    rules: (["extract", "atomize", "teach", "review", "repair", "semantic_audit", "question_refill", "qa"] as const)
      .map(stage => ({ stage, providerId: "deepseek", modelId: "deepseek-flash", enabled: true }))
  };
}
