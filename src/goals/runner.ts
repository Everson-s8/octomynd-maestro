import path from "node:path";
import type {
  GoalPhase,
  GoalRunRecord,
  GoalStepStatus,
  GoalWaitReason,
  MaestroDatabase,
  TaskStatus
} from "../db.js";
import { AgentRegistry } from "../agents/registry.js";
import { AgentCapability, AgentExecutionResult, AgentProviderId } from "../agents/types.js";
import { classifyFailure } from "../agents/failure.js";
import { GoalDeliveryHandler } from "./delivery.js";
import { redactSensitiveText, truncateForDisplay } from "../security/redaction.js";
import { compressStepOutput, dedupeTokenEfficientHandoffs } from "../runtime/compression.js";
import { detectLocalRtk } from "../runtime/rtk.js";
import { rawOutputArtifactKey, writeGoalStepRuntimeArtifacts } from "../runtime/artifacts.js";
import type { DeterministicValidationRunner } from "../validation/runner.js";
import {
  captureWorkspaceProgress,
  GoalCircuitBreaker,
  DEFAULT_PHASE_BUDGETS,
} from "./circuit-breaker.js";
import type { TaskDNA } from "./task-dna.js";
export { DEFAULT_PHASE_BUDGETS };
import { captureGoalCheckpoint, formatCheckpointForResume } from "./checkpoint.js";
import { elevateMaxSteps, MAESTRO_GOAL_MAX_STEPS } from "./coordinator.js";
import { GoalWatchdog } from "./watchdog.js";
import type { SkillRuntime } from "../skills/runtime.js";
import type { SkillExecutionContext } from "../skills/types.js";
import {
  decideWorkGraphAdoption,
  type WorkGraphAdoptionDecision,
  type WorkGraphAdoptionInput
} from "../work-graphs/adoption.js";
import type { WorkGraphDetails } from "../work-graphs/types.js";
import type { FeatureWorkGraphRequest } from "../features/task-graph.js";

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
  phaseBudgets?: Partial<Record<GoalPhase, number>>;
  /** TaskDNA: self-dimensioning workflow config. When provided, overrides phases and budgets. */
  taskDNA?: TaskDNA;
  deadlineMs?: number;
  existingRun?: GoalRunRecord;
  delivery?: GoalDeliveryHandler;
  tokenRuntime?: { enabled?: boolean } | false;
  validationRunner?: Pick<DeterministicValidationRunner, "run">;
  skillRuntime?: Pick<SkillRuntime, "prepareContext">;
  workGraphAdoption?: Pick<WorkGraphAdoptionInput, "mode" | "explicitRequest" | "trigger">;
  workGraphRunner?: {
    runToCompletion(
      graphId: number,
      options?: { selfRetry?: boolean; signal?: AbortSignal }
    ): Promise<WorkGraphDetails>;
  };
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

  // ── TaskDNA: self-dimensioning workflow ──────────────────
  const dna = options.taskDNA;
  const dnaPhases: GoalPhase[] = dna?.phases ?? PHASES;
  const dnaPhaseBudgets = dna?.phaseBudgets ?? {};
  // When DNA is present, maxSteps is the sum of phase budgets (no global cap)
  const dnaMaxSteps = dna
    ? Object.values(dna.phaseBudgets).reduce((a, b) => a + b, 0) + 5 // buffer
    : undefined;
  const effectiveMaxSteps = dnaMaxSteps ?? options.maxSteps ?? 20;

  const run = options.existingRun ?? database.createGoalRun(task.id, effectiveMaxSteps);
  // ── DNA / Existing: preserve existing run maxSteps, keeping elevated maxSteps ─
  if (options.existingRun) {
    run.maxSteps = dnaMaxSteps
      ? Math.max(options.existingRun.maxSteps, dnaMaxSteps)
      : options.existingRun.maxSteps;
  }
  const isResume = run.status === "waiting_provider" || run.stepCount > 0;
  let currentRun = run;
  // ── DNA: start at first DNA phase, not default "planning" ──
  let phase: GoalPhase = isResume
    ? run.currentPhase
    : (dna?.phases[0] as GoalPhase) ?? run.currentPhase;
  let stepCount = run.stepCount;
  let excluded = initialExcludedProviders(database, run, phase);
  const tokenRuntimeEnabled = options.tokenRuntime !== false && options.tokenRuntime?.enabled !== false;
  const rtk = detectLocalRtk();
  const goalDeadlineAt = options.deadlineMs ? Date.now() + options.deadlineMs : undefined;
  const circuitBreaker = GoalCircuitBreaker.fromSteps(database.listGoalSteps(run.id), options.phaseBudgets);
  const persistedWorkGraphRequest = database.findFeaturePlanDetailsByTask(task.id)?.tasks
    .find((candidate) => candidate.taskId === task.id)?.contract.workGraphRequest ?? null;
  const explicitWorkGraphRequested = persistedWorkGraphRequest !== null
    && options.workGraphAdoption?.explicitRequest !== false;

  database.addEvent({
    source: "maestro",
    type: isResume ? "goal.resumed" : "goal.started",
    text: `Goal #${run.id} ${isResume ? "resumed" : "started"} for task #${task.id}`,
    taskId: task.id,
    metadata: {
      runId: run.id,
      maxSteps: run.maxSteps,
      dna: dna ? { complexity: dna.complexity, phases: dna.phases, rationale: dna.rationale } : null,
    }
  });
  const workGraphDecision = decideWorkGraphAdoption({
    mode: options.workGraphAdoption?.mode ?? "off",
    explicitRequest: explicitWorkGraphRequested,
    trigger: explicitWorkGraphRequested ? options.workGraphAdoption?.trigger ?? "task_metadata" : options.workGraphAdoption?.trigger,
    taskText: task.text,
    projectKey: project.key,
    isResume,
    currentPhase: phase,
    stepCount
  });
  database.addEvent({
    source: "maestro",
    type: "goal.work_graph_adoption_decision",
    text: formatWorkGraphAdoptionText(workGraphDecision),
    taskId: task.id,
    metadata: {
      runId: run.id,
      mode: workGraphDecision.mode,
      decision: workGraphDecision.decision,
      reason: workGraphDecision.reason,
      executionMode: workGraphDecision.executionMode,
      automaticFanOut: workGraphDecision.automaticFanOut,
      telemetry: workGraphDecision.telemetry
    }
  });

  // ── Terminal transition: deliver / complete exactly once ─────────────
  // Every path that means "the goal is done" — reviewer approved, tests
  // passed with no review required, changes_requested with iteration
  // disabled, or the final phase finishing — funnels through this single
  // delivery path. A loop `break` must never implicitly mean completion:
  // completion is an explicit transition that persists a terminal state
  // exactly once and can never fall through into budget handling.
  const deliverGoal = async (): Promise<GoalRunRecord> => {
    // Idempotency guard: never deliver the same run twice (duplicate
    // scheduler tick, retry, or resume must not create a second PR).
    if (currentRun.commitSha || currentRun.pullRequestUrl || currentRun.status === "completed") {
      return currentRun;
    }

    const worktreePath = task.worktreePath;
    if (!worktreePath) {
      return finishRun(database, currentRun, "blocked", phase, stepCount, "Task has no worktree to deliver.", task.id);
    }

    // ── skip delivery for trivial tasks with no changes ──
    const workspaceFingerprint = captureWorkspaceProgress(worktreePath);
    const previousCheckpoint = database.getLatestGoalCheckpoint(run.id);
    const hasChanges = workspaceFingerprint !== null
      && previousCheckpoint !== null
      && workspaceFingerprint !== previousCheckpoint.workspaceFingerprint;

    if (dna?.complexity === "trivial" && !hasChanges) {
      // Trivial task with no file changes — complete without PR
      database.updateTaskStatus(task.id, "done");
      const completed = database.withTransaction(() => {
        const updated = database.updateGoalRun({
          id: run.id,
          status: "completed",
          currentPhase: phase,
          stepCount
        });
        database.addEvent({
          source: "maestro",
          type: "goal.completed",
          text: `Goal #${run.id} completed (trivial, no changes needed).`,
          taskId: task.id,
          metadata: { runId: run.id, stepCount, trivial: true }
        });
        return updated;
      });
      return completed;
    }

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
  };

  try {
    while (stepCount < run.maxSteps) {
      if (options.signal?.aborted) {
        return cancelRun(database, currentRun, phase, stepCount, task.id);
      }
      if (goalDeadlineAt !== undefined && Date.now() >= goalDeadlineAt) {
        return finishCircuitBreak(
          database,
          currentRun,
          phase,
          stepCount,
          task.id,
          "deadline",
          "Goal deadline reached before starting another provider step."
        );
      }
      // ── Phase budget check: DNA-aware ────────────────────
      // DNA phase budgets take precedence over circuit breaker defaults
      const dnaBudgetLimit = dnaPhaseBudgets[phase as GoalPhase];
      const phaseStepCount = database.listGoalSteps(run.id).filter((s) => s.phase === phase).length;
      if (dnaBudgetLimit !== undefined && phaseStepCount >= dnaBudgetLimit) {
        // Check if this is the last phase — if so, deliver
        const phaseIndex = dnaPhases.indexOf(phase as GoalPhase);
        if (phaseIndex === dnaPhases.length - 1) {
          // Last phase budget exhausted — deliver via the single completion path.
          return await deliverGoal();
        }
        // Not last phase — move to next DNA phase
        const nextDnaPhase = dnaPhases[phaseIndex + 1];
        if (nextDnaPhase) {
          phase = nextDnaPhase;
          excluded = new Set();
          continue;
        }
      }

      const phaseBudgetDecision = circuitBreaker.checkPhaseBudget(phase);
      if (phaseBudgetDecision) {
        return finishCircuitBreak(
          database,
          currentRun,
          phase,
          stepCount,
          task.id,
          phaseBudgetDecision.reason,
          phaseBudgetDecision.summary
        );
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
      const completedWorkGraphStep = database.listGoalSteps(run.id).some((step) => (
        step.phase === "implementing" && step.provider === "work-graph" && step.status === "completed"
      ));
      if (
        phase === "implementing"
        && workGraphDecision.decision === "explicit"
        && options.workGraphRunner
        && persistedWorkGraphRequest
        && !completedWorkGraphStep
      ) {
        const outcome = await runExplicitWorkGraphImplementation(
          database,
          options.workGraphRunner,
          task,
          run.id,
          persistedWorkGraphRequest,
          options.signal
        );
        currentRun = database.updateGoalRun({
          id: run.id,
          status: "running",
          currentPhase: phase,
          stepCount,
          lastProvider: "work-graph"
        });
        if (outcome.status === "waiting_provider") {
          const wait = latestWorkGraphWaitReason(database, outcome.graph.id);
          return pauseRun(
            database,
            currentRun,
            phase,
            stepCount,
            "Explicit Work Graph is waiting for a ready provider.",
            task.id,
            wait
          );
        }
        if (outcome.status === "cancelled" || options.signal?.aborted) {
          return cancelRun(database, currentRun, phase, stepCount, task.id);
        }

        stepCount += 1;
        const evidence = summarizeWorkGraphExecution(outcome.graph, database);
        const stepOutcome: Exclude<GoalStepStatus, "running"> = outcome.status === "completed" ? "completed" : "blocked";
        const safeSummary = redactSensitiveText(evidence.summary);
        const safeOutput = redactSensitiveText(evidence.output);
        const safeError = stepOutcome === "blocked" ? safeSummary : null;
        const goalStep = database.createGoalStep(run.id, phase, "work-graph");
        const completedStep = { ...goalStep, status: stepOutcome, summary: safeSummary, output: safeOutput, error: safeError };
        const compressed = compressStepOutput({
          step: completedStep,
          rtk,
          rawOutputArtifact: rawOutputArtifactKey(completedStep),
          enabled: tokenRuntimeEnabled
        });
        const artifactKeys = writeGoalStepRuntimeArtifacts({
          artifactsRoot: path.resolve(options.artifactsRoot),
          step: completedStep,
          rawOutput: [
            `summary: ${safeSummary}`,
            `output:\n${safeOutput}`,
            `work-graph: #${outcome.graph.id}`
          ].join("\n\n"),
          compactHandoff: compressed.compactOutput,
          telemetry: compressed.telemetry
        });
        database.withTransaction(() => {
          database.finishGoalStep({
            id: goalStep.id,
            status: stepOutcome,
            summary: safeSummary,
            output: safeOutput,
            error: safeError,
            durationMs: 0
          });
          database.addEvent({
            source: "maestro",
            type: `goal.step_${stepOutcome}`,
            text: safeSummary,
            taskId: task.id,
            metadata: {
              runId: run.id,
              stepId: goalStep.id,
              phase,
              workGraphId: outcome.graph.id,
              tokenRuntime: { ...compressed.telemetry, artifacts: artifactKeys }
            }
          });
        });
        const workspaceFingerprint = captureWorkspaceProgress(task.worktreePath);
        const previousCheckpoint = database.getLatestGoalCheckpoint(run.id);
        const checkpoint = database.createGoalCheckpoint(captureGoalCheckpoint({
          runId: run.id,
          stepId: goalStep.id,
          phase,
          provider: "work-graph",
          interrupted: false,
          summary: safeSummary,
          objective: task.text,
          output: safeOutput,
          previousCheckpoint,
          workspacePath: task.worktreePath,
          workspaceFingerprint,
          artifactKeys: Object.values(artifactKeys)
        }));
        database.addEvent({
          source: "maestro",
          type: "goal.checkpoint_saved",
          text: `Checkpoint #${checkpoint.id} saved for goal #${run.id}.`,
          taskId: task.id,
          metadata: {
            runId: run.id,
            stepId: goalStep.id,
            checkpointId: checkpoint.id,
            status: checkpoint.status,
            artifactKeys: checkpoint.artifactKeys
          }
        });

        if (stepOutcome === "blocked") {
          return finishRun(database, currentRun, "blocked", phase, stepCount, safeSummary, task.id);
        }
        phase = "testing";
        excluded = new Set();
        continue;
      }

      let routed = await registry.acquire(CAPABILITIES[phase], excluded);
      if (!routed) {
        const error = `No ready provider for ${CAPABILITIES[phase]}.`;
        const availability = await registry.nextAvailability(CAPABILITIES[phase], excluded);
        return pauseRun(database, currentRun, phase, stepCount, error, task.id, {
          reason: availability.reason,
          retryAfterMs: availability.retryAfterMs,
          provider: availability.provider ?? undefined
        });
      }

      currentRun = database.updateGoalRun({
        id: run.id,
        status: "running",
        currentPhase: phase,
        stepCount,
        lastProvider: routed.provider.id
      });

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
      const tracksWorkspaceProgress = phase === "implementing" || phase === "testing";
      const workspaceBefore = tracksWorkspaceProgress
        ? captureWorkspaceProgress(task.worktreePath)
        : null;
      let result: AgentExecutionResult;
      let skillContext: SkillExecutionContext | undefined;
      try {
        const previousSteps = database.listGoalSteps(run.id).filter((step) => step.id !== goalStep.id);
        const compressedHandoffs = tokenRuntimeEnabled
          ? dedupeTokenEfficientHandoffs(previousSteps.map((step) => compressStepOutput({
            step,
            rtk,
            rawOutputArtifact: rawOutputArtifactKey(step),
            enabled: true
          }).handoff))
          : null;
        const previousStepHandoff = compressedHandoffs?.steps;
        if (compressedHandoffs && compressedHandoffs.removed > 0) {
          database.addEvent({
            source: "maestro",
            type: "goal.handoff_deduplicated",
            text: `Removed ${compressedHandoffs.removed} duplicate handoff(s) before ${phase}.`,
            taskId: task.id,
            metadata: {
              runId: run.id,
              stepId: goalStep.id,
              phase,
              before: previousSteps.length,
              after: compressedHandoffs.steps.length
            }
          });
        }
        skillContext = options.skillRuntime?.prepareContext({
          runId: run.id,
          phase,
          capability: CAPABILITIES[phase],
          taskText: task.text,
          projectKey: project.key
        });
        if (skillContext && (skillContext.available.length > 0 || skillContext.loaded.length > 0)) {
          database.addEvent({
            source: "maestro",
            type: "goal.skill_context_prepared",
            text: `Prepared governed Skill context for ${phase}.`,
            taskId: task.id,
            metadata: {
              runId: run.id,
              stepId: goalStep.id,
              phase,
              available: skillContext.available.map((skill) => ({
                qualifiedName: skill.qualifiedName,
                versionId: skill.versionId,
                risk: skill.risk
              })),
              loaded: skillContext.loaded.map((skill) => ({
                qualifiedName: skill.qualifiedName,
                versionId: skill.versionId
              }))
            }
          });
        }
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
          skillContext,
          artifactsRoot: path.resolve(options.artifactsRoot),
          resumeContext: formatCheckpointForResume(database.getLatestGoalCheckpoint(run.id)),
          featureTaskContract: database.findFeaturePlanDetailsByTask(task.id)?.tasks
            .find((candidate) => candidate.taskId === task.id)?.contract,
          deadlineAt: goalDeadlineAt,
          signal: options.signal
        });
      } catch (error) {
        result = {
          outcome: options.signal?.aborted ? "cancelled" : "failed",
          summary: error instanceof Error ? error.message : "Unknown provider execution error.",
          structuredPayload: null,
          failureCategory: "unknown",
          retryable: false,
          artifactsProduced: [],
          output: "",
          error: error instanceof Error ? error.message : "Unknown provider execution error.",
          durationMs: Date.now() - startedAt
        };
      } finally {
        routed.release(result!);
      }
      if (skillContext?.loaded.length) {
        database.withTransaction(() => {
          for (const skill of skillContext!.loaded) {
            const version = database.getSkillVersionByCoordinates(skill.qualifiedName, skill.versionId);
            database.recordSkillUsage({
              runId: run.id,
              stepId: goalStep.id,
              skillVersionRecordId: version.id,
              provider: routed!.provider.id,
              phase,
              outcome: result.outcome,
              durationMs: result.durationMs,
              estimatedTokens: Math.ceil(skill.instructions.length / 4)
            });
          }
        });
      }
      const workspaceAfter = tracksWorkspaceProgress
        ? captureWorkspaceProgress(task.worktreePath)
        : null;
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
        try {
          database.recordTokenUsage({
            runId: run.id,
            stepId: goalStep.id,
            provider: routed.provider.id,
            model: result.model,
            inputTokens: result.tokenUsage?.inputTokens ?? 0,
            outputTokens: result.tokenUsage?.outputTokens ?? 0
          });
        } catch {
          // Requirement #8: Never fail task on token recording issue
        }
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
            processRuntime: result.processRuntime ?? null,
            structuredPayload: result.structuredPayload ?? null,
            failureCategory: result.failureCategory ?? null,
            artifactsProduced: result.artifactsProduced ?? [],
            workspaceProgress: {
              known: workspaceBefore !== null && workspaceAfter !== null,
              changed: workspaceBefore !== null
                && workspaceAfter !== null
                && workspaceBefore !== workspaceAfter
            },
            tokenRuntime: {
              ...compressed.telemetry,
              artifacts: artifactKeys
            }
          }
        });
      });
      if (tracksWorkspaceProgress) {
        const previousCheckpoint = database.getLatestGoalCheckpoint(run.id);
        const checkpoint = database.createGoalCheckpoint(captureGoalCheckpoint({
          runId: run.id,
          stepId: goalStep.id,
          phase,
          provider: routed.provider.id,
          interrupted: result.outcome !== "completed" && result.outcome !== "changes_requested",
          summary: safeSummary,
          objective: task.text,
          output: safeOutput,
          error: safeError,
          previousCheckpoint,
          workspacePath: task.worktreePath,
          workspaceFingerprint: workspaceAfter,
          artifactKeys: Object.values(artifactKeys)
        }));
        database.addEvent({
          source: "maestro",
          type: "goal.checkpoint_saved",
          text: `Checkpoint #${checkpoint.id} saved for goal #${run.id}.`,
          taskId: task.id,
          metadata: {
            runId: run.id,
            stepId: goalStep.id,
            checkpointId: checkpoint.id,
            status: checkpoint.status,
            changedFiles: checkpoint.changedFiles,
            artifactKeys: checkpoint.artifactKeys
          }
        });
      }

      if (result.outcome === "cancelled" || options.signal?.aborted) {
        return cancelRun(database, currentRun, phase, stepCount, task.id);
      }

      let taskMetadataParsed: Record<string, any> | null = null;
      const rawMeta = (task as any).metadata;
      if (rawMeta) {
        try {
          taskMetadataParsed = typeof rawMeta === "string" ? JSON.parse(rawMeta) : rawMeta;
        } catch {}
      }

      const circuitDecision = circuitBreaker.observe({
        phase,
        result,
        workspaceBefore,
        workspaceAfter,
        taskText: task.text,
        taskMetadata: taskMetadataParsed
      });
      if (circuitDecision?.reason === "output_limit") {
        database.addEvent({
          source: "maestro",
          type: "goal.output_limit_checkpoint",
          text: "Provider output limit reached; checkpoint preserved for automatic resume.",
          taskId: task.id,
          metadata: {
            runId: run.id,
            phase,
            stepCount,
            provider: routed.provider.id,
            worktreePreserved: true
          }
        });
        return pauseRun(
          database,
          currentRun,
          phase,
          stepCount,
          "Provider output limit reached. Partial work was preserved and will resume with another provider.",
          task.id,
          {
            reason: "output_limit",
            retryAfterMs: 5_000,
            provider: routed.provider.id
          }
        );
      }

      if (circuitDecision?.reason === "no_progress") {
        database.finishGoalStep({
          id: goalStep.id,
          status: "failed",
          summary: circuitDecision.summary,
          output: safeOutput,
          error: circuitDecision.summary,
          durationMs: result.durationMs
        });
        excluded.add(routed.provider.id);
        const fallback = await registry.route(CAPABILITIES[phase], excluded);
        database.addEvent({
          source: "maestro",
          type: fallback ? "goal.no_progress_fallback" : "goal.no_progress_wait",
          text: fallback
            ? `${routed.provider.label} made no progress during ${phase}; routing to ${fallback.provider.label}.`
            : `${routed.provider.label} made no progress during ${phase}; waiting for another provider.`,
          taskId: task.id,
          metadata: {
            runId: run.id,
            stepId: goalStep.id,
            phase,
            fromProvider: routed.provider.id,
            toProvider: fallback?.provider.id ?? null,
            reason: circuitDecision.reason,
            worktreePreserved: true
          }
        });
        if (fallback) continue;
        return pauseRun(
          database,
          currentRun,
          phase,
          stepCount,
          circuitDecision.summary,
          task.id,
          { reason: "capacity", retryAfterMs: 30_000, provider: routed.provider.id }
        );
      }

      if (circuitDecision && result.outcome !== "failed") {
        return finishCircuitBreak(
          database,
          currentRun,
          phase,
          stepCount,
          task.id,
          circuitDecision.reason,
          circuitDecision.summary
        );
      }

      if (result.outcome === "blocked") {
        return finishRun(database, currentRun, "blocked", phase, stepCount, result.summary || result.error || "Goal blocked.", task.id);
      }
      if (result.outcome === "failed") {
        if (circuitDecision) {
          return finishCircuitBreak(
            database,
            currentRun,
            phase,
            stepCount,
            task.id,
            circuitDecision.reason,
            circuitDecision.summary
          );
        }
        excluded.add(routed.provider.id);
        const fallback = await registry.route(CAPABILITIES[phase], excluded);
        if (fallback) {
          const resumeCheckpoint = database.getLatestGoalCheckpoint(run.id);
          database.addEvent({
            source: "maestro",
            type: "goal.provider_fallback",
            text: `${routed.provider.label} failed during ${phase}; routing to ${fallback.provider.label}.`,
            taskId: task.id,
            metadata: {
              runId: run.id,
              stepId: goalStep.id,
              phase,
              fromProvider: routed.provider.id,
              toProvider: fallback.provider.id,
              retryable: result.retryable,
              failureCategory: result.failureCategory ?? classifyFailure(result.summary || result.error || "", result.failureCategory === "timeout"),
              breakerReason: result.processRuntime?.breakerReason ?? null,
              resumeCheckpointId: resumeCheckpoint?.id ?? null,
              preservedFiles: resumeCheckpoint?.changedFiles ?? []
            }
          });
          continue;
        }
        const availability = await registry.nextAvailability(CAPABILITIES[phase], excluded);
        if (availability.provider) {
          return pauseRun(
            database,
            currentRun,
            phase,
            stepCount,
            result.summary || result.error || "Provider failure.",
            task.id,
            {
              reason: availability.reason,
              retryAfterMs: availability.retryAfterMs,
              provider: availability.provider ?? undefined
            }
          );
        }
        if (result.retryable) {
          return pauseRun(
            database,
            currentRun,
            phase,
            stepCount,
            result.summary || result.error || "Provider failure.",
            task.id,
            {
              reason: result.failureCategory === "quota" || result.failureCategory === "capacity"
                ? result.failureCategory
                : availability.reason,
              retryAfterMs: result.retryAfterMs ?? availability.retryAfterMs,
              provider: routed.provider.id
            }
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
        // DNA: check if iteration is allowed
        if (dna && !dna.allowIteration) {
          // No iteration allowed — deliver as-is via the single completion path.
          return await deliverGoal();
        }
        phase = "implementing";
        excluded = new Set();
        continue;
      }

      // ── DNA: approved = task complete ────────────────────
      // If the reviewer approved (or tests passed and no review needed),
      // treat this as completion regardless of remaining phases.
      if (result.outcome === "completed") {
        const reviewDecision = result.structuredPayload?.reviewDecision;
        if (reviewDecision === "approved") {
          // Reviewer approved — complete through the single delivery path.
          return await deliverGoal();
        }
        // DNA: if this is the last required phase and no review needed, deliver
        if (dna && !dna.requireReview && phase === (dna.phases[dna.phases.length - 1])) {
          // For trivial tasks with no changes, complete without PR
          const wf = captureWorkspaceProgress(task.worktreePath);
          const prevCp = database.getLatestGoalCheckpoint(run.id);
          const hasFileChanges = wf !== null && prevCp !== null && wf !== prevCp.workspaceFingerprint;
          if (dna.complexity === "trivial" && !hasFileChanges) {
            database.updateTaskStatus(task.id, "done");
            return database.withTransaction(() => {
              const updated = database.updateGoalRun({
                id: run.id, status: "completed", currentPhase: phase, stepCount
              });
              database.addEvent({
                source: "maestro", type: "goal.completed",
                text: `Goal #${run.id} completed (trivial, no changes needed).`,
                taskId: task.id, metadata: { runId: run.id, stepCount, trivial: true }
              });
              return updated;
            });
          }
          // Has changes or not trivial — continue to delivery (don't break here,
          // the !nextPhase check below handles delivery)
        }
        // DNA: if tests passed and no review needed, deliver
        if (dna && !dna.requireReview && phase === "testing" && result.structuredPayload?.testsPassed) {
          return await deliverGoal();
        }
      }

      if (phase === "testing" && options.validationRunner) {
        excluded = new Set();
        continue;
      }

      const nextPhase = nextPhaseAfter(phase, dnaPhases);
      if (!nextPhase) {
        // Final phase finished — complete through the single delivery path.
        return await deliverGoal();
      }
      phase = nextPhase;
      excluded = new Set();
    }

    // A goal only terminates on a real loop (watchdog), not on a raw step count.
    // When the step-budget ceiling is hit, consult the watchdog:
    //  - loop (no progress / repeated failure / same decision)  -> hard block
    //  - otherwise (forward progress)                           -> elevate (unbounded
    //    up to MAESTRO_GOAL_MAX_STEPS) and resume, so legitimate long work finishes.
    const loopVerdict = new GoalWatchdog(database).verdict(currentRun);
    if (loopVerdict.stop) {
      return finishRun(
        database,
        currentRun,
        "blocked",
        phase,
        stepCount,
        `Goal loop detected (${loopVerdict.reason}) after ${currentRun.stepCount} steps.`,
        task.id,
        "budget_exhausted"
      );
    }

    const newMaxSteps = elevateMaxSteps(currentRun.maxSteps);
    if (newMaxSteps > currentRun.maxSteps) {
      database.addEvent({
        source: "maestro",
        type: "goal.budget_elevated",
        text: `Goal #${run.id} maxSteps auto-elevated from ${currentRun.maxSteps} to ${newMaxSteps} (ceiling ${MAESTRO_GOAL_MAX_STEPS}).`,
        taskId: task.id,
        metadata: {
          runId: run.id,
          previousMaxSteps: currentRun.maxSteps,
          newMaxSteps,
          ceiling: MAESTRO_GOAL_MAX_STEPS,
          source: "auto_budget_exhausted"
        }
      });
      return pauseRun(
        database,
        currentRun,
        phase,
        stepCount,
        `Goal reached its ${currentRun.maxSteps}-step budget; elevating ceiling to ${newMaxSteps}.`,
        task.id,
        { reason: "budget_exhausted", retryAfterMs: 5_000 },
        newMaxSteps
      );
    }

    // Ceiling reached: no more elevation possible — a genuine runaway. This is
    // the absolute safety net, not the normal termination (the watchdog and
    // delivery gates should have ended the goal well before this).
    return finishRun(
      database,
      currentRun,
      "blocked",
      phase,
      stepCount,
      `Goal reached the absolute step ceiling of ${MAESTRO_GOAL_MAX_STEPS}; possible runaway.`,
      task.id,
      "budget_exhausted"
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

type ExplicitWorkGraphOutcome = {
  status: "completed" | "blocked" | "cancelled" | "waiting_provider";
  graph: WorkGraphDetails;
};

async function runExplicitWorkGraphImplementation(
  database: MaestroDatabase,
  workGraphRunner: NonNullable<GoalRunnerOptions["workGraphRunner"]>,
  task: { id: number; text: string },
  runId: number,
  request: FeatureWorkGraphRequest,
  signal?: AbortSignal
): Promise<ExplicitWorkGraphOutcome> {
  const existingGraph = database.findWorkGraphByRunId(runId);
  const graph = existingGraph ?? database.createWorkGraph({
    runId,
    objective: request.objective,
    maxParallelReaders: request.maxParallelReaders,
    nodes: request.nodes.map((node) => ({
      key: node.key,
      role: node.role,
      objective: node.objective,
      capability: node.capability,
      dependsOn: node.dependsOn,
      outputContract: node.outputContract,
      mode: node.mode,
      writeScope: node.writeScope,
      budget: node.budget
    }))
  });
  if (!existingGraph) {
    database.addEvent({
      source: "maestro",
      type: "goal.work_graph_created",
      text: `Explicit Work Graph #${graph.id} created for goal #${runId}.`,
      taskId: task.id,
      metadata: { runId, graphId: graph.id, nodeCount: request.nodes.length }
    });
  }
  const result = await workGraphRunner.runToCompletion(graph.id, { selfRetry: false, signal });
  const status = result.status as ExplicitWorkGraphOutcome["status"];
  return { status, graph: result };
}

function summarizeWorkGraphExecution(
  graph: WorkGraphDetails,
  database: MaestroDatabase
): { summary: string; output: string } {
  const total = graph.nodes.length;
  const completedCount = graph.nodes.filter((node) => node.status === "completed").length;
  const summary = `Explicit Work Graph #${graph.id} ${graph.status}: ${completedCount}/${total} Worker Node(s) completed.`;
  const lines = graph.nodes.map((node) => {
    const attempts = database.listWorkerAttempts(node.id);
    const latest = attempts.at(-1);
    const artifacts = database.listWorkerArtifacts(graph.id, node.id);
    const artifactRefs = artifacts.length > 0
      ? artifacts.map((artifact) => `artifact:${artifact.key}`).join(", ")
      : "none";
    return `- ${node.key} (${node.role}/${node.status}): ${latest?.summary || node.lastError || "no attempt"} [artifacts: ${artifactRefs}]`;
  });
  return { summary, output: [summary, ...lines].join("\n") };
}

function latestWorkGraphWaitReason(
  database: MaestroDatabase,
  graphId: number
): { reason: GoalWaitReason; retryAfterMs?: number; provider?: AgentProviderId } {
  const event = database.listEvents(200).find((candidate) => (
    candidate.type === "work_graph.waiting_provider" && candidate.metadata?.graphId === graphId
  ));
  const reason = typeof event?.metadata?.waitReason === "string"
    ? event.metadata.waitReason as GoalWaitReason
    : "unknown";
  const retryAfterMs = typeof event?.metadata?.retryAfterMs === "number" ? event.metadata.retryAfterMs : undefined;
  const provider = isAgentProviderId(event?.metadata?.provider)
    ? event.metadata.provider
    : undefined;
  return { reason, retryAfterMs, provider };
}

function formatWorkGraphAdoptionText(decision: WorkGraphAdoptionDecision): string {
  if (decision.reason === "disabled_by_config") {
    return "Work Graph adoption is disabled; running the linear Goal path.";
  }
  if (decision.reason === "shadow_mode_records_only") {
    return "Work Graph shadow decision recorded; running the linear Goal path.";
  }
  if (decision.reason === "explicit_request_recorded") {
    return "Explicit Work Graph request recorded; automatic fan-out remains disabled.";
  }
  return "Work Graph requires an explicit request; running the linear Goal path.";
}

function finishCircuitBreak(
  database: MaestroDatabase,
  run: GoalRunRecord,
  phase: GoalPhase,
  stepCount: number,
  taskId: number,
  reason: string,
  summary: string
): GoalRunRecord {
  const safeSummary = sanitizeForRunSummary(summary);
  database.addEvent({
    source: "maestro",
    type: "goal.circuit_breaker",
    text: safeSummary,
    taskId,
    metadata: { runId: run.id, phase, stepCount, reason, worktreePreserved: true }
  });
  if (reason === "phase_budget_exhausted") {
    // Same rule as the global budget: only a real loop stops a goal; forward
    // progress keeps elevating (up to the absolute ceiling).
    const loopVerdict = new GoalWatchdog(database).verdict(run);
    if (loopVerdict.stop) {
      const failureCategory = "budget_exhausted";
      return finishRun(database, run, "blocked", phase, stepCount, `Goal loop detected (${loopVerdict.reason}) in ${phase}.`, taskId, failureCategory);
    }
    const newMaxSteps = elevateMaxSteps(run.maxSteps);
    if (newMaxSteps > run.maxSteps) {
      database.addEvent({
        source: "maestro",
        type: "goal.budget_elevated",
        text: `Goal #${run.id} maxSteps auto-elevated from ${run.maxSteps} to ${newMaxSteps} (ceiling ${MAESTRO_GOAL_MAX_STEPS}).`,
        taskId,
        metadata: {
          runId: run.id,
          previousMaxSteps: run.maxSteps,
          newMaxSteps,
          ceiling: MAESTRO_GOAL_MAX_STEPS,
          source: "auto_budget_exhausted"
        }
      });
      return pauseRun(
        database,
        run,
        phase,
        stepCount,
        safeSummary,
        taskId,
        { reason: "budget_exhausted", retryAfterMs: 5_000 },
        newMaxSteps
      );
    }
  }
  const failureCategory = reason === "phase_budget_exhausted" ? "budget_exhausted" : undefined;
  return finishRun(database, run, "blocked", phase, stepCount, safeSummary, taskId, failureCategory);
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
  const failed = database.listGoalSteps(run.id)
    .filter((step) => step.phase === phase && step.status === "failed")
    .map((step) => step.provider)
    .filter(isAgentProviderId);
  const excluded = new Set(failed);
  if (
    (run.waitReason === "quota" || run.waitReason === "capacity")
    && isAgentProviderId(run.lastProvider)
  ) {
    excluded.delete(run.lastProvider);
  }
  return excluded;
}

function isAgentProviderId(value: unknown): value is AgentProviderId {
  return value === "codex" || value === "claude" || value === "antigravity";
}

function pauseRun(
  database: MaestroDatabase,
  run: GoalRunRecord,
  phase: GoalPhase,
  stepCount: number,
  error: string,
  taskId: number,
  wait: {
    reason: GoalWaitReason;
    retryAfterMs?: number;
    provider?: AgentProviderId;
  },
  newMaxSteps?: number
): GoalRunRecord {
  const safeError = sanitizeForRunSummary(error);
  const retryAfterMs = Math.max(1_000, wait.retryAfterMs ?? (wait.reason === "budget_exhausted" ? 5_000 : 60_000));
  const nextRetryAt = new Date(Date.now() + retryAfterMs).toISOString();
  const checkpoint = database.getLatestGoalCheckpoint(run.id);
  return database.withTransaction(() => {
    database.updateTaskStatus(taskId, "waiting_provider");
    const paused = database.updateGoalRun({
      id: run.id,
      status: "waiting_provider",
      currentPhase: phase,
      stepCount,
      maxSteps: newMaxSteps ?? run.maxSteps,
      lastError: safeError,
      waitReason: wait.reason,
      nextRetryAt,
      lastProvider: wait.provider ?? run.lastProvider ?? null
    });
    database.addEvent({
      source: "maestro",
      type: "goal.waiting_provider",
      text: safeError,
      taskId,
      metadata: {
        runId: run.id,
        phase,
        stepCount,
        waitReason: wait.reason,
        nextRetryAt,
        provider: wait.provider ?? run.lastProvider ?? null,
        fromProvider: run.lastProvider ?? null,
        toProvider: wait.provider ?? null,
        retryable: true,
        resumeCheckpointId: checkpoint?.id ?? null,
        preservedFiles: checkpoint?.changedFiles ?? []
      }
    });
    return paused;
  });
}

function sanitizeForRunSummary(text: string): string {
  return truncateForDisplay(redactSensitiveText(text), LAST_ERROR_MAX_LENGTH);
}

function nextPhaseAfter(phase: GoalPhase, dnaPhases?: GoalPhase[]): GoalPhase | null {
  // Use DNA phases if available, otherwise fall back to hardcoded PHASES
  const phases = dnaPhases ?? PHASES;
  const index = phases.indexOf(phase);
  return index >= 0 && index < phases.length - 1 ? phases[index + 1] : null;
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
  taskId: number,
  explicitFailureCategory?: string
): GoalRunRecord {
  const safeError = sanitizeForRunSummary(error);
  const checkpoint = database.getLatestGoalCheckpoint(run.id);
  const failureCategory = explicitFailureCategory ?? classifyFailure(safeError);
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
      metadata: {
        runId: run.id,
        phase,
        stepCount,
        failureCategory,
        lastProvider: run.lastProvider ?? null,
        resumeCheckpointId: checkpoint?.id ?? null,
        preservedFiles: checkpoint?.changedFiles ?? []
      }
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
