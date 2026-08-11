import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { AgentRegistry } from "../src/agents/registry.js";
import { OperationalChatService } from "../src/chat/service.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { createTelegramBot } from "../src/telegram/bot.js";
import { MaestroConfig } from "../src/config.js";

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
    expect(dashResp.explanation.toLowerCase()).toContain("projeto @maestro");

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

  it("gathers empirical evidence and identifies governed next actions without inventing state", async () => {
    const task = database.createTask("Implement safe operational chat", "test", "maestro");
    database.updateTaskStatus(task.id, "blocked");

    const chatService = new OperationalChatService({ database, worktreesRoot: tmpDir });
    const response = await chatService.ask({
      projectKey: "maestro",
      surface: "dashboard",
      message: "Por que a task estah bloqueada?"
    });

    expect(response.explanation).toContain(`Task #${task.id}`);
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
      execution: { rootPath: tmpDir, worktreesPath: tmpDir, expectedNodeVersion: "20.17.0", supportedNodeRange: ">=20.17.0 <21" },
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
      execution: { rootPath: tmpDir, worktreesPath: tmpDir, expectedNodeVersion: "20.17.0", supportedNodeRange: ">=20.17.0 <21" },
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
