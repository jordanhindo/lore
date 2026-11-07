import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type {
  DiscoveredFile,
  IngestContext,
  IngestResult,
  LineMapper,
} from "../../adapters/contract.js";
import type { MessageRecord, ResumeToken, ToolCallRecord } from "../records.js";
import { planReindex, prefixHash, PREFIX_BYTES } from "./watermark.js";

/**
 * The built-in ingestion path for line-oriented (JSONL) sources. Given a
 * per-line `LineMapper`, it returns a full `ingest` implementation: it resolves
 * the byte resume plan, streams the file line-by-line (memory stays bounded
 * regardless of transcript size), maps each line via the adapter's `parseLine`,
 * and returns the records plus a fresh byte resume token. Line adapters wrap
 * their mapper with this and never touch byte offsets or streaming themselves.
 */
export function lineIngest(mapper: LineMapper) {
  return async function ingest(file: DiscoveredFile, ctx: IngestContext): Promise<IngestResult> {
    const stats = await stat(file.path).catch(() => null);

    // To tell an in-place rewrite from an append, hash the head region the prior
    // watermark already covered — appends never touch those bytes. The token we
    // persist below covers the current head.
    const priorByte = ctx.priorToken?.kind === "byte" ? ctx.priorToken : null;
    const compareBytes = priorByte ? Math.min(PREFIX_BYTES, priorByte.byteOffset) : 0;
    const compareHash = compareBytes > 0 ? await prefixHash(file.path, compareBytes) : null;

    const plan = stats
      ? planReindex(ctx.priorToken, {
          kind: "byte",
          stats: { size: stats.size, mtime: stats.mtime.toISOString() },
          prefixHash: compareHash,
        })
      : ({ mode: "full" } as const);

    if (plan.mode === "skip") {
      // Nothing changed: hand back the prior token untouched.
      return {
        mode: "skip",
        messages: [],
        toolCalls: [],
        skipped: 0,
        resumeToken: ctx.priorToken ?? {
          kind: "byte",
          byteOffset: 0,
          lineCount: 0,
          prefixSha256: null,
          mtime: null,
        },
      };
    }

    const from = plan.mode === "append" && plan.from.kind === "byte" ? plan.from : null;
    const startByte = from ? from.byteOffset : 0;
    const startSeq = from ? from.lineCount : 0;

    const stream = createReadStream(file.path, { encoding: "utf8", start: startByte });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    // better-sqlite3 transactions are synchronous, so buffer lines async first,
    // then the indexer writes the batch in one transaction.
    interface Pending {
      line: string;
      seq: number;
    }
    const pending: Pending[] = [];
    let seq = startSeq;
    for await (const line of rl) {
      if (line.trim().length === 0) {
        seq++;
        continue;
      }
      pending.push({ line, seq });
      seq++;
    }

    const metadataLines = mapper.getFileMetadata ? await readLines(file.path) : [];
    const fileMetadata = mapper.getFileMetadata
      ? mapper.getFileMetadata(metadataLines, ctx.sourceFileId)
      : undefined;
    let nonEmpty = 0;
    const nativeLines = metadataLines.map((line) => {
      if (line.trim()) nonEmpty++;
      return nonEmpty;
    });

    const messages: MessageRecord[] = [];
    const toolCalls: ToolCallRecord[] = [];
    let skipped = 0;
    for (const { line, seq: lineSeq } of pending) {
      const outcome = mapper.parseLine(line, {
        sourceFileId: ctx.sourceFileId,
        sessionId: ctx.sessionId,
        seq: lineSeq,
        nativeLineNumber: nativeLines[lineSeq],
        source: mapper.source,
        fileMetadata,
        maxTextChars: ctx.maxTextChars,
      });
      if (outcome.kind === "skipped") {
        skipped++;
        continue;
      }
      const { message, toolCalls: calls } = outcome.parsed;
      messages.push(message);
      for (const call of calls) {
        call.sessionId = ctx.sessionId;
        toolCalls.push(call);
      }
    }

    // Persist a head-region hash covering the current file size, so the next
    // re-index can compare against this exact region.
    const finalStats = await stat(file.path).catch(() => null);
    const storeBytes = finalStats ? Math.min(PREFIX_BYTES, finalStats.size) : 0;
    const storeHash = storeBytes > 0 ? await prefixHash(file.path, storeBytes) : null;
    const resumeToken: ResumeToken = {
      kind: "byte",
      byteOffset: finalStats ? finalStats.size : 0,
      lineCount: seq,
      prefixSha256: storeHash,
      mtime: finalStats ? finalStats.mtime.toISOString() : null,
    };

    return { mode: plan.mode, messages, toolCalls, skipped, resumeToken };
  };
}

async function readLines(path: string): Promise<string[]> {
  const content = await readFile(path, "utf8");
  return content.split("\n");
}
