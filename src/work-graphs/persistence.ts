import Database from "better-sqlite3";
import { redactSensitiveText } from "../security/redaction.js";
import type {
  WorkGraphDetails,
  WorkGraphInput,
  WorkGraphRecord,
  WorkGraphStatus,
  WorkerArtifactKind,
  WorkerArtifactRecord,
  WorkerAttemptRecord,
  WorkerAttemptStatus,
  WorkerNodeRecord,
  WorkerNodeStatus
} from "./types.js";

export function createWorkGraphPersistence(db: Database.Database) {
  const insertGraph = db.prepare(`
    INSERT INTO work_graphs (
      run_id, objective, status, max_parallel_readers, created_at, updated_at, finished_at
    ) VALUES (@runId, @objective, 'draft', @maxParallelReaders, @now, @now, NULL)
  `);
  const insertNode = db.prepare(`
    INSERT INTO worker_nodes (
      graph_id, node_key, position, role, objective, capability, depends_on_json,
      input_artifacts_json, output_contract, skill_versions_json, mode, write_scope_json,
      max_attempts, deadline_ms, output_chars, status, attempt_count, last_error,
      created_at, updated_at, started_at, finished_at
    ) VALUES (
      @graphId, @key, @position, @role, @objective, @capability, @dependsOnJson,
      @inputArtifactsJson, @outputContract, @skillVersionsJson, @mode, @writeScopeJson,
      @maxAttempts, @deadlineMs, @outputChars, 'pending', 0, NULL,
      @now, @now, NULL, NULL
    )
  `);
  const updateGraph = db.prepare(`
    UPDATE work_graphs
    SET status = @status, updated_at = @now, finished_at = @finishedAt
    WHERE id = @id
  `);
  const updateNode = db.prepare(`
    UPDATE worker_nodes
    SET status = @status,
        last_error = @lastError,
        updated_at = @now,
        started_at = @startedAt,
        finished_at = @finishedAt
    WHERE id = @id
  `);
  const insertAttempt = db.prepare(`
    INSERT INTO worker_attempts (
      node_id, attempt_number, provider, status, summary, error,
      duration_ms, created_at, finished_at
    ) VALUES (
      @nodeId, @attemptNumber, @provider, 'running', '', NULL,
      NULL, @now, NULL
    )
  `);
  const incrementAttemptCount = db.prepare(`
    UPDATE worker_nodes
    SET attempt_count = attempt_count + 1, status = 'running',
        started_at = COALESCE(started_at, @now), updated_at = @now
    WHERE id = @nodeId
  `);
  const finishAttempt = db.prepare(`
    UPDATE worker_attempts
    SET status = @status, summary = @summary, error = @error,
        duration_ms = @durationMs, finished_at = @now
    WHERE id = @id AND status = 'running'
  `);
  const insertArtifact = db.prepare(`
    INSERT INTO worker_artifacts (
      graph_id, node_id, attempt_id, artifact_key, kind, summary,
      content_hash, bytes, created_at
    ) VALUES (
      @graphId, @nodeId, @attemptId, @key, @kind, @summary,
      @contentHash, @bytes, @now
    )
  `);

  return {
    createWorkGraph(input: WorkGraphInput): WorkGraphDetails {
      const normalized = normalizeGraphInput(input);
      assertGoalRunExists(db, normalized.runId);
      const now = new Date().toISOString();
      return db.transaction(() => {
        const result = insertGraph.run({
          runId: normalized.runId,
          objective: normalized.objective,
          maxParallelReaders: normalized.maxParallelReaders,
          now
        });
        const graphId = Number(result.lastInsertRowid);
        normalized.nodes.forEach((node, position) => insertNode.run({
          graphId,
          position,
          ...node,
          dependsOnJson: JSON.stringify(node.dependsOn),
          inputArtifactsJson: JSON.stringify(node.inputArtifacts),
          skillVersionsJson: JSON.stringify(node.skillVersions),
          writeScopeJson: JSON.stringify(node.writeScope),
          now
        }));
        return getWorkGraphDetails(db, graphId);
      })();
    },

    getWorkGraph(id: number): WorkGraphRecord {
      return mapGraph(getGraphRow(db, id));
    },

    findWorkGraphByRunId(runId: number): WorkGraphRecord | null {
      const row = db.prepare("SELECT * FROM work_graphs WHERE run_id = ?").get(runId) as WorkGraphRow | undefined;
      return row ? mapGraph(row) : null;
    },

    getWorkGraphDetails(id: number): WorkGraphDetails {
      return getWorkGraphDetails(db, id);
    },

    listWorkerNodes(graphId: number): WorkerNodeRecord[] {
      getGraphRow(db, graphId);
      return listNodeRows(db, graphId).map(mapNode);
    },

    updateWorkGraphStatus(id: number, status: WorkGraphStatus): WorkGraphRecord {
      const graph = mapGraph(getGraphRow(db, id));
      assertGraphTransition(graph.status, status);
      const terminal = ["completed", "blocked", "cancelled"].includes(status);
      updateGraph.run({
        id,
        status,
        now: new Date().toISOString(),
        finishedAt: terminal ? new Date().toISOString() : null
      });
      return mapGraph(getGraphRow(db, id));
    },

    updateWorkerNodeStatus(id: number, status: WorkerNodeStatus, error?: string | null): WorkerNodeRecord {
      const node = mapNode(getNodeRow(db, id));
      assertNodeTransition(node.status, status);
      const now = new Date().toISOString();
      updateNode.run({
        id,
        status,
        lastError: error ? bounded(error, 500) : null,
        now,
        startedAt: status === "running" ? node.startedAt ?? now : node.startedAt,
        finishedAt: isNodeTerminal(status) ? now : null
      });
      return mapNode(getNodeRow(db, id));
    },

    createWorkerAttempt(nodeId: number, provider: "codex" | "claude"): WorkerAttemptRecord {
      return db.transaction(() => {
        const node = mapNode(getNodeRow(db, nodeId));
        if (node.attemptCount >= node.maxAttempts) {
          throw new Error(`Worker ${node.key} exhausted its attempt budget.`);
        }
        if (!["ready", "running", "waiting_provider", "failed"].includes(node.status)) {
          throw new Error(`Worker ${node.key} cannot start an attempt from ${node.status}.`);
        }
        const now = new Date().toISOString();
        const attemptNumber = node.attemptCount + 1;
        const result = insertAttempt.run({ nodeId, attemptNumber, provider, now });
        incrementAttemptCount.run({ nodeId, now });
        return mapAttempt(getAttemptRow(db, Number(result.lastInsertRowid)));
      })();
    },

    finishWorkerAttempt(input: {
      id: number;
      status: Exclude<WorkerAttemptStatus, "running">;
      summary: string;
      error?: string | null;
      durationMs: number;
    }): WorkerAttemptRecord {
      const current = mapAttempt(getAttemptRow(db, input.id));
      if (current.status !== "running") throw new Error(`Worker attempt #${input.id} is already finished.`);
      if (!Number.isInteger(input.durationMs) || input.durationMs < 0) {
        throw new Error("Worker attempt duration must be a non-negative integer.");
      }
      const result = finishAttempt.run({
        id: input.id,
        status: input.status,
        summary: bounded(input.summary, 2_000),
        error: input.error ? bounded(input.error, 500) : null,
        durationMs: input.durationMs,
        now: new Date().toISOString()
      });
      if (result.changes !== 1) throw new Error(`Worker attempt #${input.id} could not be finished.`);
      return mapAttempt(getAttemptRow(db, input.id));
    },

    listWorkerAttempts(nodeId: number): WorkerAttemptRecord[] {
      getNodeRow(db, nodeId);
      const rows = db.prepare("SELECT * FROM worker_attempts WHERE node_id = ? ORDER BY attempt_number ASC")
        .all(nodeId) as WorkerAttemptRow[];
      return rows.map(mapAttempt);
    },

    addWorkerArtifact(input: {
      graphId: number;
      nodeId: number;
      attemptId?: number | null;
      key: string;
      kind: WorkerArtifactKind;
      summary: string;
      contentHash?: string | null;
      bytes: number;
    }): WorkerArtifactRecord {
      const node = mapNode(getNodeRow(db, input.nodeId));
      if (node.graphId !== input.graphId) throw new Error("Worker artifact graph and node do not match.");
      if (input.attemptId !== undefined && input.attemptId !== null) {
        const attempt = mapAttempt(getAttemptRow(db, input.attemptId));
        if (attempt.nodeId !== node.id) throw new Error("Worker artifact attempt and node do not match.");
      }
      if (!Number.isInteger(input.bytes) || input.bytes < 0) throw new Error("Worker artifact bytes are invalid.");
      const key = input.key.trim();
      if (!key || key.length > 500) throw new Error("Worker artifact key is invalid.");
      const result = insertArtifact.run({
        ...input,
        attemptId: input.attemptId ?? null,
        key,
        summary: bounded(input.summary, 1_000),
        contentHash: input.contentHash?.trim() || null,
        now: new Date().toISOString()
      });
      return mapArtifact(getArtifactRow(db, Number(result.lastInsertRowid)));
    },

    listWorkerArtifacts(graphId: number, nodeId?: number): WorkerArtifactRecord[] {
      getGraphRow(db, graphId);
      const rows = nodeId === undefined
        ? db.prepare("SELECT * FROM worker_artifacts WHERE graph_id = ? ORDER BY id ASC").all(graphId)
        : db.prepare("SELECT * FROM worker_artifacts WHERE graph_id = ? AND node_id = ? ORDER BY id ASC")
          .all(graphId, nodeId);
      return (rows as WorkerArtifactRow[]).map(mapArtifact);
    }
  };
}

export function migrateWorkGraphPersistence(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_graphs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL UNIQUE,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      max_parallel_readers INTEGER NOT NULL DEFAULT 2,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY (run_id) REFERENCES goal_runs(id)
    );
    CREATE TABLE IF NOT EXISTS worker_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      graph_id INTEGER NOT NULL,
      node_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      role TEXT NOT NULL,
      objective TEXT NOT NULL,
      capability TEXT NOT NULL,
      depends_on_json TEXT NOT NULL DEFAULT '[]',
      input_artifacts_json TEXT NOT NULL DEFAULT '[]',
      output_contract TEXT NOT NULL,
      skill_versions_json TEXT NOT NULL DEFAULT '[]',
      mode TEXT NOT NULL,
      write_scope_json TEXT NOT NULL DEFAULT '[]',
      max_attempts INTEGER NOT NULL,
      deadline_ms INTEGER NOT NULL,
      output_chars INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      UNIQUE(graph_id, node_key),
      FOREIGN KEY (graph_id) REFERENCES work_graphs(id)
    );
    CREATE TABLE IF NOT EXISTS worker_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL,
      attempt_number INTEGER NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      summary TEXT NOT NULL DEFAULT '',
      error TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE(node_id, attempt_number),
      FOREIGN KEY (node_id) REFERENCES worker_nodes(id)
    );
    CREATE TABLE IF NOT EXISTS worker_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      graph_id INTEGER NOT NULL,
      node_id INTEGER NOT NULL,
      attempt_id INTEGER,
      artifact_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      content_hash TEXT,
      bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(graph_id, artifact_key),
      FOREIGN KEY (graph_id) REFERENCES work_graphs(id),
      FOREIGN KEY (node_id) REFERENCES worker_nodes(id),
      FOREIGN KEY (attempt_id) REFERENCES worker_attempts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_worker_nodes_graph_status
      ON worker_nodes(graph_id, status, position);
    CREATE INDEX IF NOT EXISTS idx_worker_attempts_node
      ON worker_attempts(node_id, attempt_number);
    CREATE INDEX IF NOT EXISTS idx_worker_artifacts_node
      ON worker_artifacts(node_id, id);
  `);
}

function normalizeGraphInput(input: WorkGraphInput): Required<Omit<WorkGraphInput, "nodes">> & { nodes: NormalizedNode[] } {
  if (!Number.isInteger(input.runId) || input.runId <= 0) throw new Error("Work Graph requires a valid Goal run.");
  const objective = bounded(input.objective, 2_000);
  if (!objective) throw new Error("Work Graph requires an objective.");
  const maxParallelReaders = input.maxParallelReaders ?? 2;
  if (!Number.isInteger(maxParallelReaders) || maxParallelReaders < 1 || maxParallelReaders > 2) {
    throw new Error("Work Graph maxParallelReaders must be between 1 and 2.");
  }
  if (input.nodes.length === 0) throw new Error("Work Graph requires at least one Worker Node.");
  const nodes = input.nodes.map((node) => ({
    key: normalizeKey(node.key),
    role: node.role,
    objective: requiredText(node.objective, "Worker objective", 2_000),
    capability: node.capability,
    dependsOn: uniqueStrings(node.dependsOn ?? [], 20),
    inputArtifacts: uniqueStrings(node.inputArtifacts ?? [], 50),
    outputContract: requiredText(node.outputContract, "Worker output contract", 2_000),
    skillVersions: uniqueStrings(node.skillVersions ?? [], 20),
    mode: node.mode,
    writeScope: uniqueStrings(node.writeScope ?? [], 50),
    maxAttempts: positiveInteger(node.budget.maxAttempts, "Worker maxAttempts"),
    deadlineMs: positiveInteger(node.budget.deadlineMs, "Worker deadlineMs"),
    outputChars: positiveInteger(node.budget.outputChars, "Worker outputChars")
  }));
  const keys = nodes.map((node) => node.key);
  if (new Set(keys).size !== keys.length) throw new Error("Worker Node keys must be unique.");
  return { runId: input.runId, objective, maxParallelReaders, nodes };
}

type NormalizedNode = {
  key: string;
  role: WorkGraphInput["nodes"][number]["role"];
  objective: string;
  capability: WorkGraphInput["nodes"][number]["capability"];
  dependsOn: string[];
  inputArtifacts: string[];
  outputContract: string;
  skillVersions: string[];
  mode: WorkGraphInput["nodes"][number]["mode"];
  writeScope: string[];
  maxAttempts: number;
  deadlineMs: number;
  outputChars: number;
};

function assertGraphTransition(from: WorkGraphStatus, to: WorkGraphStatus): void {
  const allowed: Record<WorkGraphStatus, WorkGraphStatus[]> = {
    draft: ["validated", "blocked", "cancelled"],
    validated: ["running", "blocked", "cancelled"],
    running: ["completed", "blocked", "cancelled"],
    completed: [],
    blocked: [],
    cancelled: []
  };
  if (from !== to && !allowed[from].includes(to)) throw new Error(`Invalid Work Graph transition: ${from} -> ${to}.`);
}

function assertNodeTransition(from: WorkerNodeStatus, to: WorkerNodeStatus): void {
  const allowed: Record<WorkerNodeStatus, WorkerNodeStatus[]> = {
    pending: ["ready", "blocked", "cancelled"],
    ready: ["running", "waiting_provider", "blocked", "cancelled"],
    running: ["waiting_provider", "completed", "blocked", "failed", "cancelled"],
    waiting_provider: ["ready", "running", "blocked", "cancelled"],
    failed: ["ready", "running", "blocked", "cancelled"],
    completed: [],
    blocked: [],
    cancelled: []
  };
  if (from !== to && !allowed[from].includes(to)) throw new Error(`Invalid Worker Node transition: ${from} -> ${to}.`);
}

function isNodeTerminal(status: WorkerNodeStatus): boolean {
  return ["completed", "blocked", "cancelled"].includes(status);
}

function assertGoalRunExists(db: Database.Database, runId: number): void {
  if (!db.prepare("SELECT id FROM goal_runs WHERE id = ?").get(runId)) throw new Error(`Goal run not found: ${runId}`);
}

function getWorkGraphDetails(db: Database.Database, id: number): WorkGraphDetails {
  return { ...mapGraph(getGraphRow(db, id)), nodes: listNodeRows(db, id).map(mapNode) };
}

function getGraphRow(db: Database.Database, id: number): WorkGraphRow {
  const row = db.prepare("SELECT * FROM work_graphs WHERE id = ?").get(id) as WorkGraphRow | undefined;
  if (!row) throw new Error(`Work Graph not found: ${id}`);
  return row;
}

function listNodeRows(db: Database.Database, graphId: number): WorkerNodeRow[] {
  return db.prepare("SELECT * FROM worker_nodes WHERE graph_id = ? ORDER BY position ASC")
    .all(graphId) as WorkerNodeRow[];
}

function getNodeRow(db: Database.Database, id: number): WorkerNodeRow {
  const row = db.prepare("SELECT * FROM worker_nodes WHERE id = ?").get(id) as WorkerNodeRow | undefined;
  if (!row) throw new Error(`Worker Node not found: ${id}`);
  return row;
}

function getAttemptRow(db: Database.Database, id: number): WorkerAttemptRow {
  const row = db.prepare("SELECT * FROM worker_attempts WHERE id = ?").get(id) as WorkerAttemptRow | undefined;
  if (!row) throw new Error(`Worker attempt not found: ${id}`);
  return row;
}

function getArtifactRow(db: Database.Database, id: number): WorkerArtifactRow {
  const row = db.prepare("SELECT * FROM worker_artifacts WHERE id = ?").get(id) as WorkerArtifactRow | undefined;
  if (!row) throw new Error(`Worker artifact not found: ${id}`);
  return row;
}

function mapGraph(row: WorkGraphRow): WorkGraphRecord {
  return {
    id: row.id,
    runId: row.run_id,
    objective: row.objective,
    status: row.status,
    maxParallelReaders: row.max_parallel_readers,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at
  };
}

function mapNode(row: WorkerNodeRow): WorkerNodeRecord {
  return {
    id: row.id,
    graphId: row.graph_id,
    key: row.node_key,
    position: row.position,
    role: row.role,
    objective: row.objective,
    capability: row.capability,
    dependsOn: parseStringArray(row.depends_on_json),
    inputArtifacts: parseStringArray(row.input_artifacts_json),
    outputContract: row.output_contract,
    skillVersions: parseStringArray(row.skill_versions_json),
    mode: row.mode,
    writeScope: parseStringArray(row.write_scope_json),
    maxAttempts: row.max_attempts,
    deadlineMs: row.deadline_ms,
    outputChars: row.output_chars,
    status: row.status,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

function mapAttempt(row: WorkerAttemptRow): WorkerAttemptRecord {
  return {
    id: row.id,
    nodeId: row.node_id,
    attemptNumber: row.attempt_number,
    provider: row.provider,
    status: row.status,
    summary: row.summary,
    error: row.error,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    finishedAt: row.finished_at
  };
}

function mapArtifact(row: WorkerArtifactRow): WorkerArtifactRecord {
  return {
    id: row.id,
    graphId: row.graph_id,
    nodeId: row.node_id,
    attemptId: row.attempt_id,
    key: row.artifact_key,
    kind: row.kind,
    summary: row.summary,
    contentHash: row.content_hash,
    bytes: row.bytes,
    createdAt: row.created_at
  };
}

function requiredText(value: string, label: string, max: number): string {
  const normalized = bounded(value, max);
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function bounded(value: string, max: number): string {
  return redactSensitiveText(value.trim()).slice(0, max);
}

function normalizeKey(value: string): string {
  const key = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(key)) throw new Error(`Invalid Worker Node key: ${value}`);
  return key;
}

function uniqueStrings(values: string[], limit: number): string[] {
  if (values.length > limit) throw new Error(`Worker list exceeds ${limit} entries.`);
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return [];
  return parsed;
}

type WorkGraphRow = {
  id: number;
  run_id: number;
  objective: string;
  status: WorkGraphStatus;
  max_parallel_readers: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

type WorkerNodeRow = {
  id: number;
  graph_id: number;
  node_key: string;
  position: number;
  role: WorkerNodeRecord["role"];
  objective: string;
  capability: WorkerNodeRecord["capability"];
  depends_on_json: string;
  input_artifacts_json: string;
  output_contract: string;
  skill_versions_json: string;
  mode: WorkerNodeRecord["mode"];
  write_scope_json: string;
  max_attempts: number;
  deadline_ms: number;
  output_chars: number;
  status: WorkerNodeStatus;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type WorkerAttemptRow = {
  id: number;
  node_id: number;
  attempt_number: number;
  provider: WorkerAttemptRecord["provider"];
  status: WorkerAttemptStatus;
  summary: string;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
  finished_at: string | null;
};

type WorkerArtifactRow = {
  id: number;
  graph_id: number;
  node_id: number;
  attempt_id: number | null;
  artifact_key: string;
  kind: WorkerArtifactKind;
  summary: string;
  content_hash: string | null;
  bytes: number;
  created_at: string;
};

