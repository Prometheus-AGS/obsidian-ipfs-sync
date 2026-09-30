## Purpose

Defines the synthetic vault used to exercise publish while encryption does not exist yet, so no real note is ever published in plaintext.

## ADDED Requirements

### Requirement: Fixture generator
The repository SHALL provide a generator that creates a synthetic vault in a directory the operator names. The generated vault SHALL contain the marker file `.ipfs-sync-fixture` at its root, nested folders, Markdown notes, at least one binary attachment, and at least one excluded path (such as `.trash/` content) so exclusions are observable. All content SHALL be generated text or bytes with no user data.

#### Scenario: Generate
- **WHEN** the generator is run with a target directory
- **THEN** the directory contains `.ipfs-sync-fixture`, at least 10 files across at least 3 folders, and an excluded `.trash/` entry

#### Scenario: Deterministic content
- **WHEN** the generator runs twice with the same seed
- **THEN** both vaults have identical file paths and sha256 values

### Requirement: Generator refuses non-empty targets
The generator SHALL refuse to write into a directory that is not empty unless it already contains the marker file, and SHALL NOT read any file it did not create.

#### Scenario: Existing real vault
- **WHEN** the target directory contains files and no marker
- **THEN** the generator exits nonzero and writes nothing

### Requirement: Marker semantics
The marker SHALL be an ordinary vault file that is never itself published, and SHALL be the only signal the plaintext guard accepts.

#### Scenario: Marker excluded from sync
- **WHEN** a fixture vault is published
- **THEN** `.ipfs-sync-fixture` is not in the manifest
