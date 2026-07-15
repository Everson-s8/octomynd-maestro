import { redactSensitiveText } from "../security/redaction.js";
import {
  CompletionEvidenceFact,
  CompletionEvidencePack,
  FeatureCompletionEvidenceSource
} from "./types.js";

const MAX_FACTS = 24;
const MAX_KEY_LENGTH = 80;
const MAX_VALUE_LENGTH = 1_000;

export function buildFeatureCompletionEvidencePack(
  feature: FeatureCompletionEvidenceSource,
  capturedAt = new Date().toISOString()
): CompletionEvidencePack {
  if (feature.status !== "completed") {
    throw new Error(`Feature #${feature.id} must be completed before completion review is enqueued.`);
  }
  if (!feature.reviewedHeadSha?.trim()) {
    throw new Error(`Feature #${feature.id} has no reviewed head SHA for completion review.`);
  }

  const completionVersion = bounded(feature.reviewedHeadSha, MAX_VALUE_LENGTH);
  const provenance = (field: string) => ({
    sourceType: "feature" as const,
    sourceId: String(feature.id),
    sourceVersion: completionVersion,
    field: bounded(field, MAX_KEY_LENGTH)
  });
  const fact = (key: string, value: string | null): CompletionEvidenceFact | null => {
    if (!value?.trim()) return null;
    return {
      key: bounded(key, MAX_KEY_LENGTH),
      value: bounded(value, MAX_VALUE_LENGTH),
      provenance: provenance(key)
    };
  };

  const facts = [
    fact("project_key", feature.projectKey),
    fact("name", feature.name),
    fact("objective", feature.objective),
    fact("pull_request_url", feature.pullRequestUrl),
    fact("reviewer_provider", feature.reviewerProvider),
    fact("review_summary", feature.reviewSummary),
    fact("reviewed_head_sha", feature.reviewedHeadSha),
    fact("merged_at", feature.mergedAt)
  ].filter((item): item is CompletionEvidenceFact => item !== null).slice(0, MAX_FACTS);

  return {
    schemaVersion: 1,
    subject: { type: "feature", id: String(feature.id), completionVersion },
    trigger: "feature_completed",
    capturedAt: bounded(capturedAt, MAX_VALUE_LENGTH),
    facts
  };
}

function bounded(value: string, maxLength: number): string {
  return redactSensitiveText(value.trim()).slice(0, maxLength);
}
