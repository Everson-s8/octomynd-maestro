import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db.js";
import { CodexProvider } from "../src/agents/codex.js";
import { ClaudeProvider } from "../src/agents/claude.js";
import { CustomCliProvider, buildCustomCliArgs } from "../src/agents/custom-cli.js";
import { AntigravityProvider } from "../src/agents/antigravity.js";
import { AgentExecutionRequest } from "../src/agents/types.js";

describe("provider models configuration and propagation", () => {
  it("CodexProvider returns available models and honors configured model", async () => {
    const codex = new CodexProvider({ model: "gpt-4o" });
    expect(codex.model).toBe("gpt-4o");
    const models = await codex.models();
    expect(models).toContain("gpt-4o");
    expect(models).toContain("o3-mini");
  });

  it("ClaudeProvider returns available models and honors configured model", async () => {
    const claude = new ClaudeProvider({ model: "claude-3-7-sonnet" });
    expect(claude.model).toBe("claude-3-7-sonnet");
    const models = await claude.models();
    expect(models).toContain("claude-3-7-sonnet");
    expect(models).toContain("claude-3-5-sonnet");
  });

  it("AntigravityProvider returns available models", async () => {
    const antigravity = new AntigravityProvider({ model: "gemini-2.5-pro" });
    expect(antigravity.model).toBe("gemini-2.5-pro");
    const models = await antigravity.models();
    expect(models.length).toBeGreaterThan(0);
  }, 15_000);

  it("CustomCliProvider handles model, models list, and args substitution", async () => {
    const custom = new CustomCliProvider({
      id: "my-llm",
      label: "My LLM",
      command: "my-cli",
      model: "default-model",
      models: ["default-model", "faster-model"],
      capabilities: ["coding"]
    });

    expect(custom.model).toBe("default-model");
    expect(await custom.models()).toEqual(["default-model", "faster-model"]);

    const request: AgentExecutionRequest = {
      runId: 1,
      stepNumber: 1,
      phase: "implementing",
      capability: "coding",
      task: {
        id: 10,
        title: "Test task",
        worktreePath: process.cwd()
      } as any,
      project: {
        id: 1,
        path: process.cwd()
      } as any,
      previousSteps: [],
      artifactsRoot: process.cwd(),
      model: "faster-model"
    };

    // Test with template args {model}
    const templateArgs = buildCustomCliArgs(
      request,
      {
        id: "my-llm",
        label: "My LLM",
        command: "my-cli",
        args: ["--run", "{prompt}", "--model-flag", "{model}"],
        capabilities: ["coding"]
      },
      undefined,
      request.model
    );
    expect(templateArgs).toContain("--model-flag");
    expect(templateArgs).toContain("faster-model");

    // Test default flags appending --model
    const defaultArgs = buildCustomCliArgs(
      request,
      {
        id: "my-llm",
        label: "My LLM",
        command: "my-cli",
        capabilities: ["coding"]
      },
      undefined,
      request.model
    );
    expect(defaultArgs).toContain("--model");
    expect(defaultArgs).toContain("faster-model");
  });

  it("persists and retrieves provider controls model and capability routing preferred model in SQLite", () => {
    const db = createDatabase(":memory:");
    const persistence = db;

    // Initial snapshot should have empty controls and null preferredModel
    let snapshot = persistence.getProviderPolicySnapshot();
    expect(snapshot.controls).toEqual([]);
    expect(snapshot.capabilities.find((c) => c.capability === "coding")?.preferredModel).toBeNull();

    // Update provider control with a model
    persistence.updateProviderControl({
      providerId: "codex",
      mode: "enabled",
      fallbackEnabled: true,
      model: "o1"
    });

    // Update capability routing with a preferred model
    persistence.updateCapabilityRouting({
      capability: "coding",
      order: ["codex", "claude", "antigravity"],
      requiredProviderId: "codex",
      preferredModel: "o3-mini"
    });

    snapshot = persistence.getProviderPolicySnapshot();
    const codexControl = snapshot.controls.find((c) => c.providerId === "codex");
    expect(codexControl?.model).toBe("o1");

    const codingRouting = snapshot.capabilities.find((c) => c.capability === "coding");
    expect(codingRouting?.preferredModel).toBe("o3-mini");
    expect(codingRouting?.requiredProviderId).toBe("codex");

    // Atomic update of multiple controls
    persistence.updateProviderControls([
      { providerId: "claude", mode: "enabled", fallbackEnabled: false, model: "claude-3-7-sonnet" },
      { providerId: "antigravity", mode: "paused", fallbackEnabled: true, model: "gemini-2.5-flash" }
    ]);

    snapshot = persistence.getProviderPolicySnapshot();
    expect(snapshot.controls.find((c) => c.providerId === "claude")?.model).toBe("claude-3-7-sonnet");
    expect(snapshot.controls.find((c) => c.providerId === "claude")?.fallbackEnabled).toBe(false);
    expect(snapshot.controls.find((c) => c.providerId === "antigravity")?.model).toBe("gemini-2.5-flash");
    expect(snapshot.controls.find((c) => c.providerId === "antigravity")?.mode).toBe("paused");
  });

  it("CodexProvider and ClaudeProvider handle flattened and nested constructor options without losing limits", () => {
    // 1. Flattened options like index.ts passes
    const codexFlat = new CodexProvider({
      maxRuntimeMs: 120_000,
      inactivityTimeoutMs: 45_000,
      model: "gpt-4o"
    });
    expect(codexFlat.model).toBe("gpt-4o");
    expect(codexFlat.executionLimits.maxRuntimeMs).toBe(120_000);
    expect(codexFlat.executionLimits.inactivityTimeoutMs).toBe(45_000);

    const claudeFlat = new ClaudeProvider({
      maxRuntimeMs: 90_000,
      inactivityTimeoutMs: 30_000,
      model: "claude-3-7-sonnet"
    });
    expect(claudeFlat.model).toBe("claude-3-7-sonnet");
    expect(claudeFlat.executionLimits.maxRuntimeMs).toBe(90_000);
    expect(claudeFlat.executionLimits.inactivityTimeoutMs).toBe(30_000);

    // 2. Nested options
    const codexNested = new CodexProvider({
      model: "o1",
      executionLimits: { maxRuntimeMs: 80_000, inactivityTimeoutMs: 20_000 }
    });
    expect(codexNested.model).toBe("o1");
    expect(codexNested.executionLimits.maxRuntimeMs).toBe(80_000);
    expect(codexNested.executionLimits.inactivityTimeoutMs).toBe(20_000);

    // 3. Number timeout
    const codexNumber = new CodexProvider(15_000);
    expect(codexNumber.model).toBeNull();
    expect(codexNumber.executionLimits.inactivityTimeoutMs).toBe(15_000);

    const claudeNumber = new ClaudeProvider(25_000);
    expect(claudeNumber.model).toBeNull();
    expect(claudeNumber.executionLimits.inactivityTimeoutMs).toBe(25_000);
  });
});
