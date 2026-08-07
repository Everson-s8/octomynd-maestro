import { describe, expect, it } from "vitest";
import { remediationHint, withRemediation } from "../src/agents/remediation.js";

describe("provider remediation hints", () => {
  it("tells codex users the exact install and login commands when offline", () => {
    expect(remediationHint("codex", "offline")).toBe(
      'Instale com "npm install -g @openai/codex" e depois autentique com "codex login".'
    );
  });

  it("tells codex users to authenticate when auth is required", () => {
    expect(remediationHint("codex", "auth_required")).toBe('Autentique com "codex login".');
  });

  it("tells claude users the exact install and login commands when offline", () => {
    expect(remediationHint("claude", "offline")).toBe(
      'Instale com "npm install -g @anthropic-ai/claude-code" e depois autentique com "claude login".'
    );
  });

  it("tells claude users to authenticate when auth is required", () => {
    expect(remediationHint("claude", "auth_required")).toBe('Autentique com "claude login".');
  });

  it("tells users to wait out a quota window for either provider", () => {
    expect(remediationHint("codex", "quota")).toContain("cota do provider");
    expect(remediationHint("claude", "quota")).toContain("cota do provider");
  });

  it("has no remediation hint when a provider is ready", () => {
    expect(remediationHint("codex", "ready")).toBeNull();
    expect(remediationHint("claude", "ready")).toBeNull();
  });

  it("does not fabricate remediation for providers without known install/login commands", () => {
    expect(remediationHint("antigravity", "offline")).toBeNull();
  });

  it("appends the hint to the base detail without altering it when there is nothing to add", () => {
    expect(withRemediation("codex", "auth_required", "Codex (planning): autenticacao necessaria."))
      .toBe('Codex (planning): autenticacao necessaria. Autentique com "codex login".');
    expect(withRemediation("codex", "ready", "Codex CLI disponivel")).toBe("Codex CLI disponivel");
  });
});
