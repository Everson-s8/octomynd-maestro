import type Database from "better-sqlite3";
import {
  WorkIntakeCategory,
  WorkIntakeClassification,
  WorkIntakeMetrics,
  WorkIntakeMode
} from "./types.js";

export function migrateWorkIntakePersistence(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_intake_classifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL UNIQUE,
      category TEXT NOT NULL,
      decision_mode TEXT NOT NULL,
      actual_mode TEXT NOT NULL,
      override_mode TEXT,
      score REAL NOT NULL DEFAULT 0.0,
      reasons_json TEXT NOT NULL DEFAULT '[]',
      estimated_overhead_ms REAL NOT NULL DEFAULT 0.0,
      prior_workflow_overhead_ms REAL NOT NULL DEFAULT 4000.0,
      override_applied INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_work_intake_task_id
      ON work_intake_classifications(task_id);
    CREATE INDEX IF NOT EXISTS idx_work_intake_category
      ON work_intake_classifications(category);
    CREATE INDEX IF NOT EXISTS idx_work_intake_actual_mode
      ON work_intake_classifications(actual_mode);
  `);
}

export function saveWorkIntakeClassification(
  db: Database.Database,
  classification: WorkIntakeClassification
): WorkIntakeClassification {
  const now = new Date().toISOString();
  const reasonsJson = JSON.stringify(classification.reasons || []);
  const overrideAppliedInt = classification.overrideApplied ? 1 : 0;

  const stmt = db.prepare(`
    INSERT INTO work_intake_classifications (
      task_id, category, decision_mode, actual_mode, override_mode,
      score, reasons_json, estimated_overhead_ms, prior_workflow_overhead_ms,
      override_applied, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    ) ON CONFLICT(task_id) DO UPDATE SET
      category = excluded.category,
      decision_mode = excluded.decision_mode,
      actual_mode = excluded.actual_mode,
      override_mode = excluded.override_mode,
      score = excluded.score,
      reasons_json = excluded.reasons_json,
      estimated_overhead_ms = excluded.estimated_overhead_ms,
      prior_workflow_overhead_ms = excluded.prior_workflow_overhead_ms,
      override_applied = excluded.override_applied,
      updated_at = excluded.updated_at
  `);

  const info = stmt.run(
    classification.taskId,
    classification.category,
    classification.decisionMode,
    classification.actualMode,
    classification.overrideMode ?? null,
    classification.score,
    reasonsJson,
    classification.estimatedOverheadMs,
    classification.priorWorkflowOverheadMs,
    overrideAppliedInt,
    classification.createdAt || now,
    now
  );

  return {
    ...classification,
    id: classification.id || Number(info.lastInsertRowid),
    createdAt: classification.createdAt || now,
    updatedAt: now
  };
}

interface RawWorkIntakeRow {
  id: number;
  task_id: number;
  category: string;
  decision_mode: string;
  actual_mode: string;
  override_mode: string | null;
  score: number;
  reasons_json: string;
  estimated_overhead_ms: number;
  prior_workflow_overhead_ms: number;
  override_applied: number;
  created_at: string;
  updated_at: string;
}

function mapRowToClassification(row: RawWorkIntakeRow): WorkIntakeClassification {
  let reasons: string[] = [];
  try {
    reasons = JSON.parse(row.reasons_json || "[]");
  } catch {
    reasons = [];
  }

  return {
    id: row.id,
    taskId: row.task_id,
    category: row.category as WorkIntakeCategory,
    decisionMode: row.decision_mode as WorkIntakeMode,
    actualMode: row.actual_mode as WorkIntakeMode,
    overrideMode: row.override_mode as WorkIntakeMode | null,
    score: row.score,
    reasons,
    estimatedOverheadMs: row.estimated_overhead_ms,
    priorWorkflowOverheadMs: row.prior_workflow_overhead_ms,
    overrideApplied: Boolean(row.override_applied),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function getWorkIntakeClassificationByTaskId(
  db: Database.Database,
  taskId: number
): WorkIntakeClassification | null {
  const row = db
    .prepare("SELECT * FROM work_intake_classifications WHERE task_id = ?")
    .get(taskId) as RawWorkIntakeRow | undefined;

  return row ? mapRowToClassification(row) : null;
}

export function listWorkIntakeClassifications(
  db: Database.Database,
  limit = 50
): WorkIntakeClassification[] {
  const rows = db
    .prepare("SELECT * FROM work_intake_classifications ORDER BY id DESC LIMIT ?")
    .all(limit) as RawWorkIntakeRow[];

  return rows.map(mapRowToClassification);
}

export function getWorkIntakeMetrics(db: Database.Database): WorkIntakeMetrics {
  const all = listWorkIntakeClassifications(db, 1000);
  const total = all.length;

  const categoryCounts: Record<WorkIntakeCategory, number> = {
    tiny_fix: 0,
    documentation: 0,
    audit: 0,
    multi_deliverable_feature: 0,
    dependent_work: 0,
    parallel_safe_work: 0,
    ambiguous_request: 0,
    explicit_override: 0
  };

  const modeCounts: Record<WorkIntakeMode, number> = {
    single_agent: 0,
    feature_plan: 0,
    work_graph: 0,
    needs_clarification: 0
  };

  let overrideCount = 0;
  let totalOverhead = 0;
  let totalPriorOverhead = 0;

  for (const item of all) {
    if (categoryCounts[item.category] !== undefined) {
      categoryCounts[item.category]++;
    }
    if (modeCounts[item.actualMode] !== undefined) {
      modeCounts[item.actualMode]++;
    }
    if (item.overrideApplied) {
      overrideCount++;
    }
    totalOverhead += item.estimatedOverheadMs;
    totalPriorOverhead += item.priorWorkflowOverheadMs;
  }

  const averageOverheadMs = total > 0 ? Number((totalOverhead / total).toFixed(3)) : 0;
  const averagePriorWorkflowOverheadMs = total > 0 ? Number((totalPriorOverhead / total).toFixed(3)) : 4000;
  const overheadReductionRatio = averagePriorWorkflowOverheadMs > 0
    ? Number((1 - averageOverheadMs / averagePriorWorkflowOverheadMs).toFixed(4))
    : 0;

  return {
    totalClassifications: total,
    categoryCounts,
    modeCounts,
    overrideCount,
    averageOverheadMs,
    averagePriorWorkflowOverheadMs,
    overheadReductionRatio
  };
}

export function createWorkIntakePersistence(db: Database.Database) {
  return {
    saveWorkIntakeClassification: (classification: WorkIntakeClassification) =>
      saveWorkIntakeClassification(db, classification),
    getWorkIntakeClassificationByTaskId: (taskId: number) =>
      getWorkIntakeClassificationByTaskId(db, taskId),
    listWorkIntakeClassifications: (limit?: number) =>
      listWorkIntakeClassifications(db, limit),
    getWorkIntakeMetrics: () => getWorkIntakeMetrics(db)
  };
}
