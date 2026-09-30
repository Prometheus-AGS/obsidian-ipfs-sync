## Purpose

Defines changing the passphrase, raising the key-derivation cost, and accepting a key-slot file that another device changed, with honest statements about what these do not revoke. It replaces the first draft, which left open whether the old slot stayed in the file, allowed the cost to fall silently, and let the accept action move the local copy backwards without a warning.

## ADDED Requirements

### Requirement: Change passphrase by rewrap
The device SHALL offer a passphrase change that unlocks the vault key with the current passphrase, derives a new key-encryption key from a newly generated passphrase with a fresh 16-byte salt, and creates a new slot with a fresh slot identifier, a fresh wrap nonce and a fresh key commitment that wraps the same vault key. The vault content SHALL NOT be re-encrypted. The raw vault key bytes SHALL exist only inside the key-slot module during the operation and SHALL be overwritten afterwards. User-chosen passphrases SHALL NOT be offered. Because the vault key is not extractable after unlock, the change SHALL derive from the current passphrase a second time. The operation SHALL require that the device is up to date with the node (sequence and identity equal the record; whether the last pull restored every file is not required, because a rewrap reads no vault file), that the device holds `publish.lock` for the whole operation, and that no publish or maintenance journal is pending.

#### Scenario: Rewrap
- **WHEN** the passphrase is changed
- **THEN** the new slot has a different salt, slot identifier and nonce, the same vault key is recovered with the new passphrase, and no blob is rewritten

#### Scenario: Wrong current passphrase
- **WHEN** the current passphrase is wrong
- **THEN** the same single outcome as an unlock failure results and nothing changes

#### Scenario: Behind
- **WHEN** the node has a higher sequence than the device
- **THEN** the rewrap stops and asks the user to pull first

### Requirement: The new file replaces the old slot
The `keyslots.json` written by a rewrap SHALL contain exactly one slot, the new one. If the current file contains a slot of a type this version does not understand, the rewrap SHALL refuse before any derivation. After a rewrap, the old passphrase SHALL fail against the node's current `keyslots.json` and SHALL still open the copy in every earlier pinned root.

#### Scenario: Old passphrase on the current file
- **WHEN** the old passphrase is tried against the node's current `keyslots.json` after a rewrap
- **THEN** unlock fails

#### Scenario: Old passphrase on the previous root
- **WHEN** the previous root's `keyslots.json` is unlocked with the old passphrase
- **THEN** it still yields the vault key

#### Scenario: Unknown slot type
- **WHEN** the current file holds a slot of an unknown type
- **THEN** the rewrap refuses and says why

### Requirement: Cost is never silently lowered
A rewrap SHALL choose a cost within the ceilings of `key-slots` (131,072 KiB, 4 iterations) and SHALL require the new memory and the new iterations each to be at least the current slot's; a lower choice SHALL need an explicit confirmation that shows the current and the new cost. The interface SHALL name the cost in memory and iterations and warn that slower devices (phones) unlock more slowly.

#### Scenario: Higher cost
- **WHEN** the user selects the High preset
- **THEN** the new slot records 131,072 KiB and 4 iterations and unlocks with the new passphrase

#### Scenario: Lower preset
- **WHEN** the current cost is High and the user selects Standard
- **THEN** a downgrade confirmation shows both costs and nothing changes without it

#### Scenario: Beyond the ceiling
- **WHEN** a cost above the ceilings is requested
- **THEN** it is refused before any derivation

### Requirement: Old passphrases and copies keep working
The specification, the command output and the dialog text SHALL state before confirmation that the old passphrase and every old copy of the key-slot file (including those in earlier pinned roots) continue to open the vault after a rewrap, and that only re-encrypting under a new vault key revokes access, which this change does not provide. For a cost increase with the same passphrase the text SHALL also state that it does not protect against an attacker who holds the old slot at the old cost.

#### Scenario: Warning shown
- **WHEN** the change-passphrase or increase-cost command or dialog runs
- **THEN** it states before the confirm control works that old passphrases and old slot copies remain valid

#### Scenario: Same passphrase
- **WHEN** the cost is increased with the same passphrase
- **THEN** the text says the old cheaper slot in earlier roots is unaffected

### Requirement: Republish after a rewrap
A rewrap SHALL write the pending `keyslots.json` bytes into a maintenance journal (its own file and format, never the publish journal), write the file to the MFS root, verify by reading back through the immutable path that the file equals what was written, take a new root snapshot, pin it, re-resolve the name and require it to equal the value at the start, and publish the name. The manifest and its sequence SHALL NOT change. The device SHALL update its local key-slot copy, and the `keyslotsSha256` in its state, only after the publication succeeds. A failure at any step SHALL leave the previous published root in place. The journal SHALL record a phase (journaled, file written, snapshotted, published, local copy updated) after each step. On a rerun, the phase and the node decide: a node file equal to the journal's bytes SHALL complete the remaining steps without generating another slot; a name that already equals the journal's recorded snapshot root SHALL count the publication as done and SHALL NOT be refused for having moved; a node file equal to the old bytes SHALL discard the journal and start over; any other content (the node file matches neither, as after a lost race) SHALL be refused with a message that names `keys discard` and `keys accept-slots`. `keys discard` SHALL remove the maintenance journal after a confirmation and SHALL NOT touch the node; `keys accept-slots` SHALL clear a maintenance journal whose pending bytes are no longer on the node.

#### Scenario: Interrupted rewrap
- **WHEN** the process is killed after the new `keyslots.json` was written and before the name was published
- **THEN** a rerun completes the publication without generating another slot

#### Scenario: Killed after the name was published
- **WHEN** the process is killed after `name/publish` and before the local copy was updated, and the command is rerun
- **THEN** the rerun recognises the name as equal to the journal's snapshot root, updates the local copy and deletes the journal, and does not refuse for having seen its own publication

#### Scenario: Lost race leaves a way out
- **WHEN** another device's rewrap replaced the node's file so that it matches neither the journal nor the old bytes
- **THEN** the rerun refuses naming `keys discard` and `keys accept-slots`, and after `keys discard` publish and pull work again

#### Scenario: Sequence unchanged
- **WHEN** a rewrap completes
- **THEN** `manifest.enc` and the recorded sequence are unchanged

#### Scenario: Lock held
- **WHEN** a publish or pull holds `publish.lock`
- **THEN** a rewrap, an accept and a prune refuse with the lock text and change nothing

#### Scenario: Name moved during the rewrap
- **WHEN** another device publishes between the start and the name publication
- **THEN** the rewrap refuses to publish and says to pull first

### Requirement: Test unlock after publishing
After the name is published, the device SHALL fetch `keyslots.json` from the new immutable root, unlock it with the new passphrase and compare the recovered key with the one in use; on failure it SHALL report that another device's rewrap may have won and that the new passphrase may not open the vault, and SHALL NOT update the local copy.

#### Scenario: Lost race
- **WHEN** another device's rewrap replaced the node's file after this device's read-back
- **THEN** the test unlock fails, the report says so, and the local copy is unchanged

### Requirement: Journals of different operations do not mix
Publish and pull SHALL refuse with a typed error naming the operation when a maintenance journal is pending, and rewrap and prune SHALL refuse when a publish journal is pending; each refusal caused by a maintenance journal SHALL name `keys discard` and `keys accept-slots`. A file of one kind SHALL NOT be read as damaged by the other.

#### Scenario: Cross refusal
- **WHEN** a rewrap journal exists and publish runs
- **THEN** publish refuses without reading the file as a damaged publish journal and without any write

### Requirement: Other devices accept changed key slots
After a rewrap, another device's stored copy differs from the node's file, so its automatic operations SHALL keep refusing as `key-slots` requires. The device SHALL provide an explicit accept action that holds `publish.lock`, resolves the name once to one immutable root, reads `keyslots.json` and `manifest.enc` only from that root, unlocks the slot with the entered passphrase, authenticates the manifest under the resulting key, requires the `vaultId` to match, applies the sequence verdict of `rollback-detection` to that manifest, writes the exact bytes that unlocked as the new local copy, and updates `keyslotsSha256` in the state and in a pending publish journal if one exists. When the new slot's cost is lower than the current copy's in memory or iterations, the action SHALL show both costs and require confirmation. A slot file that unlocks but does not authenticate the manifest SHALL NOT be accepted.

#### Scenario: Accept after rewrap
- **WHEN** device B enters the new passphrase after A's rewrap
- **THEN** B's copy is replaced by the bytes that unlocked and its next pull or publish proceeds

#### Scenario: Attacker's slot file
- **WHEN** the node serves a slot file of another vault that unlocks with a passphrase the user typed
- **THEN** the manifest fails to authenticate and the copy is not replaced

#### Scenario: Automatic operations still refuse
- **WHEN** B pulls without running the action
- **THEN** it refuses with a message that names the action

#### Scenario: Downgrade warning
- **WHEN** the root being accepted holds a slot at a lower cost than B's copy
- **THEN** both costs are shown and the copy is replaced only after confirmation

#### Scenario: Restore across a rewrap
- **WHEN** `pull --root-cid <old root>` meets an older `keyslots.json`
- **THEN** it refuses naming `keys accept-slots --root-cid <old root> --allow-rollback`, and after that accept the pull can proceed under the older passphrase

#### Scenario: Restore by manifest needs no accept
- **WHEN** `pull --manifest <cid> --allow-rollback` (or the plugin's Restore action) selects a history entry under the current root after a rewrap
- **THEN** the pull proceeds with the current key-slot copy and no accept action is needed, because the blobs are encrypted under the vault key and the history entry is read from the current root

#### Scenario: One root
- **WHEN** the node's name moves while the action is running
- **THEN** both files still come from the one root resolved at the start
