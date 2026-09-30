## Purpose

Defines when a device that pulled a vault may publish to it, so two devices can take turns without silently overwriting each other.

## ADDED Requirements

### Requirement: A device that pulled may publish
A device with a local state for the vault (created by a pull or a publish), a stored key-slot copy for the MFS root, and an unlocked key SHALL be allowed to publish to that vault. The publish SHALL follow the encrypted-publish change's flow, including the journal, drift check, read-back and lock.

#### Scenario: Pull then publish
- **WHEN** a second device pulls a vault and then edits one note and publishes
- **THEN** exactly one blob is rewritten and the sequence increases by one

#### Scenario: New device without a pull
- **WHEN** a device with no state and no slot copy publishes to an existing vault
- **THEN** it is refused as before, with a message that says to pull first

### Requirement: Up-to-date rule
A publish SHALL proceed only when the node's authenticated manifest sequence equals the device's recorded sequence. If the node is ahead, the publish SHALL stop before any write and tell the user to pull first; if the node is behind, it SHALL stop with the state-behind error of the publish change.

#### Scenario: Other device published in between
- **WHEN** device A recorded sequence 3 and device B has published sequence 4
- **THEN** A's publish stops with "pull first" and writes nothing

#### Scenario: Pull resolves it
- **WHEN** A pulls (recording 4) and publishes again
- **THEN** the publish proceeds and produces sequence 5

### Requirement: Local edits survive the turn-taking
When A pulls after both devices edited the same note, the conflict policy SHALL preserve A's local text as a conflict copy before A's next publish uploads both files.

#### Scenario: Both edited
- **WHEN** both devices edited `notes/a.md` and A pulls and then publishes
- **THEN** the node holds B's text for `notes/a.md` and A's text in the dated conflict copy

### Requirement: Multi-publisher guard
Each installation SHALL have a unique device identifier (a random suffix generated once and kept in local state or plugin data) that it writes into the manifest's `device` field. When the latest authenticated manifest was published by a different device, or the local state records that another device has published, the drift path SHALL NOT remove blobs that the new manifest does not name; it SHALL report them and leave them, so device A never deletes device B's in-flight blobs. Orphaned blobs left this way are harmless and are not referenced by any manifest.

#### Scenario: Other device's in-flight blobs
- **WHEN** device B has written new blobs but not yet its manifest, and device A runs the drift path
- **THEN** A reports the unnamed blobs and removes none of them

#### Scenario: Unique identifiers
- **WHEN** two installations publish
- **THEN** their manifests carry different `device` values

### Requirement: No merge of manifests
The publish SHALL NOT attempt to merge another device's manifest into its own; being out of date is always resolved by pulling first.

#### Scenario: Stale publish
- **WHEN** the device is behind
- **THEN** no manifest is written
