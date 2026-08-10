import { classifyWorkIntake } from "./classifier.js";
import { WorkIntakeCategory, WorkIntakeClassification, WorkIntakeInput, WorkIntakeMode } from "./types.js";

export interface WorkIntakeEvalCase {
  id: string;
  description: string;
  input: WorkIntakeInput;
  expectedCategory: WorkIntakeCategory;
  expectedDecisionMode: WorkIntakeMode;
  expectedActualMode: WorkIntakeMode;
  expectedOverrideApplied: boolean;
  maxAllowedOverheadMs: number;
}

export const WORK_INTAKE_EVAL_SUITE: WorkIntakeEvalCase[] = [
  {
    id: "eval-01-tiny-fix",
    description: "Tiny fix: Quick typo fix in config variable name",
    input: { text: "Fix typo in variable name in config.ts" },
    expectedCategory: "tiny_fix",
    expectedDecisionMode: "single_agent",
    expectedActualMode: "single_agent",
    expectedOverrideApplied: false,
    maxAllowedOverheadMs: 50
  },
  {
    id: "eval-02-documentation",
    description: "Documentation: Update user guide and README instructions",
    input: { text: "Update README documentation and user guide for installation steps" },
    expectedCategory: "documentation",
    expectedDecisionMode: "single_agent",
    expectedActualMode: "single_agent",
    expectedOverrideApplied: false,
    maxAllowedOverheadMs: 50
  },
  {
    id: "eval-03-audit",
    description: "Audit: Run security review and dependency audit",
    input: { text: "Run security audit and dependency vulnerability scan across project" },
    expectedCategory: "audit",
    expectedDecisionMode: "single_agent",
    expectedActualMode: "single_agent",
    expectedOverrideApplied: false,
    maxAllowedOverheadMs: 50
  },
  {
    id: "eval-04-multi-deliverable-feature",
    description: "Multi-deliverable feature: Implement authentication feature with REST API, UI, and DB migration",
    input: { text: "Implement JWT user authentication with DB migration, REST API endpoints, and login React UI" },
    expectedCategory: "multi_deliverable_feature",
    expectedDecisionMode: "feature_plan",
    expectedActualMode: "feature_plan",
    expectedOverrideApplied: false,
    maxAllowedOverheadMs: 50
  },
  {
    id: "eval-05-dependent-work",
    description: "Dependent work: Task depends on predecessor feature migration",
    input: { text: "Add billing integration after feature plan #12 auth migration is completed, depends on feature #12" },
    expectedCategory: "dependent_work",
    expectedDecisionMode: "feature_plan",
    expectedActualMode: "feature_plan",
    expectedOverrideApplied: false,
    maxAllowedOverheadMs: 50
  },
  {
    id: "eval-06-parallel-safe-work",
    description: "Parallel-safe work: Add independent background logger and parallel-safe worker",
    input: { text: "Add independent worker for background log exporter with parallel-safe execution" },
    expectedCategory: "parallel_safe_work",
    expectedDecisionMode: "work_graph",
    expectedActualMode: "work_graph",
    expectedOverrideApplied: false,
    maxAllowedOverheadMs: 50
  },
  {
    id: "eval-07-ambiguous-request",
    description: "Ambiguous request: Vague demand without details",
    input: { text: "fix it" },
    expectedCategory: "ambiguous_request",
    expectedDecisionMode: "needs_clarification",
    expectedActualMode: "needs_clarification",
    expectedOverrideApplied: false,
    maxAllowedOverheadMs: 50
  },
  {
    id: "eval-08-explicit-override",
    description: "Explicit override: Operator forces single_agent on a feature request",
    input: { text: "Implement complex billing UI --mode=single_agent" },
    expectedCategory: "explicit_override",
    expectedDecisionMode: "feature_plan",
    expectedActualMode: "single_agent",
    expectedOverrideApplied: true,
    maxAllowedOverheadMs: 50
  }
];

export interface EvalResultItem {
  caseId: string;
  description: string;
  passed: boolean;
  actual: WorkIntakeClassification;
  errors: string[];
}

export interface EvalSuiteReport {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  results: EvalResultItem[];
}

export function evaluateWorkIntakeClassifier(evalCases: WorkIntakeEvalCase[] = WORK_INTAKE_EVAL_SUITE): EvalSuiteReport {
  const startTime = Date.now();
  const results: EvalResultItem[] = [];
  let passedCount = 0;

  for (const testCase of evalCases) {
    const classification = classifyWorkIntake(testCase.input);
    const errors: string[] = [];

    if (classification.category !== testCase.expectedCategory) {
      errors.push(`Category mismatch: expected '${testCase.expectedCategory}', got '${classification.category}'`);
    }

    if (classification.decisionMode !== testCase.expectedDecisionMode) {
      errors.push(`Decision mode mismatch: expected '${testCase.expectedDecisionMode}', got '${classification.decisionMode}'`);
    }

    if (classification.actualMode !== testCase.expectedActualMode) {
      errors.push(`Actual mode mismatch: expected '${testCase.expectedActualMode}', got '${classification.actualMode}'`);
    }

    if (classification.overrideApplied !== testCase.expectedOverrideApplied) {
      errors.push(`Override applied mismatch: expected ${testCase.expectedOverrideApplied}, got ${classification.overrideApplied}`);
    }

    if (classification.estimatedOverheadMs > testCase.maxAllowedOverheadMs) {
      errors.push(`Overhead exceeded: ${classification.estimatedOverheadMs}ms > max ${testCase.maxAllowedOverheadMs}ms`);
    }

    const passed = errors.length === 0;
    if (passed) passedCount++;

    results.push({
      caseId: testCase.id,
      description: testCase.description,
      passed,
      actual: classification,
      errors
    });
  }

  const durationMs = Date.now() - startTime;
  return {
    total: evalCases.length,
    passed: passedCount,
    failed: evalCases.length - passedCount,
    durationMs,
    results
  };
}
