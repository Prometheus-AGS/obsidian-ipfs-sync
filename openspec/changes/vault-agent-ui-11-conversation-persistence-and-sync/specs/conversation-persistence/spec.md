## Purpose

Defines local persistence of conversations as authored data: entities, retention, deletion, eviction handling and what is never stored. Spec 006's cache rule does not apply to conversations.

## ADDED Requirements

### Requirement: Entities
The data layer SHALL define conversation, message, run and tool call entities, with typed message parts, a device id, optional parent references for branches, tombstone fields and a schema version. A message SHALL record the lane and model used. Citation parts SHALL hold references (path, heading, content hash, offsets) and SHALL NOT hold excerpt text.

#### Scenario: Stale citation
- **WHEN** a cited note changed since the answer
- **THEN** the citation renders as a source that changed and no excerpt is shown from storage

### Requirement: Never stored
No entity, file or log SHALL contain a provider key, a secret value, the node token or passphrase material.

#### Scenario: Canary
- **WHEN** a canary key is configured and a conversation is saved
- **THEN** a search of the entity store finds no canary

### Requirement: Separate tables
Conversation data SHALL live in its own tables and files, apart from the embeddings, chunks, collections and membership tables, and SHALL NOT be included in any embedding scope by default.

#### Scenario: Index tables
- **WHEN** the embeddings and chunks tables are queried after a conversation is saved
- **THEN** they contain no conversation text

### Requirement: Flush and interrupted state
Streaming state SHALL stay in memory and flush at part boundaries, run end, cancel and at most once per bounded interval during a text stream. On hydrate a message in `streaming` and a run in `running` SHALL become `interrupted` and the UI SHALL show a marker.

#### Scenario: Kill mid-stream
- **WHEN** the app is killed during a stream and relaunched
- **THEN** the flushed text shows with an interrupted marker and no message is `streaming`

### Requirement: Retention and deletion
Conversations SHALL be kept until the user deletes them unless the operator sets a retention period. Deleting a conversation SHALL remove its messages, runs and tool calls. Clear all SHALL require a consequence dialog with Cancel focused.

#### Scenario: Delete
- **WHEN** a conversation is deleted
- **THEN** no orphan message, run or tool call remains

### Requirement: Eviction honesty
A sentinel outside the database SHALL record conversation count and last write time. An empty database with a non-empty sentinel SHALL raise a visible notice that history may have been cleared and SHALL NOT start silently as if new. The Data copy SHALL state that conversations are not rebuildable and that wiping local stores deletes them.

#### Scenario: Storage cleared
- **WHEN** the database is empty and the sentinel records 12 conversations
- **THEN** the notice appears

### Requirement: Layering
Components SHALL import hooks only, hooks stores, stores the persistence service, and services SHALL import no React, zustand or store.

#### Scenario: Component reads storage
- **WHEN** a component imports the persistence module
- **THEN** `check:layering` fails
