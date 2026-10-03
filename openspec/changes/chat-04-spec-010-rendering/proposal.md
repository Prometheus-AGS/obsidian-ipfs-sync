## Why

Spec 010 (operator decisions 2026-09-29) fixes what the chat must render: markdown everywhere, every chunk type, extensions, copy at two levels, collapsible non-text chunks, errors, always-visible skill activations, thinking, memory recall, streaming and A2UI chrome. Its normative table is in `.agents/skills/ui-markdown-agents/SKILL.md`. assistant-ui gives message parts and tool UI slots. It does not give skill cards, memory sections, citation lists or error cards; the assessment ranks that as custom work (risk 6). This change turns each decision into a task with an observable check, and makes the definition of done (decision 12) a BDD scenario owned by bdd-engineer.

The uncomfortable parts:
- **Heavy renderers have no measured size.** Mermaid, KaTeX and a syntax highlighter were not in the scratch builds. In a plugin they cannot load from a CDN, so "lazy-loaded" means "inside `main.js`, evaluated late". The file still grows and is read at every launch. Each library gets a measurement and an operator decision before it is pinned; mermaid may end as a labelled placeholder.
- **The fixture page is not Obsidian.** BDD against a Chromium page proves the rendering logic. It does not prove the cascade against Obsidian's stylesheet, the WKWebView keyboard, or the popout window. Those claims come from operator device runs only. A "mixed turn renders on desktop and mobile WebViews" statement is true only after the operator has seen it on the phone.
- **Agent content is untrusted.** Spec 010 asks for raw HTML, SVG, images and video from agent output. A remote image URL can carry data in its query string to a third party the moment it loads. This change proposes that remote media load only after a tap by default; spec 010 does not say that, and the operator confirms or rejects it.
- **Skill cards must never be hidden** (spec 010 decision 7, an operator requirement). A renderer bug that drops one is a defect of the audit trail, not of style. The exhaustiveness check and the BDD assertion exist for that reason.
- **Confirmation requests are in the chunk table**, but how a confirm or deny goes back to the agent is not read (chat-03 2.1 records it). Approval granularity (spec 009 open question 3) is not decided; this phase offers per-request confirm only.

## What Changes

- A block chrome component (icon, title, one-line summary, chevron, copy) shared by every non-text chunk and, in chat-05, by A2UI blocks.
- A renderer registry with a compile-time exhaustiveness check over the part-kind union, and a visible renderer for `unknown`.
- Markdown (GFM) for user and assistant messages with incremental block-level parsing.
- Extensions: highlighted code with per-block copy, mermaid, sanitized SVG, images, video, math behind a toggle. One sanitizer module.
- Message-level and block-level copy of raw source.
- Collapse rules with per-session override and global defaults in settings.
- Error cards, skill cards, thinking, memory recall, citations, confirmation requests.
- Fixtures `mixed-turn` and `all-chunks`, a fixture page, and BDD scenarios.

## Capabilities

### New Capabilities
- `mixed-turn-rendering`: the mixed-turn fixture, the all-chunks fixture, what each chunk renders as, collapse and copy behaviour, sanitization outcomes, the skill-card rule.

### Modified Capabilities
<!-- none: spec 010 is not edited by this change -->

## Impact

- Code: `src/ui/chat/components/`, `src/ui/chat/sanitize/`, `src/ui/chat/hooks/`, settings additions in `src/plugin/settings-tab-chat.ts`, `features/`, `tests/fixtures/`, a fixture page under `tests/support/`.
- Dependencies, all pending the operator's pins after measurement: a syntax highlighter, mermaid, KaTeX; `remark-gfm` and `dompurify` already in the README list. No pin is chosen here.
- `main.js` grows by whatever the operator accepts for the heavy renderers.
- Cadence: reviewers dormant until the phase gate; the independent review reads the sanitizer module first.
