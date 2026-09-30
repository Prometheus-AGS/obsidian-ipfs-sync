## Purpose

Defines the events pull publishes on the shared event bus so other features (history, UI, agents) can react without coupling to the pull code.

## ADDED Requirements

### Requirement: pull.complete event
A pull that finishes processing (with or without failed files) SHALL emit one `pull.complete` event carrying: the resolved root CID, the manifest `rootCID`, counts of fetched, unchanged, conflicted, failed, remote-deleted and locally-modified files, whether a full re-verify was forced by an exclusion mismatch, and the duration. A pull that aborts before processing (unresolvable name, refused destination) SHALL NOT emit it.

#### Scenario: Successful pull
- **WHEN** a pull fetches 2 files
- **THEN** one `pull.complete` event is emitted with fetched equal to 2 and the resolved root CID

#### Scenario: Aborted pull
- **WHEN** the destination is refused by the plaintext guard
- **THEN** no `pull.complete` event is emitted

### Requirement: conflict event
For each conflict, pull SHALL emit one `conflict` event after the local content has been preserved, carrying the vault-relative path, the conflict copy path, the local sha256 and the remote sha256.

#### Scenario: One conflict
- **WHEN** one file conflicts
- **THEN** exactly one `conflict` event is emitted, naming both paths and both hashes

### Requirement: File change events
For each file pull writes, it SHALL emit the `file.changed` event defined by the publish feature with kind `added` or `modified`.

#### Scenario: Written files
- **WHEN** pull writes one new file and replaces one existing file
- **THEN** one `file.changed` `added` and one `file.changed` `modified` event are emitted

### Requirement: Events carry no secrets or content
Event payloads SHALL NOT contain credentials or file contents.

#### Scenario: Payload inspection
- **WHEN** events from a pull with bearer auth are captured
- **THEN** none contains the token or file bytes
