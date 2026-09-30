## Purpose

Defines Release 2 (v0.3.0): what the operator run must show, how the release tool refuses unless the guard checker passes and the shipped bytes equal the reviewed build, what the notes say, and the approvals in front of every outward step, so a version number never implies more safety than was verified. There is one variant: the first draft's fixture-only Variant B is removed.

## ADDED Requirements

### Requirement: Release definition and the operator run
Release 2 SHALL require an operator run, in Obsidian desktop, of `tools/feature-op-mvp-07.mjs` in manual mode against the shared node with two throwaway vaults, on the build that the checker hashed. The run SHALL record at least these assertion ids, each passed: `ciphertext-only-on-node`, `plaintext-restored-byte-equal`, `wrong-passphrase-refused`, `first-pull-confirm-shown` (operator-observed), `sequence-recorded`, `tamper-refused-nothing-written`, `pull-no-node-mutation`, `conflict-copy-kept`, `multi-segment-blob-pulled-in-plugin` (a file of at least 20 MiB, byte-equal; the outcome `range-honoured` or `range-ignored-refused` recorded), `older-root-by-name-refused`, `restore-older-version`, `fork-resolved`, `rewrap-and-accept` (old passphrase fails on the node's current file and opens the previous root), `increase-cost`, `prune-history`, `mass-removal-stopped`, `installed-files-hashed`, `only-demo-root-and-owned-key-changed`. A CLI-only or simulated result SHALL NOT count. The result SHALL also record the owned key's value before and after the run. The operator-run script SHALL build nothing of its own: it SHALL read `dist/.guard-build.json` written by the checker's `--build`, SHALL stop before any request when that file's tree hash differs from the current T or the files in `dist/plugin/` and `dist/cli/` differ from its recorded hashes, and SHALL say to run the checker's `--build`. The required assertion ids above are also held in the checker and the two lists SHALL be equal.

#### Scenario: Stale dist
- **WHEN** `dist/` was built from an earlier tree
- **THEN** the operator-run script exits before sending any request and names the checker's `--build`

#### Scenario: Simulation only
- **WHEN** only the verify-only result exists
- **THEN** the release procedure refuses to produce a record

#### Scenario: Multi-megabyte binary body
- **WHEN** the run pulls a 20 MiB file in the plugin
- **THEN** the file is byte-equal, or the pull refused it with the named reason and the assertion records which

### Requirement: The release is gated by the checker, not by a variant
The release tool SHALL produce a release record only when `node tools/check-guard-preconditions.mjs --json` exits 0 in the same run. There SHALL be no variant for a failing checker and no option that skips, weakens or forces the checker; a failing checker SHALL print the failing items and end the procedure. When item A passed by the git-history form, `record` SHALL require a terminal, SHALL print T8, the commit E and the number of commits that touched the review record, and SHALL require the operator to type exactly `I accept an unsigned review record for <T8>`; without a terminal it SHALL exit 2. `record` SHALL exit 2 when `IPFS_SYNC_ALLOWED_SIGNERS` is set.

#### Scenario: Unsigned record needs a typed acknowledgement
- **WHEN** item A passed by the git-history form and the operator does not type the phrase
- **THEN** `record` exits 2 and writes no release record

#### Scenario: Unsigned record without a terminal
- **WHEN** `record` runs with a pipe on standard input and item A passed by the git-history form
- **THEN** it exits 2

#### Scenario: Checker fails
- **WHEN** any checker item fails
- **THEN** `record` exits 2, lists the failing items and writes no release record

#### Scenario: No force
- **WHEN** the tool's options are listed
- **THEN** none skips or weakens the checker

### Requirement: Shipped bytes equal the reviewed build
The release tool SHALL copy the plugin files and the CLI bundle from the build the checker hashed, SHALL assert that the sha256 of each copied file equals the hash the checker printed, SHALL edit no file inside the hash scope (the version 0.3.0 SHALL already be committed in `manifest.json` and `package.json` before the review, and the tool SHALL assert it), and SHALL write and re-verify a checksum file.

#### Scenario: Stale dist
- **WHEN** `dist/` does not match the checker's build (`dist/.guard-build.json` differs from the current T or from the files)
- **THEN** the tool refuses

#### Scenario: Version not bumped
- **WHEN** `manifest.json` does not read 0.3.0
- **THEN** the tool refuses and does not edit it

### Requirement: Notes open with what the release can and cannot do
The release notes SHALL open with a paragraph stating what the release CAN do (publish and pull encrypted vaults, including real notes, between Obsidian desktop and the CLI; keep a local edit as a dated copy on conflict; refuse tampered or older states on a device that has a recorded state; change the passphrase and raise the cost; prune history) and CANNOT do: hide file count, exact sizes, publish timing or access patterns; stop a node from showing a device with no recorded state an old copy; take back an old passphrase or old key-slot copy after a change; recover a lost passphrase; detect silent corruption of unchanged files by someone who can write to the node; prevent overlapping publishes (they are detected at a later pull, and an edit can sit on the node under no name until then); remove deleted notes from old pinned roots; sync Obsidian configuration or plugins; keep `.ipfs-sync/`, including temporary files, encrypted at rest; claim mobile support (not verified, and the phone key-derivation timing when it was accepted unmeasured). The notes SHALL include the line that every vault write now creates directories with mode 0700 and files with 0600 and that a crash can leave `.<name>.<pid>.<uuid>.tmp` files in the vault directory, the evidence forms found by the checker (git-history attestation with the commit and the number of commits that touched the record, or signature with the signer fingerprint), the number of files the review record declares unread, the Node and pnpm versions of the checker's build, the attestation statement, the known limitations and unverified items, the SHA-256 of every asset, the minimum Obsidian version, and that the release is a pre-release unless the operator decides otherwise.

#### Scenario: Opening
- **WHEN** the notes are generated
- **THEN** the first paragraph lists the can and cannot statements above

#### Scenario: Timing accepted unmeasured
- **WHEN** item C is an acceptance
- **THEN** the notes list the phone timing as unverified

#### Scenario: Unsigned review record
- **WHEN** item A passed by git-history binding
- **THEN** the notes say the review record is unsigned

### Requirement: Tool behaviour
`tools/release-mvp-07.mjs` SHALL have a read-only plan mode by default and a record mode, SHALL never run git or gh, SHALL never create a tag, push, release or publication receipt, SHALL package the CLI bundle with an explicit file list, and SHALL write `evidence.json` holding the paths and hashes of the review record, the operator-run record, the timing record, the checker output, the documentation hashes the checker recorded and the tool versions. Release output SHALL stay under `dist/release/`, which no checker run deletes. The shared `tools/release/*` modules SHALL be parameterised by a per-release descriptor, and a regression check SHALL show that Release 1's plan output (`tools/release-mvp-05.mjs plan`) is unchanged by the refactor.

#### Scenario: Plan is read-only
- **WHEN** plan mode runs
- **THEN** no file in the repository changes and the ordered outward steps are printed as text

#### Scenario: Release 1 unchanged
- **WHEN** the Release 1 plan is generated before and after the refactor
- **THEN** the outputs are identical

### Requirement: Release build is checked for test hooks
The release tool SHALL rely on the checker's `checkDistBundles` result (empty `missing` and `violations`) and SHALL confirm that the bytes scanned are the bytes it hashes into the checksum file; a planted-sentinel negative test SHALL prove that a bundle with a test-only sentinel fails.

#### Scenario: Planted sentinel
- **WHEN** a test-only sentinel is planted in a built bundle
- **THEN** the check reports a violation and the tool refuses

### Requirement: Outward steps need explicit approval
Committing the release, merging the reviewed branch into `main` (fast-forward only), creating tag `v0.3.0`, pushing, and creating a GitHub pre-release SHALL each require the operator's explicit approval for that exact action after it has been shown with its exact text (repository, commit, tag, asset list with checksums, release notes). Approval for one SHALL NOT extend to another. No agent message, earlier decision or configuration value counts as approval. If approval is absent the release SHALL remain local and be reported as unpublished. The GitHub release SHALL be created as a pre-release unless the operator explicitly chooses otherwise.

#### Scenario: No approval
- **WHEN** the operator has not approved
- **THEN** no commit, merge, tag, push or release is created

#### Scenario: Scope of approval
- **WHEN** the operator approved the merge only
- **THEN** the tag and push still need their own approvals

#### Scenario: Merge is fast-forward only
- **WHEN** `main` has a scoped commit that the reviewed branch does not contain
- **THEN** the merge is not performed, the operator is told that T would change, and the procedure returns to the defect loop

### Requirement: Publication receipt stays pending without an advertising page
The cadence publication receipt SHALL be produced only when the artifacts are publicly downloadable and a first-party page containing each absolute asset URL and the version exists; otherwise the publication SHALL be reported as pending and no receipt SHALL be fabricated.

#### Scenario: GitHub page only
- **WHEN** the only page is the GitHub release page whose asset links are relative
- **THEN** the receipt is not produced and the report lists it as pending

### Requirement: Cadence scope
The operator run, the phone timing, the release checker pass and local release record, and every outward step SHALL be post-finish tasks outside the cadence increment. The increment SHALL cover code, tests, documentation, tools, the branch, the gate on the branch tree and the final security review.

#### Scenario: Scope statement
- **WHEN** the task list is read
- **THEN** the post-finish tasks are marked and none of them is required for the increment to finish
