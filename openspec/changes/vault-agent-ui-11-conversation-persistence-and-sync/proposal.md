## Why

The operator asked that persisting conversations, and perhaps syncing them across devices over IPFS, be considered as a first-class concern (2026-10-04). `chat-00` decision 3 already says conversations persist as entities through the entity graph's PGlite persistence. Nothing is built, and the security ruling that gates it (D15) is open. The options, evidence and recommendation are decision group S in `vault-agent-ui-00-phase-overview/decisions-needed.md`. This slice builds A (local persistence) and, only on an operator yes, B (opt-in file-based sync through the existing encrypted vault sync). C (an op-log or CRDT) is rejected until a measured need.

The uncomfortable parts:
- **IPFS is immutable.** A synced conversation cannot be erased from older roots or from anyone who pinned them. `prune-history` trims the node's own history files and does not recall copied blocks (`README.md`, "History growth"). The UI says so before sync is enabled.
- **Pull applies no remote deletions** (`README.md`, conflict policy). Deleting a conversation file on one device leaves it on the others, and a device that still holds it can republish it. Deletion needs a tombstone (S4).
- **Chat makes publishes non-empty.** Using the README's figures (96 history files a day at a 15-minute timer on a vault that changes every tick; 4 to 14 MB each), worst case is 384 MB to 1.3 GB of pinned history a day. My arithmetic, not a measurement. The warning is at 1,500 files and the refusal at 1,999.
- **Synced conversations hold note excerpts and model answers.** They get the vault's encryption and are readable on every device that has the vault. Remote providers may have logged the same text.
- **The sync core was reviewed as it stands.** New file types in the publish tree touch code the 07b chain froze. B adds no sync code, but its effect on conflict copies, history growth and fork resolution is behaviour of that code under a new load, and nobody has measured it.
- **Local persistence has an eviction risk.** The entity store is IndexedDB; WebKit may evict it (pglite assessment s.1.2). The cache rule of spec 006 does not cover authored conversations.
- **Whether a dot-folder publishes and stays out of Obsidian's search and graph is unverified.**

## What Changes

- Section 1: tests of the sync core with conversation files (publish, pull, conflict, no remote delete, history growth) before any code depends on it.
- Section 2 (A): entities and local persistence, retention, delete, clear all, eviction notice, Data copy.
- Section 3 (B, opt-in): file writer, per-device files, tombstones, exclusions, size and history guards, the disclosure dialog, settings.
- Section 4: proof.

## Capabilities

### New Capabilities
- `conversation-persistence`: entities, retention, deletion, eviction, what is never stored.
- `conversation-sync`: opt-in file-based sync, per-device files, tombstones, exclusions, guards, disclosure.

### Modified Capabilities
<!-- none -->

## Impact

- Code: `src/data/conversations/` (entities, store, persistence), `src/agents/conversation-files/` (service: encode, decode, write batching; no React, zustand, store), `src/plugin/conversation-sync.ts` (host wiring), `src/sync/exclusions.ts` only if the operator wants a default-exclusion entry for local-only mode (ipfs-engineer; review reopened by any edit under `src/sync`), settings and dialogs (uiux-lead), `features/`, `tests/`.
- Dependencies: PGlite and entity management pins owned by mvp-08 and the operator (`tasks.md` 0.5); none new.
- Data: PGlite entity tables (own files, `idb://`); for B, files under a dedicated folder.
- Cadence: reviewers dormant until the phase gate; the security ruling comes first.

Blocked on: D15 ruling (security-reviewer); operator answers S1 to S8; mvp-08 decision on one or two PGlite databases (`chat-03` 1.2 depends on it); slice 05 (a conversation to persist); for B an operator yes, the task 1.1 results, and the history-count guard.
