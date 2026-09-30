## Why

07a (`mvp-07-encrypted-pull-second-device`) gives a second device the read side and lets it publish. Three things remain before the product can touch real notes: a passphrase cannot be changed and the key-derivation cost cannot be raised; the history folder stops the publisher at 1,999 entries with no way to prune it; and the fixture-only guard that keeps real notes out is still in force. This change (07b) delivers those, removes the plaintext v1 reader, and ends with Release 2 (v0.3.0), which is produced only if a checker confirms that the code that ships is the code that an independent reviewer read and an operator ran inside Obsidian.

Correction 2 (2026-09-30) folds the confirmation reviews `confirm-review.md` (Q-01..Q-24) and `confirm-critique.md` (C-01..C-14), stored unchanged in this directory: the evidence scheme gains a trust anchor outside the repository, a clean-export build, per-tree review records and checker-held required lists.

Revision 3 (2026-09-30) replaces the guard model of the first draft. The first draft removed the guard last, by swapping two modules for permissive ones after the review, and could not reach its own success state: the fixture policy lived in about fourteen files and the review hash excluded the build inputs (critique F-01, F-02; review P-03). The operator's decision: prepare the real post-removal code first, on a branch; the reviewer reads that tree; the operator run uses that build; and only the release is gated. `revision-notes.md` maps every finding to its resolution.

Requires 07a complete (its review closed). 07b reads 07a's history-naming order, the sequence floor, the incomplete-pull flag and the device-local store.

Contracts: mvp-06 (`key-slots`, `encrypted-blobs`, `manifest-v2`, `encrypted-publish`, `threat-model`, design "Handoff to mvp-07") and 07a. Nothing is edited in either.

The uncomfortable parts:
- **The evidence files are attestations, not proofs.** The review record, the operator-run result and the phone-timing record are files written by people and tools on the same machine as the agents that could forge them. The checker raises the cost of forging (a tree hash over everything that ships, git-history binding or an SSH signature checked against a trust anchor that is enrolled on a terminal and lives outside the repository, a per-user directory with owner checks, required lists held in the checker, an interactive terminal step with a printed nonce), and the docs say so. A determined insider with repository write access and a terminal can still produce all three, and an agent that can read the operator's signing key can sign.
- **The unsigned form is weaker than the first draft made it.** The git-history form no longer requires a record with exactly one commit, because that dead-ended the first defect-loop iteration. A later edit of the record is now printed and typed by the operator at `record`, not excluded.
- **Lifting the guard is the moment the risk becomes real.** After it, a bug in the crypto, the journal, the pull or the path policy can expose a real note, not a fixture. The branch that removes the guard exists before the review on purpose: the reviewer reads the tree that ships. The cost: any source change after the review or the run invalidates both, and the operator repeats the run.
- **The branch is real code that can publish real notes.** Until the release is merged, `main` keeps the guard and the branch must not be installed on a real vault. Nothing technical stops an operator who installs the branch build by hand.
- **A rewrap does not revoke.** Old passphrases and old key-slot copies keep opening the vault. Raising the cost with the same passphrase does nothing against an attacker who holds an old pinned cheaper slot.
- **Argon2id at 64 MiB and 3 iterations has never run on a phone.** Release 2 may ship without that measurement only by an explicit operator acceptance recorded through an interactive terminal step, and the release notes then say so.
- **Silent per-file corruption of unchanged files by someone with node write access is not detected by the publisher** (W-14). The mass-removal guard stops a publish that removes more than half the manifest, not one that removes 49 percent.
- **Variant B is gone.** The first draft produced a fixture-only pre-release when the checker failed. With the real-diff model a failing checker means no release. Whether to keep a fixture-only fallback is an open question.

## What Changes

- **Key management**: `keys change-passphrase` (rewrap: the new file contains only the new slot), `keys increase-cost` (never silently lowers cost), `keys accept-slots` (one resolved immutable root, exact unlocking bytes written, `keyslotsSha256` updated, downgrade warning), `keys discard` (clears a stale maintenance journal), a separate journal file and format with a phase marker for rewrap and prune, one shared republish primitive, all three operations under `publish.lock`, a post-publish test unlock with the new passphrase.
- **`ipfs-sync prune-history --keep N`** using 07a's name order; at least 20 kept; refuses unless the newest authenticates, its prefix matches its decrypted sequence and equals the node manifest's sequence, and the newest 20 agree.
- **Mass-removal guard** in the engine (CLI and plugin) with a confirmation dialog; exclusion-driven removals are counted apart.
- **Plaintext v1 reader removal**: every v1 file deleted or adapted (listed), the `--allow-plaintext-v1` and `--manifest-file` flags, the latch consult, `encryptedSeen` as a requirement; a root with `keyslots.json` and no `manifest.enc` is refused; a planted `manifest.json` is never read.
- **Fixture policy centralised** behind two small modules (publish, pull) and a dependency-free constants file that every caller uses (`node-safety.ts`, `defaults.ts`, notices, settings copy, vault opener, runners, publish session, CLI commands, the fixture generator), with the symlink and state-folder safety check in its own module, called from the pull orchestration, that survives removal.
- **Guard removal on a branch**: permissive modules keeping their export names; the tests and WebView-probe entries that change are named.
- **Guard evidence**: a tree hash over `src/`, `cli/`, build inputs and the tools that judge the release, computed from git blobs with ignored and staged files refused; bundle hashes from a reproducible build in a clean export with a scrubbed environment; a machine-readable review record per tree with a coverage list, authenticated by git history or by a signature against an operator-enrolled trust anchor; an operator-run result in a per-user directory with installed-file hashes and a freshness bound; phone timing or a tree-and-build-bound acceptance only through an interactive terminal step; the required assertion ids, checklist tests (with minimum counts and zero skips), sentences and audit acceptance held in the checker; the checker's own hash recorded; `checkDistBundles`; a stated defect loop.
- **Phone timing**: a plugin command that measures one derivation and prints a record with the first 16 characters of the plugin build hash, and `tools/record-phone-timing.mjs`.
- **Operator run**: `tools/feature-op-mvp-07.mjs` based on the encrypted-era mvp-06 script, with assertions for everything 07a and 07b claim in Obsidian.
- **Release 2 (v0.3.0)** tooling and procedure: the `tools/release/*` constants refactor with a Release 1 regression check, `tools/release-mvp-07.mjs` that refuses unless the checker passes and asserts shipped bytes equal the recorded build hashes; the version bump happens before the review so the tool edits no hashed file.
- **Documentation**: README, CHANGELOG, runbook, DESIGN sections 4 and 8, historical scripts marked, the attestation statement and the defect loop.
- **Deferred items carried from mvp-06 reviews** are closed here or recorded: W-14, W-15, W-16 (07a), N3-09, C5-02 (07a), R5-11, R5-12 (done), R5-13, `pnpm audit`, N2-13, handoff items 4 and 5.

## Capabilities

### New Capabilities
- `key-management`: rewrap, cost increase, accept changed slots, journals, republish.
- `history-pruning`: `prune-history`.
- `mass-removal-guard`: the publish-side guard and its confirmation.
- `plaintext-removal`: removal of the v1 reader and its consequences.
- `guard-removal`: policy centralisation, the permissive replacement, the tests and probe entries that change.
- `guard-evidence`: tree hash, build hashes, review record, operator-run record, phone timing, the checker, checklist, defect loop, attestation statement.
- `plugin-key-management-ui`: dialogs, settings additions, the measure command.
- `release-2`: v0.3.0 procedure and tooling.

### Modified Capabilities
<!-- none -->

## Impact

- Code: `src/crypto/key-slots.ts` (rewrap), `src/sync/` (key management, republish primitive, prune, removal guard, plaintext removal, policy modules), `cli/` (keys, prune, pull flag removal), `src/plugin/` (dialogs, wiring, measure command), `tools/` (checker, recorder, operator run, release tool, hook-isolation changes), `tests/`, docs.
- Removed: the v1 reader and its flags, the latch consult, the fixture policy scattered across files (replaced by two modules; the modules become permissive on the branch), `Variant B`.
- Dependencies: none added.
- Branch: the post-removal tree lives on a branch; `main` keeps the guard until the release commit.
- Cadence: the increment ends with the phase gate on the branch tree and the independent review. The operator run, phone timing, release record and outward steps are post-finish tasks and are marked as such. 36 tasks after Correction 2 (32 inside the increment, 4 post-finish).
