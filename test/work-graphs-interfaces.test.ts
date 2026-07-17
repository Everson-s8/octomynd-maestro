import fs from "node:fs";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApplicationCommands } from "../src/commands/application-commands.js";
import { MaestroConfig } from "../src/config.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { buildDashboardSnapshot } from "../src/dashboard/snapshot.js";
import { createDatabase, type MaestroDatabase } from "../src/db.js";
import { formatStatus, formatWorkGraphs } from "../src/telegram/bot.js";
import type { WorkGraphInput } from "../src/work-graphs/types.js";

let root: string;
let database: MaestroDatabase;
let config: MaestroConfig;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-work-graph-interfaces-"));
  database = createDatabase(path.join(root, "maestro.db"));
  database.registerProject({ key: "fixture", name: "Fixture", path: root, defaultBranch: "main" });
  config = {
    projectName: "maestro-test",
    databasePath: path.join(root, "maestro.db"),
    worktreesPath: path.join(root, "worktrees"),
    execution: {
      rootPath: root,
      worktreesPath: path.join(root, "worktrees"),
      expectedNodeVersion: "20.17.0",
      supportedNodeRange: ">=20.17.0 <21"
    },
    dashboard: { enabled: true, host: "127.0.0.1", port: 4787 },
    autopilot: { enabled: false, pollIntervalMs: 30_000, maxConcurrentGoals: 1 },
    runtime: { tokenEfficient: true },
    workGraph: { adoptionMode: "off" },
    skills: { enabled: false, catalogPath: path.join(root, "skills"), versionsPath: path.join(root, "versions"), projectKey: "fixture" },
    telegram: { botToken: "", allowedUserId: null }
  };
});

afterEach(() => {
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Work Graph interfaces", () => {
  it("publishes bounded graph state in Dashboard and Telegram without private paths", () => {
    const graph = createGraph("Inspect interfaces");
    database.addWorkerArtifact({
      graphId: graph.id,
      nodeId: graph.nodes[0]!.id,
      key: `goal-${graph.runId}/work-graph-${graph.id}/node-research/attempt-1/handoff.md`,
      kind: "handoff",
      summary: "Repository map.",
      bytes: 120
    });

    const snapshot = buildDashboardSnapshot(config, database);
    expect(snapshot.workGraphs[0]).toMatchObject({
      id: graph.id,
      projectKey: "fixture",
      artifactCount: 1,
      cancellable: true,
      nodes: [expect.objectContaining({ key: "research", maxAttempts: 2 })]
    });
    expect(JSON.stringify(snapshot.workGraphs)).not.toContain(root);

    const telegram = formatWorkGraphs(database, [graph]);
    expect(telegram).toContain(`Graph #${graph.id} @fixture`);
    expect(telegram).toContain("tentativas 0/2");
    expect(formatStatus("Maestro", database)).toContain(`graph #${graph.id} [draft]`);
  });

  it("cancels an idle graph through the shared Dashboard command and preserves evidence", async () => {
    const graph = createGraph("Cancel safely");
    const server = createDashboardServer({ config, database, staticRoot: root });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const listResponse = await fetch(`http://127.0.0.1:${port}/api/work-graphs`);
      expect(listResponse.status).toBe(200);
      expect((await listResponse.json() as { workGraphs: unknown[] }).workGraphs).toHaveLength(1);

      const cancelResponse = await fetch(`http://127.0.0.1:${port}/api/work-graphs/${graph.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Operator changed priority." })
      });
      expect(cancelResponse.status).toBe(200);
      const cancelled = (await cancelResponse.json() as { workGraph: ReturnType<MaestroDatabase["getWorkGraphDetails"]> }).workGraph;
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.nodes.every((node) => node.status === "cancelled")).toBe(true);
      expect(database.listEvents().find((event) => event.type === "work_graph.cancelled")?.metadata.reason)
        .toBe("Operator changed priority.");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("fails closed when asked to cancel a running graph without its runtime coordinator", async () => {
    const graph = createGraph("Do not fake cancellation");
    database.updateWorkGraphStatus(graph.id, "validated");
    database.updateWorkGraphStatus(graph.id, "running");

    await expect(new ApplicationCommands(database).cancelWorkGraph(
      { channel: "dashboard" },
      graph.id
    )).rejects.toThrow("requires its runtime coordinator");
    expect(database.getWorkGraph(graph.id).status).toBe("running");
  });
});

function createGraph(objective: string) {
  const task = database.createTask(objective, "dashboard", "fixture");
  const run = database.createGoalRun(task.id, 4);
  const input: WorkGraphInput = {
    runId: run.id,
    objective,
    nodes: [{
      key: "research",
      role: "researcher",
      objective: "Inspect the repository.",
      capability: "research",
      outputContract: "A bounded repository map.",
      mode: "read_only",
      budget: { maxAttempts: 2, deadlineMs: 30_000, outputChars: 2_000 }
    }]
  };
  return database.createWorkGraph(input);
}
