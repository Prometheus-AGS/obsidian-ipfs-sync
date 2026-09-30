# Decision Log — Phase `mvp`

Append-only. Newest at the bottom.

## 2026-09-29 — kbd-analyze library/tooling decisions

- **ADOPT kubo-rpc-client 7.1.0** as the base of the shared `src/rpc/` module.
  Evidence: URL-search-params argument encoding survives our proxy's
  form-args-dropped quirk (`src/lib/to-url-search-params.ts` in repo); active
  maintenance (2026-06-09 release, repo pushed 2026-08-10). Thin wrapper owns
  the `files/write` multipart `data`-field quirk; wrapper is the single place
  proxy quirks may live (assessment risk 1).
- **ADOPT @electric-sql/pglite 0.5.8** for the MVP StoreAdapter (vectors +
  metadata). Supersedes the assessment's "no-op adapter" note — operator
  decision 2026-09-29: ship a real adapter in MVP so event/indexing seams are
  exercised; SurrealDB WASM graph adapter deferred to a later phase. Verify
  pgvector contrib availability at plan time.
- **ADOPT @ipld/car 5.4.7** (adapt) for CAR export/import on the >32MB path and
  disaster recovery; ipfs-car 3.1.0 rejected as too CLI-shaped.
- **ADOPT @ucanto/core 10.4.6 + @ucanto/principal 9.0.3** — confirms spec 011
  Q6 UCAN pick is maintained; lands with the token-gating phase, not MVP core.
- **ADOPT @noble/curves 2.4.0** as SPAKE2 curve backend; protocol state machine
  is a build item (~300 LOC, RFC 9382), not a dependency.
- **ADOPT @napi-rs/keyring 2.1.0** for CLI keychain (spec 011 Q4); keytar
  7.9.0 rejected as primary (maintenance mode, Windows native-build pain).
  Plugin keeps plugin-data/machine-key storage with warning.
- **REJECT didcomm-node 0.4.1 — STALE (2023-05).** Messaging layer is
  post-MVP; re-evaluate DIDComm alternatives at that phase.
- **Version bumps**: obsidian types 1.9.9 → 1.13.1; esbuild 0.25 → 0.28.2;
  vite 6 → 7 (required by vitest 5); add vitest 5.0.2; pnpm 12.8.1 via
  corepack packageManager field.
- **Cadence framing for plan**: 2h usable-delivery iterations (I1–I10 skeleton
  in analysis.md), build-and-run checkpoint before each next slice; tagged
  releases after I5/I7/I10 (~every 4–5 iterations), inside the operator's
  4–6 window. Recommendation — plan confirms.
- **Delivery-cadence skill not found on disk** at analyze time; slicing applied
  its intent from the operator's instruction; confirm/replace with the skill's
  own rules once installed.

## 2026-09-29 — adversarial review of analyze artifacts (verdict: PASS, 3 WARNINGs folded)

Judge: `kbd-judge` (cross-model check verified-distinct), isolation: rest-gateway.
Findings + resolutions:

1. `@napi-rs/keyring` placement — native N-API module must live in a Node-only
   CLI package/path, never imported by plugin/WebView code, never in the
   esbuild bundle; shared `src/rpc/` stays free of native/Node-only deps.
   Recorded as a plan constraint in analysis.md and cand-006 risks.
2. Research-budget accounting — registry tier exceeded its 8-query cap (11 npm
   calls). Recorded honestly in `research_budget.queries_used` with
   `registry_tier_cap_exceeded: true` instead of re-classifying.
3. PGlite vector claim — verdict split: metadata + sync-state adopt confirmed
   for MVP; vector columns conditional on pgvector availability in the 0.5.8
   contrib set verified at plan time. No interface change when vectors land.

## 2026-09-29 — kbd-plan decisions (adversarial review: round 1 BLOCK → round 2 PASS)

- **8 changes, one delivery-cadence increment each** (2h, build → launch → feature operation). Analyze's I1/I3/I9 were not usable increments under the cadence rules, so they were merged into operable slices.
- **`files/write` wrapper is required**: verified that kubo-rpc-client 7.1.0 sends multipart field `file`/`file-N`, not `data`.
- **pgvector absent from PGlite 0.5.8 core** (separate `@electric-sql/pglite-pgvector` 0.0.9) → the MVP store is metadata + sync-state only, with the vector port declared.
- **CLI lives in `cli/`, outside `src/`**, so Node built-ins and native deps never reach the WebView bundle; the Obsidian HostBridge impl lives in `src/plugin/`.
- **PGlite in the CLI only (T2)**; the plugin is not wired to a store in MVP.
- **Cut/deferred**: UCAN, SPAKE2, DIDComm, keychain, settings control center, CAR/@ipld/car, the pure-TS tar reader, pgvector, and the graph adapter.
- **T1 (uncomfortable)**: MVP publishes plaintext to an open-write node, so change 8 is operator-gated behind a secret scan.

## 2026-09-29 — kbd-plan revision 2 (operator decisions; review: BLOCK → BLOCK → round cap, fixes carried to mvp-01 diff review)

- **KBD state now in the prometheus kbd runtime** (waypoint `generatedBy: kbd-runtime`). Plan revision 2 is recorded via `kbd revise`. The legacy migration had imported the rev-1 change list, so 5 renamed rev-1 changes are cancelled (immutable log) and 7 are registered.
- **Client-side encryption in MVP (goal 7)**: a random VCK wrapped under Argon2id (@noble/hashes 2.4.0, m=19MiB t=2); per-file HKDF keys; 8MB-segment AES-256-GCM with AAD binding id/index/final; HMAC-named blobs; encrypted manifest v2. WNFS rejected (needs the deferred WASM toolchain, and the bundle is too large for mobile). No recovery without the passphrase.
- **Release = functionality demonstrated inside Obsidian on ≥1 platform.** Releases: v0.2.0 at mvp-05 (basic sync, fixture vaults), v0.3.0 at mvp-07 (encrypted sync, after security review), v0.4.0 at mvp-10 (real vault). Cadence publication mode is `manual`.
- **Config model**: separate RPC (write) and gateway (read) endpoints with URL + port; publication key; MFS root; auth none | basic | bearer (static/JWT) | custom header. Interpretation of "not the same" = distinct RPC and gateway endpoints; pending operator confirmation.
- **Node-safety validators** (from review CRITICALs): the MFS root is confined to `/obsidian-vault-sync`; the publication key must match `^obsidian-vault(-…)?$` and be created or adopted by ID; refusal happens before any request.
- **Pre-encryption rule**: until mvp-06, only synthetic fixture vaults (marker file) can be published. No real note reaches the node in plaintext.
