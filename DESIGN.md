# IPFS Sync — Design Document

Status: **draft — pre-implementation spec. Do not build from this without sign-off.**
Companion to the README (operations) — this file is the architecture spec.

## 1. Goals

- Sync an Obsidian vault over IPFS through our own kubo node
  (`https://ipfs.prometheusags.ai`) — no Obsidian Sync subscription, no third-party cloud.
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
| WebView has only HTTP(S)/WSS | Phones never speak libp2p/DHT directly; they reach an always-on daemon over WSS |

## 3. Architecture overview

```
┌────────────┐   HTTPS RPC    ┌──────────────────────────┐
│  Desktop   │◄──────────────►│  ipfs.prometheusags.ai   │
│  (plugin)  │                │  kubo: storage + pins    │
└────────────┘                │  + IPNS pointer          │
                              └──────▲───────────────────┘
┌────────────┐   HTTPS RPC         │ WSS (Phase 2)
│  iOS app   │◄────────────────────┘
│  (plugin)  │                ┌──────────────────────────┐
└────────────┘                │  VPS sync daemon         │
┌────────────┐   HTTPS RPC   │  (Phase 2: Helia+OrbitDB │
│ Android app│◄─────────────►│  "Voyager" persistent    │
│  (plugin)  │                │  peer, always online)    │
└────────────┘                └──────────────────────────┘
```

- **Phase 1.1 (this spec's implementation target):** snapshot pointer (IPNS) +
  delta transfers, all via kubo HTTP RPC. Mobile-compatible.
- **Phase 2:** op-log CRDT (OrbitDB) replicating through the VPS daemon; kubo
  remains the block store. Snapshot layer degrades to bootstrap/restore.
- **Phase 3:** AI layer — embeddings index as content-addressed data pinned to
  the vault root; semantic search, RAG chat, auto-backlinks.
- **Phase 4:** availability/polish — pinning strategy, selective sync, conflict center.

## 4. Phase 1.1 spec — delta sync over the RPC

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
- Files under exclusion paths are absent from `files` — exclusion list lives in
  the plugin settings, shared with the CLI via `scripts/excludes.txt`.

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

**Pull (delta, streamed):**
1. `name/resolve` → root CID → `cat <root>/.ipfs-sync.manifest.json`.
2. Compare manifest against local files (sha256 pool).
3. Fetch only missing/changed files via `cat` (pool), write via `vault.create` / `vault.modify`.
4. Conflict policy (unchanged from Phase 1): **remote wins, local content preserved**
   as `name (ipfs conflict YYYY-MM-DD)`. Never delete local files in 1.1.

**Triggers:** command palette (publish/pull/status), ribbon, on-load catch-up
(enabled per device), debounced after-save publish (opt-in). All foreground.

**Config sync:** `.obsidian/` stays excluded on mobile; desktop may optionally
include a whitelist of config files (plugin settings for this plugin).

### 4.4 CLI scripts

`publish.sh` / `pull.sh` gain the same delta logic (fixed `current/` tree,
manifest-driven). Scripts remain desktop tools; mobile uses the plugin only.

## 5. Server-side prerequisites (not plugin code)

1. **Gate `/api/v0` with bearer auth at the proxy.** The endpoint is currently
   open to the internet for writes (verified during bring-up). Plugin + scripts
   already send `Authorization: Bearer $IPFS_RPC_TOKEN` when set.
2. Optional: read-only gateway subdomain for content retrieval (`cat`/`get`
   without write scopes), if we want defense-in-depth.

## 6. Phase 2 spec sketch — op-log via sync daemon (not yet final)

- **Log model:** one OrbitDB `documents` record per vault file:
  `{ path, contentCID, sha256, size, mtime, deleted: bool, lamport }`.
  Attachments referenced by CID (dedup across devices for free).
- **VPS daemon:** Node process next to kubo; Helia + OrbitDB hosting the log
  ("Voyager"-style persistent peer). kubo continues to store/pin blocks.
- **Clients (desktop + mobile plugins):** replicate over **WSS to the daemon
  only** — no DHT, no raw sockets from WebViews. Delta sync on both ends.
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

This section describes the encrypted publish path delivered by change `mvp-06-encrypted-vault-publish`, as the code
stands. Where it contradicts §4.1 to §4.4 (plaintext layout, plaintext `manifest.json`, the shell scripts) or §6
("encryption decision pending"), this section describes what the code does today; those sections have not been
rewritten. Every constant below was checked against the code (module named in the last column of §8.3).

Read this first: the key-slot file is public, the node is open-write, and the only thing between an attacker and every
note ever published is the passphrase. Encryption is implemented but has not been independently reviewed to a standard
that permits real notes, and has never been run inside Obsidian. Real vaults are refused until that changes (§8.9).

### 8.1 Status and state of review

Delivered in `mvp-06`: encrypted-only publish in the CLI and the plugin; `ipfs-sync init`; the crypto core
(`src/crypto/`); per-root state, journal, resume, `--repair`, lock file and history check (`src/sync/`); the plugin key
session, setup, unlock and abandon dialogs (`src/plugin/`). Not delivered: pulling an encrypted vault (`mvp-07`),
passphrase change, additional key slots, `prune-history`, the history store (`mvp-08`).

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

Nothing has run in Obsidian (desktop or phone), the key derivation has not been timed on a phone. The feature-operation script ran
twice against the shared node on 2026-09-30 (§8.7 item 6).

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
| MFS layout | `<mfsRoot>/current/<xx>/<52 chars>`, `<mfsRoot>/manifests/<rootCID>.enc`, `<mfsRoot>/manifest.enc`, `<mfsRoot>/keyslots.json`; the root lists exactly those four entries | `src/sync/node-reader.ts`, `src/sync/read-back.ts` |
| Node response caps | listings and `files/stat` at 1 MiB and 2,000 entries; other RPC replies at 64 KiB; error bodies at 16 KiB; a blob is written in one request up to 32 MiB, otherwise per segment | `src/kubo/node-calls.ts`, `src/kubo/rpc-call.ts`, `src/kubo/http.ts`, `src/sync/chunked-write.ts` |
| History limits | warn at 1,500 files in `manifests/`, refuse at 1,999 | `src/sync/history-check.ts` |
| Full re-upload | above 256 MiB non-interactively needs `--allow-full-reupload` | `src/sync/publish.ts` |
| Local files | under `<vault>/.ipfs-sync/`, per MFS root, `h` = first 16 hex of sha256(mfsRoot): `state.<h>.json` (format 2), `journal.<h>.json` (format 1), `keyslots.<h>.json` (byte copy of the node's file), one `publish.lock` per vault (heartbeat 60 s, stale after 15 min without one, or at once if the recorded process is dead on the same host), `encrypted-seen.json` (pull latch) | `src/sync/root-files.ts`, `root-state.ts`, `journal.ts`, `publish-lock.ts`, `pull-latch.ts` |
| Marker | `.ipfs-sync-fixture` holding `fixture` (user or generator) or `pulled-fixture` (pull); read up to 64 bytes | `src/sync/fixture-marker.ts`, `src/core/config/node-safety.ts` |

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

In this order: marker guard (before the passphrase is looked at and before any request); in the CLI, the publish lock
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
crypto layer, and the pull engine applies them from `mvp-07`. Today nothing on the read side does.

### 8.5 Threat model

The adversary is anyone who can reach the node: its RPC endpoint accepts unauthenticated writes from the internet
(README, "Security: your RPC endpoint is wide open"), and its gateway serves every published object to anyone who knows
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
- **Rewrap does not revoke.** Changing the passphrase (rewrapping the slot, which is not yet implemented) does not
  revoke the old passphrase or any old copy of the slot: an old copy keeps opening the same VCK. Only re-encrypting the
  vault under a new VCK revokes access, and no code here does that.
- **Offline guessing is the residual risk.** Anyone with the root CID can fetch the slot and test guesses permanently. The
  defences are the generated 115-bit passphrase and Argon2id at 64 MiB and t = 3. The cost was raised from the original
  19 MiB and t = 2 because an old slot copy cannot be made more expensive later.
- **Generation-only is a guard, not a proof.** The check makes about 1 in 1,024 arbitrary 25-symbol strings valid by
  chance. It catches a mistyped body symbol with probability about 99.9% and a mistyped check symbol always; it never
  catches "every typo". It cannot show that a user did not choose or grind the text. The alphabet is RFC 4648 base32 and
  is not free of look-alike characters (S and 5, Z and 2, G and 6, I and L).
- **There is no recovery.** A lost passphrase, together with the loss of every copy of the key slots, makes the vault
  permanently unreadable. The local slot copy protects only against the node deleting the file.
- **The fixture marker is an accident guard, not a control.** Anyone who can create the file can override it (§8.9).
- **Local state is plaintext at rest.** `state.<h>.json` and `journal.<h>.json` hold vault paths. The `.ipfs-sync/` folder
  must be excluded from iCloud, Dropbox, Syncthing, backup tools and any other synchronisation. Deleting it resets the
  local state, including the `encryptedSeen` latch that stops a plaintext downgrade on pull, and turns this device into a
  stranger to the roots it published to (§8.7). `abandon` does not reset the latch: it records `encrypted-seen.json`
  before it moves any file (`abandonVault`, `src/sync/vault-keys.ts`), and an `abandoned-<h>-<ms>` backup folder counts as
  evidence of an encrypted vault in `isLatched` (`ABANDONED_BACKUP` in `src/sync/pull-latch.ts`). The CLI's key-value
  store lists directory names, so it sees the folder. The plugin's folder key-value store (`isKvEntry` in
  `src/plugin/obsidian-kv.ts`) was changed after review 5c found that it listed files only; it now lists folders whose
  name matches `ABANDONED_BACKUP`. That change is covered by tests with a fake adapter only and has not run in
  Obsidian. Deleting `.ipfs-sync/`, backup folder included, still resets the latch.

Non-goals (not hidden, not prevented, not provided):
- the number of files, the exact size of each file, when and how often a vault is published, which encrypted files
  change, the IPNS and DHT access pattern, the existence of the vault;
- preventing rollback or freeze by an open-write node (nothing on the read side enforces the sequence yet);
- protecting a device whose memory, environment or files are compromised, or other code in the same application context;
- forward secrecy and revocation: the VCK never rotates, and a leaked passphrase exposes every state ever published,
  including states in old pinned roots;
- deleting history: removing a note removes its blob from the current tree, and earlier roots stay pinned;
- recovery of a lost passphrase or lost key slots;
- device pairing, passphrase change, additional key slots and multi-writer merge (later changes);
- private swarms, relays, hiding network addresses;
- user-chosen passphrases (deferred; they would need an algorithmic repetition rule, Unicode-category classes, a
  leet-folded blocklist and an explicit acknowledgement flag);
- hiding or encrypting the local state and journal.

### 8.6 What the node sees

Names of `current/` entries are 52-character HMAC values under two-character prefix folders; blob contents begin with the
`ISBL` magic followed by ciphertext; `manifest.enc`, `manifests/<rootCID>.enc` and `keyslots.json` are the only other
objects. No request URL or body contains a vault path, file name or content other than through encrypted blobs and
`manifest.enc`; local terminal output may show vault paths and never shows the passphrase or a key. Events keep their
shape: `file.changed` carries its `path` inside the process only, and no persistent sink may store event paths.

### 8.7 Stated limits

- **Plugin transport.** The Obsidian `requestUrl` transport buffers whole response bodies. The streaming caps and the
  one-segment memory bound therefore give no memory protection inside the plugin for what the transport has already
  buffered; Range requests reduce the exposure only against gateways that honour them.
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
  yields a file of the same size is not noticed until the size or time changes.
- **History growth.** Every publish that changes something adds one `manifests/<rootCID>.enc` file, pinned forever, of the
  size of `manifest.enc` (about 4 to 14 MB for a vault of 5,000 to 20,000 files). Publishing warns at 1,500 and refuses at
  1,999. The `ipfs-sync prune-history` command named in the refusal does not exist in this build.
- **Reachable actions.** The plugin cannot repair or recover slots; those are CLI flags. It can clear a stale publish
  lock (see the next two items). The abandon action
  (`abandonVault` in `src/sync/vault-keys.ts`) is reachable as `ipfs-sync abandon <vault>` (`cli/abandon-command.ts`;
  `--yes-abandon` confirms without a terminal) and, in the plugin, as the command "Abandon this vault" and a button in
  the Encryption section (`src/plugin/abandon-flow.ts`). It records the encrypted-seen latch, then moves the local key-slot
  copy, state and journal for the MFS root to `.ipfs-sync/abandoned-<h>-<ms>/`, never contacts the node and deletes
  nothing. The CLI holds the cross-process `publish.lock` while it moves files; the plugin holds only the in-process
  sync lock (`src/plugin/abandon-flow.ts`), so a CLI publish running against the same vault folder is not stopped by a
  plugin abandon. Refusal messages quote
  `ABANDON_HOW` (`src/sync/abandon-hint.ts`). The abandon dialogs have never run in Obsidian.
- **Legacy 0.2.0 markers.** `pull` refuses the three marker contents release 0.2.0 wrote or accepted (`fixture copy
  created by ipfs-sync pull`, empty, `marker`) with a message that the marker predates this version and must be
  re-marked deliberately (`src/sync/pull-guard.ts`, `src/sync/fixture-marker.ts`). `publish` uses that wording only for
  the pulled-copy text; the other two get the generic refusal.
- **Plugin key-slot copy.** The plugin writes its local key-slot copy through Obsidian's adapter, and that write is not
  crash-atomic; the CLI copy is atomic (temporary file, then rename).
- **Plugin lock file.** Creation is a check that the file does not exist, then a rename of a fully written temporary
  file: two steps. Because `adapter.rename` may replace an existing target (unconfirmed in Obsidian), `createExclusive`
  in `src/plugin/adapter-lock-file.ts` reads the file back after the rename and compares the bytes; if the file is not
  ours it returns false and leaves the other holder's file alone, and if the read-back itself throws it removes our
  file before rethrowing. `src/plugin/lock-token-check.ts` (`verifyHeld`) is a second check, run in
  `publish-runner.ts` right after the lock is acquired and before `publishUnderLock`; a mismatch throws `lock-held` and
  releases. There is no token check immediately before each write to the node. After that second check only the
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
- **Multiple publishers.** Two devices publishing to one root are not supported. The drift path would discard the other
  publisher's changes, and `--repair` in the ahead case says so.
- **Unicode.** Path normalisation differs across platforms and is not applied; a path is encoded exactly as the host
  reports it.
- **Mobile.** Argon2id at 64 MiB and t = 3 has not been timed on a phone. The engineer recorded about 0.84 s wall time and
  about 16 ms worst event-loop gap on an Apple M1 Max with Node 24.16 (targets 3 s and 100 ms); that number is from the
  build log and was not reproduced when this section was written.

Unverified, or unenforced, at the time of writing:
1. Anything inside Obsidian: the setup, unlock and abandon dialogs, an encrypted publish from the plugin, HKDF, HMAC and
   AES-GCM under Obsidian's WebView (only a SHA-256 digest is recorded as having run in Obsidian 1.13.7), and
   `requestUrl` with multi-megabyte binary bodies and Range requests.
2. Argon2id timing on a phone.
3. Zeroization beyond the arrays the core owns.
4. Rollback and freeze prevention (unenforced).
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
12. C5-02 (open): the plugin's lock token is checked at acquire, not at the first node write; see "Plugin lock file".

Deferred or accepted, recorded so they are not lost:
- A `.taken` file left by a crash between the move-aside and the discard in "Clear stale publish lock" is never cleaned
  up automatically (a few bytes in `.ipfs-sync/`); delete it by hand if you find one.
- Cosmetic, accepted: after an abandon, a second Publish can open a second unlock dialog over the first (the first is
  cancelled by the generation check). Whether `settling` deduplicates it was not verified.
- The pull notice `FIXTURE_ONLY_PULL_NOTICE` (`src/plugin/pull-notices.ts`) now reads "no files outside .obsidian/ and
  .ipfs-sync/"; before, it named only `.obsidian/` although the guard also ignores `.ipfs-sync/`.
- W-14 (untouched blobs are never re-verified), W-15 (mass removal is silent) and W-16 (the plugin's `readRange` re-reads
  the whole file per segment, so a file over 8 MiB edited during upload can be uploaded as a mix of versions) are
  preconditions for removing the guard in `mvp-07`. So is `prune-history` (N3-09).
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
`--passphrase` flag and none is read from a configuration file. Every source passes the canonical passphrase function
before any request. `ipfs-sync init` is the only command that creates a vault; it generates the passphrase, ignores any
passphrase in the environment, and either shows it once on a terminal and requires it to be typed again, or writes it to
a new 0600 file created exclusively (`--passphrase-file`) and prints only the path. The plugin asks for the passphrase
once per session, keeps only the non-extractable key set in memory, never writes a passphrase or key to `data.json`, and
never opens a dialog from the timer.

### 8.9 The publish guard

Until mvp-07 removes it, publish (CLI and plugin) and `init` refuse any vault whose `.ipfs-sync-fixture` file does not
hold the text `fixture`, before a passphrase is looked at and before any request. `pulled-fixture` (written by pull), an
empty marker and any other text are refused; pull accepts `fixture` and `pulled-fixture`. The message states that
encryption is implemented but not yet independently reviewed or verified in Obsidian. **The marker is not protection:
anyone who can create a file in the vault can create it, and then the refusal is overridden.** Removing the guard is a
named `mvp-07` task that requires the security reviewer's sign-off, a recorded in-Obsidian run, and a phone timing of the
key derivation or an explicit, informed operator acceptance; `prune-history` and the case-fold and Windows path hardening
for authenticated manifests are also `mvp-07` work.

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
