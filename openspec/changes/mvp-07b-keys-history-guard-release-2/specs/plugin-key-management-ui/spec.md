## Purpose

Defines what the plugin shows for key management, the mass-removal confirmation and the phone-timing command, so an operator can change the passphrase or cost, accept another device's change, confirm a large removal and measure key derivation on a phone, and understand what each action does and does not do. It is the second half of the first draft's `plugin-encrypted-ui`; the pull half is `plugin-pull-ui` in 07a.

## ADDED Requirements

### Requirement: Key management dialogs
The plugin SHALL provide dialogs for change passphrase, increase key-derivation cost and accept changed key slots. The change-passphrase and cost dialogs SHALL state, before the confirm control is enabled, that old passphrases and old copies of the key-slot file remain valid; the cost dialog SHALL name the memory and iterations, warn about slower devices, show the current cost, offer only presets within the ceilings, require a downgrade confirmation for a lower choice, and state that a same-passphrase increase does not protect against the old cheaper slot in earlier roots. The change-passphrase dialog SHALL generate a new passphrase, shown in monospace with a note that letters are case-insensitive, with the save-it-and-re-enter step of the publish change, and SHALL offer no field for choosing one's own. The accept dialog SHALL explain that the passphrase must be the one the other device set, SHALL show the costs of the current copy and the incoming slot when they differ and require confirmation for a lower one. After a rewrap the dialog SHALL show the result of the test unlock.

#### Scenario: Statement gating
- **WHEN** the change-passphrase dialog is open and the statement has not been acknowledged
- **THEN** the confirm control is disabled

#### Scenario: Cost presets
- **WHEN** the cost dialog opens
- **THEN** it offers the current cost and higher presets within the ceilings, a lower choice only with a downgrade confirmation, and no value beyond the ceilings

#### Scenario: Accept downgrade
- **WHEN** the incoming slot is cheaper than the copy
- **THEN** both costs are shown and accepting needs confirmation

### Requirement: Mass-removal confirmation
On a manual publish that the engine stops for mass removal, the plugin SHALL show a dialog with the number of entries that would be removed out of the total and the statement that an emptied or unmounted vault looks the same, with a cancel default. The timer publish SHALL NOT open it and SHALL show a notice.

#### Scenario: Cancel default
- **WHEN** the dialog opens
- **THEN** the default focus is on cancel and confirming needs an explicit action

#### Scenario: Timer
- **WHEN** the timer publish is stopped for mass removal
- **THEN** a notice is shown and no dialog opens

### Requirement: Measure key derivation time
The plugin SHALL provide a command "IPFS Sync: Measure key derivation time" that runs one derivation at the default cost (`m=65536 KiB, t=3, p=1`) on random input in the foreground, using no vault data and no passphrase, and shows the elapsed seconds, the device platform, whether it completed, and the first 16 hex characters of the sha256 of the installed plugin `main.js` read through the adapter, in groups of four (the recorder checks them against the local build and records the full hash). If the file cannot be read the record SHALL say the build hash is unavailable. The command SHALL tell the user to keep the app open.

#### Scenario: Command output
- **WHEN** the command runs
- **THEN** a notice shows the elapsed seconds, the platform, `completed: yes` and the first 16 characters of the build hash in groups of four, and no vault is touched

#### Scenario: No build hash
- **WHEN** the plugin file cannot be read
- **THEN** the notice says the build hash is unavailable

### Requirement: Settings additions
The Encryption section of the settings tab SHALL show the key-derivation cost of the current slot and the actions above, in the existing plain tab.

#### Scenario: State display
- **WHEN** the tab is opened in an unlocked, synced vault
- **THEN** it shows unlocked, the recorded sequence and the slot's cost

### Requirement: No secrets in output, plain tab, accessibility
Dialogs, notices, the status bar and settings SHALL NOT display or persist the passphrase or keys beyond the step that shows a generated passphrase once. The additions SHALL keep the tab plain and SHALL provide visible labels, text errors associated with fields, masked inputs with a reveal control, keyboard operation and no reliance on colour alone. A copy control for a generated passphrase SHALL clear the clipboard after a fixed short time or SHALL NOT exist, and SHALL NOT exist on mobile. Node-supplied text in these dialogs SHALL be rendered with `textContent` only.

#### Scenario: Keyboard
- **WHEN** the user tabs through each new dialog
- **THEN** every control receives focus in reading order
