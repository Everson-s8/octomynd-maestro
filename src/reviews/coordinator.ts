import { HumanReviewDecision, HumanReviewRecord, MaestroDatabase } from "../db.js";
import { GoalCoordinator } from "../goals/coordinator.js";
import { buildReviewQueueItem, listReviewQueue, ReviewQueueItem } from "./evidence.js";
import { GhReviewGateway, ReviewGitHubGateway } from "./github.js";
import { containsSensitiveText } from "../security/redaction.js";
import { PullRequestState } from "./github.js";

export type ReviewDecisionNotifier = (
  item: ReviewQueueItem,
  decision: HumanReviewRecord
) => Promise<void>;

export type ReviewSyncState = PullRequestState["state"] | "READY" | "DRAFT";
export type ReviewSyncNotifier = (item: ReviewQueueItem, state: ReviewSyncState) => Promise<void>;

export class ReviewCoordinator {
  private lastReconciledAt = 0;
  private reconcilePromise: Promise<number> | null = null;

  constructor(
    private readonly database: MaestroDatabase,
    private readonly goals: GoalCoordinator,
    private readonly github: ReviewGitHubGateway = new GhReviewGateway(),
    private readonly notify?: ReviewDecisionNotifier,
    private readonly notifySync?: ReviewSyncNotifier
  ) {}

  list(): ReviewQueueItem[] {
    return listReviewQueue(this.database);
  }

  get(runId: number): ReviewQueueItem {
    return buildReviewQueueItem(this.database, runId);
  }

  reconcile(force = false): Promise<number> {
    const now = Date.now();
    if (!force && now - this.lastReconciledAt < 15_000) return Promise.resolve(0);
    if (this.reconcilePromise) return this.reconcilePromise;
    this.lastReconciledAt = now;
    this.reconcilePromise = this.reconcilePullRequests().finally(() => {
      this.reconcilePromise = null;
    });
    return this.reconcilePromise;
  }

  async decide(
    runId: number,
    decision: HumanReviewDecision,
    note: string,
    source = "dashboard"
  ): Promise<{ review: HumanReviewRecord; item: ReviewQueueItem }> {
    const item = this.get(runId);
    if (item.status === "approved" || item.status === "rejected") {
      throw new Error(`Goal #${runId} already has a final human decision.`);
    }
    if (!note.trim()) throw new Error("Decision justification is required.");
    if (note.trim().length > 1_200) throw new Error("Decision justification exceeds 1200 characters.");
    if (containsSensitiveText(note)) {
      throw new Error("Decision justification contains a secret or private local path.");
    }
    if (decision === "approved" && item.securityAlerts.some((alert) => alert.severity === "high")) {
      throw new Error("High-severity security alerts must be resolved before approval.");
    }

    if (decision === "approved") await this.github.markReady(item.pullRequestUrl);
    if (decision === "changes_requested") await this.github.markDraft(item.pullRequestUrl);
    if (decision === "rejected") await this.github.close(item.pullRequestUrl);

    const review = this.database.addHumanReview({ runId, decision, note, source });
    this.database.addEvent({
      source: "human",
      type: `review.${decision}`,
      text: `Human decision for goal #${runId}: ${decision}`,
      taskId: item.taskId,
      metadata: { runId, reviewId: review.id, decision }
    });

    if (decision === "approved") this.database.updateTaskStatus(item.taskId, "ready_to_merge");
    if (decision === "rejected") this.database.updateTaskStatus(item.taskId, "rejected");
    if (decision === "changes_requested") this.goals.requestChanges(runId);

    const updatedItem = this.get(runId);
    if (this.notify) {
      try {
        await this.notify(updatedItem, review);
      } catch (error) {
        this.database.addEvent({
          source: "maestro",
          type: "review.notification_failed",
          text: error instanceof Error ? error.message : "Unknown review notification error.",
          taskId: item.taskId,
          metadata: { runId, reviewId: review.id, decision }
        });
      }
    }
    return { review, item: updatedItem };
  }

  private async reconcilePullRequests(): Promise<number> {
    let changes = 0;
    const candidates = this.database.listGoalRuns(100).filter((run) => {
      if (!run.pullRequestUrl || run.status !== "completed") return false;
      const status = this.database.getTask(run.taskId).status;
      return status === "awaiting_human" || status === "ready_to_merge";
    });

    for (const run of candidates) {
      try {
        const state = await this.github.inspect(run.pullRequestUrl!);
        const task = this.database.getTask(run.taskId);
        let nextStatus = task.status;
        let syncState: ReviewSyncState | null = null;

        if (state.state === "MERGED") {
          nextStatus = "done";
          syncState = "MERGED";
        } else if (state.state === "CLOSED") {
          nextStatus = "rejected";
          syncState = "CLOSED";
        } else if (!state.isDraft && task.status === "awaiting_human") {
          nextStatus = "ready_to_merge";
          syncState = "READY";
        } else if (state.isDraft && task.status === "ready_to_merge") {
          nextStatus = "awaiting_human";
          syncState = "DRAFT";
        }

        if (!syncState || nextStatus === task.status) continue;
        this.database.updateTaskStatus(task.id, nextStatus);
        this.database.addEvent({
          source: "github",
          type: `review.sync_${syncState.toLowerCase()}`,
          text: `GitHub pull request is ${syncState.toLowerCase()} for goal #${run.id}.`,
          taskId: task.id,
          metadata: { runId: run.id, state: syncState }
        });
        changes += 1;

        if (this.notifySync) {
          const item = buildReviewQueueItem(this.database, run);
          await this.notifySync(item, syncState).catch(() => undefined);
        }
      } catch {
        // Reconciliation is best-effort; dashboard availability must not depend on GitHub CLI.
      }
    }
    return changes;
  }
}
