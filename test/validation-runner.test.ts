import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentProcessRequest, AgentProcessResult } from "../src/agents/process.js";
import { DeterministicValidationRunner } from "../src/validation/runner.js";

let tempDir: string;
let workspacePath: string;
let artifactsRoot: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-validation-"));
  workspacePath = path.join(tempDir, "workspace");
  artifactsRoot = path.join(tempDir, "artifacts");
  fs.mkdirSync(workspacePath);
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(workspacePath, "README.md"), "clean\n", "utf8");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("DeterministicValidationRunner", () => {
  it("runs only the fixed validation catalog and stores sanitized artifacts", async () => {
    const calls: AgentProcessRequest[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      calls.push(request);
      return completedProcess("ok");
    });

    const report = await runner.run({ workspacePath, artifactsRoot });

    expect(report.status).toBe("passed");
    expect(report.checks.map((check) => check.id)).toEqual([
      "diff_check",
      "secret_scan",
      "typecheck_backend",
      "typecheck_ui",
      "tests_full",
      "build_ui"
    ]);
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.cwd === workspacePath)).toBe(true);
    expect(calls.some((call) => call.command === "git" && call.args.includes("--check"))).toBe(true);
    expect(fs.existsSync(path.join(artifactsRoot, ...report.reportArtifactKey.split("/")))).toBe(true);
  });

  it("returns compact actionable failures while retaining raw output", async () => {
    const runner = new DeterministicValidationRunner(async (request) => (
      request.args.includes("--noEmit")
        ? completedProcess("TypeError: expected string but received number", 2)
        : completedProcess("ok")
    ));

    const report = await runner.run({ workspacePath, artifactsRoot });

    expect(report.status).toBe("failed");
    expect(report.compactFailure).toContain("typecheck_backend");
    expect(report.compactFailure).toContain("expected string");
    const failed = report.checks.find((check) => check.id === "typecheck_backend");
    expect(failed?.artifactKey).toBeTruthy();
    expect(fs.readFileSync(path.join(artifactsRoot, ...failed!.artifactKey.split("/")), "utf8"))
      .toContain("TypeError");
  });

  it("rejects focused test paths that could escape the allowlist", async () => {
    const runner = new DeterministicValidationRunner(async () => completedProcess("ok"));

    await expect(runner.run({
      workspacePath,
      artifactsRoot,
      mode: "focused",
      focusedTests: ["../outside.test.ts"]
    })).rejects.toThrow("repository-relative");
  });

  it("fails closed when a changed file contains secret-shaped content", async () => {
    fs.writeFileSync(path.join(workspacePath, "leak.txt"), `sk-proj-${"a".repeat(32)}\n`, "utf8");
    let processCalls = 0;
    const runner = new DeterministicValidationRunner(async () => {
      processCalls += 1;
      return completedProcess("ok");
    });

    const report = await runner.run({ workspacePath, artifactsRoot });

    expect(report.status).toBe("failed");
    expect(report.compactFailure).toContain("secret_scan");
    expect(report.compactFailure).not.toContain("sk-proj-");
    expect(processCalls).toBe(1);
  });

  it("scans committed Feature changes relative to a validated base ref", async () => {
    git(["branch", "validation-base"]);
    fs.writeFileSync(path.join(workspacePath, "committed.txt"), "feature content\n", "utf8");
    git(["add", "committed.txt"]);
    git(["commit", "-m", "feature change"]);
    const runner = new DeterministicValidationRunner(async (request) => {
      if (request.args.includes("--name-only")) return completedProcess("committed.txt\n");
      return completedProcess("ok");
    });

    const report = await runner.run({ workspacePath, artifactsRoot, baseRef: "validation-base" });

    expect(report.status).toBe("passed");
    expect(report.checks.find((check) => check.id === "secret_scan")?.summary)
      .toBe("passed (1 changed files)");
  });

  it("rejects an unsafe Feature base ref before running commands", async () => {
    const runner = new DeterministicValidationRunner(async () => completedProcess("ok"));

    await expect(runner.run({
      workspacePath,
      artifactsRoot,
      baseRef: "--output=/tmp/escape"
    })).rejects.toThrow("safe Git reference");
  });
});

function git(args: string[]): void {
  const result = spawnSync("git", ["-C", workspacePath, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function completedProcess(output: string, exitCode = 0): AgentProcessResult {
  return {
    exitCode,
    stdout: output,
    stderr: "",
    aborted: false,
    timedOut: false,
    breakerReason: null,
    outputStats: {
      receivedChars: output.length,
      retainedChars: output.length,
      duplicateChunks: 0,
      truncatedChars: 0
    },
    durationMs: 10,
    tokenUsage: { inputTokens: 0, outputTokens: 0 }
  };
}
