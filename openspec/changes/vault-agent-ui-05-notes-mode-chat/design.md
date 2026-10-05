## Context

Read 2026-10-04: concept A2a; `docs/design/rag-chat.html` (Retrieved card, grounding line at line 176, refusal at 302-305, context strip at 188-196); `docs/010-agentic-ui-rendering.md`; `.agents/skills/ui-markdown-agents/SKILL.md` (chunk table, collapse rules, streaming rules); `chat-03-chat-shell-and-entities/tasks.md` and `chat-04-spec-010-rendering/tasks.md` (tasks folded here); pglite assessment s.5 (`RetrievalService.retrieve` with a refusal floor). Not read: assistant-ui, react-markdown or DOMPurify sources.

## Folded from chat-04 (section 1) and chat-03 (section 2)

chat-04 0.2 block chrome, 1.1 GFM, 3.1 code, 3.2 mermaid (measure then decide), 3.3 sanitizer, 3.4 media (remote media loads only after a tap, a proposal pending the operator, per chat-04 3.4), 3.5 math behind a toggle, 4.1 copy at two levels, 5.1 collapse rules, 10.1 incremental parse and the Stopped marker are executed as written with the layering and styles contract of slice 01. chat-03 2.3 (runtime adapter, the only code importing assistant-ui's runtime) and 3.1 (Thread, composer, states) too, minus the entity persistence (slice 11). The fixtures of chat-04 0.1 are built here for the parts used by Notes, and extended in slice 06.

Transcript-view gate (D1): after the first working Notes turn on the native-plus-React stack, the operator-run iPhone cold-start and a defined list of transcript shortfalls are recorded. Outcome is stay as built or open a separate proposal; this set does not reopen D1.

## Notes pipeline (service, no React)

`src/agents/notes-answer/` takes ports: retrieval (slice 04 B's port with a floor), provider (slice 02) and clock. Steps: retrieve passages within the chat's collection scope; if the best score is below the floor (a user setting; the prototype used 0.60) return a refusal result with the near misses and generate nothing; else build the prompt from the passages only and stream the answer; each sentence carries passage markers supplied by the pipeline; Quote only returns verbatim sentences from the passages, each cited. With no provider and no local lane the pipeline offers retrieval and Quote only. The prompt says to answer only from the passages; whether a model obeys is not verified, which is why the UI counts markers and does not claim support.

## UI

Mode switch (Notes default), scope chip (collection), lane chip, Retrieved card per assistant turn (collapsible: note, heading, similarity bar with text, excerpt as text nodes, Open at heading, Pin, Exclude), citations as superscripts linked to passage rows, grounding line wording "cited" per P1, context strip (passages sent, pinned, Quote only toggle), refusal card with two exits (text search for the phrase, Ask the agent instead), composer with `/search` and `/save` only. Disclosure line per provider and mode (slice 02 consent) is visible before the first send. Conversation memory is pinned passages plus the last turns; a follow-up re-retrieves with the question and the previous answer.

## Host actions

Open at heading: `openLinkText` with a `Note#Heading` link (API checked present); the block flash is unverified and may be dropped. Save as note: writes to the inbox folder (D16 question 5; refuse until set) with a name accepted by `src/sync/path-policy.ts` and no silent overwrite. Insert at cursor: the active editor, refused with a notice when none. Copy: raw markdown source. All three are user-initiated.
