## Context

mvp-03 added a typed EventBus (`src/core/events/event-bus.ts`) whose `SyncEventMap` (`src/core/events/event-types.ts`) today carries `file.changed`, `publish.complete`, `pull.complete` and `conflict`. The CLI's publish and pull commands each construct their own bus (`cli/publish-command.ts:156`, `cli/pull-encrypted-command.ts:183`) and pass it into the sync engine; a failing listener never stops the others (the bus reports listener failures on its own channel). Event payloads are paths, hashes, CIDs and counts — in particular `ConflictEvent` carries the plaintext `path` and `conflictPath`, and `PullCompleteEvent` carries optional mvp-07a fields (`sequence`, `complete`, `integrityFailed`, `unfetched`, `policySkipped`, `restored`).

Encryption (mvp-06/07a/07b) has landed: nothing readable may leave the device. The phase plan therefore makes the no-plaintext-paths rule for persisted history **unconditional** — it is not gated on "once encryption lands". The existing CLI history story is `prune-history` (mvp-07b), which prunes node-side manifest history; this change adds the distinct device-local operation log and its `history` command. `src/core` is softly frozen: additions under `src/core/store/` are new modules and break no existing contract. Constraints that bind this change: `webview-safe-bundle` (no Node built-ins under `src/`), `no-console-log-in-commits` (covers `cli/` — CLI output goes through `CliIo` / `process.stdout.write`), `no-any-type`, `no-python`. Package.json has one writer at a time; this change holds it (`@electric-sql/pglite` joins `@noble/hashes` 2.4.0 as the second runtime dependency).

## Goals / Non-Goals

**Goals:**
- Persist publish/pull/conflict records and the last-manifest pointer across CLI restarts, in a device-local PGlite (nodefs) database.
- StoreAdapter ports (metadata, sync-state, vector declared-only) with a WebView-safe in-memory implementation in `src/core/store/`, so later stores (plugin, AI layer) code against the ports.
- `ipfs-sync history [--limit n]` answers "what did this device sync, when" in under a second, from the on-disk DB, with zero node requests.
- No plaintext vault path is ever persisted. This is structural: the persisted record types have no path fields.

**Non-Goals:**
- No `src/plugin/` edits; the plugin is not wired to a store in MVP.
- No vector/pgvector implementation (absent from pglite 0.5.8); the vector port is a declared interface only.
- No embedding store, no embeddings anywhere (the AI-layer decision below is recorded, its stores are not built).
- No syncing, publishing or backing up of the history database. No UI.
- The phone-embeddings acceptance gate (README.md "Phone embeddings" note) is context for mvp-10 / the AI layer, not a task of this change.

## Recorded decision: embeddings do not ride the vault snapshot

**Decision (recorded 2026-10-05, required by this change's README.md before any adapter task):** embeddings are **excluded from the vault snapshot by default**. Any embedding store is device-local, optional and rebuildable per device. Nothing in the published vault layout carries embedding data.

**Rationale:** the Smart Connections assessment (`.kbd-orchestrator/phases/mvp/children/mobile-feasibility/assessment-smart-connections.md`) records its author's advice against syncing the embedding store. The size budget makes the advice concrete: vector rows are dims × 4 bytes, so an illustrative 10k notes × 10 blocks × 384 dims ≈ 150 MB per vault (inference from the report, not measurement) would ride every snapshot and every fresh-device pull, for data that is content-keyed and therefore cheaply rebuildable on any device that has the files. Rebuildable caches do not belong in the sync payload. Consequence owned by this change: docs/005, docs/006 and DESIGN.md §7 currently assume the opposite (embeddings pinned under the vault root, hydrating on pull); the documentation-specialist revises them as a plan item of this change (task 5.1), including the size budget in bytes per vault and per publish.

## Decisions

1. **Layout.** New `src/core/store/`: `types.ts` (record and pointer types), `ports.ts` (the three StoreAdapter interfaces), `memory.ts` (in-memory implementation of metadata + sync-state), `index.ts` (exports). New `cli/store/`: `pglite-store.ts` (PGlite nodefs adapter), `schema.ts` (DDL), `recorder.ts` (EventBus subscription), `location.ts` (database path rule). New `cli/history-command.ts`. Pure mapping (event payload → record) lives in `src/core/store/` so it is testable without a database and reusable by a future plugin adapter; the PGlite adapter only executes SQL.
2. **Ports.** `MetadataStoreAdapter` (append operation record, list newest-first with limit), `SyncStateStoreAdapter` (get/set the last-manifest pointer), `VectorStoreAdapter` (declared only: interface exported, no implementation, JSDoc states pgvector is absent from pglite 0.5.8 and an implementation waits for a version that carries it or a different engine). The CLI uses the first two; nothing constructs the third.
3. **Record shape (the no-plaintext rule, structural).** A history record carries: operation kind (`publish` | `pull` | `conflict`), timestamp, root CID, manifest CID, counts (per kind: written/removed for publish; fetched/unchanged/conflicted/failed/remoteDeleted/locallyModified for pull), duration ms, and for conflict rows the local/remote sha256 pair and the parent operation's root CID. **No field can hold a vault path** — there is no `path`, no vault directory, no file name anywhere in the schema. The pull record also carries the optional mvp-07a counters when present (`sequence`, `integrityFailed`, `unfetched`, `policySkipped`, `restored`, `complete`). The mapping function drops `ConflictEvent.path` / `conflictPath` by construction (it reads only the sha256 fields); a unit test serializes a mapped conflict record and greps it for the source paths.
4. **Database location.** One PGlite database per user in the per-user state directory, under `history/` (nodefs flavour), resolved by the same directory rule as the CLI device store (`cli/device-store-node.ts`; XDG honoured on every platform, per the decision-log rule). It is device-local: never synced (not a vault file), never published, and `history` needs no configuration, no node and no passphrase. Alternative considered (a database per vault under `<vault>/.ipfs-sync/`) rejected: `.ipfs-sync/` is inside the vault and must stay small and exclusion-clean, and a per-user store matches the device-store precedent.
5. **Recorder wiring.** Each CLI command that creates a bus (`publish`, `pull`) passes it to `attachHistoryRecorder(bus, store)` from `cli/store/recorder.ts` before running the engine. The recorder subscribes to `publish.complete`, `pull.complete` and `conflict`. Writes are awaited best-effort: a recorder error is reported on stderr (`io.err`) and never changes the command's exit code — the bus already isolates listener failures, and history must never be the reason a sync failed. `publish.complete` also sets the last-manifest pointer. Conflict rows reference the operation they belong to by root CID; ordering within one operation is insertion order.
6. **The `history` command.** `ipfs-sync history [--limit n]` (default limit 20, `--limit 0` means all). Prints one line per record, newest first: ISO timestamp, kind, root CID (shortened display form is a presentation detail; the stored value is the full CID), counts and duration. Output goes through `CliIo` (`process.stdout.write`), never `console.log`. Empty database: one line "no sync operations recorded on this device" and exit 0. Exit codes: 0 listed (including empty), 2 usage (bad `--limit`). It opens the database read-only and sends no node requests; `--show-request` produces no trace for it.
7. **Dependency.** `@electric-sql/pglite` pinned at exactly `0.5.8` in `dependencies` (per the dependency-pin rule: exact version, rationale recorded here: plan cand-003; metadata + sync-state only; 0.5.8 is the plan-verified version and pgvector is absent from it, which is why the vector port is declared-only). The lockfile update rides the same task (single writer). The PGlite import lives only in `cli/store/` — `src/core/store/` imports nothing from it, so `webview-safe-bundle` and `pnpm probe:webview` stay green.
8. **Testing.** Unit tests for the mapping and the in-memory implementation (no database). Adapter tests for the PGlite store against a temporary nodefs directory: append/list/limit ordering, pointer round-trip, restart persistence (close, reopen, rows survive). Recorder tests with a fake bus: a publish event produces a publish row and moves the pointer; a conflict event produces a row whose serialization contains neither `path` value; a throwing store leaves the command's exit path untouched. The feature operation (below) is the integration proof.

## Risks / Trade-offs

- [The in-memory `conflict` event carries plaintext paths] -> mitigated structurally (decision 3): the mapping never reads them, the schema has no column for them, and a test greps the serialized record for the source paths. The event type itself is unchanged (in-memory, pre-existing contract).
- [First persistent DB in the project: schema churn] -> the DDL carries a `schema_version` row and the adapter refuses an unknown version fail-closed; migration machinery is not built in MVP (one version only).
- [PGlite adds ~3 MB gz to the CLI install] -> accepted by the phase plan (cand-003); it is not in the plugin bundle (import confined to `cli/`).
- [Recorder writes on the hot path of publish/pull] -> writes are tiny (one row per operation, one per conflict) and best-effort; a slow disk delays a stderr line, not the sync.
- [A device-local log is itself metadata an attacker on the host can read] -> accepted and stated: CIDs, counts and timings are not note content; the threat model already assumes host-local state (device store, sequence floor) is readable by the device's user.
- [Vector port declared but unimplemented may rot] -> JSDoc on the interface states why (pgvector absent in 0.5.8) and what re-checks the pin before implementing.

## Migration Plan

Nothing exists to migrate: no prior history store, no prior `history` command (the similar-sounding `prune-history` is untouched and keeps its meaning). Rollback: `git revert` removes the modules, the command, the dependency and the recorder subscriptions; any on-disk database left in the per-user state directory is inert and can be deleted by hand.

## Feature Operation

One command: `node tools/feature-op-mvp-08.mjs`, structured like `tools/feature-op-mvp-07a.mjs` (loopback allow-list proxy, per-run demo root under `/obsidian-vault-sync/mvp08-demo/<runid>`, owned key, env allowlist, fixture vaults, refuses win32). In one process it:

1. Creates a fixture vault A with its own per-user state directory (`XDG_STATE_HOME`), inits and publishes it (encrypted; the publish emits `publish.complete`).
2. Creates an empty fixture vault B with its own state directory and pulls A's publish into it (emits `pull.complete`).
3. **Restarts the CLI** (a fresh child process against the same state directories) and runs `ipfs-sync history` for each device.
4. Asserts: device A's output lists the publish (kind, root CID equal to the publish result, counts); device B's output lists the pull; both rows come from the on-disk database (the original recorder processes are dead); `--limit 1` prints exactly one row; the output and a raw dump of the database contain no fixture vault path and no fixture note name (grep).
5. Prints each assertion and exits nonzero on any failure; reports what stayed unverified.

## Open Questions

- **Shortened CID display** in `history` output (full vs. truncated): presentation detail, settled in task 4.1; the stored value is always the full CID.
- **Whether `history` should take a vault filter** later (multi-vault per-user store): not in MVP; the record carries CIDs, so a filter can be added without a schema change.
