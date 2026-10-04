## Purpose

Defines the transcript kit shared by Notes and Agent modes: markdown, one sanitizer, copy at two levels, collapse rules and incremental streaming. It restates the parts of spec 010 that Notes mode needs; slice 06 adds the remaining chunk renderers.

## ADDED Requirements

### Requirement: Markdown everywhere
User and assistant messages SHALL render as GFM. Message copy SHALL write the raw markdown source held in the text part, not the rendered text.

#### Scenario: Copy
- **WHEN** the user copies a message containing a table
- **THEN** the clipboard receives the exact source string

### Requirement: One sanitizer module
Raw HTML from agents or models SHALL pass through one sanitizer module, the only file allowed to set HTML, built for the window that owns the target element. Remote images and video SHALL NOT load before a user tap unless the operator decides otherwise, and the URL SHALL be shown.

#### Scenario: Script in HTML
- **WHEN** model text contains a script element, an event handler attribute or a `javascript:` link
- **THEN** it is removed or neutralised

### Requirement: Code, mermaid and math
Code blocks SHALL show a language label, a copy action and a wrap toggle, and an unknown language SHALL render as preformatted text. Mermaid SHALL render on tap on mobile and its output SHALL pass the sanitizer, or SHALL show a labelled placeholder if the operator decides not to embed it. Math SHALL be behind a settings toggle.

#### Scenario: Mobile mermaid
- **WHEN** a mermaid block scrolls into view on a phone
- **THEN** no render starts until a tap

### Requirement: Collapse rules
Non-text chunks SHALL be expanded while their turn streams and collapsed when it ends. A user override SHALL persist for the session. Header shape SHALL be icon, title, one-line summary and chevron, and the header SHALL be a button with `aria-expanded`.

#### Scenario: Turn ends
- **WHEN** a turn completes
- **THEN** its non-text sections are collapsed and the user's earlier expansion of one is kept

### Requirement: Incremental streaming
The renderer SHALL parse at block level with a cached tree; a token SHALL re-parse only the open block. Chunks SHALL append in arrival order. Cancel SHALL keep partial content and show a terminal Stopped marker. Streaming text SHALL reach a polite live region once per sentence, not per token.

#### Scenario: Long message
- **WHEN** 1,000 tokens stream into a 50-block message
- **THEN** the full-document parse runs at most once per completed block

### Requirement: Links
Link targets SHALL be accepted only for an allowlisted scheme set. Wikilinks SHALL open through a host callback. Callouts and embeds SHALL render as text in v1.

#### Scenario: Data URL link
- **WHEN** text contains a `data:` link
- **THEN** no link is rendered
