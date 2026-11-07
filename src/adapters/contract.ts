import type {
  MessageRecord,
  ParsedLine,
  ResumeToken,
  Source,
  SourceFileKind,
  ToolCallRecord,
} from "../core/records.js";

export interface FileMetadata {
  nativeSessionId?: string | null;
  entrypoint?: string | null;
  authorKind?: MessageRecord["authorKind"];
  project?: string | null;
  branch?: string | null;
  model?: string | null;
  agent?: string | null;
}

/**
 * The contract every source adapter implements. An adapter is the only
 * source-specific code in lore: it knows how to find a harness's transcripts on
 * disk (`discover`) and how to turn one discovered file into a stream of
 * normalized records (`ingest`). Everything downstream — store, search, MCP —
 * operates on the normalized records and never sees a harness quirk.
 *
 * There is a single ingestion path: `ingest` yields records and a new resume
 * token from a discovered file, given the prior token. Line-oriented sources
 * (JSONL transcripts) don't implement it by hand — they wrap a per-line mapper
 * with the built-in `lineIngest` helper, so a JSONL adapter still only expresses
 * its per-line mapping. Database / whole-file sources implement `ingest`
 * directly and own their own reading and resume.
 *
 * Stable message ids: a message id is `hash(sourceFileId + uuid + seq)` and is
 * the upsert key (see `computeMessageId`). An id that shifts between re-indexes
 * duplicates rows. Line sources can lean on positional `seq`. Database and
 * whole-file adapters MUST derive the id from the source's own stable primary
 * key (row id, task id) — never positional `seq` — because rows can be inserted,
 * deleted, or reordered between indexes.
 *
 * Adapters are proven against this contract by the conformance harness, so a new
 * harness can be onboarded by writing an adapter and watching it pass.
 */
export interface SourceAdapter {
  /** The harness namespace this adapter ingests into (e.g. "claude-code"). */
  readonly source: Source;
  /** Walk a root directory and return the transcript files to ingest. */
  discover(root: string): Promise<DiscoveredFile[]>;
  /** Produce normalized records (and a new resume token) for one discovered file. */
  ingest(file: DiscoveredFile, ctx: IngestContext): Promise<IngestResult>;
}

/** A transcript file located by an adapter's `discover`. */
export interface DiscoveredFile {
  path: string;
  kind: SourceFileKind;
  /** For subagent files, the agent file name (basename without extension). */
  agentFile: string | null;
  /**
   * Authoritative session id when the adapter can derive it structurally (e.g.
   * Claude Code subagent files name their parent session in the path). Null when
   * the indexer should infer it from the payload/filename.
   */
  sessionId: string | null;
}

/** Context the indexer threads into `ingest`. */
export interface IngestContext {
  sourceFileId: string;
  sessionId: string;
  source: Source;
  /** The resume token persisted on the last index of this file, or null if new. */
  priorToken: ResumeToken | null;
  /** Cap on stored text/tool payload chars. Adapters default this if unset. */
  maxTextChars?: number;
}

/** What one `ingest` run produced. */
export interface IngestResult {
  /** What the resume plan resolved to: nothing to do, tail-append, or full re-index. */
  mode: "skip" | "append" | "full";
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
  /** Lines/records the adapter intentionally skipped (meta rows, blanks). */
  skipped: number;
  /** Token to persist for the next resume (the prior token unchanged on skip). */
  resumeToken: ResumeToken;
}

/**
 * The per-line surface a line-oriented adapter expresses. Wrapped by
 * `lineIngest` into a full `ingest` implementation, so line adapters never deal
 * with streaming, byte offsets, or resume planning themselves.
 */
export interface LineMapper {
  source: Source;
  /** Optional file-level metadata pass for sources that put cwd/model in full-file meta lines. */
  getFileMetadata?(fullFileLines: string[], sourceFileId: string): FileMetadata;
  /** Parse one raw transcript line into normalized records, or skip it. */
  parseLine(rawLine: string, ctx: ParseContext): ParseOutcome;
}

/** Per-line context the line helper threads into `parseLine`. */
export interface ParseContext {
  nativeLineNumber?: number;
  sourceFileId: string;
  sessionId: string;
  seq: number;
  source: Source;
  fileMetadata?: FileMetadata;
  /** Cap on stored text/tool payload chars. Adapters default this if unset. */
  maxTextChars?: number;
}

/** Result of parsing one line: either normalized records or a counted skip. */
export type ParseOutcome =
  | { kind: "parsed"; parsed: ParsedLine }
  | { kind: "skipped"; reason: string };
