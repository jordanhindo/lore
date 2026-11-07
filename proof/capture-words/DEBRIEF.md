# Capture words progress

Implemented test-first: Claude queued-command attachments retain their UUID and
exact text; Claude parser emits authorKind and entrypoint, with conservative
harness, agent and unattributed cases. Two RED/GREEN cycles are saved locally.
Full npm run check passed: 48 files, 424 tests, typecheck, lint and formatting.

Incomplete: persistence/migration of fields, Codex authorship, chronological
messages listing, bounded reindex, and all company integration/proof. Optional
record fields currently exist only at the Claude parser boundary. This is not
R-02 completion and must not merge as the capture-words implementation.

Review: read actual source diff locally against base 7d10369. No independent
review was run because this task expressly forbids delegation. Standards:
synthetic fixtures only; existing adapter seam reused. Spec: the omissions above
remain blocking findings for feature completion.

Next: test persistence through upsertMessage/getMessage including legacy rows;
add schema migration and field bindings. Then Codex provenance and L3 listing.
Lore original checkout remains on main; company checkout has no edits.

Skill change: none proposed.

## Follow-up

Persistence is now implemented through schema migration 6, upsert and getMessage,
including legacy null fields; targeted retrieval/migration tests and typecheck
passed (commit 22893a7). Codex session authorship and injected-only exclusion now
pass 15 adapter tests and typecheck (commit 19e3a32). Listing remains pending.

Confirmed spec conflict in company R-05: packetFromCodexRecord trims text, but
Lore retains it exactly. A synthetic public captureNative reproduction with the
same native id and text `  keep these words  ` first buffered the existing
adapter packet (`keep these words`), then attempted the Lore-byte packet. Intake
raised operation-conflict. sameNativeAsk requires prior.text === next.text.
Thus exact Lore bytes and replay of every prior admission cannot both hold with
PR 215 admission unchanged. Resolution needs a policy for retaining both the
prior immutable admission and the newly observed exact bytes; silently trimming
Lore would violate the exact-byte requirement. No live record or secrets read.
