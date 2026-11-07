import {
  computeMessageId,
  type MessageRecord,
  type MessageRole,
  type ToolCallRecord,
} from "../../core/records.js";
import type { ParseContext, ParseOutcome } from "../contract.js";

const DEFAULT_MAX_TEXT_CHARS = 100_000;
const PARSEABLE_ROLES = new Set<MessageRole>(["user", "assistant", "system"]);

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function cap(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max), truncated: true };
}

function stringifyResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && "text" in b ? String((b as ContentBlock).text) : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function extractText(messageContent: unknown): string {
  if (typeof messageContent === "string") return messageContent;
  if (!Array.isArray(messageContent)) return "";
  const parts: string[] = [];
  for (const block of messageContent as ContentBlock[]) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "thinking" && typeof block.thinking === "string")
      parts.push(block.thinking);
  }
  return parts.join("\n");
}

/**
 * Parse one raw transcript line into a normalized message + tool calls.
 * Returns `skipped` (with a reason) for meta/unknown line types so the caller
 * can count skips instead of crashing. Oversized text is capped and flagged,
 * never loaded unbounded.
 */
export function parseLine(rawLine: string, ctx: ParseContext): ParseOutcome {
  const maxChars = ctx.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawLine) as Record<string, unknown>;
  } catch {
    return { kind: "skipped", reason: "json-parse-error" };
  }

  const attachment =
    parsed["type"] === "attachment" &&
    parsed["attachment"] &&
    typeof parsed["attachment"] === "object"
      ? (parsed["attachment"] as Record<string, unknown>)
      : null;
  const queued = attachment?.["type"] === "queued_command";
  const type = queued ? "user" : parsed["type"];
  if (typeof type !== "string" || !PARSEABLE_ROLES.has(type as MessageRole)) {
    return { kind: "skipped", reason: `unhandled-type:${String(type)}` };
  }
  const role = type as MessageRole;

  const uuid = typeof parsed["uuid"] === "string" ? (parsed["uuid"] as string) : "";
  const parentUuid =
    typeof parsed["parentUuid"] === "string" ? (parsed["parentUuid"] as string) : null;
  const timestamp =
    typeof parsed["timestamp"] === "string" ? (parsed["timestamp"] as string) : null;
  const project = typeof parsed["cwd"] === "string" ? (parsed["cwd"] as string) : null;
  const branch = typeof parsed["gitBranch"] === "string" ? (parsed["gitBranch"] as string) : null;

  const messageBlock =
    parsed["message"] && typeof parsed["message"] === "object"
      ? (parsed["message"] as Record<string, unknown>)
      : null;

  const model =
    messageBlock && typeof messageBlock["model"] === "string"
      ? (messageBlock["model"] as string)
      : null;

  const agent = typeof parsed["agentId"] === "string" ? (parsed["agentId"] as string) : null;

  const rawContent = queued
    ? (attachment?.["content"] ?? attachment?.["prompt"])
    : messageBlock
      ? messageBlock["content"]
      : parsed["content"];
  const capped = cap(extractText(rawContent), maxChars);
  const skill = extractSkill(rawContent);

  const messageId = computeMessageId(ctx.sourceFileId, uuid, ctx.seq);

  const message: MessageRecord = {
    messageId,
    sourceFileId: ctx.sourceFileId,
    sessionId: ctx.sessionId,
    uuid,
    parentUuid,
    seq: ctx.seq,
    role,
    timestamp,
    project,
    branch,
    model,
    agent,
    skill,
    text: capped.text,
    textTruncated: capped.truncated,
    entrypoint: typeof parsed["entrypoint"] === "string" ? parsed["entrypoint"] : null,
    authorKind: authorKind(parsed, rawContent, queued ? attachment?.["origin"] : undefined),
  };

  const toolCalls = extractToolCalls(rawContent, ctx, messageId, maxChars);

  return { kind: "parsed", parsed: { message, toolCalls } };
}

/** The skill name of the first `Skill` tool_use in the content, if any. */
function extractSkill(rawContent: unknown): string | null {
  if (!Array.isArray(rawContent)) return null;
  for (const block of rawContent as ContentBlock[]) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "tool_use" && block.name === "Skill") {
      const input = block.input;
      if (input && typeof input === "object" && "skill" in input) {
        const skill = (input as { skill?: unknown }).skill;
        if (typeof skill === "string" && skill.length > 0) return skill;
      }
    }
  }
  return null;
}

function extractToolCalls(
  rawContent: unknown,
  ctx: ParseContext,
  messageId: string,
  maxChars: number,
): ToolCallRecord[] {
  if (!Array.isArray(rawContent)) return [];
  const calls: ToolCallRecord[] = [];
  for (const block of rawContent as ContentBlock[]) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "tool_use") {
      const input = cap(JSON.stringify(block.input ?? null), maxChars);
      calls.push({
        toolCallId: `${messageId}:${block.id ?? calls.length}`,
        sourceFileId: ctx.sourceFileId,
        sessionId: ctx.sessionId,
        messageId,
        toolUseId: typeof block.id === "string" ? block.id : "",
        toolName: typeof block.name === "string" ? block.name : "",
        input: input.text,
        result: null,
        isError: null,
        truncated: input.truncated,
      });
    } else if (block.type === "tool_result") {
      const result = cap(stringifyResultContent(block.content), maxChars);
      calls.push({
        toolCallId: `${messageId}:result:${block.tool_use_id ?? calls.length}`,
        sourceFileId: ctx.sourceFileId,
        sessionId: ctx.sessionId,
        messageId,
        toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
        toolName: "",
        input: "",
        result: result.text,
        isError: typeof block.is_error === "boolean" ? block.is_error : null,
        truncated: result.truncated,
      });
    }
  }
  return calls;
}

function authorKind(
  row: Record<string, unknown>,
  content: unknown,
  queuedOrigin?: unknown,
): NonNullable<MessageRecord["authorKind"]> {
  if (row["agentId"] || row["entrypoint"] === "sdk-cli") return "agent";
  const origin = (row["origin"] ?? queuedOrigin) as { kind?: string } | undefined;
  if (
    row["isCompactSummary"] ||
    row["isMeta"] ||
    (Array.isArray(content) && content.some((block) => block?.type === "tool_result")) ||
    (origin?.kind && origin.kind !== "human")
  )
    return "harness";
  if (row["entrypoint"] === "t3-code") return "unattributed";
  return origin?.kind === "human" ? "human" : "unattributed";
}
