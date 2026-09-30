## Purpose

Defines changing the passphrase, raising the key-derivation cost, and accepting a key-slot file that another device changed, with honest statements about what these do not revoke.

## ADDED Requirements

### Requirement: Change passphrase by rewrap
The device SHALL offer a passphrase change that unlocks the vault key with the current passphrase, derives a new key-encryption key from the new passphrase with a fresh 16-byte salt, and creates a new slot with a fresh slot identifier, a fresh wrap nonce and a fresh key commitment that wraps the same vault key. The vault content SHALL NOT be re-encrypted. The new passphrase SHALL be generated under the rules of `key-slots` (user-chosen passphrases are not offered; they are a deferred feature). Because the vault key is not extractable after unlock, the change SHALL derive from the current passphrase a second time.

#### Scenario: Rewrap
- **WHEN** the passphrase is changed
- **THEN** the new slot has a different salt, slot identifier and nonce, the same vault key is recovered with the new passphrase, and no blob is rewritten

#### Scenario: Wrong current passphrase
- **WHEN** the current passphrase is wrong
- **THEN** the same single outcome as an unlock failure results and nothing changes

### Requirement: Old passphrases and copies keep working
The specification, the command output and the dialog text SHALL state that the old passphrase, and every old copy of the key-slot file (including those in earlier pinned roots), continue to open the vault after a rewrap, and that only re-encrypting under a new vault key revokes access, which this change does not provide.

#### Scenario: Copy in an old root
- **WHEN** the previous root's `keyslots.json` is unlocked with the old passphrase after a rewrap
- **THEN** it still yields the vault key

#### Scenario: Warning shown
- **WHEN** the change-passphrase dialog or command runs
- **THEN** it states before confirmation that old passphrases and old slot copies remain valid

### Requirement: Increase key-derivation cost
The device SHALL offer to re-wrap the vault key with higher Argon2id parameters within the ceilings of `key-slots`, using the current passphrase or a newly generated one, through the same rewrap procedure. The interface SHALL name the cost in memory and iterations, warn that slower devices (phones) unlock more slowly, and state that old slot copies keep their old, lower cost.

#### Scenario: Higher cost
- **WHEN** the user selects the maximum preset
- **THEN** the new slot records 131,072 KiB and 4 iterations and unlocks with the passphrase

#### Scenario: Beyond the ceiling
- **WHEN** a cost above the ceilings is requested
- **THEN** it is refused before any derivation

### Requirement: Republish after a rewrap
A rewrap SHALL write the new `keyslots.json` to the MFS root through a journalled step that can resume, verify by reading back through the immutable path that the file equals what was written, then take a new root snapshot, pin it and publish the name. The manifest and its sequence SHALL NOT change. The device SHALL update its local key-slot copy only after the publication succeeds. A failure at any step SHALL leave the previous published root in place.

#### Scenario: Interrupted rewrap
- **WHEN** the process is killed after the new `keyslots.json` was written and before the name was published
- **THEN** a rerun of the command completes the publication without generating another slot

#### Scenario: Sequence unchanged
- **WHEN** a rewrap completes
- **THEN** `manifest.enc` and the recorded sequence are unchanged

### Requirement: Other devices must accept changed key slots
After a rewrap, another device's stored copy differs from the node's file, so its automatic operations SHALL keep refusing as `key-slots` requires. The device SHALL provide an explicit action to accept changed key slots: the user enters the passphrase, the device unlocks the node's slot file, authenticates the node's `manifest.enc` under the resulting vault key, requires the `vaultId` to match, and only then replaces its local copy. A slot file that unlocks but does not authenticate the manifest SHALL NOT be accepted.

#### Scenario: Accept after rewrap
- **WHEN** device B enters the new passphrase after A's rewrap
- **THEN** B's copy is replaced and its next pull or publish proceeds

#### Scenario: Attacker's slot file
- **WHEN** the node serves a slot file of another vault that unlocks with a passphrase the user typed
- **THEN** the manifest fails to authenticate and the copy is not replaced

#### Scenario: Automatic operations still refuse
- **WHEN** B pulls without running the action
- **THEN** it refuses with a message that names the action

### Requirement: Publish-only-when-current
A rewrap SHALL require that the device is up to date with the node under the rule of `second-device-publish`.

#### Scenario: Behind
- **WHEN** the node has a higher sequence than the device
- **THEN** the rewrap stops and asks the user to pull first
