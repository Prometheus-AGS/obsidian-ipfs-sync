## Purpose

Defines `ipfs-sync pull <vault>`, which brings a local vault to the state described by a published manifest by transferring only what differs, without changing anything on the node.

## ADDED Requirements

### Requirement: Pull command
`ipfs-sync pull <vault>` SHALL make the vault directory named by its single argument match the published manifest. It SHALL accept the same endpoint, auth, `--mfs-root`, `--key`, `--owned-key` and `--config` flags as `status` and `publish`, with the same precedence. Output SHALL go only through the process output and error streams and SHALL end with a one-line summary giving counts of fetched, unchanged, conflicted, failed and remote-deleted files.

#### Scenario: Missing argument
- **WHEN** the vault argument is absent
- **THEN** the command exits with a usage error before any request

#### Scenario: Summary line
- **WHEN** a pull fetches 2 files, keeps 5 unchanged, and finds no conflicts
- **THEN** the output includes a summary containing `2 fetched`, `5 unchanged`, `0 conflicts`, and the exit code is 0

### Requirement: Resolution through the publication name
The pull target SHALL be an IPNS name. `--name <id>` selects it. Without `--name`, pull SHALL use the ID of the publication key configured by `--key`, but only if that key is on the node and its ID is recorded as owned; otherwise pull SHALL fail and ask for `--name`. Pull SHALL resolve the name to the root CID of the MFS root layout (`current/`, `manifest.json`, `manifests/`).

#### Scenario: Explicit name
- **WHEN** `--name k51...` is passed
- **THEN** that name is resolved and no key lookup is needed

#### Scenario: Default from owned key
- **WHEN** no `--name` is passed and the owned key `obsidian-vault-sync` exists
- **THEN** its ID is resolved

#### Scenario: Unowned default
- **WHEN** no `--name` is passed and the configured key is absent or not recorded as owned
- **THEN** pull exits nonzero before fetching anything and tells the operator to pass `--name`

### Requirement: Manifest selection
By default pull SHALL read `<root>/manifest.json` through the gateway endpoint. `--manifest <currentCID>` SHALL instead read `<root>/manifests/<currentCID>.json`, restoring that point in time. `--manifest-file <path>` SHALL read the manifest from a local file. The three selectors SHALL be mutually exclusive. Files SHALL be fetched from the tree named by the selected manifest's `rootCID`, which for the latest manifest is `<root>/current`.

#### Scenario: Historical restore
- **WHEN** `--manifest` names an earlier `currentCID` still present under `manifests/`
- **THEN** the destination ends with that manifest's file contents, fetched from that earlier tree

#### Scenario: Unknown historical manifest
- **WHEN** `--manifest` names a CID with no file under `manifests/`
- **THEN** pull exits nonzero before writing anything

#### Scenario: Conflicting selectors
- **WHEN** both `--manifest` and `--manifest-file` are given
- **THEN** the command exits with a usage error

### Requirement: Delta transfer through a bounded pool
Pull SHALL compare local files with the manifest by sha256 and SHALL fetch only files that are missing or differ, through the gateway with between 4 and 6 concurrent fetches. Each file SHALL be streamed to disk without buffering the whole vault; files above 32 MB SHALL be read in ranged reads of at most 8 MB. Files whose size and modification time match the local record MAY be treated as unchanged without hashing.

#### Scenario: Only changes transfer
- **WHEN** one file of a synced vault changed remotely and pull runs
- **THEN** exactly one file is fetched and every other file is neither fetched nor rewritten

#### Scenario: Untouched files not rewritten
- **WHEN** pull runs on an already synced vault
- **THEN** the modification times of all files are unchanged and the summary shows `0 fetched`

#### Scenario: Large file
- **WHEN** a 40 MB file is fetched
- **THEN** it is requested in ranges of at most 8 MB and the resulting file has the manifest sha256

#### Scenario: Concurrency bound
- **WHEN** 100 files are missing
- **THEN** never more than 6 fetches are in flight

### Requirement: Read-only against the node
Pull SHALL NOT perform any node mutation. It SHALL use only name resolution, gateway reads and, when needed, key listing. It SHALL NOT call `files/write`, `files/rm`, `pin/add`, `pin/rm`, `key/gen`, `key/rm` or `name/publish`.

#### Scenario: Request audit
- **WHEN** a pull runs against a recording node
- **THEN** every recorded request is a name resolve, a gateway GET, or a key list

### Requirement: Plaintext guard before encryption
While the build has no encryption, pull SHALL write only into a destination that is either absent or empty, or that contains the `.ipfs-sync-fixture` marker. A non-empty destination without the marker SHALL be refused before any request. When pull populates an absent or empty destination it SHALL create the marker there, so later pulls and publishes of that fixture copy are allowed.

#### Scenario: Real vault refused
- **WHEN** the destination has files and no marker
- **THEN** pull exits nonzero before any request, stating that encryption is not yet available

#### Scenario: Fresh copy
- **WHEN** the destination does not exist
- **THEN** it is created, populated, and contains the marker afterwards

### Requirement: Additive core changes only
If this change extends shared core contracts (host capability members, event types), the extension SHALL be additive: existing members, event names and payloads defined by the publish feature SHALL keep their meaning and shape, and publish SHALL behave as before.

#### Scenario: Publish unaffected
- **WHEN** the publish tests of the previous change are run after this change
- **THEN** they pass without modification

### Requirement: Failure exit status
A pull SHALL exit 0 only if every file that had to be fetched was written and verified. Any failed file SHALL cause a nonzero exit after the remaining files have been processed and the counts reported.

#### Scenario: One file fails
- **WHEN** one of ten files fails to fetch
- **THEN** the other nine are written, the summary shows `1 failed`, and the exit code is 1
