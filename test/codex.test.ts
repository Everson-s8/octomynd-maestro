import { describe, expect, it } from "vitest";
import {
  buildCodexGoalPrompt,
  codexSandboxForCapability,
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

  it("classifies quota and authentication failures", () => {
    expect(isCodexQuotaError("You've hit your usage limit")).toBe(true);
    expect(isCodexQuotaError("filesystem failure")).toBe(false);
    expect(isCodexAuthenticationError("401 authentication required")).toBe(true);
    expect(isCodexAuthenticationError("filesystem failure")).toBe(false);
  });

  it("builds a phase-scoped prompt that forbids delivery mutations", () => {
    const prompt = buildCodexGoalPrompt(executionRequest());

    expect(prompt).toContain("Fase: implementing");
    expect(prompt).toContain("Nao fa");
    expect(prompt).toContain("commit, push, merge, deploy");
  });
});

function executionRequest(): AgentExecutionRequest {
  const now = "now";
  return {
    runId: 1,
    stepNumber: 2,
    phase: "implementing",
    capability: "coding",
    task: {
      id: 7,
      projectId: 3,
      projectKey: "maestro",
      projectName: "Octomynd Maestro",
      text: "melhorar provider",
      status: "implementing",
      source: "dashboard",
      branchName: "maestro/task-7",
      worktreePath: "C:/worktree",
      createdAt: now,
      updatedAt: now
    },
    project: {
      id: 3,
      key: "maestro",
      name: "Octomynd Maestro",
      path: "C:/repo",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now
    },
    previousSteps: [],
    artifactsRoot: "C:/artifacts"
  };
}
