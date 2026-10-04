# Spec 012 — Vault agent UI: surfaces, modes and design authority

Status: **design decisions — operator-reviewed concept, 2026-10-04.**
Implements: specs 002, 009, 010, 011 Q7. Consumes: specs 005, 006.
Authority: `docs/design/vault-agent-ui-concept.md` and the screens beside it
(`docs/design/README.md` lists them). This file is the pointer the numbered
spec series needs; the detail lives in the design folder and is not repeated
here.

## What is being built

A plugin surface set that reads as a core Obsidian plugin and makes three
facts legible everywhere: the embedding index is a rebuildable cache, which
lane produced an answer (Local, Remote, Offline), and which skills an agent
invoked.

| Surface | Host | Purpose |
|---|---|---|
| **Vault agent view** | right-sidebar `ItemView`, tabs Search / Chat / Index | Semantic search with similarity-scored rows; chat; index state and control |
| **Chat · Notes mode** (default) | tab of the view | Retrieval-augmented chat over local embeddings: Retrieved-passages card, passage-level citations, grounding line, pin/exclude, Quote only, "Not in your notes" refusal; writes nothing |
| **Chat · Agent mode** | tab of the view | Agentic chat per spec 010: skill cards, tool calls, thinking, memory, sources, errors, approval cards for mutating tools |
| **Quick ask** | desktop `Modal` prompt / mobile bottom sheet | One-shot search-or-ask that hands off to the view |
| **Control center** | main-area `ItemView` | Searchable settings in six sections (Sync, Security, Agents, Direct links, Data, Appearance); consequence dialogs |
| **Status bar chip** | status bar | Index coverage and lane; opens the Index tab |

## Decisions

1. Native Obsidian DOM, no React island in v1; A2UI basic catalog renders
   through the same components (spec 002 option 1).
2. Styling binds only to Obsidian CSS variables via `ipfs-sync-` classes in
   one `styles.css`; the user's accent is the sole accent; no hex, fonts or
   gradients of our own. Obsidian's default light accent fails 4.5:1 with
   white small text; accent-filled controls are icon buttons or use a darker
   derived fill, as the concept records.
3. Notes mode is the default chat and never answers from model knowledge.
4. Quick ask never gains its own composer.
5. Settings move to the control center; the native settings tab becomes a
   stub that opens it.
6. No default hotkeys; every entry point is a command the user binds.
7. Mobile: bottom sheet for quick ask, 44 px targets, lazy mermaid/KaTeX on
   tap, index eviction surfaces as "rebuild", never as silent failure.

## Ownership

- `uiux-lead` owns `src/ui/`, `styles.css` and `docs/design/`; it implements
  from the concept and raises conflicts with specs as spec deltas, not as
  silent deviations.
- `data-engineer` supplies the retrieval and index-state interfaces the
  Index tab and Notes mode consume (spec 006).
- `uar-engineer` supplies the AG-UI stream and lane selection the Agent mode
  consumes (spec 005).
- `bdd-engineer` owns the mixed-turn rendering fixture (spec 010 definition
  of done) and a Notes-mode fixture: grounded answer, refusal below floor,
  quote-only answer.

## Open questions carried from the concept

Search as a separate tab vs. a toggle in core search (API does not allow the
latter); transcript retention default; approval granularity; whether the
control center fully replaces the native tab. See the brief, §9.
