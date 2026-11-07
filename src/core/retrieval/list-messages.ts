import { stat, realpath } from "node:fs/promises";
import { relative, resolve, isAbsolute } from "node:path";
import type { Store } from "../store/open-store.js";
import { getMessage, type MessageDetail } from "./get-message.js";
export interface ListMessagesOptions {
  role: string;
  since: string;
  afterId?: string;
  limit?: number;
  afterIndex?: number;
  throughIndex?: number;
}
export function listMessages(
  db: Store,
  opts: ListMessagesOptions,
): {
  messages: MessageDetail[];
  nextCursor: {
    timestamp: string;
    messageId: string;
    index?: number;
    throughIndex?: number;
  } | null;
  snapshotIndex?: number;
  epoch?: string;
  indexReset?: boolean;
  gaps: { reason: string; id: string; project: string | null }[];
  malformedCount: number;
} {
  const limit = opts.limit ?? 100;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isFinite(Date.parse(opts.since)) ||
    !["user", "assistant", "system"].includes(opts.role)
  )
    throw new Error("invalid messages arguments");
  if (opts.afterIndex !== undefined) {
    const head = (
      db
        .prepare(
          "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='message_ingestions'),0) AS value",
        )
        .get() as { value: number }
    ).value;
    const snapshotIndex = opts.throughIndex ?? head;
    const epoch = (
      db.prepare("SELECT epoch FROM capture_cursor_meta WHERE id=1").get() as { epoch: string }
    ).epoch;
    if (
      !Number.isSafeInteger(opts.afterIndex) ||
      opts.afterIndex < 0 ||
      !Number.isSafeInteger(snapshotIndex) ||
      snapshotIndex < 0 ||
      snapshotIndex > head
    )
      throw new Error("invalid ingestion cursor");
    if (opts.afterIndex > snapshotIndex)
      return {
        messages: [],
        nextCursor: null,
        gaps: [],
        malformedCount: 0,
        snapshotIndex,
        epoch,
        indexReset: true,
      };
    const changes = db
      .prepare(
        "SELECT message_id AS id,source_timestamp AS timestamp,sequence FROM message_ingestions WHERE role=? AND sequence>? AND sequence<=? AND (source_timestamp>=? OR source_timestamp IS NULL) ORDER BY sequence LIMIT ?",
      )
      .all(opts.role, opts.afterIndex, snapshotIndex, opts.since, limit + 1) as {
      id: string;
      timestamp: string | null;
      sequence: number;
    }[];
    const selected = changes.slice(0, limit),
      last = selected.at(-1);
    const messages = selected
      .map((row) => getMessage(db, row.id, { full: true }))
      .filter((row): row is MessageDetail => row !== null)
      .map((row) => ({
        ...row,
        uuid: row.nativeUuid ?? row.uuid,
        loreSessionId: row.sessionId,
        sessionId: row.nativeSessionId ?? row.sessionId,
      }));
    return {
      messages,
      nextCursor:
        changes.length > limit && last
          ? {
              timestamp: last.timestamp ?? opts.since,
              messageId: last.id,
              index: last.sequence,
              throughIndex: snapshotIndex,
            }
          : null,
      snapshotIndex,
      epoch,
      gaps: [],
      malformedCount: messages.filter((row) => row.timestamp === null).length,
    };
  }
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
  const malformed = db
    .prepare(
      "SELECT message_id AS id,project FROM messages WHERE role=? AND timestamp IS NULL ORDER BY message_id LIMIT ?",
    )
    .all(opts.role, limit) as { id: string; project: string | null }[];
  const malformedCount = (
    db
      .prepare("SELECT COUNT(*) AS total FROM messages WHERE role=? AND timestamp IS NULL")
      .get(opts.role) as { total: number }
  ).total;
  return {
    gaps: malformed.map((row) => ({ reason: "malformed-lore-row", ...row })),
    malformedCount,
    messages: selected.map((row) => {
      const message = getMessage(db, row.id, { full: true })!;
      return {
        ...message,
        uuid: message.nativeUuid ?? message.uuid,
        loreSessionId: message.sessionId,
        sessionId: message.nativeSessionId ?? message.sessionId,
      };
    }),
    nextCursor:
      rows.length > limit && last ? { timestamp: last.timestamp, messageId: last.id } : null,
  };
}

interface CoverageSource {
  id: string;
  path: string;
  project: string | null;
  lastTimestamp: string | null;
}
export function messageCoverageSources(db: Store): CoverageSource[] {
  return db
    .prepare(
      `SELECT sf.source_file_id AS id,sf.path,
   (SELECT project FROM messages m WHERE m.source_file_id=sf.source_file_id AND m.project IS NOT NULL ORDER BY seq DESC LIMIT 1) AS project,
   (SELECT MAX(timestamp) FROM messages m WHERE m.source_file_id=sf.source_file_id) AS lastTimestamp
   FROM source_files sf WHERE sf.source IN ('claude-code','codex')`,
    )
    .all() as CoverageSource[];
}
export async function messageCoverageGaps(
  sources: CoverageSource[],
  roots: string[],
  since: string,
) {
  const canonical = await Promise.all(
    roots.map((root) => realpath(root).catch(() => resolve(root))),
  );
  const gaps: { reason: string; id: string; project: string | null }[] = [];
  for (const source of sources) {
    if (!source.project) continue;
    const project = await realpath(source.project).catch(() => resolve(source.project!));
    if (
      !canonical.some((root) => {
        const rel = relative(root, project);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      })
    )
      continue;
    try {
      const file = await stat(source.path);
      if (
        file.mtimeMs > Date.parse(since) &&
        file.mtimeMs - Date.parse(source.lastTimestamp ?? "") > 120000
      )
        gaps.push({ reason: "Lore behind", id: source.id, project: source.project });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        gaps.push({ reason: "source stat unavailable", id: source.id, project: source.project });
    }
  }
  return gaps;
}
