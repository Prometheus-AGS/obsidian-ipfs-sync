## Why

The operator wants embeddings for user-defined collections of documents (2026-10-04). A collection is a named set of notes. It scopes which notes get embedded at all, which saves compute and memory on a phone, and it scopes Search, Notes mode and the Index tab. The model, the options and the recommendation are decision group C in `vault-agent-ui-00-phase-overview/decisions-needed.md`. Facts are in `assessment-pglite-collections.md` (cited "pglite assessment s.N"), `docs/006-embedded-stores.md` and `mvp-08-sync-history-store/README.md`.

The uncomfortable parts:
- **Half of this slice has no prerequisite and half has three that do not exist.** Defining a collection and previewing its member count needs only Obsidian's file and metadata APIs (`Vault.getMarkdownFiles` is present in obsidian 1.13.1; tag evaluation is unverified). Per-collection index status and cost need the mvp-08 PGlite adapter and size budget, an embedding provider (local model or a provider endpoint, C2), and the data phase's index service. None is planned.
- **The prerequisite chain is long and outside this phase:** mvp-08 PGlite adapter and size budget (it owns the pin) -> embedding provider -> collections -> Search and Notes mode.
- **Collection definitions are authored data, not a cache** (pglite assessment s.4.5). Spec 006's "both stores are throwaway caches" breaks if definitions live only in evictable IndexedDB. They need a durable home outside PGlite (C6).
- **A remote embeddings endpoint sends whole-note text to a third party at embedding time, for every note in the collection** (C2). Anthropic-compatible providers cannot embed at all (pglite assessment s.3.2).
- **Nothing is measured.** PGlite memory on an iPhone, embedding throughput, join latency and index size are arithmetic and documentation only (pglite assessment s.7.2, s.8). The iPhone gate in mvp-08 has never been run.
- **Every collection default is a cost decision on a phone.** Whole-vault embedding of a large vault is the failure case; C4 makes embedding opt-in.

## What Changes

- Part A (no index needed): define, edit, delete, preview membership count and sample, exclusions win; definitions stored durably outside PGlite.
- Part B (blocked): per-collection index status and cost estimate, "embed this collection" action, indexing driven by the union of collections, a default collection per chat, the built-in exclusion of the conversations folder, and the local-only statement.

## Capabilities

### New Capabilities
- `collections`: definition model, membership evaluation, scope for embedding, search and chat, durability, privacy statement.

### Modified Capabilities
<!-- none -->

## Impact

- Code: `src/data/collections/` (store: definitions, membership preview), `src/agents/collections/` (service: membership evaluation over injected vault and metadata ports; no React, zustand or store), `src/ui/collections/` (components and hooks), host wiring in `src/plugin/`, copy files, `tests/`, `features/`.
- Data: definitions in a durable device-local file under the plugin folder (C6 option B, recommended; separate from `data.json` so definitions do not sit beside secrets); a PGlite mirror only once the data phase exists.
- Dependencies: none for Part A.
- Cadence: reviewers dormant until the phase gate; security-reviewer scope includes the privacy statement and the conversations-folder exclusion.

Blocked on: Part A: slice 01 only, plus C5 and C6 answers. Part B: mvp-08 PGlite adapter, pin and size budget; the embedding provider (C2) and, if provider embeddings, slice 02; the data phase's index service; `assessment-pglite-collections.md` s.7.2 measurements for defaults; D2.
