import { describe, expect, it } from "vitest";
import {
  formatQueue,
  formatEnvironmentReport,
  formatImprovementCandidates,
  formatWorkGraphs,
  formatStatus,
  executeCancelCommand,
  isUserAllowed,
  parseProjectAddText,
  parseFeatureCancelText,
  parseFeaturesProjectKey,
  parseDoctorProjectKey,
  parseQueueProjectKey,
  parseStatusProjectKey,
  parseTaskId,
  parseTaskText,
  parseReviewTargetText,
  formatManualReviewMessage,
  formatManualReviewStatusMessage
} from "../src/telegram/bot.js";
import { parseProjectTaskInput } from "../src/orchestrator.js";
import {
  createTelegramGoalProgressNotifier,
  formatFeatureAssemblyNotification,
  formatFeatureBlockedNotification,
  formatGoalNotification
} from "../src/telegram/notifications.js";
import { createTelegramReviewNotifier } from "../src/telegram/notifications.js";
import { createDatabase, GoalRunRecord, TaskRecord } from "../src/db.js";
import { MaestroConfig } from "../src/config.js";
import { ReviewQueueItem } from "../src/reviews/evidence.js";
import type { WorkGraphView } from "../src/commands/application-commands.js";

describe("telegram helpers", () => {
  it("formats shared Work Graph evidence without private paths", () => {
    const graph = {
      id: 9,
      runId: 8,
      taskId: 7,
      projectKey: "boo",
      objective: "Inspect voice pipeline.",
      status: "running",
      maxParallelReaders: 2,
      createdAt: "2026-07-18T10:00:00.000Z",
      updatedAt: "2026-07-18T10:00:03.000Z",
      finishedAt: null,
      adoption: {
        mode: "explicit",
        decision: "explicit",
        reason: "explicit_request_recorded",
        executionMode: "work_graph",
        automaticFanOut: false,
        telemetry: {}
      },
      nodes: [{
        id: 1,
        graphId: 9,
        key: "research",
        position: 0,
        role: "researcher",
        objective: "Inspect.",
        capability: "research",
        dependsOn: [],
        inputArtifacts: [],
        outputContract: "Report.",
        skillVersions: [],
        mode: "read_only",
        writeScope: [],
        maxAttempts: 2,
        deadlineMs: 30_000,
        outputChars: 2_000,
        status: "running",
        attemptCount: 2,
        lastError: null,
        createdAt: "2026-07-18T10:00:00.000Z",
        updatedAt: "2026-07-18T10:00:03.000Z",
        startedAt: "2026-07-18T10:00:00.000Z",
        finishedAt: null,
        fallbackCount: 1,
        attempts: [{
          attemptNumber: 1,
          provider: "codex",
          status: "failed",
          durationMs: 1_000,
          summary: "quota",
          error: "quota",
          createdAt: "2026-07-18T10:00:00.000Z",
          finishedAt: "2026-07-18T10:00:01.000Z"
        }, {
          attemptNumber: 2,
          provider: "claude",
          status: "running",
          durationMs: null,
          summary: "",
          error: null,
          createdAt: "2026-07-18T10:00:02.000Z",
          finishedAt: null
        }]
      }],
      artifacts: [{
        nodeId: 1,
        key: "goal-8/work-graph-9/report.md",
        kind: "report",
        summary: "Safe report.",
        contentHash: null,
        bytes: 400
      }],
      artifactCount: 1,
      artifactBytes: 400,
      canary: { durationMs: 1_000, estimatedTokens: 100, attempts: 2, fallbacks: 1, conflicts: 0, quality: "pending" },
      cancellable: true
    } satisfies WorkGraphView;

    const message = formatWorkGraphs([graph]);
    expect(message).toContain("Adocao: explicit/work_graph");
    expect(message).toContain("codex [failed]");
    expect(message).toContain("claude [running]");
    expect(message).toContain("fallbacks 1");
    expect(message).toContain("/graph_cancel 9");
    expect(message).not.toContain("C:\\Users");
  });

  it("parses task text", () => {
    expect(parseTaskText("/task testar integracao")).toBe("testar integracao");
    expect(parseTaskText("/task@OctomyndMaestroBot testar bot")).toBe("testar bot");
  });

  it("parses project task input", () => {
    expect(parseProjectTaskInput("@octomynd melhorar resposta")).toEqual({
      projectKey: "octomynd",
      text: "melhorar resposta"
    });
    expect(parseProjectTaskInput("@maestro primeira etapa\n\nsegunda etapa")).toEqual({
      projectKey: "maestro",
      text: "primeira etapa\n\nsegunda etapa"
    });
    expect(parseProjectTaskInput("sem projeto explicito")).toEqual({
      projectKey: null,
      text: "sem projeto explicito"
    });
  });

  it("parses project registration", () => {
    expect(parseProjectAddText("/project_add octomynd C:\\repo com espaco")).toEqual({
      key: "octomynd",
      path: "C:\\repo com espaco"
    });
    expect(parseProjectAddText("/project_add")).toBeNull();
  });

  it("parses queue project key", () => {
    expect(parseQueueProjectKey("/queue @octomynd")).toBe("octomynd");
    expect(parseQueueProjectKey("/queue octomynd")).toBe("octomynd");
    expect(parseQueueProjectKey("/queue")).toBeNull();
  });

  it("parses status project key", () => {
    expect(parseStatusProjectKey("/status @boo")).toBe("boo");
    expect(parseStatusProjectKey("/status")).toBeNull();
  });

  it("parses Feature operation commands", () => {
    expect(parseFeaturesProjectKey("/features @boo")).toBe("boo");
    expect(parseFeaturesProjectKey("/features")).toBeNull();
    expect(parseFeatureCancelText("/feature_cancel 12 prioridade mudou")).toEqual({
      featureId: 12,
      reason: "prioridade mudou"
    });
    expect(parseFeatureCancelText("/feature_cancel nope")).toBeNull();
  });

  it("parses review command target text", () => {
    expect(parseReviewTargetText("/review 12", "review")).toBe("12");
    expect(parseReviewTargetText("/review@MaestroBot https://github.com/org/repo/pull/5", "review")).toBe("https://github.com/org/repo/pull/5");
    expect(parseReviewTargetText("/review_status 42", "review_status")).toBe("42");
    expect(parseReviewTargetText("/review_retry 42", "review_retry")).toBe("42");
    expect(parseReviewTargetText("/review", "review")).toBeNull();
    expect(parseReviewTargetText("/review_status", "review_status")).toBeNull();
  });

  it("formats manual review messages and status clearly in Portuguese", () => {
    const dummyFeature = {
      id: 12,
      projectId: 1,
      projectKey: "maestro",
      projectName: "Maestro",
      featurePlanId: 1,
      name: "Feature Test",
      objective: "Test objective",
      status: "completed" as const,
      branchName: "maestro/feature-12",
      worktreePath: "/tmp/worktree",
      pullRequestUrl: "https://github.com/org/repo/pull/12",
      reviewerProvider: "codex",
      reviewSummary: "Approved cleanly.",
      reviewedHeadSha: "abc1234",
      lastError: null,
      mergedAt: "2026-08-07T12:00:00.000Z",
      cancelledAt: null,
      cancelReason: null,
      createdAt: "2026-08-07T10:00:00.000Z",
      updatedAt: "2026-08-07T12:00:00.000Z"
    };

    const successMsg = formatManualReviewMessage({
      success: true,
      feature: dummyFeature,
      status: "completed",
      providerId: "codex",
      summary: "Approved cleanly.",
      message: "Revisao final aprovada e Feature PR mesclado com sucesso!"
    });
    expect(successMsg).toContain("Revisao final aprovada para Feature #12!");
    expect(successMsg).toContain("Projeto: @maestro");
    expect(successMsg).toContain("Revisor: codex");
    expect(successMsg).toContain("Feature PR mesclado com sucesso.");

    const statusMsg = formatManualReviewStatusMessage({
      feature: dummyFeature,
      prState: {
        number: 12,
        url: "https://github.com/org/repo/pull/12",
        title: "Feature PR",
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        headRefName: "feature-branch",
        headRepositoryOwner: "org",
        headRepositoryName: "repo",
        baseRefName: "main",
        headSha: "abc1234",
        checks: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }]
      },
      isReady: true,
      notReadyReason: null,
      isReviewActive: false
    });
    expect(statusMsg).toContain("Status da revisao final - Feature #12");
    expect(statusMsg).toContain("Estado no Maestro: completed");
    expect(statusMsg).toContain("Estado no GitHub: OPEN | Ready | MERGEABLE");
    expect(statusMsg).toContain("Pronto para revisao: Sim");
  });

  it("formats improvement candidates with the governed activation rule", () => {
    const database = createDatabase(":memory:");
    const proposal = database.createImprovementProposal({
      category: "skill",
      title: "Improve delivery evidence",
      rationale: "Completed Features show a repeated evidence gap.",
      proposedChange: "Add a bounded checklist to the delivery skill.",
      evidence: ["feature:1:review_summary"],
      risk: "low",
      projectKey: "maestro"
    });

    const message = formatImprovementCandidates([proposal]);

    expect(message).toContain("#1 @maestro [low]");
    expect(message).toContain("Aprovar cria Task + Feature Plan");
    database.close();
  });

  it("formats a short path-private Environment Doctor report", () => {
    expect(parseDoctorProjectKey("/doctor @boo")).toBe("boo");
    expect(parseDoctorProjectKey("/doctor")).toBeNull();
    const message = formatEnvironmentReport({
      status: "environment_blocked",
      summary: "Execution environment blocked.",
      recommendedAction: "Move the worktree.",
      checkedAt: "now",
      projectKey: "boo",
      taskId: 4,
      fingerprintId: "0123456789abcdef",
      requiredCapabilities: ["planning"],
      checks: [{ name: "worktree", status: "failed", summary: "unsafe", evidence: [] }]
    });

    expect(message).toContain("Environment Doctor @boo: environment_blocked");
    expect(message).toContain("Move the worktree");
    expect(message).not.toContain("C:\\Users");
  });

  it("parses task ids", () => {
    expect(parseTaskId("/prepare 42", "prepare")).toBe(42);
    expect(parseTaskId("/prepare@OctomyndMaestroBot 42", "prepare")).toBe(42);
    expect(parseTaskId("/prepare nope", "prepare")).toBeNull();
  });

  it("checks allowed users", () => {
    expect(isUserAllowed(123, null)).toBe(true);
    expect(isUserAllowed(123, "123")).toBe(true);
    expect(isUserAllowed(456, "123")).toBe(false);
    expect(isUserAllowed(undefined, "123")).toBe(false);
  });

  it("formats empty queue", () => {
    expect(formatQueue([])).toBe("Fila vazia.");
  });

  it("executes the Telegram cancel command through the runtime handler", () => {
    const calls: number[] = [];
    const message = executeCancelCommand("/cancel 42", (taskId) => {
      calls.push(taskId);
      return { ...taskRecord(), id: taskId, status: "cancelled" };
    });

    expect(calls).toEqual([42]);
    expect(message).toBe("Task #42 cancelada. Estado: cancelled.");
    expect(executeCancelCommand("/cancel nope", () => taskRecord())).toBe("Use: /cancel 2");
  });

  it("includes governed autopilot capacity in status", () => {
    const database = createDatabase(":memory:");
    try {
      const status = formatStatus("maestro", database, null, {
        enabled: true,
        state: "idle",
        maxConcurrentGoals: 1,
        pollIntervalMs: 30_000,
        runningGoals: 0,
        waitingProviderGoals: 2,
        queuedTasks: 3,
        lastAction: "queue_empty",
        lastTickAt: null
      });

      expect(status).toContain("Autopilot: idle");
      expect(status).toContain("waiting_provider: 2");
    } finally {
      database.close();
    }
  });

  it("includes the shared provider control-plane state in status", () => {
    const database = createDatabase(":memory:");
    try {
      const status = formatStatus("maestro", database, null, null, [{
        id: "claude",
        label: "Claude",
        capabilities: ["reviewing"],
        health: { state: "ready", detail: "Claude CLI autenticado", checkedAt: new Date().toISOString() },
        state: "working",
        activeCount: 1,
        cooldownUntil: null,
        detail: "Claude CLI autenticado",
        control: { mode: "enabled", fallbackEnabled: true }
      }]);

      expect(status).toContain("Providers:");
      expect(status).toContain("Claude: working (1 ativo) - Claude CLI autenticado");
    } finally {
      database.close();
    }
  });

  it("formats a review notification without local paths or credentials", () => {
    const message = formatGoalNotification(goalRun(), taskRecord());

    expect(message).toContain("Task #3 pronta para review.");
    expect(message).toContain("Projeto: @boo");
    expect(message).toContain("https://github.com/example/boo/pull/1");
    expect(message).not.toContain("C:\\Users");
    expect(message).not.toContain("token");
  });

  it("redacts secrets and local paths from the failure reason it sends", () => {
    const fakeSecret = `sk-ant-${"a".repeat(24)}`;
    const failedRun: GoalRunRecord = {
      ...goalRun(),
      status: "failed",
      lastError: `Codex (implementing): erro desconhecido. Key ${fakeSecret} at C:\\Users\\evers\\worktree`
    };

    const message = formatGoalNotification(failedRun, taskRecord());

    expect(message).toContain("requer atencao");
    expect(message).not.toContain(fakeSecret);
    expect(message).not.toContain("C:\\Users\\evers");
  });

  it("sends review decisions without exposing the private chat id", async () => {
    const database = createDatabase(":memory:");
    try {
      database.registerProject({ key: "boo", path: process.cwd() });
      const task = database.createTask("review", "dashboard", "boo");
      const run = database.createGoalRun(task.id);
      const decision = database.addHumanReview({
        runId: run.id,
        decision: "approved",
        note: "Diff e testes revisados."
      });
      const sent: Array<{ chatId: string; text: string }> = [];
      const notifier = createTelegramReviewNotifier(
        telegramConfig(),
        database,
        async (chatId, text) => sent.push({ chatId, text })
      );

      await notifier!(reviewItem(task.id, run.id), decision);

      expect(sent).toHaveLength(1);
      expect(sent[0].chatId).toBe("private-chat-id");
      expect(sent[0].text).toContain("pronta para merge");
      expect(sent[0].text).not.toContain("private-chat-id");
      expect(sent[0].text).not.toContain("bot-token");
      expect(database.getLastEvent()?.type).toBe("review.notification_sent");
    } finally {
      database.close();
    }
  });

  it("sends phase progress for tasks created outside Telegram", async () => {
    const database = createDatabase(":memory:");
    try {
      database.registerProject({ key: "boo", path: process.cwd() });
      const task = database.createTask("melhorar painel", "codex", "boo");
      const run = database.createGoalRun(task.id);
      const sent: string[] = [];
      const notifier = createTelegramGoalProgressNotifier(
        telegramConfig(),
        database,
        async (_chatId, text) => { sent.push(text); }
      );

      await notifier!(run, "codex");

      expect(sent[0]).toContain("Task #1 em andamento");
      expect(sent[0]).toContain("Agente: codex");
      expect(database.getLastEvent()?.type).toBe("goal.progress_notification_sent");
    } finally {
      database.close();
    }
  });

  it("formats Feature assembly and blocker notifications without sensitive details", () => {
    const database = createDatabase(":memory:");
    try {
      database.registerProject({ key: "boo", path: process.cwd() });
      const task = database.createTask("bloco", "maestro", "boo");
      const plan = database.createFeaturePlan({
        projectKey: "boo",
        objective: "Montar a Feature sem expor segredos.",
        acceptanceCriteria: ["Somente dados sanitizados sao enviados."],
        taskIds: [task.id]
      }).plan;
      const feature = database.createFeature({
        projectKey: "boo",
        featurePlanId: plan.id,
        name: "Feature Boo",
        objective: plan.objective,
        branchName: "maestro/feature-boo",
        worktreePath: process.cwd(),
        pullRequestUrl: "https://github.com/example/boo/pull/10"
      });

      const ready = formatFeatureAssemblyNotification({ type: "draft_ready", plan, feature });
      const blocked = formatFeatureBlockedNotification({
        feature,
        reason: "failed",
        message: `Falhou em C:\\Users\\private com sk-proj-${"x".repeat(48)}`
      });

      expect(ready).toContain("Revise apenas este PR consolidado");
      expect(ready).toContain(feature.pullRequestUrl);
      expect(blocked).not.toContain("C:\\Users\\private");
      expect(blocked).not.toContain(`sk-proj-${"x".repeat(48)}`);
    } finally {
      database.close();
    }
  });
});

function telegramConfig(): MaestroConfig {
  return {
    projectName: "test",
    databasePath: ":memory:",
    worktreesPath: "worktrees",
    execution: {
      rootPath: "runtime",
      worktreesPath: "worktrees",
      expectedNodeVersion: "20.17.0",
      supportedNodeRange: ">=20.17.0 <21"
    },
    dashboard: { enabled: false, host: "127.0.0.1", port: 4787 },
    autopilot: { enabled: true, pollIntervalMs: 30_000, maxConcurrentGoals: 1 },
    runtime: { tokenEfficient: true },
    workGraph: { adoptionMode: "off" },
    skills: {
      enabled: false,
      catalogPath: "skills",
      versionsPath: "versions",
      projectKey: "maestro",
      curator: { staleDays: 30, autoArchiveEnabled: false, pollIntervalMs: 21_600_000 }
    },
    telegram: { botToken: "bot-token", allowedUserId: "private-chat-id" }
  };
}

function reviewItem(taskId: number, runId: number): ReviewQueueItem {
  return {
    runId,
    taskId,
    projectKey: "boo",
    projectName: "Boo",
    demand: "review",
    status: "approved",
    summary: "approved",
    agents: ["codex"],
    changedFiles: ["src/test.ts"],
    tests: [],
    changeSafetyGate: {
      status: "passed",
      code: "secret_scan_passed",
      message: "Verificacao de segredos concluida sem alertas."
    },
    securityAlerts: [],
    pullRequestUrl: "https://github.com/example/boo/pull/1",
    diffUrl: "https://github.com/example/boo/pull/1/files",
    commitSha: "abc123",
    createdAt: "2026-07-12T12:00:00.000Z",
    updatedAt: "2026-07-12T12:01:00.000Z",
    decisions: []
  };
}

function goalRun(): GoalRunRecord {
  return {
    id: 1,
    taskId: 3,
    status: "completed",
    currentPhase: "reviewing",
    stepCount: 4,
    maxSteps: 12,
    lastError: null,
    commitSha: "abc123",
    pullRequestUrl: "https://github.com/example/boo/pull/1",
    createdAt: "2026-07-12T12:00:00.000Z",
    updatedAt: "2026-07-12T12:01:00.000Z",
    finishedAt: "2026-07-12T12:01:00.000Z"
  };
}

function taskRecord(): TaskRecord {
  return {
    id: 3,
    projectId: 1,
    projectKey: "boo",
    projectName: "Boo",
    text: "criar teste Telegram",
    status: "awaiting_human",
    source: "telegram",
    branchName: "maestro/task-3",
    worktreePath: "C:\\Users\\private\\worktree",
    createdAt: "2026-07-12T12:00:00.000Z",
    updatedAt: "2026-07-12T12:01:00.000Z"
  };
}

describe("telegram work intake integration", () => {
  it("parses intake command text correctly", () => {
    const parsed = parseProjectTaskInput(parseTaskText("/task @boo refatorar API"));
    expect(parsed.projectKey).toBe("boo");
    expect(parsed.text).toBe("refatorar API");
  });
});
