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
