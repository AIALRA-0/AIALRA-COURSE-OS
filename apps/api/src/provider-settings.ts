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
    { id: "aialra-router", displayName: "AIALRA Model Router", baseUrl: "", enabled: false, credential: { configured: false }, models: [] }
  ];
}

export function mergeCourseModelProviderDefaults(saved: ModelProviderConfig[]): ModelProviderConfig[] {
  const providers = saved.map(item => structuredClone(item));
  const ids = new Set(providers.map(item => item.id));
  for (const item of defaultCourseModelProviders()) if (!ids.has(item.id)) providers.push(structuredClone(item));
  return providers;
}

export function defaultCourseModelRoutePolicy(workspaceId = "personal"): ModelRoutePolicy {
  return {
    workspaceId,
    allowProviderFallback: false,
    allowAialraEmergencyFallback: false,
    updatedAt: new Date(0).toISOString(),
    rules: (["extract", "atomize", "teach", "review", "repair", "semantic_audit", "question_refill", "qa"] as const)
      .map(stage => ({ stage, providerId: "deepseek", modelId: "deepseek-flash", enabled: true }))
  };
}
