## Purpose

Defines the plugin's plain settings tab: what an operator can configure, how bad values are rejected, and how secrets and key adoption are handled safely.

## ADDED Requirements

### Requirement: Endpoint settings
The settings tab SHALL provide separate RPC and gateway endpoints, each with its own URL and optional port. The two SHALL NOT be forced to share host, port or scheme.

#### Scenario: Different endpoints
- **WHEN** RPC is `https://rpc.example.org` port 5001 and gateway is `https://gw.example.org` port 8080
- **THEN** publish sends RPC requests to the first and gateway requests to the second

#### Scenario: Conflicting port
- **WHEN** a URL already carries a port that differs from the port field
- **THEN** an inline error names both values and the setting is not saved

### Requirement: Publication key and MFS root
The tab SHALL provide the publication key name and the MFS root. The MFS root default SHALL be `/obsidian-vault-sync/default` and the key default `obsidian-vault-sync`. Both SHALL be validated with the shared node-safety rules, showing a clear inline error beside the field for any rejected value, and a rejected value SHALL NOT be saved.

#### Scenario: Foreign MFS root
- **WHEN** the user enters `/obsidian-vault-staging`
- **THEN** an inline error explains that roots must sit under `/obsidian-vault-sync` and the previous value stays

#### Scenario: Other projects' key
- **WHEN** the user enters `consult-capture`
- **THEN** an inline error explains the name is not allowed and the previous value stays

### Requirement: Authentication settings
The tab SHALL offer the schemes none, basic (user, password), bearer (static token or JWT) and custom header (name, value), showing only the fields of the selected scheme. Secret fields SHALL be masked. The scheme SHALL apply to both endpoints.

#### Scenario: Scheme switch
- **WHEN** the user switches from bearer to basic
- **THEN** the token field is replaced by user and password fields

#### Scenario: Expired JWT
- **WHEN** a bearer token is a JWT whose expiry is in the past
- **THEN** the tab shows a warning naming the expiry time and still allows saving

### Requirement: Secrets handling
Secret values SHALL be stored in the plugin's data file and the tab SHALL show a visible warning that they are stored unencrypted in the vault's plugin data. Secrets SHALL NOT appear in logs, notices, error messages or the status display. The plugin's data file SHALL be excluded from sync so secrets are never published.

#### Scenario: Warning visible
- **WHEN** the tab is opened
- **THEN** the secrets warning is displayed near the authentication fields

#### Scenario: Data file never published
- **WHEN** a vault whose `.obsidian/plugins/ipfs-sync/data.json` holds a token is published
- **THEN** that file is absent from the manifest and no request body contains the token

#### Scenario: Error text
- **WHEN** authentication fails
- **THEN** the message names the endpoint and does not contain the token, password or header value

### Requirement: Exclusions editor
The tab SHALL show the effective exclusion list (defaults plus the user's additions) and its `excludesHash`, and SHALL let the user add and remove additional entries but not remove the defaults. Additions SHALL follow the shared matching rules.

#### Scenario: Hash shown
- **WHEN** the user adds an exclusion
- **THEN** the displayed effective list includes it and the displayed `excludesHash` changes

#### Scenario: Defaults protected
- **WHEN** the user tries to remove `.trash/`
- **THEN** the entry stays and the tab explains defaults cannot be removed

### Requirement: Owned key display and adoption
The tab SHALL show the publication key's state (absent, owned, foreign) and the recorded owned key IDs. It SHALL provide an "adopt key by ID" control. Adoption SHALL require an explicit confirmation dialog stating that the plugin will publish to that key and replace whatever pointer it currently holds, that other projects may depend on it, and that this cannot be undone by the plugin. Adoption SHALL NOT bypass name validation: a key whose name is not an allowed project key name cannot be adopted.

#### Scenario: Confirmation required
- **WHEN** the user submits a key ID to adopt
- **THEN** nothing is recorded until the user confirms in the dialog

#### Scenario: Cancelled
- **WHEN** the user cancels the dialog
- **THEN** the owned list is unchanged

#### Scenario: Disallowed key name
- **WHEN** the key with that ID has the name `prince-live`
- **THEN** adoption is refused with an explanation

### Requirement: Plain settings tab only
The tab SHALL be an ordinary settings tab. It SHALL NOT include the control-center experience deferred to a later phase.

#### Scenario: Scope
- **WHEN** the tab is opened
- **THEN** it contains the settings above and no dashboard or agent surfaces

### Requirement: Accessible controls
Every control SHALL have a visible label, error messages SHALL be text (not colour alone) and be associated with their field, and the tab SHALL be fully operable by keyboard.

#### Scenario: Keyboard
- **WHEN** the user tabs through the tab
- **THEN** every control and the adopt dialog buttons receive focus in reading order
