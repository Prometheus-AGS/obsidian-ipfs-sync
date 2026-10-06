## Purpose

Defines how the CLI turns EventBus events into persisted history: which events are recorded, what each record keeps, and the rule that recording history must never break a sync operation.

## ADDED Requirements

### Requirement: CLI records publish, pull and conflict events
The CLI's publish and pull commands SHALL attach a history recorder to their EventBus that persists one record per `publish.complete` and `pull.complete` event and one record per `conflict` event, using the mapping defined by `src/core/store/`.

#### Scenario: Publish recorded
- **WHEN** a CLI publish completes
- **THEN** the history store holds a publish record with the root CID, the written/removed counts and the duration

#### Scenario: Pull recorded
- **WHEN** a CLI pull completes
- **THEN** the history store holds a pull record with the root CID and the fetched/unchanged/conflicted/failed counts

#### Scenario: Aborted operation records nothing
- **WHEN** a publish or pull aborts before emitting its completion event
- **THEN** no record is appended

### Requirement: Publish updates the last-manifest pointer
A persisted `publish.complete` event SHALL also set the sync-state last-manifest pointer to the published root and manifest CIDs.

#### Scenario: Pointer moves
- **WHEN** two publishes complete in sequence
- **THEN** the pointer names the second publish's root and manifest CIDs

### Requirement: Conflict records keep hashes, not paths
A persisted `conflict` record SHALL carry the local and remote sha256 and the parent operation's root CID, and SHALL NOT carry the event's `path` or `conflictPath`.

#### Scenario: Conflict persistence
- **WHEN** one conflict occurs during a recorded pull
- **THEN** the store holds one conflict row whose serialized form contains neither path string and both hashes

### Requirement: Recorder failure never fails the sync
A failure of the history recorder (database error, full disk) SHALL be reported on stderr and SHALL NOT change the sync command's exit code or outcome.

#### Scenario: Throwing store
- **WHEN** the store throws on every write during an otherwise successful publish
- **THEN** the publish reports success, the exit code is 0, and a recorder error line appears on stderr

### Requirement: Recorder performs no node requests
Recording history SHALL be purely local; the recorder SHALL NOT cause any request to the IPFS node or gateway.

#### Scenario: Request audit
- **WHEN** a publish runs with request tracing enabled
- **THEN** the trace contains only the publish's own requests and nothing attributable to the recorder
