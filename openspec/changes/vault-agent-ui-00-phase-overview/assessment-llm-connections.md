# Assessment: LLM connections for the vault agent chat

Date: 2026-10-04. Scope: how the Obsidian plugin chat reaches a model. Read-only research; no model request was sent, no login was run, no credential file was read.

Source tags used below:
- [npm] `npm view`, run 2026-10-04 on this machine.
- [local] a read-only probe on this machine (`which`, `--version`, `--help`).
- [repo] a file in this repo, path given.
- [d.ts] `obsidian@1.13.1` type definitions, read from the registry tarball (`npm pack`, unpacked in the scratchpad).
- [doc:URL] an official page fetched 2026-10-04. Quotes are from the fetch result.
- UNVERIFIED means I could not confirm it from a source on this list.

## 1. Summary of findings

1. Three connection families are viable: OpenAI-compatible REST, Anthropic-compatible REST, and (desktop only) a locally installed Claude Code or Codex CLI.
2. REST is the only family that works on mobile. Obsidian mobile has no Node or Electron APIs [doc:https://docs.obsidian.md/Plugins/Getting+started/Mobile+development].
3. Obsidian `requestUrl` returns the whole body at once [d.ts, repo]. It cannot stream tokens. Streaming needs `fetch` (CORS-bound) or Node `http`/`https` on desktop.
4. This plugin is `isDesktopOnly: false` with `minAppVersion 1.12.3` [repo: manifest.json]. A desktop-only adapter must be a runtime lookup, never an import.
5. Obsidian has a `SecretStorage` API since 1.11.4 [d.ts]. The current minAppVersion already covers it.
6. Using a Claude subscription from a third-party app is prohibited by Anthropic's stated terms [doc:https://code.claude.com/docs/en/legal-and-compliance]. Spawning the user's own unmodified `claude` binary, signed in by the user, sits in a grey zone. See section 8.
7. Recommendation: do not bundle either vendor SDK. Spawn the installed CLI with `child_process` obtained at runtime, and speak its JSON stream.

## 2. Claude (desktop, installed Claude Code)

### 2.1 Official programmatic interface
- Package `@anthropic-ai/claude-agent-sdk`, latest and next `0.3.289` [npm]. Node `>=18` [npm]. License field: "SEE LICENSE IN README.md" [npm].
- Peer dependencies: `zod ^4.0.0`, `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0` [npm].
- Platform binaries ship as optional dependencies, for example `@anthropic-ai/claude-agent-sdk-darwin-arm64 0.3.289` [npm].
- Docs: "The SDK bundles a native Claude Code binary for your platform as an optional dependency... If your package manager skips optional dependencies, the SDK throws `Native CLI binary for <platform>-<arch> not found`; set `pathToClaudeCodeExecutable` to a separately installed `claude` binary instead." [doc:https://code.claude.com/docs/en/agent-sdk/typescript]
- Entry: `query({ prompt, options })` returns an async generator [doc: same page]. Options include `pathToClaudeCodeExecutable`, `executable` (`bun|deno|node`), `spawnClaudeCodeProcess`, `env`, `settingSources`, `settings` [doc: same page].
- The SDK "runs the Claude Code binary" [doc:https://code.claude.com/docs/en/agent-sdk/overview]. So the SDK is a wrapper over a subprocess. The docs also say: to drive the loop from another language, "run the CLI as a subprocess with the `-p` flag and `--output-format json`" [doc: same page].
- A bundling entry exists: `@anthropic-ai/claude-agent-sdk/core`, needs SDK 0.3.282+ [doc: typescript page].
- `Query.accountInfo()` and `initializationResult()` expose an `account` field with authentication status [doc: typescript page]. The exact fields are UNVERIFIED.

### 2.2 Headless CLI
All from [doc:https://code.claude.com/docs/en/headless] and [doc:https://code.claude.com/docs/en/cli-reference] unless tagged [local].
- `-p`/`--print` runs non-interactively. `--output-format text|json|stream-json`. `--input-format text|stream-json`.
- Token streaming: `--output-format stream-json --verbose --include-partial-messages`. Each line is a JSON object. Text deltas appear as `type == "stream_event"` with `event.delta.type == "text_delta"`. The last line is a `result` message.
- First event is `system/init`, with model, tools, MCP servers, plugins, and an optional `capabilities` array for feature detection (Claude Code 2.1.205+).
- Retry events: `system/api_retry`. Permission denials: `permission_denied` system messages.
- Useful flags: `--model`, `--max-turns`, `--max-budget-usd`, `--tools`, `--allowedTools`, `--disallowedTools`, `--permission-mode` (`default|acceptEdits|plan|auto|dontAsk|bypassPermissions`), `--permission-prompts none` (2.1.259+), `--no-session-persistence`, `--resume`, `--continue`, `--session-id`, `--system-prompt`, `--append-system-prompt`, `--mcp-config`, `--strict-mcp-config`, `--setting-sources`, `--settings`, `--json-schema`, `--restricted` (2.1.248+).
- `--bare` skips hooks, skills, plugins, MCP, CLAUDE.md, OAuth and keychain reads. "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper" in bare mode [local: `claude --help`; doc: headless]. So `--bare` cannot use a subscription login.
- Without `--bare`, a `-p` session loads the working directory's hooks and `.mcp.json` with no trust dialog [doc: headless]. This matters: a vault folder could carry `.claude/settings.json` hooks. See section 7.
- Piped stdin is capped at 10 MB [doc: headless].
- Exit code 0 on success, non-zero on failure [doc: headless].
- This machine: `claude` at `~/.local/bin/claude`, a symlink to `~/.local/share/claude/versions/2.1.289`, a Mach-O arm64 executable [local]. `claude --version` printed `2.1.289 (Claude Code)` [local]. The npm `latest` is `2.1.289` and `stable` is `2.1.285` [npm].

### 2.3 Authentication
- Precedence (first match wins): cloud provider vars, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, Anthropic profiles, then subscription OAuth from `/login` [doc:https://code.claude.com/docs/en/authentication].
- Storage: macOS Keychain, with `~/.claude/.credentials.json` (mode 0600) as fallback and on Linux; Windows uses `%USERPROFILE%\.claude\.credentials.json` [doc: authentication]. The plugin must never read these.
- Hazard: if the Obsidian process environment has `ANTHROPIC_API_KEY`, `claude -p` "always" uses it in non-interactive mode, so a spawned child can silently bill an API key instead of the subscription [doc: authentication, precedence item 3]. The adapter must choose the child environment explicitly.
- `claude auth status` prints JSON by default, `--text` for text; exit 0 if logged in, 1 if not; `authMethod` is one of `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`, `third_party`; `configDirectory` needs 2.1.268+ [doc: cli-reference; local: `claude auth status --help` lists `--json`, `--text`].
- I did NOT run `claude auth status` on this machine. The permission layer blocked my attempt as credential-adjacent, and I did not retry. The JSON shape beyond the documented `authMethod`/`configDirectory` fields is UNVERIFIED. Whether the JSON carries an email or org name is UNVERIFIED; the adapter should discard everything except `authMethod` and exit code.
- Sign-in is `claude auth login` (interactive browser flow) [doc: cli-reference]. The plugin should tell the user to run it in a terminal, not run it.

### 2.4 Detection a plugin can do safely
1. Find the binary. Candidates: user-configured path; `~/.local/bin/claude`; PATH lookup. A GUI-launched Obsidian often has a short PATH on macOS. This is UNVERIFIED on this machine.
2. Run `<path> --version`. Parse `^(\d+\.\d+\.\d+) \(Claude Code\)`. Matches the local output.
3. Run `<path> auth status --text` or `--json`. Keep only the exit code and `authMethod`.
4. Never open `~/.claude`. The directory exists on this machine [local: `ls -d`]; that is all I checked.

## 3. Codex (desktop, installed Codex CLI)

### 3.1 Packages and CLI
- `@openai/codex-sdk` latest `0.160.0`, Apache-2.0, Node `>=18`, depends on `@openai/codex 0.160.0` [npm].
- `@openai/codex` latest `0.160.0`, Apache-2.0, Node `>=16`; per-platform dist-tags exist (for example `darwin-arm64 0.160.0-darwin-arm64`) [npm].
- This machine: `/opt/homebrew/bin/codex` links to `/opt/homebrew/Caskroom/codex/0.158.0/bin/codex`; `codex --version` printed `codex-cli 0.158.0` [local]. That is behind npm latest 0.160.0.
- SDK: "wraps the `codex` CLI... spawns the CLI and exchanges JSONL events over stdin/stdout." Classes: `Codex`, `startThread()`, `resumeThread(id)`, `run()`, `runStreamed()`. The working directory must be a git repo unless `skipGitRepoCheck` [doc:https://github.com/openai/codex/blob/main/sdk/typescript/README.md]. Whether the SDK accepts a custom CLI path is UNVERIFIED.
- Non-interactive: `codex exec [PROMPT]`; stdin is read if no prompt or `-` [local: `codex exec --help`]. Flags seen locally: `--json` ("Print events to stdout as JSONL"), `-m/--model`, `-s/--sandbox read-only|workspace-write|danger-full-access`, `--skip-git-repo-check`, `--ephemeral`, `--output-schema FILE`, `-o/--output-last-message FILE`, `-c key=value`, `--oss`, `--local-provider lmstudio|ollama`, `--strict-config`, `-p/--profile` [local].
- Docs: progress goes to stderr, final message to stdout; `--json` emits JSONL with types such as `thread.started`, `turn.started`, `item.completed` ; default is read-only sandbox [doc:https://learn.chatgpt.com/docs/non-interactive-mode]. The full event list and item schemas are UNVERIFIED. Whether `--json` emits per-token deltas is UNVERIFIED. The SDK doc names only `item.completed` and `turn.completed` for `runStreamed()`, which suggests item-level, not token-level, streaming. Treat Codex chat as coarse-grained until tested.
- Other commands: `codex app-server` is marked experimental [local]. Not assessed. Do not build on it.

### 3.2 Authentication
- Two modes: ChatGPT sign-in (subscription) or API key [doc:https://learn.chatgpt.com/docs/auth].
- Credentials are cached in `~/.codex/auth.json` (plaintext) or the OS store; setting `cli_auth_credentials_store` is `file|keyring|auto|ephemeral` [doc: same page]. The plugin must never read `~/.codex`. The directory exists here [local: `ls -d`].
- `codex login status` prints the active method. On this machine it printed `Logged in using ChatGPT` [local]. That string is safe to show.
- `codex login --with-api-key` reads a key from stdin [local]. The plugin should not do this on the user's behalf.
- Docs warning: "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs. Don't expose Codex execution in untrusted or public environments." [doc: auth page]. A chat that drives `codex exec` with a ChatGPT login is a programmatic workflow. Terms for third-party apps using a ChatGPT login: UNVERIFIED (not found in the pages I fetched).
- CI auth: `CODEX_API_KEY=<key> codex exec --json ...` [doc: non-interactive page].

### 3.3 Detection
1. Binary lookup: configured path, `/opt/homebrew/bin/codex`, PATH.
2. `codex --version`, parse `codex-cli X.Y.Z`.
3. `codex login status` with exit code and first line only.
4. `codex doctor` exists [local]. Its output is UNVERIFIED and may touch config. Do not call it.

## 4. REST families

### 4.1 OpenAI-compatible
- Chat Completions stream: `POST /v1/chat/completions` with `"stream": true`. Server-sent events. Each chunk is `data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}`. The first delta has `role`, later ones carry `content`, the last has `delta:{}` and `finish_reason:"stop"`. The stream ends with `data: [DONE]` [doc via context7: https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events].
- Usage: only with `stream_options: {"include_usage": true}`; then `choices` can be empty on the last chunk and `usage` is set; "If the stream is interrupted or cancelled, you may not receive the final usage chunk" [doc: same].
- `obfuscation` field is added by default [doc: same]. Parsers must ignore unknown fields.
- Responses API stream: events carry a `type` such as `response.output_text.delta` (fields `delta`, `item_id`, `output_index`, `content_index`, `sequence_number`) and `response.completed` (field `response`) [doc via context7: https://developers.openai.com/api/reference/resources/responses/streaming-events]. The full event list, and the SSE `event:` line framing for Responses, are UNVERIFIED (docs.openai.com direct fetch returned HTTP 403).
- Model list: `GET /v1/models` returns `{"object":"list","data":[{"id","object":"model","created","owned_by","shutdown_date"}]}`, header `Authorization: Bearer <key>` [doc via context7: https://developers.openai.com/api/reference/resources/models/methods/list].
- OpenRouter: base `https://openrouter.ai/api/v1`, Bearer key. Keep-alive SSE comments `: OPENROUTER PROCESSING` must be skipped. Mid-stream errors arrive as an SSE event with HTTP 200 and `finish_reason: "error"`. A usage chunk precedes `[DONE]`. Abort cancels only for some providers [doc:https://openrouter.ai/docs/api-reference/streaming].
- Ollama: base `http://localhost:11434/v1/`; the API key is "required but ignored". Endpoints: chat completions, completions, models, embeddings, and `/v1/responses` (non-stateful, added in v0.13.3). Unsupported: `logit_bias`, `tool_choice`, `n`, `user`; no `previous_response_id` [doc:https://docs.ollama.com/api/openai-compatibility].
- LM Studio: default port 1234; endpoints `/v1/models`, `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/completions` [doc:https://lmstudio.ai/docs/developer/openai-compat]. Its CORS setting: UNVERIFIED.
- vLLM: default port, `--api-key`, `--allowed-origins`, supported params: UNVERIFIED (the docs page returned HTTP 429).
- Compatible servers differ in: whether `/v1/responses` exists; `stream_options` support; usage chunk; key enforcement; tool-call delta shape; reasoning field names (`reasoning_content` vs others, UNVERIFIED); mid-stream error shape. The adapter must treat each as optional and probe `/v1/models` first.

### 4.2 Anthropic-compatible
- Base `https://api.anthropic.com`. Messages: `POST /v1/messages`. Models: `GET /v1/models` (pagination with `after_id`, `before_id`, `has_more`, `first_id`, `last_id`) [doc:https://platform.claude.com/docs/en/api/overview].
- Required headers: `anthropic-version` (example `2023-06-01`) and `content-type: application/json`; auth is `Authorization: Bearer <token>` or legacy `x-api-key` [doc: same]. `anthropic-workspace-id` is required only for multi-workspace keys [doc: same].
- Max request size for Messages is 32 MB [doc: same].
- Streaming events in order: `message_start`, then per block `content_block_start`, `content_block_delta` (`text_delta`, `input_json_delta`, `thinking_delta`, `signature_delta`), `content_block_stop`; then `message_delta` (with `stop_reason`, `usage`), `message_stop`. `ping` events may appear anywhere. Errors can arrive in-stream as `{"type":"error","error":{"type":"overloaded_error",...}}` [doc:https://platform.claude.com/docs/en/build-with-claude/streaming]. SSE has `event:` and `data:` lines.
- Browser CORS: header `anthropic-dangerous-direct-browser-access: true` enables CORS for direct browser calls. I confirmed this from a secondary source only (Simon Willison, 2024-08-23): https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access. The official Anthropic API pages I fetched do not mention it. Mark UNVERIFIED against official docs.
- "Anthropic-compatible" third parties (gateways, proxies, Bedrock-style shims): their header, version and streaming support are UNVERIFIED. Treat as the same wire format with probing.

### 4.3 CORS behaviour of both families
- OpenAI direct API CORS from a WebView origin: UNVERIFIED. Not found in sources I could fetch.
- Local servers: Ollama, LM Studio and vLLM CORS defaults are UNVERIFIED. This repo's own finding is that the kubo node answers a request from `app://obsidian.md` with 403 and no CORS preflight headers, so the WebView `fetch` is blocked [repo: src/plugin/request-url-transport.ts header comment]. Expect the same for any server that does not allow that origin.
- Plain `http://` targets from an `https`-origin WebView on iOS may be blocked as mixed content. UNVERIFIED. Needs a device test (section 9).

## 5. Obsidian plugin API facts (obsidian 1.13.1)
- `npm view obsidian version` is `1.13.1`, latest [npm]. All items below are from its `obsidian.d.ts` [d.ts] unless tagged.
- `requestUrl(request)`: "Similar to `fetch()`, request a URL using HTTP/HTTPS, without any CORS restrictions." Params: `url`, `method`, `contentType`, `body: string | ArrayBuffer`, `headers`, `throw` (default true, throws on 400+). Response: `status`, `headers`, `arrayBuffer`, `json`, `text`. There is no stream, no `AbortSignal`, and no request-body stream. The response is whole by type. This repo says the same: "The body arrives whole (no streaming)" [repo: src/plugin/request-url-transport.ts].
- `request()` returns text, since 0.12.11.
- `Platform`: `isDesktop`, `isMobile` (UI mode), `isDesktopApp` ("the electron-based desktop app"), `isMobileApp` ("capacitor-js mobile app"), `isIosApp`, `isAndroidApp`, `isPhone`, `isTablet`. Use `isDesktopApp`, as `pullTransport()` already does [repo].
- Manifest: `minAppVersion: string` (required), `isDesktopOnly?: boolean` ("Whether the plugin can be used only on desktop") [d.ts].
- Docs: "The Node.js API, and the Electron API aren't available on mobile devices." To restrict to desktop, set `isDesktopOnly` true [doc:https://docs.obsidian.md/Plugins/Getting+started/Mobile+development].
- Secrets: `App.secretStorage: SecretStorage`, `@since 1.11.4`. Methods `setSecret(id, secret)` (id: lowercase alphanumeric with optional dashes; throws if invalid), `getSecret(id): string | null`, `listSecrets(): string[]`. There is no delete method in the 1.13.1 typings. `SecretComponent` (a settings control) is `@since 1.11.1`, with `setValue`/`onChange` `@since 1.11.4` [d.ts]. Docs page confirms "Since Version 1.11.4" [doc:https://docs.obsidian.md/Reference/TypeScript+API/SecretStorage].
- Where `SecretStorage` keeps secrets (OS keychain or a file), whether it syncs through Obsidian Sync, and whether it is shared across all plugins: UNVERIFIED. The typings say nothing. IDs are global to the app, not namespaced per plugin, as far as the typings show, so use a prefix such as `ipfs-sync-llm-`.
- Community review policy (from a search summary, not a full page): network use must be disclosed in the README; no client-side telemetry; third-party services need opt-in [search result citing https://docs.obsidian.md/Developer+policies]. The direct fetch of that page failed, so the exact wording is UNVERIFIED. Child-process use by a community plugin and its review treatment is UNVERIFIED.
- `fetch` on desktop and mobile: the WebView `fetch` exists on both. CORS applies to it. This repo found the app origin is `app://obsidian.md` [repo: request-url-transport.ts]. Whether Obsidian mobile uses a different origin (for example `capacitor://localhost`) is UNVERIFIED.

## 6. What this repo already has

- `manifest.json`: `"isDesktopOnly": false`, `"minAppVersion": "1.12.3"`, version 0.3.0 [repo]. SecretStorage (1.11.4) is already within minAppVersion. A desktop-only chat adapter must therefore be guarded at runtime.
- `src/plugin/range-streaming-transport.ts`: the pattern to copy. `desktopNodeModules(isDesktopApp, host = globalThis)` returns undefined unless `Platform.isDesktopApp`, then does `(host as {require?}).require("http")` in a try/catch. "A runtime lookup, not an import: the bundler sees no Node built-in, and mobile never reaches `require`." Structural slices describe the Node types because "src is compiled without @types/node". It wraps `incoming` in a `ReadableStream` with pause/resume back-pressure, one chunk look-ahead, and destroys the socket on cancel. Limits it states: no redirects, no system proxy, no timeout; abort signal destroys the socket [repo].
- `src/plugin/request-url-transport.ts`: `requestUrlTransport` maps `requestUrl` to a `Response`, `throw: false`, sets `contentType` from the headers, sends text or bytes only. `pullTransport()` composes the streaming Node transport for Range GETs and falls back to `requestUrl`. Only `GET` + `Range` is streamed today. A chat stream needs a new POST path with a streaming body; the existing function throws away anything but GET [repo: `rangeRequest` hardcodes `method: "GET"`].
- `tools/webview-import-probe.mjs`: bundles `src/main.ts` and probe entries with esbuild, `external: ["obsidian","electron","node:*", ...builtin-modules]`. It fails the build if any Node built-in import survives in the bundle graph (`nodeBuiltinImports`). `tools/hook-isolation.mjs` uses the same `external` list and also scans import specifiers, including template and non-literal `import()`/`require()` [repo]. Consequence: `import { query } from "@anthropic-ai/claude-agent-sdk"` or `import { Codex } from "@openai/codex-sdk"` into `src/` will almost certainly pull in `child_process` and fail the gate. The runtime `globalThis.require` lookup passes the gate.
- Bundle shape: the plugin ships one `main.js`. There is no second desktop-only bundle today. A separately loaded desktop bundle is UNVERIFIED as acceptable to Obsidian review.
- `src/sync/exclusions.ts`: `DEFAULT_EXCLUSIONS` includes `.obsidian/`, so the whole config folder, including `.obsidian/plugins/ipfs-sync/data.json`, is never published and pull refuses it. A renamed config folder is added by `exclusionsWithConfigDir` [repo]. Keys stored in `data.json` do not sync through this product. They still sit in plain text on disk in the vault folder and in any other tool that syncs `.obsidian/` (Obsidian Sync, iCloud, git). `SecretStorage` avoids that, subject to the UNVERIFIED storage location above.
- `src/plugin/settings-model.ts`: `data.json` "holds secrets and must never be published". Settings go through one store. The settings tab already warns the user about this [repo: settings-tab-copy.ts].
- `docs/002-agui-a2ui-client.md`: assumes the plugin is "just an HTTP client", `fetch` + `response.body.getReader()` over SSE, "Works in Electron (desktop) and WebViews (iOS 15+/Android)". Its open questions 2 and 3 are CORS and "iOS WebView SSE specifics: `fetch` streaming vs `EventSource` — verify on device early (spike, not assumption)". This assessment found that the repo's own transport comment says WebView `fetch` is CORS-blocked by the kubo node, which weakens assumption 1 for any server that does not allow `app://obsidian.md`.
- `docs/005-uar-lite-local-agents.md`: LLM lanes `local-onnx`, `local-webllm`, `remote-agui`, `remote-a2a`. None of the three connection families here exists as a lane. Direct provider REST and local CLI are new lanes. An AG-UI endpoint already counts as "remote-agui".
- `docs/009-popup-chat-interface.md`: desktop modal / side pane, mobile bottom sheet; streaming transcript on desktop. `docs/010-agentic-ui-rendering.md`: incremental block-level parse while streaming (so token-level streaming is a requirement of the renderer, not optional polish).
- `docs/011-mvp-decisions.md` Q4: `KeyStore` interface with platform backends; desktop plugin: "OS keychain where the plugin host allows; otherwise plugin data encrypted under a machine-local key"; "no key material in repo, logs, MCP tool arguments, or the manifest". `SecretStorage` is the plugin-host option this decision anticipated.
- `docs/012-vault-agent-ui.md` exists in the repo. It has no provider, key or CLI mention [repo: grep found none].
- The sibling change directories I saw: `chat-00-phase-overview` through `chat-05-a2ui-host-integration` [repo: `ls openspec/changes`]. I did not read them.

## 7. Recommendation

### 7.1 Provider adapter interface (TypeScript shape)
```ts
type ProviderKind = "openai-compat" | "anthropic-compat" | "claude-cli" | "codex-cli";
interface ProviderCapabilities {
  readonly tokenStreaming: boolean;      // false for requestUrl fallback, possibly Codex
  readonly tools: boolean;
  readonly modelList: boolean;
  readonly usage: boolean;
  readonly platforms: readonly ("desktop" | "mobile")[];
}
type ChatEvent =
  | { type: "start"; model?: string }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "usage"; input?: number; output?: number }
  | { type: "stop"; reason: string }
  | { type: "error"; code: string; message: string; retryable: boolean };
interface LlmProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  capabilities(): ProviderCapabilities;
  listModels(signal: AbortSignal): Promise<readonly { id: string }[]>;
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
  check(signal: AbortSignal): Promise<ProviderStatus>; // reachable, authed; never returns a secret
}
```
- The normalized `ChatEvent` maps cleanly to AG-UI `TEXT_MESSAGE_*` events (spec 002), so the same chat UI can sit on top.
- Adapter rules: skip SSE comment lines; ignore unknown fields; treat in-stream errors as `error` events; always honour `signal`; never log request headers.
- Streaming transport behind the adapter: `fetch` when the origin is allowed; a Node `http/https` POST streaming transport on desktop; `requestUrl` non-streaming on mobile, delivering the full answer as one `text` event.

### 7.2 Desktop detection and setup, step by step
1. Gate on `Platform.isDesktopApp`. Obtain `child_process` through the existing runtime `require` pattern, in a try/catch. If it is missing, hide the CLI providers.
2. Locate each binary from (a) a user-set absolute path, (b) known install locations (`~/.local/bin/claude`, `/opt/homebrew/bin/codex` on this machine), (c) a PATH lookup. Resolve symlinks. Show the path to the user.
3. Run `--version` with a short timeout and no prompt. Parse. Show it. Compare to a minimum version the plugin declares (Claude 2.1.205 for `capabilities`; Codex minimum UNVERIFIED).
4. Check sign-in: `claude auth status --json` (keep `authMethod` and exit code only), `codex login status` (keep first line only). If not signed in, show "run `claude auth login` in a terminal". The plugin does not start login flows and never handles tokens.
5. Show an explicit consent screen naming what leaves the device (section 7.5), the chosen binary, the folder it will run in, and the permission mode. Require a click per provider. Store consent in settings.
6. Build the child environment from an allow-list (`PATH`, `HOME`, locale). Remove `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY` unless the user chose key auth for that provider. This prevents the silent switch described in 2.3.
7. Run a one-token dry check only on user click. This sends a model request, so it is behind the consent screen and is not part of passive detection.
8. Claude spawn shape (to be device-tested): `claude -p --output-format stream-json --verbose --include-partial-messages --input-format text --no-session-persistence --tools "" --permission-mode dontAsk --setting-sources "" --model <m>` with the prompt on stdin, cwd set to an empty temp folder, not the vault. Rationale: no tool access, no hooks from the vault, no session files. `--setting-sources ""` handling of an empty value is UNVERIFIED. If the user wants vault tools, supply the plugin's own MCP server with `--mcp-config` and `--strict-mcp-config`, not the CLI's built-in file tools.
9. Codex spawn shape: `codex exec --json --ephemeral --skip-git-repo-check -s read-only -C <empty temp dir> -` with the prompt on stdin. The `-C` flag was not in the help text I read (output was truncated at 60 lines); verify before use. UNVERIFIED.
10. Cancel: kill the child process tree on abort. For Claude, SIGINT ends the turn; SIGTERM leaves it unfinished (exit 143) [doc: headless]. Use SIGINT first, SIGTERM after a grace period.

### 7.3 Mobile
- Can: OpenAI-compatible and Anthropic-compatible REST, if the server allows the app origin through CORS (WebView `fetch`), or non-streaming via `requestUrl`.
- Cannot: spawn a CLI, read `~/.claude` or `~/.codex`, use either SDK, use Node `http` streaming.
- Streaming on mobile depends on a device test of `fetch` + `ReadableStream` in iOS and Android WebViews (spec 002 open question 3, still open). Fallback is `requestUrl`, which gives the whole answer after the model finishes. For long answers this feels frozen.
- Options that need no new infrastructure: (a) user points mobile at a CORS-enabled endpoint (their own proxy, OpenRouter if it permits the origin, UNVERIFIED); (b) route through the user's desktop over the P2P link (spec 005/p2p-engineer) — this widens scope and is not assessed here.
- A mobile user cannot use a Claude or Codex subscription. Say so in the settings UI.

### 7.4 Key storage options, ranked
1. `app.secretStorage` (1.11.4+). Best fit: purpose-built, within current minAppVersion, keeps keys out of `data.json`. Trade-offs: no delete in typings; storage location and sync behaviour UNVERIFIED; IDs look global; read returns plain string in memory. Store only an ID reference in `data.json`.
2. `SecretComponent` in the settings tab as the entry control (1.11.1+), writing to `SecretStorage`. Same trade-offs; it keeps the key out of the DOM value and our own state.
3. OS keychain via Node on desktop. Needs a native binding, which cannot be bundled under the Node-built-in gate. Rejected for the plugin. The CLI route avoids storing any key at all, since the CLI holds its own credentials.
4. `data.json` plaintext. Not published by this product (exclusions) but readable by any process, any other plugin, and any tool that syncs `.obsidian/`. Acceptable only as an explicit user-chosen fallback with a visible warning. Spec 011 Q4 allows "plugin data encrypted under a machine-local key" as the alternative; a key stored beside the ciphertext in the same folder gives little protection.
5. Per-session memory only (prompt each launch). Strongest, worst UX. Offer as a toggle.
- Whatever is chosen: one `KeyStore` interface (spec 011 Q4), keys never in logs, error messages, event payloads, telemetry, exported chat notes, or the manifest.

### 7.5 Security issues
- Data egress from an encrypted-vault product. This product's promise is that the vault is encrypted before it leaves the device. Sending note text to a model provider breaks that promise for those notes. Provider terms and retention differ per vendor and per account type (UNVERIFIED for each). Required controls: off by default; per-provider consent; a visible "this note text will be sent to X" indicator; a send preview; exclusion of paths (reuse `src/sync/exclusions.ts` semantics plus a separate "never send" list); no silent background retrieval to a remote provider; a local-only mode (Ollama/LM Studio, `http://localhost`).
- Sensitive local endpoints. A user-entered base URL can point at an internal host. Show the host before first send, require `https` for non-loopback hosts, and do not follow cross-origin redirects with the Authorization header (`rangeRequest` does not follow redirects today, which is the safe default).
- Process spawning. Never build a shell string; use `spawn(file, argv, {shell:false})`. The binary path is user-controlled, so it is a code-execution setting: show it, re-verify on change, and do not accept a path from vault content or from a synced file. `data.json` is device-local by exclusion, which helps; the pull path already refuses `.obsidian/` files for the same reason [repo: exclusions.ts comment].
- Vault-borne config. `claude -p` without `--bare` loads project hooks and `.mcp.json` from the working directory with no trust prompt [doc: headless]. A vault cloned from elsewhere could run commands. Run with a neutral cwd and empty setting sources.
- CLI tool permissions. Do not use `--dangerously-skip-permissions` or `-s danger-full-access`. Default to no tools or read-only. Prompt-injection from note text could otherwise trigger writes. This also matches the repo rule that agent kernels do not write [repo: CLAUDE.md "Capability inversion"].
- Key redaction. Redact `Authorization`, `x-api-key`, and any `sk-`-style strings from logs, errors, copied debug text and bug reports. Never echo the child environment. Never pass a key on the command line (visible in `ps`); use stdin or env only.
- Stream hardening. Cap total streamed bytes and per-line length; time out on idle (no data) streams; tolerate malformed JSON lines; ignore SSE comment lines. Claude Code itself has watchdog env vars, for example `CLAUDE_STREAM_IDLE_TIMEOUT_MS` [doc: typescript page], but the plugin needs its own.
- Rendering. Model output is untrusted; the renderer must not use `innerHTML` for it (global web security rule; spec 010 covers rendering).
- Review risk. A community-plugin review of child-process use is UNVERIFIED. `isDesktopOnly` is not required if the code is guarded, but a reviewer may still ask.

## 8. ToS and licensing risk for the desktop CLI/SDK route

1. Claude subscription from a third-party app. Official text: "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow." [doc:https://code.claude.com/docs/en/legal-and-compliance]. And: "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication." [same]. The Agent SDK overview repeats: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." [doc:https://code.claude.com/docs/en/agent-sdk/overview].
2. The mitigating text: the restriction does not stop "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code" [doc: legal-and-compliance]. So the defensible shape is: the user installs and signs in to the real `claude` themselves; the plugin only launches it; the plugin never sees, stores or forwards a token; the binary is unmodified. That reading is mine. Whether a plugin that drives the binary as a chat backend counts as "route requests through ... plan credentials on behalf of their users" is a legal judgment. Treat it as an open risk, and ask Anthropic (the page names the sales contact) before shipping this as a feature.
3. Plan limits. "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK." [doc: legal-and-compliance]. A chat driving many calls per hour could exceed that. Enforcement: "Anthropic reserves the right to take measures ... without prior notice." [same]. The user's account is the one at risk.
4. Branding. The Agent SDK branding rules forbid the names "Claude Code" or "Claude Code Agent" and Claude Code-like visuals for partner products; "Claude Agent" or "Powered by Claude" are allowed [doc: agent-sdk/overview]. Another page allows saying in plain text that a product "runs Claude Code" [doc: legal-and-compliance]. The two pages differ in tone; use neutral labels such as "Claude (local install)". 
5. Binary integrity. Conditions for offering Claude Code inside a product: binary unmodified, no removal of auth methods, no paying or reselling for users, each user authenticates with their own credential [doc: legal-and-compliance]. Do not patch, repackage or bundle the binary. Do not bundle the SDK's native binary into the plugin.
6. SDK licence. The npm licence field is "SEE LICENSE IN README.md", and use is governed by Anthropic's Commercial Terms [npm; doc: agent-sdk/overview]. The README text was not read; the actual redistribution terms for bundling the SDK in a plugin are UNVERIFIED. Another reason to avoid bundling it.
7. Codex. The CLI and SDK are Apache-2.0 [npm], so bundling is permitted by licence. The ChatGPT-login terms for third-party apps are UNVERIFIED. The auth page tells users to use API key auth for programmatic workflows [doc: learn.chatgpt.com/docs/auth]. Safest route: offer Codex with an API key the user supplies via `codex login --with-api-key` themselves, not a ChatGPT login.
8. Safest path for each vendor: Claude through an Anthropic API key (REST family, or the CLI with `ANTHROPIC_API_KEY`, billed to the key owner as the terms allow); OpenAI through an API key. Subscription-backed CLI use should be an advanced, clearly labelled option that follows item 2.

## 9. UNVERIFIED list

1. Shape of `claude auth status --json` beyond documented fields; I did not run it (blocked).
2. `claude` and `codex` discoverability from a GUI-launched Obsidian (PATH contents).
3. Whether an Obsidian community plugin may spawn child processes in review.
4. Where `SecretStorage` persists data, whether Obsidian Sync carries it, and whether it can be deleted; ID namespacing.
5. Mobile WebView `fetch` streaming (iOS 15+/Android), and the mobile app origin used for CORS.
6. Mixed-content behaviour for `http://` endpoints from mobile.
7. CORS behaviour of `api.openai.com`, Ollama, LM Studio, vLLM, OpenRouter for the Obsidian origin. The Anthropic CORS header is confirmed only by a secondary source.
8. vLLM flags and port (page returned 429).
9. Full Responses API event list and SSE framing (docs.openai.com returned 403; only context7 excerpts).
10. Codex `--json` full event schema and whether it streams token deltas; a `-C`/cwd flag; Codex minimum version; whether `@openai/codex-sdk` accepts a CLI path.
11. `--setting-sources ""` with an empty value on Claude 2.1.289.
12. Claude Agent SDK licence text (README not read).
13. ChatGPT-login terms for third-party use of Codex.
14. Third-party "Anthropic-compatible" gateways' header and stream behaviour.
15. `codex doctor` output and side effects (not run).
16. Whether the P2P-to-desktop relay for mobile is acceptable (out of scope).

## 10. What a real-install or real-device test must verify

Desktop, on a machine with the real installs:
- Spawn from inside Obsidian (not a terminal) and confirm `child_process` is reachable through `globalThis.require` in the production bundle; confirm `tools/webview-import-probe.mjs` still passes.
- Binary discovery with a GUI-launched Obsidian on macOS, Windows and Linux.
- `claude -p ... stream-json --include-partial-messages` yields `text_delta` events promptly; time to first token; behaviour on abort (SIGINT then SIGTERM); exit codes for signed-out and expired logins; behaviour when `ANTHROPIC_API_KEY` is present vs scrubbed.
- That a hostile `.claude/settings.json` in the cwd is not loaded with the chosen flags and a neutral cwd.
- `codex exec --json` event stream, whether deltas exist, and `codex login status` exit codes signed in and out.
- Node `http/https` POST streaming for OpenAI and Anthropic REST on desktop: SSE parsing, `[DONE]`, in-stream errors, cancel closes the socket.
- `SecretStorage` round trip, uninstall behaviour, and whether the value appears under the vault folder or syncs.

Mobile, on real iOS and Android devices:
- `fetch` + `ReadableStream` against a CORS-enabled OpenAI-style and Anthropic-style endpoint: do chunks arrive incrementally?
- `requestUrl` fallback latency on a long answer.
- CORS and `anthropic-dangerous-direct-browser-access` behaviour from the mobile origin.
- `http://` LAN endpoint (Ollama on a laptop) from the phone.
- Background/foreground transitions during a stream; the stream must cancel cleanly.

Both:
- Redaction test: grep logs, error toasts and exported chat notes for a canary key after a failing request.
- Consent and egress indicator shown before the first send for each provider.
