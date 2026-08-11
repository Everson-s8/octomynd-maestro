import Database from "better-sqlite3";
import {
  OperationalChatMessageInput,
  OperationalChatMessageRecord,
  OperationalChatSenderRole,
  OperationalChatSurface
} from "./types.js";

type OperationalChatMessageRow = {
  id: number;
  project_key: string;
  surface: string;
  sender_role: string;
  message_text: string;
  evidence_json: string | null;
  action_taken: string | null;
  created_at: string;
};

export function migrateOperationalChatPersistence(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS operational_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
}

export function createOperationalChatPersistence(db: Database.Database) {
  const insertMessageStatement = db.prepare(`
    INSERT INTO operational_chat_messages (
      project_key, surface, sender_role, message_text, evidence_json, action_taken, created_at
    ) VALUES (
      @projectKey, @surface, @senderRole, @messageText, @evidenceJson, @actionTaken, @createdAt
    )
  `);

  const listMessagesStatement = db.prepare(`
    SELECT * FROM operational_chat_messages
    WHERE project_key = ?
    ORDER BY id ASC
  `);

  const listMessagesLimitedStatement = db.prepare(`
    SELECT * FROM (
      SELECT * FROM operational_chat_messages
      WHERE project_key = ?
      ORDER BY id DESC
      LIMIT ?
    ) ORDER BY id ASC
  `);

  const pruneOldMessagesStatement = db.prepare(`
    DELETE FROM operational_chat_messages
    WHERE project_key = ? AND id NOT IN (
      SELECT id FROM operational_chat_messages
      WHERE project_key = ?
      ORDER BY id DESC
      LIMIT ?
    )
  `);

  return {
    saveOperationalChatMessage(input: OperationalChatMessageInput): OperationalChatMessageRecord {
      const createdAt = input.createdAt ?? new Date().toISOString();
      const info = insertMessageStatement.run({
        projectKey: input.projectKey.toLowerCase(),
        surface: input.surface,
        senderRole: input.senderRole,
        messageText: input.messageText,
        evidenceJson: input.evidenceJson ?? null,
        actionTaken: input.actionTaken ?? null,
        createdAt
      });

      const id = Number(info.lastInsertRowid);
      const row = db.prepare("SELECT * FROM operational_chat_messages WHERE id = ?").get(id) as OperationalChatMessageRow;
      return mapRowToMessage(row);
    },

    listOperationalChatMessages(projectKey: string, limit?: number): OperationalChatMessageRecord[] {
      const normalizedKey = projectKey.toLowerCase();
      const rows = limit && limit > 0
        ? (listMessagesLimitedStatement.all(normalizedKey, limit) as OperationalChatMessageRow[])
        : (listMessagesStatement.all(normalizedKey) as OperationalChatMessageRow[]);
      return rows.map(mapRowToMessage);
    },

    pruneOperationalChatMessages(projectKey: string, keepCount = 100): number {
      const normalizedKey = projectKey.toLowerCase();
      const info = pruneOldMessagesStatement.run(normalizedKey, normalizedKey, Math.max(10, keepCount));
      return info.changes;
    }
  };
}

function mapRowToMessage(row: OperationalChatMessageRow): OperationalChatMessageRecord {
  return {
    id: row.id,
    projectKey: row.project_key,
    surface: row.surface as OperationalChatSurface,
    senderRole: row.sender_role as OperationalChatSenderRole,
    messageText: row.message_text,
    evidenceJson: row.evidence_json,
    actionTaken: row.action_taken,
    createdAt: row.created_at
  };
}
