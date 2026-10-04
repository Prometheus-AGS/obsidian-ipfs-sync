## Purpose

Defines the desktop-only adapters that use a user's installed Claude Code or Codex CLI, their detection and setup, and the limits that make spawning a local process reviewable. Nothing here ships until the four blockers close. It assumes none of the unverified behaviours of the CLIs.

## ADDED Requirements

### Requirement: Desktop only and gated
The adapters and their panel SHALL register only when the host is the desktop app and a run-time lookup yields process access. They SHALL NOT be imported by the plugin bundle graph and SHALL NOT exist on mobile.

#### Scenario: Mobile
- **WHEN** the plugin runs on a phone
- **THEN** no desktop adapter, panel or process lookup exists

### Requirement: Read-only detection
Detection SHALL locate a binary, read its version and read its sign-in state, retaining only the exit code and the auth method or first status line. It SHALL NOT open the vendors' credential or config directories, SHALL NOT run login, install or doctor commands, and SHALL NOT accept a binary path that comes from vault content or a synced file.

#### Scenario: Path inside the vault
- **WHEN** a binary path points inside the vault
- **THEN** it is refused

### Requirement: Setup is guided
Setup SHALL record a path the user confirms and SHALL show the exact sign-in command to run in a terminal. The plugin SHALL NOT write the CLI's own configuration.

#### Scenario: Signed out
- **WHEN** detection reports the user is signed out
- **THEN** the panel shows the command to run in a terminal and does not run it

### Requirement: Process safety
Processes SHALL be started with a file and an argument list and no shell. The working directory SHALL be an empty temporary folder, not the vault. Setting sources and tools SHALL be restricted so that hooks and MCP configuration from the vault are not loaded, as verified on the installed version. Dangerous permission bypasses SHALL NOT be used.

#### Scenario: Hostile vault config
- **WHEN** the vault contains a hook configuration
- **THEN** it is not loaded by the spawned process

### Requirement: Environment and keys
The child environment SHALL be built from an allow-list. Vendor key variables SHALL be removed unless the user chose key auth for that provider, in which case the key comes from the key store for that child only and never appears in argv.

#### Scenario: Ambient key
- **WHEN** the Obsidian process has `ANTHROPIC_API_KEY` set and the provider uses a different auth
- **THEN** the child does not receive it

### Requirement: Auth default
The default auth for a desktop adapter SHALL be an API key. Use of a subscription sign-in SHALL be offered only if the vendor has confirmed it is permitted in writing, and SHALL be labelled advanced.

#### Scenario: No vendor answer
- **WHEN** no written answer is on file
- **THEN** only API key auth is offered

### Requirement: Consent
Before the first send, consent SHALL name the binary, its path, the working directory, what is sent in that mode, that a local process starts with the user's credentials, and that vendor terms apply to the account.

#### Scenario: First send
- **WHEN** a desktop provider is chosen as default
- **THEN** the consent is shown and stored per provider and mode

### Requirement: Cancel and limits
Cancel SHALL send an interrupt first and a terminate after a grace period. Output size and idle limits SHALL apply as for REST providers.

#### Scenario: Stuck process
- **WHEN** the process ignores the interrupt
- **THEN** it is terminated after the grace period
