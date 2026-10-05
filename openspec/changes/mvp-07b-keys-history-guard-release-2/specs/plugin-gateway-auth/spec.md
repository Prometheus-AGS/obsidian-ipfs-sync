## Purpose

Gives the plugin a way to authenticate to the gateway separately from the node. Since commit 1e65784 the gateway inherits the node credential only when its origin equals the RPC origin (`inheritedAuth` in `src/core/config/build-config.ts`). The plugin has one auth block, applied to both endpoints, and no gateway field. A plugin user whose RPC is on `:5001` and gateway on `:8080` behind one reverse proxy now sends the gateway no credential, gets 401, and has no field to fix it. The CLI can set `IPFS_SYNC_GATEWAY_AUTH_*`. This delta closes the gap in the plugin. Operator decision 2026-10-05.

The uncomfortable part: the safe default makes this setup fail until the operator acts. That is correct, because sending the node credential to a different origin is the leak the 1e65784 change closed. The plugin must explain the 401, not hide it.

## MODIFIED Requirements

### Requirement: Authentication settings
The tab SHALL offer, for the node, the schemes none, basic (user, password), bearer (static token or JWT) and custom header (name, value), showing only the fields of the selected scheme. Secret fields SHALL be masked. The node scheme SHALL apply to the RPC endpoint, and to the gateway endpoint only as the requirement "Gateway authentication" below defines. Labels SHALL be in sentence case. The tab SHALL add no default hotkey.

#### Scenario: Scheme switch
- **WHEN** the user switches from bearer to basic
- **THEN** the token field is replaced by user and password fields

#### Scenario: Expired JWT
- **WHEN** a bearer token is a JWT whose expiry is in the past
- **THEN** the tab shows a warning naming the expiry time and still allows saving

## ADDED Requirements

### Requirement: Gateway authentication
The plugin settings SHALL gain a gateway authentication block with the same kinds as the node block (none, basic, bearer, custom header) plus a default choice, "Same as node". "Same as node" SHALL mean: the gateway inherits the node credential only when the gateway origin (scheme, host, port) equals the RPC origin, and otherwise sends no credential. An explicit gateway block (any kind, including none) SHALL always win over inheritance. A credential entered in the gateway block SHALL be sent to the gateway endpoint only and SHALL NOT be sent to the RPC endpoint. The plugin SHALL pass the gateway block to the same configuration builder the CLI uses as the gateway endpoint's own auth, so the plugin and the CLI resolve identically and no second rule is written in the plugin.

#### Scenario: Same origin
- **GIVEN** the RPC URL and the gateway URL share one origin and the gateway block is "Same as node"
- **WHEN** the plugin resolves its configuration
- **THEN** the gateway request carries the node credential

#### Scenario: Different origin, no gateway auth
- **GIVEN** the RPC origin is `https://node.example:5001`, the gateway origin is `https://node.example:8080`, the node has a bearer token and the gateway block is "Same as node"
- **WHEN** the plugin makes a gateway request
- **THEN** the request carries no credential, the node token appears in no gateway request, and a 401 from the gateway is reported with the plain-language explanation that the node credential is not sent to a gateway on a different origin and that a gateway credential can be set in the settings, without containing any secret value

#### Scenario: Different origin, gateway auth set
- **GIVEN** the origins differ and the gateway block is bearer with token G
- **WHEN** the plugin makes requests
- **THEN** gateway requests carry G and no other credential, and RPC requests carry the node credential and never G

#### Scenario: Explicit none wins
- **GIVEN** the origins match, the node has a credential and the gateway block is explicitly none
- **WHEN** the plugin makes a gateway request
- **THEN** the request carries no credential

### Requirement: Gateway credential storage
The gateway credential SHALL be stored in the same place as the node credential: the plugin's data file (`.obsidian/plugins/ipfs-sync/data.json`, the `auth` field of `PluginSettings` in `src/plugin/settings-model.ts` today), as plain text. The plugin has no OS keychain or secret-storage integration in the repository, so none is claimed. The existing secrets warning SHALL cover the gateway fields and SHALL stay visible near them. The data file SHALL stay excluded from sync. Gateway secrets SHALL NOT appear in logs, notices, error messages, the status display or any stored summary.

#### Scenario: Data file never published
- **WHEN** a vault whose data file holds a gateway token is published
- **THEN** the data file is absent from the manifest and no request body contains the token

#### Scenario: Error text
- **WHEN** the gateway rejects the credential
- **THEN** the message names the gateway endpoint and does not contain the token, password or header value

### Requirement: Origin difference notice
When the gateway origin differs from the RPC origin and a node credential is set, the settings tab SHALL show a plain-language line near the gateway fields saying that the node credential is NOT sent to the gateway, and, when the gateway block is "Same as node", that the gateway will be called without a credential until one is set here. The line SHALL disappear when the origins match, when no node credential is set, or when an explicit gateway block is set. It SHALL be text, not colour alone, and SHALL be reachable by keyboard and screen reader like the other tab text. Any dialog that confirms a consequence of this setting (for example clearing a stored gateway credential) SHALL focus Cancel first, per `docs/design/README.md`.

#### Scenario: Notice shown
- **GIVEN** a node credential is set and the gateway origin differs from the RPC origin
- **WHEN** the tab is opened with the gateway block on "Same as node"
- **THEN** the line states that the node credential is not sent to the gateway and no gateway credential is set

#### Scenario: Notice hidden
- **WHEN** the origins match, or the gateway block is explicit
- **THEN** the line is not shown

#### Scenario: Clearing confirmation
- **WHEN** the user clears a stored gateway credential and a confirmation dialog opens
- **THEN** focus is on Cancel

### Requirement: Existing settings migrate to "Same as node"
Stored settings written before this change have no gateway block. They SHALL load as "Same as node", with no prompt and no data loss. The resulting behaviour SHALL equal the behaviour after 1e65784 (inherit on matching origin, none otherwise). Migration SHALL NOT copy the node credential into the gateway block. Whether `SETTINGS_VERSION` (3, in `src/plugin/settings-model.ts`) bumps is the implementer's decision; either way a stored file without the block loads and a file with the block round-trips.

#### Scenario: Old data, same origin
- **GIVEN** stored settings with no gateway block and matching origins
- **WHEN** the plugin loads
- **THEN** the gateway block is "Same as node" and the gateway request carries the node credential

#### Scenario: Old data, different origin
- **GIVEN** stored settings with no gateway block and different origins
- **WHEN** the plugin loads
- **THEN** the gateway block is "Same as node", the gateway request carries no credential, and the origin notice is shown with a node credential set

#### Scenario: Round trip
- **WHEN** a gateway block is saved and the plugin reloads
- **THEN** the block is unchanged and the node block is unchanged
