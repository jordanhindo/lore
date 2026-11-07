import type { Store } from "./open-store.js";
import {
  type MessageRecord,
  type SessionRecord,
  type SourceFileRecord,
  type ToolCallRecord,
} from "../records.js";
import { recomputeSession } from "./recompute-session.js";
import { contentHash } from "./content-hash.js";

/**
 * Idempotent writers. All keyed on a stable primary key with ON CONFLICT DO
 * UPDATE, so re-indexing the same file never duplicates rows and never churns
 * the FTS rowid (UPDATE keeps the rowid; INSERT OR REPLACE would not).
 */

export function upsertSourceFile(db: Store, rec: SourceFileRecord): void {
  db.prepare(
    `INSERT INTO source_files
       (source_file_id, source, session_id, kind, agent_file, path,
        byte_offset, line_count, prefix_sha256, mtime, resume_token, indexed_at)
     VALUES
       (@sourceFileId, @source, @sessionId, @kind, @agentFile, @path,
        @byteOffset, @lineCount, @prefixSha256, @mtime, @resumeToken, @indexedAt)
     ON CONFLICT(source_file_id) DO UPDATE SET
       session_id=excluded.session_id, kind=excluded.kind, agent_file=excluded.agent_file,
       path=excluded.path, byte_offset=excluded.byte_offset, line_count=excluded.line_count,
       prefix_sha256=excluded.prefix_sha256, mtime=excluded.mtime,
       resume_token=excluded.resume_token, indexed_at=excluded.indexed_at`,
  ).run({
    ...rec,
    // SQLite can't bind an object: store the tagged token as JSON, null when absent.
    resumeToken: rec.resumeToken ? JSON.stringify(rec.resumeToken) : null,
  });
}

export function upsertSession(db: Store, rec: SessionRecord): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, source, project, branch, first_timestamp, last_timestamp, message_count)
     VALUES
       (@sessionId, @source, @project, @branch, @firstTimestamp, @lastTimestamp, @messageCount)
     ON CONFLICT(session_id) DO UPDATE SET
       project=excluded.project, branch=excluded.branch,
       first_timestamp=excluded.first_timestamp, last_timestamp=excluded.last_timestamp,
       message_count=excluded.message_count`,
  ).run(rec);
}

export function upsertMessage(db: Store, rec: MessageRecord): void {
  db.prepare(
    `INSERT INTO messages
       (message_id, source_file_id, session_id, uuid, parent_uuid, seq, role,
        timestamp, project, branch, model, agent, skill, text, text_truncated, content_hash, author_kind, entrypoint, native_uuid)
     VALUES
       (@messageId, @sourceFileId, @sessionId, @uuid, @parentUuid, @seq, @role,
        @timestamp, @project, @branch, @model, @agent, @skill, @text, @textTruncated, @contentHash, @authorKind, @entrypoint, @nativeUuid)
     ON CONFLICT(message_id) DO UPDATE SET
       source_file_id=excluded.source_file_id, session_id=excluded.session_id,
       uuid=excluded.uuid, parent_uuid=excluded.parent_uuid, seq=excluded.seq,
       role=excluded.role, timestamp=excluded.timestamp, project=excluded.project,
       branch=excluded.branch, model=excluded.model, agent=excluded.agent,
       skill=excluded.skill, text=excluded.text, text_truncated=excluded.text_truncated,
       content_hash=excluded.content_hash, author_kind=excluded.author_kind, entrypoint=excluded.entrypoint, native_uuid=excluded.native_uuid`,
  ).run({
    ...rec,
    nativeUuid: rec.nativeUuid ?? null,
    authorKind: rec.authorKind ?? null,
    entrypoint: rec.entrypoint ?? null,
    textTruncated: rec.textTruncated ? 1 : 0,
    contentHash: contentHash(rec.text),
  });
}

/**
 * Remove every message and tool call belonging to one physical file. Used before
 * a full re-index of a rewritten/rotated file so stale rows never linger. The
 * messages delete fires the FTS delete trigger, keeping the index in sync.
 */
export function deleteFileRows(db: Store, sourceFileId: string): void {
  db.prepare("DELETE FROM tool_calls WHERE source_file_id = ?").run(sourceFileId);
  db.prepare("DELETE FROM messages WHERE source_file_id = ?").run(sourceFileId);
}

/**
 * Remove every message and tool call belonging to a single logical session.
 * The existing `messages_ad` AFTER DELETE trigger keeps the FTS5 index in sync
 * automatically — do not reimplement FTS deletion here.
 * After row deletion the session rollup is recomputed so `message_count`
 * reflects the new (zero) state, consistent with how `recomputeSession` is
 * used elsewhere in the write path.
 */
export function deleteSessionRows(db: Store, sessionId: string): void {
  db.prepare("DELETE FROM tool_calls WHERE session_id = ?").run(sessionId);
  db.prepare("DELETE FROM messages    WHERE session_id = ?").run(sessionId);
  recomputeSession(db, sessionId);
}

/**
 * Remove every message and tool call whose `project` column is an exact match
 * for `project`. Project matching is exact-string on the cwd path stored by the
 * adapter — no normalization, no prefix/subpath expansion.
 *
 * The `messages_ad` trigger keeps the FTS5 index in sync automatically.
 * Every affected session is recomputed so rollup counts stay accurate, using
 * the same approach as `forget --project`: enumerate affected sessions from
 * `messages` (not `sessions.project`, which reflects only the last non-null
 * project and can miss sessions whose final message had a null project).
 */
export function deleteProjectRows(db: Store, project: string): void {
  // Enumerate affected sessions before deleting so we can recompute them after.
  const affected = db
    .prepare("SELECT DISTINCT session_id AS sessionId FROM messages WHERE project = ?")
    .all(project) as { sessionId: string }[];

  // Delete tool calls by their owning message, not by session membership. A
  // session can span projects (a mid-session cwd change), and tool_calls has no
  // project column — deleting by session_id would wipe tool calls belonging to
  // the session's other-project messages. The message_id join is precise and
  // cheap (idx_tool_calls_message). Runs before the messages delete so the
  // subquery still resolves.
  db.prepare(
    "DELETE FROM tool_calls WHERE message_id IN (SELECT message_id FROM messages WHERE project = ?)",
  ).run(project);
  db.prepare("DELETE FROM messages WHERE project = ?").run(project);

  for (const { sessionId } of affected) {
    recomputeSession(db, sessionId);
  }
}

export function upsertToolCall(db: Store, rec: ToolCallRecord): void {
  db.prepare(
    `INSERT INTO tool_calls
       (tool_call_id, source_file_id, session_id, message_id, tool_use_id,
        tool_name, input, result, is_error, truncated)
     VALUES
       (@toolCallId, @sourceFileId, @sessionId, @messageId, @toolUseId,
        @toolName, @input, @result, @isError, @truncated)
     ON CONFLICT(tool_call_id) DO UPDATE SET
       source_file_id=excluded.source_file_id, session_id=excluded.session_id,
       message_id=excluded.message_id, tool_use_id=excluded.tool_use_id,
       tool_name=excluded.tool_name, input=excluded.input, result=excluded.result,
       is_error=excluded.is_error, truncated=excluded.truncated`,
  ).run({
    ...rec,
    isError: rec.isError === null ? null : rec.isError ? 1 : 0,
    truncated: rec.truncated ? 1 : 0,
  });
}
