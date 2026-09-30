# Security delta check 3b — mvp-06 after review-3 fixes (tasks 28/29), independent

Reviewer: security-reviewer (static read only; no command run). Saved by the lead as a condensed record (2026-09-30); every finding id, location and fix is kept, narratives shortened. Full report in the session transcript. One independent model read; no cross-model judge.

VERDICT: PROCEED-WITH-FIXES — no CRITICAL or HIGH. The BLOCKers W-01, W-02, W-03 are fixed and could not be broken by static reading. Section 4 may start once N3-01 (MEDIUM) is fixed or explicitly accepted.

## W-status
- W-01 FIXED-CORRECTLY — `publish-session.ts:120` passes `repair` to `resumeJournal`; `publish-resume.ts:64,189` returns `deferred` for journal-conflict, journal-manifest-mismatch, sequence-ahead, node-manifest-missing; `journalOutOfStep` reuses `journal-conflict` (`publish-refusals.ts:105`); only `authorizeRepair` (`repair.ts:102`) deletes the journal after checks and confirmation; `publish.ts:72` drops a deferred journal if no repair took over; tests `encrypted-publish-review3.test.ts:63-118`. Intentionally non-repairable: `assertJournalMatches`, vault mismatch.
- W-02 FIXED-CORRECTLY — `publish-resume.ts:113-119` adopts on history-conflict; `commitPublish` (`publish-commit.ts:98-99`) refuses the next publish before the journal is written. Residual: N3-08.
- W-03 FIXED-CORRECTLY — `assessNode` runs `assertHistoryReady` before any blob write; warn 1,500, refuse 1,999; junk removed only with `--repair` plus confirmation, one path segment, non-recursive; oversized read-back listing → `ReadBackError`; oversized prefix folder → `prefixFolderTooLarge`. Tests at 1,499/1,500/2,001; no exact 1,999/2,000 test.
- W-04 FIXED-WITH-GAP — `rebuild` needs a local record and keyslots byte-equal to the local copy and always confirms (`repair.ts:65-78`); `rewriteFromJournal` covers a torn `manifest.enc`. Gap N3-01.
- W-05 FIXED-WITH-GAP — `moveAside` rename plus token check; `lapsed()` fails `assertHeld` after 2x heartbeat; `guardKv` wraps local writes. Residual N3-03.
- W-06 FIXED-WITH-GAP — 64 KiB RPC cap, 16 KiB error-body cap, threat model states the `requestUrl` buffering limit. Still unbounded (LOW): `rpc-call.ts:106` (files/write reply, accepted in review-3) and `gateway.ts:49` (pull v1 whole body).
- W-07 FIXED-WITH-GAP — `idle-check.ts` runs before unlock (`publish.ts:197`); see N3-04.
- W-08 FIXED-CORRECTLY — status 500 plus JSON `nodeMessage` required.
- W-09 FIXED-WITH-GAP — cap is `expected.length`; cap refusal is `PublishRefusedError` not `ReadBackError` (N3-07).
- W-10 FIXED-CORRECTLY — `ensure()` only in `transfer`; `journal.key` checked; `publishRoot` re-reads `keyList`, requires ID equality, refuses empty ID; pin and publish use the read-back CID. A race between the last `keyList` and `name/publish` cannot be closed client-side.
- W-11 FIXED-CORRECTLY — KV files 0600, dir 0700, `sync()` before rename.
- W-12 FIXED-CORRECTLY — module-scope WeakMap in `plugin-seams.ts`; no public seam properties on the plugin.
- W-13 FIXED-WITH-GAP — `io.err` strips control characters; the confirm prompt does not (N3-06).
- W-17 FIXED-CORRECTLY — `writeFileToMfs` gone from `src`.
- W-18 FIXED-CORRECTLY — `NO_HARD_LINKS` → `lockUnsupported`.
- W-19 NOT-FIXED — `tests/helpers/publish-rig.ts:113` still `concurrency: 1`; loose regex at `tests/unit/read-back.test.ts:74`.
- W-14/15/16 deferral not recorded in the mvp-07 files → add to the guard-removal checklist.

## Author-flagged areas
- Idle shortcut: metadata-only trust is no weaker than the normal path (`diff.ts:66` already skips hashing on equal size+mtime); the idle path additionally requires MFS root CID == `state.rootCid` and no journal and no `--repair`; a lying node can only cause a skipped publish. Real pre-existing case: a file restored with mtime preserved (`cp -p`, `rsync -t`) → needs a doc line.
- Lock takeover: two takers of the same stale token cannot both win; sticky `lock-lost` fails safe; residuals N3-03.
- `rewriteFromJournal` / rebuild: neither publishes attacker-chosen content; both write locally computed manifests; resume rewrites only when `journal.sequence > state.sequence` and refuses on key mismatch; rebuild sequence is max(local, node, record)+1. Flaws N3-01, N3-02.
- `publishRoot`: correct (see W-10).

## New findings
- **N3-01 MEDIUM — `malformed-input` conflates torn ciphertext with a schema failure after successful authentication.** `manifest-auth.ts:9` treats `malformed-input` as unreadable; `ManifestFormatError` (`encrypted-manifest.ts:70-74`, thrown after AEAD success for wrong field set/version/values) has the same code. Scenario: another device on a newer build publishes an authentic manifest with an extra field; this device has a journal from a crash; `reconcile` (`publish-resume.ts:160-163`) calls `rewriteFromJournal`, overwriting the newer manifest with no sequence check and no confirmation; `--repair` rebuild does the same after a confirmation saying "does not authenticate". Fix: `isUnreadableManifest` returns false for `ManifestFormatError`; only `authentication-failed` and envelope-level `malformed-input` are unreadable; test with an authentic manifest carrying an unknown field.
- **N3-02 LOW — `recordSequence` uses `??`, not `max` (`publish.ts:50`).** With a state present the deferred journal's sequence is ignored; in `node-manifest-missing` rebuild the new manifest can reuse S+1 though `name/publish` for S+1 may have happened → false fork report on another device. Fix: `Math.max(state?.sequence ?? 0, deferredSequence ?? 0)`.
- **N3-03 LOW — lock races.** Heartbeat is read-then-rename (`publish-lock.ts:126-132`, `cli/publish-lock-file.ts:58-62`): a holder that read its own token just before a takeover can rename over the taker's fresh lock; both believe they hold it up to 60 s. Put-back in `takeOver` (`publish-lock.ts:110-113`) has a window for a third acquirer and ignores a put-back `createExclusive` failure. Fix: re-verify the token after the rename; throw when put-back fails; skip `discard` when put-back fails.
- **N3-04 LOW — idle path gaps.** (1) Sends `files/stat`/`key/list` and returns `unchanged` before any passphrase check, contradicting the ordering comment in `publish-session.ts:20-27`; (2) files with no recorded mtime force Argon2 every tick; (3) no test for touched-file, mtime-less or wrong-passphrase behaviour (`encrypted-publish-review3b.test.ts` covers only the happy idle path).
- **N3-05 LOW —** `--key` rename after a crash gives `journal-mismatch` advising "abandon or restore the matching record" (`publish-refusals.ts:89-94`); say "publish with the original key name".
- **N3-06 LOW —** `askOnTerminal` (`cli/io.ts:14-22`) prints the prompt without `stripControlCharacters`; `JSON.stringify` in `shown()` (`history-check.ts:52`) leaves U+007F..U+009F and bidi characters unescaped, so a junk name planted on the node reaches the `--repair` confirmation prompt. Strip in the prompt.
- **N3-07 LOW —** `readRemoteFile` cap refusals raise `PublishRefusedError` (`node-reader.ts:63`), so `finishOrAdopt` does not adopt. Wrap size refusals in `ReadBackError` inside `assertFileEquals`.
- **N3-08 LOW —** a planted `manifests/<currentCID>.enc` leaves a permanent refusal with an unchanged tree; `hasWork` stays true, the idle path never matches, every timer tick pays Argon2 then refuses. Comment at `publish-resume.ts:115-116` ("refuses before writing anything") holds only when no blob changed (`transfer` runs before `commitPublish`).
- **N3-09 LOW (operational) —** publishing stops for good at 1,999 history files and `prune-history` does not exist; an actively edited vault on a timer can reach that in days to weeks. `prune-history` must ship in mvp-07 before the fixture-marker guard is lifted.

## Not verified
No test/build run. Real kubo behaviour: `ls` on `/ipfs/<cid>`, HAMT sharding near 2,000 entries in `manifests/`, `ls` JSON size vs the 1 MiB cap; `files/write` partial-write semantics after abort; heartbeat timing under sleep/stalls; the plugin runner takes no file lock (in-process only) and `assertHeld` wiring in `src/plugin/publish-runner.ts` was not read (wired for CLI at `cli/publish-command.ts:118`); DESIGN §8 text; exact 1,999/2,000 test boundaries.

## Lead disposition (2026-09-30)
Accept all. Fix now (task 31, src/sync + tests): N3-01, N3-02, N3-04(1,2,3), N3-05, N3-07, N3-08 comment, W-19, and N3-03's `publish-lock.ts` half. Deferred until 4.1 lands (cli/ is being written): N3-06 and N3-03's `cli/publish-lock-file.ts` half. Deferred to mvp-07 checklist: W-14/15/16, N3-09 (`prune-history` before guard removal), W-06 remainders, mtime-preserved-restore doc line.
