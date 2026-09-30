## Purpose

Defines what the plugin shows for encrypted pull and key management, so an operator can unlock a second vault, restore an older version, change the passphrase or cost, and understand what each action does and does not do.

## ADDED Requirements

### Requirement: Unlock and pull
The Pull command SHALL prompt for the passphrase once per session when the vault is locked, using the unlock dialog of the publish change, and SHALL show phases (resolving, reading key slots, unlocking with a keep-in-foreground hint, checking the manifest, fetching i of M). A wrong passphrase SHALL show the single unlock-failed message and allow retry without leaving partial state. A pull that fails authentication or the sequence rule SHALL show the reason in plain words and SHALL NOT use success wording.

#### Scenario: Wrong passphrase then right
- **WHEN** the user enters a wrong passphrase and then the right one
- **THEN** the first attempt shows the unlock-failed message with nothing written, and the second proceeds

#### Scenario: Typo detected locally
- **WHEN** the user mistypes one symbol of the passphrase
- **THEN** the dialog reports a probable typo (the check catches about 99.9% of body-symbol typos and every check-symbol typo) without any network request

#### Scenario: Tampered content
- **WHEN** one file fails authentication
- **THEN** the summary names the count of failed files and says they were not written

### Requirement: Pull target field
The pull-name setting SHALL accept an IPNS name, or `/ipfs/<cid>` for an explicit root, and SHALL show which of the two is in effect and, for an explicit root, a note that it is an advanced input for restore and verification.

#### Scenario: Explicit root
- **WHEN** the user enters `/ipfs/<cid>`
- **THEN** the tab shows that an explicit root will be pulled

### Requirement: Restore an older version
The plugin SHALL provide an action to restore an older version that lists available history entries and, before proceeding, shows a confirmation dialog stating that the vault will be set to an older state, that local edits are kept as conflict copies, that the recorded highest sequence is not lowered, and that the next publish will make the restored content a new version. The action SHALL do nothing without the confirmation.

#### Scenario: Cancel
- **WHEN** the user cancels the confirmation
- **THEN** nothing is fetched or written

### Requirement: Key management dialogs
The plugin SHALL provide dialogs for change passphrase, increase key-derivation cost, and accept changed key slots. The change-passphrase and cost dialogs SHALL state, before the confirm control is enabled, that old passphrases and old copies of the key-slot file remain valid, and the cost dialog SHALL name the memory and iterations and warn about slower devices. The change-passphrase dialog SHALL generate a new passphrase, shown in monospace with a note that letters are case-insensitive, with the save-it-and-re-enter step of the publish change; it SHALL offer no field for choosing one's own. The accept dialog SHALL explain that the passphrase must be the one the other device set.

#### Scenario: Statement gating
- **WHEN** the change-passphrase dialog is open and the statement has not been acknowledged
- **THEN** the confirm control is disabled

#### Scenario: Cost presets
- **WHEN** the cost dialog opens
- **THEN** it offers the current cost and higher presets within the ceilings and no value beyond them

### Requirement: Encryption settings section
The settings tab SHALL show the vault state (not set up, locked, unlocked), the vault sequence last accepted, the key-derivation cost of the current slot, and the actions above, in the existing plain tab.

#### Scenario: State display
- **WHEN** the tab is opened in an unlocked, synced vault
- **THEN** it shows unlocked, the recorded sequence and the slot's cost

### Requirement: Measure key derivation time
The plugin SHALL provide a command that runs one derivation at the default cost on random input in the foreground and shows the elapsed seconds and the device platform, so a phone measurement can be recorded. The command SHALL use no vault data and no passphrase.

#### Scenario: Command output
- **WHEN** the command runs
- **THEN** a notice shows the elapsed seconds and the platform, and no vault is touched

### Requirement: No secrets in output, plain tab, accessibility
Dialogs, notices, the status bar and settings SHALL NOT display or persist the passphrase or keys beyond the setup step that shows a generated passphrase once. The additions SHALL keep the tab plain and SHALL provide visible labels, text errors associated with fields, masked inputs with a reveal control, keyboard operation and no reliance on colour alone.

#### Scenario: Keyboard
- **WHEN** the user tabs through each new dialog
- **THEN** every control receives focus in reading order
