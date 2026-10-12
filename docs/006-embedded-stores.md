# Spec 006 — Embedded Stores: SurrealDB WASM (graph) + PGlite (vectors/metadata)

Status: **decision record — user-approved.**
Closes: spec 005 open question #4 (embedding index format).
Supersedes: the single-store comparison that preceded this decision (PGlite won
the vectors/metadata role on cross-surface API parity and live queries;
SurrealDB WASM was selected for the document-relations graph).

## Decision

Two co-located embedded databases, both WASM, both running in the Obsidian
plugin (mobile WebView + desktop Electron) and in Node 24 scripts:

| Store | Engine | Role |
|---|---|---|
| **Vectors + metadata** | PGlite (PostgreSQL 17 in WASM, ~3 MB gz) | Embeddings, file metadata, sync state, manifest caches. Real SQL, pgvector when we outgrow brute force, live queries for reactive UI. |
| **Knowledge graph** | SurrealDB WASM (official JS SDK WASM engine) | Notes as nodes, relations as edges: links, backlinks, tags, headings, agent-discovered relations. SurrealQL graph traversals (`->`, `<->`, path queries) for "how do these notes connect" at query time. |

Division of labor: PGlite is the **columnar, queryable record store**; Surreal
is the **traversable relationship store**. They reference each other by
`file_sha256` (the content key from spec 005's manifest) — never by vault path
(paths are mutable metadata that lives in PGlite).

## Why this pairing

- **PGlite for vectors/metadata:** one identical API in WebView (`idb://…`
  persistence) and Node (filesystem) — collapses the cross-platform matrix to a
  single code path; live queries give reactive index UI for free; pgvector is
  the most proven embedded vector path when brute force stops sufficing (~100k+
  vectors; we're at ~10k × 384-dim ≈ 15 MB) — but pgvector is absent from
  @electric-sql/pglite 0.5.8 (verified by `npm pack` listing at plan time for
  change `mvp-08-sync-history-store`), so a pgvector implementation waits for
  a version that carries it or a different engine.
- **SurrealDB WASM for the graph:** the vault is fundamentally a graph problem
  (notes, links, tags, embeddings-neighborhoods, agent-inferred relations), and
  graph traversals in SQL are painful vs SurrealQL's native `->` / `<->` /
  path semantics. Stack-aligned: UAR already ships Surreal configs and the
  team's skills target SurrealDB (HNSW vector type available there too if the
  graph ever wants semantic edges).
- Both are rebuildable **caches**, never sources of truth (rule below) — which
  is what makes trusting WebView storage safe.

## Non-negotiable design rule

> **Both stores are throwaway caches.** The source of truth is the vault +
> manifest on IPFS (spec 005). iOS can evict IndexedDB under storage pressure;
> the answer is rehydration, not grief: embeddings are excluded from the vault
> snapshot by default and the embedding store is device-local, optional and
> rebuilt on the device (decision record: change `mvp-08-sync-history-store`,
> design.md); the graph is rebuildable by re-parsing notes + replaying
> agent relation records. Worst case = seconds-to-minutes of rebuild, zero
  data loss.

## Schema sketches (starting points, not commitments)

**PGlite**
```sql
CREATE TABLE files (
  sha256      TEXT PRIMARY KEY,
  path        TEXT NOT NULL,
  size        INT  NOT NULL,
  mtime       TIMESTAMPTZ NOT NULL,
  synced_root TEXT          -- last vault root that contained this content
);
CREATE TABLE embeddings (
  sha256  TEXT PRIMARY KEY REFERENCES files(sha256),
  model   TEXT NOT NULL,     -- e.g. 'onnx:all-MiniLM-L6-v2'
  dims    INT  NOT NULL,
  vector  REAL[] NOT NULL    -- float32[]; brute-force cosine until >100k rows
);
CREATE TABLE sync_state (k TEXT PRIMARY KEY, v JSONB NOT NULL);
```

**SurrealDB (graph)**
```surql
DEFINE TABLE note SCHEMAFULL;
  -- id derived from sha256; no path (paths live in PGlite)
DEFINE TABLE relation SCHEMAFULL TYPE RELATION FROM note TO note
  ENFORCED;
  -- kind: 'links' | 'backlinks' | 'tag-share' | 'semantic' | 'agent:<name>'
DEFINE FIELD kind ON relation TYPE string;
DEFINE FIELD weight ON relation TYPE option<float>;
DEFINE FIELD provenance ON relation TYPE string;  -- 'parser' | 'agent' | 'import'
```

Traversal example the graph exists for:
```surql
SELECT * FROM note:<shaA> ->relation-> note ->relation-> note
WHERE kind IN ['links','backlinks'] LIMIT 50;
```

## Build/update pipeline

1. **Baseline (sync pull):** manifest arrives → PGlite `files` upsert →
   `embeddings` is rebuilt on the device for the changed content
   (content-keyed, model-matched); no embedding data arrives with the
   snapshot (decision record: change `mvp-08-sync-history-store`, design.md).
2. **Incremental (note save):** sha256 change → re-embed locally (ONNX lane,
   spec 005) → update `embeddings`; link/tag parser updates `relation` edges
   with `provenance: 'parser'`.
3. **Agent enrichment (Phase 3):** UAR-lite agents add `provenance: 'agent'`
   edges (semantic neighbors, inferred topics) — the graph becomes the agent's
   memory of the vault, and A2A/AG-UI answers can cite traversals.

## Open questions

1. SurrealDB WASM bundle size + cold-start on mobile WebView — spike early
   (it's the heavier of the two; PGlite is ~3 MB gz).
2. SurrealDB WASM storage backends in WebView: which are production-grade
   today (memory / IndexedDB kv)? Confirm against current SDK docs.
3. Relation schema versioning — agent-inferred relations will want richer
   payloads (evidence, confidence); keep `kind` namespaced (`agent:<name>`) or
   move to edge documents?
4. Graph snapshots: worth persisting the graph itself to IPFS (per snapshot)
   so a new device skips full re-parse, or is rebuild-always acceptable at 10k notes?
5. Do live queries get used on the Surreal side too (reactive graph panel),
   or only PGlite?
