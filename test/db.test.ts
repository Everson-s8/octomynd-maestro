import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, MaestroDatabase } from "../src/db.js";

let tempDir: string;
let database: MaestroDatabase;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-test-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("database", () => {
  it("registers projects", () => {
    const project = database.registerProject({
      key: "octomynd",
      name: "Octomynd",
      path: tempDir,
      defaultBranch: "main"
    });

    expect(project.key).toBe("octomynd");
    expect(project.name).toBe("Octomynd");
    expect(database.listProjects()).toHaveLength(1);
  });

  it("creates and lists tasks", () => {
    database.registerProject({
      key: "octomynd",
      path: tempDir
    });

    const task = database.createTask("test telegram integration", "telegram", "octomynd");

    expect(task.id).toBeGreaterThan(0);
    expect(task.projectKey).toBe("octomynd");
    expect(task.status).toBe("queued");
    expect(database.listTasks()).toHaveLength(1);
    expect(database.listTasksByProject("octomynd")).toHaveLength(1);
  });

  it("stores events", () => {
    const task = database.createTask("task with event");
    const event = database.addEvent({
      source: "telegram",
      type: "task.created",
      text: task.text,
      userId: "123",
      taskId: task.id
    });

    expect(event.id).toBeGreaterThan(0);
    expect(event.taskId).toBe(task.id);
    expect(database.getLastEvent()?.type).toBe("task.created");
  });
});
