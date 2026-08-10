import Database from "better-sqlite3";
import {
  WorkIntakeClassification,
  WorkIntakeCoordinationSignal,
  WorkIntakeCostEstimate,
  WorkIntakeDecision,
  WorkIntakeEvidencePack,
  WorkIntakeReasonCode,
  WORK_INTAKE_POLICY_VERSION
} from "./types.js";

type WorkIntakeDecisionRow = {
  id: string;
  project_key: string | null;
  objective: string;
  classification: WorkIntakeClassification;
  reason_code: WorkIntakeReasonCode;
  confidence: number;
  policy_version: number;
  coordination_json: string;
  cost_estimate_json: string;
  acceptance_criteria_json: string;
  explicit_override: WorkIntakeClassification | null;
  evidence_json: string;
  created_at: string;
};

export function createWorkIntakePersistence(db: Database.Database) {
  const insertDecision = db.prepare(`
    INSERT INTO work_intake_decisions (
      id, project_key, objective, classification, reason_code, confidence,
      policy_version, coordination_json, cost_estimate_json, acceptance_criteria_json,
      explicit_override, evidence_json, created_at
    ) VALUES (
      @id, @projectKey, @objective, @classification, @reasonCode, @confidence,
      @policyVersion, @coordinationJson, @costEstimateJson, @acceptanceCriteriaJson,
      @explicitOverride, @evidenceJson, @createdAt
    )
    ON CONFLICT(id) DO UPDATE SET
      project_key = excluded.project_key,
      objective = excluded.objective,
      classification = excluded.classification,
      reason_code = excluded.reason_code,
      confidence = excluded.confidence,
      policy_version = excluded.policy_version,
      coordination_json = excluded.coordination_json,
      cost_estimate_json = excluded.cost_estimate_json,
      acceptance_criteria_json = excluded.acceptance_criteria_json,
      explicit_override = excluded.explicit_override,
      evidence_json = excluded.evidence_json,
      created_at = excluded.created_at
  `);

  return {
    saveWorkIntakeDecision(decision: WorkIntakeDecision): WorkIntakeDecision {
      insertDecision.run({
        id: decision.id,
        projectKey: decision.projectKey,
        objective: decision.objective,
        classification: decision.classification,
        reasonCode: decision.reasonCode,
        confidence: decision.confidence,
        policyVersion: decision.policyVersion,
        coordinationJson: JSON.stringify(decision.coordination),
        costEstimateJson: JSON.stringify(decision.costEstimate),
        acceptanceCriteriaJson: JSON.stringify(decision.acceptanceCriteria),
        explicitOverride: decision.explicitOverride,
        evidenceJson: JSON.stringify(decision.evidence),
        createdAt: decision.createdAt
      });
      const saved = this.getWorkIntakeDecision(decision.id);
      if (!saved) {
        throw new Error(`Failed to save Work Intake decision: ${decision.id}`);
      }
      return saved;
    },

    getWorkIntakeDecision(id: string): WorkIntakeDecision | null {
      const row = db.prepare("SELECT * FROM work_intake_decisions WHERE id = ?").get(id) as
        | WorkIntakeDecisionRow
        | undefined;
      return row ? mapRowToDecision(row) : null;
    },

    listWorkIntakeDecisions(options?: {
      projectKey?: string;
      classification?: WorkIntakeClassification;
      limit?: number;
    }): WorkIntakeDecision[] {
      const limit = Math.max(1, Math.min(100, Math.trunc(options?.limit ?? 30)));
      let query = "SELECT * FROM work_intake_decisions WHERE 1=1";
      const params: (string | number)[] = [];

      if (options?.projectKey) {
        query += " AND project_key = ?";
        params.push(options.projectKey);
      }
      if (options?.classification) {
        query += " AND classification = ?";
        params.push(options.classification);
      }

      query += " ORDER BY created_at DESC LIMIT ?";
      params.push(limit);

      const rows = db.prepare(query).all(...params) as WorkIntakeDecisionRow[];
      return rows.map(mapRowToDecision);
    }
  };
}

export function migrateWorkIntakePersistence(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_intake_decisions (
      id TEXT PRIMARY KEY,
      project_key TEXT,
      objective TEXT NOT NULL,
      classification TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      confidence REAL NOT NULL,
      policy_version INTEGER NOT NULL,
      coordination_json TEXT NOT NULL,
      cost_estimate_json TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL,
      explicit_override TEXT,
      evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_intake_decisions_project
      ON work_intake_decisions(project_key);
    CREATE INDEX IF NOT EXISTS idx_work_intake_decisions_classification
      ON work_intake_decisions(classification);
  `);
}

function mapRowToDecision(row: WorkIntakeDecisionRow): WorkIntakeDecision {
  return {
    id: row.id,
    projectKey: row.project_key,
    objective: row.objective,
    classification: row.classification,
    reasonCode: row.reason_code,
    confidence: row.confidence,
    policyVersion: (row.policy_version as typeof WORK_INTAKE_POLICY_VERSION) ?? WORK_INTAKE_POLICY_VERSION,
    coordination: JSON.parse(row.coordination_json) as WorkIntakeCoordinationSignal,
    costEstimate: JSON.parse(row.cost_estimate_json) as WorkIntakeCostEstimate,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json) as string[],
    explicitOverride: row.explicit_override,
    evidence: JSON.parse(row.evidence_json) as WorkIntakeEvidencePack,
    createdAt: row.created_at
  };
}
