// Confirmed seam: bounded company reindex, capture-words R-02 L2.
import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../store/open-store.js";
import { indexFile, reindexRecentCompanyFiles } from "./index-file.js";
import { getMessage } from "../retrieval/get-message.js";
import { upsertMessage } from "../store/upsert.js";
import { computeMessageId } from "../records.js";
it("reindexes only recent company transcript files and preserves old and personal rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lore-company-reindex-")),
    db = openStore(":memory:");
  try {
    const files: [string, string][] = [
      ["recent", "/company"],
      ["old", "/company"],
      ["personal", "/personal"],
    ];
    for (const [name, cwd] of files) {
      const path = join(dir, name + ".jsonl");
      await writeFile(
        path,
        JSON.stringify({
          type: "user",
          uuid: name,
          cwd,
          origin: { kind: "human" },
          timestamp: "2026-11-07T00:00:00Z",
          message: { content: "synthetic" },
        }) + "\n",
      );
      await indexFile(db, { path });
      const message = getMessage(db, computeMessageId(path, name, 0), { full: true })!;
      upsertMessage(db, { ...message, role: "user", skill: null, authorKind: null });
      if (name === "old") await utimes(path, new Date(0), new Date(0));
    }
    const result = await reindexRecentCompanyFiles(db, {
      since: "2026-01-01T00:00:00Z",
      roots: ["/company"],
    });
    expect(result.reindexed).toEqual([join(dir, "recent.jsonl")]);
    expect(
      getMessage(db, computeMessageId(join(dir, "recent.jsonl"), "recent", 0))?.authorKind,
    ).toBe("human");
    expect(
      getMessage(db, computeMessageId(join(dir, "old.jsonl"), "old", 0))?.authorKind,
    ).toBeNull();
    expect(
      getMessage(db, computeMessageId(join(dir, "personal.jsonl"), "personal", 0))?.authorKind,
    ).toBeNull();
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
