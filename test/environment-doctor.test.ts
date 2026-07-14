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

  it("does not borrow project dependencies for an isolated task worktree", () => {
    const isolatedWorktree = path.join(runtimeRoot, "worktrees", "maestro", "task-9");
    fs.mkdirSync(isolatedWorktree, { recursive: true });
    fs.writeFileSync(path.join(isolatedWorktree, "package-lock.json"), "{}", "utf8");

    const report = runEnvironmentDoctor({
      config: doctorConfig(),
      project: project(process.cwd()),
      task: task(isolatedWorktree)
    });

    expect(report.status).toBe("environment_blocked");
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "typescript",
      status: "failed"
    }));
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
  });
});

function doctorConfig() {
  return loadConfig(process.cwd(), {
    TELEGRAM_BOT_TOKEN: "configured",
    MAESTRO_EXECUTION_ROOT: runtimeRoot,
    MAESTRO_NODE_VERSION: "20.17.0",
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
