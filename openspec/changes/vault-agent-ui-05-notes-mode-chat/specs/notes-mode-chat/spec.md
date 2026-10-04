## Purpose

Defines Notes mode: retrieval-bound answers with passage citations, refusal below a floor, Quote only, and user-initiated writes. Nothing here assumes a local generative model exists.

## ADDED Requirements

### Requirement: Answers only from retrieved passages
Notes mode SHALL retrieve passages from the local index within the chat's scope and SHALL answer only from them. It SHALL have no tools, skills or approval cards. The assistant SHALL take no write actions.

#### Scenario: No tools
- **WHEN** a Notes turn runs
- **THEN** no tool call, skill card or confirmation card is produced

### Requirement: Structural refusal and untrusted text
When no passage passes the floor, or index coverage is below its floor, the pipeline SHALL make no model call. The Notes profile SHALL have an empty tool allowlist. Retrieved passage text SHALL be treated as untrusted data and SHALL NOT be placed in the prompt as instructions.

#### Scenario: No passage passes
- **WHEN** retrieval returns no passage above the floor
- **THEN** no provider request is made and the refusal reason is shown

### Requirement: Refusal below the floor
When the best passage scores below the answer floor, Notes mode SHALL generate nothing, SHALL show the near misses and say that no note records an answer, and SHALL offer a text search and an Ask the agent instead exit. It SHALL NOT answer from the model's own knowledge.

#### Scenario: Weak match
- **WHEN** the best score is below the floor
- **THEN** no answer text is generated and both exits are shown

### Requirement: Passage citations and the grounding line
Each answer sentence SHALL carry passage markers supplied by the pipeline. The grounding line SHALL count sentences whose marker resolves to a retrieved passage and sentences without one, and SHALL NOT assert that a cited sentence is supported. A non-zero count without a source SHALL switch the line to a warning state and mark the sentences.

#### Scenario: Uncited sentence
- **WHEN** an answer contains a sentence with no resolving marker
- **THEN** the line shows the warning state and the sentence is marked

### Requirement: Quote only
In Quote only the answer SHALL consist of verbatim sentences from the passages, each cited. A quote that is not a substring of its passage SHALL be rejected.

#### Scenario: Altered quote
- **WHEN** the pipeline returns a quote that differs from its passage text
- **THEN** it is rejected and not shown

### Requirement: No provider or no generative lane
With no provider and no local generative lane Notes mode SHALL offer retrieval and Quote only and SHALL say why. The UI SHALL NOT claim that answers work offline without a recorded device run.

#### Scenario: Fresh install
- **WHEN** Notes mode opens with no provider configured
- **THEN** retrieval and Quote only are offered and the reason is stated

### Requirement: Disclosure before send
Before the first send to a provider in Notes mode the UI SHALL have shown the provider consent of its settings, and the thread SHALL show which provider host receives excerpts.

#### Scenario: First send
- **WHEN** the user sends the first question with a remote provider
- **THEN** the host is visible and consent exists

### Requirement: User-initiated writes
Copy, Save as note and Insert at cursor SHALL happen only on a user action. Save as note SHALL refuse until an inbox folder is set, SHALL use a name accepted by the sync path policy and SHALL NOT overwrite silently. Insert at cursor SHALL refuse with a notice when no editor is active.

#### Scenario: Unsafe name
- **WHEN** a conversation titled `CON` is saved
- **THEN** the save is refused or renamed with the reason from the path policy

### Requirement: Excerpts as text
Passage excerpts and titles SHALL render as text nodes.

#### Scenario: Hostile excerpt
- **WHEN** a passage contains markup
- **THEN** it displays as text
