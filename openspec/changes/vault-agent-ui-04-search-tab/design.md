## Context

Read 2026-10-04: concept A1 and section 6, `docs/design/agent-panel.html` Search tab, pglite assessment s.5 (`RetrievalService.search` proposal: request with query, scope, k, mode `semantic` or `text`; result with passages, coverage, model key or null on text fallback, lane), obsidian.d.ts (`Vault.getMarkdownFiles`, `Vault.cachedRead`, `Workspace.openLinkText`).

## Layers

```
src/ui/search/components/  search field, scope chips, result row, coverage line, states (hooks only)
src/ui/search/hooks/       use-search
src/data/search/           vanilla zustand: query, scope, results, state machine; calls the services
src/agents/text-search/    text search service over injected ports (list files, read file, abort)
(retrieval service)        provided by the data phase; consumed through a port
```

## State machine

`idle` (no query), `searching`, `results`, `empty` (no match, suggests fewer words or wider scope), `no-index` (text fallback active, with the "build the index" copy that names collections), `index-missing` (evicted: "Index missing on this device", offers rebuild, falls back to text), `model-loading` (design gap, drawn first), `embed-failed` (design gap, drawn first). The mode flips to text whenever the retrieval port returns no model key.

## Text search (Part A)

Case-insensitive substring over note text within the chosen scope. Bounded: a result cap, a file count cap per run with a visible "searched N of M notes" line, yields to the event loop between files, cancels on a new keystroke or tab change. Folder and since scopes come from file paths and mtimes; tag scope from the metadata port. The collection scope uses slice 03's membership once it exists; before then the scope is whole vault, folder, tag, since. Excerpts are note text and render as text nodes with the match wrapped by a mark element built from offsets, never `innerHTML`.

## Rows and honesty

Title, folder path, similarity bar plus the percentage as text, two-line excerpt. Header: lane chip with visible model detail (D9, not a tooltip) and "Searching X of Y notes · Z queued" linking to the Index tab, where X, Y and Z come from the index port and never from literals. Row actions Open (`openLinkText`) and Insert link; Add to chat appears with slice 05. Titles draggable into the editor: unverified from a React element; the task records the result. No digit in the UI is scripted.
