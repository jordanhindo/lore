import { describe, it, expect } from "vitest";
import { getCodexFileMetadata, parseCodexLine } from "./parse-line.js";
import type { ParseContext } from "../contract.js";

const ctx: ParseContext = {
  sourceFileId: "rollout-x.jsonl",
  sessionId: "rollout-x",
  seq: 3,
  source: "codex",
};

describe("parseCodexLine", () => {
  it("parses a user message response_item into a normalized message", () => {
    const line = JSON.stringify({
      timestamp: "2026-03-26T21:51:42.067Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "fix the routing bug" }],
      },
    });
    const out = parseCodexLine(line, ctx);
    expect(out.kind).toBe("parsed");
    if (out.kind !== "parsed") return;
    expect(out.parsed.message.role).toBe("user");
    expect(out.parsed.message.text).toBe("fix the routing bug");
    expect(out.parsed.message.timestamp).toBe("2026-03-26T21:51:42.067Z");
    expect(out.parsed.toolCalls).toHaveLength(0);
  });

  it("maps the developer role to system", () => {
    const line = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "system policy" }],
      },
    });
    const out = parseCodexLine(line, ctx);
    if (out.kind !== "parsed") throw new Error("expected parsed");
    expect(out.parsed.message.role).toBe("system");
  });

  it("extracts file-level metadata from Codex session_meta", () => {
    const metadata = getCodexFileMetadata([
      JSON.stringify({
        type: "session_meta",
        payload: {
          cwd: "/repo/project",
          model: "gpt-5.5",
          agent_nickname: "Ada",
        },
      }),
    ]);

    expect(metadata).toEqual({
      project: "/repo/project",
      branch: null,
      model: "gpt-5.5",
      agent: "Ada",
    });
  });

  it("attaches file-level metadata to parsed messages", () => {
    const line = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "metadata should travel" }],
      },
    });

    const out = parseCodexLine(line, {
      ...ctx,
      fileMetadata: {
        project: "/repo/project",
        branch: "main",
        model: "gpt-5.5",
        agent: "Ada",
      },
    });

    if (out.kind !== "parsed") throw new Error("expected parsed");
    expect(out.parsed.message.project).toBe("/repo/project");
    expect(out.parsed.message.branch).toBe("main");
    expect(out.parsed.message.model).toBe("gpt-5.5");
    expect(out.parsed.message.agent).toBe("Ada");
  });

  it("turns a function_call into an assistant message plus a tool call", () => {
    const line = JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: '{"cmd":"ls"}',
        call_id: "call_abc",
      },
    });
    const out = parseCodexLine(line, ctx);
    if (out.kind !== "parsed") throw new Error("expected parsed");
    expect(out.parsed.message.role).toBe("assistant");
    expect(out.parsed.message.text).toContain("exec_command");
    expect(out.parsed.toolCalls).toHaveLength(1);
    expect(out.parsed.toolCalls[0]?.toolName).toBe("exec_command");
    expect(out.parsed.toolCalls[0]?.toolUseId).toBe("call_abc");
    expect(out.parsed.toolCalls[0]?.input).toBe('{"cmd":"ls"}');
    expect(out.parsed.toolCalls[0]?.result).toBeNull();
  });

  it("turns a function_call_output into a tool result paired by call_id", () => {
    const line = JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_abc",
        output: "total 0\nfile.txt",
      },
    });
    const out = parseCodexLine(line, ctx);
    if (out.kind !== "parsed") throw new Error("expected parsed");
    expect(out.parsed.message.text).toContain("file.txt");
    expect(out.parsed.toolCalls).toHaveLength(1);
    expect(out.parsed.toolCalls[0]?.toolUseId).toBe("call_abc");
    expect(out.parsed.toolCalls[0]?.result).toContain("file.txt");
  });

  it("skips session_meta, turn_context, event_msg, and encrypted reasoning", () => {
    for (const payloadType of ["session_meta", "turn_context", "event_msg"]) {
      const line = JSON.stringify({ type: payloadType, payload: {} });
      expect(parseCodexLine(line, ctx).kind).toBe("skipped");
    }
    const reasoning = JSON.stringify({
      type: "response_item",
      payload: { type: "reasoning", summary: [], content: null, encrypted_content: "gAAA" },
    });
    expect(parseCodexLine(reasoning, ctx).kind).toBe("skipped");
  });

  it("skips malformed JSON without throwing", () => {
    expect(parseCodexLine("{not json", ctx).kind).toBe("skipped");
  });
});

// Confirmed seam: Codex parse with session metadata, SPEC R-02 L2.
describe("Codex authorship", () => {
  it.each([
    ["Codex Desktop", "cli", "human"],
    ["codex_cli_rs", "cli", "human"],
    ["codex_vscode", "vscode", "human"],
    ["codex_exec", "exec", "agent"],
    ["Codex Desktop", { subagent: { thread_spawn: {} } }, "agent"],
    ["unknown", "cli", "unattributed"],
  ])("classifies %s session %j as %s", (originator, source, expected) => {
    const fileMetadata = getCodexFileMetadata([
      JSON.stringify({ type: "session_meta", payload: { originator, source } }),
    ]);
    const result = parseCodexLine(
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Please keep this." }],
        },
      }),
      { ...ctx, fileMetadata },
    );
    if (result.kind !== "parsed") throw new Error(result.reason);
    expect(result.parsed.message).toMatchObject({ authorKind: expected, entrypoint: originator });
  });
  it("does not attribute an injected-only user row to a human", () => {
    const fileMetadata = getCodexFileMetadata([
      JSON.stringify({
        type: "session_meta",
        payload: { originator: "Codex Desktop", source: "cli" },
      }),
    ]);
    const result = parseCodexLine(
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<environment_context>injected</environment_context>" },
          ],
        },
      }),
      { ...ctx, fileMetadata },
    );
    if (result.kind !== "parsed") throw new Error(result.reason);
    expect(result.parsed.message).toMatchObject({ authorKind: "harness" });
  });
});

it("retains the native Codex id and supplies the Compass line identity when absent", () => {
  const line = {
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "words" }] },
  };
  const native = parseCodexLine(JSON.stringify({ ...line, uuid: "native-turn" }), ctx);
  const positional = parseCodexLine(JSON.stringify(line), ctx);
  if (native.kind !== "parsed" || positional.kind !== "parsed")
    throw new Error("expected messages");
  expect(native.parsed.message.nativeUuid).toBe("native-turn");
  expect(positional.parsed.message.nativeUuid).toBe("codex-line-4");
});

it("matches Compass native line identities when a transcript contains blank lines", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { codexAdapter } = await import("./adapter.js");
  const dir = await mkdtemp(join(tmpdir(), "lore-native-lines-"));
  try {
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { originator: "Codex Desktop", source: "cli" },
        }),
        "",
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "synthetic words" }],
          },
        }),
        "",
      ].join("\n"),
    );
    const result = await codexAdapter.ingest(
      { path, kind: "primary", agentFile: null, sessionId: "s" },
      { sourceFileId: "sf", sessionId: "s", source: "codex", priorToken: null },
    );
    expect(result.messages[0]?.nativeUuid).toBe("codex-line-2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("marks T3 Code sessions unattributed with the shared T3 confirmation entrypoint", () => {
  const metadata = getCodexFileMetadata([
    JSON.stringify({ type: "session_meta", payload: { originator: "T3 Code", source: "cli" } }),
  ]);
  expect(metadata).toMatchObject({ authorKind: "unattributed", entrypoint: "t3-code" });
});
