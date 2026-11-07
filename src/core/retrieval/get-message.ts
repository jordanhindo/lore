import type { Store } from "../store/open-store.js";
import { elide } from "../budget.js";

export interface MessageDetail {
  messageId: string;
  sourceFileId: string;
  source: string | null;
  sourcePath: string | null;
  lastTimestamp: string | null;
  sessionId: string;
  uuid: string;
  nativeUuid?: string | null;
  nativeSessionId?: string | null;
  loreSessionId?: string;
  parentUuid: string | null;
  seq: number;
  role: string;
  timestamp: string | null;
  project: string | null;
  branch: string | null;
  model: string | null;
  agent: string | null;
  text: string;
  textTruncated: boolean;
  authorKind: string | null;
  entrypoint: string | null;
}

export interface GetMessageOptions {
  /** When true, return the full stored text; otherwise a budget-elided snippet. */
  full?: boolean;
}

interface MessageRow {
  message_id: string;
  source_file_id: string;
  source: string | null;
  source_path: string | null;
  last_timestamp: string | null;
  session_id: string;
  uuid: string;
  native_uuid: string | null;
  native_session_id: string | null;
  parent_uuid: string | null;
  seq: number;
  role: string;
  timestamp: string | null;
  project: string | null;
  branch: string | null;
  model: string | null;
  agent: string | null;
  text: string;
  text_truncated: number;
  author_kind: string | null;
  entrypoint: string | null;
}

/**
 * Fetch one message by id. The escape hatch for content elided in search/
 * context responses: call with `full=true` to get the complete stored text.
 */
export function getMessage(
  db: Store,
  messageId: string,
  opts: GetMessageOptions = {},
): MessageDetail | null {
  const columns = new Set(
    (db.pragma("table_info(messages)") as { name: string }[]).map((column) => column.name),
  );
  const metadata = ["author_kind", "entrypoint", "native_uuid", "native_session_id"]
    .map((column) => (columns.has(column) ? column : `NULL AS ${column}`))
    .join(", ");
  const row = db
    .prepare(
      `SELECT message_id, source_file_id, session_id, uuid, parent_uuid, seq, role,
              timestamp, project, branch, model, agent, text, text_truncated, ${metadata},
              (SELECT source FROM source_files sf WHERE sf.source_file_id = messages.source_file_id) AS source,
              (SELECT path FROM source_files sf WHERE sf.source_file_id = messages.source_file_id) AS source_path,
              (SELECT last_timestamp FROM sessions s WHERE s.session_id = messages.session_id) AS last_timestamp
         FROM messages WHERE message_id = ?`,
    )
    .get(messageId) as MessageRow | undefined;
  if (!row) return null;

  return {
    messageId: row.message_id,
    sourceFileId: row.source_file_id,
    source: row.source,
    sourcePath: row.source_path,
    lastTimestamp: row.last_timestamp,
    sessionId: row.session_id,
    uuid: row.uuid,
    nativeUuid: row.native_uuid,
    nativeSessionId: row.native_session_id,
    parentUuid: row.parent_uuid,
    seq: row.seq,
    role: row.role,
    timestamp: row.timestamp,
    project: row.project,
    branch: row.branch,
    model: row.model,
    agent: row.agent,
    text: opts.full ? row.text : elide(row.text, row.message_id),
    textTruncated: row.text_truncated === 1,
    authorKind: row.author_kind,
    entrypoint: row.entrypoint,
  };
}
