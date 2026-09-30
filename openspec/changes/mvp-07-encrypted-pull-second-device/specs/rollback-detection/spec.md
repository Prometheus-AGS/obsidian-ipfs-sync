## Purpose

Defines how a device records the manifest sequence and identity it has seen, how it refuses older, forked and foreign states, how a deliberate restore and a fork resolution work without lowering the record, and what the record does not protect against.

## ADDED Requirements

### Requirement: The record
The local state (`RootState`, format 3) SHALL hold `highestSequence` and `highestIdentity` (the highest authenticated manifest this directory accepted, by sequence, and its manifest identity), `manifestIdentity` of the node manifest the baseline came from, `previousIdentity` (the identity of the manifest this device built on when it last published, or `null`), `complete`, `unmaterialized` (the sorted paths whose baseline entry is the node's and whose content this device does not hold), `devicesSeen` (unique, in first-seen order, at most 16) and optionally `restoredFrom`. The decoder for format 3 SHALL require every one of these fields with no defaulting, `complete` SHALL be a boolean, the identities SHALL be 64 lowercase hex characters (`previousIdentity` also `null`), `highestSequence` SHALL NOT be below `sequence`, and when the two sequences are equal `highestIdentity` SHALL equal `manifestIdentity`; a file that violates any of these SHALL be refused as a damaged state. The manifest identity SHALL be the SHA-256 of the canonical plaintext manifest serialisation (`serializeManifestV2`) and SHALL NOT be a hash of `manifest.enc` bytes. A format 2 state SHALL be read and upgraded by computing the identity from its stored manifest. The record SHALL be raised after the manifest has authenticated, passed the path policy and the verdict, and (for a first pull) been confirmed, and before any file is written; it SHALL never be lowered by any operation, including a restore. Publish SHALL raise it and write the identity of the manifest it published.

#### Scenario: First pull records
- **WHEN** a new directory completes the confirmation of a first pull of a vault at sequence 5
- **THEN** the state holds the `vaultId` (in the manifest), `highestSequence` 5, the identity, and the floor holds the same

#### Scenario: Publish advances the record
- **WHEN** the device publishes sequence 6
- **THEN** `highestSequence` is 6 and `highestIdentity` is the identity of the published manifest

#### Scenario: Re-encryption is not a fork
- **WHEN** a resumed publish re-encrypts the same plaintext manifest at the same sequence so the `manifest.enc` bytes differ
- **THEN** the identity is unchanged and a later pull at that sequence proceeds

#### Scenario: Format 2 state
- **WHEN** a state of format 2 is read
- **THEN** it is accepted, the identity is computed from its manifest, `complete` is true, `unmaterialized` is empty, `previousIdentity` is `null`, and the next write produces format 3; a build that only knows format 2 refuses the format 3 file

#### Scenario: Format 3 file missing a field
- **WHEN** a format 3 state lacks `complete`, or has `complete` as the string "true", or has an identity that is not 64 hex characters
- **THEN** the decoder refuses it and does not default the field

#### Scenario: Adopted publish
- **WHEN** a resumed publish adopts a pending manifest at sequence 7
- **THEN** the state's `highestSequence` is 7 and the sequence floor is unchanged until the publish completes

### Requirement: Sequence floor outside the vault-synced folder
The device SHALL keep, in a device-local store outside the vault's `.ipfs-sync/` folder (a per-user directory for the CLI with owner and mode checks, the plugin's own data for the plugin), a floor per `vaultId` holding the highest sequence and identity it has accepted for that vault in any directory. The effective record SHALL be the higher `highestSequence` of the directory's state and the floor; at an equal sequence with different identities the verdict SHALL be `fork`. The floor SHALL be written before the state. Every floor write SHALL re-read the stored floor and keep, per `vaultId`, the higher sequence (read, merge by maximum, write); in the plugin the settings store SHALL remain the only writer of the plugin data and SHALL apply the same maximum to the floor on every save, so a settings save built from an older snapshot cannot lower it. The `abandon` action, deleting `.ipfs-sync/` and changing `mfsRoot` SHALL NOT reset it; `abandon` (CLI and plugin) SHALL print that the floor is kept and its sequence.

#### Scenario: Abandon then pull older
- **WHEN** a directory that reached sequence 5 is abandoned and the node then serves sequence 3 to a first pull in it
- **THEN** the floor makes the pull refuse the older state and name the recorded sequence

#### Scenario: Deleted state folder
- **WHEN** `.ipfs-sync/` is deleted and the vault is pulled again
- **THEN** the floor still applies

#### Scenario: Statement of limits
- **WHEN** the README and DESIGN are read
- **THEN** they say that deleting the per-user store, the plugin data, or reinstalling removes the floor

#### Scenario: Settings save cannot lower the floor
- **WHEN** a settings save is applied from a snapshot taken before the floor was raised
- **THEN** the stored floor for every vault is the higher of the two values

#### Scenario: Abandon reports the floor
- **WHEN** a directory is abandoned
- **THEN** the output states that the sequence floor for the vault is kept and gives its sequence

### Requirement: Verdicts
A pull SHALL evaluate the authenticated manifest against the effective record in this order and write nothing on a refusal: (1) a failed `--expect-vault-id` or `--expect-min-sequence` is refused and cannot be overridden; (2) no record is a first pull; (3) a different `vaultId` is refused and cannot be overridden; (4) a lower sequence is refused, with an error that names both sequences and says the node may be serving an older state or may be hostile; (5) an equal sequence with a different identity is a fork and is refused; (6) an equal sequence and identity proceeds; (7) a higher sequence proceeds and raises the record. A name-resolved lower-sequence refusal SHALL NOT mention `--allow-rollback`. The `vaultId` and the floor SHALL be checked against the key-slot file's `vaultId` before any key derivation.

#### Scenario: Older root served by name
- **WHEN** the record is 5 and the name resolves to a valid manifest with sequence 4
- **THEN** the pull refuses it without mentioning the rollback flag and the vault and state are unchanged

#### Scenario: Same sequence, different content
- **WHEN** the node serves sequence 5 with a different identity than recorded
- **THEN** the pull refuses it as a fork, even with `--allow-rollback`

#### Scenario: Other vault
- **WHEN** a directory recorded for one vault pulls a root of another vault
- **THEN** the pull refuses it before any derivation when the key-slot file's `vaultId` differs

#### Scenario: Newer state
- **WHEN** the node serves sequence 7 and the record is 5
- **THEN** the pull proceeds and the record becomes 7

#### Scenario: Expectation failed
- **WHEN** `--expect-min-sequence 9` is given and the node serves 7
- **THEN** the pull refuses and writes nothing

### Requirement: First pull is shown and confirmed
Every first pull SHALL, after the manifest authenticates and before any file or floor write, show the manifest's sequence, `publishedAt` and `device` and require a yes (CLI: interactive prompt, or `--accept-first-pull`; plugin: a dialog). A non-interactive CLI run without `--accept-first-pull` SHALL refuse. The display SHALL state that these values were chosen by whoever holds the vault key and that the first pull has no baseline. Declining SHALL write nothing.

#### Scenario: Declined
- **WHEN** the user declines the first-pull confirmation
- **THEN** no file, state, floor entry or key-slot copy is written

#### Scenario: Non-interactive
- **WHEN** a pull with no state runs without a terminal and without `--accept-first-pull`
- **THEN** it refuses before writing anything

### Requirement: Deliberate restore of an older state
A pull that targets an older state SHALL be refused by the sequence rule unless the target is explicit (`--root-cid` or `--manifest`; in the plugin only from the Restore action) and the operator passes `--allow-rollback` (plugin: confirms a dialog that states the consequences). With the flag the pull SHALL print a loud warning, SHALL apply the restore through the normal verification and conflict steps, SHALL NOT change the baseline, `sequence`, `manifestIdentity`, `highest*`, `complete`, `unmaterialized` or `rootCid` in the state, SHALL set `restoredFrom`, and SHALL drop the recorded modification times of the paths it wrote. Because the baseline still describes the node's current manifest, the local files of a restore differ from it and the next publish SHALL publish them as a new sequence one above the node's. A restore SHALL NOT delete any file; files that did not exist in the restored version remain, and the output and the dialog SHALL say so. `--allow-rollback` SHALL NOT affect forks, other vaults or failed expectations.

#### Scenario: Restore refused by default
- **WHEN** the operator points the pull at sequence 2 with `--root-cid` while the record is 5
- **THEN** it is refused with a message naming the flag

#### Scenario: Restore with the flag
- **WHEN** the operator repeats it with `--allow-rollback`
- **THEN** a warning is printed, the vault takes the sequence-2 content (local edits preserved as conflict copies), and the recorded highest sequence stays 5

#### Scenario: Publish after restore
- **WHEN** the device publishes after a restore
- **THEN** the new manifest has sequence 6 and contains the restored file contents

#### Scenario: Plain pull does not undo a restore
- **WHEN** a plain pull runs after a restore and the node is still at sequence 5
- **THEN** the restored files are reported as locally modified and are left as they are

#### Scenario: Rollback flag with a name
- **WHEN** `--allow-rollback` is passed without `--root-cid` or `--manifest`
- **THEN** the command refuses the combination before any request

#### Scenario: Restore keeps newer files
- **WHEN** a file exists locally that the restored version did not contain
- **THEN** it is kept and the output says restore never deletes

### Requirement: Fork resolution
When this device published a sequence and the node now serves the same sequence with a different identity (another device published at the same time), `pull --resolve-fork` (plugin: a confirmed action) SHALL, for a name target only, authenticate the node's manifest, require the same `vaultId`, obtain the common ancestor, plan the three-way decision with the ancestor as base (or no base when it is unavailable, in which case every file that differs from the node's becomes a conflict copy), apply it with conflict copies, set the baseline and `manifestIdentity` to the node manifest, keep `highestSequence`, take the node manifest's identity for `highestIdentity` and the floor, and set `previousIdentity` to `null`. The ancestor SHALL be used only when exactly one history entry carries the name prefix of the preceding sequence, that entry authenticates with the same `vaultId` and that sequence, and its identity equals the `previousIdentity` stored in this device's state; with two or more entries at the prefix, no entry, a different identity, or a `null` `previousIdentity`, there is no ancestor. The next publish SHALL be one sequence above. The action SHALL require confirmation and SHALL NOT be combinable with `--allow-rollback`, `--root-cid` or `--manifest`. The local baseline of the losing manifest SHALL NOT be used as the base.

#### Scenario: Both devices edited the same note
- **WHEN** device A published sequence 6 editing `a.md` and device B published sequence 6 editing `a.md` later, and A runs `pull --resolve-fork`
- **THEN** the node's text is at `a.md` and A's text is in the dated conflict copy

#### Scenario: Edited only here
- **WHEN** only A edited `b.md` and the ancestor is available
- **THEN** `b.md` stays as A's and is published in the next sequence

#### Scenario: No ancestor
- **WHEN** the history has legacy names or the ancestor was pruned
- **THEN** the pull says so, every file that differs from the node's gets a conflict copy, and no local text is lost

#### Scenario: Two genuine entries at the ancestor prefix
- **WHEN** the history holds two authenticating manifests at the preceding sequence (an earlier fork) and only one has the identity stored as `previousIdentity`
- **THEN** that one is the ancestor; if neither matches, or both match nothing, there is no ancestor and every differing file gets a conflict copy

#### Scenario: Wrong genuine base is not used
- **WHEN** a hostile node serves a genuine sequence-N manifest that is not the one this device built on, and this device's local edit equals that manifest's content
- **THEN** the manifest is not used as the base and the local text is kept as a conflict copy

#### Scenario: Not overridable elsewhere
- **WHEN** a fork is met with `--allow-rollback` or an explicit target
- **THEN** it is refused as a fork

### Requirement: Statement of limits
The documentation SHALL state: the sequence rule protects only a device that has a record; the first pull of a new directory has no baseline and trusts what the node serves, made visible by the confirmation; a node can withhold updates indefinitely; a genuine old object is never detected as forged, only as old; the gateway path does not verify returned bytes against a CID; a holder of the vault key can publish a very high sequence that every pulling device records and no command lowers; the floor is local and is lost with the per-user store, the plugin data or a reinstall; concurrent publishes are detected at a later pull, not prevented. It SHALL also name the recovery from a ratcheted sequence: delete the floor file in the per-user store (CLI `sequence-floor.json`; plugin: the `deviceStore` section of the plugin data) and the state file of each affected directory, then pull again as a first pull.

#### Scenario: Documentation
- **WHEN** DESIGN.md section 8 and the README are read
- **THEN** each of these limits appears
