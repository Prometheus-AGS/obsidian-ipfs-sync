## Purpose

Defines the real-vault round trip: the actual host vault is published encrypted via the CLI gate build and reproduced into a fresh directory with zero content mismatches, and the run leaves an auditable record — preconditions, measurements, skips and evidence — that Release 3's notes may cite. The demo is agent-run under the operator's 2026-10-11 authorization (design.md D-E); the operator adjudicates the scan findings and rotates the OpenAI key.

## ADDED Requirements

### Requirement: Operator gate before the publish
Before any publish of the real vault, a secret scan of the vault's publishable set (the files left by the default exclusions) SHALL be run, with the 36 secret-like note names from the 2026-10-05 read-only scan adjudicated one by one by the operator: rotated/removed/false positive/kept — kept is a live credential the operator knowingly retains and publishes encrypted (design.md D-E; client-side encryption to the operator's own node is the design intent, and the verdict records the informed choice) — and the "excluded" verdict SHALL NOT be used on the CLI path, where it is not implementable; a finding that needs exclusion sends the demo to the plugin route instead. The operator SHALL rotate the leaked OpenAI key. The scan tool, its version, its date and its verdict SHALL be recorded; no key material or secret content SHALL enter the repository or the record. A publish executed before both preconditions are recorded SHALL NOT count as the demo.

#### Scenario: Scan verdict recorded
- **WHEN** the demo record is read
- **THEN** it names the scan tool, version and date, and disposes of each of the 36 secret-like names

#### Scenario: Rotation recorded without material
- **WHEN** the demo record is read
- **THEN** it states the OpenAI key rotation date and that the old key was revoked, and contains no key bytes

### Requirement: Publish via the CLI gate build, measured
The demo publish SHALL run via the CLI gate build (`dist/cli/ipfs-sync.mjs publish /Users/gqadonis/obsidian --mfs-root /obsidian-vault-sync/real-obsidian`, passphrase via `IPFS_SYNC_PASSPHRASE_FILE`) against the operator's node, adopting the existing `/obsidian-vault-sync/real-obsidian` root and its keyslots/passphrase pair unless the recorded fallback (design.md D-A) was taken, with publication key `obsidian-vault-real` (design.md D-E) unless the operator overrode it at adjudication. An Obsidian-plugin smoke publish MAY follow; it is optional, not required evidence. The record SHALL carry: wall time, bytes sent, file count, the root CID, the IPNS resolution result, the configuration in force (node URLs, mfsRoot, publication key), and the complete skipped-file list with per-file reasons.

#### Scenario: Skips are named
- **WHEN** any file was changed or removed during read, or a dangling symlink
- **THEN** the record names it with its reason, so the published set is exact

#### Scenario: Scratch-proven adopt path
- **WHEN** the demo publish begins
- **THEN** the adopt path it uses was first proven on a scratch root and the scratch root was removed

### Requirement: Fresh-directory pull with zero mismatches
The demo SHALL pull into a fresh directory via the CLI with the same passphrase (the destination is a directory, not an Obsidian vault). Every pulled file's sha256 SHALL be compared against the source vault's published set; the acceptance bar is 0 mismatches. Paths the pull policy skips SHALL be named. The comparison SHALL run on the operator's machine with no new tooling.

#### Scenario: Acceptance met
- **WHEN** the comparison runs
- **THEN** every file of the published set is present in the fresh directory with a matching sha256, and the mismatch count printed is 0

#### Scenario: History evidence
- **WHEN** the CLI is restarted after the demo
- **THEN** `ipfs-sync history` lists the publish and the pull from the on-disk database

### Requirement: Mobile stays optional and honest
A mobile Obsidian attempt MAY be run; if it runs, its outcome SHALL be recorded; if it does not, the record and the release notes SHALL state that mobile is unverified (T3). No sentence SHALL claim mobile support from this change alone.

#### Scenario: Not run
- **WHEN** no mobile attempt was made
- **THEN** the record says "not run" and the notes carry the unverified line

### Requirement: Cleanup only on confirmation
`publish-real-20260929` SHALL be removed from the node only after the round trip has passed and on the operator's confirmation; the operator's 2026-10-06 pre-approval ("demo-root cleanup after each feature op", `.kbd-orchestrator/phases/mvp/execution.md`) stands as that confirmation, so the removal runs once, after the comparison passes. The before and after `files/ls /obsidian-vault-sync` listings SHALL be recorded. No other node state is touched; `key/rm` and `pin/rm` remain forbidden.

#### Scenario: No confirmation
- **WHEN** the operator has not confirmed
- **THEN** the staging tree remains and the record says so
