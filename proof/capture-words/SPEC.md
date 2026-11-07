# Capture words — Lore dependency

Source: authorized capture-words SPEC R-02, supplied in this task.

Outcome: preserve queued Claude commands, attach conservative authorKind and
entrypoint provenance, and expose a bounded chronological full-text listing.

Confirmed seams: adapter parse/ingest, store migration and retrieval, CLI JSON.
Build order: L1 queued commands; L2 authorship persistence; L3 messages listing.
Proof: each slice records RED then GREEN, followed by npm run check in full.
Only synthetic transcript text may be committed. No live-store reindex until
its company roots and capture floor are explicitly configured.

This branch implements L1 and Claude parser metadata from L2. Persistence, Codex,
L3 and company integration remain.

## Builder repair: late-indexed messages

A source-time-only checkpoint loses a message indexed after capture has passed
its original timestamp. The existing sync agents are asynchronous, so this is a
real boundary of R-01's no-loss outcome. Add an optional ingestion cursor to the
Lore listing while retaining its default chronological contract and original
message timestamps. A current-entry change sequence plus store epoch identifies
newly indexed or reindexed messages; snapshot-bounded pages must not skip a late
arrival. Compass uses this cursor with the fixed capture floor and retains the
source-time watermark for display/T3 activity selection. This is a builder
technical default, not a founder ruling.

Proof seams: listMessages/CLI delta pages, late older-message insertion,
reindex of an existing message, snapshot paging, and capture checkpoint replay.
