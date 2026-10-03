## Purpose

Defines the chat entity types, how they are persisted, what happens when a stream is cut, how a lost database is detected, and the boundary between chat data and the vault. The entity library provides no chat model, so these types are ours.

## ADDED Requirements

### Requirement: Entity types
The chat data layer SHALL define: `conversation` (id, title, createdAt, updatedAt, endpoint label, schemaVersion); `message` (id, conversationId, role of user, assistant or system, ordered typed parts, status of streaming, complete, stopped, error or interrupted, runId optional, createdAt); `run` (id from the AG-UI run id, conversationId, status of running, finished, error, cancelled or interrupted, startedAt, finishedAt optional, error summary optional); `tool call` (id from the AG-UI tool call id, messageId, runId, name, args text as streamed, result text optional, status of running, done or error, startedAt, endedAt optional). Message parts SHALL be typed values inside the message with kinds `text`, `thinking`, `state`, `data`, `confirmation`, `skill-activation`, `memory-recall`, `citation`, `error`, `a2ui-surface` and `unknown`; a `tool-call` part SHALL reference a tool call entity by id. Text parts SHALL hold the raw markdown source as received.

#### Scenario: Unknown chunk
- **WHEN** the stream carries an event name no reducer rule matches
- **THEN** the message gets an `unknown` part holding the name and payload and the part is rendered, not dropped

### Requirement: Persistence policy
The store SHALL keep streaming state in memory and flush to the entity graph at part start, part end, run finish, run error, cancel, and at most once per bounded interval during a text stream. A token SHALL NOT cause a write by itself.

#### Scenario: Long stream
- **WHEN** a text part receives 1,000 content events
- **THEN** the number of persisted writes for that part is bounded by the interval policy and is far below 1,000

### Requirement: Interrupted state
On hydrate, a message in status `streaming` and a run in status `running` SHALL become `interrupted`, and the UI SHALL show an interrupted marker. Content flushed before the kill SHALL be kept.

#### Scenario: App killed mid-stream
- **WHEN** the app is killed during a stream and relaunched
- **THEN** the conversation shows the flushed text with an interrupted marker and no message remains in `streaming`

### Requirement: Eviction detection
The plugin SHALL keep a sentinel (conversation count and last write time) in plugin data, outside the chat database. If the chat database is empty at hydrate while the sentinel says data existed, the UI SHALL show a notice that history may have been cleared by the system and SHALL NOT silently start as if new.

#### Scenario: Storage cleared
- **WHEN** the database is empty and the sentinel records 12 conversations
- **THEN** the notice appears and names transcript export as the way to keep copies

### Requirement: Vault boundary
Chat data SHALL NOT be written into the vault tree and SHALL NOT appear in any publish plan, except a transcript the user exported. Deleting a conversation SHALL remove its messages, runs and tool calls. Clearing all chat data SHALL require a consequence dialog.

#### Scenario: Publish plan
- **WHEN** a publish plan is built for a vault on a device with chat data
- **THEN** it contains no file of the chat database

### Requirement: Transcript export
Export SHALL be off by default and user-initiated per conversation. It SHALL write a markdown note into a configured folder with a file name accepted by the path policy, containing the raw markdown source of each message, and SHALL NOT overwrite an existing note silently.

#### Scenario: Setting off
- **WHEN** export is disabled and the user opens a conversation menu
- **THEN** no export action writes anything
