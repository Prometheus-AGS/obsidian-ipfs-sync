## Context

Inputs read for this design: plan.md "Encryption design" and changes 6 and 7; decision-log sections of 2026-09-30; `.prometheus/gotchas.md`; docs/011 Q4 and Q6; the mvp-02 to mvp-05 designs and specs; the code in `src/sync`, `src/plugin`, `cli`; the independent security reviews `review-0.1.md` (S-01 to S-23) and `review-0.2.md` (N-01 to N-17 and the fold gaps), all accepted; this design is revision 3.

Facts from the code and dependencies:
- Publish today (`src/sync/publish.ts`): fixture guard, key resolution, scan and diff, verified per-file writes into `<mfsRoot>/current/<path>`, removals, `files/stat` of `current`, manifest v1 as `manifest.json` and `manifests/<currentCID>.json`, `files/stat` of the MFS root, `pin/add`, `name/publish`, local `state.json` (version 1), events.
- `@noble/hashes` 2.4.0 is installed and pinned; it exports `argon2.js` (`argon2idAsync`, options `t`, `m` in KiB, `p`, `dkLen`, `key`, `personalization`, `asyncTick`, `maxmem`, `onProgress`), `hkdf.js`, `hmac.js`, `sha2.js`.
- The pull guard and the manifest v1 reader are the only v1 consumers left after this change; pull already refuses manifest paths matching the exclusion list and `.obsidian/plugins/`.
- The plugin transport is Obsidian `requestUrl`; the CLI uses `fetch`. `crypto.subtle.digest` ran in Obsidian 1.13.7; HKDF and AES-GCM in-app are not yet observed.
- The node is unauthenticated and open-write; every byte fetched from it is attacker-controlled. Old roots stay pinned and fetchable forever (this project never unpins).

## Goals / Non-Goals

**Goals:**
- Nothing readable (content, paths, manifest) leaves the device on publish; real notes still do not leave it at all until mvp-07 lifts the marker guard.
- Tampering with any stored object is detected by AEAD; the reader requirements that detect swaps and replays are specified and tested at the crypto layer.
- Delta publish survives; a publish killed at any step resumes without locking the publisher out.
- Every claim has an automated check; every limit is written down.

**Non-Goals:** the threat-model spec lists them. Also out of scope: encrypted pull (mvp-07), passphrase change and revocation (mvp-07 and later), the history store (mvp-08), the real-vault run (mvp-10).

## Decisions

### 1. Key hierarchy
```
passphrase --canonicalise (25 symbols, checked)--> Argon2id(salt16; m=65536 KiB, t=3, p=1 default) --> KEK (32 B)
KEK --HKDF(salt=vaultId, info="ipfs-sync/slot/wrap/v1")   --> wrapKey  --AES-256-GCM(nonce12, AAD_slot)--> wrapped VCK (32 B + 16 B tag)
KEK --HKDF(salt=vaultId, info=commitInfo, length 32)       --> commitment (stored; constant-time check BEFORE decrypt)
   commitInfo = "ipfs-sync/slot/commit/v1" ‖ slotId(16) ‖ v(u32=19) ‖ m(u32) ‖ t(u32) ‖ p(u32) ‖ dkLen(u32=32) ‖ salt(16)
VCK (256-bit random)
  |-- HKDF-SHA256(salt=vaultId, info="ipfs-sync/name/v1")     --> nameKey (HMAC-SHA256 key)
  |-- HKDF-SHA256(salt=vaultId, info="ipfs-sync/manifest/v1") --> manifestKey (AES-256-GCM)
  '-- HKDF-SHA256(salt=fileId,  info="ipfs-sync/file/v1")     --> fileKey (AES-256-GCM), one per blob version
```
Unlock order (fixed): validate fixed fields and bounds; Argon2id; derive commitment; constant-time compare; derive wrap key; AES-GCM decrypt. The test-only unwrap hook calls the same internal function, so it fails on a corrupted commitment (a test proves it). `type` and `wrap.alg` are exact-match fixed fields, checked before derivation, and are also in the slot AAD. `vaultId` and `fileId` are 16 random bytes. A fresh `fileId` per encryption gives each blob version its own key, so random 96-bit nonces never share a key beyond one file version (at most 131,072 segments at 1 TiB).

### 2. Byte-exact formats (integers big-endian)
All hex is lowercase; all base64 is standard, padded and canonical (decode then re-encode must reproduce the text). `keyslots.json` read from the node must equal its canonical serialisation (sorted keys, two-space indent, trailing newline; duplicate keys rejected). The authenticated `manifest.enc` plaintext is not held to a whitespace rule (see manifest serialisation below).

**keyslots.json** (canonical form: keys sorted by UTF-16 code unit at every level, `JSON.stringify(value, null, 2)`, LF, one trailing newline, integers only; check order parse, version, canonical, schema; extra fields `malformed` except inside unknown-type slots, which are skipped; `no-usable-slot` if no passphrase slot remains; fixed-field violation on a passphrase slot refuses the whole unlock as `unsupported-format` before any derivation; only the at most 2 passphrase slots to be tried are bounds-checked, all before the first derivation):
```
{ "slots": [ { "commit": "<base64 32 B>",
               "id": "<32 hex>",
               "kdf": { "alg": "argon2id", "dkLen": 32, "m": 65536, "p": 1, "salt": "<base64 16 B>", "t": 3, "v": 19 },
               "type": "passphrase",
               "wrap": { "alg": "aes-256-gcm", "ct": "<base64 48 B>", "nonce": "<base64 12 B>" } } ],
  "vaultId": "<32 hex>",
  "version": 1 }
```
Slot AAD (identifiers are the raw 16 bytes, i.e. the hex text decoded; the same holds for every AAD and HKDF salt below) = `"ipfs-sync/slot/v1"` ‖ vaultId(16) ‖ slotId(16) ‖ v(u32=19) ‖ m(u32) ‖ t(u32) ‖ p(u32) ‖ dkLen(u32=32) ‖ salt(16) ‖ `"argon2id"` ‖ a single 0x00 ‖ `"aes-256-gcm"`. Every HKDF output is 32 bytes. Caps: file ≤ 16 KiB (checked by `files/stat` before reading and while streaming), ≤ 8 slots, prototype-free parse, ≤ 2 passphrase slots tried per unlock.

**Canonical passphrase and check**: a generated passphrase is 23 random symbols (115 bits, `byte & 31`, unbiased because 32 divides 256) plus 2 check symbols: the first 10 bits of SHA-256(UTF-8("ipfs-sync/passphrase/check/v1") ‖ ASCII(the 23 uppercase symbols)), as two base32 symbols of 5 bits each, most significant first. Canonical form: remove U+002D and U+0020, upper-case, require exactly 25 characters in `A-Z2-7` and a valid check, otherwise raise `passphrase-format` before any derivation. The KDF input is the 25 uppercase symbols without hyphens. Display: 5 groups of 5 with hyphens, monospace, "letters are case-insensitive". The check is not secret, so a UI may say "probable typo" without a network call. It catches a mistyped body symbol with probability about 99.9% (1 - 1/1024) and a mistyped check symbol always; about 1 in 1,024 arbitrary 25-symbol strings pass by chance. Tests: rejection rate at least 99.8% over 10,000 random passphrases x 25 positions, and pinned vectors (`HEZVI-DN7IB-GLQIX-B5L7V-ARDHC` valid; `CorrectHorseBatteryStaple` rejected, expected check `YK`, presented `LE`). Copy says "about 99.9%", never "every typo". The alphabet is RFC 4648 base32 and is not free of look-alikes (S and 5, Z and 2, G and 6, I and L). No Unicode normalisation is needed because only ASCII is accepted.

**Blob**: header 22 B = magic `"ISBL"` (0x49 0x53 0x42 0x4C)(4) ‖ version `0x01` ‖ exponent (`23`) ‖ fileId(16). Segments: nonce(12) ‖ ciphertext ‖ tag(16), 128-bit tag forced. Error classes: `malformed` only for structurally invalid input (bad magic, unsupported version or exponent, blob under 50 bytes, final piece under 28 bytes); everything else, including damage indistinguishable from tampering, is `authentication`. The reader needs the blob's total length from `files/stat` to know which segment is final. AAD_i = `"ipfs-sync/blob/v1"` ‖ vaultId(16) ‖ header(22) ‖ nodeName(32, the raw HMAC value) ‖ i(u64) ‖ final(1 B). Non-final segments hold exactly 2^exp bytes, the final 1..2^exp, an empty file is one empty segment. Blob length = 22 + 28n + plaintext length (exact; padding is a reserved later format version). A rename re-encrypts and re-uploads the whole file, because the name is in the AAD.

**manifest.enc**: header (17 B) = magic `"ISMF"` (0x49 0x53 0x4D 0x46)(4) ‖ version `0x02` ‖ nonce(12); then ciphertext ‖ tag. AAD = `"ipfs-sync/manifest/v1"` ‖ vaultId(16) ‖ header(17). Caps: **64 MiB** (stat before reading, enforced while streaming), ≤ 100,000 entries and ≤ 8 MiB of path bytes after decryption, `files` built without prototypes. Serialisation: `JSON.stringify` after sorting keys by UTF-16 code-unit order, no whitespace. The publisher checks every cap on the serialised plaintext and on `manifest.enc` before writing any blob. At roughly 330 to 400 bytes per entry, 100,000 entries fit under 64 MiB; a test proves it.

**Manifest v2 plaintext**: `{version:2, vaultId, sequence (1..2^53-1), rootCID, publishedAt, device, excludesHash, files:{<path>:{sha256, size, blob, fileId (32 hex), cid}}}` with the field formats of the manifest-v2 specification (sha256 and excludesHash 64 lowercase hex, `rootCID` a CIDv1 base32 string (`^b[a-z2-7]{10,}$`, a CIDv0 root is refused), entry `cid` CIDv0 or CIDv1 (`^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{10,})$`), publishedAt ISO-8601 UTC, device at most 64 characters, size 0 to 2^53-1, total path bytes measured in UTF-8). Paths obey the untrusted-path rules copied from the existing pull code into the manifest-v2 specification.

**Node names**: `current/<n[0..2]>/<n>`, `n` = base32-lower-nopad(HMAC-SHA256(nameKey, utf8(path))): 52 chars over `a-z2-7`, last character's four unused bits zero, compared by string equality with the recomputed name.

**Local files under `.ipfs-sync/`, per MFS root** (name includes the first 16 hex of sha256(mfsRoot)): `state.<h>.json` = `{version:2, mfsRoot, key, rootCid, vaultId, keyslotsSha256, sequence, manifest (plaintext v2 with blob CIDs), mtimes, encryptedSeen}`; `journal.<h>.json` = `{version:1, mfsRoot, key, vaultId, keyslotsSha256, sequence, manifestSha256, pending (plaintext manifest and mtimes), startedAt}`; `keyslots.<h>.json` = byte-identical copy of the node's file; `publish.lock` = `{token, pid, host, time}` created exclusively with a 60-second heartbeat; stale if (same host and pid dead) or (no heartbeat for 15 minutes on any host). Deleting the folder resets all of it, including `encryptedSeen`. The state and journal are plaintext at rest (they hold paths), so the folder must be excluded from iCloud, Dropbox and backup tools; the journal stores hashes wherever a hash is enough.

**Marker**: `.ipfs-sync-fixture` containing `fixture` (user or generator) or `pulled-fixture` (created by pull).

These formats, labels and numbers are this design's choices, fixed here so tests can assert them byte for byte; they must not change after release.

### 3. Deviations and refinements (each called out)
| Plan / input | This design | Reason |
|---|---|---|
| Argon2id 19 MiB / t=2 / p=1, "raise later by rewrap" | Default 64 MiB / t=3 / p=1; floors 19,456 KiB / 2 / 1; ceilings 131,072 KiB / 4 / 1 (S-01, S-06) | Old roots stay pinned; an old slot copy keeps working, so cost cannot be raised retroactively |
| Length-only passphrase rule, then a user-chosen policy | **Generated passphrases only** (25 symbols, 115 bits); user-chosen deferred (Q4 of review-0.2, N-07) | A data blocklist cannot enumerate repetition or leet variants; removing the choice removes the class of weakness |
| AES-GCM wrap only | HKDF wrap key plus a stored commitment with byte-exact commit info, checked first (S-05, N-09) | AES-GCM has no key commitment |
| Blob AAD without the node name | AAD binds the 32-byte HMAC node name (S-08) | A blob moved to another name must fail at the crypto layer |
| Name and manifest keys `HKDF(VCK, label)` | Salt = `vaultId` | Domain separation per vault |
| Manifest v2 = v1 plus sequence and blob map | Adds `vaultId`, per-entry `fileId` and blob CID | Reader can check the blob header against the authenticated manifest; writer can verify written blobs |
| Fixture guard removed with a passphrase | **Guard stays** for both hosts until mvp-07; marker value `fixture` only (Q8, S-11) | Not yet independently reviewed or verified in Obsidian |
| Publisher trusts local state | Compares with the node's authenticated `manifest.enc`; journal with an exact resume protocol; explicit `--repair`; diagnose-first baseline check; scoped read-back before pin and publish (S-02, S-04, S-07, N-01, N-02, N-03, N-05) | No self-lockout, no full re-upload on a nudge, and what is pinned is what was verified |
| Caps only on readers | Writer checks every cap first; manifest cap 64 MiB; listing and stat responses capped at 1 MiB and 2,000 entries (N-10) | A publisher must not write what it cannot read back |
| (not in plan) | Per-root state, journal and slot copy; hash and `vaultId` checks before any KDF; `--recover-slots`; abandon action (S-09, N-08) | Wrong passphrase fails without a request; no derivation on node-chosen parameters when local knowledge is missing |
| (not in plan) | Plaintext-root refusal; a vault is created only by `ipfs-sync init` (which generates the passphrase), never by `publish` (S-18) | Protects existing data; creation accepts only generator output |
| Pull reads v1 freely | `encryptedSeen` latch, `--allow-plaintext-v1`, refuse `.obsidian/*` (S-10) | Downgrade to plaintext; forged config |
| Role split by files | `vault-keys.ts` and `session-keys.ts` with identity-security-engineer; early security gate; second review point; reference decryptor written or cross-checked by ipfs-engineer (S-14, N-16) | Secret handling and format freezing need independent eyes before wiring |

### 4. Publish flow (encrypted)
0. Marker guard (value `fixture`), then require an unlocked key. If the per-root key-slot copy exists, unlock locally first (a wrong passphrase makes no request). Take the lock file.
1. Journal check with the exact resume protocol (encrypted-publish spec): hash equal means decrypt and compare `vaultId`, sequence, `rootCID` and the file map with `journal.pending`, write the history file from the node's `manifest.enc` bytes if absent, refuse if present with different bytes, then read-back and complete; a failed read-back or a torn journal is discarded; a `current` CID that differs from `manifest.rootCID` means adopt `journal.pending` as local state at the journal's sequence, delete the journal and run the drift path at sequence + 1; sequence equal to the journal's minus one means the manifest was never written, discard the journal.
2. Read-only inspection: `files/stat <mfsRoot>` (absent means new); `files/ls <mfsRoot>` one level; refuse `manifest.json` or `current/` entries not matching `<2>/<52>`; responses capped at 1 MiB and 2,000 entries. Bounded fetches of `keyslots.json` (≤ 16 KiB) and `manifest.enc` (≤ 64 MiB) through the gateway by root CID. A device with no state, no copy and `manifest.enc` present is refused before any KDF; slots present with no manifest and no local knowledge are refused before any KDF (`--recover-slots` shows the cost and asks first). The node's slot-file hash is compared with the recorded one and its bytes with the local copy before any KDF on node-supplied parameters. Authenticate `manifest.enc`; apply the sequence rules; on a behind or ahead refusal, `--repair` is available under its conditions.
3. Baseline check with diagnosis: compare the CID of `current` with `state.manifest.rootCID` and the root with `state.rootCid`. On a `current` difference, one `files/ls -l` of `current/` and its prefix folders is compared with the recorded blob CIDs; only missing or mismatching blobs are rewritten; names matching `^[a-z2-7]{2}/[a-z2-7]{52}$` that are not in the new manifest are removed; anything else is reported as an anomaly and left; removal never touches `manifests/`, `keyslots.json` or `manifest.enc`. Full re-encryption only when diagnosis cannot establish state; non-interactive full re-upload above 256 MiB needs an explicit flag (interactive: confirmation). A difference in `keyslots.json` or `manifest.enc` refuses.
4. Writer-side cap checks on the serialised plaintext manifest and `manifest.enc` size, before any blob is written.
5. New vault (only with the explicit request): generate VCK, `vaultId`, slot; write `keyslots.json` via the `files/write` wrapper; keep the local copy and record its hash.
6. Scan and diff on plaintext sha256. For each write: encrypt segment by segment (one segment in memory), write the blob with the wrapper (one request up to 32 MiB, otherwise per-segment offsets), verify size with `files/stat` and record the blob CID. Removals delete blobs by recorded name. Writes mutate `current/` in place; the previously published root stays intact and pinned, so readers of the old root are unaffected.
7. `files/stat current`; build manifest v2 (`sequence + 1`); encrypt; write the journal; write `manifest.enc`, then the history file.
8. `files/stat <mfsRoot>`; read-back through the immutable `/ipfs/<rootCid>/...`: the root lists exactly `{current, manifests, manifest.enc, keyslots.json}`; every name in `manifests/` is `<cid>.enc`; `manifest.enc` authenticates with the expected sequence; `keyslots.json` equals the local copy; the CID of `current` equals `manifest.rootCID`; history bytes equal; `files/ls -l` of the prefix folders touched in this run shows each written blob's CID as recorded. The engineer confirms and records which read-only call yields the child CIDs (a `files/stat` on the `/ipfs/` path is the candidate). Then `pin/add` and `name/publish` with exactly the verified root CID string (never the MFS path), state write, journal removal, lock release. Untouched blobs are not re-verified per publish.
Empty prefix folders left by removals stay; they reveal only that a name with that prefix once existed.

### 5. Pull until mvp-07
Detection order: if `keyslots.json` or `manifest.enc` is present, raise the "encrypted vault, pull not supported yet" error and latch `encryptedSeen`; else, with `--allow-plaintext-v1` and no latch, read `manifest.json` (v1). The v1 path, the fixture destination guard and the flag are removed by mvp-07. Manifest paths under `.obsidian/` are refused in addition to `.obsidian/plugins/`; this stops the v1 path from syncing Obsidian's own configuration files, which the earlier demonstrations did. The latch lives in local state and is lost if `.ipfs-sync/` is deleted (stated).

### 6. Passphrase handling
- Sources and prompt behaviour as in the passphrase-input spec: `IPFS_SYNC_PASSPHRASE`, `IPFS_SYNC_PASSPHRASE_FILE` (0600, not a symlink, not foreign-owned; on Windows there is no POSIX mode check, so symlink and ownership are checked where possible and a warning is printed), or a raw-mode no-echo prompt; no flag; `ipfs-sync init` to create a vault: interactive (passphrase generated, shown once, re-entered) or `init --passphrase-file <path>` (generated, written 0600 by exclusive create, path printed, never the passphrase); `publish` and later `pull` only unlock. The config-file loader's secret-key list gains `passphrase`.
- Generated passphrase only (23 random symbols plus a 2-symbol check). Setup shows it once, asks to save it in a password manager and requires re-entry. User-chosen passphrases are deferred (they would need an algorithmic repetition rule, Unicode-category classes, a leet-folded blocklist and a separate `--own-passphrase-ack` flag).
- Memory: bytes overwritten after derivation including intermediates; VCK imported as a non-extractable HKDF key; derived keys non-extractable. Stated limits: the runtime may copy buffers, the environment variable is visible to the user's processes, strings cannot be zeroed, another plugin in the same context could use the key object.
- Argon2id: `argon2idAsync` with `asyncTick` 10 ms, explicit `maxmem` equal to the ceiling, `onProgress` driving the "unlocking; keep the app in the foreground" indicator. No Worker. Targets for one default derivation (64 MiB, t=3): at most 3 s foreground on the development machine, no event-loop gap above 100 ms; if unmet the engineer reports and the lead decides. Phone timing is a hard precondition of lifting the marker guard, or an explicit informed operator acceptance.
- No fallback when `crypto.subtle` is missing (typed error); a tiny HKDF and AES-GCM self-test runs on first unlock per host. Confirm whether Node 24.15 has `crypto.argon2` for the independent cross-check.

### 7. Test obligations (mapped to the specs)
Vectors: RFC 5869 A.1 to A.3 plus empty and long `info`; RFC 4231; McGrew and Viega cases 13 to 16 and NIST `gcmEncryptExtIV256` (cases 17 and 18 excluded) including a tag-failure vector; RFC 4648 base32 and base64; RFC 9106 §5.3 through an unexported `argon2idRaw` that bypasses the floors, plus a floor-parameter output cross-checked against an independent implementation; fixed-output vectors pinning the three key labels and salts and the commitment derivation with its exact information bytes; u32/u64 AAD encodings including index > 2^32; the canonical passphrase function (25-symbol folding, everything else rejected). Independent verification: a test-only reference decryptor written or cross-checked by the ipfs-engineer (not the module author) from the specification text with `node:crypto` and no import of `src/crypto`, diffed against the spec by the security-reviewer at task 2.5, decrypting blobs, slots and manifests, plus AAD-component mutation tests. Property tests: exhaustive bit flips (100-byte blob, manifest); sampled flips (three-segment blob at exponent 16); reorder, duplicate, truncate at every byte boundary, extend, splice; other vault, other file, other node name; negatives (segment under 28 bytes, trailing garbage, non-final segment short or empty, exponent outside 16..24, tag length forced to 128); a structural test that no file identifier repeats; 100,000 distinct nonces; slot parameter, commitment, fixed-field tamper; floors and ceilings; oversize and deep or huge `keyslots.json`; a synthetic manifest at the entry cap under the size cap. The contract is that the decrypt iterator yields only authenticated segments and the caller treats the file as untrusted until completion.

### 8. Layering, files and ownership
`src/crypto/` (kebab-case): `random.ts`, `codec.ts`, `hkdf.ts`, `aes-gcm.ts`, `hmac.ts`, `argon2.ts`, `errors.ts`, `key-slots.ts`, `blob.ts`, `blob-names.ts`, `manifest-envelope.ts`, `passphrase.ts` (canonicalisation, generation), `self-test.ts`, `index.ts`; test-only helpers in `src/crypto/testing/` (`argon2id-raw`, `unwrap-vck`), each with a unique sentinel string, excluded from bundles (sentinel grep, build metafile assertion, lint rule). `tests/support/reference-decryptor.ts`. `src/sync/`: `vault-keys.ts`, `encrypted-manifest.ts`, `encrypted-transfer.ts`, `journal.ts`, `publish-lock.ts`, `repair.ts`, `state.ts` (v2), `publish.ts`, `pull-target.ts`. `cli/passphrase-input.ts`. `src/plugin/session-keys.ts`, dialogs.
Ownership: identity-security-engineer writes `src/crypto/**`, `vault-keys.ts`, `session-keys.ts` and the vector files; ipfs-engineer writes the reference decryptor cross-check, `encrypted-transfer.ts`, `journal.ts`, `publish-lock.ts`, `repair.ts`, `state.ts`, `publish.ts`, pull changes and `cli/passphrase-input.ts`, with named reviews of `encrypted-transfer.ts` and `cli/passphrase-input.ts` by identity-security-engineer. `package.json` and lockfile: ipfs-engineer only. Gating: sections 3 requires task 2.5 closed (`review-2.md`, no open critical or high finding); a second review point (`review-3.md`) follows tasks 3.1 to 3.4 and precedes any section-4 task; the shared-node run (6.2) requires the final gate (5.2) closed.

## Feature Operation (fully automated, no operator)

`node tools/feature-op-mvp-06.mjs`, using the built CLI, against the shared node under `/obsidian-vault-sync/mvp06-demo/<runid>` with the existing owned key (stable feature-op config). A random valid generated passphrase (23 symbols plus check) per run reaches the CLI child by `IPFS_SYNC_PASSPHRASE_FILE` (a 0600 temporary file outside the repo) or the environment, and is never printed. The script bundles `src/crypto` and the test-only hooks with the project's esbuild into a temporary module outside the repo, and bundles the local recording-node helper for the hostile-object phase. Hardening: before every child spawn the script asserts that the effective API URL is the intended target (the shared node in the shared-node phase, the loopback stub in the local phase) and ignores user and project configuration files; the fault-injection proxy allows only an allowlist of `/api/v0` paths and arguments confined to the demo root; `--cleanup` validates the run identifier against `^[a-z0-9-]{8,}$`.

Shared-node phase (read-only checks plus the CLI's own publishes; the script writes nothing itself):
1. Generate a fixture vault (marker `fixture`); add a repetitive 256 KiB note; record note titles, folder names and distinctive body words.
2. `ipfs-sync init --passphrase-file <per-run temp path>` (the script never prints the passphrase), then `ipfs-sync publish` with `IPFS_SYNC_PASSPHRASE_FILE` pointing at that file; record the summary and sequence.
3. (a) One level of `files/ls` at a time (root, `current`, each prefix folder, `manifests`): only `current`, `manifests`, `manifest.enc`, `keyslots.json`; two-character prefix folders; 52-character blob names; a stray file in a prefix folder is an anomaly; no recorded title or path in any listing or in the bytes of `manifest.enc`, `keyslots.json` or any blob. (b) Each blob starts with the magic; the large note's blob body has byte entropy of at least 7.99 bits per byte. (c) `keyslots.json` has exactly the documented fields; using the test-only unwrap, neither the raw VCK (raw, hex, base64) nor the KEK occurs in any fetched byte; the fetched manifest decrypts and lists the fixture paths.
4. Edit one note, publish: `1 written, 0 removed`; only that blob's CID changed; `sequence` 2; a second history file exists.
5. Resume: through the script-side fault-injecting proxy (the CLI is pointed at `http://127.0.0.1:<port>`; the proxy forwards until it has forwarded the `manifest.enc` write and then drops connections), the next publish is killed after the manifest write; a rerun without the proxy completes with sequence advanced by exactly one and no "another device" refusal. Kill between `manifest.enc` and the history file: the rerun writes the history file from the node's bytes. A kill before the manifest write leaves changed blobs; the rerun diagnoses and repairs with a consistent result and rewrites only what differs. No product code contains a fault hook. A dropped connection during a `files/write` may leave a truncated blob under the demo root, which the next publish diagnoses.
6. Refusals with an empty request trace: wrong passphrase (local copy present); a non-fixture directory with and without a passphrase; a directory with a `pulled-fixture` marker; `publish` against an empty root (no vault; it must point to `init`).
7. Local-fixture phase against a script-hosted stub node (never the shared node): oversize `keyslots.json` (refused without download), oversize `manifest.enc`, a `keyslots.json` differing from the local copy, a slot with a modified commitment, a 4 GiB memory parameter, an older genuine manifest (refused; `--repair` accepted only under its conditions): each refused with the typed message and no write.
8. Argon2id timing at the default cost (three runs, largest event-loop gap) printed; a fetched blob copied in memory, one bit flipped, decryption fails, the unmodified copy decrypts.
9. `files/ls /obsidian-vault-sync` and `key/list` before and after: only the run's demo folder and at most the owned key differ. `--cleanup` is opt-in and limited to `/obsidian-vault-sync/mvp06-demo/`.
Exit nonzero on any failed check; print each result. Unverified after a pass: phone timing, in-app plugin flow, authenticated endpoint, zeroization, plugin large-body transport.

## Working agreements

An engineer's report must paste the output for each Verify line of a task before that task is ticked; a tick without pasted output does not count.

## Risks / Trade-offs

- [History growth: one history file per publish against a 2,000-entry listing cap] -> the publisher warns at 1,500 entries and refuses cleanly at 1,999 with a message naming `ipfs-sync prune-history`, which is required mvp-07 work; frequent auto-publish reaches the cap sooner.
- [The plugin's request transport buffers whole response bodies] -> streaming caps give no memory protection in the plugin; Range requests help only compliant gateways; stated in the limits.
- [The engine derives Argon2id from a passphrase on every publish] -> the plugin passes an already unlocked key provider so a timer tick never re-derives.
- [Code in the same JavaScript context that holds the session's key set can derive and export raw file, name and manifest key bytes with the public labels] -> non-extractability only protects the base key object; stated in the limits.
- [Public key slot enables permanent offline guessing] -> Argon2id 64 MiB / t=3 and a generated 115-bit passphrase; no user-chosen option. A rewrap does not revoke old copies (stated).
- [64 MiB / t=3 on a phone is unmeasured] -> hard precondition of lifting the guard.
- [Journal, resume, repair and drift logic is new state-machine code] -> kill-after-each-step tests, the proxy-based feature checks, the second review point after wiring and the final gate.
- [Each publish adds a full `manifest.enc` plus its history copy, pinned forever] -> about 4 to 14 MB per publish for a vault of 5,000 to 20,000 files; storage grows with every publish and this project never unpins.
- [Read-back and diagnosis add requests to a publish] -> accepted for integrity; diagnosis lists up to about 1,024 prefix folders.
- [The publisher pins whatever is in `current/` at snapshot time, including an object planted during the write window, unless read-back catches it] -> stated; untouched blobs are not re-verified per publish.
- [Lock file is best effort, not atomic across machines] -> stated; `--break-lock` exists.
- [Local state and journal are plaintext] -> the `.ipfs-sync/` folder must be excluded from third-party sync and backups; deleting it resets state, including `encryptedSeen`.
- [No recovery] -> the local slot copy protects only against node-side deletion.
- [Manifest caps (100,000 entries, 64 MiB) may block very large vaults] -> the writer refuses clearly before writing.
- [A rename re-uploads the whole file] -> the node name is bound into the encryption; stated.
- [Unicode normalisation of paths differs across platforms] -> documented, not normalised.
- [Whole-file reads on Obsidian per range] -> quadratic near the read cap; noted.
- [Leftover plaintext from earlier fixture publishes stays public and pinned] -> refused as an MFS root; use a new one.
- [The feature operation's proxy and stub could be misconfigured to target the wrong node] -> the URL assertion before each spawn, the path allowlist and the ignored configuration files.

## Migration Plan

New encrypted vaults use a new MFS root and are created with `ipfs-sync init` (or the plugin setup dialog). Existing plaintext fixture roots are refused. Existing fixture markers must contain `fixture`; regenerate or edit (the generator is updated). Local state of format 1 is ignored. Pull no longer syncs `.obsidian/*` from v1 roots. Rollback: `git revert` restores plaintext publishing; encrypted roots created meanwhile stay on the node, unreadable without the passphrase.

## Handoff to mvp-07

1. **Remove the fixture-marker guard** for publish (CLI and plugin) as an explicit task, only after the security-reviewer's sign-off on this change's code, an in-Obsidian run of encrypted publish and unlock with evidence recorded, and a phone measurement of Argon2id at 64 MiB / t=3 (or an explicit, informed operator acceptance).
2. **Passphrase change** as a rewrap: a fresh salt and a fresh wrap nonce; the VCK is non-extractable after unlock, so rewrap and adding a slot need a second derivation from the passphrase. A rewrap does not revoke old passphrases or old slot copies; only re-encrypting under a new VCK does.
3. **Decrypting pull** with the reader requirements of the encrypted-blobs spec, fail-closed errors, temp-file and rename, sequence enforcement (refuse lower than recorded), refusal of executable and configuration paths by default, removal of the v1 reader, its flag and the pull fixture guard; recording the sequence so a pulling device can publish again.
4. **Second-device publish** after a pull records state, slot copy and sequence. **Multi-publisher guard**: with two publishers, the diagnosis and drift path must never let device A delete device B's in-flight blobs; until that guard exists the `--repair` ahead case warns that it discards other publishers' changes.
5. **In-app verification** of the setup and unlock dialogs, encrypted publish from the plugin, HKDF and AES-GCM inside Obsidian, and `requestUrl` with multi-megabyte binary bodies.
6. **User-chosen passphrases**: deferred; they would need the algorithmic repetition rule, Unicode-category classes, a leet-folded blocklist and a separate `--own-passphrase-ack` flag.

8. **`prune-history --keep N`** (required mvp-07 work): removes the oldest `manifests/<cid>.enc` files from the working MFS tree only; refuses unless the newest manifest authenticates; keeps at least the latest 20; needs confirmation; never touches `current/`, `manifest.enc` or `keyslots.json`; old roots stay pinned and fetchable.
9. **mvp-08 notes** (history store): `file.changed` keeps its `path` in the process only; the store adapter specification of mvp-08 must forbid persisting event paths (a persistent sink stores counts, hashes and CIDs only).
7. **Path hardening required in mvp-07** (review-2, G-10): extract `untrustedPathReason` into `src/sync/manifest-paths.ts` now (mvp-06 task 2.6b); mvp-07 must add case-fold and Windows hardening (the first segment `.ipfs-sync` folds from U+0131 and U+017F on NTFS and APFS; trailing dots and spaces; `::$DATA`; 8.3 short names) and apply the write-side exclusion checks (`.obsidian/` incl. plugins, the exclusion list) at the manifest layer, so an authenticated manifest from a compromised device cannot name them.

## Open Questions

Decided by the lead (2026-09-30): default Argon2id 64 MiB / t=3 / p=1 with ceilings 128 MiB / 4 / 1; generated passphrases only; reader exponents 16 to 24; random nonces under per-file-version keys; HKDF salts; no manifest padding; unrecoverable loss accepted with explicit text; marker guard stays until mvp-07; findings S-01 to S-23 and N-01 to N-17 accepted, including `--repair`, diagnose-first drift, manifest cap 64 MiB, the second review point and the local-state exclusion statement.

Remaining, none blocking:
1. **Acceptance targets** (3 s, 100 ms) at the new cost: measured foreground on the development machine; if unmet, the engineer reports and the lead decides.
2. **Manifest caps** (100,000 entries, 8 MiB of path bytes, 64 MiB file) are proposals; a very large vault would be refused clearly.
3. **Lock timing** (60-second heartbeat, 15-minute staleness) and the journal format are proposals.
4. **Which read-only call** returns the child CIDs for the read-back (`files/stat` on an `/ipfs/` path is the candidate); the engineer confirms against the node.
5. **Independent Argon2 implementation** for the floor-parameter cross-check: Node's `crypto.argon2` if present in 24.15, else a second published vector set; the engineer confirms.
6. **Plugin `requestUrl` and binary bodies** for multi-megabyte blobs: unverified; verified in mvp-07's operator run.
7. **Non-interactive KDF-cost confirmation**: a non-interactive host refuses slots above the defaults; whether an override flag is wanted is open.
8. **Full re-upload flag name and threshold** (256 MiB) are proposals.
