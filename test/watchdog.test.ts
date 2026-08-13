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
  it("does not stop a goal with fewer than two finished steps", () => {
    const r = makeRun();
    const v = new GoalWatchdog(database).verdict(r);
    expect(v.stop).toBe(false);
  });

  it("stops on repeated identical failures in the same phase", () => {
    const r = makeRun();
    pushStep(r, "implementing", "failed", "step", "provider crash");
    pushStep(r, "implementing", "failed", "step", "provider crash");
    pushStep(r, "implementing", "failed", "step", "provider crash");
    const v = new GoalWatchdog(database).verdict(r);
    expect(v.stop).toBe(true);
    expect(v.reason).toBe("repeated_failure");
  });

  it("does NOT treat the same generic error across different phases as a loop", () => {
    const r = makeRun();
    pushStep(r, "testing", "failed", "step", "timeout");
    pushStep(r, "implementing", "failed", "step", "timeout");
    const v = new GoalWatchdog(database).verdict(r);
    expect(v.stop).toBe(false);
  });

  it("stops when change-request reasons repeat with no work produced between reviews", () => {
    const r = makeRun();
    pushStep(r, "reviewing", "changes_requested", "add error handling");
    pushStep(r, "reviewing", "changes_requested", "add error handling");
    pushStep(r, "reviewing", "changes_requested", "add error handling");
    const v = new GoalWatchdog(database).verdict(r);
    expect(v.stop).toBe(true);
    expect(v.reason).toBe("same_decision");
  });

  it("does NOT stop when new work (completed step) is produced between reviews", () => {
    const r = makeRun();
    pushStep(r, "reviewing", "changes_requested", "add error handling");
    // Agent fixed the code (a completed step with a different summary).
    pushStep(r, "implementing", "completed", "add error handlers");
    pushStep(r, "reviewing", "changes_requested", "add error handling");
    const v = new GoalWatchdog(database).verdict(r);
    expect(v.stop).toBe(false);
  });

  it("stops on a run of identical consecutive summaries", () => {
    const r = makeRun();
    pushStep(r, "implementing", "completed", "thinking about the design");
    pushStep(r, "implementing", "completed", "thinking about the design");
    pushStep(r, "implementing", "completed", "thinking about the design");
    const v = new GoalWatchdog(database).verdict(r);
    expect(v.stop).toBe(true);
    expect(v.reason).toBe("no_progress");
  });

  it("does NOT stop a goal that is making forward progress", () => {
    const r = makeRun();
    pushStep(r, "implementing", "completed", "add User model");
    pushStep(r, "implementing", "completed", "add auth middleware");
    pushStep(r, "implementing", "completed", "add login route");
    pushStep(r, "testing", "completed", "add tests");
    const v = new GoalWatchdog(database).verdict(r);
    expect(v.stop).toBe(false);
  });

  it("does NOT stop a goal whose repeated summaries are generic phase-completion placeholders", () => {
    const r = makeRun();
    // Three identical completion templates (same status + summary) — but they
    // are generic placeholders (note the trailing '.' the providers emit), not
    // evidence of a loop. Regression: this killed a live reviewing goal.
    pushStep(r, "reviewing", "completed", "Claude concluiu a fase reviewing.");
    pushStep(r, "reviewing", "completed", "Claude concluiu a fase reviewing.");
    pushStep(r, "reviewing", "completed", "Claude concluiu a fase reviewing.");
    const v = new GoalWatchdog(database).verdict(r);
    expect(v.stop).toBe(false);
  });

  it("STILL stops a goal whose genuinely stuck steps use the SAME informative summary", () => {
    const r = makeRun();
    pushStep(r, "implementing", "completed", "cannot resolve the database connection for the auth module");
    pushStep(r, "implementing", "completed", "cannot resolve the database connection for the auth module");
    pushStep(r, "implementing", "completed", "cannot resolve the database connection for the auth module");
    const v = new GoalWatchdog(database).verdict(r);
    expect(v.stop).toBe(true);
    expect(v.reason).toBe("no_progress");
  });

  it("does NOT treat errors sharing a long common prefix as identical", () => {
    const r = makeRun();
    pushStep(r, "implementing", "failed", "step", "SyntaxError: unexpected token X. Long stack trace line one that keeps going for the full length");
    pushStep(r, "implementing", "failed", "step", "SyntaxError: unexpected token Y. Long stack trace line two that keeps going for the full len");
    const v = new GoalWatchdog(database).verdict(r);
    expect(v.stop).toBe(false);
  });
});
