## Context

Read 2026-10-04: `chat-03-chat-shell-and-entities/specs/chat-entities/spec.md` (entity types, flush policy, interrupted state, eviction sentinel, vault boundary) and its tasks 1.1 to 1.4; `README.md` (conflict policy, "History growth"); `src/sync/exclusions.ts` (`DEFAULT_EXCLUSIONS`, rule matching, `isExcluded`); `src/sync/scan.ts` (the scanner lists through the host filesystem and skips by matcher); the pglite assessment s.1.2, s.4.1, s.4.5; `mvp-07b-keys-history-guard-release-2/tasks.md` 1.8. Not read: the sync engine's handling of a new top-level folder during pull beyond what the README states.

## A. Local persistence

Entity model: `decisions-needed.md` group S, "Data model". Persistence follows the `chat-entities` spec: streaming state in memory, flush at part start, part end, run finish, run error, cancel and at most once per bounded interval; on hydrate a `streaming` message or `running` run becomes `interrupted`. Tables live in their own files under `idb://`, away from the embeddings, chunks, collections and membership tables (pglite assessment s.1.2: whole database resident; s.4.1 schema). One database or two is mvp-08's decision.

Layering: components import hooks; hooks import the conversation store; the store calls the persistence service and the file service; services import no React, zustand or store. The eviction sentinel lives in plugin data, outside the database.

Eviction detection and the Data copy: "conversations are not rebuildable" and "Wipe local stores deletes them" (D15). With B on, synced conversations hydrate from files, so eviction does not lose them.

## Store shape: two candidates, decided by numbers (K11, A7, data input s.6.5)

PEM persistence is a whole-graph JSON snapshot behind a key/value adapter (`design-input-hybrid-skills-ui.md` s.2.1), so write cost follows total graph size. Candidate 1: PEM entities with `createPGlitePersistenceAdapter` (one snapshot table). Candidate 2: the authored tables of the data input s.6.5 (conversations, runs, messages, citations, tool-call transitions), append-only, additive-only migrations, separate from the embeddings tables. Task 2.2 measures snapshot bytes and hydrate time against message count on the spike's numbers and picks one; the in-memory adapter of slice 05 is the session-only default either way. Both keep `device_id` and `device_seq` so B can be added without a migration. Every type declares `privacy: "local"` (A8).

## B. File-based sync (opt-in, off by default)

Mechanism: the existing publish and pull. No sync code is added. The service writes files through the vault adapter into a dedicated folder; the existing scan finds them and publishes them encrypted like any file; pull on another device writes them; the store hydrates from them.

File shape (proposal): one JSON document per conversation per originating device, named by conversation id plus a device suffix, with `schemaVersion`, the conversation fields and ordered messages. Tool-call arguments and results are omitted unless the user ticked the box. Citation parts hold references, not excerpt text. No key, secret id value, token or passphrase material, ever. A size cap per file.

Why per device: pull keeps a local edit when only this device changed a file, and when both changed it lets the node's version take the path and keeps local content as a conflict copy (README). One shared file appended to by two devices would generate conflict copies. Per-device files are written only by their device, so no two devices change one file. A second device continuing a conversation writes a branch (parent conversation and message ids) into its own file; the UI merges by conversation id and time.

Tombstones: pull applies no remote deletions, so deleting a file does not delete it elsewhere. A delete overwrites the content with a stub (id, deleted time, no content). The reader treats a stub as deleted and hides the conversation. Stubs are kept for a bounded period the operator sets, then removed (a removed file is itself not propagated, so each device cleans its own). Older roots keep the content; the UI says so.

Write cadence: on turn complete, debounced, then coalesced to at most one batch per publish interval and never within the last seconds before a scheduled publish; a manual "sync conversations now". The service reads the node's history count before enabling and refuses above the operator's threshold; the README's 1,500 warning is the reference. Pruning is unchanged: the floor stays 20.

Visibility: the recommended folder is a dot-folder, hidden from Obsidian search and graph (unverified), outside every collection union and the vault index by default, and excluded from `Whole vault` embedding. Because it publishes by default (not in `DEFAULT_EXCLUSIONS`), local-only users keep it empty: nothing is written there unless B is on. If the operator prefers B's folder to be excluded from publish when B is off, an exclusion entry is a change under `src/sync` and reopens the exact-tree review; a per-device extra exclusion changes `excludesHash` and warns loudly on other devices (spec 011 Q5), so it is not used.

Disclosure dialog: Obsidian `Modal` (P4), Cancel focused, text per S6.
