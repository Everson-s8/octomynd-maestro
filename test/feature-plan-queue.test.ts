import SqliteDatabase from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationCommands } from "../src/commands/application-commands.js";
import { ApplicationCommandError } from "../src/commands/errors.js";
import { MaestroConfig } from "../src/config.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { FeaturePlanLifecycleNotificationWorker } from "../src/features/lifecycle-notification-worker.js";
import {
  evaluateFeatureTaskReadiness,
  revalidateQueuedFeaturePlans,
  revalidateQueuedFeaturePlansWithAudit
} from "../src/features/task-scheduler.js";
import { formatFeaturePlanLifecycleNotification } from "../src/telegram/notifications.js";
import {
  parseFeaturePriorityText,
  parseFeaturePauseText,
  parseFeatureRetryText,
  parseFeaturePlanCancelText
} from "../src/telegram/bot.js";

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

describe("Feature Plan Queue Scheduler Block 2", () => {
  it("enforces per-project writer lease and allows cross-project concurrency", () => {
    const t1 = database.createTask("task boo 1", "dashboard", "boo");
    const t2 = database.createTask("task boo 2", "dashboard", "boo");
    const tf = database.createTask("task far 1", "dashboard", "far");

    const planBoo1 = commands.createFeaturePlan(
      { channel: "dashboard" },
      { projectKey: "boo", objective: "Boo plan 1", acceptanceCriteria: ["Pass"], taskIds: [t1.id] }
    ).plan;

    const planBoo2 = commands.createFeaturePlan(
      { channel: "dashboard" },
      { projectKey: "boo", objective: "Boo plan 2", acceptanceCriteria: ["Pass"], taskIds: [t2.id] }
    ).plan;

    const planFar1 = commands.createFeaturePlan(
      { channel: "dashboard" },
      { projectKey: "far", objective: "Far plan 1", acceptanceCriteria: ["Pass"], taskIds: [tf.id] }
    ).plan;

    expect(planBoo1.status).toBe("queued");
    expect(planBoo2.status).toBe("queued");
    expect(planFar1.status).toBe("queued");

    const admittedBoo1 = commands.admitFeaturePlan({ channel: "dashboard" }, planBoo1.id);
    expect(admittedBoo1.plan.status).toBe("admitted");
    expect(admittedBoo1.plan.admittedAt).not.toBeNull();

    const eligibilityBoo2 = commands.getFeaturePlanEligibility(planBoo2.id);
    expect(eligibilityBoo2.eligible).toBe(false);
    expect(eligibilityBoo2.blockedByActiveProjectPlan?.id).toBe(planBoo1.id);

    const eligibilityFar1 = commands.getFeaturePlanEligibility(planFar1.id);
    expect(eligibilityFar1.eligible).toBe(true);

    const admittedFar1 = commands.admitFeaturePlan({ channel: "dashboard" }, planFar1.id);
    expect(admittedFar1.plan.status).toBe("admitted");
  });

  it("revalidates queued features after merge and admits successor", () => {
    const t1 = database.createTask("task boo 1", "dashboard", "boo");
    const t2 = database.createTask("task boo 2", "dashboard", "boo");

    const planBoo1 = commands.createFeaturePlan(
      { channel: "dashboard" },
      { projectKey: "boo", objective: "Boo plan 1", acceptanceCriteria: ["Pass"], taskIds: [t1.id] }
    ).plan;

    const planBoo2 = commands.createFeaturePlan(
      { channel: "dashboard" },
      { projectKey: "boo", objective: "Boo plan 2", acceptanceCriteria: ["Pass"], taskIds: [t2.id] }
    ).plan;

    commands.admitFeaturePlan({ channel: "dashboard" }, planBoo1.id);
    expect(database.getFeaturePlan(planBoo1.id).status).toBe("admitted");

    database.updateFeaturePlanQueueStatus(planBoo1.id, "active");
    database.updateFeaturePlanQueueStatus(planBoo1.id, "waiting_review");
    database.updateFeaturePlanQueueStatus(planBoo1.id, "waiting_merge");
    database.updateFeaturePlanQueueStatus(planBoo1.id, "completed");

    const admitted = commands.revalidateFeaturePlanQueue("boo");
    expect(admitted.map((p) => p.plan.id)).toContain(planBoo2.id);
    expect(database.getFeaturePlan(planBoo2.id).status).toBe("admitted");
  });

  it("blocks dependent queued feature when predecessor is cancelled", () => {
    const t1 = database.createTask("task boo 1", "dashboard", "boo");
    const t2 = database.createTask("task boo 2", "dashboard", "boo");

    const planBoo1 = commands.createFeaturePlan(
      { channel: "dashboard" },
      { projectKey: "boo", objective: "Boo plan 1", acceptanceCriteria: ["Pass"], taskIds: [t1.id] }
    ).plan;

    const planBoo2 = commands.createFeaturePlan(
      { channel: "dashboard" },
      {
        projectKey: "boo",
        objective: "Boo plan 2 dependent",
        acceptanceCriteria: ["Pass"],
        taskIds: [t2.id],
        dependsOnFeaturePlanIds: [planBoo1.id]
      }
    ).plan;

    commands.cancelFeaturePlan({ channel: "dashboard" }, planBoo1.id, "cancelled by user");
    expect(database.getFeaturePlan(planBoo1.id).status).toBe("cancelled");

    expect(database.getFeaturePlan(planBoo2.id).status).toBe("blocked");
    expect(database.getFeaturePlan(planBoo2.id).blockedReason).toBe(`predecessor_feature_plan_${planBoo1.id}_cancelled`);

    const readiness = evaluateFeatureTaskReadiness(database, t2, []);
    expect(readiness.state).toBe("blocked");
    expect(readiness.reason).toBe("feature_plan_blocked");
  });

  it("prevents duplicate execution of blocked/cancelled/paused feature plan tasks", () => {
    const t1 = database.createTask("task boo 1", "dashboard", "boo");
    const plan = commands.createFeaturePlan(
      { channel: "dashboard" },
      { projectKey: "boo", objective: "Boo plan 1", acceptanceCriteria: ["Pass"], taskIds: [t1.id] }
    ).plan;

    commands.pauseFeaturePlan({ channel: "dashboard" }, plan.id, "paused for maintenance");
    let readiness = evaluateFeatureTaskReadiness(database, t1, []);
    expect(readiness.state).toBe("waiting");
    expect(readiness.reason).toBe("feature_plan_paused_paused for maintenance");

    commands.resumeFeaturePlan({ channel: "dashboard" }, plan.id);
    readiness = evaluateFeatureTaskReadiness(database, t1, []);
    expect(readiness.state).toBe("ready");
    expect(database.getFeaturePlan(plan.id).status).toBe("active");
  });
});

describe("Feature Plan Queue Scheduler Block 3", () => {
  it("retries blocked feature plan (blocked -> queued) and revalidates queue", () => {
    const t1 = database.createTask("task for retry", "dashboard", "boo");
    const plan = commands.createFeaturePlan(
      { channel: "dashboard" },
      { projectKey: "boo", objective: "Plan to test retry", acceptanceCriteria: ["Pass"], taskIds: [t1.id] }
    ).plan;

    // Advance to active then block
    commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, plan.id, "admitted");
    commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, plan.id, "active");
    commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, plan.id, "blocked", "Build pipeline error");

    let current = database.getFeaturePlan(plan.id);
    expect(current.status).toBe("blocked");
    expect(current.blockedReason).toBe("Build pipeline error");

    // Retry non-existent plan should fail with not_found
    expectCommandError(() => commands.retryFeaturePlan({ channel: "dashboard" }, 999999), "not_found");

    // Retry blocked plan
    const retried = commands.retryFeaturePlan({ channel: "dashboard" }, plan.id, "Fixed pipeline script");
    expect(["queued", "admitted"]).toContain(retried.plan.status);
    expect(retried.plan.blockedReason).toBeNull();
    expect(retried.plan.blockedAt).toBeNull();

    // Verify retry event in history and event log
    const history = database.getFeaturePlanHistory(plan.id);
    expect(history.some((entry) => entry.toStatus === "queued")).toBe(true);

    const events = database.listEvents(20);
    expect(events.some((event) => event.type === "feature_plan.retried")).toBe(true);

    // Re-retrying a plan that is not blocked should fail with conflict
    expectCommandError(() => commands.retryFeaturePlan({ channel: "dashboard" }, plan.id), "conflict");
  });

  it("exposes retry endpoint via REST API POST /api/feature-plans/:id/retry", async () => {
    const task = database.createTask("task for api retry", "dashboard", "boo");
    const plan = commands.createFeaturePlan(
      { channel: "dashboard" },
      { projectKey: "boo", objective: "API Retry Test Feature Plan", acceptanceCriteria: ["Pass"], taskIds: [task.id] }
    ).plan;

    commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, plan.id, "admitted");
    commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, plan.id, "active");
    commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, plan.id, "blocked", "Failed check");

    const server = createDashboardServer({ config: testConfig(), database, staticRoot: tempDir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const retryRes = await fetch(`http://127.0.0.1:${port}/api/feature-plans/${plan.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Retried via API" })
      });
      expect(retryRes.status).toBe(200);
      const payload = await retryRes.json() as { plan: { status: string; blockedReason: string | null } };
      expect(["queued", "admitted"]).toContain(payload.plan.status);
      expect(payload.plan.blockedReason).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("parses Telegram queue governance text commands", () => {
    expect(parseFeaturePriorityText("/feature_priority 12 25")).toEqual({ planId: 12, priority: 25 });
    expect(parseFeaturePauseText("/feature_pause 12 review window")).toEqual({ planId: 12, reason: "review window" });
    expect(parseFeaturePauseText("/feature_pause 12")).toEqual({ planId: 12, reason: null });
    expect(parseFeatureRetryText("/feature_retry 12 fixed build")).toEqual({ planId: 12, reason: "fixed build" });
    expect(parseFeaturePlanCancelText("/feature_plan_cancel 12 stale plan")).toEqual({ planId: 12, reason: "stale plan" });
  });

  it("formats Telegram lifecycle notifications with blockers and next action", () => {
    const planRecord: import("../src/db.js").FeaturePlanRecord = {
      id: 42,
      projectId: 1,
      projectKey: "boo",
      projectName: "Boo",
      objective: "Test Telegram notification formatting",
      acceptanceCriteria: [],
      status: "blocked",
      priority: 10,
      isPaused: false,
      pausedAt: null,
      pauseReason: null,
      blockedAt: "2026-08-08T00:00:00.000Z",
      blockedReason: "Dependency conflict",
      admittedAt: null,
      completedAt: null,
      source: "dashboard",
      createdByUserId: null,
      createdByUsername: null,
      revision: 1,
      cancelledAt: null,
      cancelReason: null,
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z"
    };

    const notificationText = formatFeaturePlanLifecycleNotification({
      plan: planRecord,
      action: "blocked",
      reason: "Dependency conflict"
    });

    expect(notificationText).toContain("Feature Plan #42 - ⚠️ Bloqueado");
    expect(notificationText).toContain("Projeto: @boo");
    expect(notificationText).toContain("Bloqueio: Dependency conflict");
    expect(notificationText).toContain("Proxima acao: Resolva o motivo do bloqueio e execute /feature_retry id.");
  });

  it("delivers new lifecycle events once and resumes without duplicates after restart", async () => {
    const delivered: Array<{ action: string; sourceEventId?: number }> = [];
    const notify = async (event: import("../src/telegram/notifications.js").FeaturePlanLifecycleEvent) => {
      delivered.push({ action: event.action, sourceEventId: event.sourceEventId });
      database.addEvent({
        source: "telegram",
        type: "feature_plan.lifecycle_notification_sent",
        text: `Feature Plan #${event.plan.id} notification sent.`,
        metadata: {
          featurePlanId: event.plan.id,
          action: event.action,
          sourceEventId: event.sourceEventId ?? null
        }
      });
    };
    const firstWorker = new FeaturePlanLifecycleNotificationWorker(database, notify);

    await firstWorker.reconcile();
    const task = database.createTask("lifecycle notification task", "dashboard", "boo");
    const plan = commands.createFeaturePlan(
      { channel: "dashboard" },
      {
        projectKey: "boo",
        objective: "Notify lifecycle changes durably",
        acceptanceCriteria: ["Notify once"],
        taskIds: [task.id]
      }
    ).plan;
    commands.pauseFeaturePlan({ channel: "dashboard" }, plan.id, "operator pause");

    expect(await firstWorker.reconcile()).toBe(1);
    expect(delivered).toEqual([{ action: "paused", sourceEventId: expect.any(Number) }]);
    expect(await firstWorker.reconcile()).toBe(0);

    const restartedWorker = new FeaturePlanLifecycleNotificationWorker(database, notify);
    expect(await restartedWorker.reconcile()).toBe(0);
    expect(delivered).toHaveLength(1);
  });

  it("emits an admission event when the scheduler acquires the writer lease", () => {
    const task = database.createTask("scheduler admission task", "dashboard", "boo");
    const plan = commands.createFeaturePlan(
      { channel: "dashboard" },
      {
        projectKey: "boo",
        objective: "Admit through scheduler",
        acceptanceCriteria: ["Admission is observable"],
        taskIds: [task.id]
      }
    ).plan;

    const readiness = evaluateFeatureTaskReadiness(database, task, []);

    expect(readiness.state).toBe("ready");
    expect(database.listEvents(20)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "feature_plan.admitted",
        metadata: expect.objectContaining({ featurePlanId: plan.id })
      })
    ]));
  });

  it("records queue revalidation failures instead of hiding them", () => {
    vi.spyOn(database, "listFeaturePlanQueue").mockImplementation(() => {
      throw new Error("simulated queue read failure");
    });

    expect(revalidateQueuedFeaturePlansWithAudit(database, "test_revalidation", "boo")).toEqual([]);
    expect(database.listEvents(20)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "feature_plan.revalidation_failed",
        text: expect.stringContaining("simulated queue read failure"),
        metadata: expect.objectContaining({
          trigger: "test_revalidation",
          projectKey: "boo"
        })
      })
    ]));
  });

  describe("Feature Plan Queue Scheduler Block 4 - Deterministic Restart, Idempotency, Concurrency, Migration and Canary Tests", () => {
    it("recovers queue states, dependencies, priority, paused/blocked status, writer lease and notification cursor deterministically after process restart", async () => {
      const tBoo1 = database.createTask("boo task 1", "dashboard", "boo");
      const tBoo2 = database.createTask("boo task 2", "dashboard", "boo");
      const tBoo3 = database.createTask("boo task 3", "dashboard", "boo");
      const tBoo4 = database.createTask("boo task 4", "dashboard", "boo");
      const tFar1 = database.createTask("far task 1", "dashboard", "far");

      const p1 = commands.createFeaturePlan(
        { channel: "dashboard" },
        {
          projectKey: "boo",
          objective: "Boo plan 1 - high priority",
          acceptanceCriteria: ["Pass"],
          taskIds: [tBoo1.id],
          priority: 100
        }
      ).plan;

      const p2 = commands.createFeaturePlan(
        { channel: "dashboard" },
        {
          projectKey: "boo",
          objective: "Boo plan 2 - depends on plan 1",
          acceptanceCriteria: ["Pass"],
          taskIds: [tBoo2.id],
          priority: 50,
          dependsOnFeaturePlanIds: [p1.id]
        }
      ).plan;

      const p3 = commands.createFeaturePlan(
        { channel: "dashboard" },
        {
          projectKey: "boo",
          objective: "Boo plan 3 - paused",
          acceptanceCriteria: ["Pass"],
          taskIds: [tBoo3.id],
          priority: 75
        }
      ).plan;

      const p4 = commands.createFeaturePlan(
        { channel: "dashboard" },
        {
          projectKey: "boo",
          objective: "Boo plan 4 - blocked",
          acceptanceCriteria: ["Pass"],
          taskIds: [tBoo4.id],
          priority: 10
        }
      ).plan;

      const pFar = commands.createFeaturePlan(
        { channel: "dashboard" },
        {
          projectKey: "far",
          objective: "Far plan 1",
          acceptanceCriteria: ["Pass"],
          taskIds: [tFar1.id],
          priority: 20
        }
      ).plan;
      const tBoo5 = database.createTask("boo task 5", "dashboard", "boo");
      const pQueued = commands.createFeaturePlan(
        { channel: "dashboard" },
        {
          projectKey: "boo",
          objective: "Boo plan queued check",
          acceptanceCriteria: ["Pass"],
          taskIds: [tBoo5.id],
          priority: 5
        }
      ).plan;

      // Set explicit states
      commands.pauseFeaturePlan({ channel: "dashboard" }, p3.id, "maintenance hold");
      commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, p4.id, "admitted");
      commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, p4.id, "active");
      commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, p4.id, "blocked", "upstream dependency failed");

      commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, p1.id, "admitted");
      commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, p1.id, "active");

      commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, pFar.id, "admitted");
      commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, pFar.id, "active");

      // Verify writer lease (active project plan lock) and eligibility before restart
      expect(commands.getFeaturePlanEligibility(pQueued.id).blockedByActiveProjectPlan?.id).toBe(p1.id);

      let el2 = commands.getFeaturePlanEligibility(p2.id);
      expect(el2.eligible).toBe(false);
      expect(el2.blockedDependencies.map((d) => d.id)).toContain(p1.id);

      let el3 = commands.getFeaturePlanEligibility(p3.id);
      expect(el3.eligible).toBe(false);
      expect(el3.blockedByPaused).toBe(true);

      // Reconcile notifications once before restart
      const delivered: string[] = [];
      const worker1 = new FeaturePlanLifecycleNotificationWorker(database, async (event) => {
        delivered.push(`${event.action}:${event.plan.id}`);
      });
      await worker1.reconcile();
      const deliveredCountPreRestart = delivered.length;

      // Close and reopen database (simulate full process crash & restart)
      database.close();
      const dbPath = path.join(tempDir, "maestro.db");
      database = createDatabase(dbPath);
      commands = new ApplicationCommands(database);

      // Assert state preservation after restart
      const plan1Rec = database.getFeaturePlan(p1.id);
      expect(plan1Rec.status).toBe("active");
      expect(plan1Rec.priority).toBe(100);

      const plan2Rec = database.getFeaturePlan(p2.id);
      expect(plan2Rec.status).toBe("queued");
      expect(plan2Rec.priority).toBe(50);
      const plan2Deps = database.listFeaturePlanDependencies(p2.id);
      expect(plan2Deps.map((d) => d.dependsOnFeaturePlanId)).toEqual([p1.id]);

      const plan3Rec = database.getFeaturePlan(p3.id);
      expect(plan3Rec.status).toBe("queued");
      expect(plan3Rec.isPaused).toBe(true);
      expect(plan3Rec.pauseReason).toBe("maintenance hold");

      const plan4Rec = database.getFeaturePlan(p4.id);
      expect(plan4Rec.status).toBe("blocked");
      expect(plan4Rec.blockedReason).toBe("upstream dependency failed");

      const planFarRec = database.getFeaturePlan(pFar.id);
      expect(planFarRec.status).toBe("active");

      // Verify active plan leases after restart
      expect(commands.getFeaturePlanEligibility(pQueued.id).blockedByActiveProjectPlan?.id).toBe(p1.id);

      // Verify eligibility logic produces identical result after restart
      el2 = commands.getFeaturePlanEligibility(p2.id);
      expect(el2.eligible).toBe(false);
      expect(el2.blockedDependencies.map((d) => d.id)).toContain(p1.id);

      el3 = commands.getFeaturePlanEligibility(p3.id);
      expect(el3.eligible).toBe(false);
      expect(el3.blockedByPaused).toBe(true);

      // Verify notification worker resumes without re-delivering pre-restart notifications
      const postRestartDelivered: string[] = [];
      const worker2 = new FeaturePlanLifecycleNotificationWorker(database, async (event) => {
        postRestartDelivered.push(`${event.action}:${event.plan.id}`);
      });
      const newDeliveredCount = await worker2.reconcile();
      expect(newDeliveredCount).toBe(0);
      expect(postRestartDelivered).toHaveLength(0);
    });

    it("enforces operation ledger idempotency and reevaluation determinism", async () => {
      const task = database.createTask("idempotency task", "dashboard", "boo");

      // Test command idempotency key
      const payload = {
        projectKey: "boo",
        objective: "Idempotency test plan",
        acceptanceCriteria: ["Idempotent execution"],
        taskIds: [task.id],
        idempotencyKey: "idem-key-plan-1"
      };

      const p1 = commands.createFeaturePlan({ channel: "dashboard" }, payload).plan;
      const p2 = commands.createFeaturePlan({ channel: "dashboard" }, payload).plan;

      // Duplicate creation request with exact payload returns identical plan without creating duplicate history entries
      expect(p2.id).toBe(p1.id);
      const history = database.getFeaturePlanHistory(p1.id);
      expect(history.filter((h) => h.action === "create")).toHaveLength(1);

      // Revalidate queued feature plans multiple times sequentially when queue is unchanged
      const count1 = revalidateQueuedFeaturePlans(database);
      const count2 = revalidateQueuedFeaturePlans(database);
      const count3 = revalidateQueuedFeaturePlans(database);

      expect(count1).toHaveLength(1); // First revalidation admits plan
      expect(count2).toHaveLength(0); // Second revalidation is no-op
      expect(count3).toHaveLength(0); // Third revalidation is no-op

      const finalHistory = database.getFeaturePlanHistory(p1.id);
      const admittedHistoryCount = finalHistory.filter((h) => h.toStatus === "admitted").length;
      expect(admittedHistoryCount).toBe(1);

      // Initialize worker baseline cursor
      const workerDelivered: string[] = [];
      const worker = new FeaturePlanLifecycleNotificationWorker(database, async (event) => {
        workerDelivered.push(event.action);
      });
      await worker.reconcile();

      // Trigger a lifecycle action (pause)
      commands.pauseFeaturePlan({ channel: "dashboard" }, p1.id, "pause test");

      // Verify worker reconcile delivers new event once and repeat call is no-op
      const r1 = await worker.reconcile();
      const r2 = await worker.reconcile();
      expect(r1).toBe(1);
      expect(r2).toBe(0);
      expect(workerDelivered).toEqual(["paused"]);
    });

    it("maintains cross-project independence while enforcing per-project writer lease mutual exclusion and queue priority ordering", () => {
      const tB1 = database.createTask("boo t1", "dashboard", "boo");
      const tB2 = database.createTask("boo t2", "dashboard", "boo");
      const tF1 = database.createTask("far t1", "dashboard", "far");
      const tF2 = database.createTask("far t2", "dashboard", "far");

      const pB1 = commands.createFeaturePlan(
        { channel: "dashboard" },
        { projectKey: "boo", objective: "Boo low prio", acceptanceCriteria: ["Pass"], taskIds: [tB1.id], priority: 10 }
      ).plan;

      const pB2 = commands.createFeaturePlan(
        { channel: "dashboard" },
        { projectKey: "boo", objective: "Boo high prio", acceptanceCriteria: ["Pass"], taskIds: [tB2.id], priority: 100 }
      ).plan;

      const pF1 = commands.createFeaturePlan(
        { channel: "dashboard" },
        { projectKey: "far", objective: "Far high prio", acceptanceCriteria: ["Pass"], taskIds: [tF1.id], priority: 80 }
      ).plan;

      const pF2 = commands.createFeaturePlan(
        { channel: "dashboard" },
        { projectKey: "far", objective: "Far low prio", acceptanceCriteria: ["Pass"], taskIds: [tF2.id], priority: 5 }
      ).plan;

      // Verify queue ordering for each project independently
      const booQueue = database.listFeaturePlanQueue("boo");
      expect(booQueue.map((item) => item.plan.id)).toEqual([pB2.id, pB1.id]);

      const farQueue = database.listFeaturePlanQueue("far");
      expect(farQueue.map((item) => item.plan.id)).toEqual([pF1.id, pF2.id]);

      // Admit highest priority plan for boo
      commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, pB2.id, "admitted");
      commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, pB2.id, "active");

      // Verify pB1 is blocked by pB2 being active in project boo
      let elB1 = commands.getFeaturePlanEligibility(pB1.id);
      expect(elB1.eligible).toBe(false);
      expect(elB1.blockedByActiveProjectPlan?.id).toBe(pB2.id);

      // Verify pF1 in project far is NOT blocked by project boo's active plan
      let elF1 = commands.getFeaturePlanEligibility(pF1.id);
      expect(elF1.eligible).toBe(true);

      // Admit pF1 in far
      commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, pF1.id, "admitted");
      commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, pF1.id, "active");

      // Verify pF2 is blocked by active pF1 in far
      let elF2 = commands.getFeaturePlanEligibility(pF2.id);
      expect(elF2.eligible).toBe(false);
      expect(elF2.blockedByActiveProjectPlan?.id).toBe(pF1.id);

      // Complete pB2 in boo
      commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, pB2.id, "waiting_review");
      commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, pB2.id, "waiting_merge");
      commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, pB2.id, "completed");

      // Revalidate queued plans: pB1 becomes eligible and is admitted
      revalidateQueuedFeaturePlans(database);
      const updatedB1 = database.getFeaturePlan(pB1.id);
      expect(updatedB1.status).toBe("admitted");

      // Far project's active lease remains held by pF1 until pF1 finishes
      expect(commands.getFeaturePlanEligibility(pF2.id).blockedByActiveProjectPlan?.id).toBe(pF1.id);
    });

    it("runs migrations idempotently on populated databases and handles legacy schema upgrades cleanly", () => {
      const t = database.createTask("migration task", "dashboard", "boo");
      const p = commands.createFeaturePlan(
        { channel: "dashboard" },
        { projectKey: "boo", objective: "Migration test plan", acceptanceCriteria: ["Pass"], taskIds: [t.id] }
      ).plan;

      // Close and reopen database multiple times to trigger migrate(db) repeatedly
      database.close();
      const dbPath = path.join(tempDir, "maestro.db");

      const db2 = createDatabase(dbPath);
      expect(db2.getFeaturePlan(p.id).objective).toBe("Migration test plan");
      db2.close();

      const db3 = createDatabase(dbPath);
      expect(db3.getFeaturePlan(p.id).objective).toBe("Migration test plan");

      // Keep database variable pointing to active DB for afterEach cleanup
      database = db3;
    });

    it("executes an end-to-end feature plan canary workflow from creation to completion and successor admission", async () => {
      // Initialize lifecycle worker first to mark initial cursor baseline
      const deliveredActions: string[] = [];
      const worker = new FeaturePlanLifecycleNotificationWorker(database, async (event) => {
        deliveredActions.push(event.action);
      });
      await worker.reconcile();

      // 1. Setup tasks and plan graph
      const t1 = database.createTask("canary task 1", "dashboard", "boo");
      const t2 = database.createTask("canary task 2", "dashboard", "boo");

      const planA = commands.createFeaturePlan(
        { channel: "dashboard" },
        { projectKey: "boo", objective: "Canary Plan A (Predecessor)", acceptanceCriteria: ["Criteria A"], taskIds: [t1.id], priority: 50 }
      ).plan;

      const planB = commands.createFeaturePlan(
        { channel: "dashboard" },
        { projectKey: "boo", objective: "Canary Plan B (Successor)", acceptanceCriteria: ["Criteria B"], taskIds: [t2.id], priority: 10, dependsOnFeaturePlanIds: [planA.id] }
      ).plan;

      // 2. Test Pause/Resume on Plan A
      commands.pauseFeaturePlan({ channel: "dashboard" }, planA.id, "canary pause verification");
      expect(commands.getFeaturePlanEligibility(planA.id).eligible).toBe(false);

      commands.resumeFeaturePlan({ channel: "dashboard" }, planA.id);
      expect(commands.getFeaturePlanEligibility(planA.id).eligible).toBe(true);

      // 3. Admit Plan A via scheduler revalidation
      expect(revalidateQueuedFeaturePlans(database)).toHaveLength(1);
      expect(database.getFeaturePlan(planA.id).status).toBe("admitted");

      // Advance Plan A to active
      commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, planA.id, "active");

      // Verify Plan B is blocked because Plan A is active AND predecessor
      const elB = commands.getFeaturePlanEligibility(planB.id);
      expect(elB.eligible).toBe(false);
      expect(elB.blockedDependencies.map((d) => d.id)).toContain(planA.id);

      // Reconcile events up to this point
      await worker.reconcile();
      expect(deliveredActions).toContain("admitted");

      // 4. Simulate crash & restart midway through execution
      database.close();
      const dbPath = path.join(tempDir, "maestro.db");
      database = createDatabase(dbPath);
      commands = new ApplicationCommands(database);

      // Verify post-restart state
      expect(database.getFeaturePlan(planA.id).status).toBe("active");
      expect(database.getFeaturePlan(planB.id).status).toBe("queued");

      // 5. Complete Plan A
      commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, planA.id, "waiting_review");
      commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, planA.id, "waiting_merge");
      commands.updateFeaturePlanQueueStatus({ channel: "dashboard" }, planA.id, "completed");

      // 6. Revalidate queue -> Plan B becomes eligible and is automatically admitted
      expect(revalidateQueuedFeaturePlans(database)).toHaveLength(1);
      expect(database.getFeaturePlan(planB.id).status).toBe("admitted");

      // 7. Verify lifecycle notifications delivered cleanly after restart
      const postRestartActions: string[] = [];
      const restartedWorker = new FeaturePlanLifecycleNotificationWorker(database, async (event) => {
        postRestartActions.push(event.action);
      });
      await restartedWorker.reconcile();
      expect(postRestartActions).toContain("admitted");
    });
  });

  describe("Feature Plan lifecycle completed non-blocking (Task #53)", () => {
    it("a completed plan does not block a new plan", () => {
      const task1 = database.createTask("task 1", "dashboard", "boo");
      const plan1 = commands.createFeaturePlan({ channel: "dashboard" }, {
        projectKey: "boo",
        objective: "Feature plan 1",
        acceptanceCriteria: ["Pass"],
        taskIds: [task1.id]
      }).plan;
      database.admitFeaturePlan(plan1.id);

      const feature1 = database.createFeature({
        projectKey: "boo",
        featurePlanId: plan1.id,
        name: "feature-1",
        objective: "Feature 1 objective",
        branchName: "feature-1-branch",
        worktreePath: tempDir,
        pullRequestUrl: "https://github.com/org/repo/pull/1"
      });
      database.updateFeature({ id: feature1.id, status: "completed" });

      const task2 = database.createTask("task 2", "dashboard", "boo");
      const plan2 = commands.createFeaturePlan({ channel: "dashboard" }, {
        projectKey: "boo",
        objective: "Feature plan 2",
        acceptanceCriteria: ["Pass"],
        taskIds: [task2.id]
      }).plan;

      const eligibility = database.evaluateFeaturePlanEligibility(plan2.id);
      expect(eligibility.eligible).toBe(true);
      expect(database.getFeaturePlan(plan1.id).status).toBe("completed");

      const admitted = database.admitFeaturePlan(plan2.id);
      expect(admitted.plan.status).toBe("admitted");
    });

    it("a plan transitions to completed correctly after merge", () => {
      const task1 = database.createTask("task 1 for merge", "dashboard", "boo");
      const plan1 = commands.createFeaturePlan({ channel: "dashboard" }, {
        projectKey: "boo",
        objective: "Feature plan to merge",
        acceptanceCriteria: ["Pass"],
        taskIds: [task1.id]
      }).plan;
      database.admitFeaturePlan(plan1.id);

      const feature1 = database.createFeature({
        projectKey: "boo",
        featurePlanId: plan1.id,
        name: "feature-to-merge",
        objective: "Merge objective",
        branchName: "feature-merge-branch",
        worktreePath: tempDir,
        pullRequestUrl: "https://github.com/org/repo/pull/2"
      });

      expect(database.getFeaturePlan(plan1.id).status).toBe("admitted");

      database.updateFeature({ id: feature1.id, status: "completed" });
      const reconciled = database.reconcileFeaturePlanStatus(plan1.id);
      expect(reconciled.status).toBe("completed");

      const history = database.getFeaturePlanHistory(plan1.id);
      expect(history.some((h) => h.action === "reconciled_after_feature_merge" && h.toStatus === "completed")).toBe(true);
    });

    it("restart does not resurrect completed plans as active", () => {
      const dbPath = path.join(tempDir, "maestro.db");
      const task1 = database.createTask("task 1 restart", "dashboard", "boo");
      const plan1 = commands.createFeaturePlan({ channel: "dashboard" }, {
        projectKey: "boo",
        objective: "Feature plan before restart",
        acceptanceCriteria: ["Pass"],
        taskIds: [task1.id]
      }).plan;
      database.admitFeaturePlan(plan1.id);

      const feature1 = database.createFeature({
        projectKey: "boo",
        featurePlanId: plan1.id,
        name: "feature-restart",
        objective: "Restart objective",
        branchName: "feature-restart-branch",
        worktreePath: tempDir,
        pullRequestUrl: "https://github.com/org/repo/pull/3"
      });
      database.updateFeature({ id: feature1.id, status: "completed" });
      database.reconcileFeaturePlanStatus(plan1.id);
      expect(database.getFeaturePlan(plan1.id).status).toBe("completed");

      // Simulate app restart by re-opening the database
      const reopenedDb = createDatabase(dbPath);
      try {
        expect(reopenedDb.getFeaturePlan(plan1.id).status).toBe("completed");

        const task2 = reopenedDb.createTask("task 2 restart", "dashboard", "boo");
        const plan2Cmd = new ApplicationCommands(reopenedDb);
        const plan2 = plan2Cmd.createFeaturePlan({ channel: "dashboard" }, {
          projectKey: "boo",
          objective: "Feature plan after restart",
          acceptanceCriteria: ["Pass"],
          taskIds: [task2.id]
        }).plan;

        const eligibility = reopenedDb.evaluateFeaturePlanEligibility(plan2.id);
        expect(eligibility.eligible).toBe(true);
      } finally {
        reopenedDb.close();
      }
    });
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
      supportedNodeRange: ">=20.17.0 <25"
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
