import { MaestroDatabase } from "../db.js";
import { CompletionReviewClaimInput, CompletionReviewRecord } from "./types.js";

export class CompletionReviewOutbox {
  constructor(private readonly database: MaestroDatabase) {}

  reconcileCompletedFeatures(limit = 100): number {
    let enqueued = 0;
    for (const feature of this.database.listFeatures(limit)) {
      if (feature.status !== "completed" || !feature.reviewedHeadSha) continue;
      const before = this.database.findCompletionReview("feature", String(feature.id), feature.reviewedHeadSha);
      this.database.enqueueFeatureCompletionReview(feature.id);
      if (!before) enqueued += 1;
    }
    return enqueued;
  }

  claim(input: CompletionReviewClaimInput): CompletionReviewRecord | null {
    return this.database.claimCompletionReview(input);
  }
}
