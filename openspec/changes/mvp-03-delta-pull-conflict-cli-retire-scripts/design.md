## Context

mvp-02 (contract, not yet merged code) defines: MFS root layout `<mfsRoot>/current/`, `<mfsRoot>/manifest.json` (latest), `<mfsRoot>/manifests/<currentCID>.json` (immutable history); IPNS publishes the CID of `<mfsRoot>`; manifest v1 with `rootCID` = CID of `current/`; a local file `<vault>/.ipfs-sync/state.json` holding `{manifest, mtimes, key}` written by publish; `src/sync/exclusions.ts` and `excludesHash`; `src/sync/hash.ts` (WebCrypto up to 32 MB, incremental `@noble/hashes` above); the typed EventBus with `file.changed` and `publish.complete`; a HostBridge interface (frozen `src/core`) with a Node implementation in `cli/node-host-bridge.ts`; the kubo client with `nameResolve`; the fixture marker and `assertFixtureVault`. `src/core` outside `store/` is softly frozen after mvp-02 (lead decision): this change may add to it additively (new HostBridge members, new event types), never break existing contracts. The old `scripts/pull.sh` downloads a tar and merges with `rsync -a -b --suffix=" (ipfs conflict $(date +%Y-%m-%d))"`, so the conflict copy is the local file's full name plus the suffix (`a.md (ipfs conflict 2026-09-29)`, which loses the `.md` extension), and every differing file is overwritten regardless of who edited it. Spec 011 Q5 requires divergence of exclusion lists to be loud. DESIGN.md §4.3 says never to delete local files. See proposal.md.

## Goals / Non-Goals

**Goals:**
- Cost proportional to change; bounded memory; remote wins without losing local text.
- A byte that fails verification never appears at its destination.
- Pull is provably read-only against the shared node.

**Non-Goals:**
- No plugin code (mvp-05), no history store (mvp-08), no encryption (mvp-06/07).
- No applying remote deletions, no merge of text, no watch mode.
- No edit to DESIGN.md (synced in mvp-10). Core changes are additive only.

## Decisions

1. **Layout.** New in `src/sync/`: `pull-plan.ts` (pure three-way planner, path and manifest validation), `conflict-name.ts` (pure), `pull-fetch.ts` (bounded pool, streamed verified write), `pull.ts` (orchestration, events, record update). `src/kubo/` gains a ranged gateway read. `cli/pull-command.ts` wires flags; `tools/feature-op-mvp-03.mjs` is the feature operation. Pure modules take the clock and the "name exists" probe as arguments so tests need no disk.
2. **Target resolution.** `--name` wins. Otherwise `key/list`, find the configured `--key` name, require its ID to be in `ownedKeys` (or `--owned-key`), and use that ID. This is read-only. Then `name/resolve` on `/ipns/<id>` to the root CID. Pulling from a name that is not ours is allowed because it is a read. Recursion or DNSLink resolution is not designed here.
3. **Manifest selection.** Latest: gateway GET `<root>/manifest.json`. Historical: `<root>/manifests/<currentCID>.json`. Local file: read through the HostBridge. Files always come from `/ipfs/<manifest.rootCID>/<path>`; for the latest manifest that equals `<root>/current/<path>`. Historical trees stay reachable because mvp-02 pins each `<mfsRoot>` CID and this project never unpins. `--manifest-file` exists so fail-closed behaviour can be demonstrated without writing to the node: an edited copy of a real manifest carries a wrong sha256, the real bytes are fetched, and verification fails. Alternative considered: a hidden "expected sha override" flag; rejected because it is a behaviour switch inside the trust path, while `--manifest-file` is an ordinary, documented input.
4. **Local sync record (the base).** No new file. Pull reads the mvp-02 `state.json`: `manifest.files[path].sha256` is B, `mtimes[path]` is the mtime shortcut. After a pull of the latest published manifest (default, or `--manifest` naming the current latest `currentCID`), the record is rewritten as the selected manifest with each failed path reverted to its previous entry (or dropped if none), with `mtimes` set from the post-write stat of every file pull synchronised. Publish therefore sees pulled files as already synchronised. A pull of any other manifest (an older `--manifest`, or `--manifest-file`) does NOT advance the record: `state.json` stays as it was (conflict decisions still compare against it), a stderr line says "restored from <cid>; sync record not advanced (next publish will overwrite newer remote content)", and the next publish writes the restored files, so restore-then-publish is a rollback of the remote. Conflict paths are recorded as the remote sha256 (the remote text now sits at that path; the local text lives in the copy). A path is a candidate for "remote deleted" only if it is in the previous `manifest.files` and absent from the new manifest. If `state.json` is missing, every differing local file is untracked and becomes a conflict, which errs toward keeping local data. If it is unreadable or has an unknown shape, pull fails before writing rather than guessing.
5. **Decision table.** Exactly the spec's three-way rule. Sketch: `L==R` record only; missing local, fetch; `L==B`, replace; `R==B` and `L!=B`, report locally modified and leave; otherwise conflict. Hashing is skipped when size and mtime equal the record (unless `excludesHash` diverged).
6. **Conflict copy.** Preserve first, replace second. The copy is written from the local bytes with a temp file and rename, so a crash between the two steps leaves either the original alone or original plus copy, never a lost original. Name: `<stem> (ipfs conflict YYYY-MM-DD).<ext>` in the same directory, split at the last dot of the file name, using the pulling machine's local date; a name with no dot, or a dotfile whose only dot is the leading one, gets the suffix at the end. Examples: `note.md` gives `note (ipfs conflict 2026-09-30).md`; `data.tar.gz` gives `data.tar (ipfs conflict 2026-09-30).gz`; `.gitignore` gives `.gitignore (ipfs conflict 2026-09-30)`. If the name is taken, the counter goes inside the parentheses: `(ipfs conflict YYYY-MM-DD 2)`, `3`, and so on. **This deliberately deviates from the old rsync-era naming**, which appended the suffix after the extension so Obsidian could not open the copy (lead decision), and from its silent overwrite of a same-day backup, which was data loss. Conflict copies are ordinary vault files and get published; a copy is a new path, so other devices fetch it as a new file and no loop forms (a conflict on a copy needs two devices editing that same copy). The README's `name.ext (ipfs conflict ...)` wording is corrected in task 4.2.
7. **Fetch and verify.** The pool (4 to 6) fetches `/ipfs/<rootCID>/<path>`. Bodies stream to a temp file under `<vault>/.ipfs-sync/tmp/` (same filesystem, excluded from sync and from the plaintext guard) while an incremental sha256 runs; files above 32 MB use ranged reads of at most 8 MB. After the stream ends, size and sha256 are compared; on match the temp file is renamed onto the destination (parent directories created first), on mismatch it is removed. This differs from "same directory" only in where the temp file sits, and it keeps half-written names out of the vault tree, where a crash could otherwise get them published. Whether the gateway honours `Range` is unverified (Open Questions); if not, the fallback is a plain streamed response with the same hash-while-writing loop.
8. **Symlinks.** Before each write, pull lstat-checks the destination and every directory component below the vault root. A symbolic link anywhere on that path makes the file fail with a symlink reason (counted as failed, other files continue); nothing is created, replaced or removed for it. A symlinked vault root argument is the operator's choice and is not checked.

9. **Untrusted paths.** Every manifest path is checked before any request: no absolute paths, empty/`.`/`..` segments, backslashes, control characters or `.ipfs-sync/` prefix. This is a real trust boundary (the manifest comes from the network). Addendum (mvp-04 repair, 2026-09-30): paths matching the effective exclusion list, and anything under `.obsidian/plugins/`, are refused the same way (`excludedPathReason` in `pull-plan.ts`; `PlanInput.extraExclusions` carries this device's additions). This is a partial mitigation of forged manifests until the manifest is authenticated (mvp-06/07).
10. **excludesHash divergence.** Compare `manifest.excludesHash` with the hash of the local effective list (the same function publish uses). Mismatch: stderr warning naming both hashes; ignore mtimes; re-hash every local manifest file; same decision table. "Full sync" here means full re-verification, not blanket re-download, because identical content need not transfer, and no local file is deleted or overwritten silently. Alternative (refetch everything) rejected as wasteful and no safer.
11. **Plaintext guard.** Publish accepts only marker vaults. For pull, the manifest cannot carry the marker (mvp-02 excludes it), so "destination has the marker or the manifest is a fixture" cannot work. Rule: absent or empty destination is allowed and gets the marker written; non-empty destination needs the marker. Justification: the remote can only hold fixture content (publish guard), so the only harm the guard prevents is fixture content overwriting a real vault, and a real vault is non-empty without the marker. The rule matches the fixture generator's "refuse non-empty target unless marked". Removed in mvp-06.
12. **Read-only.** The pull code path receives a client interface narrowed to `nameResolve`, `keyList`, gateway reads; it is not handed `filesWrite` and friends, so a mutation cannot be written by accident. Tests use a recording node and assert on the request list.
13. **Events and additive core changes.** `pull.complete`, `conflict`, and `file.changed` (added/modified) on the mvp-02 bus. New event types are added to the bus's event map in `src/core/events/` additively; new HostBridge members pull needs (streamed write, rename, mkdir, remove, lstat if absent) are added to `src/core/host-bridge/` and implemented in `cli/node-host-bridge.ts`. Each addition is recorded here under "Core additions" when made; existing members and events are not changed.
14. **Exit codes.** 0 all good; 1 any failed file or refused path; 2 usage or configuration (mvp-01 convention). Remote-deleted and locally-modified are informational and do not change the exit code.
15. **Script retirement.** Delete the three files; remove the `bash-32-compatible-scripts` constraint and the `bash -n` trigger (the `pnpm build` trigger already exists); drop `scripts/` from the path lists of the other greps. The `no-python` check is currently tripped by `python3` inside the scripts, so retirement also clears it. README lines are changed by the documentation-specialist (task 5.2).

## Risks / Trade-offs

- [A stale or missing record turns every difference into a conflict copy] -> safe direction (no loss), noisy. Acceptable; the alternative silently drops text.
- [Conflict copies are themselves vault files and will be published by the next publish] -> matches the old flow; documented in the summary line.
- [Bug in the three-way decision loses user text] -> the highest-severity risk; the planner is pure with a full decision-table test, preservation happens before replacement, and the feature operation checks the conflict copy text byte for byte.
- [Historical restore needs old trees to stay reachable] -> relies on mvp-02 pinning and on nobody unpinning; if a tree is missing, that file fails and is reported.
- [Gateway Range support unknown] -> task 3.1 probes it read-only; fallback in decision 7.
- [Temp files under `.ipfs-sync/tmp/`] -> a crash can leave them; the next pull sweeps that folder before starting.
- [Hash-while-streaming for >32 MB depends on the mvp-02 incremental hasher] -> reuse, not reimplementation.
- [Symlinks inside the vault could redirect a write] -> not designed here; pull writes are limited to paths under the vault root as strings. Raised as an open question.

## Migration Plan

Removing the scripts is the breaking part. Anyone using them switches to `ipfs-sync publish` and `ipfs-sync pull`; the old key `obsidian-vault` is not read by default (mvp-02 renamed the default key), and `--name` can pull from any name including the old key's ID. Rollback: `git revert` restores the scripts; pull leaves only vault files, `.ipfs-sync/state.json` updates, and no node state.

## Feature Operation

One process, one command: `node tools/feature-op-mvp-03.mjs`, driving the built CLI with `--config` at that stable path and the endpoint/auth from `IPFS_SYNC_*` env. Node writes happen only in step 1 and step 4 (publishes to `/obsidian-vault-sync/mvp03-demo`). The script:

1. Generates fixture vault A (N files) in a temp dir and publishes it.
2. Pulls into an absent directory B. Expect `N fetched`, marker created, every sha256 equal to A's.
3. Records file mtimes in B. Edits note X in A (text `remote`) and in B (text `local`).
4. Publishes A again (`1 written, 0 removed`).
5. Pulls into B. Expect `1 fetched, N-1 unchanged, 1 conflicts, 0 failed`; `X` holds `remote`; `X (ipfs conflict <today>).<ext>` holds `local` byte for byte (extension kept); mtimes of the other files are unchanged.
6. Runs the pull again: `0 fetched`, no new conflict.
7. Fail-closed: copies A's manifest fetched by step 2, flips one file's sha256, and pulls `--manifest-file` into fresh directory C. Expect that file absent from C, no temp file left, the other files present, `1 failed`, exit 1.
8. Restore: pulls `--manifest <currentCID of the first publish>` into fresh directory D. Expect X to hold its original text.
9. Audits every pull's request trace (`--show-request`): only name resolve, key list and gateway GETs; no mutation. Confirms afterwards with `files/ls /obsidian-vault-sync` and `key/list` that nothing outside the demo root changed.
10. Prints each result and exits nonzero on any failed assertion; reports what stayed unverified.

Key handling: the script uses the same stable config file as mvp-02's feature operation, `path.join(os.tmpdir(), 'ipfs-sync-feature-ops', 'config.json')` (outside the repo), so the key `obsidian-vault-sync` recorded there is found owned. If the key exists on the node but is not recorded in that file, the script stops with a clear message; `--owned-key <id>` remains the documented operator escape hatch, not the default path. The script does not use `IPFS_SYNC_OWNED_KEY_ID`.

## Core additions

Filled in during implementation (task 2.2 and 3.1), one line per addition: member or event name, why pull needs it, and confirmation that existing members and events are unchanged.

`src/core/host-bridge/host-bridge.ts` (`HostFs`), implemented in `cli/node-host-bridge.ts` and in the test helper `tests/helpers/memory-host.ts`:
- `HostFsLstat` type and `lstat(path)`: like `stat` but never follows a symbolic link and reports `symlink` and `other`. Pull needs it for the symlink check on the destination and every directory component (decision 8) and for the conflict-copy "name is free" probe.
- `rename(from, to)`: creates missing parents of `to`, replaces a file already there, replaces (never follows) a symbolic link at `to`. Pull needs it to commit a verified temp file and a conflict copy (decisions 6 and 7).
- `append(path, data)`: creates the file and its parents when absent, otherwise extends it. Pull needs it to stream a download into the temp file in bounded pieces (decision 7). Existing `write` replaces the whole file, so a stream cannot use it.
- Existing members `list`, `stat`, `read`, `readRange`, `write`, `mkdir`, `remove` and the `net`, `kv`, `agent`, top-level members are unchanged. `list` and `stat` still do not report or follow links as before. The mvp-02 tests pass unmodified; only the test helper gained the three members (plus `link()`, `mutations`, `failOn` for fault injection, and `stat("")` reporting the root as a directory).

`src/core/events/event-types.ts` (`SyncEventMap`):
- `pull.complete` (`PullCompleteEvent`) and `conflict` (`ConflictEvent`): payloads are paths, hashes, CIDs and counts only. `file.changed` and `publish.complete` are unchanged; pull emits `file.changed` with kind `added` or `modified`.

`src/kubo` (not `src/core`, listed here because it is a shared contract): `KuboClient.gatewayStream(cid, path?, range?)` and the types `GatewayRange` and `GatewayStream`. Read-only; existing members unchanged.

Range probe (read-only, task 2.1), against the shared gateway with a 4096-byte file published by mvp-02:
`GET /ipfs/<cid>` with `Range: bytes=100-199` answers `HTTP/2 206`, `content-range: bytes 100-199/4096`, `content-length: 100`, `accept-ranges: bytes`; the 100 bytes equal bytes 100 to 199 of the unranged response (`HTTP/2 200`, 4096 bytes). The gateway honours `Range`, so the >32 MB path uses real 8 MB ranged reads. The whole-stream fallback (200 on the first range request) is implemented and tested but is not needed on this node.

## Open Questions

- **Gateway `Range` support** on the proxy is unverified. Task 2.1 probes it read-only; the stream-and-hash fallback is accepted.
- **Full-sync meaning** (decision 10): accepted as re-verify all files under the same three-way rule; spec 011 Q5 does not define it further.
- **Harness skill folders** (for example `.minimax/skills/kubo-sync`) contain `.sh` files and are excluded from the "no .sh remains" requirement.
- **README line ranges** in task 4.2 are approximate; the documentation-specialist confirms them.
