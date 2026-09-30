## Purpose

Defines the single exclusion list that decides which vault paths never sync, replacing the plugin setting and the shell-script defaults.

## ADDED Requirements

### Requirement: One exclusion source
There SHALL be exactly one exclusion definition used by publish, change detection and the manifest hash. The defaults SHALL include `.trash/`, `.ipfs-sync/`, `.DS_Store`, `.obsidian/workspace.json`, `.obsidian/workspace-mobile.json`, `.obsidian/workspace.json.bak`, `.obsidian/graph.json`, `.obsidian/cache`, `node_modules/` and `.git/`. Adding an exclusion source elsewhere SHALL NOT be possible without changing this definition.

#### Scenario: Defaults applied
- **WHEN** a vault contains `.trash/old.md` and `.obsidian/workspace.json`
- **THEN** neither is enumerated, hashed or uploaded

#### Scenario: Local state folder never syncs
- **WHEN** the vault contains `.ipfs-sync/` files such as the last-published record
- **THEN** they are never uploaded

### Requirement: Path matching
An entry containing a `/` (other than a trailing one) SHALL be anchored at the vault root and match that vault-relative path; a trailing `/` makes it match a directory and everything beneath it. An entry with no `/` other than a trailing one SHALL match a file or directory of that name at any depth. Matching SHALL use vault-relative paths with `/` separators on all platforms.

#### Scenario: Directory entry
- **WHEN** the list contains `.trash/`
- **THEN** `.trash/a/b.md` is excluded and `notes/.trash-notes.md` is not

#### Scenario: Bare name at depth
- **WHEN** the list contains `.DS_Store`
- **THEN** `.DS_Store` and `notes/sub/.DS_Store` are both excluded

#### Scenario: Anchored path
- **WHEN** the list contains `.obsidian/workspace.json`
- **THEN** that path is excluded and `notes/.obsidian/workspace.json` is not

#### Scenario: Windows separators
- **WHEN** a path is reported with backslashes by the host
- **THEN** it is normalised to `/` before matching

### Requirement: Workspace-state constraint check
The project constraint `never-sync-workspace-state` SHALL verify the exclusion definition itself and SHALL assert that `.trash/`, `workspace.json` and `.ipfs-sync/` are present in the defaults, so deleting `scripts/excludes.txt` does not break the check.

#### Scenario: Constraint after move
- **WHEN** the constraint check runs with `scripts/excludes.txt` absent
- **THEN** it passes while all three required entries are present in the exclusion definition and fails if one is removed
