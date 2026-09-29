# Spec 009 — Popup Agentic Chat Interface (All Platforms)

Status: **spec for later reference.**
Builds on: spec 002 (AG-UI/A2UI client), spec 005 (UAR-lite lanes), spec 006
(embedded stores), spec 007 (agent records), spec 008 (container interfaces).

## Intent

A **conversational chat interface that pops up on any platform** — mobile,
desktop, web — for talking to agents and the vault: ask questions, get cited
answers from notes, run agents, approve actions. Think "Cmd-K for your
second brain," everywhere.

## Surface design

| Platform | Invocation | Presentation |
|---|---|---|
| Desktop (Obsidian) | Global hotkey (`Cmd/Ctrl+Shift+K`), ribbon icon, command palette | Centered modal with streaming transcript; docks to side pane on demand |
| Mobile (Obsidian) | Toolbar button, swipe gesture, command palette | **Bottom sheet** (thumb-reachable), half-height default, expand to full; resumes across app restarts at last position |
| Web (companion page / Agent OS) | Floating action button | Floating panel over A2UI surfaces |

The popup is one code path: an A2UI surface host (spec 002 option 1 — native
Obsidian renderer) with a chat catalog, so the same conversation renders in a
modal, a sheet, or a floating panel depending on host chrome.

## Conversational capabilities

1. **Vault Q&A with citations** — answers cite note paths (wikiLinks). Online:
   semantic search (spec 006) + remote agents. Offline: local ONNX embeddings +
   local lane; grep fallback when no index exists yet.
2. **Agent interaction** — agent picker (manifest-driven, spec 005), streamed
   AG-UI responses, tool-call visibility (expandable "what the agent is doing"
   rows), human-in-the-loop approval cards for mutating tools (write, move,
   `ipfs_add`).
3. **Agentic UI in bubbles** — A2UI components render inside the transcript
   (tables, filters, confirm cards), not just text; actions post back through
   `/{run_id}/a2ui/actions` (spec 002).
4. **Conversation → vault** — "save this as a note" turns a turn into a note in
   a configurable inbox folder; every run can auto-emit a Karpathy record
   (spec 007) with a link back to the transcript.
5. **Slash commands / quick actions** — `/search`, `/summarize this note`,
   `/sync status`, `/publish` — vault operations as chat verbs.

## Lane behavior (online ↔ offline)

- Lane chain per request: `local (UAR-lite)` → `UAR remote` → graceful
  "offline, local-only" badge in the UI.
- Streaming degrades to buffered replies when SSE isn't available; the UI
  never blocks on connectivity.
- Queue-and-resume: a question asked fully offline is answered locally; a
  follow-up needing a heavy remote agent is queued with visible status.

## Framework placement (future-phase seams)

- **Chat host** = A2UI surface host (spec 002 renderer) — reused by spec 008's
  served endpoints for the same UI in a browser.
- **Tool executor** = the same vault toolset exposed over MCP (spec 008) — the
  chat is one client of it; no separate tool implementation.
- **History/transcripts**: stored in PGlite `sync_state`/dedicated table
  (spec 006) locally; optional transcript notes in the vault (user choice).

## Open questions

1. Hotkey + gesture defaults, and are they user-remappable per platform?
2. Transcript retention policy (local-only default; vault-note export opt-in)?
3. Approval UX granularity: per-tool, per-session, per-agent-manifest?
4. Does the chat surface double as the *only* UI for agent management
   (replacing a settings page), or is there a separate management view?
5. Multi-modal scope v1: text only, or voice input on mobile (iOS dictation is
   free; Android similar)?
