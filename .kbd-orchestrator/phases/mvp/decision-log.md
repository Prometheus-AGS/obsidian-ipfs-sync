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

## 2026-09-30 — Release 1 (v0.2.0) published (operator-approved)
- **Done, each with explicit operator approval ("go")**: local commit `4c1a609` on `main` (241 files, secret scan clean, values never printed); `git push origin main`; annotated tag `v0.2.0` pushed; GitHub pre-release created (not latest, not draft): https://github.com/Prometheus-AGS/obsidian-ipfs-sync/releases/tag/v0.2.0 with main.js, manifest.json, ipfs-sync-cli-0.2.0.tgz, SHA256SUMS. Public downloads re-verified byte-for-byte against SHA256SUMS; remote main == local HEAD.
- **Release is fixture-only**: plaintext, synthetic fixture vaults only; release notes say so first.
- **Cadence publication debt stays PENDING**: `publication-receipt.mjs` requires a page containing the exact absolute asset URL; both GitHub release pages (tag page, expanded_assets) contain only a relative link (tested read-only). No receipt fabricated, no self-hosted page created. Options later: a first-party page advertising absolute URLs, or an operator decision to change the publication policy.
- **Demonstrated in Obsidian 1.13.7 desktop (macOS)**: publish (notice "4 written, 0 removed"), pull (notice "3 fetched, 10 unchanged, 1 conflicts, 0 failed"; conflict copy notes/welcome (ipfs conflict 2026-09-30).md). Not demonstrated: mobile, Windows, Linux, authenticated endpoint, catch-up on load, Pull settings section screenshots, in-app refusal notice text.
- **Open items**: LICENSE holder "Prometheus AGS" is an assumption; local commit of these log entries is pending an operator decision.

## 2026-09-30 — mvp-06 independent security review 0.1 (lead decisions)
- Saved as `openspec/changes/mvp-06-encrypted-vault-publish/review-0.1.md`. Verdict PROCEED-WITH-FIXES: no CRITICAL only because the fixture guard keeps real data off the node; S-01 and S-02 become CRITICAL at guard removal unchanged. All findings accepted.
- **Reversed**: default Argon2id 19 MiB/t=2 → **64 MiB / t=3 / p=1** (ceiling 128 MiB / t≤4 / p=1). Reason: the key slot is public, old roots stay pinned forever, so a later rewrap cannot raise the cost of an already-fetched slot. Generated passphrase (25 random base32 characters) is the default; user-chosen only behind an "attackable offline" acknowledgement, ≥16 chars + blocklist. A rewrap never revokes old slot copies.
- **Frozen-format changes now**: blob AAD binds the HMAC node name; key slot gets key commitment and exact-match fixed fields; keyslots.json compared byte-for-byte with the local copy (per-mfsRoot).
- **Publisher hardening**: local journal + resume rule, baseline CID drift check, immutable-path read-back before pin/name-publish, size caps on remote objects, cross-process lock, ≤2 slot attempts, no KDF before the "new device" refusal.
- **Guard**: pull-created marker value `pulled-fixture` does not enable publish. Guard removal (mvp-07) additionally requires a phone Argon2id timing or an explicit informed operator acceptance.
- **Process**: firm early security gate after the crypto-format tasks (review-2.md) before any wiring; vault-keys/session-keys owned by identity-security-engineer.

## 2026-09-30 — mvp-06 independent delta review 0.2 (lead decisions)
- Saved as `openspec/changes/mvp-06-encrypted-vault-publish/review-0.2.md`. PROCEED-WITH-FIXES; no CRITICAL; all findings accepted. Blocking before wiring: N-01 (resume/drift dead-ends), N-05 (read-back scope), N-08 (KDF on node params), N-09 (commitment encoding), N-10 (manifest caps/serialisation).
- **Generated-only passphrases in mvp-06** (25 base32 characters, 125 bits); user-chosen passphrases deferred with the required rules recorded (removes the policy-loophole class N-07). Alphabet is not "unambiguous"; UI says letters are case-insensitive and uses monospace.
- **`--repair`** for behind/ahead refusals (authenticated, same vaultId, slots equal to local copy) instead of "delete state"; otherwise abandon + new root.
- **Drift path diagnoses first** (rewrite only what mismatches; full re-upload above 256 MiB needs a flag/confirmation). Manifest cap 64 MiB / 100,000 entries, writer refuses to write an unreadable manifest. Read-back lists the immutable root and pins the verified CID string.
- **Process**: second independent review point `review-3.md` after tasks 3.1/3.2, in addition to the early gate `review-2.md` after 2.x and the final `review-5.md`.

## 2026-09-30 — mvp-06 implementation start (lead)
- Spec revision 3 (24 tasks) after two independent security reviews. Cadence scope = tasks 1-23; task 24 (the automated feature run) is the checkpoint and is completed after `finish`. The increment will overrun the 2 h slot (24 tasks incl. three review gates); the overrun is reported honestly, not hidden.
- mvp-07 drafted (21 tasks; post-finish tasks 6.1-6.5 separate: operator run, phone timing, guard removal, local release record, outward steps).
- Order: identity-security-engineer 1.1-2.4 (crypto core) ∥ ipfs-engineer 2.5 (independent reference decryptor) → security-reviewer 2.6 early gate (review-2.md) → wiring 3.1-3.5 → security-reviewer 3.6 (review-3.md) → 4.x → docs → gate + final review (review-5.md) → feature-op script → freeze → automated feature run.

## 2026-09-30 — LICENSE holder corrected (operator)
- Copyright holder is **KnowMe AI, LLC** (operator's company), not "Prometheus AGS" (my earlier assumption). Updated in LICENSE, README (License section) and CHANGELOG. **Not yet committed or pushed**: the public v0.2.0 tag and the current `origin/main` still carry "Prometheus AGS". The fix goes out with the next commit; the v0.2.0 tag is not rewritten.
- Deviation from the team rule, recorded: a three-line mechanical edit across LICENSE/README/CHANGELOG was made by the lead session, not by documentation-specialist.

## 2026-09-30 — mvp-06 spec ambiguities found by the independent reference reading (lead decisions)
- The reference decryptor (ipfs-engineer, spec text only, forbidden to read src/crypto) found 14 ambiguities. HIGH: the literal passphrase rule accepted "CorrectHorseBatteryStaple" (25 letters). **Decision**: generated passphrase = 23 random symbols (115 bits) + 2 check symbols (first 10 bits of SHA-256("ipfs-sync/passphrase/check/v1" ‖ 23 symbols)); canonical form requires the alphabet AND a valid checksum, rejected before any derivation (typed `passphrase-format`); ~1/1024 of arbitrary 25-letter strings still pass by chance — this is a typo/accident guard, not proof against grinding. Entropy claim is now **115 bits**.
- Other decisions: unknown slot types are skipped (refuse `no-usable-slot` only when none usable); fixed-field violations on a passphrase slot refuse the whole unlock (`unsupported-format`); bounds-validate only the ≤2 slots tried before any KDF; extras rejected except in unknown-type slot content; keyslots.json canonical form = sorted keys (UTF-16), `JSON.stringify(_,null,2)`, LF + trailing newline, integers only; raw 16-byte ids in AAD/HKDF salts; constants (magics, sizes, HKDF lengths) become normative in the specs; `malformed` only for structurally invalid input, otherwise `authentication`; manifest field formats fixed; manifest path validity = the existing v1 rules in src/sync/pull-plan.ts, reused from that code.
- Process note: this is exactly what the independent second implementation is for; the early gate additionally diffs production output against tests/support/reference-vectors.json.

## 2026-09-30 — mvp-06 crypto core complete; two-way cross-check (lead)
- Crypto core (tasks 1.1–2.4) implemented by identity-security-engineer: 887 tests pass; Argon2id 64 MiB / t=3 / p=1 async chunked = ~0.84 s wall, ~16 ms worst event-loop gap on Apple M1 Max, Node 24.16 (targets 3 s / 100 ms met on the dev machine; phone timing NOT measured).
- Independent reference (ipfs-engineer, spec text only) agreed byte-for-byte on every derived value. Permanent two-way test `tests/unit/crypto-reference-crosscheck.test.ts`: 1,246 inputs (blobs 455, manifest 445, keyslots 40, passphrases 306), both readers made identical accept/reject decisions; production-encrypt→reference-decrypt and reverse both pass. Two reference-side laxities found and fixed (entry cid regex; empty final segment after full segments). Not covered: a real 8 MiB segment and default-cost slots in the live cross-check (default-cost covered by the vectors comparison).
- Accepted by the lead: a 28-byte final piece after other segments is `malformed` (one plaintext ↔ one layout); lone-surrogate paths refused in name derivation and manifest paths; `device` limit counts code points (publisher truncates hostname); 64 MiB manifest cap is defence in depth (unreachable under the entry/path caps).
- Vectors: NIST gcmEncryptExtIV256 count/group labels UNVERIFIED (values exact); NIST FAIL vectors not transcribed (derived negative used); one recalled vector dropped after disagreeing with Node. Early security gate 2.6 review in progress.

## 2026-09-30 — mvp-06 early security gate 2.6 (independent) — lead decisions
- `openspec/changes/mvp-06-encrypted-vault-publish/review-2.md`: no CRITICAL/HIGH; 6 MEDIUM. Wiring (section 3) is blocked until G-01..G-04 land (they change public signatures) and a delta check 2.7 by the reviewer (review-2b.md) passes.
- **Frozen formats (G-06)**: manifest `device` 1..64 code points, non-empty; numbers = canonical decimal integers only; JSON depth 32; `publishedAt` = fixed ISO-UTC regex + explicit range checks (no engine date parsing); `cid`/`rootCID` ≤128 chars; bad magic = `malformed`, version/exponent out of range = `unsupported-format`, 28-byte final piece after other segments = `malformed`.
- **Fail-safe API (G-01..G-04)**: public crypto entry points accept only data inputs; test hooks only via internal entries; branded passphrase/document types; `expectedFileId`/`expectedSize` required when decrypting a blob; unlock refuses above-default KDF cost unless the host approves.
- **Independence gaps (G-13)**: the reference's path check and passphrase fold were copies/lax — being rewritten from the spec (ASCII-only folding; rejects U+017F/U+0131).
- **mvp-07 required work added**: case-fold/Windows path hardening and write-side exclusion checks for authenticated manifests (G-10); `untrustedPathReason` extracted to `manifest-paths.ts` now.

## 2026-09-30 — mvp-06 task list finalised at 27 (lead)
- Positions 25-27 (2.6a fixes, 2.6b path extraction, 2.7 delta check) are prerequisites of section 3 by text, appended to keep ids 1-24 stable. Cadence scope stays tasks 1-23 (frozen at start); 25-27 are completed in KBD but are outside the cadence claim (a frozen-scope limitation, recorded here). Runtime titles for 25-27 are stale labels (see gotchas).

## 2026-09-30 — mvp-06 delta check 2b (task 2.7) — lead decisions
- `openspec/changes/mvp-06-encrypted-vault-publish/review-2b.md`: PROCEED-WITH-FIXES, no CRITICAL/HIGH. Section 3 started with conditions: N2-02 (import-boundary lint) and N2-04 (trim the public index) before `vault-keys.ts`; N2-01 (blob reader retention) before 3.4; N2-05 (device charset: no lone surrogates/control characters) before the first artifact; **N2-13 (wire `checkDistBundles` into the release tooling, require `missing` and `violations` empty, bytes hashed = bytes scanned) before the guard is lifted and before Release 2**; N2-03/06/07/08/09/10/11 before the final gate 5.2.
- Decisions: prompt up-front for all tried slots above default cost; only genuine AES-GCM authentication failures map to `authentication-failed` (other platform errors → `platform-failure`, so wiring retries instead of quarantining); key-slot creation accepts only generated passphrases.
- Parallel work: identity-security-engineer (crypto fixes, then 3.2 vault-keys) ∥ ipfs-engineer (3.1 marker values, 3.3 per-root state/journal/lock/repair). Then 3.4 encrypted transfer, 3.5 pull detection, review-3.

## 2026-09-30 — mvp-06 encrypted engine (3.4/3.5) — lead decisions
- Encrypted-only publish engine + pull encrypted-root detection implemented (1,399 tests, build and probe clean). Independent review point 3.6 (review-3) in progress; section 4 blocked until it closes.
- **History growth**: `manifests/` gets one file per publish and the read-back lists it with a 2,000-entry cap. Decision: warn at 1,500, refuse cleanly at 2,000 naming `ipfs-sync prune-history`; `prune-history --keep N` is REQUIRED mvp-07 work (removes oldest history entries from the working tree only, old roots stay pinned, keeps ≥ 20, needs the newest manifest to authenticate, confirmation).
- **Events**: `file.changed` keeps its `path` in-process; no persistent sink (StoreAdapter, logs, notices) may store event paths — a requirement for mvp-08.
- **Plugin timer cost**: the engine currently derives Argon2id per publish; the plugin session (4.2/4.3) must pass already-unlocked keys so a timer tick never re-derives.
- **Real-node unknowns** (to be settled by the automated feature run 6.2): `ls` RPC on `/ipfs/<cid>` for the read-back (believed correct; `files/ls` is believed MFS-only), `files/write` with `offset`/`truncate=false` for segments, gateway Range 404/416 semantics, real CIDv1 for `current`.
- **Historical tools**: tools/feature-op-mvp-02..05 (plaintext) no longer work; to be marked historical in docs.
- **Process notes**: the engineer accidentally ran `git rm --cached` on one test file and restored the index at once (file is an unstaged deletion; no other git write). A read-only identity-security-engineer subagent reviewed encrypted-transfer.ts (no CRITICAL/HIGH, two MEDIUM: requestUrl buffers whole bodies; plugin readRange re-reads per segment); its record is not saved as a file — the formal review-3 supersedes it.

## 2026-09-30 — mvp-06 implementation complete (30/30); task 6.2 passed on the shared node (lead)
- Sections 4-6 delivered by the team in parallel on disjoint paths: 4.1 CLI `init`/passphrase input (ipfs-engineer, named review review-4-1 by identity-security-engineer, fixes C-01..C-08 done); 4.2 session keys (identity-security-engineer, seam `PublishOptions.unlocked`); 4.3 plugin runner wiring (ipfs-engineer); 4.4 dialogs and Encryption settings (uiux-lead); 5.1 docs (documentation-specialist, four correction passes); 6.1 feature-op script (split into tools/feature-op-mvp-06/*.mjs); plus `abandon` (CLI and plugin), legacy-marker message, atomic CLI key-slot copy write, "Clear stale publish lock" plugin action.
- Independent reviews (all static, one model each, cross-model judge never run): review-3b (PROCEED-WITH-FIXES, N3-01 MEDIUM fixed), review-4-1 (C-01 HIGH fixed), review-5 (2 MEDIUM: R5-01 lock token read-back, R5-02 abandon cleared the downgrade latch; fixed), review-5b (feature-op safe with fixes R5-09/R5-10; patched), review-5c (CONFIRMED-WITH-FIXES; C5-01/03/04/05 corrected once, NOT re-read; C5-02 open by decision).
- **Open by decision**: C5-02 — no token check immediately before each node write; a CLI and a plugin publish can overlap for up to one heartbeat (~60 s) where Obsidian's `adapter.rename` overwrites. Obsidian's rename/`stat().mtime`/`list` semantics unverified. Goes to the mvp-07 operator session. Also accepted: second unlock dialog after abandon (cosmetic); `.taken` crash leftover never auto-cleaned.
- **Amended interpretation of tasks 6.1/6.2 wording** (delivered behaviour is authoritative): `--repair` on an older genuine manifest ("behind") is repaired without a prompt (task 3.3, repair.ts); only "ahead" and rebuild ask; the wrong-passphrase refusal sends two read-only requests (files/stat, key/list) and nothing mutating, not an empty trace. Tampers in the feature-op act at the script's read boundary, not on node contents.
- **Task 6.2 run (2026-09-30, once, shared node, exit 0, 121/121)**: dist sha256 5654088ba26a36f1ae6359579fe47f41e410c24fc57f326c2e65e28a53d62646 (unchanged during the run); demo root /obsidian-vault-sync/mvp06-demo/muo58t8n-ed2e9a64; 42 mutating requests, all confined; publish #1 13 written seq 1; publish #2 `1 written, 0 removed` seq 2; three kill points all resumed; refusals sent no mutation; hostile-object variants ran against the local stub only; Argon2id 844/1096/859 ms wall, largest event-loop gap 39 ms (dev machine). Other five keys byte-identical.
- **Consequence recorded**: IPNS key `obsidian-vault-sync` (id k51qzi5uqu5dicwvxyvqgk8iwhp7f4r30i7mj54qz3100sln5czk5xcp48jgqq) previously pointed to /ipfs/bafybeihh4slp53ygsfk454pm4tqjbccd5tu6s6egu37gai2mvfnbw6aa7e (mvp-05 plaintext fixture demo); it now points to /ipfs/bafybeiec4bfadcs3iaowvg4yiwh66ivnrn3sym4r6h4x4xtw262un5jxwu (encrypted fixture demo root). Not restored. Demo root left on the node; `--cleanup muo58t8n-ed2e9a64` would not unpin.
- **Bookkeeping note**: tasks 16-24 and 30 ran as parallel dispatches; their KBD start/end receipts were recorded at close time (2026-09-30, sequentially), so receipt timestamps do not reflect the real work windows.
- **Not done / still unverified**: nothing has run in Obsidian, on a phone, or with a real vault; phone Argon2id timing; zeroization; the plugin flow; real terminal behaviour of the prompt (SIGTERM/SIGHUP/SIGTSTP restore); kubo `files/write` overwrite semantics; whether kubo reads `arg` from a POST body. Real vault `/Users/gqadonis/obsidian` never touched; fixture-only guard stays until mvp-07 review + in-app run + phone timing.
- **mvp-07 checklist additions**: W-14, W-15, W-16; `prune-history` as a guard-removal precondition (N3-09); N2-13 dist check wired into release tooling before Release 2; `@noble/hashes` 2.4.0 pin in versions.toml (operator hand-edit, R5-12); release-note line for the host-bridge change (0700/0600, `.tmp` leftovers, R5-13); DESIGN sections 1-7, 9, 10 to be brought up to date when the decrypting pull lands.

## 2026-09-30 — cadence increment 6 finished; second shared-node run (lead)
- Operator chose (AskUserQuestion) to run the cadence feature checkpoint again on the shared node rather than reconfigure it to --local-stub or leave the increment open.
- Checkpoint results: build success, launch success (dist sha256 5654088ba26a36f1ae6359579fe47f41e410c24fc57f326c2e65e28a53d62646 unchanged), feature `node tools/feature-op-mvp-06.mjs` exit 0, 121/121 checks; demo root /obsidian-vault-sync/mvp06-demo/muo6r3gr-8907bcc4. The node now holds two mvp06-demo run folders (muo58t8n-ed2e9a64 from task 6.2, muo6r3gr-8907bcc4 from the checkpoint); pins from both remain (cleanup does not unpin).
- **IPNS key obsidian-vault-sync history**: mvp-05 plaintext demo /ipfs/bafybeihh4slp53ygsfk454pm4tqjbccd5tu6s6egu37gai2mvfnbw6aa7e -> task 6.2 root /ipfs/bafybeiec4bfadcs3iaowvg4yiwh66ivnrn3sym4r6h4x4xtw262un5jxwu -> checkpoint root /ipfs/bafybeifu652yt23rpx4d4wgzd4rvyehf6xob6m53dzy6rntni2osl6oz3u (current). Other five keys unchanged (read-only key/list after the run).
- Cadence evidence: .prometheus/cadence/evidence/mvp-06-canonical.json (KBD status revision 546, scope tasks 1-23). `finish` accepted with an honest summary including the overrun of the 2-hour increment. Publication debt for Release 2 stays pending (mvp-07).
- Docs written before this run say the script ran once; correct to "twice (task 6.2 and the cadence checkpoint)".

## 2026-09-30 — pnpm audit: moment advisory accepted (lead, operator decision)
- `pnpm audit` (operator run after `pnpm install --frozen-lockfile`): 1 moderate — `moment` >=2.29.2 <2.31.0, path traversal via a crafted non-string locale name (GHSA-4p3w-j4w9-5jqw), path `.>obsidian>moment`; locked at moment 2.29.4; patched in >=2.31.0.
- **Accepted, no change made.** Basis (checked, not assumed): `moment` is a transitive dependency of the `obsidian` types package (devDependency 1.13.1); `esbuild.options.mjs` lists `obsidian` as external; `dist/plugin/main.js` and `dist/cli/ipfs-sync.mjs` contain zero occurrences of "moment"; no file in `src`, `cli`, `tools` or `tests` imports it; the flaw needs a caller to pass an attacker-controlled locale to moment, which nothing here does. Obsidian provides its own moment at runtime.
- Alternative not taken: a pnpm override forcing moment >=2.31.0 (touches package.json and the lockfile; `obsidian` pins 2.29.4 exactly). Revisit if `moment` ever becomes a direct or bundled dependency, if the `obsidian` types package releases a version depending on a patched moment, or before Release 2 packaging (re-run `pnpm audit` then).
- Recorded in mvp-07 checklist: re-run `pnpm install --frozen-lockfile` and `pnpm audit` before Release 2.
