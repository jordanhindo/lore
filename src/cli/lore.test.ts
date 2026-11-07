import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Readable } from "node:stream";
import { runCli } from "./lore.js";
import { openStore } from "../core/store/open-store.js";
import { SCHEMA_VERSION } from "../core/store/migrate.js";
import { upsertSourceFile } from "../core/store/upsert.js";
import { searchMemory } from "../core/search/search-memory.js";
import { listTombstones } from "../core/store/tombstones.js";
import { pushRecords } from "../core/ingest/push.js";

/** Run `argv` with `input` piped on stdin, restoring the real stdin afterward. */
async function runWithStdin(argv: string[], input: string): Promise<{ code: number; out: string }> {
  const writes: string[] = [];
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  const orig = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", {
    value: Readable.from([Buffer.from(input)]),
    configurable: true,
  });
  try {
    const code = await runCli(argv);
    return { code, out: writes.join("") };
  } finally {
    out.mockRestore();
    if (orig) Object.defineProperty(process, "stdin", orig);
  }
}

async function runCaptured(
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  try {
    const code = await runCli(argv);
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

const VALID_PUSH_BATCH = {
  sourceFile: {
    sourceFileId: "sf-push",
    source: "claude-code",
    sessionId: "sess-push",
    kind: "primary",
    agentFile: null,
    path: "/transcripts/push.jsonl",
    byteOffset: 0,
    lineCount: 1,
    prefixSha256: null,
    mtime: null,
    indexedAt: "2026-05-10T00:00:00.000Z",
  },
  messages: [
    {
      messageId: "mp1",
      sourceFileId: "sf-push",
      sessionId: "sess-push",
      uuid: "u1",
      parentUuid: null,
      seq: 0,
      role: "user",
      timestamp: "2026-05-10T00:00:00.000Z",
      project: "/repo",
      branch: "main",
      model: null,
      agent: null,
      skill: null,
      text: "pushed alamo content",
      textTruncated: false,
    },
  ],
  toolCalls: [],
};

function writeHermesFixtureDb(path: string, content: string): void {
  const db = new Database(path);
  db.exec(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, cwd TEXT, started_at REAL)",
  );
  db.exec(
    "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL)",
  );
  db.prepare("INSERT INTO sessions (id, source, model, cwd, started_at) VALUES (?,?,?,?,?)").run(
    "sess-hermes-sync",
    "cli",
    "minimax/minimax-m2.7",
    "/repo/hermes",
    1776879366,
  );
  db.prepare(
    "INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp) VALUES (?,?,?,?,?,?,?)",
  ).run("sess-hermes-sync", "user", content, null, null, null, 1776879366);
  db.close();
}

function seedStatusStore(): void {
  const db = openStore(dbPath);
  try {
    pushRecords(db, {
      sourceFile: {
        sourceFileId: "sf-status-claude",
        source: "claude-code",
        sessionId: "sess-status-claude",
        kind: "primary",
        agentFile: null,
        path: "/transcripts/status-claude.jsonl",
        byteOffset: 0,
        lineCount: 1,
        prefixSha256: null,
        mtime: null,
        indexedAt: "2026-05-10T12:05:00.000Z",
      },
      messages: [
        {
          messageId: "m-status-claude",
          sourceFileId: "sf-status-claude",
          sessionId: "sess-status-claude",
          uuid: "u-status-claude",
          parentUuid: null,
          seq: 0,
          role: "user",
          timestamp: "2026-05-10T12:00:00.000Z",
          project: "/repo",
          branch: "main",
          model: "gpt-5.5",
          agent: null,
          skill: null,
          text: "status fixture for claude source",
          textTruncated: false,
        },
      ],
      toolCalls: [],
    });
    pushRecords(db, {
      sourceFile: {
        sourceFileId: "sf-status-codex",
        source: "codex",
        sessionId: "sess-status-codex",
        kind: "primary",
        agentFile: null,
        path: "/transcripts/status-codex.jsonl",
        byteOffset: 0,
        lineCount: 1,
        prefixSha256: null,
        mtime: null,
        indexedAt: "2026-05-11T08:15:00.000Z",
      },
      messages: [
        {
          messageId: "m-status-codex",
          sourceFileId: "sf-status-codex",
          sessionId: "sess-status-codex",
          uuid: "u-status-codex",
          parentUuid: null,
          seq: 0,
          role: "assistant",
          timestamp: "2026-05-11T08:00:00.000Z",
          project: "/other",
          branch: "main",
          model: "gpt-5.5",
          agent: null,
          skill: null,
          text: "status fixture for codex source",
          textTruncated: false,
        },
      ],
      toolCalls: [],
    });
  } finally {
    db.close();
  }
}

let dir: string;
let dbPath: string;
let prevDb: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lore-cli-"));
  dbPath = join(dir, "lore.db");
  prevDb = process.env.LORE_DB;
  process.env.LORE_DB = dbPath;
});

afterEach(async () => {
  if (prevDb === undefined) delete process.env.LORE_DB;
  else process.env.LORE_DB = prevDb;
  await rm(dir, { recursive: true, force: true });
});

describe("lore CLI", () => {
  it("`index <dir>` backfills transcripts into the store", async () => {
    const transcript =
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: "2026-05-10T00:00:00.000Z",
        sessionId: "sess-cli",
        cwd: "/repo",
        gitBranch: "main",
        message: { role: "user", content: "cli alamo keyword" },
      }) + "\n";
    await writeFile(join(dir, "sess-cli.jsonl"), transcript);

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["index", dir]);
    spy.mockRestore();

    expect(code).toBe(0);
    expect(writes.join("")).toContain("Indexed 1 files");

    const db = openStore(dbPath);
    expect(searchMemory(db, "alamo")).toHaveLength(1);
    db.close();
  });

  it("returns non-zero and usage when `index` has no dir", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runCli(["index"]);
    spy.mockRestore();
    expect(code).toBe(1);
  });

  it("`sync codex` incrementally indexes the active Codex session tree", async () => {
    const codexDir = join(dir, ".codex", "sessions", "2026", "06", "09");
    await mkdir(codexDir, { recursive: true });
    const transcript =
      JSON.stringify({
        type: "session_meta",
        payload: { cwd: "/repo/codex", model: "gpt-5-codex" },
      }) +
      "\n" +
      JSON.stringify({
        timestamp: "2026-06-09T12:00:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "codex live sync keyword" }],
        },
      }) +
      "\n";
    await writeFile(join(codexDir, "rollout-2026-live.jsonl"), transcript);

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const first = await runCli(["sync", "codex", "--home", dir]);
    const second = await runCli(["sync", "--home", dir, "codex"]);
    spy.mockRestore();

    expect(first).toBe(0);
    expect(second).toBe(0);
    const out = writes.join("");
    expect(out).toContain("Synced codex");
    expect(out).toContain("1 indexed");
    expect(out).toContain("1 skipped");

    const db = openStore(dbPath);
    const hits = searchMemory(db, "sync", { source: "codex" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.project).toBe("/repo/codex");
    db.close();
  });

  it("`sync claude-code` incrementally indexes the active Claude projects tree", async () => {
    const claudeDir = join(dir, ".claude", "projects", "myproj");
    await mkdir(claudeDir, { recursive: true });
    const transcript =
      JSON.stringify({
        type: "user",
        uuid: "u-claude-sync",
        parentUuid: null,
        timestamp: "2026-06-25T12:00:00.000Z",
        sessionId: "sess-claude-sync",
        cwd: "/repo/claude",
        gitBranch: "main",
        message: { role: "user", content: "claude live sync keyword" },
      }) + "\n";
    await writeFile(join(claudeDir, "sess-claude-sync.jsonl"), transcript);

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const first = await runCli(["sync", "claude-code", "--home", dir]);
    const second = await runCli(["sync", "--home", dir, "claude-code"]);
    spy.mockRestore();

    expect(first).toBe(0);
    expect(second).toBe(0);
    const out = writes.join("");
    expect(out).toContain("Synced claude-code");
    expect(out).toContain("1 indexed");
    expect(out).toContain("1 skipped");

    const db = openStore(dbPath);
    const hits = searchMemory(db, "sync", { source: "claude-code" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.project).toBe("/repo/claude");
    db.close();
  });

  it("`sync claude-code` includes nested subagent transcripts", async () => {
    const claudeDir = join(dir, ".claude", "projects", "myproj");
    const subagentDir = join(claudeDir, "sess-claude-subagent", "subagents");
    await mkdir(subagentDir, { recursive: true });
    await writeFile(
      join(claudeDir, "sess-claude-subagent.jsonl"),
      JSON.stringify({
        type: "user",
        uuid: "u-claude-primary",
        parentUuid: null,
        timestamp: "2026-06-25T12:00:00.000Z",
        sessionId: "sess-claude-subagent",
        cwd: "/repo/claude",
        gitBranch: "main",
        message: { role: "user", content: "primary sync sentinel" },
      }) + "\n",
    );
    await writeFile(
      join(subagentDir, "agent-alpha.jsonl"),
      JSON.stringify({
        type: "user",
        uuid: "u-claude-subagent",
        parentUuid: null,
        timestamp: "2026-06-25T12:00:01.000Z",
        sessionId: "sess-claude-subagent",
        cwd: "/repo/claude",
        gitBranch: "main",
        agentId: "alpha",
        message: { role: "user", content: "subagent sync sentinel" },
      }) + "\n",
    );

    const result = await runCaptured(["sync", "claude-code", "--home", dir]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Synced claude-code");
    expect(result.stdout).toContain("2 indexed");

    const db = openStore(dbPath);
    const primaryHits = searchMemory(db, "primary sentinel", { source: "claude-code" });
    const subagentHits = searchMemory(db, "subagent sentinel", { source: "claude-code" });
    expect(primaryHits).toHaveLength(1);
    expect(subagentHits).toHaveLength(1);
    expect(subagentHits[0]?.agent).toBe("alpha");
    db.close();
  });

  it("`sync hermes` detects the global Hermes root and indexes its state database", async () => {
    const hermesDir = join(dir, ".hermes");
    await mkdir(hermesDir, { recursive: true });
    writeHermesFixtureDb(join(hermesDir, "state.db"), "hermes live sync keyword");

    const result = await runCaptured(["sync", "hermes", "--home", dir]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Synced hermes");
    expect(result.stdout).toContain("1 indexed");

    const db = openStore(dbPath);
    const hits = searchMemory(db, "hermes live sync", { source: "hermes" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.project).toBe("/repo/hermes");
    db.close();
  });

  it("`sync codex` fails cleanly when no Codex transcripts are present", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["sync", "codex", "--home", dir]);
    spy.mockRestore();

    expect(code).toBe(1);
    expect(writes.join("")).toContain("no codex transcripts found");
  });

  it("`sync claude-code` fails cleanly when no Claude transcripts are present", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["sync", "claude-code", "--home", dir]);
    spy.mockRestore();

    expect(code).toBe(1);
    expect(writes.join("")).toContain("no claude-code transcripts found");
  });

  it("`sync <source>` explains registered sources without detected sync roots", async () => {
    const result = await runCaptured(["sync", "openclaw", "--home", dir]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('detected sync is not configured for "openclaw"');
    expect(result.stderr).toContain("Detected sync supports: claude-code, codex, hermes");
    expect(result.stderr).toContain("lore index <dir> --source openclaw");
  });

  it("`sync codex --home` requires a directory", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["sync", "codex", "--home"]);
    spy.mockRestore();

    expect(code).toBe(1);
    expect(writes.join("")).toContain("--home requires a directory");
  });

  it("`search <query>` finds indexed content without the MCP server", async () => {
    const db = openStore(dbPath);
    upsertSourceFile(db, {
      sourceFileId: "sf-1",
      source: "codex",
      sessionId: "sess-search",
      kind: "primary",
      agentFile: null,
      path: "/transcripts/sess-search.jsonl",
      byteOffset: 0,
      lineCount: 1,
      prefixSha256: null,
      mtime: null,
      resumeToken: null,
      indexedAt: "2026-05-10T00:00:00.000Z",
    });
    db.prepare(
      `INSERT INTO messages (message_id, source_file_id, session_id, uuid, seq, role, timestamp, project, branch, text, text_truncated)
       VALUES ('m1', 'sf-1', 'sess-search', 'u1', 0, 'user', '2026-05-10T00:00:00.000Z', '/repo', 'main', 'cli alamo keyword', 0)`,
    ).run();
    db.close();

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["search", "alamo", "--json"]);
    spy.mockRestore();

    expect(code).toBe(0);
    const parsed = JSON.parse(writes.join(""));
    expect(parsed.count).toBe(1);
    expect(parsed.hits[0].messageId).toBe("m1");
    expect(parsed.hits[0].source).toBe("codex");
  });

  it("`search` can read a compatible store from a newer Lore version", async () => {
    const db = openStore(dbPath);
    upsertSourceFile(db, {
      sourceFileId: "sf-newer-read",
      source: "codex",
      sessionId: "sess-newer-read",
      kind: "primary",
      agentFile: null,
      path: "/transcripts/sess-newer-read.jsonl",
      byteOffset: 0,
      lineCount: 1,
      prefixSha256: null,
      mtime: null,
      resumeToken: null,
      indexedAt: "2026-05-10T00:00:00.000Z",
    });
    db.prepare(
      `INSERT INTO messages (message_id, source_file_id, session_id, uuid, seq, role, timestamp, project, branch, text, text_truncated)
       VALUES ('m-newer-read', 'sf-newer-read', 'sess-newer-read', 'u1', 0, 'user', '2026-05-10T00:00:00.000Z', '/repo', 'main', 'newer readable alamo keyword', 0)`,
    ).run();
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["search", "alamo", "--json"]);
    spy.mockRestore();

    expect(code).toBe(0);
    const parsed = JSON.parse(writes.join(""));
    expect(parsed.hits.map((h: { messageId: string }) => h.messageId)).toContain("m-newer-read");
  });

  it("`index` refuses to write to a store from a newer Lore version", async () => {
    const db = openStore(dbPath);
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    const transcriptDir = join(dir, "transcripts");
    await mkdir(transcriptDir);
    await writeFile(
      join(transcriptDir, "sess-newer-write.jsonl"),
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: "2026-05-10T00:00:00.000Z",
        sessionId: "sess-newer-write",
        cwd: "/repo",
        gitBranch: "main",
        message: { role: "user", content: "should not index" },
      }) + "\n",
    );

    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["index", transcriptDir]);
    spy.mockRestore();

    expect(code).toBe(1);
    expect(writes.join("")).toContain("Update Lore before running this write command");
  });

  it("`search <query> --session` narrows results through the CLI", async () => {
    const db = openStore(dbPath);
    db.prepare(
      `INSERT INTO messages (message_id, source_file_id, session_id, uuid, seq, role, timestamp, project, branch, text, text_truncated)
       VALUES
       ('m1', 'sf-1', 'sess-a', 'u1', 0, 'user', '2026-05-10T00:00:00.000Z', '/repo', 'main', 'cli alamo keyword a', 0),
       ('m2', 'sf-2', 'sess-b', 'u2', 0, 'user', '2026-05-10T00:01:00.000Z', '/repo', 'main', 'cli alamo keyword b', 0)`,
    ).run();
    db.close();

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["search", "alamo", "--session", "sess-b", "--json"]);
    spy.mockRestore();

    expect(code).toBe(0);
    const parsed = JSON.parse(writes.join(""));
    expect(parsed.count).toBe(1);
    expect(parsed.hits.map((h: { messageId: string }) => h.messageId)).toEqual(["m2"]);
  });

  it("`search` returns non-zero when no query is given", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runCli(["search"]);
    spy.mockRestore();
    expect(code).toBe(1);
  });

  it("`search` returns non-zero when the store does not exist", async () => {
    process.env.LORE_DB = join(dir, "absent.db");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runCli(["search", "alamo"]);
    spy.mockRestore();
    expect(code).toBe(1);
  });

  it("`search` returns a friendly error when the store exists but lacks FTS schema", async () => {
    const stale = new Database(dbPath);
    stale.exec("CREATE TABLE messages (message_id TEXT PRIMARY KEY, text TEXT)");
    stale.close();

    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["search", "alamo"]);
    spy.mockRestore();

    const stderr = writes.join("");
    expect(code).toBe(1);
    expect(stderr).toContain("Run `lore setup` or `lore index <dir>` first");
    expect(stderr).not.toContain("messages_fts");
    expect(stderr.toLowerCase()).not.toContain("sqlite");
  });

  it("`sessions` returns a friendly error when the store exists but lacks schema", async () => {
    const stale = new Database(dbPath);
    stale.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
    stale.close();

    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["sessions"]);
    spy.mockRestore();

    const stderr = writes.join("");
    expect(code).toBe(1);
    expect(stderr).toContain("Run `lore setup` or `lore index <dir>` first");
    expect(stderr).not.toContain("messages");
    expect(stderr.toLowerCase()).not.toContain("sqlite");
  });

  it("`sessions` lists session rollups from the store", async () => {
    const db = openStore(dbPath);
    db.prepare(
      `INSERT INTO messages (message_id, source_file_id, session_id, uuid, seq, role, timestamp, project, branch, text, text_truncated)
       VALUES ('m1', 'sf-1', 'sess-roll', 'u1', 0, 'user', '2026-05-10T00:00:00.000Z', '/repo', 'main', 'hello', 0)`,
    ).run();
    db.close();

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["sessions", "--json"]);
    spy.mockRestore();

    expect(code).toBe(0);
    const parsed = JSON.parse(writes.join(""));
    expect(parsed.count).toBe(1);
    expect(parsed.sessions[0].sessionId).toBe("sess-roll");
  });

  it("`sessions --project --limit` filters and limits through the CLI", async () => {
    const db = openStore(dbPath);
    db.prepare(
      `INSERT INTO messages (message_id, source_file_id, session_id, uuid, seq, role, timestamp, project, branch, text, text_truncated)
       VALUES
       ('m1', 'sf-1', 'sess-a', 'u1', 0, 'user', '2026-05-10T00:00:00.000Z', '/repo-a', 'main', 'hello', 0),
       ('m2', 'sf-2', 'sess-b', 'u2', 0, 'user', '2026-05-10T00:01:00.000Z', '/repo-a', 'main', 'hello', 0),
       ('m3', 'sf-3', 'sess-c', 'u3', 0, 'user', '2026-05-10T00:02:00.000Z', '/repo-b', 'main', 'hello', 0)`,
    ).run();
    db.close();

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["sessions", "--project", "/repo-a", "--limit", "1", "--json"]);
    spy.mockRestore();

    expect(code).toBe(0);
    const parsed = JSON.parse(writes.join(""));
    expect(parsed.count).toBe(1);
    expect(parsed.sessions[0].sessionId).toBe("sess-b");
    expect(parsed.sessions[0].project).toBe("/repo-a");
  });

  it("`status --json` reports a scoped ready non-empty store", async () => {
    seedStatusStore();

    const result = await runCaptured([
      "status",
      "--json",
      "--source",
      "claude-code",
      "--project",
      "/repo",
      "--since",
      "2026-05-10T00:00:00.000Z",
      "--until",
      "2026-05-10T23:59:59.999Z",
    ]);

    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      status: "ready",
      filters: {
        source: "claude-code",
        project: "/repo",
        since: "2026-05-10T00:00:00.000Z",
        until: "2026-05-10T23:59:59.999Z",
      },
      storePath: dbPath,
      schemaVersion: SCHEMA_VERSION,
      supportedSchemaVersion: SCHEMA_VERSION,
      messageCount: 1,
      sessionCount: 1,
      sources: [
        {
          source: "claude-code",
          messageCount: 1,
          sessionCount: 1,
          latestMessageTimestamp: "2026-05-10T12:00:00.000Z",
          latestIndexedAt: "2026-05-10T12:05:00.000Z",
        },
      ],
      recovery: null,
    });
  });

  it("`status --json` treats newer read-compatible stores as ready", async () => {
    seedStatusStore();
    const db = new Database(dbPath);
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    const result = await runCaptured(["status", "--json", "--source", "claude-code"]);

    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      status: "ready",
      schemaVersion: SCHEMA_VERSION + 1,
      supportedSchemaVersion: SCHEMA_VERSION,
      messageCount: 1,
      sessionCount: 1,
      recovery: null,
    });
  });

  it("`status --json --source <missing>` returns source_absent only for source-scoped misses", async () => {
    seedStatusStore();

    const result = await runCaptured(["status", "--json", "--source", "missing-source"]);

    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      ok: false,
      status: "source_absent",
      filters: { source: "missing-source" },
      storePath: dbPath,
      schemaVersion: SCHEMA_VERSION,
      supportedSchemaVersion: SCHEMA_VERSION,
      recovery: expect.any(String),
    });
    expect(parsed.recovery).toContain("missing-source");
  });

  it("`status --json --project <missing>` treats project misses as ready zero-count status", async () => {
    seedStatusStore();

    const result = await runCaptured(["status", "--json", "--project", "/missing"]);

    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      status: "ready",
      filters: { project: "/missing" },
      storePath: dbPath,
      schemaVersion: SCHEMA_VERSION,
      supportedSchemaVersion: SCHEMA_VERSION,
      messageCount: 0,
      sessionCount: 0,
      sources: [],
      recovery: null,
    });
  });

  it("`status --json --since <recent>` flags known stale scopes as possibly_unsynced", async () => {
    seedStatusStore();

    const result = await runCaptured([
      "status",
      "--json",
      "--project",
      "/repo",
      "--since",
      "2026-06-01T00:00:00.000Z",
    ]);

    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      status: "possibly_unsynced",
      filters: { project: "/repo", since: "2026-06-01T00:00:00.000Z" },
      messageCount: 0,
      sessionCount: 0,
      sources: [
        {
          source: "claude-code",
          messageCount: 1,
          sessionCount: 1,
          latestMessageTimestamp: "2026-05-10T12:00:00.000Z",
          latestIndexedAt: "2026-05-10T12:05:00.000Z",
        },
      ],
      recovery: expect.stringContaining("sync"),
    });
  });

  it("`status --json --until <old>` treats until-only bounds as an active freshness window", async () => {
    seedStatusStore();

    const result = await runCaptured([
      "status",
      "--json",
      "--project",
      "/repo",
      "--until",
      "2026-01-01T00:00:00.000Z",
    ]);

    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      status: "possibly_unsynced",
      filters: { project: "/repo", until: "2026-01-01T00:00:00.000Z" },
      messageCount: 0,
      sessionCount: 0,
      recovery: expect.stringContaining("sync"),
    });
  });

  it("`status --json` bounds source summaries", async () => {
    const db = openStore(dbPath);
    try {
      for (let i = 0; i < 25; i += 1) {
        pushRecords(db, {
          sourceFile: {
            sourceFileId: `sf-status-source-${i}`,
            source: `status-source-${i}`,
            sessionId: `sess-status-source-${i}`,
            kind: "primary",
            agentFile: null,
            path: `/transcripts/status-source-${i}.jsonl`,
            byteOffset: 0,
            lineCount: 1,
            prefixSha256: null,
            mtime: null,
            indexedAt: `2026-05-10T00:${String(i).padStart(2, "0")}:00.000Z`,
          },
          messages: [
            {
              messageId: `m-status-source-${i}`,
              sourceFileId: `sf-status-source-${i}`,
              sessionId: `sess-status-source-${i}`,
              uuid: `u-status-source-${i}`,
              parentUuid: null,
              seq: 0,
              role: "user",
              timestamp: `2026-05-10T00:${String(i).padStart(2, "0")}:00.000Z`,
              project: "/repo",
              branch: "main",
              model: null,
              agent: null,
              skill: null,
              text: `bounded source summary fixture ${i}`,
              textTruncated: false,
            },
          ],
          toolCalls: [],
        });
      }
    } finally {
      db.close();
    }

    const result = await runCaptured(["status", "--json"]);

    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.sources).toHaveLength(20);
  });

  it("`status --json --since <recent>` does not recommend sync when newer store blocks writes", async () => {
    seedStatusStore();
    const db = new Database(dbPath);
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    const result = await runCaptured([
      "status",
      "--json",
      "--project",
      "/repo",
      "--since",
      "2026-06-01T00:00:00.000Z",
    ]);

    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      status: "possibly_unsynced",
      schemaVersion: SCHEMA_VERSION + 1,
      supportedSchemaVersion: SCHEMA_VERSION,
      recovery: expect.stringContaining("Update Lore"),
    });
    expect(JSON.parse(result.stdout).recovery).toContain("cannot run write/sync recovery");
  });

  it("`sample <dir>` prints a format summary an onboarding agent can act on", async () => {
    const lines = [
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "summary", summary: "meta" }),
    ];
    await writeFile(join(dir, "roll.jsonl"), lines.join("\n") + "\n");

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["sample", dir]);
    spy.mockRestore();

    expect(code).toBe(0);
    const out = writes.join("");
    expect(out).toContain("roll.jsonl");
    expect(out).toContain("user");
    expect(out).toContain("summary");
  });

  it("`index --source <name>` rejects an unknown source without writing", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runCli(["index", dir, "--source", "nope"]);
    spy.mockRestore();
    expect(code).toBe(1);
  });

  it("`get <id>` returns an elided snippet by default and full text with --full", async () => {
    const longText = "needle " + "filler ".repeat(400) + "tailmarker";
    const db = openStore(dbPath);
    db.prepare(
      `INSERT INTO messages (message_id, source_file_id, session_id, uuid, seq, role, timestamp, project, branch, text, text_truncated)
       VALUES ('m1', 'sf-1', 'sess-get', 'u1', 0, 'assistant', '2026-05-10T00:00:00.000Z', '/repo', 'main', ?, 0)`,
    ).run(longText);
    db.close();

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const elidedCode = await runCli(["get", "m1", "--json"]);
    const elided = JSON.parse(writes.join(""));
    writes.length = 0;
    const fullCode = await runCli(["get", "m1", "--full", "--json"]);
    const full = JSON.parse(writes.join(""));
    spy.mockRestore();

    expect(elidedCode).toBe(0);
    expect(fullCode).toBe(0);
    expect(elided.messageId).toBe("m1");
    expect(full.text).toContain("tailmarker");
    expect(elided.text.length).toBeLessThan(full.text.length);
  });

  it("`get <id>` returns a not_found envelope and non-zero for an unknown id", async () => {
    openStore(dbPath).close();
    const writes: string[] = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runCli(["get", "nope", "--json"]);
    out.mockRestore();
    err.mockRestore();
    expect(code).toBe(1);
    expect(JSON.parse(writes.join("")).error).toBe("not_found");
  });

  it("`get` returns non-zero when the store does not exist", async () => {
    process.env.LORE_DB = join(dir, "absent.db");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runCli(["get", "m1"]);
    spy.mockRestore();
    expect(code).toBe(1);
  });

  it("`context <id>` returns a bounded ordered window with the anchor flagged", async () => {
    const db = openStore(dbPath);
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO messages (message_id, source_file_id, session_id, uuid, seq, role, timestamp, project, branch, text, text_truncated)
         VALUES (?, 'sf-1', 'sess-ctx', ?, ?, 'user', '2026-05-10T00:00:00.000Z', '/repo', 'main', ?, 0)`,
      ).run(`c${i}`, `u${i}`, i, `body ${i}`);
    }
    db.close();

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["context", "c2", "--before", "1", "--after", "1", "--json"]);
    spy.mockRestore();

    expect(code).toBe(0);
    const parsed = JSON.parse(writes.join(""));
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages.map((m: { messageId: string }) => m.messageId)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    expect(parsed.messages[1].isAnchor).toBe(true);
  });

  it("`context <id>` returns a not_found envelope and non-zero for an unknown id", async () => {
    openStore(dbPath).close();
    const writes: string[] = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runCli(["context", "nope", "--json"]);
    out.mockRestore();
    err.mockRestore();
    expect(code).toBe(1);
    expect(JSON.parse(writes.join("")).error).toBe("not_found");
  });

  it("`session <id>` walks a bounded page and hands back a cursor to continue", async () => {
    const db = openStore(dbPath);
    for (let i = 0; i < 5; i++) {
      const ts = `2026-05-10T00:00:0${i}.000Z`;
      db.prepare(
        `INSERT INTO messages (message_id, source_file_id, session_id, uuid, seq, role, timestamp, project, branch, text, text_truncated)
         VALUES (?, 'sf-1', 'sess-walk', ?, ?, 'user', ?, '/repo', 'main', ?, 0)`,
      ).run(`s${i}`, `u${i}`, i, ts, `body ${i}`);
    }
    db.close();

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code1 = await runCli(["session", "sess-walk", "--limit", "2", "--json"]);
    const page1 = JSON.parse(writes.join(""));
    writes.length = 0;
    const code2 = await runCli([
      "session",
      "sess-walk",
      "--limit",
      "2",
      "--cursor",
      page1.nextCursor,
      "--json",
    ]);
    const page2 = JSON.parse(writes.join(""));
    spy.mockRestore();

    expect(code1).toBe(0);
    expect(code2).toBe(0);
    expect(page1.messages.map((m: { messageId: string }) => m.messageId)).toEqual(["s0", "s1"]);
    expect(page1.nextCursor).not.toBeNull();
    expect(page2.messages.map((m: { messageId: string }) => m.messageId)).toEqual(["s2", "s3"]);
  });

  it("`session <id> --around <msg>` returns the folded window with the anchor flagged", async () => {
    const db = openStore(dbPath);
    for (let i = 0; i < 5; i++) {
      const ts = `2026-05-10T00:00:0${i}.000Z`;
      db.prepare(
        `INSERT INTO messages (message_id, source_file_id, session_id, uuid, seq, role, timestamp, project, branch, text, text_truncated)
         VALUES (?, 'sf-1', 'sess-around', ?, ?, 'user', ?, '/repo', 'main', ?, 0)`,
      ).run(`a${i}`, `u${i}`, i, ts, `body ${i}`);
    }
    db.close();

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli([
      "session",
      "sess-around",
      "--around",
      "a2",
      "--before",
      "1",
      "--after",
      "1",
      "--json",
    ]);
    spy.mockRestore();

    expect(code).toBe(0);
    const parsed = JSON.parse(writes.join(""));
    expect(parsed.messages.map((m: { messageId: string }) => m.messageId)).toEqual([
      "a1",
      "a2",
      "a3",
    ]);
    expect(parsed.messages[1].isAnchor).toBe(true);
  });

  it("`session --around <unknown>` returns a not_found envelope and non-zero", async () => {
    const db = openStore(dbPath);
    db.prepare(
      `INSERT INTO messages (message_id, source_file_id, session_id, uuid, seq, role, timestamp, project, branch, text, text_truncated)
       VALUES ('only', 'sf-1', 'sess-x', 'u0', 0, 'user', '2026-05-10T00:00:00.000Z', '/repo', 'main', 'hi', 0)`,
    ).run();
    db.close();

    const writes: string[] = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runCli(["session", "sess-x", "--around", "nope", "--json"]);
    out.mockRestore();
    err.mockRestore();
    expect(code).toBe(1);
    expect(JSON.parse(writes.join("")).error).toBe("not_found");
  });

  it("`search --relevant` reranks so a fresh memory beats an older equal-keyword one", async () => {
    const db = openStore(dbPath);
    const recent = new Date().toISOString();
    db.prepare(
      `INSERT INTO messages (message_id, source_file_id, session_id, uuid, seq, role, timestamp, project, branch, text, text_truncated)
       VALUES ('old', 'sf-1', 'sess-rel', 'u0', 0, 'user', '2020-01-01T00:00:00.000Z', '/repo', 'main', 'alamo battle history', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO messages (message_id, source_file_id, session_id, uuid, seq, role, timestamp, project, branch, text, text_truncated)
       VALUES ('new', 'sf-1', 'sess-rel', 'u1', 1, 'user', ?, '/repo', 'main', 'alamo recent note', 0)`,
    ).run(recent);
    db.close();

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["search", "alamo", "--relevant", "--json"]);
    spy.mockRestore();

    expect(code).toBe(0);
    const parsed = JSON.parse(writes.join(""));
    expect(parsed.count).toBe(2);
    // Same envelope as plain search ({count, hits}); recency lifts "new" to the top.
    expect(parsed.hits[0].messageId).toBe("new");
  });

  it("`timeline --json` returns bucketed activity in the MCP envelope shape", async () => {
    const db = openStore(dbPath);
    db.prepare(
      `INSERT INTO messages (message_id, source_file_id, session_id, uuid, seq, role, timestamp, project, branch, text, text_truncated)
       VALUES ('t0', 'sf-1', 'sess-tl', 'u0', 0, 'user', '2026-05-10T00:00:00.000Z', '/repo', 'main', 'a', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO messages (message_id, source_file_id, session_id, uuid, seq, role, timestamp, project, branch, text, text_truncated)
       VALUES ('t1', 'sf-1', 'sess-tl', 'u1', 1, 'user', '2026-05-11T00:00:00.000Z', '/repo', 'main', 'b', 0)`,
    ).run();
    db.close();

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["timeline", "--json"]);
    spy.mockRestore();

    expect(code).toBe(0);
    const parsed = JSON.parse(writes.join(""));
    expect(parsed.buckets.map((b: { bucket: string }) => b.bucket)).toEqual([
      "2026-05-10",
      "2026-05-11",
    ]);
    expect(parsed.buckets.every((b: { count: number }) => b.count === 1)).toBe(true);
  });

  it("`push` ingests a valid stdin batch and makes it searchable without the MCP server", async () => {
    const { code, out } = await runWithStdin(["push"], JSON.stringify(VALID_PUSH_BATCH));
    expect(code).toBe(0);
    const result = JSON.parse(out);
    expect(result.messages).toBe(1);

    const db = openStore(dbPath);
    expect(searchMemory(db, "alamo")).toHaveLength(1);
    db.close();
  });

  it("`push` is idempotent — re-pushing the same batch keeps one message", async () => {
    await runWithStdin(["push"], JSON.stringify(VALID_PUSH_BATCH));
    const { code } = await runWithStdin(["push"], JSON.stringify(VALID_PUSH_BATCH));
    expect(code).toBe(0);

    const db = openStore(dbPath);
    expect(searchMemory(db, "alamo")).toHaveLength(1);
    db.close();
  });

  it("`push` reports an invalid_batch envelope and non-zero for malformed JSON", async () => {
    const { code, out } = await runWithStdin(["push"], "not json {");
    expect(code).toBe(1);
    expect(JSON.parse(out).error).toBe("invalid_batch");
  });

  it("`push` reports an invalid_batch envelope and non-zero for a schema-invalid batch", async () => {
    const { code, out } = await runWithStdin(["push"], "{}");
    expect(code).toBe(1);
    expect(JSON.parse(out).error).toBe("invalid_batch");
  });

  it("`push` reports a newer_store envelope and non-zero for a newer store", async () => {
    const db = openStore(dbPath);
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { code, out } = await runWithStdin(["push"], JSON.stringify(VALID_PUSH_BATCH));
    errSpy.mockRestore();

    expect(code).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.error).toBe("newer_store");
    expect(parsed.detail).toContain("Update Lore before running this write command");
  });

  it("`setup --home <dir>` indexes detected sources and prints the registration guide", async () => {
    const projDir = join(dir, ".claude", "projects", "proj");
    await mkdir(projDir, { recursive: true });
    const transcript =
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: "2026-05-10T00:00:00.000Z",
        sessionId: "sess-setup",
        cwd: "/repo",
        gitBranch: "main",
        message: { role: "user", content: "setup verification keyword" },
      }) + "\n";
    await writeFile(join(projDir, "sess.jsonl"), transcript);

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["setup", "--home", dir]);
    spy.mockRestore();

    expect(code).toBe(0);
    const out = writes.join("");
    expect(out).toContain("claude-code");
    expect(out).toContain("claude mcp add lore");

    const db = openStore(dbPath);
    expect(searchMemory(db, "keyword").length).toBeGreaterThan(0);
    db.close();
  });
});

// ─── Helper: seed one message row directly into a fresh store ─────────────────

function seedMessage(
  dbPath: string,
  opts: { sessionId: string; messageId: string; project: string; text: string },
): void {
  const db = openStore(dbPath);
  db.prepare(
    `INSERT INTO messages
       (message_id, source_file_id, session_id, uuid, seq, role, timestamp, project, branch, text, text_truncated)
     VALUES (?, 'sf-seed', ?, ?, 0, 'user', '2026-05-10T00:00:00.000Z', ?, 'main', ?, 0)`,
  ).run(opts.messageId, opts.sessionId, opts.messageId + "-uuid", opts.project, opts.text);
  db.close();
}

// ─── forget / exclude CLI tests ───────────────────────────────────────────────

describe("lore forget / exclude CLI", () => {
  let dir2: string;
  let dbPath2: string;
  let prevDb: string | undefined;

  beforeEach(async () => {
    dir2 = await mkdtemp(join(tmpdir(), "lore-forget-"));
    dbPath2 = join(dir2, "lore.db");
    prevDb = process.env.LORE_DB;
    process.env.LORE_DB = dbPath2;
  });

  afterEach(async () => {
    if (prevDb === undefined) delete process.env.LORE_DB;
    else process.env.LORE_DB = prevDb;
    await rm(dir2, { recursive: true, force: true });
  });

  // ─── forget --session (bare preview) ───────────────────────────────────────

  it("`lore forget --session` bare preview shows counts and leaves store unchanged", async () => {
    seedMessage(dbPath2, {
      sessionId: "sess-f1",
      messageId: "mf1",
      project: "/repo-f",
      text: "forget preview content",
    });

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["forget", "--session", "sess-f1"]);
    spy.mockRestore();

    expect(code).toBe(0);
    const out = writes.join("");
    // Preview text contains session id and counts
    expect(out).toContain("sess-f1");
    expect(out).toContain("1"); // 1 message
    // Instructs user to re-run with --confirm
    expect(out).toContain("--confirm");

    // Store is byte-for-byte unchanged: message still exists
    const db = openStore(dbPath2);
    const row = db.prepare("SELECT message_id FROM messages WHERE message_id = ?").get("mf1");
    db.close();
    expect(row).toBeTruthy();
  });

  // ─── forget --session --confirm ─────────────────────────────────────────────

  it("`lore forget --session --confirm` removes rows and writes a tombstone", async () => {
    seedMessage(dbPath2, {
      sessionId: "sess-f2",
      messageId: "mf2",
      project: "/repo-f",
      text: "forget confirmed content",
    });

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["forget", "--session", "sess-f2", "--confirm"]);
    spy.mockRestore();

    expect(code).toBe(0);
    const out = writes.join("");
    expect(out).toContain("sess-f2");

    // Message row gone
    const db = openStore(dbPath2);
    const row = db.prepare("SELECT message_id FROM messages WHERE message_id = ?").get("mf2");
    expect(row).toBeUndefined();

    // Tombstone written
    const tombstones = listTombstones(db, "session");
    expect(tombstones.some((t) => t.value === "sess-f2")).toBe(true);
    db.close();
  });

  // ─── forget --session with unknown id yields zero-count preview ─────────────

  it("`lore forget --session` with unknown id shows zero counts and exits 0", async () => {
    // Create an empty store
    openStore(dbPath2).close();

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["forget", "--session", "does-not-exist"]);
    spy.mockRestore();

    expect(code).toBe(0);
    const out = writes.join("");
    expect(out).toContain("does-not-exist");
    expect(out).toContain("0"); // zero messages
  });

  // ─── forget --project (bare preview) ────────────────────────────────────────

  it("`lore forget --project` bare preview shows counts and leaves store unchanged", async () => {
    seedMessage(dbPath2, {
      sessionId: "sess-fp1",
      messageId: "mfp1",
      project: "/proj-forget",
      text: "forget project preview",
    });

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["forget", "--project", "/proj-forget"]);
    spy.mockRestore();

    expect(code).toBe(0);
    const out = writes.join("");
    expect(out).toContain("/proj-forget");
    expect(out).toContain("sess-fp1");
    expect(out).toContain("--confirm");

    // Store unchanged
    const db = openStore(dbPath2);
    const row = db.prepare("SELECT message_id FROM messages WHERE message_id = ?").get("mfp1");
    db.close();
    expect(row).toBeTruthy();
  });

  // ─── forget --project --confirm ──────────────────────────────────────────────

  it("`lore forget --project --confirm` removes rows and writes per-session tombstones", async () => {
    seedMessage(dbPath2, {
      sessionId: "sess-fp2",
      messageId: "mfp2",
      project: "/proj-confirm",
      text: "forget project confirmed",
    });

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["forget", "--project", "/proj-confirm", "--confirm"]);
    spy.mockRestore();

    expect(code).toBe(0);

    const db = openStore(dbPath2);
    const row = db.prepare("SELECT message_id FROM messages WHERE message_id = ?").get("mfp2");
    expect(row).toBeUndefined();

    // Per-session tombstone written (NOT a project tombstone)
    const sessionTombstones = listTombstones(db, "session");
    expect(sessionTombstones.some((t) => t.value === "sess-fp2")).toBe(true);
    const projectTombstones = listTombstones(db, "project");
    expect(projectTombstones.length).toBe(0);
    db.close();
  });

  // ─── exclude --project (bare preview) ───────────────────────────────────────

  it("`lore exclude --project` bare preview shows counts and leaves store unchanged", async () => {
    seedMessage(dbPath2, {
      sessionId: "sess-ex1",
      messageId: "mex1",
      project: "/proj-excl",
      text: "exclude project preview",
    });

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["exclude", "--project", "/proj-excl"]);
    spy.mockRestore();

    expect(code).toBe(0);
    const out = writes.join("");
    expect(out).toContain("/proj-excl");
    expect(out).toContain("--confirm");

    // Store unchanged
    const db = openStore(dbPath2);
    const row = db.prepare("SELECT message_id FROM messages WHERE message_id = ?").get("mex1");
    db.close();
    expect(row).toBeTruthy();
  });

  // ─── exclude --project --confirm creates standing exclusion ─────────────────

  it("`lore exclude --project --confirm` deletes rows and creates a standing project tombstone", async () => {
    seedMessage(dbPath2, {
      sessionId: "sess-ex2",
      messageId: "mex2",
      project: "/proj-excl-confirm",
      text: "exclude confirmed",
    });

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["exclude", "--project", "/proj-excl-confirm", "--confirm"]);
    spy.mockRestore();

    expect(code).toBe(0);

    const db = openStore(dbPath2);
    const row = db.prepare("SELECT message_id FROM messages WHERE message_id = ?").get("mex2");
    expect(row).toBeUndefined();

    // Project tombstone (standing rule) written
    const projectTombstones = listTombstones(db, "project");
    expect(projectTombstones.some((t) => t.value === "/proj-excl-confirm")).toBe(true);
    db.close();
  });

  // ─── exclude --list shows standing exclusions ────────────────────────────────

  it("`lore exclude --list` shows standing exclusions after one is created", async () => {
    openStore(dbPath2).close();
    // Create a standing exclusion via --confirm
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runCli(["exclude", "--project", "/proj-list-excl", "--confirm"]);
    errSpy.mockRestore();

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["exclude", "--list"]);
    spy.mockRestore();

    expect(code).toBe(0);
    const out = writes.join("");
    expect(out).toContain("/proj-list-excl");
  });

  it("`lore exclude --list` can read a compatible store from a newer Lore version", async () => {
    openStore(dbPath2).close();
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runCli(["exclude", "--project", "/proj-list-newer", "--confirm"]);
    errSpy.mockRestore();

    const raw = new Database(dbPath2);
    raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["exclude", "--list"]);
    spy.mockRestore();

    expect(code).toBe(0);
    expect(writes.join("")).toContain("/proj-list-newer");
  });

  // ─── exclude --remove lifts a standing exclusion ─────────────────────────────

  it("`lore exclude --remove` lifts a standing exclusion", async () => {
    openStore(dbPath2).close();
    // Create exclusion first
    {
      const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await runCli(["exclude", "--project", "/proj-remove-excl", "--confirm"]);
      spy.mockRestore();
    }

    // Verify it exists
    {
      const db = openStore(dbPath2);
      const before = listTombstones(db, "project");
      db.close();
      expect(before.some((t) => t.value === "/proj-remove-excl")).toBe(true);
    }

    // Now remove it
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["exclude", "--remove", "/proj-remove-excl"]);
    spy.mockRestore();

    expect(code).toBe(0);
    const out = writes.join("");
    expect(out).toContain("/proj-remove-excl");
    expect(out).toContain("lifted");

    // Tombstone gone
    const db = openStore(dbPath2);
    const after = listTombstones(db, "project");
    db.close();
    expect(after.some((t) => t.value === "/proj-remove-excl")).toBe(false);
  });

  // ─── exclude --list shows "No standing exclusions" when empty ────────────────

  it("`lore exclude --list` prints empty message when no exclusions exist", async () => {
    openStore(dbPath2).close();

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["exclude", "--list"]);
    spy.mockRestore();

    expect(code).toBe(0);
    expect(writes.join("")).toContain("No standing exclusions");
  });

  // ─── missing store returns error ─────────────────────────────────────────────

  it("`lore forget` returns non-zero when the store does not exist", async () => {
    process.env.LORE_DB = join(dir2, "absent.db");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runCli(["forget", "--session", "any"]);
    spy.mockRestore();
    expect(code).toBe(1);
  });

  it("`lore exclude` returns non-zero when the store does not exist", async () => {
    process.env.LORE_DB = join(dir2, "absent.db");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runCli(["exclude", "--project", "/any"]);
    spy.mockRestore();
    expect(code).toBe(1);
  });

  // ─── missing required argument returns non-zero ──────────────────────────────

  it("`lore forget` with no subcommand returns non-zero", async () => {
    openStore(dbPath2).close();
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runCli(["forget"]);
    spy.mockRestore();
    expect(code).toBe(1);
  });

  it("`lore exclude` with no subcommand returns non-zero", async () => {
    openStore(dbPath2).close();
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runCli(["exclude"]);
    spy.mockRestore();
    expect(code).toBe(1);
  });
});

it("messages CLI lists full authored text and provenance without keyword search", async () => {
  const db = openStore(dbPath);
  pushRecords(db, VALID_PUSH_BATCH);
  db.close();
  const result = await runCaptured([
    "messages",
    "--role",
    "user",
    "--since",
    "2026-01-01T00:00:00Z",
    "--limit",
    "1",
    "--json",
  ]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    messages: [
      {
        messageId: "mp1",
        source: "claude-code",
        sourcePath: "/transcripts/push.jsonl",
        lastTimestamp: "2026-05-10T00:00:00.000Z",
        text: "pushed alamo content",
        authorKind: null,
        entrypoint: null,
      },
    ],
    nextCursor: null,
  });
});
