## Purpose

Defines how the Obsidian plugin brings a vault to the published state using the shared pull engine, without changing anything on the node and without endangering local edits.

## ADDED Requirements

### Requirement: Pull command, ribbon and status
The plugin SHALL provide a command "IPFS Sync: Pull vault", a ribbon icon that runs it, and status content showing progress while a pull runs and a summary afterwards. The summary SHALL state counts of fetched, unchanged, conflicted, failed and remotely-deleted files, and SHALL name the conflict copies created. A failed run SHALL show the reason and the first failed paths, and SHALL NOT use wording that suggests success.

#### Scenario: Pull with a conflict
- **WHEN** one file changed remotely and locally in different ways, one changed only remotely, and the rest are unchanged
- **THEN** the summary reports 2 fetched, 1 conflict, 0 failed and names the conflict copy

#### Scenario: Progress
- **WHEN** a pull is running
- **THEN** the status shows the current phase (resolving, comparing, fetching) and a fetched count that increases

### Requirement: Same engine, same behaviour as the CLI
The plugin pull SHALL use the shared pull engine: name resolution without cache, manifest read through the gateway, sha256 verification before commit, atomic writes, the three-way conflict decision, extension-keeping dated conflict copies, no local deletions, remote deletions reported only, and the events defined for pull. The plugin SHALL contain no separate download or merge logic and SHALL NOT include any whole-archive download path.

#### Scenario: Same result as the CLI
- **WHEN** the plugin and the CLI pull the same manifest into identical copies of a vault with the same local edits
- **THEN** both end with the same file contents and the same conflict copy names

#### Scenario: Legacy code gone
- **WHEN** the plugin source is searched for the archive download endpoint and tar extraction
- **THEN** none is found

### Requirement: Pull target
The pull SHALL resolve the IPNS name given by the pull-name setting; when that setting is empty it SHALL use the ID of the configured publication key, but only if that key exists on the node and its ID is recorded as owned. Otherwise the pull SHALL stop before fetching and tell the user to set a pull name.

#### Scenario: Default target
- **WHEN** the pull-name setting is empty and the owned key exists
- **THEN** that key's ID is resolved

#### Scenario: No target
- **WHEN** the setting is empty and no owned key exists
- **THEN** the pull stops with a message pointing to the pull-name setting and writes nothing

### Requirement: Read-only against the node
The plugin pull SHALL perform no node mutation. It SHALL use only name resolution, gateway reads and key listing.

#### Scenario: Node unchanged
- **WHEN** a pull completes
- **THEN** the resolved root, the MFS root's CID and the key list on the node are identical before and after

### Requirement: Fixture-only destination guard
While the build has no encryption, the plugin pull SHALL write only into a vault that contains the `.ipfs-sync-fixture` marker, or that contains no files apart from the app's own hidden configuration folders (`.obsidian/` and `.ipfs-sync/`). Any other vault SHALL be refused before any request, with a visible notice that only fixture vaults can be synced in this release. When the vault qualified by being empty, the pull SHALL create the marker in it. This refines the CLI rule (absent or empty directory) for a vault that always contains `.obsidian/`. The guard is removed by the encryption change.

#### Scenario: Real vault refused
- **WHEN** the vault has notes and no marker
- **THEN** a notice explains the restriction, the node receives no request and no file changes

#### Scenario: Fresh vault with the plugin installed
- **WHEN** the vault contains only `.obsidian/`
- **THEN** the pull proceeds and the marker exists afterwards

### Requirement: Unsaved editor content is not lost
Before comparing files, the pull SHALL ask every open editor to save its pending content to disk, so a local edit that is only in an editor is treated as a local edit.

#### Scenario: Pending edit
- **WHEN** a note has been edited in the editor within the last two seconds and Pull runs
- **THEN** the edit is saved first and, if the remote also changed, it appears in the conflict copy

### Requirement: One sync operation at a time
Publish and pull SHALL NOT run concurrently in one vault. A request made while the other is running SHALL be ignored with a notice.

#### Scenario: Pull during publish
- **WHEN** Pull is triggered while a publish is running
- **THEN** it does not start and a notice says an operation is in progress

### Requirement: On-load catch-up
When the catch-up setting is on, the plugin SHALL run one pull after the workspace layout is ready. The catch-up SHALL obey every guard of a manual pull, SHALL NOT delay or block startup, and SHALL show a notice only when it changes files, creates a conflict copy, or fails. When the setting is off no pull happens on load.

#### Scenario: Setting off
- **WHEN** the plugin loads with catch-up off
- **THEN** no request is sent

#### Scenario: Setting on, nothing changed
- **WHEN** the plugin loads with catch-up on and the vault is already current
- **THEN** a pull runs and no notice is shown

#### Scenario: Setting on, remote unreachable
- **WHEN** the node cannot be reached at load
- **THEN** the plugin finishes loading and shows one failure notice

### Requirement: Secrets and privacy in output
Notices, the status bar and stored summaries SHALL NOT contain credentials or file contents. Stored summaries SHALL contain counts, root CIDs and timestamps only.

#### Scenario: Stored summary
- **WHEN** the last-pull summary is read from the plugin data
- **THEN** it holds counts, CIDs and a timestamp and no path text or secret
