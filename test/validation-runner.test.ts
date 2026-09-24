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

  it("strips Maestro secrets from validation commands", async () => {
    fs.writeFileSync(path.join(workspacePath, "requirements.txt"), "pytest\n", "utf8");
    const key = "TELEGRAM_BOT_TOKEN";
    const prior = process.env[key];
    process.env[key] = "FAKE-SECRET-123";
    const calls: AgentProcessRequest[] = [];
    try {
      const runner = new DeterministicValidationRunner(async (request) => {
        calls.push(request);
        return completedProcess("ok");
      });
      await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((call) => call.env?.[key] === undefined)).toBe(true);
      expect(calls.every((call) => call.env?.PATH === process.env.PATH)).toBe(true);
      expect(calls.some((call) => call.args.includes("pip"))).toBe(true);
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
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

  it("installs conventional Python test extras declared by pyproject.toml", async () => {
    fs.writeFileSync(path.join(workspacePath, "pyproject.toml"), [
      "[project]", "name = 'sample'", "", "[project.optional-dependencies]",
      "dev = ['pytest']", "test = ['coverage']", "docs = ['sphinx']", ""
    ].join("\n"), "utf8");
    const calls: AgentProcessRequest[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      calls.push(request);
      return completedProcess("ok");
    });

    await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(calls.some((call) => call.args.includes(".[dev,test]") && call.args.includes("-e"))).toBe(true);
  });

  it("uses pnpm when a pnpm lockfile is present", async () => {
    fs.writeFileSync(path.join(workspacePath, "package.json"), "{\"name\":\"demo\",\"dependencies\":{\"x\":\"workspace:*\"}}\n", "utf8");
    fs.writeFileSync(path.join(workspacePath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const calls: AgentProcessRequest[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      calls.push(request);
      if (request.args.includes("ci") || request.args.includes("install")) {
        fs.mkdirSync(path.join(request.cwd, "node_modules"), { recursive: true });
      }
      return completedProcess("ok");
    });

    await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(calls.some((call) => (
      call.command === "pnpm"
        ? call.args[0] === "install" && call.args.includes("--frozen-lockfile")
        : call.args.some((arg) => arg.includes("pnpm install --frozen-lockfile"))
    ))).toBe(true);
  });

  it("installs declared npm workspace members once from the root lockfile", async () => {
    fs.writeFileSync(path.join(workspacePath, "package.json"), JSON.stringify({
      name: "monorepo",
      private: true,
      workspaces: ["packages/*"],
      scripts: { test: "echo test" }
    }), "utf8");
    fs.writeFileSync(path.join(workspacePath, "package-lock.json"), "{}\n", "utf8");
    const webDir = path.join(workspacePath, "packages", "web");
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(path.join(webDir, "package.json"), JSON.stringify({
      name: "web",
      dependencies: { "shared-ui": "workspace:*" }
    }), "utf8");
    const installCwds: string[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      if (request.args.includes("ci")) {
        installCwds.push(request.cwd);
        fs.mkdirSync(path.join(request.cwd, "node_modules"), { recursive: true });
      }
      return completedProcess("ok");
    });

    const report = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(report.checks.find((check) => check.id === "prepare_environment")?.status).toBe("passed");
    expect(installCwds).toEqual([workspacePath]);

    fs.writeFileSync(path.join(webDir, "package.json"), JSON.stringify({
      name: "web",
      dependencies: { "shared-ui": "workspace:*", react: "19.0.0" }
    }), "utf8");
    await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });
    expect(installCwds).toEqual([workspacePath, workspacePath]);
  });

  it("installs pnpm workspace protocol dependencies from the pnpm workspace root", async () => {
    fs.writeFileSync(path.join(workspacePath, "package.json"), JSON.stringify({ name: "pnpm-monorepo", private: true }), "utf8");
    fs.writeFileSync(path.join(workspacePath, "pnpm-workspace.yaml"), "packages:\n  - 'web'\n", "utf8");
    fs.writeFileSync(path.join(workspacePath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const webDir = path.join(workspacePath, "web");
    fs.mkdirSync(webDir);
    fs.writeFileSync(path.join(webDir, "package.json"), JSON.stringify({
      name: "web",
      dependencies: { "shared-ui": "workspace:*" }
    }), "utf8");
    const installCwds: string[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      if (request.args.includes("install") || request.args.some((arg) => /pnpm install/.test(arg))) {
        installCwds.push(request.cwd);
        fs.mkdirSync(path.join(request.cwd, "node_modules"), { recursive: true });
      }
      return completedProcess("ok");
    });

    const report = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(report.checks.find((check) => check.id === "prepare_environment")?.status).toBe("passed");
    expect(installCwds).toEqual([workspacePath]);
  });

  it("prepares a pnpm workspace without a lockfile without falling back to npm", async () => {
    fs.writeFileSync(path.join(workspacePath, "pnpm-workspace.yaml"), "packages:\n  - 'web'\n", "utf8");
    const webDir = path.join(workspacePath, "web");
    fs.mkdirSync(webDir);
    fs.writeFileSync(path.join(webDir, "package.json"), JSON.stringify({
      name: "web",
      dependencies: { "shared-ui": "workspace:*" }
    }), "utf8");
    const installCalls: AgentProcessRequest[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      if (request.args.includes("--no-lockfile") || request.args.some((arg) => arg.includes("pnpm install --no-lockfile"))) {
        installCalls.push(request);
        fs.mkdirSync(path.join(request.cwd, "web", "node_modules"), { recursive: true });
      }
      return completedProcess("ok");
    });

    const report = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });
    const cachedReport = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(report.checks.find((check) => check.id === "prepare_environment")?.status).toBe("passed");
    expect(cachedReport.checks.find((check) => check.id === "prepare_environment")?.summary).toBe("nothing to prepare");
    expect(installCalls).toHaveLength(1);
    expect(installCalls[0].cwd).toBe(workspacePath);
    expect(`${installCalls[0].command} ${installCalls[0].args.join(" ")}`).toContain("pnpm install --no-lockfile");
    expect(fs.existsSync(path.join(workspacePath, "package-lock.json"))).toBe(false);
    expect(fs.existsSync(path.join(workspacePath, "pnpm-lock.yaml"))).toBe(false);
  });

  it("reinstalls a workspace when root dependencies disappear despite stale member node_modules", async () => {
    fs.writeFileSync(path.join(workspacePath, "package.json"), JSON.stringify({
      name: "pnpm-monorepo",
      private: true,
      dependencies: { "root-tool": "1.0.0" }
    }), "utf8");
    fs.writeFileSync(path.join(workspacePath, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n", "utf8");
    fs.writeFileSync(path.join(workspacePath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const memberDir = path.join(workspacePath, "packages", "web");
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, "package.json"), JSON.stringify({ name: "web" }), "utf8");
    let installs = 0;
    const runner = new DeterministicValidationRunner(async (request) => {
      if (request.args.includes("install") || request.args.some((arg) => /pnpm install/.test(arg))) {
        installs += 1;
        fs.mkdirSync(path.join(workspacePath, "node_modules"), { recursive: true });
        fs.mkdirSync(path.join(memberDir, "node_modules"), { recursive: true });
      }
      return completedProcess("ok");
    });

    const first = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });
    fs.rmSync(path.join(workspacePath, "node_modules"), { recursive: true, force: true });
    const second = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(first.checks.find((check) => check.id === "prepare_environment")?.status).toBe("passed");
    expect(second.checks.find((check) => check.id === "prepare_environment")?.status).toBe("passed");
    expect(installs).toBe(2);
  });

  it("matches declared workspace globs without assuming folder names or layout", async () => {
    fs.writeFileSync(path.join(workspacePath, "package.json"), JSON.stringify({
      name: "monorepo",
      private: true,
      workspaces: ["{services,tools}/api-v?", "products/**/worker-*"]
    }), "utf8");
    fs.writeFileSync(path.join(workspacePath, "package-lock.json"), "{}\n", "utf8");
    const memberDirs = [
      path.join(workspacePath, "services", "api-v1"),
      path.join(workspacePath, "tools", "api-v2"),
      path.join(workspacePath, "products", "media", "worker-local")
    ];
    for (const [index, memberDir] of memberDirs.entries()) {
      fs.mkdirSync(memberDir, { recursive: true });
      fs.writeFileSync(path.join(memberDir, "package.json"), JSON.stringify({
        name: `workspace-member-${index}`,
        dependencies: { "shared-package": "workspace:*" }
      }), "utf8");
    }
    const installCwds: string[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      if (request.args.includes("ci")) {
        installCwds.push(request.cwd);
        fs.mkdirSync(path.join(request.cwd, "node_modules"), { recursive: true });
      }
      return completedProcess("ok");
    });

    const report = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });
    fs.writeFileSync(path.join(memberDirs[2], "package.json"), JSON.stringify({
      name: "workspace-member-changed",
      dependencies: { "shared-package": "workspace:*", another: "1.0.0" }
    }), "utf8");
    await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(report.checks.find((check) => check.id === "prepare_environment")?.status).toBe("passed");
    expect(installCwds).toEqual([workspacePath, workspacePath]);
  });

  it("prepares a deeply nested Node app without requiring a conventional directory name", async () => {
    const appDir = path.join(workspacePath, "odd", "structure", "desktop-shell");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({
      name: "desktop-shell",
      dependencies: { example: "1.0.0" },
      scripts: { test: "vitest run", build: "vite build" }
    }), "utf8");
    fs.writeFileSync(path.join(appDir, "package-lock.json"), "{}\n", "utf8");
    const calls: AgentProcessRequest[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      calls.push(request);
      if (request.args.includes("ci")) {
        fs.mkdirSync(path.join(request.cwd, "node_modules"), { recursive: true });
        return completedProcess("installed");
      }
      if (request.args.includes("ls")) {
        return completedProcess(JSON.stringify({ dependencies: { example: { version: "1.0.0" } } }));
      }
      return completedProcess("ok");
    });

    const report = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(report.checks.find((check) => check.id === "prepare_environment")?.status).toBe("passed");
    expect(calls.find((call) => call.args.includes("ci"))?.cwd).toBe(appDir);
    expect(calls.some((call) => call.args.includes("run") && call.args.includes("test") && call.cwd === appDir)).toBe(true);
    expect(calls.some((call) => call.args.includes("run") && call.args.includes("build") && call.cwd === appDir)).toBe(true);
  });

  it("prepares a Python project at an arbitrary nested path using its own manifests", async () => {
    const projectDir = path.join(workspacePath, "modules", "data-engine", "runtime");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "requirements-quality.txt"), "pytest\n", "utf8");
    const nestedPython = process.platform === "win32"
      ? path.join(projectDir, ".venv", "Scripts", "python.exe")
      : path.join(projectDir, ".venv", "bin", "python");
    const calls: AgentProcessRequest[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      calls.push(request);
      if (request.args.includes("venv")) {
        fs.mkdirSync(path.dirname(nestedPython), { recursive: true });
        fs.writeFileSync(nestedPython, "", "utf8");
      }
      return completedProcess("ok");
    });

    const report = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(report.checks.find((check) => check.id === "prepare_environment")?.status).toBe("passed");
    expect(calls.some((call) => call.args.join(" ").endsWith("-m venv .venv") && call.cwd === projectDir)).toBe(true);
    expect(calls.some((call) => call.command === nestedPython && call.args.includes("-r")
      && call.args.includes("requirements-quality.txt") && call.cwd === projectDir)).toBe(true);
  });

  it("runs nested Python checks with the same project-local venv that preparation created", async () => {
    const frontendDir = path.join(workspacePath, "site", "client");
    const pythonDir = path.join(workspacePath, "services", "api");
    fs.mkdirSync(frontendDir, { recursive: true });
    fs.mkdirSync(path.join(pythonDir, "tests"), { recursive: true });
    fs.writeFileSync(path.join(frontendDir, "package.json"), "{\"name\":\"client\"}\n", "utf8");
    fs.writeFileSync(path.join(frontendDir, "package-lock.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(pythonDir, "pyproject.toml"), "[project]\nname = 'api'\n", "utf8");
    fs.writeFileSync(path.join(pythonDir, "tests", "test_api.py"), "def test_api(): pass\n", "utf8");
    const nestedPython = process.platform === "win32"
      ? path.join(pythonDir, ".venv", "Scripts", "python.exe")
      : path.join(pythonDir, ".venv", "bin", "python");
    const calls: AgentProcessRequest[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      calls.push(request);
      if (request.args.includes("venv")) {
        fs.mkdirSync(path.dirname(nestedPython), { recursive: true });
        fs.writeFileSync(nestedPython, "", "utf8");
      }
      return completedProcess("ok");
    });

    const report = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    const pytest = calls.find((call) => call.args.includes("pytest"));
    const compile = calls.find((call) => call.args.includes("compileall"));
    expect(report.checks.some((check) => check.id === "tests_full" || check.id.startsWith("tests_python"))).toBe(true);
    expect(pytest?.command).toBe(nestedPython);
    expect(pytest?.cwd).toBe(pythonDir);
    expect(compile?.command).toBe(nestedPython);
    expect(compile?.cwd).toBe(pythonDir);
  });

  it("does not install discovered example packages or ignored packaged builds", async () => {
    fs.writeFileSync(path.join(workspacePath, ".gitignore"), "release/\n", "utf8");
    fs.writeFileSync(path.join(workspacePath, "package.json"), JSON.stringify({
      name: "root-app",
      dependencies: { rootDependency: "1.0.0" }
    }), "utf8");
    fs.writeFileSync(path.join(workspacePath, "package-lock.json"), "{}\n", "utf8");
    const exampleDir = path.join(workspacePath, "examples", "with-redux");
    fs.mkdirSync(exampleDir, { recursive: true });
    fs.writeFileSync(path.join(exampleDir, "package.json"), JSON.stringify({
      name: "broken-example",
      dependencies: { deliberatelyMissing: "1.0.0" }
    }), "utf8");
    const ignoredBuild = path.join(workspacePath, "release", "win-unpacked", "resources", "app");
    fs.mkdirSync(ignoredBuild, { recursive: true });
    fs.writeFileSync(path.join(ignoredBuild, "package.json"), "{}\n", "utf8");
    const installCwds: string[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      if (request.args.includes("ci") || request.args.includes("install")) {
        installCwds.push(request.cwd);
        fs.mkdirSync(path.join(request.cwd, "node_modules"), { recursive: true });
      }
      if (request.args.includes("ls")) {
        return completedProcess(JSON.stringify({ dependencies: { rootDependency: { version: "1.0.0" } } }));
      }
      return completedProcess("ok");
    });

    const report = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(report.checks.find((check) => check.id === "prepare_environment")?.status).toBe("passed");
    expect(installCwds).toEqual([workspacePath]);
    expect(fs.existsSync(path.join(exampleDir, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(ignoredBuild, "node_modules"))).toBe(false);
  });

  it("caches Yarn Plug'n'Play installs without requiring node_modules", async () => {
    fs.writeFileSync(path.join(workspacePath, "package.json"), JSON.stringify({
      name: "pnp-app",
      dependencies: { "some-package": "1.0.0" }
    }), "utf8");
    fs.writeFileSync(path.join(workspacePath, "yarn.lock"), "__metadata:\n  version: 8\n", "utf8");
    let installs = 0;
    let yarnInstallArgs: string[] = [];
    const runner = new DeterministicValidationRunner(async (request) => {
      if (request.args.some((arg) => /yarn install/.test(arg)) || request.args.includes("install")) {
        installs += 1;
        yarnInstallArgs = request.args;
        fs.writeFileSync(path.join(workspacePath, ".pnp.cjs"), "// generated PnP loader\n", "utf8");
      }
      return completedProcess("ok");
    });

    await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });
    const second = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(installs).toBe(1);
    expect(yarnInstallArgs.join(" ")).toContain("--immutable");
    expect(yarnInstallArgs.join(" ")).not.toContain("--frozen-lockfile");
    expect(second.checks.find((check) => check.id === "prepare_environment")?.summary).toBe("nothing to prepare");
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
      if (request.args.includes("ci") || request.args.includes("install")) {
        fs.mkdirSync(path.join(request.cwd, "node_modules"), { recursive: true });
      }
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

  it("does not cache an npm install that fails dependency verification", async () => {
    fs.writeFileSync(path.join(workspacePath, "package.json"), "{\"name\":\"demo\",\"dependencies\":{\"vite\":\"1.0.0\"}}\n", "utf8");
    let installAttempts = 0;
    const runner = new DeterministicValidationRunner(async (request) => {
      if (request.args.some((arg) => arg === "install" || arg === "ci")) {
        installAttempts += 1;
        fs.mkdirSync(path.join(request.cwd, "node_modules"), { recursive: true });
        return completedProcess("install reported success");
      }
      if (request.args.includes("ls")) return completedProcess(JSON.stringify({
        dependencies: { vite: { missing: true, problems: ["missing: vite"] } },
        problems: ["missing: vite"]
      }), 1);
      return completedProcess("ok");
    });

    const first = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });
    const second = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(first.checks.find((check) => check.id === "prepare_environment")?.status).toBe("failed");
    expect(second.checks.find((check) => check.id === "prepare_environment")?.status).toBe("failed");
    expect(installAttempts).toBe(2);
  });

  it("accepts a complete npm install when npm ls reports only peer-dependency problems", async () => {
    fs.writeFileSync(path.join(workspacePath, "package.json"), JSON.stringify({
      name: "peer-app",
      dependencies: { vite: "1.0.0" }
    }), "utf8");
    let installs = 0;
    const runner = new DeterministicValidationRunner(async (request) => {
      if (request.args.includes("ci") || request.args.includes("install")) {
        installs += 1;
        fs.mkdirSync(path.join(request.cwd, "node_modules"), { recursive: true });
      }
      if (request.args.includes("ls")) return completedProcess(JSON.stringify({
        dependencies: { vite: { version: "1.0.0" } },
        problems: ["peer dep missing: optional-adapter"]
      }), 1, "npm error code ELSPROBLEMS\nnpm error invalid: optional-adapter");
      return completedProcess("ok");
    });

    const first = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });
    const second = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(first.checks.find((check) => check.id === "prepare_environment")).toMatchObject({ status: "passed" });
    expect(second.checks.find((check) => check.id === "prepare_environment")?.summary).toBe("nothing to prepare");
    expect(installs).toBe(1);
  });

  it("rejects an invalid direct npm dependency even when npm exits nonzero", async () => {
    fs.writeFileSync(path.join(workspacePath, "package.json"), JSON.stringify({
      name: "invalid-app",
      dependencies: { vite: "^1.0.0" }
    }), "utf8");
    const runner = new DeterministicValidationRunner(async (request) => {
      if (request.args.includes("ci")) fs.mkdirSync(path.join(request.cwd, "node_modules"), { recursive: true });
      if (request.args.includes("ls")) return completedProcess(JSON.stringify({
        dependencies: { vite: { version: "2.0.0", invalid: "^1.0.0", problems: ["invalid: vite@2.0.0"] } },
        problems: ["invalid: vite@2.0.0"]
      }), 1, "npm error code ELSPROBLEMS\nnpm error invalid: vite@2.0.0");
      return completedProcess("ok");
    });

    const report = await runner.run({ workspacePath, artifactsRoot, prepareEnvironment: true });

    expect(report.checks.find((check) => check.id === "prepare_environment")?.status).toBe("failed");
  });
});

function git(args: string[]): void {
  const result = spawnSync("git", ["-C", workspacePath, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function completedProcess(output: string, exitCode = 0, stderr = ""): AgentProcessResult {
  return {
    exitCode,
    stdout: output,
    stderr,
    aborted: false,
    timedOut: false,
    breakerReason: null,
    outputStats: {
      receivedChars: output.length + stderr.length,
      retainedChars: output.length + stderr.length,
      duplicateChunks: 0,
      truncatedChars: 0
    },
    durationMs: 10,
    tokenUsage: { inputTokens: 0, outputTokens: 0 }
  };
}
