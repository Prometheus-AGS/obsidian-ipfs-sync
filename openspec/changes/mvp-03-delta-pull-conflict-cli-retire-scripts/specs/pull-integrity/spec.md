## Purpose

Guarantees that nothing reaches the vault unless it matches the manifest, and that a hostile or corrupt manifest cannot write outside the vault.

## ADDED Requirements

### Requirement: Verify before commit
Every fetched file SHALL be hashed while it is received and compared with the manifest sha256 before it becomes visible at its destination. The bytes SHALL be written to a temporary file on the same filesystem as the destination and moved into place only after the hash matches. On mismatch or transfer error the temporary file SHALL be removed and the destination SHALL be unchanged.

#### Scenario: Hash mismatch
- **WHEN** the fetched bytes hash to a value different from the manifest
- **THEN** the destination file is unchanged (or still absent), no temporary file remains, that file is counted as failed, and the exit code is nonzero

#### Scenario: Other files continue
- **WHEN** one file fails verification
- **THEN** the remaining files are still processed and the summary reports the counts

#### Scenario: Interrupted transfer
- **WHEN** the connection drops midway through a file
- **THEN** no partial content exists at the destination path

### Requirement: Size check
A fetched file whose byte length differs from the manifest `size` SHALL be treated as a verification failure.

#### Scenario: Truncated response
- **WHEN** the gateway returns fewer bytes than the manifest size
- **THEN** the file fails and nothing is committed

### Requirement: Untrusted manifest paths
Manifest paths are untrusted input. Pull SHALL refuse, without fetching, any path that is absolute, contains an empty, `.` or `..` segment, contains a backslash or control character, or resolves inside `.ipfs-sync/`. Refused paths SHALL count as failed and SHALL be named in the output.

#### Scenario: Traversal path
- **WHEN** a manifest lists `../outside.md`
- **THEN** nothing is written outside the vault, the path is reported as refused, and the exit code is nonzero

#### Scenario: State folder protected
- **WHEN** a manifest lists `.ipfs-sync/state.json`
- **THEN** it is refused and the local record is unchanged

### Requirement: Excluded and device-local manifest paths are refused
A legitimate manifest never lists a path that publish would have excluded. Pull SHALL refuse, without fetching, any manifest path that matches this device's effective exclusion list (defaults plus local additions), and SHALL refuse any path under `.obsidian/plugins/` whatever the local list says, because plugin code and plugin data are device-local and a pulled plugin file would execute on this device. Refused paths SHALL count as failed with a reason, the other files SHALL continue, and the exit code SHALL be nonzero.

#### Scenario: Forged manifest
- **WHEN** a manifest lists `.obsidian/plugins/x/main.js`, `.ipfs-sync/state.json`, `.git/config` and `.trash/x` next to ordinary notes
- **THEN** none of the four is fetched or written, each is reported as failed with its reason, the notes are pulled, and the exit code is 1

### Requirement: Symlinks are never followed
Pull SHALL NOT write through, replace or follow a symbolic link. If a destination path, or any directory component of it inside the vault, is a symbolic link, pull SHALL skip that file, count it as failed, name it in the output, and continue with the other files. Pull SHALL NOT create the conflict copy or remove anything for a skipped path.

#### Scenario: Destination is a symlink
- **WHEN** `notes/a.md` in the vault is a symbolic link and the manifest has a new version of it
- **THEN** the link and its target are unchanged, the file is reported as failed with a symlink reason, and the exit code is nonzero

#### Scenario: Directory component is a symlink
- **WHEN** `linked/` is a symbolic link to a directory outside the vault and the manifest lists `linked/x.md`
- **THEN** nothing is written under the link target and `linked/x.md` is reported as failed

#### Scenario: Other files continue
- **WHEN** one destination is a symlink and nine others are ordinary
- **THEN** the nine are processed normally

### Requirement: Manifest validity
Pull SHALL reject a manifest whose `version` is not 1 or whose required fields are missing before fetching any file.

#### Scenario: Unknown version
- **WHEN** the manifest has `version` 2
- **THEN** pull exits nonzero with a message naming the version and writes nothing
