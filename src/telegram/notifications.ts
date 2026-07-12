import { MaestroConfig } from "../config.js";
import { GoalRunRecord, MaestroDatabase, TaskRecord } from "../db.js";
import type { ReviewDecisionNotifier } from "../reviews/coordinator.js";
import { redactSensitiveText } from "../security/redaction.js";

export type GoalNotificationHandler = (run: GoalRunRecord) => Promise<void>;
export type TelegramMessageSender = (chatId: string, text: string) => Promise<unknown>;

export function createTelegramGoalNotifier(
  config: MaestroConfig,
  database: MaestroDatabase,
  sendMessage: TelegramMessageSender
): GoalNotificationHandler | undefined {
  const chatId = config.telegram.allowedUserId;
  if (!chatId) return undefined;

  return async (run) => {
    const task = database.getTask(run.taskId);
    const text = formatGoalNotification(run, task);
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

export function formatGoalNotification(run: GoalRunRecord, task: TaskRecord): string {
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

  return [
    `Task #${task.id} requer atencao.`,
    `Projeto: ${project}`,
    `Goal #${run.id}: ${run.status}`,
    run.lastError ? `Motivo: ${truncate(run.lastError, 240)}` : "Consulte o dashboard para detalhes."
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

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}
