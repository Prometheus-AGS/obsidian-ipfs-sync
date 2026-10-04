## Context

Read 2026-10-04: concept B and section 6; `docs/design/quick-ask.html` (desktop prompt, answer mode, footer, mobile sheet); `docs/009-popup-chat-interface.md`; obsidian.d.ts (`Modal`, `SuggestModal`, `Platform.isMobile`). The report notes the shortcut handler also accepts Ctrl while the footer shows Cmd.

## Hosts

Two thin Obsidian host classes in `src/plugin/` create a container and mount the React root lazily (the same loader as slice 01). Components import hooks only; hosts pass the callbacks (open note, continue in panel, close). The Modal is the one dialog system (P4). Desktop: centred prompt; mobile: a bottom sheet built in the view layer, with a grabber, half height, expansion by drag or tap, the input at the top so the keyboard does not cover it, a scrim that closes. Whether a React sheet in Obsidian mobile keeps focus and the keyboard correct is unverified.

Roots and containers (A9, A16): the Modal root and the sheet root receive the same `GraphStore` the view uses, created in the store layer, never the ambient one. `Platform.isMobile` chooses the host only; layout inside either host switches by container width. The consequence-dialog checklist of the UI input s.2.5 is the review list for any in-popup popover.

## Flow

Empty: recent items. Typing: search rows as in slice 04 without row actions, plus a final row "Ask the agent" that, per D7, answers through the Notes pipeline (retrieval, floor, refusal, citations). The footer reads `↑↓ navigate · ↵ open note · <modifier>↵ answer · esc close`, with the modifier from `Platform`. Answer mode: the query becomes the first turn, the answer streams with citations, the lane chip shows the provider or lane in visible text, and one action, Continue in panel, hands the conversation to the Chat tab in Notes mode. "Ask the agent instead" (from a refusal) opens Agent mode in the panel. Escape resets the popup; it never keeps its own composer.

## States to draw first

Model loading, answer error, no index (offers text search), nothing found, no provider (retrieval and Quote only), offline. Each has text; none uses a spinner without words.

## Entry points

Command "Vault agent: quick ask", no default hotkey. On mobile the copy says how to add a command to the mobile toolbar in Obsidian's settings and Settings links to it (D14). No ribbon icon by default.
