import { execFile } from "node:child_process";
import path from "node:path";
import { AgentRegistry } from "../agents/registry.js";
import { AgentExecutionRequest, AgentProviderId } from "../agents/types.js";
import {
  FeatureItemRecord,
  FeatureRecord,
  MaestroDatabase,
  ProjectRecord,
  TaskRecord
} from "../db.js";
import { CompletionReviewOutbox } from "../improvements/outbox.js";
import { redactSensitiveText, truncateForDisplay } from "../security/redaction.js";
import {
  FeatureGitHubGateway,
  FeaturePullRequestState,
  GhFeatureGateway,
  featureChecksPassed
} from "./github.js";
import { revalidateQueuedFeaturePlansWithAudit } from "./task-scheduler.js";
import { ProjectRepositoryService, RepositorySyncError } from "../projects/repository-service.js";

const REVIEW_SUMMARY_MAX_LENGTH = 2_000;

export type FeatureCompletion = {
  feature: FeatureRecord;
  items: Array<{
    item: FeatureItemRecord;
    task: TaskRecord;
    cleanup: "completed" | "pending";
  }>;
};

export type FeatureBlockedReason =
  | "conflict"
  | "changes_requested"
  | "waiting_provider"
  | "closed_without_merge"
  | "failed";

export type FeatureBlockedEvent = {
  feature: FeatureRecord;
  reason: FeatureBlockedReason;
  message: string;
};

export type FeatureNotificationHandler = (completion: FeatureCompletion) => Promise<void>;
export type FeatureBlockedNotificationHandler = (event: FeatureBlockedEvent) => Promise<void>;

export type ManualReviewResult = {
  success: boolean;
  feature: FeatureRecord;
  prState?: FeaturePullRequestState;
  status: FeatureRecord["status"];
  providerId?: AgentProviderId;
  summary?: string;
  reason?: string;
  message: string;
};

export type ManualReviewStatusResult = {
  feature: FeatureRecord;
  prState: FeaturePullRequestState;
  isReady: boolean;
  notReadyReason: string | null;
  isReviewActive: boolean;
};

export class FeatureCoordinator {
  private readonly active = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private reconcilePromise: Promise<number> | null = null;

  constructor(
    private readonly database: MaestroDatabase,
    private readonly agents: AgentRegistry,
    private readonly artifactsRoot: string,
    private readonly github: FeatureGitHubGateway = new GhFeatureGateway(),
    private readonly notifyCompleted?: FeatureNotificationHandler,
    private readonly notifyBlocked?: FeatureBlockedNotificationHandler,
    private readonly pollIntervalMs = 15_000,
    private readonly onFeatureMerged?: (feature: FeatureRecord, headSha: string) => Promise<void>,
    private readonly repositoryService?: ProjectRepositoryService
  ) {}

  start(): void {
    if (this.timer) return;
    revalidateQueuedFeaturePlansWithAudit(this.database, "coordinator_start");
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reconcile(): Promise<number> {
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.reconcileFeatures().finally(() => {
      this.reconcilePromise = null;
    });
    return this.reconcilePromise;
  }

  async getReviewStatus(featureId: number): Promise<ManualReviewStatusResult> {
    const feature = this.database.getFeature(featureId);
    const prState = await this.github.inspect(feature.pullRequestUrl);
    const isReviewActive = this.active.has(feature.id) || feature.status === "reviewing" || feature.status === "merging";

    let isReady = true;
    let notReadyReason: string | null = null;

    if (feature.status === "completed") {
      isReady = false;
      notReadyReason = "Feature PR was already completed and integrated.";
    } else if (feature.status === "cancelled") {
      isReady = false;
      notReadyReason = "Feature PR was cancelled.";
    } else if (isReviewActive) {
      isReady = false;
      notReadyReason = "Final review is already in progress.";
    } else if (prState.state === "CLOSED") {
      isReady = false;
      notReadyReason = "Feature PR was closed on GitHub.";
    } else if (prState.state === "MERGED") {
      isReady = false;
      notReadyReason = "Feature PR was already merged on GitHub.";
    } else if (prState.isDraft) {
      isReady = false;
      notReadyReason = "Feature PR is still a draft on GitHub.";
    } else if (prState.mergeable === "CONFLICTING") {
      isReady = false;
      notReadyReason = "Feature PR has merge conflicts.";
    } else if (prState.mergeable !== "MERGEABLE") {
      isReady = false;
      notReadyReason = "GitHub has not confirmed that the Feature PR is mergeable yet.";
    } else if (!featureChecksPassed(prState)) {
      isReady = false;
      notReadyReason = "Required GitHub checks have not passed.";
    }

    return {
      feature,
      prState,
      isReady,
      notReadyReason,
      isReviewActive
    };
  }

  async triggerManualReview(featureId: number, isRetry = false): Promise<ManualReviewResult> {
    const feature = this.database.getFeature(featureId);

    if (feature.status === "completed") {
      return {
        success: false,
        feature,
        status: feature.status,
        reason: "already_completed",
        message: "Feature PR was already completed and integrated."
      };
    }

    if (feature.status === "cancelled") {
      return {
        success: false,
        feature,
        status: feature.status,
        reason: "cancelled",
        message: "Feature PR was cancelled."
      };
    }

    if (this.active.has(feature.id) || (feature.status === "reviewing" && !isRetry) || (feature.status === "merging" && !isRetry)) {
      return {
        success: false,
        feature,
        status: feature.status,
        reason: "already_in_progress",
        message: `Final review is already in progress for Feature #${feature.id}.`
      };
    }

    this.active.add(feature.id);
    try {
      const state = await this.github.inspect(feature.pullRequestUrl);

      if (state.state === "MERGED") {
        const completed = await this.completeFeature(feature, state);
        const updated = this.database.getFeature(feature.id);
        return {
          success: completed,
          feature: updated,
          prState: state,
          status: updated.status,
          reason: completed ? undefined : "repository_sync_pending",
          message: completed
            ? "Feature PR was merged on GitHub."
            : updated.lastError || "Feature PR was merged, but the canonical repository still needs synchronization."
        };
      }

      if (state.state === "CLOSED") {
        const message = "Feature PR was closed without merge.";
        const failed = this.database.updateFeature({ id: feature.id, status: "failed", lastError: message });
        this.addEvent(failed, "feature.closed_without_merge", message);
        await this.emitBlocked(failed, "closed_without_merge", message);
        return {
          success: false,
          feature: failed,
          prState: state,
          status: "failed",
          reason: "closed_without_merge",
          message: "Feature PR foi fechado no GitHub sem merge."
        };
      }

      if (state.isDraft) {
        const message = "Feature PR is still a draft. Mark it as 'Ready for review' on GitHub before the final review.";
        const updated = this.database.updateFeature({ id: feature.id, status: "draft", lastError: message });
        this.addEvent(updated, "feature.manual_review_rejected", message);
        return {
          success: false,
          feature: updated,
          prState: state,
          status: "draft",
          reason: "is_draft",
          message
        };
      }

      if (state.mergeable === "CONFLICTING") {
        const message = "Feature PR possui conflitos de merge.";
        await this.requestChanges(feature, "conflict", message);
        const updated = this.database.getFeature(feature.id);
        return {
          success: false,
          feature: updated,
          prState: state,
          status: "changes_requested",
          reason: "conflict",
          message
        };
      }

      if (state.mergeable !== "MERGEABLE") {
        const message = "GitHub has not confirmed that the Feature PR is mergeable yet.";
        const updated = this.database.updateFeature({ id: feature.id, status: "waiting_checks", lastError: message });
        this.addEvent(updated, "feature.waiting_mergeability", message);
        return {
          success: false,
          feature: updated,
          prState: state,
          status: "waiting_checks",
          reason: "not_mergeable",
          message
        };
      }

      if (!featureChecksPassed(state)) {
        const message = "Required GitHub checks have not passed.";
        const updated = this.database.updateFeature({ id: feature.id, status: "waiting_checks", lastError: message });
        this.addEvent(updated, "feature.waiting_checks", message);
        return {
          success: false,
          feature: updated,
          prState: state,
          status: "waiting_checks",
          reason: "checks_failed",
          message
        };
      }

      this.addEvent(
        feature,
        isRetry ? "feature.manual_review_retried" : "feature.manual_review_requested",
        `Manual final review requested for head ${state.headSha.slice(0, 8)}.`
      );

      await this.runFinalReview(feature, state);

      const finalFeature = this.database.getFeature(feature.id);
      if (finalFeature.status === "completed") {
        return {
          success: true,
          feature: finalFeature,
          prState: state,
          status: "completed",
          providerId: (finalFeature.reviewerProvider as AgentProviderId) || undefined,
          summary: finalFeature.reviewSummary || undefined,
          message: "Final review approved and the Feature PR was merged successfully!"
        };
      }

      if (finalFeature.status === "changes_requested") {
        return {
          success: false,
          feature: finalFeature,
          prState: state,
          status: "changes_requested",
          providerId: (finalFeature.reviewerProvider as AgentProviderId) || undefined,
          summary: finalFeature.reviewSummary || undefined,
          reason: "changes_requested",
          message: `Final review requested changes: ${finalFeature.reviewSummary || "no details"}`
        };
      }

      if (finalFeature.status === "waiting_provider") {
        return {
          success: false,
          feature: finalFeature,
          prState: state,
          status: "waiting_provider",
          reason: "waiting_provider",
          message: finalFeature.lastError || "Waiting for an available review provider."
        };
      }

      return {
        success: false,
        feature: finalFeature,
        prState: state,
        status: finalFeature.status,
        reason: finalFeature.status,
        message: finalFeature.lastError || `Review completed with status: ${finalFeature.status}`
      };
    } finally {
      this.active.delete(feature.id);
    }
  }

  private async reconcileFeatures(): Promise<number> {
    let changes = new CompletionReviewOutbox(this.database).reconcileCompletedFeatures(100);
    const allFeatures = this.database.listFeatures(100);
    for (const feature of allFeatures) {
      if (feature.status === "completed" && feature.featurePlanId !== null) {
        this.database.reconcileFeaturePlanStatus(feature.featurePlanId);
      }
    }
    const features = allFeatures.filter((feature) => (
      !["completed", "failed", "cancelled"].includes(feature.status)
    ));
    for (const feature of features) {
      if (this.active.has(feature.id)) continue;
      this.active.add(feature.id);
      try {
        changes += await this.reconcileFeature(feature);
      } catch (error) {
        const message = safeSummary(error);
        const failed = this.database.updateFeature({ id: feature.id, status: "failed", lastError: message });
        this.addEvent(failed, "feature.failed", message);
        await this.emitBlocked(failed, "failed", message);
        changes += 1;
      } finally {
        this.active.delete(feature.id);
      }
    }
    return changes;
  }

  private async reconcileFeature(feature: FeatureRecord): Promise<number> {
    const state = await this.github.inspect(feature.pullRequestUrl);
    if (state.state === "MERGED") {
      await this.completeFeature(feature, state);
      return 1;
    }
    if (state.state === "CLOSED") {
      const message = "Feature PR was closed without merge.";
      const failed = this.database.updateFeature({ id: feature.id, status: "failed", lastError: message });
      this.addEvent(failed, "feature.closed_without_merge", message);
      await this.emitBlocked(failed, "closed_without_merge", message);
      return 1;
    }
    if (state.isDraft) {
      if (feature.status !== "draft") {
        this.database.updateFeature({ id: feature.id, status: "draft", lastError: null });
        this.addEvent(feature, "feature.returned_to_draft", "Feature PR returned to draft.");
        return 1;
      }
      return 0;
    }
    if (state.mergeable === "CONFLICTING") {
      if (feature.status === "changes_requested") return 0;
      await this.requestChanges(feature, "conflict", "Feature PR has merge conflicts.");
      return 1;
    }
    if (state.mergeable !== "MERGEABLE") {
      if (feature.status !== "waiting_checks") {
        this.database.updateFeature({
          id: feature.id,
          status: "waiting_checks",
          lastError: "GitHub has not confirmed that the Feature PR is mergeable."
        });
        this.addEvent(feature, "feature.waiting_mergeability", "Feature PR mergeability is still unknown.");
        return 1;
      }
      return 0;
    }
    if (!featureChecksPassed(state)) {
      if (feature.status !== "waiting_checks") {
        this.database.updateFeature({ id: feature.id, status: "waiting_checks", lastError: "Required checks are not complete." });
        this.addEvent(feature, "feature.waiting_checks", "Feature PR is waiting for successful checks.");
        return 1;
      }
      return 0;
    }
    await this.runFinalReview(feature, state);
    return 1;
  }

  private async runFinalReview(feature: FeatureRecord, state: FeaturePullRequestState): Promise<void> {
    this.database.updateFeature({
      id: feature.id,
      status: "reviewing",
      reviewedHeadSha: state.headSha,
      lastError: null
    });
    this.addEvent(feature, "feature.final_review_started", `Final review started for head ${state.headSha.slice(0, 8)}.`);

    const excluded = new Set<AgentProviderId>();
    while (true) {
      const lease = await this.agents.acquire("reviewing", excluded);
      if (!lease) {
        const message = "No reviewing provider is currently available.";
        const wasWaiting = feature.status === "waiting_provider";
        const waiting = this.database.updateFeature({
          id: feature.id,
          status: "waiting_provider",
          lastError: message
        });
        if (!wasWaiting) {
          this.addEvent(waiting, "feature.waiting_provider", "Final review is waiting for a provider.");
          await this.emitBlocked(waiting, "waiting_provider", message);
        }
        return;
      }
      let result;
      try {
        result = await lease.provider.execute(this.buildReviewRequest(feature, state));
      } finally {
        lease.release(result);
      }

      const reviewSummary = truncateForDisplay(
        redactSensitiveText(result.output || result.summary),
        REVIEW_SUMMARY_MAX_LENGTH
      );
      if (result.outcome === "completed") {
        await this.mergeReviewedFeature(feature, state, lease.provider.id, reviewSummary);
        return;
      }
      if (result.outcome === "changes_requested" || result.outcome === "blocked") {
        await this.requestChanges(feature, "changes_requested", reviewSummary, lease.provider.id);
        return;
      }
      if (result.outcome === "failed" && result.retryable) {
        excluded.add(lease.provider.id);
        continue;
      }
      await this.requestChanges(feature, "changes_requested", reviewSummary || result.summary, lease.provider.id);
      return;
    }
  }

  private async mergeReviewedFeature(
    feature: FeatureRecord,
    reviewedState: FeaturePullRequestState,
    providerId: AgentProviderId,
    reviewSummary: string
  ): Promise<void> {
    if (this.database.getFeature(feature.id).status === "cancelled") return;
    const current = await this.github.inspect(feature.pullRequestUrl);
    if (
      current.state !== "OPEN"
      || current.isDraft
      || current.headSha !== reviewedState.headSha
      || current.mergeable !== "MERGEABLE"
      || !featureChecksPassed(current)
    ) {
      this.database.updateFeature({
        id: feature.id,
        status: "waiting_checks",
        reviewerProvider: providerId,
        reviewSummary,
        lastError: "Feature changed or lost a required gate after final review."
      });
      this.addEvent(feature, "feature.review_invalidated", "Feature changed after final review; merge was not attempted.");
      return;
    }

    if (this.database.getFeature(feature.id).status === "cancelled") return;

    this.database.updateFeature({
      id: feature.id,
      status: "merging",
      reviewerProvider: providerId,
      reviewSummary,
      reviewedHeadSha: current.headSha,
      lastError: null
    });
    this.addEvent(feature, "feature.final_review_passed", `Final review passed with ${providerId}.`);
    await this.github.merge(feature.pullRequestUrl, current.headSha);
    const merged = await this.github.inspect(feature.pullRequestUrl);
    if (merged.state !== "MERGED") throw new Error("GitHub did not report the Feature PR as merged.");
    await this.completeFeature(this.database.getFeature(feature.id), merged);
  }

  private async requestChanges(
    feature: FeatureRecord,
    reason: Extract<FeatureBlockedReason, "conflict" | "changes_requested">,
    summary: string,
    providerId: AgentProviderId | null = null
  ): Promise<void> {
    await this.github.markDraft(feature.pullRequestUrl);
    const safe = truncateForDisplay(redactSensitiveText(summary), REVIEW_SUMMARY_MAX_LENGTH);
    const updated = this.database.updateFeature({
      id: feature.id,
      status: "changes_requested",
      reviewerProvider: providerId,
      reviewSummary: safe,
      lastError: safe
    });
    this.addEvent(updated, "feature.changes_requested", safe);
    await this.emitBlocked(updated, reason, safe);
  }

  private async emitBlocked(feature: FeatureRecord, reason: FeatureBlockedReason, message: string): Promise<void> {
    if (!this.notifyBlocked) return;
    try {
      await this.notifyBlocked({ feature, reason, message });
    } catch (error) {
      this.addEvent(feature, "feature.blocked_notification_failed", safeSummary(error));
    }
  }

  private async completeFeature(feature: FeatureRecord, state: FeaturePullRequestState): Promise<boolean> {
    if (feature.status === "completed") return true;
    const project = this.database.getProjectByKey(feature.projectKey);
    const repositoryState = this.repositoryService
      ? (() => {
        try {
          return this.repositoryService.reconcileAfterMerge(project);
        } catch (error) {
          const message = error instanceof RepositorySyncError
            ? error.message
            : error instanceof Error ? error.message : "Repository reconciliation after Feature merge failed.";
          const waiting = this.database.updateFeature({ id: feature.id, status: "merging", lastError: message });
          this.addEvent(waiting, "feature.repository_reconcile_failed", message);
          return null;
        }
      })()
      : null;
    if (this.repositoryService && !repositoryState) {
      return false;
    }
    if (repositoryState) {
      for (const item of this.database.listFeatureItems(feature.id)) {
        this.database.updateTaskRepositoryMetadata({ id: item.taskId, mergedCommitSha: repositoryState.canonicalHeadSha });
      }
    }
    const issueLinks = feature.featurePlanId === null
      ? { featureIssueNumber: null, taskIssueNumbers: {} as Record<number, number> }
      : this.database.getFeaturePlanIssueLinks(feature.featurePlanId);
    const completedItems: FeatureCompletion["items"] = [];
    let workPullRequestPending = false;
    for (const item of this.database.listFeatureItems(feature.id)) {
      const task = this.database.getTask(item.taskId);
      if (item.status !== "included") {
        completedItems.push({
          item,
          task,
          cleanup: item.status === "completed" ? "completed" : "pending"
        });
        continue;
      }

      try {
        if (item.pullRequestUrl !== feature.pullRequestUrl) {
          await this.github.closeSuperseded(item.pullRequestUrl, feature.pullRequestUrl);
        }
        await this.github.deleteHeadBranch(item.pullRequestUrl);
        await cleanupTaskBaselineBranch(project, task);
        const taskIssueNumber = issueLinks.taskIssueNumbers[task.id];
        if (taskIssueNumber) {
          await this.github.closeIssue(
            feature.pullRequestUrl,
            taskIssueNumber,
            `Completed by Feature PR ${feature.pullRequestUrl} at ${state.headSha}.`
          );
        }
      } catch (error) {
        workPullRequestPending = true;
        this.addEvent(feature, "feature.work_pr_close_failed", safeSummary(error), task.id);
        continue;
      }

      let cleanup: "completed" | "pending" = "completed";
      try {
        cleanup = await cleanupTaskWorktree(project, task, feature.worktreePath);
      } catch (error) {
        cleanup = "pending";
        this.addEvent(feature, "feature.item_cleanup_failed", safeSummary(error), task.id);
      }
      this.database.withTransaction(() => {
        this.database.updateTaskStatus(task.id, "done");
        this.database.updateFeatureItemStatus(item.id, cleanup === "completed" ? "completed" : "cleanup_pending");
      });
      completedItems.push({ item: this.database.getFeatureItem(item.id), task: this.database.getTask(task.id), cleanup });
    }

    if (workPullRequestPending) {
      const message = "Feature merged, but one or more integrated branches or issues still need cleanup.";
      this.database.updateFeature({ id: feature.id, status: "merging", lastError: message });
      this.addEvent(feature, "feature.work_pr_cleanup_pending", message);
      return false;
    }

    try {
      await this.github.deleteHeadBranch(feature.pullRequestUrl);
      if (issueLinks.featureIssueNumber) {
        await this.github.closeIssue(
          feature.pullRequestUrl,
          issueLinks.featureIssueNumber,
          `Completed by merged Feature PR ${feature.pullRequestUrl} at ${state.headSha}.`
        );
      }
    } catch (error) {
      workPullRequestPending = true;
      this.addEvent(feature, "feature.branch_delete_failed", safeSummary(error));
    }

    if (workPullRequestPending) {
      const message = "Feature merged, but its branch or GitHub issue still needs cleanup.";
      this.database.updateFeature({ id: feature.id, status: "merging", lastError: message });
      this.addEvent(feature, "feature.work_pr_cleanup_pending", message);
      return false;
    }

    const completed = this.database.withTransaction(() => {
      const updated = this.database.updateFeature({
        id: feature.id,
        status: "completed",
        lastError: null,
        mergedAt: new Date().toISOString()
      });
      if (feature.featurePlanId !== null) {
        this.database.completeFeaturePlanAfterMerge(feature.featurePlanId);
      }
      this.database.enqueueFeatureCompletionReview(updated.id);
      this.addEvent(updated, "feature.completed", `Feature PR #${state.number} merged and child work closed.`);
      return updated;
    });
    revalidateQueuedFeaturePlansWithAudit(
      this.database,
      "feature_completed",
      feature.projectKey
    );
    if (this.notifyCompleted) {
      try {
        await this.notifyCompleted({ feature: completed, items: completedItems });
      } catch (error) {
        this.addEvent(completed, "feature.notification_failed", safeSummary(error));
      }
    }
    if (this.onFeatureMerged) {
      try {
        await this.onFeatureMerged(completed, state.headSha);
      } catch (error) {
        this.addEvent(completed, "feature.self_update_failed", safeSummary(error));
      }
    }
    return true;
  }

  private buildReviewRequest(feature: FeatureRecord, state: FeaturePullRequestState): AgentExecutionRequest {
    const project = this.database.getProjectByKey(feature.projectKey);
    const task: TaskRecord = {
      id: -feature.id,
      projectId: project.id,
      projectKey: project.key,
      projectName: project.name,
      text: [
        `FINAL FEATURE REVIEW: ${feature.name}`,
        `Objective: ${feature.objective}`,
        `Review the complete diff origin/${state.baseRefName}...HEAD at commit ${state.headSha}.`,
        "Check correctness, security, regressions, tests, scope and acceptance of the complete feature.",
        "Do not edit files. Return changes_requested for any concrete blocking issue; otherwise approve."
      ].join("\n"),
      status: "reviewing",
      source: "feature",
      branchName: feature.branchName,
      worktreePath: feature.worktreePath,
      createdAt: feature.createdAt,
      updatedAt: feature.updatedAt
    };
    return {
      runId: -feature.id,
      stepNumber: 1,
      phase: "reviewing",
      capability: "reviewing",
      task,
      project,
      previousSteps: [],
      artifactsRoot: path.resolve(this.artifactsRoot)
    };
  }

  private addEvent(feature: FeatureRecord, type: string, text: string, taskId?: number): void {
    this.database.addEvent({
      source: "maestro",
      type,
      text: truncateForDisplay(redactSensitiveText(text), 500),
      taskId: taskId ?? null,
      metadata: { featureId: feature.id, pullRequestUrl: feature.pullRequestUrl }
    });
  }
}

async function cleanupTaskWorktree(
  project: ProjectRecord,
  task: TaskRecord,
  featureWorktreePath: string
): Promise<"completed" | "pending"> {
  if (!task.worktreePath || !task.branchName) return "completed";
  if (path.resolve(task.worktreePath) === path.resolve(featureWorktreePath)) return "pending";
  const status = await runGit(["-C", task.worktreePath, "status", "--porcelain"]);
  if (status.trim()) return "pending";
  await runGit(["-C", project.path, "worktree", "remove", task.worktreePath]);
  await runGit(["-C", project.path, "branch", "-D", task.branchName]);
  return "completed";
}

async function cleanupTaskBaselineBranch(project: ProjectRecord, task: TaskRecord): Promise<void> {
  if (!task.baseBranch || task.baseBranch === project.defaultBranch) return;
  if (!/^maestro\/feature-plan-\d+-task-\d+-base-r\d+$/.test(task.baseBranch)) {
    throw new Error(`Refusing to delete unexpected Task base branch: ${task.baseBranch}`);
  }
  try {
    await runGit(["-C", project.path, "push", "origin", "--delete", task.baseBranch]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/remote ref does not exist|unable to delete|not found/i.test(message)) return;
    throw error;
  }
}

function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 2_000_000
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(redactSensitiveText((stderr || stdout || error.message).trim())));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function safeSummary(error: unknown): string {
  return truncateForDisplay(
    redactSensitiveText(error instanceof Error ? error.message : "Unknown feature completion error."),
    500
  );
}
