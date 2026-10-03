---
title: Assessment, iOS crash after pull (desktop-side investigation)
phase: mvp
child: mobile-feasibility
role: ipfs-engineer
date: 2026-10-01
subject: IPFS Sync v0.2.0 (tag v0.2.0, dist/release/v0.2.0/main.js, sha256 0df084e6...)
status: not-reproduced
tags:
  - assessment
  - mobile
  - crash
---

# Assessment: iOS crash after pull (desktop-side investigation)

## Finding

**Not reproduced. It cannot be reproduced without a device.** The plugin code of v0.2.0 does nothing at load that could loop, scan the vault, hash files, listen to vault events or grow without bound. In a headless run of the real release bundle against an emulated Capacitor vault, load costs 0 adapter calls, 0 timers and 0 listeners, and a relaunch over the state the pull wrote behaves identically. I did not observe a cause. Everything below the evidence tables is hypothesis.

## The uncomfortable alternative reading

1. **The plugin's JavaScript may be innocent while v0.2.0 is still the trigger.** v0.2.0 is the first code of ours that writes files into a live iOS vault through the adapter: 98 adapter calls in about 0.4 s in the harness, 6 parallel workers, hidden-folder temp files renamed onto visible paths. A native or Obsidian-core fault reached through those writes is invisible to a Node harness. My evidence clears our logic, not our footprint.
2. **My adapter model is old and partly assumed.** I read Obsidian's `CapacitorAdapter` (class `ej`) out of the installed desktop app (`/Applications/Obsidian.app/Contents/Resources/obsidian.asar`, `app.js`, dated 2025-01-30). That build has no `appendBinary` at all, while v0.2.0 declares `minAppVersion` 1.12.3 because it needs it. The phone runs a newer adapter I have not read. Semantics I could not confirm are marked below.
3. **The data is tiny.** The five fixture files total 3,269 bytes (77 + 88 + 57 + 47 + 3000), not the "24 KB" in the brief (that is likely the DAG size). Memory exhaustion by content is implausible. If the phone crashes, it is not because the data is big.
4. **The plugin may be a bystander to a state-dependent Obsidian crash.** The persistence (every launch, airplane mode, about 2 s) fits a startup crash on vault contents, which the plugin only authored. It does not prove the plugin's code runs at that point.

## Evidence level

| Claim | Level |
|---|---|
| v0.2.0 onload is inert (no scan, listener, timer, hash) | Static (file:line) and measured in the harness |
| Pull path is bounded, no loop, no retry, no re-entry | Static and measured, against an emulated adapter |
| Relaunch over written state is benign | Measured, emulated adapter |
| The real cause of the iPhone crash | Unknown |
| Behaviour of the phone's Obsidian build and native Filesystem plugin | Not observed |

## Task 1: static trace of v0.2.0 (from the tag)

### Load (`src/plugin/index.ts`)

- `onload` (index.ts:38) runs `openSettingsStore` (index.ts:39). That is `loadData()` plus a pure parse (`settings-migration.ts:98-114`). A write-back happens only for legacy data (`persist: true` only at settings-migration.ts:86). A normal load touches the vault with zero adapter calls.
- It builds the runners, creates a status bar item (index.ts:46), registers three commands, two ribbons and the settings tab, then `rearmAutoPublish()` (index.ts:60) and `scheduleCatchUp(...)` (index.ts:61).
- **Timers:** `rearmAutoPublish` returns at index.ts:74 when `publishIntervalMinutes <= 0`. The default is 0 (settings-model.ts:95). Even when enabled, the first run is N minutes later (index.ts:75), never 2 s.
- **Catch-up:** `scheduleCatchUp` returns at catch-up.ts:17 unless `catchUpOnLoad` is true. The default is false (settings-model.ts:97). When true it runs one quiet pull in `onLayoutReady` (catch-up.ts:18-19).
- **Listeners:** the release bundle contains no `registerEvent` (0 matches), no `vault.on` (0), no `metadataCache` (0), no `MutationObserver` (0). There is no per-event handler, so no create/modify event storm can re-enter the plugin, and the pull cannot trigger publish or a watcher. Remaining `addEventListener` hits (7) are settings-tab inputs, built only when the tab opens.
- **Settings tab:** `display()` builds the DOM and `KeysSection.render` fires one `key/list` (settings-tab-keys.ts, `refresh`). A pull-name edit commits on `change`, not per keystroke (settings-tab-controls.ts, `addTextField`), then `vm.edit` -> `store.update` -> one `saveData`. No loop.

### Pull, in order (`pull-runner.ts`, `pull.ts`, `pull-fetch.ts`, `obsidian-fs.ts`)

Lock acquired (shared, in-memory), then `prepare()`:

1. `assertVaultPullDestination` (pull-runner.ts:148): `stat("")` (synthetic, no adapter call), `lstat .ipfs-sync`, `lstat .ipfs-sync/tmp` (these are `adapter.stat`), `stat .ipfs-sync-fixture`, then `firstNoteFile` = `adapter.list("/")` plus `adapter.stat` per entry, skipping `.obsidian` and `.ipfs-sync` (pull-guard.ts:32-45). This is exactly what the empty-name run did on the phone ("no pull target" notice), so these calls are device-proven.
2. `flushEditors` (pull-runner.ts:151): `workspace.iterateAllLeaves`, and for each `TextFileView` an `adapter.readBinary` plus a conditional `view.save()` (editor-flush.ts).
3. Empty pull name: `key/list` (RPC). Set pull name: skipped, so the second run issues no RPC except `name/resolve`.

Then `pullVault` (pull.ts:233):

4. Destination guard again; `readState` = `stat` (and `readBinary` if present) of `.ipfs-sync/state.json`.
5. `name/resolve` (RPC, `nocache=true`), `GET manifest.json` via `requestUrl`.
6. `writeFixtureMarker` (pull.ts:241): `writeBinary .ipfs-sync-fixture` (39 B). **First vault write.**
7. `sweepTemp` (pull.ts:242): `stat .ipfs-sync/tmp`; lists and removes leftovers only if the directory exists.
8. `planPull`: per manifest path, `stat` ×2-3 (symlink walk over each prefix, then the file); hashes a local file only when one exists.
9. Fetch with a pool of 6 (pool.ts:3). Per file: `stat` the temp dir, `ensureDirectory` (`stat`/`mkdir` per level), `writeBinary <uuid>.part` with 0 bytes (pull-fetch.ts:104), `appendBinary` of the whole body (pull-fetch.ts:121), `stat` parents of the destination and `mkdir` them, `rename` the temp onto the destination (pull-fetch.ts:166), `stat` the destination for its mtime.
10. `writeBinary .ipfs-sync/state.json` (about 1.8 KB), then `saveData` for `lastPull`.

On-disk artifacts left behind: `.ipfs-sync-fixture`, `.ipfs-sync/state.json`, `.ipfs-sync/tmp/` (empty after a clean pull; `.part` files of 0 B or partial body if the process died mid-pull), the five notes under `notes/` and the root, and `data.json` with the pull name and `lastPull`. There is no journal file in v0.2.0 and no lock file (the lock is an in-memory object, sync-lock.ts).

### Capacitor versus desktop differences considered

| Difference (source) | v0.2.0 behaviour | Verdict |
|---|---|---|
| `rename` onto an existing path throws "Destination file already exists!" (app.js `ej.rename`) | `obsidian-fs.ts:122-128` removes an existing file target first, then renames | Handled. The replace path was not exercised (empty vault). |
| `rename` where the source is untracked (hidden `.ipfs-sync/tmp/*`): the old adapter returns early without reconciling the destination (`if(!r) return`) | Every pulled file arrives this way | Only the native watcher or the next launch's `watchAndStatAll` registers them. Inconsistent, not a loop. Phone build unknown. |
| `stat` of a missing path: null only if the native message matches "does not exist" or "there is no such file" | Plugin treats null as missing | Device-proven by the first run's guard (lstat of a missing `.ipfs-sync`). |
| `mkdir` of an existing folder is swallowed only for the message "Directory exists" | Harness shows 4 racing `mkdir .ipfs-sync` and 5 `mkdir .ipfs-sync/tmp` from the 6 workers (`ensureDirectory` is check-then-create, obsidian-fs.ts:80) | Redundant and racy. A different native message would fail files, not crash. |
| `list` returns vault paths, includes dot entries | Plugin skips app folders by name | Fine. |
| `appendBinary` exists only in Obsidian 1.12.3 and newer | `minAppVersion` 1.12.3 | Absent in the desktop app I read; a missing method would give per-file failures, not a crash. |
| Hidden paths fire only a `raw` event in Obsidian's reconcile (`Zc` = any dot segment) | Temp files and state live in dot folders | In the harness 19 of 26 reconcile events were hidden. Fine. |

## Task 2: headless reproduction

Throwaway harness in the scratch dir, outside the repo (`/private/tmp/claude-501/-Users-gqadonis-obsidian--ipfs-sync/649e61e6-bc8a-42a6-89a8-c16e83bbae4a/scratchpad/crash-repro/`):

- `harness/run.mjs`: loads `dist/release/v0.2.0/main.js` (copy, sha256 verified against `SHA256SUMS`) with a stubbed `obsidian` module (`harness/node_modules/obsidian/index.js`) and drives `onload`, `pullVault`, the settings view model and relaunches.
- `harness/cap-adapter.mjs`: in-memory vault with a serial queue, parent-must-exist writes, rename-onto-existing throws, `stat` null on missing, dot-path reconcile semantics, a hard cap of 20,000 adapter calls and 2,000 timers, and a watchdog of 90 s per scenario.
- Network: only `GET /ipfs/...` is real. `name/resolve` is served from one recorded real response (`fixture/resolve.body`, taken once with a POST to the node's read-only `name/resolve`). `key/list` is a stub (`{"Keys":[]}`). Anything else is blocked and logged. Nothing was published or written to the node.
- Re-run: `cd .../harness && node run.mjs v020 v020 && node ../summarize.mjs ../results-v020.json`.

### v0.2.0 results (`results-v020.json`)

| Scenario | Adapter calls | Notable |
|---|---|---|
| A. first launch, empty vault, settle 3 s | 0 | 0 timers, 0 listeners, 0 `saveData`, 5.4 ms CPU for require + onload |
| B. pull, empty pull name | 4 (3 stat, 1 list) | "no pull target" notice, as on the phone |
| C. set pull name through the view model | 0 | 1 `saveData`, no errors |
| D. pull with the k51 name | 98 (68 stat, 11 mkdir, 7 writeBinary, 5 appendBinary, 5 rename, 2 list) | 5 fetched, 0 failed, 374 ms, 12 progress notices, no exception |
| E, F. relaunch ×2, settle 5 s each | 0 | no timers from the plugin (the one timer seen is Node's HTTP client) |
| G. second pull over existing state | 23 | 5 unchanged, 0 fetched |
| H. `catchUpOnLoad` on, relaunch, settle 6 s | 23 | one catch-up pull, no loop, 1 `name/resolve` and 1 manifest GET |
| I, J. airplane mode, catch-up and manual | 9 | one "cannot reach the rpc endpoint" notice, no retry, no loop |
| K3, K8, K14. process dies after 3/8/14 mutations, then airplane relaunch with catch-up | 51-77 | leaves `.ipfs-sync/tmp/*.part` (0 B) after K14; the relaunch fails fast with the same notice |

Across all scenarios: 0 uncaught exceptions or unhandled rejections, the cap and watchdog never fired, the pull's reconcile events are bounded at 26 (7 visible creates), `registerEvent` 0, `vault.on` 0, and the vault tree after the pull is `.ipfs-sync-fixture`, `.ipfs-sync/state.json`, `.ipfs-sync/tmp/` (empty), `Welcome.md`, `Second note.md`, `notes/Third.md`, `notes/range-test.txt`, `notes/nested/Deep note.md`, `data.json`.

### Repo HEAD (labelled HEAD, uncommitted working tree at cebc71c, not v0.2.0)

Built with esbuild into the scratch dir only. HEAD refuses the plaintext fixture ("the node serves a plaintext (version 1) manifest ... Nothing was written to your vault"), so the write path cannot be compared. Launch: 1 `stat` of a keyslots file at load, 0 timers, 0 listeners, relaunch benign, airplane catch-up fails fast. This says nothing about the v0.2.0 write path.

## Ranked hypotheses (none observed)

1. **Obsidian core or native layer faults on vault contents at startup indexing; the plugin's code is not running at that moment.** Fits: persistence, airplane mode, about 2 s after launch (the vault is indexed natively at start, per the old bundle's `watchAndStatAll`). Candidate artifacts, in order: `.ipfs-sync/tmp/*.part` leftovers (if the original crash was mid-pull), `.ipfs-sync/state.json` and `.ipfs-sync-fixture`, the pulled notes, `data.json`. Evidence: only negative (the plugin has nothing running at load). Confidence: low-moderate.
2. **The device has `catchUpOnLoad` on (or a publish interval set).** The only plugin code that starts by itself after launch is the layout-ready catch-up (catch-up.ts:18-19), and its timing, about one to two seconds after launch, matches. Pre-network steps in airplane mode are `stat`, `list`, `readBinary` of the state file and the editor flush (9 calls in the harness, no loop). Default is false and the brief says so, so this is only relevant if the operator changed it while setting the pull name. Cheap to ask.
3. **The original crash was in the pull's write burst on the native bridge** (6 workers, about 98 adapter calls in under half a second, five simultaneous 0-byte `.part` writes, 9 redundant `mkdir`s, hidden-to-visible renames). A mid-pull death would leave partial state that hypothesis 1 then trips over. Plausible, unverified, and it explains the persistence only in combination with 1.
4. **Rejected in emulation:** load-time loop, runaway timer or interval, vault create/modify event storm re-entering the plugin, unbounded memory growth, a retry loop, a pull that triggers publish. Not rejected on device.

## What would settle it (no code)

- The iOS crash log: Settings > Privacy & Security > Analytics & Improvements > Analytics Data > `Obsidian-...ips`. Exception type separates a native fault (`EXC_BAD_ACCESS`/`SIGABRT`) from memory (jetsam) from a hang (`0x8badf00d` watchdog). This is the single most valuable artifact.
- Was "pull on load" or a publish interval switched on? What is the Obsidian iOS version?
- Does another or a new vault open on the phone? If it does, the trigger is in the vault, not the app.
- Bisect from the Files app: dot folders are hidden there, so delete the visible pulled notes first. If the crash persists, the trigger is in the hidden state or in `data.json`. If the vault lives in iCloud Drive, the Mac can see `.ipfs-sync/` and `.obsidian/plugins/ipfs-sync/data.json`.

## Candidate fix directions (untested, not proposed for implementation here)

Add a write-ahead sentinel under the plugin folder that a pull sets before the first write and clears at the end, so a launch that finds it stale skips catch-up and offers cleanup instead of repeating the work; lower pull concurrency to 1-2 on mobile and create parent directories once per pull; write visible files through the vault API or a temp name in a visible folder so Obsidian registers them itself; add a documented off-switch that does not need the settings tab.

## Process notes

- Role: ipfs-engineer, investigation only. No repo source, config or test was changed, nothing committed or published, `.prometheus/.writer.lock` untouched, no Obsidian app config touched, no GUI launch. The harness, the extracted Obsidian `app.js`, the HEAD bundle and all results live in the scratch dir.
- Extracting `app.js` from the installed `obsidian.asar` was a read-only parse by a Node script in the scratch dir. The desktop app version there (about 1.8.x) is older than the phone's.
- Network use: GET requests to the gateway (manifest, five files, directory page) and one POST to read-only `name/resolve`. No writes to the node.
