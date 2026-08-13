import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, MaestroDatabase, GoalRunRecord } from "../src/db.js";
import { GoalWatchdog } from "../src/goals/watchdog.js";

let tempDir: string;
let database: MaestroDatabase;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-watchdog-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
});

afterEach(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Creates and persists a real run row (with a project + task), returns its record. */
function makeRun(overrides: Partial<GoalRunRecord> = {}, maxSteps = 100): GoalRunRecord {
  database.registerProject({ key: "wd", path: tempDir });
  const task = database.createTask("watchdog task", "dashboard", "wd");
  const created = database.createGoalRun(task.id, maxSteps);
  return { ...created, ...overrides };
}

/** Creates and finishes a step so it appears in listGoalSteps. */
function pushStep(run: GoalRunRecord, phase: "planning" | "implementing" | "testing" | "reviewing", status: "completed" | "failed" | "changes_requested" | "blocked", summary: string, error: string | null = null) {
  const step = database.createGoalStep(run.id, phase, "codex");
  database.finishGoalStep({ id: step.id, status, summary, error, durationMs: 500 });
}

describe.sequential("GoalWatchdog", () => {
  it("does not stop a goal with no finished steps", () => {
    const r = makeRun();
    const v = new GoalWatchdog(database, { workspaceHash: () => "a" }).verdict(r);
    expect(v.stop).toBe(false);
  });

  it("stops on repeated identical failures", () => {
    const r = makeRun({ stepCount: 6 });
    pushStep(r, "implementing", "failed", "step", "provider crash");
    pushStep(r, "implementing", "failed", "step", "provider crash");
    pushStep(r, "implementing", "failed", "step", "provider crash");
    const v = new GoalWatchdog(database, { workspaceHash: () => "a", threshold: 2 }).verdict(r);
    expect(v.stop).toBe(true);
    expect(v.reason).toBe("repeated_failure");
  });

  it("stops on repeated same change-request reasons with no workspace change", () => {
    const r = makeRun({ currentPhase: "reviewing", stepCount: 4 });
    pushStep(r, "reviewing", "changes_requested", "add error handling");
    pushStep(r, "reviewing", "changes_requested", "add error handling");
    pushStep(r, "reviewing", "changes_requested", "add error handling");
    const v = new GoalWatchdog(database, { workspaceHash: () => "same-hash", threshold: 2 }).verdict(r);
    expect(v.stop).toBe(true);
    expect(v.reason).toBe("same_decision");
  });

  it("stops on repeated identical summaries with an unchanged workspace", () => {
    const r = makeRun({ stepCount: 4 });
    pushStep(r, "implementing", "completed", "thinking about the design");
    pushStep(r, "implementing", "completed", "thinking about the design");
    pushStep(r, "implementing", "completed", "thinking about the design");
    const v = new GoalWatchdog(database, { workspaceHash: () => "static", threshold: 2 }).verdict(r);
    expect(v.stop).toBe(true);
    expect(v.reason).toBe("no_progress");
  });

  it("does NOT stop a goal that is making forward progress", () => {
    const r = makeRun({ stepCount: 6 });
    pushStep(r, "implementing", "completed", "add User model");
    pushStep(r, "implementing", "completed", "add auth middleware");
    pushStep(r, "implementing", "completed", "add login route");
    pushStep(r, "testing", "completed", "add tests");
    const v = new GoalWatchdog(database, { workspaceHash: () => "changing", threshold: 2 }).verdict(r);
    expect(v.stop).toBe(false);
  });
});
