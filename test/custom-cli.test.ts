import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CustomCliProvider,
  buildCustomCliArgs,
  resolveCustomCliExecutable
} from "../src/agents/custom-cli.js";
import { AgentRegistry } from "../src/agents/registry.js";
import { detectProviders } from "../src/config/wizard.js";
import { buildRestrictedAgentEnvironment } from "../src/agents/process.js";
import type { AgentExecutionRequest, CustomCliProviderConfig } from "../src/agents/types.js";

const tempPaths: string[] = [];

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

describe("CustomCliProvider", () => {
  const baseConfig: CustomCliProviderConfig = {
    id: "opencode",
    label: "OpenCode Go",
    command: "opencode",
    args: ["--model", "opencode-go"],
    envKeys: ["OPENCODE_API_KEY"],
    capabilities: ["planning", "coding", "testing", "reviewing", "research"]
  };

  it("advertises configured capabilities", () => {
    const provider = new CustomCliProvider(baseConfig);
    expect([...provider.capabilities]).toEqual([
      "planning",
      "coding",
      "testing",
      "reviewing",
      "research"
    ]);
    expect(provider.id).toBe("opencode");
    expect(provider.label).toBe("OpenCode Go");
  });

  it("returns health state ready when executable is present", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-custom-cli-"));
    tempPaths.push(tempDir);
    const executable = path.join(tempDir, process.platform === "win32" ? "opencode.exe" : "opencode");
    fs.writeFileSync(executable, "fixture", "utf8");

    const provider = new CustomCliProvider({
      ...baseConfig,
      command: executable
    });

    const health = await provider.health();
    expect(health.state).toBe("ready");
    expect(health.detail).toContain("OpenCode Go CLI disponivel");
  });

  it("returns health offline when env key is present but the CLI is missing", async () => {
    // A custom provider can only execute by spawning command, so an env key
    // alone (without a resolvable CLI) must NOT report ready — reporting ready
    // here misled routing into a guaranteed ENOENT on the next execute().
    const provider = new CustomCliProvider({
      ...baseConfig,
      command: "nonexistent-custom-cmd-12345",
      envKeys: ["CUSTOM_OPENCODE_TEST_KEY"]
    });

    process.env.CUSTOM_OPENCODE_TEST_KEY = "test-secret-value";
    try {
      const health = await provider.health();
      expect(health.state).toBe("offline");
      expect(health.detail).toContain("nao encontrado");
    } finally {
      delete process.env.CUSTOM_OPENCODE_TEST_KEY;
    }
  });

  it("returns health state offline when neither CLI nor env key is present", async () => {
    const provider = new CustomCliProvider({
      ...baseConfig,
      command: "nonexistent-custom-cmd-12345",
      envKeys: ["MISSING_ENV_KEY_XYZ"]
    });

    const health = await provider.health();
    expect(health.state).toBe("offline");
    expect(health.detail).toContain("nao encontrada");
  });

  it("spawns restricted command on execute() and returns AgentExecutionResult", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-custom-exec-"));
    tempPaths.push(tempDir);

    const mockCli = path.join(tempDir, "mock-cli.js");
    fs.writeFileSync(
      mockCli,
      `console.log("OpenCode execution successful for phase:", process.argv[process.argv.length - 1] || "ok");`,
      "utf8"
    );

    const provider = new CustomCliProvider({
      id: "mock-opencode",
      label: "Mock OpenCode",
      command: process.execPath,
      args: [mockCli, "{prompt}"],
      capabilities: ["coding"]
    });

    const req = mockExecutionRequest("implementing", "coding", tempDir);
    const res = await provider.execute(req);

    expect(res.outcome).toBe("completed");
    expect(res.summary).toContain("Mock OpenCode concluiu a fase implementing.");
    expect(res.output).toContain("OpenCode execution successful");
    expect(res.model).toBe("mock-opencode");
  });

  it("routes through AgentRegistry picking custom provider when ready", async () => {
    const customProvider = new CustomCliProvider({
      id: "opencode-custom",
      label: "OpenCode Custom",
      command: "opencode",
      capabilities: ["coding", "testing"]
    });

    customProvider.health = async () => ({
      state: "ready",
      detail: "Ready for test",
      checkedAt: new Date().toISOString()
    });

    const registry = new AgentRegistry([customProvider]);
    const routed = await registry.route("coding");

    expect(routed).not.toBeNull();
    expect(routed?.provider.id).toBe("opencode-custom");
  });

  it("detects and lists custom provider in detectProviders wizard helper", () => {
    const customProvidersEnv = JSON.stringify([
      {
        id: "opencode-go",
        label: "OpenCode Go CLI",
        command: "opencode-go",
        envKeys: ["OPENCODE_GO_KEY"],
        capabilities: ["coding"]
      }
    ]);

    const mockEnv = {
      MAESTRO_CUSTOM_PROVIDERS: customProvidersEnv,
      OPENCODE_GO_KEY: "secret-go-key"
    };

    const detected = detectProviders(mockEnv);
    const opencode = detected.find((p) => p.id === "opencode-go");

    // The custom provider is listed, but because it is CLI-only and the
    // 'opencode-go' command cannot be resolved, it is NOT available — an env
    // key alone is not enough to run a CLI provider.
    expect(opencode).toBeDefined();
    expect(opencode?.label).toBe("OpenCode Go CLI");
    expect(opencode?.available).toBe(false);
    expect(opencode?.source).toBe("env_key");
  });

  it("forwards only provider-scoped env keys but scrubs unlisted secrets", () => {
    const mockEnv = {
      SECRET_KEY: "super-secret",
      OPENCODE_API_KEY: "opencode-token",
      OPENCODE_GO_KEY: "go-key",
      GITHUB_TOKEN: "gh-token",
      NORMAL_VAR: "hello",
      OPENAI_API_KEY: "sk-openai"
    };

    const env = buildRestrictedAgentEnvironment(mockEnv, {
      allowProviderKeys: true,
      extraAllowedKeys: ["OPENCODE_API_KEY", "NORMAL_VAR"]
    });

    // A key explicitly listed in the provider's envKeys is forwarded (forwarding
    // a provider's own auth key to its CLI is the purpose of envKeys).
    expect(env.OPENCODE_API_KEY).toBe("opencode-token");
    // Unlisted secret-shaped keys are scrubbed regardless of extraAllowedKeys.
    expect(env.SECRET_KEY).toBeUndefined();
    expect(env.OPENCODE_GO_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    // Non-secret names pass through when listed in extraAllowedKeys.
    expect(env.NORMAL_VAR).toBe("hello");
    // allow-listed provider keys pass when allowProviderKeys is true.
    expect(env.OPENAI_API_KEY).toBe("sk-openai");
  });

  it("reports offline health and a treated execute failure when the CLI is unresolvable", async () => {
    const provider = new CustomCliProvider({
      id: "missing-cli",
      label: "Missing CLI",
      command: "definitely-not-a-real-cli-xyz",
      envKeys: ["MISSING_API_KEY"],
      capabilities: ["coding"]
    });

    const health = await provider.health();
    expect(health.state).toBe("offline");
    expect(health.detail.toLowerCase()).toContain("nao enco");

    const result = await provider.execute(mockExecutionRequest("implementing", "coding", process.cwd()));
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("definitely-not-a-real-cli-xyz");
    expect(result.failureCategory).toBe("offline");
    expect(result.retryable).toBe(false);
  });

  it("does not leak other providers' keys to a custom CLI unless listed in envKeys", async () => {
    const mockEnv = {
      OPENAI_API_KEY: "sk-builtin-openai",
      ANTHROPIC_API_KEY: "sk-builtin-anthropic",
      GEMINI_API_KEY: "sk-builtin-gemini",
      MY_CUSTOM_KEY: "my-own-key"
    };

    // The operator listed only MY_CUSTOM_KEY. Even with allowProviderKeys
    // semantics historically on, a custom CLI must NOT receive the built-in
    // provider secrets — it should only receive what its envKeys opt in to.
    const env = buildRestrictedAgentEnvironment(mockEnv, {
      extraAllowedKeys: ["MY_CUSTOM_KEY"]
    });

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.MY_CUSTOM_KEY).toBe("my-own-key");
  });
});

function mockExecutionRequest(
  phase: AgentExecutionRequest["phase"],
  capability: AgentExecutionRequest["capability"],
  workspacePath: string
): AgentExecutionRequest {
  return {
    runId: 101,
    stepNumber: 1,
    phase,
    capability,
    task: {
      id: 101,
      projectId: 1,
      projectKey: "maestro",
      projectName: "Maestro",
      text: "custom provider integration",
      status: phase,
      source: "dashboard",
      branchName: "feature/opencode",
      worktreePath: workspacePath,
      createdAt: "now",
      updatedAt: "now"
    },
    project: {
      id: 1,
      key: "maestro",
      name: "Maestro",
      path: workspacePath,
      defaultBranch: "main",
      createdAt: "now",
      updatedAt: "now"
    },
    previousSteps: [],
    artifactsRoot: path.join(workspacePath, "artifacts")
  };
}
