## Purpose

Defines the device-local sync-history store: the StoreAdapter port interfaces, the WebView-safe in-memory implementation in `src/core/store/`, and the PGlite (nodefs) adapter in `cli/store/` that persists what this device published, pulled and conflicted across CLI restarts.

## ADDED Requirements

### Requirement: StoreAdapter ports
The project SHALL define StoreAdapter port interfaces in `src/core/store/`: a metadata port (append an operation record; list records newest-first with a limit), a sync-state port (get and set the last-manifest pointer), and a vector port that is declared only (no implementation, because pgvector is absent from pglite 0.5.8).

#### Scenario: Ports are interfaces
- **WHEN** `src/core/store/` is imported
- **THEN** the metadata, sync-state and vector ports are exported types, and no vector implementation exists

### Requirement: WebView-safe in-memory implementation
`src/core/store/` SHALL provide an in-memory implementation of the metadata and sync-state ports that imports no Node built-in and no PGlite module, so it is safe for the Obsidian WebView bundle.

#### Scenario: Bundle safety
- **WHEN** the `webview-safe-bundle` constraint grep and `pnpm probe:webview` run
- **THEN** `src/core/store/` contributes no Node import to the plugin bundle

### Requirement: Records never store plaintext vault paths
Persisted history records SHALL carry operation kind, timestamp, root CID, manifest CID, per-kind counts, duration and (for conflicts) the local/remote sha256 pair only. No record field SHALL hold a vault path, vault directory or file name. This rule is unconditional: encryption has already landed.

#### Scenario: Conflict record drops paths
- **WHEN** a `conflict` event carrying `path` and `conflictPath` is mapped to a record
- **THEN** the serialized record contains neither path value and does carry both sha256 hashes

#### Scenario: Schema inspection
- **WHEN** the PGlite schema and the record types are inspected
- **THEN** no column or field can hold a vault path

### Requirement: PGlite CLI adapter persists across restarts
The CLI SHALL provide a PGlite (nodefs) adapter in `cli/store/` implementing the metadata and sync-state ports against a device-local database in the per-user state directory (same directory rule as the CLI device store). Records and the last-manifest pointer SHALL survive closing and reopening the database.

#### Scenario: Restart persistence
- **WHEN** a publish record is appended, the database is closed, and a new process opens the same directory
- **THEN** the record and the last-manifest pointer are readable

### Requirement: Device-local, never synced
The history database SHALL live outside any vault, SHALL NOT be published or synced, and SHALL be usable with no node, no configuration and no passphrase.

#### Scenario: Offline use
- **WHEN** the node is unreachable and no sync configuration exists
- **THEN** the store still opens and lists previously recorded operations

### Requirement: Schema versioning is fail-closed
The database SHALL carry a schema version, and the adapter SHALL refuse an unknown version without reading or writing records.

#### Scenario: Unknown version
- **WHEN** the adapter opens a database whose schema version it does not know
- **THEN** it refuses with an error and writes nothing
