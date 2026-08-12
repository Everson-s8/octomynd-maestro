import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { detectProviders, isGhAvailable, runConfigWizard } from "../src/config/wizard.js";
import { CodexProvider } from "../src/agents/codex.js";
import { ClaudeProvider } from "../src/agents/claude.js";
import { AntigravityProvider } from "../src/agents/antigravity.js";
import { AgentRegistry } from "../src/agents/registry.js";
import { buildRestrictedAgentEnvironment } from "../src/agents/process.js";
import type { AgentCapability } from "../src/agents/types.js";

const GOAL_CAPABILITIES: AgentCapability[] = [
  "planning",
  "coding",
  "testing",
  "reviewing",
  "improvement_reviewing",
  "research"
];

describe("Task #74 - Single-Provider & Wizard Onboarding", () => {
  it("detects available providers and generates .env cleanly", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-wizard-test-"));
    try {
      const result = runConfigWizard({ cwd: tmpDir, env: {} });
      expect(result.envPath).toBe(path.join(tmpDir, ".env"));
      expect(fs.existsSync(result.envPath)).toBe(true);
      expect(result.summary).toContain("Octomynd Maestro Configuration Wizard");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 20000);

  it("does not fail when gh CLI is missing or checked", () => {
    const available = isGhAvailable();
    expect(typeof available).toBe("boolean");
  }, 20_000);

  it("routes all capabilities when ONLY Codex is available", async () => {
    const codex = new CodexProvider();
    codex.health = async () => ({
      state: "ready",
      detail: "Codex ready for test",
      checkedAt: new Date().toISOString()
    });

    const claude = new ClaudeProvider();
    claude.health = async () => ({
      state: "offline",
      detail: "Claude offline",
      checkedAt: new Date().toISOString()
    });

    const antigravity = new AntigravityProvider({ healthProbe: false });
    antigravity.health = async () => ({
      state: "offline",
      detail: "Antigravity offline",
      checkedAt: new Date().toISOString()
    });

    const registry = new AgentRegistry([codex, claude, antigravity]);

    for (const cap of GOAL_CAPABILITIES) {
      const routed = await registry.route(cap);
      expect(routed).not.toBeNull();
      expect(routed?.provider.id).toBe("codex");
    }
  });

  it("routes all capabilities when ONLY Claude is available", async () => {
    const codex = new CodexProvider();
    codex.health = async () => ({
      state: "offline",
      detail: "Codex offline",
      checkedAt: new Date().toISOString()
    });

    const claude = new ClaudeProvider();
    claude.health = async () => ({
      state: "ready",
      detail: "Claude ready for test",
      checkedAt: new Date().toISOString()
    });

    const antigravity = new AntigravityProvider({ healthProbe: false });
    antigravity.health = async () => ({
      state: "offline",
      detail: "Antigravity offline",
      checkedAt: new Date().toISOString()
    });

    const registry = new AgentRegistry([codex, claude, antigravity]);

    for (const cap of GOAL_CAPABILITIES) {
      const routed = await registry.route(cap);
      expect(routed).not.toBeNull();
      expect(routed?.provider.id).toBe("claude");
    }
  });

  it("routes all capabilities when ONLY Antigravity is available", async () => {
    const codex = new CodexProvider();
    codex.health = async () => ({
      state: "offline",
      detail: "Codex offline",
      checkedAt: new Date().toISOString()
    });

    const claude = new ClaudeProvider();
    claude.health = async () => ({
      state: "offline",
      detail: "Claude offline",
      checkedAt: new Date().toISOString()
    });

    const antigravity = new AntigravityProvider({ healthProbe: false });
    antigravity.health = async () => ({
      state: "ready",
      detail: "Antigravity ready for test",
      checkedAt: new Date().toISOString()
    });

    const registry = new AgentRegistry([codex, claude, antigravity]);

    for (const cap of GOAL_CAPABILITIES) {
      const routed = await registry.route(cap);
      expect(routed).not.toBeNull();
      expect(routed?.provider.id).toBe("antigravity");
    }
  });

  it("supports ENV overrides for provider API keys", async () => {
    const mockEnv = {
      OPENAI_API_KEY: "sk-test-openai",
      CLAUDE_API_KEY: "sk-test-claude",
      GEMINI_API_KEY: "AIzaTestGemini"
    };

    const restricted = buildRestrictedAgentEnvironment(mockEnv, { allowProviderKeys: true });
    expect(restricted.OPENAI_API_KEY).toBe("sk-test-openai");
    expect(restricted.CLAUDE_API_KEY).toBe("sk-test-claude");
    expect(restricted.GEMINI_API_KEY).toBe("AIzaTestGemini");
    expect(restricted.OPENAI_API_KEY).toBe("sk-test-openai");
    expect(restricted.CLAUDE_API_KEY).toBe("sk-test-claude");
    expect(restricted.GEMINI_API_KEY).toBe("AIzaTestGemini");

    const detected = detectProviders(mockEnv);
    expect(detected.find((p) => p.id === "codex")?.available).toBe(true);
    expect(detected.find((p) => p.id === "claude")?.available).toBe(true);
    expect(detected.find((p) => p.id === "antigravity")?.available).toBe(true);
  });
});
