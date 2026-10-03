# Task 6.2 notes (documentation-specialist): documentation for the read side

Date: 2026-10-02. Phase: Execute (KBD task 30; receipt open, not closed here). Nothing was committed. Nothing was run
except `grep`, `ls`, `wc`, `sed -n` (read-only line ranges, never an edit; no `sed -i`, no `awk`), `node -e` (two
read-only computations: the sha256 of the sorted exclusion list, and the sorted list itself) and `git diff --stat`. No
test, build, `pnpm` or CLI command ran. Edits were made with the Edit and Write tools only.

## Files changed

| File | What |
|---|---|
| `README.md` | Banner bullet, "What's here" table, MFS layout paragraph, conflict policy, plugin commands and Pull bullets, new "Pull" section (replaces "Pull in this tree"), plugin limitations, CLI usage block and bullets, "What is protected" rollback sentence, `--repair` ahead change, second-device bullet, "Local state", "The fixture marker", "Not verified" (iPhone measurements) |
| `CHANGELOG.md` | New top section "[Unreleased] - encrypted pull and second-device publish" (Added, Changed, Security, Known limitations); the older mvp-06 section got a pointer note and four in-place "as of mvp-06 / superseded" edits |
| `docs/operator/encrypted-vault.md` | Header, before-you-start rows, routine step 5, new "Pull, restore and fork resolution" section (flow, flags, record and floor, first pull, restore, fork, unfinished files, second device, exclusions, plugin differences, other limits, phone facts, stop table), updated rows for new-device, ahead, fork, history, overlapping-publish, name-routing-failed, keep-table, limits |
| `DESIGN.md` | Section 4: status note, history-name bullet, exclusion/`excludesHash` bullet (replaces the stale `scripts/excludes.txt` line), pull steps, config-sync text. Section 8: intro, 8.1, 8.3 rows (MFS layout, history names, default exclusions, local files, state format 3, device-local store, sequence floor, pull limits, marker), 8.4 paragraph and name re-check limit, 8.5 non-goal, 8.6, 8.7 (plugin transport, delta detection, multiple publishers, ratchet recovery, fork without ancestor, mobile, lock-token text, unverified items 2, 4, 12), 8.9, new 8.10 "What one pull does" |

Not edited: `docs/005`, `docs/006`, DESIGN section 7 (recorded mvp-08 prerequisite); DESIGN sections 2, 3, 6 (outside the
assignment; the decision log says the Helia-over-WSS assumption there is wrong for this node and is to be corrected in
6.2, so someone must assign it); `src/`, `cli/`, `tests/`, `tools/`; `.prometheus/` (see "Decisions" below).

## Sources read for behaviour (code and tests as built, not the plan)

`cli/pull-command.ts`, `cli/pull-encrypted-command.ts`, `cli/pull-versions.ts`, `cli/args.ts`, `cli/help-text.ts`,
`cli/device-store-node.ts`, `cli/publish-lock-file.ts`, `cli/init-command.ts` (the `vault created` line),
`src/sync/encrypted-pull.ts`, `encrypted-pull-stage.ts`, `encrypted-pull-plan.ts`, `encrypted-pull-fetch.ts`,
`fork-resolution.ts`, `pull-sequence.ts`, `pull-unlock.ts`, `root-state.ts`, `sequence-floor.ts`, `device-store.ts`,
`history-names.ts`, `exclusions.ts`, `pull-budget.ts`, `path-policy.ts`, `blob-source.ts`, `blob-fetch.ts`, `drift.ts`,
`name-recheck.ts`, `repair.ts`, `publish-sequence.ts`, `publish-refusals.ts`, `lock-token-check.ts`, `pull-guard.ts`,
`src/kubo/ipns.ts`, `src/plugin/pull-runner.ts`, `pull-restore.ts`, `pull-target.ts`, `pull-dialog-copy.ts`,
`pull-sweep.ts`, `encryption-settings*.ts`, `settings-model.ts`, `settings-tab-copy.ts`, `obsidian-fs.ts`, `index.ts`;
`tests/unit/exclusions.test.ts` (hash constants); the decision log (entries to 2026-10-02 "5.1 and 5.3 done");
`children/mobile-feasibility/device-results.md` and `assessment-smart-connections.md`.

## Check 1: `--help` and every command and flag named

`dist/cli/ipfs-sync.mjs` exists but is stale (dated Sep 30; `grep -c "list-versions"` and `grep -c "smart-env"` on it both
returned 0), so I did not run `pull --help` and did not run `pnpm build`. The help text was read from `cli/help-text.ts`.

Command run: every `--flag` token in the four files, each checked with `grep -q -- "$flag" cli/help-text.ts`.
Result: every flag the new text names is in the help text (`--accept-first-pull --accept-large --allow-plaintext-v1
--allow-rollback --expect-min-sequence --expect-vault-id --list-versions --manifest --manifest-file --max-bytes --name
--owned-key --resolve-fork --root-cid --passphrase-file --repair --recover-slots --break-lock --allow-full-reupload
--yes-abandon --mfs-root --key --config --rpc-url --gateway-url --auth`). The loop reported MISS for six tokens, all
pre-existing and none a CLI flag: `--allow-stale-build`, `--cleanup`, `--dry-run`, `--local-stub` (flags of
`tools/feature-op-*.mjs`), `--canonical` (part of the key-hierarchy arrow in DESIGN 8.2) and `--seed` (not from this task;
not investigated). Commands named: `init`, `publish`, `pull`, `abandon`, `status` (all in the help text);
`prune-history` is named only as "does not exist". Plugin command names ("Pull vault", "Restore an older version",
"Resolve fork", "Show status", "Publish vault") match `src/plugin/index.ts` lines 122-128.

## Check 2: constants, each by grep (results are the lines found)

| Named in the docs | Command | Found |
|---|---|---|
| 128 MiB budget | `grep -n 'SEGMENT_MEMORY_BUDGET = ' src/sync/pull-budget.ts` | `11: ... = 128 * MIB` |
| 32 MiB whole body | `grep -n 'WHOLE_BODY_LIMIT = ' src/sync/pull-budget.ts` | `17: ... = 32 * MIB` |
| 512 MiB default ceiling | `grep -n 'PULL_CONFIRM_ABOVE_DEFAULT = ' src/sync/pull-budget.ts` | `20: ... = 512 * MIB` |
| plugin minimum exponent 20 (1 MiB segments) | `grep -n 'PLUGIN_MIN_EXPONENT = ' src/sync/pull-budget.ts` | `23: ... = 20` |
| 6 files in flight | `grep -n 'PULL_MAX_CONCURRENCY = ' src/sync/pull-budget.ts` | `29: ... = 6` |
| writer exponent 23, reader max 24 | `grep -n 'BLOB_WRITER_EXPONENT = \|BLOB_READER_MAX_EXPONENT = ' src/crypto/blob.ts` | `25: 23`, `27: 24` |
| `--max-bytes` default 536870912 | `grep -n 'default 536870912' cli/help-text.ts` | `93` |
| plugin ceiling 64 to 8192, default 512 | `grep -n '..._PULL_CONFIRM_ABOVE_MB = ' src/plugin/settings-model.ts` | `14` (512 from the budget), `15: 64`, `16: 8192` |
| newest 20 versions, 8 MiB (CLI) | `grep -n 'LIST_VERSIONS_LIMIT = \|LIST_VERSIONS_MAX_BYTES = ' cli/pull-versions.ts` | `20: 20`, `22: 8 * 1024 * 1024` |
| newest 20, 8 MiB (plugin) | `grep -n 'RESTORE_LIST_MAX = \|RESTORE_DECRYPT_MAX_BYTES = ' src/plugin/pull-restore.ts` | `26: 20`, `28: 8 * 1024 * 1024` |
| history warn 1,500, refuse 1,999 | `grep -n 'HISTORY_WARN_AT = \|HISTORY_REFUSE_AT = ' src/sync/history-check.ts` | `18: 1_500`, `19: 1_999` |
| state format 3, 16 devices | `grep -n 'ROOT_STATE_VERSION = \|DEVICES_SEEN_MAX = ' src/sync/root-state.ts` | `20: 3`, `24: 16` |
| `sequence-floor.json`, format 1, 64 vaults | `grep -n 'SEQUENCE_FLOOR_FILE = \|FLOOR_VAULTS_MAX = \|SEQUENCE_FLOOR_VERSION = ' src/sync/sequence-floor.ts` | `12`, `13: 1`, `15: 64` |
| `dht-timeout` `10s` | `grep -n 'NAME_RESOLVE_DHT_TIMEOUT = ' src/kubo/ipns.ts` | `64: "10s"` |
| `.ipfs-sync/tmp`, `.part` and `.copy` | `grep -n 'TEMP_DIR = ' src/sync/temp-files.ts`; `grep -n 'PART_FILE = ' src/sync/blob-fetch.ts` | `4: ".ipfs-sync/tmp"`; `190: /^[0-9A-Za-z-]+\.(?:part\|copy)$/` |
| 16-digit history prefix, name regex | `grep -n 'SEQUENCE_DIGITS = \|HISTORY_NAME = ' src/sync/history-names.ts` | `11: 16`, `12: /^(?:([0-9]{16})-)?([A-Za-z0-9]{10,128})\.enc$/` |
| `device-id`, 12 hex suffix | `grep -n 'DEVICE_ID_FILE = \|DEVICE_SUFFIX_CHARS = ' src/sync/device-store.ts` | `23: "device-id"`, `26: 12` |
| default Argon2id cost 64 MiB, 3 | `grep -n 'KDF_MEMORY_DEFAULT_KIB = \|KDF_ITERATIONS_DEFAULT = ' src/crypto/argon2.ts` | `20: 65_536`, `23: 3` |
| exit codes 0, 1, 2 | `grep -n 'EXIT_OK\b.*=\|EXIT_CHECK_FAILED\b.*=\|EXIT_USAGE\b.*=' cli/io.ts` | `70: 0`, `72: 1`, `74: 2` |
| markers `fixture`, `pulled-fixture` | `grep -rn 'PULLED_MARKER_VALUE =\|FIXTURE_MARKER_VALUE =' src` | `src/core/config/defaults.ts:10` and `:13` |
| conflict name `(ipfs conflict DATE)`, counter inside the parentheses | `grep -n 'ipfs conflict' src/sync/conflict-name.ts` | `20, 23, 32` |
| exclusion list incl. `.smart-env/` | `sed -n 9,18p src/sync/exclusions.ts` (read-only) | `.trash/ .ipfs-sync/ .ipfs-sync-fixture .DS_Store .obsidian/ node_modules/ .git/ .smart-env/` |
| new `excludesHash` | `node -e` over the sorted list joined with `\n` | `ebd10cbd1cd9776229910af44cc1455550e840ba6aad25e8ba9434b0df32da0f`; also pinned at `tests/unit/exclusions.test.ts:6` |
| previous hash (docs name it in full or as `062286b6...ddc9d`) | `grep -n 'PREVIOUS_HASH =' tests/unit/exclusions.test.ts` | `10: "062286b651a2f5a832e1b8913d4e4fcd7dcfd39c081d5eb0bf5f5310962ddc9d"`, commented "the value before mvp-07a task 1.3; every old manifest carries it" |
| warning text "the exclusion lists differ: ..." | `grep -n 'the exclusion lists differ' src/sync/encrypted-pull-stage.ts` | `164` |
| "Pull record", "Ask before pulling more than (MB)" | `grep -n` in `encryption-copy.ts` and `settings-tab-copy.ts` | `encryption-copy.ts:89`, `settings-tab-copy.ts:73` |
| `ownedKeys` config key | `grep -n 'ownedKeys' src/core/config/layers.ts` | `106, 169, 190` |

Refusal and output fragments quoted in the operator doc were each checked with `grep -rqF -- "<fragment>" src cli`: 38 of
38 found (flag-combination texts, `records a different vault ...`, `the node serves sequence`, `an unfinished publish of
sequence`, fork text, first-pull texts, `does not authenticate under this vault's key`, `absent or unreadable on the node`,
the two history-entry stops, `the sequence floor file is damaged`, `the local state file for this root cannot be read`,
`another publish is running in this vault`, `--accept-large` note, `Run pull first, then publish again.`,
`another device may have published to this vault while this publish was running`, `the publication name could not be
read`, `this device is not the publisher ...`, `Unlocking these key slots costs`, `skipped (expected)`, `skipped (unsafe,`,
`integrity-failed`, `remote-deleted`, `locally modified`, `vault created`, `Resolve the fork?`).

## Check 3: the 6.2 "Must state" list, item by item

| Item in the task | Where | Basis |
|---|---|---|
| pull flow and flags | operator doc "Pull ..." and flags table; README "Pull"; DESIGN 8.10 | `encrypted-pull.ts` steps 0 to 6, `encrypted-pull-stage.ts` steps 7 and 8, `help-text.ts` |
| record, floor and limits; key holder ratchet and recovery | operator doc "The record and the sequence floor"; README "Pull"; CHANGELOG Security; DESIGN 8.7 | `sequence-floor.ts` header and `DAMAGED` text, `pull-sequence.ts` |
| first-pull trust and confirmation | operator doc "First pull"; README; DESIGN 8.10 step 6 | `firstPullDetails`, `confirmFirstPull`, three statements constants |
| root CID trust rests on the gateway | operator doc limits list; README; CHANGELOG Security | help text for `--root-cid`; `FIRST_PULL_GATEWAY_STATEMENT` |
| restore adds and replaces, never deletes | operator doc "Restore"; README; DESIGN 8.10 | `restoredState`, verdict `restore` |
| fork resolution and no-ancestor behaviour | operator doc "Fork resolution"; README; DESIGN 8.7 and 8.10 | `fork-resolution.ts` notes (`NO_RECORD_NOTE`, `noEntryNote`, `noMatchNote`) |
| concurrent publishes narrowed, drift guard after another device seen | operator doc "Second device"; DESIGN 8.4 and 8.7 | `name-recheck.ts` header, `drift.ts` `DeviceGuard` and `mayRemoveStrays` |
| routing timeout on first publish counts as not found | same places; plus the stated limit from decision-log line 273 | `rootOfReading` (`timedOut && firstPublish`), `NAME_RESOLVE_ERROR_TEXTS` comment |
| unfinished paths kept unchanged, pull exits 1 | operator doc "Files this device could not restore"; README; DESIGN 8.10 | `settlePull` (`carried`, `needsAttention`), `encryptionCopy.unfinishedKept` |
| `.obsidian/` no longer syncs; `excludesHash` changed; one warning; old entries leave at next publish | operator doc "Exclusions"; README; CHANGELOG; DESIGN 4.2 and 8.3 | `exclusions.ts`, `exclusionDifference`, `settleOne` (expected skip not in baseline) |
| `.smart-env/` statement | operator doc, README, CHANGELOG, DESIGN 4.2 (list only) | see "Smart Connections wording" below |
| marker rule (`fixture` by hand) | operator doc "Second device"; README; DESIGN 8.9 | `help-text.ts` publish and pull paragraphs; `pull-guard.ts` |
| second-device onboarding (same root and key name, adopt owned key, pull first) | operator doc "Second device"; README; CHANGELOG | `PUBLISH_REQUIREMENTS` in `pull-dialog-copy.ts`; `ownedKeys` config key; `--owned-key` |
| temp files plaintext at rest until renamed or swept | operator doc "Other limits"; README; DESIGN 8.3 | `fetchBlobToTemp` (`.part`), `sweepStaleParts` |
| mtime shortcut limit | operator doc, README, DESIGN 8.7 | `inspectLocal` (size and recorded mtime equal means baseline sha256 is trusted) |
| plugin `rename` not atomic | operator doc, README, DESIGN | `obsidian-fs.ts` lines 77 and 166-173 |
| plugin memory statement (128 MiB budget wording, buffers whole responses, Range-ignoring makes large files `unfetched`, not advertised until 07b run) | operator doc "Where the plugin differs"; README (two places); CHANGELOG; DESIGN 8.7 | `blob-source.ts` doc comment and `openHeader`; `pull-budget.ts` header says every number is a proposal |
| history names and legacy entries | operator doc; README; DESIGN 4.1, 8.3 | `history-names.ts` |
| `--repair` ahead change | README; operator doc "Second device" and sequence table; CHANGELOG; DESIGN 8.7 | `repair.ts` header and `assertAheadRepairable` |
| plugin Restore and Resolve fork commands, pull record row | README plugin section; operator doc | `index.ts` 124-125; `describePullRecord` |
| BRAT with a distinct pre-release tag, fixture-only | README (Pull, Not verified); operator doc "Phone facts"; DESIGN 8.7 Mobile; CHANGELOG | Instruction in the dispatch; `device-results.md` records the 0.2.1-probe.1 install |

## Smart Connections wording (limited to the report's evidence tags)

Stated, each tagged [E] in `assessment-smart-connections.md`: the plugin queues a re-import 13 seconds after a note edit and
appends to files in `.smart-env/` (section 2.2 "Update frequency"; sections 1 item 1); its README tells third-party sync
users to add `.smart-env/` to ignore patterns (2.2 (b), README.md:383 of that plugin); its author recommended against
syncing the embedding files (2.2 (d), issue #1058); our idle rule needs path, size and mtime to match (E for the rule,
`idle-check.ts`); our history cap warns at 1,500 and refuses at 1,999 (E, checked again against `history-check.ts`).
"Cannot apply while those files change" and "each non-empty publish adds one history file" follow from the rule and the
cap; the report labels the combined consequence [I], so the text presents it as the effect on our side and not as an
observed outcome.

Deliberately not stated: "rewrites about every 13 s" as a cadence (the report tags the 13 to 20 second cadence [I]; only the
13 s re-import wait is [E]; the dispatch said the report marks the cadence as evidence, which it does not, so I used the
report's own tags); the 21 days and 28 GB projection; the 150 MB size; cross-file inconsistency; phone memory pressure; SC
re-embedding pulled notes; the iCloud link; anything about Android. A code comment in `exclusions.ts` and in
`tests/unit/exclusions.test.ts` says "rewritten about every 13 s while editing"; I did not repeat it.

## Device results wording (only what `device-results.md` records)

Stated as measurements of the 0.2.0 and 0.2.1-probe.1 builds, with the source and the "operator screenshots and reports,
not reproduced by an agent" qualifier: plaintext pulls of 5 files (24 KB) and of 50 MB plus 5 MB worked (time and
responsiveness not recorded); Argon2id 980, 1143 and 1133 ms with gaps 21, 17 and 17 ms (and the Mac baseline 990 to 1177
ms); the first crash is unexplained and the relaunch loop was an iOS file-provider hang cleared by a restart. Stated as not
run: encrypted publish or pull on a phone, background and suspend, memory above 50 MB, Android. I did not add the iCloud
vault name, the cleanup list, or the 16 MiB diagnostic timing.

## Places where I changed a claim that was already in the docs

1. `src/plugin/lock-token-check.ts` no longer exists; the module is `src/sync/lock-token-check.ts` and the engine awaits
   `beforeFirstWrite` (task 2.3) at the first request that can change the node. README, operator doc, DESIGN 8.7 and the
   CHANGELOG named the old path and said there was no check beyond the one after acquisition. Updated to say a fresh check
   runs at the first changing request, and that there is still none before each write (C5-02 stays open for that case). I
   did not mark C5-02 closed; that is a review decision.
2. "Not timed on a phone" in README, operator doc, DESIGN 8.1, 8.7 and the CHANGELOG is replaced by the iPhone measurements
   and the qualifier that the encrypted path did not run there.
3. "Pulling an encrypted vault is not implemented" (README banner, plugin Pull bullet, "Pull in this tree", CLI bullet,
   operator doc status and three rows, DESIGN 8.1 and 8.4) replaced.
4. DESIGN 4.2 said the exclusion list is shared "via `scripts/excludes.txt`"; the CHANGELOG already records that file as
   removed. Replaced with the `src/sync/exclusions.ts` text.
5. "Two devices publishing to one root are not supported" replaced by the turn-taking and narrowing text.

## Findings the lead should read

1. **Name re-check is detect-only, and a routing failure reads as not found.** Decision-log line 273 said docs 6.2 must
   state this; it is in DESIGN 8.4, the operator doc "Second device", the README "Pull" bullet and the CHANGELOG Security
   section. The limit is: the check detects a move only when the name resolves.
2. **A declined first pull is not a zero-write run.** `createNodeLockFile` does `mkdir -p <vault>/.ipfs-sync` when the lock
   is taken, before the confirmation. The docs say: no file, marker, state, floor or key-slot copy is written; the lock may
   leave an empty `.ipfs-sync/` (and the vault directory). Task 33's script asserts "nothing written" for a declined pull;
   if it checks the directory listing, it may disagree. Not verified by running anything.
3. **The size-and-mtime shortcut can make a pull overwrite a local edit without a copy** (an in-place edit that keeps size
   and mtime). Stated in the operator doc, README and DESIGN. It follows from `inspectLocal` and `decideThreeWay`; no test
   was read for it.
4. `FLOOR_VAULTS_MAX` is 64 and the oldest entry by write time is dropped silently beyond it: a device with more than 64
   vaults loses the floor of the least recently raised one. Stated.
5. The plugin has no confirmation dialog for a key slot above the default cost (carry from the 5.3 gate); stated.
6. DESIGN sections 2, 3 and 6 still hold the Helia-over-WSS assumption the decision log calls wrong; not edited (outside
   the assignment).

## Decisions

I made no architecture decision. Doc-judgment choices are listed above (items under "Places where I changed a claim" and
"Deliberately not stated"). I did not append to `.prometheus/decisions.md` or touch `.prometheus/.writer.lock`: the task
did not list that file and the single-writer lock is held by the lead. The lead can append the five items above if wanted.

## Not verified

- No rendered Markdown check, link check or lint ran. Internal references (`"Pull"`, `"Second device"`, `§8.10`) were
  checked by reading.
- Nothing about behaviour was observed: every behavioural sentence is from reading code, and the plugin sentences are from
  reading `pull-runner.ts`, the dialog copy and the notices, not from Obsidian.
- The numbers 128 MiB, 32 MiB, 512 MiB, 6 in flight and the exponent floor are named as the code's values. The code's own
  header calls them proposals, and the docs say "design budget, not a measurement" for the 128 MiB.
- I did not read the 07a spec files for `plugin-pull-ui`, `second-device-publish` or `rollback-detection` beyond one
  grep; where the code and a spec could differ, I wrote the code.
- Tasks 6.1 (integration suite), 6.3 (gate) and 6.4 (review) are open. The docs say the pull is covered by automated tests
  with fake nodes; they do not name the suite of 6.1 or any pass count.
- The `Verify:` line of 6.2: each command and flag named exists in the help text (Check 1); each constant matches by a
  grep (Check 2); no sentence claims the operator run, Obsidian verification, a phone run of the encrypted pull, or
  large-file pull in the plugin (checked with `grep -n -i "operator run\|has run\b\|ran against"` over the four files; the
  only hits are the negative statements, the `mvp-06` script runs that were already recorded, and the 6.2 "not
  advertised ... until the 07b run" sentences).

## Follow-up 2026-10-02 (lead): DESIGN sections 2, 3 and 6, mobile transport

Changed in `DESIGN.md` only. Section 2: the "WebView has only HTTP(S)/WSS" row now says the mobile transport is the plugin
over HTTPS (`requestUrl` RPC, gateway blobs) and Helia/js-libp2p is evaluated, not adopted; added one paragraph that iOS
gives only opportunistic background time, so sync happens with Obsidian open, on an on-load pull or a manual pull (the
client assessment's claim, unverified on a device). Section 3: diagram redrawn without the WSS daemon; added the evidence
paragraph (circuit-relay-only addresses on kubo 0.42.0, 206 and open CORS on `/ipfs/`, 403 for `app://obsidian.md` on
`/api/v0`, IPNS record fetchable; iPhone 24 KB and 50 MB plaintext pulls over `requestUrl`, Argon2id 980 to 1143 ms) with its
limits (probes from a Mac, encrypted pull not run on a phone, Android untested) and the Helia note (about 318 KB gzip,
needs node-side reachability work, adds nothing the AES-GCM authenticated data needs). Section 6: the "WSS to the daemon
only" client line is marked not adopted for mobile. Only the two named files were used as evidence. The Android box in the
diagram is labelled untested.

## Follow-up 2026-10-02 (lead): decision D-2, host-independent path policy

Checked against `src/sync/path-policy.ts` (`platformRefusal`: "refused on every host") and `settleOne` in
`encrypted-pull-plan.ts` (platform skip is carried in the baseline; `needsAttention` gives exit 1). Four edits, nothing run:
README.md (pull-refusal sentence: every host including Linux, `CON.md`); CHANGELOG.md (path policy bullet: host-independent,
carried, exit 1); docs/operator/encrypted-vault.md (`unsafe` skip sentence); DESIGN.md 8.10 path policy (Linux device refuses,
carries forward, exits 1).

## Follow-up 2026-10-03 (documentation-specialist): confirmation read N-01 spec and N-02 runbook

Docs and spec text only; nothing run. Checked against the confirmation read in `review-final.md` and the printed text of
`restoreInstruction` in `tools/feature-op-mvp-07a/policy.mjs` (the script was being adjusted by another agent, so the runbook
states the meaning, not the exact words). Edits: `docs/operator/encrypted-vault.md` section "Before a shared-node run of
`tools/feature-op-mvp-07a.mjs`" (restore is now the supported but unverified kubo CLI form, the accepted-unresolved case, the
signal-exit caveat); `specs/path-hardening/spec.md` (new scenario "Over-limit local path on the publisher side"); `design.md`
decision 11 (one sentence on 255 bytes per segment); 07b `tasks.md` 4.9 (now "verify and harden the restore step", names the
existing runbook section). No restore command has been tested against the shared node.
