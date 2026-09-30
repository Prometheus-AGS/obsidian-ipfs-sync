# Spec 010 — Agentic UI Rendering Contract

Status: **spec — operator decisions 2026-09-29 (items 0 and "skill activations").**
Audience: uiux-lead, uar-engineer, bdd-engineer. Normative content lives in
the `ui-markdown-agents` skill (`.agents/skills/ui-markdown-agents/`); this
spec records the decisions and their rationale.

## Decisions

1. **Markdown everywhere.** User and assistant message bodies both render as
   markdown (GFM). Copy actions copy raw markdown source, never rendered
   text — users paste into vault notes.
2. **Full AG-UI chunk coverage.** Every event/chunk type renders; a dropped
   chunk type is a bug. The normative table is in the skill (`SKILL.md`).
3. **Markdown extensions**: code blocks (highlighted, per-block copy),
   mermaid (lazy, tap-to-render on mobile), SVG (sanitized inline),
   images (lazy, fullscreen on click, alt visible), video (native controls,
   no autoplay), math/KaTeX behind a settings toggle. Raw agent HTML is
   sanitized (DOMPurify); SVG uses the stricter svg profile.
4. **Copy/paste at two levels**: message-level (raw source) and block-level
   (code blocks, tables, every collapsible chunk section).
5. **Collapsible non-text chunks**: thinking, tool calls, citations/sources,
   memory recall, state deltas, data — collapsed on turn completion,
   expanded while streaming, per-session user override, global defaults in
   settings.
6. **Errors**: collapsible error cards — one-line summary collapsed by
   default after turn end, full error (stack, request context, chunk payload)
   always reachable and copyable; auto-expanded while the turn is running.
7. **Skill activations are always visible.** A `SKILL_ACTIVATION` chunk
   renders a skill card: name, source (project/user/plugin), one-line
   description, args summary, running state with elapsed time, expandable to
   the full skill body. Never hidden, never silent — the user must be able
   to audit what skills an agent invoked. This is an operator requirement,
   not a style preference.
8. **Thinking chunks** render in collapsible muted sections; auto-expand
   while streaming if the user setting allows.
9. **Memory recall** gets iconography distinct from citations; each recalled
   entry shows source, relevance, timestamp.
10. **Streaming**: incremental block-level parse (no full re-parse per
    token); chunks append in arrival order; cancel keeps partial content
    with a terminal "Stopped" marker.
11. **A2UI projections** render through the typed A2UI renderer with the
    same chat chrome (copy/collapse) wrapping blocks.
12. **Definition of done**: the mixed-turn fixture (text + code + mermaid +
    tool call + error + skill activation + memory recall + citations) renders
    completely on desktop and mobile WebViews; BDD scenario owned by
    bdd-engineer (`features/`).

## Platform constraints

Obsidian WebView only (desktop Chromium + iOS WKWebView + Android WebView):
no native modules; mermaid/KaTeX lazy-loaded on first use; long-press equals
right-click; 44×44 pt minimum touch targets.
