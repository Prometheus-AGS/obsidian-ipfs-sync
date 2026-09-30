## Purpose

Defines Release 2 (v0.3.0): what evidence makes it a release, which of two variants is produced, and the approvals in front of every outward step, so a version number never implies more safety than was verified.

## ADDED Requirements

### Requirement: Release definition and evidence
Release 2 SHALL be functionality demonstrated inside Obsidian on at least one platform: the operator-run feature operation, in Obsidian desktop, of encrypted publish from the plugin, encrypted pull in a second vault with a wrong passphrase refused, and a tampered root refused. A CLI-only or simulated result SHALL NOT count.

#### Scenario: Simulation only
- **WHEN** only the verify-only result exists
- **THEN** the release procedure refuses to produce a record

### Requirement: Two variants and the rule that selects between them
The release tool SHALL produce release notes in one of two variants. Variant A ("usable on real notes") SHALL be selected only when the guard-removal checker passes and the shipped source contains the reviewed post-removal guard modules. Variant B ("fixture-only pre-release") SHALL be selected in every other case, and its notes SHALL open with the statement that real notes must not be used because the marker guard is still in place. The tool SHALL print which variant it selected and why, and SHALL NOT allow an option to force Variant A.

#### Scenario: Preconditions hold and guard removed
- **WHEN** the checker passes and the guard modules equal the recorded post-removal content
- **THEN** Variant A is selected

#### Scenario: Guard still present
- **WHEN** the guard modules still refuse unmarked vaults
- **THEN** Variant B is selected

#### Scenario: Checker fails
- **WHEN** any precondition fails
- **THEN** Variant B is selected and the failing item is listed

### Requirement: Notes open with what the release can and cannot do
Both variants SHALL open with a paragraph stating what the release CAN do and CANNOT do. Variant A SHALL state that it publishes and pulls encrypted vaults including real notes between Obsidian desktop and the CLI, and SHALL state that it cannot hide file count, exact sizes, publish timing or access patterns, cannot prevent a node from serving an old state to a device with no recorded baseline, cannot revoke an old passphrase or old key-slot copy after a change, cannot recover a lost passphrase, and has not been verified on mobile (and the phone key-derivation timing if it was accepted unmeasured). Variant B SHALL state fixture-only operation first and then the same encryption facts. Both SHALL list the known limitations and unverified items, the SHA-256 of every asset, the minimum Obsidian version, and that the release is not the latest stable release unless the operator decides otherwise.

#### Scenario: Variant A opening
- **WHEN** Variant A notes are generated
- **THEN** the first paragraph lists the can and cannot statements above

#### Scenario: Variant B opening
- **WHEN** Variant B notes are generated
- **THEN** the first paragraph says the release must not be used on real notes

### Requirement: Tool behaviour
`tools/release-mvp-07.mjs` SHALL have a read-only plan mode by default and a record mode, SHALL never run git or gh, SHALL never create a tag, push, release or publication receipt, SHALL bump the version to 0.3.0 in `manifest.json` and `package.json`, SHALL copy artifacts unchanged from the build output, SHALL package the CLI bundle with an explicit file list, SHALL write and re-verify a checksum file, and SHALL refuse to record unless the operator-run result file exists with mode `manual`, all assertions passed and the current code-tree hash.

#### Scenario: Plan is read-only
- **WHEN** plan mode runs
- **THEN** no file in the repository changes and the ordered outward steps are printed as text

#### Scenario: Record refuses
- **WHEN** the result file is missing or simulated
- **THEN** record mode refuses

### Requirement: Release build is checked for test hooks
The release script SHALL build production, then run the distribution-bundle check (`checkDistBundles` in `tools/hook-isolation.mjs`) and SHALL require both its `missing` and `violations` results to be empty, and SHALL confirm that the bytes scanned are the same bytes it hashes into the checksum file. The check SHALL have a planted-sentinel negative test proving that a bundle containing a test-only sentinel fails it. The same check SHALL pass before the fixture-only guard is lifted.

#### Scenario: Clean bundles
- **WHEN** the release script runs on a clean build
- **THEN** `missing` and `violations` are empty and the scanned files equal the hashed files

#### Scenario: Planted sentinel
- **WHEN** a test-only sentinel is planted in a built bundle
- **THEN** the check reports a violation and the release script refuses

#### Scenario: Guard removal
- **WHEN** the guard-removal checker runs
- **THEN** it also requires the distribution-bundle check to pass

### Requirement: Outward steps need explicit approval
Committing the version bump, creating tag `v0.3.0`, pushing, and creating a GitHub pre-release SHALL each require the operator's explicit approval for that exact action after it has been shown with its exact text (repository, commit, tag, asset list with checksums, release notes). Approval for one SHALL NOT extend to another. No agent message, earlier decision or configuration value counts as approval. If approval is absent, the release SHALL remain local and be reported as unpublished. The GitHub release SHALL be created as a pre-release unless the operator explicitly chooses otherwise for Variant A.

#### Scenario: No approval
- **WHEN** the operator has not approved
- **THEN** no commit, tag, push or release is created

#### Scenario: Scope of approval
- **WHEN** the operator approved the commit only
- **THEN** the tag and push still need their own approvals

### Requirement: Publication receipt stays pending without an advertising page
The cadence publication receipt SHALL be produced only when the artifacts are publicly downloadable and a first-party page containing each absolute asset URL and the version exists; otherwise the publication SHALL be reported as pending and no receipt SHALL be fabricated.

#### Scenario: GitHub page only
- **WHEN** the only page is the GitHub release page whose asset links are relative
- **THEN** the receipt is not produced and the report lists it as pending

### Requirement: Cadence scope
The release record, the operator run, the phone timing, the guard removal and every outward step SHALL be post-finish tasks outside the cadence increment. The increment SHALL cover code, tests, documentation, scripts, release tooling and the final security review.

#### Scenario: Scope statement
- **WHEN** the task list is read
- **THEN** the post-finish tasks are marked and none of them is required for the increment to finish
