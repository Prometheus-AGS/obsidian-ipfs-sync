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

## 2026-09-30 — mvp-02 lead decisions (from product-manager open questions)

- **Publication key**: default becomes a NEW project-owned key `obsidian-vault-sync`, created with key/gen only when absent. The pre-existing node key `obsidian-vault` (ID k51qzi5u…74t0vzj3ina) stays classified foreign; use only if the operator passes `--owned-key <id>`. (Lead default while the operator had not answered.)
- **Manifest discoverability**: IPNS publishes the CID of `<mfsRoot>`; layout `current/`, `manifest.json` (latest), `manifests/<currentCID>.json` (history); manifest.rootCID names `current/`. Resolves the self-reference problem in DESIGN §4.2/§4.3 (DESIGN.md synced at mvp-10).
- **Default mfsRoot** → `/obsidian-vault-sync/default` (published tree stays clean).
- **Hashing**: WebCrypto ≤32 MB; >32 MB incremental sha256 via @noble/hashes (pulled forward from mvp-06).
- **Accepted, deferred**: pins accumulate (no pin/rm); name/publish latency unmeasured until mvp-02 task 6.2; exclusion semantics confirmed against scripts/publish.sh in task 2.1.

## 2026-09-30 — mvp-03 lead decisions
- **Conflict copy names keep the extension**: `<stem> (ipfs conflict YYYY-MM-DD).<ext>` (deliberate deviation from the rsync-era name; Obsidian does not open files without a known extension). Counter inside the parentheses on same-day collisions.
- **src/core freeze is soft**: additive changes (HostBridge members, event types) allowed with a design note; breaking changes are not.
- **Feature-op key ownership**: feature-op scripts share a stable config at `$TMPDIR/ipfs-sync-feature-ops/config.json` (outside the repo) so the created key `obsidian-vault-sync` is found owned on reruns; an unrecorded existing key is never adopted silently.
- **Pull never writes through symlinks**; pull performs no node mutations; pull guard: destination absent/empty or containing the fixture marker (removed with the guard in mvp-06).

## 2026-09-30 — mvp-02 sign-offs (lead)
- **HostBridge members accepted**: fs {list, stat, read, readRange, write, mkdir, remove}, net {fetch}, kv {get, set, delete, list}, agent {list, invoke}, top-level timeNow / envRead / shellExec. `rename` and `lstat` are added additively by mvp-03 (soft core freeze).
- **Drop `kubo-rpc-client` before the plugin imports src/kubo (first task of mvp-04)**: it adds ~640 KB / ~142 KB gzip to the WebView bundle and forces a type shim (`src/kubo/kubo-rpc-client-shim.d.ts`) because its typings pull in Node types. Our usage is ~10 simple RPC calls; replace with an own fetch-based `rpcCall` behind the same client interface. This **reverses the cand-001 ADOPT** from analyze (reason: measured cost + the type-isolation workaround); record in the mvp-04 design.
- **Plaintext filename restriction (`%`, `\`) is accepted for now**: it comes from mvp-01's `unsafe-mfs-path`; encrypted (HMAC) names in mvp-06 make it moot for real vaults. Must be revisited if a real vault is published before encryption (it is not: guard).
- **Excluded-marker**: `.ipfs-sync-fixture` is in the default exclusions (never published).
- **Task-ID scheme**: kbd-apply task IDs are the integer in column 1 of `kbd-apply list`, not the dotted number in the title. Orphans from the mismatch in mvp-02 were settled by alias completion (`summary: alias of task N.M`).

## 2026-09-30 — mvp-04 lead decisions
- **Sequencing changed: cadence supports ONE active iteration**, so the plan's "round 4 parallel" (mvp-04 ∥ mvp-08) is not possible as separate increments. Order becomes mvp-04 → 05 → 06 → 07 → **08** → 09 → 10 (08 depends only on 03 and benefits from running after encryption: its records must never hold plaintext paths).
- **Reverse cand-001 ADOPT (kubo-rpc-client)**: task 1.1 of mvp-04 replaces it with an own fetch-based `rpcCall` (measured cost ~640 KB / ~142 KB gzip in the WebView bundle plus a type shim). Target: src/kubo+src/core probe < 60 KB unminified.
- **HTTP transport is injectable** in `rpcCall`: CLI uses global fetch; the plugin uses fetch by default and may swap to Obsidian `requestUrl` if CORS/mobile requires it (CORS through the proxy is unverified).
- **Plugin feature-operation automation**: default `--trigger=manual` (operator-assisted, evidence recorded); the official CLI route (`/Applications/Obsidian.app/Contents/MacOS/Obsidian`, always with `vault=<throwaway>`) is proven only in a supervised run with the operator present, because it may register a vault in the operator's obsidian.json and open a window. Never targets the operator's real vault.
- **Plugin `data.json` (holds the token) is added to the default exclusions in mvp-04 task 2.2**; runs after mvp-03 merges (changes excludesHash; update the literal-hash tests in the same change).
- **Build output moves to `dist/plugin/`** (task 1.2); writing into the operator's real vault becomes opt-in via `OBSIDIAN_PLUGIN_DIR`; README dev-loop line follows (documentation-specialist).
- **Kept**: `publishIntervalMinutes` (exists today; subject to the fixture guard). **Known gaps carried to mvp-05**: Obsidian's adapter has no partial read/lstat (range reads load whole files; the pull symlink rule can't be enforced by that bridge).

## 2026-09-30 — mvp-04 part A sign-offs (lead)
- **Reversed cand-001 (kubo-rpc-client)**: measured ~640 KB / ~142 KB gzip in the WebView bundle plus a type shim. Replaced by `src/kubo/rpc-call.ts` (fetch-based, injectable transport, response modes json/ndjson/ndjson-last/text/none, kubo `{Message}` errors mapped to typed errors). Probe entry 675,213 B → 82,169 B; src/kubo+src/core alone 29,783 B (gate 60 KiB now enforced in tools/webview-import-probe.mjs).
- **Accepted deviation**: engine state (`state.json`, the shared CLI/plugin record) lives in `<vault>/.ipfs-sync/`, not plugin data (design decision 6 was inconsistent with the shared-state scenarios). The plugin-data `kv` exists but is unused by publish.
- **Accepted for MVP**: coarse progress (publishing… / count / done); per-file `publish.progress` event deferred.
- **Decision for mvp-05**: `appendBinary` needs Obsidian ≥ 1.12.3; raise `minAppVersion` from 1.4.16 to 1.12.3 in the release tooling (installed app is 1.13.x) rather than build a read-and-write fallback. Revisit if older installs matter.

## 2026-09-30 — mvp-04 real-Obsidian run: CORS defect (lead)
- **Finding** (operator run in Obsidian 1.13.7, throwaway vault): every plugin RPC call failed with "Failed to fetch". Verified with curl: the node returns 403 to POST with `Origin: app://obsidian.md` and its OPTIONS preflight (204) has no Access-Control-Allow-* headers, so the WebView's `fetch` is CORS-blocked. Node-side tests and the CLI cannot detect this. I had listed CORS as "unverified" before the run; the run proved it.
- **Fix**: plugin uses an Obsidian `requestUrl` transport (injectable transport designed for this); multipart body built by a shared pure builder (field `data`); error messages name the transport and hint CORS on browser "Failed to fetch".
- **Cadence**: the feature checkpoint for increment 4 is recorded as FAILED (operator-visible, not waived); after the fix the increment is re-frozen and the checkpoints re-run, the in-app step is repeated with the operator.
- **UI findings (operator screenshots)**: excludesHash and key-ID value boxes render tall/empty and clip long values; RPC/gateway/MFS inputs truncate; port placeholders look like values. Routed to uiux-lead.

## 2026-09-30 — mvp-04 closing decisions (lead)
- **Default exclusions now include `.obsidian/plugins/`** (whole directory): plugin code and data are device-local, never published or pulled. Pull refuses any manifest path matching the effective exclusion list, and always `.obsidian/plugins/**`. excludesHash now `062286b6…ddc9d`. Partial mitigation of the forged-manifest code-execution risk; full mitigation (authenticated manifest) stays in mvp-06/07.
- **Plugin transport is Obsidian `requestUrl`** (the node returns 403 to Origin `app://obsidian.md` and sends no CORS headers). A hand-built multipart body (field `data`) is shared by CLI and plugin.
- **Feature-op assertion**: Obsidian writes its own `.obsidian/*.json` config files when it first opens a folder; the plugin correctly publishes them. Allowed: `^\.obsidian/[^/]+\.json$` besides the edited note; never `.obsidian/plugins/`.
- **Evidence from the operator run (Obsidian 1.13.7, throwaway fixture vault)**: notice "IPFS Sync: published: 4 written, 0 removed (root bafybeibpyh6vw2o…)" = edited note + app.json + appearance.json + core-plugins.json; settings tab screenshots dark and light; feature checkpoint 23/23. Not recorded: the in-app refusal notice text for the marker-less vault (guard proven by CLI and unit tests only).
- **Process lesson**: cadence freezes the whole repo; operator-run tasks are completed in KBD after `finish`, not inside the increment scope (see gotchas 2026-09-30).

## 2026-09-30 — mvp-05 lead decisions (from product-manager open questions)
- **minAppVersion → 1.12.3** in the release tooling (appendBinary); installed app is 1.13.x.
- **Cadence publication debt stays pending** until a real release is approved and published; never fabricated. Local release record alone does not satisfy it.
- **Cadence scope for mvp-05 excludes** the operator-run task (10), the local release record (12) and the approval-gated outward steps (13); they are completed in KBD after `finish` (freeze lesson).
- **Needs the operator at release time**: which branch/commit/tag, whether to push a GitHub pre-release, and a LICENSE file (package.json says MIT; no LICENSE file exists).

## 2026-09-30 — release approvals (operator, this session)
- **Operator approved**: (1) commit on `main`; (2) push a release (GitHub pre-release v0.2.0 after Release 1 is demonstrated); (3) license MIT.
- **Handling**: LICENSE added (holder "Prometheus AGS" — an assumption, to be confirmed before the push); `.gitignore` extended for machine-local state and the absolute-path skill symlinks. The remote `Prometheus-AGS/obsidian-ipfs-sync` is PUBLIC, so a secret scan of exactly the committed set runs before the push. Commits/tags/pushes happen only between increments (cadence freeze), after Release 1's in-app demonstration.

## 2026-09-30 — mvp-05 pre-demo sign-offs (lead)
- Accepted: `PULL_FIELD_IDS` stays separate from `FIELD_IDS`; the tab layer handles both. Conditional editor flush (`save()` only when the editor text differs from disk). Publish skips over-cap files with a visible count and keeps the already-published entry. Pull demo script supports `--trigger=manual` only (CLI route unproven). Pull result file is written to `$TMPDIR/ipfs-sync-feature-ops/feature-op-mvp-05.json`, never into the repo; the release tool reads it with `--feature-op`.
- Known/accepted gaps for Release 1: `isDesktopOnly` stays false while mobile is unverified (documented as unverified); a newer global `delivery-cadence` 1.1.1 exists, the project still uses the linked 1.1.0.
