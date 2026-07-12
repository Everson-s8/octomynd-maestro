import { HumanReviewDecision, HumanReviewRecord, MaestroDatabase } from "../db.js";
import { GoalCoordinator } from "../goals/coordinator.js";
import { buildReviewQueueItem, listReviewQueue, ReviewQueueItem } from "./evidence.js";
import { GhReviewGateway, ReviewGitHubGateway } from "./github.js";
import { containsSensitiveText } from "../security/redaction.js";

export type ReviewDecisionNotifier = (
  item: ReviewQueueItem,
  decision: HumanReviewRecord
) => Promise<void>;

export class ReviewCoordinator {
  constructor(
    private readonly database: MaestroDatabase,
    private readonly goals: GoalCoordinator,
    private readonly github: ReviewGitHubGateway = new GhReviewGateway(),
    private readonly notify?: ReviewDecisionNotifier
  ) {}

  list(): ReviewQueueItem[] {
    return listReviewQueue(this.database);
  }

  get(runId: number): ReviewQueueItem {
    return buildReviewQueueItem(this.database, runId);
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
}
