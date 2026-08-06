import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentExecutionResult, AgentProviderId } from "../agents/types.js";
import { AgentRegistry } from "../agents/registry.js";
import type { GoalPhase, GoalWaitReason, MaestroDatabase } from "../db.js";
import { redactSensitiveText } from "../security/redaction.js";
import { writeWorkerResultArtifacts } from "./artifacts.js";
import { scheduleWorkerBatch } from "./scheduler.js";
import type { WorkGraphDetails, WorkerNodeRecord } from "./types.js";
import { validateWorkGraph } from "./validator.js";

export type WorkGraphRunnerOptions = {
  artifactsRoot: string;
  signal?: AbortSignal;
  onProgress?: (graph: WorkGraphDetails, node: WorkerNodeRecord, provider: AgentProviderId) => void;
};

export const WORK_GRAPH_RUNTIME_SHUTDOWN = "maestro_runtime_shutdown";

export async function runWorkGraph(
  database: MaestroDatabase,
  registry: AgentRegistry,
  graphId: number,
  options: WorkGraphRunnerOptions
): Promise<WorkGraphDetails> {
  let graph = database.getWorkGraphDetails(graphId);
  const run = database.getGoalRun(graph.runId);
  const task = database.getTask(run.taskId);
  const validation = validateWorkGraph(graph);
  if (!validation.valid) {
    const error = validation.issues.map((issue) => issue.message).join(" ");
    return finishGraph(database, graph, "blocked", error, "work_graph.validation_failed");
  }
  if (graph.status === "draft") graph = { ...database.updateWorkGraphStatus(graph.id, "validated"), nodes: graph.nodes };
  if (graph.status === "validated" || graph.status === "waiting_provider") {
    database.updateWorkGraphStatus(graph.id, "running");
  }
  if (!task.projectKey || !task.worktreePath) throw new Error("Work Graph Task requires a prepared project worktree.");
  const worktreePath = task.worktreePath;
  const project = database.getProjectByKey(task.projectKey);

  while (true) {
    graph = database.getWorkGraphDetails(graph.id);
    if (options.signal?.aborted) {
      return options.signal.reason === WORK_GRAPH_RUNTIME_SHUTDOWN
        ? interruptGraph(database, graph)
        : cancelGraph(database, graph);
    }
    const schedule = scheduleWorkerBatch(graph);
    if (schedule.complete) {
      return finishGraph(database, graph, "completed");
    }
    if (schedule.blocked || schedule.ready.length === 0 && schedule.waiting.length === 0) {
      return finishGraph(database, graph, "blocked", "Work Graph has no schedulable Worker Nodes.");
    }
    if (schedule.ready.length === 0) {
      database.updateWorkGraphStatus(graph.id, "waiting_provider");
      return database.getWorkGraphDetails(graph.id);
    }

    const results = await Promise.all(schedule.ready.map(async (scheduledNode) => {
      const node = database.updateWorkerNodeStatus(scheduledNode.id, "ready");
      const failedProviders = new Set(
        database.listWorkerAttempts(node.id)
          .filter((attempt) => !["completed", "running"].includes(attempt.status))
          .map((attempt) => attempt.provider)
      );
      const lease = await registry.acquire(node.capability, failedProviders)
        ?? (failedProviders.size > 0 ? await registry.acquire(node.capability) : null);
      if (!lease) {
        const availability = await registry.nextAvailability(node.capability);
        const wait = persistProviderWait(database, graph, node, {
          reason: availability.reason,
          retryAfterMs: availability.retryAfterMs,
          provider: availability.provider ?? undefined,
          summary: `No ready Provider for ${node.capability}.`
        });
        database.updateWorkerNodeStatus(node.id, "waiting_provider", wait.summary);
        return { progressed: false, waiting: true, cancelled: false };
      }
      const attempt = database.createWorkerAttempt(node.id, lease.provider.id);
      options.onProgress?.(database.getWorkGraphDetails(graph.id), node, lease.provider.id);
      const beforeState = captureWorktreeState(worktreePath);
      let result: AgentExecutionResult | undefined;
      try {
        const artifacts = database.listWorkerArtifacts(graph.id);
        const dependencyIds = new Set(
          graph.nodes.filter((candidate) => node.dependsOn.includes(candidate.key)).map((candidate) => candidate.id)
        );
        result = await lease.provider.execute({
          runId: run.id,
          stepNumber: attempt.id,
          phase: phaseForNode(node),
          capability: node.capability,
          task,
          project,
          previousSteps: database.listGoalSteps(run.id),
          workerContext: {
            graphId: graph.id,
            nodeId: node.id,
            key: node.key,
            role: node.role,
            objective: node.objective,
            outputContract: node.outputContract,
            mode: node.mode,
            writeScope: node.writeScope,
            inputArtifacts: artifacts
              .filter((artifact) => dependencyIds.has(artifact.nodeId) || node.inputArtifacts.includes(artifact.key))
              .map((artifact) => ({ key: artifact.key, summary: artifact.summary }))
          },
          artifactsRoot: path.resolve(options.artifactsRoot),
          deadlineAt: Date.now() + node.deadlineMs,
          signal: options.signal
        });
      } catch (error) {
        result = {
          outcome: "failed",
          summary: "Worker provider execution failed.",
          output: "",
          error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
          durationMs: 0,
          retryable: false
        };
      } finally {
        lease.release(result);
      }
      if (!result) throw new Error("Worker provider returned no execution result.");
      const afterState = captureWorktreeState(worktreePath);
      const scopeError = node.mode === "writer"
        ? validateWriteScope(beforeState, afterState, node.writeScope)
        : validateReadOnlyState(beforeState, afterState);
      const scopedResult = scopeError
        ? { ...result, outcome: "blocked" as const, summary: scopeError, error: scopeError, retryable: false }
        : result;
      const runtimeInterrupted = options.signal?.aborted && options.signal.reason === WORK_GRAPH_RUNTIME_SHUTDOWN;
      const effectiveResult = options.signal?.aborted
        ? {
            ...scopedResult,
            outcome: "cancelled" as const,
            summary: scopedResult.summary || "Work Graph cancelled.",
            error: scopedResult.error ?? null,
            retryable: false
          }
        : scopedResult;
      const finished = database.finishWorkerAttempt({
        id: attempt.id,
        status: effectiveResult.outcome,
        summary: effectiveResult.summary,
        error: effectiveResult.error,
        durationMs: effectiveResult.durationMs
      });
      writeWorkerResultArtifacts({
        database,
        artifactsRoot: options.artifactsRoot,
        graphId: graph.id,
        runId: run.id,
        node,
        attempt: finished,
        summary: effectiveResult.summary,
        output: effectiveResult.output
      });
      const retryProviderBlock = effectiveResult.outcome === "blocked"
        && !scopeError
        && !options.signal?.aborted
        && finished.attemptNumber < node.maxAttempts;
      const nodeStatus = runtimeInterrupted
        ? finished.attemptNumber >= node.maxAttempts ? "blocked" : "waiting_provider"
        : retryProviderBlock
          ? "failed"
          : statusForResult(effectiveResult, finished.attemptNumber >= node.maxAttempts);
      database.updateWorkerNodeStatus(node.id, nodeStatus, effectiveResult.error);
      database.addEvent({
        source: lease.provider.id,
        type: "work_graph.worker_finished",
        text: `${node.key}: ${effectiveResult.summary}`,
        taskId: task.id,
        metadata: {
          graphId: graph.id,
          nodeId: node.id,
          attemptId: attempt.id,
          outcome: effectiveResult.outcome,
          durationMs: effectiveResult.durationMs
        }
      });
      if (nodeStatus === "waiting_provider") {
        persistProviderWait(database, graph, node, {
          reason: effectiveResult.failureCategory ?? "unknown",
          retryAfterMs: effectiveResult.retryAfterMs,
          provider: lease.provider.id,
          summary: effectiveResult.summary || effectiveResult.error || `Provider unavailable for ${node.capability}.`
        });
      }
      return {
        progressed: effectiveResult.outcome === "completed",
        waiting: nodeStatus === "waiting_provider",
        cancelled: nodeStatus === "cancelled",
        interrupted: runtimeInterrupted
      };
    }));
    if (results.some((result) => result.cancelled)) {
      return cancelGraph(database, database.getWorkGraphDetails(graph.id));
    }
    if (results.some((result) => result.waiting) && !results.some((result) => result.progressed)) {
      database.updateWorkGraphStatus(graph.id, "waiting_provider");
      return database.getWorkGraphDetails(graph.id);
    }
  }
}

function phaseForNode(node: WorkerNodeRecord): GoalPhase {
  if (node.role === "implementer") return "implementing";
  if (node.role === "tester") return "testing";
  if (node.role === "reviewer") return "reviewing";
  return "planning";
}

function statusForResult(
  result: AgentExecutionResult,
  exhausted: boolean
): "completed" | "failed" | "blocked" | "cancelled" | "waiting_provider" {
  if (result.outcome === "completed") return "completed";
  if (result.outcome === "cancelled") return "cancelled";
  if (result.outcome === "blocked" || exhausted) return "blocked";
  if (result.retryable) return "waiting_provider";
  return "failed";
}

function interruptGraph(database: MaestroDatabase, graph: WorkGraphDetails): WorkGraphDetails {
  for (const node of graph.nodes) {
    if (["ready", "running"].includes(node.status)) {
      const status = node.attemptCount >= node.maxAttempts ? "blocked" : "waiting_provider";
      database.updateWorkerNodeStatus(node.id, status, "Maestro runtime stopped; partial worktree preserved.");
    }
  }
  const latest = database.getWorkGraphDetails(graph.id);
  const blocked = latest.nodes.some((node) => node.status === "blocked");
  database.updateWorkGraphStatus(graph.id, blocked ? "blocked" : "waiting_provider");
  const run = database.getGoalRun(graph.runId);
  database.addEvent({
    source: "maestro",
    type: blocked ? "work_graph.shutdown_blocked" : "work_graph.interrupted",
    text: "Maestro runtime stopped; partial worktree preserved.",
    taskId: run.taskId,
    metadata: { graphId: graph.id, runId: run.id, worktreePreserved: true }
  });
  return database.getWorkGraphDetails(graph.id);
}

function cancelGraph(database: MaestroDatabase, graph: WorkGraphDetails): WorkGraphDetails {
  for (const node of graph.nodes) {
    if (!["completed", "blocked", "cancelled"].includes(node.status)) {
      database.updateWorkerNodeStatus(node.id, "cancelled", "Work Graph cancelled.");
    }
  }
  database.updateWorkGraphStatus(graph.id, "cancelled");
  const run = database.getGoalRun(graph.runId);
  database.addEvent({
    source: "maestro",
    type: "work_graph.cancelled",
    text: graph.objective,
    taskId: run.taskId,
    metadata: { graphId: graph.id, runId: run.id }
  });
  return database.getWorkGraphDetails(graph.id);
}

function finishGraph(
  database: MaestroDatabase,
  graph: WorkGraphDetails,
  status: "completed" | "blocked",
  error?: string | null,
  eventType = `work_graph.${status}`
): WorkGraphDetails {
  const run = database.getGoalRun(graph.runId);
  database.withTransaction(() => {
    database.updateWorkGraphStatus(graph.id, status);
    database.addEvent({
      source: "maestro",
      type: eventType,
      text: status === "completed" ? graph.objective : error ?? "Work Graph blocked.",
      taskId: run.taskId,
      metadata: { graphId: graph.id, runId: run.id }
    });
  });
  return database.getWorkGraphDetails(graph.id);
}

function persistProviderWait(
  database: MaestroDatabase,
  graph: WorkGraphDetails,
  node: WorkerNodeRecord,
  wait: {
    reason: GoalWaitReason;
    retryAfterMs?: number;
    provider?: AgentProviderId;
    summary: string;
  }
): { summary: string } {
  const run = database.getGoalRun(graph.runId);
  const summary = redactSensitiveText(wait.summary);
  database.addEvent({
    source: "maestro",
    type: "work_graph.waiting_provider",
    text: summary,
    taskId: run.taskId,
    metadata: {
      graphId: graph.id,
      runId: run.id,
      nodeId: node.id,
      nodeKey: node.key,
      waitReason: wait.reason,
      retryAfterMs: wait.retryAfterMs ?? null,
      provider: wait.provider ?? null
    }
  });
  return { summary };
}

function changedPaths(worktreePath: string): string[] {
  const output = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: worktreePath,
    encoding: "utf8",
    windowsHide: true
  });
  return output.split("\0").filter(Boolean).map((entry) => {
    const value = entry.slice(3).trim();
    const renamed = value.includes(" -> ") ? value.split(" -> ").at(-1)! : value;
    return renamed.replaceAll("\\", "/");
  });
}

function captureWorktreeState(worktreePath: string): Map<string, string> {
  return new Map(changedPaths(worktreePath).map((filePath) => [
    filePath,
    fingerprintPath(path.join(worktreePath, filePath))
  ]));
}

function fingerprintPath(filePath: string): string {
  if (!fs.existsSync(filePath)) return "missing";
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(filePath)}`;
  if (!stat.isFile()) return `other:${stat.mode}:${stat.size}`;
  return `file:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function changedStatePaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((filePath) => before.get(filePath) !== after.get(filePath));
}

function validateReadOnlyState(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string | null {
  const changed = changedStatePaths(before, after);
  return changed.length > 0
    ? `Read-only Worker changed repository paths: ${changed.map((entry) => redactSensitiveText(entry)).join(", ")}`
    : null;
}

function validateWriteScope(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  scopes: string[]
): string | null {
  const changed = changedStatePaths(before, after);
  const outside = changed.filter((entry) => !scopes.some((scope) => pathMatchesScope(entry, scope)));
  return outside.length > 0
    ? `Writer changed paths outside its lease: ${outside.map((entry) => redactSensitiveText(entry)).join(", ")}`
    : null;
}

function pathMatchesScope(filePath: string, scope: string): boolean {
  const normalized = scope.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("..")) return false;
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3);
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  }
  if (normalized.endsWith("/*")) {
    const prefix = normalized.slice(0, -2);
    return filePath.startsWith(`${prefix}/`) && !filePath.slice(prefix.length + 1).includes("/");
  }
  return filePath === normalized || filePath.startsWith(`${normalized}/`);
}
