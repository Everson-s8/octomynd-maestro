import crypto from "node:crypto";
import { redactSensitiveText } from "../security/redaction.js";
import { buildWorkIntakeEvidencePack } from "./evidence.js";
import {
  WORK_INTAKE_POLICY_VERSION,
  WorkIntakeClassification,
  WorkIntakeCoordinationSignal,
  WorkIntakeCostEstimate,
  WorkIntakeDecision,
  WorkIntakeInput,
  WorkIntakeReasonCode
} from "./types.js";

export function computeWorkIntakeId(
  input: WorkIntakeInput & { channel?: string; userId?: string }
): string {
  if (input.id && input.id.trim()) {
    return input.id.trim();
  }
  const payload = [
    input.channel || "api",
    input.userId || "anonymous",
    input.projectKey || "",
    (input.objective || "").trim(),
    ...(input.acceptanceCriteria || []).map((c) => c.trim())
  ].join(":");
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

export function classifyWorkIntake(
  input: WorkIntakeInput,
  now: string = new Date().toISOString()
): WorkIntakeDecision {
  const objective = redactSensitiveText(input.objective ?? "").trim();
  const acceptanceCriteria = (input.acceptanceCriteria ?? [])
    .map((criterion) => redactSensitiveText(criterion.trim()))
    .filter(Boolean);

  const id = input.id ? redactSensitiveText(input.id.trim()) : crypto.randomUUID();
  const projectKey = input.projectKey ? redactSensitiveText(input.projectKey.trim()) : null;

  const coordination: WorkIntakeCoordinationSignal = {
    dependsOnCount: Math.max(0, Math.trunc(input.coordination?.dependsOnCount ?? 0)),
    parallelWorkstreamCount: Math.max(1, Math.trunc(input.coordination?.parallelWorkstreamCount ?? 1)),
    requiresMultipleReviewGates: Boolean(input.coordination?.requiresMultipleReviewGates)
  };

  const costEstimate: WorkIntakeCostEstimate = {
    estimatedFileTouchCount: Math.max(0, Math.trunc(input.costEstimate?.estimatedFileTouchCount ?? 1)),
    estimatedWorkstreamCount: Math.max(
      1,
      Math.trunc(input.costEstimate?.estimatedWorkstreamCount ?? coordination.parallelWorkstreamCount)
    )
  };

  const explicitOverride = input.explicitOverride ?? null;

  let classification: WorkIntakeClassification;
  let reasonCode: WorkIntakeReasonCode;
  let confidence: number;

  if (explicitOverride) {
    if (explicitOverride === "direct_task") {
      classification = "direct_task";
      reasonCode = "explicit_override_direct_task";
      confidence = 1.0;
    } else if (explicitOverride === "feature_plan") {
      classification = "feature_plan";
      reasonCode = "explicit_override_feature_plan";
      confidence = 1.0;
    } else if (explicitOverride === "needs_clarification") {
      classification = "needs_clarification";
      reasonCode = "explicit_override_needs_clarification";
      confidence = 1.0;
    } else {
      classification = "needs_clarification";
      reasonCode = "fallback_needs_clarification";
      confidence = 0.8;
    }
  } else if (!objective) {
    classification = "needs_clarification";
    reasonCode = "missing_objective";
    confidence = 1.0;
  } else if (
    coordination.dependsOnCount > 0 ||
    coordination.parallelWorkstreamCount > 1 ||
    coordination.requiresMultipleReviewGates ||
    costEstimate.estimatedWorkstreamCount > 1
  ) {
    classification = "feature_plan";
    reasonCode = "coordination_required";
    confidence = 0.95;
  } else if (acceptanceCriteria.length > 3 || costEstimate.estimatedFileTouchCount > 10) {
    classification = "feature_plan";
    reasonCode = "multiple_acceptance_units";
    confidence = 0.9;
  } else if (acceptanceCriteria.length === 0 && (objective.length < 5 || objective === "...")) {
    classification = "needs_clarification";
    reasonCode = "missing_acceptance_criteria";
    confidence = 0.85;
  } else {
    classification = "direct_task";
    reasonCode = "single_bounded_objective";
    confidence = 0.95;
  }

  const rawFacts = [
    { key: "objective", value: objective, field: "objective" },
    { key: "classification", value: classification, field: "classification" },
    { key: "reason_code", value: reasonCode, field: "reasonCode" },
    { key: "confidence", value: String(confidence), field: "confidence" },
    { key: "policy_version", value: String(WORK_INTAKE_POLICY_VERSION), field: "policyVersion" },
    { key: "depends_on_count", value: String(coordination.dependsOnCount), field: "coordination.dependsOnCount" },
    {
      key: "parallel_workstream_count",
      value: String(coordination.parallelWorkstreamCount),
      field: "coordination.parallelWorkstreamCount"
    },
    {
      key: "requires_multiple_review_gates",
      value: String(coordination.requiresMultipleReviewGates),
      field: "coordination.requiresMultipleReviewGates"
    },
    {
      key: "estimated_file_touch_count",
      value: String(costEstimate.estimatedFileTouchCount),
      field: "costEstimate.estimatedFileTouchCount"
    },
    {
      key: "estimated_workstream_count",
      value: String(costEstimate.estimatedWorkstreamCount),
      field: "costEstimate.estimatedWorkstreamCount"
    },
    { key: "acceptance_criteria_count", value: String(acceptanceCriteria.length), field: "acceptanceCriteria" },
    { key: "explicit_override", value: explicitOverride ?? "none", field: "explicitOverride" }
  ];

  const evidence = buildWorkIntakeEvidencePack(id, rawFacts, now);

  return {
    id,
    projectKey,
    objective,
    classification,
    reasonCode,
    confidence,
    policyVersion: WORK_INTAKE_POLICY_VERSION,
    coordination,
    costEstimate,
    acceptanceCriteria,
    explicitOverride,
    evidence,
    createdAt: now
  };
}
