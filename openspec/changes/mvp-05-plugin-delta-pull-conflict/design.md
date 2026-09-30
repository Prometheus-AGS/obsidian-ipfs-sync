## Context

Contracts this change builds on (read from the earlier changes' specs and designs, not from in-flux code):
- mvp-03: the pull engine in `src/sync` (`pull-plan`, `conflict-name`, `pull-fetch`, `pull`), the three-way decision using `.ipfs-sync/state.json` as the base, extension-keeping dated conflict copies (`note (ipfs conflict 2026-09-30).md`, counter inside the parentheses on collision), no local deletions, hash-verified temp-then-rename writes under `.ipfs-sync/tmp/`, events `pull.complete`, `conflict`, `file.changed`. Core additions recorded there: `HostFs.lstat`, `rename` (creates parents, replaces a file, replaces a link at the destination), `append` (creates or extends), plus `KuboClient.gatewayStream`. The gateway honours `Range` (probed in mvp-03).
- mvp-04: `src/plugin/` layout (`index.ts`, `obsidian-host-bridge.ts`, `settings-model.ts`, `settings-view-model.ts`, `settings-tab.ts`, `publish-runner.ts`), settings model version 2, the `obsidian` test stub under `tests/support/`, `dist/plugin/` as build output, the marker guard for publish, feature-operation script pattern (throwaway vault, plugin installed into its own `.obsidian/plugins/ipfs-sync/`, `--trigger=manual|cli`, `vault=<throwaway>` on every CLI call), the finding that route A (the app binary as CLI) is unproven until mvp-04's task 6.1.
- Obsidian's `DataAdapter` (checked in the installed `obsidian.d.ts`): `exists`, `stat` (type `file`|`folder`, ctime, mtime, size, or null), `list`, `read`, `readBinary`, `write`, `writeBinary`, `append`, `appendBinary`, `mkdir`, `remove`, `rmdir`, `rename`, `copy`, `process`, `trashLocal`. There is no `lstat`, no partial read, no link information. `TextFileView.save()` exists for flushing editors. `Platform.isMobile` and `Workspace.onLayoutReady` exist.
- The delivery-cadence `publication-receipt.mjs` requires artifacts with public HTTPS URLs, downloads them to re-verify checksums, and requires an HTTPS page whose HTML (or same-origin scripts) contains each artifact URL and the version. It only makes sense after real publication.
- `manifest.json` and `package.json` are at 0.1.0; there is no `styles.css`, no `versions.json`, no `LICENSE` file, and no `.github/` directory. The git remote is `git@github.com:Prometheus-AGS/obsidian-ipfs-sync.git`; no tags exist.

## Goals / Non-Goals

**Goals:**
- Pull inside Obsidian with the same behaviour as the CLI, provably read-only against the node.
- Say precisely what the Obsidian file API can and cannot guarantee.
- A release procedure whose output is evidence, with the outward step gated on the operator.

**Non-Goals:**
- No encryption (mvp-06/07), no mobile verification, no applying remote deletions, no history store in the plugin, no control center.
- No CI workflow and no automatic publishing. No DESIGN.md edit (mvp-10).

## Decisions

1. **Layout.** New in `src/plugin/`: `pull-runner.ts` (guard, target, editor flush, lock, engine call, progress, persisted summary), `sync-lock.ts` (shared with `publish-runner.ts`), `sync-status.ts` (notice and status-bar text from events), `catch-up.ts`, and additions to `obsidian-host-bridge.ts`, `settings-model.ts` (version 3), `settings-view-model.ts`, `settings-tab.ts`. `src/sync`, `src/kubo`, `src/core` are used, with additive changes only (recorded under "Core additions" below if any are needed).
2. **Bridge member mapping** (the `obsidian-fs-semantics` spec, in table form):

   | Member | Implementation over `vault.adapter` | Cannot guarantee |
   |---|---|---|
   | `stat` / `lstat` | `adapter.stat`; `folder` -> directory, `file` -> file, `mtime` ms, `null` -> undefined. `lstat` is the same call | Link detection (see 5) |
   | `list` | `adapter.list` (returns full child paths), one `stat` per child for size and mtime | Cost is one stat per entry |
   | `read` | `adapter.readBinary`, wrapped in `Uint8Array`, refused above the read cap | Peak memory = file size |
   | `readRange` | `readBinary` then `slice` | No partial read on any platform |
   | `write` | `adapter.writeBinary` (creates parents first) | Not atomic; engine never uses it for vault files, only for small state |
   | `append` | if `!exists`: create parents, `writeBinary`; else `appendBinary` | Chunk boundaries are the caller's |
   | `mkdir` | segment-by-segment: `exists` then `mkdir` | Concurrent creators |
   | `remove` | `exists` then `remove`; missing path succeeds | |
   | `rename(from, to)` | create parents of `to`; if `to` exists, `remove(to)` then `adapter.rename` | Replace is remove-then-rename, so not atomic (3) |
   | kv | plugin data, base64 (from mvp-04) | |

   All paths are normalised and rejected if absolute or containing `..`.
3. **Atomic commit and the crash window.** The engine appends bounded chunks to `.ipfs-sync/tmp/<random>.part`, verifies, then calls `rename(tmp, dest)`. Because the adapter's replace semantics are not documented, the bridge does remove-then-rename when the destination exists. The window between the two calls is the only non-atomic moment. What can be lost in that window: for a file with no local edits, nothing (its content equals the recorded base and the verified temp still exists); for a conflict, nothing (the conflict copy was committed first by an earlier rename to a fresh name). After a crash the destination is missing, the temp is present, the next pull sees a missing file and refetches, and it sweeps stale temp files at start. Whether `adapter.rename` already replaces atomically on desktop is not verified; if the feature operation shows it does, the remove step can be dropped later. Rejected alternative: `writeBinary` onto the destination, because it truncates in place and follows links.
4. **Memory and the read cap.** Peak memory for any read is the file size. Setting `maxReadMb`, default 64, allowed 8 to 1024. A read above the cap throws a typed error naming the file and the cap; the engine counts that file as failed (pull) or skipped (publish) and continues. Downloads are not bounded by the cap because they stream through `append` with 8 MB chunks and an incremental hash, but a downloaded file above the cap can no longer be re-hashed on this device; the state records its sha256 from the download, and a later forced re-verify (exclusion divergence) would report it as failed. The 64 MB default and the range are proposals, chosen so a phone-class device survives the default; the numbers are not from a measurement (Open Questions).
5. **Symlinks.** `lstat` cannot see links, so mvp-03's rule cannot bite here. Options considered: (a) reach Node's `fs` through Electron `require`; rejected, it breaks the WebView-safety rule and mobile parity. (b) Refuse vaults that might contain links; there is no way to know. (c) Accept and document. Chosen: (c) plus mitigations: fixture-only vaults in this release; commit by rename, which on POSIX replaces a link at the destination instead of writing through it (to be observed, not assumed: the feature operation has a probe); the plugin never creates links. Residual: a link at a directory component of a path is followed by the file API; the probe cannot exclude it. This is stated in the release notes as a limitation. It is not a claim that Obsidian's indexer ignores links; behaviour differs by platform and was not verified.
6. **Destination guard.** Publish's rule (marker present) is stricter than needed for pull. For pull the vault always contains `.obsidian/` (that is where the plugin lives), so the mvp-03 CLI rule "absent or empty" would refuse every fresh vault. Plugin rule: marker present, or no files outside `.obsidian/` and `.ipfs-sync/` (folders are ignored if empty of files). When admitted by emptiness the pull writes the marker. Justification is the same as the CLI's: the remote can only hold fixture content, so the guard exists to stop fixture content overwriting a real vault.
7. **Unsaved editor content.** The pull first calls `save()` on every open `TextFileView` (markdown editors), because Obsidian debounces editor saves by about two seconds and a pending edit would otherwise look like an unedited file and be overwritten without a conflict copy. Files replaced on disk while open are reloaded by Obsidian's own file watcher; that reload behaviour on each platform was not verified.
8. **One operation at a time.** A single lock object shared by the publish and pull runners, released in `finally`; a blocked request shows a notice. The engine's state file has a single writer at any time.
9. **Target.** `pullName` setting; empty means the owned publication key's ID via `key/list` plus `ownedKeys` (read-only). The runner passes the resolved name to the engine's `name/resolve` (nocache). A key that is absent or not recorded stops the pull with a pointer to the setting.
10. **Progress and notice content.** Phases: "Resolving name", "Reading manifest", "Comparing N files", "Fetching i of M". A notice is created at start and updated in place (not one per file). Final notice: `Pull complete: F fetched, U unchanged, C conflicts, X failed, D remote deletions kept`; when C > 0 a second line names up to three conflict copies and says how many more; when X > 0 the first three failed paths with reasons (symlink refusal is not possible here, cap errors and verification failures are). The status-bar item shows the same counts compactly and the time. The summary is persisted as `lastPull` in plugin data (counts, root CID, manifest rootCID, timestamps; no paths), and `lastPublish` likewise for publish (mvp-04's result). Paths are shown in notices for the user but never persisted.
11. **Catch-up.** In `onload`, after settings load, if `catchUpOnLoad` then `workspace.onLayoutReady(() => runner.pull({ quiet: true }))`. Quiet means: no start notice, a notice only on change, conflict, or failure. Errors are caught so startup is never blocked. It respects the lock and every guard.
12. **Settings model version 3.** Adds `pullName`, `catchUpOnLoad`, `maxReadMb`, `lastPull`, `lastPublish`. Loading version 2 fills defaults and keeps the rest. The view model gains validation for the three inputs and the "name that will be pulled" line. uiux-lead owns layout and copy for the additions; the tab remains plain.
13. **Legacy removal.** The plugin already lost the tar pull in mvp-04; this change adds a check that no `api/v0/get` or tar code remains in `src/` and `src/plugin/`.
14. **Release procedure.** A tool `tools/release-mvp-05.mjs` (owned by release-deployment-lead) in two modes, `plan` (default, read-only: prints what it would do) and `record`. It never runs `git tag`, `git push` or `gh`. `record`: refuses unless the feature-operation evidence file exists and reports pass; bumps versions in `manifest.json` and `package.json` (0.2.0); runs `pnpm build`; copies `dist/plugin/main.js` and `manifest.json` (and `styles.css` if present) into `dist/release/v0.2.0/`; builds the CLI tarball from an explicit file list (`dist/cli/ipfs-sync.mjs`); writes `SHA256SUMS`; verifies it by recomputation; assembles `release-notes.md` from a template that opens with the fixture-only statement and lists limitations; writes `evidence.json` linking the feature-operation output, screenshots or recording and notes. The printed "next commands" for the outward step (tag, push, `gh release create --prerelease` with the asset list) are text only and are executed by the release-deployment-lead only after the operator approves that exact action. Cadence: `publication.mode` is `manual`, so publication debt is recorded at the release; if publication is declined, the debt stays pending and is reported, not cleared.
15. **Feature operation.** See below.

## Feature Operation

Script `tools/feature-op-mvp-05.mjs`, one process, same pattern as mvp-04's script and the same safety rules: it never reads or writes `/Users/gqadonis/obsidian`; every Obsidian CLI call, if that route is used, carries `vault=<throwaway>` and is preceded by a path check; default `--trigger=manual`; `--trigger=cli` only if mvp-04's supervised run proved route A and the lead switches it on.

1. Build check: `pnpm build`, assert `dist/plugin/main.js` and `manifest.json` and no Node built-in in the bundle.
2. Baseline: generate fixture V1 in a temp dir (marker present, N files); publish with the built CLI to `/obsidian-vault-sync/mvp05-demo` using the stable feature-op config `path.join(os.tmpdir(), 'ipfs-sync-feature-ops', 'config.json')` (key owned; if the key exists on the node but is not recorded there, stop with a clear message).
3. V2: `ipfs-sync pull` (CLI, mvp-03) into an absent directory, so V2 has the same content, the marker and a `.ipfs-sync/state.json` base. Install the plugin into both vaults (`main.js`, `manifest.json`, `community-plugins.json`, seeded version 3 `data.json` with endpoints, key, `mfsRoot` `/obsidian-vault-sync/mvp05-demo`, `ownedKeys`, `pullName` empty, catch-up off).
4. Edits: in V2, note X gets `local text`; in V1, X gets `remote text`, note Y gets `remote-only text`, and a probe note `symlink-probe.md` gets new content; in V2, `symlink-probe.md` is replaced by a symbolic link to a file outside the vault whose content is byte-identical to the original note (so the plugin sees an unedited file, not a conflict) and is recorded. Republish V1 with the CLI (`3 written, 0 removed`).
5. Snapshot before: mtimes of every V2 file except X, Y and the probe; `name/resolve` result, `files/stat` of the demo root, and `key/list` (all read-only).
6. Trigger: the operator opens V2 in Obsidian, enables the plugin and runs "IPFS Sync: Pull vault"; the script waits (stated timeout) until V2's `data.json` shows a `lastPull`, or the timeout expires.
7. Verify: X holds `remote text`; `X (ipfs conflict <today>).md` exists and holds `local text` byte for byte; Y holds its remote text and has no conflict copy; every other file's mtime is unchanged (not rewritten); `lastPull` in `data.json` reports `fetched` 3 (X, Y, probe), `conflicts` 1, `failed` 0, and contains no path text; V2's `state.json` `manifest.rootCID` equals the CID of `<root>/current` at the latest publish; the snapshot after equals the snapshot before (pull did not mutate the node); the outside file the symlink pointed at is unchanged. The probe's observed outcome (link replaced by a regular file, or otherwise) is printed either way; a changed outside file fails the run.
8. Notice evidence the script cannot capture: the operator or the computer-use step saves a screenshot of the completion notice and of the settings tab's last-pull view; the paths are passed with `--evidence` and recorded. One status notice is expected (updated in place).
9. Optional `--with-refusal`: a third throwaway directory containing a non-fixture note and the plugin; running Pull there must produce the refusal notice, no file change and an unchanged node snapshot.
10. Cleanup of temp vaults; print each result; exit nonzero on any failed assertion; write `feature-op-mvp-05.json` (assertions, timings, evidence paths) for the release record.

Unverified after a pass: mobile, an authenticated endpoint, symlink behaviour on other platforms, and the crash window of remove-then-rename (not exercised).

## Release Procedure and Receipt (operator-approved steps marked)

1. Preconditions (all tasks done, gate passed, reviews returned, feature operation evidence passing).
2. `tools/release-mvp-05.mjs plan` prints the plan; the operator reads it.
3. `record` produces `dist/release/v0.2.0/`: `main.js`, `manifest.json`, `styles.css` if present, `ipfs-sync-cli-0.2.0.tgz`, `SHA256SUMS`, `release-notes.md`, `evidence.json`, and the version bump in `manifest.json` and `package.json` (local edits; committing them is a separate decision).
4. **Operator approval, per action:** (a) commit the version bump; (b) create tag `v0.2.0` on a stated commit; (c) push the branch and tag; (d) create the GitHub pre-release on `Prometheus-AGS/obsidian-ipfs-sync` with the listed assets. Each is shown with its exact text and requires its own explicit yes. Nothing is inferred from the plan or from earlier messages.
5. If published: run the cadence receipt tool (`publication-receipt.mjs`) with the version, frozen source refs, the public asset URLs and a first-party page that advertises them; it re-downloads and re-verifies checksums. If not published: record "publication pending" and stop; do not write a receipt.

## Risks / Trade-offs

- [Symlink write-through cannot be prevented in the plugin] -> documented, fixture-only, probe; the probe could find that a link at the destination is followed, which would block the release pending a decision.
- [Remove-then-rename gap] -> loses nothing irreplaceable (decision 3), recoverable by refetch.
- [64 MB cap is a guess] -> configurable, reported per file; large-file behaviour is unverified.
- [Editor flush uses `TextFileView.save()`] -> covers markdown editors; other view types with pending state are not covered.
- [Obsidian's file watcher and a file replaced while open] -> not verified per platform.
- [Release 1 is unusable for real notes] -> stated at every touchpoint; the risk is a user ignoring the notes, mitigated by the refusal guard in the plugin itself.
- [The receipt tool needs a public page advertising asset URLs] -> a GitHub release page may list assets as relative links, which would fail the tool's absolute-URL match; unverified (Open Questions).
- [The dirty working tree] -> the tag would need a clean commit containing the version bump and every change of mvp-01 to mvp-05; the repository currently has many uncommitted changes and no tags.

## Migration Plan

Additive. Settings version 2 loads with new defaults. Rollback: revert the change; `data.json` keeps the extra fields, which version-2 code ignores. The release steps are not automatic and are reversible until the operator approves the outward ones; a pushed tag or published release is not reversible by this project.

## Core additions

Recorded during implementation of tasks 1.1 to 3.1 (ipfs-engineer). All are additive: no existing member, event, option or default changed, and the CLI behaves as before. `src/core` and `src/kubo` are untouched.

`src/sync`:
- `pull.ts`: `PullDeps.assertDestination` (optional, default `assertPullDestination`) lets a host supply its destination rule; `PullDeps.onPhase` (optional) reports `resolving`, `reading-manifest`, `comparing {files}`, `fetching {total}` (type `PullPhase`). The plugin needs the first because an Obsidian vault always holds `.obsidian/`, which the CLI rule ("absent or empty") would refuse; it needs the second for the progress text the spec requires ("Comparing N files", "Fetching i of M").
- `pull-guard.ts`: `assertVaultPullDestination` (marker present, or no file outside `.obsidian/` and `.ipfs-sync/`; empty folders ignored; the marker is created by the engine after the manifest was read, exactly as for the CLI). `pull-errors.ts`: `PullGuardError.reason` (`real-vault` | `unsafe-destination`, default `unsafe-destination`) so the plugin can show the fixture-only notice for the first and the error text for the second.
- `host-errors.ts`: `HostReadCapError` (file, size, cap; the message names the file and the cap, no content). `pull-plan.ts` turns it into a refused decision for that file (counted as failed, other files go on). `diff.ts` and `publish.ts`: `DeltaPlan.skipped` and `PublishResult.skipped` (empty on hosts without a cap); a skipped file that was published before keeps its previous entry (never reported as removed) and gets no new mtime, so the next run reads it again. The spec asks for "skipped with a count (publish)"; this is what that needs.

`src/plugin` deviations from the layout in decision 1 (reasons):
- Notice text for pull is in `pull-notices.ts` and the in-place notice plumbing in `pull-presenter.ts`, not in `sync-status.ts`: that file already holds the Status command's report (`collectStatus`), and pull text mirrors `publish-notices.ts`.
- Extra small modules: `read-cap.ts` (range and default), `pull-target.ts` (name parsing, preview, resolution), `settings-activity.ts` (settings tab wording for the target line and last-activity view), `summary-store.ts` (a failed summary save is reported in the notice, never swallowed, and does not turn a finished pull into a failed one), `editor-flush.ts`.
- The editor flush calls `save()` only on a `TextFileView` whose text differs from the file on disk (compared as text), not on every open view: an unconditional save may rewrite an untouched note and change its mtime, which the feature operation asserts against. Pending edits are still saved. Whether Obsidian's own `save()` skips identical content was not verified.
- `settings-fields.ts` keeps the three new field IDs in `PULL_FIELD_IDS` (`EditableFieldId = FieldId | PullFieldId`), not in `FIELD_IDS`, so the tab's copy table (`Record<FieldId, FieldCopy>`, owned by uiux-lead) still compiles until task 3.2 extends it. The view model accepts all three through `edit(field, text)`; the catch-up toggle passes `"true"` or `"false"`.
- `minAppVersion` in the root `manifest.json` is now 1.12.3 (`appendBinary`, decision of the lead 2026-09-30). The release tooling must not lower it.

Known limits, not weakened: the adapter has no `lstat`, no partial read and an unspecified `rename` replace; see the bridge table. Two consequences worth stating: a file between 32 MB and the cap is hashed with 8 MB range reads that each load the whole file (repeated whole reads, correct but slow); a gateway that ignores `Range` sends a whole large object through `requestUrl`, which buffers it (the engine accepts a 200 only at offset 0, as before).

## Open Questions

1. **Cadence publication without external publication.** `publication-receipt.mjs` cannot be satisfied by a local record; it needs public HTTPS artifact URLs and a page advertising them. Is the cadence publication debt for Release 1 cleared by the local release record plus operator acknowledgement (`review`), or does it stay pending until a GitHub release is approved? The plan's profile has `publication.mode: manual` and `requireMetadata: true` but no `websiteUrl`. Recommendation: keep it pending and report it; never fabricate a receipt.
2. **GitHub release page as the advertising page.** Whether the release page's HTML contains the absolute asset URLs the receipt tool looks for is unverified; a README or a small first-party page may be needed.
3. **Repository state for tagging.** Many mvp-01 to mvp-05 changes are uncommitted and there are no tags; who commits and on which branch is an operator decision (git operations are not in this change's tasks except as approved actions).
4. **Read cap defaults (64 MB, range 8 to 1024)** are proposals, not measurements.
5. **`adapter.rename` replace semantics** on each platform are unverified; the remove-then-rename fallback is safe either way.
6. **Route A (the Obsidian CLI at the app binary)** for the trigger depends on mvp-04's supervised proof; default stays manual.
7. **CLI tarball contents.** The plan lists a CLI tarball; the exact file list (the bundle only, or with README and licence) is a release-deployment-lead decision; there is no `LICENSE` file in the repository although `package.json` declares MIT.
8. **`versions.json`** (used by Obsidian's community directory for minimum-app-version mapping) does not exist; not needed for a manual or BRAT-style install, and no directory submission is in scope.
