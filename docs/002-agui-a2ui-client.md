# Spec 002 — AG-UI / A2UI Client UI Against UAR

Status: **spec for later reference — no phases started.**
Depends on: local UAR instance at `/Users/gqadonis/Projects/prometheus/universal-agent-runtime`.

## Intent

Provide a user interface (inside Obsidian, and/or a companion web UI) that is a
**client of AG-UI endpoints**: manage sync, ask AI to search the vault, drive
agent runs — and render **A2UI** surfaces for agent-generated UI, backed by an
instance of the Universal Agent Runtime.

## Research findings

### AG-UI (agent → UI event protocol)

- Maintained by the AG-UI Foundation (CopilotKit-origin), spec at
  `docs.ag-ui.com` (1.0 spec live), reference implementation
  `github.com/ag-ui-protocol/ag-ui`.
- Event-based JSON-over-SSE: `RUN_*`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`,
  `STATE_SNAPSHOT`, etc. Framework-agnostic by design — the TypeScript SDK
  (`@ag-ui/core`) is not React-bound; events are plain JSON, so any HTTP+SSE
  client qualifies.
- Already an integration target for major frameworks (Microsoft Agent Framework,
  LangGraph, CrewAI, etc.) — i.e., UAR speaking AG-UI is on the beaten path.

### A2UI (agent-generated UI)

- Google's protocol: `github.com/google/A2UI`, spec at
  `a2ui.org/specification/v0_9` (v0.9 current per the Google developers blog).
- Agent emits **surfaces** assembled from versioned **catalogs** of components;
  message kinds: `createSurface`, `updateComponents` (JSON-Patch ops), `data`,
  `delete`. Renderers exist for web (`@a2ui/react`) and Jetpack Compose
  (`developer.android.com/develop/ui/compose/agentic`).

### Local UAR evidence (verified in source, 2026-09-29)

- UAR validates **A2UI v0.9.1** messages (`src/uar/a2ui/protocol.rs`), profile
  `uar.a2ui/1`, basic catalog `urn:uar:a2ui:catalog:1`.
- Realtime A2UI fan-out over SSE via flint-realtime-fabric
  (`src/uar/a2ui/realtime.rs`).
- Per-run A2UI routes exist (`src/uar/a2ui/routes.rs`):
  - `GET /{run_id}/a2ui/surface-replay`
  - `POST /{run_id}/a2ui/messages`
  - `POST /{run_id}/a2ui/actions`
- An AG-UI stream route exists in the skill-system's openai-proxy
  (`/ag-ui/stream`) — the exact UAR-native AG-UI endpoint surface still needs
  confirmation against the running instance.

## Feasibility verdict

**Yes.** The Obsidian plugin is just an HTTP client:

- AG-UI: `fetch` against the AG-UI endpoint, read the SSE stream
  (`response.body.getReader()`), map events to UI. Works in Electron (desktop)
  and WebViews (iOS 15+/Android) — no native code.
- A2UI: two rendering options —
  1. **Native Obsidian renderer**: map A2UI basic-catalog components to Obsidian
     DOM/CSS (lightweight, theme-consistent, no React), or
  2. **React island**: embed `@a2ui/react` in a `ItemView` (heavier, faster to
     ship, full component coverage).
  Decision deferred to implementation; option 1 preferred for mobile weight.
- A2UI **actions** (user clicks → agent) flow back through
  `POST /{run_id}/a2ui/actions`, closing the agentic loop.

## Architecture sketch

```
Obsidian plugin
 ├─ Sync engine (IPFS)          ─┐
 ├─ Agent panel (ItemView)       ├─ AG-UI client (SSE) ──► UAR instance
 │   ├─ run list / run control  ─┘   (local or remote)
 │   └─ A2UI surface renderer ◄─── surface-replay + realtime SSE
 └─ Vault tools (search etc.) ──► UAR tools (AG-UI tool calls)
```

## Open questions (need answers before implementation)

1. Exact UAR AG-UI endpoint(s) + auth model (JWT? API key?) on the local
   instance — confirm against `config.embedded.yaml` / running server.
2. CORS: can the WebView/Electron origin reach UAR; what origin allowlist does
   UAR enforce?
3. iOS WebView SSE specifics: `fetch` streaming vs `EventSource` — verify on
   device early (spike, not assumption).
4. Which A2UI catalog subset we render natively vs embed React for.
5. Does A2UI surface state need to persist into the vault (as notes/JSON) so
   surfaces survive app restarts — or is replay-from-UAR sufficient?
