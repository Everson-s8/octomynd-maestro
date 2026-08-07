import Database from "better-sqlite3";
import path from "node:path";
import { redactSensitiveText } from "../security/redaction.js";
import type { AgentOutcome, AgentProviderId } from "../agents/types.js";
import type { GoalPhase } from "../db.js";
import type { SkillPolicy, SkillRisk, SkillScope } from "./types.js";

export type SkillVersionLifecycleStatus =
  | "candidate"
  | "evaluated"
  | "approved"
  | "active"
  | "rejected"
  | "retired";

export type SkillRecord = {
  id: number;
  qualifiedName: string;
  name: string;
  description: string;
  scope: SkillScope;
  projectKey: string | null;
  owner: SkillPolicy["owner"];
  risk: SkillRisk;
  activeVersionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SkillVersionRecord = {
  id: number;
  skillId: number;
  qualifiedName: string;
  versionId: string;
  contentHash: string;
  description: string;
  snapshotPath: string;
  policy: SkillPolicy;
  fileCount: number;
  totalBytes: number;
  status: SkillVersionLifecycleStatus;
  createdAt: string;
  updatedAt: string;
};

export type SkillVersionRegistrationInput = {
  qualifiedName: string;
  name: string;
  description: string;
  scope: SkillScope;
  projectKey: string | null;
  versionId: string;
  contentHash: string;
  snapshotPath: string;
  policy: SkillPolicy;
  fileCount: number;
  totalBytes: number;
};

export type GoalSkillInvocationMode = "explicit" | "implicit";

export type GoalSkillPinRecord = {
  id: number;
  runId: number;
  skillId: number;
  skillVersionRecordId: number;
  qualifiedName: string;
  versionId: string;
  triggerReason: string;
  invocationMode: GoalSkillInvocationMode;
  createdAt: string;
};

export type SkillEvaluationCheck = {
  id: string;
  type: string;
  status: "passed" | "failed";
  message: string;
};

export type SkillEvaluationRecord = {
  id: number;
  skillVersionRecordId: number;
  qualifiedName: string;
  versionId: string;
  status: "passed" | "failed";
  qualityScore: number;
  durationMs: number;
  estimatedTokens: number;
  attempts: number;
  failures: number;
  securityPassed: boolean;
  regressionDetected: boolean;
  baselineVersionId: string | null;
  checks: SkillEvaluationCheck[];
  createdAt: string;
};

export type SkillEvaluationInput = Omit<
  SkillEvaluationRecord,
  "id" | "qualifiedName" | "versionId" | "createdAt"
>;

export type SkillEvaluationComparison = {
  baselineVersionId: string;
  qualityDelta: number;
  durationDeltaMs: number;
  estimatedTokensDelta: number;
  attemptsDelta: number;
  failuresDelta: number;
};

export type SkillUsageRecord = {
  id: number;
  runId: number;
  stepId: number;
  skillVersionRecordId: number;
  qualifiedName: string;
  versionId: string;
  provider: AgentProviderId;
  phase: GoalPhase;
  outcome: AgentOutcome;
  durationMs: number;
  estimatedTokens: number;
  createdAt: string;
};

export type SkillUsageSummary = {
  usageCount: number;
  lastUsedAt: string | null;
};

export const SKILL_PROPOSAL_STATUSES = ["requested", "linked", "rejected"] as const;
export type SkillProposalStatus = typeof SKILL_PROPOSAL_STATUSES[number];

export type SkillProposalRecord = {
  id: number;
  improvementProposalId: number;
  suggestedQualifiedName: string;
  owner: "agent";
  status: SkillProposalStatus;
  skillVersionRecordId: number | null;
  qualifiedName: string | null;
  versionId: string | null;
  evidence: string[];
  provenance: Record<string, unknown>;
  decisionNote: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SkillProposalInput = {
  improvementProposalId: number;
  suggestedQualifiedName: string;
  evidence: string[];
  provenance: Record<string, unknown>;
};

export type SkillArchiveActor = "human" | "curator";

export function createSkillPersistence(db: Database.Database) {
  const upsertSkill = db.prepare(`
    INSERT INTO skills (
      qualified_name, name, description, scope, project_key, owner, risk,
      active_skill_version_id, created_at, updated_at
    ) VALUES (
      @qualifiedName, @name, @description, @scope, @projectKey, @owner, @risk,
      NULL, @now, @now
    )
    ON CONFLICT(qualified_name) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      scope = excluded.scope,
      project_key = excluded.project_key,
      owner = excluded.owner,
      risk = excluded.risk,
      updated_at = excluded.updated_at
  `);
  const insertVersion = db.prepare(`
    INSERT INTO skill_versions (
      skill_id, version_id, content_hash, description, snapshot_path,
      policy_json, file_count, total_bytes, status, created_at, updated_at
    ) VALUES (
      @skillId, @versionId, @contentHash, @description, @snapshotPath,
      @policyJson, @fileCount, @totalBytes, 'candidate', @now, @now
    )
  `);
  const updateVersionStatus = db.prepare(`
    UPDATE skill_versions SET status = @status, updated_at = @now WHERE id = @id
  `);
  const activateSkill = db.prepare(`
    UPDATE skills
    SET active_skill_version_id = @skillVersionRecordId, updated_at = @now
    WHERE id = @skillId
  `);
  const pinGoalSkill = db.prepare(`
    INSERT INTO goal_skill_pins (
      run_id, skill_version_id, trigger_reason, invocation_mode, created_at
    ) VALUES (@runId, @skillVersionRecordId, @triggerReason, @invocationMode, @now)
    ON CONFLICT(run_id, skill_version_id) DO UPDATE SET
      trigger_reason = excluded.trigger_reason,
      invocation_mode = excluded.invocation_mode
  `);
  const recordEvaluation = db.prepare(`
    INSERT INTO skill_evaluations (
      skill_version_id, status, quality_score, duration_ms, estimated_tokens,
      attempts, failures, security_passed, regression_detected,
      baseline_version_id, checks_json, created_at
    ) VALUES (
      @skillVersionRecordId, @status, @qualityScore, @durationMs, @estimatedTokens,
      @attempts, @failures, @securityPassed, @regressionDetected,
      @baselineVersionId, @checksJson, @now
    )
  `);
  const recordUsage = db.prepare(`
    INSERT INTO skill_usage (
      run_id, step_id, skill_version_id, provider, phase, outcome,
      duration_ms, estimated_tokens, created_at
    ) VALUES (
      @runId, @stepId, @skillVersionRecordId, @provider, @phase, @outcome,
      @durationMs, @estimatedTokens, @now
    )
  `);
  const clearActiveSkillVersion = db.prepare(`
    UPDATE skills SET active_skill_version_id = NULL, updated_at = @now WHERE id = @skillId
  `);
  const insertSkillProposal = db.prepare(`
    INSERT INTO skill_proposals (
      improvement_proposal_id, suggested_qualified_name, owner, status,
      skill_version_id, evidence_json, provenance_json, decision_note, created_at, updated_at
    ) VALUES (
      @improvementProposalId, @suggestedQualifiedName, 'agent', 'requested',
      NULL, @evidenceJson, @provenanceJson, NULL, @now, @now
    )
  `);
  const linkSkillProposal = db.prepare(`
    UPDATE skill_proposals
    SET status = 'linked', skill_version_id = @skillVersionRecordId, updated_at = @now
    WHERE id = @id AND status = 'requested'
  `);
  const rejectSkillProposalStatement = db.prepare(`
    UPDATE skill_proposals
    SET status = 'rejected', decision_note = @decisionNote, updated_at = @now
    WHERE id = @id AND status = 'requested'
  `);

  function promoteVersion(id: number): SkillVersionRecord {
    return db.transaction(() => {
      const selected = getVersionRow(db, id);
      if (!(["approved", "active"] as const).includes(selected.status as "approved" | "active")) {
        throw new Error(`Skill version ${selected.qualified_name}@${selected.version_id} is not approved.`);
      }
      assertPassingEvaluation(db, selected.id);
      const skill = getSkillRow(db, selected.qualified_name);
      const now = new Date().toISOString();
      if (skill.active_skill_version_id && skill.active_skill_version_id !== selected.id) {
        updateVersionStatus.run({ id: skill.active_skill_version_id, status: "approved", now });
      }
      updateVersionStatus.run({ id: selected.id, status: "active", now });
      activateSkill.run({ skillId: skill.id, skillVersionRecordId: selected.id, now });
      return mapVersion(getVersionRow(db, selected.id));
    })();
  }

  return {
    registerSkillVersion(input: SkillVersionRegistrationInput): SkillVersionRecord {
      const normalized = normalizeRegistration(input);
      const now = new Date().toISOString();
      return db.transaction(() => {
        upsertSkill.run({
          ...normalized,
          owner: normalized.policy.owner,
          risk: normalized.policy.risk,
          now
        });
        const skill = getSkillRow(db, normalized.qualifiedName);
        const existing = findVersionRow(db, skill.id, normalized.versionId);
        if (existing) {
          assertImmutableVersion(existing, normalized);
          return mapVersion(existing);
        }
        const result = insertVersion.run({
          ...normalized,
          skillId: skill.id,
          policyJson: JSON.stringify(normalized.policy),
          now
        });
        return mapVersion(getVersionRow(db, Number(result.lastInsertRowid)));
      })();
    },

    getSkillByQualifiedName(qualifiedName: string): SkillRecord {
      return mapSkill(getSkillRow(db, qualifiedName.trim()));
    },

    listSkills(): SkillRecord[] {
      const rows = db.prepare(`
        SELECT skills.*, active_version.version_id AS active_version_id
        FROM skills
        LEFT JOIN skill_versions AS active_version ON active_version.id = skills.active_skill_version_id
        ORDER BY skills.qualified_name ASC
      `).all() as SkillRow[];
      return rows.map(mapSkill);
    },

    getSkillVersion(id: number): SkillVersionRecord {
      return mapVersion(getVersionRow(db, id));
    },

    getSkillVersionByCoordinates(qualifiedName: string, versionId: string): SkillVersionRecord {
      const skill = getSkillRow(db, qualifiedName.trim());
      const row = findVersionRow(db, skill.id, versionId.trim());
      if (!row) throw new Error(`Skill version not found: ${qualifiedName}@${versionId}`);
      return mapVersion(row);
    },

    listSkillVersions(qualifiedName?: string): SkillVersionRecord[] {
      const rows = qualifiedName
        ? db.prepare(`${VERSION_SELECT} WHERE skills.qualified_name = ? ORDER BY skill_versions.id DESC`)
          .all(qualifiedName.trim())
        : db.prepare(`${VERSION_SELECT} ORDER BY skills.qualified_name ASC, skill_versions.id DESC`).all();
      return (rows as SkillVersionRow[]).map(mapVersion);
    },

    updateSkillVersionStatus(
      id: number,
      status: Exclude<SkillVersionLifecycleStatus, "active">
    ): SkillVersionRecord {
      const current = getVersionRow(db, id);
      assertStatusTransition(current.status, status);
      if (status === "evaluated") assertPassingEvaluation(db, id);
      updateVersionStatus.run({ id, status, now: new Date().toISOString() });
      return mapVersion(getVersionRow(db, id));
    },

    activateSkillVersion(id: number): SkillVersionRecord {
      return promoteVersion(id);
    },

    rollbackSkillVersion(id: number): SkillVersionRecord {
      const target = getVersionRow(db, id);
      const skill = getSkillRow(db, target.qualified_name);
      if (skill.active_skill_version_id === target.id) {
        throw new Error(`Skill version ${target.qualified_name}@${target.version_id} is already active.`);
      }
      if (target.status !== "approved") {
        throw new Error(
          `Rollback target must be a previously approved Skill version: ${target.qualified_name}@${target.version_id}.`
        );
      }
      return promoteVersion(id);
    },

    restoreSkillVersion(id: number): SkillVersionRecord {
      const current = getVersionRow(db, id);
      if (current.status !== "retired") {
        throw new Error(`Only retired Skill versions can be restored: ${current.qualified_name}@${current.version_id}.`);
      }
      updateVersionStatus.run({ id, status: "approved", now: new Date().toISOString() });
      return mapVersion(getVersionRow(db, id));
    },

    archiveSkillVersion(id: number, actor: SkillArchiveActor): SkillVersionRecord {
      return db.transaction(() => {
        const current = getVersionRow(db, id);
        const skill = getSkillRow(db, current.qualified_name);
        if (skill.active_skill_version_id !== current.id) {
          throw new Error(`Only the active Skill version can be archived: ${current.qualified_name}@${current.version_id}.`);
        }
        if (actor === "curator" && skill.owner !== "agent") {
          throw new Error(`Automatic archival is restricted to agent-owned Skills: ${current.qualified_name}.`);
        }
        const now = new Date().toISOString();
        updateVersionStatus.run({ id: current.id, status: "retired", now });
        clearActiveSkillVersion.run({ skillId: skill.id, now });
        return mapVersion(getVersionRow(db, current.id));
      })();
    },

    getSkillUsageSummary(skillVersionRecordId: number): SkillUsageSummary {
      getVersionRow(db, skillVersionRecordId);
      const row = db.prepare(`
        SELECT COUNT(*) AS count, MAX(created_at) AS lastUsedAt
        FROM skill_usage WHERE skill_version_id = ?
      `).get(skillVersionRecordId) as { count: number; lastUsedAt: string | null };
      return { usageCount: row.count, lastUsedAt: row.lastUsedAt };
    },

    createSkillProposal(input: SkillProposalInput): SkillProposalRecord {
      const suggestedQualifiedName = input.suggestedQualifiedName.trim();
      if (!/^(?:system|user|repository|project):[a-z0-9]+(?:-[a-z0-9]+)*$/.test(suggestedQualifiedName)) {
        throw new Error(`Skill proposal has an invalid suggested qualified name: ${suggestedQualifiedName}.`);
      }
      const evidence = normalizeSkillProposalEvidence(input.evidence);
      if (evidence.length === 0) {
        throw new Error("Skill proposal requires at least one evidence reference.");
      }
      const now = new Date().toISOString();
      const result = insertSkillProposal.run({
        improvementProposalId: input.improvementProposalId,
        suggestedQualifiedName,
        evidenceJson: JSON.stringify(evidence),
        provenanceJson: JSON.stringify(input.provenance ?? {}),
        now
      });
      return getSkillProposalRecord(db, Number(result.lastInsertRowid));
    },

    getSkillProposal(id: number): SkillProposalRecord {
      return getSkillProposalRecord(db, id);
    },

    findSkillProposalByImprovementId(improvementProposalId: number): SkillProposalRecord | null {
      const row = db.prepare(`${SKILL_PROPOSAL_SELECT} WHERE skill_proposals.improvement_proposal_id = ?`)
        .get(improvementProposalId) as SkillProposalRow | undefined;
      return row ? mapSkillProposal(row) : null;
    },

    listSkillProposals(status?: SkillProposalStatus): SkillProposalRecord[] {
      const rows = status
        ? db.prepare(`${SKILL_PROPOSAL_SELECT} WHERE skill_proposals.status = ? ORDER BY skill_proposals.id DESC`)
          .all(status)
        : db.prepare(`${SKILL_PROPOSAL_SELECT} ORDER BY skill_proposals.id DESC`).all();
      return (rows as SkillProposalRow[]).map(mapSkillProposal);
    },

    linkSkillProposalDraft(id: number, skillVersionRecordId: number): SkillProposalRecord {
      const proposal = getSkillProposalRow(db, id);
      if (proposal.status !== "requested") {
        throw new Error(`Skill proposal ${id} is not awaiting a draft link.`);
      }
      const version = getVersionRow(db, skillVersionRecordId);
      const skill = getSkillRow(db, version.qualified_name);
      if (skill.owner !== "agent") {
        throw new Error(`Skill proposal drafts must link to agent-owned Skills: ${version.qualified_name}.`);
      }
      const linked = db.prepare("SELECT id FROM skill_proposals WHERE skill_version_id = ?")
        .get(skillVersionRecordId);
      if (linked) {
        throw new Error(`Skill version ${version.qualified_name}@${version.version_id} is already linked to a draft.`);
      }
      const result = linkSkillProposal.run({ id, skillVersionRecordId, now: new Date().toISOString() });
      if (result.changes !== 1) throw new Error(`Skill proposal ${id} could not be linked.`);
      return getSkillProposalRecord(db, id);
    },

    rejectSkillProposal(id: number, decisionNote: string): SkillProposalRecord {
      const note = redactSensitiveText(decisionNote.trim()).slice(0, 500);
      if (!note) throw new Error("Skill proposal rejection requires a decision note.");
      const result = rejectSkillProposalStatement.run({ id, decisionNote: note, now: new Date().toISOString() });
      if (result.changes !== 1) throw new Error(`Skill proposal ${id} is not awaiting a draft link.`);
      return getSkillProposalRecord(db, id);
    },

    pinGoalSkill(input: {
      runId: number;
      skillVersionRecordId: number;
      triggerReason: string;
      invocationMode: GoalSkillInvocationMode;
    }): GoalSkillPinRecord {
      assertGoalExists(db, input.runId);
      const version = getVersionRow(db, input.skillVersionRecordId);
      const skill = getSkillRow(db, version.qualified_name);
      if (version.status !== "active" || skill.active_skill_version_id !== version.id) {
        throw new Error(`Goal Skills must pin the active approved version: ${version.qualified_name}.`);
      }
      const triggerReason = redactSensitiveText(input.triggerReason.trim()).slice(0, 500);
      if (!triggerReason) throw new Error("Goal Skill pin requires a trigger reason.");
      if (!(["explicit", "implicit"] as const).includes(input.invocationMode)) {
        throw new Error(`Unsupported Skill invocation mode: ${input.invocationMode}.`);
      }
      pinGoalSkill.run({ ...input, triggerReason, now: new Date().toISOString() });
      return getPin(db, input.runId, input.skillVersionRecordId);
    },

    listGoalSkillPins(runId: number): GoalSkillPinRecord[] {
      assertGoalExists(db, runId);
      const rows = db.prepare(`${PIN_SELECT} WHERE goal_skill_pins.run_id = ? ORDER BY goal_skill_pins.id ASC`)
        .all(runId) as GoalSkillPinRow[];
      return rows.map(mapPin);
    },

    recordSkillEvaluation(input: SkillEvaluationInput): SkillEvaluationRecord {
      getVersionRow(db, input.skillVersionRecordId);
      validateEvaluationInput(input);
      const result = recordEvaluation.run({
        ...input,
        securityPassed: input.securityPassed ? 1 : 0,
        regressionDetected: input.regressionDetected ? 1 : 0,
        checksJson: JSON.stringify(input.checks.map((check) => ({
          id: redactSensitiveText(check.id).slice(0, 120),
          type: redactSensitiveText(check.type).slice(0, 80),
          status: check.status,
          message: redactSensitiveText(check.message).slice(0, 500)
        }))),
        now: new Date().toISOString()
      });
      return getEvaluation(db, Number(result.lastInsertRowid));
    },

    getLatestSkillEvaluation(skillVersionRecordId: number): SkillEvaluationRecord | null {
      getVersionRow(db, skillVersionRecordId);
      const row = db.prepare(`${EVALUATION_SELECT}
        WHERE skill_evaluations.skill_version_id = ? ORDER BY skill_evaluations.id DESC LIMIT 1
      `).get(skillVersionRecordId) as SkillEvaluationRow | undefined;
      return row ? mapEvaluation(row) : null;
    },

    listSkillEvaluations(skillVersionRecordId?: number): SkillEvaluationRecord[] {
      const rows = skillVersionRecordId === undefined
        ? db.prepare(`${EVALUATION_SELECT} ORDER BY skill_evaluations.id DESC`).all()
        : db.prepare(`${EVALUATION_SELECT}
            WHERE skill_evaluations.skill_version_id = ? ORDER BY skill_evaluations.id DESC
          `).all(skillVersionRecordId);
      return (rows as SkillEvaluationRow[]).map(mapEvaluation);
    },

    getSkillEvaluationComparison(evaluationId: number): SkillEvaluationComparison | null {
      const evaluation = getEvaluation(db, evaluationId);
      if (!evaluation.baselineVersionId) return null;
      const baselineVersion = findVersionByCoordinates(
        db,
        evaluation.qualifiedName,
        evaluation.baselineVersionId
      );
      if (!baselineVersion) return null;
      const baseline = db.prepare(`${EVALUATION_SELECT}
        WHERE skill_evaluations.skill_version_id = ? ORDER BY skill_evaluations.id DESC LIMIT 1
      `).get(baselineVersion.id) as SkillEvaluationRow | undefined;
      if (!baseline) return null;
      const baselineEvaluation = mapEvaluation(baseline);
      return {
        baselineVersionId: baselineEvaluation.versionId,
        qualityDelta: evaluation.qualityScore - baselineEvaluation.qualityScore,
        durationDeltaMs: evaluation.durationMs - baselineEvaluation.durationMs,
        estimatedTokensDelta: evaluation.estimatedTokens - baselineEvaluation.estimatedTokens,
        attemptsDelta: evaluation.attempts - baselineEvaluation.attempts,
        failuresDelta: evaluation.failures - baselineEvaluation.failures
      };
    },

    recordSkillUsage(input: Omit<SkillUsageRecord, "id" | "qualifiedName" | "versionId" | "createdAt">): SkillUsageRecord {
      assertGoalExists(db, input.runId);
      getVersionRow(db, input.skillVersionRecordId);
      assertGoalStepBelongsToRun(db, input.stepId, input.runId);
      assertSkillVersionPinnedToGoal(db, input.skillVersionRecordId, input.runId);
      if (input.durationMs < 0 || input.estimatedTokens < 0) throw new Error("Skill usage metrics are invalid.");
      const result = recordUsage.run({ ...input, now: new Date().toISOString() });
      return getUsage(db, Number(result.lastInsertRowid));
    },

    listSkillUsage(runId?: number, limit = 100): SkillUsageRecord[] {
      const rows = runId === undefined
        ? db.prepare(`${USAGE_SELECT} ORDER BY skill_usage.id DESC LIMIT ?`).all(limit)
        : db.prepare(`${USAGE_SELECT} WHERE skill_usage.run_id = ? ORDER BY skill_usage.id ASC LIMIT ?`)
          .all(runId, limit);
      return (rows as SkillUsageRow[]).map(mapUsage);
    }
  };
}

export function migrateSkillPersistence(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      qualified_name TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      scope TEXT NOT NULL,
      project_key TEXT,
      owner TEXT NOT NULL,
      risk TEXT NOT NULL,
      active_skill_version_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skill_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id INTEGER NOT NULL,
      version_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      description TEXT NOT NULL,
      snapshot_path TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'candidate',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(skill_id, version_id),
      FOREIGN KEY (skill_id) REFERENCES skills(id)
    );
    CREATE TABLE IF NOT EXISTS goal_skill_pins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      skill_version_id INTEGER NOT NULL,
      trigger_reason TEXT NOT NULL,
      invocation_mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, skill_version_id),
      FOREIGN KEY (run_id) REFERENCES goal_runs(id),
      FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id)
    );
    CREATE TABLE IF NOT EXISTS skill_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_version_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      quality_score REAL NOT NULL,
      duration_ms INTEGER NOT NULL,
      estimated_tokens INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      failures INTEGER NOT NULL,
      security_passed INTEGER NOT NULL,
      regression_detected INTEGER NOT NULL,
      baseline_version_id TEXT,
      checks_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id)
    );
    CREATE TABLE IF NOT EXISTS skill_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      step_id INTEGER NOT NULL,
      skill_version_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      phase TEXT NOT NULL,
      outcome TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      estimated_tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES goal_runs(id),
      FOREIGN KEY (step_id) REFERENCES goal_steps(id),
      FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id)
    );
    CREATE TABLE IF NOT EXISTS skill_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      improvement_proposal_id INTEGER NOT NULL UNIQUE,
      suggested_qualified_name TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT 'agent',
      status TEXT NOT NULL DEFAULT 'requested',
      skill_version_id INTEGER,
      evidence_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      decision_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (improvement_proposal_id) REFERENCES improvement_proposals(id),
      FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_skill_versions_skill_id ON skill_versions(skill_id, id);
    CREATE INDEX IF NOT EXISTS idx_goal_skill_pins_run_id ON goal_skill_pins(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_skill_evaluations_version_id ON skill_evaluations(skill_version_id, id);
    CREATE INDEX IF NOT EXISTS idx_skill_usage_run_id ON skill_usage(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_skill_proposals_status ON skill_proposals(status, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_proposals_skill_version
      ON skill_proposals(skill_version_id) WHERE skill_version_id IS NOT NULL;
  `);
}

const VERSION_SELECT = `
  SELECT skill_versions.*, skills.qualified_name
  FROM skill_versions
  JOIN skills ON skills.id = skill_versions.skill_id
`;
const PIN_SELECT = `
  SELECT goal_skill_pins.*, skill_versions.skill_id, skill_versions.version_id,
         skills.qualified_name
  FROM goal_skill_pins
  JOIN skill_versions ON skill_versions.id = goal_skill_pins.skill_version_id
  JOIN skills ON skills.id = skill_versions.skill_id
`;
const EVALUATION_SELECT = `
  SELECT skill_evaluations.*, skill_versions.version_id, skills.qualified_name
  FROM skill_evaluations
  JOIN skill_versions ON skill_versions.id = skill_evaluations.skill_version_id
  JOIN skills ON skills.id = skill_versions.skill_id
`;
const USAGE_SELECT = `
  SELECT skill_usage.*, skill_versions.version_id, skills.qualified_name
  FROM skill_usage
  JOIN skill_versions ON skill_versions.id = skill_usage.skill_version_id
  JOIN skills ON skills.id = skill_versions.skill_id
`;
const SKILL_PROPOSAL_SELECT = `
  SELECT skill_proposals.*, skill_versions.version_id AS linked_version_id,
         skills.qualified_name AS linked_qualified_name
  FROM skill_proposals
  LEFT JOIN skill_versions ON skill_versions.id = skill_proposals.skill_version_id
  LEFT JOIN skills ON skills.id = skill_versions.skill_id
`;

type SkillRow = {
  id: number;
  qualified_name: string;
  name: string;
  description: string;
  scope: SkillScope;
  project_key: string | null;
  owner: SkillPolicy["owner"];
  risk: SkillRisk;
  active_skill_version_id: number | null;
  active_version_id: string | null;
  created_at: string;
  updated_at: string;
};
type SkillVersionRow = {
  id: number;
  skill_id: number;
  qualified_name: string;
  version_id: string;
  content_hash: string;
  description: string;
  snapshot_path: string;
  policy_json: string;
  file_count: number;
  total_bytes: number;
  status: SkillVersionLifecycleStatus;
  created_at: string;
  updated_at: string;
};
type GoalSkillPinRow = {
  id: number;
  run_id: number;
  skill_version_id: number;
  skill_id: number;
  qualified_name: string;
  version_id: string;
  trigger_reason: string;
  invocation_mode: GoalSkillInvocationMode;
  created_at: string;
};
type SkillEvaluationRow = {
  id: number;
  skill_version_id: number;
  qualified_name: string;
  version_id: string;
  status: "passed" | "failed";
  quality_score: number;
  duration_ms: number;
  estimated_tokens: number;
  attempts: number;
  failures: number;
  security_passed: number;
  regression_detected: number;
  baseline_version_id: string | null;
  checks_json: string;
  created_at: string;
};
type SkillUsageRow = {
  id: number;
  run_id: number;
  step_id: number;
  skill_version_id: number;
  qualified_name: string;
  version_id: string;
  provider: AgentProviderId;
  phase: GoalPhase;
  outcome: AgentOutcome;
  duration_ms: number;
  estimated_tokens: number;
  created_at: string;
};
type SkillProposalRow = {
  id: number;
  improvement_proposal_id: number;
  suggested_qualified_name: string;
  owner: "agent";
  status: SkillProposalStatus;
  skill_version_id: number | null;
  linked_qualified_name: string | null;
  linked_version_id: string | null;
  evidence_json: string;
  provenance_json: string;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
};

function normalizeRegistration(input: SkillVersionRegistrationInput): SkillVersionRegistrationInput {
  const qualifiedName = input.qualifiedName.trim();
  const name = input.name.trim();
  const description = input.description.trim();
  const projectKey = input.projectKey?.trim().toLowerCase() || null;
  const versionId = input.versionId.trim().toLowerCase();
  const contentHash = input.contentHash.trim().toLowerCase();
  if (qualifiedName !== `${input.scope}:${name}`) throw new Error("Skill qualified name must match its scope and name.");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Skill name is invalid.");
  if (!description || description.length > 1_024) throw new Error("Skill description is required and must be at most 1024 characters.");
  if (!/^sha256:[a-f0-9]{64}$/.test(versionId) || versionId !== `sha256:${contentHash}`) {
    throw new Error("Skill version must match its SHA-256 content hash.");
  }
  if (!Number.isInteger(input.fileCount) || input.fileCount <= 0 || input.totalBytes < 0) {
    throw new Error("Skill version file metrics are invalid.");
  }
  if (input.scope === "project" && !projectKey) throw new Error("Project Skills require a project key.");
  return { ...input, qualifiedName, name, description, projectKey, versionId, contentHash, snapshotPath: path.resolve(input.snapshotPath.trim()) };
}

function getSkillRow(db: Database.Database, qualifiedName: string): SkillRow {
  const row = db.prepare(`
    SELECT skills.*, active_version.version_id AS active_version_id
    FROM skills
    LEFT JOIN skill_versions AS active_version ON active_version.id = skills.active_skill_version_id
    WHERE skills.qualified_name = ?
  `).get(qualifiedName) as SkillRow | undefined;
  if (!row) throw new Error(`Skill not found: ${qualifiedName}`);
  return row;
}

function getVersionRow(db: Database.Database, id: number): SkillVersionRow {
  const row = db.prepare(`${VERSION_SELECT} WHERE skill_versions.id = ?`).get(id) as SkillVersionRow | undefined;
  if (!row) throw new Error(`Skill version not found: ${id}`);
  return row;
}

function findVersionRow(db: Database.Database, skillId: number, versionId: string): SkillVersionRow | null {
  const row = db.prepare(`${VERSION_SELECT} WHERE skill_versions.skill_id = ? AND skill_versions.version_id = ?`)
    .get(skillId, versionId) as SkillVersionRow | undefined;
  return row ?? null;
}

function findVersionByCoordinates(
  db: Database.Database,
  qualifiedName: string,
  versionId: string
): SkillVersionRow | null {
  const row = db.prepare(`${VERSION_SELECT}
    WHERE skills.qualified_name = ? AND skill_versions.version_id = ?
  `).get(qualifiedName, versionId) as SkillVersionRow | undefined;
  return row ?? null;
}

function assertImmutableVersion(existing: SkillVersionRow, input: SkillVersionRegistrationInput): void {
  if (
    existing.content_hash !== input.contentHash
    || existing.description !== input.description
    || path.resolve(existing.snapshot_path) !== input.snapshotPath
    || existing.policy_json !== JSON.stringify(input.policy)
    || existing.file_count !== input.fileCount
    || existing.total_bytes !== input.totalBytes
  ) throw new Error(`Immutable Skill version conflicts with stored metadata: ${input.versionId}.`);
}

function assertStatusTransition(current: SkillVersionLifecycleStatus, next: Exclude<SkillVersionLifecycleStatus, "active">): void {
  if (current === next) return;
  const allowed: Record<SkillVersionLifecycleStatus, SkillVersionLifecycleStatus[]> = {
    candidate: ["evaluated", "rejected"],
    evaluated: ["approved", "rejected"],
    approved: ["retired"],
    active: [],
    rejected: [],
    retired: []
  };
  if (!allowed[current].includes(next)) throw new Error(`Invalid Skill version transition: ${current} -> ${next}.`);
}

function assertGoalExists(db: Database.Database, runId: number): void {
  if (!db.prepare("SELECT id FROM goal_runs WHERE id = ?").get(runId)) throw new Error(`Goal run not found: ${runId}`);
}

function assertGoalStepBelongsToRun(db: Database.Database, stepId: number, runId: number): void {
  const row = db.prepare("SELECT run_id FROM goal_steps WHERE id = ?").get(stepId) as { run_id: number } | undefined;
  if (!row || row.run_id !== runId) throw new Error(`Goal step ${stepId} does not belong to Goal run ${runId}.`);
}

function assertSkillVersionPinnedToGoal(
  db: Database.Database,
  skillVersionRecordId: number,
  runId: number
): void {
  const row = db.prepare(`
    SELECT id FROM goal_skill_pins WHERE run_id = ? AND skill_version_id = ?
  `).get(runId, skillVersionRecordId);
  if (!row) throw new Error("Skill usage requires the exact version to be pinned to the Goal.");
}

function assertPassingEvaluation(db: Database.Database, skillVersionRecordId: number): void {
  const row = db.prepare(`
    SELECT status, security_passed, regression_detected
    FROM skill_evaluations
    WHERE skill_version_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(skillVersionRecordId) as {
    status: "passed" | "failed";
    security_passed: number;
    regression_detected: number;
  } | undefined;
  if (!row || row.status !== "passed" || row.security_passed !== 1 || row.regression_detected !== 0) {
    throw new Error("Skill version requires a passing, secure, non-regressing evaluation.");
  }
}

function validateEvaluationInput(input: SkillEvaluationInput): void {
  if (
    !["passed", "failed"].includes(input.status)
    || !Number.isFinite(input.qualityScore)
    || input.qualityScore < 0
    || input.qualityScore > 1
    || ![input.durationMs, input.estimatedTokens, input.attempts, input.failures]
      .every((value) => Number.isInteger(value) && value >= 0)
    || input.checks.length === 0
    || input.checks.length > 128
  ) throw new Error("Skill evaluation metrics are invalid.");
  if (input.status === "passed" && (input.failures > 0 || !input.securityPassed || input.regressionDetected)) {
    throw new Error("Passing Skill evaluations cannot contain failures, security errors or regressions.");
  }
}

function normalizeSkillProposalEvidence(evidence: string[]): string[] {
  if (!Array.isArray(evidence)) return [];
  return evidence
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => redactSensitiveText(item.trim()).slice(0, 200))
    .slice(0, 20);
}

function getSkillProposalRow(db: Database.Database, id: number): SkillProposalRow {
  const row = db.prepare(`${SKILL_PROPOSAL_SELECT} WHERE skill_proposals.id = ?`)
    .get(id) as SkillProposalRow | undefined;
  if (!row) throw new Error(`Skill proposal not found: ${id}`);
  return row;
}

function getSkillProposalRecord(db: Database.Database, id: number): SkillProposalRecord {
  return mapSkillProposal(getSkillProposalRow(db, id));
}

function getPin(db: Database.Database, runId: number, versionId: number): GoalSkillPinRecord {
  const row = db.prepare(`${PIN_SELECT} WHERE goal_skill_pins.run_id = ? AND goal_skill_pins.skill_version_id = ?`)
    .get(runId, versionId) as GoalSkillPinRow | undefined;
  if (!row) throw new Error("Goal Skill pin was not persisted.");
  return mapPin(row);
}

function getEvaluation(db: Database.Database, id: number): SkillEvaluationRecord {
  const row = db.prepare(`${EVALUATION_SELECT} WHERE skill_evaluations.id = ?`)
    .get(id) as SkillEvaluationRow | undefined;
  if (!row) throw new Error(`Skill evaluation not found: ${id}`);
  return mapEvaluation(row);
}

function getUsage(db: Database.Database, id: number): SkillUsageRecord {
  const row = db.prepare(`${USAGE_SELECT} WHERE skill_usage.id = ?`).get(id) as SkillUsageRow | undefined;
  if (!row) throw new Error(`Skill usage not found: ${id}`);
  return mapUsage(row);
}

function mapSkill(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    qualifiedName: row.qualified_name,
    name: row.name,
    description: row.description,
    scope: row.scope,
    projectKey: row.project_key,
    owner: row.owner,
    risk: row.risk,
    activeVersionId: row.active_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapVersion(row: SkillVersionRow): SkillVersionRecord {
  return {
    id: row.id,
    skillId: row.skill_id,
    qualifiedName: row.qualified_name,
    versionId: row.version_id,
    contentHash: row.content_hash,
    description: row.description,
    snapshotPath: row.snapshot_path,
    policy: JSON.parse(row.policy_json) as SkillPolicy,
    fileCount: row.file_count,
    totalBytes: row.total_bytes,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPin(row: GoalSkillPinRow): GoalSkillPinRecord {
  return {
    id: row.id,
    runId: row.run_id,
    skillId: row.skill_id,
    skillVersionRecordId: row.skill_version_id,
    qualifiedName: row.qualified_name,
    versionId: row.version_id,
    triggerReason: row.trigger_reason,
    invocationMode: row.invocation_mode,
    createdAt: row.created_at
  };
}

function mapEvaluation(row: SkillEvaluationRow): SkillEvaluationRecord {
  return {
    id: row.id,
    skillVersionRecordId: row.skill_version_id,
    qualifiedName: row.qualified_name,
    versionId: row.version_id,
    status: row.status,
    qualityScore: row.quality_score,
    durationMs: row.duration_ms,
    estimatedTokens: row.estimated_tokens,
    attempts: row.attempts,
    failures: row.failures,
    securityPassed: row.security_passed === 1,
    regressionDetected: row.regression_detected === 1,
    baselineVersionId: row.baseline_version_id,
    checks: JSON.parse(row.checks_json) as SkillEvaluationCheck[],
    createdAt: row.created_at
  };
}

function mapUsage(row: SkillUsageRow): SkillUsageRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    skillVersionRecordId: row.skill_version_id,
    qualifiedName: row.qualified_name,
    versionId: row.version_id,
    provider: row.provider,
    phase: row.phase,
    outcome: row.outcome,
    durationMs: row.duration_ms,
    estimatedTokens: row.estimated_tokens,
    createdAt: row.created_at
  };
}

function mapSkillProposal(row: SkillProposalRow): SkillProposalRecord {
  return {
    id: row.id,
    improvementProposalId: row.improvement_proposal_id,
    suggestedQualifiedName: row.suggested_qualified_name,
    owner: row.owner,
    status: row.status,
    skillVersionRecordId: row.skill_version_id,
    qualifiedName: row.linked_qualified_name,
    versionId: row.linked_version_id,
    evidence: JSON.parse(row.evidence_json) as string[],
    provenance: JSON.parse(row.provenance_json) as Record<string, unknown>,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
