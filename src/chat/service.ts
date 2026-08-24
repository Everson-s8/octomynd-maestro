import {
  ChatActionExecutor,
  ChatEvidenceContext,
  ChatEvidenceFeaturePlanFact,
  ChatEvidenceGoalFact,
  ChatEvidenceOutboxFact,
  ChatEvidenceReviewFact,
  ChatEvidenceTaskFact,
  ChatEvidenceWorkGraphFact,
  GovernedChatAction,
  OperationalChatActionRequest,
  OperationalChatActionResponse,
  OperationalChatMessageRecord,
  OperationalChatRequest,
  OperationalChatResponse,
  ChatAccessMode,
  GLOBAL_CHAT_PROJECT_KEY
} from "./types.js";
import { MaestroDatabase, ProjectRecord } from "../db.js";
import { AgentRegistry } from "../agents/registry.js";
import { ApplicationCommands } from "../commands/application-commands.js";
import { AgentProviderId } from "../agents/types.js";
import { redactSensitiveText } from "../security/redaction.js";

// A local CLI has cold-start/auth/session overhead. Eight seconds made a
// normal conversational reply look like a provider failure and immediately
// dropped the user into the terse deterministic fallback.
const CHAT_PROVIDER_TIMEOUT_MS = 60_000;
const HIGH_IMPACT_ACTIONS = new Set<GovernedChatAction["type"]>([
  "create_task",
  "cancel_task",
  "cancel_feature_plan",
  "resume_goal",
  "unblock_provider"
]);
const FULL_ACCESS_ONLY_ACTIONS = new Set<GovernedChatAction["type"]>([
  "cancel_task",
  "cancel_feature_plan"
]);
const GLOBAL_CHAT_PROJECT: ProjectRecord = {
  id: 0,
  key: GLOBAL_CHAT_PROJECT_KEY,
  name: "Maestro (geral)",
  path: "",
  defaultBranch: "main",
  createdAt: "",
  updatedAt: ""
};

export type OperationalChatAgentRegistry = Pick<AgentRegistry, "snapshot"> & Partial<Pick<
  AgentRegistry,
  "route" | "acquire" | "updateProviderControl"
>>;

export type OperationalChatServiceOptions = {
  database: MaestroDatabase;
  agentRegistry?: OperationalChatAgentRegistry;
  commands?: ApplicationCommands;
  worktreesRoot?: string;
  actionExecutor?: ChatActionExecutor;
};

export class OperationalChatService {
  private readonly database: MaestroDatabase;
  private readonly agentRegistry?: OperationalChatAgentRegistry;
  private readonly commands: ApplicationCommands;
  private readonly worktreesRoot: string;
  private readonly actionExecutor?: ChatActionExecutor;

  constructor(options: OperationalChatServiceOptions) {
    this.database = options.database;
    this.agentRegistry = options.agentRegistry;
    this.commands = options.commands ?? new ApplicationCommands(options.database);
    this.worktreesRoot = options.worktreesRoot ?? process.cwd();
    this.actionExecutor = options.actionExecutor;
  }

  async ask(request: OperationalChatRequest): Promise<OperationalChatResponse> {
    const projectKey = normalizeChatProjectKey(request.projectKey);
    const project = this.resolveChatProject(projectKey);
    const thread = this.resolveThread(projectKey, request.threadId);
    const accessMode = normalizeAccessMode(request.accessMode ?? thread.accessMode);
    if (thread.accessMode !== accessMode) this.database.updateOperationalChatThreadAccessMode(thread.id, accessMode);

    const evidence = await this.gatherEvidenceContext(projectKey);
    const taskIntent = parseTaskCreationIntent(request.message);
    const actions = this.identifyGovernedActions(evidence, taskIntent, request.message, accessMode);

    const savedUserMessage = this.database.saveOperationalChatMessage({
      threadId: thread.id,
      projectKey,
      surface: request.surface,
      senderRole: "user",
      messageText: request.message
    });

    const conversationHistory = this.database
      .listOperationalChatMessages(projectKey, 12, thread.id)
      .filter((message) => message.id !== savedUserMessage.id)
      .slice(-10);
    const routingResult = await this.synthesizeExplanation(
      request.message,
      evidence,
      actions,
      conversationHistory,
      accessMode
    );

    const explanation = redactSensitiveText(routingResult.explanation);

    const savedOrchestratorMessage = this.database.saveOperationalChatMessage({
      threadId: thread.id,
      projectKey,
      surface: request.surface,
      senderRole: "orchestrator",
      messageText: explanation,
      evidenceJson: JSON.stringify(this.sanitizeEvidenceForStorage(evidence)),
      actionTaken: actions.length > 0 ? JSON.stringify(actions) : null
    });

    this.database.pruneOperationalChatMessages(projectKey, 100, thread.id);

    return {
      messageId: savedOrchestratorMessage.id,
      threadId: thread.id,
      projectKey,
      surface: request.surface,
      explanation,
      evidence,
      actions,
      providerId: routingResult.providerId,
      accessMode,
      createdAt: savedOrchestratorMessage.createdAt
    };
  }

  async executeAction(request: OperationalChatActionRequest): Promise<OperationalChatActionResponse> {
    const projectKey = normalizeChatProjectKey(request.projectKey);
    this.resolveChatProject(projectKey);
    const thread = this.resolveThread(projectKey, request.threadId);
    const accessMode = normalizeAccessMode(request.accessMode ?? thread.accessMode);
    if (thread.accessMode !== accessMode) this.database.updateOperationalChatThreadAccessMode(thread.id, accessMode);

    if (accessMode === "read_only") {
      throw new Error("O chat está em modo somente leitura. Troque para Standard ou Full Access para executar ações.");
    }

    const evidence = await this.gatherEvidenceContext(projectKey);
    const taskIntent = request.action.type === "create_task"
      ? parseTaskCreationIntent(String(request.action.payload?.text ?? "")) ?? {
        text: String(request.action.payload?.text ?? "").trim()
      }
      : null;
    const validActions = this.identifyGovernedActions(evidence, taskIntent?.text ? taskIntent : null, undefined, accessMode);
    const action = validActions.find((a) => a.id === request.action.id && a.type === request.action.type);

    if (!action) {
      return {
        success: false,
        actionTaken: request.action.label,
        resultSummary: `Acao '${request.action.id}' nao e mais aplicavel ao estado atual do projeto.`
      };
    }

    const origin = {
      channel: request.surface,
      userId: request.userId ?? null,
      username: request.username ?? null
    };

    let resultSummary = "";
    let success = true;

    try {
      switch (action.type) {
        case "create_task": {
          const text = typeof action.payload?.text === "string" ? action.payload.text.trim() : "";
          if (text.length < 4) throw new Error("O texto da task esta vazio ou muito curto.");
          const targetProjectKey = typeof action.payload?.projectKey === "string"
            ? action.payload.projectKey
            : projectKey === GLOBAL_CHAT_PROJECT_KEY ? this.database.getDefaultProject()?.key : projectKey;
          if (!targetProjectKey) throw new Error("Nenhum projeto está cadastrado para receber a task.");
          const task = this.commands.createTask(origin, { text, projectKey: targetProjectKey });
          await this.actionExecutor?.taskCreated?.(task.id);
          resultSummary = `Task #${task.id} criada para @${targetProjectKey} e enviada para a fila.`;
          break;
        }

        case "unblock_provider": {
          const providerId = (action.payload?.providerId ?? action.targetId) as AgentProviderId;
          if (this.agentRegistry?.updateProviderControl) {
            this.agentRegistry.updateProviderControl({
              providerId,
              mode: "enabled",
              fallbackEnabled: true
            });
            resultSummary = `Provedor ${providerId} reabilitado no Provider Control Plane.`;
          } else {
            resultSummary = `Nao foi possivel atualizar o provedor ${providerId}: AgentRegistry indisponivel.`;
            success = false;
          }
          break;
        }

        case "retry_task": {
          const taskId = Number(action.targetId);
          // F-hotfix: a blocked task that already has a worktree must return
          // to 'planning' (worktree intact, goal restarts), NOT 'queued' —
          // queued made the autopilot re-run prepareTask which used to throw
          // "already has a worktree" and re-block it (infinite retry loop).
          const current = this.database.getTask(taskId);
          if (current.worktreePath) {
            this.database.updateTaskWorktree({
              id: taskId,
              status: "planning",
              branchName: current.branchName ?? "",
              worktreePath: current.worktreePath,
              baseBranch: current.baseBranch ?? null
            });
          } else {
            this.database.updateTaskStatus(taskId, "queued");
          }
          this.database.addEvent({
            source: request.surface,
            type: "chat.task_retried",
            text: `Task #${taskId} enviada novamente para execução via Chat Operacional.`,
            userId: request.userId ?? null,
            username: request.username ?? null,
            taskId
          });
          // The task is queued/planning; the autopilot picks it up. Starting
          // inline is only a fast-path — a preflight failure here must not
          // undo the retry (the queue remains authoritative).
          try {
            this.actionExecutor?.retryTask?.(taskId);
          } catch {
            /* queue state is enough; autopilot will start it */
          }
          resultSummary = current.worktreePath
            ? `Task #${taskId} reiniciada no worktree existente.`
            : `Task #${taskId} reiniciada e movida para a fila (queued).`;
          break;
        }

        case "cancel_task": {
          const taskId = Number(action.targetId);
          // Mark cancelled FIRST (chat intent is authoritative), then let the
          // coordinator abort any live execution. The coordinator throws when
          // the task is already terminal or has no active run in this process
          // (e.g. after an app restart) — both mean the cancel already
          // succeeded, so swallow those instead of scaring the user.
          this.database.updateTaskStatus(taskId, "cancelled");
          this.database.addEvent({
            source: request.surface,
            type: "chat.task_cancelled",
            text: `Task #${taskId} cancelada via Chat Operacional.`,
            userId: request.userId ?? null,
            username: request.username ?? null,
            taskId
          });
          try {
            this.actionExecutor?.cancelTask?.(taskId);
          } catch (cancelError) {
            const message = cancelError instanceof Error ? cancelError.message : "";
            const benign =
              message.includes("already in a terminal state") ||
              message.includes("environment_blocked");
            if (!benign) throw cancelError;
          }
          resultSummary = `Task #${taskId} cancelada com sucesso.`;
          break;
        }

        case "resume_goal": {
          const runId = Number(action.targetId);
          const run = this.database.getGoalRun(runId);
          this.actionExecutor?.resumeGoal?.(runId);
          resultSummary = `Goal #${runId} da Task #${run.taskId} retomado do checkpoint na fase ${run.currentPhase}.`;
          break;
        }

        case "resume_feature_plan": {
          const planId = Number(action.targetId);
          this.commands.resumeFeaturePlan(origin, planId);
          resultSummary = `Feature Plan #${planId} retomado na fila governada.`;
          break;
        }

        case "retry_feature_plan": {
          const planId = Number(action.targetId);
          this.commands.updateFeaturePlanQueueStatus(origin, planId, "queued", "Retentativa solicitada via Chat Operacional");
          resultSummary = `Feature Plan #${planId} enviado para retentativa (queued).`;
          break;
        }

        case "cancel_feature_plan": {
          const planId = Number(action.targetId);
          this.commands.cancelFeaturePlan(origin, planId, "Cancelado via Chat Operacional");
          resultSummary = `Feature Plan #${planId} cancelado.`;
          break;
        }

        case "rerun_review": {
          const taskId = Number(action.targetId);
          this.database.updateTaskStatus(taskId, "reviewing");
          this.actionExecutor?.rerunReview?.(taskId);
          resultSummary = `Revisao para Task #${taskId} reexecutada.`;
          break;
        }

        default:
          throw new Error(`Acao governada desconhecida: ${(action as { type?: string }).type}`);
      }
    } catch (error) {
      success = false;
      resultSummary = `Falha ao executar acao governada: ${error instanceof Error ? error.message : "Erro desconhecido."}`;
    }

    const actionText = `[Acao Executada] ${action.label}: ${resultSummary}`;
    this.database.saveOperationalChatMessage({
      threadId: thread.id,
      projectKey,
      surface: request.surface,
      senderRole: "system",
      messageText: actionText,
      actionTaken: JSON.stringify({ action, success, resultSummary })
    });

    const updatedEvidence = await this.gatherEvidenceContext(projectKey);

    return {
      success,
      actionTaken: action.label,
      resultSummary,
      updatedEvidence
    };
  }

  isHighImpactAction(action: GovernedChatAction): boolean {
    return HIGH_IMPACT_ACTIONS.has(action.type);
  }

  private resolveChatProject(projectKey: string): ProjectRecord {
    if (projectKey === GLOBAL_CHAT_PROJECT_KEY) return { ...GLOBAL_CHAT_PROJECT, path: this.worktreesRoot };
    const project = this.database.findProjectByKey(projectKey);
    if (!project) throw new Error(`Projeto @${projectKey} nao encontrado.`);
    return project;
  }

  private filterActionsByAccessMode(actions: GovernedChatAction[], accessMode: ChatAccessMode): GovernedChatAction[] {
    if (accessMode === "read_only") return [];
    if (accessMode === "full") return actions;
    return actions.filter((action) => !FULL_ACCESS_ONLY_ACTIONS.has(action.type));
  }

  async getHistory(projectKey: string, limit = 50, threadId?: number | null): Promise<OperationalChatMessageRecord[]> {
    const normalizedKey = normalizeChatProjectKey(projectKey);
    this.resolveChatProject(normalizedKey);
    const thread = this.resolveThread(normalizedKey, threadId);
    return this.database.listOperationalChatMessages(normalizedKey, limit, thread.id);
  }

  listThreads(projectKey: string) {
    const normalizedKey = normalizeChatProjectKey(projectKey);
    this.resolveChatProject(normalizedKey);
    return this.database.listOperationalChatThreads(normalizedKey);
  }

  createThread(projectKey: string, title?: string | null, accessMode?: ChatAccessMode | null) {
    const normalizedKey = normalizeChatProjectKey(projectKey);
    this.resolveChatProject(normalizedKey);
    return this.database.createOperationalChatThread({ projectKey: normalizedKey, title, accessMode });
  }

  deleteThread(projectKey: string, threadId: number): boolean {
    const normalizedKey = normalizeChatProjectKey(projectKey);
    this.resolveChatProject(normalizedKey);
    return this.database.deleteOperationalChatThread(normalizedKey, threadId);
  }

  async gatherEvidenceContext(projectKey: string): Promise<ChatEvidenceContext> {
    const normalizedKey = normalizeChatProjectKey(projectKey);
    const project = this.resolveChatProject(normalizedKey);

    const rawTasks = normalizedKey === GLOBAL_CHAT_PROJECT_KEY
      ? this.database.listTasks(50)
      : this.database.listTasksByProject(normalizedKey, 50);
    const tasks: ChatEvidenceTaskFact[] = rawTasks.map((t) => ({
      id: t.id,
      text: t.text,
      status: t.status,
      source: t.source,
      branchName: t.branchName,
      worktreePrepared: Boolean(t.worktreePath),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt
    }));

    const goals: ChatEvidenceGoalFact[] = [];
    const reviews: ChatEvidenceReviewFact[] = [];
    for (const task of rawTasks) {
      // The operational chat must be able to act on a terminal run, not only
      // on currently active or completed runs.  A blocked/failed Goal is the
      // exact state in which the user needs the "resume from checkpoint"
      // action.  The old lookup silently discarded those runs and left the
      // chat with only the less precise "restart task" action.
      const taskRuns = this.database.listGoalRunsForTask(task.id);
      const run = taskRuns[taskRuns.length - 1]
        ?? this.database.findLatestCompletedGoalRunForTask(task.id)
        ?? this.database.listActiveGoalRuns().find((r) => r.taskId === task.id);
      if (run) {
        const steps = this.database.listGoalSteps(run.id);
        const latestStep = steps.length > 0 ? steps[steps.length - 1] : null;
        goals.push({
          runId: run.id,
          taskId: run.taskId,
          phase: run.currentPhase,
          status: run.status,
          stepCount: run.stepCount,
          latestStepSummary: latestStep?.summary ?? null,
          error: run.lastError ?? null,
          updatedAt: run.updatedAt
        });
      }

      const taskReviews = this.database.listTaskReviews(task.id);
      for (const rev of taskReviews) {
        reviews.push({
          id: rev.id,
          taskId: rev.taskId,
          provider: rev.provider,
          status: rev.status,
          content: rev.content,
          error: rev.error,
          createdAt: rev.createdAt
        });
      }
    }

    const featurePlanRecords = normalizedKey === GLOBAL_CHAT_PROJECT_KEY
      ? this.database.listFeaturePlans(30)
      : this.database.listFeaturePlansByProject(normalizedKey, 30);
    const featurePlans: ChatEvidenceFeaturePlanFact[] = featurePlanRecords.map((planRecord) => {
      const details = this.database.getFeaturePlanDetails(planRecord.id);
      const plan = details.plan;
      let eligibility = null;
      try {
        eligibility = this.database.evaluateFeaturePlanEligibility(plan.id);
      } catch (_) {
        // ignore if evaluation fails for non-queued plans
      }

      return {
        id: plan.id,
        objective: plan.objective,
        status: plan.status,
        priority: plan.priority,
        revision: plan.revision,
        eligibility: eligibility ? {
          eligible: eligibility.eligible,
          reason: eligibility.reason,
          blockedByPaused: eligibility.blockedByPaused,
          blockedByStatus: eligibility.blockedByStatus,
          blockedDependencies: eligibility.blockedDependencies,
          blockedByActiveProjectPlan: eligibility.blockedByActiveProjectPlan
        } : null,
        cancelReason: plan.cancelReason,
        taskCount: details.tasks.length,
        createdAt: plan.createdAt
      };
    });

    const providers = this.agentRegistry ? await this.agentRegistry.snapshot() : [];
    const events = typeof this.database.listEvents === "function" ? this.database.listEvents(20) : [];
    const outbox: ChatEvidenceOutboxFact[] = events.map((e) => ({
      id: e.id,
      channel: e.source,
      status: "recorded",
      eventType: e.type,
      text: e.text,
      error: null,
      createdAt: e.createdAt
    }));

    const workGraphs: ChatEvidenceWorkGraphFact[] = [];
    if (typeof this.database.listWorkGraphs === "function") {
      try {
        const graphs = this.database.listWorkGraphs(30);
        for (const g of graphs) {
          const activeNodes = g.nodes.filter((n) => ["running", "pending"].includes(n.status)).length;
          const failedNodes = g.nodes.filter((n) => ["failed", "blocked"].includes(n.status)).length;
          workGraphs.push({
            id: g.id,
            runId: g.runId,
            status: g.status,
            phase: "execution",
            activeNodes,
            failedNodes
          });
        }
      } catch (_) {}
    }

    const summaryParts: string[] = [
      normalizedKey === GLOBAL_CHAT_PROJECT_KEY ? "Contexto: Maestro (geral)" : `Projeto: @${project.key} (${project.name})`,
      `Tasks (${tasks.length}): ${tasks.map((t) => `#${t.id} [${t.status}]`).join(", ") || "nenhuma"}`,
      `Feature Plans (${featurePlans.length}): ${featurePlans.map((fp) => `#${fp.id} [${fp.status}]`).join(", ") || "nenhum"}`,
      `Provedores: ${providers.map((p) => `${p.label}=${p.state}/${p.control.mode}`).join(", ") || "sem provedores"}`
    ];

    return {
      project,
      tasks,
      goals,
      featurePlans,
      reviews,
      providers,
      outbox,
      workGraphs,
      summaryText: summaryParts.join("\n")
    };
  }

  identifyGovernedActions(
    evidence: ChatEvidenceContext,
    taskIntent: TaskCreationIntent | null = null,
    userMessage?: string,
    accessMode: ChatAccessMode = "standard"
  ): GovernedChatAction[] {
    const actions: GovernedChatAction[] = [];

    if (taskIntent?.text) {
      const targetProjectKey = evidence.project.key === GLOBAL_CHAT_PROJECT_KEY
        ? this.database.getDefaultProject()?.key
        : evidence.project.key;
      if (targetProjectKey) {
        actions.push({
          id: "create_task",
          type: "create_task",
          label: "Criar Task",
          description: `Cria uma nova task em @${targetProjectKey} com o objetivo informado.`,
          targetId: targetProjectKey,
          payload: { text: taskIntent.text, projectKey: targetProjectKey }
        });
      }
    }

    // Do not turn every greeting or open-ended question into a command
    // palette just because the project happens to have a blocked task. The
    // actions remain available for explicit operational requests and for the
    // Telegram /chat_action command, which calls this method without text.
    if (userMessage && !taskIntent && !isOperationalChatMessage(userMessage)) {
      return this.filterActionsByAccessMode(actions, accessMode);
    }

    for (const provider of evidence.providers) {
      if (provider.control.mode === "paused" || provider.control.mode === "disabled") {
        actions.push({
          id: `unblock_provider_${provider.id}`,
          type: "unblock_provider",
          label: `Habilitar Provedor ${provider.label}`,
          description: `Altera o status do provedor ${provider.label} de '${provider.control.mode}' para 'enabled'.`,
          targetId: provider.id,
          payload: { providerId: provider.id }
        });
      }
    }

    for (const task of evidence.tasks) {
      // 'planning' included: a prepared-but-never-dispatched task sits there
      // with no goal run, and users must be able to cancel it from the chat.
      if (["planning", "queued", "blocked", "failed", "waiting_quota", "waiting_provider", "waiting_dependency"].includes(task.status)) {
        actions.push({
          id: `cancel_task_${task.id}`,
          type: "cancel_task",
          label: `Cancelar Task #${task.id}`,
          description: `Marca a Task #${task.id} ('${task.status}') como cancelada.`,
          targetId: task.id
        });
      }
      const hasResumableGoal = evidence.goals.some(
        (goal) => goal.taskId === task.id && ["blocked", "failed"].includes(goal.status)
      );
      if (["blocked", "failed", "waiting_quota", "waiting_provider", "waiting_dependency"].includes(task.status) && !hasResumableGoal) {
        actions.push({
          id: `retry_task_${task.id}`,
          type: "retry_task",
          label: `Reiniciar Task #${task.id}`,
          description: `Retorna a Task #${task.id} ('${task.status}') para a fila governada (queued).`,
          targetId: task.id
        });
      }
    }

    for (const goal of evidence.goals) {
      if (["blocked", "failed"].includes(goal.status)) {
        actions.push({
          id: `resume_goal_${goal.runId}`,
          type: "resume_goal",
          label: `Retomar Goal da Task #${goal.taskId}`,
          description: `Continua o Goal Run #${goal.runId} da Task #${goal.taskId} no checkpoint e na fase ${goal.phase}, sem iniciar outro planejamento.`,
          targetId: goal.runId,
          payload: { runId: goal.runId, taskId: goal.taskId }
        });
      }
    }

    for (const plan of evidence.featurePlans) {
      if (["blocked", "paused"].includes(plan.status) || (plan.eligibility && !plan.eligibility.eligible)) {
        actions.push({
          id: `resume_feature_plan_${plan.id}`,
          type: "resume_feature_plan",
          label: `Retomar Feature Plan #${plan.id}`,
          description: `Retoma a execucao do Feature Plan #${plan.id} na fila governada.`,
          targetId: plan.id
        });
        actions.push({
          id: `retry_feature_plan_${plan.id}`,
          type: "retry_feature_plan",
          label: `Tentar Novamente Feature Plan #${plan.id}`,
          description: `Reinicia o Feature Plan #${plan.id} para status 'queued'.`,
          targetId: plan.id
        });
        actions.push({
          id: `cancel_feature_plan_${plan.id}`,
          type: "cancel_feature_plan",
          label: `Cancelar Feature Plan #${plan.id}`,
          description: `Cancela o Feature Plan #${plan.id}.`,
          targetId: plan.id
        });
      }
    }

    for (const review of evidence.reviews) {
      if (["failed", "rejected", "changes_requested"].includes(review.status)) {
        actions.push({
          id: `rerun_review_${review.taskId}`,
          type: "rerun_review",
          label: `Refazer Revisao Task #${review.taskId}`,
          description: `Executa novamente a revisao para a Task #${review.taskId}.`,
          targetId: review.taskId
        });
      }
    }

    return this.filterActionsByAccessMode(actions, accessMode);
  }

  private async synthesizeExplanation(
    userMessage: string,
    evidence: ChatEvidenceContext,
    actions: GovernedChatAction[],
    history: OperationalChatMessageRecord[],
    accessMode: ChatAccessMode
  ): Promise<{ explanation: string; providerId: AgentProviderId | "deterministic_engine" }> {
    const taskIntent = parseTaskCreationIntent(userMessage);
    if (taskIntent) {
      return {
        explanation: `Entendi. Preparei a Task com este objetivo: "${truncateChatText(taskIntent.text)}". Use o botao "Criar Task" abaixo para colocar ela na fila.`,
        providerId: "deterministic_engine"
      };
    }

    if (this.agentRegistry?.acquire) {
      const excluded = new Set<AgentProviderId>();
      try {
        // Conversation must have the same provider resilience as a goal. If
        // Antigravity is enabled but cannot obtain a headless command
        // permission, the chat immediately tries the next provider instead of
        // leaving the input apparently frozen until the user restarts Maestro.
        while (true) {
          const lease = await this.agentRegistry.acquire("conversation", excluded);
          if (!lease) break;
          const providerId = lease.provider.id;
          const timeoutController = new AbortController();
          const timeoutId = setTimeout(() => timeoutController.abort(), CHAT_PROVIDER_TIMEOUT_MS);
          try {
              const promptEvidence = this.sanitizeEvidenceForPrompt(evidence);
              const systemPrompt = [
                "Voce e o assistente conversacional do usuario dentro do Octomynd Maestro.",
                "Converse como uma LLM normal: cumprimente, responda perguntas, explique ideias e mantenha o contexto do projeto.",
                `Modo de acesso atual: ${accessMode}. Ações disponíveis já foram filtradas pelo núcleo do Maestro.`,
                "Uma mensagem casual como 'oi' deve receber uma resposta casual e acolhedora — nunca um relatorio de tasks.",
                "Responda em português natural, direto e humano. Use no maximo ~8 linhas quando a pergunta for simples;",
                "nao force secoes, listas, status ou acoes quando isso nao foi pedido.",
                "Quando o usuario pedir explicitamente uma acao no Maestro, explique em uma frase o que sera feito e aguarde a confirmacao pelo botao; nunca execute sozinho.",
                "NUNCA invente estado de runtime que nao esteja presente nas evidencias fornecidas.",
                "NUNCA exponha caminhos locais de worktree, tokens, senhas ou chaves.",
                "",
                "EVIDENCIAS EMPIRICAS DE RUNTIME:",
                promptEvidence.summaryText,
                "",
                "DETALHES DAS TASKS:",
                JSON.stringify(promptEvidence.tasks, null, 2),
                "",
                "DETALHES DOS FEATURE PLANS:",
                JSON.stringify(promptEvidence.featurePlans, null, 2),
                "",
                "DETALHES DOS PROVEDORES:",
                JSON.stringify(promptEvidence.providers, null, 2),
                "",
                "ACOES GOVERNADAS DISPONIVEIS:",
                JSON.stringify(actions, null, 2)
              ].join("\n");

              const historyText = history
                .map((h) => `${h.senderRole.toUpperCase()}: ${h.messageText}`)
                .join("\n");

              const result = await lease.provider.execute({
                runId: 0,
                stepNumber: 1,
                phase: "planning",
                capability: "conversation",
                task: {
                  id: 0,
                  projectId: evidence.project.id,
                  projectKey: evidence.project.key,
                  projectName: evidence.project.name,
                  text: userMessage,
                  status: "queued",
                  source: "chat",
                  branchName: null,
                  worktreePath: null,
                  baseBranch: null,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString()
                },
                project: evidence.project,
                previousSteps: [],
                artifactsRoot: this.worktreesRoot,
                humanFeedback: `${systemPrompt}\n\nHISTORICO DE CONVERSA:\n${historyText}\n\nPERGUNTA DO USUARIO:\n${userMessage}`,
                signal: timeoutController.signal
              });
              if (result.outcome === "completed" && result.output.trim().length > 0) {
                lease.release();
                return {
                  explanation: result.output.trim(),
                  providerId
                };
              }
              excluded.add(providerId);
              lease.release();
          } catch (error) {
            const isTimeout = error instanceof Error && error.name === "AbortError";
            excluded.add(providerId);
            lease.release({
              retryable: false,
              summary: isTimeout ? "Timeout na chamada de conversacao." : "Falha na chamada de conversacao."
            });
          } finally {
            clearTimeout(timeoutId);
          }
        }
      } catch (_) {
        // Fall back cleanly to deterministic explanation engine
      }
    }

    return {
      explanation: this.generateDeterministicExplanation(userMessage, evidence, actions),
      providerId: "deterministic_engine"
    };
  }

  private generateDeterministicExplanation(
    userMessage: string,
    evidence: ChatEvidenceContext,
    actions: GovernedChatAction[]
  ): string {
    const normalized = userMessage.toLowerCase();
    const lines: string[] = [];

    const taskIntent = parseTaskCreationIntent(userMessage);
    if (taskIntent) {
      return `Entendi. Preparei a Task com este objetivo: "${truncateChatText(taskIntent.text)}". Use o botao "Criar Task" abaixo para colocar ela na fila.`;
    }

    if (/provider|conectad|saudav|saudável|offline/.test(normalized)) {
      const ready = evidence.providers.filter((p) => p.health.state === "ready");
      const down = evidence.providers.filter((p) => p.health.state !== "ready");
      lines.push(ready.length > 0
        ? `Providers ok: ${ready.map((p) => p.label).join(", ")}.`
        : "Nenhum provider conectado agora.");
      for (const prov of down) {
        lines.push(`- ${prov.label}: ${prov.health.detail}`);
      }
      if (down.length === 0) lines.push("Tudo saudável pra executar tasks.");
      return lines.join("\n");
    }

    if (/por que|parada|não começou|nao comecou|travou|pres/.test(normalized)) {
      const stuck = evidence.tasks.filter((t) =>
        ["planning", "queued", "blocked", "waiting_provider", "waiting_quota", "waiting_dependency", "failed"].includes(t.status)
      );
      if (stuck.length === 0) {
        lines.push("Nenhuma task parada — tudo em movimento ou concluído.");
        return lines.join("\n");
      }
      lines.push("Tasks paradas:");
      for (const task of stuck.slice(0, 5)) {
        const goal = evidence.goals.find((g) => g.taskId === task.id);
        let reason = task.status === "planning" && !goal
          ? "worktree preparada mas o goal nunca foi disparado — use Iniciar goal no detalhe da task"
          : `status ${task.status}`;
        if (goal?.error) reason += ` · erro: ${goal.error}`;
        lines.push(`- #${task.id}: ${reason}`);
      }
      if (actions.length > 0) {
        lines.push("");
        lines.push("Posso resolver isso pra você — use as ações sugeridas abaixo.");
      }
      return lines.join("\n");
    }

    if (/^(oi|ola|olá|hey|hello|bom dia|boa tarde|boa noite)\b/i.test(normalized)) {
      return "Oi! Como posso ajudar? Posso conversar sobre o projeto, explicar uma task, verificar os providers ou continuar uma execução.";
    }

    if (/\b(obrigad[oa]|valeu|thanks|perfeito)\b/i.test(normalized)) {
      return "Por nada! Quando quiser, me diga o que você quer entender ou fazer no projeto.";
    }

    if (/^(ajuda|help|o que voce pode|o que você pode|como voce pode|como você pode)\b/i.test(normalized)) {
      return "Posso conversar sobre o projeto, explicar logs e tasks, verificar providers e executar ações quando você pedir explicitamente. O que você quer fazer?";
    }

    if (/\b(status|resumo|andamento|situacao|situação)\b/i.test(normalized)) {
      const active = evidence.tasks.filter((t) => !["done", "failed", "cancelled", "rejected"].includes(t.status));
      return `@${evidence.project.key}: ${active.length} task(s) ativa(s), ${evidence.providers.filter((p) => p.health.state === "ready").length} provider(s) ok.`;
    }

    return "Entendi. Posso conversar com você sobre este projeto e ajudar a resolver o que precisar. Me conte um pouco mais.";
  }

  private resolveThread(projectKey: string, threadId?: number | null) {
    if (threadId !== undefined && threadId !== null) {
      const thread = this.database.getOperationalChatThread(Number(threadId));
      if (!thread || thread.projectKey !== projectKey) {
        throw new Error("A conversa selecionada nao pertence a este projeto.");
      }
      return thread;
    }
    return this.database.getOrCreateOperationalChatThread(projectKey);
  }

  private sanitizeEvidenceForPrompt(evidence: ChatEvidenceContext): ChatEvidenceContext {
    return {
      ...evidence,
      tasks: evidence.tasks.map((t) => ({
        ...t,
        branchName: t.branchName ? redactSensitiveText(t.branchName) : null
      })),
      providers: evidence.providers.map((p) => ({
        ...p,
        detail: redactSensitiveText(p.detail)
      }))
    };
  }

  private sanitizeEvidenceForStorage(evidence: ChatEvidenceContext): ChatEvidenceContext {
    return {
      ...evidence,
      providers: evidence.providers.map((p) => ({
        ...p,
        detail: redactSensitiveText(p.detail)
      }))
    };
  }
}

function normalizeChatProjectKey(value?: string | null): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || GLOBAL_CHAT_PROJECT_KEY;
}

function normalizeAccessMode(value?: ChatAccessMode | string | null): ChatAccessMode {
  return value === "read_only" || value === "full" ? value : "standard";
}

export type TaskCreationIntent = { text: string };

function isOperationalChatMessage(input: string): boolean {
  const normalized = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return /\b(task|goal|provider|claude|codex|antigravity|gemini|copilot|feature\s*plan|worktree|quota|cota|log|erro|falha|bloquead|parad|trav|iniciar|comec|comecar|retomar|continuar|reiniciar|cancelar|habilitar|ativar|pausar|status|andamento|revisao|revisao|pull\s*request|\bpr\b)\b/.test(normalized);
}

/**
 * Recognise explicit task-creation language without treating ordinary
 * questions about tasks as mutations. The old parser only accepted
 * "criar task: ..." and silently ignored "Crie essa task: ...".
 */
export function parseTaskCreationIntent(input: string): TaskCreationIntent | null {
  const text = input.trim();
  if (!text) return null;

  const explicit = /^(?:eu\s+)?(?:quero\s+)?(?:crie|criar|cadastrar|cadastre|abrir|abra|faca|faça)\b[\s\S]*?\btask\b/i.exec(text);
  if (explicit) {
    let taskText = text.slice(explicit[0].length).trim();
    const framingSeparator = taskText.indexOf(":");
    if (framingSeparator >= 0) taskText = taskText.slice(framingSeparator + 1).trim();
    taskText = taskText.replace(/^[,\-:]\s*/, "").replace(/^para\s+/i, "").trim();
    return taskText.length >= 4 ? { text: taskText } : null;
  }

  // A short form such as "Quero criar um projeto de finanças" is also an
  // explicit request when it is not phrased as a question.
  const projectRequest = /^(?:eu\s+)?quero\s+criar\s+(.{4,})$/i.exec(text);
  return projectRequest ? { text: projectRequest[1].trim() } : null;
}

function truncateChatText(value: string, max = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1).trim()}…`;
}
