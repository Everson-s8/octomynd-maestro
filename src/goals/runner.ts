import path from "node:path";
import type {
  GoalPhase,
  GoalRunRecord,
  GoalStepStatus,
  MaestroDatabase,
  TaskStatus
} from "../db.js";
import { AgentRegistry } from "../agents/registry.js";
import { AgentCapability, AgentExecutionResult, AgentProviderId } from "../agents/types.js";
import { GoalDeliveryHandler } from "./delivery.js";
import { redactSensitiveText, truncateForDisplay } from "../security/redaction.js";
import { compressStepOutput } from "../runtime/compression.js";
import { detectLocalRtk } from "../runtime/rtk.js";
import { rawOutputArtifactKey, writeGoalStepRuntimeArtifacts } from "../runtime/artifacts.js";
import type { DeterministicValidationRunner } from "../validation/runner.js";

const LAST_ERROR_MAX_LENGTH = 300;

const PHASES: GoalPhase[] = ["planning", "implementing", "testing", "reviewing"];
const CAPABILITIES: Record<GoalPhase, AgentCapability> = {
  planning: "planning",
  implementing: "coding",
  testing: "testing",
  reviewing: "reviewing"
};

export type GoalRunnerOptions = {
  artifactsRoot: string;
  maxSteps?: number;
  existingRun?: GoalRunRecord;
  delivery?: GoalDeliveryHandler;
  tokenRuntime?: { enabled?: boolean } | false;
  validationRunner?: Pick<DeterministicValidationRunner, "run">;
  onProgress?: (run: GoalRunRecord, providerId: AgentProviderId) => void;
  signal?: AbortSignal;
};

export async function runTaskGoal(
  database: MaestroDatabase,
  registry: AgentRegistry,
  taskId: number,
  options: GoalRunnerOptions
): Promise<GoalRunRecord> {
  const task = database.getTask(taskId);
  if (!task.projectKey) throw new Error(`Task #${task.id} has no project.`);
  if (!task.worktreePath) throw new Error(`Task #${task.id} must be prepared before starting a goal.`);
  const project = database.getProjectByKey(task.projectKey);
  const run = options.existingRun ?? database.createGoalRun(task.id, options.maxSteps ?? 12);
  const isResume = run.status === "waiting_provider" || run.stepCount > 0;
  let currentRun = run;
  let phase: GoalPhase = run.currentPhase;
  let stepCount = run.stepCount;
  let excluded = initialExcludedProviders(database, run, phase);
  const tokenRuntimeEnabled = options.tokenRuntime !== false && options.tokenRuntime?.enabled !== false;
  const rtk = detectLocalRtk();

  database.addEvent({
    source: "maestro",
    type: isResume ? "goal.resumed" : "goal.started",
    text: `Goal #${run.id} ${isResume ? "resumed" : "started"} for task #${task.id}`,
    taskId: task.id,
    metadata: { runId: run.id, maxSteps: run.maxSteps }
  });

  try {
    while (stepCount < run.maxSteps) {
      if (options.signal?.aborted) {
        return cancelRun(database, currentRun, phase, stepCount, task.id);
      }
      currentRun = database.withTransaction(() => {
        database.updateTaskStatus(task.id, taskStatusForPhase(phase));
        return database.updateGoalRun({
          id: run.id,
          status: "running",
          currentPhase: phase,
          stepCount
        });
      });
      if (phase === "testing" && options.validationRunner) {
        const validationStep = database.createGoalStep(run.id, phase, "maestro-validation");
        let validation;
        try {
          validation = await options.validationRunner.run({
            workspacePath: task.worktreePath,
            artifactsRoot: path.resolve(options.artifactsRoot),
            signal: options.signal
          });
        } catch (error) {
          const message = sanitizeForRunSummary(
            error instanceof Error ? error.message : "Deterministic validation failed unexpectedly."
          );
          database.finishGoalStep({
            id: validationStep.id,
            status: "failed",
            summary: "Deterministic validation runner failed closed.",
            output: "",
            error: message,
            durationMs: 0
          });
          return finishRun(database, currentRun, "blocked", phase, stepCount, message, task.id);
        }
        stepCount += 1;
        const validationStatus: Exclude<GoalStepStatus, "running"> = validation.status === "passed"
          ? "completed"
          : "failed";
        const validationOutput = validation.compactFailure ?? validation.summary;
        const completedValidationStep = {
          ...validationStep,
          status: validationStatus,
          summary: validation.summary,
          output: validationOutput,
          error: null
        };
        const compressedValidation = compressStepOutput({
          step: completedValidationStep,
          rtk,
          rawOutputArtifact: rawOutputArtifactKey(completedValidationStep),
          enabled: tokenRuntimeEnabled
        });
        const validationArtifactKeys = writeGoalStepRuntimeArtifacts({
          artifactsRoot: path.resolve(options.artifactsRoot),
          step: completedValidationStep,
          rawOutput: [
            `summary: ${validation.summary}`,
            validationOutput,
            `validation-report: artifact:${validation.reportArtifactKey}`
          ].join("\n\n"),
          compactHandoff: compressedValidation.compactOutput,
          telemetry: compressedValidation.telemetry
        });
        database.withTransaction(() => {
          database.finishGoalStep({
            id: validationStep.id,
            status: validationStatus,
            summary: validation.summary,
            output: validationOutput,
            durationMs: validation.durationMs
          });
          database.addEvent({
            source: "maestro",
            type: `goal.validation_${validation.status}`,
            text: validation.summary,
            taskId: task.id,
            metadata: {
              runId: run.id,
              stepId: validationStep.id,
              durationMs: validation.durationMs,
              checks: validation.checks.map((check) => ({
                id: check.id,
                status: check.status,
                durationMs: check.durationMs,
                artifactKey: check.artifactKey
              })),
              reportArtifactKey: validation.reportArtifactKey,
              tokenRuntime: {
                ...compressedValidation.telemetry,
                artifacts: validationArtifactKeys
              }
            }
          });
        });
        if (validation.status === "passed") {
          phase = "reviewing";
          excluded = new Set();
          continue;
        }
      }
      let routed = await registry.acquire(CAPABILITIES[phase], excluded);
      if (!routed && excluded.size > 0) {
        excluded = new Set();
        routed = await registry.acquire(CAPABILITIES[phase]);
      }
      if (!routed) {
        const error = `No ready provider for ${CAPABILITIES[phase]}.`;
        return pauseRun(database, currentRun, phase, stepCount, error, task.id);
      }

      const goalStep = database.withTransaction(() => {
        const step = database.createGoalStep(run.id, phase, routed.provider.id);
        database.addEvent({
          source: routed.provider.id,
          type: "goal.step_started",
          text: `${phase} with ${routed.provider.label}`,
          taskId: task.id,
          metadata: { runId: run.id, stepId: step.id, phase }
        });
        return step;
      });
      options.onProgress?.(currentRun, routed.provider.id);

      const startedAt = Date.now();
      let result: AgentExecutionResult;
      try {
        const previousSteps = database.listGoalSteps(run.id).filter((step) => step.id !== goalStep.id);
        const previousStepHandoff = tokenRuntimeEnabled
          ? previousSteps.map((step) => compressStepOutput({
            step,
            rtk,
            rawOutputArtifact: rawOutputArtifactKey(step),
            enabled: true
          }).handoff)
          : undefined;
        result = await routed.provider.execute({
          runId: run.id,
          stepNumber: stepCount + 1,
          phase,
          capability: CAPABILITIES[phase],
          task: database.getTask(task.id),
          project,
          previousSteps,
          previousStepHandoff,
          tokenRuntime: {
            enabled: tokenRuntimeEnabled,
            rtk
          },
          humanFeedback: latestChangeRequest(database, run.id),
          artifactsRoot: path.resolve(options.artifactsRoot),
          signal: options.signal
        });
      } catch (error) {
        result = {
          outcome: options.signal?.aborted ? "cancelled" : "failed",
          summary: error instanceof Error ? error.message : "Unknown provider execution error.",
          output: "",
          error: error instanceof Error ? error.message : "Unknown provider execution error.",
          durationMs: Date.now() - startedAt,
          retryable: false
        };
      } finally {
        routed.release();
      }
      const countsTowardBudget = result.outcome !== "cancelled" && !(result.outcome === "failed" && result.retryable);
      if (countsTowardBudget) stepCount += 1;
      const safeSummary = redactSensitiveText(result.summary);
      const safeOutput = redactSensitiveText(result.output);
      const safeError = result.error ? redactSensitiveText(result.error) : null;
      const completedStep = {
        ...goalStep,
        status: result.outcome as Exclude<GoalStepStatus, "running">,
        summary: safeSummary,
        output: safeOutput,
        error: safeError
      };
      const rawArtifactText = [
        `summary: ${safeSummary}`,
        safeOutput ? `output:\n${safeOutput}` : "",
        safeError ? `error:\n${safeError}` : ""
      ].filter(Boolean).join("\n\n");
      const compressed = compressStepOutput({
        step: completedStep,
        rtk,
        rawOutputArtifact: rawOutputArtifactKey(completedStep),
        enabled: tokenRuntimeEnabled
      });
      const artifactKeys = writeGoalStepRuntimeArtifacts({
        artifactsRoot: path.resolve(options.artifactsRoot),
        step: completedStep,
        rawOutput: rawArtifactText,
        compactHandoff: compressed.compactOutput,
        telemetry: compressed.telemetry
      });
      database.withTransaction(() => {
        database.finishGoalStep({
          id: goalStep.id,
          status: result.outcome as Exclude<GoalStepStatus, "running">,
          summary: safeSummary,
          output: safeOutput,
          error: safeError,
          durationMs: result.durationMs
        });
        database.addEvent({
          source: routed.provider.id,
          type: `goal.step_${result.outcome}`,
          text: safeSummary,
          taskId: task.id,
          metadata: {
            runId: run.id,
            stepId: goalStep.id,
            phase,
            durationMs: result.durationMs,
            tokenRuntime: {
              ...compressed.telemetry,
              artifacts: artifactKeys
            }
          }
        });
      });

      if (result.outcome === "cancelled" || options.signal?.aborted) {
        return cancelRun(database, currentRun, phase, stepCount, task.id);
      }

      if (result.outcome === "blocked") {
        return finishRun(database, currentRun, "blocked", phase, stepCount, result.summary || result.error || "Goal blocked.", task.id);
      }
      if (result.outcome === "failed") {
        excluded.add(routed.provider.id);
        const fallback = await registry.route(CAPABILITIES[phase], excluded);
        if (fallback) continue;
        if (result.retryable) {
          return pauseRun(
            database,
            currentRun,
            phase,
            stepCount,
            result.summary || result.error || "Provider failure.",
            task.id
          );
        }
        return finishRun(database, currentRun, "failed", phase, stepCount, result.summary || result.error || "Provider failure.", task.id);
      }
      if (result.outcome === "changes_requested") {
        if (phase !== "reviewing") {
          return finishRun(
            database,
            currentRun,
            "failed",
            phase,
            stepCount,
            `Unexpected changes_requested during ${phase}.`,
            task.id
          );
        }
        phase = "implementing";
        excluded = new Set();
        continue;
      }

      if (phase === "testing" && options.validationRunner) {
        excluded = new Set();
        continue;
      }

      const nextPhase = nextPhaseAfter(phase);
      if (!nextPhase) {
        let deliveredRun = currentRun;
        if (options.delivery) {
          database.withTransaction(() => {
            database.updateTaskStatus(task.id, "awaiting_human");
            database.addEvent({
              source: "maestro",
              type: "goal.delivery_started",
              text: `Delivering goal #${run.id} to a draft pull request.`,
              taskId: task.id,
              metadata: { runId: run.id }
            });
          });
          try {
            const delivery = await options.delivery(database.getTask(task.id), project, currentRun);
            deliveredRun = database.withTransaction(() => {
              const updated = database.updateGoalDelivery({
                id: run.id,
                commitSha: delivery.commitSha,
                pullRequestUrl: delivery.pullRequestUrl
              });
              database.addEvent({
                source: "maestro",
                type: "goal.delivered",
                text: `Draft pull request created for goal #${run.id}.`,
                taskId: task.id,
                metadata: { runId: run.id, ...delivery }
              });
              return updated;
            });
          } catch (error) {
            return finishRun(
              database,
              currentRun,
              "blocked",
              phase,
              stepCount,
              error instanceof Error ? error.message : "Unknown goal delivery error.",
              task.id
            );
          }
        } else {
          database.updateTaskStatus(task.id, "done");
        }
        const completed = database.withTransaction(() => {
          const updated = database.updateGoalRun({
            id: deliveredRun.id,
            status: "completed",
            currentPhase: phase,
            stepCount
          });
          database.addEvent({
            source: "maestro",
            type: "goal.completed",
            text: `Goal #${run.id} completed automatically.`,
            taskId: task.id,
            metadata: { runId: run.id, stepCount }
          });
          return updated;
        });
        return completed;
      }
      phase = nextPhase;
      excluded = new Set();
    }

    return finishRun(
      database,
      currentRun,
      "blocked",
      phase,
      stepCount,
      `Goal reached its ${run.maxSteps}-step budget.`,
      task.id
    );
  } catch (error) {
    return finishRun(
      database,
      currentRun,
      "failed",
      phase,
      stepCount,
      error instanceof Error ? error.message : "Unknown goal runner error.",
      task.id
    );
  }
}

function latestChangeRequest(database: MaestroDatabase, runId: number): string | null {
  const review = database.getLatestHumanReview(runId);
  return review?.decision === "changes_requested" ? redactSensitiveText(review.note) : null;
}

function initialExcludedProviders(
  database: MaestroDatabase,
  run: GoalRunRecord,
  phase: GoalPhase
): Set<AgentProviderId> {
  if (run.status !== "waiting_provider") return new Set();
  const latestStep = [...database.listGoalSteps(run.id)]
    .reverse()
    .find((step) => step.phase === phase);
  if (latestStep?.status !== "failed") return new Set();
  if (latestStep.provider !== "codex" && latestStep.provider !== "claude") return new Set();
  return new Set([latestStep.provider]);
}

function pauseRun(
  database: MaestroDatabase,
  run: GoalRunRecord,
  phase: GoalPhase,
  stepCount: number,
  error: string,
  taskId: number
): GoalRunRecord {
  const safeError = sanitizeForRunSummary(error);
  return database.withTransaction(() => {
    database.updateTaskStatus(taskId, "waiting_quota");
    const paused = database.updateGoalRun({
      id: run.id,
      status: "waiting_provider",
      currentPhase: phase,
      stepCount,
      lastError: safeError
    });
    database.addEvent({
      source: "maestro",
      type: "goal.waiting_provider",
      text: safeError,
      taskId,
      metadata: { runId: run.id, phase, stepCount }
    });
    return paused;
  });
}

function sanitizeForRunSummary(text: string): string {
  return truncateForDisplay(redactSensitiveText(text), LAST_ERROR_MAX_LENGTH);
}

function nextPhaseAfter(phase: GoalPhase): GoalPhase | null {
  const index = PHASES.indexOf(phase);
  return index >= 0 && index < PHASES.length - 1 ? PHASES[index + 1] : null;
}

function taskStatusForPhase(phase: GoalPhase): TaskStatus {
  return phase;
}

function finishRun(
  database: MaestroDatabase,
  run: GoalRunRecord,
  status: "blocked" | "failed",
  phase: GoalPhase,
  stepCount: number,
  error: string,
  taskId: number
): GoalRunRecord {
  const safeError = sanitizeForRunSummary(error);
  return database.withTransaction(() => {
    database.updateTaskStatus(taskId, status);
    const finished = database.updateGoalRun({
      id: run.id,
      status,
      currentPhase: phase,
      stepCount,
      lastError: safeError
    });
    database.addEvent({
      source: "maestro",
      type: `goal.${status}`,
      text: safeError,
      taskId,
      metadata: { runId: run.id, phase, stepCount }
    });
    return finished;
  });
}

function cancelRun(
  database: MaestroDatabase,
  run: GoalRunRecord,
  phase: GoalPhase,
  stepCount: number,
  taskId: number
): GoalRunRecord {
  return database.withTransaction(() => {
    database.updateTaskStatus(taskId, "cancelled");
    const cancelled = database.updateGoalRun({
      id: run.id,
      status: "cancelled",
      currentPhase: phase,
      stepCount,
      lastError: "Cancelled by user."
    });
    database.addEvent({
      source: "human",
      type: "goal.cancelled",
      text: `Goal #${run.id} cancelled by user.`,
      taskId,
      metadata: { runId: run.id, phase, stepCount }
    });
    return cancelled;
  });
}
