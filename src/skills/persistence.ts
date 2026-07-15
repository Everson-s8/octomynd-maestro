import Database from "better-sqlite3";
import path from "node:path";
import { redactSensitiveText } from "../security/redaction.js";
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
      updateVersionStatus.run({ id, status, now: new Date().toISOString() });
      return mapVersion(getVersionRow(db, id));
    },

    activateSkillVersion(id: number): SkillVersionRecord {
      return db.transaction(() => {
        const selected = getVersionRow(db, id);
        if (!(["approved", "active"] as const).includes(selected.status as "approved" | "active")) {
          throw new Error(`Skill version ${selected.qualified_name}@${selected.version_id} is not approved.`);
        }
        const skill = getSkillRow(db, selected.qualified_name);
        const now = new Date().toISOString();
        if (skill.active_skill_version_id && skill.active_skill_version_id !== selected.id) {
          updateVersionStatus.run({ id: skill.active_skill_version_id, status: "approved", now });
        }
        updateVersionStatus.run({ id: selected.id, status: "active", now });
        activateSkill.run({ skillId: skill.id, skillVersionRecordId: selected.id, now });
        return mapVersion(getVersionRow(db, selected.id));
      })();
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
    CREATE INDEX IF NOT EXISTS idx_skill_versions_skill_id ON skill_versions(skill_id, id);
    CREATE INDEX IF NOT EXISTS idx_goal_skill_pins_run_id ON goal_skill_pins(run_id, id);
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

function getPin(db: Database.Database, runId: number, versionId: number): GoalSkillPinRecord {
  const row = db.prepare(`${PIN_SELECT} WHERE goal_skill_pins.run_id = ? AND goal_skill_pins.skill_version_id = ?`)
    .get(runId, versionId) as GoalSkillPinRow | undefined;
  if (!row) throw new Error("Goal Skill pin was not persisted.");
  return mapPin(row);
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
