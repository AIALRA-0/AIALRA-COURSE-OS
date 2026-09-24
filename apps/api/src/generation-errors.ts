import type { GenerationErrorCode } from "@course-os/contracts";

export interface GenerationErrorDescriptor {
  code: GenerationErrorCode | string;
  retryable: boolean;
  safeMessage: string;
}

export interface GenerationFailureRoute {
  category: "provider" | "output" | "content" | "storage" | "configuration" | "internal";
  action: "switch_provider" | "retry_stage" | "repair_field" | "retry_readback" | "hold_source" | "pause";
  code: string;
}

/** Safe, finite recovery classification for persisted events and automation. */
export function classifyGenerationFailure(error: unknown): GenerationFailureRoute {
  const code = describeGenerationError(error).code;
  if (code === "PROVIDER_QUOTA_EXHAUSTED") return { category: "provider", action: "switch_provider", code };
  if (["PROVIDER_TIMEOUT", "PROVIDER_NETWORK_FAILURE", "PROVIDER_RATE_LIMIT"].includes(code)) return { category: "provider", action: "retry_stage", code };
  if (code === "READWEAVE_UNAVAILABLE" || code === "READWEAVE_HASH_MISMATCH") return { category: "storage", action: "retry_readback", code };
  if (code === "LEASE_LOST") return { category: "internal", action: "retry_stage", code };
  if (code === "GENERATION_REPAIR_SCOPE_INVALID" || code === "FORMULA_INVALID" || code === "COVERAGE_GAP") return { category: "content", action: "pause", code };
  if (code === "MODEL_INVALID_OUTPUT" || code === "MODEL_OUTPUT_LIMIT") return { category: "output", action: "pause", code };
  if (code.startsWith("BLUEPRINT_") || code.includes("SOURCE_")) return { category: "content", action: "hold_source", code };
  if (code === "PROVIDER_AUTH" || code === "PROVIDER_INVALID_REQUEST" || code.includes("CHECKPOINT_MISMATCH")) return { category: "configuration", action: "pause", code };
  return { category: "internal", action: "pause", code };
}

/** Retry only transport failures; a malformed final package gets its one local format repair. */
export function shouldAutoRecoverGenerationFailure(
  error: unknown,
  attempt: number,
  spentUsd: number,
  budgetUsd: number,
  maxAttempts = 3
): boolean {
  if (attempt >= Math.max(1, maxAttempts) || spentUsd >= budgetUsd) return false;
  const route = classifyGenerationFailure(error);
  return route.category === "provider" && route.action === "retry_stage";
}

const RETRYABLE = new Set(["PROVIDER_TIMEOUT", "PROVIDER_NETWORK_FAILURE", "PROVIDER_RATE_LIMIT", "READWEAVE_UNAVAILABLE"]);

export function describeGenerationError(error: unknown): GenerationErrorDescriptor {
  const raw = error instanceof Error ? error.message : String(error || "INTERNAL_FAILURE");
  const code = normalizeCode(raw);
  return { code, retryable: RETRYABLE.has(code), safeMessage: safeMessage(code) };
}

function normalizeCode(raw: string): string {
  const teachingPhase = /^(TEACHING_(?:PLAN|OPENING|EXPLANATION|CONSOLIDATION)_INVALID)(?::|$)/u.exec(raw)?.[1];
  if (teachingPhase) return teachingPhase;
  if (raw.includes("READWEAVE") && raw.includes("MISMATCH")) return "READWEAVE_HASH_MISMATCH";
  if (raw.includes("READWEAVE")) return "READWEAVE_UNAVAILABLE";
  if (raw.includes("INSUFFICIENT_BALANCE") || raw.includes("QUOTA_EXHAUSTED") || raw.includes("402")) return "PROVIDER_QUOTA_EXHAUSTED";
  if (raw.includes("401") || raw.includes("403") || raw.includes("AUTH")) return "PROVIDER_AUTH";
  if (raw.includes("429") || raw.includes("RATE_LIMIT")) return "PROVIDER_RATE_LIMIT";
  if (raw.includes("TIMEOUT")) return "PROVIDER_TIMEOUT";
  if (raw.includes("NETWORK") || /MODEL_PROVIDER_FAILED:(?:upstream_error|response_failed|5\d\d)/iu.test(raw)) return "PROVIDER_NETWORK_FAILURE";
  if (raw.includes("invalid_request_error") || raw.includes("MODEL_PROVIDER_FAILED:400")) return "PROVIDER_INVALID_REQUEST";
  if (raw.includes("MODEL_PROVIDER_OUTPUT_LIMIT")) return "MODEL_OUTPUT_LIMIT";
  if (raw.includes("JSON") || raw.includes("OUTPUT") || raw.includes("MODEL_PROVIDER_INVALID_RESPONSE")) return "MODEL_INVALID_OUTPUT";
  if (raw.includes("MATH")) return "FORMULA_INVALID";
  if (raw.includes("COVERAGE")) return "COVERAGE_GAP";
  if (/^[A-Z0-9_:-]+$/.test(raw)) return raw.slice(0, 120);
  return "INTERNAL_FAILURE";
}

function safeMessage(code: string): string {
  if (code === "PROVIDER_QUOTA_EXHAUSTED") return "模型账户余额或额度已耗尽，请更换有效凭据后继续";
  if (code === "PROVIDER_AUTH") return "模型服务认证失败，请检查供应商凭据";
  if (code === "PROVIDER_RATE_LIMIT") return "模型服务达到限额，请稍后重试";
  if (code === "PROVIDER_TIMEOUT") return "模型服务响应超时，当前页面未完成生成";
  if (code === "PROVIDER_INVALID_REQUEST") return "模型服务拒绝了生成请求，请检查当前提示词和输出结构";
  if (code === "READWEAVE_UNAVAILABLE") return "ReadWeave 暂时不可访问，内容尚未保存";
  if (code === "MODEL_OUTPUT_LIMIT") return "模型达到本阶段输出上限，内容不完整，已停止相同请求重试";
  return "当前页面生成失败，请根据请求编号重试";
}
