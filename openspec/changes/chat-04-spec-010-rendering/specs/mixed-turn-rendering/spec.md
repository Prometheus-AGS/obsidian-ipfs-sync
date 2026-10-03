## Purpose

Makes the spec 010 definition of done testable: one fixture holds every element the contract names, and the scenarios say what must be observable in the DOM. Spec 010 is not edited here; this spec states how it is checked. The fixture page proves rendering logic, not Obsidian behaviour.

## ADDED Requirements

### Requirement: Mixed-turn fixture
The `mixed-turn` fixture SHALL contain, in one assistant turn, streaming text, a fenced code block, a mermaid block, a tool call with arguments and result, an error, a skill activation, a memory recall with entries, and citations. The `all-chunks` fixture SHALL contain one event of every kind in the chunk table of the `ui-markdown-agents` skill and one event with an unrecognised name.

#### Scenario: Mixed turn renders completely
- **WHEN** the `mixed-turn` fixture streams to completion
- **THEN** the DOM holds one element per content kind with `data-chunk-kind`, in arrival order, and none is missing

### Requirement: No dropped chunk kind
Every chunk kind, including an unrecognised one, SHALL render as a visible element carrying `data-chunk-kind`. The renderer registry SHALL fail type-checking when a part kind lacks a renderer.

#### Scenario: Unknown event
- **WHEN** the `all-chunks` fixture streams
- **THEN** the unrecognised event renders an `unknown` block showing its name and payload

### Requirement: Collapse behaviour
Non-text chunks SHALL be expanded while their turn streams and collapsed when it ends, except that errors are expanded while the turn runs and collapsed to a one-line summary after it ends, and a skill card stays visible with only its body collapsed. A user override SHALL persist for the session.

#### Scenario: Turn ends
- **WHEN** the turn completes
- **THEN** the tool call, thinking, memory and citation sections are collapsed, the error shows its one-line summary, and the skill card is still in the thread

### Requirement: Copy sources
Message-level copy SHALL write the raw markdown source of the message. Block-level copy SHALL write the source of the code block, table or chunk section.

#### Scenario: Copy a message
- **WHEN** the user copies the assistant message
- **THEN** the clipboard text equals the concatenated markdown source received on the wire, including the fenced code block and the mermaid fence

### Requirement: Skill activations are always visible
A skill activation SHALL render a card with name, source, one-line description, arguments summary and elapsed time while running, and SHALL be expandable to the full skill body. It SHALL NOT be hidden or removed by any collapse rule or setting.

#### Scenario: Skill card present
- **WHEN** the fixture streams a skill activation
- **THEN** the card is in the DOM at every turn state, running and complete

### Requirement: Sanitized agent content
Agent HTML SHALL pass the default DOMPurify profile and SVG the `svg` profile, built for the window that owns the target. Remote images and video SHALL NOT trigger a network request before the user's tap unless the user disabled that protection (proposed, pending operator confirmation).

#### Scenario: Hostile markup
- **WHEN** an agent message contains `<img src=x onerror=...>` and `<svg onload=...>`
- **THEN** the rendered DOM contains neither handler

### Requirement: Streaming and cancel
Streaming SHALL parse incrementally, not re-parse the whole document per token. Cancel SHALL keep partial content and render a terminal "Stopped" marker.

#### Scenario: Cancel
- **WHEN** the user cancels mid-stream
- **THEN** the partial text remains and the marker appears
