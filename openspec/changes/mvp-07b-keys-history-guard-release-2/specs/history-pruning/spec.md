## Purpose

Defines `ipfs-sync prune-history`, which keeps the manifest history folder within the cap the publisher enforces, without removing anything that old published roots depend on. Ordering comes from the sequence-prefixed names delivered by 07a, so nothing is decrypted to find the oldest entries.

## ADDED Requirements

### Requirement: Prune the working history
`ipfs-sync prune-history --keep N` SHALL remove the oldest files under `manifests/` from the working MFS tree so that N remain. Order SHALL be taken from the names: entries named `<16-digit sequence>-<cid>.enc` by sequence; legacy entries named `<cid>.enc` before all of them, with no order among themselves. The command SHALL keep at least the latest 20 entries regardless of N. It SHALL refuse, before anything is removed, unless the newest prefixed entry decrypts under the vault key, belongs to the vault, has an inner sequence equal to its prefix, and that sequence equals the sequence of the node's current manifest (so a node that withholds the newest history files is caught); unless each of the newest 20 prefixed entries decrypts and has an inner sequence equal to its prefix; unless the device is up to date with the node (whether the last pull restored every file is not required); unless it holds `publish.lock`; and unless no publish or maintenance journal is pending. N SHALL count files. Two files with one sequence (which a fork produces) SHALL be counted and shown, and SHALL NOT cause a refusal. It SHALL show the counts to be removed and kept (and how many legacy entries, whose order is unknown, and how many duplicate prefixes) and require confirmation. It SHALL remove one path segment under `<mfsRoot>/manifests/` at a time, non-recursively, and SHALL never touch `current/`, `manifest.enc` or `keyslots.json`. After removal it SHALL republish through the shared republish primitive (snapshot, read-back through the immutable path, pin, name re-check, `name/publish`) without changing the manifest or its sequence. Old published roots stay pinned and fetchable, because pruning changes only the working tree.

#### Scenario: Prune
- **WHEN** the history holds 1,600 prefixed entries and the command runs with `--keep 100` and confirmation
- **THEN** the oldest 1,500 files are removed, the newest 100 remain, and `current/`, `manifest.enc` and `keyslots.json` are unchanged

#### Scenario: Floor
- **WHEN** `--keep 5` is requested
- **THEN** at least 20 entries are kept

#### Scenario: Newest does not authenticate
- **WHEN** the newest prefixed file fails authentication
- **THEN** the command refuses and removes nothing

#### Scenario: Prefix disagrees with sequence
- **WHEN** the newest prefixed file decrypts to a sequence other than its prefix
- **THEN** the command refuses and removes nothing

#### Scenario: Newest entry is older than the node manifest
- **WHEN** the node manifest is sequence 12 and the newest history file decrypts to sequence 9 with prefix 9
- **THEN** the command refuses and removes nothing, and says the history may be withheld

#### Scenario: Disagreement inside the newest 20
- **WHEN** the fifth-newest prefixed file decrypts to a sequence other than its prefix
- **THEN** the command refuses and removes nothing

#### Scenario: Duplicate prefixes
- **WHEN** two files carry sequence 8 after a fork
- **THEN** the confirmation states the duplicate count and the command proceeds

#### Scenario: Lock held
- **WHEN** another process holds `publish.lock`
- **THEN** the command refuses and removes nothing

#### Scenario: Not confirmed
- **WHEN** the user declines the confirmation
- **THEN** nothing is removed

#### Scenario: Legacy entries
- **WHEN** the folder holds legacy and prefixed entries
- **THEN** legacy entries are removed first, the confirmation states their count and that their order is unknown, and the keep set is filled from prefixed entries first

#### Scenario: Old roots remain
- **WHEN** an earlier root is fetched after pruning
- **THEN** it is still available, including its history files as they were in that root

#### Scenario: Interrupted prune
- **WHEN** the process is killed after some removals
- **THEN** a rerun completes or refuses from the maintenance journal and never reads it as a publish journal

### Requirement: Publisher limits it enables
The publisher's warning at 1,500 history entries and refusal at 1,999 (defined by the encrypted-publish change) SHALL name `ipfs-sync prune-history` and SHALL no longer say it is unavailable.

#### Scenario: Message
- **WHEN** the publisher refuses at 1,999 entries
- **THEN** the message names `ipfs-sync prune-history`
