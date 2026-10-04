## Purpose

Defines Agent mode: complete chunk coverage, always-visible skill activations, per-call approvals for mutating tools, and the lane taken from the stream. It does not assume which wire names UAR uses.

## ADDED Requirements

### Requirement: No dropped chunk
Every chunk kind, including an unrecognised one, SHALL render as a visible element carrying `data-chunk-kind`. A part kind without a renderer SHALL fail type checking. An unknown event SHALL render its name and payload.

#### Scenario: Unknown event
- **WHEN** a stream carries an event name no rule matches
- **THEN** an `unknown` block shows the name and payload

### Requirement: Skill activations visible
A skill activation SHALL render a card with name, source, description, arguments summary and running state, expandable to the full body. It SHALL NOT be hidden or collapsed out of the thread in any turn state.

#### Scenario: Turn ends
- **WHEN** a turn that activated a skill completes
- **THEN** the skill card is in the thread and only its body is collapsed

### Requirement: Errors reachable
An error SHALL render a card that is expanded while the turn runs and collapsed to a one-line summary afterwards, with the full payload copyable. An error SHALL NOT be swallowed.

#### Scenario: Error after turn
- **WHEN** the turn ends
- **THEN** the card shows a one-line summary and expands to the full payload

### Requirement: Approvals per call
A mutating tool call SHALL require an Approve gesture on a confirmation card showing the exact arguments as text. Deny SHALL write nothing. The outcome SHALL be recorded in the card. A second tap SHALL send nothing.

#### Scenario: Deny
- **WHEN** the user denies a write
- **THEN** nothing is written and the card says so

### Requirement: Approval hygiene
Effect class SHALL be assigned by the plugin, not taken from a tool's annotation. Arguments SHALL be validated against a schema before a card is shown. A confirmation response SHALL name its tool call id, SHALL be single-use, and SHALL cause one state transition. Each call SHALL carry an idempotency id, a timeout, an output cap and a cancel signal, and results SHALL be redacted before entering a transcript or prompt. Tool names and descriptions SHALL render as text.

#### Scenario: Second response
- **WHEN** two confirmation responses arrive for one tool call id
- **THEN** only the first changes state

### Requirement: Lane from the stream
The lane chip SHALL show the lane and model the stream reports. A stream that reports none SHALL show "lane unknown" and SHALL NOT default to Local.

#### Scenario: Missing field
- **WHEN** the stream carries no lane
- **THEN** the chip reads lane unknown

### Requirement: Offline behaviour
Offline, the chip SHALL add the connectivity suffix, remote-only agents SHALL be disabled with the reason, and a skipped remote tool SHALL render an error card with state skipped. A "queued until online" row SHALL appear only when the runtime reports a queue.

#### Scenario: Remote tool offline
- **WHEN** a remote tool is called with no connectivity
- **THEN** an error card with state skipped is shown

### Requirement: Bare endpoints
With a provider that emits only text, Agent mode SHALL say that no skills, tools or memory are available from it.

#### Scenario: Plain provider
- **WHEN** Agent mode runs against a bare LLM endpoint
- **THEN** the thread is text only and the limitation is stated
