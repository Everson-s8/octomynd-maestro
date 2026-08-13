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

  it("returns health state ready when env key is present even if CLI missing", async () => {
    const provider = new CustomCliProvider({
      ...baseConfig,
      command: "nonexistent-custom-cmd-12345",
      envKeys: ["CUSTOM_OPENCODE_TEST_KEY"]
    });

    process.env.CUSTOM_OPENCODE_TEST_KEY = "test-secret-value";
    try {
      const health = await provider.health();
      expect(health.state).toBe("ready");
      expect(health.detail).toContain("API Key disponivel via ENV");
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

    expect(opencode).toBeDefined();
    expect(opencode?.label).toBe("OpenCode Go CLI");
    expect(opencode?.available).toBe(true);
    expect(opencode?.source).toBe("env_key");
  });

  it("sanitizes sensitive environment keys and custom keys in restricted env", () => {
    const mockEnv = {
      SECRET_KEY: "super-secret",
      OPENCODE_API_KEY: "opencode-token",
      NORMAL_VAR: "hello"
    };

    const env = buildRestrictedAgentEnvironment(mockEnv, {
      allowProviderKeys: true,
      extraAllowedKeys: ["OPENCODE_API_KEY"]
    });

    expect(env.SECRET_KEY).toBeUndefined();
    expect(env.OPENCODE_API_KEY).toBe("opencode-token");
    expect(env.NORMAL_VAR).toBe("hello");
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
