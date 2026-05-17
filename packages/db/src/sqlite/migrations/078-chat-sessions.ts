import type Database from 'better-sqlite3'

export function runChatSessionsMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      context_kind TEXT NOT NULL,
      context_label TEXT,
      title TEXT,
      preview_text TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by_user_id TEXT,
      updated_by_user_id TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_active
      ON chat_sessions(context_id) WHERE is_active = 1;
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_recent
      ON chat_sessions(is_archived, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_context
      ON chat_sessions(context_id, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_pinned
      ON chat_sessions(is_pinned, last_message_at DESC) WHERE is_archived = 0;

    CREATE TABLE IF NOT EXISTS chat_session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_session_messages_session
      ON chat_session_messages(session_id, created_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS chat_session_messages_fts USING fts5(
      content,
      title,
      session_id UNINDEXED,
      message_id UNINDEXED,
      tokenize = 'porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS chat_session_messages_fts_insert
      AFTER INSERT ON chat_session_messages BEGIN
        INSERT INTO chat_session_messages_fts(content, title, session_id, message_id)
          VALUES(
            new.content,
            COALESCE((SELECT title FROM chat_sessions WHERE id = new.session_id), ''),
            new.session_id,
            new.id
          );
      END;

    CREATE TRIGGER IF NOT EXISTS chat_session_messages_fts_delete
      AFTER DELETE ON chat_session_messages BEGIN
        DELETE FROM chat_session_messages_fts WHERE message_id = old.id;
      END;

    CREATE TRIGGER IF NOT EXISTS chat_session_messages_fts_update
      AFTER UPDATE ON chat_session_messages BEGIN
        DELETE FROM chat_session_messages_fts WHERE message_id = old.id;
        INSERT INTO chat_session_messages_fts(content, title, session_id, message_id)
          VALUES(
            new.content,
            COALESCE((SELECT title FROM chat_sessions WHERE id = new.session_id), ''),
            new.session_id,
            new.id
          );
      END;

    -- When a session's title changes, refresh the title column on every FTS row
    -- belonging to that session so search-by-title stays accurate.
    CREATE TRIGGER IF NOT EXISTS chat_sessions_title_update
      AFTER UPDATE OF title ON chat_sessions
      WHEN COALESCE(old.title, '') != COALESCE(new.title, '')
      BEGIN
        DELETE FROM chat_session_messages_fts WHERE session_id = new.id;
        INSERT INTO chat_session_messages_fts(content, title, session_id, message_id)
          SELECT content, COALESCE(new.title, ''), session_id, id
          FROM chat_session_messages WHERE session_id = new.id;
      END;
  `)
}
