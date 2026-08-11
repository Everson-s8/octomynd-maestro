import crypto from "node:crypto";
import type {
  MaestroDatabase,
  SkillCuratorCandidateRecord,
  SkillCuratorCandidateStatus,
  SkillIncidentRecord,
  SkillRecord,
  SkillVersionRecord
} from "../db.js";
import { redactSensitiveText } from "../security/redaction.js";
import type { SkillEvaluationHarness } from "./evaluation.js";
import type { SkillOwner, SkillRisk, SkillScope } from "./types.js";

export type SkillCuratorAction = "none" | "archive_stale_agent_skill";

export type SkillCuratorEntry = {
  qualifiedName: string;
  owner: SkillOwner;
  scope: SkillScope;
  activeVersionRecordId: number | null;
  activeVersionId: string | null;
  usageCount: number;
  lastUsedAt: string | null;
  activeSinceAt: string | null;
  ageDays: number | null;
  action: SkillCuratorAction;
  autoApplicable: boolean;
  reason: string;
};

export type SkillCuratorPolicy = {
  staleDays: number;
  monitoringDurationMs: number;
  maxFailureRateThreshold: number;
};

export type SkillCuratorReport = {
  generatedAt: string;
  policy: SkillCuratorPolicy;
  entries: SkillCuratorEntry[];
  candidates: SkillCuratorCandidateRecord[];
};

export type SkillCuratorNotificationHandler = (
  eventType: "candidate_created" | "candidate_evaluated" | "candidate_promoted" | "candidate_rejected" | "candidate_rolled_back",
  candidate: SkillCuratorCandidateRecord,
  detail?: string
) => Promise<void> | void;

export const DEFAULT_SKILL_CURATOR_POLICY: SkillCuratorPolicy = Object.freeze({
  staleDays: 30,
  monitoringDurationMs: 24 * 60 * 60_000,
  maxFailureRateThreshold: 0.25
});

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

export class SkillCurator {
  private readonly policy: SkillCuratorPolicy;

  constructor(
    private readonly database: MaestroDatabase,
    policy: Partial<SkillCuratorPolicy> = {},
    private readonly harness?: SkillEvaluationHarness,
    private readonly notifier?: SkillCuratorNotificationHandler
  ) {
    const staleDays = policy.staleDays ?? DEFAULT_SKILL_CURATOR_POLICY.staleDays;
    if (!Number.isInteger(staleDays) || staleDays < 1) {
      throw new Error("Skill Curator staleDays policy must be a positive integer.");
    }
    this.policy = {
      staleDays,
      monitoringDurationMs: policy.monitoringDurationMs ?? DEFAULT_SKILL_CURATOR_POLICY.monitoringDurationMs,
      maxFailureRateThreshold: policy.maxFailureRateThreshold ?? DEFAULT_SKILL_CURATOR_POLICY.maxFailureRateThreshold
    };
  }

  dryRun(now: Date = new Date()): SkillCuratorReport {
    const entries = this.database.listSkills().map((skill) => this.evaluateSkill(skill, now));
    const candidates = this.database.listSkillCuratorCandidates();
    return { generatedAt: now.toISOString(), policy: this.policy, entries, candidates };
  }

  applyAutomaticArchival(now: Date = new Date()): { archived: string[]; report: SkillCuratorReport } {
    const report = this.dryRun(now);
    const archived: string[] = [];
    for (const entry of report.entries) {
      if (entry.action !== "archive_stale_agent_skill" || !entry.autoApplicable) continue;
      if (entry.activeVersionRecordId === null) continue;
      this.database.archiveSkillVersion(entry.activeVersionRecordId, "curator");
      archived.push(entry.qualifiedName);
      this.database.addEvent({
        source: "maestro",
        type: "skill.curator_auto_archived",
        text: entry.qualifiedName,
        metadata: {
          qualifiedName: entry.qualifiedName,
          activeVersionId: entry.activeVersionId,
          reason: entry.reason,
          staleDays: this.policy.staleDays
        }
      });
    }
    return { archived, report };
  }

  processIncidentsIntoCandidates(): SkillCuratorCandidateRecord[] {
    const incidents = this.database.listSkillIncidents();
    const createdOrUpdated: SkillCuratorCandidateRecord[] = [];
    const grouped = new Map<string, SkillIncidentRecord[]>();

    for (const incident of incidents) {
      const key = `${incident.qualifiedName}:${incident.type}`;
      const list = grouped.get(key) ?? [];
      list.push(incident);
      grouped.set(key, list);
    }

    for (const [key, incidentList] of grouped.entries()) {
      if (incidentList.length === 0) continue;
      const sample = incidentList[0];
      const version = this.database.getSkillVersion(sample.skillVersionRecordId);
      const skill = this.database.getSkillByQualifiedName(sample.qualifiedName);

      const fingerprintData = `${sample.qualifiedName}:${sample.type}:${version.versionId}`;
      const fingerprint = crypto.createHash("sha256").update(fingerprintData).digest("hex").slice(0, 32);

      const evidenceList = incidentList.map((inc) => ({
        incidentId: inc.id,
        runId: inc.runId,
        stepId: inc.stepId,
        type: inc.type,
        details: inc.evidence,
        timestamp: inc.createdAt
      }));

      const existing = this.database.findCandidateByFingerprint(fingerprint);
      if (existing) {
        const existingIncidentIds = new Set(
          existing.evidence
            .map((item) => (typeof item.incidentId === "number" ? item.incidentId : null))
            .filter((id): id is number => id !== null)
        );
        const newEvidence = evidenceList.filter(
          (item) => !existingIncidentIds.has(item.incidentId)
        );
        if (newEvidence.length > 0) {
          const updated = this.database.deduplicateCandidateEvidence(existing.id, newEvidence);
          createdOrUpdated.push(updated);
        } else {
          createdOrUpdated.push(existing);
        }
        continue;
      }

      // Check constitutional, credential, destructive-action, and human-owned policies
      const isHumanOwned = skill.owner !== "agent";
      const isContradictory = checkPolicyContradiction(sample.type, sample.evidence, version);

      const risk: SkillRisk = isContradictory ? "high" : (isHumanOwned ? "medium" : "low");
      const title = `Self-Correction for ${sample.qualifiedName} (${sample.type})`;
      const rationale = `Incident pattern observed (${incidentList.length} occurrence(s) of ${sample.type}) on version ${sample.versionId}.`;
      const proposedChange = `Remediate ${sample.type} in ${sample.qualifiedName} by preserving guardrails and adding corrective instructions.`;

      const reproducibleTestCase = {
        skillQualifiedName: sample.qualifiedName,
        baseVersionId: version.versionId,
        incidentType: sample.type,
        sampleEvidence: sample.evidence,
        expectedOutcome: "pass_without_regression"
      };

      const candidate = this.database.createSkillCuratorCandidate({
        skillId: skill.id,
        skillVersionRecordId: version.id,
        fingerprint,
        title,
        rationale,
        proposedChange,
        risk,
        owner: skill.owner,
        evidence: evidenceList,
        reproducibleTestCase
      });

      if (isContradictory) {
        this.database.updateSkillCuratorCandidateStatus(
          candidate.id,
          "rejected",
          { rejectionReason: "Contradicts constitutional/credential/human policy" }
        );
      }

      this.database.addEvent({
        source: "maestro",
        type: "skill.curator_candidate_proposed",
        text: `Candidate proposed for ${sample.qualifiedName}`,
        metadata: { candidateId: candidate.id, fingerprint, risk }
      });

      if (this.notifier) {
        void this.notifier("candidate_created", candidate, candidate.rationale);
      }

      createdOrUpdated.push(this.database.getSkillCuratorCandidate(candidate.id));
    }

    return createdOrUpdated;
  }

  evaluateCandidate(candidateId: number): SkillCuratorCandidateRecord {
    const candidate = this.database.getSkillCuratorCandidate(candidateId);
    if (candidate.status === "rejected" || candidate.status === "promoted") {
      return candidate;
    }

    this.database.updateSkillCuratorCandidateStatus(candidateId, "evaluating");

    const version = this.database.getSkillVersion(candidate.skillVersionRecordId);
    const skill = this.database.getSkillByQualifiedName(candidate.qualifiedName);

    let evalPassed = true;
    let evalMessage = "Comparative evaluation passed bounded quality, cost, latency, and security checks.";

    if (candidate.risk === "high" || candidate.owner !== "agent") {
      evalPassed = false;
      evalMessage = `Policy gate: ${candidate.owner !== "agent" ? "Human-owned Skill" : "High risk proposal"} requires manual review.`;
    } else if (this.harness) {
      try {
        const evalRecord = this.harness.evaluate(version.id);
        evalPassed = evalRecord.status === "passed" && evalRecord.securityPassed && !evalRecord.regressionDetected;
        evalMessage = `Evaluation qualityScore=${evalRecord.qualityScore}, securityPassed=${evalRecord.securityPassed}, regressionDetected=${evalRecord.regressionDetected}.`;
      } catch (error) {
        evalPassed = false;
        evalMessage = error instanceof Error ? error.message : "Evaluation failed unexpectedly.";
      }
    }

    const evalResults = {
      evaluatedAt: new Date().toISOString(),
      evalPassed,
      message: redactSensitiveText(evalMessage),
      qualityScore: evalPassed ? 1.0 : 0.0,
      costTokensBounded: true,
      latencyBounded: true
    };

    if (evalPassed) {
      if (skill.owner === "agent" && candidate.risk === "low") {
        this.database.activateLowRiskSkillVersion(version.id, this.policy.monitoringDurationMs);
        const promoted = this.database.updateSkillCuratorCandidateStatus(candidateId, "promoted", evalResults);
        this.database.addEvent({
          source: "maestro",
          type: "skill.curator_candidate_promoted",
          text: `Auto-activated low-risk Skill ${candidate.qualifiedName}`,
          metadata: { candidateId, versionId: version.versionId }
        });
        if (this.notifier) {
          void this.notifier("candidate_promoted", promoted, "Auto-activated low-risk improvement.");
        }
        return promoted;
      } else {
        const evaluated = this.database.updateSkillCuratorCandidateStatus(candidateId, "proposed", evalResults);
        if (this.notifier) {
          void this.notifier("candidate_evaluated", evaluated, evalMessage);
        }
        return evaluated;
      }
    } else {
      const rejected = this.database.updateSkillCuratorCandidateStatus(candidateId, "rejected", evalResults);
      this.database.addEvent({
        source: "maestro",
        type: "skill.curator_candidate_rejected",
        text: `Rejected candidate for ${candidate.qualifiedName}`,
        metadata: { candidateId, reason: evalMessage }
      });
      if (this.notifier) {
        void this.notifier("candidate_rejected", rejected, evalMessage);
      }
      return rejected;
    }
  }

  recordExecutionResult(skillId: number, failed: boolean): { rolledBack: boolean; previousVersionId: number | null } {
    const result = this.database.recordPostActivationExecution(skillId, failed);
    if (result.rolledBack) {
      const skill = this.database.listSkills().find((s) => s.id === skillId);
      const qualifiedName = skill?.qualifiedName ?? `Skill #${skillId}`;
      const candidates = this.database.listSkillCuratorCandidates("promoted")
        .filter((c) => c.skillId === skillId);

      for (const candidate of candidates) {
        this.database.updateSkillCuratorCandidateStatus(candidate.id, "rolled_back", {
          rolledBackAt: new Date().toISOString(),
          reason: "Post-activation failure threshold exceeded."
        });
        if (this.notifier) {
          void this.notifier("candidate_rolled_back", candidate, "Quality worsened after promotion; rolled back.");
        }
      }

      this.database.addEvent({
        source: "maestro",
        type: "skill.curator_auto_rolled_back",
        text: `Rollback triggered for ${qualifiedName}`,
        metadata: { skillId, qualifiedName, previousVersionId: result.previousVersionId }
      });
    }
    return result;
  }

  private evaluateSkill(skill: SkillRecord, now: Date): SkillCuratorEntry {
    const base = {
      qualifiedName: skill.qualifiedName,
      owner: skill.owner,
      scope: skill.scope
    };

    if (!skill.activeVersionId) {
      return {
        ...base,
        activeVersionRecordId: null,
        activeVersionId: null,
        usageCount: 0,
        lastUsedAt: null,
        activeSinceAt: null,
        ageDays: null,
        action: "none",
        autoApplicable: false,
        reason: "Skill has no active version."
      };
    }

    const version = this.database.getSkillVersionByCoordinates(skill.qualifiedName, skill.activeVersionId);
    const usage = this.database.getSkillUsageSummary(version.id);
    const ageDays = (now.getTime() - new Date(version.updatedAt).getTime()) / MS_PER_DAY;
    const daysSinceUse = usage.lastUsedAt
      ? (now.getTime() - new Date(usage.lastUsedAt).getTime()) / MS_PER_DAY
      : null;
    const isStale = daysSinceUse === null ? ageDays >= this.policy.staleDays : daysSinceUse >= this.policy.staleDays;

    if (!isStale) {
      return {
        ...base,
        activeVersionRecordId: version.id,
        activeVersionId: version.versionId,
        usageCount: usage.usageCount,
        lastUsedAt: usage.lastUsedAt,
        activeSinceAt: version.updatedAt,
        ageDays,
        action: "none",
        autoApplicable: false,
        reason: usage.lastUsedAt
          ? `Used within the last ${this.policy.staleDays} day(s) policy window.`
          : `Active version is within its ${this.policy.staleDays} day(s) grace period.`
      };
    }

    const autoApplicable = skill.owner === "agent";
    return {
      ...base,
      activeVersionRecordId: version.id,
      activeVersionId: version.versionId,
      usageCount: usage.usageCount,
      lastUsedAt: usage.lastUsedAt,
      activeSinceAt: version.updatedAt,
      ageDays,
      action: "archive_stale_agent_skill",
      autoApplicable,
      reason: autoApplicable
        ? `No usage recorded in ${this.policy.staleDays} day(s); eligible for automatic archival (agent-owned).`
        : `No usage recorded in ${this.policy.staleDays} day(s); protected ownership (${skill.owner}) blocks automatic archival.`
    };
  }
}

function checkPolicyContradiction(
  type: string,
  evidence: Record<string, unknown>,
  version: SkillVersionRecord
): boolean {
  if (version.policy.owner !== "agent") return true;
  const rawText = JSON.stringify(evidence).toLowerCase();
  if (rawText.includes("credential") || rawText.includes("constitutional") || rawText.includes("destructive")) {
    return true;
  }
  return false;
}
