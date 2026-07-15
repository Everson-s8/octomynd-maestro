export const COMPLETION_REVIEW_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "waiting_provider",
  "failed"
] as const;

export type CompletionReviewStatus = typeof COMPLETION_REVIEW_STATUSES[number];
export type CompletionReviewSubjectType = "feature";

export type EvidenceProvenance = {
  sourceType: "feature";
  sourceId: string;
  sourceVersion: string;
  field: string;
};

export type CompletionEvidenceFact = {
  key: string;
  value: string;
  provenance: EvidenceProvenance;
};

export type CompletionEvidencePack = {
  schemaVersion: 1;
  subject: {
    type: CompletionReviewSubjectType;
    id: string;
    completionVersion: string;
  };
  trigger: "feature_completed";
  capturedAt: string;
  facts: CompletionEvidenceFact[];
};

export type FeatureCompletionEvidenceSource = {
  id: number;
  status: string;
  projectKey: string;
  name: string;
  objective: string;
  pullRequestUrl: string;
  reviewerProvider: string | null;
  reviewSummary: string | null;
  reviewedHeadSha: string | null;
  mergedAt: string | null;
};

export type CompletionReviewRecord = {
  id: number;
  subjectType: CompletionReviewSubjectType;
  subjectId: string;
  completionVersion: string;
  status: CompletionReviewStatus;
  evidence: CompletionEvidencePack;
  attemptCount: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type CompletionReviewClaimInput = {
  workerId: string;
  leaseMs: number;
  now?: Date;
};

export type CompletionReviewFinishStatus = Extract<
  CompletionReviewStatus,
  "succeeded" | "waiting_provider" | "failed"
>;
