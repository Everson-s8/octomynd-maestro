import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationCommands } from "../src/commands/application-commands.js";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { RestrictedImprovementReviewer } from "../src/improvements/reviewer.js";
import { ImprovementReviewWorker } from "../src/improvements/worker.js";

let tempDir: string;
let database: MaestroDatabase;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-improvement-worker-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
  database.registerProject({ key: "maestro", path: tempDir });
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("governed self-improvement worker", () => {
  it("turns a completed Feature review into one durable candidate", async () => {
    const feature = completedFeature();
    database.enqueueFeatureCompletionReview(feature.id);
    const notify = vi.fn(async () => undefined);
    const reviewer: RestrictedImprovementReviewer = {
      review: async (pack) => ({
        status: "completed",
        candidates: [{
          category: "skill",
          title: "Require compact provider evidence",
          rationale: "The completed Feature showed that bounded evidence improves review reliability.",
          proposedChange: "Add a compact evidence checklist to the agent-owned delivery skill.",
          targets: ["agent-owned/delivery-skill"],
          evidenceRefs: [pack.evidence.find((item) => item.kind === "review_summary")!.id],
          risk: "low",
          confidence: 0.86
        }],
        attempts: [{ provider: "codex", status: "completed", error: null, durationMs: 10 }]
      })
    };
    const worker = new ImprovementReviewWorker(database, reviewer, notify, { workerId: "test-worker" });

    expect(await worker.reconcile()).toBe(1);
    expect(await worker.reconcile()).toBe(0);

    const proposals = database.listImprovementProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      projectKey: "maestro",
      source: "background-review:codex",
      status: "candidate",
      confidence: 0.86,
      targets: ["agent-owned/delivery-skill"]
    });
    expect(proposals[0].fingerprint).toHaveLength(64);
    expect(database.listCompletionReviews()[0].status).toBe("succeeded");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("keeps protected or high-risk single-source suggestions out of the Learning Lab", async () => {
    const feature = completedFeature();
    database.enqueueFeatureCompletionReview(feature.id);
    const reviewer: RestrictedImprovementReviewer = {
      review: async (pack) => ({
        status: "completed",
        candidates: [{
          category: "policy",
          title: "Change human approval gates",
          rationale: "A reviewer suggested bypassing the final human gate.",
          proposedChange: "Disable human approval gates for faster merges.",
          targets: ["human-approval-gates"],
          evidenceRefs: [pack.evidence[0].id],
          risk: "high",
          confidence: 0.99
        }],
        attempts: [{ provider: "claude", status: "completed", error: null, durationMs: 10 }]
      })
    };

    expect(await new ImprovementReviewWorker(database, reviewer, undefined, { workerId: "test-worker" })
      .reconcile()).toBe(0);
    expect(database.listImprovementProposals()).toHaveLength(0);
    expect(database.listEvents().some((event) => event.type === "improvement.candidate_rejected")).toBe(true);
  });

  it("does not retry a persisted candidate when its notification fails", async () => {
    const feature = completedFeature();
    database.enqueueFeatureCompletionReview(feature.id);
    const reviewer: RestrictedImprovementReviewer = {
      review: async (pack) => ({
        status: "completed",
        candidates: [{
          category: "skill",
          title: "Preserve durable review results",
          rationale: "A delivery notification must not invalidate an already persisted review result.",
          proposedChange: "Keep candidate notification outside the durable review transaction.",
          targets: ["agent-owned/delivery-skill"],
          evidenceRefs: [pack.evidence[0].id],
          risk: "low",
          confidence: 0.86
        }],
        attempts: [{ provider: "codex", status: "completed", error: null, durationMs: 10 }]
      })
    };
    const notify = vi.fn(async () => {
      throw new Error("telegram unavailable");
    });
    const worker = new ImprovementReviewWorker(database, reviewer, notify, { workerId: "test-worker" });

    expect(await worker.reconcile()).toBe(1);
    expect(await worker.reconcile()).toBe(0);
    expect(database.listImprovementProposals()).toHaveLength(1);
    expect(database.listCompletionReviews()[0].status).toBe("succeeded");
    expect(database.listEvents().some(
      (event) => event.type === "improvement.candidate_notification_failed"
    )).toBe(true);
  });
});

describe("approved improvement activation", () => {
  it("creates exactly one Task and Feature Plan instead of mutating the system", () => {
    const proposal = database.createImprovementProposal({
      category: "skill",
      title: "Improve delivery evidence",
      rationale: "Completed Features repeatedly need clearer validation evidence.",
      proposedChange: "Add a bounded validation checklist to the delivery skill.",
      evidence: ["feature:24:review_summary: Final review passed"],
      risk: "low",
      source: "background-review:codex",
      projectKey: "maestro",
      targets: ["agent-owned/delivery-skill"],
      confidence: 0.9,
      fingerprint: "f".repeat(64),
      provenance: { runId: "completion-review:1" }
    });
    const commands = new ApplicationCommands(database);

    const first = commands.decideImprovementProposal({ channel: "dashboard" }, proposal.id, "approved");
    const second = commands.decideImprovementProposal({ channel: "dashboard" }, proposal.id, "approved");

    expect(first.improvement.status).toBe("approved");
    expect(first.task?.status).toBe("queued");
    expect(first.featurePlan?.tasks.map((item) => item.taskId)).toEqual([first.task?.id]);
    expect(first.improvement.taskId).toBe(first.task?.id);
    expect(first.improvement.featurePlanId).toBe(first.featurePlan?.plan.id);
    expect(second.task?.id).toBe(first.task?.id);
    expect(database.listTasks()).toHaveLength(1);
    expect(database.listFeaturePlans()).toHaveLength(1);
  });

  it("drafts an agent-owned Skill proposal linked to the improvement without activating anything", () => {
    const proposal = database.createImprovementProposal({
      category: "skill",
      title: "Improve delivery evidence",
      rationale: "Completed Features repeatedly need clearer validation evidence.",
      proposedChange: "Add a bounded validation checklist to the delivery skill.",
      evidence: ["feature:24:review_summary: Final review passed"],
      risk: "low",
      source: "background-review:codex",
      projectKey: "maestro",
      targets: ["agent-owned/delivery-skill"],
      confidence: 0.9,
      fingerprint: "e".repeat(64),
      provenance: { runId: "completion-review:2" }
    });
    const commands = new ApplicationCommands(database);

    const result = commands.decideImprovementProposal({ channel: "dashboard" }, proposal.id, "approved");

    const drafts = database.listSkillProposals();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      improvementProposalId: result.improvement.id,
      owner: "agent",
      status: "requested",
      suggestedQualifiedName: "repository:improve-delivery-evidence",
      skillVersionRecordId: null
    });
    expect(database.listSkills()).toHaveLength(0);
    expect(database.listEvents().some((event) => event.type === "skill.proposal_drafted")).toBe(true);

    const secondDecision = commands.decideImprovementProposal({ channel: "dashboard" }, proposal.id, "approved");
    expect(secondDecision.improvement.id).toBe(result.improvement.id);
    expect(database.listSkillProposals()).toHaveLength(1);
  });

  it("records rejection without creating execution work", () => {
    const proposal = database.createImprovementProposal({
      category: "memory",
      title: "Discard weak memory idea",
      rationale: "The evidence is not strong enough to justify implementation.",
      proposedChange: "Do not implement this speculative memory change.",
      evidence: ["feature:24:objective"],
      risk: "low",
      projectKey: "maestro"
    });

    const result = new ApplicationCommands(database)
      .decideImprovementProposal({ channel: "telegram", userId: "42" }, proposal.id, "rejected");

    expect(result.improvement.status).toBe("rejected");
    expect(result.task).toBeNull();
    expect(result.featurePlan).toBeNull();
    expect(database.listTasks()).toHaveLength(0);
  });
});

function completedFeature() {
  const feature = database.createFeature({
    projectKey: "maestro",
    name: "Governed improvement test",
    objective: "Produce reusable evidence without autonomous mutation",
    branchName: "maestro/feature-governed-improvement",
    worktreePath: tempDir,
    pullRequestUrl: "https://github.com/acme/maestro/pull/24"
  });
  return database.updateFeature({
    id: feature.id,
    status: "completed",
    reviewedHeadSha: "reviewed-head-24",
    reviewerProvider: "claude",
    reviewSummary: "Final review passed with deterministic validation evidence.",
    mergedAt: "2026-07-14T12:00:00.000Z"
  });
}
