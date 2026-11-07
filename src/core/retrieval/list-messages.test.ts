// Confirmed seam: chronological retrieval, SPEC R-02 L3.
import { it, expect } from "vitest";
import { openStore } from "../store/open-store.js";
import { upsertMessage } from "../store/upsert.js";
import { listMessages } from "./list-messages.js";
it("pages full messages including unattributed and agent rows without dropping ties", () => {
  const db = openStore(":memory:");
  for (let n = 0; n < 101; n++)
    upsertMessage(db, {
      messageId: String(n).padStart(3, "0"),
      sourceFileId: "sf",
      sessionId: "s",
      uuid: String(n),
      parentUuid: null,
      seq: n,
      role: "user",
      timestamp: "2026-11-01T00:00:00Z",
      project: "/repo",
      branch: null,
      model: null,
      agent: null,
      skill: null,
      text: " x ".repeat(3000),
      textTruncated: false,
      authorKind: n === 0 ? "unattributed" : "agent",
      entrypoint: "t3-code",
    });
  const first = listMessages(db, { role: "user", since: "2026-11-01T00:00:00Z", limit: 100 });
  expect(first.messages).toHaveLength(100);
  expect(first.messages[0]).toMatchObject({
    authorKind: "unattributed",
    entrypoint: "t3-code",
    text: " x ".repeat(3000),
  });
  expect(first.nextCursor).toEqual({ timestamp: "2026-11-01T00:00:00Z", messageId: "099" });
  const last = listMessages(db, {
    role: "user",
    since: first.nextCursor!.timestamp,
    afterId: first.nextCursor!.messageId,
    limit: 100,
  });
  expect(last.messages.map((row) => row.messageId)).toEqual(["100"]);
  expect(last.nextCursor).toBeNull();
  db.close();
});

it("reports malformed timestamps instead of silently dropping those rows", () => {
  const db = openStore(":memory:");
  upsertMessage(db, {
    messageId: "malformed",
    sourceFileId: "sf",
    sessionId: "s",
    uuid: "u",
    parentUuid: null,
    seq: 0,
    role: "user",
    timestamp: null,
    project: "/company",
    branch: null,
    model: null,
    agent: null,
    skill: null,
    text: "synthetic",
    textTruncated: false,
  });
  const page = listMessages(db, { role: "user", since: "2026-11-01T00:00:00Z" });
  expect(page).toMatchObject({
    messages: [],
    gaps: [{ reason: "malformed-lore-row", id: "malformed", project: "/company" }],
    malformedCount: 1,
  });
  db.close();
});

it("an ingestion cursor retrieves a late older message and metadata reindex without changing source time", () => {
  const db = openStore(":memory:");
  const message = {
    messageId: "newer",
    sourceFileId: "sf",
    sessionId: "s",
    uuid: "u",
    parentUuid: null,
    seq: 0,
    role: "user" as const,
    timestamp: "2026-11-07T02:00:00Z",
    project: "/company",
    branch: null,
    model: null,
    agent: null,
    skill: null,
    text: "newer words",
    textTruncated: false,
  };
  upsertMessage(db, message);
  const first = listMessages(db, { role: "user", since: "2026-11-01T00:00:00Z", afterIndex: 0 });
  upsertMessage(db, {
    ...message,
    messageId: "late",
    uuid: "late",
    timestamp: "2026-11-07T01:00:00Z",
    text: "older words indexed later",
  });
  const second = listMessages(db, {
    role: "user",
    since: "2026-11-01T00:00:00Z",
    afterIndex: first.snapshotIndex,
  });
  expect(second.messages.map((row) => [row.messageId, row.timestamp])).toEqual([
    ["late", "2026-11-07T01:00:00Z"],
  ]);
  upsertMessage(db, { ...message, authorKind: "human" });
  const third = listMessages(db, {
    role: "user",
    since: "2026-11-01T00:00:00Z",
    afterIndex: second.snapshotIndex,
  });
  expect(third.messages).toHaveLength(1);
  expect(third.messages[0]).toMatchObject({ messageId: "newer", authorKind: "human" });
  expect(third.epoch).toBe(first.epoch);
  db.close();
});

it("pins ingestion pages to one snapshot and exposes intervening writes on the next run", () => {
  const db = openStore(":memory:");
  const base = {
    sourceFileId: "sf",
    sessionId: "s",
    parentUuid: null,
    seq: 0,
    role: "user" as const,
    timestamp: "2026-11-07T01:00:00Z",
    project: "/company",
    branch: null,
    model: null,
    agent: null,
    skill: null,
    text: "words",
    textTruncated: false,
  };
  for (const id of ["a", "b"]) upsertMessage(db, { ...base, messageId: id, uuid: id });
  const first = listMessages(db, {
    role: "user",
    since: "2026-11-01T00:00:00Z",
    afterIndex: 0,
    limit: 1,
  });
  upsertMessage(db, { ...base, messageId: "c", uuid: "c", timestamp: "2026-11-02T00:00:00Z" });
  const second = listMessages(db, {
    role: "user",
    since: "2026-11-01T00:00:00Z",
    afterIndex: first.nextCursor!.index,
    throughIndex: first.snapshotIndex,
    limit: 1,
  });
  expect(second.messages.map((row) => row.messageId)).toEqual(["b"]);
  expect(second.nextCursor).toBeNull();
  const next = listMessages(db, {
    role: "user",
    since: "2026-11-01T00:00:00Z",
    afterIndex: second.snapshotIndex,
  });
  expect(next.messages.map((row) => row.messageId)).toEqual(["c"]);
  db.close();
});

it("exports the native Codex session id while retaining Lore's historical session key", async () => {
  const { parseCodexLine, getCodexFileMetadata } =
    await import("../../adapters/codex/parse-line.js");
  const db = openStore(":memory:");
  const fileMetadata = getCodexFileMetadata([
    JSON.stringify({
      type: "session_meta",
      payload: { id: "native-session", originator: "Codex Desktop", source: "cli" },
    }),
  ]);
  const parsed = parseCodexLine(
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-11-07T01:00:00Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "synthetic" }],
      },
    }),
    {
      sourceFileId: "file",
      sessionId: "rollout-historical-key",
      source: "codex",
      seq: 3,
      fileMetadata,
    },
  );
  if (parsed.kind !== "parsed") throw new Error(parsed.reason);
  upsertMessage(db, parsed.parsed.message);
  const page = listMessages(db, { role: "user", since: "2026-11-01T00:00:00Z" });
  expect(page.messages[0]).toMatchObject({
    sessionId: "native-session",
    loreSessionId: "rollout-historical-key",
    uuid: "codex-line-4",
  });
  db.close();
});
