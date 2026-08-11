import { describe, expect, it } from "vitest";
import {
  buildFailureSummary,
  classifyFailure,
  isRetryableFailureCategory
} from "../src/agents/failure.js";

describe("provider failure classification", () => {
  it("classifies quota/rate-limit failures", () => {
    expect(classifyFailure("Error: usage limit reached for this account")).toBe("quota");
    expect(classifyFailure("429 Too Many Requests")).toBe("quota");
    expect(classifyFailure("Rate limit exceeded, please retry later")).toBe("quota");
    expect(classifyFailure("You've hit your session limit · resets 5pm (America/Sao_Paulo)")).toBe("quota");
  });

  it("classifies authentication failures", () => {
    expect(classifyFailure("API Error: 401 Invalid authentication credentials")).toBe("auth_required");
    expect(classifyFailure("Not logged in. Please run /login")).toBe("auth_required");
    expect(classifyFailure("login required to continue")).toBe("auth_required");
  });

  it("classifies capacity/overload failures", () => {
    expect(classifyFailure("503 Service Unavailable")).toBe("capacity");
    expect(classifyFailure("Model is currently overloaded, try again later")).toBe("capacity");
    expect(classifyFailure("resource_exhausted: server is busy")).toBe("capacity");
  });

  it("classifies timeouts regardless of captured text", () => {
    expect(classifyFailure("", true)).toBe("timeout");
    expect(classifyFailure("usage limit reached", true)).toBe("timeout");
  });

  it("falls back to unknown for unrecognized failures", () => {
    expect(classifyFailure("Unexpected filesystem failure while writing artifact")).toBe("unknown");
    expect(classifyFailure("")).toBe("unknown");
  });

  it("marks quota, auth and timeout as retryable, but not unknown failures", () => {
    expect(isRetryableFailureCategory("quota")).toBe(true);
    expect(isRetryableFailureCategory("auth_required")).toBe(true);
    expect(isRetryableFailureCategory("timeout")).toBe(true);
    expect(isRetryableFailureCategory("unknown")).toBe(false);
  });

  it("builds a short, structured summary instead of echoing raw provider output", () => {
    expect(buildFailureSummary("Codex", "implementing", "quota"))
      .toBe("Codex (implementing): cota do provedor esgotada.");
    expect(buildFailureSummary("Claude", "reviewing", "auth_required"))
      .toBe("Claude (reviewing): autenticacao necessaria.");
    expect(buildFailureSummary("Codex", "testing", "timeout"))
      .toBe("Codex (testing): tempo limite excedido.");
    expect(buildFailureSummary("Claude", "planning", "unknown"))
      .toBe("Claude (planning): erro desconhecido.");
  });
});
