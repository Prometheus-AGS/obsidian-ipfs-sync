## Purpose

Defines the settings added for pull: what to pull from, whether to catch up on load, how much memory a single file may use, and a view of what happened last.

## ADDED Requirements

### Requirement: Pull name setting
The settings tab SHALL provide a "pull IPNS name" field. Empty means "use the owned publication key's ID". A value SHALL be accepted only if it is a single IPNS name (a key ID, optionally prefixed with `/ipns/`) with no whitespace; a rejected value SHALL show an inline text error and SHALL NOT be saved. The tab SHALL display which name will be used (the entered one or the owned key's ID, or a note that none is available).

#### Scenario: Default shown
- **WHEN** the field is empty and an owned key ID is recorded
- **THEN** the tab shows that ID as the name that will be pulled

#### Scenario: Bad value
- **WHEN** the user enters text containing spaces
- **THEN** an inline error appears and the previous value stays

### Requirement: Catch-up toggle
The tab SHALL provide a "pull on load" toggle, off by default, with copy stating it is a per-device setting and that it only takes effect in fixture vaults in this release.

#### Scenario: Default
- **WHEN** the plugin is installed fresh
- **THEN** the toggle is off

### Requirement: Read cap setting
The tab SHALL provide the per-file read cap in megabytes with the default and range defined by the file-system semantics, validating input inline and explaining what happens to a file above the cap.

#### Scenario: Out of range
- **WHEN** the user enters 4
- **THEN** an inline error states the allowed range and the value is not saved

### Requirement: Last summaries view
The tab SHALL show the last pull summary and the last publish summary (time, counts, root CID), or a note that none exists. The summaries SHALL be persisted in the plugin data as counts, CIDs and timestamps only.

#### Scenario: After a pull
- **WHEN** a pull has completed
- **THEN** the tab shows its time, fetched, unchanged, conflict and failed counts

### Requirement: Migration of the settings model
Stored settings from the previous plugin version SHALL load with defaults for the new fields, without altering existing values, and SHALL be saved in the new form on the next settings change.

#### Scenario: Upgrade
- **WHEN** the plugin data has the previous version marker
- **THEN** the endpoints, auth and owned keys are unchanged and the new fields have their defaults

### Requirement: Plain tab, accessible
The additions SHALL keep the tab a plain settings tab; every added control SHALL have a visible label, text errors associated with the field, and keyboard operation.

#### Scenario: Keyboard
- **WHEN** the user tabs through the new controls
- **THEN** each receives focus in reading order
