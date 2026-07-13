import { describe, expect, it } from "vitest";
import {
  formatQueue,
  isUserAllowed,
  parseProjectAddText,
  parseQueueProjectKey,
  parseStatusProjectKey,
  parseTaskId,
  parseTaskText
} from "../src/telegram/bot.js";
import { parseProjectTaskInput } from "../src/orchestrator.js";
import { createTelegramGoalProgressNotifier, formatGoalNotification } from "../src/telegram/notifications.js";
import { createTelegramReviewNotifier } from "../src/telegram/notifications.js";
import { createDatabase, GoalRunRecord, TaskRecord } from "../src/db.js";
import { MaestroConfig } from "../src/config.js";
import { ReviewQueueItem } from "../src/reviews/evidence.js";

describe("telegram helpers", () => {
  it("parses task text", () => {
    expect(parseTaskText("/task testar integracao")).toBe("testar integracao");
    expect(parseTaskText("/task@OctomyndMaestroBot testar bot")).toBe("testar bot");
  });

  it("parses project task input", () => {
    expect(parseProjectTaskInput("@octomynd melhorar resposta")).toEqual({
      projectKey: "octomynd",
      text: "melhorar resposta"
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

  it("formats a review notification without local paths or credentials", () => {
    const message = formatGoalNotification(goalRun(), taskRecord());

    expect(message).toContain("Task #3 pronta para review.");
    expect(message).toContain("Projeto: @boo");
    expect(message).toContain("https://github.com/example/boo/pull/1");
    expect(message).not.toContain("C:\\Users");
    expect(message).not.toContain("token");
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
});

function telegramConfig(): MaestroConfig {
  return {
    projectName: "test",
    databasePath: ":memory:",
    worktreesPath: "worktrees",
    dashboard: { enabled: false, host: "127.0.0.1", port: 4787 },
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
