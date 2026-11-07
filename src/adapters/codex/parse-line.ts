import {
  computeMessageId,
  type MessageRecord,
  type MessageRole,
  type ToolCallRecord,
} from "../../core/records.js";
import type { FileMetadata, ParseContext, ParseOutcome } from "../contract.js";

const DEFAULT_MAX_TEXT_CHARS = 100_000;

interface CodexContentItem {
  type?: string;
  text?: string;
}

interface CodexPayload {
  type?: string;
  role?: string;
  content?: CodexContentItem[] | null;
  name?: string;
  arguments?: string;
  call_id?: string;
  output?: unknown;
  id?: string;
  cwd?: string;
  model?: string;
  agent_nickname?: string;
  agent_role?: string;
  agent_path?: string;
  source?: unknown;
  originator?: string;
  base_instructions?: { text?: string };
}

function cap(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max), truncated: true };
}

/** Codex roles include `developer` (system-level instructions); map it to system. */
function mapRole(role: string | undefined): MessageRole {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  return "system";
}

function joinContent(content: CodexContentItem[] | null | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  return JSON.stringify(output);
}

function parseJsonLine(rawLine: string): {
  type?: string;
  timestamp?: string;
  id?: string;
  uuid?: string;
  item_id?: string;
  payload?: CodexPayload;
} | null {
  try {
    return JSON.parse(rawLine) as {
      type?: string;
      timestamp?: string;
      id?: string;
      uuid?: string;
      item_id?: string;
      payload?: CodexPayload;
    };
  } catch {
    return null;
  }
}

function agentFromSessionMeta(payload: CodexPayload): string | null {
  if (typeof payload.agent_nickname === "string" && payload.agent_nickname.length > 0) {
    return payload.agent_nickname;
  }
  if (typeof payload.agent_path === "string" && payload.agent_path.length > 0) {
    return payload.agent_path;
  }
  return null;
}

export function getCodexFileMetadata(rawLines: string[]): FileMetadata {
  for (const line of rawLines) {
    const parsed = parseJsonLine(line);
    if (parsed?.type !== "session_meta") continue;
    const payload = parsed.payload ?? {};
    return {
      project: typeof payload.cwd === "string" ? payload.cwd : null,
      branch: null,
      model: typeof payload.model === "string" ? payload.model : null,
      agent: agentFromSessionMeta(payload),
      ...(typeof payload.originator === "string"
        ? {
            entrypoint: payload.originator === "T3 Code" ? "t3-code" : payload.originator,
            authorKind: sessionAuthor(payload),
          }
        : {}),
    };
  }
  return {};
}

/**
 * Parse one Codex rollout line into a normalized message (+ tool calls). Codex
 * uses a flat timeline: `message`, `function_call`, and `function_call_output`
 * each arrive on their own `response_item` line (unlike Claude, which nests tool
 * use inside a message). We map each event to a message so the text is
 * searchable, attaching a structured tool call to the call/output lines and
 * pairing them by `call_id`. Meta lines and encrypted reasoning are skipped.
 */
export function parseCodexLine(rawLine: string, ctx: ParseContext): ParseOutcome {
  const maxChars = ctx.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;

  const parsed = parseJsonLine(rawLine);
  if (!parsed) {
    return { kind: "skipped", reason: "json-parse-error" };
  }

  if (parsed.type !== "response_item") {
    return { kind: "skipped", reason: `unhandled-type:${String(parsed.type)}` };
  }
  const payload = parsed.payload ?? {};
  const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : null;
  const messageId = computeMessageId(ctx.sourceFileId, "", ctx.seq);

  const base = {
    messageId,
    sourceFileId: ctx.sourceFileId,
    sessionId: ctx.sessionId,
    nativeUuid:
      [parsed.id, parsed.uuid, parsed.item_id].find(
        (value) => typeof value === "string" && value.trim(),
      ) ?? `codex-line-${ctx.nativeLineNumber ?? ctx.seq + 1}`,
    uuid: "",
    parentUuid: null,
    seq: ctx.seq,
    timestamp,
    project: ctx.fileMetadata?.project ?? null,
    branch: ctx.fileMetadata?.branch ?? null,
    model: ctx.fileMetadata?.model ?? null,
    agent: ctx.fileMetadata?.agent ?? null,
    skill: null,
    entrypoint: ctx.fileMetadata?.entrypoint ?? null,
    authorKind: ctx.fileMetadata?.authorKind ?? "unattributed",
  };

  switch (payload.type) {
    case "message": {
      const capped = cap(joinContent(payload.content), maxChars);
      const message: MessageRecord = {
        ...base,
        role: mapRole(payload.role),
        authorKind:
          payload.role !== "user"
            ? "harness"
            : !stripInjectedCodexText(capped.text)
              ? "harness"
              : base.authorKind,
        text: capped.text,
        textTruncated: capped.truncated,
      };
      return { kind: "parsed", parsed: { message, toolCalls: [] } };
    }
    case "function_call": {
      const args = typeof payload.arguments === "string" ? payload.arguments : "";
      const name = typeof payload.name === "string" ? payload.name : "";
      const capped = cap(`${name} ${args}`.trim(), maxChars);
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      const input = cap(args, maxChars);
      const message: MessageRecord = {
        ...base,
        role: "assistant",
        text: capped.text,
        textTruncated: capped.truncated,
      };
      const toolCall: ToolCallRecord = {
        toolCallId: `${messageId}:${callId || ctx.seq}`,
        sourceFileId: ctx.sourceFileId,
        sessionId: ctx.sessionId,
        messageId,
        toolUseId: callId,
        toolName: name,
        input: input.text,
        result: null,
        isError: null,
        truncated: input.truncated,
      };
      return { kind: "parsed", parsed: { message, toolCalls: [toolCall] } };
    }
    case "function_call_output": {
      const out = cap(stringifyOutput(payload.output), maxChars);
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      const message: MessageRecord = {
        ...base,
        role: "system",
        text: out.text,
        textTruncated: out.truncated,
      };
      const toolCall: ToolCallRecord = {
        toolCallId: `${messageId}:result:${callId || ctx.seq}`,
        sourceFileId: ctx.sourceFileId,
        sessionId: ctx.sessionId,
        messageId,
        toolUseId: callId,
        toolName: "",
        input: "",
        result: out.text,
        isError: null,
        truncated: out.truncated,
      };
      return { kind: "parsed", parsed: { message, toolCalls: [toolCall] } };
    }
    default:
      return { kind: "skipped", reason: `unhandled-payload:${String(payload.type)}` };
  }
}

function sessionAuthor(payload: CodexPayload): NonNullable<MessageRecord["authorKind"]> {
  const source = payload.source;
  if (
    payload.originator === "codex_exec" ||
    source === "exec" ||
    source === "subagent" ||
    (source && typeof source === "object" && "subagent" in source) ||
    agentFromSessionMeta(payload)
  )
    return "agent";
  return ["Codex Desktop", "codex_cli_rs", "codex_vscode"].includes(payload.originator ?? "")
    ? "human"
    : "unattributed";
}

function stripInjectedCodexText(text: string): string {
  return text
    .replace(/# AGENTS\.md instructions for [^\n]*\n+<INSTRUCTIONS\b[\s\S]*?<\/INSTRUCTIONS>/gi, "")
    .replace(/<user_instructions\b[\s\S]*?<\/user_instructions>/gi, "")
    .replace(/<environment_context\b[\s\S]*?<\/environment_context>/gi, "")
    .trim();
}
