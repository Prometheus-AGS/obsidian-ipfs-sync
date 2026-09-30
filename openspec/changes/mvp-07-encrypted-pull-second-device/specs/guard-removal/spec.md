## Purpose

Defines how and when the fixture-marker guard comes off, so that real notes can leave a device only after independent review of the exact shipping code, a recorded run inside Obsidian, and a recorded phone timing or informed operator acceptance, all checked by a tool and not by memory.

## ADDED Requirements

### Requirement: Guard policy isolated
Before removal, the entire policy that refuses publishing without an accepted marker and refuses pulling into a non-fixture directory SHALL live in exactly two small modules (one for publish, one for pull) that both hosts call. No other file SHALL decide the policy. This isolation SHALL NOT change behaviour.

#### Scenario: One place
- **WHEN** the source is searched for the marker value and the review-pending message
- **THEN** they appear only in the two guard modules and in tests

#### Scenario: Behaviour unchanged
- **WHEN** the isolation is done
- **THEN** every guard test of the earlier changes passes unchanged

### Requirement: The guard is removed last, by a checked step
The guard removal SHALL be the last code task of the change, performed after the cadence increment has finished, and SHALL run a checker first. The checker SHALL exit nonzero, and the removal SHALL NOT proceed or be recorded as done, unless all three preconditions below hold. The removal SHALL replace the two guard modules with exactly the post-removal content that the security review recorded, and SHALL change nothing else.

#### Scenario: Preconditions missing
- **WHEN** any of the three evidence items is absent or fails its check
- **THEN** the checker exits nonzero, names the failing item, and the guard stays

#### Scenario: Exact replacement
- **WHEN** the guard modules are replaced
- **THEN** their SHA-256 values equal the values recorded in the review file

### Requirement: Precondition A, independent review of the merged code
The checker SHALL require a review file saved under this change's directory by the security-reviewer's findings (through the lead) that states the reviewer, an approving verdict, zero open critical findings, zero open high findings, the SHA-256 of the reviewed code tree, and the SHA-256 of each guard module as it will be after removal. The checker SHALL recompute the hash of the code tree (all files under `src/` and `cli/` except the two guard modules) and SHALL require it to equal the recorded value, so that code changed after the review fails the check.

#### Scenario: Code changed after review
- **WHEN** a file under `src/` differs from what was reviewed
- **THEN** the checker fails precondition A

#### Scenario: Open high finding
- **WHEN** the review file lists an open high finding
- **THEN** the checker fails precondition A

### Requirement: Precondition B, the run inside Obsidian
The checker SHALL require the result file of the operator-run feature operation (stored outside the repository) with mode `manual` (not a simulation and not an expectation-tampered run), every assertion passed, the required assertions present and passed (ciphertext only on the node, plaintext restored byte for byte in the second vault, wrong passphrase refused with nothing changed, sequence recorded, tampered root refused with nothing partial written, pull made no node mutation, conflict copy behaviour), and the recorded code-tree hash equal to the current one.

#### Scenario: Simulated run
- **WHEN** the result file was produced by the verify-only mode
- **THEN** the checker fails precondition B

#### Scenario: Result for other code
- **WHEN** the result file's code-tree hash differs from the current tree
- **THEN** the checker fails precondition B

### Requirement: Precondition C, phone key-derivation timing or informed acceptance
The checker SHALL require either a timing evidence file (stored outside the repository) recording the device model, operating system, foreground measurement in seconds of one derivation at 65,536 KiB, 3 iterations and parallelism 1, or a line in the decision log recording the operator's explicit, informed acceptance of shipping without a phone measurement, with a date and the operator's statement.

#### Scenario: Timing evidence
- **WHEN** the file records a measured derivation on a phone
- **THEN** precondition C passes

#### Scenario: Acceptance
- **WHEN** the decision log holds the acceptance line
- **THEN** precondition C passes, and the release notes list the phone timing as unverified

#### Scenario: Neither
- **WHEN** no timing file and no acceptance line exist
- **THEN** precondition C fails

### Requirement: Checklist items carried from the publish review
Before the guard is lifted, the checker or the review file SHALL confirm two items from the publish-wiring review: the documentation and threat model state that the publisher does not detect silent per-file corruption of unchanged files by a node writer, and a mass-removal guard exists that stops a publish which would remove more than half of the manifest entries (or all of them) unless the user confirms explicitly.

#### Scenario: Mass removal
- **WHEN** a publish would remove all files because the vault directory was emptied
- **THEN** it stops and asks for explicit confirmation

#### Scenario: Documentation item
- **WHEN** the review file is read
- **THEN** it records that the per-file corruption limit is documented

### Requirement: Distribution bundles are clean
The checker SHALL additionally require that the distribution-bundle check of the release tooling passes (no test-only sentinel in the built plugin and CLI bundles, nothing missing).

#### Scenario: Sentinel in a bundle
- **WHEN** a built bundle contains a test-only sentinel
- **THEN** the checker fails

### Requirement: What removal changes
After removal, publishing SHALL be allowed for any vault (encryption remains mandatory), pulling SHALL be allowed into any directory subject to the existing conflict policy, the marker file SHALL have no meaning to publish or pull, the review-pending notices SHALL disappear, and the fixture-only exported check in the shared configuration SHALL be removed, which is a deliberate removal announced in the first configuration change.

#### Scenario: Real vault
- **WHEN** a vault without a marker is published with a valid passphrase after removal
- **THEN** it is published encrypted

#### Scenario: Pull into an existing vault
- **WHEN** a non-empty vault pulls
- **THEN** the pull proceeds and preserves local edits as conflict copies

### Requirement: Verification after removal
After the removal, the unit tests, the constraint checks, the WebView probe and the simulated feature operation SHALL be run and pass, and the removal SHALL be recorded with the checker's output.

#### Scenario: Post-removal checks
- **WHEN** the removal is complete
- **THEN** the recorded output shows the checker at exit 0 and the post-removal test and simulation results
