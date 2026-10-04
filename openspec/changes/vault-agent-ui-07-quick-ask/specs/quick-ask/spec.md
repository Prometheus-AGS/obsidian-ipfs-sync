## Purpose

Defines the quick-ask popup: a one-shot search or ask that answers through the Notes pipeline and hands the conversation to the panel. It never has its own composer.

## ADDED Requirements

### Requirement: One-shot, no composer
The popup SHALL take one query, SHALL show one answer, and SHALL offer Continue in panel. It SHALL NOT contain a multi-turn composer.

#### Scenario: After an answer
- **WHEN** an answer is shown
- **THEN** the only follow-up action is Continue in panel

### Requirement: Notes pipeline answers
The popup SHALL answer through the Notes pipeline: retrieval, floor, refusal and passage citations. A refusal SHALL offer a text search and Ask the agent instead.

#### Scenario: Weak match
- **WHEN** the best passage is below the floor
- **THEN** no answer is generated and both exits are shown

### Requirement: Hosts
On desktop the popup SHALL be a Modal; on mobile a bottom sheet chosen by the platform, half height by default, expandable, with the input at the top and controls of at least 44 px. The chat bundle SHALL load on first open, not at plugin load.

#### Scenario: Plugin load
- **WHEN** the plugin loads and the popup was never opened
- **THEN** the popup code has not executed

### Requirement: No default hotkey
The entry point SHALL be a command with no default hotkey. The footer SHALL show the platform's modifier. Mobile copy SHALL say how to bind the command.

#### Scenario: Windows
- **WHEN** the popup shows on Windows
- **THEN** the footer shows Ctrl

### Requirement: States
The popup SHALL render distinct states for model loading, error, no index, nothing found, no provider and offline, each with text.

#### Scenario: No provider
- **WHEN** no provider is configured
- **THEN** retrieval and Quote only are offered and the reason is stated

### Requirement: Hand-off
Continue in panel SHALL open the view on the Chat tab in Notes mode with the conversation and SHALL close the popup.

#### Scenario: Continue
- **WHEN** the user presses Continue in panel
- **THEN** the panel shows the same conversation and the popup is closed
