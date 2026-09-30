## Purpose

Keeps the shared kubo client small enough for the mobile WebView by replacing a large third-party RPC library with a minimal in-repo caller, without changing what the client does.

## ADDED Requirements

### Requirement: No RPC library dependency
The project SHALL NOT depend on `kubo-rpc-client`. The shared client SHALL reach the node through one injectable HTTP transport (the platform `fetch` by default; the plugin supplies an adapter over Obsidian's `requestUrl`, because the WebView `fetch` is CORS-blocked by the node), and no type shim for the removed library SHALL remain.

#### Scenario: Dependency removed
- **WHEN** the package manifest and the source tree are searched for `kubo-rpc-client`
- **THEN** no dependency entry, import or shim file is found

### Requirement: Interface and behaviour parity
The shared client SHALL keep its public operations (node identity and version, MFS list, stat, remove and write, key list and generation, pin add, name publish and resolve, gateway reads) with unchanged inputs, outputs and error types. Every RPC argument SHALL still travel in the query string, authentication SHALL still be attached to every RPC and gateway request, and 401 or 403 answers SHALL still raise the typed authentication error naming the endpoint. Name resolution SHALL bypass the node's resolution cache. The node-safety refusals (unsafe paths, invalid key names) SHALL still happen before any request.

#### Scenario: Existing tests pass
- **WHEN** the client unit tests written for the previous implementation are run
- **THEN** they pass without changes to their expectations

#### Scenario: Rejected credentials
- **WHEN** the endpoint answers 401
- **THEN** the client raises the authentication error naming the endpoint

#### Scenario: Fresh resolution
- **WHEN** a name is resolved
- **THEN** the request asks the node not to use its cache

### Requirement: Streaming and error responses
The caller SHALL handle the node's JSON responses, newline-delimited JSON responses and error bodies, and SHALL surface a node-reported error as a typed error carrying the node's message, never as a raw parse failure.

#### Scenario: Node error body
- **WHEN** the node answers with a non-success status and a JSON error message
- **THEN** the raised error contains that message

### Requirement: Ranged gateway reads remain
The client SHALL keep read-only ranged gateway reads with the gateway's authentication.

#### Scenario: Range request
- **WHEN** a byte range of a file is requested
- **THEN** the request carries a `Range` header and returns only that range

### Requirement: WebView bundle size
The WebView-target bundle of `src/kubo` together with `src/core`, as measured by the project's import probe, SHALL be smaller than 60 KB before minification, and SHALL still contain no Node built-in imports.

#### Scenario: Probe result
- **WHEN** `pnpm probe:webview` runs after the change
- **THEN** it reports a combined size under 60 KB and no Node built-in import
