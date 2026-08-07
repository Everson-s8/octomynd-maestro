import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildClaudeCliCommand,
  buildClaudeGoalArgs,
  buildClaudeGoalPrompt,
  buildClaudeReviewPrompt,
  ClaudeProvider,
  isClaudeAuthenticationError,
  isClaudeQuotaError,
  parseClaudeReviewDecision
} from "../src/agents/claude.js";
import { AgentExecutionRequest } from "../src/agents/types.js";
import { ProjectRecord, TaskRecord } from "../src/db.js";

describe("claude review", () => {
  it("builds a read-only design review prompt with task context", () => {
    const project: ProjectRecord = {
      id: 1,
      key: "maestro",
      name: "Octomynd Maestro",
      path: "C:/repo/maestro",
      defaultBranch: "main",
      createdAt: "now",
      updatedAt: "now"
    };
    const task: TaskRecord = {
      id: 9,
      projectId: 1,
      projectKey: "maestro",
      projectName: project.name,
      text: "revisar a identidade visual",
      status: "planning",
      source: "dashboard",
      branchName: "maestro/task-9-review",
      worktreePath: "C:/worktrees/task-9",
      createdAt: "now",
      updatedAt: "now"
    };

    const prompt = buildClaudeReviewPrompt(task, project);

    expect(prompt).toContain("somente em modo leitura");
    expect(prompt).toContain("Task #9: revisar a identidade visual");
    expect(prompt).toContain("docs/VISUAL_IDENTITY.md");
  });

  it("supports native and legacy Claude CLI installations", () => {
    expect(buildClaudeCliCommand("C:/tools/claude.exe")).toEqual({
      command: "C:/tools/claude.exe",
      argsPrefix: []
    });
    expect(buildClaudeCliCommand("C:/tools/cli.js")).toEqual({
      command: process.execPath,
      argsPrefix: ["C:/tools/cli.js"]
    });
  });

  it("recognizes current Claude login failures", () => {
    expect(isClaudeAuthenticationError("Not logged in · Please run /login")).toBe(true);
    expect(isClaudeAuthenticationError("API Error: 401 Invalid authentication credentials")).toBe(true);
    expect(isClaudeAuthenticationError("Unexpected filesystem failure")).toBe(false);
  });

  it("advertises goal capabilities while leaving conversation out", () => {
    expect([...new ClaudeProvider().capabilities]).toEqual([
      "planning",
      "coding",
      "testing",
      "reviewing",
      "improvement_reviewing",
      "research"
    ]);
  });

  it("uses read-only mode for planning and guarded workspace tools for coding", () => {
    const planning = executionRequest("planning", "planning");
    const coding = executionRequest("implementing", "coding");
    const testing = executionRequest("testing", "testing");
    const reviewing = executionRequest("reviewing", "reviewing");

    const planningArgs = buildClaudeGoalArgs(buildClaudeCliCommand("C:/tools/claude.exe"), planning, "C:/worktree");
    const codingArgs = buildClaudeGoalArgs(buildClaudeCliCommand("C:/tools/claude.exe"), coding, "C:/worktree");
    const testingArgs = buildClaudeGoalArgs(buildClaudeCliCommand("C:/tools/claude.exe"), testing, "C:/worktree");
    const reviewingArgs = buildClaudeGoalArgs(buildClaudeCliCommand("C:/tools/claude.exe"), reviewing, "C:/worktree");

    expect(planningArgs).toContain("plan");
    expect(planningArgs.join(" ")).not.toContain("--allowedTools");
    expect(codingArgs).toContain("acceptEdits");
    expect(codingArgs.join(" ")).toContain("Read,Glob,Grep,Edit,Write");
    expect(codingArgs.join(" ")).not.toContain("Read,Glob,Grep,Edit,Write,Bash");
    expect(codingArgs.join(" ")).toContain("Bash(git push*)");
    expect(testingArgs.join(" ")).toContain("Read,Glob,Grep,Edit,Write,Bash");
    expect(testingArgs.join(" ")).toContain("Bash(npm test*)");
    expect(testingArgs.join(" ")).not.toContain("--allowedTools Read,Glob,Grep,Edit,Write,Bash --disallowedTools");
    expect(testingArgs.join(" ")).toContain("Bash(curl*)");
    expect(reviewingArgs).toContain("plan");
    expect(reviewingArgs.join(" ")).toContain("Bash(git diff*)");
    expect(reviewingArgs.join(" ")).toContain("Bash(git show*)");
    expect(reviewingArgs.join(" ")).not.toContain("Edit");
    expect(buildClaudeGoalPrompt(coding)).toContain("Nunca faca commit, push, merge, deploy");
    coding.skillContext = {
      available: [],
      loaded: [{
        qualifiedName: "repository:implement-task",
        versionId: `sha256:${"a".repeat(64)}`,
        triggerReason: "Explicit implementation.",
        instructions: "PINNED SKILL PROCEDURE"
      }]
    };
    expect(buildClaudeGoalPrompt(coding)).toContain("PINNED SKILL PROCEDURE");
  });

  it("runs a read-only Work Graph tester without edit tools", () => {
    const testing = executionRequest("testing", "testing");
    testing.workerContext = {
      graphId: 1,
      nodeId: 2,
      key: "test",
      role: "tester",
      objective: "Validate the implementation.",
      outputContract: "Test report.",
      mode: "read_only",
      writeScope: [],
      inputArtifacts: []
    };

    const args = buildClaudeGoalArgs(buildClaudeCliCommand("C:/tools/claude.exe"), testing, "C:/worktree");

    expect(args).toContain("plan");
    expect(args.join(" ")).toContain("Bash(npm test*)");
    expect(args.join(" ")).not.toContain("Edit");
    expect(args.join(" ")).not.toContain("Write");
    expect(buildClaudeGoalPrompt(testing)).toContain("Nao edite arquivos");
  });

  it("recognizes Claude subscription quota failures", () => {
    expect(isClaudeQuotaError("You've hit your session limit · resets 12:40am")).toBe(true);
    expect(isClaudeQuotaError("Unexpected filesystem failure")).toBe(false);
  });

  it("requires one explicit final review decision", () => {
    expect(parseClaudeReviewDecision("Tudo certo.\nFINAL_REVIEW_DECISION: approved")).toBe("approved");
    expect(parseClaudeReviewDecision("FINAL_REVIEW_DECISION: changes_requested")).toBe("changes_requested");
    expect(parseClaudeReviewDecision("Aprovado sem marcador estruturado.")).toBeNull();
    expect(parseClaudeReviewDecision(
      "FINAL_REVIEW_DECISION: approved\nFINAL_REVIEW_DECISION: changes_requested"
    )).toBeNull();
  });
});

describe("claude provider telemetry", () => {
  let tempDir: string;
  let cwd: string;
  let originalAppData: string | undefined;
  let originalFakeMode: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-claude-cli-"));
    cwd = path.join(tempDir, "workspace");
    fs.mkdirSync(cwd);
    const claudeRoot = path.join(tempDir, "npm", "node_modules", "@anthropic-ai", "claude-code");
    fs.mkdirSync(claudeRoot, { recursive: true });
    fs.writeFileSync(path.join(claudeRoot, "cli.js"), FAKE_CLAUDE_CLI_SOURCE, "utf8");
    originalAppData = process.env.APPDATA;
    originalFakeMode = process.env.FAKE_CLAUDE_MODE;
    process.env.APPDATA = tempDir;
  });

  afterEach(() => {
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    if (originalFakeMode === undefined) delete process.env.FAKE_CLAUDE_MODE;
    else process.env.FAKE_CLAUDE_MODE = originalFakeMode;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports a short, structured summary for a quota failure and marks it retryable", async () => {
    process.env.FAKE_CLAUDE_MODE = "quota";
    const provider = new ClaudeProvider(5_000);

    const result = await provider.execute(executionRequest("reviewing", "reviewing", cwd));

    expect(result.outcome).toBe("failed");
    expect(result.summary).toBe("Claude (reviewing): cota do provedor esgotada.");
    expect(result.retryable).toBe(true);
    expect(result.error).toContain("rate limit");
    expect(await provider.health()).toMatchObject({
      state: "quota",
      detail: expect.stringContaining("cota do provider")
    });
  });

  it("reports authentication failures distinctly from quota, with a remediation command", async () => {
    process.env.FAKE_CLAUDE_MODE = "auth";
    const provider = new ClaudeProvider(5_000);

    const result = await provider.execute(executionRequest("reviewing", "reviewing", cwd));

    expect(result.outcome).toBe("failed");
    expect(result.summary).toBe("Claude (reviewing): autenticacao necessaria.");
    expect(result.retryable).toBe(true);
    expect(await provider.health()).toMatchObject({
      state: "auth_required",
      detail: expect.stringContaining("claude login")
    });
  });

  it("names the install and login commands when the Claude CLI is not found", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-claude-missing-"));
    const originalPrefix = process.env.NPM_CONFIG_PREFIX;
    process.env.APPDATA = emptyDir;
    process.env.NPM_CONFIG_PREFIX = emptyDir;
    try {
      const provider = new ClaudeProvider(5_000);

      expect(await provider.health()).toMatchObject({
        state: "offline",
        detail: expect.stringContaining("npm install -g @anthropic-ai/claude-code")
      });
    } finally {
      if (originalPrefix === undefined) delete process.env.NPM_CONFIG_PREFIX;
      else process.env.NPM_CONFIG_PREFIX = originalPrefix;
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("classifies a killed process as a timeout instead of an unknown failure", async () => {
    process.env.FAKE_CLAUDE_MODE = "timeout";
    const provider = new ClaudeProvider(150);

    const result = await provider.execute(executionRequest("reviewing", "reviewing", cwd));

    expect(result.outcome).toBe("failed");
    expect(result.summary).toBe("Claude (reviewing): tempo limite excedido.");
    expect(result.retryable).toBe(true);
    expect(await provider.health()).toMatchObject({
      state: "ready",
      detail: expect.stringContaining("ultima execucao atingiu o limite de tempo")
    });
  }, 10_000);

  it("falls back to an unknown, non-retryable failure for unrecognized errors", async () => {
    process.env.FAKE_CLAUDE_MODE = "unknown";
    const provider = new ClaudeProvider(5_000);

    const result = await provider.execute(executionRequest("reviewing", "reviewing", cwd));

    expect(result.outcome).toBe("failed");
    expect(result.summary).toBe("Claude (reviewing): erro desconhecido.");
    expect(result.retryable).toBe(false);
  });
});

const FAKE_CLAUDE_CLI_SOURCE = `
const mode = process.env.FAKE_CLAUDE_MODE || "unknown";
if (mode === "timeout") {
  setInterval(() => {}, 1000);
} else if (mode === "quota") {
  process.stderr.write("Error: rate limit exceeded, please retry later\\n");
  process.exit(1);
} else if (mode === "auth") {
  process.stderr.write("Not logged in. Please run /login\\n");
  process.exit(1);
} else {
  process.stderr.write("boom: unexpected internal failure\\n");
  process.exit(1);
}
`;

function executionRequest(
  phase: AgentExecutionRequest["phase"],
  capability: AgentExecutionRequest["capability"],
  worktreePath = "C:/worktree"
): AgentExecutionRequest {
  return {
    runId: 1,
    stepNumber: 1,
    phase,
    capability,
    task: {
      id: 9,
      projectId: 1,
      projectKey: "maestro",
      projectName: "Octomynd Maestro",
      text: "melhorar provider",
      status: phase,
      source: "dashboard",
      branchName: "maestro/task-9",
      worktreePath,
      createdAt: "now",
      updatedAt: "now"
    },
    project: {
      id: 1,
      key: "maestro",
      name: "Octomynd Maestro",
      path: worktreePath,
      defaultBranch: "main",
      createdAt: "now",
      updatedAt: "now"
    },
    previousSteps: [],
    artifactsRoot: path.join(worktreePath, "..", "artifacts")
  };
}
