# Design input: hybrid-mobile-architecture skills, DATA / PGlite / AGENT half

Written 2026-10-04 by data-engineer. Desk study only: nothing installed, no scaffold or generator run, no model run, no device used. The source repo `/Users/gqadonis/Projects/hybrid-mobile-architecture-src` was read as knowledge and not modified. `git status --short` there showed uncommitted edits to `skills/pem-local-first/references/tauri-patterns.md` (3 lines, not mine, not touched). The UI half is `design-input-hybrid-skills-ui.md` (another agent).

Source labels. `[H]` = a file in the hybrid repo, cited as `skills/<skill>/SKILL.md:line` or `references/...:line` under `/Users/gqadonis/Projects/hybrid-mobile-architecture-src`. `[O]` = a file in this repo. `[npm]` = `npm view` run 2026-10-04. `[calc]` = arithmetic. `[inf]` = my inference. `UNVERIFIED` = not confirmed in this session.

Not read: `docs/design/` (the directory does not exist in this checkout; `ls docs/design` failed), so every claim about the Notes-mode contract comes from the overview README, `decisions-needed.md` and `tasks.md`, not from the concept document. The per-slice `proposal.md` files for slices 02 to 09 do not exist yet (`ls openspec/changes` shows only `vault-agent-ui-00` and `-01`). Skill files not read: `agents/openai.yaml` of each skill, `hybrid-runtime-verification`, `content-block-ui`, `a2ui-surface-contract`, `agui-event-contract`, `references/rust/tool-governance.md`, `references/rust/inference-lanes.md`, `docs/knowme-local-first-realtime-master-plan.md` beyond a grep. `pem-local-first/references/rust-patterns.md` and `tauri-patterns.md` were read only for their persistence and lifecycle parts.

## 0. Summary

1. The skills target Tauri + Flutter + Rust apps with a Postgres server as authority. Our plugin is TypeScript + WASM in a WebView, with no server and an encrypted IPFS snapshot as the only sync. The doctrine transfers as vocabulary and checklists, not as architecture.
2. Most useful and adoptable: the client-RAG pipeline shape and its privacy rules (`skills/client-rag/SKILL.md:45-66`), the typed `Lane` enum with "reject an unknown lane loudly" (`skills/local-inference-lanes/SKILL.md:58-61`), the data-class question before every table (`skills/sync-doctrine/SKILL.md:15-31`), the governed tool sequence (`skills/agent-runtime-security/SKILL.md:11-23`), and exact pins with a rationale comment (`skills/dependency-pin-discipline/SKILL.md:13-57`).
3. Everything server-shaped is not adoptable: relational lane with server LWW, scopes with JWT tenant predicates, CDC, Electric/PES, `_operation_queue`, per-event authz (`skills/sync-doctrine/references/doctrine.md:45-72`).
4. Everything Loro/WebRTC (peer-profile-sync) is out: we have neither engine (`grep -rli "ucan\|spake\|did:key\|webrtc" src` finds nothing per the overview README) and the skill says Loro only (`skills/peer-profile-sync/SKILL.md:26-27`).
5. Hard conflict: the skills let embeddings sync by opt-in (ADR-LFS-3, `skills/client-rag/references/decisions.md:38-47`). Our rule is that embeddings never ride the snapshot (`mvp-08-sync-history-store/README.md:7`). We must close that opt-in.
6. Hard naming trap: in the skills "Vault" is the user's private profile store, not a folder of notes (`skills/client-rag/SKILL.md:59-62`). Our Obsidian vault is the whole corpus. Reusing the word imports the wrong privacy rule.
7. Version drift is large (section 3.1). Two new facts from `npm view`: `@surrealdb/wasm` 3.0.3 declares peer `surrealdb ^2.0.1`, and `surrealdb` 2.0.10 declares peer `typescript ^5.0.0 || ^6.0.0` while we pin TypeScript 7.0.2 (`versions.toml`).
8. Collection definitions: the skills' doctrine (authored data is not a cache; one source of truth per datum) supports "file in the vault as source, PGlite as mirror", with one catch: the obvious location is excluded from sync (section 2.4).
9. Conversations (new requirement): none of the five skills says anything about retention, tombstones, erasure or immutable storage (grep, section 6.1). Option B (files in a vault folder) is the only one that fits the existing encrypted sync, only as per-device append-only files, and it is irreversible once published (`DESIGN.md:404,457`).
10. Nothing here is a device measurement.

## 1. Per skill: what it prescribes, whether it applies, what must be adapted

### 1.1 client-rag

Prescribes (`skills/client-rag/SKILL.md`):
- 384 dimensions everywhere, so vectors survive cross-device sync (lines 16-18).
- Engine per tier: pgvector in PGlite on web, pglite-oxide on desktop, sqlite-vec on mobile; SurrealDB graph-RAG is an optional, benchmark-gated add-on that must not change the API or ordering when disabled (lines 18-21).
- Embeddings run on device; derived data: nullable columns, recomputable, backfilled idempotently on `embedded_at IS NULL`, not synced unless opted in (lines 22-26).
- Embed-on-write: after-commit hook enqueues an `EmbedJob` into a local queue separate from the sync queue; UI never waits (lines 28-34).
- One retrieval API, fixed pipeline: embed query, HNSW top-4k (plus BM25/FTS merged by RRF where present), dedup by source entity, `min_score` floor, recency tiebreak, cut to k and a token budget, return chunks with provenance (lines 45-54; detail in `references/client-rag.md:80-96`). Defaults k=8, `min_score` 0.3 (`references/client-rag.md:58-63`).
- No chunker pipelines for chat; split artifacts at paragraph boundaries only past about 1k tokens (SKILL:52-54; `references/client-rag.md:102-104`).
- Retrieval is read-only; agents write conclusions back as entities, never into indices (SKILL:55-57; `references/client-rag.md:93-96`).
- Privacy: `Vault`-scope chunks are class `local`, momentary prompt context only; an embedding of `local` data is `local` and lives in a separate local-only index (SKILL:59-66).
- Checklist: ingest-to-retrieve round trip on a real store, no mocks of the engine (SKILL:68-75).

Applies: pipeline order, derived-data discipline, embed-job queue separate from sync, idempotent backfill, provenance on every chunk, round-trip boundary test, "no second vector store".
Does not apply or must be adapted:
- Tiers: web row only (PGlite) applies; sqlite-vec and pglite-oxide are native. Our single tier is "PGlite in a WebView, or PGlite on Node FS in the CLI" (`docs/006-embedded-stores.md:26-27`).
- Rust `RagEngine` becomes a TypeScript service in `src/data/` behind injected ports (assessment-pglite-collections s.5, lines 128-134 of that file).
- Chunking: notes are not chat messages. Heading-aware chunks with byte offsets, no stored chunk text (assessment s.4.1), so "whole message is the chunk" does not transfer.
- "Vault" scope: see 3.2. Our scopes are collections, whole-vault (opt-in) and paths (assessment s.5).
- "Sync unless opt-in" must be removed (3.3).
- Local-only index for local-class data: we have one corpus, so the whole index is device-local, not a second index.
- Refusal: the skill has `min_score` but no refusal or grounding behaviour. Our Notes mode contract (never answer from model knowledge; refusal; citations; D10, P1) is stricter. See 2.1.

### 1.2 local-inference-lanes

Prescribes (`skills/local-inference-lanes/SKILL.md`): engine is a per-device choice, lane is a per-turn choice (15-16); every engine behind one `InferenceProvider` seam (18-20); engine table with WebLLM for web (24-30); exactly three lanes `cloud` (BYOK), `local` (row carries `model_id`, no `provider_id`), `uar` (54-56); parse lanes through a typed enum and reject an unknown lane loudly, because a silent fallback sends data off the device on the cloud lane (58-61); resumable, revision-pinned, SHA-256-verified model downloads with small files first and no partial file under the final path (84-97); RAM preflight before load, because iOS kills the process instead of throwing (99-107); red-flag table (109-120).

Applies: the typed lane enum and the loud rejection; "local is a claim the code can check" (fits D9); download discipline for the ONNX model file (our model fetch is a new design item per assessment s.3.1); a size gate before model load; "compiling proves nothing about a local lane" (121-125).
Does not apply: the engine matrix (llama-cpp-2, LiteRT-LM, MLX), JNI/Swift bridge symbols, Rust-owns-catalog, device build gates (`node scripts/android/...`). Our "mobile" is a WebView inside Obsidian, so there is one engine family (onnxruntime-web, maybe WebLLM) with a capability probe, not a per-OS engine.
Adapt: the lane set. Skill: `cloud | local | uar`. Spec 005: `local-onnx | local-webllm | remote-agui | remote-a2a` (`docs/005-uar-lite-local-agents.md:64-70`). Ours (D9): chip Local / Remote plus an Offline connectivity suffix. Mapping proposal in 2.2. RAM preflight in JS has no known API on iOS: `navigator.deviceMemory` availability inside Obsidian's iOS WebView is UNVERIFIED, so the preflight must be a conservative size table plus the mvp-08 iPhone gate, not a computed budget.

### 1.3 sync-doctrine

Prescribes (`skills/sync-doctrine/SKILL.md`): first question is which lane (relational, CRDT, append-only log) (15-24); second is privacy class `public | trusted | local`, unknown means `local`, secrets are `local`, an embedding or derived value of `local` data is `local` (26-31); seven invariants (33-44): server authority, client UUID PKs and idempotent writes, additive-only local migrations (`deprecated_at`, never destructive), local-class data never enqueues, boot order migrations then seed then loads then sync attach, one abstraction many transports, per-event authz; partial replication with scopes, versioned lookup bundles with ETag and `_load_ledger` (46-58); one durable `_operation_queue` with DEAD_LETTER visible to the user (60-65); standing rejections (67-75); thin-client fallback must keep working (74-75; `references/doctrine.md:104-110`); checklist with lane and class stated in the change description (77-86).

Applies:
- "Which lane, which class" as a mandatory sentence in every data change description. Our classes collapse to two: `published` (vault files) and `device-local` (everything in `src/data/`).
- Additive-only local migrations. This matters here because the PGlite store lives in WebView storage that can be evicted; an old device must be able to open and migrate months later. Adopt with one exception: the index is rebuildable, so a destructive migration is "drop and rebuild" and is allowed for index tables only.
- Boot order idea (migrate, then everything else) and the visible states `idle, hydrating, syncing, ready` as an `IndexState` status.
- Thin-client fallback: Search falls back to text when the store is absent, which is slice 04 A.
- `_load_ledger` idea for one-time loads such as model download.
- "No mocks of internal sync code, fake at the transport boundary" fits our round-trip boundary tests.
Does not apply: relational lane with Postgres authority and LWW, scopes with JWT predicates, bump events, CDC, `SyncTransport`, per-event authz (LFS-INV-1, -2 as server dedup, -6, -7). We have no server and no per-user tenancy; the node is an open-write IPFS node (`DESIGN.md:399-402`).
Adapt: LFS-INV-2 (client-generated ids, idempotent writes) still holds for our own local tables and the embed job queue (`UNIQUE (file_sha256, model_key, chunker_version)` in assessment s.4.1 does this).

### 1.4 anonymized-replica

Prescribes (`skills/anonymized-replica/SKILL.md:10-24`): field-classification manifest, drop unnecessary fields, deterministic scoped surrogates, preserve referential integrity, exclude free-form notes and transcripts unless a reviewed transformation exists, record source schema digest and output digest, never a production key as seed, never call a replica anonymous because names were removed.
Applies: only to test fixtures and diagnostics. Proposed uses: (a) the BDD fixture vault for retrieval tests (realistic chunk and tag distributions without a real vault); (b) a "share diagnostics" export from the Index tab, where the rule "exclude free-form notes and transcripts" and "an embedding is not anonymous" back the assessment's rule that diagnostics never contain vectors (assessment s.4.4). It is not a sync idea; we do not replicate data to other parties.
Caution: the skill is 24 lines and says nothing about embeddings or text inversion. Do not cite it for that.

### 1.5 peer-profile-sync

Prescribes (`skills/peer-profile-sync/SKILL.md`): profile data and agent-learned facts about the user live in one Loro doc synced only device to device over WebRTC, class `local`, refused by the write queue at enqueue (12-35); one doc, snapshots in `_vault_state` (37-43), version-vector delta exchange, 16 KiB frames (43-45); full mesh of the user's own paired devices with Ed25519 roster stored in the doc, untrusted signaler (46-52); momentary-context rule for cloud inference (32-35); recovery: all devices lost means the vault is gone by design, offer only user-initiated passphrase-encrypted export (60-65).
Applies, as ideas only: (a) "agent-learned facts about the user" are a distinct data class from notes and from caches; if Agent mode ever stores memory, it needs its own class and table, not the embeddings tables; (b) the recovery honesty ("tell the user honestly") fits the eviction notice for conversations (D15); (c) momentary-context rule fits Remote lane disclosure (L4).
Does not fit: Loro (`ADR-LFS-5`, `references/decisions.md:63-74`, loro-crdt 1.16.4 on npm now, not 1.13 as `versions.toml:86` says [npm]), WebRTC, pairing, roster. These are spec 003/008 territory and absent from `src/`.
Verdict: not adoptable for this phase. Do not let the phrase "never leave the user" be read as covering the IPFS snapshot: the snapshot is the user's own encrypted store, which is a different boundary.

### 1.6 persona-scoped-agent

Prescribes (`skills/persona-scoped-agent/SKILL.md:11-24`): persona is a bounded configuration, not a client-supplied role; resolve eligibility from a verified session and project policy; pin persona version, instructions, tool allowlist, retrieval scopes, model requirements, budgets; authorization lives in policy and prompt text cannot grant capability; treat retrieved content and tool metadata as untrusted; named human release for irreversible actions; record effective persona and policy revision on every run.
Applies (the strongest fit among the short skills): our Notes mode versus Agent mode is exactly a persona with a pinned tool allowlist (Notes mode: none, retrieval scopes only; Agent mode: allowlisted skills). Adopt: a `mode_profile` record with version, tool allowlist, retrieval scopes (collection ids), and budget, written onto every run row (section 6.5 `runs.profile_version`). Adopt "retrieved content is untrusted data": a note can contain prompt-injection text; Notes mode must never let retrieved text grant a tool.
Does not apply: `VerifiedSession` and tenant checks (no server, single user). Replace with "mode profile chosen by the user and stored locally".

### 1.7 agent-runtime-security

Prescribes (`skills/agent-runtime-security/SKILL.md:8-30`): app code requests a tool only through governed execution; eight-step sequence: trusted server and tool identity, JSON Schema validation, effects classified independently of MCP annotations, policy with verified actor, explicit confirmation when policy requires it, execute with idempotency id, timeout, output limit and cancellation, validate and redact the result, append an immutable audit outcome; annotations are hints, never authorization; deny unknown servers, schemas, effects and identities; test list (forged tokens, prompt injection in tool metadata, schema bypass, replay, SSRF, cancellation, output flooding, approval races, revoked keys, cross-tenant).
Applies to slice 06 approvals and the `tool_calls` table: classify effect ourselves (read / write-note / external-call / process), schema-validate arguments, require per-call confirmation for non-read effects (matches D16 item 3), idempotency id per call, timeout and output cap, redact, append an audit outcome. Test items that carry over: prompt injection in tool metadata, schema bypass, output flooding, approval races, cancellation, SSRF (a user-entered base URL, `assessment-llm-connections.md` lines 203). JWT/JWKS and cross-tenant items do not.
Caution: "immutable audit" in a local store that the user can wipe is local audit, not tamper-evident. If the log is meant as evidence it needs its own design (and would collide with retention, section 6).

### 1.8 dependency-pin-discipline

Prescribes (`skills/dependency-pin-discipline/SKILL.md`): exact pins, not floors (13-37); rationale comment is the real artifact, stating what breaks and what was tried (43-57); an analyzer-conflict set moves together or not at all (59-78); FFI pairs match exactly (80-87); one source `versions.toml`, never a version literal in a generator (89-108); raising a baseline is allowed with a fixed cost (110-118).
Applies fully, and our repo already follows it in spirit (`versions.toml` header: "Authoritative... must not edit it", `.claude/settings.json` denies Edit). Directly relevant sets: `@electric-sql/pglite` and `@electric-sql/pglite-pgvector` (the extension peer-pins PGlite to exactly 0.5.8 [npm], so they are a joint-bump set); `@surrealdb/wasm` and `surrealdb` (peer `^2.0.1` [npm]); `@huggingface/transformers` and `onnxruntime-web` (the former pins `onnxruntime-web 1.31.0-dev.20260914-8d85527a0` while npm `latest` is 1.30.0 [npm]).
Adapt: the skill's tooling (`scripts/portable/versions.mjs`, `audit.mjs doc-consistency`) does not exist here. Agents cannot edit `versions.toml`, so each pin is an operator action with the rationale comment drafted by us (tasks.md 0.5 already says so).
Note the skill's own repo breaks its rule: `versions.toml:85-88` has floors `pglite_sync = "0.4"`, `loro_crdt = "1.13"`, `sqlite_vec = "0.1"`, `flutter_webrtc = "1.4"` [H]. Treat the skill as a discipline, not as evidence that its pins are right.

### 1.9 pem-local-first (persistence and PGlite parts only)

Prescribes (`skills/pem-local-first/SKILL.md`): PEM entity graph sits at the data layer over the local store; no TanStack Query (14-21); stack per surface, Zustand holds only transient interaction state, anything durable is an entity (23-34); wiring recipe: schema first with client-UUID id, `updated_at` and declared class; `registerEntityTransport` reading the local store only and honouring `ListQuery`; `createPGlitePersistenceAdapter` plus `startLocalFirstGraph` once at the runtime boundary, reference-counted; features use hooks only (36-49); mutations write the store and enqueue (51-57); conversations are the canonical durable example: threads, messages, blocks are entities in PGlite, streaming deltas stay in Zustand until the block finalizes and then the entity write commits and embeds (67-72); checklist (74-81). Embedded-engine lifecycle: one coalesced async singleton, never check-then-act, StrictMode double-invoke as canary, no lock-file cleanup (`references/rust-patterns.md:352-363`, `docs/pglite-oxide-tauri-hybrid.md:216-303`).
Applies: (a) the conversation pattern, which matches `chat-00` decision 3 (conversations persist as entities through PGlite persistence, `chat-00-phase-overview/README.md:14`); (b) "commit on finalize, stream in memory" (our write-on-turn-complete); (c) singleton open for PGlite and Surreal, which matters in Obsidian because views can mount twice and two windows can open one vault (assessment s.1.2); implement in TS as a promise cell: `let opening: Promise<Store> | undefined; open = () => (opening ??= start().catch(e => { opening = undefined; throw e }))`; (d) hooks-only components.
Does not apply: PEM 3.x text (our pin is 4.0.2 per the overview; `versions.toml:46` in the skill repo also says 4.0.2 while `skills/pem-local-first/SKILL.md:7` and `AGENTS.md:217` say 3.x, drift inside the source repo); Rust `invoke()` and Tauri commands; the `_operation_queue`; `desktop OnceCell` code.
Adapt: the skill's layering is components, hooks, PEM/Zustand, transports, local store. Ours (`.claude/rules/typescript.md:48-65`): components, hooks, stores, services; stores call services; services import no React, no zustand, no stores. The PEM "transport reading the local store" is a service call made from a store. See section 6.7.

### 1.10 domain-glossary-service

Prescribes (`skills/domain-glossary-service/SKILL.md:8-27`): versioned vocabulary with stable ids, synonyms, status, provenance; append-only revisions with explicit deprecation; deterministic resolution; expose the glossary revision to the agent; cache only revisioned non-sensitive projections; tests for ambiguous terms, deprecated aliases, revision pinning, agent runs resumed against a newer glossary.
Applies, modestly: if collections or Agent mode ever need user vocabulary (aliases for tags, synonyms for folders), use the same shape: stable id, append-only revision, `def_version` pinned on each run. The existing `collections.def_version` column (assessment s.4.1) is the same idea. Tenant and customer-overlay parts do not apply. Not needed for v1; no table proposed.

## 2. Concrete adoptable patterns

### 2.1 RAG pipeline shape, and Notes mode refusal

Proposed stage list for `RetrievalService` (adapting `skills/client-rag/references/client-rag.md:80-96`):
1. Resolve scope to path set (collections union), per assessment s.4.1.
2. Embed the query with the same `model_key` as the index; if no active key covers the scope above a coverage floor, return `modelKey: null` and fall back to text search (thin-client fallback, 1.3).
3. Candidate search: exact scan over the scoped subset (assessment s.2.4), top-4k; optional text/FTS leg merged by RRF only if a `pg_trgm` or FTS leg exists in PGlite (the PGlite skill lists `pg_trgm` and full-text among extensions; whether they load in our bundle is UNVERIFIED).
4. Trim: dedup by chunk's source note, apply `min_score`, tie-break by recency, cut to k and a token budget.
5. Verify passages: read the passage by byte offsets, check `file_sha256`, drop stale (assessment s.4.1). This is stronger than the skill, which stores chunk text.
6. Return passages with provenance and a `coverage` record.

Compared with Notes mode (D10, P1): the skill ends at "chunks with provenance; the AGENT decides prompt placement" (`references/client-rag.md:88-91`). It prescribes no refusal and no citation contract. Our contract is stricter and must be built above retrieval, not inside it: (a) refuse when zero passages pass `min_score` or coverage is below a floor (assessment s.5 `retrieve` has a `floor`), with no model call at all, so "never answers from model knowledge" is structural; (b) the prompt contains only passages; (c) the model's output carries per-sentence markers that resolve to passage ids; the UI never infers attribution from prose (P1); (d) Quote only mode returns passages with no generation. Fixed default `min_score` 0.3 from the skill is a starting number for 384-dim cosine on MiniLM-class models, not a verified one for our notes: UNVERIFIED, measure on a vault sample (assessment s.7.2 item 10).
Persona-scoped-agent supports the structural refusal: the Notes-mode profile has an empty tool allowlist and only retrieval scopes (1.6).

### 2.2 Lanes, and how a lane is reported per turn

Skill rule to adopt: a typed `Lane = "local" | "remote"` parsed by a function with no default arm; unknown value throws (`skills/local-inference-lanes/SKILL.md:58-61,115`). The Offline state is not a lane, it is connectivity, as D9 already says. Mapping to the other vocabularies: skill `local` = spec 005 `local-onnx`/`local-webllm` = our Local; skill `cloud` and `uar` and spec 005 `remote-agui`/`remote-a2a` = our Remote (the skill's `uar` has its own embedded-library mode on mobile, `SKILL.md:56`, which our UAR-lite would be). Local-ness is checked by code (a loopback host or in-process engine), per D9; the skill's "local row carries `model_id` and no `provider_id`" (`SKILL.md:55`) becomes the `runs` shape: `lane`, `model_id`, `provider_id` nullable, never both a Local lane and a non-null `provider_id`.
Per-turn reporting: stamp the lane on the run row at dispatch (not at display), from the lane that actually executed. A fallback from Local to Remote must not happen silently: this contradicts spec 005's fallback chains (`docs/005-uar-lite-local-agents.md:72`, "`local-onnx → remote-agui`") unless the user pre-approved Remote for that mode, because the skill's reason is that silent fallback sends data off the device (`SKILL.md:60-61`). Proposed rule: fallback is allowed only to a lane the user already consented to (L4), the turn row records both the requested and the used lane (`runs.lane_requested`, `runs.lane_used`), and the chip shows the used lane. Embeddings have their own lane per index (`SearchResult.lane`, assessment s.5; `embedding_models.provider`), shown separately from the answer lane.
REST-first slice 02: the skill is consistent with it (BYOK `cloud` lane behind one seam, never the default on an unconfigured install, `SKILL.md:54`; our L3 "no default provider"). Skill gap: it has no notion of `tokenStreaming: false` or CORS; those come from `assessment-llm-connections.md` s.7.1.

### 2.3 Sync doctrine: cache versus authored data

Applying "which class, which lane" to our data (the table belongs in the data-phase change description):

| Datum | Class | Authority | Sync | Rebuildable |
|---|---|---|---|---|
| Notes | authored | vault files | encrypted snapshot (existing) | n/a |
| `documents`, `chunks`, `embeddings`, `index_jobs`, `document_paths` | derived cache | the notes | never | yes |
| Graph (SurrealDB) | derived cache | notes plus agent relation records | never in v1 (spec 006 open question 4) | yes, except agent-discovered relations |
| Collection definitions | authored | see 2.4 | see 2.4 | no |
| Provider list, consent flags, mode profiles | authored, device-local | the device | never (keys are secrets, L2) | no |
| Conversations, messages, tool calls, runs | authored (transcripts) | the device, or vault files under option B | see section 6 | no (D15, `chat-00` risk 2) |
| Agent-discovered relations ("agent:<name>" edges) | authored by an agent | not a cache: `docs/006:40-47` says the graph is rebuildable by "replaying agent relation records", which means the records are the authority | undecided | no |

The last row exposes a gap in spec 006's rule "both stores are throwaway caches": agent relation records and collection definitions and conversations are authored data that spec 006 does not give a home. The skill's lane question is what finds this.

### 2.4 Where collection definitions live (operator's open decision, C6)

Doctrine input: authored data needs exactly one authority; a cache may mirror it; the mirror must be recomputable from the authority (`skills/sync-doctrine/SKILL.md:15-24`, `skills/client-rag/SKILL.md:24-26`). That rules out "PGlite only" (assessment s.4.5 option C) regardless of where the authority sits.
Between the two real options:
- A, vault-synced file as source with PGlite mirror: follows the user to a second device through the encrypted path. Facts that constrain it: `.ipfs-sync/` and `.obsidian/` are in `DEFAULT_EXCLUSIONS` and cannot be removed (`src/sync/exclusions.ts:9-18`, assessment s.4.4), so the file must live in a normal vault folder (for example a visible folder or file) to be published. It is then plaintext on every device and visible to Obsidian. It publishes as a normal file, so edits cause a publish and add a history file (4-14 MB each for a 5,000 to 20,000 file vault, `DESIGN.md:515-517`); definitions change rarely, so this cost is small, unlike conversations (section 6). A conflict policy is needed; with a single JSON file, two devices editing it will produce a conflict copy (`DESIGN.md:157`, `646`). Mitigation from the skill's append-only lane: store definitions as one file per collection keyed by `collection_id`, with `def_version`, so concurrent edits to different collections do not conflict (this is `[inf]`; the skills do not discuss it).
- B, device-local file: no sync surface, no conflict, survives WebView eviction if it is in plugin data. `.obsidian/` is device-local and excluded (`exclusions.ts:7`). Each device defines its own collections.
Recommendation from the doctrine: the sync-doctrine "second question" asks for the class first. Collections are not secret, so they may be `published`; but the first release needs no cross-device collections (C6 reasoning), so B first and A as an additive follow-up (additive-only migrations, `SKILL.md:39`) is consistent with the skills. If A is chosen later, definitions must be excluded from any collection scope by default so the index does not embed its own definition file. I keep my earlier lean toward A for portability but accept B for release 1; this is the operator's call.

### 2.5 Anonymized replica and peer profile ideas

Only the fixture and diagnostics uses in 1.4 fit. No peer sync idea is proposed (1.5).

### 2.6 Agent runtime security checks for tool approvals (slice 06)

Adopt as a checklist for the approval path and the `tool_calls` row: effect class set by us, never taken from a tool's own annotation (`skills/agent-runtime-security/SKILL.md:22`); arguments validated against a JSON Schema before the confirmation card is shown; confirmation required for any non-read effect, per call in v1; idempotency id so a retried call after a crash is not run twice (`tool_calls.idempotency_id`); timeout, output byte cap and cancel signal on every call; result redaction before it enters a transcript or a prompt (keys, tokens); approval race: the confirmation response must name the `tool_call_id` and be single-use (state machine `proposed -> approved|denied -> running -> done|failed|cancelled`, one transition per id); tool names and descriptions are untrusted text and are rendered as text only. Test list to copy: prompt injection in tool metadata, schema bypass, output flooding, approval races, cancellation, SSRF on user-entered URLs.

### 2.7 Pin discipline for the data phase

Pins the data phase needs, none in `versions.toml` today (it holds `@noble/hashes`, `typescript`, `node` only, `versions.toml:8-11`). Candidates from `npm view` 2026-10-04: `@electric-sql/pglite` 0.5.8 (published 2026-08-26 per assessment s.1.1), `@electric-sql/pglite-pgvector` 0.0.9 with peer exactly `0.5.8`, `@surrealdb/wasm` 3.0.3 with peer `surrealdb ^2.0.1`, `surrealdb` 2.0.10 with peer `typescript ^5.0.0 || ^6.0.0`, `onnxruntime-web` 1.30.0 (latest) versus the dev prerelease `1.31.0-dev.20260914-8d85527a0` required by `@huggingface/transformers` 4.3.0 (which also depends on `sharp ^0.35.4` and `onnxruntime-node 1.30.0`) [npm]. Each needs a rationale comment, written by the owner and applied by the operator. The two joint sets are PGlite + pgvector and surrealdb + @surrealdb/wasm. No runtime test of any pairing was run here, so "pairs" means "declared peer range satisfied", not "works in Obsidian".

## 3. Conflicts and drift

### 3.1 Version pins: skills versus ours

| Item | Skills (`versions.toml`, hybrid repo) | Ours | Note |
|---|---|---|---|
| TypeScript | 7.0.2 (line 25) | 7.0.2 (`versions.toml:10`) | same |
| Node | 26.5.0 (line 23) | 24.15.0 (`versions.toml:11`) | differs; ours is engine floor in `package.json` |
| pnpm | 11.15.0 (line 28) | `packageManager pnpm@12.8.1` (`package.json`) | differs |
| vite | 8.1.5 (line 43) | 7.3.6 (`package.json`) | differs |
| React | 19.2.7 (line 44) | overview says 19.3.0, not pinned yet (README line 9) | differs, unpinned here |
| zustand | 5.0.14 (line 45) | not pinned | |
| PEM | 4.0.2 (line 46); text elsewhere says 3.x | 4.0.2 (README) | skill text drifts internally |
| PGlite | 0.5.4 (line 83) | none pinned; npm latest 0.5.8 [npm] | skill pin is stale |
| pglite pgvector | `pglite_pgvector = "0.0.5"` (line 84) | none; npm latest 0.0.9, peer pins PGlite exactly 0.5.8 [npm] | skill pin is stale; with PGlite 0.5.8 it cannot be 0.0.5 (UNVERIFIED which 0.0.x peer-pin which PGlite) |
| SurrealDB | 3.2.1 as a Rust crate with `kv-indxdb` (line 78; `references/rust/wasm-targets.md:18,62`) | JS SDK: `@surrealdb/wasm` 3.0.3 + `surrealdb` 2.0.10 [npm] | different artifact family; the embedded engine version inside `@surrealdb/wasm` is UNVERIFIED |
| Loro | `loro_crdt = "1.13"` (floor) | none; npm 1.16.4 [npm] | not used |
| embedding dim | 384 (line 89) | per model_key | see 3.3 |
| Rust toolchain | 1.97.1 (line 22) | none (no Rust in `src/`) | not applicable |

### 3.2 "Vault" means a different thing

In `client-rag` and `peer-profile-sync`, `Vault` scope is the private profile vault (`skills/client-rag/SKILL.md:59-62`; `skills/peer-profile-sync/SKILL.md:12-19`). Importing "Vault-scope chunks are momentary prompt context only, never persisted" to our notes would forbid persisting transcripts that contain retrieved excerpts, while chat-00 and D15 plan to persist them. Resolution to propose: in our docs the corpus scope is named `collections` or `notes`, never `vault`; the momentary-context rule applies to Agent-learned personal facts (if ever stored) and to the question of what a Remote provider receives (consent, L4), not to transcript storage.

### 3.3 Embeddings and sync

- Skill: embeddings default to device-local recompute but an entity type may opt its `vector(384)` column into columnar sync (ADR-LFS-3, `skills/client-rag/references/decisions.md:38-47`; `references/client-rag.md:34-37`). Ours: embeddings must not ride the snapshot (`mvp-08-sync-history-store/README.md:7`; D2, C3). No opt-in may exist. The data layer must refuse to write any store file or export under a path that `isExcluded` does not exclude (assessment s.4.4).
- Skill: "384 dimensions everywhere so vectors survive cross-device sync" (`SKILL.md:16-17`, `versions.toml:89`). Ours: no cross-device vector sync, and a provider lane can yield other dimensions (assessment s.3.2: `text-embedding-3-large` default 3,072 is UNVERIFIED in that file). Our rule is a `model_key` on every row and never mixing keys; 384 remains a sensible local default (MiniLM/bge-small class), not an invariant.
- Skill stores embeddings as a column on `messages` (`references/client-rag.md:26-32`). Under IdbFs a table is one file rewritten whole (assessment s.1.2), so a vector column on a hot table rewrites vectors on every metadata update. Keep embeddings in their own table (assessment s.4.1) and apply the same to conversations (section 6.6).
- Skill: HNSW built lazily on web with a budget of about 180 MB per 100k vectors (`references/client-rag.md:11`). Our arithmetic for 100k x 384 float32 is 154.4 MB for the vector payload alone `[calc]` (assessment s.2.3); the 180 MB figure is unsourced in the skill and I cannot say whether it includes tuple or index overhead: UNVERIFIED. Our policy (exact scan by default, no HNSW on phones, assessment s.2.4) is more conservative than the skill's.
- Skill: "no second vector store per surface; SurrealDB graph-RAG optional, disabling it must not change the API" (`references/client-rag.md:105-107`). Compatible: our SurrealDB holds the graph only. It is user-approved in `docs/006:11-17`, not optional for us, but the "API must not change when disabled" rule is still worth keeping: `RetrievalService` must work with no graph store.

### 3.4 Sync model

Skill: server is the single authority, LWW, scopes, CDC, write queue to a server (`doctrine.md:45-72`). Ours: no server; sync is an encrypted snapshot with a manifest, a sequence floor and fork resolution (`DESIGN.md:334-340`, `640-650`, section 8). The skills' standing rejection of ElectricSQL, Yjs and Automerge (`SKILL.md:67-75`) is irrelevant to us but also not a reason to adopt Loro. The skill's "No binaries through the sync engine; sync metadata, fetch payloads" (`doctrine.md:119-121`) matches our content-keyed, per-file design.

### 3.5 Rust, Node and native assumptions

The skills' one invariant puts networking, LLM, inference, MCP, agents and persistence in Rust `gen_ui_core` and forbids reimplementing them in TypeScript (`AGENTS.md:46-55`). Our constraint is the reverse: TypeScript 7 plus WASM, no native modules in `src/`. Items that assume a native or server piece and cannot be taken: pglite-oxide, sqlite-vec, `fastembed`/candle, llama-cpp-2, LiteRT-LM, MLX, JNI/Swift bridges, `tokio::OnceCell`, Tauri `invoke()`, `webrtc-rs`, Postgres 18, flint-forge, Electric, FRF/PES gateway. `@huggingface/transformers` 4.3.0 pulls `sharp` and `onnxruntime-node` as dependencies [npm], so even the nearest TS equivalent of fastembed collides with "no native modules in `src/`" (assessment s.3.1).

### 3.6 Lane fallback

Skill: reject unknown lane, no silent default (`local-inference-lanes/SKILL.md:58-61`). Spec 005: per-call fallback chains (`docs/005:72`). Resolved as in 2.2.

### 3.7 Skill claims that contradict docs/006 or mvp-08

- "Embeddings may sync by opt-in" contradicts mvp-08 (3.3). Closed by refusing the opt-in.
- "Chat messages are ordinary synced entities" (`references/client-rag.md:27`) has no counterpart here; it contradicts D15's plaintext-at-rest concern and spec 006's cache rule, which `chat-00` already flags (`chat-00-phase-overview/README.md:103`).
- Spec 006 itself still says "embeddings ride the vault snapshot" (`docs/006:44`) and the skills echo the opposite for different reasons; the revision list is in assessment s.6 and is not repeated.
- The skills do not contradict docs/006's store split (PGlite for vectors and metadata, Surreal for graph). They describe the same two stores, with SurrealDB as optional (3.3).

## 4. Proposed amendments

Slices and decisions (owner of the edit is the planning agent; I edit nothing):

| Where | Change | Reason | Source skill |
|---|---|---|---|
| decisions D9 | Add: `Lane` is a closed enum parsed with no default arm; a run stores `lane_requested` and `lane_used`; fallback to Remote only to a consented lane | A silent Local-to-Remote fallback sends note text off the device; spec 005 fallback chains allow it | local-inference-lanes `SKILL.md:58-61` |
| decisions D2 / C3 | Add: no opt-in path for syncing embeddings may exist in code; data layer refuses a store location that `isExcluded` does not exclude | The skills' ADR-LFS-3 opt-in conflicts with mvp-08 | client-rag `references/decisions.md:38-47` |
| decisions (new, name it in C) | Rename the corpus scope in all specs from "vault" to "collections/notes" where the skills' vocabulary is quoted; never reuse `privacy_class: local` for note chunks | "Vault" collides with the skills' profile-vault | client-rag `SKILL.md:59-62` |
| decisions C6 | Add the exclusion fact: `.ipfs-sync/` and `.obsidian/` never publish, so definition option A needs a normal vault folder; propose one file per collection keyed by id to avoid conflict copies; B first, A additive later | Doctrine: one authority per datum, additive migrations | sync-doctrine `SKILL.md:15-24,39` |
| decisions C2 | Add: `model_key` includes provider and model; 384 is a default, not an invariant | Provider embeddings have other dimensions | client-rag `SKILL.md:16-17` (adapted) |
| decisions D15 | Add the conversation section findings (section 6): option B irreversible after publish; skills silent on retention | Operator requirement 2026-10-04 | see section 6 |
| decisions (new) P7 | Pin set for the data phase, joint sets named, rationale comments drafted by owners | Pin discipline | dependency-pin-discipline `SKILL.md:13-78` |
| decisions (new) P8 | `@surrealdb/wasm` 3.0.3 / `surrealdb` 2.0.10 peer `typescript ^5 \|\| ^6` versus pinned TypeScript 7.0.2: resolve before the graph store lands (override, different package, or deferral) | Peer conflict [npm] | dependency-pin-discipline `SKILL.md:59-78` |
| slice 03 | Add task: collection definition store behind a `CollectionDefinitionStore` port with two implementations later (plugin-data file, vault file); PGlite `collections` is a mirror rebuilt from it | Authored data is not a cache | sync-doctrine `SKILL.md:15-24` |
| slice 04 B | Add: result carries `coverage`, `modelKey` and embedding `lane`; fallback to text when coverage is below floor | Thin-client fallback and lane honesty | sync-doctrine `references/doctrine.md:104-110` |
| slice 05 | Add: refusal is structural (no model call when no passage passes the floor); Notes profile has an empty tool allowlist; retrieved text is untrusted data | Notes mode "never answers from model knowledge" | persona-scoped-agent `SKILL.md:12-20` |
| slice 05 section 2 | Persistence is blocked on D15 and on the section 6 option choice; commit on turn complete, stream in memory | Same | pem-local-first `SKILL.md:67-72` |
| slice 06 | Add: effect class assigned by us; schema validation before the card; idempotency id; single-use approval keyed by `tool_call_id`; output and time caps; redaction | Approval path checklist | agent-runtime-security `SKILL.md:11-30` |
| slice 09 | Index tab states map to `idle, hydrating/building, ready, paused, failed`; statistics from `pg_relation_size`, not mock copy | Visible boot states; mock numbers are 8x off | sync-doctrine `SKILL.md:44` (adapted); assessment s.2.3 |
| mvp-08 | Adopt one coalesced open for PGlite and Surreal (promise cell) and a "store location must be excluded" guard; additive-only migrations except index tables | Double mount and double window; derived plaintext leaving the device | pem-local-first `references/rust-patterns.md:352-363`; sync-doctrine `SKILL.md:39` |
| tasks 0.2 | Add a spec delta to `docs/006` for authored data that is not a cache (collections, conversations, agent relation records) | Spec 006 rule has no home for them | sync-doctrine lanes |

### PGlite schema and interface amendments to `assessment-pglite-collections.md`

1. Keep `embeddings` in its own table (already so). Do not add vector columns to any conversation table (section 6.6).
2. `index_jobs`: add `scope_hint TEXT` is not needed; add `lane TEXT NOT NULL` ('local' or 'remote') so the Index tab can state which source built a row and a Remote job can be gated on consent. Reason: lane honesty (2.2). `embedding_models.provider` already exists; make `lane` derived from it and store it only on jobs for audit.
3. `embedding_models`: add `consent_ref TEXT NULL` pointing to the consent record when `provider` is remote. Reason: L4 stored per provider and mode.
4. `schema_meta`: add `migration_policy` note: index tables are drop-and-rebuild; authored tables (section 6.5) are additive-only (`deprecated_at`, no destructive migration). Source: sync-doctrine `SKILL.md:39`.
5. Interfaces: `StoreAdapter` unchanged. Add `RetrievalService.retrieve` return field `refusal?: { reason: 'no-index' | 'below-floor' | 'out-of-scope' }` so refusal is data, not prose. Add `Lane` as a closed union exported from `src/data/` with a `parseLane(x): Lane` that throws.
6. Add `CollectionDefinitionStore` port (read, write, list, subscribe) separate from `CollectionService`, as in slice 03 above.
7. Add the authored tables of section 6.5 in a separate migration file so a "Rebuild index" action cannot touch them.
8. Add a store-open guard to `StoreAdapter.open`: reject a `nodeDir` for which `isExcluded(dir)` is false (assessment s.4.4).

## 5. Which skills could later serve as executors or checklists for our agents, and caution

| Skill | Use | Caution |
|---|---|---|
| dependency-pin-discipline | Checklist when the operator pins data dependencies; reviewer prompt | It is a Markdown discipline; its tools do not exist here. It cannot edit `versions.toml` for us, and neither can our agents. |
| agent-runtime-security | Checklist for security-reviewer on slice 06 and 10; test list | Written for UAR with JWT/tenant; about half the items do not apply. A reviewer must not report the inapplicable half as "passed". |
| persona-scoped-agent | Checklist for Notes/Agent mode profiles | 24 lines; thin. Not an executor. |
| client-rag | Checklist for the data phase and for BDD scenarios (round trip, ordering contract) | Rust-shaped API and Vault naming trap (3.2). Never run any scaffold it implies. |
| sync-doctrine | Checklist: lane and class sentence in every data change | Most invariants are server-only. A reviewer applying all seven invariants would flag false failures. |
| local-inference-lanes | Checklist for lane typing and model download | Device gates are Android/iOS builds; not ours. |
| pem-local-first | Checklist for entity persistence and singleton open | Says PEM 3.x in places and prescribes `invoke()`-based paths. |
| anonymized-replica, domain-glossary-service, peer-profile-sync | Reference only | Not applicable in this phase. |

General caution: these skills carry directives such as "ALWAYS invoke" and sometimes scaffolding; the operator said to use them as knowledge. They are not authoritative over `versions.toml`, `docs/006`, `mvp-08` or `.claude/rules/typescript.md`, and the skill pack's own repo shows drift against itself (3.1). Several skills are `agents/openai.yaml`-packaged for other harnesses; I did not read those and do not rely on them.

## 6. Conversation persistence and cross-device sync

Operator requirement 2026-10-04: "persisting conversations and perhaps syncing those across devices using IPFS."

### 6.1 What the skills prescribe

- `pem-local-first`: conversations are the canonical durable example. Threads, messages and blocks are PEM entities persisted in PGlite (web) or pglite-oxide (desktop); streaming deltas live in Zustand until the block finalizes, then the entity write commits and embeds (`skills/pem-local-first/SKILL.md:67-72`). Fit: matches `chat-00` decision 3 and our local persistence; the commit-on-finalize rule is adopted.
- `client-rag`: "chat messages are ordinary synced entities (conversation thread = PEM entity)" with `embedding` and `embedded_at` columns on `messages` (`references/client-rag.md:26-32`); scopes `ThisConversation | AllConversations | AgentMemory | Vault` (`SKILL.md:51`); messages are the chunk, no splitting (`SKILL.md:52-53`). Fit: the scopes are a useful idea for a later "search my chats"; "synced entities" means server lane 1 and does not fit; embedding conversations is possible but is new scope and is a privacy-relevant derived store (a transcript can contain retrieved note text).
- `sync-doctrine`: chat data would be "relational" (server) or "append-only history" (runs, telemetry, sessions) with no merge (`SKILL.md:15-21`; `references/doctrine.md:16-20`). Agent run logs are named as the append-only lane. Writes go through the durable queue and DEAD_LETTER is user-visible (`SKILL.md:60-65`). Additive-only migrations (`SKILL.md:39`). Fit: the append-only classification of runs and tool calls fits; the queue and server do not.
- `peer-profile-sync`: sensitive user data and agent-learned facts go to a Loro vault synced device to device, class `local`, never to a server; "all devices lost: the vault is gone by design", only a user-initiated passphrase-encrypted export (`SKILL.md:60-65`). Fit: the user-facing honesty fits and matches `chat-00`'s "transcript export is the only durable copy"; the transport does not exist for us.
- `persona-scoped-agent`: record the effective persona and policy revision on every run (`SKILL.md:20-21`). Fit: adopt as `runs.profile_version`.
- `agent-runtime-security`: append an immutable audit outcome per tool call (`SKILL.md:20`). Fit as a local record; "immutable" needs care (1.7).
- Retention, tombstones, deletion, erasure, immutable storage: I searched `skills/client-rag`, `sync-doctrine`, `peer-profile-sync`, `persona-scoped-agent`, `pem-local-first` and `agent-runtime-security` for `tombstone|retention|erase|erasure|gdpr|immutab|ipfs|cannot be deleted` (grep run 2026-10-04). Hits: `agent-runtime-security/SKILL.md:20` ("immutable audit outcome") and `partial-replication.md:56` (an IPFS CID as a seed-bundle source). No skill discusses retention policy, tombstones, erasure from replicas, or the consequences of content-addressed immutability for user data. The closest guidance: lookup deletions are additive with `deprecated_at` so offline clients still hydrate (`references/partial-replication.md:69`) and Loro "compaction/shallow snapshot on save" for large docs (`references/peer-crdt.md:117`). Neither addresses erasure. This is a gap in the skills, not a settled answer.

### 6.2 Facts about our sync that decide the options

- Snapshot publish, one history file per publish that changes anything, `manifests/<16-digit sequence>-<rootCID>.enc`, pinned forever, about 4 to 14 MB each for 5,000 to 20,000 files; warn at 1,500, refuse at 1,999; `prune-history` keeps at least 20 and old roots stay pinned (`DESIGN.md:93-95,330-331,515-523`). At a 15-minute timer and a vault that changes every tick the warning arrives in about 15.6 days (`DESIGN.md:525`). The history cap counts publishes, not bytes of content.
- Precedent: `.smart-env/` is excluded because it is rewritten about every 13 s, "which would defeat the idle path and consume the history cap" (`src/sync/exclusions.ts:7`). Chat files rewritten per turn have the same shape at a lower rate.
- Per-file encryption; a rename re-encrypts and re-uploads the whole file (`DESIGN.md:323`). Whether an appended-to file re-uploads wholly or by segment: UNVERIFIED (blobs are written "per segment" above 32 MiB, `DESIGN.md:331`, but segment reuse across versions was not read).
- Conflict handling: pull makes `name (ipfs conflict YYYY-MM-DD)` copies and never deletes local files (`DESIGN.md:157`); fork resolution without an ancestor turns every differing file into a conflict copy (`DESIGN.md:646`). Single-writer-per-file is stated acceptable (`DESIGN.md:856`).
- The sequence floor protects against downgrade of encrypted manifests, not against a node showing an old copy to a device without a floor (`DESIGN.md:446-447,577`).
- Exclusions: `.obsidian/` and `.ipfs-sync/` never publish and pull refuses `.obsidian/` (`exclusions.ts:7,9-18`). The PGlite `idb://` store is in WebView storage, outside the vault tree, and cannot be published (assessment s.4.4). Embeddings never publish.
- Immutability: "Old roots stay pinned and fetchable forever; this project never unpins" (`DESIGN.md:404`). The vault content key never rotates; rewrap does not revoke the old passphrase or any old copy of the key slot; a leaked passphrase exposes every state ever published (`DESIGN.md:425-427,457`).
- Mass-removal guard: removing 49 percent of entries is silent; more asks for confirmation (`DESIGN.md:558-567`). A bulk "delete all conversations" that removes many published files could trip it; threshold semantics beyond that line were not read.

### 6.3 Options

**A. Local-only entity persistence in PGlite.**
- Doctrine fit: matches `pem-local-first` (conversations as entities in PGlite) and `sync-doctrine` class `device-local`; additive-only migrations apply; the store is not a cache (D15), so it needs the eviction notice that `chat-00` risk 2 already requires and the honest-recovery framing of `peer-profile-sync` (`SKILL.md:60-65`).
- Cost: nothing enters the publish tree; no history growth; no conflict handling; layering fits (6.7). Risk: WebKit best-effort eviction deletes the database (assessment s.1.2); iOS limits; the open PGlite bugs listed there apply to this workload. Mitigation: separate file/table from the embeddings; `navigator.storage.persist()` untested inside Obsidian (UNVERIFIED); an export to a note (Save as note, D6) is the durable copy.
- Delete is real: wiping the local row removes the data from the device. Retention and erasure are fully under the user's control.
- Cross-device: none. A second device has an empty history.

**B. Conversations as files in a dedicated vault folder, carried by the existing encrypted sync.**
- Doctrine fit: it uses the one existing sync rail, as `sync-doctrine` would require ("one abstraction", `SKILL.md:41-43`), and the append-only lane for runs (`SKILL.md:21`). It does not fit the skills' privacy rule for profile data (plaintext file on device; Obsidian can index it) and conflicts with `chat-00` D15 until ruled.
- Format (proposal, `[inf]`): one append-only JSON Lines file per conversation per device, path `Chats/<conversation_id>/<device_id>.jsonl`, each line a self-describing record (`type`, `id`, `ts`, `seq`, payload), UUIDs generated on the device (adopts LFS-INV-2 idempotent replay). Readers merge all device files of a conversation by `(ts, device_id, seq)`. Single-writer-per-file means two devices never edit the same file, so a pull sees no conflict copy and a fork leaves each device's file identical or purely newer (`DESIGN.md:646,856`). A conversation index (title, last turn) is derived into PGlite on read, not a synced file, so there is no shared mutable index to conflict.
- Write-on-turn-complete debounce: write one batch of lines when a turn reaches `done`, `error` or `cancelled`, never per token; coalesce idle turns to no more than one write per N seconds (N is a proposal; a number comes from measurement, not from this study). Writing is by the vault adapter inside the host layer, behind a port.
- History growth: each change to a published file creates a publish and one 4 to 14 MB history file; the debounced auto-publish and the existing 1,500 warning count chat edits too, so an active chat user can burn the cap in weeks. This is the `.smart-env/` failure shape at lower frequency (`exclusions.ts:7`). Options inside B: (i) conversation files are published only on the user's manual publish or on a long idle timer (a product decision, not mine); (ii) rotate files per day or per N KB so changes land in small new files rather than rewriting a large one (whether rewriting costs more is UNVERIFIED, 6.2); (iii) a separate retention action that moves old conversations into a archive file.
- Other consequences: the folder is plaintext on every device and in Obsidian's own search and graph if the files are Markdown; a `.jsonl` extension may hide them from the file explorer (UNVERIFIED); any collection that includes the folder, and the "Whole vault" collection offered in C4, would embed the transcripts, which are derived from model output plus retrieved excerpts. The folder must be excluded from collections by default, enforced in `CollectionService`, not by convention. Obsidian Sync or another sync tool the user runs would also carry it (like `.smart-env/` comments, `exclusions.ts:7`).
- Immutability: see 6.4.
- Cross-device: yes, through pull; latency is one publish plus one pull.

**C. A separate append-only op-log or CRDT published as its own encrypted record.**
- Doctrine fit: the closest to `sync-doctrine`'s append-only lane and `peer-profile-sync`'s idea of a dedicated doc, with the skills' reasons for not putting it into the main sync (different lifecycle, class, size). It fits `sync-doctrine`'s "CRDT only for collaboration or user-owned data" (`SKILL.md:23-24`); the skills' CRDT is Loro only (`ADR-LFS-5`), and Loro-over-IPFS is not designed anywhere. An op-log without a CRDT needs no merge (append-only, per-device logs, merge on read) and is what option B's per-device files already are, only moved out of the vault tree.
- Cost: needs its own record and publication path beside the manifest chain: its own sequence and floor, its own fork rule, its own key handling, its own pin and history policy, and a decision on the IPNS name or the manifest field that points to it. None exists in `src/`. This is a new sync feature in the code the 07b review chain has frozen (C6 reasoning). The skills give no design for it; `DESIGN.md:181-198` is a sketch (Phase 2) that says "not yet final".
- Benefit: it keeps transcripts out of the plaintext vault tree and out of the manifest history cap, and it can be published on its own cadence. It still ends in immutable, never-unpinned objects.
- Verdict: a follow-up design, not a v1 option. UNVERIFIED how a second encrypted record would interact with `prune-history`, the mass-removal guard and the sequence floor, which were designed for one manifest chain.

Evaluation against the doctrine in one line each: A is the doctrine-clean default (class device-local, no sync question). B is the only option that fits the existing encrypted sync, but it converts chat into published, immutable, plaintext-on-device data and consumes the history cap. C is the right shape if cross-device chat becomes a real requirement, and is unbuilt. My recommendation: ship A for the first release; define B's format now (so the schema is sync-ready: UUID ids, device id, per-device sequence) and decide B or C after D15 and after measuring publish churn on a real vault. Keeping the PGlite schema sync-ready costs nothing and does not publish anything.

### 6.4 The immutability caveat

A conversation that has been published once cannot be erased. Facts: old roots stay pinned and fetchable forever and this project never unpins (`DESIGN.md:404`); `prune-history` only removes history files from the current working tree, "Old roots stay pinned with their history" (`DESIGN.md:518`); the vault content key never rotates and a rewrap does not revoke the old passphrase or any old key-slot copy (`DESIGN.md:425-427,457`); other nodes that fetched or pinned an old root keep it (the node is open-write and its gateway serves objects to anyone who knows a root CID, `DESIGN.md:399-402`). So: deleting a conversation file locally publishes a removal in the next root, and every earlier root still contains the encrypted file, readable by anyone holding the passphrase and an old root CID; a prune does not change that. The only recovery named in the repo is "re-encrypting the vault" (`DESIGN.md:427`), which is a new vault, not an erasure of old roots. The skills say nothing about this (6.1). Required product statements if B or C ships: (1) before the first publish of a conversation, a plain statement that publishing is permanent; (2) per-conversation opt-in to sync, default off; (3) the Wipe local stores action must say it does not remove published copies. Under A none of this applies. Whether provider-side retention also applies is the L4 consent text, unrelated to IPFS.

### 6.5 Proposed PGlite schema additions (authored tables, separate from the embeddings tables)

Starting point, not a commitment, same status as the other sketches. Separate migration file from the index tables; additive-only (no `DROP`, no destructive `ALTER`, retire with `deprecated_at`); never touched by "Rebuild index". All ids are client-generated UUIDs. Retrieval for chat, if ever added, would use its own tables, not these.

```sql
CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY,                 -- uuid, minted on the device
  mode            TEXT NOT NULL CHECK (mode IN ('notes','agent')),
  title           TEXT,
  default_scope   JSONB,                            -- collection ids; default collection per chat (slice 05)
  profile_version INT  NOT NULL,                    -- mode profile pinned at creation (persona-scoped-agent)
  origin_device   TEXT NOT NULL,
  sync_state      TEXT NOT NULL DEFAULT 'local'     -- 'local' | 'publish-opt-in' (only if B or C is chosen)
                  CHECK (sync_state IN ('local','publish-opt-in')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deprecated_at   TIMESTAMPTZ                       -- soft delete; hard delete is a separate user action
);

CREATE TABLE runs (                                  -- one per assistant turn dispatch; append-only
  run_id          TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  lane_requested  TEXT NOT NULL CHECK (lane_requested IN ('local','remote')),
  lane_used       TEXT NOT NULL CHECK (lane_used IN ('local','remote')),
  model_id        TEXT NOT NULL,
  provider_id     TEXT,                              -- NULL iff lane_used = 'local'
  profile_version INT  NOT NULL,
  scope           JSONB NOT NULL,                    -- collections or paths used
  index_model_key TEXT,                              -- embedding key used for retrieval, if any
  status          TEXT NOT NULL CHECK (status IN ('running','done','error','cancelled','interrupted')),
  refusal         TEXT,                              -- 'no-index' | 'below-floor' | 'out-of-scope' | NULL
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  CHECK ((lane_used = 'local') = (provider_id IS NULL))
);

CREATE TABLE messages (                              -- append-only; an edit is a new row with supersedes
  message_id      TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  run_id          TEXT REFERENCES runs(run_id),      -- NULL for user messages
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  device_id       TEXT NOT NULL,
  device_seq      BIGINT NOT NULL,                   -- per-device counter, for merge by (ts, device, seq)
  parts           JSONB NOT NULL,                    -- typed parts; text and sentence-marker structure
  supersedes      TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  UNIQUE (device_id, device_seq)
);
CREATE INDEX messages_conv ON messages (conversation_id, created_at);

CREATE TABLE message_citations (                     -- passage markers the UI resolves; never inferred from prose
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  sentence_ix INT NOT NULL,
  path       TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  byte_start INT NOT NULL,
  byte_end   INT NOT NULL,
  PRIMARY KEY (message_id, sentence_ix, path, byte_start)
);

CREATE TABLE tool_calls (                            -- append-only state log; one row per transition
  tool_call_id   TEXT NOT NULL,
  transition_seq INT  NOT NULL,
  run_id         TEXT NOT NULL REFERENCES runs(run_id),
  tool           TEXT NOT NULL,
  effect_class   TEXT NOT NULL CHECK (effect_class IN ('read','write-note','external','process')),
  state          TEXT NOT NULL CHECK (state IN ('proposed','approved','denied','running','done','failed','cancelled')),
  idempotency_id TEXT NOT NULL,
  args_redacted  JSONB,                              -- after redaction; never raw secrets
  result_redacted JSONB,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tool_call_id, transition_seq)
);
```

Notes: (a) `message_citations` stores offsets and hashes, not text, matching the no-stored-chunk-text rule (assessment s.4.1); a citation whose `file_sha256` no longer matches is shown as "note changed" instead of a stale quote. (b) `messages.parts` holds model output and may hold pasted or retrieved text; that is the D15 content class and must never contain a key or a provider secret (L2, assessment s.7.5). (c) The `device_id` and `device_seq` columns exist now so option B or C can later write per-device logs without a migration; they publish nothing. (d) These are authored, not rebuildable, tables, so `health()` must report them separately from the index and the Index tab's "Rebuild" must not list them (D15 copy). (e) Eviction of the WebView store loses them; the notice is part of slice 05 section 2. (f) Whether to embed conversations is not proposed; if later, it needs its own `embeddings`-style table keyed by `message_id` and model key and the same device-local rule.

### 6.6 Why separate from the embeddings tables

IdbFs rewrites a whole table file on change (assessment s.1.2). Messages and tool-call transitions change every turn; the vector file changes only on embed batches. Keeping them in separate tables (separate files) keeps each rewrite small. The skill puts an `embedding` column on `messages` (`client-rag/references/client-rag.md:26-32`); we do not.

### 6.7 How the Layering rule applies

`.claude/rules/typescript.md:48-65`: components import only hooks; hooks import stores and PEM hooks, not services; stores (vanilla `zustand` plus PEM core) are the only layer calling services; services import no React, zustand or store; the sync core imports none of them.
- Services (`src/data/`): `ConversationRepository` (create, append message, record run, record tool-call transition, list, soft delete, hard delete, export-to-note payload) over `StoreAdapter`. It imports no React, no zustand, no stores, no `obsidian`. Vault writes for B (the per-device `.jsonl` files) go through an injected `VaultWriter` port that the plugin host implements, exactly like `VaultReader` and `MetadataSource` (assessment s.5). The sync core never imports `src/data/`; `src/data/` may import `sha256Hex` and `isExcluded`.
- Stores (the chat stores, vanilla zustand, location per P6): hold the in-flight stream buffer (transient) and call `ConversationRepository` on turn completion; they alone call the service. PEM entity types for message, run, tool call, conversation register a transport whose read path calls the same store action, not the service directly.
- Hooks: `useConversation(id)`, `useRun`, `useToolApprovals` import stores and PEM hooks.
- Components render and submit intent only; no component writes to PGlite or to a vault file.
- `check-layering` (chat-02 task 2.1) needs one edge added for `src/data/` as noted in assessment s.5. The write-on-turn-complete debounce is store logic calling a service, not a service timer reaching into a store.

## 7. Could not verify

- Everything on a device (memory, speed, eviction, Worker support, WebGPU, streaming).
- Which `@electric-sql/pglite-pgvector` 0.0.x versions peer-pin which PGlite versions, and the pgvector version inside 0.0.9; I checked only the 0.0.9 peer pin [npm].
- Whether `@surrealdb/wasm` 3.0.3 with `surrealdb` 2.0.10 runs in Obsidian, which SurrealDB engine version is embedded, and how the peer `typescript ^5 || ^6` behaves under TypeScript 7.0.2 (declared peers only; no install was run).
- Whether `pg_trgm` and FTS load in the PGlite bundle we will ship.
- `navigator.deviceMemory` or any RAM probe inside Obsidian iOS.
- Whether an appended-to published file re-uploads whole or by segment; the mass-removal threshold beyond the 49 percent line; whether `.jsonl` files are visible in Obsidian; how a second encrypted record would interact with prune, floor and the guard.
- The concept document and slice proposals (not in this checkout).
- The source of the skill's "about 180 MB per 100k vectors" figure and its `min_score` default 0.3 against our notes.
- The embedding-inversion claim strength (inherited unverified from the assessment).
- Contents of the skills' `agents/openai.yaml`, `hybrid-runtime-verification`, `references/rust/tool-governance.md` and `inference-lanes.md`.
