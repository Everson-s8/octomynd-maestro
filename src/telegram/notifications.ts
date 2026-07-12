import { MaestroConfig } from "../config.js";
import { GoalRunRecord, MaestroDatabase, TaskRecord } from "../db.js";

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

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}
