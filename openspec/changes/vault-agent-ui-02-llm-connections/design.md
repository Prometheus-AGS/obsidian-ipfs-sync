## Context

Facts from `assessment-llm-connections.md` (read in full 2026-10-04) and the repo: `src/plugin/request-url-transport.ts` (`requestUrl` mapped to a `Response`, `GET` plus `Range` only streamed today); `src/plugin/range-streaming-transport.ts:134-139` (`desktopNodeModules`, run-time `require` lookup); `src/plugin/settings-store.ts` (plugin data via `saveData`); `src/sync/exclusions.ts` (`.obsidian/` excluded); `node_modules/obsidian/obsidian.d.ts` (`requestUrl`, `SecretStorage` since 1.11.4, `Platform.isDesktopApp`). Not verified: everything the assessment lists in s.9.

## Layers

```
src/ui/providers/components/   provider list, add/edit form, consent view, lane chip (import hooks only)
src/ui/providers/hooks/        use-providers (imports the store)
src/data/llm/provider-store.ts vanilla zustand: records, test state, defaults per mode; calls services
src/agents/llm/                services: provider.ts, openai-compatible.ts, anthropic-compatible.ts,
                               sse-parse.ts, stream-transport.ts, redact.ts, base-url.ts, key-store.ts (port)
src/plugin/secret-key-store.ts host implementation of the key port (app.secretStorage per L2)
```

Services import no React, zustand or store. The host passes `fetch`, `requestUrl`, the key store and `Platform` facts in. `src/agents/llm` imports no `obsidian` (ports instead), so the adapters run under Node tests.

## Provider interface (proposal, shaped by assessment s.7.1; owners rename)

`kind`: `openai-compatible` or `anthropic-compatible`. `capabilities()`: token streaming, tools, model list, usage. `listModels(signal)`, `chat(request, signal)` returning an async iterable of events (`start`, `text`, `reasoning`, `usage`, `stop`, `error` with `retryable`), `check(signal)` returning reachable and authenticated state and never a secret. Adapter rules: skip SSE comment lines (OpenRouter sends `: OPENROUTER PROCESSING`, s.4.1); ignore unknown fields (OpenAI adds `obfuscation`, s.4.1); treat in-stream errors as `error` events (OpenRouter sends `finish_reason: "error"` with HTTP 200, Anthropic sends an `error` event, s.4.1, s.4.2); honour the abort signal; never log headers. OpenAI-compatible: `POST /v1/chat/completions` with `stream: true`, `[DONE]` terminator, usage only with `stream_options.include_usage` and only if the server supports it, `GET /v1/models`; probe `/v1/models` first because compatible servers differ (s.4.1). Anthropic-compatible: `POST /v1/messages`, headers `anthropic-version` and `content-type`, auth `x-api-key` or Bearer, events `message_start` to `message_stop` with `ping` anywhere, `GET /v1/models` with pagination (s.4.2). The Responses API is not used in this slice (event list unverified, s.4.1).

## Transport

Order: `fetch` with a `ReadableStream` reader when the origin allows it; otherwise `requestUrl`, non-streaming, delivering the whole answer as one `text` event and labelled "no streaming" in the provider row. Desktop-only Node `http` streaming (assessment s.7.1) is not built here. It would reuse the gated `globalThis.require` lookup, so it needs the slice 10 style security review; task 1.8 builds it only if device checks show common providers block `fetch` from the app origin. Plain `http://` to non-loopback hosts is refused. Cross-origin redirects do not carry the Authorization header.

## Hardening (assessment s.7.5)

Cap total streamed bytes and line length; idle timeout; tolerate malformed JSON lines. Redaction: `Authorization`, `x-api-key` and `sk-`-style strings never reach logs, errors, notices, copied debug text, entities, exports or the exclusion hash. Keys never appear in a URL. Error objects carry the provider id and the HTTP status, not the request. `check:chat` gains a grep for `Authorization` and `x-api-key` outside `src/agents/llm`.

## Lane semantics (D9)

A provider is `Local` only when its base URL host is loopback (`localhost`, `127.0.0.1`, `::1`). Any other host is `Remote`, including a LAN address. The chip shows the lane plus a connectivity suffix when the device is offline. A remote provider cannot be `Local` by user label.

## Consent

Per provider and per mode (Notes, Agent), shown when the provider is first selected for that mode and again if the host changes. It names the host, what is sent in that mode, that this leaves the encrypted-vault boundary, and that the provider's retention applies (L4; final words are the operator's). Stored with the provider record. A Notes-mode default cannot be set without it.

## Settings placement

Provider settings sit in a section of the existing native settings tab (P5), as a React component mounted lazily into a container. The key entry control is `SecretComponent` (since 1.11.1) hosted in a ref; whether it works inside React-owned DOM is unverified (task 3.2 checks). Slice 08 hosts the same component in the Agents section. A component slot named `desktop-detection` exists in the layout and renders nothing in this slice. It is not an empty or disabled control; it is absent from the DOM until slice 10.
