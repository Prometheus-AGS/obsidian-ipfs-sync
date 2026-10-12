## Why

After mvp-07b a device can publish and pull an encrypted vault, but nothing on the device remembers what happened: no record of which root CID was published when, how many files a pull fetched, or whether a conflict occurred. Operators debugging a sync surprise have only their terminal scrollback. mvp-03 already emits `publish.complete`, `pull.complete` and `conflict` events on the shared EventBus; this change persists them. It also lands the StoreAdapter port layer the phase plan reserves for PGlite (`@electric-sql/pglite` 0.5.8), scoped to metadata and sync-state only, so the later AI-layer stores (docs/005, docs/006) build on an interface that already exists instead of inventing their own.

The uncomfortable part: this change introduces the first persistent database the project owns, and a database is exactly where plaintext vault paths would love to accumulate — the `conflict` event carries them in memory. Since mvp-06/07a/07b, nothing readable may leave the device *or be written to a store that a future feature might sync*, so the no-plaintext-paths rule here is unconditional and structural (record types have no path fields), not a convention. Also, the planning inputs for this change (README.md, 2026-10-02) force a correction to three documents that still assume embeddings ride the vault snapshot; leaving that assumption in place would let the AI layer design itself around a 150 MB-per-vault payload nobody budgeted.

## What Changes

- New `src/core/store/` module: StoreAdapter port interfaces (metadata, sync-state, vector — vector **declared only**: pgvector is absent from pglite 0.5.8, a plan-time verification fact) plus a WebView-safe in-memory implementation. No `src/plugin` edits; the plugin is not wired to a store in MVP.
- New `cli/store/` PGlite (nodefs) adapter implementing the ports against a device-local, per-user on-disk database. It subscribes to the EventBus in the CLI's publish and pull commands and persists publish/pull/conflict records and the last-manifest pointer.
- Records carry root CIDs, counts, hashes and timings only. They **never** store plaintext vault paths — encryption has already landed, so this rule is unconditional. The in-memory `conflict` event's `path`/`conflictPath` are dropped at the persistence boundary; the stored conflict row keeps the sha256 pair and the timestamp.
- New command `ipfs-sync history [--limit n]`: prints recorded operations newest-first from the on-disk database. Local and read-only — it sends no node requests.
- **Distinction:** `prune-history` (shipped in mvp-07b) prunes the *node-side* manifest history under `<mfsRoot>/manifests/`; it mutates the shared node and needs the passphrase. The new `history` command reads the *device-local* operation log and touches nothing. The names are close; the help text and the docs say which is which.
- Recorded design decision (before any adapter task): embeddings are **excluded from the vault snapshot by default**; any embedding store is device-local, optional and rebuildable per device. Recorded with rationale in design.md (the Smart Connections assessment advises against syncing the embedding store; illustrative size ≈ 150 MB per vault).
- Documentation revision (documentation-specialist): docs/005, docs/006 and DESIGN.md §7 stop assuming embeddings ride the vault snapshot, state the recorded decision, and add the embedding size budget (bytes per vault / per publish).
- New dependency: `@electric-sql/pglite` pinned at exactly 0.5.8 (this change holds the package.json write; no other change is in flight).

## Capabilities

### New Capabilities
- `sync-history-store`: the StoreAdapter ports, the WebView-safe in-memory implementation, the PGlite CLI adapter, the record schema, the no-plaintext-paths rule and the last-manifest pointer.
- `sync-history-events`: EventBus wiring in the CLI that turns `publish.complete`, `pull.complete` and `conflict` events into persisted records, and the rule that a recorder failure never fails the sync operation.
- `history-command`: `ipfs-sync history [--limit n]`, its output shape, exit codes and read-only-local guarantee.

### Modified Capabilities
<!-- none: no capability specs exist in openspec/specs/ yet; all three deltas are ADDED -->

## Impact

- Code: new `src/core/store/` (interfaces + in-memory impl), new `cli/store/` (PGlite adapter, EventBus recorder), new `cli/history-command.ts`, additive edits to `cli/args.ts`, `cli/run.ts`, `cli/help-text.ts`, `cli/publish-command.ts`, `cli/pull-encrypted-command.ts` (recorder subscription only), new `tools/feature-op-mvp-08.mjs`, new tests. No `src/plugin/` edits.
- Dependencies: `@electric-sql/pglite` 0.5.8 exact (dependencies, single writer this change).
- Docs: `docs/005-uar-lite-local-agents.md`, `docs/006-embedded-stores.md`, `DESIGN.md` §7 (documentation-specialist).
- Node: none. The recorder listens to local events; `history` sends no requests.
- Data: a device-local PGlite database in the per-user state directory (same directory rule as the CLI device store). It is never synced, never published and excluded like all device state.
