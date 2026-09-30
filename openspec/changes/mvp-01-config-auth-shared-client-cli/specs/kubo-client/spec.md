## Purpose

Defines the single shared client through which the plugin and the CLI reach a kubo RPC endpoint and an IPFS gateway, so proxy quirks live in one place.

## ADDED Requirements

### Requirement: Arguments travel in the query string
Every kubo RPC argument SHALL be sent in the URL query string. No argument SHALL depend on a form-encoded body.

#### Scenario: Files listing
- **WHEN** listing an MFS path
- **THEN** the request URL contains the path as the `arg` query parameter and the body carries no arguments

### Requirement: files/write multipart field
The client SHALL send file content for `files/write` as a multipart body whose field is named `data`. No other module SHALL issue `files/write`.

#### Scenario: Probe write through the proxy
- **WHEN** a probe file is written under the MFS root
- **THEN** the multipart field is `data` and a following `files/stat` returns the written size

### Requirement: Authentication on both endpoints
The client SHALL attach the configured authentication to every RPC and gateway request.

#### Scenario: Basic auth
- **WHEN** the scheme is basic with user `u` and password `p`
- **THEN** each request carries `Authorization: Basic base64(u:p)`

#### Scenario: Rejected credentials
- **WHEN** the endpoint answers 401 or 403
- **THEN** the client raises a typed authentication error naming the endpoint, not a raw stack trace

### Requirement: Runtime neutrality
The client module SHALL NOT import Obsidian APIs, Node built-in modules or native modules, so it bundles for the Obsidian WebView and runs in Node 24.

#### Scenario: Bundle check
- **WHEN** the plugin bundle is built
- **THEN** it builds without Node built-in imports originating from `src/`

### Requirement: Gateway reads
The client SHALL fetch content from the gateway by CID and optional path using the gateway endpoint and authentication.

#### Scenario: Fetch by CID
- **WHEN** a known CID is requested
- **THEN** the request goes to `<gateway>/ipfs/<cid>` and returns the bytes
