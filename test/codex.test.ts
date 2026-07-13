import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexProvider, buildCodexGoalPrompt } from "../src/agents/codex.js";
import { AgentExecutionRequest } from "../src/agents/types.js";
import { ProjectRecord, TaskRecord } from "../src/db.js";

describe("codex prompt", () => {
  it("instructs the worker not to commit, push or leave the workspace", () => {
    const prompt = buildCodexGoalPrompt(buildRequest(process.cwd(), "implementing"));
    expect(prompt).toContain("Nao faça commit, push, merge, deploy");
    expect(prompt).toContain("Fase: implementing");
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

    const result = await provider.execute(buildRequest(cwd, "implementing"));

    expect(result.outcome).toBe("failed");
    expect(result.summary).toBe("Codex (implementing): cota do provedor esgotada.");
    expect(result.retryable).toBe(true);
    expect(result.error).toContain("usage limit");
  });

  it("reports authentication failures distinctly from quota", async () => {
    process.env.FAKE_CODEX_MODE = "auth";
    const provider = new CodexProvider(5_000);

    const result = await provider.execute(buildRequest(cwd, "planning"));

    expect(result.outcome).toBe("failed");
    expect(result.summary).toBe("Codex (planning): autenticacao necessaria.");
    expect(result.retryable).toBe(true);
  });

  it("classifies a killed process as a timeout instead of an unknown failure", async () => {
    process.env.FAKE_CODEX_MODE = "timeout";
    const provider = new CodexProvider(150);

    const result = await provider.execute(buildRequest(cwd, "testing"));

    expect(result.outcome).toBe("failed");
    expect(result.summary).toBe("Codex (testing): tempo limite excedido.");
    expect(result.retryable).toBe(true);
  }, 10_000);

  it("falls back to an unknown, non-retryable failure for unrecognized errors", async () => {
    process.env.FAKE_CODEX_MODE = "unknown";
    const provider = new CodexProvider(5_000);

    const result = await provider.execute(buildRequest(cwd, "reviewing"));

    expect(result.outcome).toBe("failed");
    expect(result.summary).toBe("Codex (reviewing): erro desconhecido.");
    expect(result.retryable).toBe(false);
  });
});

const FAKE_CODEX_CLI_SOURCE = `
const mode = process.env.FAKE_CODEX_MODE || "unknown";
if (mode === "timeout") {
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

function buildRequest(cwd: string, phase: AgentExecutionRequest["phase"]): AgentExecutionRequest {
  const project: ProjectRecord = {
    id: 1,
    key: "maestro",
    name: "Octomynd Maestro",
    path: cwd,
    defaultBranch: "main",
    createdAt: "now",
    updatedAt: "now"
  };
  const task: TaskRecord = {
    id: 1,
    projectId: 1,
    projectKey: "maestro",
    projectName: project.name,
    text: "melhorar telemetria",
    status: "planning",
    source: "dashboard",
    branchName: "maestro/task-1",
    worktreePath: cwd,
    createdAt: "now",
    updatedAt: "now"
  };
  return {
    runId: 1,
    stepNumber: 1,
    phase,
    capability: phase === "implementing" ? "coding" : phase === "testing" ? "testing" : phase === "reviewing" ? "reviewing" : "planning",
    task,
    project,
    previousSteps: [],
    artifactsRoot: path.join(cwd, "..", "artifacts")
  };
}
