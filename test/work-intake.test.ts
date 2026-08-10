import { describe, expect, it } from "vitest";
import { classifyWorkIntake } from "../src/intake/policy.js";
import { explainWorkIntakeDecision } from "../src/intake/explanation.js";
import { WORK_INTAKE_POLICY_VERSION } from "../src/intake/types.js";

describe("Work Intake domain policy", () => {
  it("classifies a single bounded objective as direct_task even when touching multiple files", () => {
    const decision = classifyWorkIntake({
      objective: "Refactor database migration helper to add column checks",
      costEstimate: {
        estimatedFileTouchCount: 5,
        estimatedWorkstreamCount: 1
      },
      acceptanceCriteria: [
        "Add helper function in src/db.ts",
        "Add unit test in test/db.test.ts"
      ]
    });

    expect(decision.classification).toBe("direct_task");
    expect(decision.reasonCode).toBe("single_bounded_objective");
    expect(decision.confidence).toBe(0.95);
    expect(decision.policyVersion).toBe(WORK_INTAKE_POLICY_VERSION);
    expect(decision.evidence.schemaVersion).toBe(1);
    expect(decision.evidence.subject.type).toBe("work_intake");
    expect(decision.evidence.facts.find((f) => f.key === "reason_code")?.value).toBe(
      "single_bounded_objective"
    );
  });

  it("classifies as feature_plan when explicit coordination signals are present", () => {
    const decision = classifyWorkIntake({
      objective: "Implement multi-service authentication sync",
      coordination: {
        dependsOnCount: 2,
        parallelWorkstreamCount: 2,
        requiresMultipleReviewGates: true
      }
    });

    expect(decision.classification).toBe("feature_plan");
    expect(decision.reasonCode).toBe("coordination_required");
    expect(decision.confidence).toBe(0.95);
    expect(decision.coordination.dependsOnCount).toBe(2);
    expect(decision.coordination.requiresMultipleReviewGates).toBe(true);
  });

  it("classifies as feature_plan when multiple acceptance units or large file touch counts are present", () => {
    const decision = classifyWorkIntake({
      objective: "Refactor core UI layout and themes",
      acceptanceCriteria: [
        "Update header component",
        "Update sidebar component",
        "Update footer component",
        "Update dark theme tokens",
        "Update high-contrast tokens"
      ]
    });

    expect(decision.classification).toBe("feature_plan");
    expect(decision.reasonCode).toBe("multiple_acceptance_units");
    expect(decision.confidence).toBe(0.9);
  });

  it("classifies as needs_clarification when objective is missing or empty", () => {
    const decision = classifyWorkIntake({
      objective: "   "
    });

    expect(decision.classification).toBe("needs_clarification");
    expect(decision.reasonCode).toBe("missing_objective");
    expect(decision.confidence).toBe(1.0);
  });

  it("classifies as needs_clarification when objective is extremely short/vague without acceptance criteria", () => {
    const decision = classifyWorkIntake({
      objective: "fix"
    });

    expect(decision.classification).toBe("needs_clarification");
    expect(decision.reasonCode).toBe("missing_acceptance_criteria");
    expect(decision.confidence).toBe(0.85);
  });

  it("honors explicit governed overrides over automatic signals", () => {
    const overriddenToDirect = classifyWorkIntake({
      objective: "Complex multi-team architecture overhaul",
      coordination: {
        dependsOnCount: 5,
        parallelWorkstreamCount: 4,
        requiresMultipleReviewGates: true
      },
      explicitOverride: "direct_task"
    });

    expect(overriddenToDirect.classification).toBe("direct_task");
    expect(overriddenToDirect.reasonCode).toBe("explicit_override_direct_task");
    expect(overriddenToDirect.confidence).toBe(1.0);

    const overriddenToFeature = classifyWorkIntake({
      objective: "Simple single-file doc fix",
      explicitOverride: "feature_plan"
    });

    expect(overriddenToFeature.classification).toBe("feature_plan");
    expect(overriddenToFeature.reasonCode).toBe("explicit_override_feature_plan");
    expect(overriddenToFeature.confidence).toBe(1.0);

    const overriddenToClarification = classifyWorkIntake({
      objective: "Well-defined bug fix with complete details",
      explicitOverride: "needs_clarification"
    });

    expect(overriddenToClarification.classification).toBe("needs_clarification");
    expect(overriddenToClarification.reasonCode).toBe("explicit_override_needs_clarification");
    expect(overriddenToClarification.confidence).toBe(1.0);
  });

  it("redacts sensitive text and local paths in objectives and acceptance criteria", () => {
    const sampleSkToken = ["sk-1234567890", "abcdef1234567890abcdef"].join("");
    const sampleGhpToken = ["ghp_1234567890", "abcdef1234567890abcdef"].join("");
    const decision = classifyWorkIntake({
      objective: `Fix token ${sampleSkToken} at C:\\Users\\evers\\secret.txt`,
      acceptanceCriteria: [
        `Check /home/user/private/config.json for bearer token ${sampleGhpToken}`
      ]
    });

    expect(decision.objective).not.toContain(sampleSkToken);
    expect(decision.objective).not.toContain("C:\\Users\\evers");
    expect(decision.acceptanceCriteria[0]).not.toContain(sampleGhpToken);
    expect(decision.acceptanceCriteria[0]).not.toContain("/home/user");
  });

  it("provides concise Portuguese explanations for internal decisions", () => {
    const directDecision = classifyWorkIntake({ objective: "Single bounded bug fix" });
    const featureDecision = classifyWorkIntake({
      objective: "Multi-service feature",
      coordination: { dependsOnCount: 2 }
    });
    const clarifyDecision = classifyWorkIntake({ objective: "" });

    expect(explainWorkIntakeDecision(directDecision)).toContain("Tarefa Direta");
    expect(explainWorkIntakeDecision(featureDecision)).toContain("Plano de Funcionalidade");
    expect(explainWorkIntakeDecision(clarifyDecision)).toContain("clarificação");
  });
});
