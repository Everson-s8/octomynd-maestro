import type { MaestroDatabase, SkillRecord } from "../db.js";
import type { SkillOwner, SkillScope } from "./types.js";

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
};

export type SkillCuratorReport = {
  generatedAt: string;
  policy: SkillCuratorPolicy;
  entries: SkillCuratorEntry[];
};

export const DEFAULT_SKILL_CURATOR_POLICY: SkillCuratorPolicy = Object.freeze({
  staleDays: 30
});

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

export class SkillCurator {
  private readonly policy: SkillCuratorPolicy;

  constructor(
    private readonly database: MaestroDatabase,
    policy: Partial<SkillCuratorPolicy> = {}
  ) {
    const staleDays = policy.staleDays ?? DEFAULT_SKILL_CURATOR_POLICY.staleDays;
    if (!Number.isInteger(staleDays) || staleDays < 1) {
      throw new Error("Skill Curator staleDays policy must be a positive integer.");
    }
    this.policy = { staleDays };
  }

  dryRun(now: Date = new Date()): SkillCuratorReport {
    const entries = this.database.listSkills().map((skill) => this.evaluateSkill(skill, now));
    return { generatedAt: now.toISOString(), policy: this.policy, entries };
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
