## Why

mvp-06 made publishing encrypted but left three things undone: a second device cannot read the vault, nothing enforces the manifest `sequence` on the read side, and real notes are still blocked by the fixture-marker guard. This change delivers the read half of phase goal 7 (a second vault unlocks with the passphrase, tampering fails closed), lets that second device publish, adds passphrase change and cost increase, removes the plaintext v1 reader, and lifts the guard only when independent evidence says it is safe. It ends with Release 2 (v0.3.0), which is usable on real notes only if the guard-removal preconditions hold; otherwise it ships as another fixture-only pre-release.

Contracts: this change reads `mvp-06-encrypted-vault-publish` (design "Handoff to mvp-07", the specs `key-slots`, `encrypted-blobs`, `manifest-v2`, `encrypted-publish`, `threat-model`, and `review-0.1.md`) and refers to them by name without restating them. Anything it needs changed in mvp-06 is listed in design.md as an open question, not edited.

The uncomfortable parts:
- **Nothing here enforces rollback protection on a device that has never pulled.** The first pull trusts whatever authentic state the node serves. A node operator can also replay any genuine old object. Sequence enforcement is detection for devices with a baseline, not prevention.
- **Lifting the guard is the moment the risk becomes real.** Before it, a bug in the crypto or the journal cannot expose a real note. After it, one can. That is why the guard comes off last, behind three evidence checks a tool verifies, and why the reviewed code must be exactly the code that ships.
- **Argon2id at 64 MiB / 3 iterations has never run on a phone.** Release 2 may ship without that measurement only by an explicit, recorded operator acceptance.
- **A rewrap does not revoke.** Old slot copies and old passphrases keep opening the vault; the UI must say so before the user believes their old passphrase is dead.
- **Operator-run steps and outward steps sit outside the cadence increment**, because the delivery freeze fingerprints the whole repository.

## What Changes

- New decrypting pull for the CLI and the plugin: unlock, authenticate `manifest.enc`, enforce the sequence, fetch and decrypt blobs with every reader requirement of mvp-06, temp-file and rename, fail closed per file, existing conflict policy, refusal of executable and configuration paths.
- New sequence enforcement: refuse a lower sequence than recorded, refuse an equal sequence with different content, record on first pull, and an explicit `--allow-rollback` (plugin: confirmation dialog) for deliberate point-in-time restore.
- New explicit root target: pull can be pointed at an immutable root CID (`--root-cid`, plugin pull-name `/ipfs/<cid>`), for restore and for verification.
- New second-device publish: a device that pulled holds state, slot copy and sequence and may publish when it is up to date.
- New key management: change passphrase (rewrap), increase key-derivation cost, and accept changed key slots (authenticated by the manifest), each with a journal-backed republish.
- Removal of the plaintext v1 reader, `--allow-plaintext-v1`, `--manifest-file`, and the `encryptedSeen` latch's role.
- Guard removal as the last code task, behind a checker that refuses unless the reviewed-code hash, the operator-run result and the phone-timing evidence (or a recorded operator acceptance) all check out. The guard policy is first isolated into two small modules so removal is a reviewed, hash-verified replacement.
- Phone timing support: a command that measures key derivation time on the device.
- Release 2 (v0.3.0) tooling `tools/release-mvp-07.mjs` with two release-note variants and a rule that selects between them.
- Operator-run feature operation `tools/feature-op-mvp-07.mjs` in Obsidian, plus a `--verify-only` simulation.
- Documentation: README, CHANGELOG, DESIGN.md sections 4 and 8.

## Capabilities

### New Capabilities
- `encrypted-pull`: the decrypting pull, unlock, per-file verification, paths, events, node read-only behaviour.
- `rollback-detection`: recording and enforcing the sequence, restore semantics.
- `second-device-publish`: publishing from a device that pulled, the up-to-date rule.
- `key-management`: passphrase change, cost increase, accepting changed key slots.
- `plaintext-removal`: removal of the v1 reader and its flags.
- `guard-removal`: the preconditions, the checker and the exact removal.
- `plugin-encrypted-ui`: plugin dialogs, settings additions, phone-timing command.
- `history-pruning`: `prune-history --keep N` for the manifest history folder.
- `release-2`: v0.3.0 procedure, the two variants, approvals.

### Modified Capabilities
<!-- none: earlier changes' specs are not in openspec/specs/. Where this change replaces earlier behaviour (pull guard, v1 reader, marker semantics), it says so. -->

## Impact

- Code: `src/crypto/` (rewrap and slot-acceptance helpers), `src/sync/` (encrypted pull, sequence record, unlock for pull, key management, guard modules), `cli/` (pull, keys commands), `src/plugin/` (pull runner, dialogs, settings), `tools/` (feature operation, guard checker, release tool), fixtures unchanged; docs.
- Removed: manifest v1 reader, `--allow-plaintext-v1`, `--manifest-file`, `pulled-fixture` marker semantics and both fixture guards (last task).
- Dependencies: none added.
- Node: pull performs no mutation. The feature operation publishes to a per-run demo root and, for the tamper check, writes a prepared tampered copy inside that same root; it changes no key beyond the owned key.
- Cadence: the increment covers the code, docs, release tooling, scripts and the final security review. The operator run, phone timing, guard removal, the local release record and every outward step are post-finish tasks and are marked as such.
