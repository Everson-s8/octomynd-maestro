import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/agents/registry.js";
import { loadConfig } from "../src/config.js";
import { createDatabase, MaestroDatabase, ProjectRecord, TaskRecord } from "../src/db.js";
import {
  EnvironmentBlockedError,
  runEnvironmentDoctor
} from "../src/environment/doctor.js";
import type { EnvironmentDoctorReport } from "../src/environment/types.js";
import { GoalCoordinator } from "../src/goals/coordinator.js";

let runtimeRoot: string;
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-doctor-test-"));
  runtimeRoot = process.platform === "win32"
    ? path.join(path.parse(process.cwd()).root, "MaestroRuntime", `doctor-test-${process.pid}`)
    : path.join(tempDir, "runtime");
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

describe("Environment Doctor", () => {
  it("reports a prepared project and ready provider", () => {
    const report = runEnvironmentDoctor({
      config: doctorConfig(),
      project: project(process.cwd()),
      providers: [{
        id: "codex",
        health: { state: "ready", detail: "available", checkedAt: new Date().toISOString() }
      }]
    });

    expect(report.status).toBe("ready");
    expect(report.fingerprintId).toHaveLength(16);
    expect(report.checks.filter((item) => item.status === "failed")).toEqual([]);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "native_runtime",
      status: "passed"
    }));
  }, 15_000);

  it("uses the Maestro toolchain when a project worktree has no node_modules of its own", () => {
    // The deterministic toolchain (tsc, vitest, better-sqlite3) belongs to the
    // Maestro runtime, not to the target project. A project worktree that has
    // only a stubbed node_modules (or none) must not block on the Maestro's own
    // tools; the doctor should fall back to the running Maestro's node_modules.
    const partial = path.join(tempDir, "task-partial");
    fs.mkdirSync(path.join(partial, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(partial, "package.json"), JSON.stringify({ name: "project", dependencies: {} }));

    const report = runEnvironmentDoctor({
      config: doctorConfig(),
      project: project(tempDir),
      task: task(partial)
    });

    // The Maestro provides the toolchain, so these are not missing in the project.
    for (const name of ["native_runtime", "typescript", "test_runner"]) {
      const check = report.checks.find((c) => c.name === name);
      expect(check, `${name} check should exist`).toBeDefined();
      expect(["passed", "skipped"], `${name} should not be unavailable`).toContain(check!.status);
    }
  }, 15_000);

  it("prefers the task worktree's own complete toolchain (self-development)", () => {
    // Maestro self-development: a task worktree that installs its own toolchain
    // (e.g. a bump of tsc/vitest/better-sqlite3 followed by `npm ci`) must be
    // validated against that freshly-installed toolchain, NOT the daemon's older
    // one. Build a worktree with a complete node_modules and confirm the doctor
    // reports ready against it (native_runtime/typescript/test_runner not blocked).
    const selfWorktree = path.join(tempDir, "task-self");
    fs.mkdirSync(path.join(selfWorktree, "node_modules", ".bin"), { recursive: true });
    // Windows shims: tsc.cmd / vitest.cmd; on POSIX the bare names are checked.
    const tscBin = process.platform === "win32" ? "tsc.cmd" : "tsc";
    const vitestBin = process.platform === "win32" ? "vitest.cmd" : "vitest";
    fs.writeFileSync(path.join(selfWorktree, "node_modules", ".bin", tscBin), "#!/bin/sh\n");
    fs.writeFileSync(path.join(selfWorktree, "node_modules", ".bin", vitestBin), "#!/bin/sh\n");
    fs.mkdirSync(path.join(selfWorktree, "node_modules", "better-sqlite3", "build", "Release"), { recursive: true });
    fs.writeFileSync(path.join(selfWorktree, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), "x");
    fs.writeFileSync(path.join(selfWorktree, "package.json"), JSON.stringify({ name: "self" }));

    const report = runEnvironmentDoctor({
      config: doctorConfig(),
      project: project(tempDir),
      task: task(selfWorktree)
    });

    // The worktree's own toolchain is honored; no dependency-path block for it.
    expect(report.checks).toContainEqual(expect.objectContaining({ name: "typescript", status: "passed" }));
  }, 15_000);

  it("blocks a legacy worktree before a long Goal", () => {
    const userProfile = process.env.USERPROFILE || "C:\\Users\\test";
    const legacyWorktree = path.join(userProfile, "Documents", "legacy-task");
    const report = runEnvironmentDoctor({
      config: doctorConfig(),
      project: project(process.cwd()),
      task: task(legacyWorktree)
    });

    expect(report.status).toBe("environment_blocked");
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "worktree",
      status: "failed",
      classification: "environment_blocked"
    }));
  }, 15_000);

  it("distinguishes provider quota from an environment failure", () => {
    const report = runEnvironmentDoctor({
      config: doctorConfig(),
      project: project(process.cwd()),
      providers: [{
        id: "codex",
        health: { state: "quota", detail: "limit", checkedAt: new Date().toISOString() }
      }]
    });

    expect(report.status).toBe("quota");
    expect(report.recommendedAction).toContain("quota");
  }, 15_000);

  it("uses the Maestro toolchain for a non-root-Node worktree (monorepo target)", () => {
    // A target project that is NOT a root-Node repo (e.g. Next.js in a
    // subfolder, a Java backend at the root) has no lockfile at the worktree
    // root, so the doctor must not demand a toolchain there — it falls back to
    // the running Maestro runtime's node_modules instead of blocking.
    const isolatedWorktree = path.join(runtimeRoot, "worktrees", "maestro", "task-9");
    fs.mkdirSync(isolatedWorktree, { recursive: true });
    // No package-lock.json at root (a monorepo / non-root-Node target).
    fs.writeFileSync(path.join(isolatedWorktree, "README.md"), "# target\n");

    const report = runEnvironmentDoctor({
      config: doctorConfig(),
      project: project(process.cwd()),
      task: task(isolatedWorktree)
    });

    // The toolchain is satisfied by the Maestro runtime, never borrowed from the
    // target project root being worked on.
    const check = report.checks.find((c) => c.name === "typescript");
    expect(check, "typescript check should exist").toBeDefined();
    expect(["passed", "skipped"], "typescript should not be unavailable").toContain(check!.status);
  }, 15_000);

  it("does not borrow the packaged Maestro toolchain for a root Node project", () => {
    const isolatedWorktree = path.join(runtimeRoot, "worktrees", "maestro", "task-root-node");
    fs.mkdirSync(isolatedWorktree, { recursive: true });
    fs.writeFileSync(path.join(isolatedWorktree, "package-lock.json"), JSON.stringify({ name: "target", lockfileVersion: 3 }));

    const previousMode = process.env.MAESTRO_RUNTIME_MODE;
    const previousRoot = process.env.MAESTRO_RUNTIME_ROOT;
    process.env.MAESTRO_RUNTIME_MODE = "packaged";
    process.env.MAESTRO_RUNTIME_ROOT = process.cwd();
    try {
      const report = runEnvironmentDoctor({
        config: doctorConfig(),
        project: project(process.cwd()),
        task: task(isolatedWorktree)
      });

      expect(report.status).toBe("environment_blocked");
      expect(report.checks).toContainEqual(expect.objectContaining({
        name: "npm",
        status: "skipped",
        summary: expect.stringContaining("does not install project dependencies")
      }));
      for (const name of ["native_runtime", "typescript", "test_runner"]) {
        expect(report.checks).toContainEqual(expect.objectContaining({
          name,
          status: "failed",
          classification: "environment_blocked"
        }));
      }
    } finally {
      if (previousMode === undefined) delete process.env.MAESTRO_RUNTIME_MODE;
      else process.env.MAESTRO_RUNTIME_MODE = previousMode;
      if (previousRoot === undefined) delete process.env.MAESTRO_RUNTIME_ROOT;
      else process.env.MAESTRO_RUNTIME_ROOT = previousRoot;
    }
  }, 15_000);

  it("accepts an external prepared Node project without Maestro's native dependency", () => {
    const isolatedWorktree = path.join(runtimeRoot, "worktrees", "maestro", "task-external-node");
    const binDir = path.join(isolatedWorktree, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(isolatedWorktree, "package-lock.json"), JSON.stringify({ name: "external", lockfileVersion: 3 }));
    fs.writeFileSync(path.join(isolatedWorktree, "package.json"), JSON.stringify({
      name: "external",
      devDependencies: { typescript: "^5", vitest: "^3" }
    }));
    const tscBin = process.platform === "win32" ? "tsc.cmd" : "tsc";
    const vitestBin = process.platform === "win32" ? "vitest.cmd" : "vitest";
    fs.writeFileSync(path.join(binDir, tscBin), "#!/bin/sh\n");
    fs.writeFileSync(path.join(binDir, vitestBin), "#!/bin/sh\n");

    const previousMode = process.env.MAESTRO_RUNTIME_MODE;
    process.env.MAESTRO_RUNTIME_MODE = "packaged";
    try {
      const report = runEnvironmentDoctor({
        config: doctorConfig(),
        project: project(process.cwd()),
        task: task(isolatedWorktree)
      });

      expect(report.checks).toContainEqual(expect.objectContaining({ name: "native_runtime", status: "skipped" }));
      expect(report.checks).toContainEqual(expect.objectContaining({ name: "typescript", status: "passed" }));
      expect(report.checks).toContainEqual(expect.objectContaining({ name: "test_runner", status: "passed" }));
    } finally {
      if (previousMode === undefined) delete process.env.MAESTRO_RUNTIME_MODE;
      else process.env.MAESTRO_RUNTIME_MODE = previousMode;
    }
  }, 15_000);

  it("prevents Goal creation when preflight is blocked", () => {
    const database = createDatabase(path.join(tempDir, "maestro.db"));
    try {
      database.registerProject({ key: "boo", path: tempDir, defaultBranch: "main" });
      const created = database.createTask("blocked goal", "dashboard", "boo");
      database.updateTaskWorktree({
        id: created.id,
        status: "planning",
        branchName: "maestro/task-blocked",
        worktreePath: path.join(tempDir, "worktree")
      });
      const coordinator = coordinatorWithPreflight(database, blockedReport(created.id));

      expect(() => coordinator.start(created.id)).toThrow(EnvironmentBlockedError);
      expect(database.getTask(created.id).status).toBe("blocked");
      expect(database.listGoalRuns()).toEqual([]);
      expect(database.listEvents().some((event) => event.type === "goal.environment_blocked")).toBe(true);
    } finally {
      database.close();
    }
  }, 20_000);
});

function doctorConfig() {
  return loadConfig(process.cwd(), {
    TELEGRAM_BOT_TOKEN: "configured",
    MAESTRO_EXECUTION_ROOT: runtimeRoot,
    MAESTRO_NODE_VERSION: process.version.replace(/^v/, ""),
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    USERPROFILE: process.env.USERPROFILE,
    SystemDrive: process.env.SystemDrive
  });
}

function project(projectPath: string): ProjectRecord {
  return {
    id: 1,
    key: "maestro",
    name: "Maestro",
    path: projectPath,
    defaultBranch: "main",
    createdAt: "now",
    updatedAt: "now"
  };
}

function task(worktreePath: string): TaskRecord {
  return {
    id: 9,
    projectId: 1,
    projectKey: "maestro",
    projectName: "Maestro",
    text: "doctor",
    status: "planning",
    source: "dashboard",
    branchName: "maestro/task-9",
    worktreePath,
    createdAt: "now",
    updatedAt: "now"
  };
}

function blockedReport(taskId: number): EnvironmentDoctorReport {
  return {
    status: "environment_blocked",
    summary: "Execution environment environment_blocked: worktree.",
    recommendedAction: "Move the worktree.",
    checkedAt: new Date().toISOString(),
    projectKey: "boo",
    taskId,
    fingerprintId: "0123456789abcdef",
    requiredCapabilities: ["planning"],
    checks: [{
      name: "worktree",
      status: "failed",
      summary: "unsafe",
      classification: "environment_blocked",
      evidence: []
    }]
  };
}

function coordinatorWithPreflight(database: MaestroDatabase, report: EnvironmentDoctorReport): GoalCoordinator {
  return new GoalCoordinator(
    database,
    new AgentRegistry([]),
    path.join(tempDir, "artifacts"),
    1_000,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => report
  );
}
