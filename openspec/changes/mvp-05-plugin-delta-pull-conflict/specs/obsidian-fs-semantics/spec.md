## Purpose

Defines exactly how the Obsidian implementation of the shared file-system contract behaves for pull, including what the platform cannot guarantee, so no one assumes a safety property the plugin does not have.

## ADDED Requirements

### Requirement: Contract members implemented over the vault adapter
The plugin host SHALL implement the shared file-system members `list`, `stat`, `lstat`, `read`, `readRange`, `write`, `append`, `mkdir`, `remove` and `rename` using only Obsidian's vault adapter, rooted at the vault, refusing absolute paths and `..` segments, and working on hidden folders such as `.ipfs-sync/`.

#### Scenario: Hidden folder
- **WHEN** the engine appends to `.ipfs-sync/tmp/x.part`
- **THEN** the file is created and extended there

#### Scenario: Escaping path
- **WHEN** any member receives a path containing `..`
- **THEN** it fails without touching a file

### Requirement: Atomic commit of a downloaded file
A downloaded file SHALL be assembled in a temporary file under `.ipfs-sync/tmp/` using bounded appends, verified by the engine, and committed to its destination by rename. If the destination exists, the commit MAY remove it immediately before the rename, because the adapter's rename is not guaranteed to replace a file. The commit SHALL happen only after verification and, for a conflict, only after the local content has been preserved in the conflict copy. On any failure the temporary file SHALL be removed and the destination left as it was, except that a crash between the removal and the rename leaves the destination absent with the verified content still in the temporary folder, so the next pull refetches it.

#### Scenario: Verification failure
- **WHEN** the downloaded bytes do not match the manifest
- **THEN** the destination is unchanged and the temporary file is removed

#### Scenario: Replace of an unedited file
- **WHEN** a remote change replaces a local file that had no local edits
- **THEN** the destination ends with the remote content

#### Scenario: Conflict ordering
- **WHEN** a conflict is resolved
- **THEN** the conflict copy exists with the local bytes before the original path is replaced

#### Scenario: Stale temporary files
- **WHEN** a pull starts and `.ipfs-sync/tmp/` holds files from an earlier interrupted run
- **THEN** they are removed before fetching

### Requirement: Append and create semantics
`append` SHALL create the file (and missing parent folders) when it does not exist and otherwise extend it, so a caller never needs to know which case applies.

#### Scenario: First chunk
- **WHEN** append is called for a path that does not exist
- **THEN** the file is created with the given bytes

### Requirement: Stat and list mapping
`stat` and `lstat` SHALL report a folder as a directory, a file with its size and modification time in milliseconds, and `undefined` for a missing path. `list` SHALL return the direct children with the same fields.

#### Scenario: Missing path
- **WHEN** stat is called for a path that does not exist
- **THEN** it returns undefined

### Requirement: Symbolic links cannot be detected (documented limitation)
Obsidian's adapter reports no link information. `lstat` therefore SHALL behave like `stat` and SHALL NOT report a symbolic link; the engine's symbolic-link refusal cannot take effect on this host. The plugin SHALL document this limitation in its documentation and release notes. The plugin SHALL reduce the exposure by (1) admitting pulls only into fixture or empty vaults in this release, (2) committing files by rename, which replaces a link at the destination path rather than writing through it on desktop platforms where the adapter renames with the operating system, a behaviour that the feature operation probes and records rather than assumes, and (3) never creating links. A symbolic link at a directory component of the path is not detected, and this residual risk SHALL be stated.

#### Scenario: Limitation stated
- **WHEN** the release notes and plugin documentation are read
- **THEN** they state that symbolic links inside the vault are not detected by the plugin and that pulls are restricted to fixture vaults for this reason among others

#### Scenario: Probe recorded
- **WHEN** the feature operation pulls a changed file over a path that is a symbolic link to a file outside the vault
- **THEN** the observed outcome (link replaced, target unchanged or changed) is recorded, and a changed outside file fails the feature operation

### Requirement: Memory bounds and read cap
The adapter offers no partial read, so `readRange` and `read` SHALL load one whole file and return the requested slice. To bound memory, the plugin SHALL enforce a configurable read cap in megabytes. Reading a file larger than the cap SHALL fail with a clear error naming the file and the cap, the file SHALL be counted as failed (pull) or skipped with a count (publish), and other files SHALL continue. The default cap SHALL be 64 MB and the configurable range SHALL be 8 MB to 1024 MB. Downloading a file larger than the cap is still allowed, because downloads are appended in bounded chunks and hashed incrementally, but such a file cannot be re-read on this device for hashing.

#### Scenario: File over the cap
- **WHEN** a local file of 100 MB must be hashed and the cap is 64 MB
- **THEN** that file is reported as failed with the cap in the message and the others are processed

#### Scenario: Bounded download
- **WHEN** a 200 MB remote file is fetched
- **THEN** no more than one 8 MB chunk of it is held in memory at a time

#### Scenario: Cap change
- **WHEN** the user sets the cap to 128 MB
- **THEN** the next operation reads files up to 128 MB

### Requirement: No Node built-ins
The implementation SHALL NOT import Node built-in modules or reach the file system by any route other than the Obsidian API.

#### Scenario: Static check
- **WHEN** the project's WebView-safety check runs over the plugin source
- **THEN** it finds nothing
