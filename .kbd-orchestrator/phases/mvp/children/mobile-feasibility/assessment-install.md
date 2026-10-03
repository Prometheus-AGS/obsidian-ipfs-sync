# Assessment: getting IPFS Sync onto a real iPhone and a real Android phone

Child: `mvp › mobile-feasibility`, stage: assess. Role: release-deployment-lead. Date: 2026-10-01.
Scope of this document: research only. No source, config, package, tag, release or workflow run was touched. Nothing was built.
Every command in sections 4 to 6 is a command to run later; none was run for this document.

## 0. Lead: shortest verified path, and what can block it

### Shortest path to a running phone install (zero build, zero new outward action)

1. On the phone, update Obsidian to 1.12.3 or later (`minAppVersion`; the plugin uses `adapter.appendBinary`). Settings, About shows the version.
2. Create a NEW, EMPTY vault on the phone (do not use a vault with notes). On iOS choose a local vault, not iCloud (see 1.3).
3. Settings, Community plugins, Turn on community plugins (turns Restricted mode off), Browse, install and enable **BRAT**.
4. Command palette: **BRAT: Add a beta plugin for testing**, enter `Prometheus-AGS/obsidian-ipfs-sync`, Add Plugin. For a pinned tag use **BRAT: Add a beta plugin with frozen version based on a release tag** with `v0.2.0`.
5. Settings, Community plugins, refresh the list, enable **IPFS Sync**.

This installs release **v0.2.0**, which exists today as a public pre-release with `main.js`, `manifest.json`, `SHA256SUMS` and the CLI tarball (confirmed with `gh release view`: `isPrerelease: true`, repo `PUBLIC`).
BRAT picks pre-releases (quoted in 1.1). `styles.css` is not required (the build makes none; BRAT guide: "and, if needed, `styles.css`").

### The uncomfortable thing

**There is no build, shipped or buildable, that does what the operator wants on a phone: encrypted sync of real notes between devices.** Four separate facts, all read in this session:

1. **v0.2.0 (the BRAT-installable one) is plaintext and fixture-only.** Its own release notes: "This release must not be used on real notes ... no encryption: everything it publishes to your kubo node is readable by anyone who obtains the CID." Its plugin refuses any vault without a `.ipfs-sync-fixture` marker holding `fixture` (for publish) and "Mobile is not verified."
2. **HEAD (`cebc71c`, mvp-06) has encryption (Argon2id) but cannot pull on any device.** `src/sync/pull-screen.ts` at HEAD throws `EncryptedVaultError` for an encrypted root and `PlaintextV1RefusedError` for a plaintext root unless `allowPlaintextV1` is set, and that seam is set only by tests (`src/plugin/plugin-seams.ts`). `docs/operator/encrypted-vault.md`: "Pulling an encrypted vault does not exist yet." So a HEAD build on a phone can set up, unlock and publish, and nothing can pull it. The phone-to-phone or phone-to-desktop encrypted round trip is exactly 07a, which is uncommitted and mid-flight.
3. **A phone cannot easily be a publisher with the HEAD build.** Publish requires `.ipfs-sync-fixture` (a dotfile) containing `fixture` at the vault root. I found no Obsidian doc that lets you create a dotfile from the mobile UI (could not confirm either way; treat as not possible). The marker has to be put in the vault from a computer. Pull in an empty vault writes its own marker, so a phone can be a pull-only device, but only with the v0.2.0 plaintext reader.
4. **The shared node is still open-write** (README security banner) and has no auth exercised from a plugin ("An authenticated kubo endpoint with the plugin" is on the unverified list). Putting a bearer token into the phone's plugin settings stores it in plaintext in `data.json`.

Consequence: what is achievable now is a **feasibility test with a fixture vault**, not "start syncing my notes". Two test builds are needed to cover both halves, see section 2.2.

### Second thing that bites

`dist/plugin/main.js` on disk is **stale**. It was built 2026-09-30 09:13, before the mvp-06 commit (09:49), and `git status` shows 120 modified files (07a work in progress, one deleted file). Its SHA-256 is `9a33fc20...` and matches no release. Do not copy it to a phone. Build from a clean `git worktree` at an explicit commit, and record that commit.

## 1. Verified step-by-step install routes

### 1.1 BRAT (works on both OSes, no hidden-folder access)

Sources read: `BRAT-DEVELOPER-GUIDE.md` (raw.githubusercontent.com/TfTHacker/obsidian42-brat/main), `tfthacker.com/brat-quick-guide`, `tfthacker.com/brat-plugins`, BRAT `manifest.json` (v2.2.0, `minAppVersion` 1.11.4, `isDesktopOnly: false`).

| Question | Answer | Evidence |
|---|---|---|
| Does BRAT run on mobile? | Its manifest says `isDesktopOnly: false`. A phone run is not documented in what I read: could not confirm beyond the manifest | BRAT manifest.json |
| Accepts a pre-release? | Yes | Dev guide: "For latest version: Download the latest available release or pre-release, prioritizing by semantic version number"; "Optionally mark it as a pre-release" |
| A specific tag? | Yes, "frozen" install, "regardless of whether it's marked as a pre-release" | Dev guide; quick guide command "Add a beta plugin with frozen version based on a release tag" |
| Needs `styles.css`? | No | Dev guide: "Include the `manifest.json`, `main.js`, and, if needed, `styles.css`, in the release assets" |
| Which files does it download? | `manifest.json`, `main.js`, `styles.css` from release assets | Dev guide "How BRAT works" |
| Tag vs manifest version | BRAT uses the release tag as truth, overrides `manifest.json` version, shows a notification on mismatch. Obsidian itself wants tag, release name and manifest version identical | Dev guide |
| Rate limit | 60 GitHub API requests per hour unauthenticated; irrelevant for a public repo and a few installs | Dev guide |
| `v` prefix | The existing release tag is `v0.2.0` while the manifest says `0.2.0`. Whether BRAT normalises the `v` is stated as "will attempt to normalize non-standard version strings using the semver library"; the first install is the test. A new tag should be `0.2.1-phone.1` style without `v` to match Obsidian's rule | Dev guide (semver coercion), not tested |
| Updates | BRAT command "Check for updates to all beta plugins and UPDATE"; optional auto-update at start | Quick guide |
| Obsidian will not auto-pick `X.Y.Z` after `X.Y.Z-pre.N` | A pre-release installed by BRAT must be updated through BRAT | Dev guide semver table |

Steps are in section 0. After BRAT writes the files, Community plugins must be refreshed and the plugin enabled; the help page lists a refresh icon "to reload all plugins" (obsidian.md/help/community-plugins).
Restricted mode is the default and must be turned off: "Select Turn on community plugins" (obsidian.md/help/plugin-security).

### 1.2 Manual copy

Target folder in the vault: `<vault>/.obsidian/plugins/ipfs-sync/` containing `main.js` and `manifest.json` (and nothing else is needed). The folder name must equal the manifest `id`, `ipfs-sync`.
Obsidian's `.obsidian` config folder is hidden by default on most OSes (help: "By default, most operating systems hide folders that start with a period"; the page lists only macOS, Windows, Linux).

| Platform | Route | Status |
|---|---|---|
| **iOS, vault in iCloud** | Copy from a Mac into the vault's `.obsidian/plugins/ipfs-sync/` inside the Obsidian iCloud container, with hidden files shown in Finder (`Cmd+Shift+.`, confirmed for macOS in obsidian.md/help/data-storage). The exact container path on disk is not in the Obsidian docs I could retrieve: **could not confirm**. Trade-off: the vault folder includes `.ipfs-sync/` which holds plaintext file paths; the operator runbook says to keep it out of iCloud. Acceptable for a fixture vault only | Mac side unconfirmed path; do not use for real notes |
| **iOS, local ("On My iPhone") vault** | Files app can reach app folders, but whether it shows `.obsidian` (a dotfile) is **could not confirm**. Use BRAT instead | Not recommended |
| **Android, "Device storage"** | Official: "your data is stored in a shared location on your device. This allows your Obsidian vault to be accessed by other apps ... requires 'All files' access" (obsidian.md/help/android). Exact path: **could not confirm** from docs. A USB push from a computer (`adb push main.js <vault>/.obsidian/plugins/ipfs-sync/`) avoids the file manager's hidden-file toggle; that is general Android practice, not verified here. Enable USB debugging first (same setting the inspect route needs, 1.4) | Plausible; adb path unverified |
| **Android, "App storage"** | Official: private app storage, "isolated from other apps". A computer or another app cannot write into it. Manual copy impossible; use BRAT or a vault on Device storage | Confirmed by docs |
| Obsidian Sync | Plugins sync only if "Active community plugin list" and "Installed community plugin list" are enabled in Sync settings (obsidian.md/help/sync/settings) | Possible; not tested; adds a paid dependency |

The iOS help page (obsidian.md/help/ios) covers widgets, Shortcuts, Share Sheet, Siri and Spotlight. It says nothing about vault location or hidden folders. Do not claim otherwise.

### 1.3 Vault choice on the phone (affects safety, not loading)

- Use an empty throwaway vault. A pull into an empty destination works without a marker and the plugin writes `.ipfs-sync-fixture` = `pulled-fixture` itself (README, "The fixture marker"). A non-empty vault without the marker is refused.
- Keep the vault out of iCloud on iOS (state files hold plaintext paths).
- Android: choose Device storage if you want adb or a file manager; choose App storage if you want isolation and are using BRAT.

### 1.4 Developer routes

Source: docs.obsidian.md/Plugins/Getting+started/Mobile+development (read in full).

- **Emulate mobile on desktop**: Developer Tools (`Ctrl/Cmd+Shift+I`), Console tab, run `this.app.emulateMobile(true)`; off with `this.app.emulateMobile(false)`; toggle with `this.app.emulateMobile(!this.app.isMobile)`.
- **Android**: enable USB Debugging in Developer options, connect by USB, open `chrome://inspect#devices` in a Chromium browser on the computer, make sure "Discover USB devices" is on, accept the debugging prompt on the phone (developer.chrome.com/docs/devtools/remote-debugging). Obsidian's page says the Obsidian WebView then appears and gives the usual DevTools.
- **iOS**: "an iOS device running 16.4 or later and a macOS based computer", set up per webkit.org/web-inspector/enabling-web-inspector. Mac side confirmed from that page: Safari, Settings, Advanced, "Show features for web developers", then the device name appears in the Develop menu once Web Inspector is enabled on the device and it is connected by cable or Xcode wireless debugging. The exact iPhone settings path was cut off in the text I retrieved: **could not confirm**; commonly Settings, Safari, Advanced, Web Inspector.
- **In-app console on the phone**: the Obsidian docs describe only remote inspection. Could not confirm any built-in mobile console.
- `Platform.isIosApp` / `Platform.isAndroidApp` exist (same page). The plugin does not use `Platform` (grep of the built bundle: no match for `Platform.` or `isMobile`).

## 2. Minimum artifact set, and is `pnpm build` output enough

### 2.1 Findings

- `pnpm build` runs `node esbuild.config.mjs production`. It writes `dist/plugin/main.js` and copies `manifest.json` next to it, and builds the CLI to `dist/cli/ipfs-sync.mjs` (`esbuild.options.mjs`: plugin entry `src/main.ts`, `format: cjs`, `target: es2022`, `external: ["obsidian","electron", ...builtins]`, no sourcemap in production).
- Minimum plugin set Obsidian and BRAT need: **`main.js` + `manifest.json`**. `styles.css` is optional and the build produces none. So `dist/plugin/` is the right and sufficient output shape. 
- For BRAT add a GitHub release whose tag equals the manifest `version` and whose assets include those two files. `SHA256SUMS` is not read by BRAT; it is for the human who verifies.
- Existing v0.2.0 assets (from `gh release view`): `main.js` 173,902 bytes sha256 `0df084e6...`, `manifest.json` 308 bytes `147ab4c0...`, `ipfs-sync-cli-0.2.0.tgz` 31,993 bytes `1adfa714...`, `SHA256SUMS` 244 bytes `56729b4b...`. Local `dist/release/v0.2.0/` matches those hashes.
- The CLI tarball holds only `package/dist/cli/ipfs-sync.mjs` (tar listing), no `package.json`. It is **not** installable with `npm install`. Extract it and run `node package/dist/cli/ipfs-sync.mjs` (Node 24 required by `engines`).
- Current bundle: 409,716 bytes (about 2.4 times v0.2.0), because it carries `@noble/hashes` and the crypto layer. I found no Obsidian-documented plugin size limit: could not confirm one; 0.4 MB is small by any common measure.

### 2.2 Two test builds are needed

| Build | Source | What it can test on a phone | What it cannot |
|---|---|---|---|
| **A: v0.2.0** | Existing public pre-release, install by BRAT | Loads, settings tab, `requestUrl` transport, CORS behaviour, Range probe, large-file pull, background/foreground, unlock-free **plaintext** publish and pull round trip between phone and desktop CLI v0.2.0 | No Argon2id, no encryption. Plaintext fixture goes to the shared node and is public by CID |
| **B: HEAD `cebc71c`** (mvp-06) built from a clean worktree | Needs a pre-release or a manual copy | Loads, setup and unlock dialogs, **Argon2id timing and memory**, WebCrypto HKDF/HMAC/AES-GCM, encrypted publish from a phone | Cannot pull any root. Needs the marker file placed from a computer. Pull of an encrypted vault is 07a |

Build A for the v0.2.0 plaintext round trip needs a **fresh MFS root and a fresh IPNS key name** and the v0.2.0 CLI. Do not reuse `obsidian-vault-sync`: README records that the mvp-06 runs repointed that key to an encrypted root, which the v0.2.0 reader cannot read.

### 2.3 What a phone-test pre-release needs (planning only, no action taken)

- **Version**: a distinct semver pre-release, for example `0.2.1-phone.1`. Tag, release name and `manifest.json` `version` identical, and no leading `v`, per Obsidian's rule quoted in the BRAT guide. Bump `package.json` too only if the release tooling reads it. Without a distinct version the phone shows "0.2.0" for both builds and you cannot tell which is running.
- **Do not commit the version bump to `main`**: BRAT guide: "you should not commit the change of the version number in `manifest.json` to your default branch yet" (otherwise Obsidian offers it as an update). Build the release from a worktree or a branch.
- **Files**: `main.js`, `manifest.json` (bumped copy), `SHA256SUMS`. Optionally `release-notes.md` with the fixture-only statement and "Mobile is being tested". Mark `--prerelease`.
- **Provenance**: record commit hash, `node --version`, `pnpm --version`, and the SHA-256 of each file in the notes. Build in a clean worktree with `pnpm install --frozen-lockfile`.
- **Tooling gap (blocking for B)**: `tools/release/constants.mjs` hard-codes `VERSION = "0.2.0"`, and `plan.mjs` `blockers()` fails when tag `v0.2.0` exists, when the mvp-05 feature-operation record is not "passing", and wants the fixture statement in README and CHANGELOG. The tool as written cannot produce a second release. Either parameterise the version (a change to `tools/release/`, not made here) or assemble the three files by hand for the phone pre-release. This is a decision for the execute stage.
- **Outward steps, each needing the operator's approval for that exact action, none taken**: create the git tag, push, `gh release create --prerelease` with the assets. The existing `tools/release/steps.mjs` already prints these as NOT RUN commands.
- **Alternative with no outward action at all**: AirDrop, USB or a cloud drive to the phone for B. Works for Android with adb and for iOS only through the iCloud vault route in 1.2.

## 3. Zero-hardware first smoke test: Obsidian desktop mobile emulation

Steps (official, 1.4): open a throwaway fixture vault on desktop with the plugin enabled, open DevTools Console, run `this.app.emulateMobile(true)`, then re-open the settings tab and run commands from the palette.
Do it in a vault that is not your real vault. The `OBSIDIAN_PLUGIN_DIR` dev loop in the README overwrites plugin files in whatever directory it points at.

### What emulation proves

- The plugin loads and unloads with `app.isMobile` true. The plugin has no `Platform` branches, so no code path changes; this mostly confirms no desktop-only API is used at load.
- The settings tab, dialogs (setup, unlock, abandon, pull confirmation) lay out and are operable at a phone-sized viewport and with touch-like input (resize the window, use the device toolbar in DevTools).
- No Node or Electron global is touched while `isMobile` is true. Cross-check with the static grep result in 6.1.
- Notices and status-bar text fit.

### What emulation does NOT prove

| Device-only fact | Why desktop emulation cannot show it |
|---|---|
| JS engine and WebView | Desktop is Electron Chromium (V8). iPhone is WKWebView (JavaScriptCore). Android is system WebView. Timing and feature availability differ |
| Argon2id time and memory | Desktop CPU and RAM are many times a phone's; Chromium has `scheduler.yield`, which `@noble/hashes` 2.4.0 `nextTick` uses when present, otherwise `setTimeout(0)` (read in `node_modules/@noble/hashes/utils.js`). WKWebView may take the `setTimeout` branch, whose 4 ms clamp after nesting adds overhead per 10 ms slice. Desktop timing flatters |
| Memory limits | A desktop renderer has gigabytes; iOS terminates a WebView content process that grows too much (jetsam), Android kills by low-memory policy. A 64 MiB Argon2id block plus a few 64 MB file copies is the risk |
| `requestUrl` implementation | Desktop uses Electron's network stack. Mobile uses Obsidian's mobile bridge (Capacitor). Header handling (`Range`, `Content-Range`, `Origin`), binary body size and base64 bridging are device behaviour. Obsidian documents `requestUrl` as "Similar to fetch(), request a URL using HTTP/HTTPS, without any CORS restrictions" (docs.obsidian.md requestUrl) and says nothing on size or Range |
| File adapter | Desktop `FileSystemAdapter` (Node `fs`) vs mobile `CapacitorAdapter`. `appendBinary`, `rename` over an existing file (`adapter-lock-file.ts` says "not known to refuse an existing target on every platform (unverified in Obsidian)"), `list` on dot-folders, `stat` of a symlink are all adapter-level |
| App lifecycle | Desktop emulation never suspends. iOS suspends the app off-screen (DESIGN section 2); timers stop |
| Secure context | `crypto.subtle` and `crypto.randomUUID` need a secure context. The mobile origin differs from desktop `app://obsidian.md`. Could not confirm availability on either mobile WebView |
| Origin handling by the node | Desktop sends `app://obsidian.md`; README quirk 4: the node answers that origin with 403 and no CORS headers. The mobile origin is something else (could not confirm what `requestUrl` sends). The reverse proxy might 403 it too |

Verdict: it is a free, necessary, low-value smoke test. It catches a layout or load regression in five minutes and settles none of the five questions the goals ask.

## 4. Device test plan

Run order matters: cheap and reversible first, memory-heavy last. Record every row in a table with: date, device model, OS version, Obsidian version, plugin build (tag and `main.js` SHA-256), network (Wi-Fi or cellular), result, numbers, evidence file name.

Pass thresholds are the project's own (DESIGN section 8): Argon2id derivation under **3 s** wall time with the largest event-loop gap under **100 ms** (recorded on an Apple M1 Max: about 0.84 s and 16 ms; not reproduced on a phone).

### 4.0 Desktop pre-checks (no phone, read-only against the operator's node)

Not run for this document. Operator-approved read requests only.

1. Range: `curl -s -D - -o /dev/null -H 'Range: bytes=0-0' "<gateway>/ipfs/<cid-of-a-fixture-file>"` expects `206` and a `Content-Range` header. A `200` means the gateway ignores Range and 07a's ranged source will refuse large files (`gateway-ignored-range`, `src/sync/blob-source.ts`).
2. Origin: repeat with `-H 'Origin: capacitor://localhost'` and with `-H 'Origin: https://localhost'`. A 403 here predicts a 403 from the phone if `requestUrl` forwards an `Origin`. The two values are the usual Capacitor origins; whether Obsidian mobile sends any is **could not confirm**.
3. TLS and reachability from the phone's network: open the gateway URL in the phone's own browser on cellular and on Wi-Fi.

### 4.1 Ordered device checks

| # | Check | Steps | Record | Pass |
|---|---|---|---|---|
| 1 | Install and load | Section 0, build A first. Open Settings, Community plugins | Plugin appears with version; any error Notice at load; whether BRAT accepted `v0.2.0` tag | Enabled, no error |
| 2 | Cold start / reload | Force-quit Obsidian, reopen; toggle plugin off and on | Load time felt; any missing ribbon icons or commands (Publish vault, Pull vault, Show status, Abandon this vault, Clear stale publish lock) | All five commands present |
| 3 | Settings tab | Open the settings tab; set RPC and gateway URLs, MFS root, key name, auth scheme | Layout at phone width, keyboard overlap, whether secret fields are masked, whether values persist after restart (`data.json`) | Usable one-handed; persists |
| 4 | Show status | Run "Show status" | Notice text and duration | Readable |
| 5 | Node reachability and CORS | In build A run Pull vault against a fixture root | The error or success notice; request failures with status | No CORS or 403 error |
| 6 | Unlock dialog (build B) | Place a fixture vault with the marker on the phone; Publish opens the setup dialog; later the unlock dialog | Dialog fit, passphrase entry (long generated passphrase), paste behaviour, whether the keyboard hides the field | Operable |
| 7 | Argon2id timing and memory (build B) | Run unlock with remote inspector attached (4.2). Start a Performance recording before pressing Unlock | Wall time (stopwatch and recording), longest main-thread task, event-loop gap, whether the progress indicator moved, peak memory, whether the OS killed the app, battery/thermal state, run it 3 times (cold, warm, low-power mode) | Under 3 s and gap under 100 ms; no kill |
| 8 | Publish a tiny fixture vault (build B) | Publish from the phone | Notice text (`N written, M removed`), sequence, duration, requests count | Completes; notice exact |
| 9 | Pull on the other device | Build A with plaintext, or desktop CLI. For encrypted: **cannot be done at HEAD** (07a) | Fetched/unchanged/conflict counts; hashes of pulled files equal | Hashes equal |
| 10 | ~50 MB file pull | Fixture with one 50 MB random file (set the read cap to at least 64 MB), pull to the phone | Wall time, peak memory, whether Obsidian was killed, whether the file hash matches, whether `requestUrl` returned the whole body (inspector Network/Memory), whether Range was honoured | Hash matches without a kill |
| 11 | Background and foreground | Start a pull of the 50 MB file, switch apps for 10 s, 60 s, then return; also lock the screen. Repeat with an unlock in progress | Does it resume, fail with a notice, or hang? Does the journal resume it on re-run? `CREATING_TEXT` already tells the user "Keep the app in the foreground until this finishes" | No data loss; clear state on return |
| 12 | Range support probe | From the plugin: pull a large file and read the inspector for the `Range` request/response headers | `206` vs `200`, `Content-Range`, body length | Header honoured, or the refusal text shown |
| 13 | CORS / Origin | From the inspector console on the device: `fetch("<gateway>/ipfs/<cid>")` (expected to fail as on desktop) and the plugin's `requestUrl` path | Browser error text vs plugin result | `requestUrl` works regardless |
| 14 | Atomicity and lock | Kill Obsidian during publish; relaunch; run "Clear stale publish lock" if offered after 15 minutes | Whether the lock, `.taken` or `.tmp` files are left in `.ipfs-sync/` | Recovers |
| 15 | Abandon and lock | Run "Abandon this vault"; verify the local backup folder | Result notice | Local state moved |

Steps 7, 10 and 11 are the ones that can fail the whole approach.

### 4.2 Capturing logs and metrics, per OS

The plugin writes no logs: a grep of `src/` finds no `console.*` call and no `performance.now`. Device evidence is therefore (a) Obsidian Notices and the status bar, (b) the "Show status" notice, (c) the `lastPull`/`lastPublish` summaries in the settings tab (counts, CIDs, timestamps only), (d) the remote inspector, and (e) OS tools. Screenshots of (a) to (c) are the portable minimum.

**iOS**
- Remote inspection from a Mac as in 1.4: Develop menu, device, Obsidian. Use the Console (errors), Network (the `requestUrl` calls may not appear if the bridge is native: record that), Timelines (CPU, Memory, JavaScript Allocations) for Argon2id.
- Console.app on the Mac with the device selected for the device log stream; filter on the Obsidian process. General practice, not verified here.
- Out-of-memory kills: Settings, Privacy and Security, Analytics and Improvements, Analytics Data, entries starting `JetsamEvent`. General practice, not verified here.
- Timers: iOS stops them off-screen. Mark in the notes when the app was backgrounded.

**Android**
- `chrome://inspect#devices` as in 1.4. Console, Network, Performance (record), Memory (heap snapshot, but note typed arrays live outside the JS heap).
- `adb logcat` while testing for WebView console output and `adb shell dumpsys meminfo <package>` for process memory before and after. The Obsidian package name must be read from `adb shell pm list packages | grep -i obsidian`: I did not verify it.
- Kills: `adb logcat -b events` filtered on process death. General practice, not verified here.

**Desktop emulation (control)**: DevTools Performance panel with CPU throttling at 6x as a crude proxy for a mid-range phone. This is an estimate, not a measurement; label it so in any report.

**Optional instrument, not required**: a throwaway standalone probe plugin that bundles the project's `argon2.ts` wrapper and logs `performance.now()` deltas, an event-loop drift sampler and `performance.memory` where present, built from `tools/webview-probe-crypto-entry.ts`. Not built here; it would remove the dependence on the remote inspector for check 7. Decide at plan stage.

## 5. Risks to loading and running on mobile

### 5.1 Static results from the bundle (no rebuild; read-only grep of `dist/plugin/main.js`, 409,716 bytes)

| Check | Command (essence) | Result |
|---|---|---|
| `require()` calls | `grep -o 'require("[^"]*")'` | 15 occurrences, **all `require("obsidian")`**. No `fs`, `path`, `crypto`, `electron`, `child_process` |
| `node:` specifiers | `grep -n 'node:'` | 8 lines, all of the form `node: {` / `node: createCommitNode(...)` / `local: ..., node: ...` **object property names**, not imports |
| Node globals | `process.`, `Buffer.`, `__dirname`, `__filename` | none |
| Dynamic import | `import(` | none |
| Top-level await | cannot occur in `format: "cjs"` output (esbuild rejects it); not grep-detectable otherwise | none by construction |
| WebAssembly | `WebAssembly` | none |
| Worker / SharedArrayBuffer / eval / `new Function` | grep | none |
| `electron`, `window.require`, `createRequire` | grep | none |
| Regex lookbehind (iOS below 16.4) | `grep -c '(?<[=!]'` | 0 |
| BigInt | grep | 0 |
| Newer built-ins | `Object.hasOwn` x9, `.at(` x3 | need Safari 15.4 / iOS 15.4; below the 16.4 floor the Obsidian dev docs themselves cite for iOS |
| Crypto surface | `crypto.subtle.*`, `globalThis.crypto.randomUUID` | `digest`, `importKey`, `deriveBits`, `deriveKey`, `encrypt`, `decrypt`, `sign`; HKDF, HMAC, AES-GCM on WebCrypto; needs a secure context |
| `Platform` / `isMobile` / `isDesktopOnly` | grep | none; no platform branching |

Also: `pnpm probe:webview` (`tools/webview-import-probe.mjs`) bundles `src/main.ts` and other entries with the same options and fails on any external other than `obsidian` and `electron`. It also fails if `src/kubo + src/core` exceeds 60 KB before minification. It was **not run** for this document; its last result is in `.kbd-orchestrator` evidence. Its coverage gap: it checks module specifiers, not runtime globals such as `process` or `Buffer`, which the grep above covered for the current bundle.

The v0.2.0 release bundle: 9 `require("obsidian")` and no other `require`.

### 5.2 Risk register

| # | Risk | Likelihood / impact | Basis |
|---|---|---|---|
| R1 | A phone cannot produce the fixture marker, so the HEAD build cannot publish from the phone | High / blocks publish test | Dotfile creation in the mobile UI: could not confirm; the marker text must be exactly `fixture` |
| R2 | Argon2id 64 MiB, t = 3 is slower than 3 s on a mid-range Android, or the WebView is killed | Medium / blocks the design | Pure JS in `@noble/hashes` 2.4.0; M1 Max figure is 0.84 s; `setTimeout` slicing overhead on WKWebView; 64 MiB contiguous `Uint32Array` |
| R3 | Whole-file memory: the plugin loads each file whole (`obsidian-fs.ts` comment: no partial read), then multipart-builds the upload body (another copy), plus encryption output. A 50 MB file may need 150 MB to 200 MB transient | Medium-high / kill on iOS | `readRange` serves from one whole copy; `toRequestBody` in `request-url-transport.ts` sends one prebuilt `ArrayBuffer` |
| R4 | `requestUrl` whole-body responses ("the body arrives whole (no streaming)", `request-url-transport.ts`) and whatever the mobile bridge does with 8 MB bodies (possible encoding overhead): could not confirm | Medium / blocks large pulls | Obsidian docs silent on size |
| R5 | Range ignored or stripped by the bridge or the proxy | Medium / large pulls refused (07a handles it as `unfetched`, not data loss) | `blob-source.ts` refusals |
| R6 | Mobile origin 403 at the reverse proxy | Low-medium | README quirk 4 shows the proxy already filters on Origin |
| R7 | `crypto.subtle` or `randomUUID` missing in the mobile secure-context model | Low-medium / total failure of crypto | Could not confirm |
| R8 | iOS suspends the app mid-unlock or mid-publish; timers stop; the publish lock becomes stale | High (certain on iOS) / recoverable | DESIGN section 2; the plugin has "Clear stale publish lock" and a journal |
| R9 | `adapter.rename` onto an existing file, `appendBinary` and dot-folder behaviour differ on the Capacitor adapter | Medium | Comments in `adapter-lock-file.ts` and `obsidian-fs.ts` |
| R10 | Phone's Obsidian is older than 1.12.3 | Low | `minAppVersion`; how a too-old app reacts to a BRAT install: could not confirm |
| R11 | BRAT mismatch or `v` prefix confusion; BRAT's own mobile behaviour | Low | 1.1 |
| R12 | Open-write node and a token typed into plaintext plugin data | Known / policy | README security banner; Settings tab warning |
| R13 | HEAD is not the 07a tree. Any real-device finding on HEAD may be superseded when 07a (`blob-fetch`, `device-store`, dialogs) lands | Certain / rework | 120 modified files; new untracked pull modules |
| R14 | iCloud vault leaks `.ipfs-sync/` plaintext paths | Policy | `docs/operator/encrypted-vault.md` |

## 6. What I verified, and what I could not

### Read in this session
`manifest.json`, `package.json`, `esbuild.config.mjs`, `esbuild.options.mjs`, `tools/` (webview probe, release tooling), `src/plugin/index.ts`, `src/plugin/request-url-transport.ts`, `src/plugin/adapter-lock-file.ts`, `src/plugin/obsidian-fs.ts` (header), `src/crypto/argon2.ts`, `src/plugin/plugin-seams.ts`, `src/sync/pull-screen.ts` at HEAD, README and DESIGN sections on mobile, `docs/operator/encrypted-vault.md`, the v0.2.0 release record and `gh release view` output, `dist/plugin/main.js` by grep, the release `main.js` by grep, the CLI tarball listing. Not present: `.github/` and `scripts/` do not exist in this repository (so no CI workflows exist to read); `styles.css` does not exist.

### Official documentation actually read
- docs.obsidian.md, "Mobile development" (emulateMobile, Android chrome://inspect, iOS 16.4 Web Inspector, `Platform`, Node and Electron not available on mobile, lookbehind).
- docs.obsidian.md, "requestUrl" (signature and the "without any CORS restrictions" sentence only).
- obsidian.md/help: Community plugins, Plugin security (Restricted mode), How Obsidian stores data (hidden `.obsidian`), Obsidian for Android (device vs app storage, "All files"), Obsidian for iOS and iPadOS (read in full, no vault-location content), Sync settings (plugin list sync).
- BRAT: `BRAT-DEVELOPER-GUIDE.md`, tfthacker.com quick guide and plugin pages, BRAT `manifest.json`.
- webkit.org Enabling Web Inspector (Mac side; the iPhone toggle path was truncated), developer.chrome.com Remote debug Android devices.

### Could not confirm (do not assume)
iOS vault folder locations and Files-app visibility of `.obsidian`; iCloud container path; Android exact vault path; whether the mobile UI can create a dotfile; BRAT behaviour on mobile and with a `v`-prefixed tag; whether Obsidian mobile has an in-app console; the iPhone Web Inspector settings path; `crypto.subtle` availability and the origin string on the mobile WebViews; `requestUrl` size, encoding and header behaviour on mobile; the Obsidian Android package name; any Obsidian plugin size limit; whether a too-old Obsidian rejects the BRAT install.

### Not run
`pnpm build`, `pnpm probe:webview`, `pnpm test`, `pnpm typecheck`, any network request to the operator's node, any `curl`, any release command. The only network reads were documentation fetches and `gh repo view` / `gh release view`.

## 7. Recommendation for the parent phase

1. Do the BRAT v0.2.0 install on both phones first. It costs nothing, needs no build or release, and answers: does the plugin load, does the settings tab work, does `requestUrl` reach the node, is Range honoured, can a 50 MB fixture be pulled, what happens when the app is backgrounded. Use a fresh MFS root and key, v0.2.0 CLI from the release tarball (extract and run with Node), fixture content only.
2. Treat the Argon2id and memory measurements as the gating evidence for the 07a design. They need build B on real devices, which needs (a) a clean-worktree build at a recorded commit, (b) a pre-release or a manual copy, (c) the marker file placed from a computer. Ask the operator to approve the outward steps in 2.3 before the execute stage; none was taken.
3. Do not resume 07a before checks 7, 10, 11 and 12 have numbers. If Argon2id exceeds 3 s on the phone, or a 50 MB pull is killed, the encrypted-pull design (whole-body `requestUrl`, whole-file buffers) changes, which is the question the goals ask.
4. Execute-stage items to hand to the owning roles, none done now: parameterise `tools/release/constants.mjs` or use a manual three-file assembly; add a CI gate (there is no `.github/` yet) running `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm probe:webview` and a `grep` for non-`obsidian` `require()` in `dist/plugin/main.js`; document the phone install in `docs/operator/` (documentation-specialist).
