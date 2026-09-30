## Purpose

Defines how a user's existing plugin settings carry over to the new settings model without adopting anything on the shared node implicitly.

## ADDED Requirements

### Requirement: Migrate on load
When the stored plugin data has no version marker, the plugin SHALL migrate it once to the new model and store the result with a version marker. Migration SHALL be a pure mapping with no network access.

#### Scenario: Old data
- **WHEN** stored data has `rpcUrl`, `keyName`, `authToken`, `excludedPaths` and `publishIntervalMinutes`
- **THEN** the plugin loads with the mapped settings and stores them in the new form

#### Scenario: Already migrated
- **WHEN** stored data has the version marker
- **THEN** it is loaded unchanged

### Requirement: Field mapping
`rpcUrl` SHALL become the RPC endpoint URL, and the gateway endpoint SHALL start with the same URL. A non-empty `authToken` SHALL become a bearer scheme with that token; an empty one SHALL give scheme none. `excludedPaths` lines that are not already default exclusions SHALL become user-added exclusions. `publishIntervalMinutes` SHALL be kept. The MFS root SHALL be the new default.

#### Scenario: Token
- **WHEN** the old `authToken` is `abc`
- **THEN** the new auth is bearer with token `abc` and the old field is not kept separately

#### Scenario: Extra exclusions
- **WHEN** the old list contains `private/` in addition to the old defaults
- **THEN** only `private/` is a user-added exclusion

### Requirement: Key name mapping
The old `keyName` SHALL map to the new publication key only if it matches the project key-name pattern and is not a reserved name of another project. The old default `obsidian-vault` SHALL map to the new default `obsidian-vault-sync`. Any other unacceptable value SHALL map to the new default and the plugin SHALL show a notice explaining the change.

#### Scenario: Old default
- **WHEN** the old `keyName` is `obsidian-vault`
- **THEN** the new publication key is `obsidian-vault-sync`

#### Scenario: Custom project key
- **WHEN** the old `keyName` is `obsidian-vault-work`
- **THEN** it is kept

#### Scenario: Other project's key
- **WHEN** the old `keyName` is `consult-capture`
- **THEN** the new key is `obsidian-vault-sync` and a notice explains why

### Requirement: No implicit adoption
Migration SHALL leave the owned key list empty. A key that already exists on the node SHALL become usable only through creation by this plugin or explicit adoption.

#### Scenario: Existing node key
- **WHEN** a migrated user publishes and the node already has a key with the migrated name
- **THEN** the key is foreign and publishing is refused until it is adopted explicitly

### Requirement: Unreadable data
If the stored data cannot be interpreted as either form, the plugin SHALL load the defaults, keep the raw stored data untouched, and show a notice.

#### Scenario: Garbage
- **WHEN** the stored data is not an object
- **THEN** defaults are used and the stored data is not overwritten until the user saves a setting
