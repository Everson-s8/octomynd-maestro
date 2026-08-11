import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CodexProvider,
  buildCodexGoalPrompt,
  codexSandboxForCapability,
  codexSandboxForRequest,
  isCodexAuthenticationError,
  isCodexQuotaError
} from "../src/agents/codex.js";
import { AgentExecutionRequest } from "../src/agents/types.js";

describe("codex provider", () => {
  it("uses workspace-write only for coding and testing", () => {
    expect(codexSandboxForCapability("planning")).toBe("read-only");
    expect(codexSandboxForCapability("reviewing")).toBe("read-only");
    expect(codexSandboxForCapability("coding")).toBe("workspace-write");
    expect(codexSandboxForCapability("testing")).toBe("workspace-write");
  });

  it("forces read-only sandbox for a read-only Work Graph tester", () => {
    const request = executionRequest("C:/worktree", "testing");
    request.workerContext = workerContext("tester", "read_only");

    expect(codexSandboxForRequest(request)).toBe("read-only");
    expect(buildCodexGoalPrompt(request)).toContain("Nao edite arquivos");
  });

  it("classifies quota and authentication failures", () => {
    expect(isCodexQuotaError("You've hit your usage limit")).toBe(true);
    expect(isCodexQuotaError("filesystem failure")).toBe(false);
    expect(isCodexAuthenticationError("401 authentication required")).toBe(true);
    expect(isCodexAuthenticationError("filesystem failure")).toBe(false);
  });

  it("builds a phase-scoped prompt that forbids delivery mutations", () => {
    const request = executionRequest();
    request.skillContext = skillContext();
    const prompt = buildCodexGoalPrompt(request);

    expect(prompt).toContain("Fase: implementing");
    expect(prompt).toContain("Nunca faca");
    expect(prompt).toContain("commit, push, merge, deploy");
    expect(prompt).toContain("repository:implement-task");
    expect(prompt).toContain("PINNED SKILL PROCEDURE");
  });

  it("prefers the token-efficient handoff over raw previous-step output", () => {
    const request = executionRequest();
    request.previousSteps = [{
      id: 1,
      runId: 1,
      phase: "planning",
      provider: "claude",
      status: "completed",
      summary: "planejado",
      output: `RAW-DETAIL ${"x".repeat(3_000)}`,
      error: null,
      durationMs: 1,
      createdAt: "now",
      finishedAt: "now"
    }];
    request.previousStepHandoff = [{
      stepId: 1,
      phase: "planning",
      provider: "claude",
      status: "completed",
      summary: "planejado",
      compactOutput: "evidencias:\n- npm test PASS",
      rawOutputArtifact: "goal-1/step-0001-planning-claude/provider-output.raw.txt",
      telemetry: {} as never
    }];

    const prompt = buildCodexGoalPrompt(request);

    expect(prompt).toContain("compacto:");
    expect(prompt).toContain("npm test PASS");
    expect(prompt).not.toContain("RAW-DETAIL");
  });
});

describe("codex provider telemetry", () => {
  let tempDir: string;
  let cwd: string;
  let originalAppData: string | undefined;
  let originalFakeMode: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-codex-cli-"));
    cwd = path.join(tempDir, "workspace");
    fs.mkdirSync(cwd);
    const codexBinDir = path.join(tempDir, "npm", "node_modules", "@openai", "codex", "bin");
    fs.mkdirSync(codexBinDir, { recursive: true });
    fs.writeFileSync(path.join(codexBinDir, "codex.js"), FAKE_CODEX_CLI_SOURCE, "utf8");
    originalAppData = process.env.APPDATA;
    originalFakeMode = process.env.FAKE_CODEX_MODE;
    process.env.APPDATA = tempDir;
  });

  afterEach(() => {
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    if (originalFakeMode === undefined) delete process.env.FAKE_CODEX_MODE;
    else process.env.FAKE_CODEX_MODE = originalFakeMode;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports a short, structured summary for a quota failure and marks it retryable", async () => {
    process.env.FAKE_CODEX_MODE = "quota";
    const provider = new CodexProvider(5_000);
    const result = await provider.execute(executionRequest(cwd, "implementing"));

    expect(result.outcome).toBe("failed");
    expect(result.summary).toBe("Codex (implementing): cota do provedor esgotada.");
    expect(result.retryable).toBe(true);
    expect(result.error).toContain("usage limit");
    expect(await provider.health()).toMatchObject({
      state: "quota",
      detail: expect.stringContaining("cota do provider")
    });
  });

  it("reports authentication failures distinctly from quota, with a remediation command", async () => {
    process.env.FAKE_CODEX_MODE = "auth";
    const provider = new CodexProvider(5_000);
    const result = await provider.execute(executionRequest(cwd, "planning"));

    expect(result.outcome).toBe("failed");
    expect(result.summary).toBe("Codex (planning): autenticacao necessaria.");
    expect(result.retryable).toBe(true);
    expect(await provider.health()).toMatchObject({
      state: "auth_required",
      detail: expect.stringContaining("codex login")
    });
  });

  it("names the install and login commands when the Codex CLI is not found", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-codex-missing-"));
    const originalPrefix = process.env.NPM_CONFIG_PREFIX;
    process.env.APPDATA = emptyDir;
    process.env.NPM_CONFIG_PREFIX = emptyDir;
    try {
      const provider = new CodexProvider(5_000);

      expect(await provider.health()).toMatchObject({
        state: "offline",
        detail: expect.stringContaining("npm install -g @openai/codex")
      });
    } finally {
      if (originalPrefix === undefined) delete process.env.NPM_CONFIG_PREFIX;
      else process.env.NPM_CONFIG_PREFIX = originalPrefix;
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("classifies a killed process as a timeout instead of an unknown failure", async () => {
    process.env.FAKE_CODEX_MODE = "timeout";
    const result = await new CodexProvider(150).execute(executionRequest(cwd, "testing"));

    expect(result.outcome).toBe("failed");
    expect(result.summary).toBe("Codex (testing): tempo limite excedido.");
    expect(result.retryable).toBe(true);
  }, 10_000);

  it("falls back to an unknown, non-retryable failure for unrecognized errors", async () => {
    process.env.FAKE_CODEX_MODE = "unknown";
    const result = await new CodexProvider(5_000).execute(executionRequest(cwd, "reviewing"));

    expect(result.outcome).toBe("failed");
    expect(result.summary).toBe("Codex (reviewing): erro desconhecido.");
    expect(result.retryable).toBe(false);
    expect(result.structuredPayload).toBeNull();
    expect(result.artifactsProduced).toEqual([]);
  });

  it("returns NormalizedResult structure on successful execution", async () => {
    process.env.FAKE_CODEX_MODE = "success";
    const result = await new CodexProvider(5_000).execute(executionRequest(cwd, "planning"));

    expect(result.outcome).toBe("completed");
    expect(result.summary).toBe("Plano gerado com sucesso.");
    expect(result.structuredPayload).toEqual({
      outcome: "completed",
      summary: "Plano gerado com sucesso.",
      details: "Detalhes do plano."
    });
    expect(result.artifactsProduced).toHaveLength(1);
    expect(result.artifactsProduced?.[0]).toContain("result.json");
  });
});

const FAKE_CODEX_CLI_SOURCE = `
const fs = require("node:fs");
const mode = process.env.FAKE_CODEX_MODE || "unknown";
if (mode === "success") {
  const outputIdx = process.argv.indexOf("--output-last-message");
  if (outputIdx !== -1 && process.argv[outputIdx + 1]) {
    fs.writeFileSync(process.argv[outputIdx + 1], JSON.stringify({
      outcome: "completed",
      summary: "Plano gerado com sucesso.",
      details: "Detalhes do plano."
    }));
  }
  process.exit(0);
} else if (mode === "timeout") {
  setInterval(() => {}, 1000);
} else if (mode === "quota") {
  process.stderr.write("Error: usage limit reached for this account\\n");
  process.exit(1);
} else if (mode === "auth") {
  process.stderr.write("401 authentication required, please login\\n");
  process.exit(1);
} else {
  process.stderr.write("boom: unexpected internal failure\\n");
  process.exit(1);
}
`;

function executionRequest(
  worktreePath = "C:/worktree",
  phase: AgentExecutionRequest["phase"] = "implementing"
): AgentExecutionRequest {
  const now = "now";
  const capability = phase === "implementing"
    ? "coding"
    : phase === "testing"
      ? "testing"
      : phase === "reviewing"
        ? "reviewing"
        : "planning";
  return {
    runId: 1,
    stepNumber: 2,
    phase,
    capability,
    task: {
      id: 7,
      projectId: 3,
      projectKey: "maestro",
      projectName: "Octomynd Maestro",
      text: "melhorar provider",
      status: phase,
      source: "dashboard",
      branchName: "maestro/task-7",
      worktreePath,
      createdAt: now,
      updatedAt: now
    },
    project: {
      id: 3,
      key: "maestro",
      name: "Octomynd Maestro",
      path: worktreePath,
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now
    },
    previousSteps: [],
    artifactsRoot: path.join(worktreePath, "..", "artifacts")
  };
}

function skillContext(): NonNullable<AgentExecutionRequest["skillContext"]> {
  const versionId = `sha256:${"a".repeat(64)}`;
  return {
    available: [{
      qualifiedName: "repository:implement-task",
      description: "Implement one bounded task.",
      versionId,
      scope: "repository",
      risk: "low"
    }],
    loaded: [{
      qualifiedName: "repository:implement-task",
      versionId,
      triggerReason: "Explicit implementation.",
      instructions: "PINNED SKILL PROCEDURE"
    }]
  };
}

function workerContext(
  role: NonNullable<AgentExecutionRequest["workerContext"]>["role"],
  mode: NonNullable<AgentExecutionRequest["workerContext"]>["mode"]
): NonNullable<AgentExecutionRequest["workerContext"]> {
  return {
    graphId: 1,
    nodeId: 2,
    key: role,
    role,
    objective: "Validate the implementation.",
    outputContract: "Test report.",
    mode,
    writeScope: [],
    inputArtifacts: []
  };
}
