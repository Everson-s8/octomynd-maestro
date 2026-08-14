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
    expect(codingArgs.join(" ")).toContain("Never commit, push, merge, deploy");
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

  it("returns NormalizedResult structure with proper failure classification when offline", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-agy-req-"));
    tempPaths.push(tempDir);
    const req = request("planning", "planning");
    req.task.worktreePath = tempDir;
    req.project.path = tempDir;

    const provider = new AntigravityProvider({ executablePath: path.join(tempDir, "nonexistent-agy.exe") });
    const res = await provider.execute(req);
    expect(res).toMatchObject({
      outcome: "failed",
      summary: expect.stringMatching(/Antigravity CLI nao encontrado|Workspace nao existe/),
      structuredPayload: null,
      failureCategory: "offline",
      retryable: false,
      artifactsProduced: []
    });
  });

  it("kills a hanging/silent CLI process after the configured inactivity window and classifies failure as retryable timeout", { timeout: 20_000 }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-agy-hang-"));
    tempPaths.push(tempDir);

    const scriptPath = path.join(tempDir, process.platform === "win32" ? "agy.exe" : "agy");
    if (process.platform === "win32") {
      const psCmd = `powershell -Command "Add-Type -TypeDefinition 'using System.Threading; class P { static void Main() { Thread.Sleep(300000); } }' -OutputAssembly '${scriptPath.replace(/'/g, "''")}' -OutputType ConsoleApplication"`;
      const { execSync } = await import("node:child_process");
      execSync(psCmd, { stdio: "ignore" });
    } else {
      fs.writeFileSync(scriptPath, "#!/bin/sh\nsleep 300\n", { mode: 0o755 });
    }

    const provider = new AntigravityProvider({
      executablePath: scriptPath,
      healthProbe: false,
      executionLimits: {
        inactivityTimeoutMs: 150
      }
    });

    const req = request("implementing", "coding");
    req.task.worktreePath = tempDir;
    req.project.path = tempDir;

    const started = Date.now();
    const res = await provider.execute(req);
    const elapsed = Date.now() - started;

    expect(res.outcome).toBe("failed");
    expect(res.failureCategory).toBe("timeout");
    expect(res.retryable).toBe(true);
    expect(res.retryAfterMs).toBe(15_000);
    expect(elapsed).toBeLessThan(5_000);

    const health = await provider.health();
    expect(health.state).toBe("offline");
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
