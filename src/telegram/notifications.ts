import { MaestroConfig } from "../config.js";
import { GoalRunRecord, ImprovementProposalRecord, MaestroDatabase, TaskRecord } from "../db.js";
import type { ReviewDecisionNotifier, ReviewSyncNotifier } from "../reviews/coordinator.js";
import type { AgentProviderId } from "../agents/types.js";
import { redactSensitiveText } from "../security/redaction.js";
import type {
  FeatureBlockedEvent,
  FeatureBlockedNotificationHandler,
  FeatureBlockedReason,
  FeatureCompletion,
  FeatureNotificationHandler
} from "../features/coordinator.js";
import type { FeatureAssemblyEvent, FeatureAssemblyNotificationHandler } from "../features/assembly.js";
import type { SelfUpdateNotificationEvent } from "../runtime/self-update.js";
import type { SkillCuratorNotificationHandler } from "../skills/curator.js";

import { buildGoalObservability } from "../goals/observability.js";

export type GoalNotificationHandler = (run: GoalRunRecord) => Promise<void>;
export type GoalProgressNotificationHandler = (run: GoalRunRecord, providerId: AgentProviderId) => Promise<void>;
export type TelegramMessageSender = (chatId: string, text: string) => Promise<unknown>;

export function createTelegramTaskBlockedNotifier(
  config: MaestroConfig,
  database: MaestroDatabase,
  sendMessage: TelegramMessageSender
): ((task: TaskRecord, reason: string, details: string[]) => Promise<void>) | undefined {
  const chatId = config.telegram.allowedUserId;
  if (!chatId) return undefined;

  return async (task, reason, details) => {
    const explanation = details.length > 0 ? details.join("\n") : reason;
    await sendMessage(chatId, [
      `Task #${task.id} bloqueada.`,
      `Projeto: ${task.projectKey ? `@${task.projectKey}` : "sem projeto"}`,
      `Motivo: ${reason}`,
      `Detalhe: ${redactSensitiveText(explanation)}`,
      "Acao: corrija a causa e tente novamente."
    ].join("\n"));
    database.addEvent({
      source: "telegram",
      type: "backlog.blocked_notification_sent",
      text: `Blocked notification sent for task #${task.id}.`,
      taskId: task.id,
      metadata: { reason, projectKey: task.projectKey }
    });
  };
}

export function createTelegramImprovementCandidateNotifier(
  config: MaestroConfig,
  database: MaestroDatabase,
  sendMessage: TelegramMessageSender
): ((proposal: ImprovementProposalRecord) => Promise<void>) | undefined {
  const chatId = config.telegram.allowedUserId;
  if (!chatId) return undefined;
  return async (proposal) => {
    await sendMessage(chatId, truncate([
      `Nova melhoria candidata #${proposal.id}: ${proposal.title}`,
      `Projeto: @${proposal.projectKey ?? "nao definido"}`,
      `Risco: ${proposal.risk}`,
      `Confianca: ${proposal.confidence === null ? "nao informada" : `${Math.round(proposal.confidence * 100)}%`}`,
      `Motivo: ${redactSensitiveText(proposal.rationale)}`,
      "",
      `Aprovar: /improve_approve ${proposal.id}`,
      `Rejeitar: /improve_reject ${proposal.id}`,
      "A aprovacao cria uma nova Task e Feature Plan; nao altera o sistema diretamente."
    ].join("\n"), 4_000));
    database.addEvent({
      source: "telegram",
      type: "improvement.candidate_notification_sent",
      text: `Improvement candidate #${proposal.id} notification sent.`,
      metadata: { improvementId: proposal.id, projectKey: proposal.projectKey, risk: proposal.risk }
    });
  };
}

export function createTelegramSkillCuratorCandidateNotifier(
  config: MaestroConfig,
  database: MaestroDatabase,
  sendMessage: TelegramMessageSender
): SkillCuratorNotificationHandler | undefined {
  const chatId = config.telegram.allowedUserId;
  if (!chatId) return undefined;
  return async (eventType, candidate, detail) => {
    const actionLabels: Record<string, string> = {
      candidate_created: "💡 Nova proposta de self-correction",
      candidate_evaluated: "🧪 Candidato avaliado",
      candidate_promoted: "🚀 Candidato ativado (Low-risk)",
      candidate_rejected: "❌ Candidato rejeitado",
      candidate_rolled_back: "⏪ Skill revertida por regressao"
    };

    const text = truncate([
      `${actionLabels[eventType] ?? eventType}: Candidate #${candidate.id}`,
      `Skill: ${candidate.qualifiedName}`,
      `Risk: ${candidate.risk} | Owner: ${candidate.owner} | Status: ${candidate.status}`,
      `Rationale: ${redactSensitiveText(candidate.rationale)}`,
      detail ? `Detail: ${redactSensitiveText(detail)}` : null
    ].filter(Boolean).join("\n"), 4_000);

    await sendMessage(chatId, text);
    database.addEvent({
      source: "telegram",
      type: "skill.curator_notification_sent",
      text: `Skill curator ${eventType} notification sent for candidate #${candidate.id}.`,
      metadata: { candidateId: candidate.id, eventType, status: candidate.status }
    });
  };
}

export function createTelegramGoalNotifier(
  config: MaestroConfig,
  database: MaestroDatabase,
  sendMessage: TelegramMessageSender
): GoalNotificationHandler | undefined {
  const chatId = config.telegram.allowedUserId;
  if (!chatId) return undefined;

  return async (run) => {
    const task = database.getTask(run.taskId);
    const text = formatGoalNotification(run, task, database);
    await sendMessage(chatId, text);
    database.addEvent({
      source: "telegram",
      type: "goal.notification_sent",
      text: `Goal #${run.id} notification sent.`,
      taskId: task.id,
      metadata: {
        runId: run.id,
        status: run.status,
        hasPullRequest: Boolean(run.pullRequestUrl)
      }
    });
  };
}

export function createTelegramGoalProgressNotifier(
  config: MaestroConfig,
  database: MaestroDatabase,
  sendMessage: TelegramMessageSender
): GoalProgressNotificationHandler | undefined {
  const chatId = config.telegram.allowedUserId;
  if (!chatId) return undefined;

  return async (run, providerId) => {
    const task = database.getTask(run.taskId);
    const text = [
      `Task #${task.id} em andamento.`,
      `Projeto: ${task.projectKey ? `@${task.projectKey}` : "sem projeto"}`,
      `Agente: ${providerId}`,
      `Fase: ${run.currentPhase}`,
      `Progresso: ${run.stepCount}/${run.maxSteps}`
    ].join("\n");
    await sendMessage(chatId, text);
    database.addEvent({
      source: "telegram",
      type: "goal.progress_notification_sent",
      text: `Progress notification sent for goal #${run.id}.`,
      taskId: task.id,
      metadata: { runId: run.id, phase: run.currentPhase, providerId }
    });
  };
}

export function formatGoalNotification(run: GoalRunRecord, task: TaskRecord, database?: MaestroDatabase): string {
  const project = task.projectKey ? `@${task.projectKey}` : "sem projeto";

  if (run.status === "completed" && run.pullRequestUrl) {
    return [
      `Task #${task.id} pronta para review.`,
      `Projeto: ${project}`,
      `Goal #${run.id}: completed`,
      `PR: ${run.pullRequestUrl}`,
      "Acao: revise e faca merge ou solicite ajustes."
    ].join("\n");
  }

  if (run.status === "completed") {
    return [
      `Task #${task.id} concluida.`,
      `Projeto: ${project}`,
      `Goal #${run.id}: completed`
    ].join("\n");
  }

  if (run.status === "cancelled") {
    return [
      `Task #${task.id} cancelada.`,
      `Projeto: ${project}`,
      `Goal #${run.id}: cancelled`
    ].join("\n");
  }

  const obs = database ? buildGoalObservability(database, run) : null;
  const reasonLabel = obs?.classifiedReasonLabel
    ?? (run.waitReason ? redactSensitiveText(run.waitReason) : null)
    ?? (run.lastError ? truncate(redactSensitiveText(run.lastError), 240) : "Erro de provedor/execucao");
  const sourceProv = obs?.sourceProvider ?? run.lastProvider ?? "desconhecido";
  const nextProv = obs?.nextProvider ?? (run.status === "waiting_provider" ? "aguardando cota/liberacao" : "nenhum");
  const preservedStr = obs
    ? (obs.preservedChanges ? `sim (${obs.preservedFiles.length} arquivos)` : "nao")
    : "desconhecido";
  const checkpointStr = obs?.checkpointId ? `#${obs.checkpointId}` : "nao disponivel";
  const retryableStr = obs ? (obs.retryable ? "sim" : "nao") : (run.status === "waiting_provider" ? "sim" : "nao");
  const nextAction = obs?.nextAction
    ?? (run.status === "waiting_provider" ? "Retomada automatica agendada pelo Maestro." : "Requer intervencao manual.");

  return [
    `Task #${task.id} requer atencao.`,
    `Projeto: ${project}`,
    `Goal #${run.id}: ${run.status}`,
    `Motivo: ${reasonLabel}`,
    `Provedor origem: ${sourceProv}`,
    `Proximo provedor: ${nextProv}`,
    `Alteracoes preservadas: ${preservedStr}`,
    `Checkpoint: ${checkpointStr}`,
    `Retomavel: ${retryableStr}`,
    `Proxima acao: ${nextAction}`
  ].join("\n");
}

export function createTelegramReviewNotifier(
  config: MaestroConfig,
  database: MaestroDatabase,
  sendMessage: TelegramMessageSender
): ReviewDecisionNotifier | undefined {
  const chatId = config.telegram.allowedUserId;
  if (!chatId) return undefined;

  return async (item, decision) => {
    const labels = {
      approved: "aprovada e pronta para merge",
      changes_requested: "devolvida para ajustes",
      rejected: "rejeitada"
    } as const;
    const text = [
      `Task #${item.taskId} ${labels[decision.decision]}.`,
      `Projeto: @${item.projectKey}`,
      `Goal #${item.runId}`,
      `Justificativa: ${truncate(redactSensitiveText(decision.note), 240)}`,
      `PR: ${item.pullRequestUrl}`
    ].join("\n");
    await sendMessage(chatId, text);
    database.addEvent({
      source: "telegram",
      type: "review.notification_sent",
      text: `Review decision notification sent for goal #${item.runId}.`,
      taskId: item.taskId,
      metadata: { runId: item.runId, reviewId: decision.id, decision: decision.decision }
    });
  };
}

export function createTelegramReviewSyncNotifier(
  config: MaestroConfig,
  database: MaestroDatabase,
  sendMessage: TelegramMessageSender
): ReviewSyncNotifier | undefined {
  const chatId = config.telegram.allowedUserId;
  if (!chatId) return undefined;

  return async (item, state) => {
    const labels = {
      READY: "marcada como pronta para merge no GitHub",
      DRAFT: "devolvida para draft no GitHub",
      MERGED: "mergeada no GitHub e concluida no Maestro",
      CLOSED: "fechada no GitHub",
      OPEN: "aberta no GitHub"
    } as const;
    await sendMessage(chatId, [
      `Task #${item.taskId} ${labels[state]}.`,
      `Projeto: @${item.projectKey}`,
      `PR: ${item.pullRequestUrl}`
    ].join("\n"));
    database.addEvent({
      source: "telegram",
      type: "review.sync_notification_sent",
      text: `GitHub sync notification sent for goal #${item.runId}.`,
      taskId: item.taskId,
      metadata: { runId: item.runId, state }
    });
  };
}

export function createTelegramFeatureNotifier(
  config: MaestroConfig,
  database: MaestroDatabase,
  sendMessage: TelegramMessageSender
): FeatureNotificationHandler | undefined {
  const chatId = config.telegram.allowedUserId;
  if (!chatId) return undefined;

  return async (completion) => {
    await sendMessage(chatId, formatFeatureCompletionNotification(completion));
    database.addEvent({
      source: "telegram",
      type: "feature.notification_sent",
      text: `Feature #${completion.feature.id} completion notification sent.`,
      metadata: {
        featureId: completion.feature.id,
        taskCount: completion.items.length,
        cleanupPending: completion.items.filter((item) => item.cleanup === "pending").length
      }
    });
  };
}

export function formatFeatureCompletionNotification(completion: FeatureCompletion): string {
  const feature = completion.feature;
  const work = completion.items.map(({ item, task, cleanup }) => (
    `- Task #${task.id} | ${item.branchName} | PR ${item.pullRequestUrl} | cleanup ${cleanup}`
  ));
  return truncate([
    `✅ Feature concluida: ${feature.name}`,
    `Projeto: @${feature.projectKey}`,
    `Objetivo: ${truncate(redactSensitiveText(feature.objective), 500)}`,
    `Feature PR mergeado: ${feature.pullRequestUrl}`,
    `Revisor final: ${feature.reviewerProvider ?? "registrado pelo GitHub"}`,
    "",
    "Tasks e branches integradas:",
    ...work,
    "",
    "Os Work PRs associados foram encerrados como superseded. O Maestro esta livre para a proxima Feature."
  ].join("\n"), 4_000);
}

export function createTelegramFeatureBlockedNotifier(
  config: MaestroConfig,
  database: MaestroDatabase,
  sendMessage: TelegramMessageSender
): FeatureBlockedNotificationHandler | undefined {
  const chatId = config.telegram.allowedUserId;
  if (!chatId) return undefined;

  return async (event) => {
    await sendMessage(chatId, formatFeatureBlockedNotification(event));
    database.addEvent({
      source: "telegram",
      type: "feature.blocked_notification_sent",
      text: `Feature #${event.feature.id} blocked notification sent (${event.reason}).`,
      metadata: { featureId: event.feature.id, reason: event.reason, pullRequestUrl: event.feature.pullRequestUrl }
    });
  };
}

const featureBlockedReasonLabels: Record<FeatureBlockedReason, string> = {
  conflict: "conflito de merge no PR consolidado",
  changes_requested: "revisao final pediu ajustes",
  waiting_provider: "sem agente de revisao disponivel",
  closed_without_merge: "PR consolidado fechado sem merge",
  failed: "falha no fluxo automatico da Feature"
};

export function formatFeatureBlockedNotification(event: FeatureBlockedEvent): string {
  const feature = event.feature;
  return truncate([
    `⚠️ Feature bloqueada: ${feature.name}`,
    `Projeto: @${feature.projectKey}`,
    `Motivo: ${featureBlockedReasonLabels[event.reason]}`,
    `Detalhe: ${truncate(redactSensitiveText(event.message), 500)}`,
    `Feature PR: ${feature.pullRequestUrl}`,
    "",
    "Revise apenas este PR consolidado; os Work PRs individuais permanecem como evidencia."
  ].join("\n"), 4_000);
}

export type FeaturePlanLifecycleEvent = {
  plan: import("../db.js").FeaturePlanRecord;
  action: "admitted" | "paused" | "resumed" | "blocked" | "retried" | "cancelled" | "priority_updated";
  reason?: string | null;
  sourceEventId?: number;
};

export type FeaturePlanLifecycleNotificationHandler = (event: FeaturePlanLifecycleEvent) => Promise<void>;

export function createTelegramFeaturePlanLifecycleNotifier(
  config: MaestroConfig,
  database: MaestroDatabase,
  sendMessage: TelegramMessageSender
): FeaturePlanLifecycleNotificationHandler | undefined {
  const chatId = config.telegram.allowedUserId;
  if (!chatId) return undefined;

  return async (event) => {
    await sendMessage(chatId, formatFeaturePlanLifecycleNotification(event));
    database.addEvent({
      source: "telegram",
      type: "feature_plan.lifecycle_notification_sent",
      text: `Feature Plan #${event.plan.id} ${event.action} notification sent.`,
      metadata: {
        featurePlanId: event.plan.id,
        action: event.action,
        reason: event.reason ?? null,
        sourceEventId: event.sourceEventId ?? null
      }
    });
  };
}

export function formatFeaturePlanLifecycleNotification(event: FeaturePlanLifecycleEvent): string {
  const { plan, action, reason } = event;
  const project = `@${plan.projectKey}`;
  const actionLabels: Record<string, string> = {
    admitted: "🚀 Admitido na fila de escrita",
    paused: "⏸️ Pausado pelo operador",
    resumed: "▶️ Retomado para a fila",
    blocked: "⚠️ Bloqueado",
    retried: "🔄 Retomado (Retry) para a fila",
    cancelled: "❌ Cancelado",
    priority_updated: `⬆️ Prioridade atualizada para ${plan.priority}`
  };

  const nextActions: Record<string, string> = {
    admitted: "As tasks estao prontas para inicio pelo Maestro.",
    paused: "O plano nao sera executado ate ser retomado.",
    resumed: "Aguardando liberacao de dependencias/recursos.",
    blocked: "Resolva o motivo do bloqueio e execute /feature_retry id.",
    retried: "Aguardando revalidacao da fila e admissao.",
    cancelled: "O historico e evidencias foram preservados.",
    priority_updated: "A ordem de admissao na fila foi reordenada."
  };

  const lines = [
    `Feature Plan #${plan.id} - ${actionLabels[action] ?? action}`,
    `Projeto: ${project}`,
    `Objetivo: ${truncate(redactSensitiveText(plan.objective), 200)}`,
    `Status: ${plan.status}${plan.isPaused ? " (pausado)" : ""}`,
    `Prioridade: ${plan.priority ?? 0}`,
    reason ? `Motivo: ${redactSensitiveText(reason)}` : null,
    plan.blockedReason ? `Bloqueio: ${redactSensitiveText(plan.blockedReason)}` : null,
    `Proxima acao: ${nextActions[action] ?? "Verifique a fila com /queue."}`
  ].filter(Boolean) as string[];

  return truncate(lines.join("\n"), 4_000);
}

export function createTelegramFeatureAssemblyNotifier(
  config: MaestroConfig,
  _database: MaestroDatabase,
  sendMessage: TelegramMessageSender
): FeatureAssemblyNotificationHandler | undefined {
  const chatId = config.telegram.allowedUserId;
  if (!chatId) return undefined;

  return async (event) => {
    await sendMessage(chatId, formatFeatureAssemblyNotification(event));
  };
}

export function formatFeatureAssemblyNotification(event: FeatureAssemblyEvent): string {
  if (event.type === "started") {
    return truncate([
      `🚀 Integracao iniciada: Feature Plan #${event.plan.id}`,
      `Projeto: @${event.plan.projectKey}`,
      `Objetivo: ${truncate(redactSensitiveText(event.plan.objective), 500)}`,
      "O Maestro esta montando o PR consolidado a partir dos Work PRs prontos."
    ].join("\n"), 4_000);
  }
  if (event.type === "draft_ready") {
    return truncate([
      `📝 Draft Feature PR pronto: ${event.feature.name}`,
      `Projeto: @${event.feature.projectKey}`,
      `Feature Plan #${event.plan.id}`,
      `PR: ${event.feature.pullRequestUrl}`,
      "",
      "Revise apenas este PR consolidado. Os Work PRs individuais ficam como evidencia e nao exigem revisao separada."
    ].join("\n"), 4_000);
  }
  return truncate([
    `⚠️ Integracao bloqueada: Feature Plan #${event.plan.id}`,
    `Projeto: @${event.plan.projectKey}`,
    `Detalhe: ${truncate(redactSensitiveText(event.message), 500)}`
  ].join("\n"), 4_000);
}

export function createTelegramSelfUpdateNotifier(
  config: MaestroConfig,
  database: MaestroDatabase,
  sendMessage: TelegramMessageSender
): ((event: SelfUpdateNotificationEvent) => Promise<void>) | undefined {
  const chatId = config.telegram.allowedUserId;
  if (!chatId) return undefined;

  return async (event) => {
    await sendMessage(chatId, formatSelfUpdateNotification(event));
    database.addEvent({
      source: "telegram",
      type: `self_update.${event.type}_notification_sent`,
      text: `Self-update ${event.type} notification sent.`,
      metadata: { eventType: event.type }
    });
  };
}

export function formatSelfUpdateNotification(event: SelfUpdateNotificationEvent): string {
  switch (event.type) {
    case "start":
      return truncate([
        "🔄 Self-update do Maestro iniciado.",
        `Commit de destino: ${event.targetCommit.slice(0, 8)}`,
        event.pullRequestUrl ? `PR: ${event.pullRequestUrl}` : null,
        "O Maestro aplicara o merge fast-forward e iniciara o supervised restart."
      ].filter(Boolean).join("\n"), 4_000);
    case "commit":
      return truncate([
        "📦 Main branch atualizada com sucesso.",
        `Commit resultante: ${event.resultingCommit.slice(0, 8)}`,
        "Iniciando verificacao de saude do novo runtime..."
      ].join("\n"), 4_000);
    case "success":
      return truncate([
        "✅ Self-update e supervised restart concluidos com sucesso!",
        `Commit atual: ${event.resultingCommit.slice(0, 8)}`,
        "Maestro runtime operacional."
      ].filter(Boolean).join("\n"), 4_000);
    case "failure":
      return truncate([
        "⚠️ Falha no self-update do Maestro.",
        `Commit: ${event.commit.slice(0, 8)}`,
        `Motivo: ${redactSensitiveText(event.error)}`,
        "Nenhuma alteracao destrutiva foi realizada."
      ].join("\n"), 4_000);
    case "rollback":
      return truncate([
        "⏪ Startup do novo runtime falhou. Rollback executado.",
        `Commit restaurado: ${event.previousCommit.slice(0, 8)}`,
        `Erro de startup: ${redactSensitiveText(event.error)}`,
        "O Maestro foi restaurado para a versao anterior conhecida e saudavel."
      ].join("\n"), 4_000);
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}
