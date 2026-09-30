## Purpose

Defines what the plugin shows and does for the encrypted pull: unlock, first-pull confirmation, restore, fork resolution, large pulls, incomplete pulls, and the resource behaviour of the plugin host. Key-management dialogs belong to the next change. This spec replaces the first draft's `plugin-encrypted-ui`, which mixed both.

## ADDED Requirements

### Requirement: Unlock and pull
The Pull command SHALL prompt for the passphrase once per session when the vault is locked, using the unlock dialog of the publish change, and SHALL show phases (resolving, reading key slots, unlocking with a keep-in-foreground hint, checking the manifest, fetching i of M). A wrong passphrase SHALL show the single unlock-failed message and allow retry without leaving partial state. A pull that fails authentication or a sequence verdict SHALL show the reason in plain words and SHALL NOT use success wording. The pull SHALL take the same lock the publish runner takes (in-process and file) and SHALL show the busy notice when it is held.

#### Scenario: Wrong passphrase then right
- **WHEN** the user enters a wrong passphrase and then the right one
- **THEN** the first attempt shows the unlock-failed message with nothing written, and the second proceeds

#### Scenario: Typo detected locally
- **WHEN** the user mistypes one symbol of the passphrase
- **THEN** the dialog reports a probable typo (the check catches about 99.9% of body-symbol typos and every check-symbol typo) without any network request

#### Scenario: Tampered content
- **WHEN** one file fails authentication
- **THEN** the notice names the count of files not written, says the vault is not up to date, and does not use success wording

### Requirement: First-pull confirmation dialog
The plugin SHALL show, for every first pull, a dialog with the vault's sequence, `publishedAt` and `device` (escaped) and the statements that these were chosen by whoever holds the vault key and that this device has no earlier record. It SHALL also state the three requirements for publishing from this device (same MFS root and key name, adopt the owned key, pull before publish). Declining SHALL write nothing.

#### Scenario: Decline
- **WHEN** the user declines
- **THEN** no file, state, floor entry or key-slot copy is written

### Requirement: Pull target field
The pull-name setting SHALL accept an IPNS name, or `/ipfs/<cid>` for an explicit root, and SHALL show which of the two is in effect and, for an explicit root, a note that it is an advanced input for restore and verification and that the client does not verify returned bytes against the CID.

#### Scenario: Explicit root
- **WHEN** the user enters `/ipfs/<cid>`
- **THEN** the setting is accepted (the parser that today accepts only an IPNS token or `/ipns/<token>` accepts this form too, and the stored value and the settings-to-config mapping carry it) and the tab shows that an explicit root will be pulled

#### Scenario: Malformed root
- **WHEN** the user enters `/ipfs/` followed by text that is not a CID token
- **THEN** the field shows the existing pull-name error and nothing is stored

### Requirement: Restore an older version
The plugin SHALL provide a Restore action that lists available history entries (at most the newest 20 by name order, each decrypted only if its file size is at most 8 MiB) with sequence, date and device, and, before proceeding, a confirmation dialog stating that the vault will take an older version's files, that local edits are kept as conflict copies, that files created later are not removed, that the recorded highest sequence is not lowered and that the next publish will make the result a new version. The plain Pull command SHALL NOT pass the rollback flag; only this action SHALL. The action SHALL do nothing without the confirmation. The names in the list are not authenticated: after an entry is chosen and before the confirmation, the action SHALL load that entry, authenticate its manifest, and show the authenticated sequence and date in the confirmation; if they differ from the label that was listed, the action SHALL refuse and say the history entry does not match its name.

#### Scenario: Cancel
- **WHEN** the user cancels the confirmation
- **THEN** nothing is fetched or written

#### Scenario: Label does not match
- **WHEN** a history file named for sequence 12 decrypts to a manifest of sequence 4 (it was planted or swapped)
- **THEN** the action refuses before the confirmation and writes nothing

#### Scenario: Large entry
- **WHEN** a listed entry is over 8 MiB and was listed by name only
- **THEN** the confirmation shows the sequence and date taken from the authenticated manifest, not from the name

#### Scenario: Only the Restore action rolls back
- **WHEN** the plain Pull command meets a lower sequence
- **THEN** it refuses and the notice does not offer a rollback

#### Scenario: Legacy entries
- **WHEN** the history holds legacy-named entries
- **THEN** they are listed after the prefixed ones with "order unknown"

### Requirement: Fork resolution action
The plugin SHALL, when a pull meets a fork, show a notice that explains it in plain words and offer a "Resolve fork" action whose confirmation states that the node's version takes each file where the two differ, that this device's text is kept as conflict copies, and that nothing is merged automatically. The action SHALL do nothing without the confirmation.

#### Scenario: Fork notice
- **WHEN** a pull meets equal sequences with different content
- **THEN** the notice names a fork, not an attack, and offers the action

### Requirement: Large pulls, incomplete pulls and skipped paths
Before fetching more than the configured ceiling (default 512 MiB) the plugin SHALL ask for confirmation with the size. The notice after a pull SHALL distinguish files not written because they failed integrity checks, files not fetched (with the reason), and paths skipped by policy (expected versus unsafe), and SHALL say that files not restored here are kept unchanged in the next publish and are not published from this device.

#### Scenario: Ceiling
- **WHEN** the files to fetch exceed the ceiling
- **THEN** the dialog shows the size and fetches nothing unless confirmed

#### Scenario: Unfinished files are carried
- **WHEN** a pull leaves files unfinished
- **THEN** the notice says so, names the count, and says the next publish keeps those files as the node has them

### Requirement: Ranged fetch, single-read upload and temp sweep
The plugin host SHALL fetch blobs as segment-aligned ranges as specified in `encrypted-pull`; SHALL serve upload segment reads from a single read of the file per upload, refusing with a typed error if the file's size or modification time changed between the first and the last segment; and SHALL sweep `.ipfs-sync/tmp/` when the plugin loads and at every pull start. The sweep at load SHALL run only while it holds `publish.lock` (a try-acquire; it skips when the lock is held), so it cannot remove the temporary file of a pull that is running in another process.

#### Scenario: Sweep skipped while a pull holds the lock
- **WHEN** the plugin loads while a CLI pull on the same vault holds `publish.lock`
- **THEN** the sweep does not run and no `.part` file is removed

#### Scenario: File edited during upload
- **WHEN** a file larger than one segment is edited while it is being uploaded
- **THEN** the upload of that file is skipped for this run with a notice and is retried on the next run, and no blob mixes two versions

#### Scenario: Sweep on load
- **WHEN** a crashed pull left `.part` files and the plugin loads
- **THEN** they are removed

### Requirement: Settings additions
The Encryption section of the settings tab SHALL show the vault state, the recorded highest sequence, whether the last pull was complete, the number of unfinished files, and `restoredFrom` when set, in the existing plain tab. The pull-ceiling setting (`pullConfirmAboveMb`) SHALL be a number of megabytes from 64 to 8192 (default 512) with a range check, present in the settings model, the stored-data parser and the settings migration (older stored data loads with the default).

#### Scenario: State display
- **WHEN** the tab is opened after an incomplete pull
- **THEN** it shows the recorded sequence, "last pull incomplete" and the count

### Requirement: No secrets in output, plain tab, accessibility
Dialogs, notices, the status bar and settings SHALL NOT display or persist the passphrase or keys beyond the setup step of the publish change. Dialogs SHALL have visible labels, text errors associated with fields, masked inputs with a reveal control, keyboard operation and no reliance on colour alone. Node-supplied text in notices and dialogs SHALL be fixed strings or escaped, and SHALL be rendered with `textContent` only (never `innerHTML`). Passphrase and slot dialogs SHALL NOT add a copy-to-clipboard control for the passphrase that does not clear the clipboard, and the plugin SHALL NOT add a clipboard-copy control for node-supplied text or secrets on mobile.

#### Scenario: Hostile text in a dialog
- **WHEN** a manifest `device` value contains markup
- **THEN** the first-pull dialog shows it as text, escaped, and no element is created from it

#### Scenario: Keyboard
- **WHEN** the user tabs through each new dialog
- **THEN** every control receives focus in reading order
