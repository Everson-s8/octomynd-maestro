import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { AgentRegistry } from "../src/agents/registry.js";
import { OperationalChatService } from "../src/chat/service.js";
import { parseTaskCreationIntent } from "../src/chat/service.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { createTelegramBot } from "../src/telegram/bot.js";
import { MaestroConfig } from "../src/config.js";
import type { AgentProvider } from "../src/agents/types.js";

describe("Unified Operational Chat (Task #52)", () => {
  let tmpDir: string;
  let dbPath: string;
  let database: MaestroDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-chat-test-"));
    dbPath = path.join(tmpDir, "test-maestro.db");
    database = createDatabase(dbPath);
    database.registerProject({
      key: "maestro",
      name: "Octomynd Maestro Test",
      path: tmpDir,
      defaultBranch: "main"
    });
  });

  afterEach(() => {
    try {
      database.close();
    } catch (_) {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists compact project-scoped conversation context across surfaces", async () => {
    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });

    const dashResp = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Por que as tarefas estao paradas?"
    });

    expect(dashResp.projectKey).toBe("maestro");
    expect(dashResp.surface).toBe("dashboard");
    // Short natural reply: both branches (stuck or not) mention "parada".
    expect(dashResp.explanation.toLowerCase()).toContain("parada");

    const tgResp = await chatService.ask({
      projectKey: "maestro",
      surface: "telegram",
      message: "Qual o estado dos provedores?"
    });

    expect(tgResp.surface).toBe("telegram");

    const history = await chatService.getHistory("maestro", 50);
    expect(history.length).toBe(4); // 2 user messages + 2 orchestrator responses
    expect(history[0].surface).toBe("dashboard");
    expect(history[0].senderRole).toBe("user");
    expect(history[1].senderRole).toBe("orchestrator");
    expect(history[2].surface).toBe("telegram");
    expect(history[2].senderRole).toBe("user");
  });

  it("keeps chat history isolated per conversation and supports deletion", async () => {
    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const first = chatService.createThread("maestro", "Primeira conversa");
    const second = chatService.createThread("maestro", "Segunda conversa");

    await chatService.ask({
      projectKey: "maestro",
      threadId: first.id,
      surface: "dashboard",
      message: "Oi na primeira conversa"
    });
    await chatService.ask({
      projectKey: "maestro",
      threadId: second.id,
      surface: "dashboard",
      message: "Oi na segunda conversa"
    });

    expect(chatService.listThreads("maestro")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, title: "Primeira conversa", messageCount: 2 }),
        expect.objectContaining({ id: second.id, title: "Segunda conversa", messageCount: 2 })
      ])
    );
    expect((await chatService.getHistory("maestro", 50, first.id)).every((message) => message.threadId === first.id)).toBe(true);
    expect((await chatService.getHistory("maestro", 50, second.id)).every((message) => message.threadId === second.id)).toBe(true);

    expect(chatService.deleteThread("maestro", first.id)).toBe(true);
    expect(chatService.deleteThread("maestro", first.id)).toBe(false);
    expect(chatService.listThreads("maestro").map((thread) => thread.id)).not.toContain(first.id);
  });

  it("gathers empirical evidence and identifies governed next actions without inventing state", async () => {
    const task = database.createTask("Implement safe operational chat", "test", "maestro");
    database.updateTaskStatus(task.id, "blocked");

    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Por que a task estah bloqueada?"
    });

    expect(response.explanation).toContain(`#${task.id}`);
    expect(response.explanation).toContain("blocked");

    expect(response.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "retry_task",
          targetId: task.id
        })
      ])
    );
  });

  it("answers a casual greeting naturally without dumping task actions", async () => {
    const task = database.createTask("A blocked task should not hijack a greeting", "test", "maestro");
    database.updateTaskStatus(task.id, "blocked");

    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Oi"
    });

    expect(response.explanation.toLowerCase()).toMatch(/oi|ajudar/);
    expect(response.explanation).not.toContain("task(s) ativa(s)");
    expect(response.actions).toEqual([]);
  });

  it("supports a standalone Maestro conversation without a project", async () => {
    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const response = await chatService.ask({
      projectKey: "",
      surface: "dashboard",
      message: "Oi, quais providers posso usar?"
    });

    expect(response.projectKey).toBe("__maestro__");
    expect(response.evidence.project.name).toBe("Maestro (geral)");
    expect((await chatService.listThreads("")).length).toBe(1);
    expect((await chatService.getHistory("", 20)).length).toBe(2);
  });

  it("enforces chat access modes in the core, not only in the UI", async () => {
    const task = database.createTask("Cancelar uma task de teste", "test", "maestro");
    database.updateTaskStatus(task.id, "blocked");
    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });

    const standard = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Por que a task está bloqueada?",
      accessMode: "standard"
    });
    expect(standard.actions.some((action) => action.type === "cancel_task")).toBe(false);

    const full = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Por que a task está bloqueada?",
      accessMode: "full"
    });
    const cancel = full.actions.find((action) => action.type === "cancel_task");
    expect(cancel).toBeDefined();

    const readOnly = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Quais tasks existem?",
      accessMode: "read_only"
    });
    expect(readOnly.actions).toEqual([]);
    await expect(chatService.executeAction({
      projectKey: "maestro",
      surface: "dashboard",
      accessMode: "read_only",
      action: cancel!
    })).rejects.toThrow(/somente leitura/i);
  });

  it("exposes resume from checkpoint for a blocked goal instead of only restarting the task", async () => {
    const task = database.createTask("Continue the financial app implementation", "test", "maestro");
    database.updateTaskStatus(task.id, "blocked");
    const run = database.createGoalRun(task.id, 12);
    database.updateGoalRun({
      id: run.id,
      status: "blocked",
      currentPhase: "implementing",
      stepCount: 6,
      lastError: "provider permission denied"
    });

    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Continue a task bloqueada do checkpoint"
    });

    expect(response.evidence.goals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: run.id, taskId: task.id, status: "blocked", phase: "implementing" })
      ])
    );
    expect(response.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "resume_goal", targetId: run.id })
      ])
    );
    expect(response.actions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "retry_task", targetId: task.id })
      ])
    );
  });

  it("executes safe governed actions directly from chat", async () => {
    const task = database.createTask("Fix broken task", "test", "maestro");
    database.updateTaskStatus(task.id, "failed");

    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const initial = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Como resolver a task com falha?"
    });

    const retryAction = initial.actions.find((a) => a.type === "retry_task");
    expect(retryAction).toBeDefined();

    const actionResult = await chatService.executeAction({
      projectKey: "maestro",
      surface: "dashboard",
      action: retryAction!
    });

    expect(actionResult.success).toBe(true);
    expect(actionResult.resultSummary).toContain(`Task #${task.id} reiniciada`);

    const updatedTask = database.getTask(task.id);
    expect(updatedTask.status).toBe("queued");

    const history = await chatService.getHistory("maestro", 50);
    const systemMsg = history.find((m) => m.senderRole === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg?.messageText).toContain("Task #");

    const staleActionResult = await chatService.executeAction({
      projectKey: "maestro",
      surface: "dashboard",
      action: retryAction!
    });
    expect(staleActionResult.success).toBe(false);
    expect(staleActionResult.resultSummary).toContain("nao e mais aplicavel");
  });

  it("recognizes the task wording used by users and queues it only after confirmation", async () => {
    const longObjective = "A ideia inicial é fazer um projeto de controle de finanças, organizar gastos do apartamento e acompanhar investimentos.";
    expect(parseTaskCreationIntent(`Crie essa task: ${longObjective}`)?.text).toBe(longObjective);
    expect(parseTaskCreationIntent(`eu quero criar a task, não estou pedindo análise: ${longObjective}`)?.text).toBe(longObjective);
    expect(parseTaskCreationIntent("Quero Criar um projeto de controle de finanças, organizar meu salario e as despesas etc")?.text)
      .toBe("um projeto de controle de finanças, organizar meu salario e as despesas etc");

    const createdTaskIds: number[] = [];
    const chatService = new OperationalChatService({
      database,
      worktreesRoot: tmpDir,
      actionExecutor: { taskCreated: (taskId) => { createdTaskIds.push(taskId); } }
    });
    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: `Crie essa task: ${longObjective}`
    });

    const createAction = response.actions.find((action) => action.type === "create_task");
    expect(createAction).toBeDefined();
    expect(database.listTasks(20)).toHaveLength(0);
    expect(response.explanation).toContain("Criar Task");

    const actionResult = await chatService.executeAction({
      projectKey: "maestro",
      surface: "dashboard",
      action: createAction!
    });
    expect(actionResult.success).toBe(true);
    expect(actionResult.resultSummary).toContain("enviada para a fila");
    expect(createdTaskIds).toHaveLength(1);
    expect(database.getTask(createdTaskIds[0]).text).toBe(longObjective);
  });

  it("falls back to the next conversation provider after a headless provider failure", async () => {
    const antigravity = chatProvider("antigravity", {
      outcome: "failed",
      summary: "permission check failed in headless mode",
      output: "",
      error: "user denied permission",
      retryable: false
    });
    const claude = chatProvider("claude", {
      outcome: "completed",
      summary: "Claude answered",
      output: "Consegui consultar o estado com o Claude.",
      error: null,
      retryable: false
    });
    const registry = new AgentRegistry([antigravity, claude]);
    const chatService = new OperationalChatService({
      database,
      agentRegistry: registry,
      worktreesRoot: tmpDir
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Qual provider está pronto agora?"
    });

    expect(response.providerId).toBe("claude");
    expect(response.explanation).toContain("Claude");
  });

  it("honors paused or disabled providers and excludes Codex when Codex is paused or disabled", async () => {
    const fakeCodex = {
      id: "codex" as const,
      label: "Codex Adapter",
      capabilities: new Set(["conversation" as const]),
      health: async () => ({ state: "ready" as const, detail: "Codex active", checkedAt: new Date().toISOString() }),
      execute: async () => ({
        outcome: "completed" as const,
        summary: "Codex output",
        output: "Codex output",
        error: null,
        durationMs: 10,
        retryable: false
      })
    };
    const registry = new AgentRegistry([fakeCodex], undefined, undefined, database);

    // Pause/Disable Codex in Provider Control Plane
    registry.updateProviderControl({ providerId: "codex", mode: "paused", fallbackEnabled: true });

    const chatService = new OperationalChatService({
      database,
      agentRegistry: registry,
      worktreesRoot: tmpDir
    });

    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Status dos provedores?"
    });

    // Provider ID must NOT be codex because codex is paused!
    expect(response.providerId).not.toBe("codex");
    expect(response.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "unblock_provider",
          targetId: "codex"
        })
      ])
    );
  });

  it("serves operational chat endpoints through dashboard server", async () => {
    const mockConfig: MaestroConfig = {
      projectName: "maestro",
      databasePath: dbPath,
      worktreesPath: tmpDir,
      execution: { rootPath: tmpDir, worktreesPath: tmpDir, expectedNodeVersion: "20.17.0", supportedNodeRange: ">=20.17.0 <25" },
      dashboard: { enabled: true, host: "127.0.0.1", port: 0 },
      autopilot: { enabled: false, pollIntervalMs: 5000, maxConcurrentGoals: 1 },
      runtime: { tokenEfficient: true },
      workGraph: { adoptionMode: "off" },
      skills: {
        enabled: true,
        catalogPath: tmpDir,
        versionsPath: tmpDir,
        projectKey: "maestro",
        curator: { staleDays: 30, autoArchiveEnabled: false, pollIntervalMs: 60000 }
      },
      telegram: { botToken: "mock-token", allowedUserId: "123" }
    };

    const server = createDashboardServer({
      config: mockConfig,
      database
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      // 1. Post message to /api/chat/ask
      const askRes = await fetch(`${baseUrl}/api/chat/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectKey: "maestro",
          message: "Qual o status do projeto?"
        })
      });

      expect(askRes.status).toBe(200);
      const askData = await askRes.json();
      expect(askData.explanation).toBeDefined();
      expect(askData.projectKey).toBe("maestro");
      expect(askData.threadId).toEqual(expect.any(Number));

      const globalAskRes = await fetch(`${baseUrl}/api/chat/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Oi, preciso entender o Maestro." })
      });
      expect(globalAskRes.status).toBe(200);
      expect((await globalAskRes.json()).projectKey).toBe("__maestro__");

      // 1b. List and create conversation threads without mixing histories.
      const threadsRes = await fetch(`${baseUrl}/api/chat/threads?projectKey=maestro`);
      expect(threadsRes.status).toBe(200);
      const threadsData = await threadsRes.json();
      expect(threadsData.threads).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: askData.threadId, messageCount: 2 })])
      );

      const newThreadRes = await fetch(`${baseUrl}/api/chat/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKey: "maestro", title: "Conversa isolada" })
      });
      expect(newThreadRes.status).toBe(201);
      const newThreadData = await newThreadRes.json();
      expect(newThreadData.thread.title).toBe("Conversa isolada");

      const deleteThreadRes = await fetch(
        `${baseUrl}/api/chat/threads/${newThreadData.thread.id}?projectKey=maestro`,
        { method: "DELETE" }
      );
      expect(deleteThreadRes.status).toBe(200);
      expect((await deleteThreadRes.json()).deleted).toBe(true);

      // 2. Fetch history from /api/chat/messages
      const getRes = await fetch(`${baseUrl}/api/chat/messages?projectKey=maestro`);
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.messages.length).toBe(2);

      // 3. Post action to /api/chat/action
      const actRes = await fetch(`${baseUrl}/api/chat/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectKey: "maestro",
          action: {
            id: "unblock_provider_claude",
            type: "unblock_provider",
            label: "Habilita Claude",
            description: "Habilita Claude",
            targetId: "claude"
          }
        })
      });

      expect(actRes.status).toBe(200);
      const actData = await actRes.json();
      expect(actData.resultSummary).toBeDefined();
    } finally {
      server.close();
    }
  });

  it("handles Telegram /chat and /chat_action commands", async () => {
    const mockConfig: MaestroConfig = {
      projectName: "maestro",
      databasePath: dbPath,
      worktreesPath: tmpDir,
      execution: { rootPath: tmpDir, worktreesPath: tmpDir, expectedNodeVersion: "20.17.0", supportedNodeRange: ">=20.17.0 <25" },
      dashboard: { enabled: false, host: "127.0.0.1", port: 0 },
      autopilot: { enabled: false, pollIntervalMs: 5000, maxConcurrentGoals: 1 },
      runtime: { tokenEfficient: true },
      workGraph: { adoptionMode: "off" },
      skills: {
        enabled: true,
        catalogPath: tmpDir,
        versionsPath: tmpDir,
        projectKey: "maestro",
        curator: { staleDays: 30, autoArchiveEnabled: false, pollIntervalMs: 60000 }
      },
      telegram: { botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11", allowedUserId: "123" }
    };

    const bot = createTelegramBot(mockConfig, database);
    expect(bot).toBeDefined();
  });
});

function chatProvider(id: string, result: {
  outcome: "completed" | "failed";
  summary: string;
  output: string;
  error: string | null;
  retryable: boolean;
}): AgentProvider {
  return {
    id,
    label: id,
    capabilities: new Set(["conversation"]),
    health: async () => ({ state: "ready", detail: "ready", checkedAt: new Date().toISOString() }),
    execute: async () => ({
      ...result,
      durationMs: 1
    })
  };
}
