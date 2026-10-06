## Purpose

Defines the `ipfs-sync history [--limit n]` command: a device-local, read-only listing of recorded sync operations that answers "what did this device sync, and when" after restarts.

## ADDED Requirements

### Requirement: history lists recorded operations newest-first
`ipfs-sync history` SHALL print one line per recorded operation, newest first, each line carrying the timestamp, the operation kind, the root CID, the per-kind counts and the duration. `--limit n` SHALL cap the listing at n records (default 20); `--limit 0` SHALL list all records.

#### Scenario: Newest first with limit
- **WHEN** the store holds a publish then a pull and the operator runs `ipfs-sync history --limit 1`
- **THEN** exactly one line is printed and it is the pull

### Requirement: history survives a CLI restart
The listing SHALL come from the on-disk database, so a new CLI process lists operations recorded by earlier processes.

#### Scenario: Restart listing
- **WHEN** a publish and a pull are recorded, every CLI process exits, and a fresh process runs `ipfs-sync history`
- **THEN** both operations are listed

### Requirement: history is local and read-only
The command SHALL open the database read-only, SHALL send no node or gateway requests, and SHALL need no configuration, passphrase or vault argument.

#### Scenario: No requests
- **WHEN** `ipfs-sync history --show-request` runs
- **THEN** the request trace is empty

#### Scenario: No configuration
- **WHEN** no sync configuration file exists
- **THEN** `ipfs-sync history` still lists previously recorded operations

### Requirement: Output and exit codes
All output SHALL go to standard output through `CliIo` (never `console.log`). An empty database SHALL print `no sync operations recorded on this device` and exit 0. An invalid `--limit` SHALL exit 2 with a usage error.

#### Scenario: Empty database
- **WHEN** no operation has been recorded
- **THEN** the command prints the empty line and exits 0

#### Scenario: Bad limit
- **WHEN** the operator runs `ipfs-sync history --limit abc`
- **THEN** the command exits 2 and lists nothing

### Requirement: history is distinct from prune-history
The command's help text SHALL state that `history` reads the device-local operation log and mutates nothing, while `prune-history` prunes node-side manifest history on the shared node.

#### Scenario: Help distinguishes the commands
- **WHEN** the operator runs `ipfs-sync history --help`
- **THEN** the text names the distinction from `prune-history`

### Requirement: Listing contains no vault paths
The printed output SHALL NOT contain vault paths or file names, because the stored records carry none.

#### Scenario: Output inspection
- **WHEN** a publish and a conflicted pull of a fixture vault are recorded and listed
- **THEN** the output contains the root CIDs and counts and no fixture vault path or note name
