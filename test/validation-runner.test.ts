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

  it("uses backend/frontend paths and skips optional checks when a generated app has no tests", async () => {
    fs.mkdirSync(path.join(workspacePath, "backend"));
    fs.mkdirSync(path.join(workspacePath, "frontend"));
    fs.writeFileSync(path.join(workspacePath, "backend", "tsconfig.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(workspacePath, "frontend", "tsconfig.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(workspacePath, "frontend", "vite.config.ts"), "export default {}\n", "utf8");

    const calls: AgentProcessRequest[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      calls.push(request);
      return completedProcess("ok");
    });

    const report = await runner.run({ workspacePath, artifactsRoot });

    expect(report.status).toBe("passed");
    expect(calls.find((call) => call.args.includes("backend/tsconfig.json"))).toBeDefined();
    expect(calls.find((call) => call.args.includes("frontend/tsconfig.json"))).toBeDefined();
    expect(calls.find((call) => call.args.includes("frontend/vite.config.ts"))).toBeDefined();
    expect(report.checks.find((check) => check.id === "tests_full")?.summary)
      .toContain("no test files found");
  });

  it("selects Python compile and pytest checks for a Python worktree instead of Maestro's TypeScript catalog", async () => {
    fs.writeFileSync(path.join(workspacePath, "pyproject.toml"), "[project]\nname = 'sample'\n", "utf8");
    fs.mkdirSync(path.join(workspacePath, "tests"));
    fs.writeFileSync(path.join(workspacePath, "tests", "test_sample.py"), "def test_sample(): pass\n", "utf8");
    const calls: AgentProcessRequest[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      calls.push(request);
      return completedProcess("ok");
    });

    const report = await runner.run({ workspacePath, artifactsRoot });

    expect(report.status).toBe("passed");
    expect(report.checks.map((check) => check.id)).toEqual([
      "diff_check", "secret_scan", "python_compile", "tests_full"
    ]);
    expect(calls.some((call) => call.args.includes("compileall"))).toBe(true);
    expect(calls.some((call) => call.args.includes("pytest"))).toBe(true);
    expect(calls.every((call) => !call.args.includes("--noEmit"))).toBe(true);
  });

  it("recognizes a standalone Python worktree with no dependency manifest", async () => {
    fs.writeFileSync(path.join(workspacePath, "app.py"), "print('ready')\n", "utf8");
    const calls: AgentProcessRequest[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      calls.push(request);
      return completedProcess("ok");
    });

    const report = await runner.run({ workspacePath, artifactsRoot });

    expect(report.checks.map((check) => check.id)).toEqual([
      "diff_check", "secret_scan", "python_compile", "tests_full"
    ]);
    expect(report.checks.find((check) => check.id === "tests_full")?.summary)
      .toContain("no Python test files found");
    expect(calls.some((call) => call.args.includes("compileall"))).toBe(true);
  });

  it("uses the worktree-local Python virtual environment when one is already prepared", async () => {
    fs.writeFileSync(path.join(workspacePath, "requirements.txt"), "pytest\n", "utf8");
    const python = process.platform === "win32"
      ? path.join(workspacePath, ".venv", "Scripts", "python.exe")
      : path.join(workspacePath, ".venv", "bin", "python");
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, "", "utf8");
    const calls: AgentProcessRequest[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      calls.push(request);
      return completedProcess("ok");
    });

    await runner.run({ workspacePath, artifactsRoot });

    const pythonCalls = calls.filter((call) => call.command !== "git");
    expect(pythonCalls.length).toBeGreaterThan(0);
    expect(pythonCalls.every((call) => call.command === python)).toBe(true);
    expect(pythonCalls.every((call) => !call.args.includes("-3"))).toBe(true);
  });

  it("reports a missing Python runtime as recoverable validation evidence, not a false pass", async () => {
    fs.writeFileSync(path.join(workspacePath, "requirements.txt"), "pytest\n", "utf8");
    const runner = new DeterministicValidationRunner(async (request) => (
      request.command === "git"
        ? completedProcess("ok")
        : completedProcess("Python runtime is unavailable", 9009)
    ));

    const report = await runner.run({ workspacePath, artifactsRoot });

    expect(report.status).toBe("failed");
    expect(report.compactFailure).toContain("python_compile");
    expect(report.checks.find((check) => check.id === "python_compile")?.status).toBe("failed");
  });

  it("accepts safe Python focused-test paths and rejects traversal", async () => {
    fs.writeFileSync(path.join(workspacePath, "requirements.txt"), "pytest\n", "utf8");
    fs.mkdirSync(path.join(workspacePath, "tests"));
    fs.writeFileSync(path.join(workspacePath, "tests", "test_sample.py"), "def test_sample(): pass\n", "utf8");
    const calls: AgentProcessRequest[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      calls.push(request);
      return completedProcess("ok");
    });

    await runner.run({ workspacePath, artifactsRoot, mode: "focused", focusedTests: ["tests/test_sample.py"] });
    expect(calls.some((call) => call.args.includes("tests/test_sample.py"))).toBe(true);

    await expect(runner.run({
      workspacePath,
      artifactsRoot,
      mode: "focused",
      focusedTests: ["tests/../outside.py"]
    })).rejects.toThrow("repository-relative");
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
