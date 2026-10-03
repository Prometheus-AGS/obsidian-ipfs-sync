## Purpose

Defines the decrypting pull used by the CLI and the plugin: how a device unlocks a vault it did not create, what it verifies before anything reaches disk, how outcomes are classified, and what locks and resource bounds apply, so tampering and substitution by the node fail closed and nothing partial is written.

## ADDED Requirements

### Requirement: Contracts inherited from the publish change
The pull SHALL apply, without restating them here, the caps and canonical-form rules for remote objects in `key-slots` and `manifest-v2`, the reader requirements and the streaming-decryption contract in `encrypted-blobs`, and the byte-for-byte key-slot comparison rules in `key-slots` and `encrypted-publish`, all as defined by the mvp-06 change.

#### Scenario: Oversize manifest
- **WHEN** the node reports a `manifest.enc` above the manifest cap
- **THEN** the pull refuses it without downloading it

### Requirement: Unlock on a device that did not create the vault
The pull SHALL resolve the pull target, read `keyslots.json` and `manifest.enc` from the resolved root through the gateway, unlock the passphrase slot, and authenticate `manifest.enc` under the key derived from the unlocked vault key before trusting anything else. When the device has a local key-slot copy for that MFS root, the pull SHALL unlock from it first (a wrong passphrase makes no request) and compare the node's file byte for byte, refusing on a difference with a message that names the accept action of the key-management change. When it has none, the pull SHALL use the node's file, subject to the parameter bounds, the work budget and the cost confirmation of `key-slots`. The pull SHALL require the manifest's `vaultId` to equal the key-slot file's `vaultId`. The device SHALL store its local key-slot copy only after the manifest has authenticated and the first-pull confirmation, if one is needed, has been given.

#### Scenario: Fresh device, right passphrase
- **WHEN** a new directory pulls a vault published by another device and the correct passphrase is entered and the first-pull confirmation is accepted
- **THEN** the vault unlocks, the manifest authenticates, the files are restored, and the key-slot copy is stored after the authentication

#### Scenario: Copy stored only after authentication
- **WHEN** the passphrase opens the slot but the manifest fails authentication
- **THEN** no local key-slot copy is stored, no floor entry is written and nothing is written to the vault

#### Scenario: Vault identifier mismatch
- **WHEN** the manifest's `vaultId` differs from the key-slot file's
- **THEN** the pull stops with a vault-mismatch error and writes nothing

#### Scenario: Differing slots on a device with a copy
- **WHEN** the node's `keyslots.json` differs from the local copy
- **THEN** the pull refuses, names the accept action, runs no derivation on the node's parameters and writes nothing

### Requirement: One outcome for a wrong passphrase
A wrong passphrase, a damaged slot and a slot that fails its commitment SHALL produce the same typed outcome with the same message, and the pull SHALL NOT reveal which. The work done before that outcome SHALL be the same full derivation in every case, and no counter, delay or lockout SHALL be added (offline guessing against the public slot is not slowed by one). The outcome SHALL leave the vault, the state, the floor and the local copies unchanged.

#### Scenario: Wrong passphrase
- **WHEN** a wrong passphrase is entered
- **THEN** the pull fails with the wrong-passphrase-or-damaged-slot error and nothing changes

#### Scenario: Damaged slot
- **WHEN** the node's slot file has one commitment byte changed
- **THEN** the same error and message result

#### Scenario: Typo is a format error, not an oracle
- **WHEN** the entered text is not a valid generated passphrase (wrong length, wrong alphabet or a failed check)
- **THEN** the pull fails with the `passphrase-format` error before any derivation or request, which reveals nothing about any stored key because the check is not secret; a failed check means a probable typo, and the check catches about 99.9% of mistyped body symbols, not all of them

#### Scenario: Missing slot file is different
- **WHEN** the node's root has no `keyslots.json`
- **THEN** the pull reports that the target is not an encrypted vault or lost its key slots, which reveals nothing about any passphrase

#### Scenario: Slots without a manifest
- **WHEN** the root holds `keyslots.json` and `manifest.enc` is absent or answers 404
- **THEN** the pull refuses, says the manifest is withheld or not yet published, treats the vault as neither empty nor creatable, and writes nothing

#### Scenario: Planted plaintext manifest
- **WHEN** a root holds `keyslots.json` and a planted `manifest.json`
- **THEN** the pull takes the encrypted path and never reads `manifest.json`

### Requirement: Authenticate before acting
No blob SHALL be requested and no vault file touched until the manifest has authenticated, passed its caps and canonical checks, passed the path policy over the whole manifest, passed the sequence verdict of `rollback-detection`, and (for a first pull) been confirmed. A failure at any of these SHALL abort the whole pull with nothing written.

#### Scenario: Forged manifest
- **WHEN** the node serves a `manifest.enc` that does not authenticate under the unlocked key
- **THEN** the pull aborts, requests no blob and writes nothing

### Requirement: Fetch and verify every file
For each file that must be fetched the pull SHALL request the blob from the tree named by the authenticated manifest's `rootCID` (never from the resolved root's `current/`), and SHALL verify every reader requirement of `encrypted-blobs`: the expected blob size for the manifest's plaintext size, the file identifier in the header equal to the manifest's, the name-bound associated data, every segment's authentication, and the decrypted size and sha256 equal to the manifest's. Plaintext SHALL be written to a temporary file under `.ipfs-sync/tmp/` and moved to its destination only after the final authenticated segment and the size and hash checks. Any failure SHALL remove the temporary file, leave the destination as it was, count that file in the class that names the cause (`integrity-failed` or `unfetched`), and let the other files continue.

#### Scenario: Tampered blob
- **WHEN** one bit of one blob differs from what the manifest's tree holds
- **THEN** that file is counted `integrity-failed`, the destination is unchanged, no temporary file remains, and the state is marked incomplete

#### Scenario: Blob from another path
- **WHEN** the tree holds the blob of path A under path B's name
- **THEN** the file fails (name, identifier and hash checks) and nothing is written for B

#### Scenario: Replayed older blob
- **WHEN** a genuine older blob is served for a path whose manifest entry lists a newer file identifier
- **THEN** the file fails the identifier check

#### Scenario: Interrupted stream
- **WHEN** the connection drops in the middle of a blob
- **THEN** no partial plaintext exists at the destination path and no temporary file remains

#### Scenario: Files streamed in the CLI
- **WHEN** the CLI pulls a 100 MB file
- **THEN** no more than one plaintext segment and one ciphertext segment of it are held in memory at a time

#### Scenario: Disk write failure
- **WHEN** writing the temporary file fails (for example a full disk)
- **THEN** the temporary file is removed, the file is counted `unfetched` with the reason "could not write", and it is not reported as tampering

### Requirement: Outcomes, the complete flag and unmaterialized paths
The pull SHALL classify every manifest path as `fetched`, `unchanged`, `locally-modified`, `conflict`, `integrity-failed`, `unfetched`, or `policy-skipped` with severity `expected` (configuration folder or exclusion-list match) or `unsafe` (see `path-hardening`), and every `unsafe` skip with a class: `shape` (a path shape an honest publisher never produces) or `platform` (a path an honest publisher on another platform can produce: Windows forms, reserved names, 8.3 shapes, collision groups). The state SHALL record `complete: false` when any path is `integrity-failed` or `unfetched` in a non-restore pull, and `complete: true` otherwise; `complete` is informational (it is displayed and sets the exit code) and SHALL NOT make publish refuse. A `policy-skipped` path SHALL NOT make a pull incomplete. The baseline in the state SHALL take the node's entry for every path that is now in sync with the node. A path that is `integrity-failed`, `unfetched` or `policy-skipped` with class `platform` SHALL also take the node's entry and SHALL be listed in the state's `unmaterialized` list. A path that is `expected` or `unsafe` with class `shape` SHALL be absent from the baseline. The CLI SHALL exit 1 when any path is `integrity-failed`, `unfetched` or `policy-skipped` with severity `unsafe`, and exit 0 when only `expected` skips occurred. The plugin notice SHALL use the same split and SHALL NOT use success wording for an incomplete pull. A restore SHALL NOT recompute `complete`: a path that fails during a restore is reported and makes the command exit 1, and the state is otherwise untouched (see `rollback-detection`). On the next pull a path in `unmaterialized` SHALL be planned with no base: a missing local file is fetched, a local file equal to the node's content makes the path restored and removes it from the list, and a differing local file is kept as a dated conflict copy while the node's text takes the path.

#### Scenario: One bad blob then publish
- **WHEN** a pull leaves one file `integrity-failed` and the device then publishes
- **THEN** the publish succeeds, the node's manifest entry for that file is copied into the new manifest unchanged, and the file is not removed from the node's manifest (see `second-device-publish`)

#### Scenario: Retry completes
- **WHEN** a later pull fetches the previously failed file
- **THEN** the state is marked complete, the path leaves `unmaterialized`, and its baseline entry is the fetched content

#### Scenario: Stale local copy of an unfetched file
- **WHEN** a path is `unmaterialized`, the device holds an older local version that differs from the node's, and a later pull fetches it
- **THEN** the older local text is kept in a dated conflict copy and the node's text takes the path

#### Scenario: Restore failure does not touch the record
- **WHEN** a restore cannot decrypt one file
- **THEN** the file is reported, the command exits 1, and `complete` and `unmaterialized` in the state are as they were

#### Scenario: Expected skips only
- **WHEN** an older build's manifest lists `.obsidian/app.json` and every other file is fine
- **THEN** the path is listed as skipped, the pull is complete, and the CLI exits 0

#### Scenario: Unsafe skip is loud
- **WHEN** an authenticated manifest lists `.obsidian/plugins/x/main.js`
- **THEN** the path is skipped with severity `unsafe` (class `shape`), nothing is written for it, it is not in the baseline, and the CLI exits 1

#### Scenario: Platform skip is kept in the baseline
- **WHEN** an authenticated manifest lists `CON.md` (written by a Linux device); the Windows-forms rule applies on every host, including Linux
- **THEN** the path is skipped with severity `unsafe` (class `platform`), nothing is written for it, the CLI exits 1, and the node's entry for `CON.md` is in the baseline and in `unmaterialized`

### Requirement: Delta and conflict behaviour
The pull SHALL compare local files with the manifest by plaintext sha256, fetch only missing or changed files, apply the three-way decision against the baseline in the state, preserve a local edit that differs from both the baseline and the remote as an extension-keeping dated conflict copy (`<stem> (ipfs conflict YYYY-MM-DD).<ext>`) made before the destination is replaced (when the conflict copy cannot be written, for example because the name is too long, the replace of that file SHALL be aborted, the local file left as it was, and the file counted `unfetched` with that reason), never delete local files, and report remote deletions without applying them. When the manifest's `excludesHash` differs from this device's, the pull SHALL warn once and verify every local file by content instead of trusting size and mtime.

#### Scenario: Conflict
- **WHEN** a file was edited on both devices
- **THEN** the remote text replaces it and the local text survives in the dated conflict copy

#### Scenario: Only changes transfer
- **WHEN** one file changed remotely
- **THEN** one blob is fetched and every other file is neither fetched nor rewritten

#### Scenario: Exclusion lists differ
- **WHEN** the manifest was published by a build with a different default exclusion list
- **THEN** one warning is printed, every local file is verified by content, and nothing is deleted

#### Scenario: Conflict copy cannot be written
- **WHEN** a file was edited on both devices and the dated conflict copy name exceeds what the host accepts
- **THEN** the local file is left untouched, the remote text is not written over it, the file is counted `unfetched` with the reason, and the pull continues with other files

### Requirement: Explicit targets
The pull SHALL accept, besides the IPNS name, an explicit immutable root (`--root-cid <cid>` in the CLI and `/ipfs/<cid>` as the plugin's pull name) and `--manifest <cid>` to read the history entry for that tree CID under the resolved root (either history naming form). `--manifest` SHALL require the inner `rootCID` to equal the named CID. All targets SHALL pass the same unlock, authentication, verdict and verification steps. Choosing an explicit target SHALL NOT bypass the sequence rule. The documentation and the first-pull display SHALL state that an explicit root CID is not verified against the returned bytes by the client: it names what the gateway serves, and authenticity rests on the vault key.

#### Scenario: Explicit root
- **WHEN** `--root-cid` names a root whose manifest has the recorded sequence or higher
- **THEN** the pull proceeds normally

#### Scenario: History file mismatch
- **WHEN** the history entry named by `--manifest <x>` holds a manifest whose inner `rootCID` is not `<x>`
- **THEN** the pull refuses it

### Requirement: Locks and read-only behaviour
The pull SHALL take the same file lock as publish (`publish.lock`, in the CLI through the Node lock file and in the plugin through the adapter lock file) in addition to the plugin's in-process lock, and SHALL refuse with the same message as publish when it is held. The pull SHALL perform no node mutation: only name resolution, key listing, `files/stat`, `files/ls` and gateway reads.

#### Scenario: Publish in progress
- **WHEN** a publish holds `publish.lock` and a pull starts on the same vault
- **THEN** the pull refuses, names the lock and writes nothing

#### Scenario: Request audit
- **WHEN** a pull runs against a recording node
- **THEN** every recorded request is a read

### Requirement: A pull settles a pending publish journal
A pull that reaches the state write with a publish journal for the same MFS root present SHALL, when the journal's sequence is not above the pulled manifest's sequence, move the journal to `.ipfs-sync/journal-set-aside.<sequence>.json` and report it (a pending publish that lost to the pulled manifest cannot resume, and without this the publish refusal for an overlapping publish would have no exit). A journal whose sequence is above the pulled manifest's SHALL be left for publish to resume. A pull SHALL write the state fields `rootCid` (the immutable root CID the target resolved to), `key` (the configured publication key name), `mfsRoot` (the configured MFS root) and `previousIdentity` (`null`) in addition to the fields of `rollback-detection`, except that a restore leaves the state as that spec says.

#### Scenario: Lost publish is set aside
- **WHEN** device A crashed after writing a pending manifest for sequence 7, device B published sequence 7, and A pulls
- **THEN** A's journal is moved aside with a notice, the pulled manifest becomes the baseline, and A's next publish produces sequence 8

#### Scenario: Newer journal is left
- **WHEN** the journal's sequence is above the pulled manifest's
- **THEN** the journal stays in place and publish resumes it

### Requirement: Resource bounds
The CLI SHALL stream blobs. The plugin SHALL fetch blobs as segment-aligned ranges (header first, then each segment at its computed offset), SHALL require 206 answers whose `Content-Range` start, end and total equal the request and the expected blob size, and SHALL treat a mismatch as `unfetched`. The plugin's transport (`requestUrl`) buffers a whole response before the plugin sees it; the plugin therefore SHALL NOT claim that any body is unbuffered, and a refused response is described as discarded and not decrypted. The plugin SHALL request the header range of the smallest blob to fetch first and alone; when that answer has status 200 or holds more than 22 bytes plus a margin of 64 bytes, the pull SHALL mark the gateway as ignoring Range, and every later file whose expected blob size exceeds the whole-body limit SHALL be counted `unfetched` without a request. When a gateway answers 200 to a range request the plugin SHALL accept the whole body only if the expected blob size is at most the whole-body limit (32 MiB) and otherwise count the file `unfetched` with a named reason. A blob whose header exponent is below 20 SHALL be counted `unfetched` in the plugin (too many requests per GiB), and one above 24 is an integrity failure. In-flight plaintext plus ciphertext segment memory SHALL NOT exceed a budget of 128 MiB (concurrency reduced accordingly). Before the first byte is requested the pull SHALL compute the total bytes to fetch and, above 512 MiB (configurable), SHALL ask for confirmation (plugin dialog; CLI prompt, or refusal unless `--accept-large`); declined means nothing is fetched and the state is incomplete. Free space SHALL be checked only through an optional `freeBytes` port that the CLI provides (Node `statfs`); the plugin provides none and performs no free-space check.

#### Scenario: Range honoured
- **WHEN** the gateway answers each range request with 206 and matching `Content-Range`
- **THEN** a 40 MiB blob is fetched and decrypted with no more than the budgeted segments in memory

#### Scenario: Gateway ignores Range, large file
- **WHEN** the gateway answers 200 to a range request for a 100 MiB blob in the plugin
- **THEN** the response is discarded and not decrypted, the file is counted `unfetched` with the reason, and the pull continues with other files

#### Scenario: Probe on the smallest blob
- **WHEN** the gateway ignores Range and the pull must fetch one 2 MiB file and one 100 MiB file
- **THEN** the 2 MiB file's header request is sent first and alone, the answer marks the gateway as ignoring Range, the 100 MiB file is counted `unfetched` with no request sent for it, and the 2 MiB file is fetched whole

#### Scenario: Small segment size in the plugin
- **WHEN** a blob header carries exponent 16 and the pull runs in the plugin
- **THEN** the file is counted `unfetched` with the reason and no segment request is sent

#### Scenario: Wrong Content-Range
- **WHEN** a 206 answer names a different range or total than requested
- **THEN** the file is counted `unfetched` and nothing is decrypted from that answer

#### Scenario: Large pull needs a yes
- **WHEN** the files to fetch total more than the ceiling
- **THEN** the pull asks before requesting any blob and fetches nothing if declined

### Requirement: Events and output
The pull SHALL emit `pull.complete` (with the manifest sequence, `complete`, and the counts `integrityFailed`, `unfetched` and `policySkipped` added additively) and `conflict` events. Neither the events, the status text, the logs nor the error messages SHALL contain the passphrase, key material or file contents. Terminal and notice output MAY name vault paths; C0 and C1 control characters and bidirectional overrides in any shown path or node-supplied text SHALL be escaped. Notices that echo text supplied by the node SHALL use fixed strings.

#### Scenario: Payload inspection
- **WHEN** events and output of an encrypted pull are captured
- **THEN** none contains a passphrase, a key or file bytes

#### Scenario: Hostile path text
- **WHEN** an authenticated manifest names a path containing U+009B or a bidi override
- **THEN** the terminal output shows the escaped form

### Requirement: Encrypted roots only on the new path
The pull SHALL treat a root with `keyslots.json` as an encrypted vault and use the path above. The plaintext reader of the earlier change stays in this version only behind `--allow-plaintext-v1` for roots without key slots and is removed by the next change; it SHALL NOT be reachable for a root that holds key slots.

#### Scenario: Encrypted root
- **WHEN** a root holds `keyslots.json`
- **THEN** the decrypting pull runs and the v1 reader is not consulted
