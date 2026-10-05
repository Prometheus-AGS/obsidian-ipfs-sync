# IPFS Sync — Design Document

Status: **draft — pre-implementation spec. Do not build from this without sign-off.**
Companion to the README (operations) — this file is the architecture spec.

## 1. Goals

- Sync an Obsidian vault over IPFS through a kubo node the user runs or trusts, set explicitly (there is no default
  node; the maintainer's shared node is the operator's verification target only, not a default) — no Obsidian Sync
  subscription, no third-party cloud.
- Work on **desktop (macOS first), iOS, and Android** from the same plugin codebase.
- Provide the substrate for a later AI layer: embeddings and indexes stored as
  content-addressed data pinned to the vault snapshot, so any device gets the
  index that matches its snapshot for free.
- The user writes and owns the plugin. This repo is that plugin.

## 2. Hard constraints (mobile-first rules)

Derived from Obsidian mobile = Capacitor WebView (WKWebView / Android WebView):

| Constraint | Consequence |
|---|---|
| iOS suspends the app off-screen | Sync model = "fast catch-up on app open", never background |
| Memory capped, jetsam kills | No monolithic FormData / no whole-vault ArrayBuffers; everything streams and is incremental |
| Intermittent, metered networks | Delta-only transfers in both directions |
| WebView has only HTTP(S)/WSS | Phones never speak libp2p/DHT directly. The mobile transport is the plugin over HTTPS: `requestUrl` for the RPC, the gateway for blobs (§3). Helia/js-libp2p was evaluated and is not adopted |

Phones and background sync: iOS gives a backgrounded app only opportunistic background time, so sync happens when
Obsidian is open, on an on-load catch-up pull, or on a manual pull. This is the claim of the mobile-feasibility client
assessment (`.kbd-orchestrator/phases/mvp/children/mobile-feasibility/assessment-clients.md`); it is **unverified on a
device**.

## 3. Architecture overview

```
┌────────────┐   HTTPS RPC    ┌──────────────────────────┐
│  Desktop   │◄──────────────►│  your kubo node (set     │
│  (plugin)  │                │  by you; no default)     │
└────────────┘                │  storage + pins + IPNS   │
                              └──────▲───────────────────┘
┌────────────┐   HTTPS (requestUrl RPC, gateway blobs)
│  iOS app   │◄─────────────────────┘
│  (plugin)  │
└────────────┘
┌────────────┐   HTTPS (same)
│ Android app│◄──────────────► same node (Android untested)
│  (plugin)  │
└────────────┘
```

The earlier sketch had phones reaching a Helia/OrbitDB daemon over WSS. That is not the mobile transport. Evidence (from
`assessment-clients.md` and `device-results.md`; nothing else is claimed): kubo 0.42.0 on the node advertises no directly
dialable public address, only circuit-relay addresses; gateway Range and CORS probes against `/ipfs/` returned 206 with
open CORS, while `/api/v0` returned 403 for `Origin: app://obsidian.md`; the IPNS record is fetchable at
`/ipns/<name>?format=ipns-record`. On an iPhone, plaintext pulls of 24 KB and 50 MB over `requestUrl` worked, and Argon2id
at 64 MiB, t = 3, p = 1 took 980 to 1143 ms. Limits: the Range and CORS probes were run from a Mac, not a phone; the
encrypted pull has not run on a phone; Android is untested.

**Helia/js-libp2p: evaluated, not adopted.** About 318 KB gzip per the report (`helia` 7.1.16), it needs node-side
reachability work, and it adds nothing the AES-GCM authenticated data does not already cover.

- **Phase 1.1 (this spec's implementation target):** snapshot pointer (IPNS) +
  delta transfers, all via kubo HTTP RPC. Mobile-compatible.
- **Phase 2:** op-log CRDT (OrbitDB) replicating through the VPS daemon; kubo
  remains the block store. Snapshot layer degrades to bootstrap/restore.
- **Phase 3:** AI layer — embeddings index as content-addressed data pinned to
  the vault root; semantic search, RAG chat, auto-backlinks.
- **Phase 4:** availability/polish — pinning strategy, selective sync, conflict center.

## 4. Phase 1.1 spec — delta sync over the RPC

> **Status.** This section is the Phase 1.1 plaintext design. The delivered layout, manifest and publish flow are
> encrypted and are described in §8 (layout and constants in §8.3). The delivered pull is described in §4.3 below and in
> §8.10; the plaintext reader it replaced was removed in `mvp-07b` (no flag reads a plaintext root any more). Where §4
> and §8 differ, §8 describes the code.

### 4.1 Node-side layout (MFS)

Fixed persistent staging tree (replaces the per-run timestamped dirs of Phase 1):

```
/obsidian-vault-sync/
  current/                  ← the vault tree; publish mutates in place
    <vault-relative files>
  manifests/
    <rootCID>.json          ← one manifest per published root (immutable, small)
```

- Publishing changed files writes only those paths into `current/`, removes
  deleted ones (`files/rm`), then `files/stat /obsidian-vault-sync/current`
  yields the new root CID. Cost: O(changes), not O(vault).
- Manifests are content-addressed by the root they describe; old roots stay
  resolvable (free history: pulling an old manifest = point-in-time restore).
- In the encrypted layout (§8.3) a history file is named `manifests/<16-digit sequence>-<rootCID>.enc`, so that sorting
  the names gives the publish order without decrypting anything. A name is only a claim: a reader trusts its prefix only
  after the file authenticates and carries the same sequence. Names written by a `mvp-06` development build,
  `<rootCID>.enc`, still read and sort before every prefixed name.

### 4.2 Manifest schema

`.ipfs-sync.manifest.json`, stored at the snapshot root (and mirrored to MFS
under `manifests/`):

```json
{
  "version": 1,
  "rootCID": "bafy…",
  "publishedAt": "2026-09-29T17:00:00Z",
  "device": "macbook",              
  "files": {
    "notes/hello.md": { "sha256": "…", "size": 1234, "cid": "bafk…" },
    "attachment.pdf": { "sha256": "…", "size": 45678, "cid": "bafy…" }
  },
  "excludesHash": "sha256 of the effective exclusion list"
}
```

- `sha256` (WebCrypto, cheap on mobile) is the change-detection key; `cid` is
  the fetch key. Local files are hashed and compared — only misses/mismatches transfer.
- `version` gates schema evolution.
- Files under exclusion paths are absent from `files`. The default exclusion list is one module
  (`src/sync/exclusions.ts`) that publish, change detection and the manifest hash all read: `.trash/`, `.ipfs-sync/`,
  `.ipfs-sync-fixture`, `.DS_Store`, `.obsidian/` (the whole configuration folder, device-local on every platform; a
  directory called `.obsidian` at any depth matches), `node_modules/`, `.git/` and `.smart-env/` (the Smart Connections
  embeddings folder). The defaults cannot be removed;
  the plugin adds a renamed configuration folder and the user's own entries. `excludesHash` is the sha256 of the
  effective list sorted by UTF-16 code unit and joined with `\n`; for the defaults it is
  `ebd10cbd1cd9776229910af44cc1455550e840ba6aad25e8ba9434b0df32da0f` (before `mvp-07a` it was
  `062286b651a2f5a832e1b8913d4e4fcd7dcfd39c081d5eb0bf5f5310962ddc9d`). A pull of a manifest whose hash differs from the
  local one prints one warning and hashes every local file instead of trusting size and modification time. Entries of an
  older manifest under `.obsidian/` or on the list are skipped as expected and leave the manifest at the next publish.

### 4.3 Plugin behavior

**Publish (per-file pool, 4–6 concurrent):**
1. Enumerate vault files (exclusions applied). Compute sha256 for files not in
   the last local manifest, or whose size/mtime changed (fast pre-filter).
2. `files/write` each changed file to `/obsidian-vault-sync/current/<path>`
   (multipart `data` field; args in query string — proxy quirks, see README §node-quirks).
3. `files/rm` paths present remotely (last manifest) but absent locally.
4. `files/stat` → new root CID → `pin/add`.
5. Write manifest JSON → add it (pinned) → mirror into `manifests/`.
6. `name/publish` root CID to the `obsidian-vault` IPNS key (`ttl=5m`).

**Pull (delta, streamed).** The plaintext steps this section first described (`cat` of `.ipfs-sync.manifest.json`, then
`vault.create` / `vault.modify`) were the plaintext reader, which `mvp-07b` removed. The delivered pull
of an encrypted vault, in the CLI and the plugin, is (details in §8.10):
1. Refuse invalid flag combinations; check the destination (absent or a directory whose state folder is not a symbolic
   link; the marker rule of earlier trees is gone on `mvp-07b-guard-removal`); take
   `publish.lock`; `name/resolve` (with `nocache=true`) → root CID; list the root once.
2. Unlock from the local key-slot copy, else from the node's slots; authenticate `manifest.enc`; run the path policy over
   the whole manifest; decide the verdict against the record (state and sequence floor, §8.10). A first pull is shown and
   confirmed before anything is written.
3. Plan each path on plaintext sha256 (this device, the baseline, the node) with the size-and-mtime shortcut; fetch only
   what is missing or changed from the immutable tree `/ipfs/<manifest rootCID>/` through a bounded pool; each file is
   decrypted and hashed into `.ipfs-sync/tmp/`, then renamed into place.
4. Conflict policy (unchanged from Phase 1): **the node's version wins, local content preserved**
   as `name (ipfs conflict YYYY-MM-DD)` (the extension is kept). Never delete local files: a remote deletion is reported
   as `remote-deleted` and the file stays.

**Triggers:** command palette (publish/pull/status), ribbon, on-load catch-up
(enabled per device), debounced after-save publish (opt-in). All foreground.

**Config sync:** none. The whole `.obsidian/` folder is excluded on every platform (since `mvp-07a`): plugin code and
plugin data, including this plugin's `data.json` with its credentials, never leave the device, and a pull refuses any
manifest path under it because a pulled plugin file would be code execution. A whitelist of config files is not
implemented.

### 4.4 CLI scripts

`publish.sh` / `pull.sh` gain the same delta logic (fixed `current/` tree,
manifest-driven). Scripts remain desktop tools; mobile uses the plugin only.

## 5. Server-side prerequisites (not plugin code)

1. **Gate `/api/v0` with bearer auth at the proxy.** The maintainer's shared node (the operator's verification
   target, not a default) is open to the internet for writes (verified during bring-up); any node you expose the
   same way is too. Plugin + scripts
   already send `Authorization: Bearer $IPFS_RPC_TOKEN` when set.
2. Optional: read-only gateway subdomain for content retrieval (`cat`/`get`
   without write scopes), if we want defense-in-depth.

## 6. Phase 2 spec sketch — op-log via sync daemon (not yet final)

- **Log model:** one OrbitDB `documents` record per vault file:
  `{ path, contentCID, sha256, size, mtime, deleted: bool, lamport }`.
  Attachments referenced by CID (dedup across devices for free).
- **VPS daemon:** Node process next to kubo; Helia + OrbitDB hosting the log
  ("Voyager"-style persistent peer). kubo continues to store/pin blocks.
- **Clients (desktop + mobile plugins):** the original sketch had them replicate over **WSS to the daemon
  only**. For mobile that assumption is not adopted: the node advertises only circuit-relay addresses, and the
  evaluated Helia/js-libp2p route (about 318 KB gzip) needs node-side reachability work (see §3). Phones use the plugin
  over HTTPS until a Phase 2 decision replaces it. Delta sync on both ends.
- **Merging:** Merkle-CRDT; concurrent edits converge; per-file conflicts
  resolved by policy (default: higher lamport wins, loser preserved as conflict copy).
- **Encryption (decision pending):** per-file AES-GCM with a vault key vs.
  private libp2p network. Leaning per-file: works over the daemon without
  transport assumptions, and survives gateway exposure.
- **IPNS pointer** remains as bootstrap: new device resolves IPNS → gets latest
  root + log head → joins replication.

## 7. Phase 3 sketch — AI layer (decision pending, specs TBD)

- Embeddings computed on a capable device, stored as content-addressed index
  pinned under the vault root (`/.ipfs-sync/ai/`):
  ```
  .ipfs-sync/ai/
    index-<snapshotCID>.jsonl.zst   ← chunk embeddings, keyed by file sha256
    meta.json                        ← model id, dim, version
  ```
- Index keyed by content hash → automatically correct for any device that has
  those files; mismatched files just miss.
- Features: semantic search, RAG chat (replaces vault-chat + its plaintext API key),
  embedding-similarity backlink suggestions, clustering.
- Open questions: local embeddings (transformers.js in WebView = heavy) vs.
  API embeddings (cost, privacy); index size at 10k notes; update cadence.

## 8. Encrypted vault: formats, keys, threat model and limits

This section describes the encrypted publish path delivered by change `mvp-06-encrypted-vault-publish` and the encrypted
pull and second-device publish delivered by change `mvp-07-encrypted-pull-second-device` (task group `07a`; unreleased),
as the code stands. Where it contradicts §4.1 to §4.4 (plaintext layout, plaintext `manifest.json`, the shell scripts) or
§6 ("encryption decision pending"), this section describes what the code does today; §4 carries a status note and its
pull, config-sync and exclusion text was corrected, §6 has not been rewritten. Every constant below was checked against
the code (module named in the last column of §8.3).

Read this first: the key-slot file is public, the node is open-write, and the only thing between an attacker and every
note ever published is the passphrase. Encryption is implemented but has not been independently reviewed to a standard
that permits real notes, and has never been run inside Obsidian. On branch `mvp-07b-guard-removal` real vaults are no
longer refused; `main` still refuses them (§8.9). Whoever publishes a real vault there accepts those facts.

### 8.1 Status and state of review

Delivered in `mvp-06`: encrypted-only publish in the CLI and the plugin; `ipfs-sync init`; the crypto core
(`src/crypto/`); per-root state, journal, resume, `--repair`, lock file and history check (`src/sync/`); the plugin key
session, setup, unlock and abandon dialogs (`src/plugin/`). Delivered in `mvp-07a` (not independently reviewed, not run in
Obsidian, on a phone or by the operator against the shared node, which is the maintainer's own test node and the
operator's verification target, not a default): the decrypting pull in the CLI and the plugin (§8.10),
the sequence floor, restore, fork resolution, second-device publish, history names with a sequence prefix, the path
policy for pulled manifests, and the `.obsidian/` and `.smart-env/` exclusions. Delivered in `mvp-07b` code tasks (same
standing: automated tests with fake nodes; not independently reviewed; not run in Obsidian, on a phone or by the operator
against the shared node): rewrap by `keys change-passphrase` and `keys increase-cost`, `keys accept-slots`, `keys
discard`, the maintenance journal (§8.4), `prune-history` (§8.7), the mass-removal guard (§8.7), the removal of the
plaintext reader and its latch (§8.7), the plugin's key rows, dialogs, cost confirmation and measure command, desktop Range
streaming, the guard-evidence checker with its recorder and release tool, and the operator-run script
`tools/feature-op-mvp-07.mjs` (§8.9). The guard-removal branch `mvp-07b-guard-removal` exists (§8.9). Not delivered:
additional key slots, revocation, a recorded manual operator run, a review record, a phone timing, coalescing
of auto-publishes (task 1.8 chose the CLI command plus a plugin prune action instead; the plugin action, task 2.5, is
built and tested only with a fake DOM), the history store (`mvp-08`).

**Documentation sync, `mvp-07b` task 5.1.** §4 (status note and the pull paragraph), §8.1, §8.3 (local files and history
limits), §8.5, §8.7, §8.9 and §8.10 were brought in line with the code on this date. §6 ("encryption decision pending") is
still not rewritten. §4.1 and §4.2 still describe the plaintext layout as the Phase 1.1 design and say so in their status
note. The statements about the operator run, the release checker passing and Obsidian behaviour are not made here because
none of them has happened.

Independent review, stated as it happened:

| Review | Scope | Verdict recorded | How it was done |
|---|---|---|---|
| 0.1 | specs and design, revision 1 | proceed with fixes (S-01 to S-23) | static read, no code executed |
| 0.2 | delta review of revision 2 | proceed with fixes (N-01 to N-17) | static read |
| 2 | crypto core, early gate | proceed with fixes (G-01 to G-14) | static read, nothing executed, no cross-model judge |
| 2b | delta check of the G-01 to G-06 fixes | proceed with fixes, no critical or high | static read, no shell, no cross-model judge |
| 3 | publish wiring | block (W-01 to W-03 high), then fixed | static read, nothing executed |
| 3b | delta check of the review-3 fixes | proceed with fixes, no critical or high (N3-01 to N3-09) | static read, no command run, no cross-model judge |
| 4-1 | CLI passphrase input and `init` | proceed with fixes (C-01 high, C-02 to C-10) | static read; ran three test files and the type check; not a cross-model or fully external review |
| 5 | whole change (passphrase handling, plugin session and dialogs, `tools/feature-op-mvp-06.mjs`) | proceed with fixes (0 critical, 0 high, R5-01 to R5-13) | static read, nothing executed, no cross-model judge |
| 5b | delta check of the split feature-op script (`tools/feature-op-mvp-06/`) | safe with fixes (F-01 and F-02 low, F-03 info); the pre-run IPNS pointer (R5-09) and the dist hash (R5-10) were not yet in the script when it was read | static read, nothing executed (no unit test, no `--dry-run`, no stub run), no cross-model judge |
| 5c | re-read of the review-5 fixes R5-01 to R5-08 | confirmed with fixes (0 critical, 0 high; five low findings C5-01 to C5-05 and four documentation overclaims) | static read, nothing executed, single model, no cross-model judge |

Reviews 0.1, 0.2, 2, 2b, 3, 3b, 4-1, 5, 5b and 5c are done. Each was a static read by one model; the cross-model judge
was not run for any of them, and (except the three test files in review 4-1) nothing was executed. No human reviewer and
no outside party has looked at this code. Findings were accepted by the lead and assigned as fix tasks. Review 5
re-read the review 4-1 fixes (C-01 to C-08) statically and found that they hold. Review 5c re-read the review-5 fixes
R5-01 to R5-08 the same way (static, single model, nothing executed): R5-01 and R5-02 were confirmed only in part (see
§8.7), the others were confirmed, and it raised five low findings. The corrections made for those findings (C5-01,
C5-03, C5-04 and C5-05) have NOT been re-read by any reviewer; C5-02 is still open (§8.7). No later review is
scheduled short of the phase-boundary gate, which has not run.

Nothing has run in Obsidian (desktop or phone). The key derivation was timed on an iPhone in a probe build (§8.7
"Mobile"); an encrypted publish or pull has not run on a phone. The feature-operation script of `mvp-06` ran twice
against the shared node on 2026-09-30 (§8.7 item 6); the `mvp-07a` pull has not been run against it.

### 8.2 Key hierarchy

```
passphrase (25 symbols, checked) --canonical form--> Argon2id(salt 16 B; m=65,536 KiB, t=3, p=1 by default) --> KEK (32 B)
KEK --HKDF-SHA256(salt=vaultId, info="ipfs-sync/slot/wrap/v1")   --> wrap key --AES-256-GCM(nonce 12, slot AAD)--> wrapped VCK (32 B + 16 B tag)
KEK --HKDF-SHA256(salt=vaultId, info=commit info, 32 B)          --> commitment (stored in the slot, compared in constant time BEFORE decrypting)
VCK (256 bits, random, never stored in the clear)
  |-- HKDF-SHA256(salt=vaultId, info="ipfs-sync/name/v1")     --> nameKey     (HMAC-SHA256 key)
  |-- HKDF-SHA256(salt=vaultId, info="ipfs-sync/manifest/v1") --> manifestKey (AES-256-GCM)
  '-- HKDF-SHA256(salt=fileId,  info="ipfs-sync/file/v1")     --> fileKey     (AES-256-GCM), one per blob version
```

Unlock order is fixed and stops at the first failure: validate fixed fields and parameter bounds of the (at most two)
tried passphrase slots, all before the first derivation; Argon2id; derive the commitment; constant-time compare; derive
the wrap key; AES-GCM decrypt. A wrong passphrase and a damaged slot are one error. `vaultId`, slot identifiers and
`fileId` are 16 random bytes; wherever one is an HKDF salt or part of associated data, its raw 16 bytes are used, not the
32 hex characters. A fresh `fileId` for every encryption gives every blob version its own key, so random 96-bit nonces
never share a key beyond one file version. The VCK is imported as a non-extractable HKDF key and every derived key is
non-extractable; the wrap key, commitment and KEK bytes are overwritten after use, best effort (§8.8).

The commitment exists because AES-GCM does not commit to its key. Its information bytes are
`"ipfs-sync/slot/commit/v1"` ‖ slotId(16) ‖ v(u32 = 19) ‖ m(u32) ‖ t(u32) ‖ p(u32) ‖ dkLen(u32 = 32) ‖ salt(16),
integers big-endian.

### 8.3 Format constants

All integers are big-endian. Hex is lowercase. Base64 is standard, padded and canonical (decode then re-encode must
reproduce the text). These values are fixed by the design so that tests can pin them byte for byte; they must not change
after release without a new format version.

| Item | Value | Code |
|---|---|---|
| Key-slot file | `keyslots.json`, format version 1, at most 16 KiB, at most 8 slots, at most 2 passphrase slots tried per unlock | `src/crypto/key-slot-format.ts` |
| Key-slot canonical form | keys sorted by UTF-16 code unit at every level, `JSON.stringify(value, null, 2)`, LF, exactly one trailing newline, integers only, no duplicate keys. Check order: size, parse, version, canonical form, schema | `src/crypto/key-slot-format.ts` |
| Slot fields | `commit` (32 B), `id` (32 hex), `kdf` {`alg` "argon2id", `dkLen` 32, `m`, `p`, `salt` 16 B, `t`, `v` 19}, `type` "passphrase", `wrap` {`alg` "aes-256-gcm", `ct` 48 B, `nonce` 12 B}; document `slots`, `vaultId` (32 hex), `version` | `src/crypto/key-slot-format.ts` |
| Slot associated data | `"ipfs-sync/slot/v1"` ‖ vaultId(16) ‖ slotId(16) ‖ v(u32 19) ‖ m ‖ t ‖ p ‖ dkLen(u32 32) ‖ salt(16) ‖ `"argon2id"` ‖ 0x00 ‖ `"aes-256-gcm"` | `slotAad` |
| Argon2id | version 0x13 (19), output 32 B, salt 16 B; default m 65,536 KiB, t 3, p 1; floors m 19,456 KiB, t 2, p 1; ceilings m 131,072 KiB, t 4, p 1; explicit memory limit equal to the ceiling; yields to the event loop every 10 ms of work | `src/crypto/argon2.ts` |
| Labels | `ipfs-sync/slot/v1`, `ipfs-sync/slot/wrap/v1`, `ipfs-sync/slot/commit/v1`, `ipfs-sync/name/v1`, `ipfs-sync/manifest/v1` (key and manifest AAD), `ipfs-sync/file/v1`, `ipfs-sync/blob/v1`, `ipfs-sync/passphrase/check/v1` | `src/crypto/key-derivation.ts`, `src/crypto/passphrase.ts` |
| Passphrase | alphabet `A-Z2-7` (RFC 4648 base32); 25 symbols = 23 random (115 bits, `byte & 31`, unbiased) + 2 check symbols; check = first 10 bits of SHA-256(`"ipfs-sync/passphrase/check/v1"` ‖ the 23 symbols) as two 5-bit symbols, most significant first; canonical form removes U+002D and U+0020, upper-cases, requires exactly 25 valid symbols and a valid check; the KDF input is the 25 symbols without hyphens; display is 5 groups of 5; at most 256 input bytes | `src/crypto/passphrase.ts` |
| AES-GCM | 96-bit random nonce, 128-bit tag, 256-bit key, nothing shorter accepted | `src/crypto/aes-gcm.ts` |
| Blob | header 22 B = `ISBL` (0x49 0x53 0x42 0x4C) ‖ version 0x01 ‖ exponent ‖ fileId(16); writer exponent 23 (8 MiB segments); reader accepts exponents 16 to 24; each segment = nonce(12) ‖ ciphertext ‖ tag(16); non-final segments hold exactly 2^exponent bytes, the last 1 to 2^exponent, an empty file is one empty segment; length = 22 + 28 × segments + plaintext length | `src/crypto/blob.ts` |
| Blob associated data | `"ipfs-sync/blob/v1"` ‖ vaultId(16) ‖ header(22) ‖ node name (32 raw HMAC bytes) ‖ segment index (u64) ‖ final flag (1 B). A rename therefore re-encrypts and re-uploads the whole file | `blobSegmentAad` |
| Node name | `current/<n[0..2]>/<n>`, n = base32-lower, no padding, of HMAC-SHA256(nameKey, UTF-8 path), 52 characters over `a-z2-7`, unused bits of the last character zero, compared by string equality with the recomputed name; paths are not Unicode-normalised | `src/crypto/blob-names.ts` |
| `manifest.enc` | header 17 B = `ISMF` (0x49 0x53 0x4D 0x46) ‖ version 0x02 ‖ nonce(12), then ciphertext ‖ tag; associated data `"ipfs-sync/manifest/v1"` ‖ vaultId(16) ‖ header(17); at most 64 MiB (checked by `files/stat` before reading and while streaming) | `src/crypto/manifest-envelope.ts` |
| Manifest v2 plaintext | fields `device`, `excludesHash`, `files`, `publishedAt`, `rootCID`, `sequence`, `vaultId`, `version` (2); entry fields `blob`, `cid`, `fileId`, `sha256`, `size`; keys sorted by UTF-16 code unit, no whitespace; at most 100,000 entries and 8 MiB of path bytes; sequence 1 to 2^53-1; `device` 1 to 64 code points; `rootCID` CIDv1 base32; `files` built without prototypes; JSON depth at most 32 | `src/sync/encrypted-manifest.ts`, `src/crypto/strict-json.ts` |
| MFS layout | `<mfsRoot>/current/<xx>/<52 chars>`, `<mfsRoot>/manifests/<16-digit sequence>-<rootCID>.enc` (a `mvp-06` development build wrote `<rootCID>.enc`; it still reads and sorts first), `<mfsRoot>/manifest.enc`, `<mfsRoot>/keyslots.json`; the root lists exactly those four entries | `src/sync/node-reader.ts`, `src/sync/read-back.ts`, `src/sync/history-names.ts` |
| History names | `^(?:([0-9]{16})-)?([A-Za-z0-9]{10,128})\.enc$`; the sequence is zero-padded to 16 digits (1 to 2^53-1); a prefix of 0 or above that is junk; a reader trusts a prefix only after the file authenticates and its manifest carries the same sequence; legacy names have no order among themselves | `src/sync/history-names.ts` |
| Default exclusions | `.trash/`, `.ipfs-sync/`, `.ipfs-sync-fixture`, `.DS_Store`, `.obsidian/`, `node_modules/`, `.git/`, `.smart-env/`; `excludesHash` = sha256 of the sorted list joined with `\n`, `ebd10cbd1cd9776229910af44cc1455550e840ba6aad25e8ba9434b0df32da0f` (before `mvp-07a`: `062286b651a2f5a832e1b8913d4e4fcd7dcfd39c081d5eb0bf5f5310962ddc9d`) | `src/sync/exclusions.ts` |
| Node response caps | listings and `files/stat` at 1 MiB and 2,000 entries; other RPC replies at 64 KiB; error bodies at 16 KiB; a blob is written in one request up to 32 MiB, otherwise per segment | `src/kubo/node-calls.ts`, `src/kubo/rpc-call.ts`, `src/kubo/http.ts`, `src/sync/chunked-write.ts` |
| History limits | warn at 1,500 files in `manifests/`, refuse at 1,999; both messages name `ipfs-sync prune-history`; `prune-history` always keeps the newest 20 (`HISTORY_KEEP_FLOOR`) | `src/sync/history-check.ts`, `src/sync/prune-history.ts` |
| Key management | `ipfs-sync keys change-passphrase`, `increase-cost`, `accept-slots`, `discard`; cost presets Standard (65,536 KiB, 3) and High (131,072 KiB, 4), within the Argon2id ceilings; a rewrap writes a `keyslots.json` with exactly one slot | `cli/keys-command.ts`, `src/sync/key-management.ts`, `src/crypto/key-slots.ts` |
| Full re-upload | above 256 MiB non-interactively needs `--allow-full-reupload` | `src/sync/publish.ts` |
| Local files | under `<vault>/.ipfs-sync/`, per MFS root, `h` = first 16 hex of sha256(mfsRoot): `state.<h>.json` (format 3; format 2, which no released build wrote, is upgraded on read; format 3 is read strictly), `journal.<h>.json` (format 1), `keyslots.<h>.json` (byte copy of the node's file), `maintenance.<h>.json` (the journal of a rewrap or a prune, its own version, a `type` and a `phase`; never read as a publish journal and the reverse), one `publish.lock` per vault (heartbeat 60 s, stale after 15 min without one, or at once if the recorded process is dead on the same host), `tmp/` (in-flight pull files `<id>.part` and `<id>.copy`, plaintext until renamed or swept). The `encrypted-seen.json` latch of `mvp-07a` is no longer written or read | `src/sync/root-files.ts`, `root-state.ts`, `journal.ts`, `maintenance-journal.ts`, `publish-lock.ts`, `temp-files.ts` |
| State format 3 fields | the format 2 fields plus `manifestIdentity`, `previousIdentity`, `highestSequence`, `highestIdentity`, `complete`, `unmaterialized`, `devicesSeen` (at most 16, first-seen order) and optional `restoredFrom` | `src/sync/root-state.ts` |
| Device-local store | outside every vault: CLI, a per-user directory (`$XDG_STATE_HOME/ipfs-sync`, else macOS `~/Library/Application Support/ipfs-sync`, Windows `%LOCALAPPDATA%\ipfs-sync`, otherwise `~/.local/state/ipfs-sync`; directory 0700, files 0600, owned by the user); plugin, the `deviceStore` section of the plugin data. Entries `device-id` (16 random bytes as 32 hex; the manifest `device` carries `<label>-<first 12 hex>`) and `sequence-floor.json` | `cli/device-store-node.ts`, `src/plugin/device-store-plugin.ts`, `src/sync/device-store.ts` |
| Sequence floor | `sequence-floor.json`, format 1: per vault ID (32 hex), the highest accepted manifest `sequence`, its `identity` (64 hex) and the write time `at`; at most 64 vaults, the oldest `at` dropped beyond that; every write re-reads the file and keeps the higher sequence; strict decoding, a damaged file is refused and never repaired | `src/sync/sequence-floor.ts` |
| Pull limits | in-flight segment memory budget 128 MiB; at most 6 files in flight (6 at segment exponent 23, 4 at 24); ask before fetching above 512 MiB (`--max-bytes`; plugin `pullConfirmAboveMb`, 64 to 8192); the plugin accepts a whole 200 body only up to 32 MiB and fetches only segment exponents of 20 or more; `--list-versions` and Restore list the newest 20 history names and decrypt files of at most 8 MiB. Every number is a proposal, not a measurement | `src/sync/pull-budget.ts`, `cli/pull-versions.ts`, `src/plugin/pull-restore.ts` |
| Marker (history) | `.ipfs-sync-fixture` held `fixture` (user or generator) or `pulled-fixture` (pull); read up to 64 bytes. Since `mvp-07b-guard-removal` nothing that gates an operation reads the result and pull writes none; the parsing stays exported. The names stay in `src/sync/fixture-constants.ts` | `src/sync/publish-guard.ts`, `src/sync/fixture-constants.ts` |

Error classes (`src/crypto/errors.ts`): only a genuine AES-GCM authentication failure is reported as
`authentication-failed`, and callers treat it as tampering, a wrong key or a moved object. `malformed-input` is
structurally invalid input (bad magic, truncation, trailing bytes, an over-long or misplaced piece).
`unsupported-format` is a version, algorithm, exponent or slot type this build does not know. `wrong-passphrase-or-damaged-slot`
is the single outcome of a failed commitment or wrap. `passphrase-format`, `kdf-params-out-of-bounds`,
`kdf-cost-refused`, `kdf-unaffordable`, `oversize-input` and `vault-mismatch` are refusals before or instead of a
derivation. `crypto-unavailable`, `self-test-failed` and `platform-failure` are platform faults and are reported
separately so a caller can retry instead of treating the data as damaged. There is no fallback when `crypto.subtle` is
missing; a known-answer check of HKDF, HMAC and AES-GCM runs on first unlock.

### 8.4 What one publish does

In this order: (the marker guard of earlier trees, which ran before the passphrase and any request, is a no-op on
`mvp-07b-guard-removal`); in the CLI, the publish lock
and then the passphrase; a keyless idle check (below); unlock, from the local key-slot copy first, so the wrong-passphrase check is local (the run still sends two read-only
requests, `files/stat` and `key/list`, before it unlocks); publication-key lookup; journal check and resume; read-only inspection of the MFS root (bounded
listings, plaintext-root refusal, key slots and `manifest.enc` fetched through the gateway under their caps); sequence
rules; baseline check and diagnosis; writer-side cap checks on the serialised manifest before any blob is written;
scan and diff on the plaintext sha256 and size (a file whose size and modification time match the record is not
hashed); per-file encryption one segment at a time and blob writes with size verification; removals; `files/stat` of
`current/`; manifest v2 at sequence + 1; journal; `manifest.enc`, then its history copy; `files/stat` of the MFS root;
read-back through the immutable `/ipfs/<rootCid>/` path; `pin/add` and `name/publish` with exactly the verified root CID;
state write; journal removal. Any failure before `name/publish` leaves the IPNS record unchanged. A publish with no
changes writes nothing and does not touch the IPNS record. The idle check returns "unchanged" before unlocking, so a
timer tick on an unchanged vault costs no key derivation, when there is a record of a completed publish, no journal and
no `--repair`, the node's MFS root CID equals the recorded one, the publication key exists and is owned, and every
scanned file matches the record by path, size and modification time. It sends read-only requests (`files/stat`,
`key/list`) and does not check the passphrase.

A killed publish resumes: the journal is written before `manifest.enc`, and the next run decides from the node's
authenticated manifest whether to finish, adopt the pending state and run the drift path at the next sequence, or discard
the journal. `--repair` lets a run continue past a "node is behind", "node is ahead", torn-`manifest.enc` or unreadable
local-record refusal, only when the node's manifest authenticates, belongs to this vault and the node's `keyslots.json`
equals this device's copy byte for byte; the ahead case discards other publishers' changes and asks first.

**What the publisher does not verify.** It pins whatever is in `current/` at the time of the snapshot, including an
object planted during the write window, unless the read-back catches it. Blobs that were not written in this run are not
re-verified on each publish, so a node writer can silently replace one and the publisher will not notice; a reader that
decrypts it will. Authentication covers the contents of blobs and manifests. It does not cover deletion, missing objects,
extra files, or the layout: directory names are not authenticated, and `keyslots.json` is checked only against the local
copy and its own authentication. A dropped connection during a write can leave a truncated blob under the MFS root; the
next publish diagnoses it and rewrites only what differs. A lock file is a best-effort guard, not an atomic lock across
machines. Detecting a blob moved between paths or an old blob replayed against a newer manifest entry is the job of a
reader that applies the reader requirements of the blob and manifest formats; those are specified and tested at the
crypto layer, and the pull engine of `mvp-07a` applies them (§8.10): it reads each blob from the immutable tree the
authenticated manifest names and accepts a file only when size and sha256 equal the manifest entry. Two devices
publishing to one root are narrowed, not prevented (§8.7 "Multiple publishers").

Before its first write, and again right before `name/publish`, a publish that has work reads the publication name; it
refuses with "another device may have published" if the name moved, and with "the publication name could not be read"
when name routing fails (`src/sync/name-recheck.ts`, `NAME_RESOLVE_DHT_TIMEOUT` of `10s` in `src/kubo/ipns.ts`). kubo has
no compare-and-swap, so this narrows the overlap to the time between the second read and `name/publish`; a write race on
the shared MFS tree is not detected at all. **On the operator's node an unresolvable name is always `not-found`:** for a
name that was never published it answered HTTP 500 `could not resolve name` identically with `dht-timeout` of 1 ms, 1 s
and 10 s, so a routing failure cannot be told from a name that does not exist. The re-check can therefore detect a move
only when the name resolves; a routing failure on a vault that already has a published name reads as `not-found` and the
publish proceeds (limited in practice, because the node serves its own key from its local record; `src/kubo/ipns.ts`). A
routing timeout on a vault's first publish counts as `not-found` by rule.

### 8.5 Threat model

The adversary is anyone who can reach the node. The maintainer's shared node accepts unauthenticated writes from the
internet (README, "Security: an open RPC endpoint is wide open"). That is why no node is a default. Removing the default
does not close the exposure; it stops fresh installs from walking into it. A node's gateway serves every published object to anyone who knows
the root CID or the IPNS name. Old roots stay pinned and fetchable forever; this project never unpins.

A node operator or any other writer CAN:
- read every ciphertext, the key slots, the number of blobs and their exact sizes (blob length is plaintext length plus a
  fixed overhead, so a file of a known length is recognisable), and the timing and frequency of publishes;
- see which encrypted blob names are rewritten, and when;
- delete, corrupt, replace, withhold or add any object;
- replay any genuine older object (an old blob, an old manifest, an old key-slot file, an old root), because a genuine old
  object authenticates; serve an older valid root (rollback) or withhold updates (freeze);
- attack the passphrase offline with the public key slot, at the cost of Argon2id, until the passphrase is guessed.

Without the passphrase, and short of guessing it, such an operator CANNOT:
- read file names, paths, contents or the manifest;
- create new content that authenticates under the vault key;
- learn the vault key from the stored data;
- make a publisher encrypt under a different vault key, because the key-slot comparison, the commitment or the
  authentication refuses it.

The uncomfortable parts, stated plainly:
- **A leaked passphrase plus any old slot copy opens old roots forever.** The slot is public and old roots are permanent.
  Nothing here can revoke it.
- **Rewrap does not revoke the old passphrase or any old copy of the key slot.** `keys change-passphrase` and
  `keys increase-cost` (§8.7) write a new slot around the same VCK, and an old copy, including the ones in earlier pinned
  roots, keeps opening it. Only re-encrypting the vault
  under a new VCK revokes access, and no code here does that.
- **Offline guessing is the residual risk.** Anyone with the root CID can fetch the slot and test guesses permanently. The
  defences are the generated 115-bit passphrase and Argon2id at 64 MiB and t = 3. The cost was raised from the original
  19 MiB and t = 2 because an old slot copy cannot be made more expensive later.
- **Generation-only is a guard, not a proof.** The check makes about 1 in 1,024 arbitrary 25-symbol strings valid by
  chance. It catches a mistyped body symbol with probability about 99.9% and a mistyped check symbol always; it never
  catches "every typo". It cannot show that a user did not choose or grind the text. The alphabet is RFC 4648 base32 and
  is not free of look-alike characters (S and 5, Z and 2, G and 6, I and L).
- **There is no recovery.** A lost passphrase, together with the loss of every copy of the key slots, makes the vault
  permanently unreadable. The local slot copy protects only against the node deleting the file.
- **Real notes are accepted on the branch, and nothing independent has reviewed it.** The old marker was an accident
  guard, not a control, and is gone there (§8.9). What is left between a real vault and harm is the passphrase and the
  limits listed in §8.7.
- **Local state is plaintext at rest.** `state.<h>.json` and `journal.<h>.json` hold vault paths. The `.ipfs-sync/` folder
  must be excluded from iCloud, Dropbox, Syncthing, backup tools and any other synchronisation. Deleting it resets the
  local state and turns this device into a stranger to the roots it published to (§8.7). Since `mvp-07b` there is no
  `encryptedSeen` latch and no `encrypted-seen.json`: no code path reads a plaintext manifest, so a downgrade cannot
  happen by construction, and `abandon` records nothing and prints the sequence floor it keeps (`abandonVault`,
  `src/sync/vault-keys.ts`). The sequence floor, which lives outside the folder, is the evidence that a vault was
  accepted; it covers encrypted manifests only. The sequence floor does not stop a node from showing an old copy to a
  device that has no recorded state.

Non-goals (not hidden, not prevented, not provided):
- the number of files, the exact size of each file, when and how often a vault is published, which encrypted files
  change, the IPNS and DHT access pattern, the existence of the vault;
- preventing rollback or freeze by an open-write node: a pull refuses a manifest below the highest sequence this device
  recorded (§8.10), which detects a replayed older genuine manifest only on a device that has already accepted a newer
  one, and nothing detects a freeze or a first pull of a stale root;
- protecting a device whose memory, environment or files are compromised, or other code in the same application context;
- forward secrecy and revocation: the VCK never rotates, and a leaked passphrase exposes every state ever published,
  including states in old pinned roots;
- deleting history: removing a note removes its blob from the current tree, and earlier roots stay pinned;
- recovery of a lost passphrase or lost key slots;
- device pairing, additional key slots, revocation and multi-writer merge (later changes; passphrase change exists as a
  rewrap and revokes nothing);
- private swarms, relays, hiding network addresses;
- user-chosen passphrases (deferred; they would need an algorithmic repetition rule, Unicode-category classes, a
  leet-folded blocklist and an explicit acknowledgement flag);
- hiding or encrypting the local state and journal.

### 8.6 What the node sees

Names of `current/` entries are 52-character HMAC values under two-character prefix folders; blob contents begin with the
`ISBL` magic followed by ciphertext; `manifest.enc`, `manifests/<sequence>-<rootCID>.enc` and `keyslots.json` are the only other
objects. No request URL or body contains a vault path, file name or content other than through encrypted blobs and
`manifest.enc`; local terminal output may show vault paths and never shows the passphrase or a key. The sequence number
of each publish is visible in the clear in its history file name (the node could count the files anyway), and a pull
reads only: `name/resolve`, `key/list`, listings of the immutable root and gateway reads. Events keep their
shape: `file.changed` carries its `path` inside the process only, and no persistent sink may store event paths.

Which node sees this is the user's choice, made explicitly. The lowest configuration layer (`defaultLayer()` in
`src/core/config/defaults.ts`) supplies no RPC or gateway URL. With none set by flag, environment variable or config
file (or, in the plugin, settings), a command exits 2 with `no-rpc-url` or `no-gateway-url` and sends no request; both
URLs are required because every pull, publish read-back, status and key command reads through the gateway. `abandon`
needs neither (local state only). The plugin starts with empty URLs and refuses every node action with "Set your IPFS
node in settings". The retired built-in host (`src/core/config/retired-default-hosts.ts`, a comparison only; the
trailing-dot FQDN form counts) is cleared at load for every readable format. `loadSettings` in
`src/plugin/settings-migration.ts` clears it for the version-3 and version-2 data (`clearRetiredNode`, when
`namesRetiredHost` finds it in either URL), and `migrateLegacy` clears it for the previous plugin's format (no version
marker). Both URLs become empty, and the auth tied to them is dropped: the legacy `authToken`, the node auth and the
gateway auth. A one-time notice tells the user to set their own node and enter credentials again, and the cleared data
is written back. A user who types that host in a session still sees the settings-tab warning
(`src/plugin/node-status.ts`); the next load clears it. The cost falls on an upgrader who really used that node: they
must enter it and its credentials again. The reason: the host that releases up to 0.2.0 built in is the maintainer's own
node and is open to anyone, so a default would have sent every fresh install's encrypted blobs and their metadata
there, and a credential written for it would have gone to whatever node is set next. The exposure of that node is not
fixed by this change. The load-time notice call `warnAboutRetiredDefault` in `src/plugin/index.ts` and the
`retiredDefaultNoticeShown` field are still in the code; since load now clears the host, they cannot fire from stored
data and are effectively dead. They are not removed.

Stored data with no version marker is the previous plugin's form only when `isLegacyForm` in
`src/plugin/settings-migration.ts` says so: the object is empty, or has one of `LEGACY_KEYS` and none of
`CURRENT_FORM_KEYS`. Anything else is `unreadable`: defaults are used, `persist` is false and the stored data stays
untouched. This stops a current-form file that lost its `version` key from being migrated over with defaults, which
would wipe `ownedKeys`, `gatewayAuth`, the device store and the sequence floor. In `migrateLegacy`, a previous-plugin
`rpcUrl` with userinfo (`hasUserinfo`) is stored empty and `LEGACY_CREDENTIALS_NOTICE` is shown. The legacy
`authToken` is dropped in that case too, as it is for the retired host; the user enters credentials again. Status shows addresses through `displayAddress` (`src/core/config/endpoint.ts`): scheme, host, port and
path, or "invalid address", never userinfo, query or fragment. `redactUserinfo` covers everything between `//` and the
last `@` before whitespace. An invalid auth header name is not echoed in the error. The 401 or 403 gateway hint is
added only when the resolved gateway endpoint has `credentialWithheld` (`src/core/config/build-config.ts`,
`src/kubo/http.ts`): its origin differs from the RPC's, the RPC has a credential, and the gateway has none. A JWT
whose `exp` is a finite number beyond the date range gives the fixed warning "expiry could not be read" in
`authWarnings` instead of throwing; an `exp` that is missing or not a number gives no warning. Switching either authentication
picker away from a kind clears that kind's draft secret fields (`src/plugin/settings-view-model.ts`).

**Switching nodes.** Clearing a retired host resets only `rpc`, `gateway`, `auth` and `gatewayAuth`. `ownedKeys`,
`pullName`, `lastPublish`, `lastPull`, `kv`, `deviceStore`, `publicationKey` and `mfsRoot` persist. Vault-side state under
`.ipfs-sync/` is named by a hash of `mfsRoot`, not by the node, so a new empty node meets the old local key-slot copy and
state. `openVault` in `src/sync/vault-keys.ts` finds a copy, finds no key slots on the node and finds local state, and
throws `lost-slots`: a publish is refused, fail closed, with no new key generated. Abandon is the way out. It keeps the
sequence floor and moves the key slots, state, journal and maintenance files aside. It deletes nothing, and that is the
uncomfortable part: a refusal that has a one-click exit teaches users to click past refusals. `pullName` is not cleared
by the reset, so the user should clear it when switching nodes. Status keeps the old publish's root CID and time until
the next publish (`lastPublished` in `src/plugin/sync-status.ts`, which reads the per-root record).

**Credentials follow an origin, not a field.** `clearCredentialOnOriginChange` (`src/plugin/settings-fields.ts`) runs in the
same write as an address edit. When the RPC origin (scheme, host, port) changes, `auth` becomes `none`. When the gateway
origin changes, `gatewayAuth` is removed, unless it is an explicit `none`. The view model blanks the matching typed fields
and sets a plain notice under the field (`RPC_CREDENTIAL_CLEARED`, `GATEWAY_CREDENTIAL_CLEARED`). Two addresses with the
same origin and different paths are the same place. A previous-plugin `authToken` is kept only with the `rpcUrl` it was
written for (`migrateLegacy`). An address, port or credential edit no longer calls the key check: the key section marks its
answer stale ("Press Check again") and the check on opening the tab remains. Closing the tab empties its container.

**An unreadable `data.json` is copied first.** The unreadable path leaves the data untouched until a save. The settings
store (`createSettingsStore`) calls `UnreadableBackup.save` before that first save; the copy is
`data.json.unreadable-<UTC stamp>` beside the file (`src/plugin/unreadable-backup.ts`), plain text with the same secrets,
named to a free name if one exists. A copy that fails fails the save, so the original stays and memory does not run ahead
of disk. This is a copy of a secret store with no encryption and no expiry; the notice tells the user to delete it.
`MAX_PUBLISH_INTERVAL_MINUTES` is 35,000 (a timer holds about 35,791 minutes), applied by validation and, for an older
stored value, by `rearmAutoPublish`. The abandon and clear-stale-lock dialogs no longer report a cancel when Escape closes
them mid-run: they report the real result.

Which endpoint gets the credential is decided in `src/core/config/build-config.ts`. The global auth is the RPC credential.
The gateway inherits it only when the gateway origin (scheme, host and port) equals the RPC origin; on any other origin it
gets auth kind `none` unless an explicit gateway auth is set, so the credential never goes to a host the operator did not
name. The CLI sets explicit gateway auth with `IPFS_SYNC_GATEWAY_AUTH_*`. The plugin has the same control as an optional
`gatewayAuth` block in its settings (`PluginSettings` in `src/plugin/settings-model.ts`), shown as **Gateway
authentication** with the choices Same as node (the default), None, Basic, Bearer and Custom header. Absent means Same
as node: `settingsToLayer` in `src/plugin/settings-to-config.ts` adds no gateway auth to the layer, and the builder
applies the origin rule. Present means explicit, and `{ scheme: "none" }` is an explicit "no credential" that wins even
when the origins match. The block goes to the gateway only. `SETTINGS_VERSION` stays 3: data stored without the block
loads as absent, and the node credential is never copied into it. The secret is stored in plain text in `data.json`
beside the node credential, and that file is excluded from publish. When a node credential is set and the gateway
origin differs, the tab shows a line that the credential is withheld. A gateway answer of 401 or 403 on a request that
carried no credential adds a fixed hint to the error that names the plugin setting and the CLI variables
(`KuboAuthError` in `src/kubo/errors.ts`). The origin rule compares scheme, host and port, not path, so one credential
is shared by every path of one host. This control was not rendered in Obsidian or on a phone. No mock of it exists in
`docs/design/`, because the Open Design MCP did not connect, and `styles.css` does not exist.

### 8.7 Stated limits

- **Desktop streaming.** On desktop, a GET with a `Range` header goes through Node `http` or `https`, found with
  `globalThis.require` (`src/plugin/range-streaming-transport.ts`); the ranged source reads the header bytes and cancels,
  which destroys the socket, so a hostile gateway cannot make the plugin buffer a large body for a header read. Whether
  `globalThis.require` exists in real Obsidian is unconfirmed, and without it the plugin silently buffers through
  `requestUrl`. Mobile always buffers. This path has no timeout. "Abort" means the plugin stops probing further size
  classes; it does not fail the pull.
- **Redirects.** `requestEndpoint` in `src/kubo/http.ts` passes `redirect: "manual"` and refuses a 301, 302, 303, 307 or
  308 answer (and a `fetch` opaque redirect) with the fixed `REDIRECT_REFUSED_MESSAGE`, which tells the operator to check
  the URL's scheme and path. The `Location` is never echoed and
  never followed, on RPC and gateway requests alike (`tests/unit/kubo-redirect.test.ts`). The Node stream transport does not
  follow redirects, so a 3xx answer reaches that check. Obsidian's `requestUrl` follows redirects itself, has no option to
  stop it and exposes no final URL. On mobile, and on desktop for every request that is not a ranged read, a followed
  redirect is therefore neither prevented nor detected. Whether `requestUrl` forwards the credential to the target was not
  checked, and its redirect behaviour is untested; the phone and desktop runs are to probe it. The control that holds is operator choice of an endpoint that does not redirect.
- **Plugin transport.** The Obsidian `requestUrl` transport buffers whole response bodies. The streaming caps and the
  one-segment memory bound therefore give no memory protection inside the plugin for what the transport has already
  buffered; Range requests reduce the exposure only against gateways that honour them. The CLI pull streams. The plugin
  pull holds up to the 128 MiB in-flight budget (`SEGMENT_MEMORY_BUDGET`, a design budget, not a measurement); a gateway
  that answers 200 to a Range request makes the gateway "ignoring Range" for the rest of the pull, a whole body is
  accepted only up to 32 MiB (`WHOLE_BODY_LIMIT`), and a larger blob is discarded after the transport buffered it and its
  file is `unfetched`. A blob whose segment exponent is below 20 (`PLUGIN_MIN_EXPONENT`) is `unfetched` in the plugin. Large-file
  pull in the plugin is not advertised as working until the `mvp-07b` operator run records the outcome.
- **Same-context code.** A non-extractable key object does not stop other code in the same JavaScript context from using
  it: code holding the session's key set can derive and exfiltrate raw file, name and manifest key bytes using the public
  labels. Non-extractability protects only against exporting the base key object. The plugin dialog holds the passphrase
  in a string that cannot be zeroed; the `IPFS_SYNC_PASSPHRASE` environment variable is readable by the user's other
  processes and inherited by child processes; the interactive `init` display stays in terminal scrollback and in `script`
  or `tmux` logs. Zeroization of the byte arrays the code owns is best effort; the runtime may copy buffers.
- **Passphrase file race.** Node has no `openat`. The passphrase file is opened by path with `O_NOFOLLOW` and its
  identity checked on the descriptor, and `init` compares device and inode after creating it, but a writer who can swap
  the parent directory between the check and the open can still misplace the file. Where the operating system has no POSIX
  file modes (Windows), no permission check is possible.
- **Delta detection.** A file whose size and modification time equal the recorded values is not hashed, on the normal
  path and on the idle path. A restore that preserves the modification time (`cp -p`, `rsync -t`, some backup tools) and
  yields a file of the same size is not noticed until the size or time changes. A pull trusts the same pair against the
  recorded baseline (unless the exclusion lists differ, which forces a content check): a local file edited in place with
  the same size and a preserved time is read as unedited, so a pull can replace it with the node's version without a
  conflict copy.
- **History growth.** Every publish that changes something adds one `manifests/<rootCID>.enc` file, pinned forever, of the
  size of `manifest.enc` (about 4 to 14 MB for a vault of 5,000 to 20,000 files). Publishing warns at 1,500 and refuses at
  1,999, and both messages name `ipfs-sync prune-history`. That command exists (`cli/prune-command.ts`,
  `src/sync/prune-history.ts`): it removes the oldest history files from the working tree, one path segment at a time and
  non-recursively, keeps at least the newest 20, and republishes the root under the same sequence. Before it asks, the
  newest prefixed file must authenticate, carry a sequence equal to its prefix and equal to the node manifest's sequence,
  and each of the newest 20 must decrypt and agree with its name; the device must be up to date (§8.4 floor rule), hold
  `publish.lock`, and have no publish or maintenance journal; `manifests/` must hold only history files and at most 2,000.
  Duplicate prefixes (a fork) are counted and shown. Old roots stay pinned with their history; a removed version cannot
  be restored through the current root with `pull --manifest`. The plugin has a prune action
  (`src/plugin/prune-history-dialog*.ts`, `key-actions.ts`, task 2.5): a "Prune history..." row, a keep count with the
  floor of 20 shown, the passphrase typed in the dialog, a dry-run preview of counts only, Cancel focused in the review
  step, removal only on an explicit press, the same lock pair as the key actions and the 2.4 cost confirmation. The timer
  and the catch-up pull never reach it. It has no resume: an interrupted prune is finished with the CLI command, and the
  plugin has no discard. **Decided (task 1.8, operator):** the CLI command and the plugin action; coalescing of
  auto-publishes is not built. At a 15-minute timer and a vault that changes on every tick, the warning comes in about 15.6 days and the
  refusal in about 20.8 days; the shipped default timer is off.
- **Key management (`mvp-07b`).** `rewrapKeySlots` lives in `src/crypto/key-slots.ts` so the hook-isolation allow-list
  needs no widening. A rewrap derives from the current passphrase a second time (the vault key cannot be read back out of
  an unlocked set), builds one new slot with a fresh salt, slot id, nonce and commitment around the same VCK, and writes a
  `keyslots.json` that holds only that slot; a file with an unknown slot type is refused before any derivation. The cost
  is never lowered silently (new memory and iterations each at least the current; a lower choice needs a confirmation that
  shows both) and stays within the ceilings. The effects run as phases of the maintenance journal `maintenance.<h>.json`
  (`journaled`, `file-written`, `snapshotted`, `published`, `local-updated`; a prune has `journaled`, `removing`,
  `snapshotted`, `published`): write the file, `republish-root` (snapshot, read-back through the immutable path, pin, name
  re-check, `name/publish`), a test unlock of the published file with the new passphrase, then the local copy and
  `keyslotsSha256`. `manifest.enc` and the sequence do not change; the state's `rootCid` is rewritten so the next publish
  reports nothing changed. Rewrap and prune take `publish.lock`, require the up-to-date-and-floor check (a node whose
  sequence equals the record but sits below the floor is refused as rolled back), and refuse when a publish journal
  exists; publish and pull refuse when a maintenance journal exists, naming `keys discard` and `keys accept-slots`. On a
  lost name race `republish-root` puts back the old `keyslots.json` bytes (rewrap, only when the file still holds the
  journal's bytes); a prune has nothing to put back. `keys accept-slots` takes `publish.lock`, reads `keyslots.json` and
  `manifest.enc` from one immutable root, requires the slot to unlock and the manifest to authenticate under the key it
  yields for the same vault, applies the pull sequence verdict, writes the exact unlocking bytes as the copy and updates
  `keyslotsSha256` (also in a pending publish journal); it clears a maintenance journal and shows both costs for a
  cheaper slot. Its stated residual: the manifest proves the key, not the slot's freshness, and a node that knows the
  typed passphrase could serve its own slots and manifest with this vault's id when no vault key is held to compare.
  `keys discard` removes the maintenance journal after a confirmation. Restore across a rewrap: `pull --root-cid <old>`
  needs `keys accept-slots --root-cid <old> --allow-rollback` and a later accept of the current root;
  `pull --manifest` and the plugin Restore need no accept on a device that holds the current copy. Rewrap does not revoke
  the old passphrase or any old copy of the key slot (§8.5). A cost above the default makes `enforceCostPolicy` refuse
  on every device that cannot answer a cost question: the CLI without a terminal, and the plugin's timer and catch-up
  pull. Manual plugin pull, Resolve fork, Restore, publish (at the unlock) and the key actions ask through the
  cost-confirm dialog (`src/plugin/cost-confirm-dialog.ts`); a wrong-passphrase pull asks again on each attempt, and the
  timer on a locked High-cost vault stays refused until a manual unlock. The plugin rows (change passphrase, increase
  cost, accept key slots, slot cost, prune history) and the "Measure key derivation time" command exist; the plugin has no
  discard entry and no resume for an interrupted operation. Concurrent rewraps are last-write-wins: the test unlock warns the loser and `publish.lock`, the
  up-to-date rule and the name re-check narrow it.
- **Mass-removal guard.** `guardMassRemoval` in `src/sync/publish.ts` runs after the plan and the idle check, before the
  re-upload guard and any write; the arithmetic is `assessRemovals` (`src/sync/removal-guard.ts`). Removals caused by the
  effective exclusion list (baseline paths and dropped carried paths it matches) are listed apart and counted in neither
  the numerator nor the denominator; carried entries count as kept; a dropped carried entry with an unsafe shape is
  outside the count. The publish stops when the other removals equal every remaining entry, or exceed half of at least
  two (`others * 2 > remaining`; exactly half proceeds). No baseline, no check. It supersedes the old behaviour in which
  a vault emptied on a device with a state published an empty manifest (`EmptyVaultError` stays for a first publish).
  Confirmation: `allowMassRemoval` (`--allow-mass-removal`), or the `confirmMassRemoval` port (a CLI yes; a plugin dialog
  on a manual publish). A timer publish passes a recorder that stores the counts and answers no, so it refuses with a
  notice. **Limits:** removing 49 percent of the entries is silent. Silent per-file corruption of unchanged files by
  someone who can write to the node is not detected by the publisher. An unmounted vault folder is caught only because it
  looks like total deletion; the refusal says so. A manual dialog opens while the locks are held, and (reasoned, not run)
  one left open past 15 minutes lapses the lock heartbeat so the publish refuses at its next check.
- **Plaintext reader removed.** The v1 manifest reader, `--allow-plaintext-v1`, `--manifest-file`, the pull latch and
  `encryptedSeen` are gone (`src/sync/manifest.ts`, `state.ts`, `pull.ts`, `pull-plan.ts`, `pull-fetch.ts`,
  `pull-record.ts`, `pull-target.ts`, `pull-screen.ts`, `pull-latch.ts` deleted; the flags are unknown options). A root with
  `manifest.json` and no key slots stops a pull with `plaintext-root` and the message "plaintext publications are no
  longer supported by this version" (CLI exit 2, plugin `plaintext-unsupported`), writing nothing. A root with key slots
  and no `manifest.enc` is refused on pull and publish; a planted `manifest.json` is never requested. The sequence floor
  is the downgrade evidence. The sequence floor does not stop a node from showing an old copy to a device that has no
  recorded state. The plaintext-era scripts `tools/feature-op-mvp-02.mjs` to `05.mjs` do not work against the encrypted
  publisher and are historical; none is deleted.
- **Evidence limits (release gate).** The review record, the operator-run record and the phone-timing record are
  attestations, not proofs. The checker (§8.9) makes forging them more work and leaves a trail; a person with repository
  write access and a terminal can still produce all three, and a terminal and a nonce stop pipes and accidents, not a
  program that drives a pseudo-terminal. A change to any scoped file after the review record or after the operator run
  changes the tree hash, and both must be redone. A phone measurement is bound to the exact plugin build.
- **Reachable actions.** The plugin cannot repair or recover slots; those are CLI flags. It can clear a stale publish
  lock (see the next two items). The abandon action
  (`abandonVault` in `src/sync/vault-keys.ts`) is reachable as `ipfs-sync abandon <vault>` (`cli/abandon-command.ts`;
  `--yes-abandon` confirms without a terminal) and, in the plugin, as the command "Abandon this vault" and a button in
  the Encryption section (`src/plugin/abandon-flow.ts`). It moves the local key-slot copy, state, journal and any
  maintenance journal for the MFS root to `.ipfs-sync/abandoned-<h>-<ms>/`, records no latch, prints the sequence floor it
  keeps, never contacts the node and deletes nothing. The CLI holds the cross-process `publish.lock` while it moves files; the plugin holds only the in-process
  sync lock (`src/plugin/abandon-flow.ts`), so a CLI publish running against the same vault folder is not stopped by a
  plugin abandon. Refusal messages quote
  `ABANDON_HOW` (`src/sync/abandon-hint.ts`). The abandon dialogs have never run in Obsidian.
- **Legacy 0.2.0 markers (history).** Before the guard removal, `pull` refused the three marker contents release 0.2.0
  wrote or accepted (`fixture copy created by ipfs-sync pull`, empty, `marker`) and `publish` used that wording only for
  the pulled-copy text. On `mvp-07b-guard-removal` no marker content is refused; `legacyMarkerProblem` and the marker
  readers stay exported in `src/sync/publish-guard.ts` and nothing that gates an operation reads them.
- **Plugin key-slot copy.** The plugin writes its local key-slot copy through Obsidian's adapter, and that write is not
  crash-atomic; the CLI copy is atomic (temporary file, then rename).
- **Plugin lock file.** Creation is a check that the file does not exist, then a rename of a fully written temporary
  file: two steps. Because `adapter.rename` may replace an existing target (unconfirmed in Obsidian), `createExclusive`
  in `src/plugin/adapter-lock-file.ts` reads the file back after the rename and compares the bytes; if the file is not
  ours it returns false and leaves the other holder's file alone, and if the read-back itself throws it removes our
  file before rethrowing. `src/sync/lock-token-check.ts` (`verifyHeld`, shared by the CLI and the plugin since `mvp-07a`)
  is a second check, run in `publish-runner.ts` right after the lock is acquired and before `publishUnderLock`; a
  mismatch throws `lock-held` and releases. Since `mvp-07a` the engine also awaits a fresh `verifyHeld` through
  `beforeFirstWrite` right before its first request that can change the node (resume, key creation or first blob, junk
  removal), in the CLI and the plugin. There is no token check immediately before each write to the node. After that the
  heartbeat (every 60 s) notices a replaced lock file, so a CLI publish and a plugin publish can overlap for up to one
  heartbeat interval (about 60 s) on a platform where rename overwrites. The plugin still depends on rename semantics
  for that window, and what `adapter.rename` does with an existing target in Obsidian is unconfirmed. The plugin lock
  has not been run in Obsidian.
- **Lock left by a crashed plugin.** The plugin's lock record carries a per-session host name, so a lock left by a crashed
  plugin is never recognised as dead and blocks publishing until its heartbeat has lapsed for 15 minutes. The plugin has
  a "Clear stale publish lock" command and a "Publish lock" section in the settings tab (`src/plugin/stale-lock.ts`). It
  is offered only when the lock's last heartbeat is at least 15 minutes old. Clearing takes the plugin's in-process sync
  lock for its whole duration (operation kind `clear-stale-lock`, added after review 5c), so it refuses as busy while a
  publish, pull or abandon runs and a publish started meanwhile is refused; it re-reads the age and token, moves the file
  aside, checks the moved bytes again, and puts the file back if it is not the lock that was seen. The in-process lock
  does not stop a CLI publish on the same vault folder. A lock file that cannot be parsed has no known age and is
  not clearable from the plugin: use `ipfs-sync publish --break-lock` on a computer. `--break-lock` deletes a live lock
  if it is run while a plugin publish is running. These actions have not run in Obsidian.
- **Vault writes by the CLI host bridge.** `cli/node-host-bridge.ts` now creates directories 0700 and files 0600 for
  vault writes, and writes through a temporary file. A crash can leave `.<name>.<pid>.<uuid>.tmp` inside a vault
  directory.
- **Plugin setup writes only the local copy.** Setup creates the local key-slot copy; the next publish writes
  `keyslots.json` to the node. The plugin cannot repair a vault; use the CLI.
- **Setup re-entry.** The setup dialog hands the displayed passphrase back as the value the re-entry is compared with, so
  the dialog model is the only gate for re-entry.
- **Multiple publishers.** A second device pulls first (§8.10) and then publishes at the next sequence; this is
  supported as a sequence of turns, not as concurrent writers. Concurrent publishes are narrowed, not prevented (§8.4,
  name re-check). The drift path removes stray blobs only when no other device was ever seen (`devicesSeen`, at most 16
  values) and the node's latest manifest names this device, so it protects another device's blobs only after this device
  has pulled a manifest of that device; the first overlap by a device that has never seen the other can still make the
  other device's read-back fail (that publish fails and is retried). No node-side marker exists. `--repair` in the ahead
  case is refused when a floor exists for the vault or the local state decodes; it remains only for a state file that
  exists, does not decode, and has no floor.
- **Recovery after a ratchet.** A holder of the vault key can publish a manifest with a very high sequence; every device
  that pulls it raises its floor and then refuses honest, lower manifests as older. The recovery is to delete the floor
  file (`sequence-floor.json`, which holds every vault's floor on that device) and the affected `state.<h>.json` files and
  pull again as a first pull. Deleting the per-user store, the plugin data or reinstalling the plugin removes the floor.
- **Fork resolution without an ancestor.** The common ancestor is the history entry at sequence N whose name carries the
  prefix, which authenticates for the same vault and sequence, and whose identity equals the state's `previousIdentity`;
  exactly one may match. Without one (no `previousIdentity`, which a first publish, a pull and an upgraded format 2 state leave null; no
  entry at the prefix; none or several matches) every file that differs from the node's becomes a conflict copy and the
  node's text takes the path.
- **Unicode.** Path normalisation differs across platforms and is not applied; a path is encoded exactly as the host
  reports it.
- **Mobile.** Recorded on 2026-10-02 from operator screenshots and reports on an iPhone (iOS 27.2 beta, Obsidian 1.13.7
  build 365), not reproduced by an agent (`.kbd-orchestrator/phases/mvp/children/mobile-feasibility/device-results.md`):
  Argon2id at 64 MiB, t = 3, p = 1 took 980, 1143 and 1133 ms in a probe build (`0.2.1-probe.1`), with a longest
  event-loop gap of 21, 17 and 17 ms (targets 3 s and 100 ms); the Mac baseline for the same function was 990 to 1177 ms.
  The release 0.2.0 plaintext build pulled 5 files (24 KB) and a 50 MB plus a 5 MB random file on the phone (the second
  is an operator report; time and responsiveness were not recorded). The first pull crashed the app once, which is
  unexplained; the relaunch loop that followed was an iOS file-provider hang (watchdog 0x8BADF00D) cleared by restarting
  the phone. These are measurements of that build, not claims about the encrypted pull: an encrypted publish or pull
  has not run on a phone, nothing was measured above 50 MB, background and suspend behaviour is unknown, and Android is
  untested. A phone test installs through BRAT from a GitHub pre-release with its own tag. On `mvp-07b-guard-removal`
  such a build takes a real vault, and its behaviour with one is unmeasured.

Unverified, or unenforced, at the time of writing:
1. Anything inside Obsidian: the setup, unlock and abandon dialogs, an encrypted publish from the plugin, HKDF, HMAC and
   AES-GCM under Obsidian's WebView (only a SHA-256 digest is recorded as having run in Obsidian 1.13.7), and
   `requestUrl` with multi-megabyte binary bodies and Range requests.
2. Encrypted publish and pull on a phone (Argon2id alone was timed on an iPhone; see "Mobile"), and Android.
3. Zeroization beyond the arrays the core owns.
4. Rollback and freeze prevention: a pull refuses a sequence below this device's record, and nothing detects a freeze or a
   stale first pull; the pull itself (CLI and plugin) has not been run in Obsidian, on a phone, or by the operator
   against the shared node.
5. An authenticated (auth-protected) kubo endpoint with the plugin.
6. The automated feature operation against the shared node ran twice on 2026-09-30 (task 6.2 and the delivery-cadence feature checkpoint). `tools/feature-op-mvp-06.mjs` (with
   `tools/feature-op-mvp-06/`) has an offline `--dry-run` and a `--local-stub` mode, records the IPNS pointer of
   `obsidian-vault-sync` before the first change, prints and records the sha256 of `dist/cli/ipfs-sync.mjs` and whether
   it changed during the run, and refuses `--allow-stale-build` on the shared-node path. Both shared-node runs: exit 0,
   121 of 121 checks, encrypted layout, publish #2 "1 written, 0 removed" at sequence 2, three kill points resumed,
   refusals sent no mutating request, and all 42 mutating requests stayed under
   `/obsidian-vault-sync/mvp06-demo/<runid>` and the own key. The hostile-object variants ran against a local stub only.
   Argon2id took 844, 1096 and 859 ms wall with a largest event-loop gap of 39 ms on the development machine. I did not
   run the script; this is the lead's recorded result (`.kbd-orchestrator/phases/mvp/decision-log.md`). Consequences:
   the two runs left two run folders (`muo58t8n-ed2e9a64` and `muo6r3gr-8907bcc4`) and their pins on the node, and
   repointed the IPNS key `obsidian-vault-sync`: from the mvp-05 plaintext demo root
   `/ipfs/bafybeihh4slp53ygsfk454pm4tqjbccd5tu6s6egu37gai2mvfnbw6aa7e` to the first run's root
   `/ipfs/bafybeiec4bfadcs3iaowvg4yiwh66ivnrn3sym4r6h4x4xtw262un5jxwu`, and then to the second run's root
   `/ipfs/bafybeifu652yt23rpx4d4wgzd4rvyehf6xob6m53dzy6rntni2osl6oz3u` (current; nothing was restored). Other keys are unchanged. Delivered behaviour differs from the task wording in two places: `--repair` on an older genuine
   manifest (behind) succeeds without a prompt, and only ahead and rebuild ask; the wrong-passphrase refusal sends two
   read-only requests (`files/stat`, `key/list`) and no mutating one. The build log records that the earlier
   `feature-op-mvp-02` to `05` tools, which target the removed plaintext path, no longer work.
7. Real kubo behaviour the reviews could not read: directory sharding of `manifests/` near 2,000 entries, the size of
   an `ls` reply against the 1 MiB cap, and partial-write semantics of `files/write` after an aborted request. A probe
   script (`tools/probe-node-assumptions.mjs`) exists; its findings are not recorded in this repository.
8. Real terminal behaviour of the passphrase prompt (raw-mode restore on `SIGTERM`, `SIGHUP`, `SIGTSTP`), Windows
   access-list and junction behaviour, and non-POSIX file systems.
9. How WebKit maps a failed AES-GCM operation to an error name, which the `authentication-failed` versus
   `platform-failure` split depends on.
10. The phase-boundary gate (typecheck, tests, build, bundle probes) for the fixes to review 5 and to review 5c. Review 5c
    re-read R5-01 to R5-08 statically (single model, nothing executed); it did not read the bodies of the R5 test files,
    and the later corrections (C5-01, C5-03, C5-04, C5-05) have not been re-read. C5-02 (item 12) is open.
11. Real Obsidian behaviour the reviews could not read: `adapter.rename` onto an existing target, `adapter.stat().mtime`
    (an mtime of 0 would make the scratch-file sweep delete live temporary files), and the path format returned by
    `adapter.list` on mobile (the sweep's `holding` check relies on it).
12. C5-02 (open for the "each write" case): the lock token is checked at acquire and, since `mvp-07a`, right before the
    first request that can change the node (not independently reviewed), not before each node write; see "Plugin lock
    file".

Deferred or accepted, recorded so they are not lost:
- A `.taken` file left by a crash between the move-aside and the discard in "Clear stale publish lock" is never cleaned
  up automatically (a few bytes in `.ipfs-sync/`); delete it by hand if you find one.
- Cosmetic, accepted: after an abandon, a second Publish can open a second unlock dialog over the first (the first is
  cancelled by the generation check). Whether `settling` deduplicates it was not verified.
- History: the pull notice `FIXTURE_ONLY_PULL_NOTICE` once read "no files outside .obsidian/ and .ipfs-sync/". On
  `mvp-07b-guard-removal` the constant keeps its name and carries neutral text ("pull was refused. Nothing was sent to
  the node and no file changed."), and no marker refusal reaches it.
- W-14 (untouched blobs are never re-verified), W-15 (mass removal) and W-16 (the plugin's `readRange` re-reads
  the whole file per segment, so a file over 8 MiB edited during upload can be uploaded as a mix of versions) were
  preconditions for removing the guard in `mvp-07b`. W-15 is now partly answered by the mass-removal guard (the 49 percent
  limit stays) and `prune-history` (N3-09) exists. W-14 is stated, not fixed.
- N2-13: `checkDistBundles` is not called by the release tooling (`tools/release-mvp-05.mjs`), so the dist-bundle check
  is not wired in. This blocks Release 2.
- R5-11 (accepted): the feature-op toolbox builds the test-hook folder name from parts (`["test","ing"].join("")`) so that
  it passes the import lint on purpose. The bundle it builds is written outside the repository, so nothing ships.

### 8.8 Passphrase handling in the CLI and the plugin

The CLI reads the passphrase from exactly one of: `IPFS_SYNC_PASSPHRASE_FILE` (POSIX: mode 0600 or stricter, owned by
the user, not a symbolic link, not a pipe), `IPFS_SYNC_PASSPHRASE`, or, with standard input a terminal and neither set, a
prompt that does not echo (256-byte limit). In tests with injected streams the terminal is restored after
Ctrl-C, Ctrl-D, a 257th byte, end of input and a failure to enter raw mode; restore on `SIGTERM`, `SIGHUP` and
`SIGTSTP` is unverified. Both variables set is an error. There is no
`--passphrase` flag and none is read from a configuration file. A passphrase file whose real path lies inside the vault
folder is refused with exit 2 before any request (`passphraseFileInsideVault`, `cli/run.ts`), because the next publish
would upload it; `init` and `abandon` do not read the variable and are not judged on it. Every source passes the canonical passphrase function
before any request. `ipfs-sync init` is the only command that creates a vault; it generates the passphrase, ignores any
passphrase in the environment, and either shows it once on a terminal and requires it to be typed again, or writes it to
a new 0600 file created exclusively (`--passphrase-file`) and prints only the path. The plugin asks for the passphrase
once per session, keeps only the non-extractable key set in memory, never writes a passphrase or key to `data.json`, and
never opens a dialog from the timer.

The CLI's other input boundaries, from the third review round. Credentials come from the environment only:
`--auth-password`, `--auth-token` and `--auth-header-value` are refused by name (`rejectCredentialFlags`, `cli/args.ts`) and
the value is never echoed. A `./ipfs-sync.config.json` that was found, not asked for, may not set `rpc.url` or
`gateway.url` while a credential comes from the environment or flags and the same address is not set there
(`assertImplicitFileDoesNotSteerCredential`, `cli/load-config.ts`); `--config` lifts the check. A credential on a
non-loopback `http:` endpoint gives a warning (`plainHttpWarnings`, `src/core/config/build-config.ts`). The state folder
must not be a symbolic link for any command that takes a vault (`cli/state-folder-link.ts`, called from `assertDirectory`
and from the key-value store and lock file on every operation), and `.ipfs-sync/` is created 0700. Standard input that is
not a terminal gives `CliIo` no `confirm` or `prompt`, so the commands that need a yes refuse before sending anything.
Node-supplied text is escaped in `status`, `escapeNodeText` covers zero-width and invisible code points, and a root CID
over 128 characters is refused where it enters (`src/sync/target-resolution.ts`, `commit-node.ts`, `src/kubo/ipns.ts`),
because the local record would write it and then refuse to read it back.

### 8.9 The publish guard, its removal and the release gate

**History.** Until the removal below, publish (CLI and plugin) and `init` refused any vault whose `.ipfs-sync-fixture`
file did not hold the text `fixture`, before a passphrase was looked at and before any request. `pulled-fixture`
(written by pull), an empty marker and any other text were refused, and pull accepted `fixture` and `pulled-fixture`.
**The marker was never protection: anyone who can create a file in the vault can create it.** Removing the guard was a
named `mvp-07b` task that requires the security reviewer's sign-off, a recorded in-Obsidian run, and a phone timing of
the key derivation or an explicit, informed operator acceptance (a timing on an iPhone exists, §8.7 "Mobile"; whether it
meets the precondition is for the operator and the reviewer). The case-fold and Windows path hardening for authenticated
manifests landed in `mvp-07a` as the pull path policy (§8.10). `main` still holds the guard.

**The branch that now exists.** Branch `mvp-07b-guard-removal` was cut from `main` at `ef50b1c` (the 0.3.0 version bump
in `manifest.json` and `package.json`, committed before the branch so the release tool edits no hashed file). It carries
one removal commit, `38db5f8`, which replaces the contents of `src/sync/publish-guard.ts` and `src/sync/pull-guard.ts`
with permissive versions and keeps every export name and signature. `assertPublishMarker` and `assertFixtureVault`
return without checking, `enablesPull` answers true, `assertPullDestination` and `assertVaultPullDestination` return
`{ needsMarker: false }`, `writeFixtureMarker` does nothing, and the notice, settings and help copy carry neutral text
("Any vault can be published.", "Any directory can be pulled into."). The marker parsing stays exported for its callers;
`src/sync/fixture-constants.ts` is unchanged. The commit also adds `tests/unit/guard-permissive.test.ts` (16 tests),
deletes `tests/unit/fixture-marker.test.ts` on this branch only, and adapts 20 other test files that asserted the old
refusals. It had not been run as a whole suite when this section was written; the phase gate (task 6.4) runs it once.

What stays refused, independent of the old policy: a state folder that is a symbolic link (`state-folder-guard.ts`,
called by the pull engine's first step and by both destination functions), a destination that exists and is not a
directory, a mass removal (§8.7), a missing or wrong passphrase, the path policy (§8.10), the locks, a sequence below the
recorded floor, and a plaintext root. After the removal a real vault publishes encrypted, a non-empty directory pulls
with the conflict policy, and the pull writes no marker.

**What the branch does not have.** No review record of this tree, no recorded manual operator run, no phone timing, no
tag and no release record. v0.3.0 is not cut. Anyone who publishes a real vault from this branch does so on the strength
of static reads of earlier trees by one model each (§8.1) and nothing else.

**The uncomfortable fact about `main`.** `main` is one commit ahead of the branch's base: `871257c` (the vault-agent UI
design set; it touches `docs/`, `AGENTS.md`, `.gitignore`, `.claude/agents/uiux-lead.md`,
`.agent-team/ipfs-sync/team.json` and `.agents/UI_UX_PROTOCOL.md`, none of them in the scope of T). The branch does not
contain it, so a fast-forward-only merge of the branch into `main` is not possible until the branch is rebased onto
`main` or `main` is merged into it. Either changes commit ids. Do that before the review record is written, not after:
the git-history form of item A binds the record to the reviewed commit, and the operator decides how.

**What the checker and the release tool bind to.** They bind to the committed tree of the branch HEAD, never to `main`
and never to the working tree. T is the hash over the scoped files of that commit (package and build files,
`manifest.json`, `src/`, `cli/`, `tools/release/`, `tools/feature-op-mvp-07/` and the checker, recorder and release
tools; the exact list is `TREE_SCOPE` in `tools/check-guard-preconditions.mjs`). The removal commit changes `src/`, so
T of this branch differs from T of `main`, and the reviewer reads this tree. `README.md`, `CHANGELOG.md`, `DESIGN.md` and
`docs/operator/encrypted-vault.md` are outside T. The checker hashes them from the commit into the evidence
(`DOCUMENT_FILES`) and requires the six limit sentences in the README and in this section. A documentation commit on the
branch therefore changes the documentation hashes in the evidence and does not change T; a change to any scoped file
after the review record or after the operator run changes T, and both must be redone.

**How the release is gated (delivered as tools).** The policy is centralised in `src/sync/fixture-constants.ts` (no
imports), `publish-guard.ts`, `pull-guard.ts` and `state-folder-guard.ts`. The release is gated by `tools/check-guard-preconditions.mjs`, which
exits 0 only when all of these pass: a tree hash T over a fixed scope of tracked files (blob bytes from the object
database; untracked, ignored, staged or flagged files in scope fail); build hashes B from a clean export built twice with
a scrubbed environment (`--build` copies the verified outputs into `dist/plugin/` and `dist/cli/` and writes
`dist/.guard-build.json`); item A, a review record `review-final-<T8>.md` with a machine-readable block, authenticated by
git history (the last commit that touched it descends from the reviewed commit, changed only that file, and T from the
reviewed commit equals T at HEAD; the commit count is printed) or by an `ssh-keygen -Y` signature against a trust
directory enrolled on a terminal (built and tested with a throwaway key only; the operator decided on 2026-10-03 that
Release 2 uses the git form and a typed acknowledgement, and `~/.ssh/id_ed25519` is not enrolled); item B, the operator-run
record in the per-user `feature-ops/` directory (manual mode, at most 14 days old, the required assertion ids held in the
checker); item C, phone timing through `tools/record-phone-timing.mjs` (measured: completed, parameters m=65536 KiB t=3 p=1,
under 3 seconds, longest event-loop gap under 100 ms, bound to the `main.js` hash; or an unmeasured acceptance with a typed
phrase, bound to T and B; the notes then list the timing as unverified); item D, `checkDistBundles` clean; item E, the named
checklist tests run in the clean export with zero skips, the limit sentences present in the README and in this section,
and `pnpm audit --prod` matched against dated accepted findings. The release tool (`tools/release-mvp-07.mjs`) runs the
checker in the same invocation, copies the checked bytes, asserts their hashes, edits no scoped file, needs a typed
`I accept an unsigned review record for <T8>` for the git form, and never runs git, tags, pushes or publishes. State
today: the checker, the recorder, the release tool, the operator-run script and the branch are built; the review record,
a recorded manual operator run and a phone timing are not, so items A, B and C cannot pass and no release can be
recorded. Item B counts only a manual run in Obsidian desktop against the shared node; a script-only result does not. The review record, the operator-run
record and the phone-timing record are attestations, not proofs (§8.7).

### 8.10 What one pull does

Delivered by `mvp-07a`, unreleased, covered by automated tests with fake nodes; not independently reviewed, not run in
Obsidian, on a phone, or by the operator against the shared node. The CLI (`cli/pull-command.ts`,
`cli/pull-encrypted-command.ts`) and the plugin (`src/plugin/pull-runner.ts`) call one engine, `pullEncryptedVault`
(`src/sync/encrypted-pull.ts` for steps 1 to 6, `src/sync/encrypted-pull-stage.ts` for steps 7 and 8). Which reader runs:
there is one reader. A root with `manifest.json` and no key slots is refused ("plaintext publications are no longer
supported", exit 2), and no flag reads it.

In order, and what each step may write:

1. Flag combinations that are never valid are refused before any request (`--resolve-fork` with `--allow-rollback`;
   `--allow-rollback` without `--root-cid` or `--manifest`; `--resolve-fork` with either of those).
2. The destination guard (the destination is absent or a directory, and the state folder is not a symbolic link; the
   marker rule of earlier trees is gone on `mvp-07b-guard-removal`). Refusal exits 2.
3. The in-process lock and `publish.lock` are taken (a held lock is a stop with publish's own text); `.ipfs-sync/tmp/` is
   swept while the lock is held; the state file is read (a damaged one is a stop); the target is resolved (name with
   `nocache`, `--root-cid`, or `--manifest`); the root is listed once; `keyslots.json` and `manifest.enc` are read by the
   CID of their listing entry, each refused above its cap before any byte is read. `manifest.json` is never requested.
4. Unlock (`src/sync/pull-unlock.ts`): `--expect-vault-id` and the record's vault are compared with the slot file's
   `vaultId` before any derivation. With a local key-slot copy the copy is unlocked first and the node's file must equal it
   byte for byte; without one, a slot above the default cost is shown and confirmed once (no terminal: refused). A wrong
   passphrase, a damaged slot and a failed commitment are one outcome and one message.
5. `manifest.enc` (or the chosen history entry) is authenticated and decoded; its `vaultId` must equal the slot file's; for
   `--manifest` its `rootCID` must equal the named CID. The path policy runs over the whole manifest.
6. The verdict (below). A first pull is shown and confirmed. The confirmation also states how many existing local files
   will be replaced ("at least N"), with a dated copy of each kept, and only when that count is above zero
   (`countReplacedLocalFiles` in `src/sync/encrypted-pull.ts`, shown by `cli/pull-encrypted-command.ts` and
   `src/plugin/first-pull-dialog-model.ts`). The count is a read-only preview: a first pull has no baseline, so it counts
   every local file that differs from the manifest at a manifest path, and the stage plans again. The same confirmation is
   required when the verdict is not `first-pull` but the directory has no state for this root (`run.state === undefined`
   in `authorize`): the device holds a floor, the folder holds no baseline, and every differing file is a conflict. It asks
   only when the preview count is above zero, and it shows `NO_STATE_PULL_STATEMENT` in place of the no-baseline statement.
   `--accept-first-pull` skips it; a run with no way to ask stops with `first-pull-not-confirmed`. The CLI passes the vault
   path as `destination` and prints it; the plugin does not pass one. Only then are the key-slot copy and, for a first pull or a
   newer manifest, the floor written. Nothing is written before this step except the lock and the sweep.
7. Plan: for every manifest path, the path policy first, then the symbolic-link prefix walk, then the three-way rule on
   plaintext sha256 (L missing: fetch; L = R: unchanged; L = B: replace; B = R: locally modified, left alone; otherwise
   conflict; with no `B`, a file that differs from the node's is a conflict). The size-and-mtime shortcut is bypassed when this device's exclusion
   list differs from the manifest's. A total above the ceiling needs a yes (otherwise every file to fetch is `unfetched`
   and nothing is requested). No marker is written (earlier trees wrote `pulled-fixture` before the first vault file
   when the destination was empty). Blobs are listed and read from `/ipfs/<manifest.rootCID>/`, never the root's mutable `current/`, by a bounded
   pool; each file goes through the free-space check (CLI only), `.ipfs-sync/tmp/<id>.part` (every segment authenticated;
   identifier, size and sha256 equal to the entry), the write-time path check, a conflict copy of the local file where the
   pull would replace an edit (made first; if it cannot be written the replace is aborted), and the rename.
8. The outcomes are merged into the baseline, a publish journal at or below the pulled sequence is moved aside, and the
   state is written last. An interrupted pull leaves whole files and the old state.

Verdicts, first match wins, against the effective record (the higher of the state's `highestSequence` and the floor; a
floor of another vault than the state's is ignored; equal sequences with different identities flag a conflict):
`refused` for a failed `--expect-vault-id` or `--expect-min-sequence`; `first-pull` with no record; `refused` for a
different vault; for a lower sequence, `restore` only for an explicit target with `--allow-rollback`, otherwise `refused`
(an unfinished adopted publish of this device is reported as "run publish", not as a rollback); for an equal sequence with
another identity, `fork-resolution` for a name target with `--resolve-fork`, otherwise `refused`; `same`; `newer`. The
record is raised by `first-pull`, `newer` and `fork-resolution`; no verdict lowers it. `src/sync/pull-sequence.ts`.

- **Restore** runs steps 7 and 8 with the existing baseline as `B`: files differ from it afterwards, so the next publish
  sees them as edits and publishes them as a new, higher sequence. The state changes only in `restoredFrom` (the lowest
  sequence a restore accepted), `devicesSeen` and the dropped `mtimes` of written paths. It deletes nothing.
- **Fork resolution** uses the common ancestor as `B` (`src/sync/fork-resolution.ts`; rules in §8.7), or no `B`. The
  floor is rewritten with the node manifest's identity after the fetch and before the state, so a crash between them
  leaves a fork that resolves again. The publish journal is not touched.
- **The state after a pull** has `rootCid` equal to the immutable root the target resolved to, `previousIdentity` null,
  `highest*` from the verdict, `devicesSeen` gaining the manifest's `device`, and `complete` and `unmaterialized` from the
  settlement: a path that is `integrity-failed` or `unfetched`, or skipped for a platform reason, keeps the node's entry in
  the baseline and joins `unmaterialized`, so a later publish carries it unchanged and publishes nothing from this device
  for it. `complete` is false iff a path is `integrity-failed` or `unfetched`; publish does not refuse on it.
- **Path policy** (`src/sync/path-policy.ts`, generated fold table `src/sync/path-fold-table.ts`). `expected`: the
  configuration folder or a match of the effective exclusion list. `unsafe`/`shape`: empty, absolute, backslash, control
  character, empty or dot segment, the state folder, a protected folder name by fold key. `unsafe`/`platform`: trailing dot
  or space, stream syntax, reserved device names, 8.3 short names, case-fold collisions, file/directory prefix groups, and
  a symbolic link or directory in the way on this device. The policy is not applied inside the manifest decoder (an honest
  Linux vault may hold a name such as `CON.md`, and a Linux device also refuses to write it on pull, carries it forward
  unchanged in its publishes, and exits 1); the publisher gets `adviseUnrestorablePaths`, a warning that never
  refuses. The CLI exits 1 for an `integrity-failed`, `unfetched` or `unsafe` path or a stop, and 0 for `expected` skips
  alone; exit 2 is a refusal before a request.
- **Restore listing.** `pull --list-versions` and the plugin's Restore list the newest 20 history names (prefixed names
  newest first, legacy names after them), and decrypt files of at most 8 MiB for date and device. The name is a claim; the
  entry the user chooses is authenticated again before any confirmation, and a name whose prefix disagrees with its
  manifest is refused.
- **Plugin.** `src/plugin/pull-runner.ts` offers Pull (never the rollback flag), Restore (the only caller of the rollback
  flag) and Resolve fork (after a confirmation, before the lock is taken); dialogs for the first pull, restore, fork and
  large pull set node-supplied values as text, not as HTML (no `innerHTML` in those files). The runner sweeps `.ipfs-sync/tmp/` on load only while it holds
  `publish.lock` by a try-acquire, and skips the sweep when the lock is held. The plugin's file `rename` removes an
  existing target first, so it is not atomic.

## 9. Explicit non-goals

- Real-time collaborative editing (single-writer-per-file is fine).
- Syncing `.trash`, `.obsidian` workspace state, or OS metadata.
- Background sync on iOS (impossible; not attempted).
- Windows/Linux desktop parity in 1.1 (plugin is platform-neutral; only macOS
  is tested).

## 10. Open questions (need user specs)

1. RPC auth mechanism (bearer via proxy? client certs? IP allowlist + Tailscale?)
2. Phase 2 encryption choice (per-file AES-GCM vs private network).
3. Embedding provider for Phase 3 (local vs API; which model).
4. Multiple vaults on one node? (MFS layout is currently single-vault.)
5. Retention: how many old manifests/roots to pin before GC?
6. Conflict policy preference: remote-wins vs duplicate-file (obsidian-decentralized's default).
