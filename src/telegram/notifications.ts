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
      `Task #${task.id} blocked.`,
      `Project: ${task.projectKey ? `@${task.projectKey}` : "no project"}`,
      `Reason: ${reason}`,
      `Details: ${redactSensitiveText(explanation)}`,
      "Action: fix the cause and try again."
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
      `New improvement candidate #${proposal.id}: ${proposal.title}`,
      `Project: @${proposal.projectKey ?? "not set"}`,
      `Risk: ${proposal.risk}`,
      `Confidence: ${proposal.confidence === null ? "not reported" : `${Math.round(proposal.confidence * 100)}%`}`,
      `Reason: ${redactSensitiveText(proposal.rationale)}`,
      "",
      `Approve: /improve_approve ${proposal.id}`,
      `Reject: /improve_reject ${proposal.id}`,
      "Approval creates a new Task and Feature Plan; it does not change the system directly."
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
      candidate_created: "💡 New self-correction proposal",
      candidate_evaluated: "🧪 Candidate evaluated",
      candidate_promoted: "🚀 Candidate promoted (low risk)",
      candidate_rejected: "❌ Candidate rejected",
      candidate_rolled_back: "⏪ Skill rolled back after regression"
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
      `Task #${task.id} in progress.`,
      `Project: ${task.projectKey ? `@${task.projectKey}` : "no project"}`,
      `Agent: ${providerId}`,
      `Phase: ${run.currentPhase}`,
      `Steps executed: ${run.stepCount}`
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
  const project = task.projectKey ? `@${task.projectKey}` : "no project";

  if (run.status === "completed" && run.pullRequestUrl) {
    return [
      `Task #${task.id} ready for review.`,
      `Project: ${project}`,
      `Goal #${run.id}: completed`,
      `PR: ${run.pullRequestUrl}`,
      "Action: review and merge, or request changes."
    ].join("\n");
  }

  if (run.status === "completed") {
    return [
      `Task #${task.id} completed.`,
      `Project: ${project}`,
      `Goal #${run.id}: completed`
    ].join("\n");
  }

  if (run.status === "cancelled") {
    return [
      `Task #${task.id} cancelled.`,
      `Project: ${project}`,
      `Goal #${run.id}: cancelled`
    ].join("\n");
  }

  const obs = database ? buildGoalObservability(database, run) : null;
  const reasonLabel = obs?.classifiedReasonLabel
    ?? (run.waitReason ? redactSensitiveText(run.waitReason) : null)
    ?? (run.lastError ? truncate(redactSensitiveText(run.lastError), 240) : "Provider/execution error");
  const sourceProv = obs?.sourceProvider ?? run.lastProvider ?? "unknown";
  const nextProv = obs?.nextProvider ?? (run.status === "waiting_provider" ? "waiting for quota/release" : "none");
  const preservedStr = obs
    ? (obs.preservedChanges ? `yes (${obs.preservedFiles.length} files)` : "no")
    : "unknown";
  const checkpointStr = obs?.checkpointId ? `#${obs.checkpointId}` : "not available";
  const retryableStr = obs ? (obs.retryable ? "yes" : "no") : (run.status === "waiting_provider" ? "yes" : "no");
  const nextAction = obs?.nextAction
    ?? (run.status === "waiting_provider" ? "Automatic resume scheduled by Maestro." : "Manual intervention required.");

  return [
    `Task #${task.id} needs attention.`,
    `Project: ${project}`,
    `Goal #${run.id}: ${run.status}`,
    `Reason: ${reasonLabel}`,
    `Source provider: ${sourceProv}`,
    `Next provider: ${nextProv}`,
    `Changes preserved: ${preservedStr}`,
    `Checkpoint: ${checkpointStr}`,
    `Retryable: ${retryableStr}`,
    `Next action: ${nextAction}`
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
      approved: "approved and ready to merge",
      changes_requested: "returned for changes",
      rejected: "rejected"
    } as const;
    const text = [
      `Task #${item.taskId} ${labels[decision.decision]}.`,
      `Project: @${item.projectKey}`,
      `Goal #${item.runId}`,
      `Rationale: ${truncate(redactSensitiveText(decision.note), 240)}`,
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
      READY: "marked ready to merge on GitHub",
      DRAFT: "returned to draft on GitHub",
      MERGED: "merged on GitHub and completed in Maestro",
      CLOSED: "closed on GitHub",
      OPEN: "opened on GitHub"
    } as const;
    await sendMessage(chatId, [
      `Task #${item.taskId} ${labels[state]}.`,
      `Project: @${item.projectKey}`,
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
    `✅ Feature completed: ${feature.name}`,
    `Project: @${feature.projectKey}`,
    `Objective: ${truncate(redactSensitiveText(feature.objective), 500)}`,
    `Feature PR merged: ${feature.pullRequestUrl}`,
    `Final reviewer: ${feature.reviewerProvider ?? "recorded by GitHub"}`,
    "",
    "Integrated tasks and branches:",
    ...work,
    "",
    "Associated Work PRs were closed as superseded. Maestro is ready for the next Feature."
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
  conflict: "merge conflict in the consolidated PR",
  changes_requested: "final review requested changes",
  waiting_provider: "no review agent available",
  closed_without_merge: "consolidated PR closed without merge",
  failed: "automatic Feature flow failed"
};

export function formatFeatureBlockedNotification(event: FeatureBlockedEvent): string {
  const feature = event.feature;
  return truncate([
    `⚠️ Feature blocked: ${feature.name}`,
    `Project: @${feature.projectKey}`,
    `Reason: ${featureBlockedReasonLabels[event.reason]}`,
    `Details: ${truncate(redactSensitiveText(event.message), 500)}`,
    `Feature PR: ${feature.pullRequestUrl}`,
    "",
    "Review only this consolidated PR; individual Work PRs remain as evidence."
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
    admitted: "🚀 Admitted to the write queue",
    paused: "⏸️ Paused by the operator",
    resumed: "▶️ Resumed to the queue",
    blocked: "⚠️ Blocked",
    retried: "🔄 Retried and returned to the queue",
    cancelled: "❌ Cancelled",
    priority_updated: `⬆️ Priority updated to ${plan.priority}`
  };

  const nextActions: Record<string, string> = {
    admitted: "Tasks are ready to be started by Maestro.",
    paused: "The plan will not run until it is resumed.",
    resumed: "Waiting for dependencies/resources to be released.",
    blocked: "Resolve the blocking reason and run /feature_retry id.",
    retried: "Waiting for queue revalidation and admission.",
    cancelled: "History and evidence were preserved.",
    priority_updated: "The queue admission order was updated."
  };

  const lines = [
    `Feature Plan #${plan.id} - ${actionLabels[action] ?? action}`,
    `Project: ${project}`,
    `Objetivo: ${truncate(redactSensitiveText(plan.objective), 200)}`,
    `Status: ${plan.status}${plan.isPaused ? " (paused)" : ""}`,
    `Priority: ${plan.priority ?? 0}`,
    reason ? `Reason: ${redactSensitiveText(reason)}` : null,
    plan.blockedReason ? `Blocker: ${redactSensitiveText(plan.blockedReason)}` : null,
    `Next action: ${nextActions[action] ?? "Check the queue with /queue."}`
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
      `🚀 Integration started: Feature Plan #${event.plan.id}`,
      `Project: @${event.plan.projectKey}`,
      `Objective: ${truncate(redactSensitiveText(event.plan.objective), 500)}`,
      "Maestro is assembling the consolidated PR from ready Work PRs."
    ].join("\n"), 4_000);
  }
  if (event.type === "draft_ready") {
    return truncate([
      `📝 Draft Feature PR ready: ${event.feature.name}`,
      `Project: @${event.feature.projectKey}`,
      `Feature Plan #${event.plan.id}`,
      `PR: ${event.feature.pullRequestUrl}`,
      "",
      "Review only this consolidated PR. Individual Work PRs remain as evidence and do not require separate review."
    ].join("\n"), 4_000);
  }
  return truncate([
    `⚠️ Integration blocked: Feature Plan #${event.plan.id}`,
    `Project: @${event.plan.projectKey}`,
    `Details: ${truncate(redactSensitiveText(event.message), 500)}`
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
        "🔄 Maestro self-update started.",
        `Target commit: ${event.targetCommit.slice(0, 8)}`,
        event.pullRequestUrl ? `PR: ${event.pullRequestUrl}` : null,
        "Maestro will apply the fast-forward merge and start the supervised restart."
      ].filter(Boolean).join("\n"), 4_000);
    case "commit":
      return truncate([
        "📦 Main branch updated successfully.",
        `Resulting commit: ${event.resultingCommit.slice(0, 8)}`,
        "Starting health verification for the new runtime..."
      ].join("\n"), 4_000);
    case "success":
      return truncate([
        "✅ Self-update and supervised restart completed successfully!",
        `Current commit: ${event.resultingCommit.slice(0, 8)}`,
        "Maestro runtime is operational."
      ].filter(Boolean).join("\n"), 4_000);
    case "failure":
      return truncate([
        "⚠️ Maestro self-update failed.",
        `Commit: ${event.commit.slice(0, 8)}`,
        `Motivo: ${redactSensitiveText(event.error)}`,
        "No destructive changes were made."
      ].join("\n"), 4_000);
    case "rollback":
      return truncate([
        "⏪ New runtime startup failed. Rollback completed.",
        `Restored commit: ${event.previousCommit.slice(0, 8)}`,
        `Startup error: ${redactSensitiveText(event.error)}`,
        "Maestro was restored to the previous known-good version."
      ].join("\n"), 4_000);
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}
