import { describe, expect, it } from "vitest";
import {
  buildClaudeCliCommand,
  buildClaudeGoalArgs,
  buildClaudeGoalPrompt,
  buildClaudeReviewPrompt,
  ClaudeProvider,
  isClaudeAuthenticationError,
  isClaudeQuotaError
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
      "research"
    ]);
  });

  it("uses read-only mode for planning and guarded workspace tools for coding", () => {
    const planning = executionRequest("planning", "planning");
    const coding = executionRequest("implementing", "coding");
    const testing = executionRequest("testing", "testing");

    const planningArgs = buildClaudeGoalArgs(buildClaudeCliCommand("C:/tools/claude.exe"), planning, "C:/worktree");
    const codingArgs = buildClaudeGoalArgs(buildClaudeCliCommand("C:/tools/claude.exe"), coding, "C:/worktree");
    const testingArgs = buildClaudeGoalArgs(buildClaudeCliCommand("C:/tools/claude.exe"), testing, "C:/worktree");

    expect(planningArgs).toContain("plan");
    expect(planningArgs.join(" ")).not.toContain("--allowedTools");
    expect(codingArgs).toContain("acceptEdits");
    expect(codingArgs.join(" ")).toContain("Read,Glob,Grep,Edit,Write");
    expect(codingArgs.join(" ")).not.toContain("Read,Glob,Grep,Edit,Write,Bash");
    expect(codingArgs.join(" ")).toContain("Bash(git push *)");
    expect(testingArgs.join(" ")).toContain("Read,Glob,Grep,Edit,Write,Bash");
    expect(testingArgs.join(" ")).toContain("Bash(npm test *)");
    expect(testingArgs.join(" ")).not.toContain("--allowedTools Read,Glob,Grep,Edit,Write,Bash --disallowedTools");
    expect(testingArgs.join(" ")).toContain("Bash(curl *)");
    expect(buildClaudeGoalPrompt(coding)).toContain("Nunca faca commit, push, merge, deploy");
  });

  it("recognizes Claude subscription quota failures", () => {
    expect(isClaudeQuotaError("You've hit your session limit · resets 12:40am")).toBe(true);
    expect(isClaudeQuotaError("Unexpected filesystem failure")).toBe(false);
  });
});

function executionRequest(
  phase: AgentExecutionRequest["phase"],
  capability: AgentExecutionRequest["capability"]
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
      worktreePath: "C:/worktree",
      createdAt: "now",
      updatedAt: "now"
    },
    project: {
      id: 1,
      key: "maestro",
      name: "Octomynd Maestro",
      path: "C:/repo/maestro",
      defaultBranch: "main",
      createdAt: "now",
      updatedAt: "now"
    },
    previousSteps: [],
    artifactsRoot: "C:/artifacts"
  };
}
