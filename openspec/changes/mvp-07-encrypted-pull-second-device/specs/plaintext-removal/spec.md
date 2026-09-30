## Purpose

Removes the interim plaintext-era code paths kept by the publish change, so the product has one format and cannot be downgraded to a readable one.

## ADDED Requirements

### Requirement: No plaintext manifest reader
The manifest v1 reader, the `--allow-plaintext-v1` flag, the `--manifest-file` input, and the pull engine's plaintext path SHALL be removed from the CLI, the plugin and the shared code. A root without an encrypted layout SHALL be refused by the pull.

#### Scenario: Flag gone
- **WHEN** `--allow-plaintext-v1` or `--manifest-file` is passed to pull
- **THEN** the CLI rejects it as an unknown option

#### Scenario: Source scan
- **WHEN** the source is searched for the v1 manifest parser and its flag
- **THEN** none remains outside tests that assert refusal

### Requirement: Downgrade impossible by construction
Because no code path reads a plaintext manifest, a root that serves `manifest.json` SHALL be refused regardless of any recorded state.

#### Scenario: Downgrade attempt
- **WHEN** a vault that was encrypted is replaced by a root with a plaintext manifest
- **THEN** the pull refuses it

### Requirement: Local state cleanup
Local state of earlier formats SHALL remain ignored, and the `encryptedSeen` marker SHALL no longer be consulted by any decision.

#### Scenario: Old state
- **WHEN** a vault directory holds a version 1 state file
- **THEN** it is ignored

### Requirement: Documentation follows
The README, CHANGELOG and DESIGN.md SHALL no longer describe plaintext publishing, plaintext manifests, or fixture-only operation, except in historical notes marked as such.

#### Scenario: Scan
- **WHEN** the README is searched for the removed flags
- **THEN** none is described as available
