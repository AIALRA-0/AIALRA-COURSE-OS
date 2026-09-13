import { describe, expect, it } from "vitest";
import { describeGenerationError } from "./generation-errors.js";

describe("generation error classification", () => {
  it("marks exhausted provider balance as explicit and non-retryable", () => {
    expect(describeGenerationError(new Error("MODEL_PROVIDER_INSUFFICIENT_BALANCE"))).toEqual({
      code: "PROVIDER_QUOTA_EXHAUSTED",
      retryable: false,
      safeMessage: "模型账户余额或额度已耗尽，请更换有效凭据后继续"
    });
  });
  it("keeps a rejected provider request distinct from an internal failure", () => {
    expect(describeGenerationError(new Error("MODEL_PROVIDER_FAILED:invalid_request_error"))).toEqual({
      code: "PROVIDER_INVALID_REQUEST",
      retryable: false,
      safeMessage: "模型服务拒绝了生成请求，请检查当前提示词和输出结构"
    });
  });
});
