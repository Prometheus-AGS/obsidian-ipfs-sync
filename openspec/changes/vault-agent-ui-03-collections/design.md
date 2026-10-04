## Context

Read 2026-10-04: pglite assessment s.4 (schema, comparison, incremental indexing, privacy, definitions durability), s.5 (layering and service surface); `docs/006-embedded-stores.md`; `src/sync/exclusions.ts`. The service surface in the pglite assessment (`CollectionService`: list, upsert, remove, preview, membership, cost) is the data-engineer's proposal; the UI codes against a consumer-side port with the same needs and the data phase may change the shape.

## Model (recommended, C1 and C5)

A collection: stable id, name, include list, exclude list, definition version. Include kinds in v1: folder (recursive flag), tag, manual picks. Saved query is deferred (Obsidian's search syntax is not a public API, unverified; a query language of our own is new scope). Include is a union; exclude wins. Membership is evaluated over paths and metadata, materialised at path level, so an edit changes a note's hash but not its membership (pglite assessment s.4.2). The indexed scope is the union of all collections' members; a note in several collections is embedded once.

Built-in exclusions, not editable: the conversations folder (slice 11), `DEFAULT_EXCLUSIONS` paths, and any path the sync refuses. The "Whole vault" collection is an ordinary collection with one include rule; the built-ins still apply.

## Definitions durability (C6)

Authored data. Home: a device-local JSON file in the plugin folder, separate from `data.json` (recommended, option B); a file in the vault (option A) is a follow-up. PGlite may mirror definitions for joins. Eviction of the PGlite store never loses a definition. Definitions name folders and tags, which can be sensitive; they never enter a log line or an error report.

## Layers

```
src/ui/collections/components/  list, editor, membership preview, cost row, default-per-chat picker (hooks only)
src/ui/collections/hooks/       use-collections
src/data/collections/           vanilla zustand store: definitions, preview state; calls the service
src/agents/collections/         service: evaluate membership over injected ports
```

Ports (injected by the host, so the service runs under Node tests): vault listing, metadata (tags, frontmatter), definition file read and write, clock. The service imports no `obsidian`, React, zustand or store.

## Part B surfaces

Per-collection row: member count, embedded count, queued, failed, estimated cost (chunks, bytes, seconds as the index service gives them; "unknown" when it cannot), source of embeddings (local model or provider host, C2), and an "Embed this collection" action. Starting it on a phone shows the cost and says phone embedding is opt-in (mvp-08). Starting with a provider embeddings endpoint shows the consent of L4 (whole-note text is sent). Changing the embedding model marks a rebuild; vectors from different models are never mixed (pglite assessment s.3.3). Default collection per chat: stored with the chat setting; Notes mode and Search read it.

## Privacy statement

Shown on the Index tab and the collection row: embeddings are built on this device from the notes' content and kept only here; they are not synced; every device builds its own; they can be rebuilt at any time. Pglite assessment s.6 suggests the wording; the operator owns it. With a provider embeddings endpoint the row also names the host.
