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
};

export type SkillRuntimeOptions = {
  maxAvailable: number;
  maxLoaded: number;
  maxInstructionChars: number;
};

const DEFAULT_OPTIONS: SkillRuntimeOptions = {
  maxAvailable: 12,
  maxLoaded: 2,
  maxInstructionChars: 16_000
};

export class SkillRuntime {
  private readonly options: SkillRuntimeOptions;

  constructor(
    private readonly database: MaestroDatabase,
    private readonly store: SkillVersionStore,
    options: Partial<SkillRuntimeOptions> = {}
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    if (this.options.maxAvailable < 1 || this.options.maxLoaded < 1 || this.options.maxInstructionChars < 1_000) {
      throw new Error("Skill runtime limits must be positive and keep at least 1000 instruction characters.");
    }
  }

  prepareContext(request: SkillRuntimeRequest): SkillExecutionContext {
    const active = this.database.listSkills()
      .filter((skill) => skill.activeVersionId)
      .map((skill) => ({
        skill,
        version: this.database.getSkillVersionByCoordinates(skill.qualifiedName, skill.activeVersionId!)
      }))
      .filter(({ skill, version }) => isApplicable(skill, version, request));
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
      .filter(({ skill, version }) => isApplicable(skill, version, request));
    const selected = [...alreadyPinned];
    const selectedVersionIds = new Set(selected.map(({ version }) => version.id));
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
          score: scoreSkillRelevance(skillName(candidate.version), candidate.version.description, request)
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

    const loaded = selected.slice(0, this.options.maxLoaded).map(({ pin, version }) => {
      const instructions = this.store.readSkillMarkdown(version);
      if (instructions.length > this.options.maxInstructionChars) {
        throw new Error(`Skill instructions exceed the runtime context budget: ${version.qualifiedName}.`);
      }
      return {
        qualifiedName: version.qualifiedName,
        versionId: version.versionId,
        triggerReason: pin.triggerReason,
        instructions
      };
    });
    return { available, loaded };
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
  request: Pick<SkillRuntimeRequest, "taskText" | "phase" | "capability">
): number {
  const requestTokens = tokens(`${request.taskText} ${request.phase} ${request.capability}`);
  const skillTokens = tokens(`${name} ${description}`);
  let score = 0;
  for (const token of skillTokens) if (requestTokens.has(token)) score += token.length >= 7 ? 3 : 1;
  return score;
}

function skillName(version: SkillVersionRecord): string {
  return version.qualifiedName.slice(version.qualifiedName.indexOf(":") + 1);
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3));
}
