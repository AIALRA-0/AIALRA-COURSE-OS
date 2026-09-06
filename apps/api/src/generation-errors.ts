import type { GenerationErrorCode } from "@course-os/contracts";

export interface GenerationErrorDescriptor {
  code: GenerationErrorCode | string;
  retryable: boolean;
  safeMessage: string;
}

const RETRYABLE = new Set(["PROVIDER_TIMEOUT", "PROVIDER_NETWORK_FAILURE", "PROVIDER_RATE_LIMIT", "READWEAVE_UNAVAILABLE"]);

export function describeGenerationError(error: unknown): GenerationErrorDescriptor {
  const raw = error instanceof Error ? error.message : String(error || "INTERNAL_FAILURE");
  const code = normalizeCode(raw);
  return { code, retryable: RETRYABLE.has(code), safeMessage: safeMessage(code) };
}

function normalizeCode(raw: string): string {
  if (raw.includes("401") || raw.includes("403") || raw.includes("AUTH")) return "PROVIDER_AUTH";
  if (raw.includes("429") || raw.includes("RATE_LIMIT")) return "PROVIDER_RATE_LIMIT";
  if (raw.includes("TIMEOUT")) return "PROVIDER_TIMEOUT";
  if (raw.includes("NETWORK")) return "PROVIDER_NETWORK_FAILURE";
  if (raw.includes("READWEAVE") && raw.includes("MISMATCH")) return "READWEAVE_HASH_MISMATCH";
  if (raw.includes("READWEAVE")) return "READWEAVE_UNAVAILABLE";
  if (raw.includes("JSON") || raw.includes("OUTPUT")) return "MODEL_INVALID_OUTPUT";
  if (raw.includes("MATH")) return "FORMULA_INVALID";
  if (raw.includes("COVERAGE")) return "COVERAGE_GAP";
  if (/^[A-Z0-9_:-]+$/.test(raw)) return raw.slice(0, 120);
  return "INTERNAL_FAILURE";
}

function safeMessage(code: string): string {
  if (code === "PROVIDER_AUTH") return "模型服务认证失败，请检查供应商凭据";
  if (code === "PROVIDER_RATE_LIMIT") return "模型服务达到限额，请稍后重试";
  if (code === "PROVIDER_TIMEOUT") return "模型服务响应超时，当前页面未完成生成";
  if (code === "READWEAVE_UNAVAILABLE") return "ReadWeave 暂时不可访问，内容尚未保存";
  return "当前页面生成失败，请根据请求编号重试";
}
