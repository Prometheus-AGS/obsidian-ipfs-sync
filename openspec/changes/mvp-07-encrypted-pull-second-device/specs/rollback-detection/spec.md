## Purpose

Defines how a device records the manifest sequence it has seen and refuses older or forked states, and how an operator deliberately restores an older version without weakening that protection.

## ADDED Requirements

### Requirement: Record of the highest sequence
The local state SHALL record, per vault directory, the `vaultId`, the highest manifest `sequence` this device has accepted (from a pull or its own publish), and the SHA-256 of the `manifest.enc` bytes at that sequence. The first successful pull into a directory with no record SHALL record them. The record SHALL be written after the pull has processed the manifest, and SHALL NOT be lowered by any later operation.

#### Scenario: First pull records
- **WHEN** a new directory completes its first pull of a vault at sequence 5
- **THEN** the state holds the `vaultId`, sequence 5 and the manifest hash

#### Scenario: Publish advances the record
- **WHEN** the device publishes sequence 6
- **THEN** the record holds 6 and the hash of the new `manifest.enc`

### Requirement: Refuse lower sequences
A pull SHALL refuse an authenticated manifest whose sequence is lower than the recorded one, with an error that names both values and says the node may have served an older state, and SHALL write nothing.

#### Scenario: Older root served
- **WHEN** the recorded sequence is 5 and the node serves a valid manifest with sequence 4
- **THEN** the pull refuses it and the vault and state are unchanged

### Requirement: Refuse forks
A pull SHALL refuse an authenticated manifest whose sequence equals the recorded one but whose bytes hash differently, and a manifest whose `vaultId` differs from the recorded one, and SHALL write nothing. This refusal SHALL NOT be overridable by the rollback flag.

#### Scenario: Same sequence, different content
- **WHEN** the node serves sequence 5 with a different manifest hash than recorded
- **THEN** the pull refuses it as a fork, even with the rollback flag

#### Scenario: Other vault
- **WHEN** a directory already recorded for one vault pulls a root of another vault
- **THEN** the pull refuses it

### Requirement: Equal and higher sequences proceed
A manifest with the recorded sequence and the recorded hash, or a higher sequence, SHALL proceed. A higher sequence SHALL update the record.

#### Scenario: Newer state
- **WHEN** the node serves sequence 7 and the record holds 5
- **THEN** the pull proceeds and the record becomes 7

### Requirement: Deliberate restore of an older state
A pull that targets an older state (an older `manifests/<cid>.enc` or an older root) SHALL be refused by the sequence rule unless the operator passes the explicit flag `--allow-rollback` (in the plugin, confirms a dialog that states the consequence). With the flag the pull SHALL print a loud warning, SHALL apply the restore through the normal verification and conflict steps, SHALL NOT lower the recorded highest sequence, and SHALL record that a restore from a named older sequence was accepted. After a restore, the local record of file contents SHALL describe the restored manifest so that the next publish sees the difference and republishes the restored content as a new, higher sequence.

#### Scenario: Restore refused by default
- **WHEN** the operator points the pull at sequence 2 while the record is 5
- **THEN** it is refused with a message naming the flag

#### Scenario: Restore with the flag
- **WHEN** the operator repeats it with `--allow-rollback`
- **THEN** a warning is printed, the vault takes the sequence-2 content (local edits preserved as conflict copies), and the recorded highest sequence stays 5

#### Scenario: Publish after restore
- **WHEN** the device publishes after a restore
- **THEN** the new manifest has sequence 6 and the drift or diff logic republishes the restored content

### Requirement: Statement of limits
The documentation SHALL state that the sequence rule protects only a device that has a recorded state, that the first pull of a new directory has no baseline, that a node can withhold updates indefinitely, and that a genuine old object is never detected as forged, only as old.

#### Scenario: Documentation
- **WHEN** DESIGN.md section 8 and the README are read
- **THEN** each of these limits appears
