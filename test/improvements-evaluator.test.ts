import { describe, expect, it } from "vitest";
import {
  defaultCandidateFingerprint,
  evaluateCandidate,
  EvaluateCandidateInput
} from "../src/improvements/evaluator.js";
import { CandidateDraft } from "../src/improvements/evaluation-types.js";

const allowedEvidence = [
  { id: "task:10", sourceId: "task:10" },
  { id: "review:10", sourceId: "task:10" },
  { id: "task:11", sourceId: "task:11" }
];

function draft(overrides: Partial<CandidateDraft> = {}): CandidateDraft {
  return {
    category: "skill",
    title: "Improve retry guidance",
    rationale: "Two completed runs show unclear retry instructions.",
    proposedChange: "Add a bounded retry example to the agent-owned playbook.",
    targets: ["agent-owned/retry-playbook"],
    evidenceIds: ["task:10"],
    risk: "low",
    confidence: 0.8,
    ...overrides
  };
}

function input(candidate: CandidateDraft, overrides: Partial<EvaluateCandidateInput> = {}): EvaluateCandidateInput {
  return {
    draft: candidate,
    allowedEvidence,
    origin: { kind: "background-review", author: "reviewer", runId: "review-run:7" },
    createdAt: "2026-07-14T12:00:00.000Z",
    evaluatedAt: "2026-07-14T12:01:00.000Z",
    ...overrides
  };
}

describe("improvement candidate evaluator", () => {
  it("accepts a bounded candidate and records complete provenance", () => {
    const result = evaluateCandidate(input(draft()));

    expect(result.decision).toBe("accepted");
    expect(result.reasons).toEqual([]);
    expect(result.provenance).toMatchObject({
      origin: { kind: "background-review", author: "reviewer", runId: "review-run:7" },
      evidenceIds: ["task:10"],
      evidenceSourceIds: ["task:10"],
      declaredRisk: "low",
      effectiveRisk: "low",
      confidence: 0.8
    });
    expect(result.provenance.fingerprint).toHaveLength(64);
  });

  it("sanitizes secrets, private paths, whitespace and control characters", () => {
    const result = evaluateCandidate(input(draft({
      title: "  Retry\u0000   guidance  ",
      rationale: `Observed at C:\\Users\\alice\\private\\run.log with token ${["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_")}.`,
      proposedChange: "Document the safe retry behavior without retaining credentials."
    })));
    const serialized = JSON.stringify(result.candidate);

    expect(result.candidate.title).toBe("Retry guidance");
    expect(serialized).toContain("[REDACTED_LOCAL_PATH]");
    expect(serialized).toContain("[REDACTED_SECRET]");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("ghp_");
  });

  it("rejects evidence outside the explicit allowlist without retaining it in provenance", () => {
    const result = evaluateCandidate(input(draft({ evidenceIds: ["task:999"] })));

    expect(result.decision).toBe("rejected");
    expect(result.reasons.map((reason) => reason.code)).toContain("evidence_not_allowed");
    expect(result.provenance.evidenceIds).toEqual([]);
    expect(result.provenance.evidenceSourceIds).toEqual([]);
  });

  it("uses category risk floors and confidence floors", () => {
    const result = evaluateCandidate(input(draft({
      category: "policy",
      evidenceIds: ["task:10", "task:11"],
      risk: "low",
      confidence: 0.8
    })));

    expect(result.provenance.declaredRisk).toBe("low");
    expect(result.provenance.effectiveRisk).toBe("high");
    expect(result.reasons.map((reason) => reason.code)).toContain("confidence_below_floor");
  });

  it("does not promote a high-risk candidate supported by one source", () => {
    const result = evaluateCandidate(input(draft({
      evidenceIds: ["task:10", "review:10"],
      risk: "high",
      confidence: 0.95
    })));

    expect(result.decision).toBe("rejected");
    expect(result.reasons.map((reason) => reason.code)).toContain("single_source_high_risk");
  });

  it.each([
    "docs/MAESTRO_CONSTITUTION.md",
    "security/secret-filters",
    "human-approval-gates",
    "audit-log",
    "filesystem-permissions",
    "tool-permissions",
    "rollback-mechanism"
  ])("rejects changes to protected surface %s", (target) => {
    const result = evaluateCandidate(input(draft({ targets: [target] })));

    expect(result.decision).toBe("rejected");
    expect(result.reasons.map((reason) => reason.code)).toContain("protected_target");
  });

  it("rejects protected changes even when the target label is misleading", () => {
    const result = evaluateCandidate(input(draft({
      proposedChange: "Disable the audit log for background reviewer decisions.",
      targets: ["reviewer-performance"]
    })));

    expect(result.reasons.map((reason) => reason.code)).toContain("protected_target");
  });

  it("enforces quantity and size limits while bounding returned data", () => {
    const result = evaluateCandidate(input(draft({
      title: "x".repeat(121),
      targets: Array.from({ length: 9 }, (_, index) => `skill-${index}`),
      evidenceIds: Array.from({ length: 9 }, (_, index) => `task:${index}`)
    })));

    expect(result.decision).toBe("rejected");
    expect(result.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      "field_too_large",
      "invalid_target_count",
      "invalid_evidence_count"
    ]));
    expect(result.candidate.title).toHaveLength(120);
    expect(result.candidate.targets).toHaveLength(8);
    expect(result.candidate.evidenceIds).toHaveLength(8);
  });

  it("supports an injected fingerprint and DB-independent duplicate set", () => {
    const fingerprint = (candidate: CandidateDraft) => `custom:${candidate.title.toLowerCase()}`;
    const first = evaluateCandidate(input(draft()), { fingerprint });
    const duplicate = evaluateCandidate(input(draft(), {
      knownFingerprints: new Set([first.provenance.fingerprint])
    }), { fingerprint });

    expect(first.provenance.fingerprint).toBe("custom:improve retry guidance");
    expect(duplicate.reasons.map((reason) => reason.code)).toContain("duplicate_candidate");
  });

  it("keeps the default fingerprint stable as evidence and confidence evolve", () => {
    const first = evaluateCandidate(input(draft()));
    const strengthened = evaluateCandidate(input(draft({
      confidence: 0.95,
      evidenceIds: ["task:11", "task:10"]
    })));

    expect(strengthened.provenance.fingerprint).toBe(first.provenance.fingerprint);
  });

  it("fails closed when a fingerprint hook throws", () => {
    const result = evaluateCandidate(input(draft()), {
      fingerprint: () => { throw new Error("unavailable"); }
    });

    expect(result.decision).toBe("rejected");
    expect(result.reasons.map((reason) => reason.code)).toContain("invalid_fingerprint");
  });

  it("rejects malformed runtime arrays without throwing", () => {
    const malformed = {
      ...draft(),
      targets: null,
      evidenceIds: null
    } as unknown as CandidateDraft;

    const result = evaluateCandidate(input(malformed));

    expect(result.decision).toBe("rejected");
    expect(result.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      "invalid_target_count",
      "invalid_evidence_count"
    ]));
  });

  it("is deterministic for identical explicit inputs", () => {
    const evaluationInput = input(draft({ evidenceIds: ["task:10", "task:11"] }));

    expect(evaluateCandidate(evaluationInput)).toEqual(evaluateCandidate(evaluationInput));
    expect(defaultCandidateFingerprint(evaluateCandidate(evaluationInput).candidate)).toBe(
      evaluateCandidate(evaluationInput).provenance.fingerprint
    );
  });
});
