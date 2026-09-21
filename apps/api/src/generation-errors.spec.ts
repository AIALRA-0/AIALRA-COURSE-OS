import { describe, expect, it } from "vitest";
import { classifyGenerationFailure, describeGenerationError, shouldAutoRecoverGenerationFailure } from "./generation-errors.js";

describe("generation error classification", () => {
  it("routes content, transport, quota and storage failures to distinct recovery actions", () => {
    expect(classifyGenerationFailure(new Error("TEACHING_EXPLANATION_INVALID:PLAN_EVIDENCE_QUOTE_MISSING:a"))).toMatchObject({ category: "content", phase: "explanation", action: "repair_field" });
    expect(classifyGenerationFailure(new Error("MODEL_PROVIDER_FAILED:429"))).toMatchObject({ category: "provider", action: "retry_stage" });
    expect(classifyGenerationFailure(new Error("MODEL_PROVIDER_INSUFFICIENT_BALANCE"))).toMatchObject({ category: "provider", action: "switch_provider" });
    expect(classifyGenerationFailure(new Error("READWEAVE_DRAFT_READBACK_MISMATCH"))).toMatchObject({ category: "storage", action: "retry_readback" });
  });
  it("preserves the failing teaching phase without exposing details or misreading source IDs as HTTP codes", () => {
    expect(describeGenerationError(new Error("TEACHING_PLAN_INVALID:PLAN_SOURCE_UNASSIGNED:source-401,source-402"))).toMatchObject({ code: "TEACHING_PLAN_INVALID", retryable: false });
  });
  it("marks exhausted provider balance as explicit and non-retryable", () => {
    expect(describeGenerationError(new Error("MODEL_PROVIDER_INSUFFICIENT_BALANCE"))).toEqual({
      code: "PROVIDER_QUOTA_EXHAUSTED",
      retryable: false,
      safeMessage: "模型账户余额或额度已耗尽，请更换有效凭据后继续"
    });
  });

  it("keeps output and teaching-plan repair inside a bounded runtime retry", () => {
    expect(shouldAutoRecoverGenerationFailure(new Error("MODEL_PROVIDER_OUTPUT_JSON_INVALID"), 1, 0.02, 4)).toBe(true);
    expect(shouldAutoRecoverGenerationFailure(new Error("TEACHING_PLAN_INVALID:PLAN_SOURCE_UNASSIGNED:atom-1"), 2, 0.04, 4)).toBe(true);
    expect(shouldAutoRecoverGenerationFailure(new Error("TEACHING_PLAN_INVALID:PLAN_SOURCE_UNASSIGNED:atom-1"), 3, 0.04, 4)).toBe(false);
    expect(shouldAutoRecoverGenerationFailure(new Error("PROVIDER_AUTH"), 1, 0, 4)).toBe(false);
  });
  it("keeps a rejected provider request distinct from an internal failure", () => {
    expect(describeGenerationError(new Error("MODEL_PROVIDER_FAILED:invalid_request_error"))).toEqual({
      code: "PROVIDER_INVALID_REQUEST",
      retryable: false,
      safeMessage: "模型服务拒绝了生成请求，请检查当前提示词和输出结构"
    });
  });
});
