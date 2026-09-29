# Assessment — Phase `mvp`

Date: 2026-09-29 · Driver: kbd-assess · Status: **draft pending security research integration**

## Phase goals (from goals.md)

1. Replace shell scripts with cross-platform Node 24+ CLI (specs 001, 004)
2. Delta sync: manifest + persistent MFS tree, mobile-safe publish / delta pull (DESIGN §4)
3. One shared kubo RPC client consumed by plugin and CLI
4. Plugin stays WebView-safe; conflict policy unchanged
5. Framework seams for future phases: event bus, host-bridge interface, store adapters
6. E2E fixture test green; real 1 GB vault published via the new pipeline

## Current state inventory (verified by scan)

| Asset | State | Notes |
|---|---|---|
| `src/main.ts` (426 LOC) | Phase-1 snapshot sync | publish = single monolithic FormData (mobile memory hazard); pull = whole-tar download + ArrayBuffer; conflict policy correct (remote wins, dated local copy) |
| `scripts/publish.sh` / `pull.sh` (102 LOC) | Exercised E2E during bring-up (fixture run: publish → resolve → pull → conflict check); no committed test evidence — no harness, no logs | Shell + `rsync` + `curl` + `python3` — all disqualifying per specs 001/004; macOS-only behaviors already hit (bash 3.2, openrsync) |
| `manifest.json` + built plugin | Installed in host vault `/Users/gqadonis/obsidian/.obsidian/plugins/ipfs-sync/` (verified on disk; not part of the repo packet) | v0.1.0 |
| Node RPC client shared module | **Does not exist** — plugin has `ipfsRequest()` private method; scripts shell out to curl | Goal 3 gap |
| Manifest / delta sync | **Does not exist** | Phase 1 = full snapshot per publish; no `.ipfs-sync.manifest.json`; timestamped MFS staging dirs, not the persistent `current/` tree |
| Exclusion handling | Exists in both paths | duplicated logic (plugin setting + `excludes.txt`) — must unify in the shared module |
| Test suite | **None** (no runner, no tests) | `test_command: null` in project.json; goal 6 needs at minimum an E2E fixture harness |
| Framework seams (event bus, host bridge, store adapters) | **None** | Goal 5 is greenfield |
| Security posture | RPC endpoint unauthenticated (verified during bring-up); bearer-token plumbing present but unused; leaked OpenAI key in vault noted | See "Security" below |

## Spec context (canonical inputs)

- `DESIGN.md` §4 (Phase 1.1 delta sync spec: MFS layout, manifest schema, publish/pull behavior)
- `docs/001` (Node 24+ runtime, Windows rules, migration map)
- `docs/004` (no-Python; enforcement constraint to add)
- `docs/003/005/006/008/009` (future phases — inform seam design only, **not** MVP scope)
- `docs/007` (records — event bus seam should accommodate record emission)

## Gap analysis per goal

**Goal 1 — Node CLI:** Full gap. Nothing exists. Migration map is fully specified
in docs/001 (rsync→`fs.cp`, curl→fetch, python3→URLSearchParams/JSON, tar→TS
reader or WASM-later). Acceptable simplification for MVP: pure-TS tar reader
(WASM deferred to its own phase per docs/003).

**Goal 2 — Delta sync:** Full gap. DESIGN §4 specifies the persistent
`/obsidian-vault-sync/current` MFS tree + manifest schema v1; none implemented.
Fast-change detection (sha256 via WebCrypto) also missing. This is the largest
work item.

**Goal 3 — Shared RPC client:** Architectural gap. The plugin's `ipfsRequest()`
is correct re: proxy quirks (query-string args); the Node CLI must reuse it.
Shared module must live where both esbuild (plugin) and `node` (CLI) can import
it — `src/rpc/` with no Obsidian imports; plugin's vault-dependent parts stay in
`src/main.ts` and inject IO.

**Goal 4 — WebView safety + conflict policy:** Partially met. Policy is right
and tested; the publish path violates WebView memory rules (monolithic
FormData). Fix falls out of Goal 2's per-file write pool.

**Goal 5 — Framework seams:** Greenfield. MVP-defensible minimum:
- `EventBus` (typed events: `publish.complete`, `pull.complete`, `conflict`,
  `file.changed`) — single producer/consumer, in-memory; spec 007 records and
  spec 006 indexing subscribe later.
- `HostBridge` interface (TS types only): the `fs_*/net_*/kv_*/agent_*` surface
  from specs 005/008, declared but with only a stub implementation — so Phase-2
  WASM work plugs into a frozen interface.
- `StoreAdapter` interfaces (vector/graph/metadata) behind which specs 006's
  PGlite/Surreal implementations land later; MVP ships a no-op adapter.

**Goal 6 — E2E + real publish:** No harness exists. Fixture test from the
shell-script bring-up (publish → resolve → pull → conflict check) is the
acceptance template. Real 1 GB publish is still pending (interrupted during
bring-up; firsthand observation only, not packet evidence — partial MFS
staging at `/obsidian-vault-sync/publish-real-20260929` on the node,
resumable or disposable; verify with a node listing before planning around
it).

## Security (decentralized, no key-exchange server) — RESEARCH MERGED

Deep-research package
`decentralized-security-for-an-agentic-20260929-4a2f` (job
`job-1790722831-32f52a36`), 10 sources, 50 verified claims, 21/21
contradictions resolved. **Confidence 0.562 — below the 0.7 threshold,
flagged for human review; storage/sandboxing/group-access findings rest on
below-threshold sources (official docs/notes, no contradicting evidence), and
pairing (SQ2), group-access (SQ5), and sandbox-escape (SQ8) evidence is
incomplete. Treat as direction, not proof.** The package (report +
provenance sidecar + claims) lives outside the repo at
`~/.prometheus/research/decentralized-security-for-an-agentic-20260929-4a2f/`
— not part of the review packet; verify claims against the sidecar before
planning depends on them. Full report at
`~/.prometheus/research/decentralized-security-for-an-agentic-20260929-4a2f/report.md`.

Recommended stack (each verified against the cited spec/doc in the report):

1. **Device identity + authz: UCAN.** Per-device `did:key` keys issue
   attenuated, short-lived capability tokens; no server needed, validation is
   offline (UCAN spec, UCAN-wg/revocation). Clock skew buffer ±60 s; every
   token needs a nonce. Maps directly to our spec 008 goal of manifesting
   capabilities in specs 005/008 and to token gating on the kubo RPC proxy.
2. **Device pairing: SPAKE2 (RFC 9382)** over a short code or QR — the
   standard PAKE for this; OPAQUE is the augmented alternative. This answers
   the spec 008 WebRTC v1 pairing question: pair out-of-band, then connect.
   QR formats / SAS / CPace were NOT covered by the research (SQ2 gap).
3. **Messaging: DIDComm v2** (authcrypt) — transport-agnostic, works offline
   over WebRTC/relays; matches our decentralized-AI transport ambitions
   (specs 005/008, A2A/UAR-lite layers).
4. **Content: client-side encryption before IPFS.** IPFS encrypts in transit
   but NOT at rest — anyone with a CID can fetch the data, and DHT traffic
   leaks access patterns (which CIDs, when, from which IP). WNFS-style
   client-side encryption (rs-wnfs has a WASM build — aligns with our Rust→
   WASM toolchain spec) hides content and tree structure. Resolves spec 005
   Q2 in favor of client-side encryption; does NOT give network-level
   access-pattern privacy — private swarm/relay is the mitigation.
5. **Skill sandbox: WASI capability model.** All host I/O through pre-opened
   capability-scoped dirs, no raw syscalls, no network by default (Wasmtime
   docs). Grant sandbox capabilities from the same UCAN chain that governs
   devices — one capability vocabulary end-to-end (report's own synthesis,
   marked `inferred`).
6. **MCP hardening (largest agent-layer risk).** Tool poisoning and rug-pull
   attacks are demonstrated (Invariant Labs: poisoned tool exfiltrated
   mcp.json + SSH keys from Cursor). Requirements: hash-pin tool
   descriptions/packages, no token passthrough, per-client consent on MCP
   proxies, sandbox local MCP servers, explicit user approval for local
   server config. Directly feeds spec 008's in-container MCP server design.

**Known hard limits (no server, no blockchain):** timely revocation cannot
be guaranteed — gossip propagation only, cannot undo past actions → use
short capability lifetimes; and public-IPFS access-pattern privacy cannot be
fully solved without private networks/relays. Keyhive (Ink & Switch) is the
most advanced local-first group-access research (Causal TreeKEM/Cryptree/DCGKA
lineage) if group vaults ever need serverless ACL with removal support —
out of MVP scope but worth tracking.

Still true from before research:
- kubo RPC at ipfs.prometheusags.ai is open-write — UCAN-at-proxy (or at
  minimum token gating) is a server-side prerequisite, tracked in DESIGN §5
  and spec 008.
- Bearer-token plumbing exists in plugin + scripts; token is user-supplied,
  so no key exchange with *us* is required — SPAKE2 pairing covers the
  device-to-device case.

## Constraints check

- `.kbd-orchestrator/constraints.md` already blocks WebView-unsafe bundles,
  destructive node ops, and non-bash-3.2-compatible scripts — it does
  **not** yet block Python. MVP work must add the `no-python` constraint
  (spec 004) and keep `kubo-args-in-query-string` intact in the shared
  client.
- OpenSpec initialized but `openspec/specs/` empty — assessment (this file)
  plus DESIGN.md §4 are the canonical spec inputs for planning; consider
  seeding an OpenSpec spec for the delta-sync contract during plan stage.

## Risks

1. **Proxy quirks leakage** — the shared client is the single place the
   query-string/multipart-`data` quirks may live; any second implementation
   reintroduces the bugs we already hit.
2. **MFS tree collision** — persistent `current/` tree means concurrent
   publishes from two devices would race; acceptable for MVP (single canonical
   publisher) but the event bus must carry enough for Phase 2 to detect it.
3. **Test gap** — no test runner chosen; pick the lightest option (node:test)
   to avoid toolchain creep against the no-bloat posture.
4. **Scope bleed** — specs 002/005/006/008/009 are attractive; the seams in
   Goal 5 are the only sanctioned touchpoint in MVP.

## Open questions for analyze/plan

1. Exact Node CLI surface: `npm run` scripts vs `bin` entry vs `npx` package?
2. node:test vs vitest for the E2E fixture harness?
3. Should the MVP plugin publish path move to per-file `files/write`
   immediately (docs/001-style pool), or keep multipart `add` with chunking?
4. Token delivery for kubo RPC auth: env var + settings field only, or OS
   keychain integration on desktop (node:keytar equivalent)?
5. Manifest `excludesHash` semantics when two devices use different exclusion
   lists (DESIGN §4.2) — reject, union, or per-device manifests?
6. Which UCAN + SPAKE2 implementation for TS/WebView? (Spec-wg UCAN libs vs
   hand-rolled; SPAKE2 JS implementations are scarce — may need the Rust→WASM
   path for crypto primitives, which also fits spec 005's WASM toolchain.)
