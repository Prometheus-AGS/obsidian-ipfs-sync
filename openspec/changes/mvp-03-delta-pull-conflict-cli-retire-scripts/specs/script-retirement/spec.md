## Purpose

Retires the shell scripts now that the CLI covers publish and pull, so the project has one implementation, no Python and no shell-only constraints.

## ADDED Requirements

### Requirement: Scripts removed
The files `scripts/publish.sh`, `scripts/pull.sh` and `scripts/excludes.txt` SHALL be removed from the repository. The project source SHALL contain no `.sh` or `.py` file outside vendored harness directories.

#### Scenario: Repository scan
- **WHEN** tracked files are listed for `*.sh` and `*.py` excluding harness-provided skill folders
- **THEN** none remain

### Requirement: Constraints follow the removal
The constraint `bash-32-compatible-scripts` and the workflow trigger that runs `bash -n` on the scripts SHALL be removed. Checks that grep `scripts/` SHALL no longer reference it. The exclusion check SHALL keep passing because it reads the exclusion module.

#### Scenario: Constraint file
- **WHEN** the constraint file is read after the change
- **THEN** it has no `bash-32-compatible-scripts` entry, no `bash -n` trigger and no `scripts/` path in its checks

### Requirement: Documentation follows the removal
README references to the scripts SHALL describe `ipfs-sync publish` and `ipfs-sync pull` instead, and SHALL NOT tell a reader to run a removed script.

#### Scenario: README scan
- **WHEN** the README is searched for `scripts/publish.sh`, `scripts/pull.sh`, `scripts/excludes.txt` and `rsync`
- **THEN** no instruction to run or depend on them remains
