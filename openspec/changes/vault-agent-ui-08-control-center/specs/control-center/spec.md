## Purpose

Defines the searchable control center and how it coexists with the native settings tab and the 07b key dialogs. It adds no setting that lacks backing code.

## ADDED Requirements

### Requirement: Searchable rows
The control center SHALL list settings in sections and SHALL filter rows by name, description and aliases, showing matching counts beside section names. A search with no match SHALL say aliases are searched and suggest a plainer word.

#### Scenario: Alias
- **WHEN** the user searches "rekey"
- **THEN** the rows that register that alias are shown

### Requirement: Absent rather than disabled
A row SHALL appear only when its backing code exists on the platform. Device, grant, pairing, Revoke and Direct links rows SHALL NOT appear until their engines exist.

#### Scenario: No engine
- **WHEN** the control center renders and no pairing code exists
- **THEN** no pairing, device or Revoke row is present

### Requirement: Coexistence with the native tab
The native settings tab and its Encryption section SHALL remain. A setting present in both surfaces SHALL be bound to one model. The control center SHALL NOT edit or copy any 07b key dialog or model file.

#### Scenario: Round trip
- **WHEN** a value changes in the control center
- **THEN** the native tab shows the same value and the reverse

### Requirement: Hosted key actions
The Security section SHALL open the existing 07b dialog classes for Lock, Change passphrase, Increase cost, Accept changed key slots and Prune history. The key-derivation cost row SHALL open the increase-cost dialog and SHALL NOT be an inline selector.

#### Scenario: Cost row
- **WHEN** the user activates the key-derivation cost row
- **THEN** the increase-cost dialog opens with its own consent text

### Requirement: Consequence dialogs
Every destructive or trust-changing action that exists SHALL open a consequence dialog with Cancel focused, unless a required field takes focus, and Escape SHALL mean no.

#### Scenario: Escape
- **WHEN** Escape is pressed in a consequence dialog
- **THEN** nothing destructive happens

### Requirement: Mobile
On mobile the control center SHALL be a single column with a horizontally scrolling section list, controls of at least 44 px, and SHALL hide rows that are meaningless there.

#### Scenario: Status chip toggle
- **WHEN** the Appearance section renders on a phone
- **THEN** the status bar chip toggle is absent
