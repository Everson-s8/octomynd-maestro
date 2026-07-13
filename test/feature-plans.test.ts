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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-feature-plan-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
  database.registerProject({ key: "boo", name: "Boo", path: tempDir });
  commands = new ApplicationCommands(database);
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("feature plans", () => {
  it("persists objective, acceptance criteria, provenance and explicit Task associations", () => {
    const selectedTask = database.createTask("build planner persistence", "dashboard", "boo");
    database.createTask("Build planner persistence", "dashboard", "boo");

    const result = commands.createFeaturePlan(
      { channel: "dashboard", userId: "42", username: "operator" },
      {
        projectKey: "boo",
        objective: "Persist autonomous feature planning before integration.",
        acceptanceCriteria: ["Objective is durable", "Task links are explicit"],
        taskIds: [selectedTask.id],
        idempotencyKey: "create-planner-plan"
      }
    );

    expect(result.applied).toBe(true);
    expect(result.plan.projectKey).toBe("boo");
    expect(result.plan.source).toBe("dashboard");
    expect(result.plan.createdByUserId).toBe("42");
    expect(result.plan.acceptanceCriteria).toEqual(["Objective is durable", "Task links are explicit"]);
    expect(result.tasks.map((task) => task.taskId)).toEqual([selectedTask.id]);
    expect(database.listFeaturePlanTasks(result.plan.id)).toHaveLength(1);

    const event = database.getLastEvent();
    expect(event?.type).toBe("feature_plan.created");
    expect(event?.source).toBe("dashboard");
    expect(event?.metadata).toMatchObject({
      featurePlanId: result.plan.id,
      projectKey: "boo",
      taskIds: [selectedTask.id]
    });
  });

  it("uses idempotency keys without duplicating plans, links or events", () => {
    const task = database.createTask("idempotent planner", "dashboard", "boo");

    const first = commands.createFeaturePlan({ channel: "maestro" }, {
      projectKey: "boo",
      objective: "Create the same Feature Plan exactly once.",
      acceptanceCriteria: ["Retry returns the existing plan"],
      taskIds: [task.id],
      idempotencyKey: "same-create"
    });
    const eventsAfterFirst = database.listEvents().length;
    const second = commands.createFeaturePlan({ channel: "maestro" }, {
      projectKey: "boo",
      objective: "Create the same Feature Plan exactly once.",
      acceptanceCriteria: ["Retry returns the existing plan"],
      taskIds: [task.id],
      idempotencyKey: "same-create"
    });

    expect(second.applied).toBe(false);
    expect(second.plan.id).toBe(first.plan.id);
    expect(database.listFeaturePlans()).toHaveLength(1);
    expect(database.listFeaturePlanTasks(first.plan.id)).toHaveLength(1);
    expect(database.listEvents()).toHaveLength(eventsAfterFirst);

    const otherTask = database.createTask("different plan", "dashboard", "boo");
    expect(() => commands.createFeaturePlan({ channel: "maestro" }, {
      projectKey: "boo",
      objective: "Create a different Feature Plan with a reused key.",
      acceptanceCriteria: ["Conflict is reported"],
      taskIds: [otherTask.id],
      idempotencyKey: "same-create"
    })).toThrow(ApplicationCommandError);
  });

  it("validates project ownership, required fields and active plan conflicts", () => {
    database.registerProject({ key: "other", path: tempDir });
    const task = database.createTask("owned by boo", "dashboard", "boo");
    const otherTask = database.createTask("owned by other", "dashboard", "other");

    expectCommandError(() => commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "missing",
      objective: "Unknown project plan",
      acceptanceCriteria: ["Rejected"],
      taskIds: [task.id]
    }), "not_found");

    expectCommandError(() => commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "short",
      acceptanceCriteria: [],
      taskIds: []
    }), "validation");

    expectCommandError(() => commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "Reject tasks from a different project.",
      acceptanceCriteria: ["Project ownership is enforced"],
      taskIds: [otherTask.id]
    }), "validation");

    commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "First active plan owns the task.",
      acceptanceCriteria: ["Task is linked once"],
      taskIds: [task.id]
    });
    expectCommandError(() => commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "Second active plan cannot reuse task.",
      acceptanceCriteria: ["Conflict is explicit"],
      taskIds: [task.id]
    }), "conflict");
  });

  it("replans and cancels before integration with idempotent retries", () => {
    const firstTask = database.createTask("initial task", "dashboard", "boo");
    const secondTask = database.createTask("replacement task", "dashboard", "boo");
    const created = commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "Initial autonomous plan.",
      acceptanceCriteria: ["Old criterion"],
      taskIds: [firstTask.id]
    });

    const replanned = commands.replanFeaturePlan({ channel: "dashboard" }, created.plan.id, {
      objective: "Updated autonomous plan.",
      acceptanceCriteria: ["New criterion"],
      taskIds: [secondTask.id],
      idempotencyKey: "replan-once"
    });
    const eventsAfterReplan = database.listEvents().length;
    const retry = commands.replanFeaturePlan({ channel: "dashboard" }, created.plan.id, {
      objective: "Updated autonomous plan.",
      acceptanceCriteria: ["New criterion"],
      taskIds: [secondTask.id],
      idempotencyKey: "replan-once"
    });

    expect(replanned.applied).toBe(true);
    expect(replanned.plan.revision).toBe(2);
    expect(replanned.tasks.map((task) => task.taskId)).toEqual([secondTask.id]);
    expect(retry.applied).toBe(false);
    expect(retry.plan.revision).toBe(2);
    expect(database.listEvents()).toHaveLength(eventsAfterReplan);
    expect(database.getLastEvent()?.type).toBe("feature_plan.replanned");

    const cancelled = commands.cancelFeaturePlan({ channel: "dashboard" }, created.plan.id, "Superseded before integration.");
    const eventsAfterCancel = database.listEvents().length;
    const cancelRetry = commands.cancelFeaturePlan({ channel: "dashboard" }, created.plan.id, "Superseded before integration.");

    expect(cancelled.applied).toBe(true);
    expect(cancelled.plan.status).toBe("cancelled");
    expect(cancelled.plan.cancelReason).toBe("Superseded before integration.");
    expect(cancelRetry.applied).toBe(false);
    expect(database.listEvents()).toHaveLength(eventsAfterCancel);
    expectCommandError(() => commands.replanFeaturePlan({ channel: "dashboard" }, created.plan.id, {
      objective: "Cannot replan cancelled work.",
      acceptanceCriteria: ["Blocked"],
      taskIds: [secondTask.id]
    }), "conflict");
  });

  it("returns idempotent replan retries after cancellation and task reuse", () => {
    const firstTask = database.createTask("initial reusable task", "dashboard", "boo");
    const secondTask = database.createTask("replacement reusable task", "dashboard", "boo");
    const created = commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "Initial plan before task reuse.",
      acceptanceCriteria: ["Initial task is linked"],
      taskIds: [firstTask.id]
    });
    const replanned = commands.replanFeaturePlan({ channel: "dashboard" }, created.plan.id, {
      objective: "Replanned before later cancellation.",
      acceptanceCriteria: ["Replacement task is linked"],
      taskIds: [secondTask.id],
      idempotencyKey: "retry-after-reuse"
    });
    commands.cancelFeaturePlan({ channel: "dashboard" }, created.plan.id, "Cancelled before integration.");
    commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "New active plan can reuse cancelled plan tasks.",
      acceptanceCriteria: ["Cancelled Feature Plan links do not block reuse"],
      taskIds: [secondTask.id]
    });
    const eventCount = database.listEvents().length;

    const retry = commands.replanFeaturePlan({ channel: "dashboard" }, created.plan.id, {
      objective: "Replanned before later cancellation.",
      acceptanceCriteria: ["Replacement task is linked"],
      taskIds: [secondTask.id],
      idempotencyKey: "retry-after-reuse"
    });

    expect(retry.applied).toBe(false);
    expect(retry.plan.id).toBe(replanned.plan.id);
    expect(retry.plan.status).toBe("cancelled");
    expect(retry.plan.revision).toBe(2);
    expect(database.listEvents()).toHaveLength(eventCount);
  });

  it("serves HTTP APIs for create, list, get, replan and cancel", async () => {
    const task = database.createTask("api task", "dashboard", "boo");
    const replacement = database.createTask("api replacement", "dashboard", "boo");
    const server = createDashboardServer({ config: testConfig(), database, staticRoot: tempDir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const createResponse = await fetch(`http://127.0.0.1:${port}/api/feature-plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectKey: "boo",
          objective: "Expose Feature Plans through the API.",
          acceptanceCriteria: ["Can be queried"],
          taskIds: [task.id],
          idempotencyKey: "api-create"
        })
      });
      expect(createResponse.status).toBe(201);
      const createPayload = await createResponse.json() as { plan: { id: number }; tasks: Array<{ taskId: number }> };
      expect(createPayload.tasks.map((item) => item.taskId)).toEqual([task.id]);

      const retryResponse = await fetch(`http://127.0.0.1:${port}/api/feature-plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectKey: "boo",
          objective: "Expose Feature Plans through the API.",
          acceptanceCriteria: ["Can be queried"],
          taskIds: [task.id],
          idempotencyKey: "api-create"
        })
      });
      expect(retryResponse.status).toBe(200);

      const listResponse = await fetch(`http://127.0.0.1:${port}/api/feature-plans`);
      const listPayload = await listResponse.json() as { featurePlans: Array<{ plan: { id: number } }> };
      expect(listResponse.status).toBe(200);
      expect(listPayload.featurePlans[0].plan.id).toBe(createPayload.plan.id);

      const getResponse = await fetch(`http://127.0.0.1:${port}/api/feature-plans/${createPayload.plan.id}`);
      expect(getResponse.status).toBe(200);

      const replanResponse = await fetch(`http://127.0.0.1:${port}/api/feature-plans/${createPayload.plan.id}/replan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          objective: "Expose replanned Feature Plans through the API.",
          acceptanceCriteria: ["Replacement task is linked"],
          taskIds: [replacement.id],
          idempotencyKey: "api-replan"
        })
      });
      const replanPayload = await replanResponse.json() as { plan: { revision: number }; tasks: Array<{ taskId: number }> };
      expect(replanResponse.status).toBe(200);
      expect(replanPayload.plan.revision).toBe(2);
      expect(replanPayload.tasks.map((item) => item.taskId)).toEqual([replacement.id]);

      const cancelResponse = await fetch(`http://127.0.0.1:${port}/api/feature-plans/${createPayload.plan.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Cancelled from API test." })
      });
      const cancelPayload = await cancelResponse.json() as { plan: { status: string; cancelReason: string } };
      expect(cancelResponse.status).toBe(200);
      expect(cancelPayload.plan.status).toBe("cancelled");
      expect(cancelPayload.plan.cancelReason).toBe("Cancelled from API test.");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("migrates a pre-Feature Plan database compatibly", () => {
    database.close();
    const legacyPath = path.join(tempDir, "legacy.db");
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
      INSERT INTO projects (key, name, path, default_branch, created_at, updated_at)
      VALUES ('legacy', 'Legacy', '${escapeSql(tempDir)}', 'main', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
      INSERT INTO tasks (project_id, text, status, source, created_at, updated_at)
      VALUES (1, 'legacy task', 'queued', 'dashboard', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    `);
    raw.close();

    database = createDatabase(legacyPath);
    commands = new ApplicationCommands(database);
    const result = commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "legacy",
      objective: "Plan on an upgraded database.",
      acceptanceCriteria: ["New tables are available"],
      taskIds: [1]
    });

    expect(result.plan.projectKey).toBe("legacy");
    expect(result.tasks.map((task) => task.taskId)).toEqual([1]);
  });

  it("does not fail reads when stored acceptance criteria JSON is invalid", () => {
    const task = database.createTask("corrupt criteria task", "dashboard", "boo");
    const created = commands.createFeaturePlan({ channel: "dashboard" }, {
      projectKey: "boo",
      objective: "Read a plan with invalid stored criteria.",
      acceptanceCriteria: ["Criteria start valid"],
      taskIds: [task.id]
    });
    database.close();
    const raw = new SqliteDatabase(path.join(tempDir, "maestro.db"));
    raw.prepare("UPDATE feature_plans SET acceptance_criteria_json = ? WHERE id = ?")
      .run("{not valid json", created.plan.id);
    raw.close();
    database = createDatabase(path.join(tempDir, "maestro.db"));
    commands = new ApplicationCommands(database);

    expect(commands.getFeaturePlan(created.plan.id).plan.acceptanceCriteria).toEqual([]);
  });
});

function testConfig(): MaestroConfig {
  return {
    projectName: "test",
    databasePath: path.join(tempDir, "maestro.db"),
    worktreesPath: path.join(tempDir, "worktrees"),
    dashboard: { enabled: true, host: "127.0.0.1", port: 4787 },
    autopilot: { enabled: true, pollIntervalMs: 30_000, maxConcurrentGoals: 1 },
    runtime: { tokenEfficient: true },
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
