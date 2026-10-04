## Purpose

Defines how the plugin reaches a model over OpenAI-compatible and Anthropic-compatible REST on every platform, how keys and request destinations are handled, and what the service layer may import. Desktop CLI adapters are out of scope (slice 10).

## ADDED Requirements

### Requirement: Provider interface
Each provider SHALL expose its kind, capabilities (token streaming, tools, model list, usage), a model list call, a chat call returning events (`start`, `text`, `reasoning`, `usage`, `stop`, `error` with a retryable flag) and a check call that returns reachability and authentication state and never a secret. Every call SHALL honour an abort signal.

#### Scenario: Cancel
- **WHEN** the caller aborts a streaming chat
- **THEN** the reader closes and no further events are emitted

### Requirement: Wire tolerance
Adapters SHALL skip SSE comment lines, ignore unknown fields, map in-stream errors to `error` events, and treat a malformed JSON line as an `error` event rather than throwing. The OpenAI-compatible adapter SHALL end a stream on `[DONE]` and SHALL work against a server that does not support usage chunks. The Anthropic-compatible adapter SHALL send `anthropic-version` and `content-type` and SHALL tolerate `ping` events anywhere.

#### Scenario: In-stream error
- **WHEN** a stream returns HTTP 200 and then an error event
- **THEN** the adapter emits an `error` event and stops

### Requirement: Transport honesty
The service SHALL stream through `fetch` when the origin allows it and SHALL otherwise use `requestUrl` and deliver the whole answer as one event. A non-streaming provider SHALL report token streaming as false and the UI SHALL label it. The plugin SHALL NOT claim streaming on a platform without a recorded device check.

#### Scenario: CORS blocks fetch
- **WHEN** `fetch` cannot reach the endpoint but `requestUrl` can
- **THEN** the answer arrives whole and the provider row shows that it does not stream

### Requirement: Destination safety
A base URL for a non-loopback host SHALL use `https`. The host SHALL be shown to the user before the first send. Requests SHALL NOT forward the Authorization header across origins on redirect.

#### Scenario: Plain http to a LAN host
- **WHEN** the user enters `http://192.168.1.20:11434`
- **THEN** it is refused with the reason

### Requirement: Key handling
Keys SHALL be held outside plugin data, referenced by an id, and SHALL NOT appear in any URL, log line, error text, notice, entity, conversation record, export, exclusion hash or copied debug text. The service SHALL redact `Authorization`, `x-api-key` and `sk-` style strings from anything it emits. A key SHALL NOT be placed in plugin data in clear unless the user chose that fallback and saw the warning.

#### Scenario: Failing request with a canary key
- **WHEN** a request fails with a canary key configured
- **THEN** searching logs, notices, error text and exported text for the canary finds nothing

### Requirement: Stream limits
The service SHALL cap total streamed bytes and per-line length and SHALL time out an idle stream. Exceeding a cap SHALL end the stream with a typed error.

#### Scenario: Oversized stream
- **WHEN** a stream exceeds the byte cap
- **THEN** it stops with a typed error and the partial text is kept

### Requirement: Layering and bundle
Services under `src/agents/llm` SHALL import no React, zustand, store or `obsidian`. No vendor SDK SHALL be bundled. No Node built-in SHALL appear in the plugin bundle graph.

#### Scenario: SDK import
- **WHEN** a file imports a vendor SDK package
- **THEN** `pnpm probe:webview` or `check:layering` fails
