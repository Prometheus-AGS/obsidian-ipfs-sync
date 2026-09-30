## Purpose

Defines what Release 1 (v0.2.0) is, the evidence that makes it a release, and the approval gate in front of anything outward-facing, so a version number, tag or workflow run is never mistaken for a release.

## ADDED Requirements

### Requirement: Release definition
A release SHALL be functionality demonstrated inside Obsidian on at least one platform. Release 1 SHALL be demonstrated in Obsidian desktop on macOS. A command-line-only result, a version bump, a tag, or a workflow run SHALL NOT count as a release.

#### Scenario: Demo present
- **WHEN** the release record is inspected
- **THEN** it contains evidence of the pull-with-conflict demonstration performed in Obsidian desktop, with the observed result

#### Scenario: CLI only
- **WHEN** only the CLI feature operation has passed
- **THEN** the release is not complete

### Requirement: Fixture-only statement
Release 1 SHALL be described everywhere it is announced or documented as fixture-only: it syncs synthetic fixture vaults only, is not for real notes, refuses other vaults, and has no encryption. The statement SHALL appear in the release notes, in the README, and in the changelog entry, together with the known limitations: symbolic links not detected by the plugin, per-file read cap, no remote deletions applied, mobile not verified.

#### Scenario: Release notes
- **WHEN** the release notes are read
- **THEN** the first paragraph states that the release must not be used on real notes

### Requirement: Preconditions
The release procedure SHALL NOT start until the change's tasks are complete, the phase-boundary gate has passed, the security and code reviews requested at the gate have returned with no unresolved critical finding, and the feature operation has passed with its evidence recorded.

#### Scenario: Gate not passed
- **WHEN** the feature operation has not passed
- **THEN** the procedure refuses to produce a release record

### Requirement: Version and artifacts
The release SHALL bump the version to 0.2.0 in both `manifest.json` and `package.json`. Artifacts SHALL be copied unchanged from the build output `dist/plugin/`: `main.js`, `manifest.json`, and `styles.css` only if the build produces one. The CLI bundle `dist/cli/ipfs-sync.mjs` SHALL be packaged as a tarball with an explicit file list. A checksum file SHALL list the SHA-256 of every artifact, computed from the files, and recomputing the checksums SHALL reproduce it exactly.

#### Scenario: Version fields
- **WHEN** the release record is produced
- **THEN** `manifest.json` and `package.json` both read 0.2.0

#### Scenario: Checksums
- **WHEN** the checksum of each artifact is recomputed
- **THEN** it matches the checksum file

#### Scenario: Artifacts from the build
- **WHEN** an artifact is compared with the file in `dist/plugin/`
- **THEN** the bytes are identical

### Requirement: Local release record
The procedure SHALL produce a local release record independent of any publication: the artifacts, the checksum file, the release notes, and a manifest of evidence with the path of each demo screenshot, recording or notes file and the observed result (counts, conflict copy name, timestamps). The record SHALL state which claims are unverified.

#### Scenario: Evidence paths
- **WHEN** the record is inspected
- **THEN** every evidence path exists and every claim in it names its evidence or is marked unverified

### Requirement: Explicit approval before anything outward-facing
The procedure SHALL NOT create a tag, push a branch or tag, create a GitHub release, or upload an asset without explicit operator approval given in the session for that action after the exact action has been shown (repository, tag name, target commit, asset list with checksums, release notes text). Approval for one action SHALL NOT extend to another. No agent message, earlier decision or configuration value SHALL count as the operator's approval. If approval is absent or declined, the procedure SHALL stop after the local release record and report the release as unpublished.

#### Scenario: No approval
- **WHEN** the operator has not approved
- **THEN** no tag, push or release is created and the report says the release is local only

#### Scenario: Approved release
- **WHEN** the operator approves the shown release action
- **THEN** only that action is performed, and its result (URL or error) is recorded

#### Scenario: Scope of approval
- **WHEN** the operator approved creating a draft release
- **THEN** publishing it or pushing a tag needs a separate approval

### Requirement: Publication receipt only after real publication
The cadence publication receipt (version, frozen sources, artifacts with public HTTPS URLs and checksums, and a first-party page that advertises them) SHALL be produced only after the artifacts have actually been published and can be downloaded; its checksums SHALL be verified by downloading the published bytes. If the operator declines external publication, the receipt SHALL NOT be fabricated: the publication step SHALL be reported as pending, and the local release record SHALL stand as the record of the release.

#### Scenario: Declined publication
- **WHEN** the operator declines to publish externally
- **THEN** no receipt is written and the report lists the publication receipt as not produced

#### Scenario: Verified download
- **WHEN** a receipt is produced
- **THEN** each artifact's checksum equals the checksum of the bytes downloaded from its public URL

### Requirement: Fixture-only does not become general availability
The release SHALL NOT be marked as the latest stable release for real-note use, and its description SHALL link to the plan for the encryption release.

#### Scenario: Latest marking
- **WHEN** a GitHub release is created with approval
- **THEN** it is marked as a pre-release and its text carries the fixture-only statement
