# UX design sync, 2026-10-04 (uiux-lead, discovery and documentation only)

Phase: mvp, change `mvp-07b-keys-history-guard-release-2`, KBD task 40 (2.5 prune dialog, another uiux-lead pass is building it in `src/plugin/*`). This note builds nothing. It does not touch `src/`, `docs/design/`, `styles.css`, KBD state or git.

Surface mode (per `.agents/UI_UX_PROTOCOL.md` project brief): Operate, variance 3 to 4, motion 2 to 3, density 6 to 8. Skills loaded: prometheus-ui-ux protocol, ui-ux-pro-max (no query: incumbent design authority wins), prometheus-impeccable-core, ui-markdown-agents, obsidian-markdown, vercel-react-best-practices and vercel-composition-patterns (read, not applicable: no React in the plugin per the operator section of `CLAUDE.md`).

The uncomfortable part first: the design authority is complete as a concept, and almost none of it can ship in iteration 8. It depends on an index, a local model, an AG-UI client and a lane selector that do not exist in `src/`, and one claim in its Index tab copy ("embeddings travel with the vault snapshot") is the opposite of what mvp-08 is deciding. Building screens before those exist produces a polished shell around mocks, and any new file under `src/ui/` or `styles.css` reopens the independent review of the exact tree (task 6.5).

## 0. Method and limits (what was and was not checked)

| Check | Result | Evidence |
|---|---|---|
| Read operator section, design README, concept, all five screens, `assets/obsidian-shell.css`, spec 012, specs 002/005/006/009/010/011, `open-design-mcp.md`, `.agents/UI_UX_PROTOCOL.md` | Done | Sections below cite file and line |
| New or changed in `docs/design/` since the last commit | The whole folder is new: `git status` shows `?? docs/design/`, `?? docs/012-vault-agent-ui.md`, `?? docs/operator/open-design-mcp.md`. `git log -- docs/design docs/012-vault-agent-ui.md` is empty. `.agents/UI_UX_PROTOCOL.md` is modified (+2 lines: the project surface brief). Nothing in the design set has ever been committed. | `git status --short`, `git log` |
| Open Design project `Obsidian agentic search UI concept` (`aca77082-f254-4ccf-96da-66844bd88e46`) has newer iterations | **MCP server `open-design` failed to connect this session; its tools (`mcp__open-design__*`) were not available and `ToolSearch` finds none. I did not query it.** Fallback, read-only and outside the MCP: the daemon's project directory is readable on disk, `/Users/gqadonis/Projects/references/open-design/.tmp/tools-pack/runtime/mac/namespaces/default/data/projects/aca77082-f254-4ccf-96da-66844bd88e46`. `cmp` reports all seven shipped files byte-identical to `docs/design/` (five screens, concept, `assets/obsidian-shell.css`). The folder also holds `.file-versions/` (five files, two versions each, from 12:52 on Oct 4) and `.od-skills/`. I did not open the version snapshots or compare them. | `cmp -s` on each file, `ls -la` of the project directory |
| What this does and does not establish | It establishes that, at the time of this check, the on-disk copy equals `docs/design/`. It does not establish that Open Design holds nothing newer elsewhere (unsaved canvas state, another project, a run in progress). Re-check through the MCP when it reconnects: `get_project` and `list_files` with the project id passed explicitly, read-only. | |
| UI present in `src/` today | None of the agentic layer. No `src/ui/`, no `styles.css`, no `ItemView`, no `registerView`. Existing UI: modal dialogs, a settings tab, one status bar item, two ribbon icons, eight commands (`src/plugin/index.ts:160-178`). | `ls src`, grep |
| Anything run or rendered | No. The screens were read as source; no browser, no device, no Obsidian run. Contrast, touch size and focus claims below are from the source, not from a render. | |

## (a) Inventory of design content

All files dated Oct 4 13:00 to 13:01 (copied from Open Design at 12:49 to 12:52). Authority order is README, concept, screens, shell CSS, then spec 012.

| Path | Lines | Bytes | What it holds |
|---|---|---|---|
| `docs/design/README.md` | 76 | 4,307 | Read order, decisions the screens encode, relation to specs, update rule |
| `docs/design/vault-agent-ui-concept.md` | 375 | 21,528 | Brief: research (Obsidian guidelines), 5 principles, IA and entry points, surfaces A1 to E, visual system, mobile, accessibility, implementation notes (section 8), 4 open questions (section 9), decisions (section 10) |
| `docs/design/index.html` | 225 | 17,071 | Launcher page for the screens and the token map. Uses its own display font (`--font-display: Iowan Old Style…`, line 17): a presentation page, not a plugin surface; it must not be read as a token source |
| `docs/design/agent-panel.html` | 412 | 43,806 | Sidebar view, Agent mode: Search / Chat / Index tabs, streamed turn (skill card, thinking, tool call, denied remote tool, memory recall, cited answer, sources, approval card), slash commands, rebuild dialog, status chip |
| `docs/design/rag-chat.html` | 324 | 34,700 | Same view, Notes mode: Retrieved card (pin, exclude, open at heading), passage citations, grounding line, Quote only, context strip, "Not in your notes" refusal, follow-up starters |
| `docs/design/quick-ask.html` | 176 | 19,821 | Desktop prompt (search as you type, Cmd+Enter answer mode, Continue in panel) and mobile bottom sheet (half and full, grabber, input at top) |
| `docs/design/control-center.html` | 169 | 25,397 | Searchable control center, six sections (Sync, Security, Agents, Direct links, Data, Appearance), consequence dialog for revoke, passphrase, rebuild, wipe, delete |
| `docs/design/assets/obsidian-shell.css` | 422 | 41,383 | Lines 1 to about 100: Obsidian variable defaults (hex palette) and reset. Lines about 100 to 422: `ob-*` shell classes (window frame, phone frame, concept bar) and the `ipfs-sync-*` component classes |
| `docs/012-vault-agent-ui.md` | 61 | 3,431 | Numbered-spec pointer: surface table, 7 decisions, ownership, open questions. Untracked |
| `docs/operator/open-design-mcp.md` | 67 | n/a | Names the Open Design project and the MCP bridge. Untracked. `.mcp.json` is gitignored and machine-local |
| `CLAUDE.md` section "Project: UI/UX design authority (operator decision, 2026-10-04)" | lines 243 to 250 | n/a | Operator rule: iterations drafted in Open Design, copied into `docs/design/` in the same commit as the change they justify; do not hand-edit the copies alone |

States and copy are inventoried per surface in section (c). Prototype data is scripted: no screen calls a node or a model (`docs/design/vault-agent-ui-concept.md:373-375`).

## (b) New or changed versus what exists in `src/`

Everything in `docs/design/` is new relative to the last commit (section 0), so "new vs changed" collapses to "design exists, code does not". Evidence per row is the grep or listing named.

| Design element | Design source | In `src/` today | Gap |
|---|---|---|---|
| Right-sidebar `ItemView` "Vault agent", tabs Search / Chat / Index | concept A, `agent-panel.html:97-226` | No `ItemView`, no `registerView` (`grep` over `src`: only `Modal` users and `index.ts`) | Whole surface |
| Search tab: semantic rows, scope chips, coverage line, text fallback | concept A1 | No index, no embedding code (`grep -il "pglite\|onnx\|embedding" src` hits only `path-policy.ts`, `exclusions.ts`, unrelated) | Needs data-engineer retrieval (mvp-08 and later) |
| Chat, Notes mode | concept A2a, `rag-chat.html` | None | Needs retrieval plus a generative or quote-only answer path |
| Chat, Agent mode (spec 010 chunks, skill cards, approval cards) | concept A2b, `agent-panel.html:329-396` | No AG-UI client, no A2UI renderer | Needs uar-engineer stream, lane; chat-03 2.2 and chat-05 1.2 plan the client in `src/agents/` |
| Index tab and rebuild dialog | concept A3, `agent-panel.html:183-245` | None | Needs index state interface |
| Quick ask: desktop prompt and mobile bottom sheet | concept B, `quick-ask.html` | None. `Platform.isMobile` not used for a sheet | Whole surface; the mobile "toolbar agent button" in `quick-ask.html:105` cannot be added by a plugin (see D14) |
| Control center `ItemView` | concept C, `control-center.html` | A native settings tab with sections, `Setting` rows and Encryption section (`src/plugin/settings-tab*.ts`, `encryption-settings.ts`) | The control center would replace or wrap it; see D3 |
| Status bar chip "Index 1,204 / 1,218 · local" | concept D, `agent-panel.html:230` | One status bar item showing sync state (`index.ts:160`, `presenter setStatus`) | A second item or a change of the first; see D13 |
| Ribbon icon "Vault agent" | concept section 3 | Two ribbon icons (publish, pull) at `index.ts:177-178` | One more icon; clutter decision |
| Commands "Vault agent: search / chat / index status / quick ask" | concept section 3 | Eight sync commands, none for the agent (`index.ts:169-176`) | New commands, no default hotkeys (existing code sets none: `grep hotkeys src` is empty) |
| Editor context menu "Ask about selection", file menu "Ask about this note" | concept section 3 | None | New, depends on Chat |
| Consequence dialogs, Cancel first and focused | concept D/E, README | Partly present: mass-removal, cost-confirm, abandon, clear-stale-lock focus Cancel; unlock, change-passphrase, increase-cost, accept-slots focus a field (`grep .focus() src/plugin/*dialog*.ts`) | Convergence rule needed; see D5 |
| `styles.css` bound to Obsidian variables | README, concept section 5 | No `styles.css`. Release tooling already treats it as optional (`tools/release/constants.mjs:6`, `check-guard-preconditions.mjs:362`) | New file; seed is not copy-ready; see D12 |
| Native DOM, no React | operator section, spec 012 decision 1 | True today: no JSX, no React in `src` | Conflicts with the planned chat-00 to chat-05; see D1 |
| 44 px touch targets, reduced motion | concept section 6, 7; shell CSS lines 100, 221, 297, 310, 368 | Dialogs use native Obsidian buttons and set no sizes (`task-notes/2.1-dialogs.md` accessibility checklist, "unverified on a phone") | Verify on device when UI exists |

## (c) The user experience, per surface (taken from the design)

Citations are file and line in `docs/design/` unless stated. Copy is quoted as the design writes it; sentence case holds throughout the screens.

### c.0 Facts legible on every agent surface

1. The index is a rebuildable cache (`vault-agent-ui-concept.md:81-84`). Index tab text: "Embeddings are keyed by file content and travel with the vault snapshot. This device can rebuild them at any time; nothing here is the source of truth." (`agent-panel.html:209`, concept `:238-240`). See D2: the first sentence is not safe to ship.
2. The lane chip names the lane actually used: `Local`, `Remote · UAR`, `Offline · local only`, with model or endpoint (concept `:85-87`, `:228`; chip states `agent-panel.html:117,131`, `quick-ask.html:74`, `rag-chat.html:136`; colours by `data-lane`, shell CSS lines 188 to 190: green local, blue remote, orange offline).
3. Skill activations are never hidden (concept `:88-90`, `:210-212`; skill card `agent-panel.html:353-355`).

### c.1 Vault agent sidebar view (one `ItemView`, 300 to 420 px; tab is view state so the workspace restores it)

Goal: find, ask, and see what the index is doing, in one place that looks like a core plugin (concept principle 1).

**Search tab** (concept A1; `agent-panel.html:105-120,282-313`)
- User goal: find notes by meaning, then open, link or send to chat.
- Flow: tab opens with the field autofocused ("Search by meaning…"); scope chips Whole vault / Folder… / Tag… / Since… are toggles; rows show title, mono folder path, similarity bar plus percentage text, two-line excerpt with `mark` highlight; row actions Open, Insert link, Add to chat (hover or focus on desktop, always visible on mobile, shell CSS line 218); titles draggable into the editor.
- Header: lane chip `Local · all-MiniLM-L6-v2` and "Searching 1,204 of 1,218 notes · 14 queued" linking to Index.
- Empty: no index yet, "Build the index to search by meaning. Until then, this searches text." with text fallback active (concept `:141-145`); no query: "Type to search 1,204 embedded notes by meaning…" (`agent-panel.html:298`); no match: "No notes close to that. Try fewer words, or widen the scope above." (`:300`). Offline is identical to online because search is local.
- Error / evicted: iOS may evict IndexedDB; the tab shows "Index missing on this device · rebuild" and search falls back to text (concept `:315-316`).
- Gap in the design: no loading state for the first query while the embedding model loads (cold model load is the slow step on a phone), and no error copy for a failed embed. Both need design before build.

**Chat tab: Notes mode (default)** (concept A2a; `rag-chat.html`)
- Contract: retrieve passages from the local index, answer only from them, cite every sentence at passage level, write nothing, no tools, no skills, no approvals (concept `:154-160`).
- Flow: two-position mode switch at the top (Notes / Agent) with scope chip and lane chip; each assistant turn opens with a collapsible Retrieved card "3 passages from 2 notes · 41 ms" (passage row: number, note title, heading, similarity bar and score, two-line excerpt, Open at heading, Pin, Exclude); answer with superscript passage citations (hover highlights the passage row; click opens the note and flashes the block); grounding line "grounded · 3 sentences · 3 cited · 0 without a source" (`rag-chat.html:176`); message actions Copy (markdown with `[[Note#Heading]]`), Save as note, Insert at cursor.
- Context strip above the composer: "3 of 8 passages", "0 pinned", Quote only toggle (`rag-chat.html:188-196`). Composer placeholder: "Ask your notes… answers cite passages, nothing is written" (`:199`). Only slash commands `/search` and `/save`.
- Refusal state: when the best passage is below the floor (0.60 in the prototype, user-adjustable in Appearance), nothing is generated. Copy: "Not in your notes. The closest passage scores 0.44, below the 0.60 floor for an answer. …" with two exits, "Search text for “…”" and "Ask the agent instead", plus "Notes mode never answers from the model's own knowledge." and the badge "no answer · 0 sentences · nothing generated" (`rag-chat.html:302-305`).
- Warning state: a non-zero "without a source" count turns the badge to warning and marks uncited sentences in the text (concept `:173-177`).
- Quote only: verbatim sentences, each cited; badge "quoted", "n quotes · verbatim from 2 notes" (`rag-chat.html:314`).
- Offline: fully works (embeddings on device, "a small local model for the answer", concept `:158-160`). See D10 for why this claim is unverified.
- Loading: retrieval timing is shown ("41 ms"); streaming shows a caret, not a loader (concept `:293-295`). No copy exists for "model still loading" or "retrieval failed".

**Chat tab: Agent mode** (concept A2b; `agent-panel.html:122-180,329-396`)
- Scope bar ("Scope: current note ▾" with whole vault, current note, selection, folder, this conversation's notes), lane chip, conversation switcher and new-conversation buttons.
- Thread per spec 010: GFM bodies; one header shape for chunk cards (icon, title, one-line summary, chevron) for thinking, tool call, memory, sources, state, error; expanded while streaming, collapsed at turn end, user override sticks per session; skill card (name, source badge project/user/plugin, description, args, elapsed or state, expandable body, never collapsible to nothing); error card with full payload copyable; confirmation card for `write_note`, move, `ipfs_add` with Approve and Deny and the outcome recorded in place ("Approved · appended", "Denied · nothing written", `:393`); Sources list with `[[wikilinks]]`, draggable; message actions Copy (raw markdown), Save as note, Insert at cursor; Cancel keeps partial content plus a terminal "Stopped" marker (`:376`).
- Composer: grows to six lines (144 px); `[[` note suggester; `/` command list: `/search` "Search the vault by meaning", `/summarize` "Summarize the current note", `/sync status` "Show publish and pull state", `/publish` "Publish the vault (asks before a mass removal)", `/save` "Save this conversation as a note" (`:320`); attach button for current note or selection; one primary action, Send idle and Stop streaming; Enter sends on desktop, newline on mobile.
- Offline: chip becomes "Offline · local only"; remote-only agents disabled in the picker with the reason; a remote-needing question is queued with a "Queued until online" row (concept `:228-230`). The denied remote tool shows as an error card "net_fetch denied · Remote lane not available offline" with state "skipped" (`:363`). The "Queued until online" row has no screen; only text.
- Mutating tools: approval per call in v1; "always allow" deferred (concept open question 3; control center shows the toggle locked on, `control-center.html` Agents "Approve mutating tools").

**Index tab** (concept A3; `agent-panel.html:183-225`)
- Model card (model, dimensions, where it runs, store and size, last rebuilt); Coverage with a `role="progressbar"` (aria-valuenow 1204 of 1218) and four counts (Embedded, Changed since last publish, Skipped (excluded or binary), Failed); actions Embed changed (accent), Pause on battery (toggle), Rebuild index (warn); queue of files by state (changed, skipped with reason) "Showing 4 of 45 · filter".
- Rebuild consequence dialog (`:236-245`): title "Rebuild the index on this device?", body "The local store (14.8 MB) is deleted and every note is embedded again. Search falls back to text until it finishes.", three consequences (time estimate and foreground note on phones; nothing in the vault or on the node changes; conversations and settings are kept), Cancel then "Rebuild index", Cancel focused (`:399`), Escape and scrim click close (`:401-402`).
- States: running shows disabled button and live counts (`:405-408`); evicted shows "Index missing on this device · rebuild"; failed shows a Failed count and per-file state. No error copy for "model failed to load".

### c.2 Quick-ask popup (`quick-ask.html`; concept B)

- Goal: one question, one answer, then hand off. The popup never grows its own composer (README, spec 012 decision 4).
- Desktop: centered prompt in the Quick switcher silhouette; input "Search by meaning, or ask a question…" with a `Local` chip; empty state "Recent: …"; typing shows result rows (no row actions) and a final row "Ask the agent: “…”" with `⌘↵`; footer `↑↓ navigate · ↵ open note · ⌘ ↵ ask the agent · esc close`.
- Answer mode: the query becomes the first turn; chip `Local · vault-librarian`, "scope: whole vault"; streaming answer with a caret; citations and Sources list; foot with Continue in panel (hands the conversation to the Chat tab). Escape resets the popup (`:88`).
- Mobile: bottom sheet, half height by default, grabber toggles full, scrim closes, input at the top with a send arrow ("Ask the agent"); empty text "Search by meaning across 1,204 embedded notes, or ask a question and tap the arrow." Offline answer example shows chip "Offline · local only". Controls 44 px (shell CSS lines 368, 376).
- Gap: no loading state while the model starts, no error state, no state for "no index" or "nothing found" inside the popup, and the answer path (Notes or Agent) is ambiguous; see D7.

### c.3 Control center (`control-center.html`; concept C)

- Goal: one searchable place for every setting, with consequences stated before anything irreversible.
- Layout: section list (220 px) and content on desktop, a horizontal scroller on mobile; search field "Search settings… try “rekey”, “wipe”, “model”, “battery”"; matching counts shown beside section names; no-match copy "No setting matches. Aliases are searched too: try a plainer word." (`:41`).
- Sections and the rows that matter to this note: Sync (node URL, pull name, auto-publish interval "The timer never opens a dialog…", chunk size, staging retention); Security (this device DID, QR and short code with countdown; paired devices with Revoke; active grants with expiry countdown; vault key Lock now; Change the passphrase; key-derivation cost); Agents (default lane, remote endpoint, local generative model, approve mutating tools locked on, skill permissions); Direct links (WebRTC, iroh preview, signaling relay); Data (embedding model, embed on battery, vector store with Rebuild index, knowledge graph with Rebuild graph, conversation history Delete all, Wipe local stores); Appearance (density, expand thinking and tool calls, mermaid, math, status bar chip).
- Consequence dialogs (title, body, consequence list, Cancel then warn confirm, Cancel focused, `:73-76`): revoke device ("This device loses sync access when its current grant expires. It keeps the notes it already pulled."), revoke grant, change the passphrase (new passphrase generated and shown once; other devices must run "Accept changed key slots"; the old passphrase and old key-slot copies still open the vault; "A lost device needs a new vault, not a new passphrase."), rebuild index, rebuild graph, delete conversations, wipe local stores.
- The passphrase dialog copy already agrees with the shipped 07b dialog. The device and grant rows have no backing code (see D4 and the not-ship list).
- Mobile: single column, section list scrolls horizontally; targets 44 px.

### c.4 Status chip (`agent-panel.html:229-233`; concept D)

- Text "Index 1,204 / 1,218 · local"; click opens the Index tab; updates live while embedding (`:407`); toggled by Appearance "Show status bar chip". Sits beside "Published 11 min ago" and the note count, so it is an addition to, not a replacement for, the sync status.
- Not specified: the chip's states for evicted ("Index missing"), paused, failed, offline-lane, or building; and Obsidian mobile has no visible status bar, so on phones the chip does not exist and the Index tab is the only place the facts live (D13, verify on device).

### c.5 Lane chip behaviour (all agent surfaces)

- One component, three tones: Local (green dot), Remote (blue), Offline (orange), shell CSS lines 188 to 190. Text carries the state so colour is never the only signal (concept `:340`; status colour is semantic only, `:288-290`).
- Placement: Search header; Chat scope bar; quick-ask input row; answer row. Detail (retrieval model, answer model) in Notes mode lives only in a `title` attribute (`rag-chat.html:136`), which is invisible on touch and to keyboard users. Move it into visible text or a focusable popover before build (D9).

### c.6 Consequence dialogs, accessibility and mobile (common)

- Dialog contract (concept `:324-327`, README): trap focus, Cancel first and focused, Escape means no, scrim click closes. In the prototype Cancel is a plain button and the confirm is the warn style (`agent-panel.html:243`).
- Collapsible headers are `<button aria-expanded>`, bodies regions labelled by the header; streaming goes to a polite live region once per sentence, not per token (the prototype puts `aria-live="polite"` on the whole thread, `agent-panel.html:134`, which would announce per token; the concept's per-sentence rule needs an implementation, not just the attribute); similarity bars carry the percentage as text; every control keyboard reachable.
- Mobile: tab strip on top, composer docks above the keyboard, long-press equals right-click for the same actions, mermaid and KaTeX render on tap, touch targets 44 px (shell CSS gives `is-mobile` buttons 44 px at lines 221, 297, 310). Note the project protocol: 44 px is a usability preference, 24 px is the AA floor.
- Motion: expand 200 ms, collapse 140 ms, ease-out, `prefers-reduced-motion` honoured by one global rule (shell CSS line 100).
- Contrast: Obsidian's default light accent with white small text is about 3.6:1. The concept's answer is to keep accent-filled controls to icon buttons or large labels, and spec 012 allows a darker derived fill. The prototype's "fix" redefines `--interactive-accent` at 58 percent lightness (shell CSS line 40); a plugin cannot do that globally (D12).

## (d) Conflicts and spec deltas for product-manager

Each is a delta to raise, not a decision made here. Format: what conflicts, evidence, what each reading costs, my suggested resolution (for product-manager and the operator to accept or reject). No conflict has been resolved silently in code.

**D1. No React vs the planned React chat shell (chat-00 to chat-05).** The operator section (2026-10-04) and spec 012 decision 1 say native Obsidian DOM, no React island in v1. The planned phase `chat-react-shell` (operator decisions 2026-10-02, `chat-00-phase-overview/README.md:"Operator decisions encoded"` items 1 to 5) builds the chat on React 19, Zustand, `@prometheus-ags/prometheus-entity-management`, assistant-ui, shadcn on Base UI, a custom assistant-ui runtime adapter, a lazy-evaluated chat bundle with the 300 KB limit waived, and a React spike on the operator's iPhone (chat-01) that gates everything. Directly affected: chat-02 (JSX build, layering lint, probe), chat-03 (React shell, runtime adapter 2.3, entities), chat-04 (react-markdown, `use-collapse` hook), chat-05 1.4 (React host island; 1.3 the native A2UI renderer is compatible). The 2026-10-04 section is the later decision. Suggested delta: supersede chat-00 decisions 1, 2, 4, 5, 6 and the chat-01/02 scopes; keep what survives and has no React: `src/agents/agui-client`, `src/agents/a2ui-client` (chat-03 2.2, chat-05 1.2), `src/ui/a2ui-native` (chat-05 1.3), data entities if still wanted; rename the phase (`vault-agent-ui`) and re-point chat-00 0.2a's delta text (it says "the chat shell is a React island", "the first chat surface is an ItemView", "history is entities in PGlite"). The chat-00 Out-of-scope list (popup modal, bottom sheet, global hotkey, agent picker, local lanes, offline queue, slash commands, agent management UI) is now in scope of the concept, so the scope must be re-cut. The reasons for React that the operator recorded (assistant-ui streaming runtime, shadcn) must be replaced by the native streaming renderer in concept section 8; its cost is hand-written incremental markdown, which is real work (see D11).

**D2. "Embeddings travel with the vault snapshot" vs mvp-08.** Concept principle 2 and the Index tab honesty text (`agent-panel.html:209`) say embeddings are keyed by content and ride the snapshot. `mvp-08-sync-history-store/README.md` (2026-10-02) says that assumption must be revised, that docs 005, 006 and DESIGN section 7 plan it, that the Smart Connections author advises against syncing the embedding store, that the choice is exclude by default or an own optional store, and that embeddings on a phone are opt-in, never default, behind an unrun iPhone PGlite plus ONNX memory gate. The Rebuild dialog ("Embeddings pinned to the current snapshot are reused where the content hash matches", `:242`) and the Data section depend on the same claim. Until mvp-08 decides, the verbatim copy is false or unknowable. Suggested delta: the Index tab states only "can be rebuilt on this device at any time; nothing here is the source of truth" until the decision lands, and the snapshot clause is added or dropped per mvp-08. The default "Embed on battery" and phone opt-in must follow the mvp-08 rule (the control center shows the toggle off, consistent).

**D3. Control center replaces the settings tab vs 07b `plugin-key-management-ui`.** The concept (section 3 C, section 4 C) moves Lock, Change passphrase, Increase cost, Accept slots into Security and trims the native tab to a stub; spec 012 decision 5 says the same. The 07b spec requires the actions "in the existing plain tab" and "SHALL keep the tab plain" (`specs/plugin-key-management-ui/spec.md`, "Settings additions"), and the 07b dialogs and Encryption section are built and wired. Suggested delta: iteration 8 keeps the 07b tab as is; when the control center is built, its Security section calls the same dialog classes (the `Modal` dialogs are host-independent, which is the design intent in concept section 8) and the 07b requirement text is amended after 07b closes. Open question 4 in the concept (replace or coexist) stays an operator decision; the concept recommends coexist.

**D4. Revoke wording vs 07b key semantics, and unbuilt Security rows.** Control center Revoke: "This device loses sync access when its current grant expires. It keeps the notes it already pulled." (`control-center.html` deviceCard). 07b: a rewrap replaces a slot and revokes nothing; the old passphrase and every old copy of `keyslots.json` keep opening the vault; a lost device needs a new vault (`tasks.md` 5.1 "rewrap semantics (replaces the slot, does not revoke…)"; the passphrase row of the same control center says it). A UCAN revoke that leaves the device able to decrypt everything it can fetch is a trust-changing action whose dialog would mislead. Also no code exists for did:key, UCAN, SPAKE2 pairing or WebRTC (`grep -rli "ucan\|spake\|did:key\|webrtc" src` is empty). Suggested delta: the revoke dialog must say what a grant revocation does not do (does not remove the passphrase-derived key or old slots), spec 011 Q7's "one click with a visible consequence summary" gains that limit, and the Security and Direct links rows stay hidden until their engines exist (see the not-ship list). The "Key-derivation cost" row is a dropdown in the prototype (`Default · 64 MiB, 3` / `High · 128 MiB, 4`) and must instead open the 07b increase-cost dialog (presets within ceilings, downgrade confirmation, old copies stay valid); an inline select hides a rewrap.

**D5. "Cancel first and focused" vs shipped dialog focus and styling.** Shipped: mass-removal, cost-confirm, abandon and clear-stale-lock focus Cancel (`mass-removal-dialog.ts:42`, `cost-confirm-dialog.ts:42`, `abandon-vault-dialog.ts:69,102`, `clear-stale-lock-dialog.ts:53,79`). Shipped, by 07b design: unlock, change-passphrase, accept-slots and setup focus a field; increase-cost focuses the selected radio (`unlock-dialog.ts:82`, `change-passphrase-dialog.ts:101`, `accept-slots-dialog.ts:96`, `increase-cost-dialog.ts:113`), which `task-notes/2.1-dialogs.md` records as a deliberate rule ("key dialogs on their first field"). Styling: Cancel carries `mod-cta` (accent fill) with the confirm as `mod-warning` in `mass-removal-dialog.ts:68-69` and `cost-confirm-dialog.ts:73`; the concept shows a neutral Cancel and a warn confirm, and its own contrast note says accent-filled small labels miss 4.5:1 on the default theme. Suggested delta: state the rule as "confirmation dialogs focus Cancel; dialogs with a required field focus the field, Cancel precedes the confirm control in DOM order, Escape and close mean no, and after any end state focus returns to Cancel or Close"; decide Cancel styling (neutral vs `mod-cta`) once for all dialogs. Not a code change in iteration 8.

**D6. Notes mode "writes nothing" vs Save as note and Insert at cursor.** The contract says "write nothing" (concept `:159-160`, composer placeholder "nothing is written"), yet the Notes message actions include Save as note (writes `Inbox/Notes chat — … .md`) and Insert at cursor (`rag-chat.html:177-180`). Both are user-initiated vault writes, and Save as note feeds the publish tree (so a chat transcript becomes plaintext before encryption, then encrypted content on the node). Suggested delta: the contract is "the assistant takes no write actions; user-initiated Copy, Save as note and Insert at cursor are allowed and never automatic"; the inbox folder and transcript retention (concept open question 2) are operator decisions before build.

**D7. Quick ask answers through the agent, not Notes mode.** `quick-ask.html` answer mode shows the chip `Local · vault-librarian` (an Agent-mode skill) and the footer offers "ask the agent"; Notes is declared the default chat that never answers from model knowledge, and spec 009 says answers cite note paths. Suggested delta: Quick ask answers through the Notes pipeline (retrieval, floor, refusal) and offers "Ask the agent instead" as the exit; Continue in panel opens Chat in Notes mode. Related: the shortcut is Cmd+Enter in the footer but the handler accepts Ctrl as well (`quick-ask.html:150`); the footer must show the platform's modifier; mobile has no shortcut and uses the arrow.

**D8. Spec 009 defaults vs no default hotkeys.** Spec 009 sets a global hotkey `Cmd/Ctrl+Shift+K`, a mobile swipe gesture, a popup that "docks to side pane on demand", an agent picker in the popup, a web floating panel, and "one code path: an A2UI surface host with a chat catalog". The operator rule is no default hotkeys; the concept makes the popup a one-shot that hands off. Spec 009 open question 1 asks exactly this. Suggested delta: amend 009's surface table (hotkey and gesture become commands the user binds; popup is one-shot with hand-off; docking replaced by Continue in panel); the "A2UI host with chat catalog" decision stays as a rendering path, not as the popup's identity.

**D9. Lane taxonomy.** Spec 005 defines lanes `local-onnx`, `local-webllm`, `remote-agui` with per-call fallback chains; spec 009 says "offline, local-only badge". The concept's chip has three values, Local, Remote, Offline, where Offline is a connectivity state and always implies a local lane. Examples in the screens conflict: `Local · on device` (Agent), `Local` plus a `title` tooltip (Notes), `Offline · local only` (quick-ask mobile). Suggested delta (uar-engineer to confirm feasibility): define the chip as the lane that produced this turn (`Local` or `Remote`) plus a separate connectivity suffix when the device is offline; every AG-UI turn carries the lane and model used (spec 002 stream and spec 005 do not name such a field); detail text is visible, not a tooltip.

**D10. A local generative model is assumed.** Notes mode "works fully offline … a small local model for the answer" (concept `:158-160`; Local generative model row `Qwen2.5 1.5B · WebGPU` or `Llama 3.2 1B · WASM`, `control-center.html` Agents). Spec 005 lists `local-webllm` on WebGPU-capable devices only and `local-onnx` for small generative models; no spec or run shows WebGPU in the iOS or Android WebView inside Obsidian, and the mvp-08 memory gate is unrun (`mvp-08 README`, "Phone embeddings and acceptance gate"). Suggested delta: Notes mode is specified to degrade to retrieval-only plus Quote only when no local generative lane exists, and the UI never claims "works offline" for answers until a device run records it; the control center's model list is populated from what the lane reports, not a hard-coded list.

**D11. `MarkdownRenderer.render` vs the spec 010 rendering contract.** Concept section 8 renders completed blocks with Obsidian's `MarkdownRenderer.render`. Spec 010 requires DOMPurify (default and svg profiles) on agent HTML, mermaid rendered on tap on mobile, math behind a settings toggle, per-block copy of raw source, code blocks with a language label, copy and wrap toggle, and an incremental block parser. Obsidian's renderer applies its own HTML handling and renders mermaid and math by its own rules; whether that satisfies "DOMPurify default/svg" and the lazy and toggle rules is unverified here. DOMPurify would be a new dependency needing an operator pin in `versions.toml`. Suggested delta: product-manager and the operator choose (1) accept Obsidian's sanitizer and renderer as the contract, amending spec 010 decision 3 and the toggles, or (2) pre-process fences (mermaid, math, svg, html) before handing the rest to `MarkdownRenderer`, adding DOMPurify. The streaming incrementalizer is new code either way.

**D12. The CSS seed is not copy-ready.** README and spec 012 name `assets/obsidian-shell.css` as the starting point for `styles.css`. It contains hex values (palette defaults and `#c4253a`, `#087a36`, `#b35a00`, `#111` on the phone frame), redefines Obsidian's own variables (`--interactive-accent` at 58 percent lightness, `--text-error`, `--text-success`, `--text-warning`), defines names that may be prototype-only (`--anim-in`, `--anim-out`, `--ribbon-width`, `--status-bar-height`, `--tab-height`, `--mono-0`, `--mono-100`; whether each is a real Obsidian variable is not verified here and must be checked against Obsidian's published variable list), uses literal sizes (`11px`, `12.5px`), `z-index: 70`, and `box-shadow` offsets, and carries `ob-*`, `.phone`, `.concept-bar` classes that are shell chrome. The hard rules (no hex, `ipfs-sync-` classes, Obsidian variables only) mean roughly lines 1 to 100 and every `ob-*` and prototype-only class are reference, not source. Also: the concept says `color-mix(in oklch, …)` is available "since 1.13", while `manifest.json` has `minAppVersion` 1.12.3 (and WebView support on the oldest supported iOS is unverified). Suggested delta: record the exclusion list in the design README; scope the contrast fix to a derived variable on `ipfs-sync-*` classes instead of redefining `--interactive-accent`; decide whether `color-mix` raises `minAppVersion` or is avoided.

**D13. Status bar and mobile.** The concept adds a chip beside the existing sync status; the plugin has one status item driven by the pull presenter (`index.ts:160-166`). Two items need a layout decision. Obsidian mobile does not show a status bar (stated from general Obsidian behaviour; verify on device), so lane and index state on phones live only in the Index tab and in a Notice. The Appearance toggle "Show status bar chip" is meaningless on mobile.

**D14. Mobile entry points.** `quick-ask.html:105` and the hint "Tap the agent button below" assume a toolbar button; a plugin cannot add one, the user binds a command in Obsidian's mobile toolbar settings. Concept section 3 already says commands are user-bindable; the mobile instruction copy must say how to add the command, and Settings should link to that. Also two existing ribbon icons plus the new one: ribbon crowding on desktop; decide whether the agent gets one.

**D15. Local store trust: the "caches" lede vs persisted conversations.** Control center Data lede: "Local stores are caches. The vault and its manifest on the node are the truth." and the Rebuild dialog says "Conversations and settings are kept" (`agent-panel.html:242`). chat-00 0.2a says conversations are entities in PGlite, are NOT rebuildable caches, and the local store is plaintext and outside the encrypted-vault threat model. For an encrypted-vault product the user must be told that chat history sits unencrypted on the device and that Wipe local stores deletes it. Suggested delta: split "rebuildable (index, graph)" from "not rebuildable (conversations)" in Data copy; security-reviewer to rule on plaintext transcripts at rest; transcript retention default (concept open question 2) is an operator decision.

**D16. Open questions already carried by the concept and spec 012 (operator, not product-manager).** (1) Search as its own tab vs core search (API does not allow a toggle in core search); (2) transcript retention default; (3) approval granularity; (4) control center replaces or coexists. Plus new from this review: D6 inbox folder, D10 whether Notes mode ships without a generative lane, D11 sanitizer choice.

**Process finding (not a spec conflict).** The design set and spec 012 are untracked, so the "same commit as the change they justify" rule has nothing to attach to yet. Someone with git authority must commit the authority set; I did not (no git writes).

## (e) Proposed implementation order, sizes, owners, and what must not ship in iteration 8

Sizes are my estimates in focused agent-days (one role, native DOM, tests, no device time), not measurements. Device runs (iPhone, Android) are separate operator gates and are not counted.

### Preconditions that are not UI work

| Item | Owner | Why it gates UI |
|---|---|---|
| Spec deltas D1 to D16 resolved or deferred | product-manager, operator | D1, D2, D3, D7, D9 change what is built |
| mvp-08 decision on embeddings (exclude vs own store; phone opt-in) and the PGlite plus ONNX memory run | data-engineer, operator | Index tab, Search, Notes mode cannot be specified truthfully without it |
| Retrieval interface: `search(query, scope) -> rows`, passage records with heading and score, `indexState()` stream, rebuild, pin/exclude context | data-engineer | Shapes every view model |
| AG-UI client, event reducer, lane-used field per turn, offline queue | uar-engineer | Agent mode and lane chip |
| Release tooling accepts `styles.css` | release-deployment-lead | Already optional in `tools/release/constants.mjs:6`; confirm the guard and release descriptors list it |

### Build order (after iteration 9 and the mvp phase closes; a new phase)

| Step | Delivers | Owner | Size | Depends on |
|---|---|---|---|---|
| 1 | `styles.css` foundation: `ipfs-sync-*` tokens bound to Obsidian variables, chip, badge, row, card, dialog, collapsible chunk header; exclusion list from D12 applied; reduced motion; mobile 44 px rules | uiux-lead | 2 | D12 decision; no hex (grep gate) |
| 2 | `src/ui/` DOM kit: `createEl` helpers, `setIcon` chips, `CollapsibleChunk`, `LaneChip`, `SimilarityRow`, `ConsequenceDialog` base (Cancel focus rule per D5), view-model plus view split like `src/plugin/*-dialog*.ts`, copy files | uiux-lead | 3 | Step 1 |
| 3 | Vault agent `ItemView` shell, tabs as view state, commands and ribbon icon, no default hotkeys; Index tab against a stub `indexState` | uiux-lead | 3 | Step 2; retrieval interface |
| 4 | Search tab, text fallback and "no index" and "Index missing" states | uiux-lead; data-engineer for the interface | 3 | Step 3; mvp-08 |
| 5 | Index tab real data, Embed changed, pause on battery, Rebuild consequence dialog | uiux-lead; data-engineer | 3 | Step 4; D2 copy |
| 6 | Status bar chip (and the D13 layout) | uiux-lead | 1 | Step 5 |
| 7 | Notes mode: Retrieved card, passage citations, grounding line, Quote only, context strip, "Not in your notes" refusal, composer, message actions (D6) | uiux-lead; data-engineer for answer pipeline | 6 | Step 5; D10 outcome |
| 8 | Streaming markdown renderer (incremental, per D11), per-block copy, citation chips | uiux-lead | 5 | D11 decision |
| 9 | Agent mode: spec 010 chunk cards, skill card, error card, confirmation card, memory, sources, Stop and "Stopped"; lane chip from the stream | uiux-lead; uar-engineer for the stream | 6 | Step 8; AG-UI client |
| 10 | Quick ask: desktop prompt (Modal or `SuggestModal`), mobile bottom sheet via `Platform.isMobile`, answer mode, Continue in panel | uiux-lead | 4 | Steps 7 and 9; D7, D8 |
| 11 | Control center `ItemView`: search, Sync and Appearance and Data rows that have backing code, Security section hosting the 07b dialogs, Agents section for lane and endpoint | uiux-lead | 6 | D3; real settings events |
| 12 | A2UI basic-catalog projections through the same DOM components (reuse chat-05 1.3 native renderer if it is kept) | uiux-lead; uar-engineer | 4 | Step 9; uar-engineer client |
| 13 | BDD: mixed-turn fixture (spec 010 definition of done) and Notes fixture (grounded, refusal, quote-only); phone-width and theme captures | bdd-engineer | 4 | Steps 7 and 9 |
| 14 | Independent UI review with `prometheus-ui-review` (no taste), security-reviewer on untrusted agent text sinks (no `innerHTML`), operator device runs | reviewers, operator | 3 | Steps 1 to 13 |

Total about 53 agent-days of UI plus roughly the same elsewhere for retrieval and stream. I would not commit to the number: steps 7, 8 and 9 are the ones whose size depends on D10 and D11.

### What must NOT ship in iteration 8 (07b: encryption and key management)

Iteration 8 scope is KBD tasks 1 to 27 plus 37 to 42 (`tasks.md` line 11) with a checkpoint on `key-management-and-prune-script-only`. Reasons are about the tree, not taste:

1. No `src/ui/`, no `styles.css`, no `ItemView`, no new commands, no ribbon icon, no status bar change. The guard and review chain hashes the exact tree (`tools/check-guard-preconditions.mjs:357-362`, task 6.5 "independent review of the exact post-removal tree"; "any later change to a scoped file reopens this task"). A new UI file adds an unreviewed surface to a release whose only claim is encryption and key management.
2. No control center and no move of the 07b Encryption section (D3). The shipped settings tab and dialogs stay the surface of record until 07b closes.
3. No changes to the 07b dialogs for the sake of design convergence (D5: focus and Cancel styling). Record the delta; change nothing until the review that covers those dialogs is finished.
4. No Security-section rows for devices, QR pairing, UCAN grants, Revoke, Direct links, WebRTC or iroh. No engine exists (D4); a UI row for an absent engine is a claim the product cannot keep.
5. No "Index", "Embed", "Rebuild index", "Notes", "Agent", "lane" or "skills" strings visible to users, no empty shells of those tabs, and no copy that says embeddings travel with the snapshot (D2).
6. No React, `assistant-ui`, shadcn, Tailwind or Base UI added to `package.json` or the build for the chat shell (D1). No `chat-02` task starts.
7. No edits to `docs/design/`: iterations are drafted in Open Design and copied in the same commit as the change they justify (operator rule). There is no UI change in iteration 8 to justify one.

What is allowed in iteration 8 from this note: nothing but documentation and the deltas. Task 2.5 (the prune dialog) proceeds under the existing dialog pattern and the 07b copy files; it should follow the D5 rule as written for destructive confirmations (focus Cancel, Cancel first in DOM order) because prune is irreversible, and it should use the same `escapeForDisplay` path for node text as 1.6.

## Recommendation (also in the hand-back)

1. Do not implement any of the agentic UI in iteration 8 or 9. The reasons are D2/D10 (no truthful Index and Notes copy yet), D3/D4 (the control center collides with 07b), and the exact-tree review (6.5).
2. Raise D1 first. It is the only conflict that invalidates a plan already written (six `chat-*` changes). It needs an operator-confirmed supersession and a rename, before anyone spends ZeeSpec or spike time on React.
3. Next phase, after mvp-10 reflects: a new KBD phase `vault-agent-ui` (replacing `chat-react-shell`), Spec then Plan only, seeded from this note, with steps 1 to 3 and 6 above as the first executable slice (CSS foundation, DOM kit, empty `ItemView` shell on a stub index, status chip) because they depend on nothing external; steps 4 and 5 start when mvp-08 lands; steps 7 to 10 start when data-engineer and uar-engineer interfaces exist.
4. Re-check Open Design through the MCP when `open-design` reconnects (read-only `get_project` and `list_files`, project id explicit). On disk, the project's `.file-versions/` holds earlier snapshots and nothing newer than what is in `docs/design/` was found by `cmp`.
5. Someone with git authority commits `docs/design/`, `docs/012-vault-agent-ui.md`, `docs/operator/open-design-mcp.md` and the `.agents/UI_UX_PROTOCOL.md` edit so the authority set exists in history.

## Unverified in this note

- Open Design state beyond the on-disk copy (MCP unreachable).
- Any rendering, contrast, focus or touch-size claim (source read only; no browser, no device).
- Whether the prototype-only CSS variable names are real Obsidian variables, the Obsidian version that supports `color-mix(in oklch)`, and that Obsidian mobile has no status bar.
- Whether Obsidian's `MarkdownRenderer` satisfies spec 010's sanitization and lazy-render rules.
- WebGPU availability inside the iOS and Android WebViews that Obsidian uses.
