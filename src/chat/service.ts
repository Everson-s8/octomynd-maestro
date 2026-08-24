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
  ChatLocale,
  GLOBAL_CHAT_PROJECT_KEY
} from "./types.js";
import { MaestroDatabase, ProjectRecord } from "../db.js";
import { AgentRegistry } from "../agents/registry.js";
import { ApplicationCommands } from "../commands/application-commands.js";
import { AgentProviderId } from "../agents/types.js";
import { redactSensitiveText } from "../security/redaction.js";
import { ProjectRepositoryService, RepositorySyncError } from "../projects/repository-service.js";

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
  name: "Maestro (general)",
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
  repositoryService?: ProjectRepositoryService;
};

export class OperationalChatService {
  private readonly database: MaestroDatabase;
  private readonly agentRegistry?: OperationalChatAgentRegistry;
  private readonly commands: ApplicationCommands;
  private readonly worktreesRoot: string;
  private readonly actionExecutor?: ChatActionExecutor;
  private readonly repositoryService: ProjectRepositoryService;

  constructor(options: OperationalChatServiceOptions) {
    this.database = options.database;
    this.agentRegistry = options.agentRegistry;
    this.commands = options.commands ?? new ApplicationCommands(options.database);
    this.worktreesRoot = options.worktreesRoot ?? process.cwd();
    this.actionExecutor = options.actionExecutor;
    this.repositoryService = options.repositoryService ?? new ProjectRepositoryService(options.database);
  }

  async ask(request: OperationalChatRequest): Promise<OperationalChatResponse> {
    const projectKey = normalizeChatProjectKey(request.projectKey);
    const project = this.resolveChatProject(projectKey);
    const thread = this.resolveThread(projectKey, request.threadId);
    const accessMode = normalizeAccessMode(request.accessMode ?? thread.accessMode);
    const locale = normalizeChatLocale(request.locale);
    if (thread.accessMode !== accessMode) this.database.updateOperationalChatThreadAccessMode(thread.id, accessMode);

    const evidence = await this.gatherEvidenceContext(projectKey);
    const taskIntent = parseTaskCreationIntent(request.message);
    const actions = this.identifyGovernedActions(evidence, taskIntent, request.message, accessMode, locale);

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
      accessMode,
      locale
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
    const locale = normalizeChatLocale(request.locale);
    if (thread.accessMode !== accessMode) this.database.updateOperationalChatThreadAccessMode(thread.id, accessMode);

    if (accessMode === "read_only") {
      throw new Error(locale === "pt-BR" ? "O chat está em modo somente leitura. Troque para Standard ou Full Access para executar ações." : "Chat is read-only. Switch to Standard or Full Access to execute actions.");
    }

    const evidence = await this.gatherEvidenceContext(projectKey);
    const taskIntent = request.action.type === "create_task"
      ? parseTaskCreationIntent(String(request.action.payload?.text ?? "")) ?? {
        text: String(request.action.payload?.text ?? "").trim()
      }
      : null;
    const validActions = this.identifyGovernedActions(evidence, taskIntent?.text ? taskIntent : null, undefined, accessMode, locale);
    const action = validActions.find((a) => a.id === request.action.id && a.type === request.action.type);

    if (!action) {
      return {
        success: false,
        actionTaken: request.action.label,
        resultSummary: locale === "pt-BR"
          ? `A ação '${request.action.id}' não é mais aplicável ao estado atual do projeto.`
          : `Action '${request.action.id}' is no longer applicable to the current project state.`
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
          if (text.length < 4) throw new Error(chatText(locale, "The task text is empty or too short.", "O texto da task está vazio ou muito curto."));
          const targetProjectKey = typeof action.payload?.projectKey === "string"
            ? action.payload.projectKey
            : projectKey === GLOBAL_CHAT_PROJECT_KEY ? this.database.getDefaultProject()?.key : projectKey;
          if (!targetProjectKey) throw new Error(chatText(locale, "No project is registered to receive the task.", "Nenhum projeto está cadastrado para receber a task."));
          const task = this.commands.createTask(origin, { text, projectKey: targetProjectKey });
          await this.actionExecutor?.taskCreated?.(task.id);
          resultSummary = chatText(locale, `Task #${task.id} created for @${targetProjectKey} and added to the queue.`, `Task #${task.id} criada para @${targetProjectKey} e enviada para a fila.`);
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
            resultSummary = chatText(locale, `Provider ${providerId} enabled in the Provider Control Plane.`, `Provedor ${providerId} reabilitado no Provider Control Plane.`);
          } else {
            resultSummary = chatText(locale, `Unable to update provider ${providerId}: AgentRegistry is unavailable.`, `Não foi possível atualizar o provedor ${providerId}: AgentRegistry indisponível.`);
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
            text: chatText(locale, `Task #${taskId} sent for execution again through Operational Chat.`, `Task #${taskId} enviada novamente para execução via Chat Operacional.`),
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
            ? chatText(locale, `Task #${taskId} restarted in the existing worktree.`, `Task #${taskId} reiniciada no worktree existente.`)
            : chatText(locale, `Task #${taskId} restarted and moved to the queue (queued).`, `Task #${taskId} reiniciada e movida para a fila (queued).`);
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
            text: chatText(locale, `Task #${taskId} cancelled through Operational Chat.`, `Task #${taskId} cancelada via Chat Operacional.`),
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
          resultSummary = chatText(locale, `Task #${taskId} cancelled successfully.`, `Task #${taskId} cancelada com sucesso.`);
          break;
        }

        case "resume_goal": {
          const runId = Number(action.targetId);
          const run = this.database.getGoalRun(runId);
          this.actionExecutor?.resumeGoal?.(runId);
          resultSummary = chatText(locale, `Goal #${runId} for Task #${run.taskId} resumed from the checkpoint in phase ${run.currentPhase}.`, `Goal #${runId} da Task #${run.taskId} retomado do checkpoint na fase ${run.currentPhase}.`);
          break;
        }

        case "resume_feature_plan": {
          const planId = Number(action.targetId);
          this.commands.resumeFeaturePlan(origin, planId);
          resultSummary = chatText(locale, `Feature Plan #${planId} resumed in the governed queue.`, `Feature Plan #${planId} retomado na fila governada.`);
          break;
        }

        case "retry_feature_plan": {
          const planId = Number(action.targetId);
          this.commands.updateFeaturePlanQueueStatus(origin, planId, "queued", "Retentativa solicitada via Chat Operacional");
          resultSummary = chatText(locale, `Feature Plan #${planId} sent for retry (queued).`, `Feature Plan #${planId} enviado para retentativa (queued).`);
          break;
        }

        case "cancel_feature_plan": {
          const planId = Number(action.targetId);
          this.commands.cancelFeaturePlan(origin, planId, "Cancelado via Chat Operacional");
          resultSummary = chatText(locale, `Feature Plan #${planId} cancelled.`, `Feature Plan #${planId} cancelado.`);
          break;
        }

        case "rerun_review": {
          const taskId = Number(action.targetId);
          this.database.updateTaskStatus(taskId, "reviewing");
          this.actionExecutor?.rerunReview?.(taskId);
          resultSummary = chatText(locale, `Review for Task #${taskId} rerun.`, `Revisão para Task #${taskId} reexecutada.`);
          break;
        }

        default:
          throw new Error(chatText(locale, `Unknown governed action: ${(action as { type?: string }).type}`, `Ação governada desconhecida: ${(action as { type?: string }).type}`));
      }
    } catch (error) {
      success = false;
      resultSummary = chatText(locale, `Governed action failed: ${error instanceof Error ? error.message : "Unknown error."}`, `Falha ao executar ação governada: ${error instanceof Error ? error.message : "Erro desconhecido."}`);
    }

    const actionText = `[${chatText(locale, "Action executed", "Ação executada")}] ${action.label}: ${resultSummary}`;
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
    if (!project) throw new Error(`Project @${projectKey} was not found.`);
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
    let project = this.resolveChatProject(normalizedKey);
    let repositoryState = null;
    if (normalizedKey !== GLOBAL_CHAT_PROJECT_KEY) {
      try {
        repositoryState = this.repositoryService.synchronize(project);
      } catch (error) {
        repositoryState = error instanceof RepositorySyncError
          ? error.state
          : this.repositoryService.inspect(project, false);
      }
      project = this.database.getProjectByKey(project.key);
    }

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
      ...(repositoryState ? [`Repositorio: ${repositoryState.syncState}${repositoryState.detail ? ` — ${repositoryState.detail}` : ""}`] : []),
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
      repositoryState,
      summaryText: summaryParts.join("\n")
    };
  }

  identifyGovernedActions(
    evidence: ChatEvidenceContext,
    taskIntent: TaskCreationIntent | null = null,
    userMessage?: string,
    accessMode: ChatAccessMode = "standard",
    locale: ChatLocale = "en"
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
          label: chatText(locale, "Create task", "Criar task"),
          description: chatText(locale, `Create a new task in @${targetProjectKey} with the requested objective.`, `Cria uma nova task em @${targetProjectKey} com o objetivo informado.`),
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
          label: chatText(locale, `Enable provider ${provider.label}`, `Habilitar provedor ${provider.label}`),
          description: chatText(locale, `Changes provider ${provider.label} from '${provider.control.mode}' to 'enabled'.`, `Altera o status do provedor ${provider.label} de '${provider.control.mode}' para 'enabled'.`),
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
          label: chatText(locale, `Cancel Task #${task.id}`, `Cancelar task #${task.id}`),
          description: chatText(locale, `Marks Task #${task.id} ('${task.status}') as cancelled.`, `Marca a Task #${task.id} ('${task.status}') como cancelada.`),
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
          label: chatText(locale, `Restart Task #${task.id}`, `Reiniciar task #${task.id}`),
          description: chatText(locale, `Returns Task #${task.id} ('${task.status}') to the governed queue (queued).`, `Retorna a Task #${task.id} ('${task.status}') para a fila governada (queued).`),
          targetId: task.id
        });
      }
    }

    for (const goal of evidence.goals) {
      if (["blocked", "failed"].includes(goal.status)) {
        actions.push({
          id: `resume_goal_${goal.runId}`,
          type: "resume_goal",
          label: chatText(locale, `Resume goal for Task #${goal.taskId}`, `Retomar goal da task #${goal.taskId}`),
          description: chatText(locale, `Continues Goal Run #${goal.runId} for Task #${goal.taskId} from the checkpoint in phase ${goal.phase}, without starting a new plan.`, `Continua o Goal Run #${goal.runId} da Task #${goal.taskId} no checkpoint e na fase ${goal.phase}, sem iniciar outro planejamento.`),
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
          label: chatText(locale, `Resume Feature Plan #${plan.id}`, `Retomar Feature Plan #${plan.id}`),
          description: chatText(locale, `Resumes Feature Plan #${plan.id} in the governed queue.`, `Retoma a execução do Feature Plan #${plan.id} na fila governada.`),
          targetId: plan.id
        });
        actions.push({
          id: `retry_feature_plan_${plan.id}`,
          type: "retry_feature_plan",
          label: chatText(locale, `Retry Feature Plan #${plan.id}`, `Tentar novamente Feature Plan #${plan.id}`),
          description: chatText(locale, `Restarts Feature Plan #${plan.id} with status 'queued'.`, `Reinicia o Feature Plan #${plan.id} para status 'queued'.`),
          targetId: plan.id
        });
        actions.push({
          id: `cancel_feature_plan_${plan.id}`,
          type: "cancel_feature_plan",
          label: chatText(locale, `Cancel Feature Plan #${plan.id}`, `Cancelar Feature Plan #${plan.id}`),
          description: chatText(locale, `Cancels Feature Plan #${plan.id}.`, `Cancela o Feature Plan #${plan.id}.`),
          targetId: plan.id
        });
      }
    }

    for (const review of evidence.reviews) {
      if (["failed", "rejected", "changes_requested"].includes(review.status)) {
        actions.push({
          id: `rerun_review_${review.taskId}`,
          type: "rerun_review",
          label: chatText(locale, `Rerun review for Task #${review.taskId}`, `Refazer revisão da task #${review.taskId}`),
          description: chatText(locale, `Runs the review again for Task #${review.taskId}.`, `Executa novamente a revisão para a Task #${review.taskId}.`),
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
    accessMode: ChatAccessMode,
    locale: ChatLocale
  ): Promise<{ explanation: string; providerId: AgentProviderId | "deterministic_engine" }> {
    const taskIntent = parseTaskCreationIntent(userMessage);
    if (taskIntent) {
      return {
        explanation: locale === "pt-BR"
          ? `Entendi. Preparei a Task com este objetivo: "${truncateChatText(taskIntent.text)}". Use o botão "Criar Task" abaixo para colocá-la na fila.`
          : `I understood. I prepared a task with this objective: "${truncateChatText(taskIntent.text)}". Use the "Create task" button below to add it to the queue.`,
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
                "You are the user's conversational assistant inside Octomynd Maestro.",
                "Talk like a normal LLM: greet the user, answer questions, explain ideas, and keep project context.",
                `Current access mode: ${accessMode}. Available actions were filtered by Maestro's core.`,
                "A casual message such as 'hi' should receive a casual, helpful reply — never a task report.",
                `Reply in ${locale === "pt-BR" ? "natural Brazilian Portuguese" : "natural English"}, directly and humanely. Keep simple answers to roughly eight lines;`,
                "do not force sections, lists, status, or actions when they were not requested.",
                "When the user explicitly asks Maestro to perform an action, explain in one sentence what will happen and wait for the confirmation button; never execute it alone.",
                "NEVER invent runtime state that is not present in the supplied evidence.",
                "NEVER expose local worktree paths, tokens, passwords, or keys.",
                "",
                "EMPIRICAL RUNTIME EVIDENCE:",
                promptEvidence.summaryText,
                "",
                "TASK DETAILS:",
                JSON.stringify(promptEvidence.tasks, null, 2),
                "",
                "FEATURE PLAN DETAILS:",
                JSON.stringify(promptEvidence.featurePlans, null, 2),
                "",
                "PROVIDER DETAILS:",
                JSON.stringify(promptEvidence.providers, null, 2),
                "",
                "AVAILABLE GOVERNED ACTIONS:",
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
                humanFeedback: `${systemPrompt}\n\nCONVERSATION HISTORY:\n${historyText}\n\nUSER QUESTION:\n${userMessage}`,
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
      explanation: this.generateDeterministicExplanation(userMessage, evidence, actions, locale),
      providerId: "deterministic_engine"
    };
  }

  private generateDeterministicExplanation(
    userMessage: string,
    evidence: ChatEvidenceContext,
    actions: GovernedChatAction[],
    locale: ChatLocale
  ): string {
    const normalized = userMessage.toLowerCase();
    const lines: string[] = [];

    const taskIntent = parseTaskCreationIntent(userMessage);
    if (taskIntent) {
      return locale === "pt-BR"
        ? `Entendi. Preparei a Task com este objetivo: "${truncateChatText(taskIntent.text)}". Use o botão "Criar Task" abaixo para colocá-la na fila.`
        : `I understood. I prepared a task with this objective: "${truncateChatText(taskIntent.text)}". Use the "Create task" button below to add it to the queue.`;
    }

    if (/provider|conectad|saudav|saudável|offline/.test(normalized)) {
      const ready = evidence.providers.filter((p) => p.health.state === "ready");
      const down = evidence.providers.filter((p) => p.health.state !== "ready");
      lines.push(ready.length > 0
        ? locale === "pt-BR" ? `Providers ok: ${ready.map((p) => p.label).join(", ")}.` : `Ready providers: ${ready.map((p) => p.label).join(", ")}.`
        : locale === "pt-BR" ? "Nenhum provider conectado agora." : "No provider is connected right now.");
      for (const prov of down) {
        lines.push(`- ${prov.label}: ${prov.health.detail}`);
      }
      if (down.length === 0) lines.push(locale === "pt-BR" ? "Tudo saudável para executar tasks." : "Everything is healthy for task execution.");
      return lines.join("\n");
    }

    if (/por que|parada|não começou|nao comecou|travou|pres/.test(normalized)) {
      const stuck = evidence.tasks.filter((t) =>
        ["planning", "queued", "blocked", "waiting_provider", "waiting_quota", "waiting_dependency", "failed"].includes(t.status)
      );
      if (stuck.length === 0) {
        lines.push(locale === "pt-BR" ? "Nenhuma task parada — tudo em movimento ou concluído." : "No stalled tasks — everything is moving or completed.");
        return lines.join("\n");
      }
      lines.push(locale === "pt-BR" ? "Tasks paradas:" : "Stalled tasks:");
      for (const task of stuck.slice(0, 5)) {
        const goal = evidence.goals.find((g) => g.taskId === task.id);
        let reason = task.status === "planning" && !goal
          ? locale === "pt-BR" ? "worktree preparada mas o goal nunca foi disparado — use Iniciar goal no detalhe da task" : "worktree prepared but the goal was never started — use Start goal in the task details"
          : `status ${task.status}`;
        if (goal?.error) reason += locale === "pt-BR" ? ` · erro: ${goal.error}` : ` · error: ${goal.error}`;
        lines.push(`- #${task.id}: ${reason}`);
      }
      if (actions.length > 0) {
        lines.push("");
        lines.push(locale === "pt-BR" ? "Posso resolver isso para você — use as ações sugeridas abaixo." : "I can help resolve this — use the suggested actions below.");
      }
      return lines.join("\n");
    }

    if (/^(oi|ola|olá|hey|hello|bom dia|boa tarde|boa noite)\b/i.test(normalized)) {
      return locale === "pt-BR"
        ? "Oi! Como posso ajudar? Posso conversar sobre o projeto, explicar uma task, verificar os providers ou continuar uma execução."
        : "Hi! How can I help? I can talk about the project, explain a task, check providers, or continue an execution.";
    }

    if (/\b(obrigad[oa]|valeu|thanks|perfeito)\b/i.test(normalized)) {
      return locale === "pt-BR" ? "Por nada! Quando quiser, me diga o que você quer entender ou fazer no projeto." : "You're welcome! Tell me what you want to understand or do in the project.";
    }

    if (/^(ajuda|help|o que voce pode|o que você pode|como voce pode|como você pode)\b/i.test(normalized)) {
      return locale === "pt-BR" ? "Posso conversar sobre o projeto, explicar logs e tasks, verificar providers e executar ações quando você pedir explicitamente. O que você quer fazer?" : "I can discuss the project, explain logs and tasks, check providers, and run actions when you explicitly ask. What would you like to do?";
    }

    if (/\b(status|resumo|andamento|situacao|situação)\b/i.test(normalized)) {
      const active = evidence.tasks.filter((t) => !["done", "failed", "cancelled", "rejected"].includes(t.status));
      return locale === "pt-BR"
        ? `@${evidence.project.key}: ${active.length} task(s) ativa(s), ${evidence.providers.filter((p) => p.health.state === "ready").length} provider(s) ok.`
        : `@${evidence.project.key}: ${active.length} active task(s), ${evidence.providers.filter((p) => p.health.state === "ready").length} ready provider(s).`;
    }

    return locale === "pt-BR" ? "Entendi. Posso conversar com você sobre este projeto e ajudar a resolver o que precisar. Me conte um pouco mais." : "I understand. I can talk through this project and help solve what you need. Tell me a little more.";
  }

  private resolveThread(projectKey: string, threadId?: number | null) {
    if (threadId !== undefined && threadId !== null) {
      const thread = this.database.getOperationalChatThread(Number(threadId));
      if (!thread || thread.projectKey !== projectKey) {
        throw new Error("The selected conversation does not belong to this project.");
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

function normalizeChatLocale(value?: ChatLocale | string | null): ChatLocale {
  return value === "pt-BR" ? "pt-BR" : "en";
}

function chatText(locale: ChatLocale, english: string, portuguese: string): string {
  return locale === "pt-BR" ? portuguese : english;
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
