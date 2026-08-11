import type {
  MaestroDatabase,
  SkillArchiveActor,
  SkillCuratorCandidateRecord,
  SkillEvaluationRecord,
  SkillProposalRecord,
  SkillVersionRecord
} from "../db.js";
import { SkillCurator, SkillCuratorReport } from "./curator.js";
import { SkillEvaluationHarness } from "./evaluation.js";
import { SkillVersionStore } from "./store.js";

export type SkillLifecycleRuntime = {
  store: SkillVersionStore;
  harness: SkillEvaluationHarness;
  curator: SkillCurator;
};

export class SkillLifecycleService {
  constructor(
    private readonly database: MaestroDatabase,
    private readonly runtime: SkillLifecycleRuntime
  ) {}

  evaluateVersion(skillVersionRecordId: number): SkillEvaluationRecord {
    return this.runtime.harness.evaluate(skillVersionRecordId);
  }

  approveVersion(skillVersionRecordId: number): SkillVersionRecord {
    return this.database.updateSkillVersionStatus(skillVersionRecordId, "approved");
  }

  activateVersion(skillVersionRecordId: number): SkillVersionRecord {
    return this.database.activateSkillVersion(skillVersionRecordId);
  }

  rollbackVersion(skillVersionRecordId: number): SkillVersionRecord {
    return this.database.rollbackSkillVersion(skillVersionRecordId);
  }

  restoreVersion(skillVersionRecordId: number): SkillVersionRecord {
    return this.database.restoreSkillVersion(skillVersionRecordId);
  }

  archiveVersion(skillVersionRecordId: number, actor: SkillArchiveActor = "human"): SkillVersionRecord {
    return this.database.archiveSkillVersion(skillVersionRecordId, actor);
  }

  curatorDryRun(now?: Date): SkillCuratorReport {
    return this.runtime.curator.dryRun(now);
  }

  curatorApplyAutomaticArchival(now?: Date): { archived: string[]; report: SkillCuratorReport } {
    return this.runtime.curator.applyAutomaticArchival(now);
  }

  processCuratorIncidents(): SkillCuratorCandidateRecord[] {
    return this.runtime.curator.processIncidentsIntoCandidates();
  }

  evaluateCuratorCandidate(candidateId: number): SkillCuratorCandidateRecord {
    return this.runtime.curator.evaluateCandidate(candidateId);
  }

  recordPostActivationExecution(skillId: number, failed: boolean): { rolledBack: boolean; previousVersionId: number | null } {
    return this.runtime.curator.recordExecutionResult(skillId, failed);
  }

  reconcileSkillProposalDrafts(): SkillProposalRecord[] {
    const linked: SkillProposalRecord[] = [];
    for (const proposal of this.database.listSkillProposals("requested")) {
      const skill = this.findAgentOwnedSkill(proposal.suggestedQualifiedName);
      if (!skill) continue;
      const candidate = this.findLinkableCandidateVersion(skill.qualifiedName);
      if (!candidate) continue;
      linked.push(this.database.linkSkillProposalDraft(proposal.id, candidate.id));
    }
    return linked;
  }

  private findAgentOwnedSkill(qualifiedName: string) {
    try {
      const skill = this.database.getSkillByQualifiedName(qualifiedName);
      return skill.owner === "agent" ? skill : null;
    } catch {
      return null;
    }
  }

  private findLinkableCandidateVersion(qualifiedName: string): SkillVersionRecord | null {
    const linkedVersionIds = new Set(
      this.database.listSkillProposals()
        .map((proposal) => proposal.skillVersionRecordId)
        .filter((id): id is number => id !== null)
    );
    const candidate = this.database.listSkillVersions(qualifiedName)
      .find((version) => version.status === "candidate" && !linkedVersionIds.has(version.id));
    return candidate ?? null;
  }
}

export function suggestSkillProposalQualifiedName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `repository:${slug || "agent-proposed-skill"}`;
}
