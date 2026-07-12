import { describe, expect, it } from "vitest";
import {
  formatQueue,
  isUserAllowed,
  parseProjectAddText,
  parseQueueProjectKey,
  parseTaskId,
  parseTaskText
} from "../src/telegram/bot.js";
import { parseProjectTaskInput } from "../src/orchestrator.js";
import { formatGoalNotification } from "../src/telegram/notifications.js";
import { GoalRunRecord, TaskRecord } from "../src/db.js";

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
});

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
