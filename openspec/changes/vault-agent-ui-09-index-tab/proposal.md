## Why

The Index tab shows the model, coverage, queue and actions (Embed changed, Pause on battery, Rebuild) and carries the honesty statement that the index is a rebuildable cache (`docs/design/vault-agent-ui-concept.md` A3; `docs/design/agent-panel.html:183-245`). Slice 01 ships it on a stub that says no index exists. This slice connects it to real index state, per collection, and builds the `ConsequenceDialog` base for the Rebuild action.

The uncomfortable parts:
- **The index state does not exist.** It needs the data phase's index service over PGlite vectors, mvp-08's adapter and size budget, and an embedding provider. mvp-08 is the sync-history adapter (`mvp-08-sync-history-store/README.md`); the AI layer is "decision pending, specs TBD" (`DESIGN.md` section 7).
- **The design's honesty text is false as written.** "Embeddings are keyed by file content and travel with the vault snapshot" (`agent-panel.html:209`, concept `:238-240`) and the Rebuild dialog's "Embeddings pinned to the current snapshot are reused" (`:242`) contradict mvp-08 and the 2026-10-04 local-only rule (D2, C3). They are rewritten through Open Design in this slice.
- **The mock statistics mislead.** The prototype row "PGlite in IndexedDB · 14.8 MB · 1,204 vectors" is about 8 times what 384 dimensions need (pglite assessment s.2.3). Real numbers come from the index service or are "unknown".
- **Phone memory is unmeasured.** Database size is resident memory under `idb://` next to the model (pglite assessment s.1.2, s.7.1). "Pause on battery" and a phone opt-in are only as good as a gate that has never run.
- **Rebuild is destructive and slow.** It deletes the local store and embeds again; on a phone the app must stay in the foreground (design copy). The estimate is the service's, or "unknown".
- **Rebuild must not delete what is not rebuildable.** Collection definitions and conversations are authored data and are kept (C6, D15). The dialog says so.

## What Changes

- Index tab on real state: model card, coverage and counts per collection and in total, queue by state, per-file list filtered by state, the local-only statement, evicted state, failed state, model-load failure copy.
- Actions: Embed changed, Pause on battery (toggle), Rebuild index.
- `ConsequenceDialog` base per D5 (Modal; Cancel first and focused unless a required field).
- Status chip text and states from the same store (slice 01's chip gains real states: building, paused, missing, failed).

## Capabilities

### New Capabilities
- `index-tab`: index state, actions, honesty statement, consequence dialog.

### Modified Capabilities
<!-- none -->

## Impact

- Code: `src/ui/index-tab/` (components, hooks), `src/data/shell/index-store.ts` (extended; calls the index port), `src/plugin/consequence-dialog.ts` (Modal base), copy files, `docs/design/` copies through Open Design, `features/`, `tests/`.
- Dependencies: none.
- Cadence: reviewers dormant until the phase gate.

Blocked on: slice 01; slice 03 B; the data phase index service; mvp-08 PGlite adapter, pin and size budget; D2 and D5; the iPhone gate for any phone default.
