## Purpose

Defines how operators configure where sync talks to (RPC and gateway endpoints), how it authenticates, which IPNS key and MFS root it uses, and the rules that keep it from touching anything on the shared node it does not own.

## ADDED Requirements

### Requirement: Separate RPC and gateway endpoints
The configuration SHALL hold an RPC endpoint (writes) and a gateway endpoint (reads) as independent settings, each with a URL and an optional port. The two SHALL NOT be required to share host, port or scheme.

#### Scenario: Different hosts and ports
- **WHEN** RPC is `https://rpc.example.org` port 5001 and gateway is `https://gw.example.org` port 8080
- **THEN** RPC requests go to `https://rpc.example.org:5001` and gateway requests go to `https://gw.example.org:8080`

#### Scenario: Conflicting port
- **WHEN** an endpoint URL already carries a port that differs from its separate port setting
- **THEN** configuration loading fails with an error naming the endpoint and both values

#### Scenario: Invalid URL
- **WHEN** an endpoint URL is not http or https
- **THEN** configuration loading fails before any request is made

### Requirement: Pluggable authentication
The configuration SHALL support the schemes `none`, `basic` (user, password), `bearer` (static token or JWT) and `header` (custom name and value). The chosen scheme SHALL apply to both endpoints unless an endpoint overrides it. Secret values SHALL come from flags or `IPFS_SYNC_AUTH_*` environment variables in the CLI and SHALL NOT be written to logs, manifests or the CLI config file.

#### Scenario: Bearer JWT expired
- **WHEN** the bearer token is a JWT whose `exp` claim is in the past
- **THEN** the configuration reports a warning naming the expiry time and continues

#### Scenario: Secret redaction
- **WHEN** a request description is printed with `--show-request`
- **THEN** credential values appear as `<redacted>` and header names remain visible

### Requirement: MFS root confinement
The MFS root SHALL equal `/obsidian-vault-sync` or be a path under `/obsidian-vault-sync/`. Any other value SHALL be rejected before a request is sent, including values containing `..` segments or a trailing-slash bypass.

#### Scenario: Foreign path rejected
- **WHEN** the MFS root is `/obsidian-vault-staging`
- **THEN** configuration loading fails and no request is sent

#### Scenario: Traversal rejected
- **WHEN** the MFS root is `/obsidian-vault-sync/../other`
- **THEN** configuration loading fails

### Requirement: Publication key ownership
The publication key name SHALL match `^obsidian-vault(-[a-z0-9-]+)?$`. A key SHALL be classified `absent`, `owned` (its ID is recorded as created or adopted by this installation) or `foreign` (a name match with a different ID, or an ID not recorded). Only an `owned` key MAY be used for name publishing.

#### Scenario: Existing project key names refused
- **WHEN** the publication key is `consult-capture`, `gomark-relay-lab` or `prince-live`
- **THEN** configuration loading fails

#### Scenario: Foreign key with a matching name
- **WHEN** the node has a key named `obsidian-vault` whose ID is not in the recorded set
- **THEN** it is classified `foreign` and name publishing is refused

### Requirement: Plaintext publish guard before encryption
While the build has no encryption, publishing SHALL be refused unless the vault root contains the fixture marker file `.ipfs-sync-fixture`.

#### Scenario: Real vault refused
- **WHEN** a publish is requested for a vault root without the marker file
- **THEN** the publish fails before any node request with a message that encryption is not yet available
