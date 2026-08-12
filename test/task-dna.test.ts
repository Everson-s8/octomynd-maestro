import { describe, it, expect } from "vitest";
import {
  computeTaskDNA,
  computeTaskDNAFromText,
  type TaskDNA,
} from "../src/goals/task-dna.js";
import type { WorkIntakeDecision } from "../src/intake/types.js";

function makeIntake(overrides: Partial<WorkIntakeDecision> = {}): WorkIntakeDecision {
  return {
    id: "test-1",
    projectKey: "maestro",
    objective: "Test task",
    classification: "direct_task",
    reasonCode: "single_bounded_objective",
    confidence: 0.95,
    policyVersion: 1,
    coordination: {
      dependsOnCount: 0,
      parallelWorkstreamCount: 1,
      requiresMultipleReviewGates: false,
    },
    costEstimate: {
      estimatedFileTouchCount: 1,
      estimatedWorkstreamCount: 1,
    },
    acceptanceCriteria: [],
    explicitOverride: null,
    evidence: {
      schemaVersion: 1,
      subject: { type: "work_intake", id: "test-1", policyVersion: 1 },
      capturedAt: new Date().toISOString(),
      facts: [],
    },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("computeTaskDNA", () => {
  it("classifies trivial tasks (1 file, no deps, 1 criterion)", () => {
    const dna = computeTaskDNA(
      makeIntake({
        costEstimate: { estimatedFileTouchCount: 1, estimatedWorkstreamCount: 1 },
        acceptanceCriteria: ["Fix the typo"],
      })
    );
    expect(dna.complexity).toBe("trivial");
    expect(dna.phases).toEqual(["implementing"]);
    expect(dna.requireReview).toBe(false);
    expect(dna.requireTests).toBe(false);
    expect(dna.allowIteration).toBe(false);
  });

  it("classifies small tasks (3 files, no deps)", () => {
    const dna = computeTaskDNA(
      makeIntake({
        costEstimate: { estimatedFileTouchCount: 3, estimatedWorkstreamCount: 1 },
        acceptanceCriteria: ["Add utility function", "Add tests"],
      })
    );
    expect(dna.complexity).toBe("small");
    expect(dna.phases).toEqual(["implementing", "testing"]);
    expect(dna.requireReview).toBe(false);
    expect(dna.requireTests).toBe(true);
  });

  it("classifies medium tasks (8 files, 1 workstream)", () => {
    const dna = computeTaskDNA(
      makeIntake({
        costEstimate: { estimatedFileTouchCount: 8, estimatedWorkstreamCount: 1 },
        acceptanceCriteria: ["A", "B", "C", "D"],
      })
    );
    expect(dna.complexity).toBe("medium");
    expect(dna.phases).toEqual(["planning", "implementing", "testing", "reviewing"]);
    expect(dna.requireReview).toBe(true);
    expect(dna.allowIteration).toBe(true);
  });

  it("classifies large tasks (15 files or multiple workstreams)", () => {
    const dna = computeTaskDNA(
      makeIntake({
        costEstimate: { estimatedFileTouchCount: 15, estimatedWorkstreamCount: 3 },
        coordination: { dependsOnCount: 2, parallelWorkstreamCount: 3, requiresMultipleReviewGates: true },
        acceptanceCriteria: ["A", "B", "C", "D", "E", "F"],
      })
    );
    expect(dna.complexity).toBe("large");
    expect(dna.phases).toEqual(["planning", "implementing", "testing", "reviewing"]);
    expect(dna.phaseBudgets.implementing).toBe(8);
  });

  it("upgrades to medium when dependencies exist", () => {
    const dna = computeTaskDNA(
      makeIntake({
        costEstimate: { estimatedFileTouchCount: 3, estimatedWorkstreamCount: 2 },
        coordination: { dependsOnCount: 1, parallelWorkstreamCount: 2, requiresMultipleReviewGates: false },
      })
    );
    // 3 files but 2 workstreams → medium
    expect(dna.complexity).toBe("medium");
  });

  it("phase budgets never exceed reasonable limits", () => {
    const dna = computeTaskDNA(
      makeIntake({
        costEstimate: { estimatedFileTouchCount: 50, estimatedWorkstreamCount: 10 },
        coordination: { dependsOnCount: 5, parallelWorkstreamCount: 10, requiresMultipleReviewGates: true },
      })
    );
    // Even large tasks should have bounded budgets
    const totalBudget = Object.values(dna.phaseBudgets).reduce((a, b) => a + b, 0);
    expect(totalBudget).toBeLessThanOrEqual(20);
  });
});

describe("computeTaskDNAFromText", () => {
  it("classifies short fix as trivial", () => {
    const dna = computeTaskDNAFromText("Fix typo in README.md");
    expect(dna.complexity).toBe("trivial");
    expect(dna.phases).toEqual(["implementing"]);
  });

  it("classifies feature request as small", () => {
    const dna = computeTaskDNAFromText("Add a validation function for email input");
    expect(dna.complexity).toBe("small");
    expect(dna.phases).toContain("implementing");
    expect(dna.phases).toContain("testing");
  });

  it("classifies architecture task as medium", () => {
    const dna = computeTaskDNAFromText(
      "Refactor the authentication module to support OAuth2 and update the middleware pipeline"
    );
    expect(dna.complexity).toBe("medium");
    expect(dna.phases).toContain("planning");
    expect(dna.phases).toContain("reviewing");
  });

  it("classifies long complex task as large", () => {
    const dna = computeTaskDNAFromText(
      "Implement a complete user management system with registration, login, password reset, " +
      "profile management, role-based access control, and email verification. Also add " +
      "comprehensive tests, API documentation, and migration scripts for the existing database."
    );
    expect(dna.complexity).toBe("large");
    expect(dna.phaseBudgets.implementing).toBe(8);
  });

  it("never returns null — always a valid DNA", () => {
    const dna = computeTaskDNAFromText("");
    expect(dna).toBeDefined();
    expect(dna.complexity).toBeDefined();
    expect(dna.phases.length).toBeGreaterThan(0);
  });
});
