import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { MaestroConfig } from "../src/config.js";

let tempDir: string;
let projectDir: string;
let database: MaestroDatabase;
let config: MaestroConfig;

function runGit(args: string[], cwd: string) {
  const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-task-logs-"));
  projectDir = path.join(tempDir, "test-project");
  fs.mkdirSync(projectDir);
  runGit(["init", "-b", "main"], projectDir);
  fs.writeFileSync(path.join(projectDir, "README.md"), "# Test Project\n");
  runGit(["add", "README.md"], projectDir);
  runGit(["-c", "user.name=Maestro Test", "-c", "user.email=maestro@test.local", "commit", "-m", "Initial commit"], projectDir);

  config = {
    projectName: "maestro-test",
    databasePath: path.join(tempDir, "maestro.db"),
    worktreesPath: path.join(tempDir, "worktrees"),
    execution: {
      rootPath: tempDir,
      worktreesPath: path.join(tempDir, "worktrees"),
      expectedNodeVersion: "20.17.0",
      supportedNodeRange: ">=20.17.0 <21"
    },
    dashboard: { enabled: true, host: "127.0.0.1", port: 4788 },
    autopilot: { enabled: true, pollIntervalMs: 30_000, maxConcurrentGoals: 1 },
    runtime: { tokenEfficient: true },
    workGraph: { adoptionMode: "off" },
    skills: {
      enabled: false,
      catalogPath: path.join(tempDir, "skills"),
      versionsPath: path.join(tempDir, "versions"),
      projectKey: "testproj",
      curator: { staleDays: 30, autoArchiveEnabled: false, pollIntervalMs: 21_600_000 }
    },
    telegram: { botToken: "test-token", allowedUserId: "123" }
  };
  database = createDatabase(path.join(tempDir, "maestro.db"));
  database.registerProject({ key: "testproj", name: "Test Project", path: projectDir, defaultBranch: "main" });
});

describe("Task Logs & Telemetry Persistence", () => {
  it("aggregates execution runs, steps, checkpoints, token usage, and events per task", () => {
    const task = database.createTask("Implementar feature com logs detalhados", "telegram", "testproj");
    expect(task.id).toBeGreaterThan(0);

    // Initial logs before execution
    const initialLogs = database.getTaskLogs(task.id);
    expect(initialLogs.task.id).toBe(task.id);
    expect(initialLogs.runs).toHaveLength(0);
    expect(initialLogs.telemetry.totalSteps).toBe(0);
    expect(initialLogs.telemetry.totalCostUsd).toBe(0);
    expect(initialLogs.telemetry.changedFiles).toHaveLength(0);

    // Create a Goal Run with steps, checkpoints, and tokens
    const run = database.createGoalRun(task.id, 10);

    const step1 = database.createGoalStep(run.id, "planning", "gemini-antigravity");
    database.finishGoalStep({
      id: step1.id,
      status: "completed",
      summary: "Planejamento inicial da arquitetura",
      output: "Analisando dependências e definindo plano de ação",
      durationMs: 1500
    });

    database.recordTokenUsage({
      runId: run.id,
      stepId: step1.id,
      provider: "gemini-antigravity",
      model: "gemini-2.5-pro",
      inputTokens: 1200,
      outputTokens: 450,
      costUsd: 0.0035
    });

    const step2 = database.createGoalStep(run.id, "implementing", "claude-code");
    database.finishGoalStep({
      id: step2.id,
      status: "completed",
      summary: "Implementando novos componentes e rotas",
      output: "call:default_api:write_to_file{TargetFile: 'ui/src/pages/TaskLogViewerPage.tsx'}",
      durationMs: 2800
    });

    database.recordTokenUsage({
      runId: run.id,
      stepId: step2.id,
      provider: "claude-code",
      model: "claude-3-7-sonnet",
      inputTokens: 3500,
      outputTokens: 1200,
      costUsd: 0.0245
    });

    database.createGoalCheckpoint({
      runId: run.id,
      stepId: step2.id,
      phase: "implementing",
      provider: "claude-code",
      status: "completed",
      summary: "Componentes UI e rotas criados com sucesso",
      workspaceFingerprint: "sha256:abcd1234ef56",
      changedFiles: ["ui/src/pages/TaskLogViewerPage.tsx", "ui/src/styles-v2.css"],
      artifactKeys: ["task_log_viewer_preview"]
    });

    database.addEvent({
      source: "goal_runner",
      type: "goal.step_completed",
      text: `Etapa 2 concluída para task #${task.id}`,
      taskId: task.id,
      metadata: { taskId: task.id, runId: run.id, phase: "implementing" }
    });

    // Fetch task logs
    const taskLogs = database.getTaskLogs(task.id);

    expect(taskLogs.task.id).toBe(task.id);
    expect(taskLogs.runs).toHaveLength(1);
    expect(taskLogs.runs[0].steps).toHaveLength(2);
    expect(taskLogs.runs[0].checkpoints).toHaveLength(1);
    expect(taskLogs.runs[0].tokenUsage).toHaveLength(2);

    // Telemetry assertions
    expect(taskLogs.telemetry.totalSteps).toBe(2);
    expect(taskLogs.telemetry.totalDurationMs).toBe(4300);
    expect(taskLogs.telemetry.totalCostUsd).toBeCloseTo(0.028, 3);
    expect(taskLogs.telemetry.totalInputTokens).toBe(4700);
    expect(taskLogs.telemetry.totalOutputTokens).toBe(1650);
    expect(taskLogs.telemetry.changedFiles).toEqual(
      expect.arrayContaining(["ui/src/pages/TaskLogViewerPage.tsx", "ui/src/styles-v2.css"])
    );

    // Events assertions
    expect(taskLogs.events.length).toBeGreaterThanOrEqual(1);
    expect(taskLogs.events.some((e) => e.text.includes(`Etapa 2 concluída`))).toBe(true);
  });

  it("keeps the most recent events when a task exceeds the log limit", () => {
    const task = database.createTask("Task com muitos eventos", "dashboard", "testproj");

    for (let index = 0; index < 505; index += 1) {
      database.addEvent({
        source: "test",
        type: "task.progress",
        text: `event-${index}`,
        taskId: task.id,
        metadata: { taskId: task.id, index }
      });
    }

    const events = database.listEventsForTask(task.id, 500);
    expect(events).toHaveLength(500);
    expect(events[0]?.text).toBe("event-5");
    expect(events.at(-1)?.text).toBe("event-504");
  });

  it("redacts sensitive data in task logs output and summaries", () => {
    const fakeAnthropicKey = `${["sk", "ant"].join("-")}-${"a".repeat(24)}`;
    const fakeGithubToken = ["ghp", "c".repeat(24)].join("_");
    const fakeOpenAiKey = `${["sk", "proj"].join("-")}-${"b".repeat(24)}`;

    const task = database.createTask(`Task com secret ${fakeAnthropicKey}`, "telegram", "testproj");
    const run = database.createGoalRun(task.id, 5);

    const step = database.createGoalStep(run.id, "implementing", "claude");
    database.finishGoalStep({
      id: step.id,
      status: "completed",
      summary: `Usando token ${fakeGithubToken} para autenticacao`,
      output: `Log contendo C:\\Users\\admin\\secret.txt e chave ${fakeOpenAiKey}`,
      durationMs: 500
    });

    const logs = database.getTaskLogs(task.id);
    expect(logs.task.text).not.toContain(fakeAnthropicKey);
    expect(logs.runs[0].steps[0].summary).not.toContain(fakeGithubToken);
    expect(logs.runs[0].steps[0].output).not.toContain("C:\\Users\\admin\\secret.txt");
    expect(logs.runs[0].steps[0].output).not.toContain(fakeOpenAiKey);
    expect(logs.runs[0].steps[0].output).toContain("[REDACTED_LOCAL_PATH]");
    expect(logs.runs[0].steps[0].output).toContain("[REDACTED_SECRET]");
  });

  it("serves GET /api/tasks/:id/logs via the HTTP dashboard server", async () => {
    const task = database.createTask("Task para teste de API HTTP", "dashboard", "testproj");
    const run = database.createGoalRun(task.id, 8);

    const step = database.createGoalStep(run.id, "planning", "gemini");
    database.finishGoalStep({
      id: step.id,
      status: "completed",
      summary: "Definindo arquitetura dos logs",
      output: "Planejamento concluído com sucesso.",
      durationMs: 850
    });

    const server = createDashboardServer({ config, database, staticRoot: tempDir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      // Valid task logs request
      const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/logs`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.logs.task.id).toBe(task.id);
      expect(data.logs.runs).toHaveLength(1);
      expect(data.logs.runs[0].steps).toHaveLength(1);
      expect(data.logs.runs[0].steps[0].summary).toBe("Definindo arquitetura dos logs");
      expect(data.logs.telemetry.totalSteps).toBe(1);
      expect(data.logs.telemetry.totalDurationMs).toBe(850);

      // Non-existent task logs request
      const notFoundRes = await fetch(`http://127.0.0.1:${port}/api/tasks/99999/logs`);
      expect(notFoundRes.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("creates a follow-up task linked to the original task", async () => {
    const parent = database.createTask("Task original para receber revisão", "dashboard", "testproj");
    const server = createDashboardServer({ config, database, staticRoot: tempDir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${parent.id}/follow-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Corrigir os pontos encontrados na revisão" })
      });

      expect(response.status).toBe(201);
      const data = (await response.json()) as {
        task: { id: number; parentTaskId: number; status: string; projectKey: string };
      };
      expect(data.task.id).not.toBe(parent.id);
      expect(data.task.parentTaskId).toBe(parent.id);
      expect(data.task.status).toBe("queued");
      expect(data.task.projectKey).toBe("testproj");

      const logs = database.getTaskLogs(data.task.id);
      expect(logs.task.parentTaskId).toBe(parent.id);
      expect(logs.events.some((event) => event.type === "task.follow_up_created")).toBe(true);
    } finally {
      server.close();
    }
  });
});
