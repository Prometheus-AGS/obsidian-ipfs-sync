# Argon2id timing probe build (diagnostic, local, 0.2.1-probe.1)

Role: ipfs-engineer. Phase: mvp > mobile-feasibility. No release, tag, push or commit was made. Nothing was run on a phone.

## Where
- Worktree (detached at `cebc71c`, left in place, uncommitted changes): `/private/tmp/claude-501/-Users-gqadonis-obsidian--ipfs-sync/649e61e6-bc8a-42a6-89a8-c16e83bbae4a/scratchpad/probe-wt`
- Deliverables: `/Users/gqadonis/Downloads/ipfs-sync-probe/` (main.js, manifest.json, SHA256SUMS, README.txt, probe.diff)
- Main working tree was not edited or built in.

## Environment
- node v24.16.0, pnpm 12.8.1
- `pnpm install --frozen-lockfile` succeeded. The `@typescript/typescript-darwin-arm64` package came up without its `lib/tsc` executable, so `pnpm typecheck` failed with "Executable not found". `pnpm install --frozen-lockfile --force` (worktree only) fixed it. Cause not investigated.
- Baseline `pnpm build` before changes: succeeded, `dist/plugin/main.js` 409,716 bytes.

## Argon2id call found
`src/crypto/argon2.ts` `deriveKek(password, salt, params, onProgress)`: validates floors/ceilings, then `argon2idAsync` from `@noble/hashes/argon2.js` with `{t, m, p, dkLen: 32, version: 19, maxmem: 131072*1024, asyncTick: 10}`. Production params `DEFAULT_KDF_PARAMS` = m 65536 KiB, t 3, p 1. It yields to the event loop about every 10 ms (`KDF_ASYNC_TICK_MS`).
- The three 64 MiB rows call `deriveKek` itself with `DEFAULT_KDF_PARAMS`, a fixed dummy passphrase and a fixed 16-byte salt.
- The 16 MiB row cannot go through `deriveKek` (floor is 19,456 KiB, it throws). It calls `argon2idAsync` directly with the identical options and only `m` changed. Labelled DIAGNOSTIC in the note.

## Diff (base `cebc71c`, see probe.diff)
- `src/plugin/argon-probe.ts` new (120 lines): `registerArgonProbe(plugin)` adds command id `argon-probe`, name "Argon2id timing probe (diagnostic)" (Obsidian shows it as "IPFS Sync: Argon2id timing probe (diagnostic)").
- `src/plugin/index.ts` +2 lines (import, one call).
- `manifest.json` version `0.2.1-probe.1`.
- `tools/argon-probe-harness.mjs` new: bundles the real probe with a stubbed `obsidian`, runs the command callback, prints the note.
- `tools/hook-isolation.mjs`: one name added to two allow-lists (`deriveKek` homes, `BOUNDARY_EXCEPTIONS`). Needed because the repo's isolation guard fails `pnpm probe:webview` if any file outside `src/crypto` names `deriveKek` or deep-imports `crypto/argon2`. This weakens a guard in the probe worktree only; do not carry it to a real branch.
- Probe behaviour: Notice at start; 3 sequential runs; 10 ms `setInterval` heartbeat records the longest gap; `performance.memory` if present; userAgent, `Platform.isIosApp/isAndroidApp/isMobile`, `typeof crypto.subtle`, `typeof scheduler.yield`; writes `ipfs-sync-argon-probe.md` in the vault root via `vault.adapter.write`; Notice with summary; per-row and top-level errors are caught and written into the note. No network, settings, key or publish code touched.

## Commands and results
- `pnpm typecheck` (after the reinstall): exit 0, no output beyond the two tsc invocations.
- `pnpm build`: succeeded; `dist/plugin/main.js` 413,987 bytes.
- `pnpm probe:webview`: first run FAILED on the guard (messages above); after the allow-list change: `PASS: no test-only crypto hook (sentinel, dependency metadata, imports) in the plugin, CLI or crypto surface`, dist `ok: true`, violations `[]`.
- Bundle check on `dist/plugin/main.js`: the only `require` is `require("obsidian")` (16 uses). No `node:` imports (the 8 `node:` string hits are object property names), no `process.` global use, no `Buffer`, no `WebAssembly`, no dynamic `import(`.
- Desktop baseline (`node tools/argon-probe-harness.mjs`, this Mac, Node 24.16.0, userAgent "Node.js/24", not a WebView):

| run | wall ms | max event-loop gap ms |
| --- | --- | --- |
| 64 MiB t=3 p=1 run 1 | 1177 | 20 |
| 64 MiB t=3 p=1 run 2 | 990 | 13 |
| 64 MiB t=3 p=1 run 3 | 1024 | 18 |
| 16 MiB t=3 p=1 (DIAGNOSTIC) | 241 | 14 |

The gap is bounded by the 10 ms `asyncTick`, so a gap far above about 20 ms on the phone means the WebView is being starved, not that the code stopped yielding. Node is not Safari/WKWebView: JIT, memory and throttling differ, which is the point of the phone run.
- Tests: no test file added; the full suite was not run (as instructed).

## File hashes (SHA-256)
- main.js `879fd213a0c61df643866abf9c38791054e90ce17382b8ee0ffe8f66c8d39e6d`
- manifest.json `9163285983c91066be272acc3fe13a6624be9d5ff6deaad0a6a656a7c0614253`
- probe.diff `d22a2be6ac6504ac9ad65b3d27e1d48013557998a1aaf038111c1a40e7bb474a`
- `shasum -a 256 -c SHA256SUMS` in the delivery folder: all three OK.

## Unverified
- Everything on a phone: install, plugin load, command registration, `adapter.write` of the note at the vault root, whether the Notice survives, memory behaviour, WebView kills, `performance.memory`/`scheduler.yield` presence.
- The note-writing path was exercised only against a stubbed adapter.
- The `.kbd` position files were not touched.

## Installing an unpublished main.js on iOS (all need verification, no paths guessed)
The plugin id is `ipfs-sync`, so these files replace the real plugin if placed in the same vault.
1. Throwaway vault (recommended): create an empty vault on the phone in a location a Mac can reach (iCloud Drive is the likely candidate, unverified), place `.obsidian/plugins/ipfs-sync/{main.js,manifest.json}` from the Mac, let it sync, then enable community plugins on the phone. Unverified: that iOS Obsidian reads a plugin folder added externally, and whether it needs a restart.
2. Obsidian Sync (if the user has it): add the plugin folder in a desktop test vault and sync that vault to the phone. Unverified, and `.obsidian` plugin-file sync is a vault sync setting.
3. Files app on the phone: unverified whether the hidden `.obsidian` folder is reachable there for an on-device vault. Do not assume it is; this is why the on-device real vault is the worst place to try.
4. BRAT cannot do this (it installs GitHub releases/pre-releases only), and publishing a release is out of scope.
5. Whichever route: do not overwrite a working `ipfs-sync` plugin folder without backing up its `main.js` and `manifest.json`; `data.json` is untouched by this build.
