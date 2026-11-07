import type DatabaseType from "better-sqlite3";
import { contentHash } from "./content-hash.js";

/**
 * The schema version this build of lore expects. A fresh store created by
 * `initSchema` is at version 1. Bump this whenever you append a migration step.
 */
export const SCHEMA_VERSION = 7;

export class StoreSchemaTooNewError extends Error {
  constructor(
    readonly storeVersion: number,
    readonly supportedVersion: number,
  ) {
    super(
      `Lore store schema version ${storeVersion} is newer than this CLI supports (${supportedVersion})`,
    );
    this.name = "StoreSchemaTooNewError";
  }
}

/**
 * Ordered migration steps. Each step's `to` is the schema version it produces,
 * and `up` performs the change. To evolve the schema later (for example, adding
 * a `state_signal` column), append a step with the next version number and the
 * DDL that applies it:
 *
 *   { to: 4, up: (db) => db.exec("ALTER TABLE messages ADD COLUMN state_signal TEXT") }
 *
 * Existing user stores are upgraded in order; a fresh store gets the base schema
 * from `initSchema` and is simply stamped to the latest version.
 */
const MIGRATIONS: { to: number; up: (db: DatabaseType.Database) => void }[] = [
  {
    // Source-agnostic resume: store a tagged ResumeToken (JSON) per source file.
    // Byte sources keep their legacy byte_offset/line_count/prefix_sha256/mtime
    // columns (resume falls back to them when this column is null), so existing
    // stores upgrade without a re-index.
    to: 2,
    up: (db) => db.exec("ALTER TABLE source_files ADD COLUMN resume_token TEXT"),
  },
  {
    // Tombstone table: durable records of forgotten/excluded sessions and projects.
    // The write-path guard consults this table so re-indexing or a live push cannot
    // resurrect data the user deliberately removed.
    to: 3,
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS tombstones (
          kind       TEXT NOT NULL,
          value      TEXT NOT NULL,
          reason     TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (kind, value)
        )
      `),
  },
  {
    // Recurrence-compatible content hashing. This preserves the schema contract
    // introduced on the adapters branch without changing the primary transcript
    // write model: hashes are derived from message text, nullable for short or
    // injected-only messages, and indexed for future ranking/read paths.
    to: 4,
    up: (db) => {
      if (!hasColumn(db, "messages", "content_hash")) {
        db.exec("ALTER TABLE messages ADD COLUMN content_hash TEXT");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_messages_content_hash ON messages (content_hash)");
      narrowMessageUpdateTrigger(db);
      backfillContentHash(db);
    },
  },
  {
    // Recompute content_hash with the widened injected-block strip list used by
    // Codex and other non-Claude harnesses. The trigger is scoped to text-only
    // updates, so this touches the derived column without rebuilding FTS.
    to: 5,
    up: (db) => {
      narrowMessageUpdateTrigger(db);
      backfillContentHash(db);
    },
  },
  {
    to: 6,
    up: (db) =>
      db.exec(`
    ALTER TABLE messages ADD COLUMN author_kind TEXT;
    ALTER TABLE messages ADD COLUMN entrypoint TEXT;
    ALTER TABLE messages ADD COLUMN native_uuid TEXT;
  `),
  },
  {
    to: 7,
    up: (db) =>
      db.exec(`
      CREATE TABLE capture_cursor_meta (id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL);
      INSERT INTO capture_cursor_meta VALUES(1,lower(hex(randomblob(16))));
      CREATE TABLE message_ingestions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        source_timestamp TEXT,
        role TEXT NOT NULL
      );
      CREATE INDEX message_ingestions_message ON message_ingestions(message_id);
      CREATE INDEX message_ingestions_role_sequence ON message_ingestions(role,sequence);
      INSERT INTO message_ingestions(message_id,source_timestamp,role)
        SELECT message_id,timestamp,role FROM messages ORDER BY timestamp,message_id;
      CREATE TRIGGER messages_capture_insert AFTER INSERT ON messages BEGIN
        INSERT INTO message_ingestions(message_id,source_timestamp,role) VALUES(new.message_id,new.timestamp,new.role);
      END;
      CREATE TRIGGER messages_capture_update AFTER UPDATE ON messages BEGIN
        INSERT INTO message_ingestions(message_id,source_timestamp,role) VALUES(new.message_id,new.timestamp,new.role);
        DELETE FROM message_ingestions WHERE message_id=new.message_id AND sequence<>last_insert_rowid();
      END;
      CREATE TRIGGER messages_capture_delete AFTER DELETE ON messages BEGIN
        DELETE FROM message_ingestions WHERE message_id=old.message_id;
      END;
    `),
  },
];

function hasColumn(db: DatabaseType.Database, table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`) as { name: string }[];
  return rows.some((row) => row.name === column);
}

function narrowMessageUpdateTrigger(db: DatabaseType.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS messages_au;
    CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);
}

function backfillContentHash(db: DatabaseType.Database): void {
  const page = db.prepare(
    "SELECT rowid AS rid, text FROM messages WHERE rowid > ? ORDER BY rowid LIMIT 1000",
  );
  const update = db.prepare("UPDATE messages SET content_hash = ? WHERE rowid = ?");
  let lastRowid = 0;
  for (;;) {
    const rows = page.all(lastRowid) as { rid: number; text: string }[];
    if (rows.length === 0) break;
    for (const row of rows) {
      update.run(contentHash(row.text), row.rid);
      lastRowid = row.rid;
    }
  }
}

/** Read the store's current schema version (`PRAGMA user_version`). */
export function getSchemaVersion(db: DatabaseType.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

/**
 * Bring `db` up to SCHEMA_VERSION. Assumes `initSchema` already created the base
 * tables. A store reporting user_version 0 is treated as a base (version 1)
 * store: it was either just created, or it predates versioning but already
 * carries the v1 schema via the `IF NOT EXISTS` DDL. Each pending migration runs
 * in its own transaction, and user_version is advanced only after it succeeds,
 * so an interrupted upgrade never leaves a half-stamped store.
 */
export function runMigrations(db: DatabaseType.Database): void {
  const current = getSchemaVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new StoreSchemaTooNewError(current, SCHEMA_VERSION);
  }
  // An unstamped store (0) is already at the base version 1.
  let version = current === 0 ? 1 : current;

  for (const step of MIGRATIONS) {
    if (step.to > version) {
      const apply = db.transaction(() => {
        step.up(db);
        db.pragma(`user_version = ${step.to}`);
      });
      apply();
      version = step.to;
    }
  }

  // Stamp the base version on a store that was unstamped and had no migrations
  // to run (the common fresh-install and pre-versioning cases).
  if (version !== current) {
    db.pragma(`user_version = ${version}`);
  }
}
