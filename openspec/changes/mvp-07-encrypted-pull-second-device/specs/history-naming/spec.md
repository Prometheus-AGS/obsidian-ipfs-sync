## Purpose

Makes the order of the manifest history readable without decrypting anything, so the restore list (this change) and `prune-history` (the next change) can know which entries are newest. It changes the name the publisher writes under `manifests/` and what readers accept.

## ADDED Requirements

### Requirement: Sequence-prefixed history names
The publisher SHALL write each history file as `manifests/<sequence>-<cid>.enc`, where `<sequence>` is the manifest sequence zero-padded to 16 decimal digits and `<cid>` is the manifest's `rootCID`. Because the largest valid sequence has 16 digits, the lexicographic order of names SHALL equal the numeric order of sequences. The bytes of the file SHALL be the bytes of the `manifest.enc` published at that sequence.

#### Scenario: Name form
- **WHEN** the publisher publishes sequence 5 with `rootCID` `bafy...x`
- **THEN** it writes `manifests/0000000000000005-bafy...x.enc`

#### Scenario: Order without decrypting
- **WHEN** `files/ls` lists the history folder
- **THEN** sorting the names gives the publish order for all prefixed entries

### Requirement: Readers accept both forms
Every reader of the history folder (the pre-publish check, the read-back, the pull with `--manifest`, the restore list, the fork ancestor lookup) SHALL accept names matching `(<16 digits>-)?<cid>.enc` and SHALL reject any other name as junk as before. Legacy names without a prefix (written by an mvp-06 development build) SHALL sort before every prefixed name and have no order among themselves. A prefixed name whose decrypted manifest has a different sequence than its prefix SHALL be skipped by listings with a warning and SHALL block `prune-history`.

#### Scenario: Legacy accepted
- **WHEN** the folder holds `<cid>.enc` only
- **THEN** the pre-publish check and the read-back accept it, and `--manifest <cid>` reads it

#### Scenario: Mixed folder
- **WHEN** the folder holds legacy and prefixed names
- **THEN** all are accepted and the legacy ones sort first

#### Scenario: Junk still refused
- **WHEN** the folder holds `x` or a directory
- **THEN** the existing junk refusal applies

#### Scenario: The mvp-06 operator script
- **WHEN** the mvp-06 operator script checks a `manifests/` listing that holds prefixed names
- **THEN** its history-name rule accepts both forms, and its own dry run still passes

### Requirement: Same tree, different sequence
Because the name now carries the sequence, two sequences that share one tree CID (an edit that is later reverted) SHALL have two history files. An existing file at the same name with different bytes SHALL be replaced only when it authenticates under the vault key, has the same `vaultId`, sequence and manifest identity (a resume that re-encrypted the same manifest); any other difference SHALL raise the existing history-conflict error.

#### Scenario: Reverted edit
- **WHEN** sequence 7 restores the tree of sequence 5
- **THEN** both `...0005-<cid>.enc` and `...0007-<cid>.enc` exist

#### Scenario: Resume rewrite
- **WHEN** a resume re-encrypts the pending manifest of sequence 7 and the file `...0007-<cid>.enc` holds the earlier encryption of it
- **THEN** the file is replaced and the publish completes

#### Scenario: Planted file
- **WHEN** a file at the expected name authenticates as another sequence or fails authentication
- **THEN** the publish refuses with the history-conflict error before writing

### Requirement: Dependency for the next change
The next change's `prune-history` and the plugin's restore list SHALL use the order defined here; `prune-history` SHALL NOT be implemented before this requirement is delivered.

#### Scenario: Ordering source
- **WHEN** `prune-history` chooses the oldest entries
- **THEN** it does so from the names, not by decrypting every file
