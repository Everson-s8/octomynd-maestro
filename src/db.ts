import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type TaskStatus =
  | "queued"
  | "planning"
  | "implementing"
  | "testing"
  | "reviewing"
  | "changes_requested"
  | "awaiting_human"
  | "waiting_quota"
  | "blocked"
  | "failed"
  | "done";

export type ProjectRecord = {
  id: number;
  key: string;
  name: string;
  path: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectInput = {
  key: string;
  name?: string;
  path: string;
  defaultBranch?: string;
};

export type TaskRecord = {
  id: number;
  projectId: number | null;
  projectKey: string | null;
  projectName: string | null;
  text: string;
  status: TaskStatus;
  source: string;
  branchName: string | null;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EventRecord = {
  id: number;
  source: string;
  type: string;
  text: string;
  userId: string | null;
  username: string | null;
  taskId: number | null;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export type EventInput = {
  source: string;
  type: string;
  text: string;
  userId?: string | null;
  username?: string | null;
  taskId?: number | null;
  metadata?: Record<string, unknown>;
};

export type MaestroDatabase = ReturnType<typeof createDatabase>;

export function createDatabase(databasePath: string) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);

  const createTaskStatement = db.prepare(`
    INSERT INTO tasks (project_id, text, status, source, branch_name, worktree_path, created_at, updated_at)
    VALUES (@projectId, @text, 'queued', @source, NULL, NULL, @now, @now)
  `);
  const addEventStatement = db.prepare(`
    INSERT INTO events (source, type, text, user_id, username, task_id, created_at, metadata_json)
    VALUES (@source, @type, @text, @userId, @username, @taskId, @now, @metadataJson)
  `);
  const upsertProjectStatement = db.prepare(`
    INSERT INTO projects (key, name, path, default_branch, created_at, updated_at)
    VALUES (@key, @name, @path, @defaultBranch, @now, @now)
    ON CONFLICT(key) DO UPDATE SET
      name = excluded.name,
      path = excluded.path,
      default_branch = excluded.default_branch,
      updated_at = excluded.updated_at
  `);

  return {
    close: () => db.close(),

    registerProject(input: ProjectInput): ProjectRecord {
      const now = new Date().toISOString();
      const project = normalizeProjectInput(input);
      upsertProjectStatement.run({ ...project, now });
      return this.getProjectByKey(project.key);
    },

    getProjectByKey(key: string): ProjectRecord {
      const row = db.prepare("SELECT * FROM projects WHERE key = ?").get(key) as ProjectRow | undefined;
      if (!row) {
        throw new Error(`Project not found: ${key}`);
      }
      return mapProject(row);
    },

    findProjectByKey(key: string): ProjectRecord | null {
      const row = db.prepare("SELECT * FROM projects WHERE key = ?").get(key) as ProjectRow | undefined;
      return row ? mapProject(row) : null;
    },

    getDefaultProject(): ProjectRecord | null {
      const row = db
        .prepare("SELECT * FROM projects ORDER BY id ASC LIMIT 1")
        .get() as ProjectRow | undefined;
      return row ? mapProject(row) : null;
    },

    listProjects(limit = 20): ProjectRecord[] {
      const rows = db
        .prepare("SELECT * FROM projects ORDER BY key ASC LIMIT ?")
        .all(limit) as ProjectRow[];
      return rows.map(mapProject);
    },

    createTask(text: string, source = "telegram", projectKey?: string | null): TaskRecord {
      const now = new Date().toISOString();
      const project = projectKey ? this.getProjectByKey(projectKey) : this.getDefaultProject();
      const result = createTaskStatement.run({ projectId: project?.id ?? null, text, source, now });
      return this.getTask(Number(result.lastInsertRowid));
    },

    getTask(id: number): TaskRecord {
      const row = db.prepare(taskSelectSql("WHERE tasks.id = ?")).get(id) as TaskRow | undefined;
      if (!row) {
        throw new Error(`Task not found: ${id}`);
      }
      return mapTask(row);
    },

    listTasks(limit = 10): TaskRecord[] {
      const rows = db
        .prepare(taskSelectSql("ORDER BY tasks.id DESC LIMIT ?"))
        .all(limit) as TaskRow[];
      return rows.map(mapTask);
    },

    listTasksByProject(projectKey: string, limit = 10): TaskRecord[] {
      const rows = db
        .prepare(taskSelectSql("WHERE projects.key = ? ORDER BY tasks.id DESC LIMIT ?"))
        .all(projectKey, limit) as TaskRow[];
      return rows.map(mapTask);
    },

    countTasksByStatus(): Record<string, number> {
      const rows = db
        .prepare("SELECT status, COUNT(*) as count FROM tasks GROUP BY status")
        .all() as Array<{ status: string; count: number }>;
      return Object.fromEntries(rows.map((row) => [row.status, row.count]));
    },

    addEvent(input: EventInput): EventRecord {
      const now = new Date().toISOString();
      const result = addEventStatement.run({
        source: input.source,
        type: input.type,
        text: input.text,
        userId: input.userId ?? null,
        username: input.username ?? null,
        taskId: input.taskId ?? null,
        now,
        metadataJson: JSON.stringify(input.metadata ?? {})
      });
      return this.getEvent(Number(result.lastInsertRowid));
    },

    getEvent(id: number): EventRecord {
      const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRow | undefined;
      if (!row) {
        throw new Error(`Event not found: ${id}`);
      }
      return mapEvent(row);
    },

    getLastEvent(): EventRecord | null {
      const row = db
        .prepare("SELECT * FROM events ORDER BY id DESC LIMIT 1")
        .get() as EventRow | undefined;
      return row ? mapEvent(row) : null;
    }
  };
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      source TEXT NOT NULL,
      branch_name TEXT,
      worktree_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      user_id TEXT,
      username TEXT,
      task_id INTEGER,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );
  `);

  addColumnIfMissing(db, "tasks", "project_id", "INTEGER REFERENCES projects(id)");
  addColumnIfMissing(db, "tasks", "branch_name", "TEXT");
  addColumnIfMissing(db, "tasks", "worktree_path", "TEXT");
}

type ProjectRow = {
  id: number;
  key: string;
  name: string;
  path: string;
  default_branch: string;
  created_at: string;
  updated_at: string;
};

type TaskRow = {
  id: number;
  project_id: number | null;
  project_key: string | null;
  project_name: string | null;
  text: string;
  status: TaskStatus;
  source: string;
  branch_name: string | null;
  worktree_path: string | null;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  id: number;
  source: string;
  type: string;
  text: string;
  user_id: string | null;
  username: string | null;
  task_id: number | null;
  created_at: string;
  metadata_json: string;
};

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function normalizeProjectInput(input: ProjectInput) {
  const key = input.key.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,48}$/.test(key)) {
    throw new Error("Project key must use 2-49 chars: lowercase letters, numbers, underscore or dash.");
  }

  return {
    key,
    name: input.name?.trim() || key,
    path: path.resolve(input.path.trim()),
    defaultBranch: input.defaultBranch?.trim() || "main"
  };
}

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    path: row.path,
    defaultBranch: row.default_branch,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project_key,
    projectName: row.project_name,
    text: row.text,
    status: row.status,
    source: row.source,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapEvent(row: EventRow): EventRecord {
  return {
    id: row.id,
    source: row.source,
    type: row.type,
    text: row.text,
    userId: row.user_id,
    username: row.username,
    taskId: row.task_id,
    createdAt: row.created_at,
    metadata: JSON.parse(row.metadata_json || "{}") as Record<string, unknown>
  };
}

function taskSelectSql(suffix: string): string {
  return `
    SELECT
      tasks.*,
      projects.key as project_key,
      projects.name as project_name
    FROM tasks
    LEFT JOIN projects ON projects.id = tasks.project_id
    ${suffix}
  `;
}
