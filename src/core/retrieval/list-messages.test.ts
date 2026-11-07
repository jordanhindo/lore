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
