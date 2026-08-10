export const WORK_INTAKE_POLICY_VERSION = 1 as const;

export type WorkIntakeClassification =
  | "direct_task"
  | "feature_plan"
  | "needs_clarification";

export type WorkIntakeReasonCode =
  | "missing_objective"
  | "missing_acceptance_criteria"
  | "single_bounded_objective"
  | "multiple_acceptance_units"
  | "coordination_required"
  | "explicit_override_direct_task"
  | "explicit_override_feature_plan"
  | "explicit_override_needs_clarification"
  | "fallback_needs_clarification";

export type WorkIntakeCoordinationSignal = {
  dependsOnCount: number;
  parallelWorkstreamCount: number;
  requiresMultipleReviewGates: boolean;
};

export type WorkIntakeCostEstimate = {
  estimatedFileTouchCount: number;
  estimatedWorkstreamCount: number;
};

export type WorkIntakeInput = {
  id?: string;
  projectKey?: string;
  objective: string;
  acceptanceCriteria?: string[];
  coordination?: Partial<WorkIntakeCoordinationSignal>;
  costEstimate?: Partial<WorkIntakeCostEstimate>;
  explicitOverride?: WorkIntakeClassification | null;
};

export type WorkIntakeEvidenceFact = {
  key: string;
  value: string;
  provenance: {
    sourceType: "work_intake";
    sourceId: string;
    sourceVersion: string;
    field: string;
  };
};

export type WorkIntakeEvidencePack = {
  schemaVersion: 1;
  subject: {
    type: "work_intake";
    id: string;
    policyVersion: typeof WORK_INTAKE_POLICY_VERSION;
  };
  capturedAt: string;
  facts: WorkIntakeEvidenceFact[];
};

export type WorkIntakeDecision = {
  id: string;
  projectKey: string | null;
  objective: string;
  classification: WorkIntakeClassification;
  reasonCode: WorkIntakeReasonCode;
  confidence: number;
  policyVersion: typeof WORK_INTAKE_POLICY_VERSION;
  coordination: WorkIntakeCoordinationSignal;
  costEstimate: WorkIntakeCostEstimate;
  acceptanceCriteria: string[];
  explicitOverride: WorkIntakeClassification | null;
  evidence: WorkIntakeEvidencePack;
  createdAt: string;
};
