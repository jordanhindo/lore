import type { Store } from "../store/open-store.js";
import { getMessage, type MessageDetail } from "./get-message.js";
export interface ListMessagesOptions {
  role: string;
  since: string;
  afterId?: string;
  limit?: number;
}
export function listMessages(
  db: Store,
  opts: ListMessagesOptions,
): { messages: MessageDetail[]; nextCursor: { timestamp: string; messageId: string } | null } {
  const limit = opts.limit ?? 100;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isFinite(Date.parse(opts.since)) ||
    !["user", "assistant", "system"].includes(opts.role)
  )
    throw new Error("invalid messages arguments");
  const rows = db
    .prepare(
      `SELECT message_id AS id, timestamp FROM messages
    WHERE role = ? AND (timestamp > ? OR (timestamp = ? AND message_id > ?))
    ORDER BY timestamp, message_id LIMIT ?`,
    )
    .all(opts.role, opts.since, opts.since, opts.afterId ?? "", limit + 1) as {
    id: string;
    timestamp: string;
  }[];
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return {
    messages: selected.map((row) => {
      const message = getMessage(db, row.id, { full: true })!;
      return { ...message, uuid: message.nativeUuid ?? message.uuid };
    }),
    nextCursor:
      rows.length > limit && last ? { timestamp: last.timestamp, messageId: last.id } : null,
  };
}
