## Purpose

Defines how a vault is published encrypted from the CLI and the plugin, what is refused, how an interrupted publish resumes or is repaired, and what the node sees, so that nothing readable leaves the device, the publisher never locks itself out, and the existing delta behaviour survives.

## ADDED Requirements

### Requirement: Passphrase required, always
Publishing SHALL require an unlocked vault key. Without a passphrase (or an already unlocked session in the plugin), publish SHALL refuse with a "passphrase required" error before any request is sent, for every vault. Plaintext manifest v1 publishing SHALL be removed from the CLI and the plugin.

#### Scenario: No passphrase, fixture vault
- **WHEN** publish runs on a fixture vault and no passphrase is available
- **THEN** it fails with the passphrase-required error and sends no request

#### Scenario: No v1 output
- **WHEN** any publish completes
- **THEN** the node holds no `manifest.json` and no plaintext file name from that publish

### Requirement: Fixture marker required until independent review (both hosts)
Until the encrypted pull change removes it as an explicit task after the security-reviewer's sign-off, the in-Obsidian run and a phone timing of the key derivation (or an explicit, informed operator acceptance), this tool SHALL refuse to publish a vault whose root does not carry an accepted marker, in both the CLI and the plugin, before any request is sent and even when a valid passphrase is supplied. The marker check SHALL be evaluated before the passphrase check. The message SHALL state that encryption is implemented but not yet independently reviewed or verified in Obsidian, and that real vaults are allowed after that. Encryption is mandatory for every publish, marker or not. The marker is an accident guard and not a control: anyone who can create the marker file can override the refusal.

#### Scenario: Real vault with a passphrase
- **WHEN** publish runs on a vault without the marker and a valid passphrase is supplied
- **THEN** it fails with the review-pending message and sends no request

#### Scenario: Real vault without a passphrase
- **WHEN** publish runs on a vault without the marker and no passphrase is available
- **THEN** it fails with the review-pending message (the marker check comes first) and sends no request

#### Scenario: Fixture vault with a passphrase
- **WHEN** publish runs on a vault with an accepted marker and a valid passphrase
- **THEN** publishing proceeds encrypted

#### Scenario: Plugin
- **WHEN** the plugin's Publish command or its timer runs in a vault without the marker
- **THEN** a notice shows the review-pending message (at most once per session for the timer) and no request is sent

#### Scenario: Guard removal is explicit
- **WHEN** the guard is removed by the later change
- **THEN** the removal is a named task that requires the reviewer's sign-off, the in-app run recorded as evidence, and the phone timing or operator acceptance

### Requirement: Two marker values
The marker file SHALL hold one of two values. A marker created by the user or by the fixture generator SHALL contain the text `fixture`; a marker created by pull when it populated an empty destination SHALL contain the text `pulled-fixture`. Publish SHALL accept only the value `fixture` (a trailing newline is allowed); an empty marker, `pulled-fixture` and any other content SHALL be refused. Pull SHALL accept either value in its destination guard. The fixture generator SHALL write `fixture`.

#### Scenario: Pulled copy cannot publish
- **WHEN** a directory populated by pull is later published
- **THEN** publish refuses it as having an insufficient marker, with a message that explains how to mark a fixture vault deliberately

#### Scenario: Generator marker
- **WHEN** the fixture generator creates a vault
- **THEN** its marker reads `fixture` and publish accepts it

#### Scenario: Legacy pulled markers
- **WHEN** pull's destination guard finds a marker from release 0.2.0 whose content is `fixture copy created by ipfs-sync pull`, is empty, or is `marker`
- **THEN** it refuses with a specific message explaining that the marker predates this version and must be re-marked deliberately

#### Scenario: Old empty marker
- **WHEN** a marker file from an earlier release is empty
- **THEN** publish refuses it

### Requirement: Existing content is never overwritten by a different vault
Publish SHALL read the state of the MFS root before writing (read-only requests). It SHALL refuse, with a typed error and no write, when: the root holds a plaintext publication (a `manifest.json` or plaintext entries under `current/` not matching the blob layout); key slots exist and cannot be unlocked with the supplied passphrase; the node's key slots differ from the local copy; or the sequence rules fail (subject to the repair action). The error for a plaintext publication SHALL name the problem and suggest a new MFS root.

#### Scenario: Old plaintext root
- **WHEN** the configured MFS root holds a `manifest.json` from an earlier release
- **THEN** publish refuses, nothing is written, and the message suggests a new MFS root

#### Scenario: Different passphrase
- **WHEN** key slots exist and the supplied passphrase does not open them
- **THEN** publish stops with the wrong-passphrase error and nothing is written

### Requirement: Bounded responses and writer-side caps
The device SHALL cap the responses it accepts from `files/ls` and `files/stat` at 1 MiB and, for listings, at 2,000 entries. Before writing any blob, the publisher SHALL serialise the plaintext manifest it will write and check every cap of the manifest specification (entry count, path bytes, `manifest.enc` size) and SHALL refuse with a typed message naming the cap if any is exceeded, so it never writes a manifest it cannot read back.

#### Scenario: Oversize listing
- **WHEN** the node answers a listing with 5,000 entries
- **THEN** the response is refused

#### Scenario: Vault over the caps
- **WHEN** the vault would produce a manifest above the entry cap
- **THEN** publish refuses before any blob is written

### Requirement: Per-root state
The local state and the journal SHALL be stored per MFS root (file names that include a digest of the MFS root), so publishing the same directory to two roots keeps them separate. The state and journal SHALL record the `vaultId` and the SHA-256 of the key-slot copy, and a mismatch with the node SHALL refuse before any key derivation. The documentation SHALL state that deleting the `.ipfs-sync/` folder resets the local state, including the record that a root held encrypted content, and that the folder must be excluded from third-party sync and backups because state and journal are plaintext.

#### Scenario: Two roots
- **WHEN** one directory publishes to two MFS roots
- **THEN** each root has its own state, journal and slot copy

#### Scenario: Mismatch before derivation
- **WHEN** the node's key-slot file hash differs from the recorded one
- **THEN** publish refuses before deriving anything

### Requirement: Publish never creates a vault
A vault SHALL be created only by `ipfs-sync init` (CLI) or the plugin's setup dialog, both of which generate the passphrase, write `keyslots.json` and the local copy, and record the vault identifier. `publish` SHALL refuse to create a vault: when the MFS root holds no key slots and the device has no local copy of key slots for that root, it SHALL refuse with a message pointing to `ipfs-sync init` and send no write. If a first publish fails after the key slots were written, a rerun SHALL find the slots, and where `manifest.enc` is absent and the local copy has the same `vaultId`, SHALL unlock and continue with the same VCK.

#### Scenario: No implicit creation
- **WHEN** publish runs against an empty root
- **THEN** it refuses, states that `ipfs-sync init` creates a vault, and sends no write

#### Scenario: Init then publish
- **WHEN** `init` has created the vault and `publish` runs with the passphrase from the file
- **THEN** publish unlocks from the local copy and completes the first publish

#### Scenario: Interrupted first publish
- **WHEN** a first publish fails after the key slots were written and is rerun with the same passphrase
- **THEN** the rerun reuses the same VCK and `vaultId` and completes

### Requirement: New devices are refused before any key derivation
A device with no local state, no local copy of key slots for the MFS root, and a `manifest.enc` present on the node SHALL be refused, before any key derivation, with a message that it is not the publisher of this vault and that pulling encrypted vaults arrives in the next change. The refusal SHALL NOT tell the user to delete local state. The case of key slots present without a manifest is governed by the key-slots specification.

#### Scenario: New device
- **WHEN** a device without local state publishes to a root that already holds an encrypted vault
- **THEN** publish stops before any derivation or write

### Requirement: Interrupted publishes resume
Before the manifest is written, the publisher SHALL write the journal recording the pending sequence, the hash of the `manifest.enc` it is about to write, the plaintext manifest and modification times of the pending state, the `vaultId`, the key-slot hash, and the target root and key. The write order SHALL be `manifest.enc` first and the history file second. On start, if a journal exists, the publisher SHALL read the node's `manifest.enc` and authenticate it. If its hash equals the journal's, the publisher SHALL decrypt it and require its `vaultId`, sequence, `rootCID` and file map to equal the journal's pending manifest; it SHALL then write the history file from the node's `manifest.enc` bytes if that file is absent, and, if that file exists with different bytes, apply the history replacement rule; a history conflict that the rule refuses during resume SHALL adopt the journal's pending state and run the drift path at the next sequence instead of refusing. It SHALL then run the read-back verification and complete the remaining steps. If the CID of `current` differs from the manifest's `rootCID`, or any read-back check fails, the publisher SHALL adopt the journal's pending state as its local state at the journal's sequence, delete the journal, and run the normal drift path at the next sequence. If the node's sequence is the journal's minus one, the manifest was never written and the journal SHALL be discarded. A torn or damaged journal (one that cannot be parsed or fails its own checks) SHALL be discarded, because the manifest was not written by the run that left it; if the node is ahead anyway, the sequence rules refuse and name `--repair`. A journal SHALL NOT be left in place in a way that blocks the drift path. Anything else SHALL be refused with a message that names the repair action.

#### Scenario: Kill after the manifest write
- **WHEN** a publish is killed after `manifest.enc` was written and before the state was updated, and is rerun
- **THEN** the rerun completes without an "another device has published" refusal, the sequence advanced by exactly one, and the journal is gone

#### Scenario: Kill between manifest and history
- **WHEN** a publish is killed after `manifest.enc` and before its history file, and is rerun
- **THEN** the history file is written from the node's `manifest.enc` bytes and the publish completes

#### Scenario: Object planted while the publisher was down
- **WHEN** an extra object is added under `current/` between the kill and the rerun
- **THEN** the read-back fails, the journal is adopted and deleted, and the drift path runs at the next sequence instead of locking the publisher out

#### Scenario: Different history bytes
- **WHEN** the history file exists with bytes different from the node's `manifest.enc`
- **THEN** the publish refuses

#### Scenario: History conflict during resume
- **WHEN** a history file was planted while the publisher was down
- **THEN** the resume adopts the pending state and runs the drift path at the next sequence and does not refuse

#### Scenario: Repair reaches resume
- **WHEN** a journal exists that resume refuses and `--repair` is passed
- **THEN** the repair path is taken, and each of the five refusal codes has an end-to-end test that ends in a completed publish or a specific refusal

#### Scenario: Absent node manifest after a torn write
- **WHEN** the node has no authenticating `manifest.enc`, its slot file equals the local copy, and a state or journal exists, and `--repair` is confirmed
- **THEN** the publisher writes the manifest and continues

#### Scenario: Torn journal
- **WHEN** the journal file is truncated or unparsable
- **THEN** it is discarded and the normal sequence rules apply, naming `--repair` if the node is ahead

#### Scenario: Kill after each step
- **WHEN** a publish is killed after each step of the write order in turn and rerun
- **THEN** every rerun either completes or refuses with a specific message, none writes a second manifest for the same sequence, and none leaves a journal that blocks the drift path

### Requirement: Explicit repair
A publisher that meets a state refusal (the node behind the device, or the node ahead of it) SHALL offer the explicit action `--repair`. The action SHALL be allowed only when the node's manifest authenticates, has the same `vaultId`, and the node's `keyslots.json` equals the local copy byte for byte, and either the node's sequence is below the local sequence (behind), or the local state is missing or older than the node (ahead, for example a restored backup). It SHALL run the drift path and publish at the greater of the local and node sequences plus one. For the ahead case it SHALL warn that changes made by any other publisher will be discarded, and SHALL require confirmation. The repair action SHALL also be allowed to overwrite an absent or non-authenticating `manifest.enc` (which a torn write can cause without an attacker) when the node's `keyslots.json` equals the local copy byte for byte and a local state or journal exists, with interactive confirmation. On resume, when the node's `manifest.enc` fails to authenticate, the publisher SHALL re-encrypt the journal's pending manifest. `--repair` SHALL be threaded into the resume path, so a journal that resume would refuse can be repaired. An unreadable or invalid local state file SHALL be treated as missing when `--repair` is passed, and the refusal that occurs without it SHALL name `--repair`. Without those conditions, recovery SHALL be the abandon action and a new MFS root.

#### Scenario: Older manifest replayed
- **WHEN** the node serves an older genuine `manifest.enc` and the publisher passes `--repair`
- **THEN** the drift path runs and the next publish has the sequence one above the local one

#### Scenario: Restored backup
- **WHEN** the local state is older than the node and the user confirms `--repair`
- **THEN** the publish adopts the node's authenticated sequence and publishes at the next value

#### Scenario: Damaged local state
- **WHEN** the local state file cannot be parsed and `--repair` is passed
- **THEN** it is treated as missing and the repair proceeds under its conditions; without the flag the refusal names `--repair`

#### Scenario: Conditions not met
- **WHEN** the node's slot file differs from the local copy and `--repair` is passed
- **THEN** the repair is refused

### Requirement: Baseline check diagnoses before it rewrites
At the start of a publish that has local state, the publisher SHALL compare the CID of `<mfsRoot>/current` with the local manifest's `rootCID` and the CID of `<mfsRoot>` with the local state's root. A difference in `current` SHALL be diagnosed first: one `files/ls -l` of `current/` and of its prefix folders SHALL be compared with the CIDs recorded in the local manifest. Only blobs that are missing or whose CID differs SHALL be rewritten. Entries whose names match the blob pattern and are not in the new manifest SHALL be removed; any other entry SHALL be reported as an anomaly and left alone. Removal SHALL never touch `manifests/`, `keyslots.json` or `manifest.enc`. A full re-encryption SHALL happen only when the diagnosis cannot establish the state; a non-interactive full re-upload above 256 MiB SHALL require an explicit flag, and an interactive one SHALL require confirmation. A difference in `keyslots.json` or `manifest.enc` SHALL be a refusal.

#### Scenario: One blob replaced on the node
- **WHEN** a single blob under `current/` was replaced
- **THEN** only that blob is rewritten and nothing else is uploaded

#### Scenario: Interrupted write left extra blobs
- **WHEN** an earlier run wrote blobs and died before the manifest, and the publish is rerun
- **THEN** blobs matching the pattern that are not in the new manifest are removed and everything else in the tree is left

#### Scenario: Unknown entry
- **WHEN** an entry that does not match the blob pattern is found in a prefix folder
- **THEN** it is reported as an anomaly and left in place

#### Scenario: Large full re-upload
- **WHEN** diagnosis cannot establish the state and the full re-upload would exceed 256 MiB in a non-interactive run
- **THEN** the publish refuses unless the explicit flag is given

#### Scenario: Slots changed on the node
- **WHEN** the node's `keyslots.json` differs from the local copy
- **THEN** publish refuses

### Requirement: History growth is bounded
Because the read-back lists `manifests/` under the 2,000-entry listing cap and each publish adds one history file, the publisher SHALL warn (a non-fatal notice) when the history holds 1,500 entries or more, saying that the history has N entries and should be pruned soon, and SHALL refuse cleanly before writing anything when it holds 1,999 or more, with a message naming `ipfs-sync prune-history`. This check SHALL run as a pre-flight listing of `manifests/` before any write, not only in the read-back after the writes. Names in `manifests/` that are not of the form `<cid>.enc` (junk) SHALL be refused; the tool MAY remove them only through `--repair` with interactive confirmation, one path segment under `<mfsRoot>/manifests/` at a time, non-recursively, through the mutation-path guard, and never silently. The pruning command is delivered by the encrypted pull change.

#### Scenario: Warning
- **WHEN** the history holds 1,500 entries
- **THEN** the publish proceeds and shows a notice with the count

#### Scenario: Clean refusal
- **WHEN** the history holds 1,999 entries
- **THEN** the publish refuses before any write and names `ipfs-sync prune-history`

#### Scenario: Boundaries
- **WHEN** the history holds 1,499, 1,500, 1,999 and 2,000 entries, and separately a junk name, and separately a planted 2,001st entry in one prefix folder
- **THEN** the results are: no notice; warning; refusal; refusal; refusal naming the junk; a typed read-back cap error and not a raw failure

#### Scenario: Junk removal
- **WHEN** `--repair` is given with interactive confirmation and a junk name exists directly under `manifests/`
- **THEN** exactly that entry is removed, non-recursively, and nothing else

### Requirement: Read-back before pinning and publishing
After the final snapshot of the MFS root and before the pin and the name publication, the publisher SHALL read the snapshot through its immutable path and SHALL verify: the root lists exactly `current`, `manifests`, `manifest.enc` and `keyslots.json`; every name in `manifests/` is `<cid>.enc`; `manifest.enc` authenticates with the expected sequence; `keyslots.json` equals the local copy byte for byte; the CID of `current` equals the manifest's `rootCID`; the history file for that `rootCID` has bytes identical to the manifest just written; and the prefix folders touched in this run, listed with `files/ls -l`, show for each blob written in this run the CID recorded when it was written. The pin and the name publication SHALL use exactly the verified root CID string and never the MFS path. Blobs that were not touched in this run are not re-verified per publish, and the documentation SHALL say so. Any failure SHALL stop the publish before the pin and the IPNS publication.

#### Scenario: Snapshot changed under us
- **WHEN** the snapshot's `current` CID differs from the manifest's `rootCID`
- **THEN** publish stops before pinning and publishing

#### Scenario: Planted history file
- **WHEN** `manifests/<currentCID>.enc` already exists with different bytes that do not satisfy the replacement rule
- **THEN** publish refuses

#### Scenario: Unexpected top-level entry
- **WHEN** the immutable root lists an extra entry
- **THEN** publish stops before the pin

#### Scenario: Written blob altered
- **WHEN** a blob written in this run has a different CID at read-back
- **THEN** publish stops before the pin

### Requirement: History file replacement rule
When the history file `manifests/<rootCID>.enc` already exists with bytes different from the manifest being written, the publisher SHALL replace it only if the existing file authenticates under the vault key, has the same `vaultId`, and has a lower sequence than the new manifest (it is this vault's own earlier manifest for the same tree, as happens when a repair or resume runs with an unchanged `current/`). It SHALL refuse in every other case: an equal or higher sequence with different bytes, another `vaultId`, or a file that does not authenticate.

#### Scenario: Own earlier manifest for the same tree
- **WHEN** a repair runs with an unchanged `current/` tree and the existing history file is the vault's own manifest at a lower sequence
- **THEN** the history file is replaced and the publish continues

#### Scenario: Equal sequence, different bytes
- **WHEN** the existing history file has the same sequence but different bytes
- **THEN** publish refuses

#### Scenario: Foreign or unauthenticated file
- **WHEN** the existing history file has another `vaultId` or fails authentication
- **THEN** publish refuses

### Requirement: Cross-process lock
A publish SHALL take a lock file in the vault's `.ipfs-sync/` folder, created exclusively, holding a random token, the process identifier, the host and the time. The holder SHALL refresh a heartbeat every 60 seconds. A lock SHALL be considered stale if (it was taken on the same host and the recorded process is dead) or (it has had no heartbeat for 15 minutes, on any host). A killed publish on the same host therefore does not block reruns; process-identifier reuse can only make a stale lock look live, never the reverse; locks taken on other hosts (a synchronised `.ipfs-sync/` folder) rely on the heartbeat lapse. A takeover of a stale lock SHALL be done by renaming the stale lock file aside and creating a new one exclusively, and SHALL verify by reading back that the token is this run's. The holder SHALL check, before every write to local state and before each network mutation, that it still holds the lock and that its last heartbeat is not older than twice the heartbeat interval. A lock file on a filesystem without hard links SHALL produce a typed message and not a raw error. Host-name collisions between installations matter only if `.ipfs-sync/` is synchronised by a third-party tool, which the documentation forbids; this change adds no per-installation identifier to the lock. A documented `--break-lock` action SHALL remove a lock after confirmation. The documentation SHALL state that the lock is a best-effort guard and not an atomic lock across machines. The plugin's in-process lock remains.

#### Scenario: Two publishes
- **WHEN** the CLI starts a publish while a live holder has a fresh heartbeat
- **THEN** the CLI refuses with a message naming the lock

#### Scenario: Stale lock
- **WHEN** the lock has had no heartbeat for 15 minutes
- **THEN** it is replaced, on any host

#### Scenario: Killed publish on this host
- **WHEN** the recorded process is dead and the lock was taken on this host
- **THEN** the lock is replaced at once, without waiting for the heartbeat to lapse

#### Scenario: Live process
- **WHEN** the recorded process is alive on this host and the heartbeat is fresh
- **THEN** the lock is honoured

#### Scenario: Lapsed holder
- **WHEN** a holder's last heartbeat is older than twice the interval
- **THEN** it stops before its next write

#### Scenario: No hard links
- **WHEN** the filesystem does not support hard links
- **THEN** a typed message explains it

#### Scenario: Break lock
- **WHEN** the user passes `--break-lock` and confirms
- **THEN** the lock is removed and the publish continues

### Requirement: Unlocked keys avoid repeated derivation
The publish engine SHALL accept an already unlocked key provider, and SHALL use the passphrase path only when no session exists, so an automatic publish (the plugin timer) never re-runs the key derivation on each tick.

#### Scenario: Timer tick with a session
- **WHEN** the vault is unlocked in the plugin and the timer fires
- **THEN** the publish uses the session's keys and runs no Argon2id derivation

#### Scenario: No session
- **WHEN** the vault is locked
- **THEN** the timer publish is skipped as before and no derivation runs

### Requirement: Keyless idle fast path
When there is no journal, `--repair` is not passed, the publication key exists, and the root CID equals the local state's `rootCid`, and there are no local changes, the publish SHALL return unchanged without unlocking the vault or deriving a key, so idle timer ticks cost nothing.

#### Scenario: Idle tick
- **WHEN** nothing changed and the root CID equals the recorded one
- **THEN** the publish returns "unchanged" without a key derivation

#### Scenario: Journal present
- **WHEN** a journal exists
- **THEN** the fast path is not taken

### Requirement: Delta behaviour is preserved
Change detection SHALL continue to use the plaintext sha256 and size held in the local state, so unchanged files are neither read for encryption nor rewritten. A changed file SHALL be re-encrypted with a new file identifier and written to its own blob name. A removed file SHALL have its blob removed. A renamed file SHALL be treated as a removal and a new file, so it is re-encrypted and re-uploaded whole, because the node name is bound into the encryption. A publish with no changes SHALL send no write and SHALL NOT change the IPNS record or the sequence.

#### Scenario: One edited note
- **WHEN** one note is edited after a publish and publish runs again
- **THEN** exactly one blob is rewritten, the summary reads `1 written, 0 removed`, and the sequence increases by one

#### Scenario: Nothing changed
- **WHEN** publish runs with no changes
- **THEN** it reports `0 written, 0 removed`, writes nothing and publishes no new IPNS record

#### Scenario: Deleted note
- **WHEN** a published note is deleted locally
- **THEN** its blob is removed from `current/` and the summary counts it under removed

#### Scenario: Renamed note
- **WHEN** a note is renamed
- **THEN** the old blob is removed and a new blob is uploaded for the new name

### Requirement: Verified writes and safe order
Each blob write SHALL be verified by comparing the node's reported size with the expected blob size and by recording the blob's CID. The order SHALL be: guard and unlock, read-only inspection, baseline check and diagnosis, cap checks, key slots (first publish only), blob writes and verification, blob removals, snapshot CID of `current/`, journal, `manifest.enc` then its history file, CID of the MFS root, read-back verification, pin, IPNS publication, local state, journal removal. Any failure before the IPNS publication SHALL leave the IPNS record unchanged.

#### Scenario: Short write
- **WHEN** the node reports a different size for a blob
- **THEN** publish fails, names the failure without any plaintext path, and does not publish the IPNS record

### Requirement: Bounded memory
Encryption SHALL process a file one segment at a time. No more than one plaintext segment and one ciphertext segment per file being processed SHALL be held in memory, and files above the host's read limit SHALL be skipped and counted as before.

#### Scenario: Large file
- **WHEN** a 100 MB file is published on a host that can read ranges
- **THEN** memory held for that file never exceeds two segments plus the header

### Requirement: No plaintext on the wire or in output that reaches the node
No request URL, request body or stored object sent to the node SHALL contain a plaintext vault path, file name, file content or manifest field other than through encrypted blobs and `manifest.enc`. The recorded request trace of a publish SHALL be free of plaintext names. Local terminal output MAY show vault paths to the user, and MUST NOT show the passphrase or any key.

#### Scenario: Recording node
- **WHEN** a publish of a fixture vault runs against a recording node
- **THEN** none of the fixture's note titles, folder names or body words occurs in any recorded URL or body

### Requirement: Node safety unchanged
Publishing SHALL keep every node-safety rule: the MFS root confined to `/obsidian-vault-sync`, project key names only, `name/publish` only for an owned key, no key removal and no unpinning. Key generation and ownership handling are unchanged.

#### Scenario: Unsafe root
- **WHEN** `--mfs-root /obsidian-vault-staging` is used
- **THEN** the command fails before any request

### Requirement: Events stay content-free
`file.changed` and `publish.complete` events SHALL keep their shape. `file.changed` carries its `path` in the process only: no persistent sink (a store adapter, a log file, a notice history, telemetry) SHALL store event paths. They MAY carry vault paths within the process, and SHALL NOT carry the passphrase, keys or file contents. Consumers that persist events (the history store) SHALL NOT persist plaintext paths.

#### Scenario: Payload inspection
- **WHEN** events from an encrypted publish are captured
- **THEN** none contains a key, a passphrase or file bytes

#### Scenario: No persistent sink
- **WHEN** a persistent consumer subscribes to `file.changed`
- **THEN** it stores counts, hashes or CIDs only and no path text

### Requirement: Pull of an encrypted root
Until encrypted pull exists, the pull engine SHALL detect an encrypted root (key slots or an encrypted manifest present, or no readable `manifest.json`) and stop with a clear error that pulling encrypted vaults arrives in the next change, writing nothing. It SHALL NOT attempt to read an encrypted root as manifest v1. Once a root, key or destination has been seen to hold encrypted content, the local state and the pull record SHALL latch `encryptedSeen`, and pull SHALL refuse manifest v1 for that root, key and destination from then on. The v1 reader SHALL be usable only with the explicit flag `--allow-plaintext-v1`. Pull SHALL additionally refuse manifest paths under the configuration folder `.obsidian/` (besides the plugin folder it already refuses).

#### Scenario: Pull of an encrypted vault
- **WHEN** pull is pointed at an encrypted root
- **THEN** it stops with the "encrypted vault, not supported yet" error and the destination is unchanged

#### Scenario: Downgrade attempt
- **WHEN** a root that once served an encrypted vault later serves a plaintext `manifest.json`
- **THEN** pull refuses it because the latch is set, even with the v1 reader enabled

#### Scenario: v1 without the flag
- **WHEN** pull reads a genuine v1 root without `--allow-plaintext-v1`
- **THEN** it refuses and names the flag

#### Scenario: Configuration paths
- **WHEN** a v1 manifest lists `.obsidian/app.json`
- **THEN** pull refuses that entry and counts it as failed
