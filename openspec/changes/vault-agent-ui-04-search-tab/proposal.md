## Why

The design's Search tab finds notes by meaning, with scope chips, similarity rows, a coverage line and a text fallback (`docs/design/vault-agent-ui-concept.md` A1; `docs/design/agent-panel.html:105-120,282-313`). Semantic search needs an index that no plan builds. Text search does not.

The uncomfortable parts:
- **Part B depends on phases that do not exist.** Semantic rows need a retrieval service over PGlite vectors, an embedding provider and per-collection scope (slice 03 B). mvp-08 does not build them (`mvp-08-sync-history-store/README.md`; `DESIGN.md` section 7 "decision pending, specs TBD").
- **Part A duplicates Obsidian's core search.** A text-only Search tab is a worse core search. Open question 1 of the concept (own tab versus core search; the API allows no "by meaning" toggle in core search) is the operator's. Recommended (D16): own tab, kept behind the preview gate until Part B works. Part A exists because the design needs a "no index" state and spec 009 names a grep fallback.
- **Text fallback cost is unmeasured.** Reading every note with `Vault.cachedRead` on a large vault on a phone may be slow; the design says nothing about a loading state, a cancel, or a cap.
- **The design has gaps:** no loading state while the embedding model loads (the slow step on a phone), no error copy for a failed embed (report c.1), and a similarity bar that must show the percentage as text.
- **Row actions depend on later slices.** "Add to chat" needs slice 05; it is absent until then, not disabled.

## What Changes

- Part A: text search with scope chips (whole vault or collection, folder, tag, since), result rows, bounded and cancellable, honest "no index" copy.
- Part B: semantic rows with similarity percentage as text, excerpt with matched span, coverage line with queued count linking to the Index tab, lane chip with visible detail, collection scope, states for no index, evicted index, no match, model loading and embed failure.
- Row actions: Open, Insert link; Add to chat once slice 05 ships. Title drag into the editor if feasible.

## Capabilities

### New Capabilities
- `vault-agent-search`: the Search tab behaviour, states and honesty rules.

### Modified Capabilities
<!-- none -->

## Impact

- Code: `src/ui/search/` (components, hooks), `src/data/search/` (store; calls the retrieval and text-search services), `src/agents/text-search/` (service over injected vault ports), `src/plugin/` host wiring for open and insert-link, copy files, `tests/`, `features/`.
- Dependencies: none for Part A.
- Cadence: reviewers dormant until the phase gate; excerpts and titles are note text and render by text node only.

Blocked on: Part A: slice 01. Part B: slice 03 B, the data phase's retrieval service, D2, the model-load and error designs, D16 question 1; Add to chat: slice 05.
