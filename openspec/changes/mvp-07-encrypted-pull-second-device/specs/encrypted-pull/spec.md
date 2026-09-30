## Purpose

Defines the decrypting pull used by the CLI and the plugin: how a device unlocks a vault it did not create, what it verifies before anything reaches disk, and what it refuses, so tampering and substitution by the node fail closed and nothing partial is written.

## ADDED Requirements

### Requirement: Contracts inherited from the publish change
The pull SHALL apply, without restating them here, the caps and canonical-form rules for remote objects in `key-slots` and `manifest-v2`, the reader requirements and the streaming-decryption contract in `encrypted-blobs`, and the byte-for-byte key-slot comparison rules in `key-slots` and `encrypted-publish`, all as defined by the encrypted-publish change.

#### Scenario: Oversize manifest
- **WHEN** the node reports a `manifest.enc` above the manifest cap
- **THEN** the pull refuses it without downloading it, as the publish change specifies

### Requirement: Unlock on a device that did not create the vault
The pull SHALL resolve the pull target, read `keyslots.json` and `manifest.enc` from the resolved root through the gateway, unlock the passphrase slot, and authenticate `manifest.enc` under the key derived from the unlocked vault key before trusting anything else. When the device has a local key-slot copy for that MFS root, the pull SHALL unlock from it first and compare the node's file byte for byte; when it has none, the pull SHALL use the node's file, subject to the parameter bounds, the work budget and the cost confirmation of `key-slots`. The pull SHALL also require the manifest's `vaultId` to equal the key-slot file's `vaultId`. After the manifest authenticates, the device SHALL store its local key-slot copy for that root.

#### Scenario: Fresh device, right passphrase
- **WHEN** a new vault directory pulls a vault published by another device and the correct passphrase is entered
- **THEN** the vault unlocks, the manifest authenticates, the files are restored, and the key-slot copy is stored afterwards

#### Scenario: Copy stored only after authentication
- **WHEN** the passphrase opens the slot but the manifest fails authentication
- **THEN** no local key-slot copy is stored and nothing is written to the vault

#### Scenario: Vault identifier mismatch
- **WHEN** the manifest's `vaultId` differs from the key-slot file's
- **THEN** the pull stops with a vault-mismatch error and writes nothing

### Requirement: One outcome for a wrong passphrase
A wrong passphrase, a damaged slot and a slot that fails its commitment SHALL produce the same typed outcome with the same message, and the pull SHALL NOT reveal which. The work done before that outcome SHALL be the same full derivation in every case, and no counter, delay or lockout SHALL be added (offline guessing against the public slot is not slowed by one). The outcome SHALL leave the vault, the state and the local copies unchanged.

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

### Requirement: Authenticate before acting
No blob SHALL be requested and no vault file touched until the manifest has authenticated, passed its caps and canonical checks, passed the sequence rule of `rollback-detection`, and its paths have been checked. A failure at any of these SHALL abort the whole pull with nothing written.

#### Scenario: Forged manifest
- **WHEN** the node serves a `manifest.enc` that does not authenticate under the unlocked key
- **THEN** the pull aborts, requests no blob and writes nothing

### Requirement: Fetch and verify every file
For each file that must be fetched the pull SHALL request the blob from the tree named by the authenticated manifest's `rootCID` (never from the resolved root's `current/`), and SHALL verify every reader requirement of `encrypted-blobs`: the expected blob size for the manifest's plaintext size, the file identifier in the header equal to the manifest's, the name-bound associated data, every segment's authentication, and the decrypted size and sha256 equal to the manifest's. Plaintext SHALL be written to a temporary file under `.ipfs-sync/tmp/` and moved to its destination only after the final authenticated segment and the size and hash checks. Any failure SHALL remove the temporary file, leave the destination as it was, count that file as failed, and let the other files continue.

#### Scenario: Tampered blob
- **WHEN** one bit of one blob differs from what the manifest's tree holds
- **THEN** that file fails with an authentication error, the destination is unchanged, no temporary file remains, and the summary counts one failure

#### Scenario: Blob from another path
- **WHEN** the tree holds the blob of path A under path B's name
- **THEN** the file fails (name, identifier and hash checks) and nothing is written for B

#### Scenario: Replayed older blob
- **WHEN** a genuine older blob is served for a path whose manifest entry lists a newer file identifier
- **THEN** the file fails the identifier check

#### Scenario: Interrupted stream
- **WHEN** the connection drops in the middle of a blob
- **THEN** no partial plaintext exists at the destination path and no temporary file remains

#### Scenario: Files streamed
- **WHEN** a 100 MB file is pulled
- **THEN** no more than one plaintext segment and one ciphertext segment of it are held in memory at a time

### Requirement: Delta and conflict behaviour unchanged
The pull SHALL compare local files with the manifest by plaintext sha256, fetch only missing or changed files, apply the three-way decision against the local record, preserve a local edit that differs from both the record and the remote as an extension-keeping dated conflict copy before replacing the file, never delete local files, and report remote deletions without applying them, exactly as the earlier pull specifications define.

#### Scenario: Conflict
- **WHEN** a file was edited on both devices
- **THEN** the remote text replaces it and the local text survives in `<stem> (ipfs conflict YYYY-MM-DD).<ext>`

#### Scenario: Only changes transfer
- **WHEN** one file changed remotely
- **THEN** one blob is fetched and every other file is neither fetched nor rewritten

### Requirement: Refused paths
The pull SHALL refuse, without fetching, any manifest path that: is absolute or contains an empty, `.` or `..` segment, a backslash or a control character; lies at or under `.obsidian/` (all configuration and every plugin); lies under `.ipfs-sync/` or `.git/`; matches the effective exclusion list; or fails the path rules of `manifest-v2`. Refused paths SHALL be counted as failed and named in the output. There SHALL be no option to include `.obsidian/plugins/`. These checks SHALL be applied at the manifest layer to the authenticated manifest as well, so a manifest from a compromised device cannot name such a path, and they SHALL be case- and platform-hardened: the folder names `.ipfs-sync`, `.obsidian` and `.git` are compared after the folds that NTFS and APFS apply (including U+0131 and U+017F folding to `i` and `s`); path segments with trailing dots or spaces, NTFS alternate data stream syntax (`::$DATA` and `:name`), and 8.3 short names of those folders are refused.

#### Scenario: Plugin code
- **WHEN** an authentic manifest lists `.obsidian/plugins/x/main.js`
- **THEN** the entry is refused and counted as failed, and no file is written

#### Scenario: Configuration
- **WHEN** an authentic manifest lists `.obsidian/app.json`
- **THEN** the entry is refused

#### Scenario: Folded folder names
- **WHEN** an authentic manifest lists `.ıpfs-sync/state.json` (dotless i) or `.ipfſ-sync/x` (long s)
- **THEN** the entry is refused

#### Scenario: Windows forms
- **WHEN** an entry has a trailing dot or space in a segment, `::$DATA`, or the 8.3 name `OBSIDI~1/x`
- **THEN** the entry is refused

#### Scenario: Traversal
- **WHEN** an authentic manifest lists `../outside.md`
- **THEN** it is refused and nothing is written outside the vault

### Requirement: Explicit targets
The pull SHALL accept, besides the IPNS name, an explicit immutable root (`--root-cid <cid>` in the CLI and `/ipfs/<cid>` as the plugin's pull name) and `--manifest <currentCID>` to read `manifests/<currentCID>.enc` from the resolved root. All targets SHALL pass the same unlock, authentication, sequence and verification steps. Choosing an explicit root SHALL NOT bypass the sequence rule.

#### Scenario: Explicit root
- **WHEN** `--root-cid` names a root whose manifest has the recorded sequence or higher
- **THEN** the pull proceeds normally

#### Scenario: History file mismatch
- **WHEN** `manifests/<x>.enc` holds a manifest whose inner `rootCID` is not `<x>`
- **THEN** the pull refuses it

### Requirement: Read-only against the node
The pull SHALL perform no node mutation: only name resolution, key listing, `files/stat`, `files/ls` and gateway reads.

#### Scenario: Request audit
- **WHEN** a pull runs against a recording node
- **THEN** every recorded request is a read

### Requirement: Events and output
The pull SHALL emit `pull.complete` (with the manifest sequence added to its payload additively) and `conflict` events as before. Neither the events, the status text, the logs nor the error messages SHALL contain the passphrase, key material or file contents. Terminal and notice output MAY name vault paths.

#### Scenario: Payload inspection
- **WHEN** events and output of an encrypted pull are captured
- **THEN** none contains a passphrase, a key or file bytes

### Requirement: Encrypted-only
The pull SHALL treat a root without key slots and an encrypted manifest as not a vault it can read and SHALL refuse it with a message that plaintext publications are no longer supported by this version.

#### Scenario: Old plaintext root
- **WHEN** the target holds a plaintext `manifest.json`
- **THEN** the pull refuses it and writes nothing
