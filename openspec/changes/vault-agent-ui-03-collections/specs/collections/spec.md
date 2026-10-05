## Purpose

Defines user-defined collections of notes as the scope for embedding, Search, Notes mode and the Index tab. Membership is a filter over one shared per-block index. Claims about index cost and performance assume nothing; they are measured.

## ADDED Requirements

### Requirement: Definition model
A collection SHALL have a stable id, a name, include rules (folder, tag, manual picks), exclude rules and a definition version. Includes SHALL form a union and an exclude SHALL win over an include.

#### Scenario: Exclude wins
- **WHEN** a folder is included and one of its subfolders is excluded
- **THEN** notes in the subfolder are not members

### Requirement: Built-in exclusions
The conversations folder, the default sync exclusions and any path the sync refuses SHALL never be members of any collection, including a whole-vault collection.

#### Scenario: Whole vault
- **WHEN** a collection includes the whole vault
- **THEN** its membership contains no conversation file and no path under `.obsidian/`

### Requirement: Membership at path level
Membership SHALL be evaluated over paths and metadata, not content hashes. A note SHALL stay a member after an edit and SHALL be queued for embedding when an index exists.

#### Scenario: Edit
- **WHEN** a member note is edited
- **THEN** it is still a member

### Requirement: Shared index scope
The indexed scope SHALL be the union of collection members. A note in several collections SHALL be embedded once. Deleting a collection SHALL prune only embeddings that no remaining collection needs.

#### Scenario: Overlap
- **WHEN** a note belongs to two collections and one is deleted
- **THEN** its embeddings remain

### Requirement: Opt-in embedding
Nothing SHALL be embedded until the user defines a collection and starts it. Starting SHALL show the estimated cost first, and on a phone SHALL state that phone embedding is opt-in.

#### Scenario: First run
- **WHEN** a user opens collections on a fresh install
- **THEN** no embedding job exists

### Requirement: Durable definitions
Definitions SHALL be stored outside the embedded database in a durable device-local file separate from the plugin's secrets, SHALL survive a wipe or eviction of the local stores, and SHALL NOT appear in logs or error reports.

#### Scenario: Store wiped
- **WHEN** the local index store is wiped
- **THEN** the definitions remain and the index can be rebuilt from them

### Requirement: Embedding source disclosure
Each collection row SHALL name the embedding source (local model or provider host). A provider source SHALL require the consent of its provider before the first embedding and SHALL state that whole-note text is sent. Vectors from different models SHALL NOT be mixed.

#### Scenario: Provider source without consent
- **WHEN** a collection is set to embed through a provider with no consent for embeddings
- **THEN** the embed action is refused

### Requirement: Local-only statement
The Index tab and the collection row SHALL state that embeddings are built on this device, kept only here, not synced, rebuilt per device, and rebuildable at any time.

#### Scenario: Index tab
- **WHEN** a collection row renders
- **THEN** the statement is visible without opening a tooltip
