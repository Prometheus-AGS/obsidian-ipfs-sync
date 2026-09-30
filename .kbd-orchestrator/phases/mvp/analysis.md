# Analysis — Phase `mvp`

Date: 2026-09-29 · Driver: kbd-analyze · Status: **complete, adversarially vetted (see `review/`)**

Input: `assessment.md` (gaps G1–G6 map to phase goals 1–6), `docs/011-mvp-decisions.md`
(operator answers to all six open questions), `docs/010-agentic-ui-rendering.md`
(UI contract, future-phase input only). Research budget: 8 queries/tier, 20 min
(registry + GitHub tiers only; stack is *specified*, not discovery mode — no
stack-tier queries needed). ~16 queries used.

## Landscape by gap

### G1 — Cross-platform Node 24+ CLI (goal 1)

The migration map in docs/001 is fully specified; the only research question was
toolchain versions, not libraries. Findings:

- **pnpm 12.8.1** current; adopted via corepack per spec 011 Q1. ✔
- **Vitest 5.0.2** (2026-09-25, active) over `node:test` — assessment flagged
  lightest-runner as a preference, but spec 011 Q2 (operator) settled vitest
  for watch/UI ergonomics across the 2h cadence loop. Vitest 5 requires
  Vite 7+; repo currently pins Vite 6 — bump together.
- **esbuild 0.28.2** (repo pins ^0.25.0 — bump).
- No library candidates for the CLI itself: `fs.cp`, `fetch`, URLSearchParams,
  tar reader are all platform/node builtins or small TS we write. Tar reading
  stays pure-TS for MVP (WASM deferred per docs/003).
- **Tar write**: MVP publish writes per-file `files/write` into MFS (spec 011
  Q3), so no tar writer is needed on the publish path at all. Tar *read* is
  needed only for the legacy pull-back path and the disaster-recovery CAR
  import story — candidate `@ipld/car` below.

Verdict: G1 is a **build** item, not a library gap. Toolchain version bumps
land in the first iteration.

### G2 — Delta sync: manifest + persistent MFS tree (goal 2, largest work item)

Three sub-problems: (a) fast local change detection, (b) per-file publish with
chunking, (c) MFS tree management against our kubo node's RPC quirks.

- **(a) Change detection**: no candidate — sha256 via WebCrypto in both runtimes
  (plugin WebView and Node 24 both expose it). Build item.
- **(b/c) kubo RPC client**: `kubo-rpc-client` **7.1.0** (2026-06-09; repo
  `ipfs/js-kubo-rpc-client` active, pushed 2026-08-10, not archived; maintainers
  Protocol/lidel). **Decisive compatibility evidence**: the client's source
  encodes all API arguments as URL search params (`src/lib/to-url-search-params.ts`),
  which survives our proxy's quirk of dropping form-encoded args. ADOPT as the
  base of the shared `src/rpc/` module. One behavior to verify at plan time:
  whether its `files/write` call names the multipart file field `data` as our
  proxy requires; if not, wrap just that call — the wrapper lives in our module
  either way, keeping the quirk in exactly one place (assessment risk 1).
- **CAR export/import for >32MB files + disaster recovery**:
  `@ipld/car` **5.4.7** (2026-07-30, active) for CAR encode/decode; `ipfs-car`
  3.1.0 (2025-10) considered but the lower-level `@ipld/car` gives us control
  without its CLI assumptions. ADAPT: use `@ipld/car` inside our own exporter.
- Chunking (8MB parts, reassemble on pull) is our code — no library fits the
  MFS-layout contract from DESIGN §4.

Verdict: shared client = ADOPT `kubo-rpc-client` + thin wrapper; delta diff
engine, manifest schema, chunking = **build**.

### G3 — Shared RPC client consumed by plugin and CLI (goal 3)

Follows from G2: `src/rpc/` with zero Obsidian imports; plugin IO injected.
esbuild bundles it for Obsidian's WebView; Node 24 imports it directly (pure
TS, no node-only deps in the shared module — verified as a constraint on
candidate selection: `kubo-rpc-client` is runtime-agnostic fetch-based, safe).

### G4 — WebView safety + conflict policy (goal 4)

No library work. The per-file `files/write` pool from G2 fixes the monolithic
FormData hazard; conflict policy (remote wins, dated local copy) is ported
verbatim from the working Phase-1 code. Pull path moves from whole-tar
ArrayBuffer to per-file ranged reads streaming to disk.

### G5 — Framework seams (goal 5)

All three seams are **build** items (typed TS interfaces + one in-memory
implementation), deliberately library-free so future phases don't inherit a
dependency:

- `EventBus` — typed events (`publish.complete`, `pull.complete`, `conflict`,
  `file.changed`); single-producer in-memory; spec 007 record emission and
  spec 006 indexing subscribe later without interface churn.
- `HostBridge` — the `fs_*/net_*/kv_*/agent_*` surface from specs 005/008,
  declared now, stub implementation; Phase-2 WASM plugs into the frozen
  interface.
- `StoreAdapter` — vector/graph/metadata interfaces per spec 006.
  **Operator decision (2026-09-29, superseding the assessment's "no-op
  adapter" note): MVP ships a real PGlite adapter** — `@electric-sql/pglite`
  **0.5.8** (2026-08-26, active, Electric team). ADOPT for **metadata +
  sync-state storage immediately** (extension set in the shipped contrib
  list confirmed for core Postgres). **Vector columns are conditional**:
  adopt only after pgvector availability in the 0.5.8 contrib set is
  verified at plan time (pglite docs list vector among contrib extensions —
  confirm against 0.5.8); if unconfirmed, the adapter ships metadata-only
  and vector storage lands the moment it is verified, with no interface
  change. The graph adapter (SurrealDB WASM) is explicitly deferred to a
  later phase.

### G6 — E2E harness + real 1 GB publish (goal 6)

Harness = vitest fixture test (template: the shell-script bring-up run —
publish → resolve → pull → conflict check), pointed at the staging kubo node.
The 1 GB real publish uses the new pipeline end-to-end; the interrupted
bring-up staging at `/obsidian-vault-sync/publish-real-20260929` on the node
is disposable (plan confirms with a node listing, then ignores it).

## Security-landscape notes (from assessment's merged research, not re-researched)

- **UCAN**: `@ucanto/core` 10.4.6 + `@ucanto/principal` 9.0.3 (Apache-2.0 AND
  MIT, 2025-10) — ADOPT when token gating lands; confirms spec 011 Q6's pick is
  maintained.
- **SPAKE2**: `@noble/curves` **2.4.0** (2026-08-27, active) — ADOPT as the
  curve backend; the SPAKE2 protocol state machine itself is a small build item
  (~300 LOC, RFC 9382) rather than a dependency (spec 011 Q6).
- **Key storage** (spec 011 Q4): `@napi-rs/keyring` **2.1.0** (2026-09-13,
  active, prebuilt napi binaries — cross-platform incl. Windows) preferred over
  `keytar` 7.9.0 (2025-07, maintenance mode, native build pain on Windows).
  ADOPT `@napi-rs/keyring` for the Node CLI; the Obsidian plugin keeps
  plugin-data/machine-key storage with a warning (spec 011 Q4), Capacitor
  Keychain/Keystore on mobile in a later phase. **Placement rule (review
  finding, plan constraint)**: `@napi-rs/keyring` is a native N-API module and
  must live in a Node-only CLI package/path that is never imported by plugin /
  WebView code and never enters the esbuild plugin bundle — the shared `src/rpc/`
  module must stay free of native and Node-only dependencies.
- **didcomm-node 0.4.1 — STALE** (last modified 2023-05). DIDComm is
  post-MVP anyway; **flag**: re-evaluate the messaging layer (and
  alternatives) at that phase rather than adopting a dormant package now.

## Version bumps to land in iteration 1

| Package | Repo pin | Current | Note |
|---|---|---|---|
| `obsidian` (types) | ^1.9.9 | 1.13.1 | types only |
| `esbuild` | ^0.25.0 | 0.28.2 | |
| `vite` | 6.x | 7.x | required by vitest 5 |
| `vitest` | — (none) | 5.0.2 | new |
| `pnpm` (corepack) | — | 12.8.1 | via packageManager field |

## Cadence slicing guidance for /kbd-plan (operator framing: 2h usable iterations, publish every 4–6)

> Note: the `delivery-cadence` skill was not found on disk at analyze time;
> the slicing below applies its described intent (usable delivery per
> iteration, build-and-run checkpoints, evidence-based learning) from the
> operator's instruction, and should be confirmed/replaced by the skill's
> own rules when it is installed.

Proposed iteration skeleton — every iteration ends with something runnable or
verifiable, and each has a build-and-run checkpoint (type gate + tests green
before the next slice starts):

| # | Slice (2h) | Demoable outcome |
|---|---|---|
| I1 | pnpm workspace scaffold, Vite 7 + TS7 + vitest 5, CI type/test gate | `pnpm test` green on empty suite; repo builds |
| I2 | Shared kubo client wrapper (`src/rpc/`) incl. quirk tests against staging node | live smoke: add + files/write round-trip from Node |
| I3 | Manifest diff engine (sha256 walk, exclude unify, manifest v1 schema) | unit tests: synthetic vault → correct diff/changed sets |
| I4 | CLI publish: per-file write pool → staging MFS + `current/` repoint | real small vault published via CLI only |
| I5 | CLI pull: delta fetch, conflict policy (remote wins, dated copy) | publish → edit → pull round-trip on staging; **release v0.2.0** |
| I6 | Plugin publish path reuses shared client (delete `ipfsRequest`) | plugin publishes from Obsidian desktop |
| I7 | Plugin pull path + conflict policy port | full sync loop inside Obsidian; **release v0.3.0** |
| I8 | PGlite StoreAdapter + event bus wiring (real events → store) | events persist; queryable metadata after a sync |
| I9 | E2E fixture harness (vitest): publish → resolve → pull → conflict | `pnpm test:e2e` green in CI |
| I10 | Real 1 GB vault publish through the new pipeline | goal 6 met; **release v0.4.0** |

**Publication cadence recommendation**: tagged releases after I5 (first usable
CLI), I7 (first usable plugin), and I10 (all goals) — i.e. roughly every
4–5 iterations, inside the operator's 4–6 window. `/kbd-plan` should confirm or
adjust this; if an iteration overruns 2h, the slice — not the checkpoint — is
what gets cut (defer the remainder to the next iteration rather than dropping
the run gate).

## Risks carried to plan

1. `kubo-rpc-client` `files/write` multipart field name must match our proxy
   (`data`); verified at I2 with a live call before I3 builds on it.
2. PGlite + pgvector extension availability pinned at I8; if vector is not in
   the shipped contrib set for 0.5.8, metadata-only adapter first, vector
   columns added when confirmed (interface already allows it).
3. Vite 7 bump may surface esbuild-obsidian plugin config drift — I1 owns it.
4. Staging MFS tree from the interrupted bring-up (`publish-real-20260929`) is
   disposable; confirm-and-ignore at plan, don't design around it.
