import { WorkIntakeDecision } from "./types.js";

export function explainWorkIntakeDecision(decision: WorkIntakeDecision): string {
  switch (decision.reasonCode) {
    case "single_bounded_objective":
      return "Request has one bounded objective. Classified as a Direct Task.";
    case "coordination_required":
      return "Request requires dependency coordination or multiple parallel flows. Classified as a Feature Plan.";
    case "multiple_acceptance_units":
      return "Request has multiple acceptance units or a broad change volume. Classified as a Feature Plan.";
    case "missing_objective":
      return "Objective is missing or blank. Clarification is required before proceeding.";
    case "missing_acceptance_criteria":
      return "Objective is vague and lacks sufficient acceptance criteria. Clarification is required.";
    case "explicit_override_direct_task":
      return "Explicit user override applied: Direct Task.";
    case "explicit_override_feature_plan":
      return "Explicit user override applied: Feature Plan.";
    case "explicit_override_needs_clarification":
      return "Explicit user override applied: Needs Clarification.";
    case "fallback_needs_clarification":
    default:
      return "Classification is uncertain. Clarification is required.";
  }
}
