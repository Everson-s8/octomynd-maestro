import fs from "node:fs";
import type { AgentRegistry } from "../agents/registry.js";
import type { MaestroDatabase } from "../db.js";
import { Scheduler, SystemScheduler } from "../goals/scheduler.js";
import { redactSensitiveText } from "../security/redaction.js";
import { runWorkGraph, WORK_GRAPH_RUNTIME_SHUTDOWN } from "./runner.js";
import type { WorkGraphDetails, WorkerAttemptRecord } from "./types.js";

const RESTART_RETRY_DELAY_MS = 5_000;
const ACTIVE_RUN_STATUSES = new Set(["running", "waiting_provider"]);
const ACTIVE_GRAPH_STATUSES = new Set(["draft", "validated", "running", "waiting_provider"]);
const TERMINAL_GRAPH_STATUSES = new Set(["completed", "blocked", "cancelled"]);
const TERMINAL_NODE_STATUSES = new Set(["completed", "blocked", "cancelled"]);

export type WorkGraphCommandOrigin = {
  channel: string;
  userId?: string | null;
  username?: string | null;
};

type ActiveExecution = {
  runId: number;
  controller: AbortController;
  promise: Promise<WorkGraphDetails>;
};

export class WorkGraphCoordinator {
  private readonly activeByGraphId = new Map<number, ActiveExecution>();
  private readonly activeByRunId = new Map<number, number>();
  private readonly retryTimers = new Map<number, unknown>();
  private stopping = false;

  constructor(
    private readonly database: MaestroDatabase,
    private readonly registry: AgentRegistry,
    private readonly artifactsRoot: string,
    private readonly retryDelayMs = 15 * 60_000,
    private readonly scheduler: Scheduler = new SystemScheduler(),
    private readonly restartRetryDelayMs = RESTART_RETRY_DELAY_MS
  ) {}

  start(graphId: number): WorkGraphDetails {
    if (this.stopping) throw new Error("Work Graph coordinator is shutting down.");
    const graph = this.database.getWorkGraphDetails(graphId);
    if (TERMINAL_GRAPH_STATUSES.has(graph.status)) {
      throw new Error(`Work Graph #${graphId} is already ${graph.status}.`);
    }
    const run = this.database.getGoalRun(graph.runId);
    if (!ACTIVE_RUN_STATUSES.has(run.status)) {
      throw new Error(`Work Graph #${graphId} belongs to inactive Goal run #${run.id} (${run.status}).`);
    }
    if (this.activeByGraphId.has(graph.id)) return graph;
    const activeRunGraphId = this.activeByRunId.get(graph.runId);
    if (activeRunGraphId !== undefined && activeRunGraphId !== graph.id) {
      throw new Error(`Goal run #${graph.runId} already has Work Graph #${activeRunGraphId} active.`);
    }
    this.execute(graph);
    return this.database.getWorkGraphDetails(graph.id);
  }

  resume(graphId: number): WorkGraphDetails {
    return this.start(graphId);
  }

  recoverActiveGraphs(): number {
    let recovered = 0;
    for (const graph of this.database.listRecoverableWorkGraphs()) {
      const run = this.database.getGoalRun(graph.runId);
      if (!ACTIVE_RUN_STATUSES.has(run.status)) {
        this.blockGraph(graph.id, `Owning Goal run #${run.id} is ${run.status}; recovery failed closed.`);
        continue;
      }
      const prepared = this.recoverInterruptedGraph(graph);
      if (!ACTIVE_GRAPH_STATUSES.has(prepared.status)) continue;
      recovered += 1;
      if (prepared.status === "waiting_provider") {
        const delayMs = graph.status === "running" ? this.restartRetryDelayMs : this.retryDelayMs;
        this.scheduleRetry(prepared, delayMs);
      } else {
        this.start(prepared.id);
      }
    }
    return recovered;
  }

  async cancel(origin: WorkGraphCommandOrigin, graphId: number, reason?: string | null): Promise<WorkGraphDetails> {
    const graph = this.database.getWorkGraphDetails(graphId);
    if (TERMINAL_GRAPH_STATUSES.has(graph.status)) {
      throw new Error(`Work Graph #${graphId} is already ${graph.status}.`);
    }
    const cancellationReason = redactSensitiveText(reason?.trim() || "Cancelled by operator.");
    this.clearRetry(graph.id);
    const run = this.database.getGoalRun(graph.runId);
    const active = this.activeByGraphId.get(graph.id);
    if (active) {
      this.database.addEvent({
        source: origin.channel,
        type: "work_graph.cancel_requested",
        text: cancellationReason,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        taskId: run.taskId,
        metadata: { graphId: graph.id, runId: graph.runId, reason: cancellationReason }
      });
      active.controller.abort(cancellationReason);
      await active.promise.catch(() => undefined);
      return this.database.getWorkGraphDetails(graph.id);
    }

    this.database.withTransaction(() => {
      for (const node of graph.nodes) {
        if (!TERMINAL_NODE_STATUSES.has(node.status)) {
          this.database.updateWorkerNodeStatus(node.id, "cancelled", cancellationReason);
        }
      }
      this.database.updateWorkGraphStatus(graph.id, "cancelled");
      this.database.addEvent({
        source: origin.channel,
        type: "work_graph.cancelled",
        text: cancellationReason,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        taskId: run.taskId,
        metadata: { graphId: graph.id, runId: graph.runId, reason: cancellationReason }
      });
    });
    return this.database.getWorkGraphDetails(graph.id);
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const graphId of [...this.retryTimers.keys()]) this.clearRetry(graphId);
    const active = [...this.activeByGraphId.values()];
    for (const execution of active) execution.controller.abort(WORK_GRAPH_RUNTIME_SHUTDOWN);
    await Promise.allSettled(active.map((execution) => execution.promise));
  }

  isActive(graphId: number): boolean {
    return this.activeByGraphId.has(graphId) || this.retryTimers.has(graphId);
  }

  isRunActive(runId: number): boolean {
    if (this.activeByRunId.has(runId)) return true;
    return [...this.retryTimers.keys()].some((graphId) => this.database.getWorkGraph(graphId).runId === runId);
  }

  private execute(graph: WorkGraphDetails): void {
    this.clearRetry(graph.id);
    const controller = new AbortController();
    const promise = runWorkGraph(this.database, this.registry, graph.id, {
      artifactsRoot: this.artifactsRoot,
      signal: controller.signal
    });
    const active = { runId: graph.runId, controller, promise };
    this.activeByGraphId.set(graph.id, active);
    this.activeByRunId.set(graph.runId, graph.id);

    void promise.then(
      (result) => {
        this.releaseActive(graph.id, active);
        if (!this.stopping && result.status === "waiting_provider") {
          this.scheduleRetry(result, this.retryDelayMs);
        }
      },
      (error) => {
        this.releaseActive(graph.id, active);
        if (!this.stopping) {
          this.blockGraph(graph.id, error instanceof Error ? error.message : "Unknown Work Graph execution error.");
        }
      }
    );
  }

  private recoverInterruptedGraph(graph: WorkGraphDetails): WorkGraphDetails {
    if (graph.status !== "running") return graph;
    const run = this.database.getGoalRun(graph.runId);
    const task = this.database.getTask(run.taskId);
    if (!task.worktreePath || !fs.existsSync(task.worktreePath)) {
      return this.blockGraph(
        graph.id,
        task.worktreePath
          ? `Runtime recovery could not find the preserved worktree: ${task.worktreePath}`
          : "Runtime recovery could not find a recorded worktree."
      );
    }

    const runningNodes = graph.nodes.filter((node) => node.status === "running");
    if (runningNodes.length === 0) return graph;

    const summary = "Maestro runtime restarted while this Worker attempt was active; partial worktree preserved.";
    let retryable = true;
    this.database.withTransaction(() => {
      for (const node of runningNodes) {
        const latest = latestAttempt(this.database.listWorkerAttempts(node.id));
        if (latest?.status === "running") {
          this.database.finishWorkerAttempt({
            id: latest.id,
            status: "cancelled",
            summary,
            error: "runtime_restart",
            durationMs: elapsedMilliseconds(latest.createdAt)
          });
        }

        if (latest?.status === "completed") {
          this.database.updateWorkerNodeStatus(node.id, "completed");
          continue;
        }
        if (latest?.status === "blocked" || node.attemptCount >= node.maxAttempts) {
          retryable = false;
          this.database.updateWorkerNodeStatus(node.id, "blocked", `${summary} Attempt budget exhausted.`);
          continue;
        }
        this.database.updateWorkerNodeStatus(node.id, "waiting_provider", summary);
      }
      this.database.updateWorkGraphStatus(graph.id, retryable ? "waiting_provider" : "blocked");
      this.database.addEvent({
        source: "maestro",
        type: retryable ? "work_graph.recovered_after_restart" : "work_graph.recovery_blocked",
        text: summary,
        taskId: run.taskId,
        metadata: {
          graphId: graph.id,
          runId: run.id,
          nodeIds: runningNodes.map((node) => node.id),
          retryDelayMs: retryable ? this.restartRetryDelayMs : null,
          worktreePreserved: true
        }
      });
    });
    return this.database.getWorkGraphDetails(graph.id);
  }

  private scheduleRetry(graph: WorkGraphDetails, delayMs: number): void {
    if (this.stopping || this.retryTimers.has(graph.id) || this.activeByGraphId.has(graph.id)) return;
    const run = this.database.getGoalRun(graph.runId);
    const timer = this.scheduler.schedule(() => {
      this.retryTimers.delete(graph.id);
      try {
        this.start(graph.id);
      } catch (error) {
        this.database.addEvent({
          source: "maestro",
          type: "work_graph.resume_failed",
          text: error instanceof Error ? error.message : "Unknown Work Graph resume error.",
          taskId: run.taskId,
          metadata: { graphId: graph.id, runId: graph.runId }
        });
      }
    }, Math.max(0, delayMs));
    this.retryTimers.set(graph.id, timer);
  }

  private blockGraph(graphId: number, message: string): WorkGraphDetails {
    const graph = this.database.getWorkGraphDetails(graphId);
    if (TERMINAL_GRAPH_STATUSES.has(graph.status)) return graph;
    const run = this.database.getGoalRun(graph.runId);
    const safeMessage = redactSensitiveText(message);
    this.database.withTransaction(() => {
      for (const node of graph.nodes) {
        if (!TERMINAL_NODE_STATUSES.has(node.status)) {
          this.database.updateWorkerNodeStatus(node.id, "blocked", safeMessage);
        }
      }
      this.database.updateWorkGraphStatus(graph.id, "blocked");
      this.database.addEvent({
        source: "maestro",
        type: "work_graph.blocked",
        text: safeMessage,
        taskId: run.taskId,
        metadata: { graphId: graph.id, runId: graph.runId }
      });
    });
    return this.database.getWorkGraphDetails(graph.id);
  }

  private clearRetry(graphId: number): void {
    const timer = this.retryTimers.get(graphId);
    if (timer !== undefined) this.scheduler.cancel(timer);
    this.retryTimers.delete(graphId);
  }

  private releaseActive(graphId: number, active: ActiveExecution): void {
    if (this.activeByGraphId.get(graphId) !== active) return;
    this.activeByGraphId.delete(graphId);
    if (this.activeByRunId.get(active.runId) === graphId) this.activeByRunId.delete(active.runId);
  }
}

function latestAttempt(attempts: WorkerAttemptRecord[]): WorkerAttemptRecord | null {
  return attempts.at(-1) ?? null;
}

function elapsedMilliseconds(createdAt: string): number {
  const startedAt = Date.parse(createdAt);
  return Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0;
}
