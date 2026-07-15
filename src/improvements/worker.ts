import { MaestroDatabase, ImprovementProposalRecord } from "../db.js";
import { redactSensitiveText } from "../security/redaction.js";
import { RestrictedImprovementReviewer } from "./reviewer.js";
import { evaluateCandidate } from "./evaluator.js";
import type { AllowedEvidence, CandidateDraft } from "./evaluation-types.js";
import { CompletionReviewOutbox } from "./outbox.js";
import type { CompletionEvidencePack, CompletionReviewRecord } from "./types.js";

export type ImprovementCandidateNotificationHandler = (
  proposal: ImprovementProposalRecord
) => Promise<void>;

export type ImprovementReviewWorkerOptions = {
  pollIntervalMs?: number;
  leaseMs?: number;
  workerId?: string;
};

export class ImprovementReviewWorker {
  private readonly outbox: CompletionReviewOutbox;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly workerId: string;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly database: MaestroDatabase,
    private readonly reviewer: RestrictedImprovementReviewer,
    private readonly notifyCandidate?: ImprovementCandidateNotificationHandler,
    options: ImprovementReviewWorkerOptions = {}
  ) {
    this.outbox = new CompletionReviewOutbox(database);
    this.pollIntervalMs = boundedInteger(options.pollIntervalMs, 30_000, 1_000, 300_000);
    this.leaseMs = boundedInteger(options.leaseMs, 5 * 60_000, 30_000, 10 * 60_000);
    this.workerId = options.workerId?.trim().slice(0, 120) || `improvement-review:${process.pid}`;
  }

  start(): void {
    if (this.timer) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async reconcile(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      this.outbox.reconcileCompletedFeatures();
      const review = this.outbox.claim({ workerId: this.workerId, leaseMs: this.leaseMs });
      if (!review) return 0;
      return await this.processReview(review);
    } finally {
      this.running = false;
    }
  }

  private async processReview(review: CompletionReviewRecord): Promise<number> {
    try {
      const projectKey = factValue(review.evidence, "project_key");
      const project = projectKey ? this.database.findProjectByKey(projectKey) : null;
      if (!project) throw new Error(`Project not found for completion review #${review.id}.`);
      const reviewerEvidence = toReviewerEvidence(review.evidence);
      const result = await this.reviewer.review(reviewerEvidence.pack, { workspacePath: project.path });
      if (result.status === "unavailable") {
        this.database.finishCompletionReview(review.id, this.workerId, "waiting_provider", "No reviewer provider available.");
        return 0;
      }
      if (result.status !== "completed") {
        const error = result.attempts.map((attempt) => attempt.error).filter(Boolean).at(-1)
          ?? `Improvement review ended with status ${result.status}.`;
        this.database.finishCompletionReview(review.id, this.workerId, "failed", error);
        return 0;
      }

      const provider = [...result.attempts].reverse().find((attempt) => attempt.status === "completed")?.provider
        ?? "codex";
      let created = 0;
      for (const draft of result.candidates) {
        const evaluation = evaluateCandidate({
          draft: {
            ...draft,
            evidenceIds: draft.evidenceRefs
          } satisfies CandidateDraft,
          allowedEvidence: reviewerEvidence.allowed,
          knownFingerprints: this.database.listImprovementFingerprints(),
          origin: { kind: "background-review", author: provider, runId: `completion-review:${review.id}` },
          createdAt: review.evidence.capturedAt,
          evaluatedAt: new Date().toISOString()
        });
        if (evaluation.decision === "rejected") {
          this.database.addEvent({
            source: "maestro",
            type: "improvement.candidate_rejected",
            text: evaluation.candidate.title || "Rejected background improvement candidate",
            metadata: {
              completionReviewId: review.id,
              reasonCodes: evaluation.reasons.map((reason) => reason.code),
              fingerprint: evaluation.provenance.fingerprint
            }
          });
          continue;
        }

        const before = this.database.findImprovementProposalByFingerprint(evaluation.provenance.fingerprint);
        const proposal = this.database.createImprovementProposal({
          category: evaluation.candidate.category,
          title: evaluation.candidate.title,
          rationale: evaluation.candidate.rationale,
          proposedChange: evaluation.candidate.proposedChange,
          evidence: evaluation.provenance.evidenceIds.map((id) => reviewerEvidence.descriptions.get(id) ?? id),
          risk: evaluation.provenance.effectiveRisk,
          source: `background-review:${provider}`,
          projectKey: project.key,
          targets: evaluation.candidate.targets,
          confidence: evaluation.candidate.confidence,
          fingerprint: evaluation.provenance.fingerprint,
          provenance: evaluation.provenance as unknown as Record<string, unknown>
        });
        if (before) continue;
        created += 1;
        this.database.addEvent({
          source: "maestro",
          type: "improvement.proposed_by_background_review",
          text: proposal.title,
          metadata: {
            improvementId: proposal.id,
            completionReviewId: review.id,
            projectKey: project.key,
            risk: proposal.risk,
            confidence: proposal.confidence
          }
        });
        if (this.notifyCandidate) {
          try {
            await this.notifyCandidate(proposal);
          } catch (error) {
            this.database.addEvent({
              source: "maestro",
              type: "improvement.candidate_notification_failed",
              text: proposal.title,
              metadata: {
                improvementId: proposal.id,
                completionReviewId: review.id,
                error: redactSensitiveText(
                  error instanceof Error ? error.message : "Improvement candidate notification failed."
                )
              }
            });
          }
        }
      }
      this.database.finishCompletionReview(review.id, this.workerId, "succeeded");
      return created;
    } catch (error) {
      const message = redactSensitiveText(error instanceof Error ? error.message : "Improvement review failed.");
      try {
        this.database.finishCompletionReview(review.id, this.workerId, "failed", message);
      } catch {
        // The durable lease may already have expired; another worker can recover it.
      }
      return 0;
    }
  }
}

function toReviewerEvidence(evidence: CompletionEvidencePack): {
  pack: { subject: string; evidence: Array<{ id: string; kind: string; summary: string; reference: string }> };
  allowed: AllowedEvidence[];
  descriptions: Map<string, string>;
} {
  const entries = evidence.facts.map((fact) => {
    const id = `feature:${evidence.subject.id}:${fact.key}`;
    return {
      id,
      kind: fact.key,
      summary: fact.value,
      reference: `feature:${fact.provenance.sourceId}@${fact.provenance.sourceVersion}#${fact.provenance.field}`
    };
  });
  return {
    pack: { subject: `feature:${evidence.subject.id}@${evidence.subject.completionVersion}`, evidence: entries },
    allowed: entries.map((entry) => ({ id: entry.id, sourceId: `feature:${evidence.subject.id}` })),
    descriptions: new Map(entries.map((entry) => [entry.id, `${entry.reference}: ${entry.summary}`]))
  };
}

function factValue(evidence: CompletionEvidencePack, key: string): string | null {
  return evidence.facts.find((fact) => fact.key === key)?.value ?? null;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value!)) : fallback;
}
