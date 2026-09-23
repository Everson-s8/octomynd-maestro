import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase, type MaestroDatabase } from "../src/db.js";
import { AgentRegistry } from "../src/agents/registry.js";
import type { AgentProvider } from "../src/agents/types.js";
import { OperationalChatService } from "../src/chat/service.js";
import { ApplicationCommands } from "../src/commands/application-commands.js";

describe("chat agent loop integration", () => {
  const resources: Array<{ database: MaestroDatabase; dir: string }> = [];

  afterEach(() => {
    for (const resource of resources.splice(0)) {
      resource.database.close();
      fs.rmSync(resource.dir, { recursive: true, force: true });
    }
  });

  it("turns the conversation objective into a task instead of copying the meta request", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-chat-agent-"));
    const database = createDatabase(path.join(dir, "maestro.db"));
    resources.push({ database, dir });
    database.registerProject({ key: "apto", name: "Apto Gerenciamento", path: dir, defaultBranch: "main" });
    const thread = database.createOperationalChatThread({ projectKey: "apto", title: "Reformulação do aplicativo" });
    database.saveOperationalChatMessage({
      threadId: thread.id,
      projectKey: "apto",
      surface: "dashboard",
      senderRole: "user",
      messageText: "O projeto está genérico e cheio de mocks. Quero simplificar para gerenciar contas do apartamento, dívidas entre moradores, comprovantes e lista de compras, com abatimento automático quando alguém paga uma conta compartilhada."
    });
    database.saveOperationalChatMessage({
      threadId: thread.id,
      projectKey: "apto",
      surface: "dashboard",
      senderRole: "orchestrator",
      messageText: "Entendi o escopo: o fluxo precisa priorizar dívidas e contas reais entre moradores, sem a complexidade mockada atual."
    });

    let call = 0;
    const provider: AgentProvider = {
      id: "antigravity",
      label: "Antigravity",
      capabilities: new Set(["conversation"]),
      health: async () => ({ state: "ready", detail: "ready", checkedAt: new Date().toISOString() }),
      execute: async () => {
        call += 1;
        const turns = [
          { type: "tool_call", name: "inspect_project", arguments: { focus: "current app structure and mocks" } },
          { type: "tool_call", name: "project_state", arguments: {} },
          { type: "tool_call", name: "governed_action", arguments: {
            action: "create_task",
            title: "Reformular o Apto Gerenciamento",
            taskText: "Reformular o Apto Gerenciamento para remover a complexidade e os mocks atuais e implementar o fluxo doméstico de contas compartilhadas, dívidas entre moradores, comprovantes e lista de compras, calculando automaticamente o abatimento da dívida quando um morador paga sua parte de uma conta compartilhada.",
            specification: [
              "## Context",
              "O projeto atual está genérico e contém mocks; a conversa descreve um uso doméstico real entre moradores.",
              "",
              "## Objective",
              "Simplificar o Apto Gerenciamento para administrar contas compartilhadas, dívidas, comprovantes e compras.",
              "",
              "## Scope",
              "Implementar o registro de despesas, a divisão entre moradores e o abatimento automático da dívida quando alguém paga sua parte.",
              "",
              "## Acceptance criteria",
              "- Uma conta compartilhada registra participantes, valores e quem pagou.",
              "- A dívida de cada morador é recalculada quando uma parte é paga.",
              "- Comprovantes e lista de compras permanecem acessíveis no fluxo principal.",
              "",
              "## Validation",
              "- Inspecionar os módulos existentes e executar os testes focados do fluxo.",
              "- Executar typecheck ou build quando disponível.",
              "",
              "## Constraints",
              "- Remover complexidade e mocks apenas no escopo necessário; não inventar regras financeiras não definidas."
            ].join("\n")
          } },
          { type: "final", response: "Analisei o contexto completo e criei a task com o objetivo real do apartamento." }
        ];
        const turn = turns[Math.min(call - 1, turns.length - 1)];
        return {
          outcome: "completed",
          summary: "completed",
          output: JSON.stringify(turn),
          structuredPayload: turn,
          error: null,
          retryable: false,
          durationMs: 1
        };
      }
    };
    const service = new OperationalChatService({
      database,
      agentRegistry: new AgentRegistry([provider]),
      worktreesRoot: dir,
      chatBudget: { maxIterations: 6, maxToolCalls: 5 }
    });

    const response = await service.ask({
      projectKey: "apto",
      threadId: thread.id,
      surface: "dashboard",
      accessMode: "full",
      uiLocale: "pt-BR",
      message: "Sim, a partir disso crie uma task para começar a implementar."
    });

    const task = database.listTasksByProject("apto", 10)[0];
    expect(call).toBe(4);
    expect(task?.text).toContain("dívidas entre moradores");
    expect(task?.text).toContain("mocks");
    expect(task?.text).not.toContain("a partir disso crie uma task");
    expect(task?.title).toBe("Reformular o Apto Gerenciamento");
    expect(task?.specification).toContain("## Acceptance criteria");
    expect(task?.specification).toContain("## Validation");
    expect(response.explanation).toContain("criei a task");
    expect(response.evidence.summaryText).toContain("Task creation");
  });

  it("does not persist a task-creation meta instruction after an operational incident", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-chat-agent-meta-task-"));
    const database = createDatabase(path.join(dir, "maestro.db"));
    resources.push({ database, dir });
    database.registerProject({ key: "apto", name: "Apto Gerenciamento", path: dir, defaultBranch: "main" });
    const thread = database.createOperationalChatThread({ projectKey: "apto", title: "Task from context" });
    const objective = "Simplificar a interface do projeto, organizar a navegação principal e deixar o fluxo de edição previsível para o usuário.";
    database.saveOperationalChatMessage({
      threadId: thread.id,
      projectKey: "apto",
      surface: "dashboard",
      senderRole: "user",
      messageText: objective
    });
    database.saveOperationalChatMessage({
      threadId: thread.id,
      projectKey: "apto",
      surface: "dashboard",
      senderRole: "orchestrator",
      messageText: "A Task #6 foi interrompida e está blocked por permission denied; a execução precisa ser recuperada."
    });

    let call = 0;
    const provider: AgentProvider = {
      id: "antigravity",
      label: "Antigravity",
      capabilities: new Set(["conversation"]),
      health: async () => ({ state: "ready", detail: "ready", checkedAt: new Date().toISOString() }),
      execute: async () => {
        call += 1;
        const turn = call === 1
          ? {
            type: "tool_call",
            name: "governed_action",
            arguments: {
              action: "create_task",
              title: "Criar tarefa conforme alinhamos",
              taskText: "Crie a tarefa conforme alinhamos o chat para esse projeto.",
              specification: [
                "## Context", "O projeto precisa de uma interface previsível.",
                "## Objective", "Melhorar a interface.",
                "## Scope", "Organizar a navegação e o fluxo de edição.",
                "## Acceptance criteria", "O usuário consegue editar sem se perder.",
                "## Validation", "Executar os testes e revisar o fluxo.",
                "## Constraints", "Não alterar regras fora da interface."
              ].join("\n")
            }
          }
          : { type: "final", response: "Compilei o objetivo da conversa e criei a task sem reutilizar o relato operacional." };
        return {
          outcome: "completed",
          summary: "completed",
          output: JSON.stringify(turn),
          structuredPayload: turn,
          error: null,
          retryable: false,
          durationMs: 1
        };
      }
    };
    const service = new OperationalChatService({
      database,
      agentRegistry: new AgentRegistry([provider]),
      worktreesRoot: dir,
      chatBudget: { maxIterations: 4, maxToolCalls: 3 }
    });

    const response = await service.ask({
      projectKey: "apto",
      threadId: thread.id,
      surface: "dashboard",
      accessMode: "full",
      uiLocale: "pt-BR",
      message: "Crie a tarefa conforme alinhamos o chat para esse projeto."
    });

    const task = database.listTasksByProject("apto", 10)[0];
    expect(task?.text).toBe(objective);
    expect(task?.text).not.toContain("conforme alinhamos");
    expect(database.listTasksByProject("apto", 10)).toHaveLength(1);
    expect(response.evidence.summaryText).toContain("Task creation");
  });

  it("cancels an in-flight provider turn through the activity controller", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-chat-cancel-"));
    const database = createDatabase(path.join(dir, "maestro.db"));
    resources.push({ database, dir });
    database.registerProject({ key: "apto", name: "Apto Gerenciamento", path: dir, defaultBranch: "main" });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const provider: AgentProvider = {
      id: "codex",
      label: "Codex",
      capabilities: new Set(["conversation"]),
      health: async () => ({ state: "ready", detail: "ready", checkedAt: new Date().toISOString() }),
      execute: async ({ signal }) => {
        started();
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
          signal?.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
        });
        return { outcome: "cancelled", summary: "cancelled", output: "", error: "cancelled", retryable: false, durationMs: 1 };
      }
    };
    const service = new OperationalChatService({ database, agentRegistry: new AgentRegistry([provider]), worktreesRoot: dir });
    const pending = service.ask({ projectKey: "apto", threadId: null, surface: "dashboard", message: "estude o projeto" });
    await startedPromise;
    const live = service.getActiveChat("apto");
    expect(live).toMatchObject({ threadId: expect.any(Number), activity: { active: true, phase: "thinking", requestId: expect.any(String) } });
    expect(service.cancelChat("apto")).toMatchObject({ active: true, phase: "cancelled" });
    await expect(pending).rejects.toThrow("cancelled");
    expect(service.getActivity("apto", live!.threadId)).toMatchObject({ active: false, phase: "idle" });
    const activityEvents = database.listOperationalChatActivityEvents("apto", live!.threadId);
    expect(activityEvents.map((event) => event.phase)).toEqual(expect.arrayContaining(["thinking", "cancelled"]));
  });

  it("persists live Goal guidance instead of creating a second task", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-chat-guidance-"));
    const database = createDatabase(path.join(dir, "maestro.db"));
    resources.push({ database, dir });
    database.registerProject({ key: "apto", name: "Apto Gerenciamento", path: dir, defaultBranch: "main" });
    const task = new ApplicationCommands(database).createTask(
      { channel: "dashboard", userId: null, username: null },
      { projectKey: "apto", text: "Implementar o fluxo do apartamento" }
    );
    database.updateTaskWorktree({ id: task.id, status: "implementing", branchName: "maestro/task-guidance", worktreePath: dir });
    const run = database.createGoalRun(task.id, 12);
    database.updateGoalRun({ id: run.id, status: "running", currentPhase: "implementing", stepCount: 2, lastProvider: "codex" });
    const thread = database.createOperationalChatThread({ projectKey: "apto", title: "Orientar Goal" });
    let providerCalls = 0;
    const provider: AgentProvider = {
      id: "codex",
      label: "Codex",
      capabilities: new Set(["conversation"]),
      health: async () => ({ state: "ready", detail: "ready", checkedAt: new Date().toISOString() }),
      execute: async () => {
        providerCalls += 1;
        const turn = providerCalls === 1
          ? { type: "tool_call", name: "governed_action", arguments: { action: "guide_goal", actionId: `guide_goal_${run.id}` } }
          : { type: "final", response: "Registrei a nova orientação no Goal atual e mantive o checkpoint." };
        return {
          outcome: "completed",
          summary: "completed",
          output: JSON.stringify(turn),
          structuredPayload: turn,
          error: null,
          retryable: false,
          durationMs: 1
        };
      }
    };
    const service = new OperationalChatService({ database, agentRegistry: new AgentRegistry([provider]), worktreesRoot: dir, chatBudget: { maxIterations: 4, maxToolCalls: 3 } });

    await service.ask({
      projectKey: "apto",
      threadId: thread.id,
      surface: "dashboard",
      accessMode: "full",
      uiLocale: "pt-BR",
      message: "Redirecione o Goal para priorizar os testes e continue a execução."
    });

    // The governed guide_goal action is enough to continue the persistent Goal;
    // the chat must not spend another provider loop just writing a summary.
    expect(providerCalls).toBe(0);
    expect(database.listTasksByProject("apto", 10)).toHaveLength(1);
    expect(database.listEventsForTask(task.id).find((event) => event.type === "goal.human_guidance")).toMatchObject({
      taskId: task.id,
      text: "Redirecione o Goal para priorizar os testes e continue a execução."
    });
    expect(database.getGoalRun(run.id).status).toBe("running");
  });

  it("applies an explicit redirection to the active Goal without a redundant provider turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-chat-guidance-core-"));
    const database = createDatabase(path.join(dir, "maestro.db"));
    resources.push({ database, dir });
    database.registerProject({ key: "apto", name: "Apto Gerenciamento", path: dir, defaultBranch: "main" });
    const task = new ApplicationCommands(database).createTask(
      { channel: "dashboard", userId: null, username: null },
      { projectKey: "apto", text: "Implementar o fluxo do apartamento" }
    );
    database.updateTaskWorktree({ id: task.id, status: "implementing", branchName: "maestro/task-guidance-core", worktreePath: dir });
    const run = database.createGoalRun(task.id, 12);
    database.updateGoalRun({ id: run.id, status: "running", currentPhase: "implementing", stepCount: 2, lastProvider: "codex" });
    const thread = database.createOperationalChatThread({ projectKey: "apto", title: "Redirecionar Goal" });
    let providerCalls = 0;
    const provider: AgentProvider = {
      id: "codex",
      label: "Codex",
      capabilities: new Set(["conversation"]),
      health: async () => ({ state: "ready", detail: "ready", checkedAt: new Date().toISOString() }),
      execute: async () => {
        providerCalls += 1;
        const turn = { type: "final", response: "Entendi a nova direção e continuei o Goal existente." };
        return { outcome: "completed", summary: "completed", output: JSON.stringify(turn), structuredPayload: turn, error: null, retryable: false, durationMs: 1 };
      }
    };
    const service = new OperationalChatService({ database, agentRegistry: new AgentRegistry([provider]), worktreesRoot: dir });

    const response = await service.ask({
      projectKey: "apto",
      threadId: thread.id,
      surface: "dashboard",
      accessMode: "full",
      uiLocale: "pt-BR",
      message: "Foque nos testes da implementação atual e continue o Goal."
    });

    expect(providerCalls).toBe(0);
    expect(database.listTasksByProject("apto", 10)).toHaveLength(1);
    expect(database.listEventsForTask(task.id).some((event) => event.type === "goal.human_guidance")).toBe(true);
    expect(response.explanation).toContain("Orientação registrada");
    expect(response.actions.some((action) => action.type === "guide_goal")).toBe(false);
  });

  it("reopens a blocked Goal from chat without creating a replacement run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-chat-reopen-goal-"));
    const database = createDatabase(path.join(dir, "maestro.db"));
    resources.push({ database, dir });
    database.registerProject({ key: "apto", name: "Apto Gerenciamento", path: dir, defaultBranch: "main" });
    const task = new ApplicationCommands(database).createTask(
      { channel: "dashboard", userId: null, username: null },
      { projectKey: "apto", text: "Continuar a implementação do apartamento" }
    );
    database.updateTaskWorktree({ id: task.id, status: "blocked", branchName: "maestro/task-reopen", worktreePath: dir });
    const run = database.createGoalRun(task.id, 12);
    database.updateGoalRun({ id: run.id, status: "blocked", currentPhase: "implementing", stepCount: 4, lastError: "permission denied", failureCategory: "permission_denied" });
    const thread = database.createOperationalChatThread({ projectKey: "apto", title: "Retomar Goal" });
    const provider: AgentProvider = {
      id: "codex",
      label: "Codex",
      capabilities: new Set(["conversation"]),
      health: async () => ({ state: "ready", detail: "ready", checkedAt: new Date().toISOString() }),
      execute: async () => {
        const turn = { type: "final", response: "O Goal foi reaberto do checkpoint atual." };
        return { outcome: "completed", summary: "completed", output: JSON.stringify(turn), structuredPayload: turn, error: null, retryable: false, durationMs: 1 };
      }
    };
    const service = new OperationalChatService({
      database,
      agentRegistry: new AgentRegistry([provider]),
      worktreesRoot: dir,
      actionExecutor: {
        resumeGoal: (runId) => {
          const current = database.getGoalRun(runId);
          database.updateGoalRun({ id: runId, status: "waiting_provider", currentPhase: current.currentPhase, stepCount: current.stepCount, nextRetryAt: null });
          database.updateTaskStatus(current.taskId, current.currentPhase);
        }
      }
    });

    await service.ask({
      projectKey: "apto",
      threadId: thread.id,
      surface: "dashboard",
      accessMode: "full",
      uiLocale: "pt-BR",
      message: "Desbloqueie o Goal e continue a implementação atual a partir do checkpoint."
    });

    expect(database.listGoalRunsForTask(task.id)).toHaveLength(1);
    expect(database.getGoalRun(run.id).status).toBe("waiting_provider");
    expect(database.getTask(task.id).status).toBe("implementing");
  });

  it("repairs a blocked Goal environment inside its worktree, records evidence and then resumes that Goal", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-chat-goal-environment-"));
    const database = createDatabase(path.join(dir, "maestro.db"));
    resources.push({ database, dir });
    database.registerProject({ key: "apto", name: "Apto Gerenciamento", path: dir, defaultBranch: "main" });
    const worktree = path.join(dir, "worktrees", "task-python-env");
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, "package.json"), JSON.stringify({
      name: "goal-env-recovery-test",
      version: "1.0.0",
      scripts: { repair: "node -e \"require('fs').appendFileSync('recovery-proof.txt','x')\"" }
    }), "utf8");
    const task = new ApplicationCommands(database).createTask(
      { channel: "dashboard", userId: null, username: null },
      { projectKey: "apto", text: "Prepare the local test environment and continue implementation." }
    );
    database.updateTaskWorktree({ id: task.id, status: "blocked", branchName: "maestro/task-python-env", worktreePath: worktree });
    const run = database.createGoalRun(task.id, 12);
    database.updateGoalRun({
      id: run.id,
      status: "blocked",
      currentPhase: "testing",
      stepCount: 4,
      lastError: "Python test environment is missing.",
      failureCategory: "environment_error"
    });
    const thread = database.createOperationalChatThread({ projectKey: "apto", title: "Recover Goal test environment" });
    const turns = [
      { type: "tool_call", name: "goal_workspace_command", arguments: { runId: run.id, command: "npm run repair" } },
      { type: "tool_call", name: "goal_workspace_command", arguments: { runId: run.id, command: "npm run repair" } },
      { type: "tool_call", name: "governed_action", arguments: { action: "resume_goal", targetId: run.id } },
      { type: "final", response: "O ambiente foi reparado no worktree, o comando duplicado foi evitado e a Goal existente foi retomada." }
    ];
    let providerCalls = 0;
    let resumeCalls = 0;
    const provider: AgentProvider = {
      id: "codex",
      label: "Codex",
      capabilities: new Set(["conversation"]),
      health: async () => ({ state: "ready", detail: "ready", checkedAt: new Date().toISOString() }),
      execute: async () => {
        const turn = turns[providerCalls++];
        return { outcome: "completed", summary: "completed", output: JSON.stringify(turn), structuredPayload: turn, error: null, retryable: false, durationMs: 1 };
      }
    };
    const service = new OperationalChatService({
      database,
      agentRegistry: new AgentRegistry([provider]),
      worktreesRoot: path.join(dir, "worktrees"),
      chatBudget: { maxIterations: 6, maxToolCalls: 4 },
      actionExecutor: {
        resumeGoal: (runId) => {
          resumeCalls += 1;
          const current = database.getGoalRun(runId);
          database.updateGoalRun({ id: runId, status: "waiting_provider", currentPhase: current.currentPhase, stepCount: current.stepCount, nextRetryAt: null });
          database.updateTaskStatus(current.taskId, current.currentPhase);
        }
      }
    });

    const response = await service.ask({
      projectKey: "apto",
      threadId: thread.id,
      surface: "dashboard",
      accessMode: "full",
      uiLocale: "pt-BR",
      message: "Tente você resolver o ambiente bloqueado desta Goal."
    });

    const recoveryEvents = database.listEventsForTask(task.id).filter((event) => event.type === "goal.environment_recovery_command");
    expect(providerCalls).toBe(4);
    expect(fs.readFileSync(path.join(worktree, "recovery-proof.txt"), "utf8")).toBe("x");
    expect(recoveryEvents).toHaveLength(1);
    expect(recoveryEvents[0].metadata).toMatchObject({ runId: run.id, phase: "testing", command: "npm run repair", status: "completed" });
    expect(resumeCalls).toBe(1);
    expect(database.listGoalRunsForTask(task.id)).toHaveLength(1);
    expect(database.getGoalRun(run.id).status).toBe("waiting_provider");
    expect(response.explanation).toContain("Goal existente foi retomada");
    expect(response.actions.some((action) => action.type === "resume_goal")).toBe(false);
  });

  it("answers a blocked-task question from refreshed project state evidence", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-chat-state-"));
    const database = createDatabase(path.join(dir, "maestro.db"));
    resources.push({ database, dir });
    database.registerProject({ key: "apto", name: "Apto Gerenciamento", path: dir, defaultBranch: "main" });
    const task = new ApplicationCommands(database).createTask({ channel: "dashboard", userId: null, username: null }, { projectKey: "apto", text: "Implementar o fluxo de dívidas compartilhadas" });
    database.updateTaskStatus(task.id, "blocked");
    const thread = database.createOperationalChatThread({ projectKey: "apto", title: "Status" });
    let promptAfterState = "";
    const provider: AgentProvider = {
      id: "codex",
      label: "Codex",
      capabilities: new Set(["conversation"]),
      health: async () => ({ state: "ready", detail: "ready", checkedAt: new Date().toISOString() }),
      execute: async ({ stepNumber, humanFeedback }) => {
        if (stepNumber === 1) return { outcome: "completed", summary: "completed", output: JSON.stringify({ type: "tool_call", name: "project_state", arguments: {} }), structuredPayload: { type: "tool_call", name: "project_state", arguments: {} }, error: null, retryable: false, durationMs: 1 };
        promptAfterState = humanFeedback ?? "";
        return { outcome: "completed", summary: "completed", output: JSON.stringify({ type: "final", response: "A task está bloqueada; o estado atual exige revisão antes de continuar." }), structuredPayload: { type: "final", response: "A task está bloqueada; o estado atual exige revisão antes de continuar." }, error: null, retryable: false, durationMs: 1 };
      }
    };
    const service = new OperationalChatService({ database, agentRegistry: new AgentRegistry([provider]), worktreesRoot: dir });
    const response = await service.ask({ projectKey: "apto", threadId: thread.id, surface: "dashboard", message: "Por que essa task parou?" });

    expect(promptAfterState).toContain("blocked");
    expect(response.explanation).toContain("bloqueada");
  });

  it("does not fall back and duplicate a task after a committed governed action", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-chat-no-replay-"));
    const database = createDatabase(path.join(dir, "maestro.db"));
    resources.push({ database, dir });
    database.registerProject({ key: "apto", name: "Apto", path: dir, defaultBranch: "main" });
    const thread = database.createOperationalChatThread({ projectKey: "apto", title: "Criar task" });
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary: AgentProvider = {
      id: "antigravity",
      label: "Antigravity",
      capabilities: new Set(["conversation"]),
      health: async () => ({ state: "ready", detail: "ready", checkedAt: new Date().toISOString() }),
      execute: async () => {
        primaryCalls += 1;
        if (primaryCalls === 1) {
          return {
            outcome: "completed",
            summary: "completed",
            output: JSON.stringify({
              type: "tool_call",
              name: "governed_action",
              arguments: {
                action: "create_task",
                title: "Implementar fluxo de dívidas",
                taskText: "Implementar o fluxo de dívidas compartilhadas entre moradores.",
                specification: [
                  "## Context", "O projeto precisa de um fluxo real de despesas.",
                  "## Objective", "Implementar o fluxo de dívidas.",
                  "## Scope", "Registrar pagamentos e recalcular saldos.",
                  "## Acceptance criteria", "O saldo deve ser atualizado após cada pagamento.",
                  "## Validation", "Executar os testes do fluxo.",
                  "## Constraints", "Não inventar regras fora do escopo."
                ].join("\n")
              }
            }),
            structuredPayload: null,
            error: null,
            retryable: false,
            durationMs: 1
          };
        }
        return { outcome: "failed", summary: "provider failed after action", output: "provider disconnected", error: "provider disconnected", retryable: true, durationMs: 1 };
      }
    };
    const fallback: AgentProvider = {
      id: "claude",
      label: "Claude",
      capabilities: new Set(["conversation"]),
      health: async () => ({ state: "ready", detail: "ready", checkedAt: new Date().toISOString() }),
      execute: async () => {
        fallbackCalls += 1;
        return { outcome: "completed", summary: "fallback", output: JSON.stringify({ type: "final", response: "fallback" }), structuredPayload: null, error: null, retryable: false, durationMs: 1 };
      }
    };
    const service = new OperationalChatService({ database, agentRegistry: new AgentRegistry([primary, fallback]), worktreesRoot: dir });

    const response = await service.ask({
      projectKey: "apto",
      threadId: thread.id,
      surface: "dashboard",
      accessMode: "full",
      uiLocale: "pt-BR",
      message: "Crie a task com o fluxo descrito na conversa."
    });

    expect(primaryCalls).toBe(2);
    expect(fallbackCalls).toBe(0);
    expect(database.listTasksByProject("apto", 10)).toHaveLength(1);
    expect(response.explanation).toContain("Não vou repetir");
  });
});
