## Why

mvp-06 made publishing encrypted and left the read side closed: a second device cannot read the vault, the manifest `sequence` is enforced only by the publisher, and two devices cannot take turns without one of them losing work. This change (07a of a split: the original mvp-07 is now `mvp-07-encrypted-pull-second-device` = 07a and `mvp-07b-keys-history-guard-release-2` = 07b) delivers the read half of phase goal 7: a second vault or the CLI unlocks with the passphrase, tampering and rollback fail closed, and a device that pulled can publish without dropping what it could not restore.

07a ships no release and does not touch the fixture-only guard. A build of 07a still refuses to publish an unmarked vault and still refuses to pull into a populated unmarked directory. Real notes stay blocked until 07b.

Revision 3 of this set (2026-09-30) replaces the first draft after two independent reviews found it wrong about the delivered mvp-06 code: `critique-plan.md` (F-01..F-25) and `review-0.md` (P-01..P-21). Correction 2 (2026-09-30) folds the confirmation reviews `confirm-review.md` (Q-01..Q-24) and `confirm-critique.md` (C-01..C-14). `revision-notes.md` maps every finding to where it is resolved or why it is deferred or rejected.

Contracts: this change reads `mvp-06-encrypted-vault-publish` (design "Handoff to mvp-07", the specs `key-slots`, `encrypted-blobs`, `manifest-v2`, `encrypted-publish`, `threat-model`, and its reviews) and refers to them by name without restating them. Nothing in mvp-06's specs is edited; where this change tightens a behaviour it says so in a requirement.

The uncomfortable parts:
- **Concurrent publishing is detected late.** Two devices that publish at the same time on one shared MFS tree cannot be stopped from outside the node. 07a narrows the window (a name re-check before `name/publish`) and adds an explicit recovery (`pull --resolve-fork`), but the loser learns about it only at its next pull. Until then its edit exists on the node under no name.
- **The first pull trusts what the node serves.** A new directory has no baseline. A hostile node can serve an old genuine state and the device records it. 07a makes the user see and confirm the sequence, date and device, and offers `--expect-min-sequence` and `--expect-vault-id`; none of it is prevention.
- **The sequence floor lives on the device, outside the vault.** It survives `abandon`, deleting `.ipfs-sync/` and changing `mfsRoot`, but not deleting the per-user store (CLI) or the plugin data (plugin), and not a reinstall. Anyone holding the vault key can also publish a huge sequence and every device that pulls it records it; no command lowers a record.
- **The plugin cannot stream.** `requestUrl` buffers the whole response before the plugin sees it. 07a adds a segment-aligned ranged fetch for the plugin, but whether Obsidian's `requestUrl` honours `Range` with binary bodies is unverified until the 07b operator run. If a gateway answers 200 to a Range request the plugin discards the response, does not decrypt it, and refuses large files; a probe on the smallest blob decides this first so that a large file is never requested from a Range-ignoring gateway. Until the operator run records the outcome, large-file pull in the plugin is not advertised as working.
- **A device that cannot restore a path still vouches for it.** A path a device cannot restore (a name Windows refuses, a case collision, a file the gateway would not deliver) stays in the vault because the device's publish copies the node's entry unchanged. The cost: that device publishes entries it has never held, and pull exits 1 about them on every run until they can be restored. The alternative, refusing to publish, locked a device out for good when a gateway ignored `Range`.
- **`.obsidian/` stops syncing.** The publisher's default exclusions now cover the whole configuration folder, because pull has always refused it and an honest manifest must not contain entries pull refuses. Themes, snippets and hotkeys are not synced in this version.
- **Restore adds and replaces; it never deletes.** Restoring an older version puts that version's files on disk. Files created later stay. The next publish then publishes the mix.
- **07a is unverified inside Obsidian.** The operator run that proves the plugin flow is a 07b task. A defect found there reopens 07a code under a 07b task.

## What Changes

- **New decrypting pull** for the CLI and the plugin: unlock (new-device path included), authenticate `manifest.enc`, apply the sequence rules, show the first-pull confirmation, fetch and decrypt blobs with every mvp-06 reader requirement, temp-file and rename, fail closed per file, existing conflict policy, refusal of unsafe paths. The pull takes the same `publish.lock` file lock as publish.
- **RootState version 3** (`src/sync/root-state.ts`, not `state.ts`): `highestSequence`, a canonical-plaintext `manifestIdentity`, `previousIdentity`, an informational `complete` flag, `unmaterialized`, `devicesSeen`, `restoredFrom`, decoded strictly (no defaulting). Version 2 states are read and upgraded; version 3 states are refused by older builds. All four writers of the state (publish, resume adoption, unchanged publish, pull) are covered.
- **Device-local store** outside the vault-synced folder, holding a per-installation device id and a **sequence floor** keyed by `vaultId`.
- **Sequence enforcement on pull**: refuse older, refuse forks on the plaintext manifest identity (not the ciphertext hash), refuse another vault, record on first pull. `--allow-rollback` only with an explicit target. `--expect-min-sequence`, `--expect-vault-id`. First-pull confirmation.
- **Explicit targets**: `--root-cid`, `--manifest`, plugin pull-name `/ipfs/<cid>`. State that a root CID binds nothing client-side: the gateway decides.
- **Restore semantics** that fit the state model: restore leaves the baseline at the node's current manifest and never lowers the record.
- **`pull --resolve-fork`**: recovery from two devices publishing the same sequence.
- **Publisher deltas** (second-device publish): ahead and new-device messages say "pull first"; `--repair` no longer lifts "ahead" for a device with a baseline or a floor; publish copies the node's entries for paths this device could not restore instead of dropping them; a classified, time-bounded name re-resolve before `name/publish`, with the start root kept in the publish journal; the drift path leaves unnamed blobs alone once another device is known; a unique device label; an async lock-token check at the three places a run first writes (closes C5-02).
- **Path policy** as its own unit: a generated case-folding table, reserved names, Windows forms, 8.3 shapes, collisions, realpath containment on the CLI; the publisher's own exclusion matching is unchanged.
- **Relocation of shared helpers** (`TEMP_DIR`, `discardTemp`, target resolution) out of the plaintext reader's files, so that 07b's deletion moves nothing.
- **`abandon` prints the sequence floor it keeps**, and the plugin settings gain the pull-ceiling setting and the `/ipfs/<cid>` pull name.
- **Default exclusions** now include the configuration folder (`.obsidian/`, and `vault.configDir` in the plugin). The effective list, and so `excludesHash`, changes.
- **History file names** become `<16-digit sequence>-<cid>.enc` so order is readable without decrypting. Readers accept legacy `<cid>.enc` as oldest. 07b's `prune-history` consumes this.
- **Plugin**: pull runner, first-pull, restore (with an authenticated sequence and date in the confirmation), fork and large-pull dialogs, segment-aligned ranged fetch with a probe, total-bytes ceiling, temp sweep on load under the lock, single-read upload source (W-16).
- **W-16 is in this change on purpose.** The plugin becomes a second device that edits the same vault, which is when a torn upload (a blob mixing two versions of a file) becomes likely; the operator's decision-log entry assigned the item here. Its task has no dependencies and can be moved to another change without touching any other task.
- Documentation for the above; two-device integration suite; phase gate; independent review.

## Capabilities

### New Capabilities
- `encrypted-pull`: the decrypting pull, unlock, per-file verification, outcomes, locks, events, node read-only behaviour, resource ceilings.
- `rollback-detection`: the record (state and floor), the verdicts, explicit targets and flags, restore, fork resolution, limits.
- `second-device-publish`: publisher deltas, incomplete-pull refusal, concurrency detection, device identity, onboarding.
- `path-hardening`: the path policy and its application to manifests and to the file system.
- `history-naming`: sequence-prefixed history file names and the readers that accept both forms.
- `plugin-pull-ui`: pull runner behaviour, dialogs, ranged fetch, settings additions.

### Modified Capabilities
<!-- none: earlier changes' specs are not in openspec/specs/. Where this change replaces earlier behaviour (history names, default exclusions, the ahead message, repair), it says so in the requirement. -->

## Impact

- Code: `src/sync/` (state, sequence, pull, blob fetch, plan, fork resolution, path policy, history names, publisher deltas, carry-forward, relocated helpers), `src/kubo/` (`ipns.ts` and `client.ts`: a classified, time-bounded `name/resolve`), `cli/` (pull command, device store, realpath check, abandon output), `src/plugin/` (pull runner, dialogs, device store, settings model and store, abandon flow), `tools/gen-path-fold-table.mjs` and `tools/feature-op-mvp-06/policy.mjs` (history name rule), `tests/` (new suites). `src/crypto/` is read, not changed, except as a named reviewer.
- Not changed: the fixture-only guard modules and every caller of them (07b), the v1 plaintext reader (07b), key management and `prune-history` (07b), release tooling (07b).
- Dependencies: none added.
- Node: pull performs no mutation. Publish gains two read-only `name/resolve` requests per run that has work (none for a key created by that run).
- Migration: states of format 2 are upgraded on first write and journals of format 1 are read and rewritten as 2; history files written by an mvp-06 dev build (`<cid>.enc`) stay readable. No released build wrote any of them.
- Cadence: every task is inside the increment and the phase gate and the independent review are the last two; 07a has no post-finish tasks (32 tasks after Correction 2).
