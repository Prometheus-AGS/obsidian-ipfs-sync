## Purpose

Defines `ipfs-sync prune-history`, which keeps the manifest history folder within the cap the publisher enforces, without removing anything that old published roots depend on.

## ADDED Requirements

### Requirement: Prune the working history
`ipfs-sync prune-history --keep N` SHALL remove the oldest files `manifests/<cid>.enc` from the working MFS tree so that N remain. It SHALL keep at least the latest 20 regardless of N, SHALL refuse to run unless the newest manifest authenticates under the vault key, SHALL require confirmation showing how many entries will be removed, and SHALL never touch `current/`, `manifest.enc` or `keyslots.json`. Old published roots stay pinned and fetchable, because pruning changes only the working tree. After removal the command SHALL take a new root snapshot, verify it through the immutable path, pin it and publish it like any publish, without changing the manifest or its sequence.

#### Scenario: Prune
- **WHEN** the history holds 1,600 entries and the command runs with `--keep 100` and confirmation
- **THEN** the oldest 1,500 files are removed, the newest 100 remain, and `current/`, `manifest.enc` and `keyslots.json` are unchanged

#### Scenario: Floor
- **WHEN** `--keep 5` is requested
- **THEN** at least 20 entries are kept

#### Scenario: Newest does not authenticate
- **WHEN** the newest history file fails authentication
- **THEN** the command refuses and removes nothing

#### Scenario: Not confirmed
- **WHEN** the user declines the confirmation
- **THEN** nothing is removed

#### Scenario: Old roots remain
- **WHEN** an earlier root is fetched after pruning
- **THEN** it is still available, including its history files as they were in that root

### Requirement: Publisher limits it enables
The publisher's warning at 1,500 history entries and refusal at 1,999 (defined by the encrypted-publish change) SHALL name this command.

#### Scenario: Message
- **WHEN** the publisher refuses at 1,999 entries
- **THEN** the message names `ipfs-sync prune-history`
