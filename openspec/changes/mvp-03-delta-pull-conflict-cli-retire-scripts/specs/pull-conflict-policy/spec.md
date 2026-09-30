## Purpose

Defines how pull decides between local and remote content so that remote wins by default but no local edit is ever lost or deleted.

## ADDED Requirements

### Requirement: Local sync record
The CLI SHALL keep a local record of the content last known to be equal between this device and the remote: for each path, its sha256, plus the modification time of the local file at that moment. The record SHALL live in the vault's `.ipfs-sync/` folder (the file used by publish for its last-published state), SHALL be updated by pull for every file it synchronised, and SHALL contain no credentials. Files that failed keep their previous entry.

#### Scenario: Record after pull
- **WHEN** a pull fetches a file
- **THEN** the record holds that path with the fetched sha256 and the file's new modification time

#### Scenario: Failed file
- **WHEN** a file fails verification
- **THEN** its record entry is unchanged

#### Scenario: Record shared with publish
- **WHEN** a pull of the latest published manifest completes and the user then publishes the same vault
- **THEN** publish treats the pulled files as already synchronised and transfers none of them

#### Scenario: Restore does not advance the record
- **WHEN** a pull uses an older `--manifest` or `--manifest-file`
- **THEN** the record is left byte-identical, stderr says the record was not advanced, and a following publish writes the restored files (rollback of the remote)

### Requirement: Three-way decision
For each manifest file, pull SHALL compare the local sha256 (L), the recorded sha256 (B, absent when untracked) and the remote sha256 (R):
- L equals R: nothing to do, and B is updated to R.
- The file is missing locally: fetch it.
- L equals B and differs from R: the local file has no edits, so replace it with R without a conflict copy.
- L differs from B and differs from R (or B is absent and L differs from R): conflict.

#### Scenario: Remote-only change
- **WHEN** the local file equals the record and the remote changed
- **THEN** the remote version replaces it and no conflict copy exists

#### Scenario: Local-only change
- **WHEN** the local file differs from the record and the remote equals the record
- **THEN** the local file is left untouched and pull reports it as locally modified

#### Scenario: Both changed
- **WHEN** the local file and the remote both differ from the record and from each other
- **THEN** the conflict procedure runs

#### Scenario: Untracked local file
- **WHEN** a local file has no record entry and differs from the remote version
- **THEN** the conflict procedure runs

### Requirement: Conflict copies
On conflict, pull SHALL first preserve the local content as a sibling file named `<stem> (ipfs conflict YYYY-MM-DD).<ext>`, where the extension is the part after the last dot of the file name and is kept so the copy opens in the same application as the original. A file name with no extension, and a dotfile whose only dot is the leading one, SHALL get the suffix at the end (`<name> (ipfs conflict YYYY-MM-DD)`). The date being the local calendar date of the pulling machine, and only then write the remote version to the original path. If that name already exists, pull SHALL NOT overwrite it and SHALL use a distinct name by appending a counter inside the parentheses. If preserving the local content fails, the original SHALL be left untouched and the file counted as failed.

#### Scenario: Conflict naming
- **WHEN** `notes/a.md` conflicts on 2026-09-29
- **THEN** the local text is preserved as `notes/a (ipfs conflict 2026-09-29).md` and `notes/a.md` holds the remote text

#### Scenario: Names without a plain extension
- **WHEN** `LICENSE`, `.gitignore` and `data.tar.gz` conflict on 2026-09-29
- **THEN** the copies are `LICENSE (ipfs conflict 2026-09-29)`, `.gitignore (ipfs conflict 2026-09-29)` and `data.tar (ipfs conflict 2026-09-29).gz`

#### Scenario: Second conflict the same day
- **WHEN** the conflict copy name already exists
- **THEN** the existing copy is unchanged and the new local content is preserved as `a (ipfs conflict 2026-09-29 2).md` (the counter increases until the name is free)

#### Scenario: Preserve failure
- **WHEN** the conflict copy cannot be written
- **THEN** the original file still holds the local content and the run exits nonzero

### Requirement: Conflict copies are ordinary files
A conflict copy SHALL be an ordinary vault file. It SHALL be published by the next publish like any other file, and pull SHALL NOT treat its existence as a conflict on the original. Because a conflict copy is a new path, another device receiving it fetches it as a new file; a conflict arises on it only if two devices edit that same copy path.

#### Scenario: No loop
- **WHEN** device B publishes after preserving a conflict copy and device A pulls
- **THEN** A receives the copy as a new file and no further conflict copy is created

### Requirement: No local deletions
Pull SHALL NOT delete any local file. A path present in the local record but absent from the manifest SHALL be reported as remotely deleted and SHALL be left in place. A local file absent from the manifest and from the record SHALL be left untouched.

#### Scenario: Remote deletion
- **WHEN** a file recorded locally is missing from the manifest
- **THEN** the file remains on disk and the summary counts it under remote-deleted

### Requirement: Exclusion divergence
Pull SHALL compare the manifest `excludesHash` with the hash of the local effective exclusion list. On mismatch it SHALL print a warning on the error stream that the two devices' exclusion lists differ, ignore the record's modification-time shortcut, re-hash every local manifest file, and apply the same three-way decision without trusting mtimes. It SHALL NOT delete anything because of the divergence.

#### Scenario: Divergent lists
- **WHEN** the local exclusion list differs from the one the manifest was published with
- **THEN** stderr carries a warning naming both hashes and every manifest file is re-verified

#### Scenario: Matching lists
- **WHEN** the hashes are equal
- **THEN** no warning is printed and mtime shortcuts apply
