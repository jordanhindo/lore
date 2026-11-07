import { basename, relative, resolve, isAbsolute } from "node:path";
import { stat, readFile, realpath } from "node:fs/promises";
import { codexAdapter } from "../../adapters/codex/adapter.js";
import type { Store } from "../store/open-store.js";
import { writeRecordBatch } from "../store/write-records.js";
import { resumeTokenSchema, type ResumeToken, type SourceFileKind } from "../records.js";
import { logger } from "../logger.js";
import type { SourceAdapter } from "../../adapters/contract.js";
import { claudeCodeAdapter } from "../../adapters/claude-code/adapter.js";

export interface IndexFileOptions {
  path: string;
  kind?: SourceFileKind;
  /** For subagent files: the agent file hash/name. */
  agentFile?: string | null;
  /**
   * Authoritative logical session for this file. Discovery passes the structural
   * parent session for subagent files; for primary files it defaults to the
   * filename (`<sessionId>.jsonl`).
   */
  sessionId?: string;
  maxTextChars?: number;
  /**
   * Opt-in secret redaction. Off by default (local-only store keeps everything
   * verbatim). When true, message text and tool payloads pass through the
   * credential redactor before they're stored or indexed.
   */
  redact?: boolean;
  /** Source adapter that knows how to ingest this harness's files. Defaults to Claude Code. */
  adapter?: SourceAdapter;
}

export interface IndexFileResult {
  sourceFileId: string;
  sessionId: string;
  /** What the resume plan decided: nothing to do, tail-appended, or fully re-indexed. */
  mode: "skip" | "append" | "full";
  messages: number;
  toolCalls: number;
  skipped: number;
}

/**
 * Read the persisted resume token for a file, or null if it was never indexed.
 * Prefers the `resume_token` column; falls back to reconstructing a byte token
 * from the legacy byte columns so stores indexed before the resume-token
 * migration resume without a re-index.
 */
function readResumeToken(db: Store, sourceFileId: string): ResumeToken | null {
  const row = db
    .prepare(
      "SELECT byte_offset, line_count, prefix_sha256, mtime, resume_token FROM source_files WHERE source_file_id = ?",
    )
    .get(sourceFileId) as
    | {
        byte_offset: number;
        line_count: number;
        prefix_sha256: string | null;
        mtime: string | null;
        resume_token: string | null;
      }
    | undefined;
  if (!row) return null;
  if (row.resume_token) {
    try {
      return resumeTokenSchema.parse(JSON.parse(row.resume_token));
    } catch (err) {
      logger.warn("ignoring invalid resume token; file will be fully re-indexed", {
        sourceFileId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
  return {
    kind: "byte",
    byteOffset: row.byte_offset,
    lineCount: row.line_count,
    prefixSha256: row.prefix_sha256,
    mtime: row.mtime,
  };
}

/** Physical (byte) descriptors for the source-file row, derived from the token. */
function physicalFromToken(token: ResumeToken): {
  byteOffset: number;
  lineCount: number;
  prefixSha256: string | null;
  mtime: string | null;
} {
  if (token.kind === "byte") {
    return {
      byteOffset: token.byteOffset,
      lineCount: token.lineCount,
      prefixSha256: token.prefixSha256,
      mtime: token.mtime,
    };
  }
  return { byteOffset: 0, lineCount: 0, prefixSha256: null, mtime: null };
}

/**
 * Index one discovered file via its adapter and persist the result. The single
 * ingestion path: read the prior resume token, hand it to `adapter.ingest`,
 * write the records the adapter yields through the shared writer, and persist
 * the new token. Resume-safe — the adapter's resume plan lets a re-index skip an
 * unchanged file, append only its new tail, or fully re-index a rewritten one.
 */
export async function indexFile(db: Store, opts: IndexFileOptions): Promise<IndexFileResult> {
  const sourceFileId = opts.path;
  const kind: SourceFileKind = opts.kind ?? "primary";
  const sessionId = opts.sessionId ?? basename(opts.path).replace(/\.jsonl$/i, "");
  const adapter = opts.adapter ?? claudeCodeAdapter;

  const priorToken = readResumeToken(db, sourceFileId);
  const result = await adapter.ingest(
    { path: opts.path, kind, agentFile: opts.agentFile ?? null, sessionId },
    {
      sourceFileId,
      sessionId,
      source: adapter.source,
      priorToken,
      maxTextChars: opts.maxTextChars,
    },
  );

  if (result.mode === "skip") {
    logger.debug("skipped unchanged file", { path: opts.path });
    return { sourceFileId, sessionId, mode: "skip", messages: 0, toolCalls: 0, skipped: 0 };
  }

  const phys = physicalFromToken(result.resumeToken);
  writeRecordBatch(
    db,
    {
      sourceFile: {
        sourceFileId,
        source: adapter.source,
        sessionId,
        kind,
        agentFile: opts.agentFile ?? null,
        path: opts.path,
        byteOffset: phys.byteOffset,
        lineCount: phys.lineCount,
        prefixSha256: phys.prefixSha256,
        mtime: phys.mtime,
        resumeToken: result.resumeToken,
        indexedAt: new Date().toISOString(),
      },
      messages: result.messages,
      toolCalls: result.toolCalls,
    },
    { mode: result.mode === "full" ? "full" : "append", redact: opts.redact },
  );

  logger.debug("indexed file", {
    path: opts.path,
    mode: result.mode,
    messages: result.messages.length,
    toolCalls: result.toolCalls.length,
    skipped: result.skipped,
  });

  return {
    sourceFileId,
    sessionId,
    mode: result.mode,
    messages: result.messages.length,
    toolCalls: result.toolCalls.length,
    skipped: result.skipped,
  };
}

export async function reindexRecentCompanyFiles(
  db: Store,
  options: { since: string; roots: string[] },
): Promise<{ reindexed: string[] }> {
  const floor = Date.parse(options.since);
  if (!Number.isFinite(floor) || !options.roots.length)
    throw new Error("reindex requires a floor and company roots");
  const roots = await Promise.all(
    options.roots.map((root) => realpath(root).catch(() => resolve(root))),
  );
  const within = async (cwd: unknown) => {
    if (typeof cwd !== "string") return false;
    const absolute = await realpath(cwd).catch(() => resolve(cwd));
    return roots.some((root) => {
      const rel = relative(root, absolute);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
  };
  const files = db
    .prepare(
      "SELECT path,source,kind,agent_file,session_id FROM source_files WHERE source IN ('claude-code','codex') ORDER BY path",
    )
    .all() as {
    path: string;
    source: string;
    kind: SourceFileKind;
    agent_file: string | null;
    session_id: string;
  }[];
  const reindexed: string[] = [];
  for (const file of files) {
    if ((await stat(file.path)).mtimeMs < floor) continue;
    let company = false;
    for (const line of (await readFile(file.path, "utf8")).split("\n")) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (await within(row.cwd ?? row.payload?.cwd)) {
        company = true;
        break;
      }
    }
    if (!company) continue;
    const adapter = file.source === "codex" ? codexAdapter : claudeCodeAdapter;
    await indexFile(db, {
      path: file.path,
      kind: file.kind,
      agentFile: file.agent_file,
      sessionId: file.session_id,
      adapter: {
        ...adapter,
        ingest: (file, ctx) => adapter.ingest(file, { ...ctx, priorToken: null }),
      },
    });
    reindexed.push(file.path);
  }
  return { reindexed };
}
