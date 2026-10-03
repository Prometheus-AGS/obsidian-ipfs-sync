# Revision notes, 07b (mvp-07b-keys-history-guard-release-2), revision 3, 2026-09-30

## Re-read 2026-10-03

Inputs: `reread-A.md` (tasks 1.1 to 3.2), `reread-B.md` (4.1 to 7.6), `review-final*.md` of 07a, and the operator decisions of 2026-10-03. Nothing was run; the evidence is the re-read's file:line references. Details sit under the "Re-read 2026-10-03" bullets of each `tasks.md` section.

Operator decisions (encoded exactly): (1) two increments, iteration 8 = 1.x to 5.1 uncommitted until `finish`, iteration 9 = 6.x and 7.x with commits and own freeze, both on the 1.2.0 engine path, ready inputs recorded; (2) git-history evidence with the typed acknowledgement, `~/.ssh/id_ed25519` not enrolled, dedicated key later; (3) injected terminal streams, one skippable `expect(1)` smoke test, one no-pty exit-2 test, no pty dependency; (4) item C stays build-bound via a BRAT pre-release, thresholds 3 s and 100 ms gap.

What changed (task id -> one line):
- header -> cadence block, ready-input requirements, shared-file chains extended (`root-files.ts`, `vault-keys.ts`, `publish-refusals.ts`, `history-check.ts`, `webview-import-probe.mjs`, 07a tools).
- 1.1 -> two input modes for `assertGenerated`; `costPolicy` for the current slot; unknown-slot scan covers all slots.
- 1.2 -> names the 07a verdict functions; copy-less `unlockForPull`; `confirmCost`; floor error surfaced.
- 1.3 -> lost-race withdrawal; A-01 re-read; `state.rootCid` update; reuse the verifier; shared up-to-date plus floor helper; `maintenance` in `RootFileNames` and `abandonVault`; refusal placement; owned-key check; kill-matrix harness.
- 1.4 -> token-check lock standard; shared helper; `init-command.ts` helpers; lazy device store; path-limit text; write helpers; cost warning.
- 1.5 -> accept hint satisfied by 07a (verify only), only the `--root-cid` suffix is new; journal field; `--manifest` caveat.
- 1.6 -> second "not available" text in `publish-refusals.ts`; reuse the history order helpers; 2,000-entry overflow; fork-after-prune test; display escaping; `rootCid`.
- 1.7 -> supersedes the emptied-with-state publish; the exclusion split runs over `removedPaths`; denominator; placement; port; `.smart-env` integration test; `CON.md` wording.
- 1.8 -> acceptance names an interval (default timer is off); real driver already excluded; plugin prune gap; arithmetic.
- 2.1 -> file list fix; settle contract; escaping; cost source.
- 2.2 -> measure command on the public key-slot path (no crypto export); heartbeat gap; shared locks; port; cost wiring; Requires 2.4.
- 2.3 -> streaming transport must fit the import probe; missing pieces named; mobile residual closes in 7.2.
- NEW 2.4 -> plugin cost-confirm dialog (recommended; fallback: CLI-only above default).
- NEW 2.5 -> conditional plugin prune action.
- 3.1a -> split `pull-fixtures.ts` first; `three-way.test.ts`, `publish-repair.test.ts`; floor output satisfied by 07a.
- 3.1b -> CLI and plugin v1 coupling files and symbols; probe entry simplification.
- 3.1c -> refusals mostly satisfied by 07a (verify only); only the pull-side plaintext message is new; `pull-errors.ts` keeps its guards.
- 3.2 -> grep scope; call order in `encrypted-pull.ts`; imports to list.
- 4.1 -> descriptor covers strings, steps and no-bump mode; tag one field; regression on same tree.
- 4.2 -> sentinel check satisfied by 07a (verify only).
- 4.3a -> glob narrowed (lead default); imported tools added by exact path.
- 4.3c -> rewritten: injected streams, one `expect(1)` smoke test, no-pty test; signing decision.
- 4.4a -> 07a result location corrected (tmpdir, not per-user).
- 4.4b -> bound 3 s and 100 ms gap (replaces 600 s).
- 4.5 -> injected-stream tests; BRAT route.
- 4.6 -> bases on 07a; parameterise `DEMO_PARENT`, `DEFAULT_OUT`, `LOCK_FILE`; hash check new; Requires 4.9.
- 4.7b -> reuse 07a phases; hostile writes on the stub (lead default).
- 4.8 -> no-bump, no-build record mode.
- 4.9 -> printed restore text fix added; TTL testing remains.
- NEW 4.10 -> kill matrices for restore and fork resolution.
- 5.1 -> BRAT route and mobile facts; supersession; Android not claimed.
- 6.1 to 6.5 -> tag field; probe worktree warning; commits before `ready`; run list; record form.
- 7.1 -> reuse 07a pointer/restore; cleanup debt. 7.2 -> BRAT, probe-style numbers, thresholds, multi-MiB phone pull. 7.3 -> acknowledgement wording. 7.4 -> phone pre-release listed.
- NEW 7.7 -> BRAT phone pre-release (own approval).
- Specs -> `guard-evidence` (glob, thresholds), `key-management` (restore caveat, three scenarios), `mass-removal-guard` (`CON.md`), `plugin-key-management-ui` (gap, cost-confirm), `release-2` (Android, cadence). Design -> 2, 4, 7, 9, 10, 11, 12, 13 and a status block under Open Questions.

Open for the operator (lead defaults in brackets):
1. Whether 7.1 to 7.5 sit inside iteration 9's checkpoints, given the 2026-09-30 gotcha that operator-run tasks stay outside a freeze.
2. 1.8: coalescing, a plugin prune action (task 2.5), or the explicit CLI-only statement.
3. Cost-confirm dialog (2.4, recommended) or the CLI-only fallback; the High preset is unmeasured on a phone.
4. Fixture-only fallback release; the bidi-override decision (7.6).
5. `tests/**` and `tools/webview-import-probe.mjs` in T's scope.
6. Hostile writes on the stub (4.7b) [yes], with the required assertion ids reconciled.
7. Android not a gate [yes]; tag `v0.3.0` [yes]; glob narrowed [yes]; deleting `0.2.1-probe.1` as an approved cleanup [yes]; form (b) signing kept built [yes]; 4.10 as a task or a 7.1 "not run" note [task].

Not changed, tracked as residuals: `stripControlCharacters` omits U+2028/9 (`cli/io.ts:48`); release `firstFilePrefix` prefix-hash cost; six publish-side scenarios without integration tests (`tests/integration/scenario-map.test.ts:122`); A-04 (7.5); B1-04(b); `SessionKeys.adopt(vault)` (optional in 2.2). Not checked in the re-read: `key-slot-format.ts` internals, per-command flag gating for `keys` in `cli/run.ts`.

Inputs as in the 07a notes. The same traceability table follows; "Where" says which change holds the resolution.

## Decisions made beyond those given (reasons)
1. No Variant B. With a real-diff branch, a failing checker ends the procedure; a fixture-only fallback would need its own reviewed tree and operator run. Open question 3.
2. The operator's "review evidence committed before the removal commit" cannot hold when the reviewer must read the removal. The record is committed on the branch after the review, in its own commit, and never changed; or it is SSH-signed by the operator. The checker prints which form it found.
3. The SSH signature scheme is this design's own (`ssh-keygen -Y`, allowed-signers outside the repo). The repository has no verifier for the adversarial-review waiver; only the phrase "SSH-signed waiver" exists in the skill text.
4. Hash scope additions to the operator's list: `pnpm-workspace.yaml`, `tools/hook-isolation.mjs`, `tools/record-phone-timing.mjs`, `tools/release-mvp-07.mjs`, `tools/release/**`, helper directories `tools/feature-op-mvp-07*/` (the glob `*.mjs` alone would let code hide in a directory). Git mode is part of each line. `tests/` is not hashed; the named checklist test files are.
5. The version bump to 0.3.0 is committed before the review (task 6.1) because `manifest.json` and `package.json` are in the hash; the release tool only asserts it.
6. Phone timing is bound to the plugin `main.js` hash, so any later source change needs a new measurement or acceptance. Acceptance is an interactive-terminal record, not a decision-log line.
7. Item E machine-checks W-14/W-15/W-16 by running named test files (hashes recorded in the review record) and by matching required sentences in README and DESIGN; it also runs `pnpm audit` against one accepted advisory and fails offline.
8. Freshness bound for the operator run: 14 days. Result directory: per-user state dir `feature-ops/`, 0700/0600, owner checked.
9. Prune: legacy names are oldest and unordered; keep set is filled from prefixed entries first.
10. Mass-removal rule stays "all, or more than half of at least two"; the timer never prompts.
11. Restore across a rewrap follows the operator's accept route (three steps); a shorter route exists and is listed as open question 10.
12. Docs are split: docs on `main` before the branch; a docs commit on the branch after removal (outside the hash).

## Rejected or narrowed findings
- P-04's "SSH-signed or committed before the removal commit": adapted (decision 2).
- P-15's "any file in src/crypto/testing must carry a sentinel": implemented as an added check in `hook-isolation.mjs` (task 4.2), which is itself under the hash and reviewed.
- F-14's "per-assertion transcript hash": implemented as one transcript hash for the run.

## Not verified
`ssh-keygen -Y` availability, cadence freeze behaviour on a non-checked-out branch, `requestUrl` Range, phone timing.

## ZeeSpec pass (inline, not the interactive 60-question session)
What: evidence records, journals, hash scope defined. Where: per-user directory, branch vs main, node only via the demo root. Who: owners assigned, operator-only steps marked. When: branch cut after all code tasks, version bump before review, review before run or either order with hash binding, defect loop. Why: each decision carries its finding. How: checker items, release steps, operator-run phases. Implicit gaps are open questions 1 to 11 in design.md. No `.zeespec/` manifest was produced.

## Traceability
| Finding | Resolution | Where |
|---|---|---|
| F-01 (Variant A unreachable; policy in ~14 files) | Resolved by model change: policy centralised first, removal prepared as a real diff on a branch, release gated by the checker | 07b design 8, 9; spec `guard-removal`; 07b tasks 3.2, 6.2 |
| F-02 (post-removal content not stored; symlink check dropped) | Resolved: the post-removal code is the branch tree itself; symlink/state-folder check in its own module | 07b spec `guard-removal`; tasks 3.2, 6.2 |
| F-03 (restore vs state model) | Resolved: `highestSequence` separate; restore leaves the baseline at the node's manifest | 07a design 2, 8; spec `rollback-detection`; tasks 1.1, 4.6 |
| F-04 (history ordering) | Resolved: 16-digit sequence prefix, legacy oldest | 07a design 13; spec `history-naming`; task 1.4; 07b task 1.6 |
| F-05 (partial pull advances baseline) | Resolved: `complete` flag, baseline merge, publish refuses | 07a design 7; spec `encrypted-pull`; tasks 4.5, 2.1 |
| F-06 (wrong state file; latch) | Resolved: `root-state.ts`, format 3 decision; latch consult removed in 07b | 07a design 2; task 1.1; 07b design 7, task 3.1 |
| F-07 (2.5 re-implemented existing rule) | Resolved as deltas: ahead/new-device/fork messages, `--repair` ahead narrowed | 07a design 10; spec `second-device-publish`; task 2.1, 4.1 |
| F-08 (multi-publisher holes; device id storage) | Resolved: `devicesSeen`, per-installation id in the device store; residual first overlap stated | 07a design 3, 10; tasks 1.2, 2.2 |
| F-09 (journal reuse) | Resolved: separate maintenance journal, shared republish primitive, cross-tests | 07b design 4; spec `key-management`; task 1.3 |
| F-10 (hook-isolation lint) | Resolved: rewrap inside `key-slots.ts`; lint file changes are a reviewed task | 07b design 1; tasks 1.1, 4.2 |
| F-11 (`.obsidian` pull failures; D:50 wrong) | Resolved: default exclusions include the config folder; `policy-skipped` does not fail; claim corrected | 07a design 12; tasks 1.3, 4.5 |
| F-12 (plugin cannot stream) | Resolved: ranged fetch, budget; memory claim limited to CLI | 07a design 14; spec `encrypted-pull`; task 4.4 |
| F-13 (checker fields vs spec) | Resolved: items D and E, checklist fields in the record | 07b spec `guard-evidence`; tasks 4.3, 4.4 |
| F-14 (forgeable evidence) | Resolved as far as possible: wider hash, bundle hashes, signed or git-bound record; stated as attestations | 07b design 9; spec `guard-evidence` |
| F-15 (old slot kept?) | Resolved: new file holds only the new slot | 07b design 2; spec `key-management`; task 1.1 |
| F-16 (restore across rewrap; downgrade) | Resolved: accept with one root and downgrade warning | 07b design 3; task 1.5 |
| F-17 (ownership, ordering) | Resolved: explicit assignments, dialogs before wiring, 2.8 dialog included | 07a tasks header, 5.2 before 5.3; 07b tasks header, 2.1 before 2.2 |
| F-18 (tasks too large) | Resolved: split path policy, blob fetch, plan, orchestration, fork, key tasks | 07a tasks 3.x, 4.x; 07b tasks 1.x, 4.x |
| F-19 (marker dead end) | Resolved: rule stated for 07a; removed with the guard in 07b | 07a design 16; spec `second-device-publish` |
| F-20 (no defect loop) | Resolved: stated loop | 07b design 9; spec `guard-evidence` |
| F-21 (mvp-06 feature op; release constants) | Resolved: based on `feature-op-mvp-06*`; separate refactor task with regression check | 07b tasks 4.1, 4.6 |
| F-22 (pull takes no file lock) | Resolved: pull takes `publish.lock` in CLI and plugin | 07a design 6; spec `encrypted-pull`; tasks 4.6, 5.1, 5.3 |
| F-23 (second-device onboarding) | Resolved: docs and first-pull dialog hint | 07a design 15; spec `second-device-publish`; tasks 5.2, 6.2 |
| F-24 (v1 files) | Resolved: explicit list | 07b design 7; spec `plaintext-removal`; task 3.1 |
| F-25 (cap message already partly done) | Resolved: only the parenthesis is dropped, in 07b | 07b task 1.6 |
| P-01 (partial pull then publish) | Resolved: as F-05; `.obsidian` excluded by default; two outcome classes | 07a design 7, 12; tasks 1.3, 2.1, 4.5 |
| P-02 (concurrent publish, fork wedge) | Resolved in part: name re-check, `--resolve-fork`, drift guard, loud statement; not prevented | 07a design 9, 10; tasks 2.2, 4.7 |
| P-03 (reviewed code is not shipped code) | Resolved: real diff, wider hash, bundle hashes, release asserts bytes | 07b design 8, 9; 12 |
| P-04 (forgeable preconditions) | Resolved as far as possible: git-bound or signed record, per-user directory, installed-file hashes, TTY step, build-hash-bound timing | 07b spec `guard-evidence` |
| P-05 (restore vs state invariant) | Resolved: as F-03 | 07a design 8 |
| P-06 (baseline resets) | Resolved: floor by `vaultId` in the device store; limits stated | 07a design 3; task 1.2 |
| P-07 (first-pull trust) | Resolved: confirmation, `--expect-*`, gateway statement | 07a design 5; spec `rollback-detection`; task 5.1 |
| P-08 (rollback scope) | Resolved: explicit targets only; plugin Restore action only | 07a design 4, 5 |
| P-09 (accept freshness/atomicity) | Resolved: one root, exact bytes, hash updates, sequence rule | 07b design 3; task 1.5 |
| P-10 (rewrap details) | Resolved: replace, cost rule, same-passphrase statement, test unlock | 07b design 2; task 1.4 |
| P-11 (path hardening) | Resolved: fold key, reserved names, collisions, realpath; own task; own review record | 07a design 11; spec `path-hardening`; tasks 3.1, 3.2, 6.4 |
| P-12 (resource claims) | Resolved: ranged fetch, budget, ceiling, sweep; free-space check only where exposed (not in the plugin) | 07a design 14; tasks 4.3, 4.4, 5.3 |
| P-13 (equality on ciphertext hash) | Resolved: plaintext manifest identity | 07a design 2; task 1.1 |
| P-14 (planted manifest.json; slots without manifest) | Resolved: refusals specified (07a for the pull, 07b for the rest) | 07a spec `encrypted-pull`; 07b spec `plaintext-removal` |
| P-15 (release and dist check) | Resolved: rebuild inside the checker, dist check in the checker, sentinel rule, extended cannot list | 07b design 9, 12; spec `release-2` |
| P-16 (control characters) | Resolved: escaped output | 07a spec `path-hardening`, `encrypted-pull` |
| P-17 (temp plaintext) | Resolved: sweep at pull start, CLI start, plugin load; listed as a limit | 07a design 14; task 5.3, 6.2 |
| P-18 (plugin rename not atomic) | Resolved by statement (conflict copies first) | 07a design 14; task 6.2 |
| P-19 (key adoption) | Resolved: onboarding text | 07a design 15 |
| P-20 (clipboard, node text) | Resolved: fixed or escaped strings; no non-clearing copy | 07a spec `plugin-pull-ui`; 07b spec `plugin-key-management-ui` |
| P-21 (mtime shortcut) | Resolved by statement | 07a design 14; task 6.2 |
| W-14 (silent corruption) | 07b: documented and checked by sentence | 07b spec `mass-removal-guard`, `guard-evidence` item E |
| W-15 (mass removal) | 07b: guard, limits stated | 07b task 1.7 |
| W-16 (readRange) | 07a: single read, file-changed error | 07a task 2.4 |
| N3-09 (prune-history) | 07b: implemented, test file in checklist | 07b task 1.6 |
| C5-02 (token check) | 07a: async hook | 07a task 2.3 |
| R5-11 (lint allowlist) | 07b | 07b task 4.2 |
| R5-12 (noble pin) | Already done (`versions.toml` pin, verified) | none |
| R5-13 (release-note line) | 07b | 07b spec `release-2`, task 4.8 |
| `pnpm audit` | Both gates; checker item E | 07a task 6.3; 07b tasks 6.4, 4.4 |
| N2-13 (dist check in release tooling) | 07b | 07b tasks 4.3, 4.8 |
| Handoff 4 (multi-publisher guard) | 07a | 07a tasks 2.2 |
| Handoff 5 (multi-MB body in plugin) | 07b operator-run assertion | 07b spec `release-2`; task 4.7 |


---

# Correction 2 (2026-09-30)

Inputs: `confirm-review.md` (security-reviewer, Q-01..Q-24; there is no Q-18 in the file) and `confirm-critique.md` (artifact-critic, C-01..C-14), stored unchanged in both change directories, and the operator decisions listed in the dispatch that asked for this correction. One batched correction; no further review cycle follows it. Code claims in the artifacts were checked by opening the files on 2026-09-30 (the list of files is in 07a `design.md` "Verified facts" and 07b `design.md` "Verified facts"). Three facts were checked by running a command: `openspec validate` (before and after), `ssh-keygen -Y` usage text and man page on this machine, and a one-file `vitest run --reporter=json` (which wrote a `.vitest/` directory into the repository; it was removed again). The kubo `name/resolve` arguments were read from docs.ipfs.tech/reference/kubo/rpc. The "Task id map" below says how the Revision 3 task ids above map to the current ones; the traceability table of Revision 3 above keeps the old ids and is not rewritten.

Verdicts being answered: 07a and 07b were PROCEED-WITH-FIXES (security-reviewer) and READY-WITH-FIXES (artifact-critic). This correction is the batched fix cycle; it has not itself been reviewed.

## Task counts and id map

07a: 24 tasks became 32. 07b: 29 tasks became 36 (32 inside the increment, 4 post-finish).

| Revision 3 id | Now | Why |
|---|---|---|
| 07a 1.1 to 1.4 | 1.1 to 1.4 | widened (strict v3, all writers, floor maximum, policy.mjs regex) |
| 07a (new) | 1.5 | `abandon` prints the floor (C-05) |
| 07a 2.1 | 2.1 | no `last-pull-incomplete` refusal; `--repair` ahead rule with the floor |
| 07a 2.2 | 2.2 and 2.6 | re-check, classification and journal start root stay in 2.2; the drift guard moves to 2.6 so each task is one unit |
| 07a 2.3, 2.4 | 2.3, 2.4 | 2.3 now wires the hook at three places and is the only plugin-runner wiring |
| 07a (new) | 2.5 | carry-forward in the publisher (Q-01) |
| 07a 3.1 | 3.1a and 3.1b | fold table and generator; policy module (C-02, C-05) |
| 07a 3.2 | 3.2 | unchanged |
| 07a (new) | 4.0 | relocate `TEMP_DIR`, `discardTemp`, target resolution (C-10) |
| 07a 4.1 to 4.5 | 4.1 to 4.5 | widened where the findings say |
| 07a 4.6 | 4.6a, 4.6b, 4.6c | split (C-06) |
| 07a 4.7 | 4.7 | ancestor rule |
| 07a (new) | 5.0 | settings plumbing: `/ipfs/<cid>` pull name, pull-ceiling setting (C-05) |
| 07a 5.1 to 5.3, 6.1 to 6.4 | same | Requires fixed (C-01) |
| 07b 1.1 to 1.7, 2.1, 2.2 | same | Requires chain added (C-11) |
| 07b 3.1 | 3.1a, 3.1b, 3.1c | adaptations, wiring removal, deletion with refusals (C-14, C-10) |
| 07b 3.2 | 3.2 | constants file, call site, generator (C-13) |
| 07b 4.1, 4.2 | same | |
| 07b 4.3 | 4.3a, 4.3b, 4.3c | tree hash; clean-export build; item A and trust anchor |
| 07b 4.4 | 4.4a, 4.4b, 4.4c | items B, C, D and E |
| 07b 4.5, 4.6 | same | |
| 07b 4.7 | 4.7a, 4.7b | plugin-visible steps; hostile and script-only steps |
| 07b 4.8, 5.1, 6.1 to 6.5, 7.1 to 7.4 | same | |

## Decisions made beyond those given (reasons)

1. **Which skips are carried forward.** The operator decision named "policy-skipped, unfetched, integrity-failed". This correction carries `unfetched`, `integrity-failed` and policy skips of class `platform` (Windows forms, reserved names, 8.3 shapes, collisions), and does not carry `expected` skips (configuration folder or exclusion list) or `unsafe` skips of class `shape` (traversal, protected folder names, plugin paths, control characters). Reason: carrying every skip would keep an older build's `.obsidian/*` entries and any forged traversal entry in every manifest for ever, contradicting the default-exclusion change, and would make pull exit 1 on them permanently with no device able to clear them. One set in `encrypted-pull-plan.ts` switches this. Open question 11 in 07a.
2. **Publish no longer refuses on `complete: false`.** With the carry-forward the hazard that the refusal guarded (publishing a path that is in the baseline but missing locally as a removal) cannot occur, and the refusal was the lockout of Q-02. `complete` stays as a displayed flag and the exit code. Rewrap and prune no longer require it either (they read no vault file). Open question 12 in 07a.
3. **`unmaterialized` is a separate sorted list in the state**, with the node's entry in `manifest.files`; on the next pull such a path is planned with no base (missing file: fetch; equal: restored; different: conflict copy). A stale older copy of an unfetched file costs one extra conflict copy.
4. **The publisher's exclusion matcher is not made fold-aware.** The fold-aware comparison lives in `path-policy.ts` and a pull-only matcher. Reason: making `createExclusionMatcher` case-insensitive would change what the scan and `idle-check.ts` exclude on case-sensitive file systems (a user excluding `Private/` would also lose `private/`). Answers the question Q-01 asked about task 3.1.
5. **`previousIdentity`** (the identity of the manifest this device built on) is added to the state and cleared by a pull; it is what makes the Q-03 ancestor rule checkable.
6. **Publish journal format 2** with `startRoot`; a pull sets aside a journal whose sequence is not above the pulled one. Reason: without the set-aside, the Q-04 refusal would leave the device with a journal that publish refuses to resume and pull refuses to ignore.
7. **Name re-check rules.** A key created by this run is not resolved; `failed` is a refusal; on the first publish of a vault a timeout counts as not found (residual stated); `dht-timeout` proposal 10 s; the error-text table is recorded from the operator's node because the strings were not verified.
8. **`adopt` raises the directory's `highest*` but not the floor.** The invariant `highestSequence >= sequence` must hold, and the floor is raised only by a completed publish or a pull.
9. **Plugin Range probe.** The smallest blob's header request goes first and alone and decides whether the gateway ignores Range for the whole pull. Margin 64 bytes. `PLUGIN_MIN_EXPONENT` 20 (exponent 16 means 16,384 requests per GiB). Proposals, not measurements.
10. **8.3 rule.** The regex is `^([^.~/]{1,6})~[0-9]+(\.[^./]{0,3})?$` plus a check that the prefix is a prefix of a protected folder name, so `OBSIDI~1`, `OBS~1`, `GIT~1`, `IPFS-S~1` are refused and `abc~1.md` is accepted. The reviewer's remark that honest `abc~1.md` would be refused described the broad form.
11. **Fold key.** Full case folding from a generated checked-in table (Unicode `CaseFolding.txt` C and F, `Default_Ignorable_Code_Point`) plus the supplement (U+0131 to `i`, U+0307 after `i` removed), generated by `tools/gen-path-fold-table.mjs` at a pinned Unicode version. I chose the table over `lower(upper(NFKC))` because JavaScript's case mapping depends on the host's Unicode version and Obsidian's runtime may differ from Node's. The Unicode version is not chosen here.
12. **Plugin data: `settings-store.ts` stays the single writer** and applies a per-vault maximum to the `deviceStore` section on every save. It was already the only caller of `saveData`; the change is the merge rule and a test.
13. **The hook for the token check** is awaited at three places (before resume, before junk removal under `--repair`, before `key.ensure()`), each a fresh check; 07a previously said "once" in one place and "start and again" in another.
14. **Restore leaves `complete` and `unmaterialized` alone** and reports failures with exit 1.
15. **`--repair` ahead** is refused when a floor exists for the vault or the state decodes, and offered only for a state file that does not decode with no floor.
16. **Git-history form of item A.** Per-tree file name `review-final-<T8>.md`; "exactly one commit" dropped as decided; replaced by the last-commit rule plus a printed commit count and a typed acknowledgement at `record`. This is weaker than the first draft and the docs and notes say so.
17. **Enrolment lives in the checker** (`--enrol-signer`), not in a separate tool, to keep the set of hashed tools small; it requires a terminal and a retyped fingerprint and nonce.
18. **The checker builds in a clean export** and its default run writes nothing in the repository; `--build` copies only `dist/plugin/` and `dist/cli/` and writes `dist/.guard-build.json`. This resolves C-09's conflict without moving release output (`dist/release/` is never touched by the checker). The operator-run script, the recorder and the release tool read that file and stop early when it is stale (Q-22).
19. **Phone build hash typed as 16 hex characters**, checked by the recorder against the local build, which records the full hash.
20. **Acceptance records** carry T, B's `main.js` hash and a 14-day bound (C-12).
21. **Prune.** The newest 20 prefixed entries must agree prefix-to-sequence (one rule in design, spec and task); the newest entry's sequence must equal the node manifest's; duplicate prefixes are counted and shown, not refused (a fork produces them legitimately).
22. **Mass-removal guard.** Exclusion-driven removals count in neither numerator nor denominator; carried entries count as kept.
23. **Checker item E runs tests in the clean export** with `--outputFile` (the vitest default writes `.vitest/json/output.json` into the working directory, observed) and holds paths and minimum counts as constants.
24. **Terminal tests use `script(1)`** in two platform forms through one helper; whether it can be driven from the test runner is not verified and the task stops and asks before adding a pty dependency.
25. **`tools/feature-op-mvp-06/policy.mjs`** gets the history-name rule update inside 07a task 1.4, with the mvp-06 `--dry-run` as its check.
26. **New command `keys discard`** for a stale maintenance journal (named in the operator decision as "keys discard/accept-slots").

## Deferred or rejected, with reasons

- **Q-22, first clause (a terminal and a nonce do not stop a program that drives a pseudo-terminal): accepted as a stated limit, not fixed.** No local control can tell a person from a pty driver. The docs say so (07b task 5.1, `guard-evidence` item C).
- **Q-14, "the signing key must not be agent-readable": stated, not enforced.** The checker cannot test who can read a key file. It is the largest remaining gap in the evidence scheme: an agent that can read the operator's unlocked key can sign. Needs an operator decision on where the key lives (see operator questions).
- **Q-16: the coverage list is checked for completeness, not for truth.** The checker can require that every file is listed as read or unread; it cannot tell that the reviewer read it. Stated in the design and the release notes count unread files.
- **Q-21, last clause (docs are outside T, so a post-review README can overclaim): partly addressed.** The required sentences are matched at record time and the documentation hashes are written to `evidence.json`; the claims in the docs are still not bound to T.
- **Q-05: two CLI processes on different vaults can lose one another's floor update to the shared file.** Stated as a residual in 07a design 3; the loss only removes protection for a directory whose own state has been deleted.
- **Q-12: no command lowers a ratcheted sequence.** The documented recovery is deleting the floor file and the affected state files and pulling again as a first pull. By design, because a command that lowers a record is the rollback it guards against.
- **Q-02: no separate per-path exclusion or `--publish-despite-unfetched`.** Not needed once the carry-forward removes the refusal.
- **C-09, W-16 (07a 2.4): justified, not split.** Reason in the 07a proposal; the task has no Requires and can be moved without touching another task. If the operator prefers it out of 07a, it is a one-line move.
- **C-03: the kubo not-found and timeout strings are not in the artifacts.** They were not verified; the task records them from the operator's node and unrecognised text is treated as failure.
- **C-14, how the plugin build reaches a phone:** documented as the operator's own route (copy into the phone vault's plugin folder); the tool cannot do it because `.obsidian/plugins/` is deliberately not synced.
- **Previously deferred items are unchanged:** node-side device marker (P-02), whitelisting non-plugin `.obsidian/*.json` (F-11), a fixture-only fallback release (07b open question 3).

## Traceability, confirm-review.md

| Finding | Resolution | Where |
|---|---|---|
| Q-01 HIGH (policy-skipped entries dropped by the next publish) | Carry-forward of entries the device could not materialize; matcher question answered | 07a design 2, 7, 10.7, 11; specs `encrypted-pull` (Outcomes), `second-device-publish` (Paths this device could not restore), `path-hardening`; tasks 1.1, 2.5, 3.1b, 4.5, 6.1 |
| Q-02 (permanent `complete:false` lockout) | Removed by the same change: no publish refusal on `complete` | 07a design 7, 10.2; spec `second-device-publish` (Gateway that ignores Range); tasks 2.1, 2.5 |
| Q-03 (fork ancestor not authenticated as parent) | `previousIdentity`; exactly one authenticating entry at the prefix | 07a design 2, 9; spec `rollback-detection`; tasks 1.1, 4.7 |
| Q-04 (name re-check vs journal root) | `startRoot` in publish journal format 2; compare on resume; pull sets a lost journal aside | 07a design 10.3, 6 step 8; specs `second-device-publish`, `encrypted-pull`; tasks 2.2, 4.6b, 6.1 |
| Q-05 (floor can regress in plugin data) | Read-merge-max; `settings-store.ts` single writer | 07a design 3; spec `rollback-detection`; task 1.2 |
| Q-06 (Restore list shows unauthenticated names) | Confirm shows the authenticated sequence and date; mismatch refuses | 07a design 8; spec `plugin-pull-ui`; tasks 5.2, 5.3 |
| Q-07 (`--repair` ahead) | Refused with a floor or a decodable state; offered only for an undecodable state with no floor | 07a design 10.1; spec `second-device-publish`; task 2.1 |
| Q-08 (v3 decoder strictness) | Strict decoder, no defaulting | 07a design 2; spec `rollback-detection`; task 1.1 |
| Q-09 (8.3 rule undefined) | Regex plus protected-prefix check; four refused and one accepted vector | 07a design 11; spec `path-hardening`; task 3.1b |
| Q-10 (upgrade-day `.obsidian` removals vs guard) | Exclusion-driven removals counted apart | 07b design 6; spec `mass-removal-guard`; task 1.7 |
| Q-11 (plugin fetch and temp nits) | Exponent floor 20; sweep only under the lock; abort replace when the conflict copy cannot be written; `textContent`; no clipboard copy on mobile | 07a design 14, 15; specs `encrypted-pull`, `plugin-pull-ui`; tasks 4.4, 4.5, 5.2, 5.3 |
| Q-12 (ratcheted sequence) | Recovery named: delete the floor file and the state files | 07a design 3; spec `rollback-detection` (limits); task 6.2 |
| Q-13 HIGH (git form dead end) | Per-tree file name; "exactly one commit" dropped; commit count printed and typed | 07b design 9, 12; specs `guard-evidence` (Item A), `release-2`; tasks 4.3c, 4.8, 6.5 |
| Q-14 HIGH (trust anchor chosen by the invoker) | Fixed operator-owned path with owner and mode checks, no env or flag override, enrolment on a terminal, typed acknowledgement for the unsigned pass, namespace and exact invocation pinned, key-not-agent-readable statement, fingerprint in notes | 07b design 9, 12; specs `guard-evidence` (Item A, trust anchor), `release-2`; tasks 4.3c, 4.8, 5.1, 7.3 |
| Q-15 (ignored files bypass T) | Ignored-files check, clean export, scrubbed environment, `ls-tree`, index equals HEAD, blob bytes | 07b design 9; spec `guard-evidence` (Tree hash, Build hashes); tasks 4.3a, 4.3b |
| Q-16 (review-to-tree binding) | `coverage` list keyed to `--print-tree-hash --list`, completeness checked | 07b design 9; spec `guard-evidence` (Item A); tasks 4.3c, 6.5 |
| Q-17 (audit allowlist inside T) | `--prod`; dated accepted findings in the record; evaluated at record time | 07b design 9; spec `guard-evidence` (Item E); tasks 4.4c, 6.4, 6.5 |
| Q-18 | Not present in `confirm-review.md` | none |
| Q-19 (maintenance journal dead ends) | Phase marker; name equal to snapshot root counts as done; `keys discard` and accept clear a stale journal; refusals name them | 07b design 4; spec `key-management`; tasks 1.3, 1.5 |
| Q-20 (prune withholding check) | Newest sequence equals node manifest sequence; newest 20 agree; duplicates counted | 07b design 5; spec `history-pruning`; task 1.6 |
| Q-21 (Item E weaknesses) | Zero skip/todo/only, minimum counts, zero-match guard, versions recorded, `.npmrc` and engine pin in scope, documentation hashes recorded | 07b design 9; spec `guard-evidence` (Item E, Tree hash); tasks 4.3b, 4.4c |
| Q-22 (TTY nonce, phone typing, stale dist) | Limit stated; 16-character prefix checked by the recorder; operator-run script and release tool stop on a stale `dist/.guard-build.json` | 07b design 9, 10, 11; specs `guard-evidence` (Item C), `release-2`; tasks 4.5, 4.6, 4.8, 7.2 |
| Q-23 (rewrap, accept, prune vs publish.lock) | All three take `publish.lock` | 07b design 2 to 5; spec `key-management`, `history-pruning`; tasks 1.4, 1.5, 1.6 |
| Q-24 (checker dead end undocumented) | Run the checker once before the operator run; the route after a failure is written in one place | 07b design 9 (Checker behaviour); spec `guard-evidence` (Checker behaviour); tasks 5.1, 7.1 |

## Traceability, confirm-critique.md

| Finding | Resolution | Where |
|---|---|---|
| C-01 (Requires graph misses the publisher deltas) | 6.1 and 6.3 require 2.1 to 2.6; duplicate hook wiring removed from 5.3 | 07a tasks header order table, 2.3, 5.3, 6.1, 6.3 |
| C-02 (fold key contradicts its vectors; no table source) | Generated checked-in table, supplement, generator, tests, Files | 07a design 11; spec `path-hardening` (Fold key); task 3.1a |
| C-03 (no error classification or timeout design) | Three-way classification, `dht-timeout`, new-key and first-publish rules, `nameResolve` on the port, tests for both | 07a design 10.3; spec `second-device-publish`; task 2.2 |
| C-04 ("not buffered" is false for the plugin) | Transport fact stated; wording "discarded, not decrypted"; probe on the smallest blob; large-file pull not advertised until the operator run | 07a proposal, design 14; spec `encrypted-pull` (Resource bounds); tasks 4.4, 6.2 |
| C-05 (requirements without tasks or Files) | `abandon` floor (1.5); `/ipfs/<cid>` and ceiling setting (5.0); free-space port explicit, plugin claim dropped (4.6b, 5.1); 3.1 Files and order after 2.5; 1.2 Files publish.ts and publish-types.ts | 07a design 3, 14; tasks 1.2, 1.5, 3.1b, 4.6b, 5.0 |
| C-06 (4.6 too large) | Split into 4.6a, 4.6b, 4.6c | 07a tasks 4.6a to 4.6c |
| C-07 (state a pull writes; writers under-counted) | Pull writes `rootCid`, `key`, `mfsRoot` as specified; `adopt` and `finishUnchanged` in 1.1 with the adopt rule | 07a design 2 (Writers), 6 step 8; spec `encrypted-pull`; tasks 1.1, 4.6b |
| C-08 (inconsistencies inside 07a) | `devicesSeen` first-seen order; restore leaves `complete`; ancestor exactly-one rule; skipped paths carried; hook at three places; Restore needs no accept for `--manifest` | 07a design 2, 7, 8, 9, 10.5; 07b design 3; specs `rollback-detection`, `second-device-publish`, `key-management`; tasks 1.1, 2.3, 4.6c, 4.7 |
| C-09 (tool regex; dist/release; W-16) | `policy.mjs` regex in 1.4 with the dry run; the checker never deletes `dist/release/`; W-16 justified | 07a design 13, 14, proposal; 07b design 9, 12; tasks 1.4, 2.4 (07a), 4.3b, 4.8 (07b) |
| C-10 (3.1 deletes code live modules import) | 07a task 4.0 relocates `TEMP_DIR`, `discardTemp`, target resolution; 07b 3.1a adapts before 3.1c deletes; `crypto-manifest-paths.test.ts` added | 07a design 1; 07b design 7; tasks 4.0 (07a), 3.1a to 3.1c (07b) |
| C-11 (parallel edits to shared files) | Requires edges added; per-file order tables; ownership exceptions recorded; `settings-tab` ownership | both `tasks.md` headers; 07b tasks 1.5 to 3.2, 2.2 |
| C-12 (checker takes lists from the record; acceptance never stale) | Required ids, checklist paths with counts and sentences held in the checker; acceptance bound to T and B with a bound; negative tests | 07b design 9; spec `guard-evidence` (Items B, C, E); tasks 4.4a to 4.4c, 4.6 |
| C-13 (guard centralisation gaps) | `fixture-constants.ts` with no imports; generator and fixture test in 3.2 Files; `assertStateFolderSafe` called from `encrypted-pull.ts` step 1 | 07b design 8; spec `guard-removal`; task 3.2 |
| C-14 (Verify lines and design mismatches) | `script(1)` named with its platform limit; prune rule aligned; per-user path pinned by one function and a test; phone route; fast-forward only; large tasks split | 07b design 5, 9, 10, 12; specs `history-pruning`, `guard-evidence`, `release-2`; tasks 3.1a to 3.1c, 4.3a to 4.4c, 4.7a, 4.7b, 7.2, 7.4 |

## Not verified in this correction

- The kubo error text for a never-published name versus a routing timeout; `requestUrl` Range behaviour; `script(1)` driven from the test runner on either platform; `ssh-keygen -Y` on platforms other than this machine's macOS; the Unicode version for the fold table; that the sentences held in the checker will survive the docs task unchanged.
- The interactive 60-question ZeeSpec session was not run for this correction or for the earlier revision (the "inline pass" above is a product-manager read, not the skill's interrogation). No `.zeespec/` manifest exists. The operator can ask for the interrogation before either change is approved for planning.
- `openspec validate` results are reported in the dispatch result, not here.
