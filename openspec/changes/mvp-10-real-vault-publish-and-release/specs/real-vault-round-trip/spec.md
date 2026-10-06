## Purpose

Defines the real-vault round trip: the operator publishes the actual host vault, encrypted, from inside Obsidian desktop, reproduces it into a fresh vault with zero content mismatches, and the run leaves an auditable record — preconditions, measurements, skips and evidence — that Release 3's notes may cite. Every action that touches the real vault or writes real content to the node is operator-run; agents prepare and verify but do not execute them.

## ADDED Requirements

### Requirement: Operator gate before the publish
Before any publish of the real vault, the operator SHALL run a secret scan of the vault's publishable set (the files left by the default exclusions), with the 36 secret-like note names from the 2026-10-05 read-only scan adjudicated one by one (rotated/removed/excluded, or a recorded false positive), and SHALL rotate the leaked OpenAI key. The scan tool, its version, its date and its verdict SHALL be recorded; no key material or secret content SHALL enter the repository or the record. A publish executed by an agent, or before both preconditions are recorded, SHALL NOT count as the demo.

#### Scenario: Scan verdict recorded
- **WHEN** the demo record is read
- **THEN** it names the scan tool, version and date, and disposes of each of the 36 secret-like names

#### Scenario: Rotation recorded without material
- **WHEN** the demo record is read
- **THEN** it states the OpenAI key rotation date and that the old key was revoked, and contains no key bytes

### Requirement: Publish from Obsidian desktop, measured
The operator SHALL publish the host vault from inside Obsidian desktop (the plugin's Publish command) against the operator's node, adopting the existing `/obsidian-vault-sync/real-obsidian` root and its keyslots/passphrase pair unless the recorded fallback (design.md D-A) was taken. The record SHALL carry: wall time, bytes sent, file count, the root CID, the IPNS resolution result, the plugin settings in force (node URLs, mfsRoot, key, exclusion list and its hash, read cap), and the complete skipped-file list with per-file reasons.

#### Scenario: Skips are named
- **WHEN** any file was excluded, over the read cap, changed or removed during read, or a dangling symlink
- **THEN** the record names it with its reason, so the published set is exact

#### Scenario: Scratch-proven adopt path
- **WHEN** the operator publish begins
- **THEN** the adopt path it uses was first proven on a scratch root and the scratch root was removed

### Requirement: Fresh-vault pull with zero mismatches
The operator SHALL create a fresh vault in Obsidian, install the plugin, enter the passphrase, and pull through the plugin's first-pull flow. Every pulled file's sha256 SHALL be compared against the source vault's published set; the acceptance bar is 0 mismatches. Paths the pull policy skips SHALL be named. The comparison SHALL run on the operator's machine with operator-executed commands and no new tooling.

#### Scenario: Acceptance met
- **WHEN** the comparison runs
- **THEN** every file of the published set is present in the fresh vault with a matching sha256, and the mismatch count printed is 0

#### Scenario: History evidence
- **WHEN** the CLI is restarted after the demo
- **THEN** `ipfs-sync history` lists the publish and the pull from the on-disk database

### Requirement: Mobile stays optional and honest
A mobile Obsidian attempt MAY be run; if it runs, its outcome SHALL be recorded; if it does not, the record and the release notes SHALL state that mobile is unverified (T3). No sentence SHALL claim mobile support from this change alone.

#### Scenario: Not run
- **WHEN** no mobile attempt was made
- **THEN** the record says "not run" and the notes carry the unverified line

### Requirement: Cleanup only on confirmation
`publish-real-20260929` SHALL be removed from the node only after the round trip has passed and the operator has explicitly confirmed the removal; the before and after `files/ls /obsidian-vault-sync` listings SHALL be recorded. No other node state is touched; `key/rm` and `pin/rm` remain forbidden.

#### Scenario: No confirmation
- **WHEN** the operator has not confirmed
- **THEN** the staging tree remains and the record says so
