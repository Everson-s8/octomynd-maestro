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
import { redactSensitiveText, truncateForDisplay } from "../security/redaction.js";
import {
  FeatureGitHubGateway,
  FeaturePullRequestState,
  GhFeatureGateway,
  featureChecksPassed
} from "./github.js";

const REVIEW_SUMMARY_MAX_LENGTH = 2_000;

export type FeatureCompletion = {
  feature: FeatureRecord;
  items: Array<{
    item: FeatureItemRecord;
    task: TaskRecord;
    cleanup: "completed" | "pending";
  }>;
};

export type FeatureNotificationHandler = (completion: FeatureCompletion) => Promise<void>;

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
    private readonly pollIntervalMs = 15_000
  ) {}

  start(): void {
    if (this.timer) return;
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

  private async reconcileFeatures(): Promise<number> {
    let changes = 0;
    const features = this.database.listFeatures(100).filter((feature) => (
      feature.status !== "completed" && feature.status !== "failed"
    ));
    for (const feature of features) {
      if (this.active.has(feature.id)) continue;
      this.active.add(feature.id);
      try {
        changes += await this.reconcileFeature(feature);
      } catch (error) {
        const message = safeSummary(error);
        this.database.updateFeature({ id: feature.id, status: "failed", lastError: message });
        this.addEvent(feature, "feature.failed", message);
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
      this.database.updateFeature({ id: feature.id, status: "failed", lastError: message });
      this.addEvent(feature, "feature.closed_without_merge", message);
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
      await this.requestChanges(feature, "Feature PR has merge conflicts.");
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
        this.database.updateFeature({
          id: feature.id,
          status: "waiting_provider",
          lastError: "No reviewing provider is currently available."
        });
        this.addEvent(feature, "feature.waiting_provider", "Final review is waiting for a provider.");
        return;
      }
      let result;
      try {
        result = await lease.provider.execute(this.buildReviewRequest(feature, state));
      } finally {
        lease.release();
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
        await this.requestChanges(feature, reviewSummary, lease.provider.id);
        return;
      }
      if (result.outcome === "failed" && result.retryable) {
        excluded.add(lease.provider.id);
        continue;
      }
      await this.requestChanges(feature, reviewSummary || result.summary, lease.provider.id);
      return;
    }
  }

  private async mergeReviewedFeature(
    feature: FeatureRecord,
    reviewedState: FeaturePullRequestState,
    providerId: AgentProviderId,
    reviewSummary: string
  ): Promise<void> {
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
    summary: string,
    providerId: AgentProviderId | null = null
  ): Promise<void> {
    await this.github.markDraft(feature.pullRequestUrl);
    const safe = truncateForDisplay(redactSensitiveText(summary), REVIEW_SUMMARY_MAX_LENGTH);
    this.database.updateFeature({
      id: feature.id,
      status: "changes_requested",
      reviewerProvider: providerId,
      reviewSummary: safe,
      lastError: safe
    });
    this.addEvent(feature, "feature.changes_requested", safe);
  }

  private async completeFeature(feature: FeatureRecord, state: FeaturePullRequestState): Promise<void> {
    if (feature.status === "completed") return;
    const project = this.database.getProjectByKey(feature.projectKey);
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

    try {
      await this.github.deleteHeadBranch(feature.pullRequestUrl);
    } catch (error) {
      workPullRequestPending = true;
      this.addEvent(feature, "feature.branch_delete_failed", safeSummary(error));
    }

    if (workPullRequestPending) {
      const message = "Feature merged, but one or more integrated branches still need cleanup.";
      this.database.updateFeature({ id: feature.id, status: "merging", lastError: message });
      this.addEvent(feature, "feature.work_pr_cleanup_pending", message);
      return;
    }

    const completed = this.database.updateFeature({
      id: feature.id,
      status: "completed",
      lastError: null,
      mergedAt: new Date().toISOString()
    });
    this.addEvent(completed, "feature.completed", `Feature PR #${state.number} merged and child work closed.`);
    if (this.notifyCompleted) {
      try {
        await this.notifyCompleted({ feature: completed, items: completedItems });
      } catch (error) {
        this.addEvent(completed, "feature.notification_failed", safeSummary(error));
      }
    }
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
