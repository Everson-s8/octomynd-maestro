import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type MaestroDatabase } from "../src/db.js";
import type { WorkGraphInput } from "../src/work-graphs/types.js";

let tempDir: string;
let databasePath: string;
let database: MaestroDatabase;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-work-graph-"));
  databasePath = path.join(tempDir, "maestro.db");
  database = createDatabase(databasePath);
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Work Graph persistence", () => {
  it("persists a graph, ordered nodes, attempts and artifact references", () => {
    const run = database.createGoalRun(database.createTask("Implement a complex feature").id);
    const graph = database.createWorkGraph(graphInput(run.id));

    expect(graph.status).toBe("draft");
    expect(graph.nodes.map((node) => node.key)).toEqual(["research", "implementation"]);
    expect(database.findWorkGraphByRunId(run.id)?.id).toBe(graph.id);

    database.updateWorkGraphStatus(graph.id, "validated");
    database.updateWorkGraphStatus(graph.id, "running");
    const researcher = graph.nodes[0]!;
    database.updateWorkerNodeStatus(researcher.id, "ready");
    const attempt = database.createWorkerAttempt(researcher.id, "codex");
    expect(attempt.attemptNumber).toBe(1);
    const finished = database.finishWorkerAttempt({
      id: attempt.id,
      status: "completed",
      summary: "Mapped the affected modules.",
      durationMs: 120
    });
    database.updateWorkerNodeStatus(researcher.id, "completed");
    const artifact = database.addWorkerArtifact({
      graphId: graph.id,
      nodeId: researcher.id,
      attemptId: attempt.id,
      key: "work-graphs/research/handoff.md",
      kind: "handoff",
      summary: "Bounded research handoff.",
      contentHash: "sha256:abc",
      bytes: 320
    });

    expect(finished.status).toBe("completed");
    expect(database.listWorkerAttempts(researcher.id)).toEqual([finished]);
    expect(database.listWorkerArtifacts(graph.id)).toEqual([artifact]);

    database.close();
    database = createDatabase(databasePath);
    expect(database.getWorkGraphDetails(graph.id).nodes[0]).toMatchObject({
      key: "research",
      status: "completed",
      attemptCount: 1
    });
    expect(database.listWorkerArtifacts(graph.id)[0]?.key).toBe("work-graphs/research/handoff.md");
  });

  it("enforces graph transitions, attempt budgets and artifact lineage", () => {
    const firstRun = database.createGoalRun(database.createTask("First graph").id);
    const secondRun = database.createGoalRun(database.createTask("Second graph").id);
    const first = database.createWorkGraph(graphInput(firstRun.id));
    const second = database.createWorkGraph(graphInput(secondRun.id));
    const firstNode = first.nodes[0]!;
    const secondNode = second.nodes[0]!;

    expect(() => database.updateWorkGraphStatus(first.id, "running")).toThrow("draft -> running");
    database.updateWorkerNodeStatus(firstNode.id, "ready");
    const attempt = database.createWorkerAttempt(firstNode.id, "claude");
    database.finishWorkerAttempt({
      id: attempt.id,
      status: "failed",
      summary: "Provider failed.",
      error: "quota",
      durationMs: 1
    });
    database.updateWorkerNodeStatus(firstNode.id, "failed", "quota");
    const retry = database.createWorkerAttempt(firstNode.id, "codex");
    database.finishWorkerAttempt({
      id: retry.id,
      status: "completed",
      summary: "Recovered.",
      durationMs: 2
    });
    expect(() => database.createWorkerAttempt(firstNode.id, "codex")).toThrow("exhausted");
    expect(() => database.addWorkerArtifact({
      graphId: second.id,
      nodeId: firstNode.id,
      key: "invalid-lineage",
      kind: "report",
      summary: "Wrong graph.",
      bytes: 1
    })).toThrow("graph and node do not match");
    expect(() => database.addWorkerArtifact({
      graphId: first.id,
      nodeId: firstNode.id,
      attemptId: database.createWorkerAttempt(
        database.updateWorkerNodeStatus(secondNode.id, "ready").id,
        "codex"
      ).id,
      key: "invalid-attempt",
      kind: "report",
      summary: "Wrong attempt.",
      bytes: 1
    })).toThrow("attempt and node do not match");
  });

  it("rejects duplicate keys and duplicate graphs for one Goal run", () => {
    const run = database.createGoalRun(database.createTask("Invalid graph").id);
    const input = graphInput(run.id);
    input.nodes[1]!.key = input.nodes[0]!.key;
    expect(() => database.createWorkGraph(input)).toThrow("keys must be unique");

    database.createWorkGraph(graphInput(run.id));
    expect(() => database.createWorkGraph(graphInput(run.id))).toThrow();
  });
});

function graphInput(runId: number): WorkGraphInput {
  return {
    runId,
    objective: "Deliver one bounded multi-agent feature.",
    maxParallelReaders: 2,
    nodes: [
      {
        key: "research",
        role: "researcher",
        objective: "Map affected modules without editing files.",
        capability: "research",
        outputContract: "A bounded module map stored as a handoff artifact.",
        mode: "read_only",
        budget: { maxAttempts: 2, deadlineMs: 60_000, outputChars: 4_000 }
      },
      {
        key: "implementation",
        role: "implementer",
        objective: "Implement the accepted design in the prepared worktree.",
        capability: "coding",
        dependsOn: ["research"],
        inputArtifacts: ["work-graphs/research/handoff.md"],
        outputContract: "Code changes and a concise implementation report.",
        mode: "writer",
        writeScope: ["src/work-graphs", "test/work-graphs-*"],
        budget: { maxAttempts: 2, deadlineMs: 120_000, outputChars: 8_000 }
      }
    ]
  };
}

