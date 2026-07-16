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
import { createDatabase, type MaestroDatabase } from "../src/db.js";
import { runWorkGraph } from "../src/work-graphs/runner.js";
import type { WorkGraphInput } from "../src/work-graphs/types.js";

let root: string;
let projectPath: string;
let artifactsRoot: string;
let database: MaestroDatabase;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-work-graph-runner-"));
  projectPath = path.join(root, "project");
  artifactsRoot = path.join(root, "artifacts");
  fs.mkdirSync(projectPath);
  execFileSync("git", ["init", "-b", "main"], { cwd: projectPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "maestro@example.test"], { cwd: projectPath });
  execFileSync("git", ["config", "user.name", "Maestro Test"], { cwd: projectPath });
  fs.writeFileSync(path.join(projectPath, "README.md"), "fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: projectPath });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: projectPath, stdio: "ignore" });
  database = createDatabase(path.join(root, "maestro.db"));
  database.registerProject({ key: "fixture", path: projectPath, defaultBranch: "main" });
});

afterEach(() => {
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Work Graph runner", () => {
  it("runs independent readers concurrently and passes their artifacts to the writer", async () => {
    let activeReaders = 0;
    let maxActiveReaders = 0;
    let writerContext: AgentExecutionRequest["workerContext"];
    const handler = async (request: AgentExecutionRequest): Promise<AgentExecutionResult> => {
      if (request.workerContext?.mode === "read_only") {
        activeReaders += 1;
        maxActiveReaders = Math.max(maxActiveReaders, activeReaders);
        await delay(25);
        activeReaders -= 1;
      } else {
        writerContext = request.workerContext;
        const target = path.join(request.task.worktreePath!, "src", "work-graphs", "implemented.ts");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "export const implemented = true;\n", "utf8");
      }
      return completed(`${request.workerContext?.key} completed`);
    };
    const providers = [
      new FakeProvider("claude", ["research", "planning"], handler),
      new FakeProvider("codex", ["research", "planning", "coding"], handler)
    ];
    const graph = createPreparedGraph(graphInput());

    const finished = await runWorkGraph(database, new AgentRegistry(providers), graph.id, { artifactsRoot });

    expect(finished.status).toBe("completed");
    expect(finished.nodes.every((node) => node.status === "completed")).toBe(true);
    expect(maxActiveReaders).toBe(2);
    expect(writerContext?.inputArtifacts).toHaveLength(4);
    expect(writerContext?.inputArtifacts.map((artifact) => artifact.key)).toEqual(expect.arrayContaining([
      expect.stringContaining("node-research"),
      expect.stringContaining("node-plan")
    ]));
    expect(database.listWorkerArtifacts(graph.id)).toHaveLength(6);
  });

  it("preserves writer changes and blocks the graph when a path escapes its lease", async () => {
    const provider = new FakeProvider("codex", ["coding"], async (request) => {
      fs.writeFileSync(path.join(request.task.worktreePath!, "outside.txt"), "preserve me\n", "utf8");
      return completed("implemented");
    });
    const graph = createPreparedGraph({
      objective: "Implement one scoped change.",
      nodes: [{
        key: "implement",
        role: "implementer",
        objective: "Implement inside the leased directory.",
        capability: "coding",
        outputContract: "Code and report.",
        mode: "writer",
        writeScope: ["src/allowed"],
        budget: { maxAttempts: 1, deadlineMs: 30_000, outputChars: 2_000 }
      }]
    });

    const finished = await runWorkGraph(database, new AgentRegistry([provider]), graph.id, { artifactsRoot });

    expect(finished.status).toBe("blocked");
    expect(finished.nodes[0]).toMatchObject({ status: "blocked" });
    expect(finished.nodes[0]!.lastError).toContain("outside.txt");
    expect(fs.readFileSync(path.join(projectPath, "outside.txt"), "utf8")).toBe("preserve me\n");
  });

  it("blocks a read-only tester that mutates the worktree", async () => {
    const provider = new FakeProvider("claude", ["testing"], async (request) => {
      fs.writeFileSync(path.join(request.task.worktreePath!, "README.md"), "mutated by tester\n", "utf8");
      return completed("tests passed");
    });
    const graph = createPreparedGraph({
      objective: "Validate without editing.",
      nodes: [{
        key: "test",
        role: "tester",
        objective: "Run validation without changing files.",
        capability: "testing",
        outputContract: "Test report.",
        mode: "read_only",
        budget: { maxAttempts: 1, deadlineMs: 30_000, outputChars: 2_000 }
      }]
    });

    const finished = await runWorkGraph(database, new AgentRegistry([provider]), graph.id, { artifactsRoot });

    expect(finished.status).toBe("blocked");
    expect(finished.nodes[0]).toMatchObject({ status: "blocked" });
    expect(finished.nodes[0]!.lastError).toContain("Read-only Worker changed repository paths: README.md");
  });

  it("waits without spending an attempt when no provider is available", async () => {
    const graph = createPreparedGraph({
      objective: "Research one question.",
      nodes: [{
        key: "research",
        role: "researcher",
        objective: "Inspect the repository.",
        capability: "research",
        outputContract: "Research report.",
        mode: "read_only",
        budget: { maxAttempts: 2, deadlineMs: 30_000, outputChars: 2_000 }
      }]
    });

    const finished = await runWorkGraph(database, new AgentRegistry([]), graph.id, { artifactsRoot });

    expect(finished.status).toBe("waiting_provider");
    expect(finished.nodes[0]).toMatchObject({ status: "waiting_provider", attemptCount: 0 });
  });
});

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

function graphInput(): Omit<WorkGraphInput, "runId"> {
  return {
    objective: "Research, plan and implement one complex change.",
    nodes: [
      {
        key: "research",
        role: "researcher",
        objective: "Map relevant modules.",
        capability: "research",
        outputContract: "Research artifact.",
        mode: "read_only",
        budget: { maxAttempts: 2, deadlineMs: 30_000, outputChars: 2_000 }
      },
      {
        key: "plan",
        role: "planner",
        objective: "Produce a bounded plan.",
        capability: "planning",
        outputContract: "Plan artifact.",
        mode: "read_only",
        budget: { maxAttempts: 2, deadlineMs: 30_000, outputChars: 2_000 }
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
