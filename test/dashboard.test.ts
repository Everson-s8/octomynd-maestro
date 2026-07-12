import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MaestroConfig } from "../src/config.js";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { buildDashboardSnapshot } from "../src/dashboard/snapshot.js";

let tempDir: string;
let database: MaestroDatabase;

const config: MaestroConfig = {
  projectName: "maestro-test",
  databasePath: "",
  worktreesPath: "",
  dashboard: { enabled: true, host: "127.0.0.1", port: 4787 },
  telegram: { botToken: "test-token", allowedUserId: "123" }
};

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-dashboard-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
  database.registerProject({ key: "boo", name: "Boo", path: tempDir, defaultBranch: "master" });
  database.createTask("testar dashboard", "telegram", "boo");
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("dashboard", () => {
  it("builds an operational snapshot without private telegram identifiers", () => {
    const snapshot = buildDashboardSnapshot(config, database);

    expect(snapshot.summary.projects).toBe(1);
    expect(snapshot.summary.queuedTasks).toBe(1);
    expect(snapshot.projects[0].key).toBe("boo");
    expect(JSON.stringify(snapshot)).not.toContain("test-token");
    expect(JSON.stringify(snapshot)).not.toContain('"123"');
  });

  it("serves the dashboard API and creates a queued task", async () => {
    const server = createDashboardServer({ config, database, staticRoot: tempDir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const dashboardResponse = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      expect(dashboardResponse.status).toBe(200);
      const dashboard = await dashboardResponse.json() as { summary: { projects: number } };
      expect(dashboard.summary.projects).toBe(1);

      const taskResponse = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKey: "boo", text: "nova task visual" })
      });
      expect(taskResponse.status).toBe(201);
      expect(database.listTasksByProject("boo")).toHaveLength(2);
      expect(database.getLastEvent()?.source).toBe("dashboard");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
