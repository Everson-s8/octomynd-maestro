import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MaestroConfig } from "../src/config.js";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { buildDashboardSnapshot } from "../src/dashboard/snapshot.js";

let tempDir: string;
let projectDir: string;
let database: MaestroDatabase;
let config: MaestroConfig;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-dashboard-"));
  projectDir = path.join(tempDir, "boo-project");
  fs.mkdirSync(projectDir);
  runGit(["init", "-b", "master"], projectDir);
  fs.writeFileSync(path.join(projectDir, "README.md"), "# Boo test\n");
  runGit(["add", "README.md"], projectDir);
  runGit(["-c", "user.name=Maestro Test", "-c", "user.email=maestro@test.local", "commit", "-m", "Initial"], projectDir);

  config = {
    projectName: "maestro-test",
    databasePath: path.join(tempDir, "maestro.db"),
    worktreesPath: path.join(tempDir, "worktrees"),
    dashboard: { enabled: true, host: "127.0.0.1", port: 4787 },
    telegram: { botToken: "test-token", allowedUserId: "123" }
  };
  database = createDatabase(path.join(tempDir, "maestro.db"));
  database.registerProject({ key: "boo", name: "Boo", path: projectDir, defaultBranch: "master" });
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
    expect(snapshot.summary.improvementCandidates).toBe(0);
    expect(JSON.stringify(snapshot)).not.toContain("test-token");
    expect(JSON.stringify(snapshot)).not.toContain('"123"');
  });

  it("serves the dashboard API and creates a queued task", async () => {
    const server = createDashboardServer({
      config,
      database,
      staticRoot: tempDir,
      claudeReviewer: async () => ({
        status: "completed",
        content: "Aprovado com ajustes de contraste.",
        error: null,
        durationMs: 42
      })
    });
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

      const createdTask = database.listTasksByProject("boo")[0];
      const prepareResponse = await fetch(
        `http://127.0.0.1:${port}/api/tasks/${createdTask.id}/prepare`,
        { method: "POST" }
      );
      expect(prepareResponse.status).toBe(200);
      const preparedTask = database.getTask(createdTask.id);
      expect(preparedTask.status).toBe("planning");
      expect(preparedTask.worktreePath).toContain(path.join("worktrees", "boo"));
      expect(fs.existsSync(preparedTask.worktreePath!)).toBe(true);

      const reviewResponse = await fetch(
        `http://127.0.0.1:${port}/api/tasks/${createdTask.id}/reviews/claude`,
        { method: "POST" }
      );
      expect(reviewResponse.status).toBe(201);
      expect(database.listTaskReviews(createdTask.id)[0].content).toContain("contraste");

      const reviewsResponse = await fetch(
        `http://127.0.0.1:${port}/api/tasks/${createdTask.id}/reviews`
      );
      expect(reviewsResponse.status).toBe(200);
      const reviewsPayload = await reviewsResponse.json() as { reviews: Array<{ provider: string }> };
      expect(reviewsPayload.reviews[0].provider).toBe("claude");
      expect(database.getLastEvent()?.type).toBe("task.reviewed");

      const improvementResponse = await fetch(`http://127.0.0.1:${port}/api/improvements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: "integration",
          title: "Harden Telegram delivery retries",
          rationale: "Two task traces show the same transient failure.",
          proposedChange: "Add a bounded retry policy with an auditable failure event.",
          evidence: ["task:3", "event:12"],
          risk: "medium"
        })
      });
      expect(improvementResponse.status).toBe(201);
      const improvementPayload = await improvementResponse.json() as {
        improvement: { id: number; status: string };
      };
      expect(improvementPayload.improvement.status).toBe("candidate");

      const decisionResponse = await fetch(
        `http://127.0.0.1:${port}/api/improvements/${improvementPayload.improvement.id}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "approved", decisionNote: "Implement with tests." })
        }
      );
      expect(decisionResponse.status).toBe(200);
      expect(database.getImprovementProposal(improvementPayload.improvement.id).status).toBe("approved");
      expect(database.getLastEvent()?.type).toBe("improvement.approved");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

function runGit(args: string[], cwd: string) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "git test setup failed");
  }
}
