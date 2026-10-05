## Purpose

Defines the opt-in sync of conversations through the existing encrypted vault sync, as files, with no new sync machinery. Off by default. Nothing here assumes the sync core's behaviour beyond what its README states; task 1.1 verifies it.

## ADDED Requirements

### Requirement: Off by default
Conversation sync SHALL be off on every device until that device's user enables it through the disclosure dialog. With it off, no conversation file SHALL be written.

#### Scenario: Fresh install
- **WHEN** the plugin is installed and conversations are created
- **THEN** no conversation file exists in the vault

### Requirement: Disclosure before enabling
Enabling SHALL show a consequence dialog with Cancel focused that states: published content cannot be erased from older roots or from anyone who pinned them, and pruning history does not recall copied blocks; synced conversations contain note excerpts and model answers and are readable on every device that holds the vault; a remote provider may have logged what was sent; chat increases the number of publishes and history files; deleting on one device does not remove it elsewhere except through a tombstone. It SHALL name the folder and what is written.

#### Scenario: Escape
- **WHEN** the user presses Escape in the dialog
- **THEN** sync stays off

### Requirement: Per-device files
Each device SHALL write only its own conversation files. A second device continuing a conversation SHALL write a branch, with parent references, into its own file. The reader SHALL merge by conversation id and time.

#### Scenario: Two devices
- **WHEN** two devices each add turns to the same conversation between publishes
- **THEN** no conflict copy is created by conversation files

### Requirement: Tombstones
Deleting a synced conversation SHALL replace its content with a stub holding the conversation id and deletion time. Readers SHALL hide a stubbed conversation. The UI SHALL state that older published roots and pins keep the content.

#### Scenario: Delete on device A
- **WHEN** a synced conversation is deleted on device A and device B pulls
- **THEN** device B hides it and the stub, not the content, is in the current vault

### Requirement: Write cadence and guards
Writes SHALL occur on turn complete and SHALL be coalesced to at most one batch per publish interval. The service SHALL read the node's history count before enabling and SHALL refuse above the threshold the operator sets, and SHALL NOT prune.

#### Scenario: Near the limit
- **WHEN** the history count is above the threshold
- **THEN** enabling is refused with the count and the name of the prune command

### Requirement: Exclusions
The conversations folder SHALL be excluded from every collection union, from `Whole vault` embedding and from the vault index by default. Search over conversations SHALL be a separate opt-in.

#### Scenario: Whole vault collection
- **WHEN** a collection includes the whole vault
- **THEN** its membership contains no conversation file

### Requirement: Content of files
Files SHALL omit tool-call arguments and results unless the user opted in, SHALL carry no key, token or passphrase material, SHALL be size-capped, and SHALL carry a schema version. A reader SHALL refuse an unknown schema version with a reason.

#### Scenario: Unknown version
- **WHEN** a pulled file has a newer schema version
- **THEN** it is not loaded and the reason is shown
