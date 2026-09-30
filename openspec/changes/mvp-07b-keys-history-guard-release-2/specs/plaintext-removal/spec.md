## Purpose

Removes the interim plaintext-era code paths kept by the earlier changes, so the product has one format and cannot be downgraded to a readable one, and records exactly which files go. It replaces the first draft, which named no files and left the downgrade latch, the state requirement and the plugin notices in place.

## ADDED Requirements

### Requirement: No plaintext manifest reader
The manifest v1 reader, the `--allow-plaintext-v1` flag, the `--manifest-file` input and the pull engine's plaintext path SHALL be removed from the CLI, the plugin and the shared code. Removal SHALL cover at least: `src/sync/manifest.ts`, `state.ts`, `pull.ts`, `pull-plan.ts`, `pull-fetch.ts`, `pull-record.ts`, `pull-target.ts`, `pull-screen.ts` and `pull-latch.ts`; the plaintext errors in `pull-errors.ts`; the `allowPlaintextV1` seam, notices and refusal reasons in the plugin; the flags in `cli/args.ts`, `run.ts`, `help-text.ts` and `pull-command.ts`; and the v1 imports of the WebView probe entry. The removal SHALL be done in three steps so that no commit leaves an import to a deleted file: modules that other code imports are adapted first, then the flags, notices, seams and probe imports are removed, then the files and their tests are deleted. The helpers that live in those files and that the encrypted pull needs (`TEMP_DIR`, `discardTemp`, target resolution) SHALL already live in kept modules (07a). The task that removes them SHALL re-run the search for the v1 symbols and list anything further it finds.

#### Scenario: Flag gone
- **WHEN** `--allow-plaintext-v1` or `--manifest-file` is passed to pull
- **THEN** the CLI rejects it as an unknown option

#### Scenario: Source scan
- **WHEN** the source is searched for the v1 manifest parser, its flag and the latch module
- **THEN** none remains outside tests that assert refusal

### Requirement: Refusals for roots that are not an encrypted vault
A root with `manifest.json` and no `keyslots.json` SHALL be refused with a message that plaintext publications are no longer supported by this version, and nothing SHALL be written. A root with `keyslots.json` and no `manifest.enc` SHALL be refused and treated as neither an empty vault nor creatable. A planted `manifest.json` in a root that has the encrypted layout SHALL never be read.

#### Scenario: Old plaintext root
- **WHEN** the target holds a plaintext `manifest.json` and no key slots
- **THEN** the pull refuses it and writes nothing

#### Scenario: Slots without manifest
- **WHEN** the root holds `keyslots.json` and no `manifest.enc`
- **THEN** the pull and the publish refuse and create nothing

#### Scenario: Planted manifest
- **WHEN** a root holds `keyslots.json`, `manifest.enc` and a planted `manifest.json`
- **THEN** the pull reads only the encrypted files

### Requirement: Downgrade impossible by construction
Because no code path reads a plaintext manifest, a root that serves `manifest.json` SHALL be refused regardless of any recorded state. The evidence role that the `encryptedSeen` latch played (including for abandoned destinations) is replaced by the sequence floor of `rollback-detection`; `abandon` SHALL NOT record a latch and SHALL keep printing the floor it keeps (added by 07a).

#### Scenario: Downgrade attempt
- **WHEN** a vault that was encrypted is replaced by a root with a plaintext manifest
- **THEN** the pull refuses it

### Requirement: State cleanup
Local state of earlier formats SHALL remain readable as 07a defines; `encryptedSeen` SHALL no longer be required by the decoder or consulted by any decision.

#### Scenario: Old state
- **WHEN** a vault directory holds a format 2 state
- **THEN** it is upgraded as before and no decision consults `encryptedSeen`

### Requirement: Documentation follows
The README, CHANGELOG and DESIGN.md SHALL no longer describe plaintext publishing, plaintext manifests or fixture-only operation, except in historical notes marked as such. The plaintext-era operator scripts `tools/feature-op-mvp-02.mjs` to `tools/feature-op-mvp-05.mjs` SHALL be described as historical (they do not work against the encrypted publisher), and any release helper that depends on plaintext publishing SHALL be identified by the docs task and marked the same way; no script is deleted.

#### Scenario: Scan
- **WHEN** the README is searched for the removed flags
- **THEN** none is described as available
