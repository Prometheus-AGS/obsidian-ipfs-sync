## Purpose

Defines the accuracy contract for README.md as the project's primary public document: it reflects the shipped release state, and every verifiable factual claim it makes is enumerated, source-referenced and checked against the code and records of truth, with results committed as evidence.

## ADDED Requirements

### Requirement: README reflects the shipped release state
README.md SHALL NOT describe v0.4.0 as in-flight, SHALL NOT describe `main` as awaiting a release merge, and SHALL NOT bind evidence to a branch superseded by a merge. Release-status statements SHALL name the shipped state: v0.4.0 shipped 2026-10-11 as a GitHub pre-release and PR #2 merged to main on 2026-10-12.

#### Scenario: No stale release phrasing
- **WHEN** `grep -n "being cut\|keeps the old guard\|until the release merge" README.md` runs
- **THEN** it prints nothing

### Requirement: Verifiable claims are inventoried
Every verifiable factual claim in README.md — commands, flags, defaults, limits, exit codes, file paths, versions, timings, counts — SHALL be enumerated in a committed checklist under the change folder, and each entry SHALL carry its README source section and line reference.

#### Scenario: Inventory completeness check
- **WHEN** the claim inventory is inspected
- **THEN** every entry names a source section and line, and the unchecked-entry count is stated in the file header

### Requirement: Every claim is checked against the code of record
Each inventoried claim SHALL be verified against `src/`, `cli/`, `manifest.json` or `docs/operator/mvp-10-demo-record.md` as applicable; a mismatch SHALL be corrected in README.md and recorded as fixed in the inventory with the checking evidence.

#### Scenario: Zero unchecked claims
- **WHEN** the verification pass completes
- **THEN** the inventory contains no unchecked entry, and every corrected claim carries pasted grep evidence of the fix
