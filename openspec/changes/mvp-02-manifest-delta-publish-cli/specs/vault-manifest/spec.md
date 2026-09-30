## Purpose

Defines the manifest that describes a published vault snapshot and the change detection that decides which files must transfer, so publish cost is proportional to what changed.

## ADDED Requirements

### Requirement: Manifest v1 schema
Each publish SHALL produce a manifest with exactly these top-level fields: `version` (the number 1), `rootCID` (the CID of the `current/` vault tree, read before the manifest is written), `publishedAt` (UTC ISO-8601), `device`, `files` and `excludesHash`. `files` SHALL map each vault-relative path to `{sha256, size, cid}`, where `sha256` is the lowercase hex digest of the file bytes and `size` is in bytes. Paths under an exclusion SHALL be absent from `files`.

#### Scenario: Manifest content
- **WHEN** a vault with `notes/hello.md` and `attachment.pdf` is published
- **THEN** the manifest lists both paths with sha256, size and cid, `version` is 1, and no excluded path appears

#### Scenario: Deterministic serialisation
- **WHEN** the same vault state is published twice with the same `publishedAt` and `device`
- **THEN** the two manifests are byte-identical

### Requirement: Manifest placement
The latest manifest SHALL be stored at `<mfsRoot>/manifest.json`, a sibling of `current/`, and every manifest SHALL also be kept at `<mfsRoot>/manifests/<currentCID>.json`, where `currentCID` is the manifest's `rootCID`. The manifest SHALL NOT be stored inside `current/`, so it never describes itself. Files under `manifests/` SHALL NOT be overwritten by later publishes.

#### Scenario: Reader finds the manifest from the published root
- **WHEN** a reader resolves the publication key to a root and fetches `<root>/manifest.json`
- **THEN** it obtains the latest manifest, whose `rootCID` equals the CID of `<root>/current`

#### Scenario: History kept
- **WHEN** two publishes with different content succeed
- **THEN** `manifests/` holds one file per `currentCID` and `manifest.json` equals the newer one

### Requirement: Exclusion hash
`excludesHash` SHALL be the lowercase hex sha256 of the effective exclusion list, sorted and serialised in one documented exact form, so any change to the list changes the hash.

#### Scenario: Order independence
- **WHEN** the same exclusion entries are supplied in a different order
- **THEN** `excludesHash` is unchanged

#### Scenario: List change
- **WHEN** one entry is added to the exclusion list
- **THEN** `excludesHash` differs from the previous value

### Requirement: sha256 change detection
Change detection SHALL hash file contents so it runs unchanged in Node 24 and the Obsidian WebView. Files of 32 MB or less SHALL be hashed with WebCrypto. Files larger than 32 MB SHALL be hashed incrementally in 8 MB chunks, so the whole file is never held in memory, and the digest SHALL equal the digest of the same bytes computed in one pass. A file whose size and modification time equal the last-published record MAY be treated as unchanged without hashing. A file SHALL transfer only when it is absent from the last-published manifest or its sha256 differs.

#### Scenario: Large file hashed in chunks
- **WHEN** a 40 MB file is hashed
- **THEN** its sha256 equals the one-pass digest of the same bytes and no read larger than 8 MB is issued

#### Scenario: Untouched vault
- **WHEN** a vault is published twice with no file changes
- **THEN** the second run reports `0 written, 0 removed` and sends no `files/write` request

#### Scenario: Touched but identical
- **WHEN** a file's modification time changes but its content does not
- **THEN** the file is hashed, found equal, and not transferred

#### Scenario: Edited file
- **WHEN** one file's content changes
- **THEN** only that file transfers and its new sha256 appears in the new manifest

### Requirement: Last-published state
The CLI SHALL keep a local record of the last published manifest per vault, used for change detection and to identify remote paths that must be removed. The record SHALL live under the `.ipfs-sync/` folder of the vault, which is excluded from sync, and SHALL contain no credentials.

#### Scenario: First publish
- **WHEN** no last-published record exists
- **THEN** every non-excluded file is treated as new and no removals are issued

#### Scenario: Record survives restart
- **WHEN** the CLI process exits after a publish and is run again
- **THEN** the second run detects changes against the record from the first
