## Purpose

Defines how `ipfs-sync publish <vault>` sends only changed files to the shared kubo node, updates the published snapshot and IPNS pointer, and stays inside the project's own node namespace.

## ADDED Requirements

### Requirement: Default MFS root
The default MFS root SHALL be `/obsidian-vault-sync/default`, so the published tree contains only this project's vault content and none of the other folders under `/obsidian-vault-sync`. The confinement rule is unchanged: a configured root MUST equal `/obsidian-vault-sync` or sit under it.

#### Scenario: Default root
- **WHEN** publish runs with no root setting
- **THEN** it writes under `/obsidian-vault-sync/default/current/`

#### Scenario: Confinement unchanged
- **WHEN** `--mfs-root /obsidian-vault-staging` is passed
- **THEN** the command exits nonzero before any request

### Requirement: Publish command
`ipfs-sync publish <vault>` SHALL publish the vault directory named by its single argument. It SHALL accept the same endpoint, auth, `--mfs-root`, `--key`, `--owned-key` and `--config` flags as `status`, and the same precedence (flags, environment, config file, defaults). It SHALL write output only through the process output and error streams and SHALL end with a one-line summary of the form `N written, M removed`.

#### Scenario: Missing vault
- **WHEN** the vault argument is absent or is not a directory
- **THEN** the command exits nonzero with a usage error before any request

#### Scenario: Summary line
- **WHEN** a publish writes 3 files and removes 1
- **THEN** the output includes `3 written, 1 removed` and the new root CID and exits 0

### Requirement: Fixture-only publishing before encryption
Publish SHALL call the fixture guard before any network request, and SHALL refuse a vault whose root lacks the `.ipfs-sync-fixture` marker.

#### Scenario: Directory without marker
- **WHEN** publish is run on a directory with no `.ipfs-sync-fixture` file
- **THEN** it exits nonzero with a message that encryption is not yet available, and the process has sent no HTTP request

### Requirement: Node-safety on every mutation
Every mutating call in a publish (`files/write`, `files/rm`, `pin/add`, `key/gen`, `name/publish`) SHALL be gated by the mvp-01 validators before it is sent: MFS paths under `/obsidian-vault-sync/`, key names matching the project pattern, and `name/publish` only for an owned key. The publish SHALL NOT call `key/rm`, `key/rename`, `pin/rm` or any `files/rm` outside its own MFS root, and SHALL NOT touch `/obsidian-vault-staging` or the keys `consult-capture`, `gomark-relay-lab` and `prince-live`.

#### Scenario: Unsafe root
- **WHEN** `--mfs-root /obsidian-vault-staging` is passed
- **THEN** the command exits nonzero before any request

#### Scenario: Removal confined
- **WHEN** a deletion is computed for a path that resolves outside `<mfsRoot>/current/`
- **THEN** the removal is refused and the publish fails without sending `name/publish`

### Requirement: Delta transfer through a bounded pool
Publish SHALL write only new or changed files, into `<mfsRoot>/current/<vault-relative path>`, with between 4 and 6 concurrent writes. Every write SHALL go through the shared client's `files/write` wrapper (multipart field `data`, arguments in the query string).

#### Scenario: One edited file
- **WHEN** one file of an already published vault is edited and publish runs again
- **THEN** exactly one `files/write` is sent and the summary reads `1 written, 0 removed`

#### Scenario: Concurrency bound
- **WHEN** 100 files are new
- **THEN** never more than 6 writes are in flight at once and at least 4 are in flight while work remains

### Requirement: Large-file chunking
A file larger than 32 MB SHALL be written in 8 MB chunks using the `offset` argument, without holding the whole file in memory. Files up to 32 MB SHALL be written in one request.

#### Scenario: 40 MB file
- **WHEN** a 40 MB file is published
- **THEN** it is sent as 5 chunks of at most 8 MB with increasing offsets and the resulting remote size is 40 MB

### Requirement: Write verification
After each file is written, publish SHALL confirm the remote size with `files/stat`. A mismatch SHALL fail the publish for that file, and `name/publish` SHALL NOT run while any file is unverified.

#### Scenario: Short write
- **WHEN** `files/stat` reports a size different from the local size
- **THEN** the publish exits nonzero, names the file, and does not update the IPNS pointer

### Requirement: Deletions
Files present in the last published manifest but absent locally (or newly excluded) SHALL be removed from `<mfsRoot>/current/` with `files/rm`, after the writes complete.

#### Scenario: Deleted note
- **WHEN** a previously published file is deleted from the vault
- **THEN** the next publish removes it remotely and the summary counts it under `removed`

### Requirement: Snapshot, manifest and IPNS pointer
After writes and removals, publish SHALL read the CID of `<mfsRoot>/current` with `files/stat`, build the manifest with that CID as its `rootCID`, write it to `<mfsRoot>/manifest.json` and to `<mfsRoot>/manifests/<currentCID>.json`, read the CID of `<mfsRoot>` with `files/stat`, pin that CID, and only then publish it to the configured key with a five-minute TTL. The IPNS value SHALL be the CID of `<mfsRoot>` itself. Earlier manifests SHALL be left in place.

#### Scenario: Resolvable result
- **WHEN** a publish succeeds
- **THEN** resolving the publication key returns the CID of `<mfsRoot>`, `<root>/manifest.json` fetched through the gateway lists every published file, and `<root>/current/<path>` holds each file

#### Scenario: Nothing changed
- **WHEN** a publish finds no changes
- **THEN** it reports `0 written, 0 removed` and does not create a new manifest or publish a new IPNS record

### Requirement: Failure leaves the pointer untouched
If any write, verification, removal, pin or manifest step fails, publish SHALL exit nonzero and SHALL NOT publish a new IPNS record. The last-published record on disk SHALL NOT be advanced.

#### Scenario: Interrupted publish
- **WHEN** the node rejects a write midway
- **THEN** the IPNS record still points at the previous root and rerunning publish completes the remaining transfer
