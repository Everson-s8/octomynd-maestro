import { describe, expect, it } from "vitest";
import {
  buildFailureSummary,
  classifyFailure,
  isRetryableFailureCategory,
  FailureCategory
} from "../src/agents/failure.js";

describe("provider failure classification", () => {
  it("classifies quota/rate-limit failures", () => {
    expect(classifyFailure("Error: usage limit reached for this account")).toBe("quota");
    expect(classifyFailure("429 Too Many Requests")).toBe("quota");
    expect(classifyFailure("Rate limit exceeded, please retry later")).toBe("quota");
    expect(classifyFailure("You've hit your session limit · resets 5pm (America/Sao_Paulo)")).toBe("quota");
    expect(classifyFailure("", { jsonError: { code: "quota_exceeded" } })).toBe("quota");
    expect(classifyFailure("", { jsonError: { status: 429 } })).toBe("quota");
  });

  it("classifies authentication failures", () => {
    expect(classifyFailure("API Error: 401 Invalid authentication credentials")).toBe("auth_required");
    expect(classifyFailure("Not logged in. Please run /login")).toBe("auth_required");
    expect(classifyFailure("login required to continue")).toBe("auth_required");
    expect(classifyFailure("", { jsonError: { status: 401 } })).toBe("auth_required");
  });

  it("classifies timeouts regardless of captured text", () => {
    expect(classifyFailure("", true)).toBe("timeout");
    expect(classifyFailure("usage limit reached", true)).toBe("timeout");
    expect(classifyFailure("", { timedOut: true })).toBe("timeout");
    expect(classifyFailure("", { breakerReason: "inactivity" })).toBe("timeout");
    expect(classifyFailure("", { breakerReason: "phase_timeout" })).toBe("timeout");
    expect(classifyFailure("", { breakerReason: "deadline" })).toBe("timeout");
  });

  it("classifies output limit failures", () => {
    expect(classifyFailure("", { breakerReason: "output_limit" })).toBe("output_limit");
    expect(classifyFailure("", { breakerReason: "duplicate_output" })).toBe("output_limit");
    expect(classifyFailure("Output limit exceeded for provider response")).toBe("output_limit");
  });

  it("classifies permission denied failures", () => {
    expect(classifyFailure("", { spawnErrorCode: "EACCES" })).toBe("permission_denied");
    expect(classifyFailure("", { exitCode: 126 })).toBe("permission_denied");
    expect(classifyFailure("Permission denied when accessing worktree")).toBe("permission_denied");
  });

  it("classifies environment errors (ENOENT, cannot find module)", () => {
    expect(classifyFailure("", { spawnErrorCode: "ENOENT" })).toBe("environment_error");
    expect(classifyFailure("", { exitCode: 127 })).toBe("environment_error");
    expect(classifyFailure("Cannot find module './foo'")).toBe("environment_error");
    expect(classifyFailure("enoent: no such file or directory")).toBe("environment_error");
    expect(classifyFailure("ERR_ENVIRONMENT: Missing tool dependency")).toBe("environment_error");
  });

  it("classifies invalid output failures", () => {
    expect(classifyFailure("", { jsonError: { code: "invalid_output" } })).toBe("invalid_output");
    expect(classifyFailure("Codex retornou saida invalida: unexpected end of JSON input")).toBe("invalid_output");
  });

  it("classifies user cancelled failures", () => {
    expect(classifyFailure("", { aborted: true })).toBe("user_cancelled");
    expect(classifyFailure("Execution cancelled by user")).toBe("user_cancelled");
  });

  it("classifies offline and capacity failures via regex", () => {
    expect(classifyFailure("connection refused to server")).toBe("offline");
    expect(classifyFailure("network is unreachable")).toBe("offline");
    expect(classifyFailure("no provider available")).toBe("capacity");
  });

  it("falls back to unknown for unrecognized failures", () => {
    expect(classifyFailure("Unexpected filesystem failure while writing artifact")).toBe("unknown");
    expect(classifyFailure("")).toBe("unknown");
  });

  it("Layer 1 structural signals take precedence over text regex matching", () => {
    // Text mentions rate limit, but process was aborted by user structurally
    expect(classifyFailure("rate limit exceeded", { aborted: true })).toBe("user_cancelled");
    // Text mentions connection refused, but process hit output_limit breaker
    expect(classifyFailure("connection refused", { breakerReason: "output_limit" })).toBe("output_limit");
    // Text mentions 401 unauthorized, but spawn code is ENOENT
    expect(classifyFailure("401 unauthorized", { spawnErrorCode: "ENOENT" })).toBe("environment_error");
  });

  it("enforces explicit retryability rules across all 11 categories", () => {
    const retryableList: FailureCategory[] = ["quota", "auth_required", "timeout", "offline", "capacity"];
    const nonRetryableList: FailureCategory[] = [
      "output_limit",
      "permission_denied",
      "environment_error",
      "invalid_output",
      "user_cancelled",
      "unknown"
    ];

    for (const cat of retryableList) {
      expect(isRetryableFailureCategory(cat)).toBe(true);
    }
    for (const cat of nonRetryableList) {
      expect(isRetryableFailureCategory(cat)).toBe(false);
    }
  });

  it("verifies enoent and cannot-find-module are classified as environment_error and NOT retryable", () => {
    const cat1 = classifyFailure("cannot find module '@anthropic-ai/claude-code'");
    const cat2 = classifyFailure("spawn agy ENOENT");

    expect(cat1).toBe("environment_error");
    expect(cat2).toBe("environment_error");
    expect(isRetryableFailureCategory(cat1)).toBe(false);
    expect(isRetryableFailureCategory(cat2)).toBe(false);
  });

  it("builds a short, structured summary instead of echoing raw provider output", () => {
    expect(buildFailureSummary("Codex", "implementing", "quota"))
      .toBe("Codex (implementing): cota do provedor esgotada.");
    expect(buildFailureSummary("Claude", "reviewing", "auth_required"))
      .toBe("Claude (reviewing): autenticacao necessaria.");
    expect(buildFailureSummary("Codex", "testing", "timeout"))
      .toBe("Codex (testing): tempo limite excedido.");
    expect(buildFailureSummary("Gemini", "planning", "environment_error"))
      .toBe("Gemini (planning): erro de ambiente.");
    expect(buildFailureSummary("Claude", "planning", "unknown"))
      .toBe("Claude (planning): erro desconhecido.");
  });
});
