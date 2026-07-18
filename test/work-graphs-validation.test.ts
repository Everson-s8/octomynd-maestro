import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type MaestroDatabase } from "../src/db.js";
import { scheduleWorkerBatch } from "../src/work-graphs/scheduler.js";
import { classifyWorkGraphComplexity, validateWorkGraph } from "../src/work-graphs/validator.js";
import type { WorkGraphInput } from "../src/work-graphs/types.js";

let root: string;
let database: MaestroDatabase;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-work-graph-validation-"));
  database = createDatabase(path.join(root, "maestro.db"));
});

afterEach(() => {
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Work Graph validation", () => {
  it("accepts a bounded DAG with two readers and one writer", () => {
    const graph = createGraph();
    const result = validateWorkGraph(graph, new Set(["research", "planning", "coding"]));
    expect(result).toMatchObject({ valid: true, issues: [] });
    expect(result.topologicalOrder.at(-1)).toBe("implement");
  });

  it("rejects cycles, unavailable capabilities and unsafe writer policy", () => {
    const graph = createGraph();
    graph.nodes[0]!.dependsOn = ["implement"];
    graph.nodes[1]!.mode = "writer";
    graph.nodes[1]!.writeScope = [];
    const result = validateWorkGraph(graph, new Set(["planning", "coding"]));
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "cycle",
      "provider_unavailable",
      "writer_limit",
      "writer_scope_missing"
    ]));
  });

  it("rejects role and mode combinations that could bypass the single writer policy", () => {
    const graph = createGraph();
    graph.nodes[0]!.mode = "writer";
    graph.nodes[0]!.writeScope = ["src/research"];
    graph.nodes[2]!.mode = "read_only";
    graph.nodes[2]!.writeScope = [];

    const result = validateWorkGraph(graph);

    expect(result.valid).toBe(false);
    expect(result.issues.filter((issue) => issue.code === "role_mode_mismatch")).toEqual([
      expect.objectContaining({ nodeKey: "research" }),
      expect.objectContaining({ nodeKey: "implement" })
    ]);
  });

  it("uses role-aware deadlines so bounded writers can finish substantive work", () => {
    const graph = createGraph();
    graph.nodes[0]!.deadlineMs = 6 * 60_000;
    graph.nodes[2]!.deadlineMs = 20 * 60_000;

    expect(validateWorkGraph(graph).issues.filter((issue) => issue.code === "budget_exceeded")).toEqual([]);

    graph.nodes[0]!.deadlineMs += 1;
    graph.nodes[2]!.deadlineMs += 1;
    expect(validateWorkGraph(graph).issues.filter((issue) => issue.code === "budget_exceeded")).toEqual([
      expect.objectContaining({ nodeKey: "research" }),
      expect.objectContaining({ nodeKey: "implement" })
    ]);
  });

  it("classifies only sufficiently complex Tasks as Work Graph candidates", () => {
    expect(classifyWorkGraphComplexity({ taskText: "Fix a label typo." }).mode).toBe("single_agent");
    expect(classifyWorkGraphComplexity({
      taskText: "Investigate the architecture and perform a security audit before redesigning provider routing.",
      acceptanceCriteria: ["a", "b", "c", "d"],
      estimatedFiles: 10
    })).toMatchObject({ mode: "work_graph_candidate", score: 5 });
  });
});

describe("Work Graph scheduler", () => {
  it("schedules two independent readers and waits before the writer", () => {
    const graph = createGraph();
    const first = scheduleWorkerBatch(graph);
    expect(first.ready.map((node) => node.key)).toEqual(["research", "plan"]);
    expect(first.waiting.map((node) => node.key)).toContain("implement");

    for (const node of graph.nodes.slice(0, 2)) node.status = "completed";
    const second = scheduleWorkerBatch(graph);
    expect(second.ready.map((node) => node.key)).toEqual(["implement"]);
  });

  it("never schedules a writer while another worker is active", () => {
    const graph = createGraph();
    graph.nodes[0]!.status = "running";
    graph.nodes[1]!.status = "completed";
    graph.nodes[2]!.dependsOn = ["plan"];
    expect(scheduleWorkerBatch(graph).ready).toEqual([]);
  });

  it("blocks a graph when a dependency exhausts its attempts", () => {
    const graph = createGraph();
    graph.nodes[0]!.status = "failed";
    graph.nodes[0]!.attemptCount = graph.nodes[0]!.maxAttempts;
    expect(scheduleWorkerBatch(graph).blocked).toBe(true);
  });
});

function createGraph() {
  const run = database.createGoalRun(database.createTask("Complex graph fixture").id);
  return database.createWorkGraph(graphInput(run.id));
}

function graphInput(runId: number): WorkGraphInput {
  return {
    runId,
    objective: "Research, plan and implement one complex change.",
    nodes: [
      {
        key: "research",
        role: "researcher",
        objective: "Map relevant modules.",
        capability: "research",
        outputContract: "Research artifact.",
        mode: "read_only",
        budget: { maxAttempts: 2, deadlineMs: 60_000, outputChars: 4_000 }
      },
      {
        key: "plan",
        role: "planner",
        objective: "Produce a bounded plan.",
        capability: "planning",
        outputContract: "Plan artifact.",
        mode: "read_only",
        budget: { maxAttempts: 2, deadlineMs: 60_000, outputChars: 4_000 }
      },
      {
        key: "implement",
        role: "implementer",
        objective: "Implement the accepted plan.",
        capability: "coding",
        dependsOn: ["research", "plan"],
        outputContract: "Code and implementation report.",
        mode: "writer",
        writeScope: ["src/work-graphs"],
        budget: { maxAttempts: 2, deadlineMs: 120_000, outputChars: 8_000 }
      }
    ]
  };
}
