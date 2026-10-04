## Why

Notes mode is the default chat: retrieve passages from the local index, answer only from them, cite at passage level, take no write actions, show "Not in your notes" below a floor (`docs/design/vault-agent-ui-concept.md` A2a; `docs/design/rag-chat.html`). This slice also builds the transcript kit that Agent mode reuses: the part of `chat-04` that Notes needs first (block chrome, GFM, sanitizer, code, copy, collapse, incremental parse) and the assistant-ui runtime adapter and Thread of `chat-03`. D1 decided React 19, shadcn and assistant-ui; see `decisions-needed.md` D1 for the fold.

The uncomfortable parts:
- **Retrieval does not exist.** Notes mode retrieves from an index that no plan builds. Without slices 03 B and 04 B it has nothing to show. Quote only needs retrieval too.
- **The generative lane is unproven.** "Works fully offline" assumes a small local model. No run shows WebGPU in the iOS or Android WebView, and the mvp-08 iPhone gate is unrun; `mvp-10-real-vault-publish-and-release/README.md` bars any airplane-mode or on-device-AI claim before that run (D10). With a provider from slice 02, answers are Remote and disclosed. Without either, Notes mode is retrieval plus Quote only.
- **The grounding badge claims more than the UI can verify.** "grounded · 3 cited · 0 without a source" would assert support. The UI can count only markers that resolve to retrieved passages and, in Quote only, quotes that are substrings of a passage (P1). It never infers attribution from prose.
- **Notes mode "writes nothing", yet Save as note and Insert at cursor write** (D6). They are user-initiated, never automatic.
- **Note text goes to a provider.** Excerpts and the question are sent to the chosen provider (slice 02 consent). Note content can carry instructions; Notes mode has no tools, so injection can change an answer but cannot write.
- **Streaming markdown is new work** with react-markdown, remark-gfm and DOMPurify behind it, none pinned (D11). Vault-faithful callouts, embeds and wikilinks do not render like the vault; wikilinks open by callback, callouts and embeds show as text in v1.
- **Persistence is not here.** Conversations live in memory for the session until slice 11 A ships and the D15 ruling lands.

## What Changes

- Section 1: transcript kit (chat-04 0.2, 1.1, 3.1 to 3.5, 4.1, 5.1, 10.1) and the transcript-view gate.
- Section 2: runtime adapter, Thread, composer (chat-03 2.3, 3.1) over an in-memory conversation store.
- Section 3: Notes mode: Retrieved card, passage citations, grounding line, Quote only, context strip, refusal, composer limits, message actions.
- Section 4: host actions: open at heading, Save as note, Insert at cursor, Copy.
- Section 5: BDD fixture (grounded, refusal, Quote only).

## Capabilities

### New Capabilities
- `notes-mode-chat`: retrieval-bound answers, citations, refusal, Quote only, actions.
- `transcript-rendering`: markdown, sanitizer, block chrome, copy, collapse, streaming parse.

### Modified Capabilities
<!-- none -->

## Impact

- Code: `src/ui/chat/` (components, hooks, mount, sanitize), `src/data/chat/` (in-memory store), `src/agents/notes-answer/` (service over ports: retrieval, provider), `src/plugin/` host actions, copy files, `features/`, `tests/`.
- Dependencies: operator pins (react-markdown, remark-gfm, DOMPurify, assistant-ui, shadcn) per `tasks.md` 0.5.
- Cadence: reviewers dormant until the phase gate; sanitizer, link handling and note writes are in the security review scope.

Blocked on: slice 01, slice 02 (a provider, or Quote only), slice 03 B and 04 B (retrieval and collection scope), D6, D10, D11, P1; for any persistence, slice 11 and the D15 ruling.
