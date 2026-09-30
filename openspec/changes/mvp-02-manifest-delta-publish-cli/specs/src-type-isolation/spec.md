## Purpose

Guarantees at type-check time that code under `src/`, which ships in the Obsidian WebView, cannot use Node globals or modules, while CLI, tests and tools keep Node types.

## ADDED Requirements

### Requirement: Node-free type check for src
`src/` SHALL be type-checked with no ambient Node types. Any `src/` file that imports a Node built-in module or uses a Node-only global SHALL fail this check.

#### Scenario: Node import in src
- **WHEN** a `src/` file imports `node:fs`
- **THEN** the source type check fails with a diagnostic on that import

#### Scenario: Clean src
- **WHEN** `src/` contains only WebView-safe code
- **THEN** the source type check passes

### Requirement: Node types kept for the CLI, tests and tools
`cli/`, `tests/`, `tools/` and the test-runner config SHALL be type-checked with Node types available.

#### Scenario: CLI uses Node
- **WHEN** a `cli/` file imports `node:fs/promises`
- **THEN** the type check passes

### Requirement: One typecheck command
`pnpm typecheck` SHALL run both checks and fail if either fails.

#### Scenario: Either fails
- **WHEN** only the `src/` check fails
- **THEN** `pnpm typecheck` exits nonzero
