## Purpose

Defines how the E2E sync fixture confines itself on the shared kubo node: the per-run MFS root, the suite-owned publication key, the loopback proxy allowlist, the per-device state isolation, the preflight refusals, the cleanup semantics, and how the suite is wired into (and kept out of) the project's test commands.

## ADDED Requirements

### Requirement: Per-run MFS root and suite-owned publication key
Each suite run SHALL compute a fresh run identifier matching `/^[a-z0-9-]{8,}$/` and use `/obsidian-vault-sync/e2e-<runId>` as the run root, and SHALL use the publication key `obsidian-vault-e2e` (which matches the publication-key name rule `^obsidian-vault(-[a-z0-9-]+)?$`). The suite SHALL create the key with `key/gen` only when it is absent on the node; when the key is present, the suite SHALL require its key ID to be recorded as owned in the per-machine configuration or supplied explicitly, and SHALL refuse otherwise. The suite SHALL never remove, rename, import or export any key.

#### Scenario: Fresh node creates the suite key
- **WHEN** the suite starts against a node where `obsidian-vault-e2e` is absent
- **THEN** exactly one `key/gen` for `obsidian-vault-e2e` is sent, and no other key operation

#### Scenario: Foreign-looking key refused
- **WHEN** `obsidian-vault-e2e` exists on the node but its key ID is neither in the owned-keys configuration nor supplied explicitly
- **THEN** the suite refuses before the first mutation, naming the key and the adoption rule

#### Scenario: A key removal is never sent
- **WHEN** any suite run completes, fails or is interrupted
- **THEN** the proxy log holds no `key/rm`, `key/rename`, `key/import` or `key/export` request

### Requirement: Loopback proxy confinement
Every CLI child SHALL be configured so its RPC and gateway endpoints are the suite's loopback forwarding proxy. The proxy SHALL forward only: `files/write`, `files/mkdir`, `files/rm`, `files/stat` and `files/ls` with path arguments at or below the run root; `key/gen` of `obsidian-vault-e2e`; `key/list`; `name/resolve`; `name/publish` with `key=obsidian-vault-e2e` of a CID the node reported under the run root; `pin/add`; reads of `/ipfs/<cid>`; and gateway GET/HEAD. The proxy SHALL refuse and record (without forwarding) every other request, including any path outside the run root, any path naming `/obsidian-vault-staging`, a sibling run's `e2e-<other>` root, and any request naming another key (including `obsidian-vault-sync`).

#### Scenario: Refusal matrix
- **WHEN** a request asks for `key/rm`, `pin/rm`, `files/mv`, `files/cp`, a write outside the run root, a write under `/obsidian-vault-staging`, a write under another run's root, or a `key/gen`/`name/publish` naming a different key
- **THEN** the proxy refuses it, records the violation and does not forward it

#### Scenario: Self-test against a dead upstream
- **WHEN** the suite starts
- **THEN** it proves, against a second proxy whose upstream is a dead loopback address, that refused requests are not forwarded

### Requirement: Per-device state isolation
Every simulated device SHALL get its own vault directory, its own config file and its own per-user state directory, with `XDG_STATE_HOME` and `HOME` set to absolute paths inside the per-run temporary directory outside the repository; the runner SHALL refuse a child whose state directory is missing, relative or inside the repository. Child environments SHALL be limited to the allowlist (`PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, plus the `IPFS_SYNC_*` auth variables on the shared-node path only). The operator's real state directory (device id, sequence floor, history database) SHALL NOT be read or written.

#### Scenario: History lands in the per-run state
- **WHEN** a publish or pull child exits
- **THEN** the device's history database exists under `<per-run state>/ipfs-sync/history` and no file under the operator's real state directory was touched

#### Scenario: Hostile environment stripped
- **WHEN** the parent environment carries `IPFS_SYNC_*` variables pointing at a different node or root
- **THEN** the child's effective RPC URL, gateway URL, MFS root and key are still the loopback proxy, the run root and `obsidian-vault-e2e` (verified from the exact argv and environment before spawn)

### Requirement: Preflight refusals fail fast
Before the first scenario the suite SHALL refuse, with a named reason and a nonzero exit, when: the running Node does not satisfy `engines.node` (`>= 24.15.0` — the refusal names the PATH fix); the built CLI is missing or older than its sources (the suite never builds); or the node does not answer a bounded read-only probe. An unreachable or misconfigured node SHALL fail the suite loudly; the suite SHALL NOT skip its scenarios for that reason.

#### Scenario: Wrong Node version
- **WHEN** the suite runs under a Node older than `engines.node`
- **THEN** it refuses before opening any socket, printing the required version and the PATH fix

#### Scenario: Node unreachable
- **WHEN** the read-only probe cannot reach the configured node
- **THEN** the suite exits nonzero naming the node address and the error, and reports zero scenarios as passed

#### Scenario: Stale build
- **WHEN** `dist/cli/ipfs-sync.mjs` is older than `cli/` or `src/`
- **THEN** the suite refuses and asks for a fresh `pnpm build`

### Requirement: Cleanup of exactly the run root, on every outcome
The suite SHALL remove the run root with `files/rm -r` (stat, remove, confirm) as the last ordered scenario step on the success path, SHALL attempt the same removal from a failure-path hook whatever the scenario outcome (idempotent when already removed), and SHALL attempt a bounded best-effort removal on SIGINT/SIGTERM/SIGHUP before exiting. A cleanup failure SHALL fail the suite and name the root. The suite SHALL NOT remove any path other than its own run root — enforced by the proxy policy, not by convention.

#### Scenario: Cleanup after a failed scenario
- **WHEN** a scenario fails mid-run
- **THEN** the failure-path hook removes the run root and the suite reports both the scenario failure and the cleanup result

#### Scenario: Signal interruption
- **WHEN** the run receives SIGINT, SIGTERM or SIGHUP
- **THEN** a bounded best-effort removal of the run root runs before the process exits with the signal's conventional exit code

### Requirement: No-leftovers gate
After removing its run root, the suite SHALL list `/obsidian-vault-sync` and assert it holds no `e2e-` prefixed entry. A stale `e2e-<other>` root from a previously crashed run SHALL fail this gate loudly and print the exact operator removal command for that specific root; the suite SHALL NOT remove another run's root itself.

#### Scenario: Clean run leaves nothing
- **WHEN** a run completes and its cleanup succeeded
- **THEN** the listing of `/obsidian-vault-sync` shows no `e2e-` entries

#### Scenario: Stale root surfaces
- **WHEN** a previous crashed run left `/obsidian-vault-sync/e2e-<staleId>`
- **THEN** the gate fails, names the stale root and prints `files/rm -r /obsidian-vault-sync/e2e-<staleId>` as the operator's removal step

### Requirement: Suite wiring — explicit opt-in, excluded from the default gate
The package SHALL expose `pnpm test:e2e` running the suite via `tests/e2e/vitest.config.ts`. Suite spec files SHALL use the `.e2e.ts` suffix so the default `pnpm test` (include pattern `tests/**/*.test.ts`) never discovers them, and the default gate SHALL remain fully offline.

#### Scenario: Default gate untouched
- **WHEN** `pnpm test` runs
- **THEN** its collected file set contains no `tests/e2e/` path and no request is sent to any node

#### Scenario: Explicit command runs the suite
- **WHEN** `pnpm test:e2e` runs under a supported Node with a fresh build and a reachable node
- **THEN** the suite executes every scenario in order and exits 0 only when all pass and cleanup succeeded
