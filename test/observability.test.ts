import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db.js";
import { buildGoalObservability } from "../src/goals/observability.js";
import { formatGoalNotification } from "../src/telegram/notifications.js";

describe("Goal Observability", () => {
  it("builds observability snapshot for a waiting_provider goal with checkpoint and fallback history", () => {
    const database = createDatabase(":memory:");
    try {
      database.registerProject({ key: "maestro", path: process.cwd() });
      const task = database.createTask("fix quota fallback", "human", "maestro");
      const run = database.createGoalRun(task.id);
      const step = database.createGoalStep(run.id, "implementing", "codex");

      const checkpoint = database.createGoalCheckpoint({
        runId: run.id,
        stepId: step.id,
        phase: "implementing",
        provider: "codex",
        status: "interrupted",
        summary: "Interrupted due to quota limit.",
        workspaceFingerprint: "fingerprint-123",
        changedFiles: ["src/agents/codex.ts", "src/goals/runner.ts"],
        artifactKeys: ["art-1"]
      });

      database.addEvent({
        source: "maestro",
        type: "goal.provider_fallback",
        text: "Codex failed due to quota; routing to Claude.",
        taskId: task.id,
        metadata: {
          runId: run.id,
          stepId: step.id,
          phase: "implementing",
          fromProvider: "codex",
          toProvider: "claude",
          retryable: true,
          failureCategory: "quota",
          resumeCheckpointId: checkpoint.id,
          preservedFiles: checkpoint.changedFiles
        }
      });

      const updatedRun = database.updateGoalRun({
        id: run.id,
        status: "waiting_provider",
        currentPhase: "implementing",
        stepCount: 1,
        lastError: "Codex usage limit reached.",
        waitReason: "quota",
        nextRetryAt: "2026-08-07T20:00:00.000Z",
        lastProvider: "codex"
      });

      const obs = buildGoalObservability(database, updatedRun);

      expect(obs.classifiedReason).toBe("quota");
      expect(obs.classifiedReasonLabel).toBe("cota do provedor esgotada");
      expect(obs.sourceProvider).toBe("codex");
      expect(obs.nextProvider).toBe("claude");
      expect(obs.preservedChanges).toBe(true);
      expect(obs.preservedFiles).toEqual(["src/agents/codex.ts", "src/goals/runner.ts"]);
      expect(obs.checkpointId).toBe(checkpoint.id);
      expect(obs.retryable).toBe(true);
      expect(obs.nextAction).toContain("Retomada automatica agendada");
    } finally {
      database.close();
    }
  });

  it("formats Telegram notification with rich observability metadata and redacts secrets", () => {
    const database = createDatabase(":memory:");
    try {
      database.registerProject({ key: "maestro", path: process.cwd() });
      const task = database.createTask("test telegram notification", "telegram", "maestro");
      const run = database.createGoalRun(task.id);
      const step = database.createGoalStep(run.id, "implementing", "codex");

      const checkpoint = database.createGoalCheckpoint({
        runId: run.id,
        stepId: step.id,
        phase: "implementing",
        provider: "codex",
        status: "interrupted",
        summary: "Quota limit reached.",
        workspaceFingerprint: "fp-1",
        changedFiles: ["src/index.ts"],
        artifactKeys: []
      });

      database.addEvent({
        source: "maestro",
        type: "goal.provider_fallback",
        text: "Codex failed; routing to Claude.",
        taskId: task.id,
        metadata: {
          runId: run.id,
          stepId: step.id,
          phase: "implementing",
          fromProvider: "codex",
          toProvider: "claude",
          retryable: true,
          failureCategory: "quota",
          resumeCheckpointId: checkpoint.id,
          preservedFiles: checkpoint.changedFiles
        }
      });

      const fakeSecret = `sk-ant-api03-${"z".repeat(32)}`;
      const waitingRun = database.updateGoalRun({
        id: run.id,
        status: "waiting_provider",
        currentPhase: "implementing",
        stepCount: 1,
        lastError: `Quota exceeded with key ${fakeSecret}`,
        waitReason: "quota",
        nextRetryAt: "2026-08-07T21:00:00.000Z",
        lastProvider: "codex"
      });

      const text = formatGoalNotification(waitingRun, task, database);

      expect(text).toContain("Task #1 requer atencao.");
      expect(text).toContain("Projeto: @maestro");
      expect(text).toContain("Goal #1: waiting_provider");
      expect(text).toContain("Motivo: cota do provedor esgotada");
      expect(text).toContain("Provedor origem: codex");
      expect(text).toContain("Proximo provedor: claude");
      expect(text).toContain("Alteracoes preservadas: sim (1 arquivos)");
      expect(text).toContain(`Checkpoint: #${checkpoint.id}`);
      expect(text).toContain("Retomavel: sim");
      expect(text).toContain("Proxima acao: Retomada automatica agendada");
      expect(text).not.toContain(fakeSecret);
    } finally {
      database.close();
    }
  });

  it("handles terminal blocked/failed goals where waitReason is cleared in database", () => {
    const database = createDatabase(":memory:");
    try {
      database.registerProject({ key: "maestro", path: process.cwd() });
      const task = database.createTask("test blocked status", "human", "maestro");
      const run = database.createGoalRun(task.id);

      database.addEvent({
        source: "maestro",
        type: "goal.blocked",
        text: "Execution blocked due to timeout.",
        taskId: task.id,
        metadata: {
          runId: run.id,
          phase: "testing",
          stepCount: 2,
          failureCategory: "timeout",
          lastProvider: "claude",
          resumeCheckpointId: 5,
          preservedFiles: ["test/app.test.ts"]
        }
      });

      const blockedRun = database.updateGoalRun({
        id: run.id,
        status: "blocked",
        currentPhase: "testing",
        stepCount: 2,
        lastError: "Execution blocked due to timeout."
      });

      const obs = buildGoalObservability(database, blockedRun);

      expect(obs.classifiedReason).toBe("timeout");
      expect(obs.classifiedReasonLabel).toBe("tempo limite excedido");
      expect(obs.sourceProvider).toBe("claude");
      expect(obs.nextProvider).toBeNull();
      expect(obs.checkpointId).toBe(5);
      expect(obs.preservedChanges).toBe(true);
      expect(obs.retryable).toBe(true);
      expect(obs.nextAction).toContain("Falha transitoria");
    } finally {
      database.close();
    }
  });

  it("reports a Goal step-budget stop as resumable work rather than a provider failure", () => {
    const database = createDatabase(":memory:");
    try {
      database.registerProject({ key: "maestro", path: process.cwd() });
      const task = database.createTask("continue bounded work", "telegram", "maestro");
      const run = database.createGoalRun(task.id);
      const step = database.createGoalStep(run.id, "implementing", "claude");
      const checkpoint = database.createGoalCheckpoint({
        runId: run.id,
        stepId: step.id,
        phase: "implementing",
        provider: "claude",
        status: "completed",
        summary: "Work preserved after the bounded run.",
        workspaceFingerprint: "fp-budget",
        changedFiles: ["src/runtime/self-update.ts"],
        artifactKeys: []
      });
      database.addEvent({
        source: "maestro",
        type: "goal.blocked",
        text: "Goal reached its 12-step budget.",
        taskId: task.id,
        metadata: {
          runId: run.id,
          phase: "reviewing",
          stepCount: 12,
          failureCategory: "budget_exhausted",
          lastProvider: "claude",
          resumeCheckpointId: checkpoint.id,
          preservedFiles: checkpoint.changedFiles
        }
      });
      const blocked = database.updateGoalRun({
        id: run.id,
        status: "blocked",
        currentPhase: "reviewing",
        stepCount: 12,
        lastError: "Goal reached its 12-step budget.",
        lastProvider: "claude"
      });
      const observation = buildGoalObservability(database, blocked);
      expect(observation.classifiedReason).toBe("budget_exhausted");
      expect(observation.classifiedReasonLabel).toBe("orcamento de etapas da Goal esgotado");
      expect(observation.sourceProvider).toBeNull();
      expect(observation.preservedChanges).toBe(true);
      expect(observation.nextAction).toContain("Continue a Goal a partir do checkpoint");
    } finally {
      database.close();
    }
  });
});
