## Purpose

Defines the changes to the publisher that let a device that pulled publish to the same vault, and that make overlapping publishes detectable and recoverable. The publish flow, journal, drift check, read-back and lock are the mvp-06 ones; this spec lists only what differs. It replaces the first draft's restatement of the up-to-date rule, which `src/sync/sequence-rules.ts` already implements.

## ADDED Requirements

### Requirement: A device that pulled may publish
A device with a state for the vault (created by a pull or a publish), a stored key-slot copy for the MFS root and an unlocked key SHALL be allowed to publish when the node's authenticated manifest has the recorded sequence and identity. Publishing from a directory produced by a pull remains subject to the marker rule of the guard that is still in force in this version.

#### Scenario: Pull then publish
- **WHEN** a second device pulls a vault, its marker is set to `fixture` by hand, and it edits one note and publishes
- **THEN** exactly one blob is rewritten and the sequence increases by one

#### Scenario: Pulled marker refuses publish
- **WHEN** a directory populated by pull still carries the `pulled-fixture` marker and publish runs
- **THEN** publish refuses with the existing review-pending message and its hint, and nothing is sent

### Requirement: Ahead, fork and new-device messages
When the node is ahead of this device, the publish SHALL stop before any write and tell the user to pull first; it SHALL NOT suggest `--repair` to a device that has a usable baseline. The new-device refusal SHALL name pull instead of saying pulling arrives in a later change. The fork refusal SHALL name `pull --resolve-fork`. `--repair` SHALL refuse the ahead case, with a message that says to pull first, when a sequence floor exists for the vault's `vaultId` (read from the node's key-slot file) and when the device has a state that decodes for the same vault; it MAY offer the ahead case, behind its existing confirmation whose warning recommends pull first, only when a state file exists, does not decode, and no floor exists for the vault. Behind and rebuild repairs are unchanged, except that no publish and no repair goes out at or below the sequence floor: on every publish the device SHALL read the floor for the vault, and when an entry exists and the device's state is missing or holds a lower sequence, the first publish, a resumed creation, an in-step publish and a rebuild repair SHALL be refused before any write with a message that says to pull first (code `sequence-below-floor`), and a behind or rebuild repair SHALL publish at the greatest of the local, node, record and floor sequences plus one.

#### Scenario: Other device published in between
- **WHEN** device A recorded sequence 3 and device B has published sequence 4
- **THEN** A's publish stops with "pull first" and writes nothing, and `--repair` does not lift it

#### Scenario: Pull resolves it
- **WHEN** A pulls (recording 4) and publishes again
- **THEN** the publish proceeds and produces sequence 5

#### Scenario: New device without a pull
- **WHEN** a device with no state and no slot copy publishes to an existing vault
- **THEN** it is refused with a message that says to pull first

#### Scenario: Repair ahead after the state folder was deleted
- **WHEN** `.ipfs-sync/` was deleted on a device that had reached sequence 5, the node is at 6, and `publish --repair` runs
- **THEN** the repair refuses the ahead case because the floor for the vault exists, and says to pull first

#### Scenario: Repair ahead for a corrupt state with no floor
- **WHEN** the state file does not decode, no floor exists for the vault, and `publish --repair` runs
- **THEN** the ahead case is offered behind its confirmation, whose warning recommends pull first

#### Scenario: Restart below the floor after the state was lost
- **WHEN** a device that reached sequence 40 lost its state file but kept its key-slot copy and its sequence floor, and the node (hostile or wiped) shows no `manifest.enc` or no key slots, and the device publishes
- **THEN** the publish is refused with "pull first" before any write, and sequence 1 is not published under the owned name

#### Scenario: Rebuild or in-step publish below the floor
- **WHEN** the floor for the vault is higher than the device's state (for example a pull raised the floor and stopped before its state was written) and the device publishes, or runs `publish --repair` on a node that lost `manifest.enc`
- **THEN** the publish or the rebuild is refused with "pull first", even when the user confirms, and nothing is written

#### Scenario: Behind repair above the floor
- **WHEN** a behind repair is planned and the floor is higher than the local, node and record sequences
- **THEN** the repair publishes at the floor's sequence plus one

### Requirement: Paths this device could not restore are carried forward
A publish SHALL copy into the new manifest, unchanged, the node's entry for every path in the state's `unmaterialized` list (paths this device could not restore: `unfetched`, `integrity-failed`, and platform-unsafe names such as reserved names and case collisions). It SHALL NOT compare such a path with a local file, SHALL NOT count it as a removal, SHALL count its blob as named in the drift check, and SHALL list the carried paths (at most three and a count) as not published from this device. It SHALL drop a carried path that matches this device's exclusion list at publish time. A publish SHALL NOT refuse because the last pull was incomplete. The idle check SHALL compare only materialized entries with the scan.

#### Scenario: Linux-only name survives a Windows device
- **WHEN** a Linux device publishes `CON.md` and `note.md`, a Windows device pulls (skipping `CON.md` as a platform form), edits `note.md` and publishes
- **THEN** the new manifest still lists `CON.md` with the Linux device's entry and blob, and `CON.md`'s blob is not treated as a stray

#### Scenario: Windows-form name is not restored on Linux either
- **WHEN** a fresh Linux device pulls a manifest that lists `CON.md`
- **THEN** the path policy refuses `CON.md` on every host, so nothing is written for it, it is reported as skipped (`unsafe`, class `platform`), the CLI exits 1, and the node's entry for `CON.md` is in the baseline, in `complete`'s accounting and in `unmaterialized`

#### Scenario: Collision pair survives
- **WHEN** a manifest lists `Note.md` and `note.md`, both are skipped on a case-insensitive device, and that device publishes an unrelated edit
- **THEN** both entries stay in the manifest

#### Scenario: Failed file is not dropped
- **WHEN** the last pull left one `integrity-failed` file and the user publishes
- **THEN** the publish succeeds, the node's entry for that file is unchanged in the new manifest, and the output says one path was not published from this device

#### Scenario: Gateway that ignores Range
- **WHEN** a plugin device counts a large file `unfetched` on every pull and publishes an unrelated edit
- **THEN** the publish proceeds and the large file stays in the vault for every other device

#### Scenario: Local edit of an unrestored path
- **WHEN** the device holds an older local copy of an `unmaterialized` path and edits it, then publishes
- **THEN** the edit is not published, the carried entry is unchanged, and the next pull keeps the edit as a conflict copy

#### Scenario: Excluded entries are not carried
- **WHEN** an older build's manifest lists `.obsidian/app.json` and this device publishes
- **THEN** the entry is absent from the new manifest and the output lists it as dropped because it is excluded

### Requirement: Local edits survive the turn-taking
When a device pulls after both devices edited the same note, the conflict policy SHALL preserve the local text as a conflict copy before the next publish uploads both files.

#### Scenario: Both edited
- **WHEN** both devices edited `notes/a.md` and A pulls and then publishes
- **THEN** the node holds B's text for `notes/a.md` and A's text in the dated conflict copy

### Requirement: Overlapping publishes are detected before the name is published
When a publish has work, it SHALL resolve the owned IPNS name with `nocache` and a bounded `dht-timeout` before its first write and again immediately before `name/publish`. Each resolution SHALL be classified as a value, `not-found` or `failed` by matching the kubo error text against a table held in one file, and any text not in the table SHALL be `failed`. The publish SHALL refuse to publish when the second value differs from the first, when the name resolved at the start and no longer does, or when either resolution is `failed`. A key created by this run SHALL NOT be resolved at either point. On the first publish of a vault (no `manifest.enc` on the node and no local state) a timeout SHALL count as `not-found`. The commit client port SHALL provide `nameResolve`. The refusal SHALL say another device may have published and to pull first (or, for `failed`, that name routing could not be reached), SHALL leave the MFS tree as written, and SHALL NOT publish. The publish journal SHALL store the resolved root at the start as `startRoot` (journal format 2) when the pending manifest is built, and a resume SHALL compare the name's current value with it (with the state's `rootCid` for a format 1 journal) before it adopts the pending manifest and before `name/publish`; a difference SHALL end in the overlapping-publish refusal and never in a publication over the other device's manifest.

#### Scenario: Name moved during the publish
- **WHEN** another device publishes between this device's first write and its `name/publish`
- **THEN** this device does not publish, reports the situation, and a later pull shows the fork or the newer state

#### Scenario: Winner completes before the name start
- **WHEN** another device completes a publish after this device read `manifest.enc` for its sequence decision and before this device read the name, so the name start already shows the other device's root
- **THEN** `manifest.enc` is read again after the name start, differs from the first read, and the publish is refused as overlapping before any write to the node

#### Scenario: Winner's manifest.enc found at the commit
- **WHEN** the `manifest.enc` on the node, read just before this publish overwrites it, authenticates for this vault at this publish's sequence or a later one and is not this publish's own manifest
- **THEN** the publish is refused as overlapping without writing `manifest.enc`; the journal stays and the next pull sets it aside

#### Scenario: Withdrawal is matched to the moved name
- **WHEN** the name re-check refuses after this publish overwrote `manifest.enc`, and the file it overwrote is byte-equal to the `manifest.enc` inside the root the name now resolves to
- **THEN** that file is put back if `manifest.enc` still holds this publish's bytes; if the root holds another file, the root cannot be read, or the withdrawal fails, nothing is put back and the overlapping-publish refusal is what the caller sees

#### Scenario: Resolution fails
- **WHEN** the second `name/resolve` times out for a vault that already has a manifest on the node
- **THEN** the publish is refused, the message names name routing, and nothing is published

#### Scenario: Not found is not a failure
- **WHEN** the owned key exists, has never been published, and both resolutions report not found
- **THEN** the first publish proceeds

#### Scenario: Timeout on the first publish
- **WHEN** the vault has no manifest on the node and no local state and the resolutions time out
- **THEN** they count as not found and the first publish proceeds, and the documentation lists that two first publishes cannot be told apart

#### Scenario: New key
- **WHEN** this run creates the publication key
- **THEN** no `name/resolve` request is sent at either point

#### Scenario: Crash, foreign publish, resume
- **WHEN** device A crashes after writing its pending manifest for sequence 7, device B publishes sequence 7, and A reruns the publish
- **THEN** A does not publish and does not adopt over B's manifest, the refusal names an overlapping publish, and A's next pull sets the journal aside and continues from B's manifest

#### Scenario: Statement of limits
- **WHEN** the documentation is read
- **THEN** it says overlapping publishes are narrowed, not prevented, because no compare-and-swap exists and writes to the shared `current/` tree are not detected

### Requirement: Fork recovery is available
After an overlapping publish the losing device SHALL be able to recover with `pull --resolve-fork` without deleting `.ipfs-sync/` or abandoning the vault.

#### Scenario: Loser recovers
- **WHEN** device A and device B each published sequence 6 and A pulls
- **THEN** A is told it is a fork and how to resolve it, and after resolving, A's next publish is sequence 7

### Requirement: Unique device identity
Each installation SHALL generate a random device identifier once, keep it in the device-local store outside the vault-synced folder, and write `<label>-<12 hex characters>` into the manifest's `device` field, where the label is the sanitised `IPFS_SYNC_DEVICE` (default `cli`, `obsidian` in the plugin), cut so the field stays within 64 characters.

#### Scenario: Unique identifiers
- **WHEN** two installations publish
- **THEN** their manifests carry different `device` values

### Requirement: The drift path does not delete another device's blobs
The state SHALL record every `device` seen on an authenticated manifest (unique, in first-seen order, at most 16 kept). When the state records any device other than this installation's, or the node's latest manifest names another device, the drift path SHALL report the blob-shaped files the new manifest does not name and SHALL NOT remove them. The blobs of carried entries SHALL count as named. A device that has never seen another device's manifest MAY remove them as before; the documentation SHALL state that the guard protects a device only after it has seen another device.

#### Scenario: Other device's in-flight blobs
- **WHEN** device B has written new blobs but not yet its manifest, B's device id is in A's state, and A runs the drift path
- **THEN** A reports the unnamed blobs and removes none of them

#### Scenario: Single publisher
- **WHEN** only this installation has ever published
- **THEN** unnamed blobs are removed as in the mvp-06 flow

### Requirement: Token check before the first write
The publish engine SHALL accept an optional asynchronous hook that is awaited, as a fresh check each time, at each of the three places where a run first can change the node: before the resume of a journal, before the history-junk removal of a repair run, and before the publication key is ensured ahead of the blob transfer. The plugin SHALL pass a check that re-reads the lock file and compares its token; the CLI SHALL pass the same check over its lock file. A failed check SHALL refuse the publish with the lock-held error and no mutating request. A host that passes no hook SHALL behave as before.

#### Scenario: Lock file replaced
- **WHEN** the lock file changes hands between acquiring the lock and the first write
- **THEN** the publish refuses and no mutating request was sent

### Requirement: No merge of manifests
The publish SHALL NOT attempt to merge another device's manifest into its own; being out of date is always resolved by pulling first, and overlapping publishes by fork resolution.

#### Scenario: Stale publish
- **WHEN** the device is behind
- **THEN** no manifest is written

### Requirement: Second-device onboarding is stated
The documentation and the pull dialog SHALL state that a second installation must use the same MFS root and publication key name, adopt the owned publication key through the existing key-adoption flow before it can publish, and pull before it publishes.

#### Scenario: Dialog hint
- **WHEN** the plugin's first-pull dialog is shown
- **THEN** it names these three requirements for publishing from this device
