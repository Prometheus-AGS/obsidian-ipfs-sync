## Why

The operator wants the plugin to reach models through OpenAI-compatible and Anthropic-compatible REST on every platform, with keys that stay on the device. Decided 2026-10-04: **REST first, desktop CLI later.** This slice ships only the two REST kinds. The desktop adapters (Claude Code, Codex) are slice 10. Notes mode needs a model to answer with (or it ships retrieval and Quote only, D10) and Agent mode needs a connection, so this slice comes before Search, Notes and Agent. Facts are in `vault-agent-ui-00-phase-overview/assessment-llm-connections.md` (cited "assessment s.N").

The uncomfortable parts:
- **Note text leaves the encrypted-vault boundary.** The product's promise is that the vault is encrypted before it leaves the device (assessment s.7.5). A provider receives whatever Notes mode sends (the question, retrieved excerpts, recent turns) and anything the user pastes. The UI must say so per provider and per mode, before the first send. Disclosure costs a click and may reduce use.
- **Mobile streaming may not exist.** `requestUrl` returns whole bodies and has no abort signal (assessment s.5). `fetch` streams but is bound by CORS, and the mobile origin and the CORS behaviour of `api.openai.com`, Ollama, LM Studio, OpenRouter and Anthropic for the Obsidian origin are untested (s.4.3, s.9 items 5 to 7). The Anthropic browser-access header is confirmed only by a secondary source (s.4.2). Some providers will answer whole on a phone and freeze the UI for long answers (s.7.3).
- **Where `SecretStorage` keeps keys is unknown.** Whether it persists in the OS keychain or a file, whether Obsidian Sync carries it, whether ids are shared across plugins, whether it works on mobile, and the lack of a delete method are all unverified (assessment s.5, s.9 item 4). The recommendation stands (L2 in `decisions-needed.md`) but awaits the operator and a real-install check. If it syncs, "keys never leave the device" is false.
- **Direct providers give text, not agent events.** There is no skill, tool or memory chunk from a bare endpoint. Agent mode needs UAR or, later, slice 10 (L8).
- **A user-typed base URL is a request destination.** It can point at an internal host. The UI shows the host and requires `https` for non-loopback hosts (assessment s.7.5).
- **The design has no provider screens.** The control center's Agents rows (default lane, endpoint, local model) are the only draft. Screens are drafted through Open Design first.

## What Changes

- A provider interface and two adapters in `src/agents/llm/`: `openai-compatible` and `anthropic-compatible`. No React, no zustand, no stores. Called only by stores.
- A key store port and a host implementation (L2), redaction, stream hardening, base URL validation.
- A vanilla store for the provider list, the test state and the default provider per mode.
- Provider settings UI: list, add, edit, remove, test connection, model selection, default per mode, lane chip per provider, consent per provider and mode.
- A named, hidden-on-mobile place for the future desktop detection panel that renders nothing in this slice.
- BDD against stub servers, including a canary-key redaction test.

## Capabilities

### New Capabilities
- `llm-provider-service`: the provider interface, REST adapters, transport, redaction, key port.
- `llm-connections-settings`: provider list UI, consent, defaults, lane semantics, key entry.

### Modified Capabilities
<!-- none -->

## Impact

- Code: `src/agents/llm/` (services), `src/data/llm/` (store), `src/ui/providers/` (components and hooks), `src/plugin/secret-key-store.ts`, settings-tab registration in `src/plugin/settings-tab.ts` (one line, ipfs-engineer approves), `tests/`, `features/`.
- Dependencies: none. No vendor SDK is bundled (assessment s.1.7, s.8 item 6). No React or zustand beyond the slice 01 pins.
- Data: provider records in plugin data (non-secret: id, kind, label, base URL, model, consent flags, defaults); secrets under ids such as `ipfs-sync-llm-<provider-id>` (assessment s.5 advises a prefix). `.obsidian/` is excluded from publish by default (`src/sync/exclusions.ts`, assessment s.6), but plugin data is readable by any process and by any tool that syncs `.obsidian/`, which is why the secret is kept out of it.
- Cadence: reviewers dormant until the phase gate; security-reviewer scope includes key handling, redaction, base URL handling and consent copy.

Blocked on: slice 01 sections 2 and 3 (build, layering lint, styles contract); L2 confirmed by the operator after task 1.1; design screens (task 0.1) before UI tasks; device checks of mobile streaming (task 1.7) before any "streams on mobile" claim.
