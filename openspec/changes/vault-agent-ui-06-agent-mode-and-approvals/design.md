## Context

Read 2026-10-04: the chunk table, collapse and streaming rules in `.agents/skills/ui-markdown-agents/SKILL.md`; `docs/010-agentic-ui-rendering.md` decisions 1 to 12; `chat-04-spec-010-rendering/tasks.md` (tasks folded here) and its `mixed-turn-rendering` spec; `chat-03` tasks 2.1 and 2.2; concept A2b. Not read: UAR's actual event names.

## Registry

One renderer per part kind of the entity union (`text`, `thinking`, `state`, `data`, `confirmation`, `skill-activation`, `memory-recall`, `citation`, `error`, `a2ui-surface`, `unknown`; tool calls reference a tool call entity). An exhaustive `switch` with a `never` check: adding a kind without a renderer fails `pnpm typecheck`. The `unknown` renderer shows the event name and payload, collapsible and copyable. Every block carries `data-chunk-kind`.

## Cards

Header shape: icon, title, one-line summary, chevron. Tool call: name, live args stream, result, state. Skill card: name, source badge (project, user, plugin), description, args summary, elapsed time or state, expandable body; never collapsible to nothing, never hidden. Error card: one-line summary, expanded while the turn runs, collapsed after, full payload copyable, never swallowed. Memory: entries with source, relevance, timestamp, distinct icon from citations. Thinking: muted, auto-expands while streaming only if the setting allows. Confirmation card: Approve and Deny; the outcome recorded in place ("Approved · appended", "Denied · nothing written"); both buttons disabled after one choice; per call only.

## Lane from the stream

The chip reads the turn's lane and model from the stream (D9). A stream without the field shows no lane claim and a visible "lane unknown" rather than defaulting to Local. Offline: the chip adds the connectivity suffix; remote-only agents are disabled in the picker with the reason; a skipped remote tool shows an error card with state "skipped". "Queued until online" appears only when the runtime reports a queue.

## Composer and scope

Scope bar (current note, selection, folder, whole vault, collection), composer growing to six lines, `[[` note suggester, `/` commands (`/search`, `/summarize`, `/sync status`, `/publish`, `/save`; `/publish` routes to the existing publish command, which asks before a mass removal), Send and Stop in one control, Enter sends on desktop and inserts a newline on mobile. Conversation switcher is per session until slice 11.

## Approvals

Mutating tools are write, move and `ipfs_add` (spec 009). A confirmation request renders a card and waits; the response goes to the runtime through a store action that calls the service; how the response returns to the agent is a runtime-phase fact. Nothing writes without an Approve gesture. Retrieved note text and tool results are untrusted input to the model; the card shows the exact arguments, as text, so the user sees what would be written.

## A2UI

The `a2ui-surface` part renders inside block chrome through a slot with a labelled placeholder until `chat-05` ships. `chat-05` tasks 1.1 to 1.8 stay as written and are scheduled after this slice.
