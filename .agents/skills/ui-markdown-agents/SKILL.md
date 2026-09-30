---
name: ui-markdown-agents
description: >
  Rendering contract for the agentic chat UI (specs 002/009/010): markdown
  for user and assistant messages, every AG-UI event/chunk type, markdown
  extensions (code, mermaid, SVG, images, video), copy at message and block
  level, and collapsible presentation of thinking, citations, memory recall,
  error, and skill-activation chunks. Use when implementing or reviewing any
  agent-message rendering, chat surface, or popup chat component.
license: MIT
metadata:
  author: prometheus-ags
  version: '1.0.0'
  category: design
  tags: [ag-ui, a2ui, markdown, chat-ui, react, obsidian]
user-invocable: true
---

# ui-markdown-agents

The full rendering contract for agent surfaces in this project: the AG-UI/A2A
client (spec 002), the popup chat (spec 009), and any settings/help surfaces
that render agent output. If a chunk type exists on the wire, the UI renders
it — silently dropping a chunk type is a rendering bug, not a style choice.

## Surfaces

- **Chat thread** (popup + docked): user and assistant turns, full chunk set.
- **Agent management** (spec 002): agent cards, run lists, rendered outputs.
- **Settings** (spec 011 Q7): feature-rich settings UI — every toggle in this
  contract is user-configurable (e.g. "auto-expand thinking", "render mermaid").

## Markdown (all message bodies)

Both user and assistant messages render as markdown. Requirements:

- GFM: tables, task lists, strikethrough, autolinks.
- Code blocks: syntax-highlighted, with language label, **copy button per
  block**, and wrap/scroll toggle. Fenced blocks with unknown language render
  as plain preformatted text, never raw.
- Extensions, each with graceful degradation to a labelled placeholder when
  disabled or unsupported:
  - **Mermaid** → rendered diagram (lazy-rendered offscreen; mobile renders
    on tap, not on scroll, for battery).
  - **SVG** → inline-sanitized render (strip scripts/events; DOMPurify
    profile `svg`).
  - **Images** → lazy-loaded, click-to-fullscreen, alt text always visible.
  - **Video** → native controls, never autoplay, poster frame optional.
  - Math (KaTeX) — included because agent outputs use it, gated behind the
    same settings toggle pattern.
- Raw HTML in agent markdown is sanitized (DOMPurify default profile) — agent
  output is untrusted input.

## Copy/paste

- **Message level**: every message (user and assistant) has a copy action
  copying the complete raw markdown source, not the rendered text.
- **Block level**: code blocks, tables, and each collapsible chunk section
  have their own copy action copying that block's source.
- Copy must preserve source fidelity (what-you-copied-is-what-the-agent-said),
  because users paste outputs into their vault notes.

## AG-UI chunk rendering (complete set)

| Chunk | Render |
|---|---|
| `TEXT_MESSAGE_CONTENT` | Streaming markdown per above. |
| `TOOL_CALL_START/ARGS/END` | Collapsible tool-call card: tool name, live args stream (JSON, syntax-highlighted), result; spinner while running; error state red. |
| `STATE` (snapshot/delta) | "State updated" chip with expandable JSON diff; compact by default. |
| `DATA` | Labelled data pill; expandable. |
| `CONFIRMATION_REQUEST` / `CONFIRMATION_RESPONSE` | Inline confirm/deny buttons (spec 002 interaction); the request card stays in-thread with the chosen outcome recorded. |
| `SKILL_ACTIVATION` | **Skill card**: skill name, source (project/user/plugin), one-line description, arguments summary; expandable to full skill body on demand; running state shows elapsed time. Never hidden — users must see what skills an agent invokes. |
| `MEMORY_RECALL` | Collapsible "Memory" section listing recalled entries (source, relevance, timestamp); each entry expandable; hover/long-press to inspect. Distinct iconography from citations. |
| `CITATION` / sources | Inline superscript numbers linking to a Sources section; citation chip shows title + URI; click opens source (vault note → Obsidian open; web → browser). |
| `ERROR` | **Collapsible error card**: one-line summary (error type + message), collapsed by default after the turn completes, expanded shows the full error — stack, request context, chunk payload — copyable as text. While the turn is running, errors auto-expand. Never swallow: the user must always be able to reach the full error. |
| `THINKING` | Collapsible "Thinking" section; streaming state shows animated placeholder; auto-expands while streaming if the user setting allows, collapses on completion. Thinking text renders as markdown but with muted styling. |

## Collapse behavior (uniform rules)

- All non-text chunks (tool calls, thinking, memory, sources, errors, skill
  activations, state) render as collapsible sections with a consistent header
  row: icon + title + one-line summary + chevron.
- Default state: expanded while their turn/stream is active; collapsed when
  the turn ends (errors excepted while running — see above).
- User override sticks per-session; the settings UI exposes global defaults
  (spec 011 Q7).

## Streaming behavior

- Text streams token-by-token into the markdown renderer; the renderer
  incrementalizes (do not re-parse the whole document per token — parse
  block-level, cache AST).
- Chunk interleaving is the norm (text → tool call → text): the thread
  appends in arrival order, no re-grouping.
- Cancel renders a terminal "Stopped" marker with the partial content kept.

## A2UI projections

When the endpoint returns an A2UI surface instead of chat chunks (spec 002),
the same surface renders the typed projection: forms, buttons, cards per the
A2UI renderer contract (`a2ui-surface-contract` skill). Chat chrome
(copy/collapse) wraps A2UI blocks the same way it wraps markdown blocks.

## Platform constraints

- Obsidian WebView (desktop + mobile): no native modules; sanitization and
  mermaid run in the WebView thread — lazy-load heavy renderers (mermaid,
  KaTeX) on first use, cache thereafter.
- Long-press equals right-click for block actions on mobile.
- All interactive elements meet 44×44 pt touch targets.

## Definition of done (rendering)

A turn containing text + code + mermaid + a tool call + an error + a skill
activation + memory recall + citations renders completely on desktop and
mobile WebViews, every block is copyable, every non-text chunk collapses, and
no chunk type is dropped. This exact mixed fixture is the BDD scenario the
`bdd-engineer` owns.
