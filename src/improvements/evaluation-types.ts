export const IMPROVEMENT_CATEGORIES = ["skill", "memory", "routing", "policy", "integration"] as const;
export const IMPROVEMENT_RISKS = ["low", "medium", "high"] as const;

export type ImprovementCategory = typeof IMPROVEMENT_CATEGORIES[number];
export type ImprovementRisk = typeof IMPROVEMENT_RISKS[number];

export type CandidateDraft = {
  category: ImprovementCategory;
  title: string;
  rationale: string;
  proposedChange: string;
  targets: string[];
  evidenceIds: string[];
  risk: ImprovementRisk;
  confidence: number;
};

export type SanitizedCandidateDraft = CandidateDraft;

export type AllowedEvidence = {
  id: string;
  sourceId: string;
};

export type EvaluationReasonCode =
  | "invalid_category"
  | "invalid_risk"
  | "invalid_confidence"
  | "missing_field"
  | "field_too_large"
  | "invalid_target_count"
  | "invalid_evidence_count"
  | "duplicate_evidence"
  | "evidence_not_allowed"
  | "protected_target"
  | "confidence_below_floor"
  | "single_source_high_risk"
  | "duplicate_candidate"
  | "invalid_fingerprint";

export type EvaluationReason = {
  code: EvaluationReasonCode;
  message: string;
  field?: keyof CandidateDraft;
};

export type EvaluationLimits = {
  maxTitleLength: number;
  maxRationaleLength: number;
  maxProposedChangeLength: number;
  maxTargets: number;
  maxTargetLength: number;
  maxEvidence: number;
  maxEvidenceIdLength: number;
};

export type CandidateFingerprintHook = (candidate: SanitizedCandidateDraft) => string;
