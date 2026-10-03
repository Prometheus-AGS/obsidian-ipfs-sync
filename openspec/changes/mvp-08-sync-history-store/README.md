# mvp-08-sync-history-store

StoreAdapter interfaces + PGlite metadata/sync-state adapter in CLI; ipfs-sync history

## Required before this change starts (2026-10-02)

- Revise the assumption that embeddings ride the vault snapshot. `docs/005`, `docs/006` and DESIGN section 7 currently plan it that way; those files are owned by documentation-specialist, who revises them as a plan item of this change. The Smart Connections report (`.kbd-orchestrator/phases/mvp/children/mobile-feasibility/assessment-smart-connections.md`) records that its author advises against syncing the embedding store.
- Add a size budget: bytes per vault and bytes per publish for any embedding data. Vector rows are dims x 4 bytes; an illustrative 10k notes x 10 blocks x 384 dims is about 150 MB (inference in the report, not measured).
- Decide exclusion versus own store: embeddings are excluded from the snapshot by default or stored in a store of their own (optional, rebuildable per device). Record the decision before any adapter work.

## Phone embeddings and acceptance gate (2026-10-02)

- Embeddings on a phone are opt-in and user-initiated, never on by default.
- Acceptance gate: a run on an iPhone loading PGlite and the ONNX model together, with a vault of realistic size, recording peak memory. No such run exists yet (the mobile-feasibility child measured Argon2id only). Applies equally to mvp-10 and the AI-layer plan.
- Unverified external signal, not our evidence: Smart Connections issue #1301 reports an iOS relaunch loop about 8 s after the user taps Load (open, no root cause established). Cited as a risk signal only.
