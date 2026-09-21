import Database from "better-sqlite3";
import {
  OperationalChatMessageInput,
  OperationalChatMessageRecord,
  OperationalChatThreadInput,
  OperationalChatThreadRecord,
  OperationalChatSenderRole,
  OperationalChatSurface,
  ChatAccessMode,
  OperationalChatMemoryRecord,
  OperationalChatActivityEvent
} from "./types.js";
import type { AgentReasoningEffort } from "../agents/types.js";

type OperationalChatMessageRow = {
  id: number;
  thread_id: number;
  project_key: string;
  surface: string;
  sender_role: string;
  message_text: string;
  evidence_json: string | null;
  action_taken: string | null;
  provider_id: string | null;
  model: string | null;
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
  provider_id: string | null;
  model: string | null;
  effort: AgentReasoningEffort | null;
};

type OperationalChatMemoryRow = {
  id: number;
  project_key: string;
  memory_text: string;
  memory_kind: string;
  source_thread_id: number | null;
  created_at: string;
  updated_at: string;
};

type OperationalChatActivityEventRow = {
  id: number;
  thread_id: number;
  project_key: string;
  request_id: string;
  active: number;
  started_at: string | null;
  phase: string;
  iteration: number;
  max_iterations: number;
  tool_calls: number;
  max_tool_calls: number;
  tool_name: string | null;
  detail: string | null;
  created_at: string;
};

export function migrateOperationalChatPersistence(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS operational_chat_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_key TEXT NOT NULL,
      title TEXT NOT NULL,
      access_mode TEXT NOT NULL DEFAULT 'standard',
      provider_id TEXT,
      model TEXT,
      effort TEXT,
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
      provider_id TEXT,
      model TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_operational_chat_messages_project
      ON operational_chat_messages(project_key);
    CREATE INDEX IF NOT EXISTS idx_operational_chat_messages_created
      ON operational_chat_messages(created_at);
    CREATE TABLE IF NOT EXISTS operational_chat_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_key TEXT NOT NULL,
      memory_text TEXT NOT NULL,
      memory_kind TEXT NOT NULL DEFAULT 'decision',
      source_thread_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_key, memory_text)
    );
    CREATE INDEX IF NOT EXISTS idx_operational_chat_memories_project
      ON operational_chat_memories(project_key, updated_at DESC);
    CREATE TABLE IF NOT EXISTS operational_chat_activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      project_key TEXT NOT NULL,
      request_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      started_at TEXT,
      phase TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      max_iterations INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      max_tool_calls INTEGER NOT NULL DEFAULT 0,
      tool_name TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_operational_chat_activity_thread
      ON operational_chat_activity_events(project_key, thread_id, id DESC);
  `);

  const threadColumns = db.prepare("PRAGMA table_info(operational_chat_threads)").all() as Array<{ name: string }>;
  if (!threadColumns.some((column) => column.name === "access_mode")) {
    db.exec("ALTER TABLE operational_chat_threads ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'standard'");
  }
  if (!threadColumns.some((column) => column.name === "provider_id")) {
    db.exec("ALTER TABLE operational_chat_threads ADD COLUMN provider_id TEXT");
  }
  if (!threadColumns.some((column) => column.name === "model")) {
    db.exec("ALTER TABLE operational_chat_threads ADD COLUMN model TEXT");
  }
  if (!threadColumns.some((column) => column.name === "effort")) {
    db.exec("ALTER TABLE operational_chat_threads ADD COLUMN effort TEXT");
  }

  const columns = db.prepare("PRAGMA table_info(operational_chat_messages)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "thread_id")) {
    db.exec("ALTER TABLE operational_chat_messages ADD COLUMN thread_id INTEGER");
  }
  if (!columns.some((column) => column.name === "provider_id")) {
    db.exec("ALTER TABLE operational_chat_messages ADD COLUMN provider_id TEXT");
  }
  if (!columns.some((column) => column.name === "model")) {
    db.exec("ALTER TABLE operational_chat_messages ADD COLUMN model TEXT");
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
      "Project conversation",
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
    INSERT INTO operational_chat_threads (project_key, title, access_mode, provider_id, model, effort, created_at, updated_at)
    VALUES (@projectKey, @title, @accessMode, @providerId, @model, @effort, @createdAt, @updatedAt)
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
  const updateThreadSelectionStatement = db.prepare(`
    UPDATE operational_chat_threads
    SET provider_id = @providerId, model = @model, effort = @effort, updated_at = @updatedAt
    WHERE id = @id
  `);

  const deleteThreadMessagesStatement = db.prepare(`
    DELETE FROM operational_chat_messages WHERE thread_id = ?
  `);
  const deleteThreadActivityEventsStatement = db.prepare(`
    DELETE FROM operational_chat_activity_events WHERE thread_id = ?
  `);
  const deleteThreadStatement = db.prepare(`
    DELETE FROM operational_chat_threads WHERE id = ? AND project_key = ?
  `);

  const insertMessageStatement = db.prepare(`
    INSERT INTO operational_chat_messages (
      thread_id, project_key, surface, sender_role, message_text, evidence_json, action_taken, provider_id, model, created_at
    ) VALUES (
      @threadId, @projectKey, @surface, @senderRole, @messageText, @evidenceJson, @actionTaken, @providerId, @model, @createdAt
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

  const insertMemoryStatement = db.prepare(`
    INSERT INTO operational_chat_memories (
      project_key, memory_text, memory_kind, source_thread_id, created_at, updated_at
    ) VALUES (@projectKey, @memoryText, @memoryKind, @sourceThreadId, @createdAt, @updatedAt)
    ON CONFLICT(project_key, memory_text) DO UPDATE SET
      memory_kind = excluded.memory_kind,
      source_thread_id = excluded.source_thread_id,
      updated_at = excluded.updated_at
  `);
  const listMemoriesStatement = db.prepare(`
    SELECT * FROM operational_chat_memories
    WHERE project_key = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `);
  const deleteMemoryStatement = db.prepare(`
    DELETE FROM operational_chat_memories WHERE project_key = ? AND id = ?
  `);
  const insertActivityEventStatement = db.prepare(`
    INSERT INTO operational_chat_activity_events (
      thread_id, project_key, request_id, active, started_at, phase, iteration,
      max_iterations, tool_calls, max_tool_calls, tool_name, detail, created_at
    ) VALUES (
      @threadId, @projectKey, @requestId, @active, @startedAt, @phase, @iteration,
      @maxIterations, @toolCalls, @maxToolCalls, @toolName, @detail, @createdAt
    )
  `);
  const listActivityEventsStatement = db.prepare(`
    SELECT * FROM operational_chat_activity_events
    WHERE project_key = ? AND thread_id = ?
    ORDER BY id DESC
    LIMIT ?
  `);
  const getActivityEventStatement = db.prepare(`
    SELECT * FROM operational_chat_activity_events WHERE id = ?
  `);
  const pruneActivityEventsStatement = db.prepare(`
    DELETE FROM operational_chat_activity_events
    WHERE project_key = ? AND thread_id = ? AND id NOT IN (
      SELECT id FROM operational_chat_activity_events
      WHERE project_key = ? AND thread_id = ?
      ORDER BY id DESC LIMIT 500
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
        providerId: input.providerId ?? null,
        model: normalizeModel(input.model),
        effort: normalizeEffort(input.effort),
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
        deleteThreadActivityEventsStatement.run(threadId);
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

    updateOperationalChatThreadSelection(threadId: number, providerId: string | null, model: string | null, effort: AgentReasoningEffort | null = null): OperationalChatThreadRecord {
      const thread = getThreadStatement.get(threadId) as OperationalChatThreadRow | undefined;
      if (!thread) throw new Error("Chat thread not found.");
      updateThreadSelectionStatement.run({
        id: threadId,
        providerId: providerId?.trim() || null,
        model: normalizeModel(model),
        effort: normalizeEffort(effort),
        updatedAt: new Date().toISOString()
      });
      return mapRowToThread(getThreadStatement.get(threadId) as OperationalChatThreadRow);
    },

    getOrCreateOperationalChatThread(projectKey: string, title = "Project conversation"): OperationalChatThreadRecord {
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
      const resolvedThread = thread ?? this.createOperationalChatThread({ projectKey, title: "Project conversation" });
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
        providerId: input.providerId ?? null,
        model: normalizeModel(input.model),
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
    },

    saveOperationalChatMemory(input: {
      projectKey: string;
      text: string;
      kind?: OperationalChatMemoryRecord["kind"];
      sourceThreadId?: number | null;
    }): OperationalChatMemoryRecord {
      const projectKey = input.projectKey.trim().toLowerCase();
      const text = input.text.replace(/\s+/g, " ").trim().slice(0, 500);
      if (!projectKey || !text) throw new Error("Chat memory cannot be empty.");
      const now = new Date().toISOString();
      insertMemoryStatement.run({
        projectKey,
        memoryText: text,
        memoryKind: input.kind ?? "decision",
        sourceThreadId: input.sourceThreadId ?? null,
        createdAt: now,
        updatedAt: now
      });
      const row = db.prepare(`
        SELECT * FROM operational_chat_memories WHERE project_key = ? AND memory_text = ?
      `).get(projectKey, text) as OperationalChatMemoryRow;
      return mapRowToMemory(row);
    },

    listOperationalChatMemories(projectKey: string, limit = 30): OperationalChatMemoryRecord[] {
      const rows = listMemoriesStatement.all(projectKey.trim().toLowerCase(), Math.max(1, Math.min(50, limit))) as OperationalChatMemoryRow[];
      return rows.map(mapRowToMemory);
    },

    deleteOperationalChatMemory(projectKey: string, memoryId: number): boolean {
      return deleteMemoryStatement.run(projectKey.trim().toLowerCase(), memoryId).changes > 0;
    },

    appendOperationalChatActivityEvent(input: {
      threadId: number;
      projectKey: string;
      requestId: string;
      activity: Omit<OperationalChatActivityEvent, "id" | "threadId" | "projectKey" | "requestId" | "createdAt">;
    }): OperationalChatActivityEvent {
      const createdAt = new Date().toISOString();
      const projectKey = input.projectKey.trim().toLowerCase();
      const info = insertActivityEventStatement.run({
        threadId: input.threadId,
        projectKey,
        requestId: input.requestId,
        active: input.activity.active ? 1 : 0,
        startedAt: input.activity.startedAt,
        phase: input.activity.phase,
        iteration: input.activity.iteration,
        maxIterations: input.activity.maxIterations,
        toolCalls: input.activity.toolCalls,
        maxToolCalls: input.activity.maxToolCalls,
        toolName: input.activity.toolName,
        detail: input.activity.detail,
        createdAt
      });
      pruneActivityEventsStatement.run(projectKey, input.threadId, projectKey, input.threadId);
      return mapRowToActivityEvent(getActivityEventStatement.get(Number(info.lastInsertRowid)) as OperationalChatActivityEventRow);
    },

    listOperationalChatActivityEvents(projectKey: string, threadId: number, limit = 100): OperationalChatActivityEvent[] {
      return (listActivityEventsStatement.all(projectKey.trim().toLowerCase(), threadId, Math.max(1, Math.min(500, limit))) as OperationalChatActivityEventRow[])
        .reverse()
        .map(mapRowToActivityEvent);
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
    providerId: (row.provider_id as OperationalChatMessageRecord["providerId"]) ?? null,
    model: row.model ?? null,
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
    messageCount: Number(row.message_count ?? 0),
    providerId: (row.provider_id as OperationalChatThreadRecord["providerId"]) ?? null,
    model: row.model ?? null,
    effort: normalizeEffort(row.effort)
  };
}

function mapRowToMemory(row: OperationalChatMemoryRow): OperationalChatMemoryRecord {
  return {
    id: row.id,
    text: row.memory_text,
    kind: row.memory_kind === "preference" || row.memory_kind === "constraint" ? row.memory_kind : "decision",
    sourceThreadId: row.source_thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRowToActivityEvent(row: OperationalChatActivityEventRow): OperationalChatActivityEvent {
  return {
    id: row.id,
    threadId: row.thread_id,
    projectKey: row.project_key,
    requestId: row.request_id,
    active: Boolean(row.active),
    startedAt: row.started_at,
    phase: row.phase as OperationalChatActivityEvent["phase"],
    iteration: row.iteration,
    maxIterations: row.max_iterations,
    toolCalls: row.tool_calls,
    maxToolCalls: row.max_tool_calls,
    toolName: row.tool_name,
    detail: row.detail,
    createdAt: row.created_at
  };
}

function normalizeAccessMode(value?: string | null): ChatAccessMode {
  return value === "read_only" || value === "approval" || value === "full" ? value : "standard";
}

function normalizeEffort(value?: string | null): AgentReasoningEffort | null {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "extra_high" || value === "max" || value === "ultra"
    ? value
    : null;
}

function normalizeThreadTitle(value?: string | null): string {
  const title = String(value ?? "").replace(/\s+/g, " ").trim();
  return title.slice(0, 80) || "Nova conversa";
}

function normalizeModel(value?: string | null): string | null {
  const model = String(value ?? "").trim();
  return model ? model.slice(0, 200) : null;
}
