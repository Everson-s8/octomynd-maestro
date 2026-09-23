import path from "node:path";
import type {
  GoalFailureCategory,
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
import { repairWorktreeAccess } from "../environment/doctor.js";
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

  // Re-read resumed runs so durable state written after the scheduler handed
  // us the run (notably validation evidence) is never shadowed by a stale
  // in-memory record.
  const run = options.existingRun
    ? database.getGoalRun(options.existingRun.id)
    : database.createGoalRun(task.id, effectiveMaxSteps);
  // ── DNA / Existing: preserve existing run maxSteps, keeping elevated maxSteps ─
  if (options.existingRun) {
    run.maxSteps = dnaMaxSteps
      ? Math.max(run.maxSteps, dnaMaxSteps)
      : run.maxSteps;
  }
  const isResume = run.status === "waiting_provider" || run.stepCount > 0;
  let currentRun = run;
  // ── DNA: start at first DNA phase, not default "planning" ──
  let phase: GoalPhase = isResume
    ? run.currentPhase
    : (dna?.phases[0] as GoalPhase) ?? run.currentPhase;
  let stepCount = run.stepCount;
  let excluded = excludedProvidersForPhase(
    database,
    registry,
    run.id,
    phase,
    dna,
    initialExcludedProviders(database, run, phase)
  );
  // ── F01 guard: track whether the last completed validation pass actually
  // passed. A failed (or never-run) validation must never be masked by phase
  // budget exhaustion into a "deliver anyway" transition. When requireTests is
  // true and the test phase ran without a green result, delivery is refused and
  // the run blocks (resumable) instead of shipping unverified code.
  // Rebuild the evidence on resume instead of trusting in-memory state. A
  // validation only remains valid until a later implementing step changes the
  // workspace.
  // The explicit column is authoritative for new runs, including `false`
  // after a reviewer requests changes. Fall back only for legacy runs that
  // predate the durable validation state.
  let lastValidationPassed = run.validationPassed !== null && run.validationPassed !== undefined
    ? run.validationPassed
    : options.existingRun
      ? validationPassedForCurrentImplementation(database, run.id)
      : null;
  const setValidationState = (passed: boolean | null) => {
    lastValidationPassed = passed;
    database.setGoalRunValidation(run.id, passed);
  };
  // A resumed/retried run may start a fresh budget window for its current
  // phase. Historical steps remain visible and auditable, but must not consume
  // the continuation's entire phase budget before one new attempt can run.
  const phaseBudgetStartStepId = run.phaseBudgetStartStepId ?? null;
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

    // F01: every delivery route, including reviewer approval and the
    // no-review shortcut, must prove that the current implementation passed
    // validation. Keeping this check here prevents a future shortcut from
    // bypassing the budget-exhaustion guard below.
    if (dna?.requireTests && lastValidationPassed !== true) {
      const steps = database.listGoalSteps(run.id);
      const latestImplementationStepId = [...steps]
        .reverse()
        .find((step) => step.phase === "implementing")?.id ?? 0;
      const validationBoundary = Math.max(phaseBudgetStartStepId ?? 0, latestImplementationStepId);
      const hasValidationAttempt = steps.some((step) => (
        step.phase === "testing" && step.id > validationBoundary
      ));
      return finishRun(
        database,
        currentRun,
        "blocked",
        phase,
        stepCount,
        "Tests are required, but the current implementation has no passing validation.",
        task.id,
        hasValidationAttempt ? "budget_exhausted" : undefined
      );
    }

    // A review is an acceptance gate, not a ceremonial final response. When
    // more than one reviewer-capable provider is registered, do not let the
    // same provider that implemented the change approve its own work. This
    // keeps quota fallback from silently turning into self-approval, while
    // preserving single-provider installations as a valid operating mode.
    const reviewGate = independentReviewGate(database, registry, run.id, dna);
    if (reviewGate) {
      database.addEvent({
        source: "maestro",
        type: "goal.review_independence_blocked",
        text: reviewGate.message,
        taskId: task.id,
        metadata: {
          runId: run.id,
          implementationProviders: reviewGate.implementationProviders,
          reviewingProvider: reviewGate.reviewingProvider,
          independentReviewers: reviewGate.independentReviewers,
          reason: reviewGate.reason
        }
      });
      return finishRun(database, currentRun, "blocked", phase, stepCount, reviewGate.message, task.id);
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
        const delivery = await options.delivery(database.getTask(task.id), project, currentRun, dna?.acceptanceCriteria);
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
      const phaseStepCount = database.listGoalSteps(run.id).filter((s) => (
        s.phase === phase
          && (phaseBudgetStartStepId === null || s.id > phaseBudgetStartStepId)
      )).length;
      if (dnaBudgetLimit !== undefined && phaseStepCount >= dnaBudgetLimit) {
        // Check if this is the last phase — if so, deliver
        const phaseIndex = dnaPhases.indexOf(phase as GoalPhase);
        if (phaseIndex === dnaPhases.length - 1) {
          // Delivery performs the F01 validation check centrally, so this
          // budget path cannot diverge from reviewer and shortcut paths.
          return await deliverGoal();
        }
        // Not last phase — move to next DNA phase
        const nextDnaPhase = dnaPhases[phaseIndex + 1];
        if (nextDnaPhase) {
          phase = nextDnaPhase;
          excluded = excludedProvidersForPhase(database, registry, run.id, phase, dna);
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
            signal: options.signal,
            // Install the worktree's dependencies first: a missing pytest or
            // package must not turn into a "blocked by dependencies" Goal.
            prepareEnvironment: true
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
          // The validation runner is infrastructure around the Goal, not a
          // user-level verdict. A transient runner/toolchain error must remain
          // recoverable so the next provider step can repair the environment.
          return pauseRun(
            database,
            currentRun,
            phase,
            stepCount,
            `Deterministic validation could not start: ${message}`,
            task.id,
            { reason: "environment_error", retryAfterMs: 30_000 }
          );
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
          setValidationState(validation.status === "passed");
        });
        if (validation.status === "passed") {
          phase = "reviewing";
          excluded = excludedProvidersForPhase(database, registry, run.id, phase, dna);
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

      let routed = await registry.acquire(
        CAPABILITIES[phase],
        excluded,
        database.getGoalRun(run.id).preferredProviderId
      );
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
          humanFeedback: [
            latestChangeRequest(database, run.id),
            latestGoalGuidance(database, task.id, run.id)
          ].filter((value): value is string => Boolean(value)).join("\n\n") || null,
          skillContext,
          artifactsRoot: path.resolve(options.artifactsRoot),
          resumeContext: formatCheckpointForResume(database.getLatestGoalCheckpoint(run.id)),
          featureTaskContract: database.findFeaturePlanDetailsByTask(task.id)?.tasks
            .find((candidate) => candidate.taskId === task.id)?.contract,
          deadlineAt: goalDeadlineAt,
          signal: options.signal,
          model: routed.model,
          effort: routed.effort,
          acceptanceCriteria: dna?.acceptanceCriteria,
          workspaceWriteApproved: database.hasEventForTask(task.id, "task.workspace_access_approved")
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
        if (
          phase === "testing"
          && !options.validationRunner
          && ["completed", "failed", "blocked"].includes(result.outcome)
        ) {
          setValidationState(
            result.outcome === "completed" && result.structuredPayload?.testsPassed === true
          );
        }
        if (phase === "reviewing" && result.outcome === "changes_requested") {
          setValidationState(false);
        }
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
        provider: routed.provider.id,
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

      const recoverableBlockedResult = result.outcome === "blocked"
        && isRecoverableProviderFailure(
          result.failureCategory ?? classifyFailure(result.summary || result.error || "", result.failureCategory === "timeout"),
          result.summary || result.error || ""
        );

      if (circuitDecision?.reason === "no_progress" && !recoverableBlockedResult) {
        database.finishGoalStep({
          id: goalStep.id,
          status: "failed",
          summary: circuitDecision.summary,
          output: safeOutput,
          error: circuitDecision.summary,
          durationMs: result.durationMs
        });
        excluded.add(routed.provider.id);
        const fallback = await registry.route(
          CAPABILITIES[phase],
          excluded,
          database.getGoalRun(run.id).preferredProviderId
        );
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

      // These failures cannot be repaired by changing providers: the prompt
      // itself is too large for the process boundary, and a deadline means the
      // goal's execution window is over. Preserve the hard-stop semantics for
      // them while allowing provider-specific failures to fall back below.
      if (circuitDecision?.reason === "prompt_too_large" || circuitDecision?.reason === "deadline") {
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

      if (circuitDecision && result.outcome !== "failed" && !recoverableBlockedResult) {
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
        const failureDetail = result.summary || result.error || "Goal blocked.";
        const failureCategory = result.failureCategory
          ?? classifyFailure(failureDetail, result.failureCategory === "timeout");
        if (task.worktreePath && isWorktreeWriteFailure(failureCategory, failureDetail)) {
          const alreadyRetriedAfterRepair = database.listEventsForTask(task.id, 500).some((event) => (
            event.type === "goal.worktree_repair_attempted"
            && Number(event.metadata?.runId) === run.id
            && event.metadata?.phase === phase
            && event.metadata?.retryProvider === routed.provider.id
          ));
          if (!alreadyRetriedAfterRepair) {
            const repair = repairWorktreeAccess(task.worktreePath);
            database.addEvent({
              source: "maestro",
              type: "goal.worktree_repair_attempted",
              text: repair.detail,
              taskId: task.id,
              metadata: {
                runId: run.id,
                stepId: goalStep.id,
                phase,
                providerId: routed.provider.id,
                retryProvider: repair.repaired ? routed.provider.id : null,
                repaired: repair.repaired,
                failureCategory
              }
            });
            if (repair.repaired) {
              excluded.delete(routed.provider.id);
              continue;
            }
          }
        }
        if (isRecoverableProviderFailure(failureCategory, result.summary || result.error || "")) {
          excluded.add(routed.provider.id);
          const fallback = await registry.route(
            CAPABILITIES[phase],
            excluded,
            database.getGoalRun(run.id).preferredProviderId
          );
          const resumeCheckpoint = database.getLatestGoalCheckpoint(run.id);
          database.addEvent({
            source: "maestro",
            type: fallback ? "goal.provider_block_fallback" : "goal.provider_block_wait",
            text: fallback
              ? `${routed.provider.label} was blocked during ${phase}; routing to ${fallback.provider.label}.`
              : `${routed.provider.label} was blocked during ${phase}; preserving the Goal for recovery.`,
            taskId: task.id,
            metadata: {
              runId: run.id,
              stepId: goalStep.id,
              phase,
              fromProvider: routed.provider.id,
              toProvider: fallback?.provider.id ?? null,
              failureCategory,
              worktreePreserved: true,
              resumeCheckpointId: resumeCheckpoint?.id ?? null,
              preservedFiles: resumeCheckpoint?.changedFiles ?? []
            }
          });
          if (fallback) continue;
          return pauseRun(
            database,
            currentRun,
            phase,
            stepCount,
            result.summary || result.error || "Provider blocked; waiting for recovery.",
            task.id,
            { reason: failureCategory, retryAfterMs: result.retryAfterMs ?? 30_000, provider: routed.provider.id }
          );
        }
        return finishRun(database, currentRun, "blocked", phase, stepCount, result.summary || result.error || "Goal blocked.", task.id, failureCategory);
      }
      if (result.outcome === "failed") {
        // A circuit decision is a safety boundary for the current execution
        // path, not a reason to skip a healthy alternate provider. This matters
        // when one provider fails in several phases: the old code accumulated
        // those failures and blocked the goal before trying Claude/Codex in
        // the last phase, even though a fallback was available.
        excluded.add(routed.provider.id);
        const fallback = await registry.route(
          CAPABILITIES[phase],
          excluded,
          database.getGoalRun(run.id).preferredProviderId
        );
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
        const failureDetail = result.summary || result.error || "Provider failure.";
        const failureCategory = result.failureCategory
          ?? classifyFailure(failureDetail, result.failureCategory === "timeout");
        // Environment and permission failures are repairable execution
        // states, especially during testing. Preserve the checkpoint and
        // retry instead of converting the same recoverable incident into a
        // terminal blocked Goal after the circuit breaker sees it twice.
        if (isRecoverableProviderFailure(failureCategory, failureDetail)) {
          return pauseRun(
            database,
            currentRun,
            phase,
            stepCount,
            failureDetail,
            task.id,
            {
              reason: failureCategory,
              retryAfterMs: result.retryAfterMs ?? 30_000,
              provider: routed.provider.id
            }
          );
        }
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
          // Never deliver a diff that the reviewer explicitly rejected. The
          // run remains resumable and preserves the review feedback/checkpoint.
          return finishRun(
            database,
            currentRun,
            "blocked",
            phase,
            stepCount,
            "The review requested changes, but this task does not allow automatic iteration. Continue the Goal after reviewing the feedback.",
            task.id
          );
        }
        // Any new implementation invalidates the previous validation result.
        // The next testing phase must produce fresh evidence for the new code.
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
      excluded = excludedProvidersForPhase(database, registry, run.id, phase, dna);
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
        "loop"
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
      return finishRun(database, run, "blocked", phase, stepCount, `Goal loop detected (${loopVerdict.reason}) in ${phase}.`, taskId, "loop");
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
    .filter((step) => step.phase === phase && (step.status === "failed" || step.status === "blocked"))
    .map((step) => step.provider)
    .filter(isAgentProviderId);
  const excluded = new Set(failed);
  const preferredProviderId = isAgentProviderId(run.preferredProviderId)
    ? run.preferredProviderId
    : null;
  if (preferredProviderId && wasProviderSelectedAfterItsLatestFailure(database, run, phase, preferredProviderId)) {
    // A user-selected provider gets one explicit retry even if it failed
    // earlier in this phase. The next failure is newer than the selection,
    // so subsequent automatic resumes will not keep retrying it forever.
    excluded.delete(preferredProviderId);
  }
  if (isAgentProviderId(run.lastProvider)) {
    const lastProviderHasFailedThisPhase = failed.includes(run.lastProvider);
    const transientProviderWait = run.waitReason === "quota" || run.waitReason === "capacity";
    if (!lastProviderHasFailedThisPhase || transientProviderWait) excluded.delete(run.lastProvider);
  }
  return excluded;
}

function wasProviderSelectedAfterItsLatestFailure(
  database: MaestroDatabase,
  run: GoalRunRecord,
  phase: GoalPhase,
  providerId: AgentProviderId
): boolean {
  const events = database.listEventsForTask(run.taskId, 500)
    .filter((event) => Number(event.metadata?.runId) === run.id && event.metadata?.phase === phase);
  const latestSelection = events
    .filter((event) => event.type === "goal.provider_selected" && event.metadata?.providerId === providerId)
    .at(-1);
  if (!latestSelection) return false;

  const latestFailure = events
    .filter((event) => (
      (event.type === "goal.step_failed" || event.type === "goal.step_blocked")
      && event.source === providerId
    ))
    .at(-1);
  return !latestFailure || latestSelection.id > latestFailure.id;
}

function latestGoalGuidance(database: MaestroDatabase, taskId: number, runId: number): string | null {
  const events = database.listEventsForTask(taskId, 500)
    .filter((item) => Number(item.metadata?.runId) === runId);
  const guidance = events
    .filter((item) => item.type === "goal.human_guidance")
    .at(-1);
  const recoveries = events
    .filter((item) => item.type === "goal.environment_recovery_command")
    .slice(-5);
  const parts = [
    guidance?.text
      ? `User guidance for this Goal:\n${redactSensitiveText(guidance.text).slice(0, 5000)}`
      : "",
    recoveries.length > 0
      ? `Environment recovery evidence from Chat (newest last):\n${recoveries.map((event) => redactSensitiveText(event.text).slice(0, 2500)).join("\n\n")}`
      : ""
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function isRecoverableProviderFailure(category: string, detail = ""): category is GoalWaitReason {
  if (new Set([
    "quota",
    "auth_required",
    "timeout",
    "offline",
    "capacity",
    "permission_denied",
    "environment_error",
    "configuration_error"
  ]).has(category)) return true;
  return /permission|access denied|read[- ]only|write lock|file lock|worktree.*(?:write|lock)|eacces|eperm/i.test(detail);
}

function isWorktreeWriteFailure(category: string, detail: string): boolean {
  return category === "permission_denied"
    || /permission|access denied|read[- ]only|write lock|file lock|worktree.*(?:write|lock)|eacces|eperm/i.test(detail);
}

type IndependentReviewGate = {
  message: string;
  reason: "missing_review" | "self_review";
  implementationProviders: string[];
  reviewingProvider: string | null;
  independentReviewers: string[];
};

function excludedProvidersForPhase(
  database: MaestroDatabase,
  registry: AgentRegistry,
  runId: number,
  phase: GoalPhase,
  dna?: TaskDNA,
  base: Set<AgentProviderId> = new Set()
): Set<AgentProviderId> {
  if (phase !== "reviewing" || !dna?.requireReview) return base;

  const implementationProviders = [...new Set(
    database.listGoalSteps(runId)
      .filter((step) => step.phase === "implementing" && step.status === "completed")
      .map((step) => step.provider)
      .filter((provider): provider is AgentProviderId => typeof provider === "string" && provider.length > 0)
  )];
  const reviewerIds = registry.list()
    .filter((provider) => provider.capabilities.has("reviewing"))
    .map((provider) => provider.id);
  const hasIndependentReviewer = reviewerIds.some((providerId) => !implementationProviders.includes(providerId));
  if (!hasIndependentReviewer) return base;

  const excluded = new Set(base);
  implementationProviders.forEach((providerId) => excluded.add(providerId));
  return excluded;
}

function independentReviewGate(
  database: MaestroDatabase,
  registry: AgentRegistry,
  runId: number,
  dna?: TaskDNA
): IndependentReviewGate | null {
  if (!dna?.requireReview) return null;

  const steps = database.listGoalSteps(runId);
  const implementationProviders = [...new Set(
    steps
      .filter((step) => step.phase === "implementing" && step.status === "completed")
      .map((step) => step.provider)
      .filter((provider): provider is AgentProviderId => typeof provider === "string" && provider.length > 0)
  )];
  const reviewers = registry.list()
    .filter((provider) => provider.capabilities.has("reviewing"))
    .map((provider) => provider.id);
  const independentReviewers = reviewers.filter((providerId) => !implementationProviders.includes(providerId));
  const latestReview = [...steps]
    .reverse()
    .find((step) => step.phase === "reviewing" && step.status === "completed");

  if (!latestReview) {
    return {
      message: "Delivery blocked: this task requires an acceptance review, but no completed review evidence is available.",
      reason: "missing_review",
      implementationProviders,
      reviewingProvider: null,
      independentReviewers
    };
  }

  if (
    independentReviewers.length > 0
    && implementationProviders.includes(latestReview.provider)
  ) {
    return {
      message: `Delivery blocked: ${latestReview.provider} implemented this task and cannot be its sole acceptance reviewer. Route the review to an independent reviewer (${independentReviewers.join(", ")}) and resume the Goal.`,
      reason: "self_review",
      implementationProviders,
      reviewingProvider: latestReview.provider,
      independentReviewers
    };
  }

  return null;
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

/**
 * Reconstruct validation evidence for a resumed run. Validation is tied to the
 * implementation generation: an implementing step created after the latest
 * validation invalidates that validation, while a reviewing-only resume may
 * safely retain it.
 */
function validationPassedForCurrentImplementation(
  database: MaestroDatabase,
  runId: number
): boolean | null {
  const steps = database.listGoalSteps(runId);
  const latestValidation = [...steps]
    .reverse()
    .find((step) => step.phase === "testing");
  if (!latestValidation) return null;

  const implementationAfterValidation = steps.some((step) => (
    step.phase === "implementing" && step.id > latestValidation.id
  ));
  if (implementationAfterValidation) return false;
  if (latestValidation.status !== "completed") return false;
  if (latestValidation.provider === "maestro-validation") return true;

  // New executions persist provider-backed evidence directly on goal_runs. A
  // step-specific lookup keeps legacy/in-flight runs recoverable without
  // scanning a capped task event window.
  const event = database.findGoalStepCompletedEvent(runId, latestValidation.id);
  const payload = event?.metadata.structuredPayload;
  return typeof payload === "object"
    && payload !== null
    && (payload as Record<string, unknown>).testsPassed === true;
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
  explicitFailureCategory?: GoalFailureCategory
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
      lastError: safeError,
      failureCategory
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
