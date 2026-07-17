import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/agents/registry.js";
import type {
  AgentCapability,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentProvider,
  AgentProviderId
} from "../src/agents/types.js";
import { ApplicationCommands } from "../src/commands/application-commands.js";
import { createDatabase, type MaestroDatabase } from "../src/db.js";
import { ManualScheduler } from "../src/goals/scheduler.js";
import { WorkGraphCoordinator } from "../src/work-graphs/coordinator.js";
import type { WorkGraphInput } from "../src/work-graphs/types.js";

let root: string;
let projectPath: string;
let artifactsRoot: string;
let databasePath: string;
let database: MaestroDatabase;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-work-graph-coordinator-"));
  projectPath = path.join(root, "project");
  artifactsRoot = path.join(root, "artifacts");
  databasePath = path.join(root, "maestro.db");
  fs.mkdirSync(projectPath);
  execFileSync("git", ["init", "-b", "main"], { cwd: projectPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "maestro@example.test"], { cwd: projectPath });
  execFileSync("git", ["config", "user.name", "Maestro Test"], { cwd: projectPath });
  fs.writeFileSync(path.join(projectPath, "README.md"), "fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: projectPath });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: projectPath, stdio: "ignore" });
  database = createDatabase(databasePath);
  database.registerProject({ key: "fixture", path: projectPath, defaultBranch: "main" });
});

afterEach(() => {
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("WorkGraphCoordinator", () => {
  it("deduplicates active execution and awaits provider cancellation through the shared command", async () => {
    let calls = 0;
    let observedSignal: AbortSignal | undefined;
    const provider = new FakeProvider("codex", ["research"], async (request) => {
      calls += 1;
      observedSignal = request.signal;
      return new Promise((resolve) => {
        request.signal?.addEventListener("abort", () => resolve(cancelled()), { once: true });
      });
    });
    const graph = createPreparedGraph(singleNodeGraph("Coordinate cancellation."));
    const coordinator = new WorkGraphCoordinator(database, new AgentRegistry([provider]), artifactsRoot);
    const commands = new ApplicationCommands(database, undefined, coordinator);

    coordinator.start(graph.id);
    coordinator.start(graph.id);
    await waitFor(() => database.listWorkerAttempts(graph.nodes[0]!.id).length === 1);
    const result = await commands.cancelWorkGraph(
      { channel: "dashboard" },
      graph.id,
      "Operator stopped the graph."
    );

    expect(result.status).toBe("cancelled");
    expect(observedSignal?.aborted).toBe(true);
    expect(calls).toBe(1);
    expect(database.listWorkerAttempts(graph.nodes[0]!.id)[0]?.status).toBe("cancelled");
    expect(database.getGoalRun(graph.runId).status).toBe("running");
    expect(database.getTask(database.getGoalRun(graph.runId).taskId).status).toBe("planning");
    await coordinator.shutdown();
  });

  it("persists provider wait evidence without consuming an attempt or hijacking Goal lifecycle", async () => {
    const scheduler = new ManualScheduler();
    const graph = createPreparedGraph(singleNodeGraph("Wait for a provider."));
    const coordinator = new WorkGraphCoordinator(database, new AgentRegistry([]), artifactsRoot, 20, scheduler);

    coordinator.start(graph.id);
    await waitFor(() => database.getWorkGraphDetails(graph.id).status === "waiting_provider");
    await waitFor(() => scheduler.pendingCount === 1);

    const node = database.getWorkGraphDetails(graph.id).nodes[0]!;
    const run = database.getGoalRun(graph.runId);
    expect(node).toMatchObject({ status: "waiting_provider", attemptCount: 0 });
    expect(database.listWorkerAttempts(node.id)).toHaveLength(0);
    expect(run.status).toBe("running");
    expect(database.getTask(run.taskId).status).toBe("planning");
    expect(database.listEvents().some((event) => event.type === "work_graph.waiting_provider")).toBe(true);
    await coordinator.shutdown();
  });

  it("recovers a graph without rerunning completed nodes or completing the owning Goal", async () => {
    const graph = createPreparedGraph(twoNodeGraph());
    database.updateWorkGraphStatus(graph.id, "validated");
    database.updateWorkGraphStatus(graph.id, "running");
    const completedNode = graph.nodes[0]!;
    database.updateWorkerNodeStatus(completedNode.id, "ready");
    const attempt = database.createWorkerAttempt(completedNode.id, "codex");
    database.finishWorkerAttempt({ id: attempt.id, status: "completed", summary: "Research done.", durationMs: 1 });
    database.updateWorkerNodeStatus(completedNode.id, "completed");
    database.addWorkerArtifact({
      graphId: graph.id,
      nodeId: completedNode.id,
      attemptId: attempt.id,
      key: `goal-${graph.runId}/work-graph-${graph.id}/node-research/attempt-1/handoff.md`,
      kind: "handoff",
      summary: "Research done.",
      bytes: 14
    });
    reopenDatabase();

    let executedNode: string | undefined;
    const provider = new FakeProvider("codex", ["coding"], async (request) => {
      executedNode = request.workerContext?.key;
      return completed("implementation done");
    });
    const coordinator = new WorkGraphCoordinator(database, new AgentRegistry([provider]), artifactsRoot);

    expect(coordinator.recoverActiveGraphs()).toBe(1);
    await waitFor(() => database.getWorkGraphDetails(graph.id).status === "completed");

    expect(executedNode).toBe("implement");
    expect(database.listWorkerAttempts(completedNode.id)).toHaveLength(1);
    expect(database.listWorkerArtifacts(graph.id, completedNode.id)).toHaveLength(1);
    expect(database.getGoalRun(graph.runId).status).toBe("running");
    await coordinator.shutdown();
  });

  it("finalizes an interrupted attempt and resumes with a new provider lineage", async () => {
    const graph = createPreparedGraph(singleNodeGraph("Resume interrupted attempt.", 2));
    database.updateWorkGraphStatus(graph.id, "validated");
    database.updateWorkGraphStatus(graph.id, "running");
    const node = graph.nodes[0]!;
    database.updateWorkerNodeStatus(node.id, "ready");
    const interruptedAttempt = database.createWorkerAttempt(node.id, "claude");
    reopenDatabase();

    const scheduler = new ManualScheduler();
    const provider = new FakeProvider("codex", ["research"], async () => completed("resumed attempt"));
    const coordinator = new WorkGraphCoordinator(database, new AgentRegistry([provider]), artifactsRoot, 20, scheduler);

    expect(coordinator.recoverActiveGraphs()).toBe(1);
    expect(database.getWorkGraphDetails(graph.id).status).toBe("waiting_provider");
    expect(database.listWorkerAttempts(node.id)).toEqual([
      expect.objectContaining({ id: interruptedAttempt.id, provider: "claude", status: "cancelled" })
    ]);

    scheduler.flush();
    await waitFor(() => database.getWorkGraphDetails(graph.id).status === "completed");

    expect(database.listWorkerAttempts(node.id)).toEqual([
      expect.objectContaining({ attemptNumber: 1, provider: "claude", status: "cancelled" }),
      expect.objectContaining({ attemptNumber: 2, provider: "codex", status: "completed" })
    ]);
    expect(database.listWorkerArtifacts(graph.id, node.id)).toHaveLength(2);
    expect(database.getGoalRun(graph.runId).status).toBe("running");
    await coordinator.shutdown();
  });

  it("turns graceful runtime shutdown into recoverable evidence instead of operator cancellation", async () => {
    const graph = createPreparedGraph(singleNodeGraph("Preserve shutdown progress.", 2));
    const provider = new FakeProvider("codex", ["research"], async (request) => new Promise((resolve) => {
      request.signal?.addEventListener("abort", () => resolve(cancelled()), { once: true });
    }));
    const coordinator = new WorkGraphCoordinator(database, new AgentRegistry([provider]), artifactsRoot);

    coordinator.start(graph.id);
    await waitFor(() => database.listWorkerAttempts(graph.nodes[0]!.id).length === 1);
    await coordinator.shutdown();

    expect(database.getWorkGraphDetails(graph.id)).toMatchObject({ status: "waiting_provider" });
    expect(database.getWorkGraphDetails(graph.id).nodes[0]).toMatchObject({ status: "waiting_provider" });
    expect(database.listWorkerAttempts(graph.nodes[0]!.id)[0]).toMatchObject({ status: "cancelled" });
    expect(database.getGoalRun(graph.runId).status).toBe("running");
  });
});

function reopenDatabase() {
  database.close();
  database = createDatabase(databasePath);
}

function createPreparedGraph(input: Omit<WorkGraphInput, "runId">) {
  const task = database.createTask(input.objective, "dashboard", "fixture");
  database.updateTaskWorktree({
    id: task.id,
    status: "planning",
    branchName: "maestro/test-work-graph",
    worktreePath: projectPath
  });
  const run = database.createGoalRun(task.id, 8);
  return database.createWorkGraph({ ...input, runId: run.id });
}

function singleNodeGraph(objective: string, maxAttempts = 1): Omit<WorkGraphInput, "runId"> {
  return {
    objective,
    nodes: [{
      key: "research",
      role: "researcher",
      objective: "Inspect the repository.",
      capability: "research",
      outputContract: "Research report.",
      mode: "read_only",
      budget: { maxAttempts, deadlineMs: 30_000, outputChars: 2_000 }
    }]
  };
}

function twoNodeGraph(): Omit<WorkGraphInput, "runId"> {
  return {
    objective: "Research then implement.",
    nodes: [
      {
        key: "research",
        role: "researcher",
        objective: "Inspect the repository.",
        capability: "research",
        outputContract: "Research report.",
        mode: "read_only",
        budget: { maxAttempts: 1, deadlineMs: 30_000, outputChars: 2_000 }
      },
      {
        key: "implement",
        role: "implementer",
        objective: "Implement the change.",
        capability: "coding",
        dependsOn: ["research"],
        outputContract: "Implementation report.",
        mode: "writer",
        writeScope: ["src/work-graphs"],
        budget: { maxAttempts: 1, deadlineMs: 30_000, outputChars: 2_000 }
      }
    ]
  };
}

class FakeProvider implements AgentProvider {
  readonly label: string;
  readonly capabilities: ReadonlySet<AgentCapability>;

  constructor(
    readonly id: AgentProviderId,
    capabilities: AgentCapability[],
    private readonly handler: (request: AgentExecutionRequest) => Promise<AgentExecutionResult>
  ) {
    this.label = id;
    this.capabilities = new Set(capabilities);
  }

  async health() {
    return { state: "ready" as const, detail: "test", checkedAt: new Date().toISOString() };
  }

  async execute(request: AgentExecutionRequest) {
    return this.handler(request);
  }
}

function completed(summary: string): AgentExecutionResult {
  return {
    outcome: "completed",
    summary,
    output: summary,
    error: null,
    durationMs: 1,
    retryable: false
  };
}

function cancelled(): AgentExecutionResult {
  return {
    outcome: "cancelled",
    summary: "cancelled",
    output: "",
    error: null,
    durationMs: 1,
    retryable: false
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Work Graph state.");
}
