import { describe, it, expect } from "vitest";
import { openStore } from "../store/open-store.js";
import { upsertMessage } from "../store/upsert.js";
import { getMessage } from "./get-message.js";
import type { MessageRecord } from "../records.js";

function msg(
  over: Partial<MessageRecord> & Pick<MessageRecord, "messageId" | "text">,
): MessageRecord {
  return {
    sourceFileId: "sf-1",
    sessionId: "sess-1",
    uuid: over.messageId,
    parentUuid: null,
    seq: 0,
    role: "assistant",
    timestamp: "2026-05-10T00:00:00.000Z",
    project: "/repo",
    branch: "main",
    model: "claude-opus-4-8",
    agent: null,
    skill: null,
    textTruncated: false,
    ...over,
  };
}

describe("getMessage", () => {
  it("returns null for an unknown id", () => {
    const db = openStore(":memory:");
    expect(getMessage(db, "nope")).toBeNull();
  });

  it("returns a budget-elided snippet by default and full text with full=true", () => {
    const db = openStore(":memory:");
    const big = "a".repeat(10_000);
    upsertMessage(db, msg({ messageId: "m1", text: big }));

    const snippet = getMessage(db, "m1");
    expect(snippet?.text.length).toBeLessThan(big.length);
    expect(snippet?.text).toContain("chars elided");

    const full = getMessage(db, "m1", { full: true });
    expect(full?.text).toBe(big);
  });

  it("returns full provenance fields", () => {
    const db = openStore(":memory:");
    upsertMessage(db, msg({ messageId: "m1", text: "short", parentUuid: "p1" }));
    const detail = getMessage(db, "m1");
    expect(detail?.sessionId).toBe("sess-1");
    expect(detail?.parentUuid).toBe("p1");
    expect(detail?.model).toBe("claude-opus-4-8");
    expect(detail?.role).toBe("assistant");
  });
});

// Confirmed seams: persisted message retrieval and legacy admission, SPEC R-02 L2.
it("round trips authorship and entrypoint while older admissions remain unattributed", () => {
  const db = openStore(":memory:");
  upsertMessage(db, msg({ messageId: "legacy", text: "old" }));
  upsertMessage(
    db,
    msg({ messageId: "human", text: "new", authorKind: "human", entrypoint: "claude-desktop" }),
  );
  expect(getMessage(db, "legacy")).toMatchObject({ authorKind: null, entrypoint: null });
  expect(getMessage(db, "human")).toMatchObject({
    authorKind: "human",
    entrypoint: "claude-desktop",
  });
  upsertMessage(
    db,
    msg({
      messageId: "human",
      text: "reindexed",
      authorKind: "unattributed",
      entrypoint: "t3-code",
    }),
  );
  expect(getMessage(db, "human")).toMatchObject({
    authorKind: "unattributed",
    entrypoint: "t3-code",
  });
  db.close();
});
