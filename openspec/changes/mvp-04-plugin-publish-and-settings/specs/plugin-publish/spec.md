## Purpose

Defines how the Obsidian plugin publishes a vault through the shared sync engine, what it shows the user, and the limits that apply while publishing is fixture-only.

## ADDED Requirements

### Requirement: Fixture-only publishing (prominent)
While the build has no encryption, the plugin SHALL publish only a vault whose root contains the marker file `.ipfs-sync-fixture`. Any other vault SHALL be refused before any network request, with a visible notice stating that encryption is not yet available and that only synthetic fixture vaults can be published. Release v0.2.0 (mvp-05) is therefore a fixture-only release: it demonstrates sync mechanics and MUST NOT be used on real notes. The release notes SHALL say so. This guard is removed by the encryption change.

#### Scenario: Real vault refused
- **WHEN** the user runs Publish in a vault with no marker file
- **THEN** a notice explains that only fixture vaults can be published, and the node receives no request

#### Scenario: Fixture vault allowed
- **WHEN** the vault root contains the marker and the settings are valid
- **THEN** publishing proceeds

### Requirement: Publish through the shared engine
The publish command, the ribbon icon and the auto-publish timer SHALL all run the same shared publish engine that the CLI uses, producing the same manifest format and node layout. The plugin SHALL contain no separate upload logic: no whole-vault buffering, no private RPC helper, and no multipart upload outside the shared client.

#### Scenario: Same result as the CLI
- **WHEN** the plugin and the CLI publish identical vault content under the same MFS root
- **THEN** the resulting manifests list the same paths, sizes and sha256 values

#### Scenario: Shared state
- **WHEN** the CLI has published a vault and the plugin then publishes it after one file was edited
- **THEN** the plugin transfers only the edited file

### Requirement: Publish command, ribbon and status
The plugin SHALL provide a command "IPFS Sync: Publish vault", a ribbon icon that runs it, and a command that shows the sync status (publication key state, last published root, last publish time). While a publish runs, the plugin SHALL show progress driven by the event bus, and SHALL prevent a second concurrent publish. On success it SHALL show a notice with the written and removed counts and the new root; on failure a notice with the reason and no partial-success wording.

#### Scenario: One edited note
- **WHEN** one note of an already published vault is edited and Publish runs
- **THEN** the notice reports 1 file written and 0 removed

#### Scenario: Concurrent request
- **WHEN** Publish is triggered while a publish is running
- **THEN** the second request is ignored with a notice that a publish is in progress

#### Scenario: Failure
- **WHEN** the node rejects a write
- **THEN** the notice names the failure and the IPNS pointer is unchanged

### Requirement: Removed legacy behaviour
The plugin SHALL NOT include the previous tar-based pull command, the private RPC helper or the single-request vault upload. The plugin SHALL NOT offer a pull command until the pull change ships.

#### Scenario: Command list
- **WHEN** the command palette is searched for "IPFS Sync"
- **THEN** it lists Publish and Status and no Pull command

### Requirement: Key ownership recorded in plugin data
The plugin SHALL keep the IDs of IPNS keys it created or the operator adopted in its own stored data (`ownedKeys`). Publishing SHALL apply the shared key rules: an absent key is created once and its ID recorded before `name/publish`; a key with a matching name and an unrecorded ID is foreign and publishing is refused with a notice that points to the settings.

#### Scenario: First publish creates the key
- **WHEN** the configured key is absent on the node
- **THEN** the key is created, its ID is stored in plugin data, and publishing continues

#### Scenario: Foreign key
- **WHEN** a key with the configured name exists and its ID is not recorded
- **THEN** publishing is refused and no `name/publish` is sent

#### Scenario: Recording fails
- **WHEN** the plugin cannot save the new key ID
- **THEN** publishing stops before `name/publish` and the notice shows the key ID

### Requirement: Node safety
The plugin publish SHALL apply the same node-safety rules as the CLI: the MFS root confined to `/obsidian-vault-sync`, project key names only, no key removal, no unpinning.

#### Scenario: Unsafe root
- **WHEN** the MFS root setting is `/obsidian-vault-staging`
- **THEN** it cannot be saved and publish sends no request

### Requirement: Entry point and layering
`src/main.ts` SHALL only re-export the plugin. The plugin code SHALL live under `src/plugin/`, depend on the shared engine through its public interfaces, and contain no Node built-in imports.

#### Scenario: Entry file
- **WHEN** `src/main.ts` is read
- **THEN** it contains an export of the plugin and no sync logic

### Requirement: Auto-publish keeps working
The existing "publish every N minutes" setting SHALL continue to work by triggering the same publish path quietly, subject to the same guards.

#### Scenario: Timer on a non-fixture vault
- **WHEN** the timer fires in a vault without the marker
- **THEN** no request is sent and at most one notice per session explains why
