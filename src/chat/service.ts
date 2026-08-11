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
  OperationalChatResponse
} from "./types.js";
import { MaestroDatabase } from "../db.js";
import { AgentRegistry } from "../agents/registry.js";
import { ApplicationCommands } from "../commands/application-commands.js";
import { AgentProviderId } from "../agents/types.js";
import { redactSensitiveText } from "../security/redaction.js";

const CHAT_PROVIDER_TIMEOUT_MS = 25_000;
const HIGH_IMPACT_ACTIONS = new Set<GovernedChatAction["type"]>([
  "cancel_task",
  "cancel_feature_plan",
  "resume_goal",
  "unblock_provider"
]);

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
    const projectKey = request.projectKey.trim().toLowerCase();
    const project = this.database.getProjectByKey(projectKey);
    if (!project) {
      throw new Error(`Projeto @${projectKey} nao encontrado.`);
    }

    const evidence = await this.gatherEvidenceContext(projectKey);
    const actions = this.identifyGovernedActions(evidence);

    this.database.saveOperationalChatMessage({
      projectKey,
      surface: request.surface,
      senderRole: "user",
      messageText: request.message
    });

    const conversationHistory = this.database.listOperationalChatMessages(projectKey, 10);
    const routingResult = await this.synthesizeExplanation(
      request.message,
      evidence,
      actions,
      conversationHistory
    );

    const explanation = redactSensitiveText(routingResult.explanation);

    const savedOrchestratorMessage = this.database.saveOperationalChatMessage({
      projectKey,
      surface: request.surface,
      senderRole: "orchestrator",
      messageText: explanation,
      evidenceJson: JSON.stringify(this.sanitizeEvidenceForStorage(evidence)),
      actionTaken: actions.length > 0 ? JSON.stringify(actions) : null
    });

    this.database.pruneOperationalChatMessages(projectKey, 100);

    return {
      messageId: savedOrchestratorMessage.id,
      projectKey,
      surface: request.surface,
      explanation,
      evidence,
      actions,
      providerId: routingResult.providerId,
      createdAt: savedOrchestratorMessage.createdAt
    };
  }

  async executeAction(request: OperationalChatActionRequest): Promise<OperationalChatActionResponse> {
    const projectKey = request.projectKey.trim().toLowerCase();
    const project = this.database.getProjectByKey(projectKey);
    if (!project) {
      throw new Error(`Projeto @${projectKey} nao encontrado.`);
    }

    const evidence = await this.gatherEvidenceContext(projectKey);
    const validActions = this.identifyGovernedActions(evidence);
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
          this.database.updateTaskStatus(taskId, "queued");
          this.database.addEvent({
            source: request.surface,
            type: "chat.task_retried",
            text: `Task #${taskId} enviada novamente para a fila via Chat Operacional.`,
            userId: request.userId ?? null,
            username: request.username ?? null,
            taskId
          });
          this.actionExecutor?.retryTask?.(taskId);
          resultSummary = `Task #${taskId} reiniciada e movida para a fila (queued).`;
          break;
        }

        case "cancel_task": {
          const taskId = Number(action.targetId);
          this.database.updateTaskStatus(taskId, "cancelled");
          this.database.addEvent({
            source: request.surface,
            type: "chat.task_cancelled",
            text: `Task #${taskId} cancelada via Chat Operacional.`,
            userId: request.userId ?? null,
            username: request.username ?? null,
            taskId
          });
          this.actionExecutor?.cancelTask?.(taskId);
          resultSummary = `Task #${taskId} cancelada com sucesso.`;
          break;
        }

        case "resume_goal": {
          const taskId = Number(action.targetId);
          this.database.updateTaskStatus(taskId, "queued");
          this.actionExecutor?.resumeGoal?.(taskId);
          resultSummary = `Goal da Task #${taskId} retomado e adicionado a fila.`;
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

  async getHistory(projectKey: string, limit = 50): Promise<OperationalChatMessageRecord[]> {
    const normalizedKey = projectKey.trim().toLowerCase();
    return this.database.listOperationalChatMessages(normalizedKey, limit);
  }

  async gatherEvidenceContext(projectKey: string): Promise<ChatEvidenceContext> {
    const project = this.database.getProjectByKey(projectKey);
    if (!project) {
      throw new Error(`Projeto @${projectKey} nao encontrado.`);
    }

    const rawTasks = this.database.listTasksByProject(projectKey, 50);
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
      const run = this.database.findLatestCompletedGoalRunForTask(task.id)
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

    const featurePlanRecords = this.database.listFeaturePlansByProject(projectKey, 30);
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
      `Projeto: @${project.key} (${project.name})`,
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

  identifyGovernedActions(evidence: ChatEvidenceContext): GovernedChatAction[] {
    const actions: GovernedChatAction[] = [];

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
      if (["blocked", "failed", "waiting_quota", "waiting_provider", "waiting_dependency"].includes(task.status)) {
        actions.push({
          id: `retry_task_${task.id}`,
          type: "retry_task",
          label: `Reiniciar Task #${task.id}`,
          description: `Retorna a Task #${task.id} ('${task.status}') para a fila governada (queued).`,
          targetId: task.id
        });
        actions.push({
          id: `cancel_task_${task.id}`,
          type: "cancel_task",
          label: `Cancelar Task #${task.id}`,
          description: `Marca a Task #${task.id} como cancelada.`,
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
          description: `Reabre o Goal Run #${goal.runId} da Task #${goal.taskId} para nova tentativa.`,
          targetId: goal.taskId,
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

    return actions;
  }

  private async synthesizeExplanation(
    userMessage: string,
    evidence: ChatEvidenceContext,
    actions: GovernedChatAction[],
    history: OperationalChatMessageRecord[]
  ): Promise<{ explanation: string; providerId: AgentProviderId | "deterministic_engine" }> {
    if (this.agentRegistry?.route && this.agentRegistry.acquire) {
      try {
        const routed = await this.agentRegistry.route("conversation");
        if (routed && routed.health.state === "ready") {
          const lease = await this.agentRegistry.acquire("conversation");
          if (lease) {
            const timeoutController = new AbortController();
            const timeoutId = setTimeout(() => timeoutController.abort(), CHAT_PROVIDER_TIMEOUT_MS);
            try {
              const promptEvidence = this.sanitizeEvidenceForPrompt(evidence);
              const systemPrompt = [
                "Voce e o assistente de conversacao operacional do Octomynd Maestro.",
                "Sua funcao e explicar de forma clara, concisa, precisa e fundamentada exclusivamente em evidencias o estado do projeto, tasks, goals, feature plans, revisoes e provedores.",
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

              lease.release();
              if (result.outcome === "completed" && result.output.trim().length > 0) {
                return {
                  explanation: result.output.trim(),
                  providerId: lease.provider.id
                };
              }
            } catch (error) {
              const isTimeout = error instanceof Error && error.name === "AbortError";
              lease.release({
                retryable: !isTimeout,
                summary: isTimeout ? "Timeout na chamada de conversacao." : "Falha na chamada de conversacao."
              });
            } finally {
              clearTimeout(timeoutId);
            }
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
    const lines: string[] = [];
    lines.push(`Diagnostico do Maestro para o projeto @${evidence.project.key}:`);
    lines.push("");

    const blockedTasks = evidence.tasks.filter((t) =>
      ["blocked", "failed", "waiting_quota", "waiting_provider", "waiting_dependency"].includes(t.status)
    );
    const blockedPlans = evidence.featurePlans.filter((fp) =>
      ["blocked", "paused"].includes(fp.status) || (fp.eligibility && !fp.eligibility.eligible)
    );
    const pausedProviders = evidence.providers.filter((p) =>
      p.control.mode === "paused" || p.control.mode === "disabled" || p.state === "cooldown" || p.state === "quota"
    );

    if (blockedTasks.length === 0 && blockedPlans.length === 0 && pausedProviders.length === 0) {
      lines.push("O sistema esta operando normalmente sem bloqueios ativos ou tarefas com falha.");
      lines.push(`- Tasks totais: ${evidence.tasks.length}`);
      lines.push(`- Feature Plans: ${evidence.featurePlans.length}`);
      lines.push(`- Provedores ativos: ${evidence.providers.map((p) => `${p.label} (${p.state})`).join(", ") || "nenhum"}`);
    } else {
      if (pausedProviders.length > 0) {
        lines.push("Provedores Limitados ou Pausados:");
        for (const prov of pausedProviders) {
          lines.push(`- Provedor '${prov.label}' id=${prov.id}: estado=${prov.state}, controle=${prov.control.mode}. Detalhes: ${prov.detail}`);
        }
        lines.push("");
      }

      if (blockedTasks.length > 0) {
        lines.push("Tasks Bloqueadas ou com Falha:");
        for (const task of blockedTasks) {
          const goal = evidence.goals.find((g) => g.taskId === task.id);
          lines.push(`- Task #${task.id}: "${task.text}" [Status: ${task.status}]`);
          if (goal?.error) {
            lines.push(`  Erro no Goal Run #${goal.runId}: ${goal.error}`);
          }
          if (goal?.latestStepSummary) {
            lines.push(`  Ultima etapa: ${goal.latestStepSummary}`);
          }
        }
        lines.push("");
      }

      if (blockedPlans.length > 0) {
        lines.push("Feature Plans Bloqueados:");
        for (const plan of blockedPlans) {
          lines.push(`- Feature Plan #${plan.id}: "${plan.objective}" [Status: ${plan.status}]`);
          if (plan.eligibility?.reason) {
            lines.push(`  Motivo do bloqueio: ${plan.eligibility.reason}`);
          }
          if (plan.cancelReason) {
            lines.push(`  Motivo do cancelamento/pausa: ${plan.cancelReason}`);
          }
        }
        lines.push("");
      }
    }

    if (actions.length > 0) {
      lines.push("Proximas acoes governadas recomendadas:");
      for (const act of actions) {
        lines.push(`- [Acao #${act.id}]: ${act.label} -> ${act.description}`);
      }
    } else {
      lines.push("Nenhuma acao governada necessaria no momento.");
    }

    return lines.join("\n");
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
