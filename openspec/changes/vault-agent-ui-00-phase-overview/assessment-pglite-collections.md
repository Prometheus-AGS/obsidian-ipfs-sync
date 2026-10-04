# Assessment: PGlite vectors for document collections

Written 2026-10-04 by data-engineer (read-only desk study; nothing installed, no model run, no device used). Answers the operator input: "we should also consider using PGlite as a database with vectors, so we can create embeddings for collections of documents that are defined."

Evidence labels. `[repo]` = a file read in this session. `[npm]` = `npm view`, 2026-10-04 23:04 UTC. `[doc]` = documentation or issue page fetched 2026-10-04. `[calc]` = arithmetic, not measurement. `[inf]` = my inference from cited facts. `UNVERIFIED` = not confirmed in this session.

## 0. Summary

1. PGlite is already the user-approved vector and metadata store (`docs/006-embedded-stores.md` [repo]). The operator's idea is therefore not a new store. The open design work is the collection data model and the embedding source.
2. Current PGlite is `@electric-sql/pglite` 0.5.8 (2026-08-26), Apache-2.0 [npm]. `pglite.wasm` is 10,088,161 bytes raw, 3,389,857 gz; `pglite.data` is 6,295,316 raw, 1,859,685 gz [calc: downloaded from jsDelivr, `gzip -9`]. So the "~3 MB gz" in spec 006 covers the wasm only; with `pglite.data` the gzipped payload is about 5.2 MB.
3. pgvector is a separate package, `@electric-sql/pglite-pgvector` 0.0.9, peer-pinned to `@electric-sql/pglite` 0.5.8 exactly [npm]. Its payload is a 46,549-byte `vector.tar.gz` [doc: jsDelivr file listing]. HNSW and IVFFlat exist in pgvector itself [doc]; that they build and perform acceptably inside PGlite WASM is UNVERIFIED.
4. PGlite's browser persistence (`idb://`) loads every database file into memory at start and rewrites whole changed files to IndexedDB [doc: pglite.dev/docs/filesystems]. OPFS is unavailable on Safari (252 sync-access-handle limit) [doc]. On an iPhone, database size is therefore resident memory, next to the ONNX model. No measurement of this exists (`mvp-08-sync-history-store/README.md` [repo]).
5. Embeddings must not ride the vault snapshot. Four files say or imply they do: `docs/005` lines 99-101, `docs/006` lines 44-47 and 89-91, `DESIGN.md` section 7, and the Index tab copy in `docs/design/`. mvp-08 says to revise them [repo]. Section 6 lists the exact lines.
6. Recommendation on collections: one shared index (one `chunks` table, one `embeddings` table per active model). A collection is a materialised path-level membership filter over it. Embedding scope is the union of collection members. Details in section 4.
7. A collection definition is user-authored data, not a cache. Spec 006's rule "both stores are throwaway caches" breaks if definitions live only in evictable IndexedDB. Definitions need a durable home outside PGlite. This is an operator decision (section 4.5).
8. `@huggingface/transformers` 4.3.0 declares `sharp` and `onnxruntime-node` as dependencies and `onnxruntime-web` as a dev prerelease (`1.31.0-dev.20260914-8d85527a0`) [npm]. That collides with "no native modules in src/" and with the pin discipline in `CLAUDE.md`. Section 3.
9. Anthropic has no embeddings endpoint (its docs say so and point to Voyage AI) [doc]. The OpenAI `POST /embeddings` shape is documented and small [doc]. Provider embeddings send note text to a third party, which is a different privacy posture from local ONNX.
10. Nothing in this study is a device measurement. Section 7 lists what must be measured on a real iPhone before any default is chosen.

## 1. PGlite

### 1.1 Version, size, licence

| Fact | Value | Source |
|---|---|---|
| Latest `@electric-sql/pglite` | 0.5.8, modified 2026-08-26T18:40:09Z; dist-tags `latest` 0.5.8, `next` 0.3.0-next.1 | [npm] |
| Licence | Apache-2.0 (site says dual Apache-2.0 and PostgreSQL License) | [npm], [doc: pglite.dev] |
| `dist/pglite.wasm` | 10,088,161 B raw; 3,389,857 B gzip -9 | [calc] from jsDelivr file |
| `dist/pglite.data` | 6,295,316 B raw; 1,859,685 B gzip -9 | [calc] |
| `dist/initdb.wasm` | 395,242 B raw | [doc: jsDelivr listing] |
| `dist/index.js` | 464,072 B raw | [doc: jsDelivr listing] |
| `dist/live/index.js` (live queries) | 11,231 B raw | [doc: jsDelivr listing] |
| `dist/worker/index.js` | 8,698 B raw | [doc: jsDelivr listing] |
| npm `unpackedSize` | 25,437,263 B (all contrib tarballs included; not what ships) | [npm] |
| Postgres version | 17 (spec 006); the extension catalogue page and skill text say PG 17.4 | [repo], skill text. Not re-read on pglite.dev this session. |
| Exports | `.`, `./live`, `./basefs`, `./nodefs`, `./worker`, `./opfs-ahp`, `./template`, `./contrib/*` | [npm exports] |

Shipping consequence `[inf]`: an Obsidian plugin is `main.js`, `manifest.json`, `styles.css`. A 10 MB wasm and a 6 MB data file do not fit that shape unless inlined (base64 adds about 33 percent to the raw bytes) or downloaded on first use. How PGlite resolves `pglite.wasm` and `pglite.data` inside the Obsidian bundle is UNVERIFIED; the bundler issue #546 ("import resolve warnings when using esbuild") is open [doc]. The release-deployment-lead owns the answer. Size gate comes from `chat-00` (300 KB waived, measured cold-start instead [repo: vault-agent-ui README]).

### 1.2 Persistence options

| Option | Where it works | Constraint | Source |
|---|---|---|---|
| `memory://` (default) | All | No persistence except `dumpDataDir()` then `loadDataDir` | [doc: filesystems] |
| `idb://name` | Chrome, Safari, Firefox | Loads all files into memory at start; flushes changed whole files to IndexedDB after each query; `relaxedDurability` defers the flush | [doc: filesystems] |
| `opfs-ahp://path` | Chrome and Firefox only, Web Worker only | Safari limit of 252 open sync access handles against a Postgres install of over 300 files; docs recommend IndexedDB VFS in browsers | [doc: filesystems] |
| Node FS (`./path/`) | Node, Bun | Plain directory | [doc: filesystems] |

Implications for this design:
- **Write amplification `[inf]`.** The docs say IdbFs stores "whole files (Postgres has a single file per table or index) as blobs". A large embeddings table is one file that is rewritten whenever it changes. Keep embeddings in their own table (own file) so metadata updates, job-status updates and membership refreshes do not rewrite the vector file. Batch inserts in one transaction per file or per N chunks.
- **Resident memory `[inf]`.** Database size is resident memory on `idb://`. The 10k-note, 10-blocks figure of about 150 MB (mvp-08 README [repo]) would be in memory plus the WASM heap plus the model. Issue #406 (open, 2024-10) asks this exact question and the thread says "I believe it does" load the whole database [doc: github.com/electric-sql/pglite/issues/406]. Issue #408 (open, "mobile support"): a maintainer says "I know there can be issues if you try to allocate over 256mb" and users report iOS Safari crashes and a `Maximum call stack size exceeded` on 0.3.4 [doc: .../issues/408]. Current version behaviour on iOS: UNVERIFIED.
- **Multi-tab and worker.** `PGliteWorker` runs leader election across tabs; one tab owns the instance [doc: pglite.dev/docs/multi-tab-worker]. The `vector` extension must be loaded inside the worker; extensions are "not exposed on a connecting PGliteWorker on the main thread" [doc]. Obsidian runs one renderer per vault window on desktop; the leader pattern matters only if two windows open the same vault. Whether a Worker from a Blob URL runs inside Obsidian mobile is UNVERIFIED (Smart Connections does it for its model worker, per `assessment-smart-connections.md` 2.1 [repo], which is evidence for the model worker, not for PGlite).
- **Storage eviction.** WebKit: "By default, all origins use a best-effort mode... their data can be evicted"; eviction happens on exceeding quota, system storage pressure, or no user interaction for some time; origin quota is up to 15 percent of disk for non-browser WebKit apps on iOS 17 [doc: webkit.org/blog/14403]. Obsidian is a WebKit app that is not a browser app `[inf]`, so the 15 percent origin quota would apply; that Obsidian mobile's IndexedDB is subject to the same eviction rules is UNVERIFIED. `docs/006` already plans for eviction by calling the stores caches. `navigator.storage.persist()` exists in WebKit 17 [doc]; whether it helps inside Obsidian is UNVERIFIED.
- **Quota growth on Chrome/Android.** Issue #467 (open): `Failed to read large IndexedDB value` near the IndexedDB quota; IndexedDB size only grows unless `VACUUM FULL` is run [doc: .../issues/467]. Plan: run `VACUUM FULL` after rebuilds, or drop and recreate the database on rebuild.
- **Open bugs touching our workload.** #1068 (open, 2026-07-25): under sustained per-page `DELETE` plus multi-row `INSERT ... ON CONFLICT` with a `vector(1024)` column, PGlite 0.4.3 can spin forever on the main thread, reproduced 5 times by the reporter, once offline in pure SQL [doc: .../issues/1068]. Our re-index path is exactly DELETE plus INSERT per document. Mitigation to test, not assume: run PGlite in a Worker (a spin then does not freeze the UI), keep batches small, and use plain `INSERT` into fresh rows rather than `ON CONFLICT` upserts. #1085 (open): WebKit CI tests fail intermittently with `Out of bounds memory access` and `INITDB failed to initialize` [doc: .../issues/1085]. #829 (open): `useLiveQuery` with pgvector failed in a browser/Vite setup on 0.3.11 [doc: .../issues/829]. Whether any of these still reproduce on 0.5.8 is UNVERIFIED.
- **Old WebViews.** Runtime errors on Chrome 114 and older; project tests start at Chromium 118 / iOS 15 and will not support older [doc: .../issues/584]. Obsidian's minimum iOS and Android WebView versions versus that floor: UNVERIFIED.

## 2. Vectors in PGlite

### 2.1 pgvector as a PGlite extension

- Package: `@electric-sql/pglite-pgvector` 0.0.9, modified 2026-08-26, Apache-2.0, `peerDependencies: { "@electric-sql/pglite": "0.5.8" }` (exact pin) [npm].
- Load: `import { vector } from '@electric-sql/pglite-pgvector'; const pg = new PGlite({ extensions: { vector } }); await pg.exec('CREATE EXTENSION IF NOT EXISTS vector;')` [doc: pglite.dev/extensions]. The catalogue lists "Bundle Size: 42.9 KB"; the jsDelivr listing shows `vector.tar.gz` of 46,549 B [doc]. An older import path (`@electric-sql/pglite/vector`) is not in the 0.5.8 `exports` map [npm]; use the new package name.
- The pgvector version inside 0.0.9 is UNVERIFIED. Issue #1068 reports "bundled pgvector 0.8.1" on PGlite 0.4.3 [doc]. Iterative index scans need pgvector 0.8.0 or later [doc: pgvector README].
- Pin consequence: the extension peer-pins PGlite to one exact version. Every PGlite bump is a joint bump and needs a store-format check. The pin belongs in `versions.toml` as part of mvp-08 (it currently pins `@noble/hashes`, `typescript`, `node` only, per the vault-agent-ui README [repo]).

### 2.2 Types, index types, limits (pgvector, upstream docs)

Source: https://github.com/pgvector/pgvector README, read 2026-10-04.
- `vector` row = `4 * dims + 8` bytes; `halfvec` = `2 * dims + 8`; `bit` = `dims/8 + 8`; sparse = `8 * nnz + 16`.
- Index dimension limit for `vector` is 2,000 (README lines 252 and 374).
- HNSW: better speed-recall than IVFFlat, slower build, more memory, no training step, can be built on an empty table. IVFFlat: needs data present before building. Build is faster when the graph fits in `maintenance_work_mem`.
- Filtering with an approximate index is applied after the index scan, so selective filters return fewer rows. Iterative scans (0.8.0+) address that. Quote: "If a condition matches 10% of rows, with HNSW and the default `hnsw.ef_search` of 40, only 4 rows will match on average."
- Varying dimensions: only indexable per dimension via expression plus partial index, for example `CREATE INDEX ON embeddings USING hnsw ((embedding::vector(3)) vector_l2_ops) WHERE (model_id = 123);` queried with `ORDER BY embedding::vector(3) <-> ...`. This is the documented way to hold several models in one table.
- Without an index, pgvector does an exact scan: `ORDER BY embedding <=> $1 LIMIT k` computes every distance.

### 2.3 Size arithmetic (all `[calc]`, not measurement)

Per-vector payload from the formulas above, excluding Postgres tuple and page overhead (not computed; UNVERIFIED) and excluding any index.

| Dims | float32 `vector` bytes | `halfvec` bytes | 10,000 vectors f32 | 100,000 vectors f32 | 100,000 vectors halfvec |
|---|---|---|---|---|---|
| 384 | 1,544 | 776 | 15.4 MB | 154.4 MB | 77.6 MB |
| 768 | 3,080 | 1,544 | 30.8 MB | 308.0 MB | 154.4 MB |
| 1,024 | 4,104 | 2,056 | 41.0 MB | 410.4 MB | 205.6 MB |
| 1,536 | 6,152 | 3,080 | 61.5 MB | 615.2 MB | 308.0 MB |

Reading it against the repo's own numbers:
- `docs/006` "~10k x 384-dim, 15 MB" is note-level vectors: matches 15.4 MB. mvp-08's "10k notes x 10 blocks x 384 dims, about 150 MB" is block-level: matches 154.4 MB. Both are consistent with the formula. The design screen `control-center.html` shows "PGlite in IndexedDB · 14.8 MB · 1,204 vectors", which is about 12.3 KB per vector, roughly 8 times what 384 dims need. That is mock copy, not data; do not let the Index tab statistics be built to look like it.
- An HNSW index stores another copy of each indexed vector plus link lists `[inf]`; I did not compute it. The pgvector-semantic-search skill text (not an authoritative source) gives "about 4-6 KB per 1536-dim halfvec (m=16)". Treat index size at 384 dims as UNVERIFIED and measure it with `pg_relation_size`.
- Exact-scan time at 100k x 384 is 38.4 million multiply-adds per query `[calc]`. Latency in PGlite WASM on a phone is UNVERIFIED. No benchmark of pgvector inside PGlite was found in this session. Measure before choosing the HNSW threshold.
- `halfvec` halves storage for a small recall cost per the skill text and pgvector docs. Whether PGlite's pgvector build exposes `halfvec` and `hnsw` over it: UNVERIFIED (the README says 0.7.0+ has it; the version inside 0.0.9 is unconfirmed).

### 2.4 Index policy I would specify

1. Default on every device: **no ANN index**. Exact scan over the collection-filtered subset. Collections are small by construction and exact search has no recall loss and no post-filter problem.
2. Desktop and Node only, when a measured threshold is passed (rows above N, p95 over a stated budget): an HNSW partial index per `(model_key, dims)` using the documented expression-index form, with iterative scan on if pgvector is 0.8.0+.
3. Phone: never build HNSW. Build time and memory (`maintenance_work_mem`) and the resident-database rule make it a bad default `[inf]`.

### 2.5 Alternative noted, not recommended to switch

SurrealDB WASM has an HNSW vector type (spec 006 notes it; `surrealdb-vector` skill shows `DEFINE INDEX ... HNSW DIMENSION 384 DIST COSINE TYPE F32`). It is the graph store here. Registry state: `surrealdb` 2.0.10 (2026-10-03) and `@surrealdb/wasm` 3.0.3 (2026-03-09) [npm]; the two have different major versions and I did not verify they pair. Putting vectors in Surreal would split embeddings from the metadata and membership joins that collection queries need. No switch recommended; spec 006's split stands.

## 3. Embedding sources

### 3.1 Local ONNX in a WebView

Packages [npm 2026-10-04]:
- `@huggingface/transformers` 4.3.0 (2026-09-16), Apache-2.0. Dependencies: `sharp ^0.35.4`, `onnxruntime-web 1.31.0-dev.20260914-8d85527a0`, `onnxruntime-node 1.30.0`, `@huggingface/jinja ^0.5.10`, `@huggingface/tokenizers ^0.2.0`.
- `onnxruntime-web` 1.30.0 (2026-09-18), MIT, unpackedSize 144,618,540 B (all variants; the shipped wasm is a subset, size UNVERIFIED).

Repo constraints this hits:
- **No native modules in `src/`.** `sharp` and `onnxruntime-node` are native packages listed in `dependencies`. Installing the package pulls them into `node_modules` even if the browser bundle aliases them away. Options to evaluate in the spike: npm `overrides`/omit for those two, or call `onnxruntime-web` directly with a pure-JS tokenizer. Whether `@huggingface/tokenizers` is pure JS: UNVERIFIED. The Node CLI must use the WASM backend, not `onnxruntime-node`.
- **Pin discipline.** `CLAUDE.md`: verify dependency versions against official sources before introducing them. The transformers.js 4.3.0 line depends on a dated dev prerelease of `onnxruntime-web` that differs from the `latest` tag (1.30.0). A stable pin that works must be found, not assumed.
- **Offline claim.** `docs/005` says "airplane mode, phone only". Smart Connections fetches the runtime and models from jsDelivr and Hugging Face on first load and then relies on the browser cache (`assessment-smart-connections.md` 2.1, R7 [repo]). Model files are not in the plugin bundle. Offline holds only after a successful online first run, and only while the cache is not evicted `[inf]`. Alternative: put the model in the plugin folder through a download step (plugin data is device-local and excluded from sync, `src/sync/exclusions.ts` [repo]); that is a new design item for the release lead.
- WebGPU: spec 005 says shipped on Android Chrome and iOS Safari 26 [repo, from research done earlier, not re-verified]. Smart Connections tries WebGPU then falls back to WASM, batch 16 on WebGPU and 8 on CPU [repo: assessment-smart-connections]. Whether WebGPU is exposed to Obsidian's iOS WKWebView: UNVERIFIED.

Candidate models (Hugging Face ONNX files, sizes from `https://huggingface.co/api/models/<id>/tree/main/onnx`, 2026-10-04):

| Model | Files (bytes) | Licence | Dims |
|---|---|---|---|
| `Xenova/all-MiniLM-L6-v2` | `model.onnx` 90,387,606; `model_quantized`/`model_int8` 22,972,370; `model_fp16` 45,297,825; `model_q4f16` 30,018,257 | apache-2.0 (card) | 384 (model card, not re-read: UNVERIFIED) |
| `Xenova/bge-small-en-v1.5` | `model.onnx` 133,093,490; `model_quantized` 34,014,426; `model_int8` 33,760,831; `model_fp16` 66,749,212 | `BAAI/bge-small-en-v1.5` card says MIT; the Xenova card has no licence field | 384 (UNVERIFIED) |
| `Xenova/multilingual-e5-small` | `model.onnx` 470,268,533; `model_quantized` 118,308,185; `model_fp16` 235,336,732 | no licence field on the Xenova card (UNVERIFIED) | 384 (UNVERIFIED) |
| `onnx-community/embeddinggemma-300m-ONNX` | `model_q4.onnx_data` 196,725,760; `model_q4f16.onnx_data` 175,410,176; `model_quantized.onnx_data` 308,890,624 | `gemma` (custom terms; review before use) | UNVERIFIED |

Spec 005 and 006 name `onnx:all-MiniLM-L6-v2`. The int8 file at 22.97 MB is the realistic phone candidate on size grounds `[inf]`. Speed on a phone WebView: UNVERIFIED, measure. Retrieval quality of any of these on the user's notes: UNVERIFIED. Smart Connections' default is `TaylorAI/bge-micro-v2`, 384 dims, 512 tokens [repo: assessment-smart-connections], which I did not size.

The Rust/WASM `tract` lane in spec 005 stays deferred to the benchmark spike (spec 005 open question 6 [repo]). I did not evaluate it.

### 3.2 Provider REST embeddings

- OpenAI `POST /v1/embeddings` [doc: developers.openai.com/api/reference/resources/embeddings/methods/create]: body `input` (string or array), `model` (`text-embedding-3-small`, `text-embedding-3-large`, `text-embedding-ada-002`), optional `dimensions` (only `text-embedding-3` and later), `encoding_format` `float` or `base64`. Limits stated on that page: 8,192 tokens per input, arrays of at most 2,048 inputs, 300,000 tokens summed per request. Response: `data[].embedding`, `model`, `usage`. The response carries the model name, which maps onto `model_key`.
- Anthropic: "Anthropic does not offer its own embedding model", recommends Voyage AI [doc: platform.claude.com/docs/en/build-with-claude/embeddings]. There is no Anthropic embeddings endpoint; an "Anthropic-compatible" connection from slice 02 cannot serve embeddings. The Voyage API shape was not read: UNVERIFIED.
- "OpenAI-compatible" servers: `assessment-llm-connections.md` lists `/v1/embeddings` for Ollama and LM Studio [repo]; I did not independently verify. CORS for WebView `fetch` is UNVERIFIED there; `requestUrl` bypasses CORS but is non-streaming [repo], which is fine for embeddings (whole JSON response).
- Privacy and consent: every note chunk is sent to the endpoint. The vault is encrypted for IPFS; this path sends plaintext to a third party. It needs an explicit per-provider consent and a visible lane label, and it is a security-reviewer item (D15 in the overview [repo]). It also means `model_key` must record the provider and model so Search can state which lane produced the index.
- Dimension note: `text-embedding-3-large` is 3,072 dims by default (UNVERIFIED in this session; not on the page I read). The `dimensions` parameter can reduce it (documented). pgvector's `vector` index limit is 2,000 [doc], so an unreduced 3,072-dim vector cannot use an index on `vector`.

### 3.3 Model and dimension changes: version columns

Rule: a vector is comparable only with vectors from the same `model_key`. Store the key on every embedding row and on the index job. Never mix keys in a search.

`model_key` is a stable string that includes everything that changes the numbers, for example `onnx:Xenova/all-MiniLM-L6-v2@<hf-revision>|int8|pool=mean|norm=l2|prefix=none` or `openai:text-embedding-3-small|dim=512`. Chunking also changes the vectors, so `chunker_version` is a second axis stored on `chunks`.

On a change (user picks another model, or we bump `chunker_version`):
1. Register the new `embedding_models` row. Mark it `building`; the old one stays `active`.
2. Embed in the background over the union scope. Search keeps using the old key until `coverage(new) >= threshold`, then flip `active`.
3. On a phone, do not keep both: free the old rows at flip time (database size is resident memory). On desktop, keep the old key until the user says otherwise.
4. Provide "Rebuild index" as the user action that drops the current key's rows; the UI already has the dialog (`agent-panel.html`).

## 4. Collections

### 4.1 Proposed PGlite schema

Starting point, not committed, same status as the sketches in spec 006. Differences from the 006 sketch and why:
- 006 has `files(sha256 PRIMARY KEY, path ...)`. Two notes with identical content share a sha256, and every edit creates a new sha256, so one path does not map to one key. Split content (`documents`, keyed by `file_sha256`) from location (`document_paths`, keyed by path).
- 006 has `embeddings(sha256 PRIMARY KEY, vector REAL[])`, one vector per file and a JS-side cosine. Block-level retrieval (the Notes-mode citation contract in `docs/design/vault-agent-ui-concept.md`) needs chunks. Use pgvector `vector` so the distance runs inside the engine.
- Chunk text is not stored. Chunks keep byte offsets into the file; the retrieval service reads the passage from the vault and checks it against `file_sha256`. That avoids a second plaintext copy of every note in IndexedDB and gives free staleness detection: a passage whose file now hashes differently is dropped and queued.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE schema_meta (k TEXT PRIMARY KEY, v JSONB NOT NULL);   -- schema_version, store_id, created_at

-- content identity: derived data hangs off this key
CREATE TABLE documents (
  file_sha256   TEXT PRIMARY KEY,                -- same value the sync manifest uses
  size_bytes    INT  NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- mutable location and metadata; many paths may carry one sha
CREATE TABLE document_paths (
  path        TEXT PRIMARY KEY,                  -- vault-relative, '/' separators
  file_sha256 TEXT NOT NULL REFERENCES documents(file_sha256),
  mtime       TIMESTAMPTZ NOT NULL,
  tags        TEXT[] NOT NULL DEFAULT '{}',      -- pushed by the host layer from Obsidian metadata
  props       JSONB  NOT NULL DEFAULT '{}'       -- frontmatter subset, same
);
CREATE INDEX document_paths_sha ON document_paths (file_sha256);
CREATE INDEX document_paths_tags ON document_paths USING gin (tags);

CREATE TABLE embedding_models (
  model_key  TEXT PRIMARY KEY,                   -- section 3.3
  dims       INT  NOT NULL,
  provider   TEXT NOT NULL,                      -- 'local-onnx' | 'openai-compatible'
  status     TEXT NOT NULL CHECK (status IN ('building','active','retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chunks (
  chunk_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_sha256     TEXT NOT NULL REFERENCES documents(file_sha256) ON DELETE CASCADE,
  chunker_version INT  NOT NULL,
  ordinal         INT  NOT NULL,
  byte_start      INT  NOT NULL,
  byte_end        INT  NOT NULL,
  heading_path    TEXT,
  UNIQUE (file_sha256, chunker_version, ordinal)
);

-- own table => own file under IdbFs (section 1.2)
CREATE TABLE embeddings (
  chunk_id  BIGINT NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
  model_key TEXT   NOT NULL REFERENCES embedding_models(model_key),
  vec       vector NOT NULL,                     -- dims enforced per model_key by CHECK or expression index
  PRIMARY KEY (chunk_id, model_key)
);
-- optional, desktop/Node only, after a measured threshold:
-- CREATE INDEX ON embeddings USING hnsw ((vec::vector(384)) vector_cosine_ops) WHERE (model_key = '...');

-- collections: a mirror, see 4.5 for where the source of truth lives
CREATE TABLE collections (
  collection_id TEXT PRIMARY KEY,                -- stable id, not the name
  name          TEXT NOT NULL,
  definition    JSONB NOT NULL,                  -- below
  def_version   INT   NOT NULL DEFAULT 1,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- materialised at PATH level (edits change sha but not membership)
CREATE TABLE collection_membership (
  collection_id TEXT NOT NULL REFERENCES collections(collection_id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  reason        TEXT NOT NULL,                   -- 'folder' | 'tag' | 'query' | 'pick'
  PRIMARY KEY (collection_id, path)
);
CREATE INDEX collection_membership_path ON collection_membership (path);

CREATE TABLE index_jobs (
  job_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_sha256 TEXT NOT NULL,
  model_key   TEXT NOT NULL,
  chunker_version INT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','skipped')),
  attempts    INT  NOT NULL DEFAULT 0,
  last_error  TEXT,
  queued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (file_sha256, model_key, chunker_version)
);
```

`collections.definition` (v1, JSON):

```json
{
  "v": 1,
  "include": [
    { "kind": "folder", "path": "Projects/Atlas/", "recursive": true },
    { "kind": "tag", "tag": "research" },
    { "kind": "query", "engine": "properties", "expr": "status = 'active'" },
    { "kind": "pick", "paths": ["Inbox/idea.md"] }
  ],
  "exclude": [ { "kind": "folder", "path": "Projects/Atlas/archive/" } ]
}
```

Rules: include is a union, exclude wins. The `query` kind is evaluated by the host layer with Obsidian's metadata API (SQL cannot see it) and its result is written to `collection_membership`; `folder` and `tag` could be pure SQL over `document_paths` but are materialised the same way so there is one read path. The syntax of `expr` is not designed here.

Search over a collection (exact scan, no index):

```sql
SELECT dp.path, c.chunk_id, c.heading_path, c.byte_start, c.byte_end,
       1 - (e.vec <=> $1::vector) AS score
FROM collection_membership m
JOIN document_paths dp ON dp.path = m.path
JOIN chunks c          ON c.file_sha256 = dp.file_sha256
JOIN embeddings e      ON e.chunk_id = c.chunk_id AND e.model_key = $2
WHERE m.collection_id = ANY($3)
ORDER BY e.vec <=> $1::vector
LIMIT $4;
```

The planner's choice for this join and the real latency are UNVERIFIED.

### 4.2 Comparison: one shared index vs a store per collection

| Criterion | Shared index, membership as a filter | Separate embedding store per collection |
|---|---|---|
| Storage | Each chunk embedded once. 100k chunks x 384 f32 is 154 MB regardless of how many collections `[calc]` | A note in k collections is stored k times (or needs a cross-store dedupe layer). Worst case k x 154 MB `[calc]` |
| Re-index cost on model change | One pass over the union of members | One pass per collection, so overlap is embedded again. Compute is the dominant cost on a phone `[inf]` |
| Document in several collections | One row set, several membership rows | Duplicate vectors or a reference scheme that rebuilds the shared index by another name |
| Collection edit (add folder) | Insert membership rows; embed only members with no vector for the active key | Build a new store; embed all members unless copied from another store |
| Search over two collections at once | `collection_id = ANY(...)`, one scan | Query two stores and merge by score |
| ANN filtering | Post-filter problem if HNSW is used; avoided by exact scan over the filtered set (2.4) | A per-collection HNSW is naturally "pre-filtered"; this is its one real advantage, and it matters only for large selective collections on desktop |
| IdbFs flush and memory | One embeddings file, rewritten per batch; membership and jobs live in other files | Several files if tables, or several PGlite instances if databases. Each instance adds its own WASM heap and loads all of its files `[inf from 1.2]` |
| Phone constraint | Embed only the union of the user's collections; a "whole vault" collection is opt-in | Same opt-in applies; the duplication makes the phone worse |
| Complexity | One schema, one migration path | N schemas, lifecycle per collection (create, delete, evict) |

**Recommendation: shared index, materialised path-level membership, embedding scope equal to the union of collection members.** Per-collection indexes are a later optimisation for a desktop with a very large selective collection, built as partial HNSW indexes over the same table (the `WHERE model_key = ...` form, plus a collection-specific variant if measurement ever justifies it). The operator's sentence "create embeddings for collections of documents that are defined" is satisfied: defining a collection is what brings its documents into the embedding queue.

Why path-level membership: folders, tags, picks and queries describe paths and metadata. A content-hash membership would be invalidated by every edit. At search time the join goes path to current sha to chunks, so an edited note drops out of results until re-embedded and is queued automatically.

### 4.3 Incremental indexing by content hash

1. A file event, a pull, or a startup scan yields `(path, file_sha256)`. The sync core already computes `sha256Hex` (`src/sync/hash`, imported in `exclusions.ts` [repo]) and the manifest carries `file_sha256`. Reuse that value; do not run a second hash implementation in the data layer.
2. Upsert `documents` and `document_paths`. A rename or move is a metadata change only: update `document_paths.path`, no embedding work.
3. If `embeddings` already has rows for `(any chunk of file_sha256 at the current chunker_version, active model_key)`, stop.
4. Else, if the path is in the union of collection members, enqueue an `index_jobs` row (`UNIQUE` makes it idempotent). Paths outside every collection are not embedded.
5. Worker loop: take N jobs, read the file through the vault reader port, chunk, embed in batches, insert chunks and vectors in one transaction, mark done. Honour a pause signal and a battery/foreground flag.
6. Garbage collection after each batch: delete `documents` with no `document_paths` row (cascade removes chunks and embeddings). Content-keyed storage creates an orphan per save, because every edit mints a new key `[inf]`; without GC the store grows with edit churn and the IndexedDB size-only-grows problem (#467) gets worse. GC deletes are part of the churn that issue #1068 reports; keep them off the hot path of bulk inserts.
7. Pull interaction: a pull of N notes writes N files, then each file produces an event. Smart Connections re-embeds each pulled note 13 s later and that is a CPU burst on a phone (`assessment-smart-connections.md` R8 [repo]). We should debounce and gate on the opt-in and the foreground flag, not on each event.
8. `excludesHash` and manifest hashing are unaffected: the data layer reads the vault and never writes to it.

### 4.4 Keeping derived data local (encrypted vault)

Facts from the repo:
- `DEFAULT_EXCLUSIONS` (`src/sync/exclusions.ts` lines 9-18 [repo]) contains `.trash/`, `.ipfs-sync/`, `.ipfs-sync-fixture`, `.DS_Store`, `.obsidian/`, `node_modules/`, `.git/`, `.smart-env/`. The whole `.obsidian/` folder (plugin code and `data.json`) is excluded and pull refuses it; `.smart-env/` is excluded because it is rewritten about every 13 s and its author advises against syncing it. The default list cannot be removed (DESIGN §4, line ~124 [repo]).
- A browser `idb://` store is in the WebView's IndexedDB, not in the vault tree. It cannot be published by the vault sync at all.
- For the Node CLI, a PGlite data directory is a folder. Place it under `.ipfs-sync/` (already excluded). The adapter should refuse a data directory that `isExcluded(path)` does not exclude. Named failure scenario for that guard: a user points the CLI store at a normal vault folder and the next publish uploads a plaintext derived database to a peer. This is a real trust boundary (derived plaintext leaving the device), so I count it as the standing exception in `CLAUDE.md`.
- Derived embeddings are not a different class of secret `[inf]`. Text embeddings can be inverted back to close approximations of the source text; the cited paper is "Text Embeddings Reveal (Almost) As Much As Text" (arXiv 2310.06816; title and date verified through the arXiv API, the claim summary is from my recollection of the abstract, so treat the strength of the claim as UNVERIFIED). Treat the store as exactly as sensitive as the notes: local only, never published, never in a snapshot, never in telemetry, never exported by "share diagnostics".
- No chunk text is stored (4.1). The store holds offsets, hashes, path strings, tags, frontmatter subset and vectors. Paths and tags are still plaintext metadata; list them in the security review input.

### 4.5 Collection definitions are not a cache

Spec 006's rule: "Both stores are throwaway caches... iOS can evict IndexedDB... the answer is rehydration". Embeddings, chunks, membership and jobs satisfy that: rebuild from the vault and the definitions. A user's collection definitions do not: they are authored data. If they exist only in `collections` inside `idb://`, an eviction deletes the user's work and the rebuild has no scope to rebuild.

Options (operator decision, not mine):
- A. **A file in the vault** (for example a JSON file the plugin owns, visible to sync). Definitions follow the user to a second device through the existing encrypted path. Cost: a new synced file type and a conflict policy (last-writer or merge by `collection_id`).
- B. **Plugin `data.json`** (under `.obsidian/plugins/ipfs-sync/`). Durable on the device and not subject to WebView storage eviction `[inf]`. Device-local by exclusion (`.obsidian/`, and its own `data.json` holds auth secrets per `exclusions.ts` [repo]). Putting definitions next to secrets widens what a data.json read leaks; the separate-file variant under the same folder avoids that.
- C. PGlite only, as a mirror of A or B. Allowed as a mirror, never as the source.

My lean is A for portability, with PGlite mirroring it; B if the operator wants collections kept per device. The overview's slice 03 A already says collection definition and preview "needs no index" [repo], which fits either.

## 5. Layering fit

`.claude/rules/typescript.md` [repo]: components import only hooks; hooks import stores; stores (vanilla `zustand` plus the PEM core) are the only layer that calls services; services import no React, no zustand and no stores; the sync core (`src/sync`, `src/kubo`, `src/crypto`, `src/core`) imports none of those.

Placement:
- `src/data/` (owned by data-engineer) is the **services/data layer**. It holds the `StoreAdapter` implementations (PGlite, later Surreal), the chunker, the embedding provider adapters, and the index worker. It imports no React, no zustand, no stores, and no `obsidian`.
- Everything that touches Obsidian or the vault is an **injected port**: `VaultReader` (read bytes by path), `MetadataSource` (tags, frontmatter, folder listing), `Clock`, `PowerState` (battery and foreground). The plugin host wires the real implementations. This keeps `src/data/` testable under Node 24 with the same PGlite code on `NodeFS` (spec 006: one API in WebView and Node).
- `src/data/` may import the sync core's pure helpers (`sha256Hex`, `isExcluded`); the sync core must not import `src/data/`. That is the same direction as the existing rule 5 `[inf]`; `tools/check-layering.mjs` (chat-02 task 2.1) will need a line for `src/data/`.
- The StoreAdapter interfaces are named in mvp-08's title but I found no file that defines them (`grep` over `docs` and `openspec` finds only mvp-08 README and the overview README). The shapes below are a proposal for mvp-08 to adopt or change.

Proposed adapter and service surface (TypeScript; names are mine):

```ts
// Adapter seam: one per engine, owns lifecycle and migration. No domain logic.
interface StoreAdapter {
  open(opts: { location: 'idb' | 'memory' | { nodeDir: string }; extensions?: string[] }): Promise<void>;
  close(): Promise<void>;
  health(): Promise<{ schemaVersion: number; approxBytes: number | null; ok: boolean; detail?: string }>;
  wipe(): Promise<void>;                       // "Rebuild index", eviction recovery
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (q: TxQuery) => Promise<T>): Promise<T>;
}

type Scope =
  | { kind: 'collections'; ids: readonly string[] }
  | { kind: 'vault' }                          // only if the user opted in to a whole-vault index
  | { kind: 'paths'; paths: readonly string[] };

interface SearchRequest { query: string; scope: Scope; k: number; minScore?: number; mode: 'semantic' | 'text' }
interface Passage { path: string; fileSha256: string; chunkId: number; headingPath?: string; score: number; text: string }
interface SearchResult {
  passages: readonly Passage[];
  coverage: { embedded: number; total: number; queued: number; failed: number };
  modelKey: string | null;                     // null => fell back to text
  lane: 'local' | 'remote';                    // embedding lane that produced the index
}

// What Search tab and Notes mode call (through hooks and stores, never directly)
interface RetrievalService {
  search(req: SearchRequest, signal?: AbortSignal): Promise<SearchResult>;
  retrieve(req: SearchRequest & { floor: number }, signal?: AbortSignal): Promise<SearchResult>;   // Notes mode; same, with a refusal floor
}

interface IndexService {                       // Index tab, status chip
  state(scope: Scope): Promise<IndexState>;    // counts, size, model, lastRebuilt, queue head
  subscribe(scope: Scope, cb: (s: IndexState) => void): () => void;
  embedChanged(scope: Scope, opts?: { signal?: AbortSignal }): Promise<void>;
  pause(on: boolean): void;                    // "Pause on battery"
  estimate(scope: Scope): Promise<{ chunks: number; approxBytes: number; approxSeconds: number | null }>;
  rebuild(scope: Scope): Promise<void>;        // destructive; UI shows the consequence dialog first
}

interface CollectionService {                  // slice 03
  list(): Promise<readonly Collection[]>;
  upsert(def: CollectionInput): Promise<Collection>;
  remove(id: string): Promise<void>;
  preview(def: CollectionInput): Promise<{ count: number; sample: readonly string[] }>;   // no index needed
  membership(id: string): Promise<readonly string[]>;
  cost(id: string): Promise<{ missingChunks: number; approxBytes: number; approxSeconds: number | null }>;
}
```

The `IndexState.subscribe` stream is what PGlite's live queries (`@electric-sql/pglite/live`, 11.2 KB [doc]) would back, but a plain event emitter fed by the index worker is enough for v1 `[inf]`. Whether live queries work with the `vector` type in the current version is UNVERIFIED (issue #829).

## 6. Documentation that contradicts mvp-08 (for documentation-specialist; I changed none of them)

| File and place | Says | Conflict |
|---|---|---|
| `docs/005-uar-lite-local-agents.md` lines 99-101 | "embeddings for the current snapshot were synced down with the vault... index pinned to snapshot" | mvp-08 README: embeddings must not ride the snapshot |
| `docs/005` open question 4, lines 121-127 | marked resolved by 006 | 006's resolution includes "embeddings ride the vault snapshot" |
| `docs/006-embedded-stores.md` lines 44-47 and 89-91 | "embeddings ride the vault snapshot", hydrate on pull | same |
| `DESIGN.md` section 7 (lines 199-214) | index at `.ipfs-sync/ai/index-<snapshotCID>.jsonl.zst` under the vault root | `.ipfs-sync/` is in `DEFAULT_EXCLUSIONS` (`src/sync/exclusions.ts:11`), so that path would never publish as written; also contradicts mvp-08 |
| `docs/design/vault-agent-ui-concept.md` lines 12 and 238-239; `agent-panel.html:209` and the rebuild dialog at line 242 | "Embeddings are keyed by file content and travel with the vault snapshot", "Embeddings pinned to the current snapshot..." | same; this is the "index honesty statement", so a wrong sentence there is the worst place for it |
| `docs/design/control-center.html:136` | "Changing the model re-embeds every note; embeddings for the old model are discarded" | consistent with section 3.3 on a phone; on desktop I propose keeping the old key until the new one covers enough |

Suggested replacement for the honesty statement `[inf]`: "Embeddings are built on this device from your notes' content and kept only here. They are not synced; every device builds its own. This device can rebuild them at any time; nothing here is the source of truth." If an exported or shared index is ever wanted, it is a separate, encrypted, opt-in artifact with its own size budget; it is not part of the vault tree and not designed here.

mvp-08's required-before-start items map to this document: the size budget is section 2.3 (arithmetic only); the exclusion-versus-own-store decision is "own store, per device, rebuildable, never in the snapshot" (recommended, needs the operator's recording in mvp-08).

## 7. Risks and what must be measured

### 7.1 Risks

1. **Memory on iPhone (HIGH, unmeasured).** PGlite `idb://` resident database plus WASM heap plus ONNX runtime plus model in one WebView process. Evidence of trouble: issue #408 (iOS Safari crash reports, "over 256mb" remark), Smart Connections issue #1301 (iOS relaunch loop about 8 s after Load, open, no root cause; cited as a signal only, per mvp-08). iPhone gate in mvp-08 has never been run.
2. **Eviction (MEDIUM).** WebKit best-effort storage; designed for by the cache rule, but the user-visible cost is a re-embed of the whole union. Collection definitions must not live only in this store (4.5).
3. **Shipping the WASM (MEDIUM).** 3.4 MB gz wasm plus 1.9 MB gz data plus model fetch; how the plugin loads them is open.
4. **Native dependencies of transformers.js and a dev-prerelease ORT dependency (MEDIUM).** Violates the stated constraint and the pin rule until resolved in the spike.
5. **PGlite stability (MEDIUM).** Open issues #1068 (DELETE+INSERT spin), #1085 (WebKit intermittent), #339 (out of bounds memory access, open) [doc]. Our workload is DELETE+INSERT heavy.
6. **Exact peer pin (LOW).** `pglite-pgvector` requires PGlite 0.5.8 exactly; version bumps are joint.
7. **Privacy of provider embeddings (MEDIUM).** Plaintext note chunks leave the device. Consent and lane label required.
8. **First-use network fetch (LOW to MEDIUM).** "Offline" claim holds only after a successful online first run unless the model is shipped locally.
9. **Document churn (LOW).** Content-keyed rows orphan on every save; GC is mandatory (4.3 step 6).

### 7.2 Must be measured on a real device before defaults are chosen

On an iPhone (state the model and iOS version) running the plugin in Obsidian, with a vault of realistic size and block count, and with PGlite plus the model loaded together:
1. Peak resident memory and whether the app survives: cold open, first model load, embedding 1k, 10k and 100k chunks (stop at the first kill). Record the kill point.
2. PGlite cold start (`PGlite.create` with `idb://` and `vector`) with an empty and a populated database; time to ready.
3. IndexedDB write cost per batch with the embeddings table at 10k and 100k rows; effect of `relaxedDurability`; database size on disk versus `pg_relation_size`.
4. Exact-scan search latency (p50 and p95) at 10k and 100k x 384 over the full table and over a 1k-row and 10k-row collection subset; HNSW build time, memory and size where it builds at all; recall of HNSW versus exact at the same filters.
5. Embedding throughput of the int8 MiniLM (and one alternative) on WASM and on WebGPU where exposed; batch size that stays inside memory; tokens per second; thermal throttling over a 10-minute run.
6. Whether a Worker from a Blob URL starts in Obsidian mobile and iOS, and whether PGlite runs inside it.
7. Eviction: whether the `idb://` database and the model cache survive app termination, a device restart and low-storage pressure over several days; whether `navigator.storage.persist()` returns true inside Obsidian.
8. Issue-specific probes on 0.5.8: the #1068 DELETE+INSERT churn shape, a `Maximum call stack size exceeded` check on first `CREATE SCHEMA`/`CREATE EXTENSION` (#408), live query with `vector` columns (#829).
9. On desktop and Node 24: the same PGlite code on `NodeFS`, and a bundle that contains no native module (`sharp`, `onnxruntime-node` absent from the install or aliased out).
10. Retrieval quality on a real vault sample: does the 384-dim model find what the user means; this decides whether a larger model or a provider lane is worth its cost. Not measurable by me.

Tests that belong in the data phase (not run here): schema migration up/down with a model change; membership refresh on rename, tag change and folder move; orphan GC; stale-passage rejection when `file_sha256` no longer matches the file; refusal of a non-excluded datadir; Notes-mode refusal when coverage is below a floor.

## 8. UNVERIFIED list

- pgvector version inside `@electric-sql/pglite-pgvector` 0.0.9 and therefore iterative-scan and `halfvec`/HNSW-over-halfvec availability.
- HNSW or IVFFlat build and search performance, memory and index size inside PGlite WASM at any scale; exact-scan latency at 10k and 100k x 384.
- PGlite baseline memory (WASM heap) at idle and per MB of database; behaviour of `idb://` on 0.5.8 inside Obsidian iOS and Android WebViews; whether #408, #1068, #1085, #829, #467 still reproduce on 0.5.8.
- Whether Obsidian mobile's IndexedDB is subject to WebKit eviction exactly as the WebKit blog describes for "WebKit apps", and whether `navigator.storage.persist()` helps.
- How PGlite loads its `.wasm` and `.data` inside a single-file Obsidian plugin bundle (and the esbuild issue #546).
- Whether Blob-URL Workers (needed for `PGliteWorker`) run in Obsidian mobile.
- Postgres tuple and page overhead per row; HNSW index size at 384 dims.
- Dimensions, licences and quality of `bge-small-en-v1.5`, `multilingual-e5-small`, `embeddinggemma-300m` as read from model cards (sizes were read from the Hugging Face file tree; dims and licences for the Xenova copies were not all read).
- Speed of any ONNX model in an iPhone WKWebView on WASM and WebGPU; whether WebGPU is exposed inside Obsidian's iOS WebView.
- Whether `@huggingface/tokenizers` is pure JS; a stable (non-dev) `onnxruntime-web` pin that transformers.js 4.3.0 accepts; `tract` as an alternative lane.
- Voyage AI embeddings API shape; `text-embedding-3-large` default dimensions; which "OpenAI-compatible" servers return the same shape; their CORS defaults (`assessment-llm-connections.md` also marks CORS UNVERIFIED).
- Whether `@surrealdb/wasm` 3.0.3 pairs with `surrealdb` 2.0.10 (relevant only to the graph store, not to this assessment's recommendation).
- Strength of the embedding-inversion claim (title and date verified; abstract content is from memory).
- Postgres 17.4 as the PGlite engine version (stated by the skill text; not re-read on pglite.dev).
- The planner's behaviour and latency for the path-level membership join in 4.1.

## 9. Not changed

No file other than this one was written. `docs/005`, `docs/006`, `DESIGN.md`, `docs/design/`, `src/`, `versions.toml`, mvp-08 and the other overview files were read only. No package was installed. Downloads: `pglite.wasm` and `pglite.data` to the session scratchpad for `gzip` size only; HTTP reads of documentation, GitHub issue pages, Hugging Face file-tree metadata, the arXiv API and npm registry metadata.
