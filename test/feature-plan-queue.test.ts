import SqliteDatabase from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApplicationCommands } from "../src/commands/application-commands.js";
import { ApplicationCommandError } from "../src/commands/errors.js";
import { MaestroConfig } from "../src/config.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { createDatabase, MaestroDatabase } from "../src/db.js";

let tempDir: string;
let database: MaestroDatabase;
let commands: ApplicationCommands;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-queue-test-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
  database.registerProject({ key: "boo", name: "Boo", path: tempDir });
  database.registerProject({ key: "far", name: "Far", path: tempDir });
  commands = new ApplicationCommands(database);
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Feature Plan Queue Scheduler Block 1", () => {
  it("initializes feature plans with queued status, default priority 0, and not paused", () => {
    const task = database.createTask("task for default queue", "dashboard", "boo");
    const result = commands.createFeaturePlan(
      { channel: "dashboard", userId: "10", username: "alice" },
      {
        projectKey: "boo",
        objective: "Feature plan queue state initial defaults.",
        acceptanceCriteria: ["Status is queued", "Priority is 0", "isPaused is false"],
        taskIds: [task.id]
      }
    );

    expect(result.plan.status).toBe("queued");
    expect(result.plan.priority).toBe(0);
    expect(result.plan.isPaused).toBe(false);
    expect(result.plan.pausedAt).toBeNull();
    expect(result.plan.pauseReason).toBeNull();
    expect(result.plan.blockedAt).toBeNull();
    expect(result.plan.blockedReason).toBeNull();

    const history = database.getFeaturePlanHistory(result.plan.id);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].action).toBe("create");
    expect(history[0].toStatus).toBe("queued");
    expect(history[0].actorUserId).toBe("10");
  });

  it("handles priority updates and queue ordering (priority DESC, creation ASC)", () => {
    const t1 = database.createTask("task for plan 1", "dashboard", "boo");
    const t2 = database.createTask("task for plan 2", "dashboard", "boo");
    const t3 = database.createTask("task for plan 3", "dashboard", "boo");

    const p1 = commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "First plan created",
      acceptanceCriteria: ["Pass"],
      taskIds: [t1.id]
    }).plan;

    const p2 = commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "Second plan created",
      acceptanceCriteria: ["Pass"],
      taskIds: [t2.id],
      priority: 10
    }).plan;

    const p3 = commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "Third plan created",
      acceptanceCriteria: ["Pass"],
      taskIds: [t3.id],
      priority: 5
    }).plan;

    let queue = database.listFeaturePlanQueue("boo");
    expect(queue.map((item) => item.plan.id)).toEqual([p2.id, p3.id, p1.id]);

    commands.updateFeaturePlanPriority({ channel: "dashboard" }, p1.id, 20);
    queue = database.listFeaturePlanQueue("boo");
    expect(queue.map((item) => item.plan.id)).toEqual([p1.id, p2.id, p3.id]);

    const history = database.getFeaturePlanHistory(p1.id);
    const priorityEvent = history.find((entry) => entry.action === "set_priority");
    expect(priorityEvent).toBeDefined();
    expect(priorityEvent?.metadata.priority).toBe(20);
  });

  it("supports pause and resume, blocking eligibility while paused", () => {
    const task = database.createTask("pause test task", "dashboard", "boo");
    const plan = commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "Plan to test pause and resume",
      acceptanceCriteria: ["Pausable"],
      taskIds: [task.id]
    }).plan;

    let eligibility = commands.getFeaturePlanEligibility(plan.id);
    expect(eligibility.eligible).toBe(true);

    const paused = commands.pauseFeaturePlan({ channel: "dashboard" }, plan.id, "Waiting for review window");
    expect(paused.plan.isPaused).toBe(true);
    expect(paused.plan.pauseReason).toBe("Waiting for review window");
    expect(paused.plan.pausedAt).not.toBeNull();

    eligibility = commands.getFeaturePlanEligibility(plan.id);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockedByPaused).toBe(true);
    expect(eligibility.reason).toContain("Waiting for review window");

    const resumed = commands.resumeFeaturePlan({ channel: "dashboard" }, plan.id);
    expect(resumed.plan.isPaused).toBe(false);
    expect(resumed.plan.pausedAt).toBeNull();
    expect(resumed.plan.pauseReason).toBeNull();

    eligibility = commands.getFeaturePlanEligibility(plan.id);
    expect(eligibility.eligible).toBe(true);

    const history = database.getFeaturePlanHistory(plan.id);
    expect(history.some((item) => item.action === "pause")).toBe(true);
    expect(history.some((item) => item.action === "resume")).toBe(true);
  });

  it("validates dependencies: rejects self, cross-project, and cyclic dependencies", () => {
    const t1 = database.createTask("task for boo plan 1", "dashboard", "boo");
    const t2 = database.createTask("task for boo plan 2", "dashboard", "boo");
    const t3 = database.createTask("task for boo plan 3", "dashboard", "boo");
    const tFar = database.createTask("task for far plan", "dashboard", "far");

    const p1 = commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "Boo plan 1",
      acceptanceCriteria: ["Criteria"],
      taskIds: [t1.id]
    }).plan;

    const p2 = commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "Boo plan 2",
      acceptanceCriteria: ["Criteria"],
      taskIds: [t2.id],
      dependsOnFeaturePlanIds: [p1.id]
    }).plan;

    const pFar = commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "far",
      objective: "Far project plan",
      acceptanceCriteria: ["Criteria"],
      taskIds: [tFar.id]
    }).plan;

    // Self dependency
    expectCommandError(() => commands.addFeaturePlanDependency({ channel: "dashboard" }, p1.id, p1.id), "validation");

    // Cross-project dependency
    expectCommandError(() => commands.addFeaturePlanDependency({ channel: "dashboard" }, p1.id, pFar.id), "validation");

    // Cyclic dependency: p1 -> p2 (trying p1 depends on p2 when p2 already depends on p1)
    expectCommandError(() => commands.addFeaturePlanDependency({ channel: "dashboard" }, p1.id, p2.id), "validation");

    // Multi-step cyclic dependency: p3 -> p2 -> p1, trying p1 -> p3
    const p3 = commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "Boo plan 3",
      acceptanceCriteria: ["Criteria"],
      taskIds: [t3.id],
      dependsOnFeaturePlanIds: [p2.id]
    }).plan;

    expectCommandError(() => commands.addFeaturePlanDependency({ channel: "dashboard" }, p1.id, p3.id), "validation");

    // Dependencies listed correctly
    const p2Deps = database.listFeaturePlanDependencies(p2.id);
    expect(p2Deps.map((d) => d.dependsOnFeaturePlanId)).toEqual([p1.id]);

    // Removal of dependency
    commands.removeFeaturePlanDependency({ channel: "dashboard" }, p2.id, p1.id);
    expect(database.listFeaturePlanDependencies(p2.id)).toHaveLength(0);
  });

  it("enforces predecessor dependency completion for eligibility", () => {
    const t1 = database.createTask("task for predecessor", "dashboard", "boo");
    const t2 = database.createTask("task for successor", "dashboard", "boo");

    const p1 = commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "Predecessor plan",
      acceptanceCriteria: ["Criteria"],
      taskIds: [t1.id]
    }).plan;

    const p2 = commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "Successor plan",
      acceptanceCriteria: ["Criteria"],
      taskIds: [t2.id],
      dependsOnFeaturePlanIds: [p1.id]
    }).plan;

    // p1 is queued -> p2 is blocked by p1
    let el2 = commands.getFeaturePlanEligibility(p2.id);
    expect(el2.eligible).toBe(false);
    expect(el2.blockedDependencies.map((d) => d.id)).toEqual([p1.id]);
    expect(el2.reason).toContain(`Waiting on predecessor Feature Plan #${p1.id}`);

    // Advance p1 to active -> p2 is still blocked
    commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, p1.id, "admitted");
    commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, p1.id, "active");
    el2 = commands.getFeaturePlanEligibility(p2.id);
    expect(el2.eligible).toBe(false);

    // Complete p1 -> p2 becomes eligible
    commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, p1.id, "waiting_review");
    commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, p1.id, "waiting_merge");
    commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, p1.id, "completed");

    el2 = commands.getFeaturePlanEligibility(p2.id);
    expect(el2.eligible).toBe(true);
  });

  it("enforces single active plan per project constraint on eligibility while allowing cross-project concurrency", () => {
    const tBoo1 = database.createTask("task boo 1", "dashboard", "boo");
    const tBoo2 = database.createTask("task boo 2", "dashboard", "boo");
    const tFar1 = database.createTask("task far 1", "dashboard", "far");

    const pBoo1 = commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "Boo active plan",
      acceptanceCriteria: ["Criteria"],
      taskIds: [tBoo1.id]
    }).plan;

    const pBoo2 = commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "Boo queued plan",
      acceptanceCriteria: ["Criteria"],
      taskIds: [tBoo2.id]
    }).plan;

    const pFar1 = commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "far",
      objective: "Far active plan",
      acceptanceCriteria: ["Criteria"],
      taskIds: [tFar1.id]
    }).plan;

    // pBoo1 is admitted
    commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, pBoo1.id, "admitted");

    // pBoo2 is blocked by active pBoo1
    const elBoo2 = commands.getFeaturePlanEligibility(pBoo2.id);
    expect(elBoo2.eligible).toBe(false);
    expect(elBoo2.blockedByActiveProjectPlan?.id).toBe(pBoo1.id);
    expect(elBoo2.reason).toContain("already has an active Feature Plan");

    // pFar1 in project 'far' is NOT blocked by pBoo1 in project 'boo'
    const elFar1 = commands.getFeaturePlanEligibility(pFar1.id);
    expect(elFar1.eligible).toBe(true);
  });

  it("executes valid lifecycle transitions and supports blocked -> queued recovery", () => {
    const task = database.createTask("lifecycle task", "dashboard", "boo");
    const plan = commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "Lifecycle transition test plan",
      acceptanceCriteria: ["Criteria"],
      taskIds: [task.id]
    }).plan;

    // queued -> admitted
    let updated = commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, plan.id, "admitted");
    expect(updated.plan.status).toBe("admitted");
    expect(updated.plan.admittedAt).not.toBeNull();

    // admitted -> active
    updated = commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, plan.id, "active");
    expect(updated.plan.status).toBe("active");

    // active -> blocked
    updated = commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, plan.id, "blocked", "Integration test failed");
    expect(updated.plan.status).toBe("blocked");
    expect(updated.plan.blockedReason).toBe("Integration test failed");
    expect(updated.plan.blockedAt).not.toBeNull();

    // blocked -> queued (RECOVERY)
    updated = commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, plan.id, "queued");
    expect(updated.plan.status).toBe("queued");
    expect(updated.plan.blockedReason).toBeNull();
    expect(updated.plan.blockedAt).toBeNull();

    // queued -> admitted -> active -> waiting_review -> waiting_merge -> completed
    commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, plan.id, "admitted");
    commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, plan.id, "active");
    commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, plan.id, "waiting_review");
    commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, plan.id, "waiting_merge");
    updated = commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, plan.id, "completed");
    expect(updated.plan.status).toBe("completed");
    expect(updated.plan.completedAt).not.toBeNull();

    // Rejects transition out of completed
    expectCommandError(() => commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, plan.id, "queued"), "conflict");

    // History log contains all steps
    const history = database.getFeaturePlanHistory(plan.id);
    const statuses = history.map((item) => item.toStatus);
    expect(statuses).toContain("queued");
    expect(statuses).toContain("admitted");
    expect(statuses).toContain("active");
    expect(statuses).toContain("blocked");
    expect(statuses).toContain("completed");
  });

  it("serves REST APIs for queue management and auditable history", async () => {
    const task = database.createTask("api queue task", "dashboard", "boo");
    const server = createDashboardServer({ config: testConfig(), database, staticRoot: tempDir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      // Create with priority and dependency
      const createRes = await fetch(`http://127.0.0.1:${port}/api/feature-plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectKey: "boo",
          objective: "API Queue Test Feature Plan",
          acceptanceCriteria: ["API works"],
          taskIds: [task.id],
          priority: 15
        })
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json() as { plan: { id: number; priority: number; status: string } };
      expect(created.plan.priority).toBe(15);
      expect(created.plan.status).toBe("queued");

      // Pause
      const pauseRes = await fetch(`http://127.0.0.1:${port}/api/feature-plans/${created.plan.id}/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Paused via API" })
      });
      expect(pauseRes.status).toBe(200);
      const paused = await pauseRes.json() as { plan: { isPaused: boolean; pauseReason: string } };
      expect(paused.plan.isPaused).toBe(true);

      // Resume
      const resumeRes = await fetch(`http://127.0.0.1:${port}/api/feature-plans/${created.plan.id}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      expect(resumeRes.status).toBe(200);
      const resumed = await resumeRes.json() as { plan: { isPaused: boolean } };
      expect(resumed.plan.isPaused).toBe(false);

      // Priority update
      const prioRes = await fetch(`http://127.0.0.1:${port}/api/feature-plans/${created.plan.id}/priority`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: 42 })
      });
      expect(prioRes.status).toBe(200);

      // Eligibility
      const eligRes = await fetch(`http://127.0.0.1:${port}/api/feature-plans/${created.plan.id}/eligibility`);
      expect(eligRes.status).toBe(200);
      const eligPayload = await eligRes.json() as { eligibility: { eligible: boolean } };
      expect(eligPayload.eligibility.eligible).toBe(true);

      // History
      const histRes = await fetch(`http://127.0.0.1:${port}/api/feature-plans/${created.plan.id}/history`);
      expect(histRes.status).toBe(200);
      const histPayload = await histRes.json() as { history: Array<{ action: string }> };
      expect(histPayload.history.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("migrates legacy databases with planned status to queued transparently", () => {
    database.close();
    const legacyPath = path.join(tempDir, "legacy-queue.db");
    const raw = new SqliteDatabase(legacyPath);
    raw.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        default_branch TEXT NOT NULL DEFAULT 'main',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        source TEXT NOT NULL,
        branch_name TEXT,
        worktree_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );
      CREATE TABLE feature_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        objective TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'planned',
        source TEXT NOT NULL,
        created_by_user_id TEXT,
        created_by_username TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        cancelled_at TEXT,
        cancel_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );
      INSERT INTO projects (key, name, path, default_branch, created_at, updated_at)
      VALUES ('boo', 'Boo', '${escapeSql(tempDir)}', 'main', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
      INSERT INTO feature_plans (project_id, objective, acceptance_criteria_json, status, source, revision, created_at, updated_at)
      VALUES (1, 'Legacy planned feature plan', '[]', 'planned', 'dashboard', 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    `);
    raw.close();

    database = createDatabase(legacyPath);
    commands = new ApplicationCommands(database);

    const legacyPlan = database.getFeaturePlan(1);
    expect(legacyPlan.status).toBe("queued");
    expect(legacyPlan.priority).toBe(0);
    expect(legacyPlan.isPaused).toBe(false);
  });
});

function testConfig(): MaestroConfig {
  return {
    projectName: "test",
    databasePath: path.join(tempDir, "maestro.db"),
    worktreesPath: path.join(tempDir, "worktrees"),
    execution: {
      rootPath: tempDir,
      worktreesPath: path.join(tempDir, "worktrees"),
      expectedNodeVersion: "20.17.0",
      supportedNodeRange: ">=20.17.0 <21"
    },
    dashboard: { enabled: true, host: "127.0.0.1", port: 4787 },
    autopilot: { enabled: true, pollIntervalMs: 30_000, maxConcurrentGoals: 1 },
    runtime: { tokenEfficient: true },
    workGraph: { adoptionMode: "off" },
    skills: {
      enabled: false,
      catalogPath: path.join(tempDir, "skills"),
      versionsPath: path.join(tempDir, "versions"),
      projectKey: "boo",
      curator: { staleDays: 30, autoArchiveEnabled: false, pollIntervalMs: 21_600_000 }
    },
    telegram: { botToken: "test-token", allowedUserId: "123" }
  };
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function expectCommandError(
  callback: () => unknown,
  code: "validation" | "not_found" | "conflict"
): void {
  try {
    callback();
    expect.fail(`Expected ApplicationCommandError with code ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicationCommandError);
    expect((error as ApplicationCommandError).code).toBe(code);
  }
}
