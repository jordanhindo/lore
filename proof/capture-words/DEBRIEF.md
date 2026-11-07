# Capture words — Lore builder handoff

PR: https://github.com/jordanhindo/lore/pull/24

Implemented R-02: queued-command indexing (including nested attachment prompt/origin), authorKind and entrypoint persistence, full-text chronological messages listing, bounded company reindex, and freshness diagnostics. Native Codex message/session identities are exposed without changing historical Lore keys. An ingestion cursor makes late arrivals and metadata reindex visible after a timestamp checkpoint; schema migration preserves existing rows and read-only retrieval compatibility.

Verification on code head 8605dc41f56759b33b047f8cbd8618ed00ef2ed9: typecheck, 197 affected tests in 15 files, and build passed on 2026-11-07. The earlier full suite passed 434 tests; it is not claimed as a final-head full run. The operator reserves the full matrix for merge. Real bounded reindex recovered the previously absent queued message in an isolated Lore database.

Original /Users/jordanhindo/lore checkout remains untouched on main. No merge or live reindex was performed. This worktree initially reused node_modules via a symlink; no install was run through that link. A later install must replace the link with worktree-owned dependencies first.

Company integration and its real Jev classification proof are tracked in company PR 247. Lore supplies source data; passing parser/retrieval tests does not establish Jev classification accuracy.

## Lessons and proposed skill changes

TDD: add a reminder that native identity and retrieval identity can differ. Compatibility tests must preserve existing lookup keys while checking the newly exposed native identity against the source adapter.

Real transcript fixtures should retain structural variants (nested attachment origin/prompt, blank lines, session metadata), with synthetic text. Bounded reindex must stream large files rather than read an entire transcript into one string.

No independent review was delegated, per the task restriction. PR remains unmerged.
