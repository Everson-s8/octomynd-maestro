import Database from "better-sqlite3";
import {
  OperationalChatMessageInput,
  OperationalChatMessageRecord,
  OperationalChatThreadInput,
  OperationalChatThreadRecord,
  OperationalChatSenderRole,
  OperationalChatSurface,
  ChatAccessMode
} from "./types.js";

type OperationalChatMessageRow = {
  id: number;
  thread_id: number;
  project_key: string;
  surface: string;
  sender_role: string;
  message_text: string;
  evidence_json: string | null;
  action_taken: string | null;
  created_at: string;
};

type OperationalChatThreadRow = {
  id: number;
  project_key: string;
  title: string;
  access_mode: string;
  created_at: string;
  updated_at: string;
  message_count: number;
};

export function migrateOperationalChatPersistence(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS operational_chat_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_key TEXT NOT NULL,
      title TEXT NOT NULL,
      access_mode TEXT NOT NULL DEFAULT 'standard',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_operational_chat_threads_project
      ON operational_chat_threads(project_key, updated_at DESC);
    CREATE TABLE IF NOT EXISTS operational_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER,
      project_key TEXT NOT NULL,
      surface TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      message_text TEXT NOT NULL,
      evidence_json TEXT,
      action_taken TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_operational_chat_messages_project
      ON operational_chat_messages(project_key);
    CREATE INDEX IF NOT EXISTS idx_operational_chat_messages_created
      ON operational_chat_messages(created_at);
  `);

  const threadColumns = db.prepare("PRAGMA table_info(operational_chat_threads)").all() as Array<{ name: string }>;
  if (!threadColumns.some((column) => column.name === "access_mode")) {
    db.exec("ALTER TABLE operational_chat_threads ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'standard'");
  }

  const columns = db.prepare("PRAGMA table_info(operational_chat_messages)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "thread_id")) {
    db.exec("ALTER TABLE operational_chat_messages ADD COLUMN thread_id INTEGER");
  }

  const legacyProjects = db.prepare(`
    SELECT DISTINCT project_key
    FROM operational_chat_messages
    WHERE thread_id IS NULL
  `).all() as Array<{ project_key: string }>;
  const findThread = db.prepare(`
    SELECT id FROM operational_chat_threads
    WHERE project_key = ?
    ORDER BY id ASC LIMIT 1
  `);
  const insertThread = db.prepare(`
    INSERT INTO operational_chat_threads (project_key, title, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  const updateLegacyMessages = db.prepare(`
    UPDATE operational_chat_messages
    SET thread_id = ?
    WHERE project_key = ? AND thread_id IS NULL
  `);
  for (const project of legacyProjects) {
    const now = new Date().toISOString();
    const existing = findThread.get(project.project_key) as { id: number } | undefined;
    const threadId = existing?.id ?? Number(insertThread.run(
      project.project_key,
      "Conversa do projeto",
      now,
      now
    ).lastInsertRowid);
    updateLegacyMessages.run(threadId, project.project_key);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_operational_chat_messages_thread
      ON operational_chat_messages(thread_id, id);
  `);
}

export function createOperationalChatPersistence(db: Database.Database) {
  const insertThreadStatement = db.prepare(`
    INSERT INTO operational_chat_threads (project_key, title, access_mode, created_at, updated_at)
    VALUES (@projectKey, @title, @accessMode, @createdAt, @updatedAt)
  `);

  const getThreadStatement = db.prepare(`
    SELECT t.*, COUNT(m.id) AS message_count
    FROM operational_chat_threads t
    LEFT JOIN operational_chat_messages m ON m.thread_id = t.id
    WHERE t.id = ?
    GROUP BY t.id
  `);

  const listThreadsStatement = db.prepare(`
    SELECT t.*, COUNT(m.id) AS message_count
    FROM operational_chat_threads t
    LEFT JOIN operational_chat_messages m ON m.thread_id = t.id
    WHERE t.project_key = ?
    GROUP BY t.id
    ORDER BY t.updated_at DESC, t.id DESC
  `);

  const touchThreadStatement = db.prepare(`
    UPDATE operational_chat_threads
    SET updated_at = @updatedAt
    WHERE id = @id
  `);

  const renameThreadStatement = db.prepare(`
    UPDATE operational_chat_threads
    SET title = @title, updated_at = @updatedAt
    WHERE id = @id
  `);
  const updateThreadAccessModeStatement = db.prepare(`
    UPDATE operational_chat_threads
    SET access_mode = @accessMode, updated_at = @updatedAt
    WHERE id = @id
  `);

  const deleteThreadMessagesStatement = db.prepare(`
    DELETE FROM operational_chat_messages WHERE thread_id = ?
  `);
  const deleteThreadStatement = db.prepare(`
    DELETE FROM operational_chat_threads WHERE id = ? AND project_key = ?
  `);

  const insertMessageStatement = db.prepare(`
    INSERT INTO operational_chat_messages (
      thread_id, project_key, surface, sender_role, message_text, evidence_json, action_taken, created_at
    ) VALUES (
      @threadId, @projectKey, @surface, @senderRole, @messageText, @evidenceJson, @actionTaken, @createdAt
    )
  `);

  const listMessagesStatement = db.prepare(`
    SELECT * FROM operational_chat_messages
    WHERE project_key = ? AND (? IS NULL OR thread_id = ?)
    ORDER BY id ASC
  `);

  const listMessagesLimitedStatement = db.prepare(`
    SELECT * FROM (
      SELECT * FROM operational_chat_messages
      WHERE project_key = ? AND (? IS NULL OR thread_id = ?)
      ORDER BY id DESC
      LIMIT ?
    ) ORDER BY id ASC
  `);

  const pruneOldMessagesStatement = db.prepare(`
    DELETE FROM operational_chat_messages
    WHERE project_key = ? AND (? IS NULL OR thread_id = ?) AND id NOT IN (
      SELECT id FROM operational_chat_messages
      WHERE project_key = ? AND (? IS NULL OR thread_id = ?)
      ORDER BY id DESC
      LIMIT ?
    )
  `);

  return {
    createOperationalChatThread(input: OperationalChatThreadInput): OperationalChatThreadRecord {
      const now = new Date().toISOString();
      const projectKey = input.projectKey.trim().toLowerCase();
      const title = normalizeThreadTitle(input.title);
      const info = insertThreadStatement.run({
        projectKey,
        title,
        accessMode: normalizeAccessMode(input.accessMode),
        createdAt: now,
        updatedAt: now
      });
      return mapRowToThread(getThreadStatement.get(Number(info.lastInsertRowid)) as OperationalChatThreadRow);
    },

    getOperationalChatThread(threadId: number): OperationalChatThreadRecord | null {
      const row = getThreadStatement.get(threadId) as OperationalChatThreadRow | undefined;
      return row ? mapRowToThread(row) : null;
    },

    listOperationalChatThreads(projectKey: string): OperationalChatThreadRecord[] {
      return (listThreadsStatement.all(projectKey.trim().toLowerCase()) as OperationalChatThreadRow[]).map(mapRowToThread);
    },

    deleteOperationalChatThread(projectKey: string, threadId: number): boolean {
      const normalizedKey = projectKey.trim().toLowerCase();
      const thread = getThreadStatement.get(threadId) as OperationalChatThreadRow | undefined;
      if (!thread || thread.project_key !== normalizedKey) return false;
      const deleted = db.transaction(() => {
        deleteThreadMessagesStatement.run(threadId);
        return deleteThreadStatement.run(threadId, normalizedKey).changes > 0;
      })();
      return deleted;
    },

    updateOperationalChatThreadAccessMode(threadId: number, accessMode: ChatAccessMode): OperationalChatThreadRecord {
      const thread = getThreadStatement.get(threadId) as OperationalChatThreadRow | undefined;
      if (!thread) throw new Error("Chat thread not found.");
      updateThreadAccessModeStatement.run({ id: threadId, accessMode: normalizeAccessMode(accessMode), updatedAt: new Date().toISOString() });
      return mapRowToThread(getThreadStatement.get(threadId) as OperationalChatThreadRow);
    },

    getOrCreateOperationalChatThread(projectKey: string, title = "Conversa do projeto"): OperationalChatThreadRecord {
      const existing = (listThreadsStatement.all(projectKey.trim().toLowerCase()) as OperationalChatThreadRow[])[0];
      if (existing) return mapRowToThread(existing);
      return this.createOperationalChatThread({ projectKey, title });
    },

    saveOperationalChatMessage(input: OperationalChatMessageInput): OperationalChatMessageRecord {
      const createdAt = input.createdAt ?? new Date().toISOString();
      const projectKey = input.projectKey.toLowerCase();
      const thread = input.threadId
        ? getThreadStatement.get(input.threadId) as OperationalChatThreadRow | undefined
        : (listThreadsStatement.all(projectKey) as OperationalChatThreadRow[])[0];
      const resolvedThread = thread ?? this.createOperationalChatThread({ projectKey, title: "Conversa do projeto" });
      const resolvedProjectKey = "project_key" in resolvedThread ? resolvedThread.project_key : resolvedThread.projectKey;
      if (resolvedProjectKey !== projectKey) {
        throw new Error("Chat thread does not belong to the requested project.");
      }
      const info = insertMessageStatement.run({
        threadId: resolvedThread.id,
        projectKey,
        surface: input.surface,
        senderRole: input.senderRole,
        messageText: input.messageText,
        evidenceJson: input.evidenceJson ?? null,
        actionTaken: input.actionTaken ?? null,
        createdAt
      });

      const id = Number(info.lastInsertRowid);
      touchThreadStatement.run({ id: resolvedThread.id, updatedAt: createdAt });
      if (input.senderRole === "user" && resolvedThread.title === "Nova conversa") {
        renameThreadStatement.run({
          id: resolvedThread.id,
          title: normalizeThreadTitle(input.messageText),
          updatedAt: createdAt
        });
      }
      const row = db.prepare("SELECT * FROM operational_chat_messages WHERE id = ?").get(id) as OperationalChatMessageRow;
      return mapRowToMessage(row);
    },

    listOperationalChatMessages(projectKey: string, limit?: number, threadId?: number | null): OperationalChatMessageRecord[] {
      const normalizedKey = projectKey.toLowerCase();
      const rows = limit && limit > 0
        ? (listMessagesLimitedStatement.all(normalizedKey, threadId ?? null, threadId ?? null, limit) as OperationalChatMessageRow[])
        : (listMessagesStatement.all(normalizedKey, threadId ?? null, threadId ?? null) as OperationalChatMessageRow[]);
      return rows.map(mapRowToMessage);
    },

    pruneOperationalChatMessages(projectKey: string, keepCount = 100, threadId?: number | null): number {
      const normalizedKey = projectKey.toLowerCase();
      const resolvedThread = threadId ?? null;
      const info = pruneOldMessagesStatement.run(
        normalizedKey,
        resolvedThread,
        resolvedThread,
        normalizedKey,
        resolvedThread,
        resolvedThread,
        Math.max(10, keepCount)
      );
      return info.changes;
    }
  };
}

function mapRowToMessage(row: OperationalChatMessageRow): OperationalChatMessageRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    projectKey: row.project_key,
    surface: row.surface as OperationalChatSurface,
    senderRole: row.sender_role as OperationalChatSenderRole,
    messageText: row.message_text,
    evidenceJson: row.evidence_json,
    actionTaken: row.action_taken,
    createdAt: row.created_at
  };
}

function mapRowToThread(row: OperationalChatThreadRow): OperationalChatThreadRecord {
  return {
    id: row.id,
    projectKey: row.project_key,
    title: row.title,
    accessMode: normalizeAccessMode(row.access_mode),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(row.message_count ?? 0)
  };
}

function normalizeAccessMode(value?: string | null): ChatAccessMode {
  return value === "read_only" || value === "full" ? value : "standard";
}

function normalizeThreadTitle(value?: string | null): string {
  const title = String(value ?? "").replace(/\s+/g, " ").trim();
  return title.slice(0, 80) || "Nova conversa";
}
