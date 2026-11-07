import type { Store } from "../store/open-store.js";
import { elide } from "../budget.js";

export interface MessageDetail {
  messageId: string;
  sourceFileId: string;
  sessionId: string;
  uuid: string;
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
  session_id: string;
  uuid: string;
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
  const row = db
    .prepare(
      `SELECT message_id, source_file_id, session_id, uuid, parent_uuid, seq, role,
              timestamp, project, branch, model, agent, text, text_truncated, author_kind, entrypoint
         FROM messages WHERE message_id = ?`,
    )
    .get(messageId) as MessageRow | undefined;
  if (!row) return null;

  return {
    messageId: row.message_id,
    sourceFileId: row.source_file_id,
    sessionId: row.session_id,
    uuid: row.uuid,
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
