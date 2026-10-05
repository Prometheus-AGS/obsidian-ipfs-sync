## Context

Read 2026-10-04: concept A3 and section 6; `docs/design/agent-panel.html` Index tab and rebuild dialog (lines 183-245, 399-408); pglite assessment s.5 (`IndexService`: state, subscribe, embedChanged, pause, estimate, rebuild; proposal), s.6 (documents that contradict mvp-08), s.2.3 (size arithmetic); `docs/design/control-center.html:136`. The shapes are the data-engineer's proposal; the UI codes against the data phase's real interface.

## State

The store extends slice 01's index store. States: `unavailable` (no service), `empty` (no collection defined; points to collections), `building` (counts moving), `ready`, `paused`, `missing` (evicted: "Index missing on this device · rebuild", search falls back to text), `failed` (per-file failures; a model-load failure has its own copy, a design gap drawn first). Values: model id and dimensions, where it runs (device or provider host, C2), store size, last rebuilt, embedded, changed since last publish, skipped with reason, failed, queue. Any number the service cannot give renders as "unknown", never as a literal.

Boot states map to visible phases: idle, hydrating or building, ready, paused, failed (data input s.4, adapted from the sync-doctrine boot states). Store statistics come from `pg_relation_size` or the service's own measure, never from mock copy: the prototype's "14.8 MB · 1,204 vectors" is about 8 times what 384 dimensions need (pglite assessment s.2.3). Index size at 384 dimensions is unverified until measured. Authored tables (conversations, provider list, collection definitions) are reported separately from the index and are not listed under Rebuild (data input s.6.5 note d).

## Per collection

Rows per collection reuse slice 03's collection row: members, embedded, queued, failed, cost. The total is the union.

## Actions

Embed changed: starts the queue for the selected scope. Pause on battery: a toggle; the phone default and any battery heuristic follow mvp-08's opt-in rule and the gate, not a number chosen here. Rebuild: opens the consequence dialog.

## ConsequenceDialog base (first consumer here)

An Obsidian `Modal` host with a model/view split like the 07b dialogs. Rule (D5): confirmation dialogs focus Cancel; dialogs with a required field focus the field; Cancel precedes the confirm control in DOM order; Escape and the close control mean no; after any end state focus returns to Cancel or Close. Cancel styling is decided once (D5). The Rebuild dialog states: the local index store is deleted and every collection member is embedded again; search falls back to text until it finishes; the time estimate or "unknown"; on a phone keep the app in the foreground; nothing in the vault or on the node changes; collection definitions and conversations are kept. It does not say embeddings are pinned to a snapshot.

## Honesty statement

"Embeddings are built on this device from your notes' content and kept only here. They are not synced; every device builds its own. This device can rebuild them at any time; nothing here is the source of truth." (suggested wording, pglite assessment s.6; the operator owns the final text). The design copies are changed through Open Design first (`tasks.md` 0.1).
