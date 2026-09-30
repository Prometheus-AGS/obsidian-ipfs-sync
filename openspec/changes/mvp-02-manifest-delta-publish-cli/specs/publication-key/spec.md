## Purpose

Defines which IPNS key publish uses, how a project-owned key comes into existence, and how keys owned by other projects on the shared node are protected.

## ADDED Requirements

### Requirement: Default publication key
The default publication key name SHALL be `obsidian-vault-sync`. The name SHALL satisfy the key-name pattern `^obsidian-vault(-[a-z0-9-]+)?$`. The previous default `obsidian-vault` SHALL no longer be a default.

#### Scenario: Default without configuration
- **WHEN** publish runs with no key setting
- **THEN** it targets the key named `obsidian-vault-sync`

### Requirement: Create only when absent
When the configured key is absent on the node, publish SHALL create it with `key/gen`, record the returned ID in the CLI config `ownedKeys`, and then use it. When the key is present, publish SHALL NOT call `key/gen`.

#### Scenario: First publish on a fresh node
- **WHEN** no key named `obsidian-vault-sync` exists
- **THEN** exactly one key is generated, its ID is written to `ownedKeys`, and `name/publish` uses it

#### Scenario: Key already owned
- **WHEN** the key exists and its ID is in `ownedKeys`
- **THEN** no key is generated and publish proceeds

#### Scenario: Config file cannot be updated
- **WHEN** the key was generated but the config file cannot be written
- **THEN** publish stops before `name/publish`, prints the generated key ID and the exact `--owned-key` value to use, and exits nonzero

### Requirement: Foreign keys refused
A key whose name matches but whose ID is not in `ownedKeys` SHALL be classified foreign, and `name/publish` SHALL NOT be sent for it. The existing node key `obsidian-vault` SHALL be treated as foreign. The operator MAY adopt a specific key by passing `--owned-key <id>`, which SHALL only mark that exact ID as owned for the run.

#### Scenario: Existing obsidian-vault key
- **WHEN** the configuration sets `--key obsidian-vault` and the node's `obsidian-vault` key ID is not recorded
- **THEN** publish exits nonzero before any `name/publish` and names the key as foreign

#### Scenario: Explicit adoption
- **WHEN** the operator passes `--owned-key` with the exact ID of that key
- **THEN** the key is classified owned and publish may proceed

#### Scenario: Other projects' keys
- **WHEN** the key is `consult-capture`, `gomark-relay-lab` or `prince-live`
- **THEN** configuration loading fails before any request

### Requirement: No key removal
The implementation SHALL NOT call `key/rm`, `key/rename` or `key/rotate`.

#### Scenario: Client surface
- **WHEN** the kubo client interface is inspected
- **THEN** it exposes `key/gen` but no operation that removes, renames or rotates keys
