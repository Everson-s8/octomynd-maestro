import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type TaskStatus = "queued" | "done" | "failed";

export type TaskRecord = {
  id: number;
  text: string;
  status: TaskStatus;
  source: string;
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
    INSERT INTO tasks (text, status, source, created_at, updated_at)
    VALUES (@text, 'queued', @source, @now, @now)
  `);
  const addEventStatement = db.prepare(`
    INSERT INTO events (source, type, text, user_id, username, task_id, created_at, metadata_json)
    VALUES (@source, @type, @text, @userId, @username, @taskId, @now, @metadataJson)
  `);

  return {
    close: () => db.close(),

    createTask(text: string, source = "telegram"): TaskRecord {
      const now = new Date().toISOString();
      const result = createTaskStatement.run({ text, source, now });
      return this.getTask(Number(result.lastInsertRowid));
    },

    getTask(id: number): TaskRecord {
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
      if (!row) {
        throw new Error(`Task not found: ${id}`);
      }
      return mapTask(row);
    },

    listTasks(limit = 10): TaskRecord[] {
      const rows = db
        .prepare("SELECT * FROM tasks ORDER BY id DESC LIMIT ?")
        .all(limit) as TaskRow[];
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
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
}

type TaskRow = {
  id: number;
  text: string;
  status: TaskStatus;
  source: string;
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

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    text: row.text,
    status: row.status,
    source: row.source,
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
