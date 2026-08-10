export type WorkIntakeCategory =
  | "tiny_fix"
  | "documentation"
  | "audit"
  | "multi_deliverable_feature"
  | "dependent_work"
  | "parallel_safe_work"
  | "ambiguous_request"
  | "explicit_override";

export type WorkIntakeMode =
  | "single_agent"
  | "feature_plan"
  | "work_graph"
  | "needs_clarification";

export interface WorkIntakeClassification {
  id?: number;
  taskId: number;
  category: WorkIntakeCategory;
  decisionMode: WorkIntakeMode;
  actualMode: WorkIntakeMode;
  overrideMode?: WorkIntakeMode | null;
  score: number;
  reasons: string[];
  estimatedOverheadMs: number;
  priorWorkflowOverheadMs: number;
  overrideApplied: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkIntakeInput {
  taskId?: number;
  text: string;
  overrideMode?: WorkIntakeMode | null;
  projectKey?: string | null;
}

export interface WorkIntakeMetrics {
  totalClassifications: number;
  categoryCounts: Record<WorkIntakeCategory, number>;
  modeCounts: Record<WorkIntakeMode, number>;
  overrideCount: number;
  averageOverheadMs: number;
  averagePriorWorkflowOverheadMs: number;
  overheadReductionRatio: number;
}
