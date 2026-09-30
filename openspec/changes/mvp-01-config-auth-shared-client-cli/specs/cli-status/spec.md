## Purpose

Defines the `ipfs-sync status` command, which shows that a configured node is reachable, writable in the project's own MFS area and readable through the gateway.

## ADDED Requirements

### Requirement: Status report
`ipfs-sync status` SHALL print the node peer ID and version, the entries under the MFS root, a gateway fetch result, and the result of a write probe (`files/write` then `files/stat` then `files/rm`) under `<mfsRoot>/.probe/`. Output SHALL use standard output and standard error streams and SHALL NOT use `console.log`.

#### Scenario: Healthy node
- **WHEN** all endpoints are reachable and writable
- **THEN** the output lists peer ID, MFS entries, `gateway fetch OK` and `probe OK`, and the exit code is 0

#### Scenario: Authentication failure
- **WHEN** an endpoint rejects the credentials
- **THEN** the output names the endpoint and states the credentials were rejected, and the exit code is nonzero

#### Scenario: Unsafe configuration
- **WHEN** `--mfs-root /obsidian-vault-staging` or `--key consult-capture` is passed
- **THEN** the command exits nonzero before any network request is sent

### Requirement: Key state reporting
`status` SHALL report the publication key state (`absent`, `owned` or `foreign`) using key listing only. It SHALL NOT create, rename or remove keys.

#### Scenario: Absent key
- **WHEN** no key with the configured name exists
- **THEN** status reports `absent` and creates nothing

### Requirement: Request transparency
`status --show-request` SHALL print each request's method, URL and header names with credential values redacted.

#### Scenario: Header construction per scheme
- **WHEN** run once each with basic, bearer and header schemes
- **THEN** the printed requests show `Authorization` or the custom header name with `<redacted>` values
