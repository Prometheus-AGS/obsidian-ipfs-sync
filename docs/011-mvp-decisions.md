# Spec 011 — MVP Decisions (kbd-assess open questions 1–7)

Status: **decisions — operator-directed 2026-09-29.** These resolve the six
open questions in `.kbd-orchestrator/phases/mvp/assessment.md` plus the UI
requirements (question 0 → spec 010). Recorded here so /kbd-analyze and
/kbd-plan consume them as inputs, not open questions.

## Q1 — Package manager: **pnpm** (via corepack)

Runs on Node 24 (our pinned runtime); bun's own runtime has ~99% Node
compatibility — an unacceptable foundation for a CLI that must behave
identically on Windows/macOS/Linux and in CI. pnpm adds strict node_modules
(phantom-dependency prevention — matters with our large skill bundles),
content-addressable store, and first-class workspace filtering when the repo
grows (plugin/, cli/, wasm/). Bun wins raw install speed; that is not our
bottleneck. Lockfile: `pnpm-lock.yaml`, committed. Enforce with
`packageManager` in package.json + corepack.

## Q2 — Test runner: **vitest**

node:test is dependency-free but weak on TS ergonomics, watch mode, and
ecosystem integration. vitest is the 2026 default for TS projects, runs our
Node 16-resolution tsconfig natively, and playwright-bdd composes with it.
Type gate remains `tsc --noEmit` (TS 7) — vitest does not replace it.

## Q3 — Publish path: **per-file `files/write`** (research: decided)

Multipart `add` of a monolithic tar has no resume, no per-file progress, and
is a mobile-memory hazard (assessment Goal 1). Per-file `files/write` into the
staging tree gives delta granularity, per-file resume, real progress events,
and per-file stat verification (the proxy quirk makes stat-after-write
mandatory anyway). Files > 32 MB stream in 8 MB chunks with explicit offset.
See `kubo-sync` skill, "Per-file vs monolithic upload".

## Q4 — Token/key delivery per platform (research: decided)

One design, platform backends behind a `KeyStore` interface:

- **Desktop CLI (Win/macOS/Linux)**: OS keychain via a maintained Node
  keychain binding; env var `IPFS_SYNC_TOKEN` as explicit override; config
  file only as fallback, chmod 600 / ACL'd.
- **Desktop Obsidian plugin**: OS keychain where the plugin host allows;
  otherwise plugin data encrypted under a machine-local key with an explicit
  "device-trust" warning in settings.
- **iOS**: Keychain, Secure Enclave-backed when available, via Capacitor
  plugin; WebCrypto non-extractable CryptoKey as WebView fallback.
- **Android**: Android Keystore via the same Capacitor plugin.
- Rule: no key material in repo, logs, MCP tool arguments, or the manifest.

## Q5 — `excludesHash`: **keep it**

Rationale: two devices with different exclusion lists silently corrupt each
other's notion of the vault if divergence is not detectable. On hash mismatch
the pulling device performs a full sync and the UI warns loudly. Divergence
must be loud, not silent. Semantics: exact sorted-list hash (spec:
`kubo-sync` → references/mfs-delta-contract.md).

## Q6 — UCAN + SPAKE2 libraries: **ucanto + @noble/curves + didcomm-node**

- UCAN: **`@ucanto/core` + `@ucanto/principal`** — most-maintained TS
  implementation (Storacha, production storage services), native Ed25519
  did:key. Migration path: `@ixousername/ucan` adds a revocation registry +
  replay store — adopt when multi-device revocation syncing lands.
- SPAKE2: **no battle-tested TS library exists.** Implement against
  **`@noble/curves`** (audited, dependency-free) following RFC 9382 exactly
  (edwards25519, spec MHF). Ship gate: RFC test vectors + adversarial review
  by the security-reviewer role. (Alternative — Rust→WASM per spec 003 — stays
  available if the JS implementation review surfaces problems.)
- DIDComm v2: **`didcomm-node`** (SICPA, maintained) on desktop/daemon;
  evaluate its browser build for WebView, else WebViews use the
  WebRTC+UCAN path and DIDComm stays daemon-side.
- Token rules: invocations expire in 5 min, delegations in 24 h, nonce +
  single-use enforced, ±60 s clock skew, no-expiry tokens rejected.

## Q7 — Settings UI/UX: **one searchable control center**

The feature set is too large for Obsidian's native settings tabs, so the
plugin ships its own settings surface (rendered per spec 010 rules):

- **Command-palette-first**: every setting searchable (Ctrl/Cmd+P inside
  settings), with natural-language aliases.
- **Sections**: Sync (node URL, MFS root, staging retention, chunk size),
  Security (device DID + QR, paired devices with per-device revoke, active
  UCAN grants with expiry countdown, vault key status), Agents (UAR-lite
  endpoints, model routing, skill permissions), Direct Links (WebRTC pairing
  state, iroh v2 preview), Data (PGlite/Surreal storage, embedding model,
  reindex), Appearance (theme, density, collapse defaults from spec 010).
- **Security section is first-class**: pairing happens here (QR + short
  code), revocations are one click with a visible consequence summary
  ("this device loses sync access at grant expiry").
- **Every destructive or trust-changing action** (revoke, rekey, wipe local
  stores) shows a consequence dialog; nothing destructive is one click.
- Settings changes emit typed events on the EventBus so sync/agents/UI react
  without restart.
- Visual bar: dark-mode native, keyboard navigable, meets the same touch
  targets as spec 010 — designed by uiux-lead under the impeccable system,
  not Obsidian's default tab list.
