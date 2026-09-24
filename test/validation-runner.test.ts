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

describe("DeterministicValidationRunner environment preparation", () => {
  const venvPython = () => (process.platform === "win32"
    ? path.join(workspacePath, ".venv", "Scripts", "python.exe")
    : path.join(workspacePath, ".venv", "bin", "python"));

  it("creates .venv and installs the Python project and pytest before the checks", async () => {
    fs.writeFileSync(path.join(workspacePath, "pyproject.toml"), "[project]\nname = 'sample'\n", "utf8");
    fs.mkdirSync(path.join(workspacePath, "tests"));
    fs.writeFileSync(path.join(workspacePath, "tests", "test_sample.py"), "def test_sample(): pass\n", "utf8");
    const calls: AgentProcessRequest[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      calls.push(request);
      return completedProcess("ok");
    });

    const report = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(report.checks.map((check) => check.id)).toEqual([
      "diff_check", "secret_scan", "prepare_environment", "python_compile", "tests_full"
    ]);
    expect(calls.some((call) => call.args.join(" ").endsWith("-m venv .venv"))).toBe(true);
    expect(calls.some((call) => call.command === venvPython() && call.args.join(" ").endsWith("install --disable-pip-version-check -e ."))).toBe(true);
    expect(calls.some((call) => call.command === venvPython() && call.args.at(-1) === "pytest")).toBe(true);
    expect(report.checks.find((check) => check.id === "prepare_environment")?.summary)
      .toContain("create .venv");
  });

  it("prefers requirement files and keeps .venv/node_modules out of commits", async () => {
    fs.writeFileSync(path.join(workspacePath, "requirements.txt"), "fastapi\n", "utf8");
    fs.writeFileSync(path.join(workspacePath, "requirements-dev.txt"), "pytest\n", "utf8");
    fs.writeFileSync(path.join(workspacePath, "pyproject.toml"), "[project]\nname = 'sample'\n", "utf8");
    const calls: AgentProcessRequest[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      calls.push(request);
      return completedProcess("ok");
    });

    await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    const pipCalls = calls.filter((call) => call.args.includes("pip")).map((call) => call.args.slice(-2).join(" "));
    expect(pipCalls).toEqual(["-r requirements.txt", "-r requirements-dev.txt"]);
    const exclude = fs.readFileSync(path.join(workspacePath, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".venv/");
    expect(exclude).toContain("node_modules/");
  });

  it("does not reinstall Python dependencies when the manifests did not change", async () => {
    fs.writeFileSync(path.join(workspacePath, "requirements.txt"), "pytest\n", "utf8");
    fs.mkdirSync(path.dirname(venvPython()), { recursive: true });
    fs.writeFileSync(venvPython(), "", "utf8");
    const calls: AgentProcessRequest[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      calls.push(request);
      return completedProcess("ok");
    });

    await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });
    const firstInstalls = calls.filter((call) => call.args.includes("pip")).length;
    calls.length = 0;
    const second = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(firstInstalls).toBe(1);
    expect(calls.filter((call) => call.args.includes("pip"))).toHaveLength(0);
    expect(second.checks.find((check) => check.id === "prepare_environment")?.summary).toBe("nothing to prepare");
  });

  it("validates a frontend-ts app next to a Python service and installs its node_modules", async () => {
    fs.writeFileSync(path.join(workspacePath, "requirements.txt"), "fastapi\n", "utf8");
    fs.mkdirSync(path.join(workspacePath, "tests"));
    fs.writeFileSync(path.join(workspacePath, "tests", "test_api.py"), "def test_api(): pass\n", "utf8");
    const frontend = path.join(workspacePath, "frontend-ts");
    fs.mkdirSync(frontend);
    fs.writeFileSync(path.join(frontend, "package.json"), "{\"name\":\"ui\",\"dependencies\":{\"vite\":\"*\"}}\n", "utf8");
    fs.writeFileSync(path.join(frontend, "package-lock.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(frontend, "tsconfig.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(frontend, "vite.config.ts"), "export default {}\n", "utf8");
    const calls: AgentProcessRequest[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      calls.push(request);
      return completedProcess("ok");
    });

    const report = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(report.checks.map((check) => check.id)).toEqual([
      "diff_check", "secret_scan", "prepare_environment",
      "typecheck_backend", "typecheck_ui", "tests_full", "build_ui",
      "python_compile", "tests_python"
    ]);
    expect(calls.some((call) => call.args.includes("frontend-ts/tsconfig.json"))).toBe(true);
    expect(calls.some((call) => call.args.includes("frontend-ts/vite.config.ts"))).toBe(true);
    const npmCall = calls.find((call) => call.args.includes("ci"));
    expect(npmCall?.cwd).toBe(frontend);
    expect(npmCall?.command).toBe(process.execPath);
  });

  it("reports a failed install but still runs the checks for evidence", async () => {
    fs.writeFileSync(path.join(workspacePath, "requirements.txt"), "does-not-exist\n", "utf8");
    const runner = new DeterministicValidationRunner(async (request) => (
      request.args.includes("pip")
        ? completedProcess("ERROR: No matching distribution found for does-not-exist", 1)
        : completedProcess("ok")
    ));

    const report = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    const prepare = report.checks.find((check) => check.id === "prepare_environment");
    expect(prepare?.status).toBe("failed");
    expect(prepare?.summary).toContain("No matching distribution");
    expect(report.checks.map((check) => check.id)).toContain("python_compile");
  });

  it("does not report success for an environment.yml it cannot provision", async () => {
    fs.writeFileSync(path.join(workspacePath, "environment.yml"), "dependencies:\n  - python\n", "utf8");
    const calls: AgentProcessRequest[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      calls.push(request);
      return completedProcess("ok");
    });

    const report = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(report.checks.find((check) => check.id === "prepare_environment")?.status).toBe("failed");
    expect(report.checks.find((check) => check.id === "prepare_environment")?.summary).toContain("environment.yml");
    expect(calls.some((call) => call.args.includes("-m") && call.args.includes("venv"))).toBe(false);
  });

  it("retries a partial npm install without a lockfile instead of trusting node_modules", async () => {
    fs.writeFileSync(path.join(workspacePath, "package.json"), "{\"name\":\"demo\",\"dependencies\":{\"left-pad\":\"1.3.0\"}}\n", "utf8");
    let installAttempts = 0;
    const runner = new DeterministicValidationRunner(async (request) => {
      if (request.args.includes("install") && request.args.includes("--no-package-lock")) {
        installAttempts += 1;
        fs.mkdirSync(path.join(request.cwd, "node_modules"), { recursive: true });
        return completedProcess(installAttempts === 1 ? "install interrupted" : "install complete", installAttempts === 1 ? 1 : 0);
      }
      return completedProcess("ok");
    });

    const first = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });
    const second = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });
    const cached = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(first.checks.find((check) => check.id === "prepare_environment")?.status).toBe("failed");
    expect(second.checks.find((check) => check.id === "prepare_environment")?.status).toBe("passed");
    expect(cached.checks.find((check) => check.id === "prepare_environment")?.summary).toBe("nothing to prepare");
    expect(installAttempts).toBe(2);
    expect(fs.existsSync(path.join(workspacePath, "package-lock.json"))).toBe(false);

    fs.writeFileSync(path.join(workspacePath, "package.json"), "{\"name\":\"demo\",\"dependencies\":{\"left-pad\":\"1.3.1\"}}\n", "utf8");
    await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });
    expect(installAttempts).toBe(3);
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
