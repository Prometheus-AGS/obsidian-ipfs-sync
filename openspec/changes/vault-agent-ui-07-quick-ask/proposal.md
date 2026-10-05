## Why

Quick ask is a one-shot popup: desktop prompt in the Quick switcher silhouette, mobile bottom sheet, answer mode, then hand off to the view (`docs/design/vault-agent-ui-concept.md` B; `docs/design/quick-ask.html`). It never grows its own composer.

The uncomfortable parts:
- **It has all the prerequisites of Notes mode** and no extra. D7 recommends that it answers through the Notes pipeline, so it cannot ship before slice 05.
- **React inside a Modal and inside a bottom sheet has never run on a phone.** The spike sentinel task (slice 01 1.2) mounts a root in both; nothing else exercises it. Focus traps, the keyboard and portals in a WKWebView are the known risk (`chat-00` risk 6).
- **The popup must not pay the cold-start cost on every app launch.** It loads the chat bundle on first open only.
- **A plugin cannot add a mobile toolbar button.** `quick-ask.html:102,105` say "Tap the agent button below"; users bind a command (D14). The copy has to explain how.
- **The design has gaps:** no loading state while the model starts, no error state, no state for "no index" or "nothing found" inside the popup (report c.2).
- **Spec 009 defaults conflict:** a global hotkey, a swipe gesture, docking, an agent picker (D8). None is built.

## What Changes

- Desktop prompt in an Obsidian `Modal` (or `SuggestModal` host) with a React root; type to search, ⌘↵ or Ctrl+Enter to answer through the Notes pipeline with the platform's modifier shown.
- Mobile bottom sheet chosen by `Platform.isMobile`: half height, expands, input at the top, 44 px controls.
- Answer mode with citations and Continue in panel (opens Chat in Notes mode with the conversation).
- Command "Vault agent: quick ask", no default hotkey; mobile instruction copy for binding it.

## Capabilities

### New Capabilities
- `quick-ask`: popup behaviour, answer path, hand-off, hosts.

### Modified Capabilities
<!-- none -->

## Impact

- Code: `src/plugin/quick-ask-modal.ts`, `src/plugin/quick-ask-sheet.ts` (hosts), `src/ui/quick-ask/` (components, hooks), `src/data/quick-ask/` (store), copy files, `features/`, `tests/`.
- Dependencies: none.
- Cadence: reviewers dormant until the phase gate.

Blocked on: slice 05 (Notes pipeline and transcript kit); D7, D8, D14; slice 04 for result rows; design states.
