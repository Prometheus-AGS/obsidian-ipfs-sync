# Vault agent — UI/UX concept for IPFS Sync's agentic search and chat

Status: concept for review, 2026-10-04. Inputs: `README.md`, `DESIGN.md` §7
(AI layer), specs 002 (AG-UI/A2UI client), 005 (UAR-lite lanes), 006
(embedded stores), 009 (popup chat), 010 (rendering contract), 011 Q7
(control center), the `ui-markdown-agents` skill, and the research below.
Prototype screens live beside this file (see §11).

The uncomfortable thing first: an AI chat panel inside Obsidian is a crowded
category (Copilot, Smart Chat, Smart Composer). Chrome will not differentiate
this plugin and must not try. What is different here is *where the truth
lives*: the index is a content-keyed cache that rides the encrypted vault
snapshot, the agent can run with no network, and every skill the agent uses is
visible. The UI's job is to make those three facts legible on every screen.

## 1. What the research says is standard practice

Sources: Obsidian developer docs (Plugin guidelines, CSS variables, Views,
Modals, Mobile development), the Smart Connections and Copilot for Obsidian
plugin pages and docs, 2026 plugin round-ups.

Obsidian's own rules for plugin UI, from the review guidelines:

- **No hardcoded styling.** Use CSS classes and Obsidian's CSS variables; a
  plugin styled with its own hex values breaks under themes and the user's
  accent colour. Ship one `styles.css`.
- **Sentence case** for every label, command and heading. Headings only when
  a settings tab has more than one section, never "Settings" in a heading,
  and headings via `new Setting().setHeading()`, not `<h2>`.
- **No default hotkeys.** Expose commands; let the user bind them.
- **Build DOM with `createEl`/`createDiv`,** never `innerHTML` with agent text.
  Agent output is untrusted input, which matches spec 010's sanitisation rule.
- **Register views, never hold view references;** reveal the leaf with
  `workspace.revealLeaf`. Do not detach leaves on unload.
- **Mobile:** no Node or Electron APIs, `Platform.isMobile` for layout
  switches, test with `app.emulateMobile(true)`.

Obsidian's design foundations the plugin should bind to, not restate:

| Need | Obsidian variable |
|---|---|
| Panel background / raised surface | `--background-primary`, `--background-secondary`, `--background-primary-alt` |
| Hover and borders | `--background-modifier-hover`, `--background-modifier-border`, `--background-modifier-border-focus` |
| Text hierarchy | `--text-normal`, `--text-muted`, `--text-faint` |
| User's accent | `--interactive-accent`, `--text-on-accent`, `--text-accent` |
| Status | `--text-error`, `--text-success`, `--text-warning`, `--background-modifier-error`, `--background-modifier-success` |
| Extended hues for chips | `--color-blue`, `--color-green`, `--color-orange`, `--color-purple`; mix with `color-mix(in oklch, …)` since 1.13 |
| Spacing (4 px grid) | `--size-4-1` … `--size-4-18`; `--size-2-*` sparingly |
| Radii | `--radius-s` 4, `--radius-m` 8, `--radius-l` 12, `--radius-xl` 16 |
| UI type | `--font-interface`, `--font-ui-smaller` 12, `--font-ui-small` 13, `--font-ui-medium` 15; weights `--font-medium`, `--font-semibold` |
| Code / numerics | `--font-monospace` |

Surfaces Obsidian gives a plugin, and what the leading AI plugins do with them:

- **`ItemView` in the right sidebar** is the home of every well-regarded AI
  plugin. Smart Connections lists related notes with a similarity percentage
  and lets the user drag a title into the editor to insert a wikilink. Copilot
  puts chat in a sidebar leaf, switches modes (chat / vault Q&A / agent),
  accepts `[[note]]` mentions and `/` commands in the composer, shows sources
  in a modal, and supports drag-to-link from sources. These are now what
  Obsidian users expect from "AI in the sidebar".
- **`SuggestModal` / `FuzzySuggestModal`** are the native pattern for a
  type-ahead popup (Quick switcher, Command palette). Users already know
  `↑↓ ↵ esc`. A plugin popup that looks like the Quick switcher needs no
  explanation.
- **`Modal`** for confirmations, with `Setting` rows inside; the existing
  plugin already does this (cost confirm, mass removal, key actions), with
  Cancel first and focused.
- **Status bar item** for a persistent one-line state; **`Notice`** for
  transient results. The plugin already uses both for sync.
- Local-first embedding plugins show indexing as an explicit, inspectable
  process (model name, progress, "zero setup, no API key"), because users
  decide whether to trust a plugin by whether it tells them what it did to
  their notes.

## 2. Principles

1. **Native first.** The panel should pass for a core plugin. Obsidian
   variables, Obsidian components, sentence case, Lucide icons via
   `setIcon`. No brand colour, no custom fonts, no gradients.
2. **The index is a cache and the UI says so.** Spec 006: PGlite and Surreal
   are rebuildable; iOS can evict them. Every index view shows model, counts,
   what is pinned to the current snapshot, and a one-tap rebuild. Nothing in
   the UI implies the embeddings are precious.
3. **Lane transparency.** Spec 005/009: a chip on every agent surface states
   `Local`, `Remote`, or `Offline`, and which model or endpoint. A question
   answered locally looks different from one that left the device.
4. **Audit beats trust.** Spec 010: skill activations are never hidden; tool
   calls, thinking, memory recall, sources and errors are collapsible but
   always reachable and copyable as source.
5. **One mechanism per job.** Questions go through chat, finding goes through
   search, settings go through the control center. No duplicate controls on
   the same screen.

## 3. Information architecture

Entry points (all user-bindable, none with a default hotkey):

| Entry | Opens |
|---|---|
| Ribbon icon "Vault agent" | the sidebar view, Chat tab |
| Command "Vault agent: search" / "…: chat" / "…: index status" | the sidebar view on that tab |
| Command "Vault agent: quick ask" | the popup (desktop modal, mobile bottom sheet) |
| Editor context menu "Ask about selection" / file menu "Ask about this note" | Chat tab with scope preset |
| Status bar chip "Index 1,204 / 1,218 · local" | Index tab |
| Settings → IPFS Sync → "Open control center" | the control center view |

Surfaces:

- **A. Vault agent view** (`ItemView`, right sidebar, 300–420 px) with three
  tabs: **Search**, **Chat**, **Index**. One leaf, one view type; the tab is
  view state so the workspace restores it.
- **B. Quick ask** (popup). Desktop: a `Modal` styled as a prompt, centered.
  Mobile: bottom sheet, half height, expands to full. Same component, two
  hosts, per spec 009.
- **C. Control center** (own `ItemView` in the main area). Spec 011 Q7:
  searchable, sectioned, consequence dialogs for anything destructive. The
  native settings tab stays, trimmed to the sync basics plus a button that
  opens the control center.
- **D. Status bar chip** and **Notices** for ambient state.
- **E. Dialogs**: consequence dialogs (Cancel first and focused), approval
  cards inside the chat for mutating tools.

## 4. Surface detail

### A1. Search tab

- Search field at the top, autofocused when the tab opens, placeholder
  "Search by meaning…". Below it, scope chips: *Whole vault*, *Folder…*,
  *Tag…*, *Since…*. Chips are toggles, not a second query box.
- Results are rows, not cards: title, folder path in muted mono, a thin
  similarity bar with the percentage, and a two-line excerpt with the matched
  span highlighted using `--text-highlight-bg`. Rows use
  `--background-modifier-hover` on hover; focus shows the native focus ring.
- Row actions appear on hover or focus and are always present on mobile:
  **Open**, **Insert link** (inserts `[[Note]]` at the cursor), **Add to chat**.
  Titles are draggable into the editor, like Smart Connections and Copilot.
- The lane chip sits in the tab header: `Local · all-MiniLM-L6-v2`. If the
  index does not cover the whole vault, the header says *"Searching 1,204 of
  1,218 notes · 14 queued"* with a link to the Index tab.
- Empty states say what they mean: *no index yet* ("Build the index to search
  by meaning. Until then, this searches text.") with grep fallback active;
  *no matches* with a suggestion to loosen scope; *offline* (identical, since
  search is local).

### A2. Chat tab: two modes, Notes and Agent

The Chat tab has a two-position mode switch at the top. **Notes** is the
default and is a retrieval-augmented chat over the local embeddings; **Agent**
is the agentic chat (skills, tools, approval cards) described in A2b. They
share the thread, the composer, the scope bar and the lane chip; they differ
in what a turn is allowed to do.

#### A2a. Notes mode (RAG chat)

Contract: retrieve passages from the local index, answer **only** from them,
cite every sentence at passage level, write nothing. No tools, no skills, no
approval cards. It works fully offline (embeddings on device, a small local
model for the answer) and is the mode most questions should land in.

- **Retrieved card first.** Every assistant turn opens with a collapsible
  *Retrieved N passages from M notes · 41 ms* card. Each passage row shows
  note title, the heading it sits under, a similarity bar with the score, a
  two-line excerpt, and three actions: **Open at heading**, **Pin** (keeps the
  passage in context for the following questions) and **Exclude** (drops it
  from the next retrieval). The card collapses when the answer finishes; the
  user can reopen it. This is the RAG equivalent of spec 010's tool-call card:
  the retrieval is the only "tool", so it is the thing to show.
- **Passage-level citations.** Superscripts in the answer point at passage
  numbers, not just notes. Hovering a citation highlights its passage row;
  clicking opens the note at that heading and flashes the block in the
  editor. Copy produces markdown with `[[Note#Heading]]` links.
- **Grounding line** under every answer: *grounded · 3 sentences · 3 cited ·
  0 without a source*. A sentence the model produced without a supporting
  passage is counted here, not hidden; if the count is non-zero the badge
  turns to a warning and the uncited sentences are marked in the text.
- **"Not in your notes."** When the best passage scores below the answer
  floor (0.60 in the prototype, user-adjustable), Notes mode generates
  nothing. It shows the near-misses it did find, says plainly that nothing
  records an answer, and offers two exits: text search for the phrase, or
  *Ask the agent instead*. It never answers from the model's own knowledge.
- **Quote only.** A toggle in the context strip switches answers to verbatim
  sentences from the passages, each cited. This is the honest mode for small
  offline models that paraphrase badly, and for users who want the notes'
  wording, not a summary.
- **Context strip** above the composer shows the passage budget (*3 of 8
  passages*), how many are pinned, and the Quote-only toggle. Pinned passages
  persist across turns; the budget makes the retrieval window visible rather
  than magic.
- **Conversation memory** is the pinned passages plus the last turns; a
  follow-up re-retrieves with the question and the previous answer as the
  query. The Retrieved card on the follow-up shows that the context changed.

What Notes mode deliberately lacks: no composer slash commands except
`/search` and `/save`, no agent picker, no skill cards. If a question needs
an action, the "Not in your notes" card and the mode switch are the way out.

#### A2b. Agent mode

- **Scope bar** above the thread: `Scope: current note ▾` (whole vault,
  current note, selection, folder, this conversation's notes). Beside it, the
  **lane chip** (`Local`, `Remote · UAR`, `Offline · local only`) and a
  conversation switcher.
- **Thread** renders per spec 010 and the `ui-markdown-agents` skill:
  - User and assistant bodies as GFM markdown.
  - Collapsible chunk cards with one header shape (icon · title · one-line
    summary · chevron): tool call, thinking, memory recall, sources, state,
    error. Expanded while streaming, collapsed on turn end, user override
    sticks per session.
  - **Skill card** for `SKILL_ACTIVATION`: name, source badge
    (project/user/plugin), description, args summary, elapsed time. It is
    expandable, never collapsible to nothing.
  - **Error card**: one-line summary collapsed after the turn, full payload
    inside, copyable.
  - **Confirmation card** for mutating tools (`write`, `move`, `ipfs_add`):
    inline **Approve** / **Deny**, decision recorded in place.
  - Citations as superscript numbers in the text and a **Sources** list with
    `[[wikilinks]]` that open the note; source titles drag into the editor.
  - Message actions: **Copy** (raw markdown), **Save as note** (inbox folder
    from settings), **Insert at cursor**.
  - Cancel leaves partial content with a terminal *Stopped* marker.
- **Composer**: multi-line, grows to six lines; `[[` opens the note
  suggester; `/` opens the command list (`/search`, `/summarize`,
  `/sync status`, `/publish`, `/save`); an attach control adds the current
  note or selection as context; one primary action that is **Send** while idle
  and **Stop** while streaming. Enter sends on desktop; on mobile the send
  button sends and Enter inserts a newline.
- **Offline behaviour**: the chip turns to *Offline · local only*; remote-only
  agents are disabled in the picker with the reason; a question that needs a
  remote lane is queued with a visible *Queued until online* row.

### A3. Index tab

- Model card: model id, dimensions, where it runs (on device), storage
  (PGlite in IndexedDB, size), last rebuilt.
- Progress: a filled bar with `1,204 / 1,218 embedded`, and the queue: changed
  since last publish, skipped (excluded or binary), failed.
- A short explanation that is the product's honesty statement: *"Embeddings
  are keyed by file content and travel with the vault snapshot. This device
  can rebuild them at any time; nothing here is the source of truth."*
- Actions: **Embed changed**, **Pause on battery** (toggle), **Rebuild
  index** (destructive → consequence dialog: time estimate, battery note,
  Cancel default).
- Per-file list, filterable by state, each row openable.

### B. Quick ask

- Desktop: a centered prompt (same silhouette as the Quick switcher). Typing
  searches the index as-you-type; results render like the Search tab rows
  without the action buttons. The instruction footer reads `↑↓ navigate ·
  ↵ open · ⌘↵ ask the agent · esc close`.
- `⌘↵` switches the same popup into **answer mode**: the query becomes the
  first user turn, the answer streams in with citations, and a single
  **Continue in panel** action hands the conversation to the Chat tab. The
  popup never grows its own composer: one question, then hand off.
- Mobile: bottom sheet with a grabber, half height by default, swipe or tap
  to expand. The input is at the top of the sheet so the keyboard does not
  cover it. Controls are at least 44 px tall.

### C. Control center

- Two columns on desktop (section list 220 px, content), one column on mobile
  with the section list as a horizontal scroller.
- A search field at the top filters rows by name, description and aliases
  ("rekey", "wipe", "model") and shows the matching section headings.
- Sections, per spec 011 Q7: Sync, Security, Agents, Direct links, Data,
  Appearance. Rows are Obsidian `Setting` rows: name, description, control.
- **Security** is first-class: device DID with QR, paired devices with
  per-device **Revoke**, UCAN grants with expiry countdowns, vault key state
  with the existing Lock / Change passphrase / Increase cost / Accept slots
  rows moved here.
- Every destructive or trust-changing action (revoke, rekey, wipe local
  stores, rebuild index) opens a consequence dialog: what happens, when it
  takes effect, what cannot be undone, Cancel focused.

## 5. Visual system

- **Background**: Obsidian's own surfaces, light and dark, via variables. The
  panel is `--background-secondary` like every sidebar; cards inside it use
  `--background-primary` with a `--background-modifier-border` hairline.
- **Typography**: `--font-interface` at `--font-ui-small` (13 px) for the
  panel, `--font-ui-medium` for the composer and answers, mono for paths,
  tool arguments and numbers. No display face: the plugin has no headline.
- **Layout**: 4 px grid throughout (`--size-4-2` row gaps, `--size-4-3` card
  padding, `--size-4-4` section gaps). Rows over cards; hairlines over boxes.
- **Accent**: the user's accent, used for the active tab indicator, links and
  the one primary action per surface. Nothing else is coloured by brand.
- **Status colour is semantic only**: green for embedded/online, orange for
  queued/stale, red for failed/error, never decorative.
- **States**: hover changes background only, never text colour toward the
  background; focus uses `--background-modifier-border-focus` plus the
  native ring; disabled is the only state allowed to lower contrast.
- **Motion**: expand/collapse 200 ms in, 140 ms out, ease-out; honour
  `prefers-reduced-motion`. Streaming shows a caret, not a bouncing dots
  loader.
- **Icons**: Lucide via `setIcon` (`search`, `message-square`, `database`,
  `terminal`, `zap`, `book-open`, `history`, `alert-triangle`, `cpu`,
  `wifi-off`).
- **Class prefix**: `ipfs-sync-` (already the plugin's convention), one
  `styles.css`, optional `@settings` block for the Style Settings plugin.

A contrast note the prototype surfaced: Obsidian's default light accent
(`hsl(258 88% 66%)`) with white text measures about 3.6:1, under 4.5:1 for
small text. The plugin should keep accent-filled buttons to icon buttons or
large labels, and use `--text-accent` on `--background-primary` for small
accent text. Themes may change the accent; the plugin cannot assume either way.

## 6. Mobile

- The sidebar view is Obsidian's mobile drawer; the tab strip stays at the
  top, the composer docks above the keyboard.
- Quick ask is the bottom sheet (§B). The control center is single column.
- Touch targets 44 px; long-press opens the same actions as right-click.
- Mermaid and KaTeX render on tap, not on scroll (spec 010).
- iOS may evict IndexedDB: the Index tab shows *"Index missing on this device
  · rebuild"* instead of failing silently, and search falls back to text.

## 7. Accessibility

- Every control is keyboard reachable; tab order follows reading order.
- Collapsible headers are `<button aria-expanded>`; chunk bodies are regions
  labelled by their header.
- Streaming text goes into a polite live region once per sentence, not per
  token, so screen readers are not flooded.
- Similarity bars carry the percentage as text; colour is never the only
  signal for state.
- Dialogs trap focus, Cancel first, Escape closes and means no.

## 8. Implementation notes for `uiux-lead`

- Vanilla DOM with Obsidian's `ItemView`, `Modal`, `Setting`, `setIcon`,
  matching the existing `src/plugin/*-dialog.ts` pattern (model + view split,
  copy in `*-copy.ts`). No React island for v1; A2UI basic catalog maps to
  the same components (spec 002 option 1).
- One `styles.css` with `ipfs-sync-` classes bound to Obsidian variables.
- Streaming renderer: block-level incremental markdown; use
  `MarkdownRenderer.render` for completed blocks so callouts, embeds and
  wikilinks behave like the rest of the vault.
- `Platform.isMobile` picks modal vs sheet; everything else is CSS.

## 9. Open questions

1. Does the Search tab merge with Obsidian's core search (a "by meaning"
   toggle in the core search pane is not possible from the API), or stay a
   separate tab? This concept keeps it separate.
2. Transcript retention default: local only (PGlite) with opt-in "Save as
   note". Confirm.
3. Approval granularity for mutating tools: per call in v1; "always allow for
   this agent" belongs in the control center's Agents section later.
4. Whether the control center replaces the native settings tab entirely or
   coexists (this concept: coexist, native tab trimmed).

## 10. Decisions this concept takes

- Right sidebar `ItemView` with three tabs is the home; the popup is a
  one-shot that hands off to it.
- Native Obsidian renderer, no React.
- The lane chip and the index honesty statement are mandatory, not optional
  polish.
- Settings live in a control center view; the native tab becomes a stub.

## 11. Prototype files

| File | What it shows |
|---|---|
| `index.html` | Overview and links to the screens |
| `agent-panel.html` | Obsidian desktop shell with the Vault agent view: Search, Chat in Agent mode (streaming turn with every chunk type), Index. Light/dark toggle, slash commands, approval card, collapsibles |
| `rag-chat.html` | The same view with Chat in Notes mode: Retrieved card with pin/exclude, passage-level citations linked to the editor block, grounding line, Quote-only toggle, context budget, and the "Not in your notes" state |
| `quick-ask.html` | Quick ask popup on desktop and as a mobile bottom sheet, with answer mode |
| `control-center.html` | Searchable control center with the six sections and a consequence dialog |
| `assets/obsidian-shell.css` | Obsidian variable defaults (light and dark) and the `ipfs-sync-` component styles the screens share |

The screens are concept fidelity: real Obsidian variable names and default
values, sample vault content, scripted agent responses. Nothing in them calls
a node or a model.
