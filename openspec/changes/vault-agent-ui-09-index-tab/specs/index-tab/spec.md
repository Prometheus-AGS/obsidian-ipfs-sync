## Purpose

Defines the Index tab on real state: what it shows, the actions, the statement that the index is local and rebuildable, and the rebuild consequence dialog. Numbers come from the index service or are shown as unknown.

## ADDED Requirements

### Requirement: Real state only
The tab SHALL show model, dimensions, where it runs, size, last rebuilt, counts and per-file states from the index service. A value the service cannot supply SHALL render as unknown. Production code SHALL NOT contain scripted index numbers.

#### Scenario: No size available
- **WHEN** the service reports no store size
- **THEN** the tab shows unknown, not zero

### Requirement: Local-only statement
The tab SHALL state, in visible text, that embeddings are built on this device from the notes' content, kept only here, not synced, built per device and rebuildable at any time. It SHALL NOT say that embeddings travel with the vault snapshot.

#### Scenario: Wording
- **WHEN** the tab renders
- **THEN** the statement is present and the word snapshot does not describe embeddings

### Requirement: States
The tab SHALL render distinct states for empty (no collection), building, ready, paused, missing (evicted) and failed, including a model-load failure with its own text. An evicted index SHALL say "Index missing on this device" and offer a rebuild.

#### Scenario: Evicted
- **WHEN** the service reports the store missing
- **THEN** the tab says so and search falls back to text

### Requirement: Progress as text
Coverage SHALL expose its values as text and through a progressbar role with now and max.

#### Scenario: Screen reader
- **WHEN** coverage updates
- **THEN** the progressbar's values and the visible text agree

### Requirement: Rebuild consequence dialog
Rebuild SHALL open a consequence dialog that states what is deleted, that search falls back to text meanwhile, the time estimate or unknown, the foreground note on phones, that nothing in the vault or on the node changes, and that collection definitions and conversations are kept. Cancel SHALL be first and focused, and Escape SHALL mean no.

#### Scenario: Cancel
- **WHEN** the user presses Escape
- **THEN** no rebuild starts

### Requirement: Phone defaults
No phone default for embedding or battery behaviour SHALL be set before a recorded iPhone run of the store and model together.

#### Scenario: No device row
- **WHEN** no device-results row for peak memory exists
- **THEN** phone embedding remains opt-in with no automatic start
