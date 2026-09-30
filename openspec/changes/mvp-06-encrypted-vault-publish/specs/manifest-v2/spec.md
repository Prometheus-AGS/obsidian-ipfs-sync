## Purpose

Defines the encrypted manifest that lists a vault's files, and the layout of the MFS root, so that paths and hashes are hidden, tampering with the manifest is detected, and the sequence gives devices that track it a way to notice an older state.

## ADDED Requirements

### Requirement: Manifest v2 content
The manifest SHALL contain: `version` (2), `vaultId`, `sequence`, `rootCID` (the CID of `current/`, read before the manifest is written), `publishedAt`, `device`, `excludesHash`, and `files`, mapping each vault-relative path to `{sha256, size, blob, fileId, cid}`. `sha256` and `size` describe the plaintext, `blob` is the node name of the file's blob, `fileId` is the blob's file identifier as 32 lowercase hex characters, and `cid` is the CID of the blob on the node. Field formats: `version` is the integer 2; `vaultId` is 32 lowercase hex characters; `sequence` is an integer from 1 to 2^53 - 1; `rootCID` is at most 128 characters and a CIDv1 base32 string as returned by kubo, matching `^b[a-z2-7]{10,}$` (a CIDv0 `rootCID` from the node SHALL be refused with a typed refusal); `publishedAt` matches `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$` and also passes explicit range checks (month 1 to 12, a day valid for the month including leap years, hour 0 to 23, minute 0 to 59, second 0 to 59), with no reliance on the engine's date parser; `device` is 1 to 64 Unicode code points (never empty; a publisher truncates a host name by code points), contains no lone surrogate and no control character in U+0000 to U+001F or U+007F; `excludesHash` and each `sha256` are 64 lowercase hex characters; `size` is an integer from 0 to 2^53 - 1; `blob` is the 52-character canonical name; `fileId` is 32 lowercase hex characters; `cid` is at most 128 characters and a CIDv0 or CIDv1 string matching `^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{10,})$`. Every number SHALL be a canonical decimal integer: no exponent, no fraction (`1.0`), no negative zero, no leading zero. JSON nesting deeper than 32 levels SHALL be refused. Any other field, type or format SHALL be refused. "Total path bytes" means the sum of the UTF-8 lengths of all paths.

#### Scenario: Entry content
- **WHEN** a decrypted manifest is inspected
- **THEN** each entry holds a plaintext sha256 and size, a blob name matching the name rule for its path, and the file identifier stored in that blob's header

#### Scenario: Frozen readings
- **WHEN** a manifest has `sequence` written as `1e2` or `1.0` or `-0` or `01`, a `device` of 0 or 65 code points, a `publishedAt` of `2026-02-30T00:00:00Z` or with 4 fractional digits, a `cid` of 129 characters, or nesting 33 levels deep
- **THEN** each is refused, and the same inputs are refused by both the production reader and the reference reader

#### Scenario: Device text
- **WHEN** a `device` contains a lone surrogate, U+0007 or U+007F
- **THEN** the manifest is refused by both the production reader and the reference reader

#### Scenario: Leap day
- **WHEN** `publishedAt` is `2028-02-29T12:00:00.123Z`
- **THEN** it is accepted, and `2027-02-29T12:00:00Z` is refused

#### Scenario: CID formats
- **WHEN** an entry `cid` is a CIDv0 string, or a CIDv1 base32 string
- **THEN** it is accepted; and when the manifest-level `rootCID` is a CIDv0 string it is refused with a typed refusal

#### Scenario: Name consistency
- **WHEN** an entry's `blob` differs from the name computed from its path
- **THEN** the manifest is rejected as inconsistent

#### Scenario: Sequence range
- **WHEN** `sequence` is 0, negative, fractional, or above 2^53 - 1
- **THEN** the manifest is rejected

### Requirement: Untrusted path rules
Every path in a manifest is untrusted input and SHALL be checked, before use, by these rules (the production code reuses the existing plaintext-era check, and this text describes it exactly). A path SHALL be refused if: it is empty; it starts with `/` or with a drive letter followed by a colon (`[A-Za-z]:`); it contains a backslash; it contains any character in U+0000 to U+001F or U+007F; splitting it on `/` yields an empty segment, a segment `.` or a segment `..`; or its first segment equals `.ipfs-sync` compared case-insensitively. Paths that are additionally refused by the pull (configuration, plugin and excluded paths) are defined by the pull specification.

#### Scenario: Refused forms
- **WHEN** the empty path, `/a`, `C:/a`, a path containing a backslash, `a/../b`, `a//b`, `./a`, a path containing U+0007, and `.IPFS-SYNC/x` are checked
- **THEN** each is refused

#### Scenario: Accepted form
- **WHEN** the path `notes/daily/2026-01-01.md` is checked
- **THEN** it is accepted

### Requirement: Serialisation, caps and writer-side checks
The plaintext manifest SHALL be serialised with `JSON.stringify` after sorting object keys by UTF-16 code-unit order, with no whitespace. Because `manifest.enc` is authenticated, a reader SHALL NOT reject a manifest merely for its whitespace or key order, and SHALL reject duplicate keys, wrong types and unknown fields. Remote `manifest.enc` files SHALL be checked with `files/stat` (or the equivalent) before reading and refused above 64 MiB; the cap SHALL also be enforced while streaming. After decryption a manifest with more than 100,000 entries, or with more than 8 MiB of total path bytes, SHALL be refused. The `files` map SHALL be built without object prototypes so a path such as `__proto__` is plain data. The publisher (the writer) SHALL serialise the plaintext manifest and check every cap on it and on the resulting `manifest.enc` before writing any blob, and SHALL refuse with a typed message naming the cap. A test SHALL show that a synthetic manifest at the entry cap with maximum-typical entries fits under the size cap.

#### Scenario: Oversize manifest
- **WHEN** the node reports a 200 MiB `manifest.enc`
- **THEN** the device refuses it without downloading it

#### Scenario: Too many entries
- **WHEN** a decrypted manifest lists 100,001 entries
- **THEN** it is refused

#### Scenario: Writer refuses first
- **WHEN** the vault would produce a manifest above any cap
- **THEN** the publisher refuses before writing any blob, so it never writes a manifest it cannot read back

#### Scenario: Cap consistency
- **WHEN** a synthetic manifest with 100,000 entries is serialised and encrypted
- **THEN** its size is below the 64 MiB cap

#### Scenario: Prototype path
- **WHEN** a manifest lists a path named `__proto__`
- **THEN** it is handled as data, subject to the path validity rules, and no prototype is altered

#### Scenario: Ordering and whitespace
- **WHEN** an authenticated manifest has the same content with different whitespace or key order
- **THEN** it is accepted

### Requirement: Encrypted at rest
The manifest SHALL be encrypted with AES-256-GCM under a key derived with HKDF-SHA256 (32 bytes of output) from the VCK with the raw 16 bytes of the `vaultId` as salt and the label `ipfs-sync/manifest/v1`, using a fresh random nonce. The file SHALL consist of a 17-byte header (the 4-byte magic `ISMF`, bytes 0x49 0x53 0x4D 0x46, the 1-byte version 2, then the 12-byte nonce) followed by the ciphertext and tag, with associated data made of the label `ipfs-sync/manifest/v1`, the raw 16 bytes of the `vaultId` and the 17-byte header. Structurally invalid input (bad magic, unsupported version, shorter than 17 + 16 bytes) SHALL raise the `malformed` or `unsupported-format` error; every other failure SHALL raise the `authentication` error. The plaintext manifest SHALL NOT be written to the node.

#### Scenario: Round trip
- **WHEN** a manifest is encrypted and decrypted with the same keys
- **THEN** the original content is returned

#### Scenario: Bit flip
- **WHEN** any single bit of `manifest.enc` is flipped
- **THEN** decryption fails with the authentication error

#### Scenario: Other vault
- **WHEN** a valid `manifest.enc` from another vault is decrypted
- **THEN** decryption fails

#### Scenario: No plaintext manifest
- **WHEN** the node's MFS root of an encrypted vault is listed
- **THEN** it contains no `manifest.json`

### Requirement: Layout of the encrypted MFS root
An encrypted vault SHALL have this layout in its MFS root: `current/` holding `<2-char prefix>/<blob name>` blobs; `manifest.enc` (the latest manifest); `manifests/<currentCID>.enc` (one immutable file per published `current/` state, never overwritten with different bytes); and `keyslots.json`. The published IPNS value SHALL remain the CID of the MFS root.

#### Scenario: Listing
- **WHEN** the MFS root is listed one level deep after a publish
- **THEN** its entries are exactly `current`, `manifests`, `manifest.enc` and `keyslots.json`

#### Scenario: History
- **WHEN** two publishes with different content succeed
- **THEN** `manifests/` holds two files and `manifest.enc` equals the newer one byte for byte

#### Scenario: Stray file
- **WHEN** a file whose name is not in the manifest is found inside a prefix directory
- **THEN** the automated verification reports it as an anomaly; the publisher leaves it alone unless its name matches the blob pattern and it is not in the manifest, in which case the drift path removes it

### Requirement: Monotonic sequence
Each published manifest SHALL carry a `sequence` one greater than the sequence of the manifest it replaces, starting at 1. A publisher SHALL take the previous sequence from its local state and SHALL confirm it against the sequence in the node's current authenticated `manifest.enc` before writing, as a best-effort check that is not atomic.

#### Scenario: Sequence advances
- **WHEN** a second publish follows a first
- **THEN** the second manifest's sequence is 2

#### Scenario: Remote is ahead
- **WHEN** the node's manifest has a higher sequence than the local state and no pending journal explains it
- **THEN** publish stops with an error that the node is ahead of this device, writes nothing, and names the explicit repair action

#### Scenario: Remote is behind or missing
- **WHEN** the node's manifest has a lower sequence than the local state, or is missing while the local state exists
- **THEN** publish stops with an error that the node's state is behind this device, writes nothing, and names the explicit repair action

#### Scenario: Fork
- **WHEN** the node's manifest has the same sequence as the local state but a different `rootCID`
- **THEN** the verdict is `fork`: publish stops, and `--repair` does not apply

#### Scenario: Node manifest missing
- **WHEN** this device published to the root before but the node has no `manifest.enc`
- **THEN** the verdict is `node-manifest-missing`: publish stops and names the explicit repair action where its conditions can be met

#### Scenario: Unauthentic remote manifest
- **WHEN** the node's `manifest.enc` exists but fails authentication
- **THEN** publish stops with an authentication error and writes nothing

### Requirement: Rollback status stated exactly
The `sequence` SHALL be usable by a pulling device to refuse a lower value than the last one it recorded. In this change nothing on the read side enforces it, because pulling an encrypted vault is refused; the publisher-side comparison is not rollback protection for readers. The specification SHALL state that even after enforcement, rollback is detected only on a device that has seen a later state, is not prevented, and does not help a device that has never pulled.

#### Scenario: Documentation
- **WHEN** the threat-model text is read
- **THEN** it states that rollback protection is not enforced by this change

### Requirement: Local state records the sequence
The local state SHALL record the `vaultId`, the SHA-256 of the key-slot copy, the published `sequence`, the plaintext manifest (including blob names and file identifiers and blob CIDs), modification times, and an `encryptedSeen` marker, in the vault's `.ipfs-sync/` folder, stored per MFS root. A local state of an earlier format SHALL be ignored, not migrated. The local state SHALL never be published.

#### Scenario: Old state
- **WHEN** the local state has the earlier plaintext format
- **THEN** it is ignored and the publish treats every file as new

#### Scenario: State reset
- **WHEN** the `.ipfs-sync/` folder is deleted
- **THEN** the local state, including the encrypted-seen record, is gone, and the documentation says so

#### Scenario: State excluded
- **WHEN** a vault is published
- **THEN** no file under `.ipfs-sync/` reaches the node
