# Design: Vault agent (agentic search, Notes chat, Agent chat)

This folder is the design authority for the plugin's agentic layer: the
surfaces the `uiux-lead` role builds and every other role reads before
touching anything the user sees. It was produced in the Open Design project
`Obsidian agentic search UI concept` (id `aca77082-f254-4ccf-96da-66844bd88e46`,
see `docs/operator/open-design-mcp.md`) and copied here on 2026-10-04. The
Open Design project is where new iterations are drafted; this folder is the
copy of record that the team reads.

## Read in this order

1. `vault-agent-ui-concept.md` — the brief. Research findings (Obsidian plugin
   guidelines, CSS variables, leading AI plugins), principles, entry points,
   every surface in detail, token mapping, mobile, accessibility,
   implementation notes, open questions, and the decisions taken.
2. `index.html` — launcher. Opens the screens and shows the token map.
3. `agent-panel.html` — the sidebar view in **Agent** mode: Search, Chat,
   Index tabs; a streamed turn with every chunk type from spec 010 (skill
   card, thinking, tool call, skipped remote tool, memory recall, cited
   answer, sources, approval card); the rebuild consequence dialog.
4. `rag-chat.html` — the same view in **Notes** mode (retrieval-augmented
   chat, the default): Retrieved-passages card with pin/exclude,
   passage-level citations wired to the editor block, grounding line,
   Quote-only toggle, context budget, and the "Not in your notes" refusal.
5. `quick-ask.html` — the one-shot popup: desktop prompt with answer mode,
   mobile bottom sheet.
6. `control-center.html` — the searchable settings view, six sections,
   Security first-class, consequence dialogs.
7. `assets/obsidian-shell.css` — Obsidian's own CSS variable names with their
   documented default values (light and dark) plus the `ipfs-sync-` component
   styles the screens share. This is the starting point for the plugin's
   `styles.css`.

Open any screen directly in a browser; the files are self-contained apart
from the shared stylesheet. The screens have a light/dark toggle and working
interactions; all data is scripted and nothing calls a node or a model.

## Decisions the screens encode (do not re-open without an operator decision)

- One right-sidebar `ItemView` ("Vault agent") with three tabs: Search, Chat,
  Index. The Chat tab has a two-position switch: **Notes** (RAG, default) and
  **Agent** (skills, tools, approvals).
- Quick ask is a one-shot popup that hands off to the view; it never grows its
  own composer. Desktop: `Modal` styled as a prompt. Mobile: bottom sheet.
- Settings live in a control center view (spec 011 Q7); the native settings
  tab stays as a trimmed stub.
- Native Obsidian DOM (`ItemView`, `Modal`, `Setting`, `setIcon`,
  `MarkdownRenderer`). No React island in v1. The A2UI basic catalog maps to
  the same components (spec 002 option 1).
- Styling binds only to Obsidian CSS variables through `ipfs-sync-` classes
  in one `styles.css`. No hex values, no custom fonts, no gradients. The
  user's accent is the only accent.
- Three facts must be legible on every agent surface: the index is a
  rebuildable cache; which lane answered (Local, Remote, Offline); which
  skills the agent invoked (never hidden, per spec 010).
- Notes mode never answers from the model's own knowledge. Below the
  similarity floor it shows "Not in your notes" and offers text search or the
  Agent mode.
- Every destructive or trust-changing action opens a consequence dialog with
  Cancel first and focused.

## Relation to the numbered specs

The brief implements specs 002 (AG-UI/A2UI client), 009 (popup chat), 010
(rendering contract) and 011 Q7 (control center), and consumes 005 (lanes)
and 006 (stores). Where the brief and a spec disagree, the brief is the newer
decision and the spec should be amended through `product-manager`. Spec 012
(`docs/012-vault-agent-ui.md`) records the pointer and the decisions above.

## Updating this folder

Draft changes in the Open Design project, then copy the changed files here in
the same commit as the spec or code change they justify. Keep file names
stable; the HTML cross-links by name. Do not hand-edit the copies here without
also updating the Open Design project, or the two drift.
