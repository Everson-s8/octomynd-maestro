import type { AgentCapability } from "../agents/types.js";
import type { GoalPhase, MaestroDatabase, SkillRecord, SkillVersionRecord } from "../db.js";
import type { SkillExecutionContext, SkillOperatingSystem } from "./types.js";
import { SkillVersionStore } from "./store.js";

export type SkillRuntimeRequest = {
  runId: number;
  phase: GoalPhase;
  capability: AgentCapability;
  taskText: string;
  projectKey: string;
  explicitSkills?: string[];
  pinnedSkillVersions?: string[];
};

export type SkillRuntimeOptions = {
  maxAvailable: number;
  maxLoaded: number;
  maxInstructionChars: number;
};

export const DEFAULT_SKILL_RUNTIME_OPTIONS: SkillRuntimeOptions = {
  maxAvailable: 24,
  maxLoaded: 2,
  maxInstructionChars: 24_000
};

export class SkillRuntime {
  private readonly options: SkillRuntimeOptions;

  constructor(
    private readonly database: MaestroDatabase,
    private readonly store: SkillVersionStore,
    options: Partial<SkillRuntimeOptions> = {},
    private readonly isEnabled: () => boolean = () => true
  ) {
    this.options = { ...DEFAULT_SKILL_RUNTIME_OPTIONS, ...options };
    if (this.options.maxAvailable < 1 || this.options.maxLoaded < 1 || this.options.maxInstructionChars < 1_000) {
      throw new Error("Skill runtime limits must be positive and keep at least 1000 instruction characters.");
    }
  }

  prepareContext(request: SkillRuntimeRequest): SkillExecutionContext {
    if (!this.isEnabled()) {
      return {
        available: [],
        loaded: [],
        selectionMode: "disabled",
        selectionNote: "Skills are disabled by the operator."
      };
    }
    const active = this.database.listSkills()
      .filter((skill) => skill.activeVersionId)
      .map((skill) => ({
        skill,
        version: this.database.getSkillVersionByCoordinates(skill.qualifiedName, skill.activeVersionId!)
      }))
      .filter(({ skill, version }) => version.status === "active" && isApplicable(skill, version, request));
    const available = active.slice(0, this.options.maxAvailable).map(({ skill, version }) => ({
      qualifiedName: version.qualifiedName,
      description: version.description.slice(0, 240),
      versionId: version.versionId,
      scope: skill.scope,
      risk: version.policy.risk
    }));

    const alreadyPinned = this.database.listGoalSkillPins(request.runId)
      .map((pin) => {
        const version = this.database.getSkillVersion(pin.skillVersionRecordId);
        return { pin, version, skill: this.database.getSkillByQualifiedName(version.qualifiedName) };
      })
      .filter(({ skill, version }) => version.status === "active" && isApplicable(skill, version, request));
    const selected = [...alreadyPinned];
    const selectedVersionIds = new Set(selected.map(({ version }) => version.id));
    const rejectedPins: string[] = [];
    for (const pinnedVersionId of request.pinnedSkillVersions ?? []) {
      const candidate = findActiveVersion(this.database, pinnedVersionId.trim());
      if (!candidate) {
        rejectedPins.push(pinnedVersionId);
        continue;
      }
      if (!isApplicable(candidate.skill, candidate.version, request) || selectedVersionIds.has(candidate.version.id)) {
        rejectedPins.push(pinnedVersionId);
        continue;
      }
      if (selected.length >= this.options.maxLoaded) {
        rejectedPins.push(pinnedVersionId);
        continue;
      }
      this.assertInstructionsBudget(candidate.version);
      selected.push({
        ...candidate,
        pin: this.pin(request, candidate.version, `Pinned by Work Graph node for ${request.phase}.`, "explicit")
      });
      selectedVersionIds.add(candidate.version.id);
    }
    const explicit = new Set((request.explicitSkills ?? []).map((name) => name.trim()).filter(Boolean));

    for (const name of explicit) {
      const candidate = active.find(({ version }) => version.qualifiedName === name || skillName(version) === name);
      if (!candidate) throw new Error(`Explicit Skill is not active or applicable: ${name}.`);
      if (selectedVersionIds.has(candidate.version.id)) continue;
      if (selected.length >= this.options.maxLoaded) {
        throw new Error("Explicit Skill selection exceeds the runtime load budget.");
      }
      this.assertInstructionsBudget(candidate.version);
      selected.push({
        ...candidate,
        pin: this.pin(request, candidate.version, `Explicitly selected for ${request.phase}.`, "explicit")
      });
      selectedVersionIds.add(candidate.version.id);
    }

    const remaining = this.options.maxLoaded - selected.length;
    if (remaining > 0) {
      const implicit = active
        .filter(({ version }) => !selectedVersionIds.has(version.id))
        .filter(({ version }) => version.policy.allowImplicitInvocation && version.policy.risk === "low")
        .map((candidate) => ({
          ...candidate,
          score: scoreSkillRelevance(
            skillName(candidate.version),
            candidate.version.description,
            request,
            candidate.version.policy.capabilities
          )
        }))
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score || left.version.qualifiedName.localeCompare(right.version.qualifiedName))
        .slice(0, remaining);
      for (const candidate of implicit) {
        this.assertInstructionsBudget(candidate.version);
        selected.push({
          version: candidate.version,
          skill: candidate.skill,
          pin: this.pin(
            request,
            candidate.version,
            `Implicit metadata match for ${request.phase} (score ${candidate.score}).`,
            "implicit"
          )
        });
      }
    }

    let loadedChars = 0;
    let budgetSkipped = 0;
    const loaded = selected.slice(0, this.options.maxLoaded).flatMap(({ pin, version }) => {
      const instructions = this.store.readSkillMarkdown(version);
      if (loadedChars + instructions.length > this.options.maxInstructionChars) {
        budgetSkipped += 1;
        return [];
      }
      loadedChars += instructions.length;
      return [{
        qualifiedName: version.qualifiedName,
        versionId: version.versionId,
        triggerReason: pin.triggerReason,
        instructions
      }];
    });
    const notes = [
      rejectedPins.length > 0 ? `Rejected ${rejectedPins.length} non-active or inapplicable Work Graph Skill pin(s).` : null,
      budgetSkipped > 0 ? `Skipped ${budgetSkipped} Skill(s) because the instruction budget was full.` : null
    ].filter((item): item is string => Boolean(item));
    const note = notes.length > 0
      ? notes.join(" ")
      : "Selection uses language-independent phase and capability metadata; no model call was added.";
    return { available, loaded, selectionMode: "deterministic_metadata", selectionNote: note };
  }

  private pin(
    request: SkillRuntimeRequest,
    version: SkillVersionRecord,
    triggerReason: string,
    invocationMode: "explicit" | "implicit"
  ) {
    return this.database.pinGoalSkill({
      runId: request.runId,
      skillVersionRecordId: version.id,
      triggerReason,
      invocationMode
    });
  }

  private assertInstructionsBudget(version: SkillVersionRecord): void {
    const instructions = this.store.readSkillMarkdown(version);
    if (instructions.length > this.options.maxInstructionChars) {
      throw new Error(`Skill instructions exceed the runtime context budget: ${version.qualifiedName}.`);
    }
  }
}

function findActiveVersion(
  database: MaestroDatabase,
  requestedVersionId: string
): { skill: SkillRecord; version: SkillVersionRecord } | null {
  const normalized = requestedVersionId.trim();
  if (!normalized) return null;
  for (const skill of database.listSkills()) {
    if (!skill.activeVersionId) continue;
    const version = database.getSkillVersionByCoordinates(skill.qualifiedName, skill.activeVersionId);
    if (version.status === "active" && (version.versionId === normalized || `${version.qualifiedName}@${version.versionId}` === normalized)) {
      return { skill, version };
    }
  }
  return null;
}

function isApplicable(
  skill: SkillRecord,
  version: SkillVersionRecord,
  request: SkillRuntimeRequest
): boolean {
  if (["repository", "project"].includes(skill.scope) && skill.projectKey !== request.projectKey) return false;
  if (!version.policy.capabilities.includes(request.capability)) return false;
  if (!version.policy.operatingSystems.includes(process.platform as SkillOperatingSystem)) {
    return false;
  }
  return true;
}

export function scoreSkillRelevance(
  name: string,
  description: string,
  request: Pick<SkillRuntimeRequest, "taskText" | "phase" | "capability">,
  supportedCapabilities?: readonly AgentCapability[]
): number {
  void name;
  void description;
  // Selection is intentionally based on protocol metadata, not words. The
  // phase/capability enums survive translation and non-Latin user input.
  const phaseCapability: Record<GoalPhase, AgentCapability> = {
    planning: "planning",
    implementing: "coding",
    testing: "testing",
    reviewing: "reviewing"
  };
  if (supportedCapabilities && !supportedCapabilities.includes(request.capability)) return 0;
  return request.capability === phaseCapability[request.phase] && Boolean(request.taskText.trim()) ? 10 : 0;
}

function skillName(version: SkillVersionRecord): string {
  return version.qualifiedName.slice(version.qualifiedName.indexOf(":") + 1);
}
