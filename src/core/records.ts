import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Normalized records that the core (store/search/MCP) operates on. Adapters are
 * responsible for turning source-specific transcript lines into these shapes and
 * Zod-validating them at the boundary, so the core never sees source quirks.
 */

export const SOURCES = ["claude-code", "codex", "openclaw", "cursor", "hermes"] as const;
export const sourceSchema = z.string().min(1);
export type Source = z.infer<typeof sourceSchema>;

/**
 * Source-agnostic resume watermark. Each ingestion path resumes differently, so
 * the token is a tagged union rather than a fixed set of byte fields:
 *  - `byte`  — append-only text transcripts (Claude Code, Codex, openclaw). The
 *              byte offset + line count is where the next read starts; the head
 *              hash distinguishes an in-place rewrite from an append.
 *  - `rowid` — database-backed sources (e.g. a SQLite table) that resume from the
 *              last ingested row id.
 *  - `hash`  — whole-file sources that have no incremental cursor; the content
 *              hash decides whether anything changed since last index.
 */
export const resumeTokenSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("byte"),
    byteOffset: z.number().int().nonnegative(),
    lineCount: z.number().int().nonnegative(),
    prefixSha256: z.string().nullable(),
    mtime: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("rowid"),
    value: z.number().int().nonnegative(),
    /**
     * Optional fingerprint of the already-indexed row prefix. New DB-backed
     * adapters set it so a changed/deleted row below the max row id forces a full
     * re-index instead of being skipped as "unchanged." Optional for legacy tokens.
     */
    fingerprint: z.string().optional(),
  }),
  z.object({ kind: z.literal("hash"), value: z.string() }),
]);
export type ResumeToken = z.infer<typeof resumeTokenSchema>;
export type ByteResumeToken = Extract<ResumeToken, { kind: "byte" }>;
export type RowidResumeToken = Extract<ResumeToken, { kind: "rowid" }>;
export type HashResumeToken = Extract<ResumeToken, { kind: "hash" }>;

export const SOURCE_FILE_KINDS = ["primary", "subagent"] as const;
export const sourceFileKindSchema = z.enum(SOURCE_FILE_KINDS);
export type SourceFileKind = z.infer<typeof sourceFileKindSchema>;

export const MESSAGE_ROLES = ["user", "assistant", "system"] as const;
export const messageRoleSchema = z.enum(MESSAGE_ROLES);
export type MessageRole = z.infer<typeof messageRoleSchema>;

/**
 * A physical transcript file on disk. This is the unit of ingestion and the
 * thing a resume watermark is attached to. Distinct from a logical session: one
 * session can span a primary file plus several subagent files.
 */
export const sourceFileRecordSchema = z.object({
  sourceFileId: z.string().min(1),
  source: sourceSchema,
  sessionId: z.string().min(1),
  kind: sourceFileKindSchema,
  /** For subagent files, the agent file hash/name; null for primary files. */
  agentFile: z.string().nullable(),
  path: z.string().min(1),
  /**
   * Physical descriptors of the file. For byte sources these mirror the byte
   * resume token; for database / whole-file sources they're zero/null and the
   * authoritative cursor lives in `resumeToken`.
   */
  byteOffset: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
  prefixSha256: z.string().nullable(),
  mtime: z.string().nullable(),
  /**
   * Source-agnostic resume watermark. Optional so live-`push` callers needn't
   * supply one (they re-push idempotently); the file indexer always sets it.
   * When absent on read, resume falls back to the legacy byte columns above, so
   * stores indexed before the resume-token migration upgrade cleanly.
   */
  resumeToken: resumeTokenSchema.nullable().optional(),
  indexedAt: z.string(),
});
export type SourceFileRecord = z.infer<typeof sourceFileRecordSchema>;

/** A logical session, rolled up across all of its source files. */
export const sessionRecordSchema = z.object({
  sessionId: z.string().min(1),
  source: sourceSchema,
  project: z.string().nullable(),
  branch: z.string().nullable(),
  firstTimestamp: z.string().nullable(),
  lastTimestamp: z.string().nullable(),
  messageCount: z.number().int().nonnegative(),
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

/**
 * One message within a file. The primary key is a synthetic
 * `messageId = hash(sourceFileId + uuid + seq)` because raw `uuid`s collide
 * across (and even within) files with different content — keying on uuid alone
 * would silently overwrite distinct messages. `uuid`/`parentUuid` are kept as
 * plain columns for thread reconstruction.
 */
export const messageRecordSchema = z.object({
  messageId: z.string().min(1),
  sourceFileId: z.string().min(1),
  sessionId: z.string().min(1),
  uuid: z.string(),
  nativeUuid: z.string().nullable().optional(),
  parentUuid: z.string().nullable(),
  /** Zero-based line index within the source file. */
  seq: z.number().int().nonnegative(),
  role: messageRoleSchema,
  timestamp: z.string().nullable(),
  project: z.string().nullable(),
  branch: z.string().nullable(),
  model: z.string().nullable(),
  /** Subagent identity (the agent file hash) for subagent messages; null on the primary thread. */
  agent: z.string().nullable(),
  /** Skill name if this message invoked a `Skill` tool_use; null otherwise. */
  skill: z.string().nullable(),
  /** Human-readable text, size-capped. `textTruncated` flags elision. */
  text: z.string(),
  textTruncated: z.boolean(),
  authorKind: z.enum(["human", "agent", "harness", "unattributed"]).nullable().optional(),
  entrypoint: z.string().nullable().optional(),
});
export type MessageRecord = z.infer<typeof messageRecordSchema>;

/**
 * The synthetic message id: a stable hash of (sourceFileId, uuid, seq). It is
 * stable across re-indexing of the same line but distinct when seq differs, so
 * the uuid-collision cases the schema warns about never overwrite distinct
 * messages. Every adapter calls this so all sources mint ids the same way.
 */
export function computeMessageId(sourceFileId: string, uuid: string, seq: number): string {
  return createHash("sha256").update(`${sourceFileId}\u0000${uuid}\u0000${seq}`).digest("hex");
}

/**
 * A tool invocation. `tool_use` and `tool_result` blocks are paired within file
 * scope by `toolUseId`. The result side may arrive on a later line.
 */
export const toolCallRecordSchema = z.object({
  toolCallId: z.string().min(1),
  sourceFileId: z.string().min(1),
  sessionId: z.string().min(1),
  /** The message the tool_use originated from. */
  messageId: z.string().min(1),
  toolUseId: z.string(),
  toolName: z.string(),
  input: z.string(),
  result: z.string().nullable(),
  isError: z.boolean().nullable(),
  truncated: z.boolean(),
});
export type ToolCallRecord = z.infer<typeof toolCallRecordSchema>;

/** The full output of parsing a single transcript line. */
export interface ParsedLine {
  message: MessageRecord;
  toolCalls: ToolCallRecord[];
}
