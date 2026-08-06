import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AntigravityProvider,
  buildAntigravityArgs,
  resolveAntigravityExecutable
} from "../src/agents/antigravity.js";
import type { AgentExecutionRequest } from "../src/agents/types.js";

const tempPaths: string[] = [];

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

describe("Antigravity provider", () => {
  it("advertises general execution capabilities", () => {
    expect([...new AntigravityProvider().capabilities]).toEqual([
      "planning",
      "coding",
      "testing",
      "reviewing",
      "improvement_reviewing",
      "research",
      "conversation"
    ]);
  });

  it("uses sandboxed plan mode for reads and accept-edits for writers", () => {
    const planning = request("planning", "planning");
    const coding = request("implementing", "coding");

    const planningArgs = buildAntigravityArgs(planning, null, "low");
    const codingArgs = buildAntigravityArgs(coding, "gemini-model", "high");

    expect(planningArgs).toContain("plan");
    expect(planningArgs).toContain("--sandbox");
    expect(planningArgs).toContain("low");
    expect(codingArgs).toContain("accept-edits");
    expect(codingArgs).toContain("gemini-model");
    expect(codingArgs).toContain("high");
    expect(codingArgs.join(" ")).toContain("Nunca faca commit, push, merge, deploy");
    expect(codingArgs).not.toContain("--dangerously-skip-permissions");
  });

  it("resolves an explicitly configured executable without relying on PATH", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-agy-"));
    tempPaths.push(tempDir);
    const executable = path.join(tempDir, "agy.exe");
    fs.writeFileSync(executable, "fixture", "utf8");

    expect(resolveAntigravityExecutable(executable)).toBe(executable);
    await expect(new AntigravityProvider({
      executablePath: executable,
      healthProbe: false
    }).health()).resolves.toMatchObject({
      state: "ready"
    });
  });
});

function request(
  phase: AgentExecutionRequest["phase"],
  capability: AgentExecutionRequest["capability"]
): AgentExecutionRequest {
  return {
    runId: 1,
    stepNumber: 1,
    phase,
    capability,
    task: {
      id: 1,
      projectId: 1,
      projectKey: "maestro",
      projectName: "Maestro",
      text: "integrar provider",
      status: phase,
      source: "dashboard",
      branchName: "feature/antigravity",
      worktreePath: "C:/worktree",
      createdAt: "now",
      updatedAt: "now"
    },
    project: {
      id: 1,
      key: "maestro",
      name: "Maestro",
      path: "C:/worktree",
      defaultBranch: "main",
      createdAt: "now",
      updatedAt: "now"
    },
    previousSteps: [],
    artifactsRoot: "C:/artifacts"
  };
}
