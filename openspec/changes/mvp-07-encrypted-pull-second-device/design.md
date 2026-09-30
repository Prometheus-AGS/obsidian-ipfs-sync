## Context

Contracts read for this design (referenced, not restated or altered): mvp-06 `design.md` (key hierarchy, byte formats, publish flow, "Handoff to mvp-07"), its specs `key-slots`, `encrypted-blobs`, `manifest-v2`, `encrypted-publish`, `threat-model`, and `review-0.1.md` (S-01 to S-23, all accepted there). An independent delta review of mvp-06 is running and may change it slightly; where this design depends on an mvp-06 detail it names it, and Open Questions lists anything that needs an mvp-06 change.

Also read: plan.md change 7, decision-log 2026-09-30 sections (mvp-04 to mvp-06), `.prometheus/gotchas.md` (forged manifest, freeze lesson, GitHub receipt), and the existing tools `tools/feature-op-mvp-05.mjs` (manual trigger, verify-only, tamper-expect, lock file, result file outside the repo, wait-for-Enter, Refusal guard for the real vault) and `tools/release-mvp-05.mjs` with `tools/release/*.mjs` (plan/record modes, fixed constants, notes with the fixture-only opening, never runs git or gh).

Facts that shape this change: the node is open-write and anyone can `name/publish` under any key stored on it; old roots stay pinned forever; the plugin transport is `requestUrl`; the plugin cannot see symlinks or read partial files (mvp-05); the earlier pull already refuses `.obsidian/plugins/` and exclusion-list paths; pull writes a `pulled-fixture` marker into populated destinations and refuses non-fixture non-empty ones (mvp-06 marker rules).

## Goals / Non-Goals

**Goals:**
- A second device unlocks and restores a vault byte for byte, with every mvp-06 reader requirement applied and nothing partial written on failure.
- Sequence enforcement that is honest about what it does and does not prevent.
- Two devices can take turns publishing; a passphrase can be changed and the KDF cost raised without re-encrypting.
- The guard comes off only when a tool confirms independent review of the exact code, an in-Obsidian run, and a phone timing or informed acceptance.
- Release 2 says exactly what it can and cannot do.

**Non-Goals:** revocation or VCK rotation, multi-writer merge, device-to-device pairing (SPAKE2, UCAN), padding, hiding metadata, mobile verification beyond the timing command, the history store (mvp-08), the real-vault run (mvp-10).

## Decisions

### 1. Files and layering
`src/sync/`: `encrypted-pull.ts` (orchestration), `pull-unlock.ts` (identity-security-engineer: unlock over fetched bytes, new-device path, cost confirmation), `sequence-record.ts` (pure rules), `blob-fetch.ts` (bounded pool, decrypt to temp, verify, rename), `key-management.ts` (rewrap, cost change, accept-slots), `publish-guard.ts` and `pull-guard.ts` (the guard policy, isolated), `state.ts` (additive fields). `src/crypto/`: `rewrap.ts`, `slot-acceptance.ts` (identity-security-engineer). `cli/`: `pull-command.ts` (changed), `keys-command.ts` (`keys change-passphrase`, `keys increase-cost`, `keys accept-slots`). `src/plugin/`: pull runner changes, dialogs (uiux-lead), settings additions, the measure command. `tools/`: `feature-op-mvp-07.mjs`, `check-guard-preconditions.mjs`, `release-mvp-07.mjs` (shares `tools/release/*` parameterised by release). Kebab-case throughout. Crypto and secret-handling files: identity-security-engineer only.

### 2. Pull flow
1. Take the lock; require an unlocked key or prompt (once per session in the plugin). Marker/destination guard (still present until the last task) runs first.
2. Resolve the target: IPNS name (`--name`, or the owned key's ID), or `--root-cid`. `name/resolve` with `nocache=true`.
3. Read-only fetches with caps (mvp-06): `keyslots.json`, `manifest.enc` (or `manifests/<cid>.enc` for `--manifest`), via `files/stat` first.
4. Key slots: with a local copy, unlock it first and compare bytes (mismatch is a refusal that names the accept action of section 8); without one (new device), parse canonically, apply bounds, work budget and cost confirmation, unlock the node's slot.
5. Authenticate `manifest.enc`; require `vaultId` equality; apply the caps; apply the sequence rule (section 3); check paths (section 6). Any failure aborts before a blob is requested.
6. Store the local key-slot copy (only now).
7. Plan with the existing three-way planner on plaintext sha256. For each file to fetch: expected blob size from the manifest size; stream `/ipfs/<manifest.rootCID>/<blobName>`; decrypt segment by segment with name-bound AAD; append to `.ipfs-sync/tmp/<random>.part`; incremental sha256; on the final segment check file identifier (header), size, sha256; conflict copy first when needed; rename. Failure: delete the temp file, count the file failed, continue.
8. Write state (sequence and manifest hash, per-file base), emit events, release the lock.
Blobs are read from the authenticated `rootCID` tree, not from `<root>/current/`, so replacing blobs in the mutable MFS tree cannot affect a pull; an attacker's only route is a manifest that authenticates, which needs the vault key, or a replay of a genuine older manifest, which the sequence rule handles.

### 3. Sequence record and rules
State (additive to mvp-06's state): `vaultId`, `sequence` (highest accepted), `manifestSha256` (of `manifest.enc` at that sequence), `restoredFrom` (highest older sequence accepted by a deliberate restore, or absent). Rules in order: different `vaultId` -> refuse; lower than `sequence` -> refuse unless the restore flag; equal with a different hash -> refuse (fork, never overridable); equal with the same hash or higher -> proceed. A missing `manifestSha256` (state written before this change) is treated as unrecorded: the pull records it. The record is written when the pull has processed the manifest, and only ever raised.

**`--allow-rollback` (decision and justification).** The append-only history under `manifests/` exists to allow point-in-time restore (DESIGN 4.1), and each history entry has a lower sequence, so a strict rule with no override would make that feature unusable. The alternative, silently accepting lower sequences when the target is a history entry, would let a node replay an old root and have it accepted by naming it as history. So: default refuse; an explicit operator act (flag or confirmation dialog) accepts one restore; the record is never lowered; the next publish is a new higher version of the restored content. The flag cannot override a fork or a vault mismatch. It is not a security control against a compromised operator, only against the node.

Limits (stated in docs): a new directory has no baseline; the node can withhold updates forever; a genuine old object cannot be told from a current one except by its sequence.

### 4. Wrong passphrase, no oracle
One typed outcome for wrong passphrase, damaged slot and failed commitment (mvp-06). All three do the full derivation first. No lockout or delay is added, because the public slot can be attacked offline at will and a client-side counter would only annoy the honest user. Distinct, non-oracle errors: missing slot file; manifest not authenticating after a successful unlock (the passphrase was right, so this discloses nothing to a party who cannot type into the user's dialog).

### 5. First-pull trust (TOFU)
A new directory trusts the IPNS name it is given and the passphrase. Because anyone with RPC write access can repoint a key stored on the node, the name alone is not a trust anchor; the passphrase is. A repointed name serves someone else's vault, whose slot will not open with the user's passphrase (commitment check), so the pull fails closed; a device that already has a stored slot copy refuses on the byte comparison. What a repoint can still do is deny service or serve an older genuine state to a device without a baseline.

### 6. Refused paths (encrypted-pull spec)
Refused list: any path with an unsafe segment; anything at or under `.obsidian/` (this removes the earlier allowance for Obsidian's own JSON files; the earlier demos synced them, and this change stops that on purpose because configuration and plugins are the code-execution surface of a forged manifest); anything under `.ipfs-sync/` or `.git/`; anything matching the effective exclusion list. There is no include option for plugins. Whether to allow a whitelist of non-plugin `.obsidian/*.json` files later is a product question (Open Questions).

### 6a. Path hardening (required, from the mvp-06 early review)
mvp-06 extracts `untrustedPathReason` into `src/sync/manifest-paths.ts`. This change builds on it and must add: Unicode fold handling for the state, configuration and VCS folder names (U+0131 and U+017F), trailing dots and spaces, alternate data streams, 8.3 names, and the exclusion and `.obsidian/` checks at the manifest layer (not only when writing), so an authenticated manifest from a compromised device cannot name executable or configuration paths. This is required work, not an option.

### 7. Blob fetch and memory
One segment plaintext plus one ciphertext in memory per file in flight; the pool bound follows the earlier pull (4 to 6), which at six large files is about 96 MB of segments in flight, unmeasured. Sizes are checked before decryption (`22 + 28n + size`). Temp files live in `.ipfs-sync/tmp/` and are swept at pull start. Plugin reads for local hashing keep the read cap of mvp-05.

### 8. Key management
**Rewrap.** Requires being up to date and unlocked (derive from the current passphrase a second time to get raw VCK bytes briefly). Steps: obtain a new passphrase (generated only; user-chosen passphrases are deferred in mvp-06), choose cost (Standard 65,536 KiB / 3 iterations; High 131,072 KiB / 4; current is shown), derive KEK with a fresh salt, build a new slot (fresh slot id, fresh wrap nonce, fresh commitment), overwrite the vault key bytes, write the pending `keyslots.json` bytes into the journal (type `rewrap`), write it to the MFS root, read back through the immutable path, snapshot the root, pin, `name/publish`, then update the local copy and clear the journal. `manifest.enc` and the sequence are untouched. Resume: if the node's `keyslots.json` equals the journal's bytes, finish the remaining steps; if it equals the old bytes, discard the journal and start over; otherwise refuse.
**Old slots stay valid**, and the copy in every earlier pinned root still opens the vault with the old passphrase and at the old cost. The dialog and command say so before the confirm control works.
**Accept changed slots.** After a rewrap by another device the local copy differs from the node's. The automatic refusal of mvp-06 stays; the explicit action unlocks the node's slot with the entered passphrase, authenticates the node's `manifest.enc` under the resulting key (an attacker's slot cannot), requires the `vaultId` to match, and then replaces the copy. This extends mvp-06's comparison rule with a proof path and does not weaken it; it is listed as an Open Question because mvp-06's wording says "refuse on any difference".
**Cost increase** is the same procedure with the same or a new passphrase; presets stay within the mvp-06 ceilings.

### 9. Second-device publish
State after a pull contains vault identity, sequence and slot copy, so mvp-06's "new device" refusal no longer applies. **Multi-publisher guard** (mvp-06 handoff item 4): each installation gets a random device identifier used as the manifest `device` (the earlier default `cli` is not unique); when the latest authenticated manifest names another device, or the state records that another device published, the drift path removes nothing that the new manifest does not name and only reports it, because blobs written by another publisher before its manifest looks unnamed to this one. The cost is orphaned blobs, which are harmless. The publish rule is: node sequence equals recorded sequence; ahead means pull first; behind is the state-behind error. Publish flow, journal, drift, read-back and lock are mvp-06's, unchanged. No manifest merge.

### 10. Plaintext removal
Delete the v1 manifest reader and validator, `--allow-plaintext-v1`, `--manifest-file`, the `pulled-fixture` writing (the pull guard still accepts either marker until the last task), and stop consulting `encryptedSeen`. A root with `manifest.json` and no key slots is refused with a message that plaintext publications are no longer supported. Tests assert refusal.

### 11. Guard isolation and the checker
Isolation task: create `src/sync/publish-guard.ts` (marker acceptance, the review-pending message, the plugin notice policy) and make `src/sync/pull-guard.ts` the only place for the destination rule, including the plugin variant that ignores `.obsidian/` and `.ipfs-sync/`. Callers only call exported functions. Post-removal content: the same exports as permissive no-ops (so callers do not change), plus a comment naming the decision.
**Checker `tools/check-guard-preconditions.mjs`** (read-only; exit 0 only if all three pass; prints each):
- **A. Review file** `openspec/changes/mvp-07-encrypted-pull-second-device/review-final.md` containing the lines `Reviewer: security-reviewer`, `Verdict: APPROVED`, `Open critical: 0`, `Open high: 0`, `Reviewed-tree-sha256: <64 hex>`, `Guard-after-removal-sha256: publish-guard.ts=<64 hex> pull-guard.ts=<64 hex>`. The tool recomputes the tree hash: SHA-256 over lines `<relative path>\t<file sha256>\n` in sorted order, for every file under `src/` and `cli/` except the two guard modules (tests excluded), and compares.
- **B. Operator-run result** `<tmp>/ipfs-sync-feature-ops/feature-op-mvp-07.json` with `mode: "manual"`, `passed: true`, `codeTreeSha256` equal to the recomputed hash (which also covers the guard modules as they were during the run: the run records the hash of the tree excluding the guard modules plus each guard module's hash before removal), and required assertion ids all passed: `ciphertext-only-on-node`, `plaintext-restored-byte-equal`, `wrong-passphrase-refused`, `sequence-recorded`, `tamper-refused-nothing-written`, `pull-no-node-mutation`, `conflict-copy-kept`, `only-demo-root-and-owned-key-changed`.
- **C. Phone timing** `<tmp>/ipfs-sync-feature-ops/phone-timing.json` (device model, OS, foreground seconds, `m=65536 t=3 p=1`, measured by the plugin command) or a decision-log line `PHONE-TIMING-ACCEPTANCE: <date> <operator statement>`; the checker reports which one it found. An acceptance makes the release notes list the phone timing as unverified.
The guard-removal task pastes the checker output, replaces the two modules with the reviewed content (checker confirms the hashes), then runs unit tests, constraint checks, the WebView probe and `--verify-only`. The reviewed content is fixed at review time, so the only post-review code change is a replacement whose hash the reviewer recorded.

### 12. Phone timing command
"IPFS Sync: Measure key derivation time" runs one Argon2id derivation at the default parameters on random input in the foreground and shows seconds and platform. A small script `tools/record-phone-timing.mjs` writes the evidence file from the operator's numbers and screenshot path. The plugin must be installed on the phone by the operator's own means; that is outside this change.

### 13. Release 2
`tools/release-mvp-07.mjs` reuses `tools/release/*.mjs`, parameterised by a release descriptor (version 0.3.0, feature-op file, notes builder, evidence names) instead of copying. Modes and constraints as in the release-2 spec. Variant selection rule (in code and printed): `A` iff `check-guard-preconditions` exits 0 AND the guard modules' hashes equal the recorded post-removal hashes; else `B`. Notes skeletons:
- **Variant A opening**: "IPFS Sync 0.3.0 encrypts your vault on your device before it reaches your kubo node, and restores it on a second Obsidian desktop vault or the CLI with the passphrase. It can: publish and pull real notes, keep your local edit as a dated copy on conflict, refuse tampered or older states on a device that has a recorded state. It cannot: hide how many files you have, their exact sizes or when you publish; stop the node from showing a device with no recorded state an old copy; take back an old passphrase or old key-slot copy after you change it; recover a lost passphrase; or claim mobile support (not verified[; phone key-derivation timing was accepted unmeasured])."
- **Variant B opening**: "IPFS Sync 0.3.0 (fixture-only). Do not use this release on real notes: publishing a vault without the fixture marker is still refused. It encrypts fixture vaults ... [same cannot list]".
Both then list limitations, unverified items, checksums, minimum Obsidian version 1.12.3, and status (pre-release). Publication receipt: pending unless an advertising page with absolute URLs exists (gotchas 2026-09-30).

### 14. Feature operation (operator-run, post-finish)
`tools/feature-op-mvp-07.mjs`, same conventions as the mvp-05 script: `--trigger=manual` only; `--verify-only` with the CLI standing in; `--tamper-expect` (with verify-only, flips one expectation and must exit 1); per-run demo root `/obsidian-vault-sync/mvp07-demo/<runid>`; lock file in the OS temp directory; result at `<tmp>/ipfs-sync-feature-ops/feature-op-mvp-07.json` (verify-only writes a different file the checker refuses); throwaway vaults in the OS temp directory only; the operator's real vault refused by a guard; nothing written into the repository; `--evidence` paths recorded; the timeout countdown starts only when the operator says ready (Enter), not at script start.
Script prepares: build check; two throwaway fixture vaults (marker `fixture`) V1 and V2 with the built plugin installed and version 3+ settings (endpoints, demo root, owned key, pull name empty); the passphrase file path `<tmp>/ipfs-sync-feature-ops/mvp07-passphrase.txt` (0600, created empty) into which the operator saves the generated passphrase so the script can verify (a throwaway vault, so the show-once rule is relaxed; stated).
Operator steps (each with a wait and a printed prompt):
1. V1: Settings, Encryption, set up (generated passphrase; save it to the passphrase file; acknowledge); run "Publish vault". Script sees V1's state (sequence 1) and a changed root.
2. Script verifies ciphertext-only on the node (listings, no fixture words in any object, magics, key-material search with the test-only hook) using the passphrase file.
3. V2: run "Pull vault": first enter a WRONG passphrase (expected refusal, one outcome, V2 unchanged), then the right one. Script verifies every V2 file equals V1's plaintext byte for byte, V2 state holds sequence 1, the manifest hash and the slot copy; pull made no node mutation (snapshots before and after).
4. Script edits note X in V1 and in V2 (different text); operator runs Publish in V1 (sequence 2) then Pull in V2: script verifies X has V1's text, the dated conflict copy has V2's text, other files untouched (mtimes), V2 sequence 2, only changed blobs fetched.
5. Script prepares a tampered root inside `<DEMO_ROOT>/tamper` using the CLI to publish V1's content as a separate vault there, then, with its own guarded writes limited to that subtree, flips one bit of one blob and writes a new authentic `manifest.enc` (sequence above 2, built with the bundled crypto and the test-only unwrap so its `rootCID` names the tampered tree); prints the `/ipfs/<root>` value. Operator pastes it into the pull-name setting and runs Pull. Script verifies the refusal (authentication failure, the failed count), V2 unchanged, no temporary files, sequence unchanged, and that the tampered subtree is the only place the script wrote outside the CLI's publishes. Operator clears the pull-name setting.
6. Script (no operator): with the CLI on a copy of V2, pull an older root (`--root-cid` of the first publish) is refused by the sequence rule; with `--allow-rollback` it restores the first version into a third directory.
7. Script confirms with `files/ls /obsidian-vault-sync` and `key/list` that only the demo root and the owned key changed.
Evidence screenshots (unlock dialog, wrong passphrase message, conflict notice, tamper refusal notice) are passed with `--evidence`. The script never writes hostile objects outside `<DEMO_ROOT>/tamper` and never mutates the node during pulls.
`--verify-only` replays steps 1 to 7 with the CLI (vault created with `ipfs-sync init --passphrase-file`, later steps unlocking from that file), including the wrong-passphrase attempt, so the assertions can be exercised without Obsidian; its result cannot satisfy precondition B.

### 14a. History pruning
The mvp-06 publisher warns at 1,500 history files and refuses at 1,999 (the listing cap), so `ipfs-sync prune-history --keep N` is required work here (task 2.7, `history-pruning` spec). It changes only the working MFS tree; old roots stay pinned.

### 15. Cadence scope
In the increment (before `ready`): tasks 1.x to 6.x below, including the final security review (its file is saved before `ready`, because saving it later would change the frozen repository) and the scripts and tools. Post-finish, outside the increment, each done in KBD after `finish`: the operator-run feature operation, the phone timing or acceptance, the guard removal, the local release record, and every outward step. Scripts write results only outside the repository. The countdown for operator steps starts when the operator says ready.

## Risks / Trade-offs

- [Guard removal makes any remaining bug reach real notes] -> the checker ties review, run and timing to the same code hash; residual risk stays with the reviewer's completeness.
- [Post-removal code is not exercised by the operator run] -> the removal is a replacement of two policy modules by permissive stubs with recorded hashes; post-removal unit tests and the simulation run; the reviewer approves the exact content.
- [Refusing `.obsidian/*` removes configuration sync] -> deliberate; product question stays open.
- [Rewrap makes other devices refuse until they accept] -> friction by design (the refusal is the substitution defence); the accept action authenticates via the manifest.
- [Slow unlock on phones (64 MiB, 3 iterations)] -> unmeasured; timing command and precondition C.
- [Passphrase file for the operator run] -> throwaway vault only; file mode 0600 outside the repo; deleted by the script at the end.
- [Script-prepared tampered root writes hostile-looking objects on the shared node] -> confined to the per-run `tamper` subtree under the demo root; they are encrypted bytes with a flipped bit, useless to anyone; pinned forever like everything else.
- [The freeze fingerprints the repo] -> nothing the scripts write goes into it; post-finish tasks are separate.
- [Whole-file reads in the plugin for local hashing] -> the read cap applies as before.

## Migration Plan

Users of the v0.2.0 fixture-only build lose plaintext pull; there is no plaintext data of value to migrate (fixtures). State files of earlier formats are ignored. Encrypted vaults created by the mvp-06 build are readable by this change. Rollback: `git revert` restores mvp-06 behaviour (encrypted pull refused); nothing on the node changes.

## Open Questions

Security first:
1. **Accept-changed-slots proof path vs mvp-06's rule.** mvp-06 says any difference between the node's `keyslots.json` and the local copy is a refusal and the local copy is authoritative. This change adds an explicit action that proves legitimacy by authenticating the manifest under the newly unlocked key, then replaces the copy. Does that need an mvp-06 clarification? Recommendation: add one sentence to mvp-06's `key-slots` requirement ("except through the explicit accept action defined by encrypted pull").
2. **Trust on first pull.** A new directory records whatever authentic state the node serves. Is that acceptable for Release 2, or should the operator supply the expected `vaultId` or sequence out of band for the first pull? Recommendation: accept and document; add an optional `--expect-vault-id` later.
3. **`--allow-rollback` semantics** (decision 3): strict default, explicit flag or dialog, record never lowered. Confirm.
4. **Reviewed-tree hash covers `src/` and `cli/` only** (not `tools/`, not `package.json`, not the built bundles). The build and dependency set could change after review. Should the hash include `package.json`, the lockfile and the built plugin bundle? Recommendation: include them.
5. **Guard removal also lifts the pull destination guard.** Pulling into a non-empty real vault is then allowed, with conflict copies preserving local edits. Confirm that both guards go together.
6. **Plugin-side residuals** stay from mvp-06/05: other code in the same context can use the key object; the passphrase dialog holds a string; the adapter cannot see symlinks; range reads load whole files. None is fixed here.
7. **Cost presets** (Standard 64 MiB / 3, High 128 MiB / 4) and the absence of a middle preset are choices; a phone may fail at High.
8. **Rewrap concurrency**: two devices rewrapping at once are serialised only by the up-to-date rule and the journal; a lost update of `keyslots.json` is possible if both pass the read-back. Recommendation: accept; the second rewrap fails its read-back.
9. **Operator-run tamper root writes to the shared node** (inside the demo `tamper` subtree), unlike mvp-06's local-only hostile fixtures, because the plugin can only fetch from the node. Confirm this is acceptable.

Other:
9a. **User-chosen passphrases** remain deferred (mvp-06 Handoff); rewrap generates the new passphrase.
10. **Whether to allow a whitelist of non-plugin `.obsidian/*.json` files** to sync later.
11. **Marker fixture generator** keeps writing `fixture`; after the guard is removed the marker means nothing. Keep or drop it later.
12. **Restore UI** needs a listing of history entries: it reads `manifests/`, which reveals only CIDs; the sequence of each entry is known only after decryption. Listing all sequences requires fetching each history manifest; a cap on entries listed is proposed (last 20).
13. **Delta-review changes to mvp-06** may alter formats referenced here; this design will be re-checked against that review.
