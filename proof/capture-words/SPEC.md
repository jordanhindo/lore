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
