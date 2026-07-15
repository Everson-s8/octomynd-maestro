import { describe, expect, it, vi } from "vitest";
import { buildClaudeCliCommand, buildClaudeImprovementReviewArgs } from "../src/agents/claude.js";
import { buildCodexImprovementReviewArgs } from "../src/agents/codex.js";
import { AgentRegistry } from "../src/agents/registry.js";
import type {
  AgentCapability,
  AgentExecutionResult,
  AgentProvider,
  AgentProviderId
} from "../src/agents/types.js";
import { RestrictedImprovementReviewCoordinator } from "../src/improvements/coordinator.js";
import {
  buildImprovementReviewPrompt,
  buildImprovementReviewSchema,
  ImprovementEvidencePack,
  ImprovementReviewExecutionRequest,
  ImprovementReviewExecutionResult,
  isValidImprovementEvidencePack,
  parseImprovementCandidateDrafts
} from "../src/improvements/reviewer.js";

const EVIDENCE_PACK: ImprovementEvidencePack = {
  subject: "Completed task review",
  evidence: [
    { id: "review-17", kind: "final_review", summary: "Repeated handoff omitted test evidence." },
    { id: "goal-22", kind: "goal", summary: "Testing passed after a manual retry." }
  ]
};

describe("restricted improvement reviewer", () => {
  it("uses a dedicated schema and rejects fabricated evidence references", () => {
    const schema = buildImprovementReviewSchema(3);
    const prompt = buildImprovementReviewPrompt(EVIDENCE_PACK, schema);

    expect(prompt).toContain("restricted background improvement reviewer");
    expect(prompt).toContain("Execucao estritamente read-only");
    expect(prompt).not.toContain("goal persistente");
    expect(schema).toMatchObject({
      properties: { candidates: { maxItems: 3 } }
    });
    expect(parseImprovementCandidateDrafts(candidateOutput("invented"), EVIDENCE_PACK, 3)).toBeNull();
  });

  it("fails closed before provider execution for sensitive or unbounded evidence", async () => {
    const secret = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const unsafe: ImprovementEvidencePack = {
      subject: "unsafe",
      evidence: [{ id: "secret", kind: "log", summary: secret }]
    };
    const review = vi.fn(async () => completed(JSON.stringify({ candidates: [] })));
    const reviewer = new RestrictedImprovementReviewCoordinator(
      new AgentRegistry([provider("codex", review)])
    );

    expect(isValidImprovementEvidencePack(unsafe)).toBe(false);
    await expect(reviewer.review(unsafe, { workspacePath: "C:/repo" }))
      .rejects.toThrow("contains sensitive text");
    expect(review).not.toHaveBeenCalled();
  });

  it("falls back through AgentRegistry leases and returns only validated drafts", async () => {
    const claude = provider("claude", async () => completed("not-json"));
    const codex = provider("codex", async (request) => {
      expect(request.timeoutMs).toBe(1_500);
      expect(request.maxOutputChars).toBe(2_000);
      return completed(candidateOutput("review-17"));
    });
    const registry = new AgentRegistry([codex, claude]);
    const reviewer = new RestrictedImprovementReviewCoordinator(registry, {
      timeoutMs: 1_500,
      maxOutputChars: 2_000,
      maxCandidates: 2
    });

    const result = await reviewer.review(EVIDENCE_PACK, { workspacePath: "C:/repo" });

    expect(result.status).toBe("completed");
    expect(result.candidates).toEqual([{
      category: "skill",
      title: "Require test evidence in handoffs",
      rationale: "Repeated reviews found missing validation evidence.",
      proposedChange: "Add a handoff checklist that requires the focused test command and result.",
      targets: ["agent-owned/handoff-skill"],
      evidenceRefs: ["review-17"],
      risk: "low",
      confidence: 0.84
    }]);
    expect(result.attempts.map(({ provider, status }) => ({ provider, status }))).toEqual([
      { provider: "claude", status: "invalid" },
      { provider: "codex", status: "completed" }
    ]);
    expect(registry.activeCount("claude")).toBe(0);
    expect(registry.activeCount("codex")).toBe(0);
  });

  it("tries at most two providers and fails closed when both outputs are invalid", async () => {
    const calls: AgentProviderId[] = [];
    const registry = new AgentRegistry([
      provider("codex", async () => {
        calls.push("codex");
        return completed(candidateOutput("missing"));
      }),
      provider("claude", async () => {
        calls.push("claude");
        return completed(JSON.stringify({ candidates: [], unexpected: true }));
      })
    ]);

    const result = await new RestrictedImprovementReviewCoordinator(registry)
      .review(EVIDENCE_PACK, { workspacePath: "C:/repo" });

    expect(result.status).toBe("failed");
    expect(result.candidates).toEqual([]);
    expect(result.attempts).toHaveLength(2);
    expect(calls).toEqual(["claude", "codex"]);
  });

  it("enforces the timeout before falling back from a non-cooperative adapter", async () => {
    const claude = provider("claude", async () => new Promise(() => {}));
    const codex = provider("codex", async () => completed(candidateOutput("goal-22")));
    const reviewer = new RestrictedImprovementReviewCoordinator(new AgentRegistry([codex, claude]), {
      timeoutMs: 20
    });

    const result = await reviewer.review(EVIDENCE_PACK, { workspacePath: "C:/repo" });

    expect(result.status).toBe("completed");
    expect(result.attempts.map((item) => item.status)).toEqual(["failed", "completed"]);
    expect(result.attempts[0].error).toContain("timed out");
  });

  it("builds provider invocations with no writable tools or sandbox", () => {
    const request: ImprovementReviewExecutionRequest = {
      workspacePath: "C:/repo",
      prompt: "dedicated improvement prompt",
      schema: buildImprovementReviewSchema(2),
      timeoutMs: 1_000,
      maxOutputChars: 2_000
    };
    const codex = buildCodexImprovementReviewArgs("C:/codex.js", request, "C:/schema.json", "C:/output.json");
    const claude = buildClaudeImprovementReviewArgs(buildClaudeCliCommand("C:/claude.exe"), request);

    expect(codex.join(" ")).toContain("--sandbox read-only");
    expect(claude.join(" ")).toContain("--permission-mode plan");
    expect(claude.join(" ")).toContain("--tools Read,Glob,Grep");
    expect(claude.join(" ")).not.toMatch(/Edit|Write|Bash/);
    expect(codex.at(-1)).toBe("-");
    expect(claude.at(-1)).toBe(request.prompt);
  });
});

function candidateOutput(evidenceRef: string): string {
  return JSON.stringify({
    candidates: [{
      category: "skill",
      title: "Require test evidence in handoffs",
      rationale: "Repeated reviews found missing validation evidence.",
      proposedChange: "Add a handoff checklist that requires the focused test command and result.",
      targets: ["agent-owned/handoff-skill"],
      evidenceRefs: [evidenceRef],
      risk: "low",
      confidence: 0.84
    }]
  });
}

function completed(output: string): ImprovementReviewExecutionResult {
  return { status: "completed", output, error: null, durationMs: 1, retryable: false };
}

function provider(
  id: AgentProviderId,
  review: (request: ImprovementReviewExecutionRequest) => Promise<ImprovementReviewExecutionResult>
): AgentProvider {
  const capabilities: AgentCapability[] = ["improvement_reviewing"];
  const execution: AgentExecutionResult = {
    outcome: "completed",
    summary: "unused",
    output: "",
    error: null,
    durationMs: 0,
    retryable: false
  };
  return {
    id,
    label: id,
    capabilities: new Set(capabilities),
    health: async () => ({ state: "ready", detail: "fake", checkedAt: "now" }),
    execute: async () => execution,
    reviewImprovements: review
  };
}
