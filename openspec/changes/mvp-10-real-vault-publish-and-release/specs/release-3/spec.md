## Purpose

Defines Release 3 (v0.4.0): the version bump, the GitHub pre-release and its assets, the release notes content (including the AI-layer gate), the demo evidence in the release record, and the single batched operator approval in front of every outward step — so the version number never claims more than the demo observed.

## ADDED Requirements

### Requirement: Release definition
Release 3 SHALL carry a version bump to `0.4.0` in `manifest.json` and `package.json`, a GitHub pre-release on `Prometheus-AGS/obsidian-ipfs-sync` carrying `main.js`, `manifest.json`, the CLI tarball and a SHA-256 checksum file, and a release record holding the demo procedure and its observed result. A tag or a workflow run alone SHALL NOT count as a release. The release tooling SHALL follow the descriptor pattern of `tools/release/` (a `release3.mjs` descriptor and a `tools/release-mvp-10.mjs` plan/record tool), SHALL copy assets from the build it hashes, and SHALL never run git or gh itself.

#### Scenario: Shipped bytes match the checksums
- **WHEN** the checksum file is re-verified against the packaged assets
- **THEN** every SHA-256 matches

#### Scenario: Version not bumped
- **WHEN** the record step runs
- **THEN** `manifest.json` and `package.json` read `0.4.0` before the record is written

### Requirement: Notes open with what the release can and cannot do
The release notes SHALL open with a paragraph stating what v0.4.0 CAN do (publish and pull a real encrypted vault between Obsidian desktop and the CLI, demonstrated on the operator's own ~1.0 GB vault with 0 sha256 mismatches) and CANNOT do: hide file count, exact sizes, publish timing or access patterns; claim mobile support (unverified unless the optional mobile attempt ran, and then only as recorded); claim Android support (untested); cap or exclude files in the CLI (the CLI has no read cap and no exclusion option); recover a lost passphrase; take back an old passphrase or old key-slot copy after a change; remove deleted notes from old pinned roots. The notes SHALL include the SHA-256 of every asset, the minimum Obsidian version, the known limitations, the unverified items, and that the release is a pre-release unless the operator decides otherwise.

#### Scenario: Opening
- **WHEN** the notes are generated
- **THEN** the first paragraph lists the can and cannot statements above

### Requirement: AI-layer gate on release-notes claims
The release notes SHALL NOT claim airplane-mode operation, on-device AI, or phone embeddings capability unless an iPhone run loading PGlite and the ONNX model together, with peak memory recorded, exists and is cited (the acceptance gate carried from this change's README.md and `openspec/changes/mvp-08-sync-history-store/README.md`). Without that run, the notes SHALL state that phone embeddings are opt-in and the iPhone memory run has not happened.

#### Scenario: No memory run
- **WHEN** the iPhone PGlite+ONNX run does not exist
- **THEN** the notes contain no airplane-mode or on-device-AI claim and carry the gate sentence instead

### Requirement: Demo evidence in the release record
The release record SHALL hold the path of the demo record and SHALL reproduce its headline numbers: wall time, bytes, file count, root CID, the mismatch count (0), and the unverified list. A release record without the demo evidence SHALL NOT be produced.

#### Scenario: No demo record
- **WHEN** the demo record path is missing or unreadable
- **THEN** the record step refuses

### Requirement: One batched approval for all outward steps
Committing the version bump and release files, creating the annotated tag `v0.4.0`, pushing the branch, pushing the tag, and creating the GitHub pre-release SHALL be presented to the operator as ONE approval list showing the exact text of every action: the `git add` paths and commit message, the tag and its target commit SHA, the pushes, the repository, the full asset list with checksums, and the complete release-notes text. A single approval SHALL authorize exactly the listed actions, executed without further questions; any item the operator strikes SHALL NOT be performed and SHALL be reported as not performed. No agent message, earlier decision or configuration value counts as approval. The GitHub release SHALL be created as a pre-release unless the operator explicitly chooses otherwise.

#### Scenario: No approval
- **WHEN** the operator has not approved the batched list
- **THEN** no commit, tag, push or release is created

#### Scenario: Partial strike
- **WHEN** the operator approves the list minus the tag push
- **THEN** the tag is not pushed, everything else executes, and the report names the tag push as not performed

### Requirement: Publication receipt stays pending without an advertising page
The cadence publication receipt SHALL be produced only when the artifacts are publicly downloadable and a first-party page containing each absolute asset URL and the version exists; otherwise the publication SHALL be reported as pending and no receipt SHALL be fabricated (Release 2's outcome, unchanged).

#### Scenario: GitHub page only
- **WHEN** the only page is the GitHub release page whose asset links are relative
- **THEN** the receipt is not produced and the report lists it as pending
