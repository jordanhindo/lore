import type DatabaseType from "better-sqlite3";

/**
 * Schema for the lore store.
 *
 * Three distinct IDs, per the corrected data model:
 *  - `source_file_id` — a physical transcript file (the ingestion/watermark unit)
 *  - `session_id`     — a logical session, shared across a primary file and its
 *                       subagent files
 *  - tool_call rows carry both, plus the `message_id` they originated from
 *
 * `messages.message_id` is a synthetic hash of (source_file_id + uuid + seq);
 * `uuid` alone collides across and within files with differing content.
 *
 * FTS5 uses an external-content table synced by triggers, with a code-aware
 * tokenizer (`tokenchars '_-.'`) so identifiers and paths like `getUserById`,
 * `foo.bar.ts`, and `trust-metadata` are retrievable as whole tokens.
 */
export function initSchema(db: DatabaseType.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_files (
      source_file_id TEXT PRIMARY KEY,
      source         TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      kind           TEXT NOT NULL,
      agent_file     TEXT,
      path           TEXT NOT NULL,
      byte_offset    INTEGER NOT NULL DEFAULT 0,
      line_count     INTEGER NOT NULL DEFAULT 0,
      prefix_sha256  TEXT,
      mtime          TEXT,
      indexed_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id      TEXT PRIMARY KEY,
      source          TEXT NOT NULL,
      project         TEXT,
      branch          TEXT,
      first_timestamp TEXT,
      last_timestamp  TEXT,
      message_count   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      message_id     TEXT NOT NULL UNIQUE,
      source_file_id TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      uuid           TEXT NOT NULL,
      parent_uuid    TEXT,
      seq            INTEGER NOT NULL,
      role           TEXT NOT NULL,
      timestamp      TEXT,
      project        TEXT,
      branch         TEXT,
      model          TEXT,
      agent          TEXT,
      skill          TEXT,
      text           TEXT NOT NULL,
      text_truncated INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_messages_file ON messages (source_file_id, seq);
    CREATE INDEX IF NOT EXISTS idx_messages_file_timestamp ON messages (source_file_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages (agent);
    CREATE INDEX IF NOT EXISTS idx_messages_skill ON messages (skill);
    -- EQP-proven on the real store (352k messages): with this index the planner
    -- runs list_sessions and timeline project filters as a SEARCH on
    -- idx_messages_project (project=?), visiting only the matching project's rows
    -- instead of a SCAN over idx_messages_session across every session. That plan
    -- change is cache-independent; one cold-cache measurement saw a
    -- project-filtered list_sessions fall from ~12s to ~3s. It is NOT used by
    -- keyword search (FTS MATCH resolves rowids first, project is a residual
    -- filter). A matching index on source_files(source) was tested and dropped:
    -- the source filter still drives from messages via the session index, so the
    -- planner never uses a source_files index (and that table is tiny anyway,
    -- ~1.3k rows).
    CREATE INDEX IF NOT EXISTS idx_messages_project ON messages (project);

    CREATE TABLE IF NOT EXISTS tool_calls (
      tool_call_id   TEXT PRIMARY KEY,
      source_file_id TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      message_id     TEXT NOT NULL,
      tool_use_id    TEXT,
      tool_name      TEXT,
      input          TEXT,
      result         TEXT,
      is_error       INTEGER,
      truncated      INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls (message_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_use_id ON tool_calls (tool_use_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      content='messages',
      content_rowid='rowid',
      tokenize="unicode61 tokenchars '_-.'"
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;

    CREATE TABLE IF NOT EXISTS tombstones (
      kind       TEXT NOT NULL,
      value      TEXT NOT NULL,
      reason     TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (kind, value)
    );
  `);
}
