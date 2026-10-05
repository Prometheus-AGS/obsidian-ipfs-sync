## Purpose

Defines the Search tab: text search that needs no index, semantic search when an index exists, and the honesty rules for what the tab says.

## ADDED Requirements

### Requirement: Text fallback
When no index covers the scope the tab SHALL search note text, SHALL say that it is searching text, and SHALL bound the run with a result cap and a file cap and report "searched N of M notes". A new query SHALL cancel the previous run.

#### Scenario: Large vault
- **WHEN** the file cap is reached
- **THEN** the tab shows how many notes were searched out of how many

### Requirement: Scope
The tab SHALL offer scope toggles for the whole vault or a collection, a folder, a tag and a date. Scope chips SHALL be toggles and SHALL NOT be a second query box.

#### Scenario: Folder scope
- **WHEN** a folder scope is chosen
- **THEN** only notes under it are searched

### Requirement: Rows
A row SHALL show the title, the folder path, the similarity as a bar and as text, and an excerpt with the match marked. Titles, paths and excerpts SHALL be rendered as text nodes and SHALL NOT be inserted as HTML.

#### Scenario: Hostile note text
- **WHEN** a note contains markup in the excerpt span
- **THEN** it is shown as text

### Requirement: Honest coverage
The coverage line and every count SHALL come from the index service. Production code SHALL contain no scripted counts. A device with no index or an evicted index SHALL say so and SHALL fall back to text.

#### Scenario: Evicted index
- **WHEN** the retrieval port reports the index missing
- **THEN** the tab shows "Index missing on this device" with a rebuild action and returns text results

### Requirement: Lane chip detail
The lane chip SHALL show the embedding model or provider in visible text and SHALL NOT rely on a tooltip.

#### Scenario: Touch device
- **WHEN** the tab renders on a phone
- **THEN** the model detail is readable without hover

### Requirement: States
The tab SHALL render distinct states for idle, searching, results, no match, no index, index missing, model loading and embed failure, each with text that says what happened and what the user can do.

#### Scenario: Embed failure
- **WHEN** the query embedding fails
- **THEN** the failure is stated and text results are offered

### Requirement: Actions
Rows SHALL offer Open and Insert link. Add to chat SHALL appear only when Notes mode exists. Actions SHALL be reachable by keyboard and shown without hover on touch devices.

#### Scenario: No active editor
- **WHEN** Insert link is pressed with no active editor
- **THEN** a notice explains and nothing is inserted
