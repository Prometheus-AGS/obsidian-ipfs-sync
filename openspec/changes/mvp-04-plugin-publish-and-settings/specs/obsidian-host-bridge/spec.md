## Purpose

Defines the Obsidian implementation of the host capabilities the shared publish engine needs, and the limits that keep it safe on mobile.

## ADDED Requirements

### Requirement: File-system capability over the vault
The plugin SHALL implement the host file-system capabilities (list, stat, read, ranged read, write, mkdir, remove) using only Obsidian APIs, rooted at the vault. It SHALL refuse paths that are absolute or contain `..`, and SHALL be able to read and write hidden folders such as `.ipfs-sync/`. It SHALL NOT import Node built-in modules.

#### Scenario: Hidden state folder
- **WHEN** the engine writes its local record to `.ipfs-sync/`
- **THEN** the file is written even though the folder is not part of the indexed vault

#### Scenario: Escaping path
- **WHEN** a path contains `..`
- **THEN** the call fails without touching any file

### Requirement: Key-value capability over plugin data
The plugin SHALL implement the key-value capability over its stored plugin data, with values kept as bytes and no interference with the settings stored in the same file.

#### Scenario: Round trip
- **WHEN** a value is set and read back in a later session
- **THEN** the same bytes are returned and the settings are unchanged

### Requirement: Bounded memory per file
The bridge SHALL read one file at a time on request and SHALL NOT hold the whole vault in memory. Its ranged read SHALL return only the requested bytes to its caller. Where the platform offers no partial read, the bridge MAY load one whole file to serve a range, and this limit SHALL be documented: a single very large file can exceed mobile memory.

#### Scenario: Many files
- **WHEN** a vault with thousands of files is published
- **THEN** at any moment only the files currently being hashed or uploaded are in memory

### Requirement: Unimplemented capabilities fail clearly
Capabilities the plugin does not implement in this change (agents, shell) SHALL raise a typed not-implemented error; shell execution SHALL be denied.

#### Scenario: Shell request
- **WHEN** shell execution is requested through the bridge
- **THEN** it is denied with a typed error

### Requirement: WebView safety
The plugin source SHALL pass the project's WebView-safety checks: no Node built-in imports, no native modules, and a successful plugin bundle.

#### Scenario: Static check
- **WHEN** the WebView-safety grep runs over `src/`
- **THEN** it finds nothing
